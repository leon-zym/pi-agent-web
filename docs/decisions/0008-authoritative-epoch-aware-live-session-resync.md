# ADR 0008: Authoritative epoch-aware live Session resync

- Status: Accepted
- Date: 2026-08-26

## Context

Pi RPC `get_messages` returns the current branch's in-memory message list. While Pi is producing an
assistant message, thinking, running a tool, or waiting for Extension UI, that list does not contain all
live product state. The old Browser resync path combined the response with a separately sampled Gateway
`lastSeq`, rebuilt the conversation from the incomplete list, and discarded buffered events through that
sequence. A reload or replay gap could then lose a partial answer, interrupt a running tool, or reconstruct
conversation and Extension state at different waterlines.

Replay cursors used only `{generation, seq}`. A Gateway restart resets both values, so a cursor from the
previous process could match a new Runtime by accident.

This ADR supersedes the generation-only cursor and separate Extension UI baseline portions of
[ADR 0003](0003-session-channel-control-and-recovery.md). Its multiplexing, lease fencing, sequenced dialog
closure, and ordinary response barrier decisions remain in force.

## Decision

1. One Gateway startup creates one `serverEpoch`. Hello negotiation, Runtime identities, sequenced
   envelopes, responses, leases, rekeys, resync diagnostics, snapshots, replay keys, and replay cursors all
   use that value. A stream position is `{serverEpoch, sessionHandle, generation, seq}`.
2. Cursor validation checks epoch first, then handle and rekey identity, generation, and sequence range. A
   mismatch produces explicit resync. The Gateway does not infer or repair a cursor.
3. Each Runtime generation obtains a settled-message base at `baseSeq = 0` before publishing live events.
   Validated startup events are buffered and committed in order after the base exists. The Gateway keeps an
   ephemeral projection made from that base and an ordered product-domain event suffix, plus queue state,
   runtime phase, and pending blocking Extension requests. One bounded Runtime map is the snapshot authority
   for sticky Extension state. Replacement, clear, and capacity eviction publish semantic frames so live
   observers converge with the map. Pi JSONL remains the only durable Session truth. Buffered startup frames
   enter projection and replay first, then the complete wire snapshot passes admission before any of those
   frames are published. Admission failure crashes the generation and publishes none of them.
4. A live frame passes projection admission, allocates its sequence, appends replay, and publishes in one
   serialized boundary. Failed projection or budget admission leaves the projection waterline and replay
   unchanged and publishes nothing.
5. `session_snapshot` is an immutable projection at one `asOfSeq`. It includes the settled base, ordered
   product events through that waterline, queue state, runtime phase, pending blocking requests, and sticky
   Extension state. It excludes `notify`, the Controller Lease, and fencing tokens. The Browser atomically
   replaces Session-scoped authoritative state, then applies only a contiguous suffix with `seq > asOfSeq`.
6. `notify` is delivered once as a transient live effect. A replay range that omits a notification contains
   a sequence gap and must use snapshot resync. It cannot be presented as contiguous replay. A fresh
   exact-hot catch-up may separately journal notifications produced during its transaction for bounded,
   identity-scoped, exact-once Browser delivery. That journal is not part of the snapshot or projection
   waterline.
7. Command responses retain `barrierSeq`, and the Browser resolves them only after its projection reaches
   that barrier. `get_messages` carries no resync role and cannot advance the snapshot waterline.
8. Snapshot structure, depth, items, and serialized bytes are bounded. Overflow is a stable Runtime error
   that crashes the generation, stops Pi, and does not trigger automatic process restart. An explicit
   restart of a persisted Session replaces the overflowed Runtime and starts the next generation. Browser
   recovery uses bounded attempts with backoff and jitter, stops in a stable degraded state, and starts a
   new cursorless attempt only after explicit manual retry. Mutations and Extension responses remain
   disabled until the new baseline is authoritative.
9. Idle base compaction uses compare-and-swap only while the hot Runtime has no agent, compaction, awaiting
   start, queue, in-flight command, dialog, or transition blocker. It records a projection-owned token with
   the Runtime incarnation and `expectedAsOfSeq`, reads a new settled base, and commits only if identity,
   idle phase, owner, and waterline still match. A successful commit moves `baseSeq` to `asOfSeq` and clears
   the suffix. Before admitting `prompt`, `steer`, or `follow_up`, the Runtime waits for compaction when
   needed and rechecks that the suffix holds one bounded active-Turn budget. Raw product-event count and
   complete frame bytes each receive 50 percent of the configured live suffix ceiling. Capacity checking and
   pending reservation occur together in the serialized command-admission boundary, before Pi receives the
   command. The reservation becomes active when the Agent starts and is released on failure, cancellation,
   settlement, stop, or rekey.
10. Restoring a known Session after a hard reload uses this snapshot contract. Discovering which independent
    Session channels need that restoration after a new Browser connection uses the inventory and
    exact-observation contract in
    [ADR 0009](0009-authoritative-hot-runtime-inventory-and-browser-reconciliation.md). Inventory selection
    leaves snapshot contents, cursor validation, and waterline rules unchanged. Dormant history continues to
    use the existing Pi activation path.

## Consequences

A snapshot and its suffix describe one Runtime incarnation at one waterline. Text, thinking, running tools,
partial results, queue state, and blocking dialogs survive reload without relying on the timing of a Pi
response. Epoch changes, rekeys, generation changes, and replay gaps fail closed.

The Gateway owns more memory while a Runtime is hot, and snapshot overflow leaves the affected generation
terminal with the Browser degraded rather than guessing at an incomplete baseline. A new admissible
generation or a future chunked snapshot protocol is required before mutation can resume. The half-ceiling
active-Turn budget does not guarantee an arbitrary complete Turn: a Turn that exceeds either its raw event
or frame-byte budget fails with the same stable overflow. Rolling over a larger Turn remains a separate
design question.

## Rejected alternatives

- Combining `get_messages` with `lastSeq`: the two sample different waterlines during active work.
- Keeping or repairing `{generation, seq}` cursors: values collide after restart, and a repair discards events
  from another incarnation.
- Rebuilding conversation and Extension UI from separate snapshots: an intervening request or close event
  can leave the Browser with a dialog that does not match its conversation.
- Persisting the Gateway projection: this would create a second Session database beside Pi JSONL.
- Replaying notifications or sharing leases in snapshots: notifications duplicate side effects, and
  connection-local capabilities escape their fencing boundary.
- Retrying forever: permanent overflow or malformed snapshots would create reconnect and Toast loops without
  improving the baseline.
