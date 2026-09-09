# Performance Benchmark Report: Historical Phase 1 Observations

## Overview

The September 6, 2026 tables below preserve historical observations from the two recorded commits.
Their metric semantics, pooled CPU profiles, and calibration formula are incompatible with the
corrected benchmark suite. They do not establish a current reference baseline or performance
guarantee. The original values and reported statuses remain unchanged for provenance.

See [current streaming observer semantics](#current-streaming-observer-semantics) and the
[reproduction guide](#reproduction-guide) for current measurement definitions and comparison
requirements. Fresh calibration and remaining coverage are tracked in
[Issue #28](https://github.com/leon-zym/pi-agent-web/issues/28).

The reference environment, methodology, and numerical sections that follow describe that historical
calibration, including its original claims and limitations.

## Mixed history contract (suite version 6)

The additional history scenarios preserve `history-65m` and the stress byte-boundary cases.
They independently constrain native JSONL to 1,000 Turns / 4 MiB and 5,000 Turns / 16 MiB.
A five-Turn recipe mixes prose, fenced code, tool-call/result chains, collapsed thinking and
list/table Markdown. Four individual Markdown blocks are 10/64/120 KiB and 1 MiB; these are
not multiplied by every Turn. No real history or provider output is used.

Representative adds one 1,000-Turn bounded-mount cycle per publication variant. Stress declares
two sizes × two publication variants × bounded/full mounting × (one warmup + three measured
cycles): 32 independent cycles, 24 measured. This is a declared workload, not a claim that the
full stress matrix has passed. Mode order is fixed within each size: coalesced bounded/full,
sequential full/bounded. Each cycle owns one fresh Browser context and Gateway; the
Browser executable and OS disk cache may be reused. Full mounting is a compile-time benchmark
control using the same TurnView. The ordinary production executable scan must exclude the control.

Cold opening ends after the authoritative initial history is visible, loading has ended and two
animation frames have completed. Warm opening returns to the same retained Session store after
visiting a small second Session. GC is outside open/navigation timing: baseline, all-pages,
warm-reopen and small-Session-return checkpoints record absolute retained heap and DOM counts.
`heapDeltaBytes` is warm retained heap minus baseline, including negative values.
The final checkpoint intentionally retains cached history; it is not an unload or leak test.

Raw evidence records actual wire-page cursors and the deterministic timestamp/role/stop-reason
message identities, rather than counting local window expansion as remote pagination. Validation
requires every native message exactly once in order, the exact initial/final Turn counts, no
`get_messages` fallback, bounded mounting ≤64 or full mounting equal to the native Turn count,
and all declared actions. Oldest/middle/latest navigation, remote prepend anchor error (≤2 CSS
pixels), focus, resize, theme, text selection, clipboard copy, mounted-target find, draft-preserving
Session switching, reconnect and live Extension UI have separate outcomes and timings. Browser
find does not search unmounted history. Extension UI is live accompanying state added after the
native measurements; its added Turn and mounted count are recorded separately. It is not fabricated
persisted history. A fixed semantic digest excludes the private header and byte padding.

A cycle exceeding 120 seconds, 1 GiB measured JS heap or 500,000 DOM nodes stops as incomplete
INVALID evidence. Those are execution safety caps, not accepted performance budgets. Missing GC,
missing actions, duplicate/gapped pages, Browser errors or inconsistent raw-to-summary metrics
cannot become zero-valued success. A B-only development run remains partial; it cannot replace
formal stress completeness or the 800 measured recovery trials.

Suite 6 and changed producer/matrix provenance make the accepted suite-5 references incompatible.
They remain immutable and fully validated with their trusted frozen source before reporting budget
not evaluated. The six completion medians and `completion-median-v1` policy are unchanged. Final
B/C calibration is separate from this implementation and is still tracked in #28.

## Recovery scope (introduced in suite version 5)

Gateway restart performance is explicitly deferred to [Issue #105](https://github.com/leon-zym/pi-agent-web/issues/105).
It is absent from both formal matrices; the retained implementation has no active matrix entry.
The runner selects the remaining declared scenarios, and the validator still fails missing required
scenarios, variants, trials or unexpected artifacts. This is a workload revision, not skipped tests,
error suppression or replacement sampling. The strict restart error oracle remains unit-tested.

The four required fault classes are WebSocket disconnect, replay gap, Pi crash and Session rekey.
Stress retains 100 measured trials per fault per variant: 800 measured trials across both variants,
plus warmups. Gateway restart's additional 100 per variant belongs to #105. Other history, load and
fairness work remains in #28. The default Browser suite continues running the #103 real Gateway
restart directory-recovery regression, including automatic recovery without another prompt or click,
error/loading clearance and preserved selection/draft. This suite does not currently measure or
budget the directory-read/shutdown overlap.

Version 5 and changed matrix provenance reject old bundles as current evidence. Historical artifacts,
including the invalid local reference-2, remain unchanged; a new frozen source requires a new complete
cohort. The previously inspected holdout cannot validate a newly selected budget policy. Strict
completion budgets use the policy below; the accepted suite-5 local and Actions references are
registered in `tests/e2e/benchmarks/references.json`. `liveLongTasksOver50Ms` is a count (zero
additive floor), not a duration;
its suffix describes the 50 ms threshold. Other metric dimensions and diagnostic modes are unchanged.

## Completion median gate

Policy `completion-median-v1` uses six measured medians: `stream-1m / totalCompletionMs`,
`sessions-4 / totalCompletionMs`, and `content-roundtrip / roundTripMs`, each in coalesced and
sequential variants. Against each of two fixed references independently, `target > 1.5 * reference
+ 50 ms` fails; equality passes. Either reference can fail the overall budget. Other metrics remain
diagnostic. This is an initial coarse completion-cost guard, not a responsiveness SLO or an estimate
of measurement noise; smaller regressions can pass.

The strict CLI validates the complete target and both reference raw/result sets before comparing.
`INVALID` or reference setup failures exit 1, as does an assessed budget regression. Only fully
compatible inputs receive a budget result. Incompatible inputs exit 0 with an explicit performance-budget-not-evaluated status, preserving
mandatory correctness without claiming a timing pass. The original `--baseline` diagnostic command
and its exit codes remain unchanged.

`tests/e2e/benchmarks/references.json` keeps independent Actions and local sets. Both sets are
active at frozen source `00fe129125fcf273f8c27332ec4b115b59779ce8`.
A `{"status":"pending"}` set validates target raw data and reports that references are not
established. An active set has exactly `status`, `source` (frozen source commit), `artifactId`,
`sha256` (digest of the entire ZIP), `reference1` and `reference2` (distinct, predetermined run IDs).
For Actions, `artifactId` is the fixed GitHub artifact ID in this repository; local sets use null and
supply the archive path at invocation. The ZIP must contain the two run directories at its root;
retaining the third holdout and other cohort evidence is allowed. Both reference manifests must match
the registered source. Local paths and private machine information do not belong in the descriptor.

```bash
node scripts/compare-benchmark-baseline.mjs <target-run-dir> --strict --references tests/e2e/benchmarks/references.json --environment local --archive <cohort.zip>
```

Active archive loading requires Python 3 (standard-library ZIP handling); Actions additionally uses
`gh` with read-only Actions access. Reads are bounded to 8 MiB compressed, 128 MiB expanded and 2,048
entries, with digest/path checks and temporary extraction cleanup. Missing, expired, oversized or
corrupt active evidence fails; it never becomes pending automatically. Retain the adopted archive
before GitHub artifact expiry. Any replacement locator must be explicitly reviewed and preserve the
fixed evidence; an expired locator remains a setup failure until that update is accepted.

Strict evaluation requires a Git checkout with the reviewed reference source object
`00fe129125fcf273f8c27332ec4b115b59779ce8`. Local evaluation is offline; if the object is missing,
explicitly run `git fetch --depth=1 origin 00fe129125fcf273f8c27332ec4b115b59779ce8` first.
An anonymous source export without Git objects is not supported by this resolver. CI fetches the
fixed source from the existing origin; no additional permission or reference archive override is used.

The target's raw evidence and envelope are validated by the current checkout. Both fixed references
are validated by the allowlisted source's raw validator and envelope comparator in one bounded Node
subprocess, without inherited credentials or Node preload options. Executable code comes only from
that reviewed Git tree, never from the evidence ZIP. Temporary source extraction is bounded and
removed on success or failure. Other reference sources need explicit reviewed support.
Only after all three inputs validate does the strict path compare complete schema, suite, workload
and environment identities. Changed producers or matrices yield an explicit incompatible/unassessed
result; corrupt evidence still fails. Compatible inputs retain the same six-median policy. This does
not change the diagnostic `--baseline` command or refresh previously accepted evidence.

CI evaluates after representative collection and publishes `budget.md` in the artifact and job summary.
PRs use the base commit's reference descriptor, so editing a PR's descriptor cannot disable that PR's
active gate. The first descriptor introduction uses the checkout copy only when the base has no file.
Activation changes therefore take effect on main after review. No per-PR disable switch is provided.

After B/C stabilization, a future cohort requires an explicit reviewed source/descriptor update.
Freeze the final suite contract and policy before collecting fresh `reference-1`, `reference-2`,
`holdout` bundles separately per environment. Evaluate the new holdout using a temporary active
copy of the descriptor, then register accepted reference IDs/digest in the tracked descriptor.
Do not select references after seeing the holdout or reuse historical suite-4/previously inspected
holdouts. Registration must leave the complete declared producer set, matrices, suite, lockfile and evaluation
semantics unchanged. Product source/build hashes retain their own provenance; they are not required
to equal a reference's product build. Existing full workload/environment compatibility stays intact,
with no alternate producer hashes or hardware-lottery retries.

## Reference Environment (`linux-x64-gh-standard`)

All Phase 1 baseline benchmarks were executed within the pinned reference environment:

- **Profile ID**: `linux-x64-gh-standard`
- **Operating System / Kernel**: Linux Ubuntu 24.04 (kernel `6.17.0-1022-azure`)
- **Hardware**: 4 logical vCPUs (`Intel Xeon Platinum 8573C` / `AMD EPYC 7763`), 16 GiB RAM
- **Toolchain**: Node `v22.23.2`, pnpm `11.21.0`, Playwright `1.62.1`, Chromium `151.0.7922.34`
- **Build Artifacts**: Production minified build (`dirty: false`)

## Invariants and Methodology

The benchmark suite evaluates system behavior under two distinct categories of requirements:
deterministic correctness hard gates and host-sensitive diagnostic timing metrics.

### Deterministic Correctness Hard Gates

Correctness hard gates enforce critical protocol and system invariants. They must pass unconditionally
(zero failures) across every trial in every run:

1. **Zero duplicate events** (`zeroDuplicateLostEvents`): no duplicate frames or messages delivered.
2. **Zero lost events** (`zeroDuplicateLostEvents`): no dropped frames or message gaps in projection.
3. **Stale lease rejection** (`staleFenceRejected`): mutations with outdated fencing tokens fail closed.
4. **Stale generation rejection** (`staleGenerationRejected`): mutations from superseded generations fail closed.
5. **Stale epoch rejection** (`staleEpochRejected`): mutations from prior epochs are rejected.
6. **Sequence and recovery barriers** (`recoveryBarrier`): state is verified up to the exact sequence barrier.
7. **Final projection match** (`finalProjectionMatches`): UI projection exactly matches canonical JSONL history.
8. **Zero browser errors** (`browserErrors == 0`): zero uncaught page errors or unexpected console exceptions.
9. **Zero correctness failures** (`correctnessFailures == 0`): zero structural correctness violations.
10. **Turn nodes budget** (`turnNodes <= 64`): active DOM turn nodes stay bounded under stream load.
11. **Mounted turn nodes budget** (`mountedTurnNodes <= 64`): virtualized history DOM nodes remain bounded.
12. **Zero projection checkpoint deficit** (`browserProjectionCheckpointDeficit <= 0`): projection meets checkpoint requirements.
13. **Zero background ingest checkpoint deficit** (`backgroundIngestCheckpointDeficit <= 0`): background sessions ingest required checkpoints.
14. **Authenticated attachment fetch integrity** (`authenticatedAttachmentFetch == 1`): attachments require valid authentication.
15. **Max sent frame bytes budget** (`maxSentFrameBytes <= 8 MiB`): sent WebSocket frames stay within size limits.
16. **Max received frame bytes budget** (`maxReceivedFrameBytes <= 256 KiB`): received WebSocket frames stay within size limits.

Recovery scenarios also verify fault-specific structural invariants, including socket reconnection count (`reconnectedSockets <= 2`),
gap resync frames (`gapResyncFrames == 1`), process restart markers (`processStarts == 1`), rekey frames (`rekeyFrames == 1`),
gateway lifecycle transitions (`gatewayStarts == 1`, `activeGateways == 1`), and residual root entry count (`rootEntryCount <= 6`).

### Timing Metrics and Threshold Calibration Formula

Host-sensitive timing metrics (latencies, durations, throughputs, and memory allocations) are subject
to cloud virtualization noise and host CPU scheduling jitter. To prevent false-positive CI failures while
retaining regression detection sensitivity, thresholds are calibrated using two independent runs on the
reference host according to the formula:

```text
Threshold = Math.round((max(Median_1, Median_2) * 1.5 + floor) * 100) / 100
```

Where `floor` is defined as:

- `50` ms for latencies, durations, and dimensionless metrics
- `5` MB (5,242,880 bytes) for memory heap bytes and buffer sizes

## Provenance Runs

The reference baseline is calibrated from two consecutive, fully passing formal benchmark runs on the reference host:

| Property | Run 1 | Run 2 |
| :--- | :--- | :--- |
| **GitHub Actions Run ID** | `34024571730` | `34024886062` |
| **Suite Run ID** | `2026-09-06t092520783z-p2855-0d8e6b58` | `2026-09-06t093154444z-p3070-f9e18071` |
| **Commit** | `8313132` (`8313132cf57c060cbd5f4c6ed0e318bd02b8d430`) | `e59adfc` (`e59adfc2fe8a848d07f9756e6dd8eadbba40802e`) |
| **Timestamp** | 2026-09-06T09:24:42Z | 2026-09-06T09:31:17Z |
| **Trials** | 22 / 22 passed | 22 / 22 passed |
| **Validation Errors** | 0 | 0 |
| **Status** | Passed | Passed |

## Comprehensive Summary Table

The following table summarizes all 22 representative scenario and variant combinations across
the 5 benchmark domains (`streaming`, `history`, `concurrency`, `content`, `recovery`). Each row
shows the primary performance metric, observed medians from both provenance runs, the baseline
maximum median, the calibrated threshold, and the verification status.

| Domain | Scenario | Variant | Primary Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | :---: |
| streaming | `stream-120k` | `coalesced` | `totalCompletionMs` | 1,814.5 | 2,141.9 | 2,141.9 | 3,262.85 | OK |
| streaming | `stream-120k` | `sequential` | `totalCompletionMs` | 2,022.2 | 2,410.1 | 2,410.1 | 3,665.15 | OK |
| streaming | `stream-1m` | `coalesced` | `totalCompletionMs` | 4,179.6 | 5,197.3 | 5,197.3 | 7,845.95 | OK |
| streaming | `stream-1m` | `sequential` | `totalCompletionMs` | 4,149.5 | 5,496.2 | 5,496.2 | 8,294.3 | OK |
| history | `history-65m` | `coalesced` | `firstPageMs` | 11,656.5 | 14,077.9 | 14,077.9 | 21,166.85 | OK |
| history | `history-65m` | `sequential` | `firstPageMs` | 14,638.2 | 14,364.3 | 14,638.2 | 22,007.3 | OK |
| concurrency | `sessions-1` | `coalesced` | `totalCompletionMs` | 3,858.5 | 4,265 | 4,265 | 6,447.5 | OK |
| concurrency | `sessions-1` | `sequential` | `totalCompletionMs` | 3,888.5 | 4,259.8 | 4,259.8 | 6,439.7 | OK |
| concurrency | `sessions-4` | `coalesced` | `totalCompletionMs` | 7,734.6 | 9,859.3 | 9,859.3 | 14,838.95 | OK |
| concurrency | `sessions-4` | `sequential` | `totalCompletionMs` | 7,786.9 | 10,498.7 | 10,498.7 | 15,798.05 | OK |
| content | `content-roundtrip` | `coalesced` | `roundTripMs` | 489.6 | 510.3 | 510.3 | 815.45 | OK |
| content | `content-roundtrip` | `sequential` | `roundTripMs` | 496.8 | 522.1 | 522.1 | 833.15 | OK |
| recovery | `recovery-gateway-restart` | `coalesced` | `gatewayRestartMs` | 788 | 1,115 | 1,115 | 1,722.5 | OK |
| recovery | `recovery-gateway-restart` | `sequential` | `gatewayRestartMs` | 791 | 1,116 | 1,116 | 1,724 | OK |
| recovery | `recovery-pi-crash` | `coalesced` | `recoveryMs` | 1,392 | 1,273 | 1,392 | 2,138 | OK |
| recovery | `recovery-pi-crash` | `sequential` | `recoveryMs` | 1,393 | 1,371 | 1,393 | 2,139.5 | OK |
| recovery | `recovery-replay-gap` | `coalesced` | `recoveryMs` | 984.3 | 991.2 | 991.2 | 1,536.8 | OK |
| recovery | `recovery-replay-gap` | `sequential` | `recoveryMs` | 990.4 | 986.2 | 990.4 | 1,535.6 | OK |
| recovery | `recovery-session-rekey` | `coalesced` | `rekeyMs` | 538 | 666 | 666 | 1,049 | OK |
| recovery | `recovery-session-rekey` | `sequential` | `rekeyMs` | 637 | 694 | 694 | 1,091 | OK |
| recovery | `recovery-websocket-disconnect` | `coalesced` | `recoveryMs` | 991.8 | 993.2 | 993.2 | 1,539.8 | OK |
| recovery | `recovery-websocket-disconnect` | `sequential` | `recoveryMs` | 992.7 | 905.3 | 992.7 | 1,539.05 | OK |

## Domain Details

### Streaming Domain

Evaluates long streaming throughput, chunk delivery, batching efficiency, and DOM settlement
for 120 KiB (`stream-120k`) and 1 MiB (`stream-1m`) payloads under both coalesced and sequential variants.

#### `streaming:stream-120k:coalesced`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `deltaCount` | 480 | 480 | 480 | 770 | OK |
| `inputToNextPaintMs` | 352.6 | 386.9 | 386.9 | 630.35 | OK |
| `inputToPublicationMs` | 336.6 | 371.1 | 371.1 | 606.65 | OK |
| `liveLongTaskMaxMs` | 0 | 0 | 0 | 50 | OK |
| `liveLongTasksOver50Ms` | 0 | 0 | 0 | 50 | OK |
| `publicationBatches` | 19 | 14 | 19 | 78.5 | OK |
| `publicationRatio` | 0.04 | 0.03 | 0.04 | 50.06 | OK |
| `settlementMs` | 592.3 | 651.9 | 651.9 | 1,027.85 | OK |
| `streamDurationMs` | 1,252.6 | 1,490 | 1,490 | 2,285 | OK |
| `structuralDomTransitionMs` | 492.3 | 509.6 | 509.6 | 814.4 | OK |
| `totalCompletionMs` | 1,814.5 | 2,141.9 | 2,141.9 | 3,262.85 | OK |
| `turnNodes` | 0 | 0 | 0 | 50 | OK |

#### `streaming:stream-120k:sequential`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `deltaCount` | 480 | 480 | 480 | 770 | OK |
| `inputToNextPaintMs` | 357.2 | 361 | 361 | 591.5 | OK |
| `inputToPublicationMs` | 346.5 | 350.8 | 350.8 | 576.2 | OK |
| `liveLongTaskMaxMs` | 0 | 0 | 0 | 50 | OK |
| `liveLongTasksOver50Ms` | 0 | 0 | 0 | 50 | OK |
| `publicationBatches` | 480 | 480 | 480 | 770 | OK |
| `publicationRatio` | 1 | 1 | 1 | 51.5 | OK |
| `settlementMs` | 586.2 | 638.8 | 638.8 | 1,008.2 | OK |
| `streamDurationMs` | 1,436 | 1,771.3 | 1,771.3 | 2,706.95 | OK |
| `structuralDomTransitionMs` | 473.2 | 503.7 | 503.7 | 805.55 | OK |
| `totalCompletionMs` | 2,022.2 | 2,410.1 | 2,410.1 | 3,665.15 | OK |
| `turnNodes` | 0 | 0 | 0 | 50 | OK |

#### `streaming:stream-1m:coalesced`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `deltaCount` | 256 | 256 | 256 | 434 | OK |
| `inputToNextPaintMs` | 348.9 | 360.6 | 360.6 | 590.9 | OK |
| `inputToPublicationMs` | 333.3 | 345.6 | 345.6 | 568.4 | OK |
| `liveLongTaskMaxMs` | 0 | 0 | 0 | 50 | OK |
| `liveLongTasksOver50Ms` | 0 | 0 | 0 | 50 | OK |
| `publicationBatches` | 52 | 47 | 52 | 128 | OK |
| `publicationRatio` | 0.2 | 0.18 | 0.2 | 50.3 | OK |
| `settlementMs` | 1,606.5 | 2,085.3 | 2,085.3 | 3,177.95 | OK |
| `streamDurationMs` | 2,633.6 | 3,102.8 | 3,102.8 | 4,704.2 | OK |
| `structuralDomTransitionMs` | 1,304 | 1,717.3 | 1,717.3 | 2,625.95 | OK |
| `totalCompletionMs` | 4,179.6 | 5,197.3 | 5,197.3 | 7,845.95 | OK |
| `turnNodes` | 0 | 0 | 0 | 50 | OK |

#### `streaming:stream-1m:sequential`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `deltaCount` | 256 | 256 | 256 | 434 | OK |
| `inputToNextPaintMs` | 331.8 | 345 | 345 | 567.5 | OK |
| `inputToPublicationMs` | 324.5 | 329.3 | 329.3 | 543.95 | OK |
| `liveLongTaskMaxMs` | 0 | 0 | 0 | 50 | OK |
| `liveLongTasksOver50Ms` | 0 | 0 | 0 | 50 | OK |
| `publicationBatches` | 257 | 259 | 259 | 438.5 | OK |
| `publicationRatio` | 1 | 1.01 | 1.01 | 51.52 | OK |
| `settlementMs` | 1,493.8 | 2,104.7 | 2,104.7 | 3,207.05 | OK |
| `streamDurationMs` | 2,655.7 | 3,438.7 | 3,438.7 | 5,208.05 | OK |
| `structuralDomTransitionMs` | 1,291.6 | 1,718.5 | 1,718.5 | 2,627.75 | OK |
| `totalCompletionMs` | 4,149.5 | 5,496.2 | 5,496.2 | 8,294.3 | OK |
| `turnNodes` | 0 | 0 | 0 | 50 | OK |

### History Domain

Evaluates initial page loading, virtualized projection, heap memory delta, and pagination
over a large 65 MiB native JSONL session history (`history-65m`).

#### `history:history-65m:coalesced`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `firstPageMs` | 11,656.5 | 14,077.9 | 14,077.9 | 21,166.85 | OK |
| `heapDeltaBytes` | 212,161,238 | 306,561,535 | 306,561,535 | 465,085,182.5 | OK |
| `mountedTurnNodes` | 64 | 64 | 64 | 146 | OK |
| `nextPageMs` | 11,515.5 | 14,857.8 | 14,857.8 | 22,336.7 | OK |
| `sourceBytes` | 68,157,440 | 68,157,440 | 68,157,440 | 107,479,040 | OK |

#### `history:history-65m:sequential`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `firstPageMs` | 14,638.2 | 14,364.3 | 14,638.2 | 22,007.3 | OK |
| `heapDeltaBytes` | 614,216,425 | 416,462,090 | 614,216,425 | 926,567,517.5 | OK |
| `mountedTurnNodes` | 64 | 64 | 64 | 146 | OK |
| `nextPageMs` | 11,576.7 | 14,971.8 | 14,971.8 | 22,507.7 | OK |
| `sourceBytes` | 68,157,440 | 68,157,440 | 68,157,440 | 107,479,040 | OK |

### Concurrency Domain

Evaluates multi-session event ingestion, browser projection fairness, background session throughput,
and completion skew across single (`sessions-1`) and 4 concurrent active sessions (`sessions-4`).

#### `concurrency:sessions-1:coalesced`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `aggregateDeltaPerSecond` | 87.72 | 86.36 | 87.72 | 181.58 | OK |
| `backgroundIngestCheckpointDeficit` | 0 | 0 | 0 | 50 | OK |
| `browserFrameArrivalGapMs` | 50.2 | 50.1 | 50.2 | 125.3 | OK |
| `browserProjectionCheckpointDeficit` | 0 | 0 | 0 | 50 | OK |
| `browserProjectionLagMs` | 152 | 351.5 | 351.5 | 577.25 | OK |
| `completionSkewMs` | 0 | 0 | 0 | 50 | OK |
| `durationSkewMs` | 0 | 0 | 0 | 50 | OK |
| `inputToNextPaintMs` | 508 | 693.7 | 693.7 | 1,090.55 | OK |
| `inputToPublicationMs` | 492 | 678.5 | 678.5 | 1,067.75 | OK |
| `liveLongTaskMaxMs` | 0 | 0 | 0 | 50 | OK |
| `liveLongTasksOver50Ms` | 0 | 0 | 0 | 50 | OK |
| `producerProgressGapMs` | 251 | 250 | 251 | 426.5 | OK |
| `publicationBatches` | 147 | 137 | 147 | 270.5 | OK |
| `settlementMs` | 524.7 | 596.4 | 596.4 | 944.6 | OK |
| `streamDurationMs` | 3,333.8 | 3,676.9 | 3,676.9 | 5,565.35 | OK |
| `totalCompletionMs` | 3,858.5 | 4,265 | 4,265 | 6,447.5 | OK |
| `turnNodes` | 3 | 3 | 3 | 54.5 | OK |

#### `concurrency:sessions-1:sequential`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `aggregateDeltaPerSecond` | 87.88 | 87.5 | 87.88 | 181.82 | OK |
| `backgroundIngestCheckpointDeficit` | 0 | 0 | 0 | 50 | OK |
| `browserFrameArrivalGapMs` | 50.1 | 50.1 | 50.1 | 125.15 | OK |
| `browserProjectionCheckpointDeficit` | 0 | 0 | 0 | 50 | OK |
| `browserProjectionLagMs` | 185.7 | 282.3 | 282.3 | 473.45 | OK |
| `completionSkewMs` | 0 | 0 | 0 | 50 | OK |
| `durationSkewMs` | 0 | 0 | 0 | 50 | OK |
| `inputToNextPaintMs` | 492 | 513.7 | 513.7 | 820.55 | OK |
| `inputToPublicationMs` | 487.3 | 507.6 | 507.6 | 811.4 | OK |
| `liveLongTaskMaxMs` | 0 | 0 | 0 | 50 | OK |
| `liveLongTasksOver50Ms` | 0 | 0 | 0 | 50 | OK |
| `producerProgressGapMs` | 250 | 250 | 250 | 425 | OK |
| `publicationBatches` | 240 | 240 | 240 | 410 | OK |
| `settlementMs` | 528.4 | 602 | 602 | 953 | OK |
| `streamDurationMs` | 3,360.1 | 3,628.4 | 3,628.4 | 5,492.6 | OK |
| `totalCompletionMs` | 3,888.5 | 4,259.8 | 4,259.8 | 6,439.7 | OK |
| `turnNodes` | 3 | 3 | 3 | 54.5 | OK |

#### `concurrency:sessions-4:coalesced`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `aggregateDeltaPerSecond` | 345.57 | 342.98 | 345.57 | 568.36 | OK |
| `backgroundIngestCheckpointDeficit` | 0 | 0 | 0 | 50 | OK |
| `browserFrameArrivalGapMs` | 191 | 217.3 | 217.3 | 375.95 | OK |
| `browserProjectionCheckpointDeficit` | 0 | 0 | 0 | 50 | OK |
| `browserProjectionLagMs` | 1,812.9 | 3,064.7 | 3,064.7 | 4,647.05 | OK |
| `completionSkewMs` | 26 | 27 | 27 | 90.5 | OK |
| `durationSkewMs` | 12 | 14 | 14 | 71 | OK |
| `inputToNextPaintMs` | 1,698.1 | 2,155 | 2,155 | 3,282.5 | OK |
| `inputToPublicationMs` | 1,682.2 | 2,139.3 | 2,139.3 | 3,258.95 | OK |
| `liveLongTaskMaxMs` | 168 | 200 | 200 | 350 | OK |
| `liveLongTasksOver50Ms` | 12 | 12 | 12 | 68 | OK |
| `producerProgressGapMs` | 251 | 251 | 251 | 426.5 | OK |
| `publicationBatches` | 115 | 92 | 115 | 222.5 | OK |
| `settlementMs` | 1,727.3 | 2,041.3 | 2,041.3 | 3,111.95 | OK |
| `streamDurationMs` | 6,007.3 | 7,818 | 7,818 | 11,777 | OK |
| `totalCompletionMs` | 7,734.6 | 9,859.3 | 9,859.3 | 14,838.95 | OK |
| `turnNodes` | 3 | 3 | 3 | 54.5 | OK |

#### `concurrency:sessions-4:sequential`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `aggregateDeltaPerSecond` | 344.58 | 343.35 | 344.58 | 566.87 | OK |
| `backgroundIngestCheckpointDeficit` | 0 | 0 | 0 | 50 | OK |
| `browserFrameArrivalGapMs` | 168.6 | 263.6 | 263.6 | 445.4 | OK |
| `browserProjectionCheckpointDeficit` | 0 | 0 | 0 | 50 | OK |
| `browserProjectionLagMs` | 1,710.7 | 3,360 | 3,360 | 5,090 | OK |
| `completionSkewMs` | 35 | 20 | 35 | 102.5 | OK |
| `durationSkewMs` | 24 | 9 | 24 | 86 | OK |
| `inputToNextPaintMs` | 1,702.8 | 2,225.8 | 2,225.8 | 3,388.7 | OK |
| `inputToPublicationMs` | 1,693.2 | 2,218.7 | 2,218.7 | 3,378.05 | OK |
| `liveLongTaskMaxMs` | 161 | 233 | 233 | 399.5 | OK |
| `liveLongTasksOver50Ms` | 12 | 12 | 12 | 68 | OK |
| `producerProgressGapMs` | 251 | 251 | 251 | 426.5 | OK |
| `publicationBatches` | 248 | 247 | 248 | 422 | OK |
| `settlementMs` | 1,696.3 | 2,224.6 | 2,224.6 | 3,386.9 | OK |
| `streamDurationMs` | 6,090.6 | 8,274.1 | 8,274.1 | 12,461.15 | OK |
| `totalCompletionMs` | 7,786.9 | 10,498.7 | 10,498.7 | 15,798.05 | OK |
| `turnNodes` | 3 | 3 | 3 | 54.5 | OK |

### Content Domain

Evaluates large typed attachment transfer, WebSocket frame budget enforcement, and roundtrip latency
under authenticated loopback transport (`content-roundtrip`).

#### `content:content-roundtrip:coalesced`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `heapDeltaBytes` | 12,107,635 | 1,293,338 | 12,107,635 | 23,404,332.5 | OK |
| `inputBase64Chars` | 1,493,336 | 1,493,336 | 1,493,336 | 2,240,054 | OK |
| `maxReceivedFrameBytes` | 992 | 992 | 992 | 5,244,368 | OK |
| `maxSentFrameBytes` | 1,493,655 | 1,493,655 | 1,493,655 | 7,483,362.5 | OK |
| `roundTripMs` | 489.6 | 510.3 | 510.3 | 815.45 | OK |
| `selectionMs` | 254.1 | 357.2 | 357.2 | 585.8 | OK |

#### `content:content-roundtrip:sequential`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `heapDeltaBytes` | -12,268,167 | 1,256,834 | 1,256,834 | 7,128,131 | OK |
| `inputBase64Chars` | 1,493,336 | 1,493,336 | 1,493,336 | 2,240,054 | OK |
| `maxReceivedFrameBytes` | 992 | 992 | 992 | 5,244,368 | OK |
| `maxSentFrameBytes` | 1,493,655 | 1,493,655 | 1,493,655 | 7,483,362.5 | OK |
| `roundTripMs` | 496.8 | 522.1 | 522.1 | 833.15 | OK |
| `selectionMs` | 295.8 | 299.9 | 299.9 | 499.85 | OK |

### Recovery Domain

Evaluates fault recovery latency and state restoration under 5 simulated fault conditions:
gateway restart, supervisor process crash, sequence gap resynchronization, session rekeying, and WebSocket disconnection.

#### `recovery:recovery-gateway-restart:coalesced`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `activeGateways` | 1 | 1 | 1 | 51.5 | OK |
| `baselineFrames` | 98 | 98 | 98 | 197 | OK |
| `gatewayRestartMs` | 788 | 1,115 | 1,115 | 1,722.5 | OK |
| `gatewayStarts` | 1 | 1 | 1 | 51.5 | OK |
| `rootEntryCount` | 6 | 6 | 6 | 59 | OK |

#### `recovery:recovery-gateway-restart:sequential`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `activeGateways` | 1 | 1 | 1 | 51.5 | OK |
| `baselineFrames` | 98 | 98 | 98 | 197 | OK |
| `gatewayRestartMs` | 791 | 1,116 | 1,116 | 1,724 | OK |
| `gatewayStarts` | 1 | 1 | 1 | 51.5 | OK |
| `rootEntryCount` | 6 | 6 | 6 | 59 | OK |

#### `recovery:recovery-pi-crash:coalesced`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `processRestartMs` | 558 | 569 | 569 | 903.5 | OK |
| `processStarts` | 1 | 1 | 1 | 51.5 | OK |
| `recoveryMs` | 1,392 | 1,273 | 1,392 | 2,138 | OK |

#### `recovery:recovery-pi-crash:sequential`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `processRestartMs` | 557 | 564 | 564 | 896 | OK |
| `processStarts` | 1 | 1 | 1 | 51.5 | OK |
| `recoveryMs` | 1,393 | 1,371 | 1,393 | 2,139.5 | OK |

#### `recovery:recovery-replay-gap:coalesced`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `gapResyncFrames` | 1 | 1 | 1 | 51.5 | OK |
| `reconnectedSockets` | 1 | 1 | 1 | 51.5 | OK |
| `recoveryMs` | 984.3 | 991.2 | 991.2 | 1,536.8 | OK |

#### `recovery:recovery-replay-gap:sequential`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `gapResyncFrames` | 1 | 1 | 1 | 51.5 | OK |
| `reconnectedSockets` | 1 | 1 | 1 | 51.5 | OK |
| `recoveryMs` | 990.4 | 986.2 | 990.4 | 1,535.6 | OK |

#### `recovery:recovery-session-rekey:coalesced`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `childGeneration` | 2 | 2 | 2 | 53 | OK |
| `rekeyFrames` | 1 | 1 | 1 | 51.5 | OK |
| `rekeyMs` | 538 | 666 | 666 | 1,049 | OK |

#### `recovery:recovery-session-rekey:sequential`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `childGeneration` | 2 | 2 | 2 | 53 | OK |
| `rekeyFrames` | 1 | 1 | 1 | 51.5 | OK |
| `rekeyMs` | 637 | 694 | 694 | 1,091 | OK |

#### `recovery:recovery-websocket-disconnect:coalesced`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `reconnectedSockets` | 1 | 1 | 1 | 51.5 | OK |
| `recoveryMs` | 991.8 | 993.2 | 993.2 | 1,539.8 | OK |
| `replayFrames` | 12 | 12 | 12 | 68 | OK |

#### `recovery:recovery-websocket-disconnect:sequential`

| Metric | Run 1 Median | Run 2 Median | Max Median | Calibrated Threshold | Status |
| :--- | ---: | ---: | ---: | ---: | :---: |
| `reconnectedSockets` | 1 | 1 | 1 | 51.5 | OK |
| `recoveryMs` | 992.7 | 905.3 | 992.7 | 1,539.05 | OK |
| `replayFrames` | 12 | 12 | 12 | 68 | OK |

## Current streaming observer semantics

Suite version 4 retains the streaming measurement contract introduced in suite version 3
and keeps artifact schema version 2.
The historical tables above and checked-in calibration file retain their original names and values;
they are not current-suite calibration. Comparisons reject unsupported suite versions and changed
producer hashes. Current suite-5 references are registered separately in `tests/e2e/benchmarks/references.json`.

| Current metric | Exact observation boundary |
| --- | --- |
| `automationStartToFirstStreamingDomMs` | Browser `performance.now()` at measurement start, before Playwright fill/click, to the first MutationObserver callback affecting non-empty streaming DOM |
| `automationStartToFirstStreamingRafMs` | The same automation start to the first rAF callback scheduled after that DOM observation; this runs before rendering and does not measure pixel paint |
| `streamingDomMutationBatches` | MutationObserver callback batches affecting the live streaming element; excludes unrelated DOM updates, and is neither store publications nor React commits |
| `streamingDomMutationPerDeltaRatio` | Those DOM callback batches divided by the fixture's emitted delta count; not a publication/coalescing ratio |
| `turnNodes` | All mounted `[data-turn-id]` roots in the document, including the current turn root itself |

The two automation-start timings include fill/click dispatch, fixture pacing, transport and rendering
work. They are not user-input latency. `streamDurationMs` ends when automation observes stream end;
`settlementMs`, `structuralDomTransitionMs`, and `totalCompletionMs` include assertion/polling and
callback scheduling overhead at their recorded endpoints. No metric here certifies actual paint,
React commit count, or store publication latency.

Streaming observations must contain positive mounted-turn, streaming-DOM-batch and fixture-delta
counts, including warmups. The independent validator derives that correctness claim from raw facts.
The 64-turn upper bound applies to every trial, including warmups, as a hard correctness condition;
zero is no longer accepted as bounded evidence.
Timing budgets remain diagnostic and have not been recalibrated by this change.

## Disconnect evidence boundary

Suite version 4 replaces the flattened disconnect replay oracle with per-connection sequence
segments and the actual reconnect subscription cursor. The controlled experiment receives the
first text delta on the old socket but closes it before forwarding that callback. The new socket
replays from the retained cursor. Both publication variants use the same instrumentation.

A benchmark-build-only observer records ordered bus delivery and transport `lastSeq`/`projectedSeq`
high watermarks while this trial is armed. Bus delivery alone is not successful admission, and
projection confirmation is not a per-event reducer execution receipt. The validator combines these
facts to check observable admission uniqueness and confirmation coverage. Before forwarding the
assistant `message_end`, the test checks the exact streaming reply so authoritative final text cannot
hide repeated appends. This does not exclude arbitrary hidden duplicate reducer execution.

The bounded recorder retains at most 512 scalar rows without overwriting. Missing start/end,
active reset, overflow, identity changes, resync, and late callbacks invalidate this pure-disconnect
experiment. Snapshot and rekey scenarios retain their separate existing barrier checks. Timing in
this experiment is instrumented recovery timing, including automation, callback gates and content
assertions; it is not uninstrumented reconnect latency.

Historical artifacts remain unchanged and incompatible. The unresolved historical failure and its
investigation are recorded in [Issue #28](https://github.com/leon-zym/pi-agent-web/issues/28#issuecomment-5579565003)
and [PR #90](https://github.com/leon-zym/pi-agent-web/pull/90); this experiment does not retrospectively
clear that failed result.

## Reproduction Guide

To run the representative benchmark suite locally:

```bash
pnpm bench:representative
```

This executes the same deterministic matrix locally and on Actions, writing artifacts under
`test-results/performance/<run-id>/`. Preserve every run, including failed raw artifacts; do not
select the best run as a reference.

Compare two complete runs with their sibling `manifest.json` and `environment.json` files:

```bash
node scripts/compare-benchmark-baseline.mjs test-results/performance/<target> --baseline test-results/performance/<reference>
```

The comparator prints Markdown to stdout (redirect it to save a report). It checks non-empty,
complete scenario and metric evidence, measured summaries, recorded correctness outcomes, and
manifest/environment hashes. It supplements the runner's independent raw-artifact validator; it
does not replace that validator or certify raw observations independently.

- `INVALID` (exit 1): missing, malformed, incomplete or failed evidence; no green comparison.
- `INCOMPATIBLE` (exit 2): valid evidence cannot share a budget. No thresholds are applied.
- `REGRESSION` (exit 0): compatible diagnostic metrics exceed the comparison policy.
- `OK` (exit 0): compatible diagnostic metrics stay within that policy.

Compatibility requires matching OS/kernel/architecture, exact CPU model and logical count,
resource quota and memory, image, Node/pnpm/Playwright/Chromium, suite/tier, fixture and matrix
hashes, lockfile, seed, warmup/sample counts, and scenario parameters. Commit and production build
hashes may differ because those are the subject of the comparison. All trials must have canonical counts, indices, warmup flags, finite metrics, and successful
recorded correctness; summary statistics use measured trials only. Darwin
`quota.cpu="unavailable"` is interpreted as inapplicable because the producer only reads Linux
cgroup CPU quotas; missing Darwin values and unknown Linux quotas remain incompatible.
A shared `ubuntu-latest` label
or reference-profile name does not make different CPUs compatible. For local runs, set `PI_WEB_BENCHMARK_IMAGE` to a stable label for the OS installation
(for example, `local-host-v1`) on both invocations; an unspecified image remains incompatible.
Linux quota collection resolves the process's fully visible cgroup v2 hierarchy and checks ancestor
CPU and memory limits. Unsupported v1/hybrid or hidden hierarchies, missing constraints and read
errors remain `unavailable`; they do not imply unlimited resources. Sanitized probe reasons and
values are retained in `logs/quota.json`. Unknown memory quota, like unknown CPU quota, prevents
comparison. No private cgroup paths are recorded.
Downloaded Actions artifacts can be compared with the same command when their metadata matches.
Local same-host diagnostics and Actions reference runs use one suite; neither may borrow another platform's budgets.

The minimal diagnostic policy uses the reference median: higher-is-better throughput has a lower
bound of median / 1.5; lower-is-better metrics have an upper bound of median + abs(median) * 0.5
plus a unit-specific floor (50 ms, 5 MiB, or zero for ratios/counts). This is an explicit diagnostic
policy, not newly calibrated variance evidence. Existing hard correctness metrics remain governed
by the formal validator and are excluded from relative timing budgets. Generation identities and
fixed workload counters (`childGeneration`, `deltaCount`, `inputBase64Chars`, `sourceBytes`)
have no performance direction and are also excluded.

All numerical tables above and `baselines/reference-linux-x64.json` retain their historical
2026-09-06 semantics, including the old common floor and pooled CPU models. That file is
`INCOMPATIBLE` with the new comparator; it has not been silently recalibrated. Accepted suite-5
references are registered separately; remaining coverage and delivery work stays in #28.

### Manual representative calibration collection

The existing manual performance workflow defaults to stress. After approving a sampling window,
select `representative-calibration` to collect three complete representative bundles on one Actions
VM, in fixed order: `reference-1`, `reference-2`, then `holdout`:

```bash
gh workflow run performance-stress.yml --ref main -f suite=representative-calibration
```

Freeze and record the intended source revision before dispatch. The job has a 60-minute limit;
collection has a 50-minute limit to leave time for evidence upload. Ordinary PR CI still runs the
representative suite once, and the manual stress selection retains its 180-minute limit.

The job checks Linux quota availability before building. Each completed run is compared against
reference-1 (including its self-check); holdout is also compared against reference-2. Invalid or
incompatible evidence stops further collection. Diagnostic regressions remain observations and do
not cause retries. Both reference bundles are fixed before holdout; retain both comparisons rather
than selecting the faster reference or adjusting policy after seeing holdout.

The `performance-representative-calibration` artifact retains the representative tier, with IDs
`calibration-<Actions run ID>-<attempt>-<phase>`. Every bundle includes source/build hashes in
`manifest.json`, host/toolchain/quota in `environment.json` and `logs/quota.json`, raw trials in
`raw/`, and `benchmark.json`/`benchmark.md`. Comparison Markdown sits alongside the bundles.
Uploads run on failure too; infrastructure loss or a hard job termination can still prevent upload.
Keep all failed/incomplete attempts, and archive accepted raw evidence before the 30-day expiry.

Local repetitions use the same `pnpm bench:representative` command with distinct predetermined
`PI_WEB_BENCHMARK_RUN_ID` values and a stable `PI_WEB_BENCHMARK_IMAGE`, on one unchanged host.
Apply the same ordering and comparison rules. Never pool local and Actions absolute measurements.
Collecting three bundles does not itself establish calibrated budgets: review repeatability and
holdout observations separately. Strict budget enforcement remains separate from this entry point.

For explicit long-running stress benchmarking:

```bash
pnpm bench:stress
```

Note: The stress suite extends payload sizes and concurrency levels (e.g. 8 concurrent sessions with 1 MiB turns).
Stress runs are executed only on explicit request or manual CI and are not required for regular release verification.

## Known Coverage Gaps

As defined in `tests/e2e/benchmarks/matrix.json`, the Phase 1 representative baseline has the following 6 declared coverage gaps:

1. A deliberately slow raw WebSocket client and concurrent history/command fairness are not yet benchmarked.
2. Generic typed content-root references are covered by the default Browser gate but are not benchmarked as a separate performance scenario; this suite measures production attachment refs.
3. Browser-triggered history cancellation and post-cancel process/heap release are not yet measured; the server cancellation contract is covered separately.
4. Stress concurrency uses synchronized repeated finite 1 MiB turns and reports actual arrival rate; it does not yet certify an uninterrupted 60 second 1000 delta/s arrival rate.
5. The deterministic Pi fixture proves repeatable protocol behavior, not real-provider or heterogeneous reference-host performance.
6. Multiple Browser clients sharing the same Gateway and adversarial socket backpressure remain outside Phase 1.
