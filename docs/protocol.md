# 协议 — Pi RPC 事实地图

本文档是工程内对 Pi Coding Agent RPC 协议**已核实事实**的沉淀（对照 0.84.2 源码逐项验证）。编码时以本文档与 `@earendil-works/pi-coding-agent` 的类型导出为准。

## 传输与分帧

- stdin/stdout 严格 JSONL，**仅按 LF 切分**；U+2028/U+2029 是合法 JSON 字符串内容，禁止 readline；容忍行尾 \r；非 JSON 行静默丢弃。
- 命令可带可选 `id`；对应 response 回传相同 id。事件帧（`type` 为事件名）不带 id。
- stdout 三类帧：`response`（命令结果）、`extension_ui_request`（扩展 UI）、事件帧。
- ⚠ 顺序保证是「写入顺序」而非「因果顺序」：`get_*` 快照 response 可能夹在事件流中间到达。前端以事件流为权威。

## 命令矩阵（要点）

| 命令 | 关键事实 |
|---|---|
| `prompt` | 支持 `images`；流式时**必须**带 `streamingBehavior`（否则 `success:false`）；`success:true` 只表示被接受，运行失败走事件流（assistant 消息 `stopReason:"error"`）；`/` 扩展命令流式时也立即执行 |
| `steer` / `follow_up` | 排队注入（本轮工具完成后 / 完全空闲后）；空闲时发送同样有效；扩展命令被拒绝 |
| `abort` | 中断生成与工具，响应在完全静止后返回 |
| `set_model` | 不在快照中返回 `Model not found`；持久化 settings.json 并写 `model_change` 条目 |
| `set_thinking_level` | 无效级别被静默钳制；事件 `thinking_level_changed` 回显实际值 |
| `get_available_models` | 返回 `{models}` 包裹；只含已配置认证的 Provider |
| `get_available_thinking_levels` | 基础集合 off/minimal/low/medium/high；xhigh/max 仅在模型 `thinkingLevelMap` 声明时出现 |
| `new_session` / `switch_session` / `fork` | 可被扩展取消，返回 `{cancelled}`；fork 只接受 user 消息 entryId |
| `get_entries` | `since` 游标增量拉取，未命中返回 `success:false`；返回 `{entries, leafId}` |
| `get_tree` | `{tree, leafId}`；孤儿条目作为根返回 |
| `get_messages` | 仅内存中当前活动分支（不含被压缩历史；全量历史用 get_entries） |
| `get_state` | `model` 未选时缺失；`sessionFile` 在 --no-session 时缺失 |
| `get_session_stats` | `contextUsage.tokens/percent` 刚压缩后可能为 **null** |
| `bash` | **必须带 id**（关联 `bash_execution_update{id,delta}`）；结果延迟落库（挂起到 agent_end / 下一个 prompt 前） |
| `get_commands` | `{commands}` 包裹；source ∈ extension/prompt/skill；skill 带 `skill:` 前缀；内置 TUI 命令不在列表 |
| `set_session_name` | 空字符串报错；写入 `session_info` 条目 |

## Web Gateway 会话控制

浏览器先以允许的 loopback Origin 请求 `GET /api/v1/bootstrap`，获得启动期随机 secret 对应的
HttpOnly、SameSite=Strict Cookie。除了 bootstrap 外，REST 和 WebSocket upgrade 都必须通过 Cookie
校验；带 `Origin` 的请求还会校验 Origin。浏览器同源 GET 不发送 `Origin` 时，REST 仅接受
`Sec-Fetch-Site: same-origin`；服务不接受非 loopback listener。

连接随后用 `session_claim` 取得 Workspace controller lease，再发送控制命令。控制命令和 Extension
UI 回包必须携带 `expectedSessionId`；Gateway 在同一 Workspace 的互斥队列里校验 lease、当前 session
和 JSONL Header 的 Workspace 归属。`lease_status` 只说明当前连接是否拥有控制权，`session_state`
广播当前会话的 id、文件路径和递增 epoch。observer 可以订阅事件、读取快照并缓存 dialog，但不能改变
Pi 状态；取得 controller 后才显示并回应仍未过期的 dialog。

会话目录 REST 只扫描已经写入磁盘的 JSONL。Pi 刚执行 `new_session` 时，当前 Host 会话可能仍在内存中，
此时 `get_state.sessionId` / `sessionFile` 先于首条 entry 成为事实；UI 必须暂时保留这个活动会话的摘要，
不能因为目录快照为空就取消当前选择。首条 entry 落盘后，摘要再与正常扫描结果合并。

| Browser → Gateway | 必填字段 | 语义 |
|---|---|---|
| `session_listen` | `workspaceId`, `sessionId` | 建立只读事件作用域，并定向收到当前 `session_state`。 |
| `session_claim` / `session_release` | `workspaceId` | 取得 / 释放 Workspace controller lease。 |
| `command` | `workspaceId`, `expectedSessionId`, `command` | 受 lease 与 session epoch 保护的 Pi 命令。 |
| `extension_ui_response` | `workspaceId`, `expectedSessionId`, `response` | 仅原 controller 可回应其当前 session 的待处理 dialog。 |

Gateway 使用 `@pi-agent-web/protocol` 的 runtime guard 拒绝未知字段、错误类型和超出长度限制的帧。
每个连接命令分配内部 Pi id，response 回传前恢复 client id，因此不同标签页相同 client id 不会互相覆盖。
每连接最多 32 个 in-flight 命令；WS 帧和 JSONL 单行的上限均为 8 MiB；超过 1 MiB pending 输出的
慢 socket 会被关闭。

命令 timeout 是 Gateway policy，而不是浏览器输入：普通读取 30 秒，prompt/steer/follow-up 120 秒，
abort 90 秒，compact/export 120 秒。客户端只显示等于或略长于这些期限的等待状态。

## 事件流（JsonAgentSessionEvent 关键子集）

| 事件 | 投影消费 |
|---|---|
| `agent_start` | 新建 ProductTurn（running） |
| `turn_start` | 新建 AssistantStep（一轮 = 一次模型响应 + 其工具执行） |
| `message_start(role)` | user → 用户消息节点；assistant → 内容块种子；toolResult → 工具结果归位（**渲染以它为准**） |
| `message_update` | 仅含增量（无累积 snapshot）：`text_/thinking_/toolcall_{start,delta,end}` + `usage`；按 contentIndex 局部追加 |
| `message_end` | 权威最终消息，全量替换但保留 key；stopReason 裁决状态 |
| `tool_execution_start/update/end` | 两阶段状态；update 的 partialResult 是**累积快照**（覆写） |
| `turn_end` | Step 结算；`toolResults` 只用于结算统计，不渲染 |
| `agent_end` | `willRetry:true` 表示自动重试中，**不可结算 Turn** |
| `agent_settled` | 唯一 Turn 结算信号 |
| `queue_update` | `{steering[], followUp[]}` → Queue Dock |
| `compaction_start/end`、`auto_retry_*`、`summarization_retry_*` | 状态行 |
| `bash_execution_update` | 终端增量输出 |
| `extension_error` | stdout 直发帧（不在会话事件总线内），Toast 展示 |
| `thinking_level_changed` / `session_info_changed` / `entry_appended` | 目录/菜单回显 |

⚠ `session_start` / `session_shutdown` 是扩展专用事件，不出现于 stdout；以 `get_state.sessionId` 变化推断会话边界。

## stopReason 语义

- `length`：输出被上限截断，工具调用**不会执行**（Pi 会发 start+end(isError) 错误结果；前端将 preparing 工具标 skipped，永不转 running）。
- `error`：Turn → error（`errorMessage` 展示）。
- `aborted`：Turn → aborted（保留 partial，弱化「已停止」标记）。
- abort/error 可能产生零 delta 的 assistant 消息（message_start+message_end 直连），前端需容忍。

## Extension UI 子协议

- 阻塞对话框 `select/confirm/input/editor`：Agent 原地阻塞等 `extension_ui_response`；`timeout` 存在时 Agent 侧自动降级默认值（select/input/editor → undefined，confirm → false）；`editor` 无 timeout，完全依赖 Host 断连保护。
- 响应格式：`{value}` / `{confirmed}` / `{cancelled:true}`。
- 单向通知：`notify`（Toast）、`setStatus`（状态栏）、`setWidget`（仅字符串数组）、`setTitle`、`set_editor_text`。
- RPC 降级：`custom()` 返回 undefined；working indicator / footer / header / editor 组件均为 no-op；`getEditorText()` 返回 ""。

## 本地存储

| 文件 | 说明 |
|---|---|
| `~/.pi/agent/auth.json` | `Record<providerId, Credential>`；权限 600；写入用 proper-lockfile |
| `~/.pi/agent/settings.json` | 默认模型/思考级别/steering 模式/压缩与重试开关 |
| `<workspace>/.pi/settings.json` | 项目级覆盖 |
| `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl` | Append-only；首行 SessionHeader（version 3）；文件名 `<ISO时间戳>_<uuidv7>.jsonl` |

Workspace Registry 位于 Gateway 自己的数据目录（默认 agent 目录的同级 `web`）。它由单实例锁保护；
认证与 Registry 使用唯一临时文件、fsync、原子 rename 写入。`auth.json` 无法解析时拒绝覆盖以保留用户凭据。
会话目录编码只能用于定位：因为不同 cwd 可编码到同一目录，扫描、切换、删除和计数一律再比对 Header 的
`cwd` realpath。活动会话删除以 `get_state.sessionFile` 的规范化绝对路径作 409 防护，而非 Header UUID。

编码算法：`"--" + resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--"`。

环境变量（网关必须读取并透传子进程）：`PI_CODING_AGENT_DIR`（覆盖 agent 配置目录）、
`PI_CODING_AGENT_SESSION_DIR`（覆盖 Pi 的会话存储目录）。默认情况下 Pi 使用
`<agentDir>/sessions/--<encoded-cwd>--/`；显式的 `PI_CODING_AGENT_SESSION_DIR` / `--session-dir`
是“直接存储目录”，不会再自动追加 cwd 编码子目录，并且 Pi 会通过 JSONL Header 的 `cwd` 过滤列表。
因此网关的“session root + 每个 Workspace 派生目录”模型只适用于默认布局；自定义会话目录属于兼容性
配置，启用前必须用真实 Pi 验证扫描、创建、切换和重连，不应仅凭目录名称推断 Workspace 归属。

## 三层运行时解析

1. `PI_PATH` / `--pi-path`（pi-web 自定义约定，Pi 源码无此变量；可指向可执行文件或安装目录）。
2. 系统 PATH 中的全局 `pi` 命令（无缝继承配置与扩展）。
3. 内置兜底：`@earendil-works/pi-coding-agent` 的 `dist/rpc-entry.js`（**必须 rpc-entry**，非 cli.js）+ Homebrew Cellar 布局探测。

## 认证时序闭环

RPC 进程的模型快照在启动时刷新（后台 15s 周期）。Onboarding 保存 Key 后，前端收到 `auth_changed` 广播并轮询重拉模型目录（上限 20s），成功后再 `set_model`，避免命中启动时的空快照。
