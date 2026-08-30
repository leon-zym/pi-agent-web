# Pi Agent Web

Pi Agent Web is a local web workbench for Pi Coding Agent's RPC mode. It opens Pi's native JSONL
Sessions, keeps active Sessions independent, and lets background work continue while the Browser
moves between conversations.

Pi JSONL is the durable source of truth. Pi Agent Web does not copy Workspace or Session history
into another database.

> Pi Agent Web is a development preview. Interfaces can change and defects can interrupt work.
> Keep important work under version control and retain normal backups.

## Product boundary

The Gateway is a single-user, same-origin control surface that listens only on loopback addresses.
It is not a hosted service, a LAN server, a multi-user collaboration system, or a security boundary
against a hostile local user. Do not expose `pi-web` through a public reverse proxy.

Provider credentials, extensions, settings, and Session history remain in the user's Pi
installation. Credential-free development and CI use deterministic fixtures.

## What it provides

- Native Session discovery without a second history store.
- One independently supervised Pi process per active Session, with a bounded hot-process pool.
- One authenticated WebSocket carrying isolated Session channels.
- Streaming replies, reasoning, tool activity, Markdown, images, slash commands, and Extension UI.
- Session-scoped drafts, controls, projections, recovery, and background event ingestion.
- Fenced mutations, bounded payloads, explicit resync, and recoverable Session deletion.

Selecting a Session changes only the visible Browser view. It does not use Pi's global
`switch_session` or `new_session` commands, and it does not stop another Session.

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

The demo uses deterministic fixtures and contains no provider credentials, private paths, or user
Session history.

## Architecture at a glance

```text
Browser: selected view and Session-scoped stores
  -> one authenticated WebSocket with isolated Session channels
     -> Gateway: native catalog and bounded hot-process pool
        -> Pi RPC process per active Session
           -> native Pi JSONL
```

A canonical JSONL file identifies a persisted Session. The canonical `cwd` in its header identifies
the Workspace. A dormant historical Session owns no process and starts on demand.

Mutations require the exact Session generation and current fencing token. Read-only observers do
not require a controller lease. Unknown identity or ordering fails closed and triggers explicit
recovery rather than silent cursor repair.

## Quick start

Requirements: Node.js 22 or later, pnpm 11.21.0, and a compatible Pi Coding Agent runtime.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Development mode starts the Gateway on port 3000 and Vite on port 5173 by default. Open the
loopback URL printed by Vite.

Build the SPA before starting the single-port CLI:

```bash
pnpm build
pnpm start

# Forward CLI arguments through the root script.
pnpm start -- --pi-path /path/to/rpc-entry.js --port 3100 --no-open
```

`pi-web` accepts only loopback hosts. It normally uses the exact Pi dependency installed with the
distribution. `--pi-path` and `PI_PATH` are expert overrides and must pass the same bounded version
and capability probe.

The names have different scopes: `pi-agent-web` is the repository and package namespace;
`pi-web` is the user-facing command.

## Verification

```bash
pnpm verify                 # lint, types, deterministic tests, and production build
pnpm test:smoke             # authenticated REST and WebSocket smoke test
pnpm test:browser           # packaged deterministic Browser suite
pnpm test:pack              # tarball install and CLI launch smoke test
pnpm test:compat            # exact-version Pi compatibility fixtures
pnpm bench:representative   # reproducible representative performance matrix
pnpm bench:stress           # explicit long-running stress matrix
PI_WEB_RUN_E2E=1 pnpm test:e2e:real  # explicit credential-bearing real-Pi acceptance
```

The performance matrix is Issue #28 Phase 1 and remains incomplete. Structural correctness is
gated; host-sensitive latency, throughput, long-task, and heap results remain observational until a
reference-host baseline exists. See [Development](docs/development.md) for test boundaries.

## Distribution status

The four `@pi-agent-web/*` packages are not published to npm. Clone the repository and use the
commands above. `pnpm test:pack` verifies local tarballs without implying a registry release.

The source is available under the [MIT License](LICENSE).

## Repository map

```text
packages/protocol  Browser-safe DTOs, guards, policy, and budgets
packages/server    Local Gateway, native discovery, and Session supervision
packages/ui        React workbench and Session-scoped Browser state
packages/cli       pi-web launcher and bounded shutdown
docs/              Current contracts and architecture decisions
```

## Documentation authority

- [Architecture](docs/architecture.md): identities, ownership, concurrency, and recovery
- [Protocol](docs/protocol.md): Pi RPC facts and the Browser/Gateway contract
- [UI and UX](docs/ui-ux.md): user-visible behavior and accessibility
- [Design](docs/design.md): visual language and acceptance criteria
- [Development](docs/development.md): test layers, CI, packaging, and release checks
- [Architecture decisions](docs/decisions/README.md): rationale, supersession, and rejected alternatives
- [GitHub Issues](https://github.com/leon-zym/pi-agent-web/issues): backlog and delivery status

Current contracts describe the product as it exists now. Historical reasoning belongs in ADRs.
Files under `docs/notes/` and `tmp/` are ignored working material, not product authority.
