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
history, or provider output.

- `test-results/` holds Playwright traces, screenshots, and benchmark JSON or Markdown artifacts.
- `playwright-report/` holds Playwright's optional HTML report.
- `tmp/` holds disposable maintainer notes and local experiments.

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

Use package filters and focused test paths while iterating. Browser and benchmark suites start real
local listeners and Chromium, so do not run them concurrently across worktrees.

## Repository scripts

Repository-specific scripts cover contracts where package tooling does not; keep them narrow:

| Script | Responsibility |
| --- | --- |
| `check-docs.mjs` | Enforce authority-language policy, reject stale document names, and verify local links |
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
custody, recovery, native discovery, deletion, and authenticated routes with deterministic process
fixtures.

### Deterministic Browser E2E

Playwright launches the production Gateway and UI against deterministic Pi fixtures. The suite covers
navigation, multiple Sessions, streaming, recovery, Extension UI, attachments and typed content, large
history, responsive layouts, accessibility regressions, and runtime resilience. Tests exercise product
behavior rather than incidental animation frames, wait on stable readiness and projection barriers,
record traces on failure, and keep screenshots only as durable visual evidence. Visual changes also
follow the [visual acceptance matrix](design.md#visual-acceptance-matrix).

### Real Pi acceptance

Real-Pi tests are explicit because they can use the developer's configured provider credentials. They
create isolated temporary Workspace, Session, Browser-data, and Pi Agent roots, copy only the required
authentication and model configuration into the private temporary Agent root, and never load or modify
existing Pi history, extensions, settings, or project data. The lane verifies the upstream boundary
with concurrent Sessions, streaming follow-up and abort, image input, rekey, fork or clone behavior,
isolation, and RPC metadata; a release report states whether it ran and why it was skipped when the
explicit environment was unavailable.

## CI

The main CI workflow has three independent jobs: deterministic `verify` with authenticated smoke and
package smoke; packaged Browser E2E with failure traces; and the representative performance matrix
with artifacts. Pi compatibility uses a separate exact-version workflow, the stress matrix runs only
through manual dispatch, and real-Pi acceptance is never an implicit CI dependency.

The active `protect main` ruleset requires pull requests, an up-to-date branch, and the exact checks
`Deterministic verification` and `Packaged browser E2E`; it also blocks deletion and non-fast-forward
updates. The jobs are credential-free, and representative performance remains non-required evidence.
While the repository has one maintainer, required approvals are zero and no bypass actor is allowed;
raise the count to one when a second maintainer becomes active.

[benchmark.md](benchmark.md) owns measurement and comparison semantics;
[Issue #28](https://github.com/leon-zym/pi-agent-web/issues/28) owns calibration, and
[#117](https://github.com/leon-zym/pi-agent-web/issues/117) owns the remaining Phase 2 coverage gaps.

## Packaging

`pnpm test:pack` creates local tarballs in a temporary directory, checks package contents and
dependency edges, installs them, verifies the CLI help path, and launches the installed single-port
workbench.

The packages are not published to npm. Passing package smoke proves local distribution integrity and
says nothing about registry publication or a stable public release.

## Release gate

Before a release-related handoff, run:

```bash
pnpm verify && pnpm test:smoke && pnpm test:compat && pnpm test:browser && pnpm test:pack && pnpm bench:representative
```

Also inspect the final diff, repository status, package contents, Browser artifacts, benchmark
artifact, and documentation links, and report the exact real-Pi outcome. Do not close a tracked issue
until its accepted behavior is on the shipped branch and deferred work is recorded. Confirm the
ruleset, exact required checks, and the current maintainer-count exception.

## Release staging and workflow

Official release archives are staged on the release runner through `pnpm release:stage`:

```bash
pnpm release:stage --tag=v<version>          # add --allow-local for a local dry run
```

The script checks that root and workspace package versions match the target tag, requires a clean
working tree, packs all four workspace packages, inspects tarball contents for compiled artifacts and
workspace protocol leaks, and writes `dist/staging/pi-agent-web-v<version>/` with the bundle manifest,
private root package, install guide, and license.

`.github/workflows/release.yml` triggers through `workflow_dispatch` with a required `tag` input. It
runs the serial release gates (`pnpm verify`, `pnpm test:smoke`, `pnpm test:browser`, `pnpm test:pack`),
stages the release directory, creates the outer tar.gz archive and a SHA-256 sidecar checksum, and
drafts a GitHub Release for maintainer review.
