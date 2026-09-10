# Pi Agent Web

[English](README.md) | 简体中文

Pi Agent Web 是 Pi Coding Agent RPC 模式的本地 Web 工作台。它直接打开 Pi 原生 JSONL 会话。
各活跃会话彼此独立运行，浏览器切换对话时后台任务继续执行。

Pi JSONL 是持久化数据的唯一事实来源。Pi Agent Web 不会把工作区或会话历史复制到另一个数据库。

> Pi Agent Web 目前处于开发预览阶段。接口可能变化，缺陷可能中断工作。请把重要工作纳入版本控制，
> 并按日常方式保留备份。

## 产品边界

网关是单用户、同源的控制界面，只监听回环地址。它不是托管服务、局域网服务器或多人协作系统。
请勿通过公共反向代理暴露 `pi-web`。[SECURITY.md](SECURITY.md#security-boundary) 是威胁边界与
报告流程的归属文档。

提供商凭据、扩展、设置和会话历史仍保存在用户的 Pi 安装中。开发环境和 CI 使用不含凭据的确定性
测试夹具。

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

截图使用确定性测试夹具，不包含提供商凭据、私有路径或用户会话历史。

## 快速开始

### 发行版安装

1. 从 [GitHub Releases](https://github.com/leon-zym/pi-agent-web/releases) 下载归档包及其校验和文件。
2. 解压归档包并进入目录：
   ```bash
   tar -xzf pi-agent-web-v*.tar.gz
   cd pi-agent-web-v*
   ```
3. 安装生产依赖：
   ```bash
   npm install --omit=dev --ignore-scripts
   ```
4. 启动工作台：
   ```bash
   npx pi-web
   ```

### 开发环境配置

环境要求：Node.js 22 或更高版本、pnpm 11.21.0，以及兼容的 Pi Coding Agent 运行时。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

开发模式默认在 3000 端口启动网关，在 5173 端口启动 Vite。请打开 Vite 输出的回环地址。

两个名称的作用不同：`pi-agent-web` 是仓库和包的命名空间，`pi-web` 是面向用户的命令。

## 分发状态

四个 `@pi-agent-web/*` 包尚未发布到 npm。请克隆仓库并使用上面的命令。`pnpm test:pack` 验证本地
包产物，不代表已完成公共注册表发布。

源代码采用 [MIT License](LICENSE) 许可。

## 仓库结构

```text
packages/protocol  浏览器安全的数据传输对象、守卫、策略和预算
packages/server    本地网关、原生发现和会话监督
packages/ui        React 工作台和按会话隔离的浏览器状态
packages/cli       pi-web 启动器和退出流程
docs/              当前契约、架构决策和归档证据
```

## 文档

[docs/README.md](docs/README.md) 汇总了当前契约、架构决策和归档证据的归属。
[GitHub Issues](https://github.com/leon-zym/pi-agent-web/issues) 跟踪待办事项和交付状态。
