# 架构 — Pi Agent Web

## 拓扑

```text
Browser (React SPA)
  │  bootstrap Cookie → authenticated REST / WS
  │  @pi-agent-web/protocol DTO + runtime guard
  ▼
Web Gateway (Node.js, Hono + ws)
  ├─ Access control      loopback + Origin + HttpOnly session Cookie
  ├─ WorkspaceRegistry   工作区注册表（Host 职责，持久化于 Web 数据目录）
  ├─ Supervisor          Workspace 粒度进程管理器
  │    └─ WorkspaceRuntime { PiProcess, session { id, file, epoch }, controller lease }
  ├─ WsBridge            WS <-> JSONL 中继（命令关联、会话过滤、断连 Cancel 保护）
  └─ Resolver / PiProcess 三层运行时解析与严格 JSONL 子进程封装
```

## 进程模型（关键不变量）

1. **1 Workspace = 1 进程**：进程 cwd 与扩展/技能/项目设置在启动时固定；`switch_session` / `new_session` / `fork` 只替换进程内部会话，不改变 cwd。
2. **同工作区切会话复用进程**；跨工作区 `switch_session` 一律拒绝。浏览器必须先显式选择目标 Workspace，再打开其中的会话；Supervisor 在 `switch_session` 前同时校验会话目录与首行 Header 的 `cwd` 真实路径，目录编码只用于定位，不能作为工作区归属依据。
3. **就绪握手**：协议没有就绪帧。spawn 后发送 `get_state{id:"ready-1"}`，收到同 id response 视为就绪；超时（默认 10s）杀进程并广播 `process_status: "crashed"`。就绪后立即 `get_commands` 预热 Slash 菜单。
4. **崩溃容错**：进程退出时 Supervisor 合成 `process_status: "crashed"`（死进程无法自报）。30 秒窗口内自动重启上限 3 次（指数退避），超出后仅保留手动重启。
5. **断连保护**：WS 网关按 (workspaceId, sessionId) 聚合连接计数；归零时代发 `extension_ui_response{cancelled:true}`（幂等，超时已降级的请求会被 Agent 静默忽略）。
6. **会话文件安全**：`get_state.sessionFile` 是运行中会话的文件身份；删除、`new_session`、`fork`、`clone` 和 `switch_session` 通过同一工作区互斥队列串行，删除前以规范化文件路径比对活动文件并检查同工作区子会话。
7. **stderr 单独收集**：RPC 模式接管 stdout，第三方写 stdout 会被重定向到 stderr；网关只把解析成功的 stdout 帧转发，脏行丢弃。
8. **控制权与会话纪元**：每个 Workspace 同时只能有一个 WS controller；控制命令携带 `expectedSessionId`，Supervisor 在互斥队列内验证 lease 与会话身份。`session_state` 广播 `{ id, file, epoch }`，断开 controller 后 lease 自动释放。
9. **本机同源边界**：Gateway 仅监听 `127.0.0.1`、`localhost` 或 `::1`。每次启动生成随机 secret；浏览器先请求 `/api/v1/bootstrap` 获得 HttpOnly、SameSite=Strict Cookie。带 `Origin` 的 REST 与 WS 校验允许的 loopback Origin；浏览器同源 GET 缺少 `Origin` 时，REST 以 `Sec-Fetch-Site: same-origin` 校验。
10. **资源上限**：JSONL 与 WS 单帧均不超过 8 MiB；每连接最多 32 个 in-flight 命令；socket 积压超过 1 MiB 时关闭。Pi stdin 等待 `drain`，进程输出超长行被当作协议错误处理。

### 会话状态的双层事实

Pi 新建会话后，`get_state` 可能先返回一个只有 `sessionId` / `sessionFile` 的内存会话，直到首条
entry 写入后才在磁盘上出现可扫描的 JSONL 文件。因此：

- Supervisor 的 `{ id, file, epoch }` 是运行期 Host 状态的权威来源；
- `GET /api/v1/workspaces/:id/sessions` 是持久化目录的快照，不保证立即包含刚创建的空会话；
- `sessionDirectoryStore` 在当前 Workspace 中把 Host 的活动会话合并成临时摘要，首条 entry 落盘后再由扫描结果接管；
- 重连时只有在 Host 会话既不在持久化目录、也没有可用的活动文件身份时，才清空选择并显示恢复失败。

这条边界避免“新建成功但 Composer 没有可选会话”的竞态，也避免用旧投影猜测当前会话。

## 数据流

```text
浏览器启动 → GET /api/v1/bootstrap（允许的 Origin）→ HttpOnly Cookie
用户提交 → session-controller 统一附加 expectedSessionId
  → WsClientMessage{command} → WsBridge runtime guard + connection 内部 id
      → Supervisor transition mutex：controller / expectedSessionId / 工作区归属校验
      → PiProcess.send（可信的命令级 timeout）→ pi 进程执行 → stdout 三类帧：
          response  → 由内部 id 映射回发起连接的 client id
          event     → 按 (workspace, session, epoch) 广播给声明监听的连接
          extension_ui_request → 只允许 controller 回应；对话框按 deadline 清理
  → 前端 transportStore（原始事件环形缓冲 200 条）
  → projection reducer（纯函数流式装配状态机）
  → 组件（只消费投影，不读原始事件）
```

**权威性规则**：事件流是权威；`get_messages` 等快照只用于首次加载与重连回放，且不得覆盖正在运行中的投影（replayable 门控）。

## 重连快照协议

WS 重连成功后依次：`get_state` → 刷新该 Workspace 的会话目录 → 以 Host session id 找到持久化摘要，
必要时合并 Host 的活动空会话 → 原子更新当前摘要、投影 key、listen scope 与 epoch → `get_messages` 重建
→ `get_commands` / 模型目录 / 会话统计刷新。如果 Host 会话既不在目录也没有有效活动文件身份，清空选择并
显示恢复失败，而不是把数据写回陈旧投影。期间实时事件只接受匹配当前 session 与 epoch 的帧。

## 前端状态分层

| Store | 职责 | 生命周期 |
|---|---|---|
| transportStore | WS 状态、命令关联、原始事件窗口、进程状态 | 全局单例 |
| sessionDirectoryStore | 工作区/会话目录、搜索、当前会话 | 全局单例 |
| projectionStore | 会话投影（turns/steps/blocks/usage），纯 reducer 可重建 | 按 sessionId 分区，保留最近 3 个 |
| viewStore | 展开状态、面板模式、工具选择（纯 UI，不写回） | 按 sessionId 清理 |
| composerStore | draft / trigger / 附件 / 队列意图 / delivery mode | 全局常驻 |
| modelDirectoryStore | 模型目录、思考级别、当前选择（Host 报告为唯一真相） | 按工作区缓存 |
| extensionUiStore | 待应答对话框、状态栏、widget | 全局 |
| sessionStatsStore | Token/费用/上下文占用（null 感知） | 当前会话 |
| slashCommandsStore | get_commands 缓存 | 按工作区 |

## 目录约定

- `packages/server/src/`：jsonl.ts（分帧）→ pi-process.ts（进程）→ supervisor.ts（调度）→ ws-bridge.ts（中继）→ routes.ts（REST）→ main.ts（装配）。
- `packages/ui/src/stores/`：transport / projection(+reducer) / session-directory / composer / model-directory / view / extension-ui / session-stats / slash-commands。
- `packages/ui/src/features/`：sidebar / conversation / composer / details / extension-ui。
- `packages/ui/src/lib/`：i18n / stream-pipeline（帧路由）/ session-controller（编排）/ api / format / use-theme。

## 安全边界

- **访问控制**：`/api/v1/bootstrap` 是唯一不需要 session Cookie 的 API。带 `Origin` 的请求必须使用允许的
  loopback Origin；浏览器同源 GET 不带 `Origin` 时，REST 只接受 `Sec-Fetch-Site: same-origin`。其余 REST
  与 WS upgrade 都需要 session Cookie，Vite 开发期只额外允许三个 loopback `:5173` Origin。
- **命令隔离**：observer 没有 lease 时不能 prompt、abort、切换、创建、fork、重命名、设置模型或回应
  Extension UI。断开后只释放该连接的 lease 与待处理的内部命令映射。
- **数据身份**：Workspace 以 `realpath` 身份化；会话扫描、切换和计数都以 JSONL Header 的 `cwd` 校验
  归属，不能依赖会话目录编码。删除前读取 Header，比较规范化绝对 `sessionFile`。
- **持久化**：认证与注册表通过锁、唯一临时文件、fsync 和原子 rename 更新。认证文件损坏时拒绝覆盖；
  注册表数据目录以单实例锁保护。
- **进程与浏览器**：Pi 在 POSIX 上作为独立进程组停止；浏览器打开使用参数数组 spawn，host/port 在调用
  前经过 loopback 校验，不经过 shell。

## 运行与分发

`packages/cli` 的 `pi-web` 解析 `--pi-path`、`--host`、`--port` 与 `--no-open`，定位已安装的
`@pi-agent-web/ui/dist`，再调用 `startServer()`。CLI 自己处理 SIGINT/SIGTERM，等待 Gateway 和 Pi
进程关闭。运行时包只有 `@pi-agent-web/protocol`、`@pi-agent-web/server`、`@pi-agent-web/ui` 和
`@pi-agent-web/cli`；每个 tarball 除 package manifest 外只包含 `dist`，不会包含认证、会话或 Pi 本体。
