# pi-agent-web engineering guide

Pi Agent Web is a local, Session-native workbench for Pi Coding Agent's RPC mode.

## Documentation map

Start with `README.md`, then open only the contract relevant to the task:

- [Architecture](docs/architecture.md): package boundaries, identity, ownership, concurrency, and recovery.
- [Protocol](docs/protocol.md): verified Pi RPC facts and the REST/WebSocket contract.
- [UI and UX](docs/ui-ux.md): user-visible behavior, localization, and accessibility.
- [Design](docs/design.md): visual language and acceptance criteria.
- [Development](docs/development.md): test layers, CI, packaging, and release gates.
- [Security](SECURITY.md): threat boundary and private vulnerability reporting.
- [Architecture decisions](docs/decisions/README.md): rationale and explicit supersession.

Issues hold backlog and delivery state. `docs/notes/` and `tmp/` are ignored working material. Do not
promote a temporary note into product authority by linking to it from tracked documentation.

## Engineering guardrails

Follow the linked contracts rather than maintaining another implementation inventory here.

- Pi JSONL is the only durable Session truth. Workspace preferences are discovery/presentation hints,
  never a second history database. Preserve Pi directory environment semantics.
- Canonical file identity and per-Session ownership govern processes, control, ordering, recovery,
  and Browser state. Navigation changes only the visible view and must not stop background work.
- Pending identity stays unverified until Pi materializes it. Abandoning an untouched transient
  Session must not delete a file.
- The protocol package remains Browser-safe and independent of upstream Pi types. Pi RPC and the
  Browser/Gateway protocol have separate compatibility contracts; unknown identity, ordering, or
  protocol compatibility fails closed.
- Mutations require exact generation and current fence. Event projection must reach the response
  barrier before a command completes; snapshots do not silently patch gaps.
- Components consume ordered Session stores, not WebSocket frames. Async work retains its captured
  Session and operation ownership through completion or cancellation.
- Deletion requires exact control, identity reservation, header/path/inode verification, and a
  same-filesystem move to recoverable trash. Never use direct unlink or copy-and-unlink.
- Keep loopback and same-origin authentication. Treat paths, Pi/Extension output, filenames, and
  Browser frames as untrusted. Never commit credentials, private paths, real history, provider output,
  or recoverable-trash content.
- User-visible copy uses `packages/ui/src/lib/i18n` with matching `zh-CN`/`en` keys. Tracked
  documentation and code comments are English. Apply the Design contract's visible focus,
  reduced-motion, semantic-color, and critical-action requirements.

`pi-agent-web` is the repository/package namespace; `pi-web` is the user-facing command. Do not
perform a repository-wide rename between them.

## Working conventions

- Use tabs and Biome. Do not add ESLint or Prettier.
- Prefer pure reducers and injected filesystem/process seams for deterministic tests.
- Preserve unrelated worktree changes. Use Conventional Commits in reviewable stages.
- Match verification depth to risk. Architecture, protocol, transport, deletion, or Session-scope
  changes require focused invariants and an upper-layer integration or Browser regression.
- Before a release handoff run `pnpm verify`, `pnpm test:smoke`, `pnpm test:browser`, and
  `pnpm test:pack`. Run `pnpm test:compat` for Pi boundary changes.
- `pnpm test:e2e:real` is explicit and credential-bearing. Never make it an implicit CI dependency.
