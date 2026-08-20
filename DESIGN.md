# DESIGN.md — Pi Agent Web 视觉契约

本文件是所有界面的视觉事实源。偏离 token、布局或状态语言时，PR 必须说明用户问题与验证证据。

## 视觉主张

Pi Agent Web 是安静、精确的本地 Agent 工作台：近白编辑阅读面、浅灰导航、低 chrome、强排版
层级。界面应该更接近 Linear / ShadCN 的克制系统，而不是仪表盘、营销页或传统 IDE 面板墙。

蓝色只表示主要操作、运行、链接与当前选中；中性色承担结构。终端气质来自单宽的工具摘要、
时间与 Token，不来自黑底、霓虹或装饰性代码雨。

## 信息架构

- Sidebar 负责 Workspace 与 Session 导航、创建和搜索入口。
- Center 是唯一默认主表面：Session identity、conversation、sticky composer。
- Details 是上下文面板，只在检查 tool/diff/tree/events 或用户明确打开时出现；空页面默认关闭。
- 当前选中 Session 只是视图；Sidebar 的后台状态必须让 running/waiting/crashed Session 可见。
- 长对话的默认扫描单位是「用户请求 → 折叠过程摘要 → 答案 → 紧凑指标」。完整工具输出进入
  Details，不能把巨量 stdout 当作主要阅读内容。

## CSS 与 token

Tailwind CSS v4；语义 token 定义于 `packages/ui/src/styles/index.css`。只使用静态 class，不动态
拼接 Tailwind class；同一 element 不混用 CSS Modules。禁止 `transition: all` 和 layout property
动画。

### 颜色

| Token role | Light | Dark |
|---|---:|---:|
| base | `#ffffff` | `#151517` |
| sidebar | `#f9fafb` | `#1b1b1c` |
| surface | `#ffffff` | `#2c2c2e` |
| primary | `#4176e6` | `#679efe` |
| ink | `#0f1115` | `#f9fafb` |
| success | `#16a34a` | `#4ade80` |
| warning | `#d97706` | `#fbbf24` |
| danger | `#dc2626` | `#ef4444` |

正文灰色不能直接放在彩色背景上。状态不能只靠颜色：同时使用文案、icon、形状或 sr-only 文本。

### 排版

- UI：`-apple-system, "SF Pro Text", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif`。
- Mono：`"SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace`。
- Assistant prose 15px / 26px 以上；UI ladder 12 / 13 / 14px；CJK 不使用负 tracking。
- 更新数字使用 `tabular-nums`。标题 sentence case；成功文案不用感叹号，错误不用 “Oops”。
- 正文最大宽度随屏幕响应，桌面阅读轴约 700–748px，Composer 可到约 780px；代码输出可在
  Details 中使用更宽空间，不能把主要对话固定成更窄专栏。

### 圆角与深度

`xs 6px` inline code，`sm 8px` row/input/button，`md 12px` menu/card，`lg 16px`，
`xl 22px` composer/user bubble，`full` send/stop circle。外层圆角 = 内层圆角 + padding。

层级优先靠 background step 与间距，不用层层 card border。阴影仅给浮层：composer、menu、dialog、
tooltip、toast；暗色 elevation 使用白色低透明 overlay 与边框。

## 布局

### Desktop ≥ 1024px

- Sidebar 默认 280px，可拖 264–420px，可收成 56px rail。
- Center 至少优先保留 640px，conversation/composer 同一中心线。
- Details 目标 360px，可拖 300–520px，**默认关闭**；打开时先压缩到 300px，再关闭，最后才压 Center。
- Details 关闭后留可键盘访问的固定 reopen rail；tool/diff/tree 入口可以上下文打开相应 tab。

### Tablet 768–1023px

- Sidebar 使用 56px rail；Session 选择通过可关闭 surface 展开。
- Details 不占永久列，以 overlay/sheet 或零宽 mounted surface 呈现；关闭入口始终可发现。
- Composer 与 Center 共宽，次要 label 缩略但不丢主操作。

### Phone < 768px

- 使用 52–56px navigation rail 或 sheet；Details 不成为并排第三栏。
- Header 两行：第一行 Workspace/Session identity，第二行 runtime/branch/active count；export/delete
  收进有 aria-label 的 overflow menu。
- Conversation 侧边 20–24px；composer 全宽。Send/stop 永远在 viewport 内，模型、effort、上下文与
  attachment 按优先级缩略为短 label/icon，不能把主按钮挤出去。
- 关键 hit target 最小 40px；hover 信息必须有触摸/键盘替代。

## 核心组件

### Conversation

- Assistant 无气泡；User 右对齐淡蓝气泡，最大约 525px，padding 10/16，radius 22px。
- 过程默认折叠为低高度摘要，展开一个过程不展开相邻过程。
- Thinking 使用紧凑 disclosure row；running 可有唯一的 2.6s light sweep，settled 显示首行摘要。
- Tool 是独立语义节点，不塞回 Markdown。折叠行显示状态、动词/工具名、目标与摘要；inline preview
  有高度上限，完整 raw output 进 Inspector。
- Edit/diff 显示文件、changed line count 与语义化 add/delete/hunk；不能只写 “edited file”。
- 流式 Markdown 可以降级尾部渲染，但 settled 最终 DOM 必须完整、可选择、可复制、语义正确。

### Composer

- 同一 visual seat 跨 Session 切换，但 draft、attachment、queue 与 submit 状态按 Session 隔离。
- 浮动 capsule，radius 22px，1px border + level-2 shadow；textarea 最多约 14 行。
- 运行中 Enter = steer，Cmd/Ctrl+Enter = follow-up；当前 delivery mode 可见。
- Observer 保持清晰的只读外观与 Session-scoped 原因；不提供会让旧 fencing token 复活的强制接管。
- 无模型显示 “No models / Configure model”，而不是看似有效的 “Select model · Off”。
- 图片先显示安全 thumbnail/移除入口；decode/resize/error 不阻断该 Session 的文本草稿。

### Session row 与 Header

状态词表：starting、running、waiting for input、queued、idle、crashed、dormant、observer、unread
background update。优先级为 waiting/crashed > running/queued > unread > idle/dormant。颜色之外必须有
tooltip/sr text；标题、状态、时间不可互相挤到不可辨认。

Header 的 delete/export 是低频操作；窄屏进入 overflow。Branch、runtime 与 Session identity 是高频
上下文。空 Session 不伪造时间或上下文 0%；null usage 要区分 active loading 与 unavailable。

### Menus、dialogs 与 Extension UI

- Row 32–40px，hover fill，无 card border；keyboard highlight 与 pointer hover 使用同一选中语言。
- Slash menu 锚定 composer，max-height 320px；source 分组；精确 commit，模糊候选不误执行。
- Extension dialog 按 Session/generation 排队；responding 时按钮显式 disabled，等待 authoritative close。
- Toast 只用于瞬时反馈；可恢复错误与 observer 原因留在发生位置。

## Motion 与反馈

- hover 不作为唯一反馈。Button/icon button 可用轻量 `scale(0.98)` press，100–160ms；tree/list row
  不强制缩放，以免文本抖动。
- 一般 transition 200ms `cubic-bezier(0.4, 0, 0.2, 1)`，只动画 transform/opacity/color。
- `prefers-reduced-motion` 关闭 sweep、pulse 与非必要位移；键盘触发不依赖 motion 说明状态。

## Accessibility

- 所有 icon button：aria-label + 500ms tooltip；menu/dialog 使用正确 role、name 与 focus return。
- `focus-visible` 明确，Tab 顺序与视觉顺序一致；Escape 关闭最上层 surface。
- 200% zoom、375px、键盘-only、touch、reduced motion 都是 release screenshot/interaction gate。
- 文本选择优先于 row click/drag；工具输出和 Markdown 可复制；ANSI/control chars 在展示前清理。

## 禁止项

- gradient text、glass cards、厚侧边强调、彩色装饰蓝、无意义 dashboard metric、永久空详情栏；
- 关键入口仅 hover 可见、移动端主按钮越界、用截断碎片作为唯一 Session identity；
- 在主要对话面直接展开无限 stdout、将 thinking/tool 拼成一段 Markdown、用 spinner 永久表示 unknown；
- 为“像 IDE”增加未定义价值的永久 tab、Trajectory 或多面板。

## 视觉验收矩阵

每次影响 shell/conversation/composer 的改动至少检查：

- light/dark；1440、1280、1024、768、375×812；200% zoom；reduced motion；
- empty、loading、no model、running、waiting_ui、observer、crashed、reconnect/resync、error；
- 长中英文标题、长路径、image-only、长 Markdown/code、50+ tools、background Session 更新；
- console/page errors、水平 overflow、所有主控件 bounding box、键盘 focus、ARIA name。

截图必须来自隔离 fixture，不含用户名、家目录、真实会话、credential、provider output 或 fencing token。
