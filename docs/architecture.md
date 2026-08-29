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
  ├─ EpochContentStore (epoch-scoped raster + UTF-8 derived content spool)
  ├─ Native REST routes
  ├─ SessionWsBridge (multiplexing, catch-up, id mapping, backpressure)
  └─ SessionSupervisor (bounded hot-runtime pool)
         ├─ PiHostAdapter (probe, capabilities, strict normalization)
         ├─ SessionRuntime A ─ PiProcess A ─ Pi RPC ─ session A.jsonl
         ├─ SessionRuntime B ─ PiProcess B ─ Pi RPC ─ session B.jsonl
         └─ dormant Session C ─ no process
                                      │
                                      └─ Pi settings, credentials, extensions, JSONL history
```

RecoverableSessionTrash is a side store used only by fenced deletion. EpochContentStore holds only
bounded, discardable raster and UTF-8 derivatives; neither store replaces Pi JSONL.

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

## 跨层资源治理

资源上限在 Gateway 的实际共享边界上执行，而不是只在单个请求或单个 Browser 连接上计数：

- `SessionSupervisor` 默认最多保留 8 个热 Pi 进程，并以 `maxRetainedProjectionBytes` 默认 512 MiB
  为热 Runtime 投影保留预算。每个热 Runtime 按其 snapshot 上限做保守 reservation；这是 admission
  预算，不是对 Node 或 Browser 实际 heap 的精确测量。容量不足时只有可驱逐的 idle、已持久化、无
  lease/命令/对话框/transition reservation 的 Runtime 可以让位，否则以
  `session_runtime_capacity` 或 `session_projection_capacity` 明确拒绝。
- Runtime 对外发布 `phase`、`operationCount` 和 `busyReasons`：`starting`、`ready`、`busy`、
  `waiting_ui`、`crashed`、`dormant`。这些字段描述共享 admission 与可观察状态；`operationCount`
  是加权占用估计，不是可供客户端操纵的任务序号。
- `SessionWsBridge` 在所有连接共享的边界执行连接数（默认 64）、订阅 channel（1024）、并发
  catch-up（256）、历史 alias（1024）、pending command response reservation（65 MiB）以及
  outbound backlog/frame 上限；每连接的 in-flight command 仍受 32 项限制。超过预算会得到稳定、
  可分类的错误，不通过扩大某一条连接的队列来掩盖全局压力。
- `NativeSessionCatalog` 以文件 identity/revision 做可丢弃的逐文件 cache；同一文件追加时只读取
  新增尾部，truncate、inode replacement、symlink retarget 或 transient I/O failure 会退回安全重扫。
  单次发现默认受 128 MiB、4096 页、5 秒限制，硬上限为 512 MiB、100,000 页、60 秒，并保留
  `partial`/`stale`/`retryable` 诊断，不把 cache 当成第二套 Session 事实。
- Browser 的 6 个普通 idle/persisted subscription 仍是 soft target。受保护的 hot Runtime 可以使其
  暂时超额；UI 必须区分 protected overage 与带 `code`/`retryable` 的拒绝，并只在连接已可用时重试。

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

`session_error` 的错误文案仅用于展示；Gateway 同时发送稳定 `code` 与 `retryable` 判定。Browser
不得从人类可读文案猜测是否应重试；旧 peer 缺少结构化字段时只保留兼容性 fallback。

桥接层为每条浏览器命令分配内部 Pi id，response 前恢复发起者 id。Bash 的流式 execution id
也按连接映射，避免不同连接使用相同 client id 时串流。

## Payload authority、typed content refs 与共享 cache

[ADR 0010](decisions/0010-epoch-scoped-attachment-references-and-payload-budgets.md) 定义跨 Browser、
Gateway、Pi adapter、projection、replay、snapshot 与 queue 的统一 `payloadBudget`。ADR 0011 在同一
`EpochContentStore` 中增加 UTF-8 namespace，并由协议 minor 3 的 `contentRefBudget` 描述泛型内容边界。
Production Browser 与 Gateway 双向都要求 `payload.epoch_attachment_refs` 和
`payload.epoch_content_refs`；hello 必须选择 minor 3，携带完整两套 budget，并通过 client/server frame
ceiling 的关系检查。缺少任一能力、budget 或 frame ceiling 的连接在首个 Session subscribe 前终止，不存在
逐连接 inline fallback。Minor 1/2 的 hello、DTO 和预算仍作为历史兼容面保留并由显式 fixture 覆盖，不是
当前生产 Session 模式。

Raster attachment 与 UTF-8 content blob 共用 `webDataDir` 下的私有、epoch-scoped disk spool，容量、hold、
pin 与 publish 状态由
Gateway 内存 ledger 管理；它仍是可丢弃的有界派生 cache，不是新的持久化层。Store root 由单个 Gateway
生命周期锁独占，持锁者才可把旧 epoch 原子改名为 tombstone 后清理。新 digest 的写入先按声明长度预留
容量；未知长度按单 blob 上限预留，然后流式计算 SHA-256，并通过同目录临时文件与原子 rename 发布
manifest。已发布 digest 会先取得 pin；只有
`serverEpoch`、digest、media type 与 length 全部相同才进入重复 PUT 快路径，并在固定内存内重新流式验证
raster gross contract、实际长度和 SHA-256，不创建新 reservation 或 temp file；metadata 不同则直接拒绝。
Reference 携带创建它的 `serverEpoch`、内容摘要、media type 与 byte length，只能在完全相同的 epoch 使用。Gateway restart
会使旧 reference 无效；后续恢复必须从 Pi JSONL 或 Pi Runtime 的权威内容重新 externalize，不能只凭
digest 推断新进程仍拥有原 blob。Cache eviction 也不改变 Pi 内容，缺失 blob 必须 fail closed 或从
Pi authority 重建，不能把附件静默替换为空值。

UTF-8 namespace 的物理身份是 `(serverEpoch, sha256(raw UTF-8 bytes), byteLength)`。它不把
`text/plain` 或 `application/json` 写进 manifest，也不把 text/json 加入 digest，typed wrapper 决定消费
语义。基础 `content_ref` 为 `{type:"content_ref", encoding:"utf-8", serverEpoch, sha256, byteLength}`，
文本根使用 `external_text`，JSON 根使用 `external_json`，小 JSON 根必须使用 `inline_json`。同一 UTF-8
bytes 的 text 与 JSON wrapper 共享一个 store item 和一个 hold，但每个逻辑出现仍按 `byteLength` 计入
logical-content budget。

Disk spool 只保存 blob 与校验所需的 manifest。Reservation、hold、pin、publish/delete transition 和
并发 digest serialization 属于当前进程的内存 ledger。Epoch 目录名由 `serverEpoch` 摘要派生，URL 参数
不能直接成为文件路径。Store 在读取和发布时重新验证 manifest、digest、length、inode 与目录布局；同一
digest 的并发写入只发布一个条目。未 publish 且没有 hold/pin 的条目会被回收，已 publish 且没有
hold/pin 的条目可以由 GC 淘汰。

Gateway 已提供同源、认证后的 attachment REST ingress，另有只读 generic content route：

- `PUT /api/v1/attachments/:serverEpoch/:sha256` 接受 raw raster body。它在访问 store 前精确比较当前
  epoch 和 64 位小写 digest，要求正的 safe-integer `Content-Length`、identity encoding，以及精确的
  PNG、JPEG、WebP 或 GIF media type。新 digest 在读取 body 前 reservation，并在写盘时流式计算 digest
  和实际长度；已有 exact metadata 的 digest 先 pin，再以固定内存完整重验 raster gross contract、length
  与 SHA-256 后返回 200，不创建新 reservation。
- `GET /api/v1/attachments/:serverEpoch/:sha256` 只在 URL epoch 等于当前 epoch 后按 digest pin 已发布
  内容。Pin 持续到 EOF、stream error 或 Browser cancel。`Range` 返回 416，`HEAD` 明确返回 405。
- Raster admission 验证 media type、magic、最低 header/tail、gross container length/padding 和明显截断。
  它不是 codec decoder，也不证明 PNG CRC、JPEG marker graph、WebP frame semantics、GIF sub-block graph
  或像素数据可解码。Browser preprocessing 与最终 Pi/provider 消费路径仍需处理 decode failure。

- `GET /api/v1/content/:serverEpoch/:sha256` 只读取 `utf8` namespace，要求同样的 loopback、Cookie、Host、
  Origin/Fetch Metadata、精确 epoch、digest、published pin 和取消检查。成功响应固定为
  `application/octet-stream`，带 exact `Content-Length`、`Cache-Control: no-store`、
  `Cross-Origin-Resource-Policy: same-origin` 和 `X-Content-Type-Options: nosniff`。`HEAD`、`Range`、PUT、
  redirect 与 content sniffing 均拒绝；wrapper 决定 Browser 用文本解码还是 JSON 解析。

Main 从同一个 `EpochContentStore`、`serverEpoch`、canonical `payloadBudget` 与 `contentRefBudget` 构造
单一 payload activation，并把其中的 externalizer/hold services 注入 Supervisor，把完整 trusted content
context 注入 WebSocket Bridge。REST routes 使用同一个 store。Bridge 复验 exact epoch、两套 budget 与
product mode 后才广告并要求 `payload.epoch_attachment_refs`、`payload.epoch_content_refs`；缺少任一
required capability 的连接在 subscribe 前终止，不退回 inline output。

Production Pi externalization 路径中，`legacy-rpc-v1` 先用 command/event-specific
raw guard 验证来源，再只遍历明确的 image 语义槽：user、toolResult 与 custom message content，message
与 custom_message entry，`get_messages`、`get_entries`、`get_tree` 成功响应，以及 `agent_end`、
`turn_end`、`message_start`、`message_end`、`entry_appended` 事件。Tool args/result/details、Extension UI
与 opaque JSON 不递归，嵌套 lookalike 也不会获得 reference 语义。每个 inline image 先严格验证 canonical
base64，再用唯一 decoded Buffer 完成 raster admission、SHA-256 和 store staging；整帧通过 trusted product
guard 后才返回 `{value, lease}`，任一失败都会回滚该帧取得的 holds。

Typed-content 路径只遍历闭合 root-slot allowlist：tool-result/custom-message 的 text content 与 entry、
`BashExecutionMessage.output`、`ToolCallContentDto.arguments`、tool execution 的
`args`/`partialResult`/`result`、tool-result/custom-message details，以及 Extension `editor.prefill`、
`set_editor_text.text` 和完整 `setWidget.widgetLines` 数组。它覆盖 live event、replay、authoritative
snapshot 和 `get_messages`/`get_entries`/`get_tree` 三个 history response 的 1.3 full-frame roots。
Root-only walker 不递归 opaque JSON，嵌套的 `content_ref`、`external_json` 等 lookalike 仍是普通数据。
UTF-8 小于 256 KiB 的 text root 保持 string；JSON root 必须归一为 `inline_json` 或 `external_json`，
达到阈值后单 blob externalize，最大 48 MiB，不拆 chunk。

Lease 通过 PiProcess 的两阶段 decoded-delivery seam 移交，timeout、abort、late response、stale spawn 与
ownerless outcome 都会幂等释放。启用该 seam 的 Runtime 为每个 generation 建立 content owner，并在
startup history、普通 response/event、idle compaction 与 fork/clone rekey 中先接管 holds，再推进
projection、seq、replay 或 child identity。Transition ledger 只在身份未决期间保存 staged transfer，
验证 parent 后归还 parent owner，验证 child 后原子转入 child owner；不确定失败清理 parent、candidate 与
ledger，禁止发布半完成 child frame。

Correlated response 只有具备可信 limit/actual evidence 的 blob ceiling、cache bytes/items exhaustion，
以及 PiProcess 自己判定的 caller abort/deadline 才是 response-local Gateway delivery failure。Raw/product/
provenance/raster 不兼容、manifest/path safety、rollback failure 和所有 authoritative event externalization
failure 都会终止当前 Runtime。Manual/capacity stop、recoverable crash、generation roll、rekey、overflow
与 shutdown 清理 projection 和 holds；只有已建立最终 projection、没有未决 cleanup 的真实
nonrecoverable leader crash 才 seal 并保留当前 owner，直到显式 stop 或 Gateway shutdown。

Browser 从已验证的 `server_hello` 固化 `{serverEpoch,payloadBudget,contentRefBudget}`，所有后续 server frame 与 snapshot
都用该 trusted context guard。Ingress prompt image 仍是 inline-only `ImageContentDto`，projection 则保留
`SessionImageContentDto` 的 inline 或 reference data，以及 1.3 message/tool 的 typed content refs。Raster
reference 通过同源、带认证 Cookie 的相对 GET URL 直接交给 `<img>`，不先 fetch 或复制为 Blob。Text/JSON
reference 只在对应 slot 被展开或 Inspector 需要时 GET，保持 lazy。当前 authoritative baseline 的 content
加载失败只对精确 Session/generation 发起一次 cursorless resync；identity 已变化、Abort 已发生或 baseline
尚未提交时忽略旧 completion/error。每个 consumer 捕获完整的
`{serverEpoch, sessionHandle, generation}`，不能只用 digest 或当前 selected pointer 判断归属。
结构化 admission failure 按稳定 code 本地化。失败提交保留原 draft 与 images，同 Session 后续提交成功后
才清空。

Reference 消费入口必须把 canonical DTO、协商后的 blob ceiling 与当前 `serverEpoch` 作为同一次
admission 判断。Payload ceiling 必须保持 producer 不大于 consumer。Raw Pi event 到 normalized event
还要保留固定的 4 KiB canonical envelope headroom，用来容纳最大长度、最坏 JSON 转义的 Session
identity、generation、seq 与 wrapper。其他关系包括 command 到 Pi、normalized event 到 replay frame、
replay frame 到 server frame，以及 Pi snapshot 到 canonical snapshot 再到 server frame。Queue 的小
backlog ceiling 通过单个 oversized item 隔离处理，不代表合法大 frame 可以无限排队。

每一层在占用 buffer、推进 seq、写入 Pi 或发送 socket 之前执行自己的 admission。拒绝结果使用稳定的
`payload_admission_error` code 与 boundary；有实际 byte ceiling 的失败同时报告 byte limit 与 actual，
attachment cache item ceiling 使用独立的 item limit 与 actual。这个结构用于 UI 本地化和诊断，不改变
Pi response barrier、Session identity 或 controller fencing。

每个 live event 在同一串行边界中完成 raw guard、root externalization、exact owner adoption、product
guard、projection、seq、replay 与 publish。任何一步失败都不推进 seq。Replay、snapshot 和 history response
分别使用 1.3 full-frame guard，保留 typed roots 与原始 refs。Response 在 materialization 完成、captured
pending token 仍有效且 projection 覆盖 `barrierSeq` 后才 resolve；history response 的 materialization 走
独立 pending-command lane，不改变 snapshot `asOfSeq`。

Extension 的 `editor.prefill`、`set_editor_text.text` 与完整 `setWidget.widgetLines` root 在 semantic
state 或 seq commit 前 eager materialize；失败会终止当前 Runtime 或请求，不能发布半完成 Extension frame。
Tool 与 message content 默认 lazy。collapse、未打开 Inspector、切换 Session、unmount、disconnect、
rekey 或 dispose 都会 Abort 对应 consumer，late completion 经过 exact Session/generation/epoch fence 后
只释放资源，不更新 projection。
该结构由 Gateway 拥有。Pi adapter 拒绝 raw Pi response 中的同名字段，Bridge 只透传 Gateway 内部真实
`RpcError` 携带的 admission detail。

Gateway startup 只 canonicalize 一次 `webDataDir`，并只生成一次 `serverEpoch`。Preferences 取得锁后，
content store 才初始化；任一后续构造或 bind 失败都会按已取得资源的逆向依赖清理。正常 shutdown 严格按
ingress、Supervisor、content store、preferences 的顺序执行，继续收集 cleanup failure 后统一报告。
Store shutdown 会 abort active upload/download、等待已登记操作、清理未发布 temp/entry，再释放 lifecycle
lock。两个 Gateway 不能同时拥有同一个 `webDataDir` 的 content store；持锁进程只在确认 ownership 后
处理旧 epoch 和 tombstone。

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

Persistence reconciliation has three states: persisted, unpersisted, and unknown. A matching native
catalog row proves persistence. Its absence does not prove that a Session is unpersisted because the
directory may filter a materialized empty Session. Runtime evidence is accepted only when
`{serverEpoch, workspaceId, sessionHandle, generation}` matches the current inventory entry. A new
incarnation invalidates earlier persistence evidence and returns the overlay row to unknown.

Automatic initial creation waits while a relevant hot Runtime remains unknown. If exact recovery for
that identity becomes degraded and manual-only, the Browser stops waiting without creating a Session;
the user may still choose New Session explicitly. Automatic startup and explicit New Session calls
share one in-flight create operation per Workspace within one Browser. The Gateway Workspace
reservation remains the file-identity serialization boundary across requests.

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
delete 和 pool transaction，停止所有 Pi 进程，再关闭 content store，最后释放 preferences 文件锁。
重复 close 共享同一 Promise，关闭开始后所有新 mutation 都被拒绝。

## 非目标

- 不支持公网、LAN、远程账户、多用户协作或敌对本机用户隔离。
- 不把浏览器的 selected Session 写成 Pi 的全局“当前 Session”。
- 不保证无限并发、无限 replay、无限 Markdown 或无限工具输出。
- 不自动导入、复制、重写或删除用户既有 Pi JSONL。
