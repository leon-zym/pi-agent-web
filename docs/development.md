# Development

This document defines the supported toolchain, verification layers, CI, packaging, and release
checks. It is intentionally operational. Product behavior belongs in the other current contracts.

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

Generated local directories have separate purposes:

- `test-results/` holds Playwright traces, screenshots, and benchmark JSON or Markdown artifacts.
- `playwright-report/` is Playwright's optional HTML report, produced by the CI Browser reporter or
  an explicit HTML reporter selection.
- `tmp/` is reserved for disposable maintainer notes and local experiments. Project scripts use
  operating-system temporary directories for isolated package and runtime fixtures.

## Root commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Build protocol, then run Gateway and Vite development servers |
| `pnpm build` | Build all packages and enforce the UI bundle budget |
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

Use package filters and focused test paths while iterating. Run the full risk-appropriate gate before
handoff. Browser and benchmark suites start real local listeners and Chromium; do not run them
concurrently across worktrees.

## Repository scripts

Root commands call small repository-specific scripts where package tooling does not cover the
contract:

| Script | Responsibility |
| --- | --- |
| `check-docs.mjs` | Enforce authority-language policy, reject stale document names, and verify local links |
| `check-style.mjs` | Reject a short list of visual anti-patterns that bypass shared design tokens |
| `check-ui-bundle-budget.mjs` | Enforce gzip ceilings for the entry, settled-Markdown, and CSS assets |
| `clean-dist.mjs` | Remove one package's `dist` directory before rebuilding it |
| `pack-smoke.mjs` | Pack, inspect, install, launch, authenticate, and probe the local distribution |
| `run-performance-benchmarks.mjs` | Build and run one benchmark tier, then write reproducible artifacts |
| `performance-benchmark-validator.mjs` | Recompute benchmark summaries and reject incomplete or inconsistent evidence |

Keep these scripts narrow. Do not move ordinary lint, test, or build behavior into another custom
runner.

## Verification layers

### Unit and property tests

Pure guards, reducers, identities, policies, byte accounting, and state machines should have direct
tests. Filesystem, clock, process, and transport seams are injected where practical so edge cases do
not depend on local state.

### Server integration

Server tests exercise actual Session supervision, JSONL parsing, replay, control fencing, resource
custody, recovery, native discovery, deletion, and authenticated routes with deterministic process
fixtures.

Architecture, protocol, transport, deletion, or Session-scope changes require both focused
invariants and an upper-layer integration or Browser regression. A shallow smoke test is not enough.

### Deterministic Browser E2E

Playwright launches the production Gateway and UI against deterministic Pi fixtures. The suite
covers navigation, multiple Sessions, streaming, recovery, Extension UI, attachments and typed
content, large history, responsive layouts, accessibility regressions, and runtime resilience.

Tests must assert product behavior rather than incidental animation frames. Use stable readiness and
projection barriers. Keep test data free of credentials, user history, and private paths. Record
traces on failure; keep screenshots only when they provide durable visual evidence.

### Real Pi acceptance

Real-Pi tests are explicit because they can use the developer's configured provider credentials.
They create isolated temporary Workspace, Session, Browser-data, and Pi Agent roots. Only the
minimum required authentication and model configuration is copied into the private temporary Agent
root. Existing Pi history, extensions, settings, and project data are not loaded or modified.

The lane verifies the upstream boundary with concurrent Sessions, streaming follow-up and abort,
image input, rekey, fork or clone behavior, isolation, and RPC metadata. A release report states
whether it ran and why it was skipped if the explicit environment was unavailable.

## Performance evidence

`pnpm bench:representative` runs a bounded production-Chromium matrix and writes strict JSON plus
derived Markdown under `test-results/performance`. The artifact validator rejects missing scenarios,
invalid metrics, wrong tier labels, and incomplete outputs.

The representative matrix targets high-value risks:

- concurrent Session publication and Browser fairness;
- long streaming with structural flush boundaries;
- large native history and incremental Browser loading;
- replay, resync, crash recovery, Session rekey, Gateway restart, and stale mutation rejection;
- large typed content references near declared limits;
- bounded projection, queue, and materialization behavior.

`pnpm bench:stress` extends duration and load and runs only by explicit request or manual CI. It is
not a substitute for deterministic correctness.

This is Issue #28 Phase 1 and remains incomplete. Issue #28 stays open until the project publishes a
pinned reference-host profile and records two fresh representative baseline runs. Historical
observations from Issues #53 and #58 are non-reference. Structural checks and declared artifact
shape are hard gates; host-sensitive latency, throughput, long-task, heap, and other
timing/resource measurements remain diagnostic until that reference profile and variance policy
exist. A green run proves only the declared scenarios.

When changing a targeted optimization, add a reproducible scenario only if it guards a real product
risk. Do not create a generic benchmark framework or convert unstable workstation timing into a
release promise.

## Visual verification

Use the matrix in [Visual design](design.md). At minimum, inspect changed surfaces in both themes,
both product locales, keyboard and coarse-pointer modes, reduced motion, and relevant narrow and
wide widths.

Exercise empty, streaming, settled, failed, blocked, recovering, long-content, overlay, and
software-keyboard states where relevant. Check focus restoration, clipping, overlap, scroll
anchoring, background Session continuity, and critical action reachability.

## CI

The main CI workflow has three independent jobs:

1. deterministic `verify`, authenticated smoke, and package smoke;
2. packaged Browser E2E with failure traces;
3. the representative performance matrix with artifacts.

Pi compatibility has a separate exact-version workflow. The stress matrix is manual. Real-Pi
acceptance is never an implicit CI dependency.

The active `protect main` ruleset requires pull requests, an up-to-date branch, and the exact checks
`Deterministic verification` and `Packaged browser E2E`; it also blocks deletion and non-fast-forward
updates. The jobs are credential-free. Representative performance remains non-required evidence.

While the repository has one maintainer, required approvals are zero and there is no bypass actor.
Raise the count to one when a second maintainer becomes active.

## Packaging

The workspace contains protocol, server, UI, and CLI packages. `pnpm test:pack` creates local
tarballs in a temporary directory, checks package contents and dependency edges, installs them,
verifies the CLI help path, and launches the installed single-port workbench.

The packages are not published to npm. Passing package smoke proves local distribution integrity;
it does not imply registry publication or a stable public release.

## Release gate

Before a release-related handoff:

```bash
pnpm verify
pnpm test:smoke
pnpm test:compat
pnpm test:browser
pnpm test:pack
pnpm bench:representative
```

Also inspect the final diff, repository status, package contents, Browser artifacts, benchmark
artifact, and documentation links. Report the exact real-Pi outcome. Do not close a tracked issue
until its accepted behavior is on the shipped branch and deferred work is explicitly recorded.
Confirm the ruleset, exact required checks, and current maintainer-count exception.

## Code and commit conventions

- Use tabs and Biome. Do not add ESLint or Prettier.
- Keep Browser-safe code in protocol and Node-specific code in server.
- Prefer explicit state machines, bounded ownership, and pure reducers over generic frameworks.
- Treat untrusted values at their first authoritative boundary.
- Use Conventional Commits and keep stages independently reviewable.
- Preserve unrelated worktree changes and never hide a skipped or failed gate.
