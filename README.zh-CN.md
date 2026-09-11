# Pi Agent Web

[English](README.md) | 简体中文

[Pi Coding Agent](https://github.com/earendil-works/pi) RPC 模式的本地 Web 工作台。它在浏览器中打开
Pi 原生 JSONL 会话，让各活跃会话独立运行。切换对话时，后台任务继续执行。

Pi JSONL 始终是持久化数据的唯一事实来源。Pi Agent Web 不会把工作区或会话历史复制到另一个数据库。

> Pi Agent Web 目前处于开发预览阶段。接口可能变化，缺陷可能中断工作。请把重要工作纳入版本控制，
> 并按日常方式保留备份。

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

## 功能

- 发现 Pi 原生会话和工作区，不建立第二套历史存储。
- 每个活跃会话由一个受监督的 Pi 进程负责，切换视图不会停止后台任务。
- 流式输出回复、思考、工具活动、Markdown、图片、斜杠命令和扩展界面。
- 草稿、附件、控制权、模型选择和恢复流程按会话隔离。
- 会话删除进入可恢复回收站，需通过身份与控制权校验。
- 附加工作区文件前预览大小、类型和风险，确认后再纳入提示词。
- 支持浅色与深色主题、键盘操作、`zh-CN` 与 `en` 文案以及响应式布局。

## 产品边界

网关是单用户、同源的控制界面，只监听回环地址。请在本机运行，勿通过公共反向代理暴露
`pi-web`。[SECURITY.md](SECURITY.md#security-boundary) 是威胁边界与报告流程的归属文档。

提供商凭据、扩展、设置和会话历史保存在你的 Pi 安装中。开发环境和 CI 使用不含凭据的确定性测试
夹具。

## 快速开始

环境要求：Node.js 22 或更高版本、pnpm 11.21.0，以及兼容的 Pi Coding Agent 运行时。

### 运行发行版

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

### 从源码开发

```bash
pnpm install --frozen-lockfile
pnpm dev
```

开发模式在 3000 端口启动网关，在 5173 端口启动 Vite。请打开 Vite 输出的回环地址。执行
`pnpm build` 后再运行 `pnpm start`，可启动构建后的单端口工作台；`pnpm start -- --pi-path
/path/to/rpc-entry.js --port 3100 --no-open` 可传递命令行参数。

两个名称作用不同：`pi-agent-web` 是仓库和包的命名空间，`pi-web` 是面向用户的命令。

## 参与贡献

欢迎提交 Issue 和 Pull Request。修改代码或文档前，请先阅读 [AGENTS.md](AGENTS.md)；工具链、验证
层次和发布闸门见 [docs/development.md](docs/development.md)。

```bash
pnpm verify        # 代码检查、类型检查、确定性测试和生产构建
pnpm test:smoke    # 经过认证的 REST 和 WebSocket 冒烟测试
pnpm test:browser  # 基于打包产物的确定性浏览器测试
```

保持改动聚焦，在确有失败风险处补充回归测试，并更新对应事实的归属文档。

## 文档

[docs/README.md](docs/README.md) 汇总了当前契约、架构决策和归档证据的归属。
[GitHub Issues](https://github.com/leon-zym/pi-agent-web/issues) 跟踪待办事项和交付状态。

## 许可

[MIT](LICENSE)
