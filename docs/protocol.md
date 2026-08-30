# 协议：Pi RPC 与 Session Web Gateway

本文区分上游 **Pi RPC** 与 Pi Agent Web 自己的 REST/WebSocket 协议。事实已对照当前依赖
`@earendil-works/pi-coding-agent@0.84.2` 与本仓库 runtime guards 核对；升级 Pi 时必须重新验证。

当前 production activation 使用 Gateway 协议 minor 3。双向 required capabilities 为
`payload.epoch_attachment_refs` 与 `payload.epoch_content_refs`，hello 同时携带完整的
`payloadBudget` 和 `contentRefBudget`。minor 1/2 的 DTO、hello 和 image-only attachment 路径是保留的
历史兼容事实，不属于当前 production Session mode。

`session.chunked_history` 是按需协商的可选能力。支持它的两端可以把超出单帧预算的 settled history
拆成有界流；未协商该能力的旧客户端仍可使用普通 snapshot，但遇到只能用分块传输的历史时会收到
`session_history_unsupported`，不会收到一个超限或不完整的 snapshot。

## 1. Pi RPC 传输

- 子进程 stdin/stdout 使用 JSONL，只按 LF 分帧；U+2028/U+2029 是合法 JSON 字符，禁止用
  `readline`。输入容忍 CRLF。
- stdout 帧分为 `response`、`extension_ui_request` 与 Agent Session event。命令可带 `id`，
  response 回传相同 id；事件本身没有命令 id。
- response 与事件只有写入顺序，没有业务因果保证。`get_*` response 可能夹在同一 Session
  的事件流中间。
- 普通 stdout 行上限 8 MiB。Pi 会把 `get_messages` 作为单行 response 输出，因此仅在该命令
  pending 期间把 reader 预算临时提高到 64 MiB；解析后，任何大于 8 MiB 的行还必须是 id 与
  command 都精确匹配当前 pending `get_messages` 的 response，否则 fail closed。完成、失败或
  timeout 后立即恢复 8 MiB；更大快照同样 fail closed。
- 不超过 8 MiB、无法解析的脏行可被容忍并丢弃；超过 8 MiB 的不可解析行按上一条 fail closed。
  形似协议帧但字段非法的 typed JSON 被当作该 Session 的协议故障，不能让扩展输出触发整个
  Gateway 的未捕获异常。

### 命令事实

| 命令 | 已验证语义 |
|---|---|
| `prompt` | 支持 `images`；流式时必须带 `streamingBehavior`；`success:true` 只表示已接受，最终错误在事件流中 |
| `steer` / `follow_up` | 分别在本轮工具闭环后、完全空闲后注入；空闲时也有效；扩展 slash command 不接受这两种投递 |
| `abort` | 中断生成与工具，待运行静止后返回 |
| `set_model` | 只接受可用模型；持久化设置并产生 `model_change`；不改变已经开始的请求 |
| `set_thinking_level` | 无效级别可能被钳制；`thinking_level_changed` 回显实际值 |
| `get_available_models` | 返回 `{models}`，只含当前已配置认证的 Provider |
| `get_available_thinking_levels` | 基础集合加模型声明的扩展级别；UI 不硬编码最终列表 |
| `new_session` / `switch_session` | Pi 支持，但 Web 将它们视为 Host-managed，浏览器导航不得直接调用 |
| `fork` / `clone` | 可被扩展取消；fork 只接受 user message entry id；成功后进程身份转到 child Session |
| `get_entries` | `since` 游标增量拉取；游标不存在时 `success:false`；返回 `{entries, leafId}` |
| `get_tree` | 返回 `{tree, leafId}`；孤儿条目成为根 |
| `get_messages` | 当前活动分支的内存消息快照，不等于完整 JSONL 历史 |
| `get_state` | 未选模型时可缺 `model`；正常持久化模式返回 `sessionId` 与 `sessionFile` |
| `get_session_stats` | 压缩边界上 `contextUsage.tokens/percent` 可为 `null` |
| `bash` | 必须带 id，以关联 `bash_execution_update{id,delta}`；结果可能延后落库 |
| `get_commands` | `{commands}`；source 为 extension/prompt/skill，skill 名带 `skill:` 前缀 |
| `compact` | 手动压缩只发 `compaction_start/end`，不保证随后有 `agent_settled` |
| `set_session_name` | 空名称报错，并写 `session_info` 条目 |
| archive | 当前依赖没有 Session 或 Workspace archive RPC；Web 不合成等价命令 |

Gateway command timeout 是本项目策略，不是浏览器输入：默认读取 30 秒，prompt/steer/
follow_up 120 秒，abort 90 秒，compact/export 120 秒。Timeout 后身份变更命令属于不确定状态，
Gateway 会停止进程并重新验证，而不是继续把它当作旧 Session。

### 事件投影

| 事件 | 投影规则 |
|---|---|
| `agent_start` | 开始 Product Turn；可先于首条 user message |
| `turn_start` | 声明模型轮次边界；不应留下无内容的永久 step |
| `message_start` | user 建消息；assistant 建/复用 step 内容；toolResult 归位到 tool call |
| `message_update` | **delta-only**；按 message、contentIndex 与事件类型追加，usage 取最新值 |
| `message_end` | 权威最终消息；全量替换内容但保持稳定 UI key |
| `tool_execution_start/update/end` | preparing → running → done/error；`partialResult` 是累积快照 |
| `turn_end` | 结算 step；其 `toolResults` 只用于统计，显示仍以 toolResult message 为准 |
| `agent_end` | `willRetry:true` 时仍未结算 Product Turn |
| `agent_settled` | Agent run 的最终结算边界 |
| `queue_update` | `{steering[], followUp[]}`，按 Session 更新 Queue Dock |
| `compaction_start/end` | `willRetry:false` 的 end 结算手动 compact；自动重试链不能提前 idle |
| `auto_retry_*` / `summarization_retry_*` | 重试与状态行 |
| `bash_execution_update` | 终端增量；Bridge 将内部执行 id 恢复为发起连接的 public id |
| `thinking_level_changed` / `session_info_changed` | 更新 Session 快照或目录；目录事件使用 forced refresh 绕过短 TTL |
| `extension_error` | Pi 直接写 stdout 的额外 wire event，不属于上游 Agent Session event union |

`stopReason`：`length` 表示截断且未执行准备中的工具；`error` 结算为错误；`aborted` 保留
partial 并标记已停止。零 delta 的 assistant start/end 是合法序列。

### Extension UI

- 阻塞方法：`select`、`confirm`、`input`、`editor`。响应分别为 `{value}`、`{confirmed}` 或
  `{cancelled:true}`；Editor 没有 Agent timeout，Host 必须在断连/进程丢失时收敛。
- 语义状态：`setStatus`、`setWidget`、`setTitle`、`set_editor_text`；相同 key 替换，clear 删除。
- Gateway 用一个有界 Runtime map 保存 sticky 语义状态；pending 与 sticky 共用 256 项、512 KiB
  Runtime 预算。容量淘汰先发布对应 clear frame，使 live observer 与后续 snapshot 收敛。
- `notify` 是瞬时 Toast，不应在 snapshot 中重复播放。
- Web 为 request 设置数量/字节上限，并以 `extension_ui_closed` 向所有订阅者公布 answered、
  cancelled、expired、process_lost 或 replaced。

## 2. 本地访问控制

Gateway 只接受 `127.0.0.1`、`localhost` 或 `::1` listener。浏览器先请求
`GET /api/v1/bootstrap`；Gateway 校验 loopback Host 与完全相同的 Origin 后写入启动期随机的
HttpOnly、SameSite=Strict Cookie。

其余 REST 与 WebSocket upgrade 必须带 Cookie：

- 有 `Origin` 时必须与请求 Host 推导出的 Origin 完全一致，包括 hostname 与 port；
- 浏览器同源 GET 缺少 `Origin` 时必须有 `Sec-Fetch-Site: same-origin`；
- Host 本身也必须是 loopback，防止 DNS rebinding 用恶意域名同源读取本机数据。

开发模式不扩大 Gateway allowlist。Vite 先按自己的 Host/Origin 或 Fetch Metadata 拒绝跨 Origin
请求，再把允许的 REST 与 WebSocket 请求改写为固定的 Gateway Origin；生产或打包启动会拒绝所有
`:5173` Origin，即使请求已携带有效 Cookie。Gateway 拒绝日志按时间窗汇总，只记录稳定原因码与
抑制计数，不记录 Cookie 或 session secret。

这层保护用于阻止普通网页跨站驱动 localhost，不是面向远程用户、敌对本机进程或共享账户的
认证系统。

## 3. Native REST

除 bootstrap 外，下列路径都位于 `/api/v1` 且需要 Cookie。

| Method / path | 语义 |
|---|---|
| `GET /health` | 服务与版本健康状态 |
| `GET /auth/status` | Provider 是否已配置，不返回 credential 内容 |
| `POST /auth/keys` | 保存一个 Provider key，并广播 `auth_changed` |
| `POST /workspaces/pick-directory` | Gateway 所在操作系统的原生目录选择器 |
| `GET /workspaces` | 从 native history、preferences 与 hot runtimes 投影 Workspace |
| `POST /workspaces` | 添加/更新 path preference；不创建另一份 Workspace 数据 |
| `POST /workspaces/:workspaceHandle/activate` | 记录 Web 最近显式使用的 Workspace；Pi 本身无 last-Workspace setting |
| `DELETE /workspaces/:workspaceHandle` | 仅移除 preference；response 明示 native history 是否保留 |
| `GET /workspaces/:workspaceHandle/sessions` | native Session 摘要；`?refresh=1` 强制绕过 catalog snapshot TTL |
| `POST /workspaces/:workspaceHandle/sessions` | 用该 Workspace 的解析布局创建独立 Pi Session runtime |
| `GET /workspaces/:workspaceHandle/sessions/:sessionHandle/process` | hot runtime，或合成的 dormant 状态 |
| `GET /content/:serverEpoch/:sha256` | 读取已发布的 UTF-8 content blob；只读、同源认证、epoch-scoped |
| `DELETE /workspaces/:workspaceHandle/sessions/:sessionHandle/transient` | fenced 地忘记 untouched、idle、未落盘 runtime；不删除文件 |
| `DELETE /workspaces/:workspaceHandle/sessions/:sessionHandle` | 受 fencing 保护的可恢复文件移动 |

Session DELETE 与 transient abandon 都额外要求：

```text
X-Pi-Session-Generation: <exact positive integer>
X-Pi-Fencing-Token: <current opaque controller token>
```

删除会在 supervisor reservation 内 force-refresh，再校验 Workspace/Session handle、Header id/cwd、
子 Session、运行状态与文件 identity。成功返回 `{ok:true,recoverable:true}`；它不承诺当前 UI 已
提供 restore/purge。

Transient abandon 只接受当前 controller 的精确 capability，且 runtime 必须 untouched、idle、
unpersisted、无 command/dialog/transition reservation。停止进程后若目标路径已经出现则返回 409
并保留 Session；成功返回 `{ok:true,abandoned:true}`，不会调用 unlink、rename 或 trash。

## 4. Browser → Gateway WebSocket

所有输入先经 `@pi-agent-web/protocol` 严格 guard，未知字段也会拒绝。单 frame 上限 8 MiB，
每连接最多 32 个 in-flight command。

| `type` | 必填字段 | 语义 |
|---|---|---|
| `session_subscribe` | `sessionHandle`, optional `{serverEpoch,generation,seq}` cursor, optional `expectedHotRuntime` | Ordinary subscribe activates on demand; an exact expected identity observes only a Runtime that is still hot |
| `session_unsubscribe` | `sessionHandle` | 停止该连接的事件消费；不停止 Pi |
| `session_claim` | `sessionHandle` | 尝试取得该 Session 的 controller lease |
| `session_release` | `sessionHandle` | 释放该连接持有的 Session lease |
| `session_restart` | `sessionHandle`, `expectedGeneration`, optional `fencingToken` | 只恢复已显式暴露给该连接的 `session_snapshot_overflow`；generation 必须精确，已有 lease 时 token 与连接也必须精确 |
| `command` | `sessionHandle`, `expectedGeneration`, optional `fencingToken`, `command` | 只读命令无需 token；mutation 必须精确匹配 token 与 generation |
| `extension_ui_response` | `sessionHandle`, `expectedGeneration`, `fencingToken`, `response` | 回应当前 generation 的待处理 dialog |

Prompt/steer/follow_up 文本按 UTF-8 编码后上限 1 MiB。可以是 image-only，但 text 与 images
不能同时为空；最多 16 张图片，每张 base64 ASCII payload 不超过 2 MiB，总 base64 payload 不超过
6 MiB。共享 guard 还会对 `JSON.stringify` 后的完整 UTF-8 browser frame 执行 8 MiB 上限，因此
反斜杠/引号转义、CJK 文本与图片组合不能绕过 transport 预算。UI 在 `WebSocket.send` 前执行同一
整帧检查，并会预先解码、缩放和压缩图片；协议 guard 是最终边界而不是图片处理器。

### Payload budget、attachment reference 与 typed content reference

协议 minor 3 同时要求 `payload.epoch_attachment_refs` 与 `payload.epoch_content_refs`。双方必须声明两项
能力，`server_hello` 必须携带完整 `payloadBudget` 与 `contentRefBudget`，并通过 producer/consumer 及
client/server frame ceiling 关系检查。缺少能力、budget、minor 3 或 frame ceiling 不足的连接在首个
Session subscribe 前终止，不存在逐连接 inline output fallback。minor 1/2 的 hello 和 DTO 仍按原合同解码，
用于兼容 fixture 与诊断，不与当前 production Session 混流。Browser-to-Gateway prompt image 与所有
Extension response 仍是 inline-only ingress。

完整 `payloadBudget` 是一个不可缺项、不可扩展的 canonical record：

| 字段 | 上限 |
|---|---:|
| `maxCommandFrameBytes` | 8 MiB |
| `maxCommandTextBytes` | 1 MiB |
| `maxInlineImageBase64Bytes` | 2 MiB |
| `maxInlineImagesBase64Bytes` | 6 MiB |
| `maxImageCount` | 16 items |
| `maxPiJsonlFrameBytes` | 8 MiB |
| `maxPiSnapshotJsonlFrameBytes` | 64 MiB |
| `maxNormalizedEventFrameBytes` | 8 MiB + 4 KiB |
| `maxReplayFrameBytes` | 8 MiB + 4 KiB |
| `maxReplayBytes` | 16 MiB |
| `maxSnapshotCanonicalBytes` | 64 MiB |
| `maxServerFrameBytes` | 65 MiB |
| `maxQueuedBacklogBytes` | 1 MiB |
| `maxCatchUpBacklogBytes` | 1 MiB |
| `maxAttachmentBlobBytes` | 8 MiB |
| `maxAttachmentCacheBytes` | 64 MiB |
| `maxAttachmentCacheItems` | 256 items |

`contentRefBudget` 是同样不可缺项、不可扩展的 canonical record：

| 字段 | 上限 |
|---|---:|
| `maxContentBlobBytes` | 48 MiB |
| `inlineContentThresholdBytes` | 256 KiB |

UTF-8 text 或 JSON root 的编码字节数严格小于 256 KiB 时保留 inline；达到 256 KiB 时使用单个 content
blob，最大 48 MiB，禁止拆 chunk。Raster attachment 仍使用 8 MiB blob 上限。两类 namespace 共用 64 MiB、
256 item cache，physical bytes 按 exact raw bytes 去重；logical content bytes 按每次 root 出现计数。

`contentRefBudget.maxContentBlobBytes` 必须不大于 `maxPiSnapshotJsonlFrameBytes`、
`maxSnapshotCanonicalBytes`、`maxServerFrameBytes` 和 shared `maxAttachmentCacheBytes`；完整 snapshot
canonical bytes 与 server frame bytes 还必须不大于 `maxSnapshotFrameBytes`。单个 raw JSONL frame 最多
64 MiB，每个 allowlisted generic root 最多 48 MiB；JSON escaping 使 raw frame 超过 64 MiB 时，在 frame
admission 阶段拒绝，不提高 framing ceiling。Active Turn 与 identity transition 的 logical content 各自
最多 64 MiB，serialized event suffix 仍受 8 MiB frame ceiling 约束。

Guard 同时验证 producer 和 consumer 的关系：完整 command frame 不大于普通 Pi line；normalized
event ceiling 必须比普通 Pi line 多出至少 `SESSION_EVENT_ENVELOPE_HEADROOM_BYTES`；normalized event
不大于 replay frame，replay frame 不大于单个 server frame；Pi snapshot line 不大于 canonical
snapshot，canonical snapshot 不大于单个 server frame。Canonical headroom 是 4 KiB，覆盖最大长度、
最坏 JSON 转义的 Session identity、generation、seq 与 event wrapper。Replay aggregate 上限为 16 MiB，
至少能接纳一个合法的最大 replay frame。

Attachment reference 的产品 DTO 是
`{type:"attachment_ref",serverEpoch,sha256,mediaType,byteLength}`。`sha256` 只接受 64 位小写十六
进制，`byteLength` 必须为正数且不超过 blob 上限。Reference 只在完全相同的 `serverEpoch` 内有效。
Gateway 重启后，旧 reference 必须 fail closed；需要的附件从 Pi 权威消息或 Runtime 状态重新
externalize，生成新 epoch 的 reference。Blob 与索引只是有界、可淘汰的派生缓存，不是 Session
持久化事实，也不能替代 Pi JSONL。

消费 reference 时必须使用组合 guard，同时验证 canonical DTO、当前连接协商的对应 blob ceiling 和预期
`serverEpoch`。只调用结构 guard 或只比较 epoch 都不足以取得 blob 读取权限。

UTF-8 content reference 的 DTO 与 wrapper 为：

```ts
{type:"content_ref", encoding:"utf-8", serverEpoch, sha256, byteLength}
{type:"external_text", ref: content_ref}
{type:"inline_json", value: JsonValue}
{type:"external_json", ref: content_ref}
```

`content_ref` 的 digest 是 raw UTF-8 bytes 的 lowercase SHA-256，byte length 必须为正 safe integer，且
不超过 `contentRefBudget.maxContentBlobBytes`。它只在 exact `serverEpoch` 内有效。JSON 不做 semantic
canonicalization，inline 与 external 采用同一 bounded JSON data-model guard，external digest 对应实际
提供给 GET 的 UTF-8 bytes。Typed wrapper 属于 Gateway-owned product DTO，Pi raw JSON 中同形对象不获得
reference 语义。

1.3 的 full-frame message、entry、tree、event、response、replay 与 snapshot DTO 都保留这些 typed roots。
允许 externalize 的 root 是 tool-result/custom-message text content 与 details、Bash output、tool-call
arguments、tool execution 的 args/partialResult/result、以及 Extension editor prefill、set_editor_text
text 和完整 setWidget widgetLines 数组。root-only walker 不递归 opaque JSON，也不拆分单个 root。直播、
replay、snapshot 和三个 history response 共用这套字段语义与 exact root guard。

Payload admission 失败使用结构化
`{type:"payload_admission_error",code,boundary,limitBytes?,actualBytes?,limitItems?,actualItems?}`。
Byte 超限与 byte cache exhaustion 同时携带 `limitBytes` 和更大的 `actualBytes`。Attachment cache
item 上限使用独立的 `attachment_cache_item_limit_exceeded` code、`limitItems` 和更大的
`actualItems`，不能用 byte 字段冒充 item evidence。能力缺失、reference 非法、epoch 不匹配或 blob
不可用不伪造 size evidence。失败的 command response 可以在可读 `error` 之外携带
`admissionError`，UI 不得依赖解析错误文案；共享 response helper 抛出的 `RpcError` 会保留这个结构。
Gateway 只有在所有表内边界已经执行、旧 epoch reference 会 fail closed 后才能实际回显并启用该能力。
`admissionError` 是 Gateway-owned 字段。Pi raw failure response 携带该字段属于协议不兼容；Bridge
只从 Gateway 内部真实 `RpcError` 透传结构，不接受普通 Error 或形似对象注入。

Correlated response 只有在有明确 limit/actual 证据的 blob 或 shared-cache ceiling exhaustion，以及
PiProcess 自己判定的 caller Abort/deadline 时，才返回 command-local failure。Malformed UTF-8/JSON、forged
wrapper、slot field guard failure、unsafe manifest/path、rollback failure、uncertain ownership，以及任何
authoritative event 或 Extension externalization failure 都是 Runtime terminal failure。Cache exhaustion
不能统一改写成 cursorless resync。

Production Pi image output 顺序是 command/event-specific raw guard → image externalization → trusted
epoch/budget product guard → redaction。Externalizer 只处理 message
content、message/custom_message entry、三个 history success response 和五类明确携带 message/entry 的
authoritative event；tool args/result/details、Extension UI 与 opaque JSON 保持原值。Late 或 unknown-id
response 只完成 command-specific raw validation 后丢弃，不调用 externalizer。Main 用同一个
`serverEpoch`、canonical 两套 budget 与 `EpochContentStore` 构造 activation，把 externalizer/hold services
注入 Supervisor，把 trusted context 注入 WebSocket Bridge；attachment 与 content routes 使用同一个 store
与 `serverEpoch`。

Externalized outcome 显式携带 provisional lease。PiProcess 只在同步 prepare 和 commit 都返回 literal
`true`、且 spawn/pending identity 仍匹配后移交 transfer；late、timeout、abort、stale 与 ownerless 路径
负责释放。Runtime owner 在 ref 进入 projection、replay 或 snapshot 前接管 hold，并跨 startup、普通
event/response、idle compaction 和 identity transition 保持 generation ownership。Correlated response
只有可信 blob/cache ceiling evidence 或 PiProcess 自身 caller abort/deadline 可转为 Gateway delivery failure；
所有 authoritative event failure、payload provenance/integrity failure 与 unsafe store state 都是 terminal。

Browser 从已验证的 `server_hello` 保存 immutable `{serverEpoch,payloadBudget,contentRefBudget}`。后续
event、response、replay、snapshot 与 history response 都必须用这个 context 通过对应 1.3 full-frame guard，
projection 才能保留 typed references。图片使用 `/api/v1/attachments/:serverEpoch/:sha256` 的同源相对
URL，不经过 fetch-to-Blob 复制；text/JSON 使用 `/api/v1/content/:serverEpoch/:sha256`，由 wrapper 决定
UTF-8 decode 或 JSON parse。

Tool 与 message roots 默认 lazy，只有消费者请求时 materialize。Extension editor、set_editor_text 与
setWidget 的完整 root 在 semantic state 或 seq barrier commit 前 eager materialize。GET、decode、JSON parse
与 field guard 使用独立 consumer AbortSignal；collapse、切换 Session、unmount、disconnect、rekey、
dispose、command timeout 或 token 失效都会 Abort。await 后必须复核 exact Session/generation/epoch 与
captured pending token，且捕获完整的 `{serverEpoch, sessionHandle, generation}`。stale/Abort completion 只释放
资源，不更新 projection。

当前 authoritative baseline 已提交且 exact identity 仍有效时，content GET 的 404、410、错误 metadata、
malformed UTF-8、JSON parse 或 slot field guard failure，只触发一次 cursorless resync。未提交 baseline、
identity 已变化、Abort 或 pending token 已失效时不触发 recovery。Materialization 完成仍必须等待 projection
覆盖 response 的 `barrierSeq`，history response 不建立 resync baseline，也不推进 snapshot `asOfSeq`。

### Attachment REST staging contract

Attachment REST 使用与其他 `/api/v1/*` 路由相同的 loopback Host、same-origin Origin/Fetch Metadata 和
bootstrap Cookie 校验。所有 attachment 成功与错误响应都携带 `Cache-Control: no-store`。REST 可达性
本身不替代 capability negotiation；production hello 必须先完成 required capability、完整 budget 与 frame
ceiling 校验。

`PUT /api/v1/attachments/:serverEpoch/:sha256` 的 request body 是 raw raster bytes：

| 条件 | 结果 |
|---|---|
| URL epoch 不是当前 `serverEpoch` | 410，`attachment_ref_epoch_mismatch` |
| digest 不是 64 位小写十六进制 | 400，`attachment_ref_invalid` |
| 缺少 `Content-Length` | 411，`content_length_required` |
| length 不是正的 safe integer | 400，`invalid_content_length` |
| length 超过 blob ceiling | 413，`payload_too_large`，携带 byte evidence |
| 非 identity `Content-Encoding` 或非 allowlisted raster media type | 415 |
| magic、gross container、截断、声明 length/digest 或 manifest 校验失败 | 422 |
| cache byte/item reservation 失败 | 507，使用 canonical cache admission code 与 evidence |
| 新 digest 发布成功 | 201，body 为 `{attachment: attachment_ref}` |
| 已有相同 digest、media type 与 length，且完整 body 重验成功 | 200，body 为同一个 canonical reference |

PUT 先按 URL digest 查询已发布内容。查询未命中（即新 digest）时，它在读取 body 前按声明长度预留
cache，并在写入私有 temp file 时流式计算 SHA-256 和实际长度；只有 validator flush、长度和 digest
全部成功后才 publish。
命中已发布 digest 时，Gateway 先 pin 该条目并精确比较 `serverEpoch`、digest、media type 与 length。
Metadata 完全相同才走重复 PUT 快路径：不创建新 reservation 或 temp file，而是在固定内存内完整流式重验
raster gross contract、实际长度和 SHA-256，成功后返回 200。任一 metadata 或 body 不匹配都返回 422，
不能只凭 URL digest 接纳重复上传。Raster validator 是安全 admission，不是图片 decoder：它只验证
allowlisted MIME、
magic、最低 header/tail、gross container size/padding 与明显截断。通过 PUT 不代表 codec-valid 或
provider 可解码。

`GET /api/v1/attachments/:serverEpoch/:sha256` 在访问 store 前执行同一 URL epoch 与 digest 校验。旧 epoch
固定返回 410，即使当前 epoch 碰巧已有相同 digest。未知或已淘汰的 digest 返回 404
`attachment_unavailable`。`Range` 返回 416；`HEAD` 返回 405 和 `Allow: GET, PUT`，不能使用 Hono 的
implicit HEAD fallback。成功 GET 返回 exact `Content-Type`、`Content-Length`，以及：

```text
Cache-Control: no-store
Content-Disposition: attachment; filename="<sha256>.<safe-extension>"
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
```

GET 先取得 published digest 的 pin，再从同一个已验证 file descriptor 建立 managed stream。EOF、stream
error、request abort 和 Browser cancel 都必须幂等 release pin；GC 不能删除仍被 pin 的 blob。未知 I/O
错误固定映射为不含本地路径的 generic 500。Store unavailable 使用 503，响应不能反射内部 Error message。

### Generic content GET

`GET /api/v1/content/:serverEpoch/:sha256` 只读取 shared `EpochContentStore` 的 `utf8` namespace。它在
触碰 store 前检查 loopback Host、同源 Origin/Fetch Metadata、bootstrap Cookie、exact current epoch 和
lowercase 64-hex digest；旧 epoch 固定返回 410，未知或已回收 digest 返回 404。成功响应固定为
`application/octet-stream`，使用 manifest 的 exact `Content-Length`，并返回：

```text
Cache-Control: no-store
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
```

`HEAD` 返回 405，`Range` 返回 416，PUT、redirect 与 content sniffing 都不支持。GET 先 pin 已发布
entry，再以同一个已验证 file descriptor 建立 managed stream；EOF、stream error、request abort 与
Browser cancel 都幂等 release pin。content route 不解释 text/json，Browser 由 `external_text` 或
`external_json` wrapper 选择 bounded UTF-8 decode、JSON parse 和原 slot field guard。

## 5. Gateway → Browser WebSocket

| `type` | 核心字段 | 语义 |
|---|---|---|
| `runtime_state` | `runtime` | Session 的 epoch/handle/workspace/id/file/generation/lastSeq/state/phase/operationCount/busyReasons/recoverable |
| `event` | epoch-aware Session envelope + `event` | 权威 Pi/extension error 事件 |
| `response` | epoch, handle, generation, `barrierSeq`, Pi response, optional previous handle | 只发回命令发起连接 |
| `lease_status` | epoch, handle, generation, `isController`, controller-only token | 当前连接在该 Session 的权限快照 |
| `resync_required` | epoch, handle, runtime, reason | initial/epoch_changed/generation_changed/gap/invalid_cursor |
| `session_snapshot` | snapshot identity, runtime, `baseSeq`, `asOfSeq`, projection state | 一个 waterline 上的原子 live baseline |
| `session_snapshot_begin` / `chunk` / `end` | snapshot identity, `snapshotId`, history metadata, settled message chunks | 大型 settled history 的有界原子 baseline |
| `session_history_page_begin` / `chunk` / `end` | request/snapshot identity, cursor, settled message chunks | 同一 snapshot 的更早 history page |
| `extension_ui_request` | sequenced request | live blocking/semantic/notify 请求 |
| `extension_ui_result` | epoch, handle, generation, request id, accepted/no_dialog/not_running | 只确认 response admission；closed 帧负责全体收敛 |
| `extension_ui_closed` | sequenced request id + reason | 所有订阅者删除对话框或 semantic request |
| `session_rekeyed` | epoch, previous handle + authoritative runtime | new/fork/clone 或 catch-up identity 迁移 |
| `hot_runtime_inventory` | epoch, monotonic revision, exact Runtime entries | Bounded full replacement of current hot Pi process ownership |
| `session_error` | epoch, handle, operation, error, optional `code`/`retryable` | subscribe/claim/release/extension response 错误；结构化字段优先于文案判断 |
| `session_directory_changed` | workspace id | 触发该 Workspace 的 forced native catalog refresh |
| `auth_changed` | optional workspace id | 重新获取模型/认证状态 |

Session envelope 是 `{serverEpoch,sessionHandle,workspaceId,generation,seq}`。Stream position 由
`{serverEpoch,sessionHandle,generation,seq}` 唯一确定。Runtime state：`starting`、`idle`、`running`、
`waiting_ui`、`crashed`、`dormant`。

### Subscribe 与 response barrier

若请求的 handle 在 catch-up 中 fork/clone 到新 handle，Bridge 先发 synthetic `session_rekeyed`，
让 UI 能关联 baseline。Bridge 的 wire 顺序为：runtime → replay，或 runtime → `resync_required` →
`session_snapshot` → lease → live suffix。catch-up 窗口的新帧先缓冲，再按完整 stream identity 与
seq 去重；unsubscribe、重复 subscribe、close 与 buffer overflow 都会取消旧 continuation。

Cursor 先校验 `serverEpoch`，再解析 handle/rekey，随后校验 generation 和 seq range。Epoch 不匹配
返回 `epoch_changed`，其他身份或范围不确定也必须显式 resync，禁止推断、补齐或静默修复 cursor。

`session_snapshot` 的 `runtime.lastSeq` 必须等于 `asOfSeq`。它包含 `baseSeq` 上的 settled messages、
严格递增且位于 `(baseSeq, asOfSeq]` 的 product projection events、queue、pending blocking Extension
requests 与 sticky Extension state。UI 原子替换 Session-scoped projection 与 Extension state，再只应用
`seq > asOfSeq` 的连续 suffix。`notify`、Controller Lease 与 fencing token 不属于 snapshot。Replay 若
跳过 `notify` 以避免重复 Toast，产生的 seq 空洞必须转为 gap resync，不能把非连续帧当作 replay。

当 settled messages 不能安全放入一个 server frame 时，baseline 改用
`session_snapshot_begin → session_snapshot_chunk* → session_snapshot_end`。Begin 携带除 settled messages
外的 snapshot state 以及 `totalMessages`、`loadedMessages`、`loadedBytes`、`totalBytes`、`nextCursor`；每个
chunk 携带有序 `chunkIndex`、消息数组、item/byte count 与 checksum；End 再确认完整 item/byte count、按序
checksum 和下一页 cursor。Begin、chunk、End 全部通过相同的 epoch、handle、workspace、generation 与
`snapshotId` 校验，只有 End 完成后 UI 才替换 baseline，不能先显示半个 snapshot。

UI 请求更早历史时发送带 `expectedGeneration`、`snapshotId`、`asOfSeq` 和 cursor 的
`session_history_page`，Gateway 返回对应的 begin/chunk/end 流。Page 必须属于当前订阅的同一 snapshot，
过期、重排、重复、checksum/count 不一致或 source fingerprint 变化都会 fail closed；取消、切换 Session、
rekey、断线和 generation 变化会中止未完成 page，late frame 不得写入新的 Session。

Pi response 到达时 Gateway 记录 `barrierSeq`。UI 必须先应用同 generation 中不大于该序号的事件，
再 resolve command。这个规则适用于所有普通 response。`get_messages` 只是一条普通只读命令；它的
response 不建立 resync baseline，也不推进 `asOfSeq`。

### 1.3 full-frame roots 与物化顺序

`event`、`replay`、`session_snapshot` 以及 `get_messages`、`get_entries`、`get_tree` 的成功 `response`
都使用并行的 1.3 product DTO，不能把 1.3 value cast 成 1.2 DTO，也不能按 payload shape 猜测版本。原始
Pi JSONL frame 先过 command/event-specific raw guard，再做 reviewed root externalization，确认 store
entry 可读后才通过 trusted epoch、两套 budget 和 product field guard。发布顺序是 projection、seq、replay、
publish；任一步失败都不推进 seq，也不发布半帧。

Tool 和 message 的 text/JSON roots 保留 reference，按需 GET。Extension 的 editor prefill、set_editor_text
text 和完整 setWidget widgetLines root 在 semantic state 或 sequence barrier commit 前必须 eager materialize。
每个 content ref 使用 exact Session/generation/epoch identity；stale identity、Abort、disconnect、rekey、
dispose 和失效 pending token 的 late completion 静默释放 hold，不写入其他 Session。History response 的
materialization 在独立 command lane 完成，仍必须先满足 captured command token、exact identity 与
`barrierSeq`，但不改变 snapshot waterline。

### Hot Runtime inventory and exact observation

The current Browser requires the negotiated `session.hot_runtime_inventory` capability. Production peers
select protocol minor 3 and admit the 1 MiB inventory ceiling. A successful
`server_hello` is followed by the initial `hot_runtime_inventory`; Session traffic is not admitted
before hello negotiation completes. A missing capability, invalid version selection, or frame limit
that cannot carry the inventory is terminal for this Browser connection.

`hot_runtime_inventory` is a full replacement, not a delta. It contains at most 256 unique Session
handles, has a canonical JSON ceiling of 1 MiB, and carries one `serverEpoch` plus a monotonically
increasing safe-integer `revision`. Every entry repeats the same epoch and contains the exact
`workspaceId`, `sessionHandle`, positive `generation`, and one of `starting`, `idle`, `running`, or
`waiting_ui`, together with a coherent `phase`, `operationCount`, and `busyReasons` observation.
A new epoch resets revision comparison. Crashed and dormant Sessions are absent.

When `session_subscribe.expectedHotRuntime` is present, its complete identity must match the outer
handle and a currently live Supervisor observation. This form is only-if-hot: it never starts a Pi
process and never falls back to ordinary activation. Identity loss produces an explicit subscribe
error. A cursor remains fully epoch-aware, so a stale but structurally valid cursor receives the
normal epoch, generation, or range resync result rather than local repair.

Exact catch-up is transactional. The Supervisor captures and revalidates the process observation,
and the Bridge installs the runtime baseline, replay or snapshot, lease snapshot, and buffered suffix
as one subscription transition. Failure leaves an existing live subscription and lease intact.
Repeated exact subscribe for an already live identity is a silent no-op. A connection admits at
most 256 concurrent exact operations; the Browser serializes fresh exact baselines so one legal
oversized snapshot cannot be multiplied across its outbound queue.

Inventory publication is fenced when a catch-up contains a pending rekey. A connection retains only
the newest deferred full replacement. On a successful identity transition, observers see the rekey
before the canonical child inventory and staged child frames. If the staged commit fails after
identity commit, they see the rekey, the inventory removal, and one terminal Runtime result, with no
staged child frames released.

Snapshots still exclude `notify`. During exact hot catch-up, the Bridge separately journals fresh
non-replayable notifications that occur in the catch-up window. The Browser delivers each such
notification once under a bounded full-identity dedupe key, including when its seq is not greater
than the snapshot `asOfSeq`. This side-effect delivery does not advance or repair projection seq and
does not change the ordinary replay-gap rule above.

### 有界性与 backpressure

- Session admission is bounded at the shared resource owners. The Supervisor defaults to 8 hot Pi
  processes and reserves up to 512 MiB for retained projection state; each hot Runtime consumes a
  conservative reservation derived from its snapshot ceiling. This is an admission budget, not an
  exact Node/Browser heap measurement. `session_runtime_capacity` and `session_projection_capacity`
  are explicit retryable-or-not decisions at the REST/WS boundary.
- Across sockets, the Gateway defaults to 64 connections, 1,024 subscribed channels, 256 concurrent
  catch-ups, 1,024 historical subscription aliases, and 65 MiB of weighted pending command-response
  reservations per connection. Large history/tree responses reserve a full server-frame weight;
  ordinary responses reserve a small bounded weight. A socket still has a 32 in-flight-command limit.
- Native discovery is streamed and budgeted per refresh: default 128 MiB/4,096 pages/5 seconds,
  clamped at 512 MiB/100,000 pages/60 seconds, with at most 8 files scanned concurrently. Per-file
  identity/revision cache entries are disposable; safe append reads only the new suffix, while
  truncate, replacement, symlink retarget, and transient I/O failure fall back to a bounded rescan.
  A partial result can carry `partial`, `stale`, and `retryable` diagnostics so callers never mistake
  an incomplete catalog for authoritative absence.
- The Browser keeps six ordinary idle/persisted subscriptions as a soft target. Hot Runtime observers
  are protected and may exceed it; the UI exposes `protected_overage` separately from a rejected
  subscription and uses `session_error.code`/`retryable` for retry decisions.
- Runtime replay 默认同时受 1024 frame 与 8 MiB 限制；startup/transition staging、Extension state、
  dialogs、UI raw events 和 resync buffers 都有独立 item/byte ceiling。
- `session_snapshot` 的完整 canonical JSON 上限为 64 MiB，最多包含 10,000 条 settled message、4,096
  条 projection event、每个 queue 分区 10,000 项、每个 Extension 分区 256 项，JSON depth 上限为 48，
  总结构项上限为 250,000。Guard 只接受 plain canonical JSON record、自有可枚举 data property 与普通
  Array；symbol、accessor、非枚举字段和 exotic container 都 fail closed。
- 分块 history 的单 chunk 最多约 64.75 MiB、256 条消息，默认发送目标约 4 MiB；每条消息仍必须独立通过
  product guard 与 server-frame ceiling。一次 snapshot/page stream 的排队权重最多 65 MiB，native reader
  还受 16 GiB 总源文件预算、上下文消息数与索引条目数预算、cursor 大小及 source fingerprint 约束。Checksum 只用于检测
  顺序与完整性，不替代 epoch、generation、Cookie 或权限校验。
- Live product event suffix 默认上限为 4,096 项与 8 MiB。每个 active Turn 的 raw product-event
  count 与完整 frame bytes 分别限制为对应 ceiling 的 50%，默认即 2,048 项与 4 MiB。发送
  `prompt`、`steer` 或 `follow_up` 前，Runtime 必须等待并复核 idle base compaction 已恢复这份
  remaining headroom，并在同一串行 admission 边界原子创建 pending reservation；容量不足时在发送
  Pi 命令前拒绝。Reservation 在 Agent 启动时转为 active，并在失败、取消、结算、stop 或 rekey 时
  释放。单个 Turn 超过 half-ceiling 时稳定 overflow，协议不承诺容纳任意 Turn，也不在本层合成
  chunk 或 rollover。
- Catch-up 与每连接应用层 outbound queue 分别限制积压。Command pending-response reservation 同时受
  per-connection、Gateway 聚合与 per-canonical-Session Runtime 上限约束；断线不会提前释放仍在 Pi
  执行的 command reservation。History page 在同一 canonical Session 上只允许一个 read，不同 Session
  可并行但受 Gateway 总并发上限约束；替换、取消、断线和 Session identity 变化会 Abort 并释放 read。
  非分块的合法 `session_snapshot` 可以成为唯一
  oversized send/queue item；其前后的普通 queued backlog 仍不得超过 1 MiB。分块 history 则受独立的
  stream queue ceiling 约束，不能借由拆 chunk 无限增加 backlog。已有 socket backlog 超过上限、出现
  第二个 oversized item 或追加 backlog 越界时才断开。非 history 的 snapshot overflow 使用稳定
  `session_snapshot_overflow` 错误，Runtime 不自动重启，Browser 也不形成永久 retry 或 Toast 循环。
- 浏览器断开时 pending command reject、catch-up 取消、controller lease 释放；不保留幽灵 token。

## 6. Pi 存储与目录配置

| 文件/目录 | 说明 |
|---|---|
| `~/.pi/agent/auth.json` | Provider credential；Gateway 只显示是否配置 |
| `~/.pi/agent/settings.json` | 全局模型、thinking、重试、压缩与可选 `sessionDir` |
| `<workspace>/.pi/settings.json` | 项目级覆盖与可选 `sessionDir`；project 覆盖 global |
| 默认 Session 目录 | `<agentDir>/sessions/--<encoded-cwd>--/*.jsonl` |
| 自定义 Session 目录 | env/global/project 指定的直接目录，不再追加 cwd 编码 |
| Web data | Workspace preferences、启动期控制数据、recoverable trash，以及 epoch-scoped derived attachment blob/manifest；不保存正常 Session 副本 |

默认目录编码只用于发现候选目录：

```text
"--" + resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--"
```

任何扫描、打开、计数或删除仍要读取 Header `cwd` 并比较 canonical real path。相对
`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 与 settings `sessionDir` 按每个 Pi child 的
Workspace cwd 解析；Gateway 必须让 Catalog 与 child 看到相同结果。

## 7. Pi runtime 解析

1. `--pi-path` / `PI_PATH`：唯一显式 expert override，可指向 executable、Pi package 目录或 rpc entry；
2. 否则从 server 模块上下文解析发行依赖的 `@earendil-works/pi-coding-agent/rpc-entry` export。

默认路径不读取启动 cwd、`PATH` 或 Homebrew Cellar。选中项先执行 3 秒/4 KiB 有界的 `--version`
probe，再以 exact version compatibility matrix 校验 adapter 与必需 capabilities。发行依赖版本、Pi
package manifest 与 probe 输出必须一致；失败使用稳定且不含路径/凭据的诊断码。

Pi stdout 先由独立的 `PI_WIRE_RUNTIME_SCHEMA_REGISTRY` 做有界 envelope 形状筛选，再由
`legacy-rpc-v1` adapter 的 raw wire guard 按 command/event 验证并转换为产品 DTO。Browser/Gateway 方向
使用独立的 `PRODUCT_RUNTIME_SCHEMA_REGISTRY`；它同样只声明浅层 envelope，产品 guard 继续负责 nested
data、UTF-8 bytes、item count、safe number、JSON depth、epoch/generation identity 与 resource budget。
这样 schema 不会把 Pi-owned opaque JSON 误认成 Gateway-owned DTO，也不会在通用 validator 中重复实现
脱敏或 ownership 检查。显式列入 non-authoritative allowlist 的 frame 可忽略；其他未知或畸形权威 frame
进入单一 `protocol_incompatible` 终态。Production Main 注入的 image externalizer 按上面的 attachment
顺序与 generation ownership 处理 image payload。

Registry 的稳定 schema id 只用于内部诊断、fixture 与 benchmark，不是对外的协议版本号。TypeScript
upstream 类型只能在 Server 中以 type-only import 参与 adapter conformance；运行时仍必须通过 raw
registry、边界 guard 与显式 redaction。升级 Pi 时先加入 exact candidate 和 current/candidate fixture，
在 `pnpm test:compat` 及 schema benchmark 通过后，人工把 candidate promotion 到 matrix current；bundled
resolver 会拒绝尚未晋级的 candidate，显式 `PI_PATH` 仍可用于专家验证。

The first WebSocket frame must be `client_hello`. A successful `server_hello` carries the Gateway
protocol major and minor, server build and epoch, Pi version, adapter id, capability intersection,
and negotiated limits. A major mismatch returns a stable `protocol_error` and closes the connection;
the UI does not reconnect automatically. Client and Gateway validate every directional required
capability. The Browser requires `session.hot_runtime_inventory`; both peers require
`payload.epoch_attachment_refs` and `payload.epoch_content_refs`. Shared negotiation validates both hello
messages, exact minor 3 selection, both capability declarations, the complete `payloadBudget`, the complete
`contentRefBudget`, and the client/server frame limit intersection. Minor 1/2 keep their previous hello and DTO
shapes for explicit compatibility decoding and diagnostics, but cannot establish a production Session connection.
`/api/v1/health/live` reports process liveness, `/api/v1/health/ready` reports Pi Host readiness, and
the legacy `/health` endpoint remains a readiness alias.

子进程继承现有 Pi 配置、Provider credentials、extensions 与环境变量；本项目不把这些内容打入
四个发行 tarball。
