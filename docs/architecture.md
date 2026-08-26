# 架构：Pi Agent Web

本文描述当前生产路径。关键取舍见 [架构决策记录](decisions/)；协议字段与 Pi RPC
事实见 [protocol.md](protocol.md)。

## 范围与不变量

1. **Pi JSONL 是持久化事实**：Web 不建立第二套 Workspace/Session 数据库。
2. **每个热 Session 最多一个 Pi 进程**：历史 Session dormant 时没有进程；并发池有界。
3. **选择只是视图指针**：切换页面不发送 Pi `switch_session`，也不停止后台 Session。
4. **一条 WebSocket，多条 Session channel**：订阅、控制权、`serverEpoch`、generation、seq、
   回放与 Extension UI 都按 Session 隔离。
5. **事件流是对话权威**：快照用于初始化与明确 resync；命令完成还要等待投影越过
   `barrierSeq`。
6. **本机同源控制面**：只监听 loopback；Cookie、Host、Origin/Fetch Metadata 共同阻止
   任意网页驱动本机 Agent。它不是远程账户或多用户安全边界。
7. **Client subscription LRU with a hot Runtime guard**: Six is the soft admission target for
   ordinary idle, persisted subscriptions. Every Runtime in the authoritative hot inventory keeps
   an observer subscription regardless of phase or persistence, so the hot set may exceed the
   target. A non-inventory Session is eligible for LRU eviction only when it is idle or dormant,
   persisted, and has no pending Extension request.
8. **悬挂工具状态只在权威边界收敛**：进程崩溃、用户 Abort 或已结算 Turn 中未收到结果的工具调用
   收敛为 `interrupted`。短暂断线或 resync 不提前中断工具；权威快照继续保留 running 与 partial result。
9. **乐观 User 消息以 ContentShape 对齐**：前端提交即刻乐观挂载；权威 `message_start` 到达时按
   `contentShape`（文本特征 + 附件数）与 FIFO 队列匹配回填，消除重复与闪烁。
10. **柔性幂等退让 (Soft Idempotency)**：针对竞争状态下的 Abort 或已失效 Extension UI 响应，
    按柔性无操作（Soft No-op）吸收，不弹出侵入式错误 Toast。
11. **版本化 Host 边界**：发行清单中的 Pi runtime 必须在启动期通过版本/能力探测；Browser 只消费
    产品自有 DTO，并在任何 Session frame 前完成 Gateway hello 协商。

## 拓扑

```text
Browser · React SPA
  ├─ Native directory + ephemeral hot overlay + selected view pointer
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
         ├─ PiHostAdapter (probe, capabilities, strict normalization)
         ├─ SessionRuntime A ─ PiProcess A ─ Pi RPC ─ session A.jsonl
         ├─ SessionRuntime B ─ PiProcess B ─ Pi RPC ─ session B.jsonl
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
| 新空 Session | pending handle → allow-missing canonical path | Pi 可先分配 `sessionFile` 而不落盘；首次持久化后再冻结 Header/inode |
| Controller | `(sessionHandle, connectionId, fencingToken)` | 只赋予一个 Session 的修改权，不是 Workspace 锁 |
| Stream position | `(serverEpoch, sessionHandle, generation, seq)` | Gateway 重启、Session rekey、Runtime 重启和帧位置分别由四个分量隔离 |

已存在文件用 `realpath`；尚未创建的 leaf 通过最近存在祖先的 realpath 规范化，防止符号链接
父目录在落盘前后生成不同 handle。启动已有 Session 时，Runtime 会复核目标文件、Header id、
Header cwd 与 Pi ready state；任何不一致都 fail closed。

Pi 对新 Session 以及从首条 user entry fork 的 child，可能先在 `get_state` 返回目标路径，直到后续
durable entry 才创建 JSONL。Runtime 只接受同一已验证 sessionDir 内、basename 与 native id 对应的
allow-missing identity；验证前不可恢复、驱逐或删除。文件首次出现时必须复核 regular file、Header
id/cwd 与冻结身份，失败就隔离该 Runtime，而不是把任意新 leaf 追认为 Session。

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
- 未触碰、未落盘且无 lease 的空 Runtime 由短 TTL reaper 停止并忘记，不执行任何文件删除；当前
  controller 主动离开时可用 exact generation/fencing 的 transient abandon 提前完成同一收敛；
- generation 在进程生命周期或身份迁移时递增，所有旧 mutation 都被拒绝；
- crash 在滚动窗口内有限重试，超预算保留 crashed 状态供显式恢复；
- adapter 发现未知权威字段或畸形嵌套数据时进入 `protocol_incompatible` 终态，不自动重启；
- POSIX 子进程使用独立进程组，显式停止与异常退出都会清理残留后代，再允许新进程启动。

同一 Workspace 的多个 Session 可以并发。Workspace reservation 只覆盖文件身份敏感的 create、
fork/clone commit 与 delete 窗口，避免两个进程同时拥有同一 JSONL；它不是运行时全局锁。

## 订阅、控制与命令

连接必须先用 `client_hello` / `server_hello` 协商协议 major/minor、能力与上限；major 不兼容是
不重连的终态。订阅是只读操作，会激活 Runtime 并建立 catch-up baseline。一个连接可以订阅和控制多个
Session；不同连接也能各自控制不同 Session。同一 Session 同时只有一个 controller：

- `get_*` 只读 RPC 不需要 lease；
- prompt、queue、abort、model/thinking、compact、bash、fork/clone 等 mutation 需要精确
  `expectedGeneration` 与当前 `fencingToken`；
- disconnect 释放该连接全部 lease，旧 fencing token 立即失效；
- observer 继续接收权威 Session snapshot、事件、运行状态与 Extension state，但不能修改 Pi；
- `new_session` 与 `switch_session` 是 Host 管理的生命周期命令，浏览器不能直接转发；新建走
  Native REST，页面导航只更改 selected pointer。

桥接层为每条浏览器命令分配内部 Pi id，response 前恢复发起者 id。Bash 的流式 execution id
也按连接映射，避免不同连接使用相同 client id 时串流。

## 事件、回放与 resync

Gateway 启动时生成唯一 `serverEpoch`，并把同一值注入 hello、Runtime identity、sequenced
envelope、response、lease、rekey、resync、snapshot 与 replay cursor。每个 stream position 是
`{serverEpoch, sessionHandle, generation, seq}`。Cursor 按 epoch、handle/rekey、generation、seq
range 的顺序校验；任一不确定身份都进入显式 resync。

Runtime generation 启动时先用内部 `get_messages` 建立 `baseSeq = 0` 的 settled-message base，期间
到达的已验证事件有界缓冲，base 建立后再按到达顺序提交。Gateway 的临时 live projection 保存
settled base、有序 product-domain event suffix、queue、runtime phase 与 pending blocking Extension
请求。Sticky Extension state 只保留在一个有界 Runtime map 中；替换、clear 与容量淘汰都发布明确的
semantic frame，使 live observer 与 snapshot 在同一 waterline 收敛。Pi JSONL 仍是唯一持久化事实，
这些内存状态只服务当前 Runtime generation。Startup frame 可以先提交 projection 与 replay，但必须
等完整 wire snapshot guard 通过后才统一对外发布。

每个 live frame 在同一串行边界中完成 projection、seq allocation、replay append 与 publish。投影或
预算检查失败时，`lastSeq`、replay 和订阅者都看不到半提交帧。Runtime 同时按帧数和字节数保存有界
replay；停止或溢出可以丢弃旧帧，但保留 cursor 边界，使客户端收到显式 gap。`notify` 只实时投递，
不进入 snapshot；若 replay 为避免重复通知而跳过一个 `notify` seq，该范围必须按 gap 处理并改用
snapshot，不能伪装成连续 replay。

subscribe catch-up 的 Bridge wire 顺序是：

```text
optional synthetic rekey
→ runtime baseline
→ replay frames OR (resync_required → session_snapshot @ asOfSeq)
→ lease snapshot
→ contiguous live suffix with seq > replay cursor / asOfSeq
```

Bridge 在 catch-up 期间先缓冲新帧，最终按完整 stream identity 与 seq 去重后切 live。初次订阅、
epoch 或 generation 变化、cursor 无效、replay gap、rekey race 或 UI 缓冲溢出都会进入 resync。
`session_snapshot` 在一个 `asOfSeq` 原子包含 settled base、live product event suffix、queue、runtime
phase、pending dialog 与 sticky Extension state；不包含瞬时 `notify`、Controller Lease 或 fencing token。
UI 原子替换该 Session 的权威状态，然后只接受 `seq > asOfSeq` 的连续 suffix。

Snapshot 有 item、byte 与 depth 上限。无法生成合法 snapshot 的 Runtime 进入稳定
`session_snapshot_overflow` crashed 状态，停止 Pi 且不自动重启或形成订阅循环。Persisted Session 的
显式 Runtime restart 会替换旧 overflow Runtime，以旧 generation 为 seed 启动下一 generation；不会
复用已锁存 overflow 的实例。UI 的恢复状态机使用有界次数、退避与 jitter；预算耗尽后保持 degraded
状态，只有显式 manual retry 才开始新的 cursorless 尝试。恢复完成前所有 mutation 与 Extension
response 都 fail closed。已知 Session 的 hard reload 使用同一 snapshot 路径；新 Browser 连接发现并
恢复所有 hot Runtime 的 inventory 属于独立的 hot-runtime reconciliation 契约。

## Authoritative hot Runtime inventory and Browser reconciliation

The decision rationale is recorded in
[ADR 0009](decisions/0009-authoritative-hot-runtime-inventory-and-browser-reconciliation.md).

`SessionSupervisor` is the sole authority for which Sessions currently own a live Pi process. It
publishes a bounded, full-replacement inventory:

```text
{type: hot_runtime_inventory, serverEpoch, revision, runtimes[]}
```

Each entry contains the exact `{serverEpoch, workspaceId, sessionHandle, generation}` identity and
one live phase: `starting`, `idle`, `running`, or `waiting_ui`. The revision increases monotonically
within one Gateway epoch whenever the set, identity, or phase changes. The inventory excludes
crashed and dormant Sessions. It is ephemeral process ownership, not durable history, and it never
replaces Pi JSONL or the native catalog.

The negotiated `session.hot_runtime_inventory` capability is required by the Browser. After a
successful hello, the Bridge sends the current full inventory before the Browser starts Session
reconciliation. Later revisions are broadcast as full replacements. The Supervisor computes each
revision under its pool serialization boundary, while the Bridge retains only the latest deferred
revision when a catch-up contains a pending rekey ordering fence.

An inventory entry is observed with `session_subscribe.expectedHotRuntime`. This is an exact,
only-if-hot subscription. The Gateway compares the complete identity, captures the live process
incarnation, builds the replay or snapshot baseline, and revalidates that observation immediately
before making it visible. A mismatch returns an explicit subscribe error and never activates a
dormant Session. Exact catch-up is transactional: failure preserves any previous live subscription,
catch-up, and lease; success installs one authoritative baseline followed by its contiguous suffix.
A duplicate exact request for an identity already live on that connection is a no-op.

Browser startup waits for the initial inventory before loading and reconciling the REST directory or
creating a Session. The REST load is fenced to the same online connection epoch, but inventory
revision changes within that epoch do not restart bootstrap. The newest same-epoch full replacement
is applied independently. The Browser then treats every inventory entry as a desired background
observer, recovers exact baselines one at a time, and pins those channels above the ordinary LRU
target. The selected Session requests controller ownership only after an authoritative baseline and
a fresh matching lease snapshot exist.

The directory merges durable native rows with the ephemeral hot overlay by Session handle. This
allows multiple unpersisted hot Runtimes to remain visible across reload while preventing duplicate
rows for persisted Sessions. A full inventory removal removes the overlay and ends desired hot
observation. It does not select or activate a historical Session. Rekey changes the desired exact
identity without turning the parent into an alias for dormant activation.

Transient cleanup is provenance-sensitive. Only an unpersisted Session created by this Browser may
use the fenced abandon path after it is authoritative, controlled, idle, and untouched. A recovered
hot-only Session can be released or observed, but the Browser cannot infer that it is safe to
abandon. Dormant history remains an on-demand native catalog concern and is intentionally absent
from hot reconciliation.

当 Runtime hot、idle 且没有 agent、compaction、awaiting-start、queue、in-flight command、dialog 或
transition 时，可以用 compare-and-swap 压缩 live suffix：先记录 projection-owned incarnation 与
`expectedAsOfSeq`，异步读取新的 settled base，提交时再次确认仍为 idle 且 waterline 未变化。成功后
`baseSeq = asOfSeq` 并清空 suffix；任一条件变化都丢弃候选 base。

`prompt`、`steer` 与 `follow_up` admission 还要为下一个 active Turn 保留有界 headroom。Raw product
event 数量与完整 frame bytes 各自受 live suffix ceiling 的 50% 预算约束；剩余空间不足时，命令等待
并复核 idle CAS compaction。容量复核与 pending reservation 在同一串行 admission 边界原子完成，
不足时在命令发送给 Pi 前拒绝；Agent 启动后 reservation 转为 active，失败、取消、结算、stop 或
rekey 时释放。这个预算只覆盖符合 half-ceiling 的 Turn，不保证任意完整 Turn。单个 active Turn
超过预算时稳定进入 `session_snapshot_overflow`；更大的 Turn 需要 chunking 或 rollover 协议。

Pi response 可与事件交错，因此 Gateway 附加 `barrierSeq`。UI 只有在同 generation 的投影已
应用至该序号后才 resolve 调用者。普通 `get_messages` response 也遵守该 barrier，但不再参与
resync，也不能推进 snapshot waterline。fork/clone 的 `previousSessionHandle` 只迁移对应 transition
命令和 channel，不批量改写父 Session 的其他 pending command。

## 前端状态所有权与生命周期不变量

| 层 | 所有权 |
|---|---|
| `session-transport` | One socket, hello and inventory reconciliation, bounded per-Session runtime/cursor/lease/resync/raw-event windows, serialized exact hot recovery, and ordinary subscription LRU admission |
| `session-frame-bus` | 按 Session 保序分发；组件不直接订阅 WebSocket |
| `session-directory` | Native Workspace and Session summaries, full-replacement hot overlay, transient provenance, selected pointer, and request generation |
| `projection` | 按 Session 的 turn/step/block 投影；处理 ContentShape 乐观回填与悬挂工具 interrupted 收敛 |
| `composer` | 按 Session 的 draft、原子 Slash Command Token、附件、提交状态、70vh 模式、delivery mode 与 queue 意图；管理 prompt 历史 |
| `model` / `slash` / `stats` | 按 Session 的 Host 快照与刷新状态，动态 thinking levels 分段映射 |
| `extension-ui` | 按 Session/generation 的 dialog、status、widget、title、editor text；管理 ChatDock 最小化与 QuestionCard |
| `view` | 本地展开、选中工具、TOC 悬浮轨、移动端 Sheet 与详情面板状态；不写回 Pi |

### 客户端生命周期四大不变量

1. **WebSocket subscription admission with a hot Runtime guard**:
   - `MAX_ACTIVE_SUBSCRIPTIONS = 6` is a soft target for ordinary idle, persisted subscriptions, not a hard connection limit.
   - Every Session in hot inventory keeps an observer subscription, including a persisted idle Runtime. These channels do not participate in LRU eviction, so inventory membership may exceed the target.
   - A non-inventory Session is eligible for LRU unsubscribe only when it is idle or dormant, persisted, and has no pending Extension request.
2. **悬挂工具状态收敛为 `interrupted`**：
   - 当 dormant settled history 加载、当前 Turn 权威结算、进程 Crash 或用户触发 Abort 时，若仍有尚未收到结果的工具调用，视图层将其状态置为 `interrupted`；
   - reload、短暂断线或 resync 本身不是结算边界，live snapshot 中的 running tool 与 partial result 保持不变；
   - 渲染为低调的灰色标记，杜绝永恒 Loading Spinner，同时绝不篡改事实伪造为 `ok`。
3. **乐观更新回填与 ContentShape 精准对齐**：
   - 用户发送 Prompt 后，前端立即生成带 `optimistic: true` 标记的 User 消息节点；
   - 当权威 `message_start` 到达时，通过 `contentShape`（文本特征摘要 + 附件数量）与发送 FIFO 队列严格匹配替换，避免消息重复与跳跃。
4. **冲突与中断操作的柔性幂等退让 (Soft Idempotency)**：
   - 用户触发 Abort、取消或提交已过期的 Extension UI 响应时，若后端返回“已结算”、“已过期”或“无进行中任务”等竞态结果，客户端统一按柔性无操作（Soft No-op）吸收，不触发红色错误 Toast。

`stream-pipeline` 消费所有已订阅 Session，而不只消费当前视图。连续文本/thinking/toolcall
delta 由 per-Session scheduler 合并：可见页用 rAF，hidden 页用有界 timer；结构、错误、settled、
rekey 等边界立即 flush。多 Session 在同一 publication 周期公平推进。

## Fork、clone、transient abandon 与删除事务

Pi fork/clone 可能在返回 response 前就切换进程身份并分配或创建 child JSONL。Supervisor 在
Workspace identity reservation 内验证 ready state 与 child identity；已落盘时还验证 Header/cwd，
然后先原子占用新 handle，再广播 rekey 并释放 staged frames。取消、timeout、碰撞或身份不确定会
停止进程并丢弃 staged child 帧。

从 root user entry fork 时，Pi 也可能只分配 child path 而尚未创建文件。该 child 继续使用上面的
pending persisted-identity 状态，直到首次落盘验证；不能把正常 ENOENT 当成 fork failure。

Transient abandon 与 recoverable DELETE 是两个 API：前者只允许 untouched、idle、unpersisted
runtime，并在 stop 后再次确认路径仍不存在再忘记内存身份；后者只处理已经验证的 JSONL 并移动
文件。两者都在 Supervisor reservation 内与 command、claim、materialization 和 shutdown 互斥。

DELETE 需要当前 Session 的 generation 与 fencing token。Reservation 内再次 force-refresh
Catalog，并拒绝 active/unpersisted Session、子 Session、Workspace transition 和并发 deletion。
Trash 在 rename 前后绑定 canonical path、Header id/cwd 与文件 dev/ino/size/mtime；成功时同文件
系统原子移动到私有可恢复目录。EXDEV、替换或回滚冲突均 fail closed，不做 copy-and-unlink。

## 启动与关停

`startServer` 先按 server package export 解析并探测发行清单 pin 的 Pi；`--pi-path` / `PI_PATH` 是
唯一显式 override，cwd 与 `PATH` 不参与默认选择。探测失败时启动直接失败。`/health/live` 只表示
Gateway 进程存活，`/health/ready` 表示 Pi 版本、adapter 与能力已验证。

HTTP server 只有在 `listening` 后才 resolve；bind 失败会清理已创建资源。关闭顺序先停止
新 ingress，给 HTTP/WS 一个短的有界 grace，随后 terminate/destroy 残留连接，等待 activation、
delete 和 pool transaction，停止所有 Pi 进程，最后释放 preferences 文件锁。重复 close 共享同一
Promise，关闭开始后所有新 mutation 都被拒绝。

## 非目标

- 不支持公网、LAN、远程账户、多用户协作或敌对本机用户隔离。
- 不把浏览器的 selected Session 写成 Pi 的全局“当前 Session”。
- 不保证无限并发、无限 replay、无限 Markdown 或无限工具输出。
- 不自动导入、复制、重写或删除用户既有 Pi JSONL。
