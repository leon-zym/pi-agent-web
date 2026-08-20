# UI/UX — Session 工作台交互契约

视觉 token 与组件配方见 [DESIGN.md](../DESIGN.md)；本文件规定用户可观察的行为。页面的
selected Session 只是显示指针，不能被误写成 Gateway 或 Pi 的唯一“当前会话”。

## 1. Workspace 与 Session 导航

- Workspace 来源于 Pi history 的 Header `cwd`，也可以由用户 pin 一个本地目录以便创建首个
  Session。添加操作使用 Gateway 所在系统的原生目录选择器，不要求用户手输绝对路径。
- 移除 Workspace 只移除展示/发现偏好，不删除 native history。项目级自定义 `sessionDir` 可能因此
  暂时不再出现在目录中；重新添加同一 Workspace 路径会恢复发现，确认文案必须说明这一点。
- Session row 的运行状态独立于选中状态。A 正在生成时切到 B，A 继续运行，Sidebar 持续更新 A；
  再切回 A 立即显示已有投影，不发送 Pi `switch_session`。
- 启动时只根据 Web 的 `lastOpenedAt` 选择默认 Workspace（Pi 本身没有 last-Workspace 设置），并进入
  一个新的空 Session；不得自动打开历史列表第一项。展开/收起 Workspace 只加载或隐藏其目录，不能
  改变当前 Workspace、Session、订阅或 lease；显式的 Open/New/Session row 才改变当前视图。
- 新建且尚无对话的 Session 只存在于当前 Header/Composer 表面，不进入 Sidebar row，也不计入
  Workspace 的历史数量。Pi 写入包含对话的 JSONL 后由强制 Catalog refresh 一次性发布 row、首条
  消息标题与当前状态，不能先闪现 `Empty session` 占位 row；untouched transient 被 abandon 后始终
  不留目录项。
- 同一 Workspace 和不同 Workspace 的多个 Session 都可同时工作。页面不宣传“无限并发”；容量
  不足时显示具体 runtime 错误，而不是静默终止已有运行。
- 空 Session、unavailable Workspace、crashed/dormant runtime 使用不同状态，不用一个灰点概括。

## 2. Session 选择与后台生命周期

选择 Session 时按顺序：恢复该 Session 的可见 store → subscribe channel → 在 baseline 完成后尝试
claim。离开 Session 时：

- 新建与尚无 projection 的历史 Session 先显示现代化 skeleton；只有 authoritative 空 snapshot 才能
  显示 first-turn empty state。新建请求开始时旧对话必须立即退出可见树，迟到的 create response
  不得把用户从后来选择的 Session 抢回；
- running、waiting_ui、starting 或仍有活动投影的 Session 保持订阅，后台继续摄取；
- settled、可重建且无待处理 UI 的 Session 可以 release/unsubscribe 以限制浏览器内存；
- 离开一个仍未落盘、idle、无草稿/Command Tag/附件及附件处理、queue、对话或 Extension UI 的
  Session 时，使用 exact generation + fencing token 请求 transient abandon。Gateway 只停止并忘记
  runtime，绝不删除文件；若并发落盘或收到 mutation 就 fail closed。失去 controller 的孤儿由有界
  TTL reaper 收敛；
- crash 必须先把正在运行的投影结算为可见错误，再决定是否释放；
- draft、附件、模型、命令目录、usage、Extension UI 与 submit state 按 handle 保存，异步 completion
  只能更新发起它的 Session。

Rekey（new/fork/clone）是显式身份事件。Child 继承应有的 Pi history，但父 Session 仍可独立打开；
后续 child 消息不得回流父投影，父 pending command 也不得被批量迁移。

## 3. Controller 与 observer

每个 Session 有独立 controller lease。一条 tab 可以控制多个 Session，不同 tab 可以各控一个
Session；同一 Session 的第二个 tab 是 observer。

- Observer 可以浏览历史、运行状态、事件、tool output 与待处理 Extension UI，但 composer 和所有
  mutation 控件 visibly read-only。
- 文案必须说“另一个标签页正在控制此 Session”，不能说 Workspace，也不能暗示工作已停止。
- Controller 关闭、release 或 disconnect 后，observer 重新选择该 Session（或重连）取得新 baseline，
  再按保留的 controller intent claim；当前不依赖跨连接的隐式 lease 广播。
- 当前不提供强制 takeover：直接抢占会让旧 token、运行中 prompt 与对话框产生歧义。未来实现必须
  有独立设计与 fencing 测试，不能藏在普通按钮后。

## 4. Composer 与投递

Composer visual seat 固定在 Center 底部，同一 DOM 可以延续焦点，但数据按 Session 隔离。

- idle：Enter 提交 prompt；Shift+Enter 换行。
- running：Enter = **插队**（steer，本轮工具闭环后注入）；Cmd/Ctrl+Enter = **排队**
  （follow_up，本轮完全结算后执行）。当前模式与提交后 badge 必须准确。
- image-only 合法；text 与 image 都为空时 Send disabled。图片在发出前 decode、限制像素、压缩，并在
  当前 Session 显示 thumbnail 与删除入口。
- 切换 Session 前捕获 handle；上传、resize、submit、response、error、清空 draft 都回写该 handle，
  不能污染新选 Session。
- 375px 下 Send/stop 固定可见，所有 control bounding box 位于 viewport；次要 label 优先缩略/隐藏。
- observer、无 Session、无模型、unavailable Workspace 分别给出就地原因，不能只 disable 而不解释。

## 5. 模型、thinking 与上下文

- 模型和 thinking level 来自该 Session 的 Host snapshot；不把另一个 Session 或旧 response 当真相。
- 运行中切换明确标注“用于下一次请求”；当前 Turn 保持启动时配置。
- thinking level 使用 `get_available_thinking_levels`，不硬编码模型能力。无可用模型时显示
  “No models / Configure model”，禁用无意义的 effort 选择。
- Context usage 有三态：active request 且等待统计 = loading；有值 = percent/tokens；空闲仍为 null =
  unavailable。使用无按钮 press 效果的环形 meter；Unknown 不使用永久 spinner，也不渲染伪 0%。
- 模型与 thinking 页面共享同一个 popover：列表的 Back header 固定在滚动 viewport 外；成功选择后
  回到根页而不关闭 popover，便于连续调整模型与 thinking level。
- Session metadata 的 `agent_settled`、`session_info_changed` 与 directory event 使用 forced refresh，
  标题和 message count 不允许滞后一整个对话。

## 6. Slash commands

- 菜单锚定 Composer 上方，最大高度 320px，按 extension / prompt / skill 分组，显示时去掉 `skill:`。
- ArrowUp/ArrowDown 循环；Escape 关闭；Tab/Enter 或 click 选择当前高亮项并保留焦点；Space
  是普通参数输入，不触发执行。
- 选中的命令显示为不可编辑的原子 Tag，正文输入只保存参数；Backspace（空正文）或 Tag 的关闭按钮
  一次移除完整命令。提交边界再序列化为 `/<command> <arguments>`。
- 只有第一个非空白 Token 的 `/` 会打开菜单，避免把正文中间的 `/name` 重排到消息开头。模糊
  搜索只生成候选；未知 `/name` 不得作为普通 prompt 静默发送。命令刷新、Token、草稿和异步
  提交清理都按 Session 隔离，rekey 时迁移到 canonical handle。
- Pi 会在发送前把 Skill 展开为含完整正文和本机 location 的 `<skill>` envelope；live、snapshot、
  Conversation tree 与 native directory summary 都必须折叠回 `/skill:name` Tag + 用户参数，不能把
  Skill 正文或绝对路径显示/复制到消息、Header、Sidebar 或搜索摘要。
- Extension `select` 是独立 blocking dialog：键盘选项、confirm/cancel 与 authoritative close 都按
  Session/generation 处理，不与 Slash suggestion highlight 共用状态。

## 7. Conversation 投影

### Turn / step / block

产品模型保持 `ProductTurn → AssistantStep → ContentBlock`。Pi 的真实序列可能是
`agent_start → turn_start → user message_start → assistant message_start`：首个 user message 不能仅因
step 已存在就被标成 steer，`turn_start` 也不能留下永远 Working 的空 step。

Assistant prose 无气泡，User 是右对齐 bubble。Thinking、tool call、tool result、retry/compaction 是
独立语义节点，不拼回 Markdown。Tool result 以 `message_start(role=toolResult)` 为显示权威；
`turn_end.toolResults` 只结算，避免双份输出。

### Thinking 与 tool

- Thinking 折叠态显示最新非空行或 settled 首行摘要；只展开当前行，不展开 siblings。
- Tool 行显示 preparing/running/done/error/skipped。参数和 bounded preview 可内联；完整输出进入
  Inspector。所有 ANSI/control chars 在显示前清理。
- Bash 展开体分开显示完整 Command 与 Output；settled result 优先于旧 partial snapshot。结构化工具
  参数、Inspector 参数、runtime 与展开的 Event payload 使用安全的 JSON/Bash token highlighting；
  streaming 中尚不完整的 JSON 才回退 raw text。
- Edit/diff 使用结构化 `details.diff` 时渲染 hunk/add/delete；没有 diff 时才回退通用摘要。
- stopReason length/error/aborted 保留 partial，并分别显示截断、失败、已停止；零 delta message 合法。

### Markdown 与性能

- 流式 delta 只在相同 Session/generation/message/contentIndex/type 下合并；结构、错误、settled、
  rekey、dialog close 立即 flush。
- 可见 tab 用 rAF 发布，hidden tab 用有界 timer，保证后台 Session 不因 rAF suspension 永久积压。
- 多 Session 同一周期公平推进；缓冲有 item/byte/reducer-run 上限，overflow 进入显式 rebuild/resync。
- 历史 Turn/Step/Message 使用稳定引用与 memo；tool result 按 id 索引，不在每个 block 重扫数组。
- 流式期间允许尾部简化，但 settled Markdown 必须恢复 GFM/code 语义。Renderer 或 virtualization 只有在
  profile 证明必要并有 DOM/scroll regression 后才能引入。

## 8. 滚动与长对话

- 距底部 24px 内视为 pinned；新内容自动跟随。用户上翻立即解除，新 delta 不抢视口。
- 脱离底部显示可键盘访问的 40px“回到最新”按钮。用户提交当前 Session 时强制回到底部。
- Session 切换恢复该 Session 的合理阅读位置；snapshot prepend 要用 semantic anchor，而不是 raw
  `scrollTop` 猜测。
- 大输出默认折叠；Details 承担完整 tool/diff，避免一个展开项撑爆整个 conversation。

## 9. Extension UI

- blocking dialog 每个 Session 依序显示；按钮在 response pending 时 disabled，直到 Host 的
  `extension_ui_closed`，防止重复点击与 observer 残留。
- cancel/关闭回发 `{cancelled:true}`。timeout、process lost、replacement 与另一个 controller 作答
  都会广播 close reason，所有 tab 同步清理。
- `setStatus` 聚合在 Composer 附近；`setWidget` 放在明确的 before/after 区；`setTitle` 更新当前
  document title；`set_editor_text` 写入指定 Session draft；`notify` 只 Toast 一次，不从 snapshot 重播。
- Subscription baseline 在 consumer resync 前原子应用 Extension snapshot，避免 Pi 永久卡 waiting_ui。

## 10. Details、branch 与删除

- Details 默认关闭，无 selected tool/tree/debug 内容时不占桌面宽度。关闭后有固定 reopen rail；
  tool、diff、branch action 会上下文打开正确 mode。
- Branch tree 以 `get_tree` 显示 leaf 和 user-message fork action。Fork 成功后进入 child channel，父
  Session 仍可在 Sidebar 打开。这个表面命名为 Conversation tree：它只描述当前 JSONL 内的 entry
  parent/leaf 路径，并不是所有 forked Session 的全局列表；Current 标记 Pi 的 active leaf。
- Export HTML 成功后 Gateway 返回已验证 regular file 的 canonical `file:` URL；UI 立即复制 URL，
  让用户可直接粘贴到浏览器。它不把模型生成的 HTML 作为同源 HTTP 页面提供。
- 当前 Pi RPC 没有 archive Session 或 archive Workspace 命令，因此 UI 不伪造“归档”入口；删除仍
  只走上面的 recoverable trash 契约。
- Session DELETE 只在当前 tab 控制该 Session、generation 精确、runtime 可删除时启用；确认文案
  说明它会移动到 recoverable trash。active、unpersisted、有 child、身份冲突或文件系统不支持时
  显示具体 409 原因。
- Workspace remove 与 Session delete 是两种操作，绝不共用含糊的 “Delete workspace data” 文案。

## 11. Responsive 与可访问性

- Desktop：280px Sidebar、Center、按需 Details。Tablet：56px rail + overlay details。Phone：两行
  Session header，低频 action 进入 overflow，conversation/composer 全宽。
- 每个 icon button 有 aria-label 与 Tooltip；状态使用文案/sr text，不只颜色。
- focus-visible 明确；菜单上下键、Home/End/Enter/Escape 与 pointer 行为一致；dialog 关闭恢复焦点。
- touch hit target ≥40px，关键信息不只在 hover。`prefers-reduced-motion` 禁止非必要 sweep/pulse。
- 任何 shell/composer 改动都要在 375×812 实测 horizontal overflow 与 control bounding box；同时
  检查 200% zoom、键盘-only、light/dark、console/page error。

## 12. 有意延后

- 显式强制 controller takeover：需要单独 fencing/运行中语义。
- 全文 Session 搜索、Trajectory、`@file` / `fs/browse`：需要独立数据、权限与性能设计。
- recoverable trash 的 list/restore/purge UI：当前只承诺安全保留文件。
- Turn virtualization 或完整 Markdown renderer 替换：由正式 benchmark/profile 触发，不因库流行而引入。
