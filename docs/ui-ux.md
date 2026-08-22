# UI/UX — Session 工作台交互契约

视觉 Token 与组件配方见 [DESIGN.md](../DESIGN.md)；本文件规定用户可观察的交互行为。页面的
selected Session 只是显示指针，不能被误写成 Gateway 或 Pi 的唯一“当前会话”。

---

## 1. Workspace 与 Session 导航

- **Workspace 来源与管理**：Workspace 来源于 Pi 历史记录的 Header `cwd`，也可以由用户 Pin 本地目录创建。添加操作调用 Gateway 所在系统的原生目录选择器，不要求用户手输绝对路径。
- **偏好隔离**：移除 Workspace 只移除展示/发现偏好，绝不删除 Native history。项目级自定义 `sessionDir` 可能因此暂时不再出现在目录中；重新添加同一路径立即恢复发现，确认文案必须清晰说明。
- **后台多会话并发感知**：Session 行的运行状态严格独立于选中状态。在会话 A 正在执行流式生成或工具调用时切换到会话 B，A 继续在后台运行并在 Sidebar 实时更新其状态指示（`running` / `waiting_ui`）；切回 A 立即呈现已有最新投影，不向 Pi 发送冗余的 `switch_session`。
- **启动与新建会话**：启动时根据 Web 的 `lastOpenedAt` 选择默认 Workspace，并自动进入一个新的空 Session，绝不自动打开历史第一项。展开/收起 Workspace 树只加载或折叠目录，不改变当前选中的 Workspace/Session、订阅通道或 Lease。
- **未落盘瞬态防污染**：新建且尚无对话的 Session 只存在于当前 Header/Composer 表面，不进入 Sidebar 列表，不计入 Workspace 历史数量。只有当 Pi 成功落盘包含首条 User 消息的 JSONL 后，才由 Catalog Refresh 一次性发布列表项与标题；未交互即离开的 Transient Session 自动执行 Abandon，不在文件系统留下垃圾。
- **多感官与后台 Tab 感知**：
  - **轻柔提示音**：任务执行完成或触发 Extension UI 等待确认时，通过 Web Audio API 播放 120ms 正弦升调提示音（440Hz $\to$ 880Hz），可在偏好设置中一键静音；
  - **动态标题与 Favicon 徽标**：页面处于后台标签页时，根据 Session 状态动态更新 `document.title`（如 `[运行中] Pi Agent Web`、`[待确认] Pi Agent Web`）并在 Favicon 绘制状态红点/蓝点。

---

## 2. Session 选择与客户端生命周期

选择 Session 时按标准流水线执行：恢复该 Session 的本地 Store 视图 $\to$ 订阅 WebSocket Channel $\to$ 在 Baseline 同步完成后按需 Claim 控制权。离开 Session 时：

- **骨架屏平滑过渡**：新建与尚无 Projection 的历史 Session 先呈现骨架屏（Skeleton）；只有 Authoritative 空快照才能展示 First-turn 引导页。新建请求开始时旧对话立即退出可见树，迟到的 Create Response 不得把用户从后来选中的 Session 抢回。
- **WebSocket 订阅 LRU 有界淘汰（带 Running 活性守卫）**：
  - 单个客户端 WebSocket 连接的活跃会话订阅池上限为 `MAX_ACTIVE_SUBSCRIPTIONS = 6`；
  - **前置活性守卫**：**仅允许淘汰 `state === "idle"` 且已持久化的会话**。处于 `running`、`waiting_ui`、`starting`、`unpersisted` 的会话必须常驻订阅，严禁退订，确保后台任务流、音频提示与审批弹窗持续生效。
- **瞬态收敛 (Transient Abandon)**：离开未落盘、idle、无草稿/Command Tag/附件及处理、queue、对话或 Extension UI 的 Session 时，使用 exact generation + fencing token 请求 Transient Abandon，Gateway 仅停止并清理内存 Runtime，绝不误删文件。
- **崩溃结算与状态隔离**：进程 Crash 时先将当前 Step/Turn 结算为可见错误，再释放资源；Draft、附件、模型配置、命令目录、Token 用量与 Extension UI 完全按 `sessionHandle` 隔离。

---

## 3. Controller、Observer 与柔性幂等

每个 Session 拥有独立的 Controller Lease。一个浏览器 Tab 可控制多个 Session，不同 Tab 可各自控制不同 Session；同一 Session 的第二个打开者为 Observer。

- **Observer 只读模式**：Observer 可实时浏览历史、流式事件、Tool Output 与待处理 Extension UI，但 Composer、中断按钮及所有 Mutation 控件显式呈现为只读禁用态，并展示“另一个标签页正在控制此 Session”的原因说明。
- **Lease 释放与接管**：Controller 标签页关闭、释放或断网时，Observer 重新选择该 Session 即可取得新 Baseline 并按 Controller 意图完成 Claim。
- **柔性幂等退让 (Soft Idempotency)**：用户点击 `Abort` 或响应已超时的 Extension UI 请求时，若后端返回“已结算/已过期/无进行中任务”等竞态结果，客户端统一按**柔性无操作 (Soft No-op)** 吸收，不弹出侵入式红色错误 Toast，界面平滑过渡至 Idle 状态。

---

## 4. Composer 输入控制与意图编排

Composer Visual Seat 固定于 Center 底部，同一 DOM 延续焦点，数据与输入历史按 Session 严格隔离。

- **工作区 `@` 文件快速提及**：
  - 键入 `@` 字符时在光标上方弹出文件检索浮层；
  - 联动后端 `/api/native/workspaces/:handle/files:search`（带 150ms 防抖与模糊匹配）；
  - 支持键盘 `↑` / `↓` 选择、`Enter` / `Tab` 插入、`Esc` 取消；
  - 插入后渲染为不可分割的原子提及 Token（如 `[@src/main.ts]`），并在提交时附加语义路径。
- **70vh 沉浸式展开模式与按键仲裁**：
  - 当输入内容超过单行高度时，右上角浮现展开按钮，点击后平滑展开为占据视口 `70vh` 高度的沉浸编辑面板；
  - **按键仲裁状态机（彻底消除 Steer / Follow-up 歧义与死锁）**：
    1. **空闲态 (Idle)**：
       - *常规高度*：`Enter` 提交 Prompt，`Shift + Enter` 换行；
       - *70vh 展开*：`Enter` 换行，`Cmd/Ctrl + Enter` 提交 Prompt。
    2. **运行态 (Running)**：
       - *常规高度*：`Enter` 触发 **Steer（插队，当前工具闭环后注入）**；`Cmd/Ctrl + Enter` 触发 **Follow-up（排队，本轮全部结算后执行）**；
       - *70vh 展开*：底部显示明确的 **Delivery Mode 切换器（`[Steer | Follow-up]`）**；`Enter` 保持大文本换行，`Cmd/Ctrl + Enter` **严格按选中的 Delivery Mode 投递**。
- **Shell 风格输入历史穿透 (↑/↓)**：
  - 按 Session / Workspace 隔离记录已发送的 Prompt 历史（上限 50 条，`localStorage` 持久化）；
  - 光标在首行且按 `ArrowUp` 调出上一条历史并暂存草稿；按 `ArrowDown` 恢复草稿；
  - **Session Rekey 兼容**：新会话从 `pending handle` 迁移到落盘后的 `canonical realpath handle` 时，自动迁移历史记录索引。
- **只读 QueueDock 状态指示坞**：
  - 严格遵循 Pi RPC `queue_update` 单向流事实，不虚构前端重排功能；
  - 胶囊展示当前排队的 Steering 引导指令与 Follow-up 任务数量及文本摘要。
- **图片与多模态**：支持纯图片发送；发图前在客户端完成解码、分辨率限制与压缩，并在当前 Session 呈现安全缩略图与删除入口。

---

## 5. 模型、Thinking 档位与上下文度量

- **Host 快照权威**：模型列表与思考力档位来自当前 Session 的 Host Snapshot；运行中切换明确提示“将在下一次请求生效”，当前 Turn 保持启动时配置。
- **细粒度思考力分段控制器 (SegmentedControl)**：
  - 根据 Pi RPC `get_available_thinking_levels` 返回的档位自适应渲染：
    - 不支持思考力：完全隐藏或置灰；
    - 布尔开关型：`[Off | On]`；
    - 多档 Effort 型：`[Off | Low | Medium | High | Max]`。
- **上下文用量环 (ContextMeter)**：
  - 具备三态表现：Active 请求且等待统计 = Loading 呼吸；有统计值 = 百分比与 Token 数（`tabular-nums`）；空闲为 null = Unavailable 状态。不使用永恒 Spinner，不渲染伪 0%。
- **统一模型 Popover**：模型与 Thinking 等级共享同一面板，切换模型时自动重置为其默认 Thinking 档位。

---

## 6. Slash 命令系统

- **菜单与交互**：键入 `/` 锚定 Composer 弹出菜单（最大高度 320px），按 extension / prompt / skill 分组；支持 `↑`/`↓` 循环、`Tab`/`Enter`/点击选中为不可编辑的 Command Tag，第二次 `Enter` 才提交；`Space` 为正常参数输入。
- **Skill Envelope 保护**：Pi 在底层将 Skill 展开为携带本机路径的 `<skill>` envelope；前端 Live 流、快照、Conversation Tree 与侧边栏摘要必须统一折叠回 `/skill:name` Tag + 用户参数，绝不泄露 Skill 内部实现或绝对路径。

---

## 7. Conversation 主表面与内容流编排

### 7.1 模型与消息渲染
- **数据结构**：产品模型严格遵循 `ProductTurn → AssistantStep → ContentBlock`。
- **气泡布局**：Assistant 正文无气泡，直接依托近白画布排版（行高 26px）；User 消息采用右对齐淡蓝气泡（最大宽 525px）。
- **乐观更新回填与 ContentShape 对齐**：本地发送即刻渲染 `optimistic: true` 气泡；当权威 `message_start` 到达时，基于 `contentShape`（文本特征 + 附件数）与 FIFO 队列匹配替换，消除消息重复与跳闪。

### 7.2 思维链 (Thinking) 2 段式平滑折叠
- **Stage 1 (流式生成中)**：
  - 展示 5 行高度的滚动视窗，新文本追加时自动平滑置底（`scrollTop = scrollHeight`）；
  - 伴随 2.6s 优雅脉冲呼吸指示（`.thinking-sweep`），表明深度思考中。
- **Stage 2 (结算完成 Settled)**：
  - 流式结束后，通过 CSS Grid 动画（`grid-template-rows: 0fr 1fr`）平滑折叠为**末段结论摘要 (Teaser)**，仅呈现最终结论段落。
- **原位展开主交互**：
  - 点击 Thinking 卡片主体执行**原位内联平滑展开/折叠**，不弹出侧边栏，保障主阅读流居中；
  - 卡片右上角提供微型 `<ExternalLink>` 图标，按需在 DetailsPanel 的 Inspector 中全屏审阅。

### 7.3 三级工具调用架构 (ToolGroup)
- **流式运行期守卫（防假死盲区）**：
  - 工具执行期间，进行中的工具行**必须保持展开**，带有旋转指示器与实时参数摘要；绝不在流式期间折叠为静态汇总。
- **Step 结算期聚合 (ToolGroup)**：
  - 当前 Step 结算后，若包含连续 $>2$ 个非交互式工具调用，自动聚合为单行折叠汇总：  
    `⚡ 13 tool calls · read_file × 8, grep × 4, bash × 1 · 3.4s [✓ Done]`
- **Stacked 紧凑堆叠布局**：
  - 展开 ToolGroup 后，子条目以 Stacked 紧凑堆叠形态呈现，共享 1px 细分割线（首项 `rounded-t-md`，中间项 `rounded-none`，末项 `rounded-b-md`）；
  - 文件修改工具（`edit_file`/`write_file`）自动展示行数变更徽标（如 `+15 -2`）。
- **Tier 3 决策卡片**：
  - Extension UI 审批、输入、选择等高注意力交互保留独立卡片权重。
- **悬挂工具状态收敛 (`interrupted`)**：
  - 历史会话加载或未完成 Turn 结算时，因 Crash、断网或 Abort 未收到结果的工具调用统一收敛为 `interrupted` 状态（弱化灰色标志），消除永久 Loading Spinner。

### 7.4 行级代码 Diff 块 (`DiffBlock`)
- 在 Markdown 解析中专门拦截 ````diff` 代码块与文件编辑输出：
  - 行级解析 `+`（新增）、`-`（删除）、`@@`（Hunk 锚点）；
  - 双栏等宽 Gutter 行号渲染（原行号 / 新行号对齐）与 `+/-` 标志列；
  - 新增行 `bg-success-soft/30 text-success`，删除行 `bg-danger-soft/30 text-danger`；
  - 提供 **Clean Copy** 按钮：自动剥离行首 `+`/`-` 符号，一键复制纯净代码。

### 7.5 渐进式流式 Markdown 与 32KB/64KB 熔断降级
- 流式生成期间渐进渲染标题、粗斜体、列表与代码块外框，消除从纯文本到富文本的跳闪；
- 当代码块超过 32KB 字符（`MAX_SYNTAX_HIGHLIGHT_CHARACTERS`）或 64KB UTF-8 字节时，自动降级为轻量原生 `<pre><code>` 文本容器，确保长代码不阻塞渲染主线程。

---

## 8. 滚动感知与对话大纲轨 (Conversation TOC)

- **滚动跟随与回到底部**：距底部 24px 内视为 Pinned，新内容自动跟随；用户上翻立即解除，新 Delta 不抢夺视口；脱离底部时展示 40px“回到最新”悬浮按钮。
- **对话微缩大纲轨 (Conversation TOC)**：
  - 主阅读列右侧悬浮纵向微缩刻度轨，每轮 User Turn 对应一个小刻度线；
  - 鼠标悬浮或聚焦时向左平滑展开 220px 气泡卡片，展示提问摘要；
  - 基于 `IntersectionObserver` 监听当前视口中央的 Turn 并高亮对应刻度；
  - **防碰撞与遮挡保护**：当视口右侧余量 $<240\text{px}$ 或正文存在超宽表格/代码块横向撑开时，TOC 自动隐藏（`visibility: hidden`），严禁遮挡正文。

---

## 9. Extension UI 与人机协作体验

- **阻塞式交互浮动坞 (ChatDock)**：
  - Agent 触发 Extension UI 阻塞交互时，居中 Modal 提供右上角“**最小化**”操作；
  - 最小化后全屏遮罩解除，卡片收缩为 Composer 上方的**浮动胶囊（ChatDock）**；
  - 用户可自由滚动查阅历史代码与上下文，并在 ChatDock 上直接点击“允许/拒绝”或“最大化”恢复 Modal；
  - 保持底层 WebSocket 响应通道与超时 Deadline 不变。
- **结构化单选与问答卡片 (QuestionCard)**：
  - 严格遵循 Pi Extension UI 的 `{ value: string }` / `{ confirmed: boolean }` 响应规范；
  - 支持键盘 `1~9` 数字键直选、推荐项（Recommended）默认高亮以及 Write-in 自定义文本输入。
- **状态与挂件**：`setStatus` 聚合在 Composer 附近，`setWidget` 放置在明确的 Before/After 区，`setTitle` 同步更新 Tab Title，`notify` 只 Toast 一次。

---

## 10. DetailsPanel、分支与删除

- **三合一专注抽屉**：右侧 DetailsPanel 默认关闭，按需切换 `inspector`（工具调用参数、标准输出、行级 Diff）、`tree`（会话血缘树与 Fork 操作）、`debug`（原始 WebSocket 事件流）。
- **会话删除事务**：Session DELETE 仅在当前 Tab 拥有 Controller Lease、Generation 精确时可用，确认文案明确说明移动到 Recoverable Trash，失败时返回具体 409 冲突原因。

---

## 11. 响应式与可访问性契约

- **桌面端 (≥1024px)**：280px Sidebar、Center 阅读轴居中、按需 DetailsPanel。
- **移动端 (<768px)**：
  - 48px `MobileTopBar` 整合工作区名称与核心状态；
  - `MobileSwitcherSheet` 底部触控抽屉管理会话与工作区；
  - 保证所有触控热区 $\ge 40\text{px}$；
  - 基于 `window.visualViewport` 动态计算 `--app-height` 与 `--app-top`，消除软键盘遮挡。
- **可访问性与键盘导航**：全局 `focus-visible` 光环，`<Kbd>` 按键提示，Tab 顺序与视觉一致，Escape 关闭顶层浮层，`prefers-reduced-motion` 关闭呼吸灯与位移。

---

## 12. 有意延后 (Deferred Intentionally)

以下特性在当前阶段保持有意延后：
- **显式强制 Controller Takeover**：需要单独的跨连接 Fencing 与运行中语义设计，不作为普通按钮提供。
- **跨会话全局全文检索与 Trajectory 树**：需要独立的持久化倒排索引与后台索引引擎。
- **Recoverable Trash 的可视化还原/清空 UI**：当前只承诺安全移动到本地垃圾桶并保证文件不被损毁。
- **Turn 虚拟化与定制 Markdown 解析引擎**：需待生产环境 Benchmark 出现实际 DOM 瓶颈时再引入，不提前增加复杂度。

*(注：`@file` 工作区文件提及、Extension UI ChatDock 浮动坞、Conversation TOC 大纲轨及移动端 Bottom Sheet 触控抽屉已正式纳入当前规范体系，不再列入延后清单。)*
