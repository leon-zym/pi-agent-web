# pi-agent-web — engineering notes for AI collaborators

A local, Session-native web workbench for Pi Coding Agent's RPC mode.

## Documentation map

- `README.md` / `README.zh-CN.md` — public overview, quick start, and product boundary.
- `docs/architecture.md` — identities, process pool, state ownership, concurrency, and recovery.
- `docs/protocol.md` — verified Pi RPC facts and the REST/WebSocket contract.
- `docs/ui-ux.md` — user-visible interaction and accessibility rules.
- `docs/development.md` — toolchain, test layers, CI, packaging, and release checks.
- `docs/decisions/` — accepted architecture decisions and rejected alternatives.
- `DESIGN.md` — visual contract for every surface.
- GitHub [Issues](https://github.com/leon-zym/pi-agent-web/issues) — backlog, sequencing, and completion status.

`docs/notes/` and `tmp/` are ignored working material, not current product contracts. Promote durable
facts into the tracked documents above. Never reference files outside this repository from code or
public documentation.

## Package and module boundaries

- `packages/protocol`: browser-safe DTOs, strict runtime guards, shared read-only command policy,
  and command deadlines. It must never import Node APIs or upstream Pi packages.
- `packages/server`: Node gateway (Hono + ws).
  - Process path: `jsonl` → `pi-process` → `session-runtime` → `session-supervisor` →
    `session-ws-bridge`.
  - Discovery path: `session-layout-resolver` → `native-session-catalog` → `native-routes`.
  - Side stores: `workspace-preferences` stores presentation/discovery hints only;
    `recoverable-session-trash` implements fenced deletion.
- `packages/ui`: React 19 + Vite + Tailwind v4. `session-transport` multiplexes one socket;
  `session-frame-bus` feeds `stream-pipeline`; stores and projections are Session-scoped.
- `packages/cli`: the `pi-web` launcher, static UI discovery, and bounded shutdown.

`pi-agent-web` is the repository/service and `@pi-agent-web/*` package namespace. `pi-web` is the
human-facing command. Do not perform a repository-wide rename between them.

## Architecture invariants

- Pi JSONL is the durable Session truth. Do not create a second Workspace/Session database.
- A canonical JSONL file realpath is the persisted Session identity; Header `id` verifies the file
  but is not a global key. Canonical Header `cwd` is the Workspace identity. Encoded directory names
  are discovery hints only.
- Every hot Session owns at most one `pi --mode rpc` process; a dormant historical Session owns
  none. The hot pool is bounded. Same-Workspace and cross-Workspace Sessions may run concurrently.
- Browser selection is only a view pointer. Never use Pi `switch_session`/`new_session` for
  navigation, and never stop one Session merely because the user selected another.
- A new empty Session can rekey from a pending handle to its canonical file handle. Pi may allocate
  a new/fork child path before creating the JSONL; keep that identity unverified and non-recoverable
  until the first materialized Header id/cwd is frozen. Fork/clone rekeys the active process to the
  child; the parent remains independently reopenable.
- Untouched, idle, unpersisted Sessions may be abandoned with the exact lease/generation or by the
  bounded orphan reaper. This path only stops and forgets memory state; it must never delete a file.
- One authenticated WebSocket carries multiple Session channels. Subscription, lease, fencing
  token, generation, seq, replay/resync, command ids, and Extension UI state are isolated per
  Session.
- Every WebSocket begins with versioned client/server hello negotiation. Protocol-major mismatch is
  terminal. The server epoch is negotiated now; replay/cursor fencing is completed under Issue #17.
- Read-only RPC commands do not require a controller lease. Every mutation and Extension response
  requires the exact generation and current fencing token. Gap or uncertain identity always fails
  closed; never silently repair a cursor or accept a nullable generation.
- The event stream is authoritative. A command response resolves in the UI only after projection
  state covers its `barrierSeq`; snapshots are for initialization and explicit resync.
- Workspace preferences must never overwrite or delete native Pi history. Resolve default,
  environment, global, project, direct, and relative Session directories through
  `SessionLayoutResolver`, using the same child-cwd semantics as Pi. Project-only configuration and
  every child-cwd-relative Agent/Session directory require a known Workspace discovery hint;
  absolute default/global/environment directories do not.
- Session deletion is recoverable and fenced: exact lease/generation, identity reservation,
  Header/path/inode verification, same-filesystem atomic move. No direct unlink or EXDEV
  copy-and-unlink fallback.

## UI invariants

- Components never subscribe to WebSocket directly. Frames pass through the transport, ordered
  Session bus, pipeline, and stores.
- Projection, draft, attachments, submit state, model/thinking, slash commands, usage, and Extension
  UI are partitioned by canonical Session handle. Async completions must update their captured
  Session, not whichever Session is currently visible.
- Background subscribed Sessions continue ingesting while the user views another Session.
- Coalesce only delta-only text/thinking/toolcall updates with matching Session/generation/message/
  content identity. Structural, settled, error, rekey, and dialog-close boundaries flush
  synchronously. Visible tabs use rAF; hidden tabs use a bounded timer.
- All user-visible copy goes through `src/lib/i18n` (`zh-CN` default, `en` same shape). Code comments
  are English.
- Follow `DESIGN.md`: quiet ShadCN-style hierarchy, semantic color, strong focus-visible states,
  reduced-motion support, and no critical action hidden by responsive overflow.

## Security and resource boundary

- The Gateway is a local, same-origin control surface. Only loopback listeners are valid. Except for
  the endpoint that issues the bootstrap Cookie, REST and WS require that Cookie; validate loopback
  Host, Origin when present, and Fetch Metadata for browser same-origin GETs without Origin.
- Treat `sessionFile`, Header `cwd`, filenames, model output, extension payloads, and all browser
  frames as untrusted. Guards and item/byte ceilings belong at every buffering boundary.
- Preserve `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` semantics in child processes.
- Never commit credentials, personal Pi history, private absolute paths, real provider output, or
  recoverable-trash contents. Real-Pi tests use isolated temporary workspaces and explicit opt-in.

## Working and verification conventions

- Use tabs and Biome; do not add ESLint/Prettier. Keep browser-safe types in protocol and Node code
  in server. Prefer pure reducers and injected filesystem/process seams for deterministic tests.
- Conventional Commits, in reviewable stages. Preserve unrelated dirty-worktree changes.
- Match verification depth to risk; see `docs/development.md`. Before a release-related handoff run
  `pnpm verify`, `pnpm test:smoke`, `pnpm test:browser`, and `pnpm test:pack`.
- `pnpm test:e2e:real` is explicit and credential-bearing; never make it an implicit CI dependency.
- Architecture, protocol, transport, deletion, or Session-scoping changes require both focused
  invariants and an upper-layer integration/browser regression. A green shallow smoke is not enough.
