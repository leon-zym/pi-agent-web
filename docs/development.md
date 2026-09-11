# Development

## Environment

- Node.js 22 or later
- pnpm 11.21.0 through Corepack or an equivalent pinned installation
- Chromium installed through Playwright for Browser tests
- a compatible Pi runtime for local use; deterministic CI does not require provider credentials

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Do not commit generated `dist`, `test-results`, Playwright output, credentials, private paths, real Pi
history, or provider output. `test-results/` holds traces, screenshots, and benchmark artifacts.

Project scripts use operating-system temporary directories for isolated package and runtime fixtures.

Tracked files use LF endings, tab indentation, and a final newline, as `.editorconfig` declares.

## Root commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Build protocol, then run Gateway and Vite development servers |
| `pnpm build` | Build all packages and enforce the UI bundle budget |
| `pnpm start` | Run the built workbench through the CLI package |
| `pnpm lint` | Run package lint, Biome, style, and documentation guards |
| `pnpm typecheck` | Build shared boundaries and typecheck packages plus Browser tests |
| `pnpm test` | Run deterministic package test suites |
| `pnpm verify` | Lint, types, benchmark-validator tests, package tests, and production build |
| `pnpm test:smoke` | Exercise authenticated REST and WebSocket with deterministic Pi |
| `pnpm test:browser` | Build and run the packaged Playwright suite |
| `pnpm test:compat` | Run exact-version Pi adapter fixtures and conformance |
| `pnpm test:pack` | Pack, install, inspect, and launch the four local packages |
| `pnpm bench:representative` | Run the reproducible representative performance matrix |
| `pnpm bench:stress` | Run the explicit long-running stress matrix |
| `PI_WEB_RUN_E2E=1 pnpm test:e2e:real` | Run explicit credential-bearing real-Pi acceptance |

`pnpm test:e2e` aliases `test:browser`; `test:e2e:real` is the credential-bearing lane.

Use package filters and focused test paths while iterating. Browser and benchmark suites start real
local listeners and Chromium, so do not run them concurrently across worktrees.

A dependency whose install runs a build script needs an entry in the `pnpm-workspace.yaml`
`allowBuilds` list; pnpm skips unlisted build scripts.

## Repository scripts

Repository-specific scripts cover contracts where package tooling does not; keep them narrow:

| Script | Responsibility |
| --- | --- |
| `check-docs.mjs` | Enforce authority-language policy, reject stale document names, verify local links, and require every tracked document to register in `docs/README.md` |
| `check-style.mjs` | Reject a short list of visual anti-patterns that bypass shared design tokens |
| `check-ui-bundle-budget.mjs` | Enforce gzip ceilings for the entry, settled-Markdown, and CSS assets |
| `clean-dist.mjs` | Remove one package's `dist` directory before rebuilding it |
| `pack-smoke.mjs` | Pack, inspect, install, launch, authenticate, and probe the local distribution |
| `run-performance-benchmarks.mjs` | Build and run one benchmark tier, then write reproducible artifacts |
| `performance-benchmark-validator.mjs` | Recompute benchmark summaries and reject incomplete or inconsistent evidence |

## Verification layers

### Unit and property tests

Pure guards, reducers, identities, policies, byte accounting, and state machines have direct tests.

### Server integration

Server tests exercise actual Session supervision, JSONL parsing, replay, control fencing, resource
custody, recovery, discovery, deletion, and authenticated routes with deterministic process fixtures.

### Deterministic Browser E2E

Playwright launches the production Gateway and UI against deterministic Pi fixtures, covering
navigation, multiple Sessions, streaming, recovery, Extension UI, attachments and typed content, large
history, responsive layouts, accessibility regressions, and runtime resilience. Tests exercise product
behavior rather than incidental animation frames, wait on stable readiness and projection barriers,
record traces on failure, and keep screenshots only as durable visual evidence. Visual changes also
follow the [visual acceptance matrix](design.md#visual-acceptance-matrix).

### Real Pi acceptance

Real-Pi tests are explicit because they can use the developer's configured provider credentials. They
build isolated temporary Workspace, Session, Browser-data, and Pi Agent roots, copying only the minimum
required authentication and model configuration into the private temporary Agent root and loading no
existing Pi history, extensions, settings, or project data. They cover concurrent Sessions, streaming
follow-up and abort, image input, rekey, fork or clone behavior, isolation, and RPC metadata; a release
report states whether the lane ran and why it was skipped.

## CI

The main CI workflow has three independent jobs: deterministic `verify` with authenticated smoke and
package smoke; packaged Browser E2E with failure traces; and the representative performance matrix
with artifacts, whose [measurement semantics](benchmark.md) live in their own contract. Pi
compatibility uses a separate exact-version workflow triggered by changes under
`packages/protocol/**`, the Pi RPC adapter, host adapter, resolver, or their fixtures, and by
`package.json` or `pnpm-lock.yaml`. The stress matrix runs only through manual dispatch, and real-Pi
acceptance is never an implicit CI dependency.

Two gates exist only in CI, so a green local `pnpm verify` does not imply a green CI run:

- The verify job also runs the mixed-history fixture bounds, which no local script reaches because
  that file sits outside the package Vitest glob:
  ```bash
  pnpm --filter @pi-agent-web/server exec tsx --test --test-name-pattern="mixed history" ../../tests/e2e/fixtures/production-harness.test.ts
  ```
- `performance-benchmark-validator` replays the frozen references pinned in
  `scripts/benchmark-frozen-references.mjs`, so those commits must resolve locally; CI fetches them
  by SHA first.

The active `protect main` ruleset requires pull requests, an up-to-date branch, and the exact checks
`Deterministic verification` and `Packaged browser E2E`; it also blocks deletion and non-fast-forward
updates. The jobs are credential-free, and representative performance remains non-required evidence.
Real-Pi acceptance is never required for pull requests or forks. While the repository has one
maintainer, required approvals are zero and no bypass actor is allowed; raise the count to one when a
second maintainer becomes active.

## Packaging

`pnpm test:pack` creates local tarballs in a temporary directory, checks package contents and
dependency edges, installs them, verifies the CLI help path, and launches the installed single-port
workbench. Each package exposes only its entry point, so cross-package imports use the package name
rather than a path into `src`.

A tarball carries `dist` and `LICENSE` only. `release-stage.mjs` rejects a source file, uncompiled
TypeScript, a `workspace:` protocol leak, or a package version that differs from the root, so all four
packages release in lockstep on one version. The packages are not published to npm, so passing package
smoke proves local distribution integrity alone.

## Release gate

Before a release-related handoff, run `pnpm verify && pnpm test:smoke && pnpm test:compat &&
pnpm test:browser && pnpm test:pack && pnpm bench:representative`. Then inspect the final diff,
repository status, package contents, Browser and benchmark artifacts, and documentation links; report
the exact real-Pi outcome; and confirm the ruleset, required checks, and maintainer-count exception.
Do not close a tracked issue until its accepted behavior is on the shipped branch and deferred work is
recorded.

## Release staging and workflow

`pnpm release:stage --tag=v<version>` stages an archive on the release runner from a clean tree,
requires the tag to match the root version, and writes `dist/staging/pi-agent-web-v<version>/` with the
bundle manifest, private root package, install guide, and license. Add `--allow-local` for a local dry
run.

`.github/workflows/release.yml` takes a required `tag` input through `workflow_dispatch`, runs the
serial release gates, stages the directory, creates the outer tar.gz archive and a SHA-256 sidecar
checksum, and drafts a GitHub Release for maintainer review.
