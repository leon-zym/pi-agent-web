# pi-agent-web engineering guide

Pi Agent Web is a local, Session-native workbench for Pi Coding Agent's RPC mode.

## Documentation map

Start with `README.md`, then open only the contract relevant to the task:

- `docs/architecture.md`: identity, ownership, concurrency, and recovery.
- `docs/protocol.md`: verified Pi RPC facts and the REST/WebSocket contract.
- `docs/ui-ux.md`: user-visible behavior and accessibility.
- `docs/design.md`: visual language and acceptance criteria.
- `docs/development.md`: test layers, CI, packaging, and release gates.
- `docs/decisions/`: accepted and superseded architecture decisions.

Issues hold backlog and delivery state. `docs/notes/` and `tmp/` are ignored working material. Do not
promote a temporary note into product authority by linking to it from tracked documentation.

## Package boundaries

- `packages/protocol` is Browser-safe. It owns product DTOs, strict guards, command policy, and
  shared budgets. It must not import Node APIs or upstream Pi packages.
- `packages/server` owns the local Gateway, Pi process supervision, native discovery, recovery,
  content custody, and authenticated REST/WebSocket transport.
- `packages/ui` owns the React workbench, transport consumption, projections, and Session-scoped
  Browser state. Components do not subscribe to WebSocket directly.
- `packages/cli` owns the `pi-web` launcher, static UI discovery, and bounded shutdown.

`pi-agent-web` is the repository and package namespace. `pi-web` is the user-facing command. Do not
perform a repository-wide rename between them.

## Non-negotiable architecture

- Pi JSONL is the only durable Session truth. Never create a second Workspace or Session database.
- A canonical JSONL realpath identifies a persisted Session. Header `id` verifies the file; it is
  not a global key. Canonical header `cwd` identifies the Workspace.
- Each hot Session owns at most one `pi --mode rpc` process. Dormant history owns none. The pool is
  bounded and permits concurrent Sessions in the same or different Workspaces.
- Browser selection is a view pointer. Navigation must not call Pi `switch_session` or
  `new_session`, and must not stop background Sessions.
- Pending, forked, and cloned Sessions remain unverified until Pi materializes and freezes their
  native identity. Abandoning an untouched transient Session stops memory state only; it never
  deletes a file.
- One authenticated WebSocket multiplexes isolated Session channels. Generation, sequence,
  subscription, lease, fencing token, command id, recovery, and Extension UI state are per Session.
- Browser/Gateway protocol 1.3 is the sole production contract. Version mismatch is terminal. Pi
  RPC is a separate upstream boundary named `PiRpcAdapter` with exact-version fixtures.
- Read-only commands do not require a controller lease. Mutations and Extension responses require
  the exact generation and current fence. Uncertain identity or ordering fails closed.
- Events are authoritative. A command resolves in the UI only after projection reaches its
  `barrierSeq`. Snapshots initialize or explicitly resync; they do not silently patch gaps.
- Workspace preferences store presentation and discovery hints only. They never rewrite or delete
  native Pi history.
- Deletion requires exact control, identity reservation, header/path/inode verification, and a
  same-filesystem move to recoverable trash. Never fall back to direct unlink or copy-and-unlink.

## UI and safety invariants

- Transport frames flow through the ordered Session bus, stream pipeline, and stores before UI
  components consume them.
- Projection, draft, attachments, submit state, model/thinking controls, commands, usage, and
  Extension UI are partitioned by canonical Session handle. Async work updates its captured Session.
- Background subscribed Sessions continue ingesting while another Session is visible.
- Coalesce only compatible text, thinking, or tool-call deltas. Structural, settled, error, rekey,
  and dialog-close boundaries flush synchronously.
- User-visible copy goes through `packages/ui/src/lib/i18n`; `zh-CN` and `en` keep the same shape.
  Code comments and tracked documentation are English.
- Follow `docs/design.md`: semantic color, clear hierarchy, visible focus, reduced motion, and no
  critical action hidden by responsive overflow.
- The Gateway listens on loopback and requires same-origin authentication. Treat paths, filenames,
  Pi output, extension payloads, and Browser frames as untrusted at every boundary.
- Preserve Pi directory environment semantics. Never commit credentials, private paths, real user
  history, provider output, or recoverable-trash content.

## Working conventions

- Use tabs and Biome. Do not add ESLint or Prettier.
- Prefer pure reducers and injected filesystem/process seams for deterministic tests.
- Preserve unrelated worktree changes. Use Conventional Commits in reviewable stages.
- Match verification depth to risk. Architecture, protocol, transport, deletion, or Session-scope
  changes require focused invariants and an upper-layer integration or Browser regression.
- Before a release handoff run `pnpm verify`, `pnpm test:smoke`, `pnpm test:browser`, and
  `pnpm test:pack`. Run `pnpm test:compat` for Pi boundary changes.
- `pnpm test:e2e:real` is explicit and credential-bearing. Never make it an implicit CI dependency.
