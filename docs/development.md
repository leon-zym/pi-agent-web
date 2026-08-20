# 开发 — 工具链、测试与发布门禁

## 环境

- Node.js 22+；pnpm 11.21.0（以根 `packageManager` 为准）。
- 一个可解析的 Pi runtime；开发与确定性测试使用 fake Pi，不需要 Provider credential。
- Chromium 由 Playwright 管理。编辑器使用 Biome；项目不使用 ESLint/Prettier。

```bash
pnpm install --frozen-lockfile
pnpm dev                    # protocol build + server :3000 + Vite :5173
pnpm build                  # 四个 package 的发行产物
pnpm start                  # build 后由 pi-web 提供单端口 SPA/REST/WS
```

根 `pnpm start` 参数放在 `--` 之后，例如：

```bash
pnpm start -- --pi-path /path/to/rpc-entry.js --port 3100 --no-open
```

CLI 只接受 `127.0.0.1`、`localhost` 或 `::1`。

## 根命令

| 命令 | 作用 | Credential |
|---|---|---|
| `pnpm lint` | 全 package Biome + root scripts/e2e files | 无 |
| `pnpm typecheck` | 先 build protocol/server，再检查四包与 E2E TS | 无 |
| `pnpm test` | protocol/server/UI/CLI 确定性测试 | 无 |
| `pnpm build` | 清理并生成发行 dist | 无 |
| `pnpm verify` | lint → typecheck → test → build | 无 |
| `pnpm test:smoke` | fake Pi 的 authenticated REST/WS gateway smoke | 无 |
| `pnpm test:browser` | production build + packaged Chromium black-box | 无 |
| `pnpm test:e2e` | `test:browser` 的用户友好别名 | 无 |
| `pnpm test:pack` | 四 tarball → install → bin/npx help + bin 启动工作台 | 无 |
| `pnpm test:e2e:real` | 默认明确 skip；显式运行真实 Pi/provider compatibility | 有，release only |
| `pnpm --filter @pi-agent-web/ui bench:conversation` | scheduler 与 Markdown benchmark | 无 |

Focused Vitest 可以在 package 内传文件：

```bash
pnpm --filter @pi-agent-web/server exec vitest run test/session-supervisor.test.ts
pnpm --filter @pi-agent-web/ui exec vitest run test/session-transport.test.ts
pnpm exec playwright test --config tests/e2e/playwright.config.ts multi-session.spec.ts
```

Focused 绿灯不是 release gate；修改完成后仍按风险运行上层组合。

## 测试层级

| 层 | 目标 | 主要证据 |
|---|---|---|
| L0 静态 | 类型、格式、browser/server 包边界、可构建产物 | lint、typecheck、build |
| L1 单元 | guards、LF reader、identity、layout、reducer、scheduler、formatter | package Vitest |
| L2 模块集成 | 文件、process group、runtime pool、rekey、trash、shutdown | server fixtures + Vitest |
| L3 Gateway 黑盒 | Cookie/Origin/Host、REST+real WS、lease/fencing/replay/dialog/backpressure | gateway/security/bridge tests + smoke |
| L4 Packaged browser | 用户操作、同 Workspace 多 Session、后台运行、image-only、responsive、console errors | Playwright `test:browser` |
| L5 Real Pi | fake 无法证明的 upstream/provider/multimodal/queue/fork 兼容性 | opt-in `test:e2e:real` |
| L6 视觉/性能 | light/dark/mobile/zoom/states、长流公平性、Markdown/DOM profile | screenshots + benchmark |
| L7 分发 | tarball contents、依赖可发布性、bin/npx、single port、clean dist | `verify` + smoke + pack |

架构或协议改动至少要有 L1/L2 不变式与 L3/L4 中一条用户路径。UI shell/composer 改动不能用
reducer 单测代替 browser bounding-box/console 断言。删除、process 或 shutdown 改动必须覆盖 race 和
失败恢复；不能只检查 happy path。

## 确定性 browser E2E

`tests/e2e` 启动 build 后的真实 CLI、Hono、WebSocket 与 SPA，只替换 Pi RPC child。Harness 为每个
case 建立隔离的 agent/session/web/workspace/control 目录，并从 child env 过滤 credential-like 变量。

当前必须覆盖：

- cold bootstrap，无 console/page error；
- 同一 Workspace 的两个独立 Pi PID/Session 并发；A 后台流式时选择并完成 B，再切回 A；
- image-only prompt 后同一 multiplexed socket 仍能发下一条 command；
- ordinary first prompt 不被标成 steer，真实 event order 不留下空 Working step；
- 375×812 没有页面水平 overflow，composer 主控件 bounding box 都在 viewport。

失败时 Playwright 保存 screenshot 与 trace 到 `test-results/browser-e2e`；CI 只在失败时上传并保留
7 天。Fixture 文案、路径和截图不得包含维护者数据。

## 真实 Pi 验收

运行方式：

```bash
PI_WEB_RUN_E2E=1 pnpm test:e2e:real

# 可选：指定已配置且支持图片的 provider/model
PI_WEB_RUN_E2E=1 \
PI_WEB_E2E_IMAGE_MODEL=provider/model \
pnpm test:e2e:real
```

规则：

- 使用 `mkdtemp` 的 Workspace、Session root、Web data 与 Pi Agent root；只把现有 `auth.json` 和
  `models.json` 白名单复制到权限为 `0700` 的临时 Agent 目录（文件为 `0600`），不加载用户的
  `settings.json`、扩展、技能或 prompt。
- 开始前记录真实 `settings.json` 的路径/目标元数据与内容哈希，所有 Pi 子进程退出后再次比对；任何
  差异都令验收失败，测试绝不通过 snapshot/restore 覆盖并发用户修改。
- 允许使用复制后的 Pi authentication 发请求，但不扫描、修改或删除用户旧 JSONL。
- 不打印 key、Cookie、fencing token、私人 prompt/history 或 provider raw payload。
- 测试自己生成小图片与唯一 marker；清理只针对已验证的临时根。
- 未设置 opt-in 时输出明确 SKIPPED；已经 opt-in 却找不到配置好的 image-capable model 时必须失败，
  不得空洞 0-exit 假装通过。
- Release 记录通过的 provider/model 与场景，不记录 credential。

当前 suite 验证一条 socket 上两个 Session 并发、image-only、内容隔离、streaming `follow_up`、abort、
clone rekey/generation、父子 history isolation，以及 stats/tree/commands。Extension editor/widget 等尚未
自动化的 upstream surface 必须在 release checklist 明示通过或跳过理由。

## Conversation 性能

```bash
pnpm --filter @pi-agent-web/ui bench:conversation
```

Benchmark 至少报告：10k sequential reducer、scheduler coalescing、多 Session 公平性，以及大 GFM/code
settlement。它是诊断数据，不是跨机器的绝对通过阈值。原始 profile 和候选库对比放在 gitignored
`tmp/`；稳定决策写入 `docs/decisions/0005-conversation-rendering.md`。

必须保持的语义门禁：

- 同显示帧连续 compatible delta 至多一次 publication；
- hidden tab 用 bounded timer 最终追上；
- structural/error/settled/rekey/dialog boundary 不延迟；
- 一个高频 Session 不饿死其他 Session；
- 用户上翻不被吸底，settled Markdown 仍有完整 GFM/code 语义。

只有 profile 证明 DOM/layout 是剩余主瓶颈后才引入 turn virtualization；只有候选 renderer 在真实长
Markdown、Unicode、unfinished fence、GFM、highlight、DOM stability 上有证据时才替换当前 renderer。

## 视觉验收

使用 production build 与隔离 deterministic fixture；不要把开发者的真实 Session 当 demo 数据。
最小矩阵见 `DESIGN.md`。操作并截图后逐项检查：

- selected/background Session identity 与 runtime state；
- composer send/stop、附件、model/context 在 375px 的实际 bounding box；
- Details 初始关闭、上下文打开、固定 reopen 入口；
- observer、waiting_ui、crashed、resync、no-model 与 context unavailable；
- focus-visible、keyboard-only、reduced motion、200% zoom；
- ANSI/control chars、绝对路径、credential、私人标题与真实 Provider 输出均不存在。

截图不是测试替代品；功能/边界使用 Playwright assertion，审美与信息层级使用视觉 review。

## CI

GitHub Actions 使用 Node 22、pnpm 11.21.0，不读取 Pi credential 或用户目录：

1. `pnpm install --frozen-lockfile`；
2. `pnpm verify`、`pnpm test:smoke`、`pnpm test:pack`；
3. 独立 browser job 安装 Chromium 并运行 `pnpm test:browser`；
4. 同一 ref 的旧 run 会被取消；browser failure 上传 trace/screenshot。

Real Pi/provider 与人工视觉检查只在本地 release 执行，不能成为隐式 CI dependency。

## 打包与发布

Runtime 由 `@pi-agent-web/protocol`、`server`、`ui`、`cli` 四包组成。`test:pack` 在临时目录创建
tarball，检查 LICENSE/repository 元数据、拒绝残留 `workspace:*`；安装后由 bin 与等价本地 npx
验证 `--help`，再由 bin 以 fake Pi 路径启动单端口 Gateway、SPA 与 WebSocket。真实 fake child/RPC
启动由 `test:smoke` 验证。Build 在 tsc 前清理 `dist`，避免删除源码后孤儿 JS 泄漏进 tarball。

公开源码与发布 npm 包是两个门槛。除非 registry 中真的存在对应版本，不要把
`npx --yes @pi-agent-web/cli` 写成可用安装方式。

Release 前从干净 clone 运行：

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm test:smoke
pnpm test:browser
pnpm test:pack
PI_WEB_RUN_E2E=1 pnpm test:e2e:real  # 有 credential 的显式 compatibility gate
```

同时完成最终截图、安全内容扫描、文档 consistency grep、版本/tag/change record；任何跳过的 L5/L6
场景必须写原因。

## 代码与提交约定

- Biome tabs、110 columns、文件末尾换行；comments English。
- UI copy 先加 `src/lib/i18n/zh-CN.ts` id，再在 `en.ts` 同形镜像；非 React 模块用 `tt()`。
- Pi RPC types 来自 upstream package；Browser↔Gateway DTO 与 guards 只来自 protocol；UI 不 import
  server runtime。
- Components 只读 stores；socket ingestion 留在 transport/frame bus/pipeline。
- Conventional Commits，按可验证切片提交，例如：

```text
feat(server): supervise Pi at Session granularity
fix(ui): preserve background Session projections
perf(ui): coalesce compatible streaming deltas
test(e2e): cover concurrent native Sessions
docs: record Session runtime decisions
```

临时审计、benchmark raw output 与进度台账可以放 gitignored `tmp/`。决定延期的永久产品工作建
GitHub Issue，包含用户问题、成功条件、非目标、安全/性能边界与测试层级；不要把一次性 audit 原样
提交为公共契约。
