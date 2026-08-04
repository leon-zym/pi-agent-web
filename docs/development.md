# 开发 — 工具链与规范

## 环境

- Node.js ≥ 22、pnpm 11.21.0。
- 一个可用的 Pi 运行时（见 docs/protocol.md 三层解析）。
- 编辑器建议启用 biome 插件；本项目不使用 ESLint/Prettier。

## 常用命令

```bash
pnpm install --frozen-lockfile                  # 安装（allowBuilds 已在 pnpm-workspace.yaml）
pnpm dev                                        # 先构建 protocol，再启动 server:3000 + ui:5173
pnpm build                                      # protocol + server + UI + CLI 的发行 dist
pnpm start                                      # 经 pi-web 在 :3000 提供 SPA、REST 和 WS
pnpm test                                       # protocol/server/UI/CLI 的确定性单测
pnpm test:smoke                                 # fake Pi 的 REST/WS smoke
pnpm test:e2e                                   # 默认跳过；PI_WEB_RUN_E2E=1 时才使用真实 Provider
pnpm test:pack                                  # 四个 tarball 的临时 npm install + CLI 启动验证
pnpm typecheck                                  # 先构建 protocol、server，再检查所有包
pnpm lint                                       # biome check（写修复加 --write）
pnpm verify                                     # lint → typecheck → test → build
node packages/ui/test/visual-walkthrough.mjs    # 截图走查（需 dev 双进程运行中）
```

根 `pnpm start` 的额外参数要在 `--` 后传递，例如
`pnpm start -- --pi-path /path/to/rpc-entry.js --port 3100`。CLI 只接受 loopback host；默认会打开浏览器，
自动化使用 `--no-open`。

## CI 与发布前验证

GitHub Actions 使用 Node 22 与 pnpm 11.21.0，且不读取任何 Pi 凭据或用户目录。它固定执行：

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm test:smoke
```

在准备 tag 或变更 package manifest 时，本地还必须执行 `pnpm test:pack`。该脚本对 protocol、server、
UI 和 CLI 创建 tarball，在临时空项目安装它们，检查只包含构建产物与精确依赖版本，然后通过 bin 和本地
`npx` 等价路径启动带 fake Pi 的单端口服务。

## 文档、开源与发布边界

文档的事实来源按以下顺序维护：架构和状态时序写入 `docs/architecture.md`，Pi/Gateway 帧和存储事实
写入 `docs/protocol.md`，交互语义写入 `docs/ui-ux.md`，视觉 token 和组件配方写入 `DESIGN.md`，
命令与验证流程写入本文。README 只保留对使用者必要的产品边界和入口。`docs/notes/` 是本地交接、
审计和草稿目录，默认被 `.gitignore` 排除，不应被代码或公开 API 引用。

仓库当前以 MIT 许可证公开预览，且处于快速迭代期；它是本机单用户工具，不是远程部署方案。公开源码
与发布可安装包是两个门槛：前者需要 README、LICENSE 和可复现验证，后者还需要版本/tag、四个包的
打包内容、干净临时目录安装和单端口启动证据。当前阶段不要求贡献指南或独立安全报告入口，真实
Provider 验收仍只在本地显式运行，不能作为 CI 的隐含依赖。

发布前最小清单：

1. 从干净 clone 执行 `pnpm install --frozen-lockfile`、`pnpm verify`、`pnpm test:smoke` 和 `pnpm test:pack`。
2. 检查 README 的快速迭代警告、MIT `LICENSE`、Node/pnpm/Pi 版本约束与包版本一致。
3. 用临时 agent/session/web 数据目录完成一次手工启动；不要读取或打包维护者个人的 Pi 数据。
4. 若要发布 npm 包，再单独核对 npm 包名、版本/tag、tarball 内容和 `npx` 入口；源代码公开不等于包已发布。

## 验证矩阵（改动后必跑）

| 改动面 | 验证 |
|---|---|
| server 协议层 | pnpm --filter @pi-agent-web/server test |
| server REST | pnpm test:smoke + curl /api/v1/health |
| ui 投影/状态 | pnpm --filter @pi-agent-web/ui test（reducer 单测） |
| ui 视觉 | typecheck + build + visual-walkthrough 截图逐张核对 |
| 端到端对话 | PI_WEB_RUN_E2E=1 pnpm test:e2e（真实模型往返） |
| 断连/崩溃 | ws-bridge.test.ts + supervisor 崩溃退避日志 |
| 分发与 CLI | pnpm test:pack + pnpm start -- --help |

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
