# 协议 — Pi RPC 与 Session Web Gateway

本文区分上游 **Pi RPC** 与 Pi Agent Web 自己的 REST/WebSocket 协议。事实已对照当前依赖
`@earendil-works/pi-coding-agent@0.84.2` 与本仓库 runtime guards 核对；升级 Pi 时必须重新验证。

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
- `notify` 是瞬时 Toast，不应在 snapshot 中重复播放。
- Web 为 request 设置数量/字节上限，并以 `extension_ui_closed` 向所有订阅者公布 answered、
  cancelled、expired、process_lost 或 replaced。

## 2. 本地访问控制

Gateway 只接受 `127.0.0.1`、`localhost` 或 `::1` listener。浏览器先请求
`GET /api/v1/bootstrap`；Gateway 校验 Host 与允许的 loopback Origin 后写入启动期随机的
HttpOnly、SameSite=Strict Cookie。

其余 REST 与 WebSocket upgrade 必须带 Cookie：

- 有 `Origin` 时必须与允许的 loopback origin 匹配；
- 浏览器同源 GET 缺少 `Origin` 时必须有 `Sec-Fetch-Site: same-origin`；
- Host 本身也必须是 loopback，防止 DNS rebinding 用恶意域名同源读取本机数据。

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
| `session_subscribe` | `sessionHandle`, optional `{generation,seq}` cursor | 激活/订阅并获取 baseline 与 replay/resync |
| `session_unsubscribe` | `sessionHandle` | 停止该连接的事件消费；不停止 Pi |
| `session_claim` | `sessionHandle` | 尝试取得该 Session 的 controller lease |
| `session_release` | `sessionHandle` | 释放该连接持有的 Session lease |
| `command` | `sessionHandle`, `expectedGeneration`, optional `fencingToken`, `command` | 只读命令无需 token；mutation 必须精确匹配 token 与 generation |
| `extension_ui_response` | `sessionHandle`, `expectedGeneration`, `fencingToken`, `response` | 回应当前 generation 的待处理 dialog |

Prompt/steer/follow_up 文本按 UTF-8 编码后上限 1 MiB。可以是 image-only，但 text 与 images
不能同时为空；最多 16 张图片，每张 base64 ASCII payload 不超过 2 MiB，总 base64 payload 不超过
6 MiB。共享 guard 还会对 `JSON.stringify` 后的完整 UTF-8 browser frame 执行 8 MiB 上限，因此
反斜杠/引号转义、CJK 文本与图片组合不能绕过 transport 预算。UI 在 `WebSocket.send` 前执行同一
整帧检查，并会预先解码、缩放和压缩图片；协议 guard 是最终边界而不是图片处理器。

## 5. Gateway → Browser WebSocket

| `type` | 核心字段 | 语义 |
|---|---|---|
| `runtime_state` | `runtime` | Session 的 handle/workspace/id/file/generation/lastSeq/state/recoverable |
| `event` | Session envelope + `event` | 权威 Pi/extension error 事件 |
| `response` | handle, generation, `barrierSeq`, Pi response, optional previous handle | 只发回命令发起连接 |
| `lease_status` | handle, `isController`, controller-only token | 当前连接在该 Session 的权限快照 |
| `resync_required` | handle, runtime, reason | initial/generation_changed/gap/invalid_cursor |
| `extension_ui_snapshot` | handle, generation, requests | catch-up 时的原子待处理/semantic UI 状态 |
| `extension_ui_request` | sequenced request | live blocking/semantic/notify 请求 |
| `extension_ui_result` | request id, accepted/no_dialog/not_running | 只确认 response admission；closed 帧负责全体收敛 |
| `extension_ui_closed` | sequenced request id + reason | 所有订阅者删除对话框或 semantic request |
| `session_rekeyed` | previous handle + authoritative runtime | new/fork/clone 或 catch-up identity 迁移 |
| `session_error` | handle, operation, error | subscribe/claim/release/extension response 错误 |
| `session_directory_changed` | workspace id | 触发该 Workspace 的 forced native catalog refresh |
| `auth_changed` | optional workspace id | 重新获取模型/认证状态 |

Session envelope 是 `{sessionHandle,workspaceId,generation,seq}`。Runtime state：`starting`、`idle`、
`running`、`waiting_ui`、`crashed`、`dormant`。

### Subscribe 与 response barrier

若请求的 handle 在 catch-up 中 fork/clone 到新 handle，Bridge 先发 synthetic `session_rekeyed`，
让 UI 能关联 baseline。Bridge 的 wire 顺序为：runtime → replay 或 `resync_required` → Extension
snapshot → lease → live。UI 不会把 baseline 中的 `resync_required` 提前暴露给 consumer；它先原子
应用 Extension snapshot，再启动 snapshot resync，避免丢失让 Pi 阻塞的对话框。catch-up 窗口的
新帧先缓冲，再按 generation/seq 去重；unsubscribe、重复 subscribe、close 与 buffer overflow 都会
取消旧 continuation。

Pi response 到达时 Gateway 记录 `barrierSeq`。UI 必须先应用同 generation 中不大于该序号的事件，
再 resolve command。`get_messages` 是 resync 的特殊启动命令：它的 response 本身推进 snapshot barrier，
否则“等待投影后 resolve / 等 response 才重建投影”会形成死锁。

### 有界性与 backpressure

- Runtime replay 默认同时受 1024 frame 与 8 MiB 限制；startup/transition staging、Extension state、
  dialogs、UI raw events 和 resync buffers都有独立 item/byte ceiling。
- Catch-up 与每连接应用层 outbound queue 分别限制积压。单个合法 `get_messages` snapshot response
  （Pi JSONL line 不超过 64 MiB，另有固定上限的 Web envelope）可以成为唯一 oversized send/queue
  item；其前后的普通 queued backlog 仍不得超过 1 MiB。已有 socket backlog 超过 1 MiB、出现第二个
  oversized item 或追加 backlog 越界时才断开。
- 浏览器断开时 pending command reject、catch-up 取消、controller lease 释放；不保留幽灵 token。

## 6. Pi 存储与目录配置

| 文件/目录 | 说明 |
|---|---|
| `~/.pi/agent/auth.json` | Provider credential；Gateway 只显示是否配置 |
| `~/.pi/agent/settings.json` | 全局模型、thinking、重试、压缩与可选 `sessionDir` |
| `<workspace>/.pi/settings.json` | 项目级覆盖与可选 `sessionDir`；project 覆盖 global |
| 默认 Session 目录 | `<agentDir>/sessions/--<encoded-cwd>--/*.jsonl` |
| 自定义 Session 目录 | env/global/project 指定的直接目录，不再追加 cwd 编码 |
| Web data | Workspace presentation preferences、启动期控制数据与 recoverable trash；不保存正常 Session 副本 |

默认目录编码只用于发现候选目录：

```text
"--" + resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--"
```

任何扫描、打开、计数或删除仍要读取 Header `cwd` 并比较 canonical real path。相对
`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 与 settings `sessionDir` 按每个 Pi child 的
Workspace cwd 解析；Gateway 必须让 Catalog 与 child 看到相同结果。

## 7. Pi runtime 解析

1. `--pi-path` / `PI_PATH`：本项目约定，可指向 executable、安装目录或 rpc entry；
2. `PATH` 中的全局 `pi`；
3. 已安装 `@earendil-works/pi-coding-agent` 的 `dist/rpc-entry.js`，包括常见 Homebrew 布局探测。

子进程继承现有 Pi 配置、Provider credentials、extensions 与环境变量；本项目不把这些内容打入
四个发行 tarball。
