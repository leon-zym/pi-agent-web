# ADR 0011: Epoch-scoped typed content references

- Status: Accepted and activated; compatibility wording partly superseded by ADRs 0013 and 0015
- Date: 2026-08-28

[Protocol](../protocol.md) holds the current single-version contract; 1.2/1.3 below are historical.

## Context

ADR 0010's raster store binds one manifest media type to bytes identified by SHA-256. Generic UTF-8 content
has no such identity: the same bytes may be valid text and valid JSON, and the carrying field decides
interpretation. Large tool arguments, results, message details, and Extension payloads would otherwise be
copied through decoding, projection, replay, and snapshots, and replacing reference-shaped objects
recursively would let upstream data claim Gateway authority. The raster blob ceiling is too small for some
settled history, and chunking would add a second ordering protocol to every hold and recovery path.

## Decision

1. `EpochContentStore` remains the only derived content store, with an internal `utf8` namespace beside the
   raster namespace. Identity inside it is the exact `serverEpoch`, the SHA-256 of the stored raw UTF-8
   bytes, and the byte length.
2. A `utf8` manifest records storage facts only and binds no semantic media type; raster metadata stays in
   the raster namespace. Both namespaces share one lifecycle, cache ledger, hold set, and shutdown fence,
   and the namespace affects lookup and path derivation only.
3. The protocol uses one base UTF-8 content reference and three Gateway-owned wrappers:
   ```ts
   interface SessionUtf8ContentRefDto {
       type: "content_ref"; encoding: "utf-8"; serverEpoch: string; sha256: string;
       byteLength: number;
   }
   interface SessionExternalTextDto { type: "external_text"; ref: SessionUtf8ContentRefDto; }
   interface SessionInlineJsonDto { type: "inline_json"; value: JsonValue; }
   interface SessionExternalJsonDto { type: "external_json"; ref: SessionUtf8ContentRefDto; }
   ```
   A text slot takes its inline string or `SessionExternalTextDto`; every JSON root normalizes to
   `SessionInlineJsonDto` or `SessionExternalJsonDto`. No externalizable slot carries a bare JSON root,
   and the containing field reruns its guard after materialization; media type is a typed-slot concern.
4. External JSON identity covers the exact UTF-8 bytes emitted for that slot; canonicalization is never
   applied. Both wrappers pass the same bounded guard, so equal JSON may differ in digest without changing
   product semantics.
5. The externalizer uses a closed root-slot allowlist. Text slots are `TextContentDto.text` in reviewed
   tool-result, message, and entry paths, `BashExecutionMessage.output`, Extension `editor.prefill` and
   `set_editor_text.text`. JSON slots are `ToolCallContentDto.arguments`, tool execution `args`,
   `partialResult`, `result`, tool-result and custom-message `details`, Extension `setWidget.widgetLines`.
   The raw guard runs first, so a raw root resembling `inline_json`, `external_json`, or `content_ref`
   stays ordinary Pi data, and objects with those shapes below it are not traversed.
6. Everything else stays inline: nested JSON, assistant diagnostics, deferred and custom entry data,
   compaction details and results, streaming text, thinking, tool-call deltas, queue content, prompts,
   bare user and custom message strings, and Extension titles, prompts, options, notifications, and
   status text. Browser commands and Extension responses stay inline; no binary type, remote hosting,
   durable storage, or inline fallback.
7. Values below the generic-content threshold stay a string or `inline_json`; larger ones use
   `external_text` or `external_json` up to the blob ceiling, while raster images keep their own ceiling.
   Wrappers for the same bytes share one item and one hold. `packages/protocol/src/payload-budget.ts` owns
   the thresholds; a value beyond its ceiling fails admission instead of splitting.
8. Logical and wire bytes have separate accounting: a closed-slot walker counts inline text by UTF-8 byte
   length, external refs by `ref.byteLength`, and inline JSON by encoded length. Every occurrence counts,
   including repeated roots that share one physical hold, while the active-turn logical ceiling exceeds one
   admissible root and stays bounded.
9. A live event passes its raw JSONL frame, its normalized event frame, and its replay frame; history and
   snapshot roots pass their own raw and canonical forms. The normalized and replay ceilings add an envelope
   headroom to the raw frame ceiling and the replay frame admits the complete normalized envelope, while the
   raw history and snapshot ceiling exceeds one admissible generic root. Escaping can push a
   control-character-heavy root past the raw frame ceiling, and framing is never raised for that worst case.
   `packages/protocol/src/payload-budget.ts` owns every one of these values.
10. Generic retrieval is GET-only at `/api/v1/content/:serverEpoch/:sha256`, serving the `utf8` namespace;
    `/api/v1/attachments/:serverEpoch/:sha256` keeps the raster namespace. The typed wrapper, not an HTTP
    media type, controls Browser decoding.
11. Externalization is transactional per decoded frame, and each transfer takes one of two exclusive custody
    paths: the exact generation owner adopts it immediately, or an identity-transition ledger holds exclusive
    cleanup custody while the target generation is uncertain. The ledger adopts no holds and drains each
    transfer into the confirmed generation owner before the value reaches projection, replay, a snapshot, or
    a response; `releaseRemaining()` frees what it still owns when drain or transition fails. Responses and
    compactions are adopted before they resolve or commit, and timeout, abort, late, stale, orphaned,
    transition-failure, stop, and shutdown paths release holds through the same fences as raster attachments.
12. Correlated response failures stay local only for evidenced content-blob or shared-cache ceilings and a
    PiProcess-owned caller abort or deadline. Malformed UTF-8 or JSON, forged wrappers, field-guard failure,
    unsafe store state, rollback failure, uncertain ownership, and externalization failure terminate the
    Runtime. A missing content GET never yields an empty string, `null`, or empty object.
13. Browser projection keeps typed references. Tool and message content materializes on demand; an ordered
    Extension request materializes before its state or sequence barrier commits. Decoding is streaming, and
    the slot guard reruns after parsing. A 404, 410, decode failure, or guard failure reports one failure
    for the exact Session and generation and requests a cursorless resync, while stale identity and
    uncommitted-baseline failures leave the current channel alone.

## Consequences

Text and JSON share stored bytes without sharing interpretation: the store deduplicates the physical value
while the DTO field and wrapper keep product semantics explicit. The raster contract stays isolated from
generic UTF-8 identity, and both forms consume one cache and one ownership system. One generic blob may
occupy most of the shared cache, so a second large value can fail cache admission while the first stays
held. That is a bounded-resource result, not a reason to evict held content or split a value after
admission. Materialization moves work from WebSocket parsing to an authenticated GET, and components that do
not need the value retain the small reference.

## Rejected alternatives

- Keep media type as singleton manifest metadata: the first writer would set digest semantics.
- Include `text` or `json` in identity or a kind hash: duplicate bytes, labeled addresses.
- Split generic content into chunks: each value needs a second manifest, holds, and rollback.
- Raise raw JSONL framing to admit the worst-case escaped form of every generic root: this would multiply
  the parser and buffering boundary for an uncommon representation.
- Hash canonicalized JSON values: that adds a normalization contract and mismatched digests.
- Interpret references recursively: JSON meaning drifts and Pi output can forge authority.
- Advertise before full ownership: a peer could admit an undecodable reference.
- Add a second generic-content database or make references valid across Gateway restarts: either choice
  would create content authority outside Pi JSONL and the current Gateway epoch.
