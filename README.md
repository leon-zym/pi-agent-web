# Pi Agent Web

Pi Coding Agent RPC 模式的本机 Web 工作台。它在每个已注册 Workspace 中运行一个
`pi --mode rpc` 子进程，并提供会话浏览、流式对话、工具调用、模型设置和 Extension UI。

Pi Agent Web 是单用户、本机、同源产品：服务只监听 loopback 地址；启动时会生成新的
HttpOnly session cookie。REST 与 WebSocket 控制请求必须有该 Cookie；带 `Origin` 的请求会校验
loopback 同源，浏览器同源 GET 缺少 `Origin` 时使用 Fetch Metadata 校验。

## 特性

- **一个 Workspace 一个 Pi 进程**：跨 Workspace 时先选择 Workspace，再打开其会话；不隐式切换 cwd。
- **单控制标签页**：同一 Workspace 只能有一个 controller。观察标签页可以阅读历史和事件，不能写入 Pi。
- **会话安全**：所有控制命令带预期 session id；删除会话按 Pi 返回的 `sessionFile` 比对，绝不按 UUID 猜测。
- **可靠恢复**：重连时以 Host 的 session state 收敛目录、投影和控制权；历史失败的工具调用保留失败状态。
- **有界网关**：严格 LF JSONL、8 MiB 行/帧上限、stdin backpressure、每连接命令配额与慢客户端断开。
- **本地单命令启动**：`pi-web` 同端口提供 SPA、REST 和 WebSocket，并默认打开浏览器。

Pi 运行时按以下顺序解析：`--pi-path` / `PI_PATH`、PATH 中的 `pi`、已安装 Pi 包的
`rpc-entry.js`。现有的 Pi 配置、Provider 凭据与扩展会被继承；它们不会被打包进本项目的发行物。

## 快速开始

要求 Node.js 22+ 与 pnpm 11.21.0，并且本机有可用的 Pi 运行时。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

开发模式启动 Gateway（默认 `:3000`）和 Vite（默认 `:5173`）。打开 Vite 提示的 loopback
地址，注册一个本地项目目录后即可新建会话。

生产模式使用构建后的 SPA 与 CLI：

```bash
pnpm build
pnpm start

# 透传 CLI 参数的示例
pnpm start -- --pi-path /path/to/rpc-entry.js --port 3100
```

`pi-web` 只接受 `127.0.0.1`、`localhost` 或 `::1` 作为 `--host`。常用参数：
`--pi-path <path>`、`--host <host>`、`--port <port>`、`--no-open`、`--help`。

## 验证

```bash
pnpm verify       # lint → typecheck → deterministic tests → build
pnpm test:smoke   # fake Pi 驱动的 REST / WebSocket smoke
pnpm test:e2e     # 默认跳过；PI_WEB_RUN_E2E=1 时才使用真实 Provider
pnpm test:pack    # pack 四个运行时包，临时安装并启动 pi-web
```

CI 只运行无凭据的 `pnpm verify` 和 `pnpm test:smoke`。真实 Provider 对话、图片附件、fork、
Extension editor/widget 与浏览器视觉走查是本地 release checklist，不会读取 CI 或其他人的 Pi 数据。

## 本地分发验证

运行时由四个包组成：`@pi-agent-web/protocol`、`@pi-agent-web/server`、
`@pi-agent-web/ui` 和 `@pi-agent-web/cli`。`pnpm test:pack` 会在临时目录中打包、安装四个
tarball，确认没有源码或 `workspace:*` 依赖泄漏，再通过 bin 与等价的本地 `npx` 路径启动 CLI。

公开发布是独立决策；只有包被发布后，才可使用 `npx --yes @pi-agent-web/cli --help`。

## 项目结构

```text
packages/
  protocol/ Browser-safe DTO、运行时 guards 与命令 timeout 策略
  server/   Node Gateway：jsonl / resolver / pi-process / supervisor / ws-bridge / routes
  ui/       React 19 + Vite + Tailwind v4：stores、特性组件和 i18n
  cli/      pi-web 命令：静态资源定位、单端口启动与优雅关闭
docs/       架构 / 协议 / UI-UX / 开发规范
```

## 文档

- [docs/architecture.md](docs/architecture.md) — 拓扑、控制权和数据流
- [docs/protocol.md](docs/protocol.md) — Pi RPC 与 Gateway 协议、存储事实
- [docs/ui-ux.md](docs/ui-ux.md) — 交互设计与 UX 规则
- [docs/development.md](docs/development.md) — 工具链、CI、验证与提交规范
- [DESIGN.md](DESIGN.md) — 视觉设计契约
