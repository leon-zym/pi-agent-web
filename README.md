# Pi Agent Web

[English](README.md) · [简体中文](README.zh-CN.md)

Pi Agent Web is a local, Session-native web workbench for Pi Coding Agent's RPC mode. It opens
Pi's existing JSONL Sessions, runs active Sessions independently, and keeps background work alive
while you move between conversations.

Pi JSONL remains the durable source of truth. Pi Agent Web does not copy Workspace or Session
history into a second database. A Workspace is derived from the canonical `cwd` in each JSONL
header; a small preference store keeps presentation and discovery hints only.

> Pi Agent Web is a development preview. Interfaces and compatibility may change, and defects may
> interrupt normal use. Keep important work under version control and retain your usual backups.

## Local Preview Boundary

The gateway is a single-user, same-origin control surface that listens only on loopback addresses.
After the bootstrap request issues an HttpOnly cookie, all other REST and WebSocket requests require
it and are checked against the loopback Host plus Origin or Fetch Metadata. These checks are intended for local browser use, not
for a hosted service, LAN deployment, remote accounts, multi-user collaboration, or isolation from
a hostile local user. Do not expose `pi-web` through a public reverse proxy.

Provider credentials, extensions, settings, and JSONL history remain in the user's Pi installation.
This repository does not bundle them, and credential-free CI does not need them.

## Features

- Pi-native discovery uses canonical JSONL file paths for Session identity and header `cwd` paths
  for Workspace grouping. Preferences never replace, rewrite, or delete native history.
- Each hot Session runs at most one `pi --mode rpc` process. Dormant Sessions have no process, and a
  bounded pool allows same-Workspace and cross-Workspace Sessions to run concurrently.
- The browser and gateway multiplex isolated Session channels over one authenticated WebSocket.
  Controller leases, generation, fencing, sequence cursors, replay, resync, and Extension UI state
  are scoped to each Session.
- Selecting a conversation changes only the visible view. Other subscribed Sessions continue to
  receive events, so switching Workspace or Session does not stop background work.
- The workbench supports streaming replies, reasoning and tool steps, settled GFM and code,
  model/thinking controls, slash commands, Extension UI, and image attachments including
  image-only prompts.
- The gateway applies bounded JSONL, frame, command, replay, and client-buffer limits. Session
  deletion is fenced and moves a verified file to recoverable trash instead of unlinking it.

## Product Demo

Workbench views:

<table>
<tr>
<td align="center"><img src="docs/assets/demo/overall.png" alt="Pi Agent Web Session-native workbench showing a settled coding-agent response" width="560" /><br /><sub>Focused conversation workbench</sub></td>
<td align="center"><img src="docs/assets/demo/tool-inspect.png" alt="Pi Agent Web tool diff and inspector" width="560" /><br /><sub>Tool result and contextual inspector</sub></td>
</tr>
<tr>
<td align="center"><img src="docs/assets/demo/dark-mode.png" alt="Pi Agent Web dark theme with token-based syntax highlighting" width="560" /><br /><sub>Dark theme</sub></td>
<td align="center"><img src="docs/assets/demo/mobile.png" alt="Pi Agent Web responsive 375 pixel Session view" width="220" /><br /><sub>375 px responsive view</sub></td>
</tr>
</table>

All demo content comes from the deterministic browser fixture. The screenshots contain no provider
credentials, private paths, or user Session history.

## Session Model

```text
Browser: selected view + per-Session stores
  └─ one authenticated WebSocket, N isolated Session channels
       └─ Gateway: native catalog + bounded hot-runtime pool
            ├─ Workspace X / Session A ─ Pi process A ─ A.jsonl
            ├─ Workspace X / Session B ─ Pi process B ─ B.jsonl
            └─ Workspace Y / Session C ─ dormant, JSONL only
```

The selected Session is a browser view pointer, not Pi's global current Session. Activating a
historical Session starts its process on demand. Idle, persisted Sessions can return to dormant
state when the pool needs capacity, then reopen from the same native JSONL file.

Absolute default, global, and environment-configured Pi directories are discoverable without a Web
preference. A project-only `sessionDir`, or any relative Agent/Session directory interpreted from a
Pi child's Workspace cwd, cannot be derived without first knowing that Workspace path. Removing the
Workspace removes that discovery hint, not its JSONL files; adding the same canonical path restores
discovery.

Mutating commands require the exact Session generation and current fencing token. Read-only
observers can follow events without claiming control. On reconnect, bounded replay fills a known
gap; if the cursor or identity is uncertain, the client performs an explicit snapshot resync.

## Quick Start

Requirements: Node.js 22+, pnpm 11.21.0, and a Pi Coding Agent runtime.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Development mode starts the gateway on `:3000` and Vite on `:5173` by default. Open the loopback
URL printed by Vite, add a local Workspace, then open an existing native Session or create one.

Build the SPA before starting the single-port CLI:

```bash
pnpm build
pnpm start

# Pass CLI arguments through the root script
pnpm start -- --pi-path /path/to/rpc-entry.js --port 3100 --no-open
```

`pi-web` accepts `127.0.0.1`, `localhost`, or `::1` as `--host`. It resolves Pi from
`--pi-path` / `PI_PATH`, then `pi` on `PATH`, then an installed Pi package's dedicated
`rpc-entry.js`. Common options are `--pi-path`, `--host`, `--port`, `--no-open`, and `--help`.

The naming boundary is intentional: `pi-agent-web` is the repository, service, and
`@pi-agent-web/*` package namespace; `pi-web` is the user-facing command.

## Verification

```bash
pnpm verify                                      # lint, types, deterministic tests, build
pnpm test:smoke                                  # authenticated REST/WebSocket with fake Pi
pnpm test:e2e                                    # packaged browser E2E with fake Pi
pnpm test:pack                                   # pack/install four packages; verify help; launch via the bin
PI_WEB_RUN_E2E=1 pnpm test:e2e:real              # explicit real Pi/provider compatibility
```

`pnpm test:e2e` is an alias for `pnpm test:browser`. CI runs `verify`, `test:smoke`,
`test:pack`, and the packaged Chromium suite without provider credentials. Real Pi checks remain
explicit because they use the developer's configured provider.

The real Pi suite covers concurrent Sessions on one WebSocket, image-only input, content
isolation, follow-up and abort while streaming, clone rekeying, parent/child history isolation,
and RPC metadata. It creates isolated temporary Workspace, Session, Web-data, and Pi Agent roots;
only `auth.json` and `models.json` are copied into the private temporary Agent root. It neither loads
the user's extensions/settings nor scans or modifies existing Pi history, and it verifies that the
real `settings.json` fingerprint is unchanged after every run.

## Distribution Status

The four `@pi-agent-web/*` packages are not published to npm. Clone the repository and use the
commands above; do not rely on an `npx @pi-agent-web/cli` installation yet.

`pnpm test:pack` creates local tarballs for protocol, server, UI, and CLI in a temporary directory.
It checks package contents and dependencies, installs the tarballs, verifies `--help` through the
binary and equivalent local `npx` path, then starts the single-port workbench with the installed
binary. This verifies packaging without implying a registry release.

The source is available under the [MIT License](LICENSE). The current boundary is a GitHub preview,
not a stable npm or production release.

## Project Structure

```text
packages/
  protocol/  Browser-safe DTOs, runtime guards, and command policy
  server/    Native catalog, bounded Session runtime pool, REST, and multiplexed WebSocket
  ui/        React 19 workbench with Session-scoped stores and streaming projection
  cli/       pi-web launcher, static UI discovery, and bounded shutdown
docs/
  decisions/ Accepted architecture decision records
  *.md       Architecture, protocol, UI/UX, and development contracts
```

## Documentation

- [Architecture](docs/architecture.md): identity, process ownership, concurrency, and recovery
- [Protocol](docs/protocol.md): verified Pi RPC facts and the browser/gateway contract
- [UI and UX](docs/ui-ux.md): interaction, accessibility, and responsive behavior
- [Development](docs/development.md): test layers, CI, packaging, and release checks
- [Roadmap](docs/roadmap.md): completed recovery scope and bounded follow-up Issues
- [Architecture decisions](docs/decisions/README.md): accepted decisions and rejected alternatives
- [Visual design](DESIGN.md): visual tokens and component rules
- [简体中文](README.zh-CN.md): Chinese README

Files under `docs/notes/` and `tmp/` are ignored working material, not current product contracts.
