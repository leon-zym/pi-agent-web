# UI/UX — 交互设计与规则

> 视觉 token 与组件配方见 [DESIGN.md](../DESIGN.md)；本文档记录交互语义与可挑剔性标准。

## 核心交互

### 三栏让步策略
- 默认：Sidebar 280px（264–420 可拖拽）| Center ≥ 640px | Details 360px（300–520 可拖拽）。
- 空间不足时：先压 Details 至 300px → 再关闭 Details（子树保持挂载）→ 最后才允许 Center 低于 640px。Sidebar 不让步，<1024px 进入 56px 图标 Rail。
- 拖拽把手同时支持键盘（方向键 ±16px）。

### Sticky Composer 常驻
- 同一 DOM 实例跨工作区/会话切换存续，draft 与焦点不丢失。
- 运行中 Enter = **插队**（steer，本轮工具闭环后注入，不打断生成 token）；Cmd/Ctrl+Enter = **排队**（follow_up，本轮完全结束后执行）。UI 必须明确标注当前消息的注入模式。
- 运行中提交裸 prompt 被前端阻止（服务端也会 success:false）。
- 空会话 / 未选工作区 / 无模型的 Hero 都复用同一输入底座。

### 滚动跟随（Pinned Follow）
- 距底部 24px 内视为 pinned，自动跟随；用户上翻立即暂停，新内容不抢视口。
- 脱离底部浮现 34px 圆形「回到最新消息」按钮。
- 用户提交或 pending steering 出现时强制回底部。

### Thinking 折叠行
- 24px 紧凑行：折叠态显示最新非空行（流式，扫光 2.6s 感知推进）/ 首行摘要（结算后）。
- 展开进入普通阅读流，不内滚，不与页面抢滚动。
- prefers-reduced-motion 禁用扫光。

### Tool Call 行
- 独立一等节点，永不混入 Markdown；[状态图标] 名称 · 摘要 折叠行。
- 两阶段状态：preparing（参数流式生成）→ running（执行，增量输出覆写）→ done/error；skipped 单独样式（无执行动画）。
- 行内展开钳高（终端 224px / 代码 260px）；完整日志进右侧 Inspector。

### Slash 命令菜单
- 锚定 Composer 上方，max-height 320px；按 source 分组（扩展 / 提示词模板 / 技能，skill: 前缀去展示）。
- 模糊候选、精确执行：Space/Enter 只执行精确匹配的命令名；无法识别的 / 开头输入**不得**静默当普通 prompt 发送。
- 回车执行、点击插入（保留焦点与后续参数输入）。

### 模型与思考级别
- 两级菜单（根：模型 / 思考级别）；Effort 词表来自 get_available_thinking_levels 响应（非硬编码），不支持思考的模型不显示该行。
- 切换标记为「用于下一次请求」；运行中请求保持启动时快照。
- 失败 Toast 保留原选择；thinking_level_changed 回显实际（可能被钳制）值。

### Extension UI 拦截
- 对话框队列逐个渲染；关闭/取消一律回发 {cancelled:true}（Editor 无超时，完全依赖此保护）。
- setStatus 聚合为 Composer 上方单行状态条；setWidget 挂载于 Composer 上/下；notify → Toast；set_editor_text → 写入 draft。

### 分支树与时间旅行
- 右侧「分支」面板：get_tree 树形渲染，leaf 标「当前」；user 消息节点 hover 出 fork 入口。
- fork 后投影随 sessionId 变化重建，目录自动刷新并打开新会话。

## 状态优先级（会话行状态槽）

1. 运行中（当前会话 activeTurn 非空）→ primary 呼吸点
2. 失败（最近 Turn status=error）→ danger 点
3. 空闲 → 弱化点

空会话（无消息且未命名）不显示时间与操作，标题呈「空会话」。

## UX 规则清单

- 图标按钮必须有 aria-label + Tooltip；状态不能只靠颜色（状态槽 + sr-only 文案）。
- 触摸设备关键信息不进 Tooltip；hover 态包 @media (hover:hover)。
- 空态不营销：一句方向 + 一行操作提示。
- 运行状态文案泛化（「正在处理…」），不绑定具体模型行为。
- 工具结果渲染以 message_start(toolResult) 为准，turn_end.toolResults 仅结算，绝不双份渲染。
- 快照不覆盖运行中投影（旧数据不回写新状态）。
- 删除会话双防护：运行中 409、子会话引用 409（血缘）。
- 上下文计量 null 感知：null 显示「计算中…」，绝不渲染 0%。
- 所有数字（计时/Token/费用/百分比）tabular-nums。
- 中文 UI 文案经 i18n 字典；英文注释；无惊叹号成功文案；错误文案不用「Oops」句式。

## 已知简化（有意为之）

- 第一版不做 Trajectory 独立视图（原始事件台账已提供，字段留存：turn/step/usage/timing）。
- 不做消息内 @file 引用装饰层（普通 textarea + Slash 菜单已覆盖 P0）。
- 不复制 DSH 的 Subagent/Goal/审批能力；Queue Dock 与扩展位已预留。
