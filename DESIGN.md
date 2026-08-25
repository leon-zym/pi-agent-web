# DESIGN.md — Pi Agent Web 视觉与设计系统契约

本文件是所有界面与交互的视觉事实源。偏离 Token、布局、状态语言或交互模型时，PR 必须说明用户问题与验证证据。

---

## 1. 视觉主张与设计哲学

Pi Agent Web 是**安静、精确、高生产力**的本地 Agent 工作台：
- **近白编辑阅读面、浅灰导航、低 Chrome、强排版层级**。界面对齐 Linear / ShadCN 的克制设计系统，拒绝仪表盘、营销页或传统 IDE 面板墙。
- **色彩克制**：蓝色（`primary`）仅表示主要操作、运行中状态、焦点与活动链接；中性色（`ink`/`surface`/`border`）承担所有界面结构与层级。
- **终端气质**：终端质感来自于单宽字符（`SF Mono` / `JetBrains Mono`）呈现的精确工具摘要、时间、行号与 Token 统计，绝不来自于全黑底色、霓虹渐变或装饰性代码雨。
- **极简主题**：仅提供 **Light** / **Dark** / **System** 三种原生外观，拒绝引入破坏克制感的彩色主题盘。

---

## 2. 信息架构与表面划分

- **Sidebar (左栏)**：负责 Workspace 与 Session 导航、创建、搜索与后台状态感知。
- **Center (主视口)**：唯一默认主表面，承载 Session Header、主对话阅读流与粘性 Composer。
- **DetailsPanel (右侧上下文抽屉)**：三合一专注面板（`inspector` / `tree` / `debug`），**默认关闭**，仅在检查工具调用详情、代码 Diff、会话血缘分支或用户显式打开时挂载；禁止常驻空面板。
- **ChatDock (浮动协作坞)**：阻塞式 Extension UI 最小化后的浮动胶囊，停靠在 Composer 上方，解除全屏遮罩以支持无障碍阅读历史。
- **Conversation TOC (悬浮大纲轨)**：主对话右侧微缩进度刻度轨，提供长会话快速锚点与视口感知。
- **后台生命周期**：当前选中 Session 只是视图指针；Sidebar 与全局指示器必须清晰展示后台 `running` / `waiting_ui` / `crashed` 状态。

---

## 3. CSS、Token 规范与工程守卫

基于 Tailwind CSS v4；语义 Token 统一声明于 `packages/ui/src/styles/index.css`。

### 3.1 颜色语义阶梯

| Token 角色 | Light | Dark | 用途与说明 |
|---|---|---|---|
| `--color-base` | `#ffffff` | `#151517` | 主画布底色 |
| `--color-sidebar` | `#f9fafb` | `#1b1b1c` | 导航侧边栏背景 |
| `--color-surface` | `#ffffff` | `#2c2c2e` | 卡片、下拉菜单、浮层表面 |
| `--color-surface-2` | `#f4f5f7` | `#222224` | 微凸起容器、代码块、内联区块背景 |
| `--color-ink` | `#0f1115` | `#f9fafb` | 主标题与正文主要文字 |
| `--color-ink-2` | `#4c5058` | `#b7bcc4` | 次要描述、元数据、工具参数 |
| `--color-ink-3` | `#878c96` | `#7d838c` | 弱化图标、时间戳、占位符 |
| `--color-primary` | `#4176e6` | `#679efe` | 核心操作、运行指示、活动链接 |
| `--color-primary-hover` | `#3564c9` | `#7fabff` | 主色悬浮反馈 |
| `--color-primary-soft` | `#edf3fe` | `rgba(103, 158, 254, 0.14)` | 主色弱化背景（选中项、胶囊徽标） |
| `--color-user-bubble` | `#edf3fe` | `#2c2c2e` | User 消息气泡底色 |
| `--color-success` | `#16a34a` | `#4ade80` | 执行完成、成功、Diff 新增行 |
| `--color-success-soft` | `#e8f7ee` | `rgba(74, 222, 128, 0.12)` | 成功浅色容器、Diff 新增行背景 |
| `--color-warning` | `#d97706` | `#fbbf24` | 告警、等待交互、排队状态 |
| `--color-warning-soft` | `#fdf3e3` | `rgba(251, 191, 36, 0.12)` | 告警弱化背景 |
| `--color-danger` | `#dc2626` | `#ef4444` | 失败、拒绝、中断、Diff 删除行 |
| `--color-danger-soft` | `#fdecec` | `rgba(239, 68, 68, 0.12)` | 错误浅色容器、Diff 删除行背景 |
| `--color-terminal` | `#101418` | `#0d0e10` | 纯黑控制台/终端代码输出背景 |

- **对比度原则**：正文灰色（`ink-2`/`ink-3`）严禁直接置于未经减淡的高饱和度彩色背景上。
- **多维状态反馈**：状态绝不能仅依赖颜色传达，必须同时提供文案、图标、形状或 `sr-only` 屏幕阅读文本。

### 3.2 排版与字体体系

- **UI 字体**：`-apple-system, "SF Pro Text", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif`。
- **等宽字体 (Mono)**：`"SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace`。
- **字阶规范**：
  - Assistant 正文：15px / 行高 26px（提供极致阅读舒适度）；
  - UI 字阶：12px（元数据/快捷键） / 13px（辅助文本/二级菜单） / 14px（标准控件/输入框）；
  - CJK 字符严禁使用负字距（negative tracking）。
- **等宽数字（`tabular-nums`）**：所有 Token 计数、耗时、行号、百分比及历史计数强制启用 `tabular-nums`，消除数值变动时的抖动。

### 3.3 圆角、阴影与深度

- **圆角梯度**：
  - `xs (6px)`：内联代码标签、小徽标；
  - `sm (8px)`：列表行、输入框、按钮、工具条目；
  - `md (12px)`：下拉菜单、浮动卡片、对话框；
  - `lg (16px)`：抽屉面板、主容器卡片；
  - `xl (22px)`：Composer 浮动胶囊、User 消息气泡；
  - `full`：圆型 Send/Stop 按钮、状态指示圆点。
  - **嵌套圆角法则**：外层圆角 = 内层圆角 + 容器内边距（Padding）。
- **深度阶梯**：
  - 层级优先依靠背景阶梯（`base` $\to$ `surface` $\to$ `surface-2`）与间距表达，避免层层生硬边框；
  - 阴影仅用于浮层表面：Composer、Menu、Dialog、Tooltip、Toast；
  - 暗色模式下使用低透明度白色外发光边框（`border-white/8`）增强层次。

### 3.4 全局 Focus-Visible 光环与无障碍 `<Kbd>` 规范

- **Focus-Visible 环**：所有可交互元素（按钮、输入框、菜单项、卡片折叠触发器）在键盘 Tab 导航时统一触发 `ring-2 ring-primary/40 focus-visible:outline-none`，鼠标点击时不触发。
- **按键提示徽标（`<Kbd>`）**：在菜单项、按钮 Hover 提示、快捷操作中统一使用 `<Kbd>` 规范组件（如 `⌘↵`、`Esc`、`↑↓`、`1~9`）。
- **动效边界守卫**：严禁 `transition: all`，动效属性严格锁定在 `opacity`、`transform`、`color` 与 `background-color`；响应 `prefers-reduced-motion` 立即关闭非必要位移与呼吸灯。

---

## 4. 响应式布局与视口适配

### 4.1 桌面端 (Desktop ≥ 1024px)
- **Sidebar**：默认 280px，支持 264–420px 拖拽调节，可一键收拢为 56px 导航 Rail。
- **Center**：主阅读视口优先保留至少 640px，阅读轴居中（正文最大宽 700–748px，Composer 宽 760–780px）。
- **DetailsPanel**：目标宽度 360px（300–520px 可拖拽），**默认关闭**；打开时优先压缩至 300px，必要时再微幅挤压 Center。关闭后保留固定可聚焦的 Reopen Rail。
- **Conversation TOC**：悬浮于主阅读列右侧，视口右侧余量 $\ge 240\text{px}$ 时展现。

### 4.2 平板端 (Tablet 768–1023px)
- **Sidebar**：默认采用 56px Rail；Session 列表通过可滑出的覆盖层（Flyout surface）呈现。
- **DetailsPanel**：不占常驻列，以抽屉（Sheet）或 Overlay 形式按需呈现。
- **Composer**：与 Center 等宽，次要操作自动缩略为图标或短标签。

### 4.3 移动端 (Phone < 768px)
- **48px `MobileTopBar`**：紧凑 Header，整合工作区名称、当前会话标题与核心运行状态；低频操作（导出、删除、分支）收敛至 Overflow 菜单。
- **`MobileSwitcherSheet`**：工作区与会话列表转换为底部滑出的触控抽屉（Bottom Sheet），触控热区全部 $\ge 40\text{px}$。
- **`visualViewport` 软键盘适配**：基于 `window.visualViewport` 动态计算 `--app-height` 与 `--app-top`，杜绝 iOS/Android 软键盘弹出时将 Composer 顶出屏幕或遮挡视口。
- **DetailsPanel**：完全以全屏/底部 Sheet 呈现，不与主表面并排。

---

## 5. 对话主表面与内容编排 (Conversation Orchestration)

### 5.1 消息气泡规范
- **Assistant 正文**：无外层气泡包裹，直接依托近白画布排版渲染，正文行高 26px，建立极度舒适的沉浸阅读感。
- **User 消息**：右对齐淡蓝气泡（`bg-user-bubble`），最大宽度 525px，内边距 `10px 16px`，圆角 22px。
- **乐观更新对齐**：发送新消息时立即渲染 `optimistic: true` 占位气泡；当权威 `message_start` 到达时，通过 `contentShape`（文本特征 + 附件数）与 FIFO 队列精准对齐替换，杜绝重复闪烁。

### 5.2 思维链 (Thinking) 2 段式原位折叠
- **Stage 1 (流式生成中)**：
  - 固定展示 5 行高度的滚动视窗，文本增量到达时平滑自动置底（`scrollTop = scrollHeight`）；
  - 伴随 2.6s 优雅平滑的脉冲呼吸指示（`.thinking-sweep`），表明模型正在深度思考。
- **Stage 2 (结算完成 Settled)**：
  - 流式结束后，通过 CSS Grid 动画（`grid-template-rows: 0fr 1fr`）平滑折叠为**末段结论摘要（Teaser）**，仅展示思考结论的最后关键段落。
- **原位展开主交互**：
  - 点击 Thinking 卡片主体执行**原位内联平滑展开/收起**，不强行弹出侧边栏，保障主阅读轴连贯；
  - 卡片右上角提供微型 `<ExternalLink>` 图标，按需跳转至 DetailsPanel 的 Inspector 模块查看超长完整日志。

### 5.3 三级工具调用架构 (ToolGroup)
- **流式运行期守卫（防假死盲区）**：
  - 当 Agent 正在执行工具时，进行中的工具行**必须保持展开**，带有旋转/呼吸指示与实时参数摘要；绝不在流式运行期间折叠为静态汇总，确保执行透明。
- **Step 结算期聚合 (ToolGroup)**：
  - 当当前 Step 结算完成，且包含连续 $>2$ 个非交互式工具调用时，自动聚合为单行折叠汇总：  
    `⚡ 13 tool calls · read_file × 8, grep × 4, bash × 1 · 3.4s [✓ Done]`
- **Stacked 紧凑堆叠布局**：
  - 点击展开 ToolGroup 后，子条目以 Stacked 紧凑堆叠形态呈现，共享 1px 细分割线；
  - 首项顶部圆角（`rounded-t-md`），中间项直角（`rounded-none`），末项底部圆角（`rounded-b-md`）；
  - 文件修改工具（`edit_file` / `write_file`）自动计算并展示变更行数徽标（如 `+15 -2`）。
- **Tier 3 决策卡片**：
  - 仅对 Extension UI 审批、输入、选择等强人机交互保留完整卡片视觉权重。
- **悬挂工具状态收敛 (`interrupted`)**：
  - 历史会话加载或非活跃 Turn 结算时，未收到结果的工具调用统一收敛为 `interrupted`（弱化灰色标志），严禁残留永久 Loading Spinner，也绝不伪造为 `ok`。

### 5.4 行级代码 Diff 块 (`DiffBlock`)
- 在 Markdown 解析中专门拦截 ````diff` 代码块与文件编辑输出：
  - 行级解析 `+`（新增）、`-`（删除）、`@@`（Hunk 锚点）；
  - 双栏等宽 Gutter 行号渲染（原行号 / 新行号精确对齐）与 `+/-` 符号列；
  - 语义化背景：新增行使用 `bg-success-soft/30 text-success`，删除行使用 `bg-danger-soft/30 text-danger`；
  - 提供 **Clean Copy** 功能：一键复制时自动剥离行首 `+`/`-` 标记，还原纯净源码。

### 5.5 渐进式流式 Markdown 与 32KB/64KB 熔断降级
- 流式生成期间渐进渲染标题、粗斜体、列表与代码块外框，消除从纯文本到富文本的突兀跳闪。
- **熔断降级规范**：严格复用 `code-display.ts` 规范，当代码块字符超过 32KB（`MAX_SYNTAX_HIGHLIGHT_CHARACTERS`）或 64KB UTF-8 字节时，跳过高亮与 DiffBlock，降级为轻量原生 `<pre><code>` 文本容器；这只限制高亮开销，不是完整 Markdown 解析或主线程预算证明。

### 5.6 对话微缩大纲轨 (Conversation TOC)
- 主阅读列右侧悬浮纵向微缩进度条，每轮 User Turn 对应一个小刻度线。
- 鼠标悬浮或聚焦时向左平滑展开 220px 气泡卡片，展示各轮提问摘要；
- 基于 `IntersectionObserver` 精确监听当前视口中央的 Turn 并高亮对应刻度；
- **防碰撞与遮挡保护**：当视口右侧余量 $<240\text{px}$ 或正文存在超宽表格/代码块横向撑开时，TOC 自动隐藏（`visibility: hidden`），严禁遮挡正文。

---

## 6. Composer 交互与意图编排

### 6.1 基础布局与多行感知
- 底部悬浮胶囊，外层圆角 22px，1px 边框与 Level-2 柔和投影。
- 多行文本自动撑开，达到多行高度时右上角平滑浮现“70vh 展开”按钮。

### 6.2 70vh 沉浸式编辑模式与按键仲裁
- **70vh 展开模式**：点击后平滑展开为占据视口 `70vh` 高度的沉浸式编辑面板。
- **按键仲裁状态机（彻底消除 Steer / Follow-up 歧义与死锁）**：
  1. **空闲态 (Idle)**：
     - *常规高度*：`Enter` 发送，`Shift + Enter` 换行。
     - *70vh 展开*：`Enter` 保持大段落换行，`Cmd/Ctrl + Enter` 触发发送。
  2. **运行态 (Running)**：
     - *常规高度*：`Enter` 触发 **Steer（插队，当前工具闭环后注入）**；`Cmd/Ctrl + Enter` 触发 **Follow-up（排队，当前任务全部结算后执行）**。
     - *70vh 展开*：底部显示明确的 **Delivery Mode 切换器（`[Steer | Follow-up]`）**；`Enter` 保持大文本换行，`Cmd/Ctrl + Enter` **严格按当前选中的 Delivery Mode 投递**。

### 6.3 工作区 `@` 文件快速提及
- 键入 `@` 字符时在光标上方弹出文件检索浮层；
- 联动后端 `/api/native/workspaces/:handle/files:search`（带 150ms 防抖与模糊匹配）；
- 支持 `↑` / `↓` 选择、`Enter` / `Tab` 插入、`Esc` 取消；
- 插入后渲染为不可分割的原子提及 Token（如 `[@src/main.ts]`），并在提交时附加语义路径。

### 6.4 Shell 风格输入历史穿透 (↑/↓)
- 按 Session / Workspace 隔离记录已发送的 Prompt 队列（上限 50 条，`localStorage` 持久化）；
- 光标在首行且按 `ArrowUp` 调出上一条历史并暂存当前草稿；按 `ArrowDown` 恢复草稿；
- **Session Rekey 兼容**：新会话从 `pending handle` 迁移到落盘后的 `canonical realpath handle` 时，自动迁移历史记录索引。

### 6.5 只读 QueueDock 状态指示坞
- 严格遵循 Pi RPC `queue_update` 单向流事实，不虚构前端重排功能；
- 紧凑胶囊呈现当前已排队的 Steering 指令与 Follow-up 任务数量与文本摘要。

### 6.6 思考力动态分段控制器 (SegmentedControl)
- 根据所选模型支持的思考力档位（通过 `get_available_thinking_levels` 获取）自适应渲染分段控制器：
  - 无思考力支持：完全隐藏或置灰；
  - 布尔型：`[Off | On]`；
  - 多档 Effort 型：`[Off | Low | Medium | High | Max]`。

---

## 7. 人机协作与阻塞交互体验

### 7.1 Extension UI 最小化浮动坞 (ChatDock)
- 当 Agent 触发阻塞式交互（权限确认、文件写入确认、单选等）时，居中 Modal 提供右上角“**最小化**”操作；
- **最小化行为**：
  - 全屏阻断遮罩立即解除；
  - 交互卡片收缩为 Composer 上方的**浮动胶囊（ChatDock）**；
  - 用户可自由上下滚动主阅读区、查阅历史代码与上下文；
  - ChatDock 上可直接点击快捷操作（“允许”/“拒绝”），或点击“最大化”恢复全屏 Modal；
  - 保持底层 WebSocket 响应通道与超时 Deadline 持续有效。

### 7.2 结构化单选与问答卡片 (QuestionCard)
- 严格对齐 Pi Extension UI 的 `{ value: string }` / `{ confirmed: boolean }` 响应规范；
- 渲染为精致的 QuestionCard：
  - 支持键盘 `1~9` 数字键直接选择对应选项；
  - 自动识别“推荐项”（Recommended）并默认高亮；
  - 支持 Write-in 自定义文本输入单选。

### 7.3 柔性幂等退让 (Soft Idempotency)
- 在用户点击 `Abort` 或响应已过期的 Extension UI 请求时，若后端返回“已结算/已过期/无进行中任务”等竞态结果，客户端统一按**柔性无操作（Soft No-op）**处理，禁止弹出侵入式红色错误 Toast。

---

## 8. 辅助抽屉与多感官系统反馈

### 8.1 DetailsPanel 三合一专注抽屉
- 右侧上下文面板**默认关闭**，杜绝多面板拥挤感：
  1. `inspector`：当前选中工具调用的入参、完整标准输出、格式化数据及**局部代码 Diff 高亮**；
  2. `tree`：Pi 原生 Session 分支与血缘树，支持从任意节点 Fork；
  3. `debug`：原始 WebSocket 事件流追踪与运行时状态。

### 8.2 Web Audio 轻柔提示音
- 原生 Web Audio API 合成 120ms 正弦波升调（440Hz $\to$ 880Hz）；
- 在任务执行完成或触发 Extension UI 等待确认时播放；无需下载外部音频资产；设置中提供静音开关。

### 8.3 后台 Tab 状态感知
- 当页面处于后台标签页时，根据 Session 状态动态更新 `document.title`（如 `[运行中] Pi Agent Web`、`[待确认] Pi Agent Web`）；
- 在 Favicon 绘制状态红点/蓝点。

---

## 9. 客户端生命周期与健壮性契约

### 9.1 WebSocket 订阅 LRU admission target（带 Running 活性守卫）
- `MAX_ACTIVE_SUBSCRIPTIONS = 6` 是 idle/persisted 订阅的软 admission target，不是所有状态下的硬上限；
- **前置活性守卫**：达到目标后，仅允许淘汰 `state === "idle"` 或 `"dormant"`、已持久化且没有待处理 Extension 请求的会话。处于 `running`、`waiting_ui`、`starting`、`unpersisted` 的会话必须常驻订阅，受保护会话可能使活跃数暂时超过目标。

### 9.2 悬挂工具状态收敛
- 进程崩溃、网络断开或用户 Abort 导致未返回结果的工具调用，视图层统一收敛为 `interrupted` 状态，显示弱化灰色标记，杜绝永恒 Loading Spinner。

---

## 10. 设计系统反模式与禁止项

- **禁止装饰性彩色渐变**：严禁 `bg-gradient-*`、`linear-gradient`（`index.css` 的 `.thinking-sweep` 呼吸动画除外）。
- **禁止玻璃拟态滥用**：严禁任意添加 `backdrop-blur`（仅 TopBar 与 Modal 遮罩提供受控单点支持）。
- **禁止全局过度动效**：严禁使用 `transition: all`，所有动效严格限制于 `opacity` 与 `transform`。
- **禁止任意 Z-Index**：严禁使用非标 `z-[9999]` 类，严格遵循 Tailwind 阶梯规范（`z-10` $\to$ `z-50`）。
- **禁止硬编码 Hex 颜色**：严禁在组件中使用原始 `#rrggbb` 颜色，所有颜色必须走语义 Token。
- **禁止制造 IDE 面板墙**：严禁为了“像 IDE”增加未定义价值的永久文件树、终端或多面板。

---

## 11. 视觉验收矩阵

每次影响 Shell / Conversation / Composer 的改动，至少验证：
1. **多主题与多视口**：Light / Dark；1440px、1280px、1024px、768px、375×812px；200% Zoom；`prefers-reduced-motion`。
2. **完整生命周期状态**：empty、loading、no-model、running、waiting_ui、observer、crashed、reconnect/resync、error。
3. **极值内容压力**：超长中英文标题、超长路径、大尺寸图片、超长 Markdown/代码、50+ 工具连续调用、后台 Session 并发更新。
4. **自动化工程守卫**：运行 `node scripts/check-style.mjs` 与 `pnpm lint` 零错误通过。
