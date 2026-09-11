# pi-agent-web

A local web workbench for Pi Coding Agent. Start with [docs/README.md](docs/README.md): its ownership
map names the document that owns each fact, which also routes a change to the right place. Tracked
documentation and code comments are English except `README.zh-CN.md`. Issues carry the backlog and
delivery state, `docs/decisions/` carries rationale, `docs/evidence/` carries frozen evidence.
`docs/notes/` and `tmp/` are ignored working material. Do not promote a temporary note into product
authority by linking to it from tracked documentation.

## Invariants

- Every durable Session fact lives in Pi JSONL. Workspace preferences stay discovery and presentation
  hints, never a second history database, and Pi's own directory environment keeps deciding where
  configuration and Sessions live.
- A Session's canonical file identity owns its process, control, ordering, recovery, and Browser
  state. Navigation changes only the visible view, so background work continues.
- A mutation carries the exact generation and current fence, and event projection reaches the
  response barrier before the command completes. Unknown identity, ordering, or protocol
  compatibility fails closed.
- A pending identity stays unverified until Pi materializes it, and abandoning an untouched
  transient Session leaves its file on disk.
- Deletion moves the file into recoverable trash by same-filesystem rename, after exact control, an
  identity reservation, and header, path, and inode verification.
- Only the CLI package composes the server and UI; every other package depends on the protocol
  package alone, which stays Browser-safe and free of Node and upstream Pi imports. Pi RPC and the
  Browser/Gateway protocol have separate compatibility contracts. The UI consumes ordered Session
  stores rather than WebSocket frames.
- The Gateway listens on loopback with same-origin authentication. Validate untrusted values at their
  first boundary: paths, Pi and Extension output, filenames, and Browser frames. Keep credentials,
  private paths, real history, provider output, and recoverable-trash content out of commits.
- User-visible copy goes through `packages/ui/src/lib/i18n` with matching `zh-CN` and `en` keys.
  Apply the Design contract's visible focus, reduced-motion, semantic-color, and critical-action
  rules.

## Conventions

- Biome is the only formatter and linter. Commits use Conventional Commits in reviewable stages.
- Prefer explicit state machines, bounded ownership, and pure reducers over generic frameworks.
  Filesystem, clock, process, and transport seams are injected where practical so edge cases do not
  depend on local state.
- The two names are deliberate: `pi-agent-web` is the repository and package namespace, and `pi-web`
  is the user-facing command. Do not perform a repository-wide rename between them.
- Keep unrelated worktree changes and never hide a skipped or failed gate.
- Match verification depth to risk: architecture, protocol, transport, deletion, and Session-scope
  changes need focused invariants plus an upper-layer integration or Browser regression.
- Run the release gate in [docs/development.md](docs/development.md) before a release handoff, with
  `pnpm test:compat` for Pi boundary changes. `pnpm test:e2e:real` stays explicit and
  credential-bearing.
