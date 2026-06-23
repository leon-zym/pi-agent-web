# pi-agent-web — engineering notes for AI collaborators

A modern web workbench for Pi Coding Agent's RPC mode. Authoritative spec:
`Desktop/Pi_Coding_Agent_RPC_Web_UI_Design_Report.md`; UI reference:
`yaca/docs/notes/deepseek-harness-web-ui-report.md`.

## Layout
- `packages/server`: Node gateway (Hono + ws). Core modules:
  `src/jsonl.ts` (strict LF JSONL, never readline), `src/resolver.ts`
  (PI_PATH → global pi → bundled rpc-entry.js), `src/pi-process.ts` (child
  process wrapper), `src/supervisor.ts` (workspace-granularity process
  management), `src/ws-bridge.ts`, `src/routes.ts`.
- `packages/ui`: React 19 + Vite + Tailwind v4, ShadCN-style. Stores are
  layered (transport / sessionDirectory / projection / view / composer /
  modelDirectory).
- `packages/cli`: the `pi-web` command — starts the server and opens the
  browser.

## Key conventions
- Protocol types are imported from `@earendil-works/pi-coding-agent`
  (RpcCommand, RpcResponse, RpcExtensionUIRequest, ...).
- The event stream is authoritative; get_* snapshots are only for
  initialization / reconnect replay.
- One `pi --mode rpc` child process per workspace (cwd = workspace);
  cross-workspace session switches must restart the process.
- bash commands must carry an id; prompts during streaming must carry
  streamingBehavior.
- All code comments are written in English; user-facing UI copy is Chinese.
- UI follows the ShadCN minimal style: low chrome, light hierarchy, blue only
  for primary actions / running state / links.
- Conventional Commits; commit in small stages.
- Env vars PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR must be passed
  through to child processes.
