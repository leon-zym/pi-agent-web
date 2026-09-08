# Performance Benchmark Report: Phase 1 Representative Baseline

## Overview

This document is the formal performance benchmark report for Issue #28 Phase 1 calibration.
It establishes the reference performance baseline profile (`linux-x64-gh-standard`) on
GitHub standard Linux runners, records two fresh provenance benchmark runs, documents the
calibration methodology separating deterministic correctness hard gates from host-sensitive
timing metrics, and presents the calibrated thresholds across all 22 representative scenario
and variant combinations.

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

Suite version 3 keeps artifact schema version 2 but changes the streaming measurement contract.
The historical tables above and checked-in calibration file retain their original names and values;
they are not suite-v3 calibration. Comparisons reject unsupported suite versions and changed
producer hashes. Fresh local/reference calibration remains pending under #28.

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
The retained 64-turn upper bound is still a hard gate; zero is no longer accepted as bounded evidence.
Timing budgets remain diagnostic and have not been recalibrated by this change.

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
`INCOMPATIBLE` with the new comparator; it has not been silently recalibrated. Fresh repeated
reference runs and measurement corrections are still required by #28 before new calibration claims.

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
