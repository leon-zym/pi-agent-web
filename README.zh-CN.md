# Pi Agent Web

[English](README.md) | 简体中文

[Pi Coding Agent](https://github.com/earendil-works/pi) 的浏览器界面。

Pi Agent Web 运行在你自己的电脑上，用网页呈现 Pi 的对话。你可以同时进行多个对话：先启动一个耗时
任务，切到另一个对话，等回来时第一个仍在继续。

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

> Pi Agent Web 目前处于开发预览阶段。功能可能变化，缺陷可能中断工作。请把重要工作纳入版本控制，
> 并按日常方式保留备份。

## 能做什么

- **同时进行多个对话。** 每个对话有独立的 Pi 进程，来回切换不会中断后台正在进行的工作。
- **实时查看回复。** 回复、思考过程和工具调用都会流式显示在页面上。
- **阅读丰富内容。** 支持 Markdown、代码高亮、diff、表格和图片。
- **使用斜杠命令和技能。** 每个对话可单独选择模型和思考等级。
- **附加项目文件。** 发送前先看到文件的大小、类型和风险。
- **回答 Pi 的提问。** 问题、确认请求和编辑器显示在页面中，切换对话后依然可达。
- **长对话依然好用。** 历史记录随滚动分段加载，可用大纲快速跳转。
- **找回误删的对话。** 删除只是移入可从回收站恢复的位置，不会彻底清除。
- **适应你的习惯。** 浅色与深色主题、完整键盘操作、中英文界面，手机上也同样可用。

Pi Agent Web 直接使用你 Pi 安装中已有的对话和设置，不导入数据，也不在别处另存一份历史记录。

## 环境要求

- Node.js 22 或更高版本
- 一个模型提供商的 API Key

发行归档包会安装与之匹配的 Pi 版本，并在首次启动时提示你填入提供商密钥。如果你已经在使用
Pi Coding Agent，Pi Agent Web 会沿用你已有的对话、扩展和设置。

## 安装并启动

1. 从 [GitHub Releases](https://github.com/leon-zym/pi-agent-web/releases) 下载归档包及其校验和文件。
2. 解压：
   ```bash
   tar -xzf pi-agent-web-v*.tar.gz
   cd pi-agent-web-v*
   ```
3. 安装依赖：
   ```bash
   npm install --omit=dev --ignore-scripts
   ```
4. 启动：
   ```bash
   npx pi-web
   ```

Pi Agent Web 启动后监听 `http://127.0.0.1:3000`，并自动打开浏览器。需要调整时：

```bash
npx pi-web --port 3100     # 换一个端口
npx pi-web --no-open       # 不自动打开浏览器
npx pi-web --help          # 查看全部选项
```

## 请保持私有

Pi Agent Web 只监听本机，要求同源会话，并控制本机的 Pi 进程及其历史记录。请在本机运行，不要通过
公共反向代理或共享网络暴露它。它不是托管服务，也不是多用户系统，无法防御以你的用户身份运行的恶意
进程。报告问题请见 [SECURITY.md](SECURITY.md)。

## 参与贡献

欢迎在 [GitHub Issues](https://github.com/leon-zym/pi-agent-web/issues) 提交问题报告和 Pull Request。

从源码开始：

```bash
pnpm install --frozen-lockfile
pnpm dev        # 网关监听 3000 端口，Vite 监听 5173 端口
pnpm verify     # 代码检查、类型检查、测试和生产构建
```

工具链、测试层次和发布闸门见 [docs/development.md](docs/development.md)。若在本仓库使用编程智能体，
它需要的规则见 [AGENTS.md](AGENTS.md)。

## 文档

[docs/README.md](docs/README.md) 汇总了当前契约、架构决策和归档证据的归属。

## 许可

[MIT](LICENSE)
