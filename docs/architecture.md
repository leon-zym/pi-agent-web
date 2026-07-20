# 架构 — Pi Agent Web

## 拓扑

```text
Browser (React SPA)
  │  REST  /api/v1/*（工作区、会话目录、认证、进程诊断）
  │  WS    /api/v1/ws（命令、事件流、Extension UI）
  ▼
Web Gateway (Node.js, Hono + ws)
  ├─ WorkspaceRegistry   工作区注册表（Host 职责，持久化于 Web 数据目录）
  ├─ Supervisor          Workspace 粒度进程管理器
  │    ├─ PiProcess      pi --mode rpc 子进程封装（严格 JSONL、就绪握手、stderr 环形收集）
  │    └─ 每个工作区一个子进程（cwd = 工作区根目录）
  ├─ WsBridge            WS <-> JSONL 中继（命令关联、会话过滤、断连 Cancel 保护）
  └─ Resolver            三层 Pi 运行时解析
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

## 数据流

```text
用户提交 → Composer 状态机（plain / trigger / submitting）
  → WsClientMessage{command} → Supervisor.sendCommand
      → controller / expectedSessionId / 工作区归属校验 → PiProcess.send（自动补 id）
      → pi 进程执行 → stdout 三类帧：
          response  → 按 id 回给发起连接（仅该标签页）
          event     → 按 (workspace, session) 广播给声明监听的连接
          extension_ui_request → 同上（对话框排队渲染，逐个应答）
  → 前端 transportStore（原始事件环形缓冲 200 条）
  → projection reducer（纯函数流式装配状态机）
  → 组件（只消费投影，不读原始事件）
```

**权威性规则**：事件流是权威；`get_messages` 等快照只用于首次加载与重连回放，且不得覆盖正在运行中的投影（replayable 门控）。

## 重连快照协议

WS 重连成功后依次：`get_state`（sessionId 与本地不一致则清空投影）→ `get_messages` 重建 → `get_commands` / 模型目录 / 会话统计刷新。期间实时事件照常投影。

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

- 认证状态接口只返回脱敏信息；API Key 仅经 `POST /api/v1/auth/keys` 写入（600 权限 + proper-lockfile）。
- 会话删除做双防护：运行中会话 409、有子会话引用的 409（血缘保护）。
- 文件路径接口做目录存在/可读校验；会话 id 参数做 basename 校验防穿越。
