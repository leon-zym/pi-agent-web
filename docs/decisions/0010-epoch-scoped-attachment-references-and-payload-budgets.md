# ADR 0010: Epoch-scoped attachment references and payload budgets

- Status: Accepted
- Date: 2026-08-27

## Context

Browser commands, Pi JSONL, normalized events, replay, snapshots, catch-up buffers, and outbound
queues have different byte ceilings. Those limits previously lived near their individual consumers.
That made it difficult to prove that a payload accepted at one boundary could be represented safely
at the next boundary.

Inline image data also multiplies memory and wire costs. A Browser may retain the same attachment
while a command is retried, queued, or reconstructed after live Session recovery. Repeating the
base64 payload is wasteful, but making an attachment store durable would create a second source of
Session truth beside Pi JSONL. A content address without an incarnation fence would also survive a
Gateway restart even though its backing bytes may have disappeared.

## Decision

1. Gateway protocol minor 2 introduces the optional `payload.epoch_attachment_refs` capability.
   Protocol minor 1 keeps its previous hello shape. A peer at minor 1 must not send the capability
   or `payloadBudget` field.
2. A server that selects minor 2 advertises `payloadBudget` if and only if it advertises the new
   capability. Both peers validate the complete budget, the selected minor, the capability
   intersection, and compatible client and server frame ceilings before using attachment
   references. The capability is not part of either directional required-capability set during the
   staged rollout.
3. `@pi-agent-web/protocol` owns one canonical payload budget. It covers complete Browser command
   frames, command text, inline images, Pi JSONL frames, normalized event frames, replay frames and
   buffers, canonical snapshots, Gateway frames, queued and catch-up backlogs, and the derived
   attachment cache. Guards reject incomplete, extra, inherited, accessor, symbolic, or relationally
   inconsistent values. Adjacent producer ceilings must not exceed their consumer ceilings. A
   canonical 4 KiB headroom separates the Pi JSONL frame ceiling from the normalized event ceiling.
   It covers the maximum escaped Session identity, generation, sequence, and event wrapper. The
   replay frame ceiling must admit that complete normalized envelope.
4. An attachment reference is
   `{type:"attachment_ref",serverEpoch,sha256,mediaType,byteLength}`. The digest is lowercase SHA-256,
   the media type is a bounded canonical token, and the declared byte length is positive and within
   the negotiated blob ceiling. Consumers use one combined guard for the canonical shape, the exact
   negotiated blob ceiling, and the expected server epoch.
5. A reference is valid only within the exact `serverEpoch` that created it. A new Gateway epoch
   invalidates every old reference. The Gateway must reconstruct needed attachments from Pi's
   authoritative state and externalize them again under the new epoch. It must not repair an old
   reference by digest alone.
6. Attachment blobs and their index are a bounded, discardable derived cache. They are not Session
   history, do not establish persistence, and may be evicted at any time. Pi JSONL and Pi Runtime
   state remain authoritative.
7. Payload admission failures use the product-owned `payload_admission_error` shape. Byte failures
   carry a stable code, boundary, byte limit, and actual byte count. Attachment cache item exhaustion
   uses `attachment_cache_item_limit_exceeded` with an item limit and actual item count. Capability
   and attachment reference failures omit synthetic size evidence. A failed command response may
   carry this structure beside its human-readable error. The field is Gateway-owned: the Pi adapter
   rejects it on raw Pi responses, and the WebSocket bridge forwards it only from an actual internal
   `RpcError`.
8. The Gateway may advertise the capability only after every advertised boundary is enforced and
   stale references fail closed. Until then, peers continue using the minor 1 compatible inline
   payload path even when they can select protocol minor 2.
9. The server-private Pi output path externalizes images only from reviewed raw message and entry
   slots. Command/event-specific raw guards run first, and the epoch-aware product guard runs after
   externalization. Tool details, Extension UI, opaque JSON, and nested lookalike objects never gain
   reference semantics.
10. Externalization is transactional per frame and returns an explicit provisional lease. PiProcess
    exposes attachment custody only through a synchronous two-phase decoded-delivery contract;
    timeout, abort, late, stale, orphaned, and ownerless outcomes release their lease. A Runtime
    generation owner adopts holds before refs enter projection, replay, or snapshots. Fork/clone
    uses a bounded transition ledger until parent or child identity is verified.
11. Correlated response failure is local only for evidenced blob/cache ceiling exhaustion and a
    PiProcess-owned caller abort or response deadline. Authoritative event failure, malformed
    provenance, raster or product incompatibility, unsafe store state, and rollback failure terminate
    the Runtime. Manual or capacity stop, recoverable crash, generation roll, rekey, overflow, and
    shutdown release reachable holds. A true nonrecoverable leader crash may retain a sealed final
    projection and its owner until explicit stop or shutdown.
12. The production Main does not install the server-private externalizer or Runtime payload services.
    Gateway hello therefore does not advertise `payload.epoch_attachment_refs`, and the Browser
    continues to use inline images.

## Consequences

The Browser protocol can distinguish a payload policy failure from a Pi command failure without
parsing localized text. The server-private image path can reuse attachment bytes during one Gateway
lifetime without treating that cache as recoverable storage. Since Main leaves the path disabled,
these references are not part of the current Browser/Gateway runtime contract.

A Gateway restart intentionally loses reference continuity. Recovery may spend CPU and bandwidth to
externalize Pi-owned attachment content again. This is preferable to accepting a reference whose
backing bytes or authority cannot be proven.

The negotiated table is a public compatibility contract. A server cannot advertise it while using
larger internal input limits or smaller downstream buffers. Changing a ceiling requires protocol
review and tests at every affected boundary.

## Rejected alternatives

- Make content-addressed references valid across Gateway restarts: the digest does not prove that the
  new process owns the bytes or applied the same admission policy.
- Persist an attachment database: this duplicates Pi-owned Session content and adds migration,
  deletion, and recovery authority outside Pi JSONL.
- Raise all downstream limits to match the largest snapshot: this multiplies memory exposure and
  weakens queue and replay backpressure.
- Lower the existing public inline image limits in this slice: that would create an unrelated user
  regression before reference transport is available.
- Treat a missing cache blob as an empty attachment: this silently changes command meaning. The
  operation must fail with a structured admission error or be rebuilt from Pi authority.

## Verification

- Protocol tests cover minor 1 hello compatibility, minor 2 capability and complete-budget gating,
  negotiation frame relationships, strict canonical budget guards, epoch-scoped reference guards,
  and structured command admission errors.
- Store and route tests cover cache admission and eviction, stale-epoch rejection, exact-metadata
  holds, raster validation, fixed-memory duplicate PUT verification, download pins, lifecycle locks,
  and shutdown races.
- Adapter, PiProcess, projection, and Runtime tests cover raw provenance, image externalization,
  transactional rollback, decoded-delivery disposal, active generation ownership, compaction,
  rekey, transition cleanup, and stop/crash cleanup fences.
- Browser preprocessing tests cover decode failure and bounded inline image preparation. Production
  Browser tests remain on the inline path because Main does not install or advertise attachment refs.
