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
diagnostic unless a compatible reference backs them.

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
`PI_WEB_BENCHMARK_IMAGE` to a stable label on both invocations. Darwin's undefined cgroup CPU quota is
inapplicable; an unknown Linux quota is incompatible.

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
