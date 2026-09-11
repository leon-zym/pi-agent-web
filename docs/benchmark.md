# Performance benchmarks

## Measurement

A run is evidence only when every trial and artifact is complete: canonical counts, indices, and
warmup flags, finite metrics, and recorded correctness outcomes. Structural and declared-artifact-shape
checks are hard gates, every trial holds the 64 mounted-turn bound, and streaming observations need
positive mounted-turn, streaming-DOM-batch, and fixture-delta counts, warmups included. Failed
artifacts are retained, never selected away.

Streaming metrics count DOM mutation callback batches and rAF callbacks, so they observe no paint,
React commit, or store publication. The two automation-start timings begin before the Playwright fill
and click dispatch and include fixture pacing and transport work. Timing and resource comparisons stay
diagnostic unless a compatible reference backs them; correctness and structural metrics are the gate.

A green run proves only its declared scenarios. When changing a targeted optimization, add a
reproducible scenario only if it guards a real product risk. Do not create a generic benchmark
framework or convert unstable workstation timing into a release promise.

## Comparison

```bash
node scripts/compare-benchmark-baseline.mjs <target-run-dir> --baseline <reference-run-dir>
```

| Status | Exit code | Meaning |
| --- | --- | --- |
| `INVALID` | 1 | Missing, malformed, incomplete, or failed evidence |
| `INCOMPATIBLE` | 2 | Valid evidence that cannot share a budget |
| `REGRESSION` | 0 | Compatible metrics exceed the comparison policy |
| `OK` | 0 | Compatible metrics stay within the policy |

Compatibility requires matching OS, kernel, and architecture, exact CPU model and logical count,
resource quota and memory, image label, Node, pnpm, Playwright and Chromium versions, suite and tier,
fixture and matrix hashes, lockfile, seed, warmup and sample counts, and scenario parameters. Commit
and build hashes may differ. An unspecified image label is incompatible, so set
`PI_WEB_BENCHMARK_IMAGE` to a stable label on both invocations. Darwin `quota.cpu="unavailable"` is
interpreted as inapplicable because the producer only reads Linux cgroup CPU quotas; missing Darwin
values and unknown Linux quotas remain incompatible.

## Admission gate

Policy `completion-median-v1` uses six measured medians: `stream-1m / totalCompletionMs`,
`sessions-4 / totalCompletionMs`, and `content-roundtrip / roundTripMs`, each in coalesced and
sequential variants. Against each of two fixed references independently, `target > 1.5 * reference
+ 50 ms` fails; equality passes. Either reference can fail the overall budget. Other metrics remain
diagnostic. This is an initial coarse completion-cost guard, not a responsiveness SLO or an estimate
of measurement noise; smaller regressions can pass.

The strict CLI validates the complete target and both reference raw/result sets before comparing.
`INVALID` or reference setup failures exit 1, as does an assessed budget regression. Only fully
compatible inputs receive a budget result. Incompatible inputs exit 0 with an explicit
performance-budget-not-evaluated status, preserving mandatory correctness without claiming a timing
pass. The original `--baseline` diagnostic command and its exit codes remain unchanged.

```bash
node scripts/compare-benchmark-baseline.mjs <target-run-dir> --strict --references tests/e2e/benchmarks/references.json --environment local --archive <cohort.zip>
```

## Diagnostic policy

Against the reference median, a higher-is-better metric takes the lower bound median / 1.5, and a
lower-is-better metric takes the upper bound median + abs(median) * 0.5 plus a floor of 50 ms, 5 MiB,
or zero for ratios and counts.

## Running

- `pnpm bench:representative` runs the deterministic representative matrix; `pnpm bench:stress` runs
  the long-running stress matrix on explicit request.
- `gh workflow run performance-stress.yml --ref main -f suite=representative-calibration` collects
  three representative bundles on one Actions machine.

Artifacts land in `test-results/performance/<tier>/<run-id>/` with a sibling `manifest.json` and
`environment.json`. Accepted suite-6 references are registered in
`tests/e2e/benchmarks/references.json`, and editing `tests/e2e/benchmarks/matrix.json` changes the
compared workload identity and invalidates them, so a coverage gap is recorded in an Issue instead.
Registering references from a new source commit also requires that commit in the
`TRUSTED_REFERENCE_SOURCES` allowlist in `scripts/benchmark-frozen-references.mjs`. The checked-in
`baselines/reference-linux-x64.json` of 2026-09-06 is `INCOMPATIBLE` with the current comparator, and
manual calibration uploads expire after 30 days. Archived historical measurements are in
[benchmark-phase-1-2026-09.md](evidence/benchmark-phase-1-2026-09.md).

## Issue ownership

[#28](https://github.com/leon-zym/pi-agent-web/issues/28) owns calibration,
[#117](https://github.com/leon-zym/pi-agent-web/issues/117) owns the remaining Phase 2 coverage
gaps; [#105](https://github.com/leon-zym/pi-agent-web/issues/105) owns the Gateway restart deferral.
