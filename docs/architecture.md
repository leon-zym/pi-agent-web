# 架构 — Pi Agent Web

本文描述当前生产路径。关键取舍见 [架构决策记录](decisions/)；协议字段与 Pi RPC
事实见 [protocol.md](protocol.md)。

## 范围与不变量

1. **Pi JSONL 是持久化事实**：Web 不建立第二套 Workspace/Session 数据库。
2. **每个热 Session 最多一个 Pi 进程**：历史 Session dormant 时没有进程；并发池有界。
3. **选择只是视图指针**：切换页面不发送 Pi `switch_session`，也不停止后台 Session。
4. **一条 WebSocket，多条 Session channel**：订阅、控制权、generation、seq、回放与
   Extension UI 都按 Session 隔离。
5. **事件流是对话权威**：快照用于初始化与明确 resync；命令完成还要等待投影越过
   `barrierSeq`。
6. **本机同源控制面**：只监听 loopback；Cookie、Host、Origin/Fetch Metadata 共同阻止
   任意网页驱动本机 Agent。它不是远程账户或多用户安全边界。

## 拓扑

```text
Browser · React SPA
  ├─ Native directory + selected view pointer
  ├─ one SessionTransport WebSocket
  │    └─ N isolated channels {runtime, lease, cursor, replay/resync}
  └─ per-Session projection/composer/model/stats/extension stores
             │ authenticated same-origin REST + WS
             ▼
Node Gateway · Hono + ws
  ├─ access-control / auth-storage / directory-picker
  ├─ SessionLayoutResolver ── NativeSessionCatalog
  │                             └─ bounded streaming JSONL summaries
  ├─ WorkspacePreferences (presentation and discovery hints only)
  ├─ Native REST routes
  ├─ SessionWsBridge (multiplexing, catch-up, id mapping, backpressure)
  └─ SessionSupervisor (bounded hot-runtime pool)
         ├─ SessionRuntime A ─ PiProcess A ─ pi --mode rpc --session A.jsonl
         ├─ SessionRuntime B ─ PiProcess B ─ pi --mode rpc --session B.jsonl
         └─ dormant Session C ─ no process
                                      │
                                      └─ Pi settings, credentials, extensions, JSONL history

RecoverableSessionTrash is a side store used only by fenced deletion.
```

## 身份模型

| 概念 | 权威身份 | 说明 |
|---|---|---|
| Pi Session | JSONL 文件的 canonical real path | `sessionHandle` 由该路径生成，是不透明 Web 路由标识 |
| Native Session id | JSONL Header `id` / `get_state.sessionId` | 用于验证文件与运行时一致，不作为跨文件全局主键 |
| Workspace | JSONL Header `cwd` 的 canonical real path | `workspaceHandle` 是对应的不透明路由标识 |
| 新空 Session | 短暂 pending handle | Pi 暴露真实 `sessionFile` 后通过 `session_rekeyed` 提交身份 |
| Controller | `(sessionHandle, connectionId, fencingToken)` | 只赋予一个 Session 的修改权，不是 Workspace 锁 |

已存在文件用 `realpath`；尚未创建的 leaf 通过最近存在祖先的 realpath 规范化，防止符号链接
父目录在落盘前后生成不同 handle。启动已有 Session 时，Runtime 会复核目标文件、Header id、
Header cwd 与 Pi ready state；任何不一致都 fail closed。

## 原生发现与 Workspace 偏好

`SessionLayoutResolver` 复现 Pi 的目录优先级：

1. `PI_CODING_AGENT_SESSION_DIR`；
2. Workspace `.pi/settings.json` 的 `sessionDir`；
3. 全局 `settings.json` 的 `sessionDir`；
4. 默认 `<agentDir>/sessions/--<encoded-cwd>--/`。

Pi 原生 CLI 的显式 `--session-dir` 仍高于环境变量；Web child 不传该 flag。Project settings
覆盖 global settings，与 Pi 的 merged settings 语义一致。

前三种是直接 Session 目录，不再追加 encoded cwd。相对路径按 Pi 子进程的 Workspace cwd
解释；Gateway 为每个 Workspace 生成一致的 child env/绝对目标。Catalog 从已知路径与 JSONL
Header 反向发现 Workspace，按目录 revision 缓存，并以有限文件/目录并发逐行扫描；它只保留
Header、名称、计数、时间和截断首条消息，不复制完整对话文本。

`WorkspacePreferences` 只保存 pin、显示名、path hint 与最近打开时间。删除偏好不会触碰 Pi
历史。绝对路径的默认、环境与全局目录仍可独立发现；但仅由 Workspace `.pi/settings.json` 指定的
`sessionDir`，以及按 child cwd 解释的相对 Agent/Session 目录，都无法脱离已知 Workspace path
推导。偏好丢失或损坏时相应历史会暂时隐藏，重新添加同一规范路径即可恢复发现。路径暂不可用时，
有偏好或可发现 native history 的 Workspace 以 unavailable 状态保留。

## Session Runtime 池

`SessionSupervisor` 以 canonical `sessionHandle` 注册 Runtime：

- `activate`/`subscribe` 按需启动 Pi，并用 `get_state` 完成 ready 与身份校验；
- 热池默认有上限，只有 idle、已持久化、无命令/对话框/transition reservation 的 Runtime
  可以被驱逐；
- idle TTL 到期后停止进程并进入 dormant，下一次打开同一 JSONL；
- running、waiting_ui、starting、unpersisted、正在 fork/clone/delete 的 Runtime 不被驱逐；
- generation 在进程生命周期或身份迁移时递增，所有旧 mutation 都被拒绝；
- crash 在滚动窗口内有限重试，超预算保留 crashed 状态供显式恢复；
- POSIX 子进程使用独立进程组，显式停止与异常退出都会清理残留后代，再允许新进程启动。

同一 Workspace 的多个 Session 可以并发。Workspace reservation 只覆盖文件身份敏感的 create、
fork/clone commit 与 delete 窗口，避免两个进程同时拥有同一 JSONL；它不是运行时全局锁。

## 订阅、控制与命令

订阅是只读操作，会激活 Runtime 并建立 catch-up baseline。一个连接可以订阅和控制多个
Session；不同连接也能各自控制不同 Session。同一 Session 同时只有一个 controller：

- `get_*` 只读 RPC 不需要 lease；
- prompt、queue、abort、model/thinking、compact、bash、fork/clone 等 mutation 需要精确
  `expectedGeneration` 与当前 `fencingToken`；
- disconnect 释放该连接全部 lease，旧 fencing token 立即失效；
- observer 继续接收历史、事件、运行状态与 Extension snapshot，但不能修改 Pi；
- `new_session` 与 `switch_session` 是 Host 管理的生命周期命令，浏览器不能直接转发；新建走
  Native REST，页面导航只更改 selected pointer。

桥接层为每条浏览器命令分配内部 Pi id，response 前恢复发起者 id。Bash 的流式 execution id
也按连接映射，避免不同连接使用相同 client id 时串流。

## 事件、回放与 resync

每个 generation 的权威事件按 `seq` 单调编号。Runtime 同时按帧数和字节数保存有界 replay；
停止或溢出可以丢弃旧帧，但保留 cursor 边界，使客户端收到显式 gap，而不是静默漏消息。

subscribe catch-up 的 Bridge wire 顺序是：

```text
optional synthetic rekey
→ runtime baseline
→ replay frames OR resync_required
→ atomic Extension UI snapshot
→ lease snapshot
→ catch-up barrier 后的 live frames
```

Bridge 在 catch-up 期间先缓冲新帧，最终按 generation/seq 去重后切 live。初次订阅、cursor
无效、generation 变化、replay gap 或 UI 缓冲溢出都会进入 resync。UI 用 `get_messages` 重建
投影，并在应用快照后完成新 cursor；UI 会延迟向 consumer 暴露 baseline `resync_required`，直到
Extension snapshot 已原子应用，避免丢失让 Pi 阻塞的对话框。

Pi response 可与事件交错，因此 Gateway 附加 `barrierSeq`。UI 只有在同 generation 的投影已
应用至该序号后才 resolve 调用者。fork/clone 的 `previousSessionHandle` 只迁移对应 transition
命令和 channel，不批量改写父 Session 的其他 pending command。

## 前端状态所有权

| 层 | 所有权 |
|---|---|
| `session-transport` | 单 socket、连接状态，以及每 Session runtime/cursor/lease/resync/raw-event 有界窗口 |
| `session-frame-bus` | 按 Session 保序分发；组件不直接订阅 WebSocket |
| `session-directory` | 原生 Workspace/Session 摘要、selected pointer、请求 generation |
| `projection` | 按 Session 的 turn/step/block 投影；recent settled projection 可淘汰并从快照重建 |
| `composer` | 按 Session 的 draft、附件、提交状态、delivery mode 与 queue 意图 |
| `model` / `slash` / `stats` | 按 Session 的 Host 快照与刷新状态 |
| `extension-ui` | 按 Session/generation 的 dialog、status、widget、title、editor text |
| `view` | 本地展开、选中工具和详情面板状态；不写回 Pi |

`stream-pipeline` 消费所有已订阅 Session，而不只消费当前视图。连续文本/thinking/toolcall
delta 由 per-Session scheduler 合并：可见页用 rAF，hidden 页用有界 timer；结构、错误、settled、
rekey 等边界立即 flush。多 Session 在同一 publication 周期公平推进。

## Fork、clone 与删除事务

Pi fork/clone 可能先创建 child JSONL，再返回 response。Supervisor 在 Workspace identity
reservation 内验证 child 文件 Header、cwd 与 ready state，先原子占用新 handle，再广播 rekey
并释放 staged frames。取消、timeout、碰撞或身份不确定会停止进程并丢弃 staged child 帧。

DELETE 需要当前 Session 的 generation 与 fencing token。Reservation 内再次 force-refresh
Catalog，并拒绝 active/unpersisted Session、子 Session、Workspace transition 和并发 deletion。
Trash 在 rename 前后绑定 canonical path、Header id/cwd 与文件 dev/ino/size/mtime；成功时同文件
系统原子移动到私有可恢复目录。EXDEV、替换或回滚冲突均 fail closed，不做 copy-and-unlink。

## 启动与关停

`startServer` 只有在 HTTP `listening` 后才 resolve；bind 失败会清理已创建资源。关闭顺序先停止
新 ingress，给 HTTP/WS 一个短的有界 grace，随后 terminate/destroy 残留连接，等待 activation、
delete 和 pool transaction，停止所有 Pi 进程，最后释放 preferences 文件锁。重复 close 共享同一
Promise，关闭开始后所有新 mutation 都被拒绝。

## 非目标

- 不支持公网、LAN、远程账户、多用户协作或敌对本机用户隔离。
- 不把浏览器的 selected Session 写成 Pi 的全局“当前 Session”。
- 不保证无限并发、无限 replay、无限 Markdown 或无限工具输出。
- 不自动导入、复制、重写或删除用户既有 Pi JSONL。
