# pi-agent-web engineering guide

## Documentation authority

Read [docs/README.md](docs/README.md) first: it owns the documentation map and names the single owner
of each fact. Tracked documentation is English except `README.zh-CN.md`. Issues hold backlog and
delivery state, `docs/decisions/` holds rationale, and `docs/evidence/` holds frozen evidence. Never
link `docs/notes/` or `tmp/` from tracked documentation.

## Change to document

| Change | Update |
| --- | --- |
| Protocol boundary, Pi RPC, REST, or WebSocket shape | `docs/protocol.md`, plus an ADR for a new decision |
| User-visible behavior, interaction, accessibility behavior, i18n copy | `docs/ui-ux.md` |
| Visual language, tokens, composition, motion | `docs/design.md` |
| Toolchain, commands, CI, packaging, release gates | `docs/development.md` |
| Measurement semantics, comparison rules, valid evidence | `docs/benchmark.md` |
| Identity, ownership, concurrency, recovery, resource boundaries | `docs/architecture.md` |
| Threat boundary, supported versions, vulnerability reporting | `SECURITY.md` |
| A new long-term decision | New ADR plus `docs/decisions/README.md` |
| Delivery status, backlog, implementation plan | GitHub Issue or pull request |

## Hard rules

- Pi JSONL is the only durable Session truth. Never add a second history or ownership database.
  Workspace preferences stay discovery and presentation hints. Preserve Pi directory environment
  semantics.
- Canonical file identity and per-Session ownership govern processes, control, ordering, recovery,
  and Browser state. Navigation changes only the visible view and must never stop background work.
- Pending identity stays unverified until Pi materializes it. Abandoning an untouched transient
  Session must not delete a file.
- The protocol package stays Browser-safe and independent of upstream Pi types. Pi RPC and the
  Browser/Gateway protocol have separate compatibility contracts. Unknown identity, ordering, or
  protocol compatibility fails closed.
- Mutations require the exact generation and current fence, and event projection must reach the
  response barrier before a command completes. Snapshots never patch a gap silently.
- Components consume ordered Session stores, not WebSocket frames. Async work retains its captured
  Session and operation ownership through completion or cancellation.
- Deletion requires exact control, identity reservation, header/path/inode verification, and a
  same-filesystem move to recoverable trash. Never unlink directly or copy-and-unlink.
- Keep loopback and same-origin authentication. Treat paths, Pi and Extension output, filenames, and
  Browser frames as untrusted. Never commit credentials, private paths, real history, provider
  output, or recoverable-trash content.
- User-visible copy goes through `packages/ui/src/lib/i18n` with matching `zh-CN` and `en` keys. Tracked
  documentation and code comments are English. Apply the Design contract's visible focus, reduced-motion,
  semantic-color, and critical-action rules.
- `pi-agent-web` is the repository and package namespace; `pi-web` is the user-facing command. Never
  rename one to the other repository-wide.

## Working conventions

- Use tabs and Biome. Do not add ESLint or Prettier.
- Prefer pure reducers and injected filesystem or process seams for deterministic tests.
- Preserve unrelated worktree changes. Use Conventional Commits in reviewable stages.
- Match verification depth to risk. Architecture, protocol, transport, deletion, or Session-scope
  changes need focused invariants plus an upper-layer integration or Browser regression.
- Before a release handoff run `pnpm verify`, `pnpm test:smoke`, `pnpm test:browser`, and
  `pnpm test:pack`. Run `pnpm test:compat` for Pi boundary changes. `pnpm test:e2e:real` is explicit
  and credential-bearing; never make it an implicit CI dependency, and never hide a skipped or failed
  gate.
