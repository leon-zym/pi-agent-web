# Pi Agent Web

English | [Chinese](README.zh-CN.md)

Pi Agent Web is a local web workbench for Pi Coding Agent's RPC mode. It opens Pi's native JSONL
Sessions, keeps active Sessions independent, and lets background work continue while the Browser
moves between conversations.

Pi JSONL is the durable source of truth. Pi Agent Web does not copy Workspace or Session history
into another database.

> Pi Agent Web is a development preview. Interfaces can change and defects can interrupt work.
> Keep important work under version control and retain normal backups.

## Product boundary

The Gateway is a single-user, same-origin control surface that listens only on loopback addresses.
It is not a hosted service, a LAN server, or a multi-user collaboration system. Do not expose
`pi-web` through a public reverse proxy.
[SECURITY.md](SECURITY.md#security-boundary) owns the threat boundary and the reporting process.

Provider credentials, extensions, settings, and Session history remain in the user's Pi
installation. Development and CI use credential-free deterministic fixtures.

## Preview

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

The screenshots use deterministic fixtures and contain no provider credentials, private paths, or
user Session history.

## Quick start

### Release installation

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

### Development setup

Requirements: Node.js 22 or later, pnpm 11.21.0, and a compatible Pi Coding Agent runtime.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Development mode starts the Gateway on port 3000 and Vite on port 5173. Open the loopback URL that
Vite prints.

The names have different scopes: `pi-agent-web` is the repository and package namespace, and
`pi-web` is the user-facing command.

## Distribution status

The four `@pi-agent-web/*` packages are not published to npm. Clone the repository and use the
commands above. `pnpm test:pack` verifies local tarballs without implying a registry release.

The source is available under the [MIT License](LICENSE).

## Repository map

```text
packages/protocol  Browser-safe DTOs, guards, policy, and budgets
packages/server    Local Gateway, native discovery, and Session supervision
packages/ui        React workbench and Session-scoped Browser state
packages/cli       pi-web launcher and shutdown
docs/              Current contracts, architecture decisions, and archived evidence
```

## Documentation

[docs/README.md](docs/README.md) maps the current contracts, the architecture decisions, and the
archived evidence. [GitHub Issues](https://github.com/leon-zym/pi-agent-web/issues) tracks the
backlog and delivery status.
