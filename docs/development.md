# 开发 — 工具链与规范

## 环境

- Node.js ≥ 22、pnpm 11.21.0。
- 一个可用的 Pi 运行时（见 docs/protocol.md 三层解析）。
- 编辑器建议启用 biome 插件；本项目不使用 ESLint/Prettier。

## 常用命令

```bash
pnpm install --frozen-lockfile                  # 安装（allowBuilds 已在 pnpm-workspace.yaml）
pnpm dev                                        # 先构建 protocol，再启动 server:3000 + ui:5173
pnpm build                                      # protocol + server dist + ui dist
pnpm test                                       # protocol/server/UI 的确定性单测
pnpm test:smoke                                 # fake Pi 的 REST/WS smoke
pnpm test:e2e                                   # 默认跳过；PI_WEB_RUN_E2E=1 时才使用真实 Provider
pnpm typecheck                                  # 先构建 protocol，再检查所有包
pnpm lint                                       # biome check（写修复加 --write）
pnpm verify                                     # lint → typecheck → test → build
node packages/ui/test/visual-walkthrough.mjs    # 截图走查（需 dev 双进程运行中）
```

## 验证矩阵（改动后必跑）

| 改动面 | 验证 |
|---|---|
| server 协议层 | pnpm --filter @pi-agent-web/server test |
| server REST | pnpm test:smoke + curl /api/v1/health |
| ui 投影/状态 | pnpm --filter @pi-agent-web/ui test（reducer 单测） |
| ui 视觉 | typecheck + build + visual-walkthrough 截图逐张核对 |
| 端到端对话 | PI_WEB_RUN_E2E=1 pnpm test:e2e（真实模型往返） |
| 断连/崩溃 | ws-bridge.test.ts + supervisor 崩溃退避日志 |

## 提交规范

Conventional Commits，分阶段小步提交。scope 用包名（server / ui / cli / docs）。示例：

```text
feat(server): add workspace supervisor with crash handling and ws relay
fix(ui): correct slash trigger detection for CJK punctuation
refactor(ui): migrate copy to the i18n dictionary
docs: capture protocol facts in docs/protocol.md
test(server): add disconnect-cancel protection tests
```

## 代码约定

- **注释全英文**；用户可见文案走 src/lib/i18n 字典（zh-CN 为 id 与默认文案的单一事实源，en 镜像同形状，由 typeof zhCN 编译期校验）。
- Pi RPC 类型 import 自 @earendil-works/pi-coding-agent；浏览器安全 DTO、响应 helpers 和输入 guards 由 @pi-agent-web/protocol 提供。UI 不得依赖 server 包。
- 前端组件不直接订阅 socket：帧经 stream-pipeline 路由进 store，组件只读投影。
- 缩进 tab（biome 配置），每文件末尾空行，行宽 110。
- 不在代码/文档中引用仓库外路径的文件；需要的协议事实沉淀进 docs/。

## 添加新 UI 文案

1. 在 zh-CN.ts 添加 id 与中文文案（含 {arg} 占位）。
2. 在 en.ts 镜像同 id 英文文案（编译期强制）。
3. 组件内 const { t } = useT()；非 React 模块用 tt("id", { arg })。

## 添加新特性面板

1. 状态放对应 store（分层见 docs/architecture.md）。
2. 组件放 packages/ui/src/features/<domain>/。
3. 视觉遵循 DESIGN.md（token / 圆角 / 行高 / 按压反馈），不新造颜色与圆角。
4. 交互语义遵循 docs/ui-ux.md 规则清单。
