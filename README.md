# Pi Agent Web

English | [Chinese](README.zh-CN.md)

A browser interface for [Pi Coding Agent](https://github.com/earendil-works/pi).

Pi Agent Web runs on your own computer and shows your Pi conversations in a web page. You can work in
several conversations at once: start a long task, switch to another one, and come back while the
first keeps running.

<table>
<tr>
<td align="center"><img src="docs/assets/demo/overall.png" alt="Pi Agent Web conversation workbench" width="560" /><br /><sub>Conversation workbench</sub></td>
<td align="center"><img src="docs/assets/demo/tool-inspect.png" alt="Pi Agent Web tool inspector" width="560" /><br /><sub>Tool inspection</sub></td>
</tr>
<tr>
<td align="center"><img src="docs/assets/demo/dark-mode.png" alt="Pi Agent Web dark theme" width="560" /><br /><sub>Dark theme</sub></td>
<td align="center"><img src="docs/assets/demo/mobile.png" alt="Pi Agent Web narrow viewport" width="220" /><br /><sub>Narrow viewport</sub></td>
</tr>
</table>

> Pi Agent Web is a development preview. Things can change, and bugs can interrupt your work. Keep
> important work under version control and keep your usual backups.

## What you can do

- **Run several conversations at once.** Each has its own Pi process, so switching between them
  never interrupts work happening in the background.
- **Watch replies arrive live.** Answers, reasoning, and tool activity stream into the page.
- **Read rich content.** Markdown, syntax-highlighted code, diffs, tables, and images.
- **Use slash commands and skills.** Pick the model and thinking level for each conversation.
- **Attach files from your project.** See each file's size, type, and risk before you send it.
- **Answer Pi when it asks.** Questions, approval prompts, and editors appear in the page and stay
  reachable if you navigate away.
- **Keep long conversations usable.** History loads as you scroll, with an outline to jump around.
- **Recover a conversation you deleted.** Deleting moves it to a trash you can restore from.
- **Use it your way.** Light and dark themes, full keyboard operation, English and Simplified
  Chinese, and a layout that works on a phone.

Pi Agent Web uses the conversations and settings that are already in your Pi installation. Nothing
is imported, and no copy of your history is kept elsewhere.

## Requirements

- Node.js 22 or later
- A model provider API key

The release archive installs its own matching Pi version and asks for a provider key the first time
you start it. If you already use Pi Coding Agent, Pi Agent Web picks up the conversations, extensions,
and settings you have.

## Install and run

1. Download the archive and its checksum from
   [GitHub Releases](https://github.com/leon-zym/pi-agent-web/releases).
2. Unpack it:
   ```bash
   tar -xzf pi-agent-web-v*.tar.gz
   cd pi-agent-web-v*
   ```
3. Install its dependencies:
   ```bash
   npm install --omit=dev --ignore-scripts
   ```
4. Start it:
   ```bash
   npx pi-web
   ```

Pi Agent Web starts on `http://127.0.0.1:3000` and opens your browser. To change that:

```bash
npx pi-web --port 3100     # use another port
npx pi-web --no-open       # do not open a browser
npx pi-web --help          # see every option
```

## Keep it private

Pi Agent Web listens only on your own computer, requires a same-origin session, and controls local Pi
processes and their history. Run it on your machine and keep it off public reverse proxies and shared
networks. It is not a hosted service or a multi-user system, and it does not defend against a hostile
process running as your user account. See [SECURITY.md](SECURITY.md) to report a problem.

## Contributing

Bug reports and pull requests are welcome in
[GitHub Issues](https://github.com/leon-zym/pi-agent-web/issues).

To work on the source:

```bash
pnpm install --frozen-lockfile
pnpm dev        # Gateway on port 3000, Vite on port 5173
pnpm verify     # lint, types, tests, and a production build
```

[docs/development.md](docs/development.md) covers the toolchain, the test layers, and the release
gate. If you use a coding agent on this repository, [AGENTS.md](AGENTS.md) carries the rules it needs.

## Documentation

[docs/README.md](docs/README.md) maps the current contracts, the architecture decisions, and the
archived evidence.

## License

[MIT](LICENSE)
