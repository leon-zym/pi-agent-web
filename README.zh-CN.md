# Pi Agent Web

[English](README.md) | 简体中文

Pi Agent Web 是 Pi Coding Agent RPC 模式的本地 Web 工作台。它直接打开 Pi 原生 JSONL
会话，让各个活跃会话独立运行。即使浏览器切换到了其他对话，后台任务也能继续执行。

Pi JSONL 是持久化数据的唯一事实来源。Pi Agent Web 不会将工作区或会话历史复制到另一个数据库。

> Pi Agent Web 目前处于开发预览阶段。接口可能发生变化，缺陷也可能中断工作。请将重要工作纳入
> 版本控制，并按日常方式保留备份。

## 产品边界

网关是一个仅供单用户使用的同源本地控制界面，只监听回环地址。它不是托管服务、局域网服务器、
多人协作系统，也不能防御恶意本地用户。请勿通过公共反向代理暴露 `pi-web`。

提供商凭据、扩展、设置和会话历史仍由用户现有的 Pi 安装管理。开发环境和 CI 使用不含凭据的
确定性测试夹具。

## 主要能力

- 直接发现原生会话，不建立第二套历史存储。
- 每个活跃会话由独立的 Pi 进程负责，进程池有明确上限。
- 一个经过认证的 WebSocket 承载相互隔离的会话通道。
- 支持流式回复、思考过程、工具活动、Markdown、图片、斜杠命令和扩展界面。
- 草稿、控制权、投影状态、恢复流程和后台事件均按会话隔离。
- 对变更操作执行围栏校验，限制载荷规模，提供显式重同步和可恢复的会话删除。

选择会话只会改变浏览器当前显示的内容。它不会调用 Pi 的全局 `switch_session` 或
`new_session` 命令，也不会停止其他会话。

## 界面预览

<table>
<tr>
<td align="center"><img src="docs/assets/demo/overall.png" alt="Pi Agent Web 对话工作台" width="560" /><br /><sub>对话工作台</sub></td>
<td align="center"><img src="docs/assets/demo/tool-inspect.png" alt="Pi Agent Web 工具检查器" width="560" /><br /><sub>工具检查</sub></td>
</tr>
<tr>
<td align="center"><img src="docs/assets/demo/dark-mode.png" alt="Pi Agent Web 深色主题" width="560" /><br /><sub>深色主题</sub></td>
<td align="center"><img src="docs/assets/demo/mobile.png" alt="Pi Agent Web 窄视口界面" width="220" /><br /><sub>窄视口</sub></td>
</tr>
</table>

演示内容使用确定性测试夹具，不包含提供商凭据、私有路径或用户会话历史。

## 架构概览

```text
浏览器：当前视图和按会话隔离的状态存储
  -> 一个经过认证的 WebSocket，内部包含相互隔离的会话通道
     -> 网关：原生目录和有上限的活跃进程池
        -> 每个活跃会话对应一个 Pi RPC 进程
           -> Pi 原生 JSONL
```

持久化会话以 JSONL 文件的规范路径作为身份。文件头中的规范 `cwd` 标识工作区。休眠的历史会话
不占用进程，需要时才会启动。

变更操作需要匹配会话的准确代次和当前围栏令牌。只读观察者不需要控制租约。身份或顺序不明确时，
系统会拒绝操作并进入显式恢复流程，而不是静默修补游标。

## 快速开始

环境要求：Node.js 22 或更高版本、pnpm 11.21.0，以及兼容的 Pi Coding Agent 运行时。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

开发模式默认在 3000 端口启动网关，在 5173 端口启动 Vite。请打开 Vite 输出的回环地址。

使用单端口命令行程序之前，需要先构建单页应用：

```bash
pnpm build
pnpm start

# 通过根目录脚本传递命令行参数。
pnpm start -- --pi-path /path/to/rpc-entry.js --port 3100 --no-open
```

`pi-web` 只接受回环主机。它通常使用发行包中安装的准确 Pi 依赖。`--pi-path` 和 `PI_PATH`
是面向高级用户的覆盖选项，指定的运行时必须通过相同的限时版本与能力探测。

两个名称的作用不同：`pi-agent-web` 是仓库和包命名空间，`pi-web` 是面向用户的命令。

## 验证

```bash
pnpm verify                 # 代码检查、类型检查、确定性测试和生产构建
pnpm test:smoke             # 经过认证的 REST 和 WebSocket 冒烟测试
pnpm test:browser           # 基于打包产物的确定性浏览器测试
pnpm test:pack              # 本地包安装和命令行启动冒烟测试
pnpm test:compat            # 准确版本的 Pi 兼容性夹具
pnpm bench:representative   # 可复现的代表性性能矩阵
pnpm bench:stress           # 显式执行的长时间压力矩阵
PI_WEB_RUN_E2E=1 pnpm test:e2e:real  # 显式执行、会使用凭据的真实 Pi 验收
```

性能矩阵属于 Issue #28 第一阶段，目前尚未完成。结构正确性已有强制门禁；延迟、吞吐量、长任务和
堆内存等受宿主机影响的指标仍只作观察，需建立参考主机基线后才能成为发布门禁。测试边界参见
[开发文档](docs/development.md)。

## 分发状态

四个 `@pi-agent-web/*` 包尚未发布到 npm。请克隆仓库并使用上面的命令。本地
`pnpm test:pack` 会验证包产物，但不代表已经完成公共注册表发布。

源代码采用 [MIT License](LICENSE) 许可。

## 仓库结构

```text
packages/protocol  浏览器安全的数据传输对象、守卫、策略和预算
packages/server    本地网关、原生发现和会话监督
packages/ui        React 工作台和按会话隔离的浏览器状态
packages/cli       pi-web 启动器和有边界的退出流程
docs/              当前契约和架构决策
```

## 文档权威性

- [架构](docs/architecture.md)：身份、所有权、并发和恢复
- [协议](docs/protocol.md)：Pi RPC 事实和浏览器与网关之间的契约
- [UI 与 UX](docs/ui-ux.md)：用户可见行为和可访问性
- [视觉设计](docs/design.md)：视觉语言和验收标准
- [开发](docs/development.md)：测试层次、CI、打包和发布检查
- [架构决策](docs/decisions/README.md)：决策理由、替代关系和被否决的方案
- [GitHub Issues](https://github.com/leon-zym/pi-agent-web/issues)：待办事项和交付状态

当前契约只描述产品现状。历史决策过程保存在 ADR 中。`docs/notes/` 和 `tmp/` 下的文件是被忽略的
临时工作材料，不属于产品权威文档。
