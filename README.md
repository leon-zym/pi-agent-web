# Pi Agent Web

English | [Chinese](README.zh-CN.md)

A local web workbench for [Pi Coding Agent](https://github.com/earendil-works/pi)'s RPC mode. It opens
Pi's native JSONL Sessions in the browser, keeps active Sessions independent, and lets background
work continue while you move between conversations.

Pi JSONL stays the single durable source of truth. Pi Agent Web does not copy Workspace or Session
history into a second database.

> Pi Agent Web is a development preview. Interfaces can change and defects can interrupt work. Keep
> important work under version control and retain normal backups.

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

Screenshots use deterministic fixtures, with no provider credentials, private paths, or user Session
history.

## Features

- Discover Pi's native Sessions and Workspaces, with no second history store.
- Run one supervised Pi process per active Session, so switching views never stops background work.
- Stream replies, reasoning, tool activity, Markdown, images, slash commands, and Extension UI.
- Keep drafts, attachments, control, model choice, and recovery scoped to each Session.
- Delete a Session into recoverable trash behind exact identity and control checks.
- Attach Workspace files after a preview of size, kind, and risk, then capture them for the prompt.
- Follow the conversation with a light and dark theme, keyboard operation, `zh-CN` and `en` copy,
  and responsive layouts.

## Product boundary

The Gateway is a single-user, same-origin control surface that listens only on loopback addresses.
Run it on your own machine, and do not expose `pi-web` through a public reverse proxy.
[SECURITY.md](SECURITY.md#security-boundary) owns the threat boundary and the reporting process.

Provider credentials, extensions, settings, and Session history stay in your Pi installation.
Development and CI use credential-free deterministic fixtures.

## Quick start

Requirements: Node.js 22 or later, pnpm 11.21.0, and a compatible Pi Coding Agent runtime.

### Run a release build

1. Download the archive and its checksum from
   [GitHub Releases](https://github.com/leon-zym/pi-agent-web/releases).
2. Unpack it and enter the directory:
   ```bash
   tar -xzf pi-agent-web-v*.tar.gz
   cd pi-agent-web-v*
   ```
3. Install production dependencies:
   ```bash
   npm install --omit=dev --ignore-scripts
   ```
4. Launch the workbench:
   ```bash
   npx pi-web
   ```

### Work on the source

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Development mode starts the Gateway on port 3000 and Vite on port 5173. Open the loopback URL that
Vite prints. `pnpm build` then `pnpm start` runs the built single-port workbench, and
`pnpm start -- --pi-path /path/to/rpc-entry.js --port 3100 --no-open` forwards CLI arguments.

The names have different scopes: `pi-agent-web` is the repository and package namespace, and
`pi-web` is the user-facing command.

## Contributing

Issues and pull requests are welcome. Read [AGENTS.md](AGENTS.md) before changing code or
documentation, and [docs/development.md](docs/development.md) for the toolchain, the verification
layers, and the release gate.

```bash
pnpm verify        # lint, types, deterministic tests, and production build
pnpm test:smoke    # authenticated REST and WebSocket smoke test
pnpm test:browser  # packaged deterministic Browser suite
```

Keep a change focused, add a regression where a real failure is plausible, and update the document
that owns each affected fact.

## Documentation

[docs/README.md](docs/README.md) maps the current contracts, the architecture decisions, and the
archived evidence. [GitHub Issues](https://github.com/leon-zym/pi-agent-web/issues) tracks the
backlog and delivery status.

## License

[MIT](LICENSE)
