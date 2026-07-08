# Pi Agent Web

Pi Coding Agent RPC 模式的现代 Web 工作台。通过一个 Node.js 网关（Supervisor）驱动每个工作区一个 `pi --mode rpc` 子进程，在浏览器中提供完整的三栏对话工作台：会话浏览、流式对话、工具调用、模型切换、上下文计量、分支树时间旅行与扩展 UI 拦截。

> 系统通过三层运行时解析自动发现本机的 Pi 运行时（`PI_PATH` → 全局 `pi` 命令 → 内置 `@earendil-works/pi-coding-agent` 包），无缝继承你现有的 `~/.pi` 配置、Provider 凭据与扩展。

## 特性

- **Workspace 粒度进程隔离**：一个工作区一个 `pi --mode rpc` 进程；同工作区内切换会话复用进程，跨工作区切换自动校验并拒绝错乱场景。
- **严格 JSONL 协议**：仅按 LF 切分（U+2028/U+2029 安全），容忍 \r，脏行静默丢弃；bash 输出增量流式、Extension UI 双向对话框、断连自动 Cancel 保护。
- **产品级对话投影**：ProductTurn → AssistantStep → ContentBlock 三层投影，稳定 React key，Thinking 扫光折叠行、Tool Call 两阶段卡片、插队/排队 Queue Dock。
- **会话管理**：会话目录扫描（mtime 排序）、重命名/删除（血缘保护）、分支树可视化与 fork 时间旅行、HTML 导出。
- **模型与上下文**：Model/Thinking Level 两级菜单、上下文占用计量（null 感知）、会话 Token/费用统计。
- **零配置向导**：无 Provider 凭据时自动弹出 Onboarding，密钥以 600 权限写入 `auth.json`（proper-lockfile 锁）。
- **中文 / English 双语文案**：轻量字典式 i18n（zh-CN 默认，跟随浏览器语言）。

## 快速开始

要求 Node.js ≥ 22 与 pnpm ≥ 10。本机需可用任一 Pi 运行时（见上文三层解析）。

```bash
pnpm install
pnpm dev            # 网关 :3000 + Vite :5173（带 WS 代理）
```

打开 <http://localhost:5173>。左侧添加一个工作区（本地项目目录），新建会话，开始对话。

生产模式（单端口 :3000 托管构建产物）：

```bash
pnpm build          # 构建 server dist + ui dist
pnpm start          # node packages/server/dist/main.js，自动打开浏览器
```

## 验证

```bash
pnpm test           # server 单测 + 真实 pi 集成测试 + ui reducer 单测
pnpm typecheck      # 全包 tsc
pnpm lint           # biome check
```

集成测试使用真实 Pi 运行时（隔离的临时会话目录），不触碰用户数据。UI 视觉走查脚本位于 `packages/ui/test/visual-walkthrough.mjs`（Playwright，需先 `pnpm --filter @pi-agent-web/ui exec playwright install chromium`）。

## 项目结构

```text
packages/
  server/   Node 网关：jsonl / resolver / pi-process / supervisor / ws-bridge / routes
  ui/       React 19 + Vite + Tailwind v4：stores 分层 + 特性组件 + i18n 字典
  cli/      pi-web 命令（启动网关 + 打开浏览器）
docs/       架构 / 协议 / UI-UX / 开发规范
```

## 文档

- [docs/architecture.md](docs/architecture.md) — 系统拓扑与进程调度
- [docs/protocol.md](docs/protocol.md) — RPC 协议与存储事实
- [docs/ui-ux.md](docs/ui-ux.md) — 交互设计与 UX 规则
- [docs/development.md](docs/development.md) — 工具链与提交规范
- [DESIGN.md](DESIGN.md) — 视觉设计契约（颜色 / 字体 / 圆角 / 组件配方）
