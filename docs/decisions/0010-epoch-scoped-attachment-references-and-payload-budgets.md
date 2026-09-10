# ADR 0010: Epoch-scoped attachment references and payload budgets

- Status: Accepted; Browser/Gateway activation wording partly superseded by ADRs 0013 and 0015
- Date: 2026-08-27
- Amended: 2026-08-28

## Context

Browser commands, Pi JSONL, normalized events, replay, snapshots, catch-up buffers, and outbound queues have
different byte ceilings, and those limits previously lived near their individual consumers. That made it
difficult to prove that a payload accepted at one boundary could be represented safely at the next boundary.

Inline image data also multiplies memory and wire costs. A Browser may retain the same attachment while a
command is retried, queued, or reconstructed after live Session recovery. Repeating the base64 payload is
wasteful, but making an attachment store durable would create a second source of Session truth beside Pi
JSONL. A content address without an incarnation fence would also survive a Gateway restart even though its
backing bytes may have disappeared.

Protocol minor 1 and minor 2 were an intermediate staged rollout of these decisions.
[Protocol](../protocol.md) defines the current single-version Gateway contract that replaces them.

## Decision

1. `@pi-agent-web/protocol` owns one canonical payload budget covering complete Browser command frames,
   command text, inline images, Pi JSONL frames, normalized event frames, replay frames and buffers,
   canonical snapshots, Gateway frames, queued and catch-up backlogs, and the derived attachment cache.
   Guards reject incomplete, extra, inherited, accessor, symbolic, or relationally inconsistent values.
   Adjacent producer ceilings must not exceed their consumer ceilings. A headroom, sized in
   `packages/protocol/src/payload-budget.ts`, separates the Pi JSONL frame ceiling from the normalized
   event ceiling and covers the maximum escaped Session identity, generation, sequence, and event wrapper;
   the replay frame ceiling must admit that complete normalized envelope.
2. An attachment reference is `{type:"attachment_ref",serverEpoch,sha256,mediaType,byteLength}`. The digest
   is lowercase SHA-256, the media type is a bounded canonical token, and the declared byte length is
   positive and within the negotiated blob ceiling. Consumers use one combined guard for the canonical
   shape, the exact negotiated blob ceiling, and the expected server epoch.
3. A reference is valid only within the exact `serverEpoch` that created it. A new Gateway epoch invalidates
   every old reference. The Gateway reconstructs needed attachments from Pi's authoritative state and
   externalizes them again under the new epoch; it does not repair an old reference by digest alone.
4. Attachment blobs and their index are a bounded, discardable derived cache. They are not Session history,
   do not establish persistence, and may be evicted at any time. Pi JSONL and Pi Runtime state remain
   authoritative.
5. Payload admission failures use the product-owned `payload_admission_error` shape: byte failures carry a
   stable code, boundary, byte limit, and actual byte count, and attachment cache item exhaustion uses
   `attachment_cache_item_limit_exceeded` with an item limit and actual item count, while capability and
   reference failures omit synthetic size evidence. A failed command response may carry this structure beside
   its human-readable error: the Pi adapter rejects it on raw Pi responses, and the bridge forwards it only
   from an actual internal `RpcError`.
6. Production Main constructs one activation from the canonical budget, current `serverEpoch`, and
   initialized `EpochContentStore`, supplying REST storage, the Pi externalization and hold services, and the
   trusted attachment context to the WebSocket bridge, which validates its epoch before advertising the
   capability.
7. The server-private Pi output path externalizes images only from reviewed raw message and entry slots.
   Command and event-specific raw guards run first, and the epoch-aware product guard runs after
   externalization. Tool details, Extension UI, opaque JSON, and nested lookalike objects never gain
   reference semantics.
8. Externalization is transactional per frame and returns an explicit provisional lease. PiProcess exposes
   attachment custody only through a synchronous two-phase decoded-delivery contract; timeout, abort, late,
   stale, orphaned, and ownerless outcomes release their lease. A Runtime generation owner adopts holds
   before refs enter projection, replay, or snapshots. Fork and clone use a bounded transition ledger until
   parent or child identity is verified.
9. Correlated response failure stays local only for evidenced blob or cache ceiling exhaustion and a
   PiProcess-owned caller abort or response deadline. Authoritative event failure, malformed provenance,
   raster or product incompatibility, unsafe store state, and rollback failure terminate the Runtime. Manual
   or capacity stop, recoverable crash, generation roll, rekey, overflow, and shutdown release reachable
   holds. A true nonrecoverable leader crash may retain a sealed final projection and its owner until
   explicit stop or shutdown.
10. The Browser freezes the trusted epoch and budget context from the verified server hello and applies it to
    every server frame and snapshot guard. Projection preserves `SessionImageContentDto` references and
    renders them through authenticated same-origin GET URLs without a fetch-to-Blob copy; a load failure
    requests one exact authoritative resync, while stale DOM failures are ignored until the new baseline
    commits. Structured admission errors use localized copy, a failed submit keeps its draft and images, and
    command images stay inline-only ingress.

## Consequences

The Browser protocol can distinguish a payload policy failure from a Pi command failure without parsing
localized text. The image path reuses attachment bytes during one Gateway lifetime without treating that
cache as recoverable storage.

A Gateway restart intentionally loses reference continuity. Recovery may re-externalize Pi-owned attachment
content at CPU and bandwidth cost, which beats accepting a reference whose backing bytes or authority cannot
be proven.

The negotiated table is a public compatibility contract. A server cannot advertise it while using larger
internal input limits or smaller downstream buffers. Changing a ceiling requires protocol review and tests
at every affected boundary.

## Rejected alternatives

- Make content-addressed references survive restarts: the digest does not prove that the new process owns
  the bytes or applied the same admission policy.
- Persist an attachment database: it duplicates Pi content and adds authority outside Pi JSONL.
- Raise all downstream limits to match the largest snapshot: this multiplies memory exposure and weakens
  queue and replay backpressure.
- Lower public inline image limits in this slice: that regresses users before references ship.
- Treat a missing cache blob as an empty attachment: this silently changes command meaning. The operation
  must fail with a structured admission error or be rebuilt from Pi authority.
