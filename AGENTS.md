# pi-agent-web engineering guide

## Docs

Read [docs/README.md](docs/README.md) before a documentation change: its ownership map names the owner
of each fact. Tracked docs are English except `README.zh-CN.md`. Issues carry backlog and delivery
state, `docs/decisions/` carries rationale, and `docs/evidence/` carries frozen evidence.

## Where a change goes

| Change | Update |
| --- | --- |
| Protocol boundary, Pi RPC, REST, WebSocket | `docs/protocol.md` |
| User-visible behavior, interaction, i18n copy | `docs/ui-ux.md` |
| Visual language, tokens, composition, motion | `docs/design.md` |
| Identity, ownership, concurrency, recovery, limits | `docs/architecture.md` |
| Toolchain, commands, CI, packaging, release gates | `docs/development.md` |
| Measurement semantics, comparison rules | `docs/benchmark.md` |
| Threat boundary, reporting, supported versions | `SECURITY.md` |
| A new long-term decision | A new ADR plus `docs/decisions/README.md` |
| Delivery status, backlog, plan | A GitHub Issue or pull request |

## Guardrails

State each fact once, in its owning document. Pi JSONL is the only durable Session truth:
Workspace preferences stay discovery and presentation hints, and a second history or ownership
database never appears beside it. Preserve Pi directory environment semantics.

Canonical file identity and per-Session ownership govern processes, control, ordering, recovery, and
Browser state. Navigation changes only the visible view, so background work continues. Pending
identity stays unverified until Pi materializes it, and abandoning an untouched transient Session
leaves its file on disk.

The protocol package stays Browser-safe and independent of upstream Pi types, with a compatibility
contract separate from Pi RPC. Unknown identity, ordering, or protocol compatibility fails closed. A
mutation carries the exact generation and current fence, and event projection reaches the response
barrier before the command completes; snapshots never patch a gap silently.

Components consume ordered Session stores, not WebSocket frames, and async work keeps its captured
Session and operation ownership through completion or cancellation. Deletion needs exact control, an
identity reservation, header/path/inode verification, and a same-filesystem move to recoverable
trash.

Keep loopback and same-origin authentication, and treat paths, Pi and Extension output, filenames,
and Browser frames as untrusted. Committable content stays free of credentials, private paths, real
history, provider output, and recoverable-trash content. User-visible copy goes through
`packages/ui/src/lib/i18n` with matching `zh-CN` and `en` keys, and the Design contract's visible
focus, reduced-motion, semantic-color, and critical-action rules apply to every surface.
`pi-agent-web` is the repository and package namespace; `pi-web` is the user-facing command.

## Working conventions

- Use Biome for formatting and linting, with tabs.
- Prefer pure reducers and injected filesystem or process seams, so tests stay deterministic.
- Keep unrelated worktree changes, and commit in reviewable Conventional Commit stages.
- Match verification depth to risk: architecture, protocol, transport, deletion, and Session-scope
  changes need focused invariants plus an upper-layer integration or Browser regression.
- Run the release gate in [docs/development.md](docs/development.md) before a release handoff, with
  `pnpm test:compat` for Pi boundary changes. `pnpm test:e2e:real` stays explicit and
  credential-bearing, and a skipped or failed gate gets reported.
