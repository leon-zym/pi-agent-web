# pi-agent-web — engineering notes for AI collaborators

A modern web workbench for Pi Coding Agent's RPC mode.

## Documentation map
- `README.md` — overview, quick start, feature list.
- `docs/architecture.md` — topology, supervisor, stores, project structure.
- `docs/protocol.md` — the verified Pi RPC protocol map and storage layout.
- `docs/ui-ux.md` — interaction design and UX rules.
- `docs/development.md` — toolchain, verification, commit rules.
- `DESIGN.md` — the visual design contract for every new surface.

## Layout
- `packages/protocol`: Browser-safe DTOs, runtime message guards, and trusted command
  timeout policy shared by the gateway and UI. It must never import Node APIs.
- `packages/server`: Node gateway (Hono + ws). Core modules:
  `src/jsonl.ts` (strict LF JSONL, never readline), `src/resolver.ts`
  (PI_PATH → global pi → bundled rpc-entry.js), `src/pi-process.ts` (child
  process wrapper), `src/supervisor.ts` (workspace-granularity process
  management), `src/ws-bridge.ts`, `src/routes.ts`.
- `packages/ui`: React 19 + Vite + Tailwind v4, ShadCN-style. Stores are
  layered (transport / sessionDirectory / projection / view / composer /
  modelDirectory); UI copy goes through `src/lib/i18n`.
- `packages/cli`: the `pi-web` command — starts the server and opens the
  browser.

## Naming
- `pi-agent-web` is the repository, service, and `@pi-agent-web/*` package
  namespace. `pi-web` is the short human-facing CLI command and local UI name.
  Keep that boundary; do not perform a repository-wide rename between them.

## Key conventions
- Protocol types are imported from `@earendil-works/pi-coding-agent`
  (RpcCommand, RpcResponse, RpcExtensionUIRequest, ...).
- Browser ↔ gateway DTOs and guards are imported from `@pi-agent-web/protocol`;
  the UI must never import server runtime code.
- The event stream is authoritative; get_* snapshots are only for
  initialization / reconnect replay.
- One `pi --mode rpc` child process per workspace (cwd = workspace);
  cross-workspace `switch_session` is rejected. Select the target workspace
  explicitly before opening one of its sessions.
- Gateway is a local, same-origin control surface: only loopback listeners are
  valid; REST and WS require the bootstrap session Cookie. Validate an Origin
  when present; browser same-origin REST GETs use Fetch Metadata instead.
- One Workspace has one controller lease. Every state-changing command carries
  `expectedSessionId`; observers remain read-only until they claim the lease.
- Treat `sessionFile` and JSONL Header `cwd` realpaths as data identities. Do
  not substitute session UUIDs or encoded directory names for either check.
- bash commands must carry an id; prompts during streaming must carry
  streamingBehavior.
- All code comments are written in English; user-facing UI copy is Chinese
  and must go through the i18n dictionary (zh-CN default, en included).
- UI follows the ShadCN minimal style: low chrome, light hierarchy, blue only
  for primary actions / running state / links.
- Conventional Commits; commit in small stages.
- Env vars PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR must be passed
  through to child processes.
- Before a release-related change, run `pnpm verify`, `pnpm test:smoke`, and
  `pnpm test:pack`. CI is credential-free; real-Pi checks stay explicit.
- Never reference documents outside this repository from code or docs;
  capture the needed facts in `docs/` instead.
