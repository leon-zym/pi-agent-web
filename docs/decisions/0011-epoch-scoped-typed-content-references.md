# ADR 0011: Epoch-scoped typed content references

- Status: Accepted
- Date: 2026-08-28

## Context

ADR 0010 introduced epoch-scoped references for raster images. The current attachment store keys a
blob by its SHA-256 digest and binds one media type in the manifest. That works for an admitted
raster representation because its media type is verified against the bytes. It does not define a
safe identity for generic UTF-8 content. The same bytes may be valid text and valid JSON, while the
field that carries the value determines how the Browser must interpret them.

Large tool arguments, partial results, results, and message details can otherwise be copied through
Pi decoding, Runtime projection, replay, snapshots, and WebSocket delivery. Extension editor and
widget payloads have the same problem. Recursively replacing objects that resemble references would
change opaque Pi data and let an upstream value claim Gateway authority.

The existing history contract also admits an individual settled text block up to 48 MiB. Keeping the
8 MiB image blob ceiling for generic content would make some currently valid history impossible to
externalize. Splitting one value into several attachment-sized chunks would add a second ordering and
atomicity protocol to every hold, download, materialization, and recovery path.

## Decision

1. `EpochContentStore` remains the only derived content store. It gains an internal `utf8` namespace
   beside the existing raster attachment namespace. Physical identity inside this namespace is the
   exact `serverEpoch`, SHA-256 of the stored raw UTF-8 bytes, and byte length. The namespace
   participates in store lookup and path derivation but is not exposed in the public reference. The
   digest remains the SHA-256 of the bytes alone. Text and JSON do not add a semantic discriminator
   to the digest.
2. A `utf8` manifest records only content-intrinsic storage facts: manifest version, publication
   state, namespace, epoch, raw-byte digest, and byte length. It does not bind `text/plain`,
   `application/json`, or another semantic media type. Raster admission metadata remains confined to
   the raster namespace. Both namespaces share the same store lifecycle lock, reservations, cache
   ledger, GC, holds, pins, and shutdown fence.
3. The protocol uses a base UTF-8 content reference and three Gateway-owned wrappers:

   ```ts
   interface SessionUtf8ContentRefDto {
       type: "content_ref";
       encoding: "utf-8";
       serverEpoch: string;
       sha256: string;
       byteLength: number;
   }

   interface SessionExternalTextDto {
       type: "external_text";
       ref: SessionUtf8ContentRefDto;
   }

   interface SessionInlineJsonDto {
       type: "inline_json";
       value: JsonValue;
   }

   interface SessionExternalJsonDto {
       type: "external_json";
       ref: SessionUtf8ContentRefDto;
   }
   ```

   A text slot accepts only its existing inline string or `SessionExternalTextDto`. Every JSON root
   is normalized after raw admission to either `SessionInlineJsonDto` or `SessionExternalJsonDto`;
   product DTOs never carry a bare JSON root in an externalizable slot. The wrapper selects inline
   JSON or referenced UTF-8 JSON bytes, while the containing field still owns the product meaning
   and runs its field-specific guard after materialization. Media type is therefore a typed-slot
   concern, not blob identity or singleton manifest metadata.
4. External JSON identity covers the exact UTF-8 bytes emitted for that slot. It does not use
   semantic JSON canonicalization. Both `inline_json.value` and the value encoded for
   `external_json` must pass the same bounded JSON guard. The encoder preserves the JSON data model,
   enforces depth, item, string, and encoded-byte ceilings, and streams bytes to the store without
   constructing a second complete binary copy. Materialization parses the bytes and reruns the guard
   for the original field. Two different serializations of equivalent JSON may have different
   digests without changing product semantics.
5. The externalizer uses a closed root-slot allowlist:
   - Text slots are string-form user or custom message content, `TextContentDto.text` in reviewed
     message and entry paths, Extension `editor.prefill`, and Extension `set_editor_text.text`.
   - JSON slots are `ToolCallContentDto.arguments`, tool execution `args`, `partialResult`, and
     `result`, tool-result or custom message `details`, custom-message entry `details`, and the whole
     Extension `setWidget.widgetLines` array.

   The same reviewed history responses and authoritative message or entry events used by the image
   externalizer carry these message slots. Tool execution events and supported Extension requests
   add their explicit root slots. The raw command or event guard runs before normalization. A raw
   JSON root that resembles `inline_json`, `external_json`, or `content_ref` is still ordinary Pi
   data and is placed inside `SessionInlineJsonDto.value`; it does not gain reference semantics.
   Objects with the same shapes below that root also remain ordinary JSON and are not traversed.
6. This decision does not externalize arbitrary nested JSON, assistant diagnostics, deferred data,
   custom entry data, compaction details or results, streaming text, thinking, or tool-call deltas,
   queue content, Bash responses, Extension titles, prompts, options, notifications, or status text.
   Browser-to-Gateway commands and Extension responses remain inline. It does not add a generic
   binary type, remote hosting, durable Session storage, or a per-connection inline fallback.
7. Text whose encoded UTF-8 byte length is strictly less than 256 KiB remains a string. A JSON root
   below the same threshold uses `inline_json`. Any allowlisted text or JSON value whose encoded byte
   length is at least 256 KiB uses `external_text` or `external_json`, up to a 48 MiB generic-content
   blob ceiling. Raster images retain their 8 MiB blob ceiling. Both internal namespaces share one
   64 MiB, 256-item cache; cache accounting counts physical store entries, so text and JSON wrappers
   for the same UTF-8 bytes share one item and one hold. The negotiated budget exposes the threshold
   and both blob ceilings. A value beyond its ceiling fails admission rather than being split into
   chunks.
8. Generic retrieval is GET-only at `/api/v1/content/:serverEpoch/:sha256`. The route selects the
   internal `utf8` namespace; `/api/v1/attachments/:serverEpoch/:sha256` continues to select the
   raster namespace. Text and JSON references with the same raw UTF-8 bytes therefore resolve to one
   generic store entry. The content route uses the same loopback, same-origin, bootstrap Cookie,
   Fetch Metadata, exact epoch, digest, pin, and cancellation checks as attachment retrieval. A
   successful response uses `application/octet-stream`, exact `Content-Length`, `Cache-Control:
   no-store`, `Cross-Origin-Resource-Policy: same-origin`, and `X-Content-Type-Options: nosniff`.
   `HEAD`, `Range`, uploads, redirects, and content sniffing are not supported. The typed wrapper,
   rather than an HTTP media type, controls Browser decoding.
9. Externalization remains transactional per decoded frame. The existing provisional lease,
   PiProcess two-phase delivery, generation owner, compaction transfer, and identity-transition
   ledger adopt namespaced holds before a reference enters projection, replay, or a snapshot. One
   frame holds each exact physical UTF-8 blob once even when several typed wrappers refer to it.
   Timeout, abort, late, stale, orphaned, transition failure, stop, and shutdown paths release holds
   through the same exact cleanup fences as raster attachments.
10. Correlated response failures remain local only for evidenced content-blob or shared-cache
    ceilings and PiProcess-owned caller abort or deadline. Malformed UTF-8 or JSON, forged wrappers,
    field-guard failure, unsafe manifest or path state, rollback failure, uncertain ownership, and
    every authoritative event or Extension externalization failure terminate the Runtime. A missing
    or stale content GET never materializes as an empty string, `null`, or empty object.
11. Browser projection retains typed references. Tool and message content may materialize on demand;
    an ordered Extension request materializes before its semantic state or sequence barrier is
    committed. The Browser uses bounded streaming UTF-8 decoding, parses JSON only for JSON wrappers,
    and reruns the slot guard. A 404, 410, decode failure, or guard failure reports one failure for
    the exact Session and generation and requests a cursorless authoritative resync. Stale identity
    or uncommitted-baseline failures do not affect the current channel.
12. Protocol version 1.3 adds `payload.epoch_content_refs`. The capability and its complete canonical
    budget become required in both directions only when the full vertical path is activated. Version
    1.3 peers then reject a missing capability or budget before Session subscription and do not
    materialize inline output for an older peer. Until that activation, production continues to
    advertise protocol version 1.2 and `payload.epoch_attachment_refs` only;
    `payload.epoch_content_refs` remains unadvertised.

## Activation boundary

The capability stays private through the first six stages. Each intermediate stage must preserve the
current protocol version 1.2 production behavior.

1. Record this decision and freeze the wrapper, slot, budget, and failure contracts.
2. Add strict version 1.3 DTO, budget, wrapper, context, and provenance guards without advertising the
   new capability.
3. Add the namespaced store identity, manifest, holds, and authenticated GET route under the existing
   `EpochContentStore` lifecycle.
4. Add streaming text and JSON encoding plus raw-slot JSON normalization and externalization, with
   the externalizer still absent from production activation.
5. Carry namespaced holds through PiProcess, Runtime ownership, projection, replay, snapshot,
   compaction, rekey, transition, and teardown paths.
6. Add Browser trusted-context guards, bounded materialization, tool and Extension consumers, and
   exact resync behavior while version 1.3 remains unavailable to production connections.
7. Atomically switch Main, Supervisor, Bridge, routes, Browser hello, and the canonical production
   budget to version 1.3. Advertise and require `payload.epoch_content_refs` only in the same change
   that passes the full integration and Browser gates and updates the current architecture, protocol,
   and development contracts.

## Consequences

Text and JSON can share stored bytes without sharing interpretation. The store can deduplicate the
physical value, while the DTO field and wrapper keep product semantics explicit. The existing raster
contract remains isolated from generic UTF-8 identity, and both forms consume one bounded cache and
one ownership system.

A single generic blob may occupy three quarters of the shared cache. A second large value can fail
cache admission while the first remains held. This is an explicit bounded-resource result, not a
reason to evict held content or split a value after admission. Correlated responses may report the
evidenced exhaustion locally; authoritative delivery remains fail closed.

Materialization moves some work from WebSocket parsing to authenticated GET and the final consumer.
JSON consumers may temporarily hold encoded text and the parsed value within the 48 MiB ceiling.
Components that do not need the value can retain the small reference instead of parsing it.

Protocol version 1.3 is an atomic compatibility boundary. Independently updated version 1.2 clients
and servers cannot guess the wrapper, budget, or materialization rules and will fail hello rather
than receive a mixed inline/reference stream.

## Rejected alternatives

- Keep media type as singleton manifest metadata: identical UTF-8 bytes used as text and JSON would
  conflict in a digest-keyed store, and the first writer could determine later consumer semantics.
- Include `text` or `json` in blob identity or use a domain-separated kind hash: this would duplicate
  identical bytes, fragment cache and hold accounting, and make a semantic label part of a raw-byte
  content address. The `utf8` namespace separates the validated byte representation from raster
  content without separating text from JSON.
- Split generic content into 8 MiB chunks: every value would need a second ordered manifest, multiple
  holds and GETs, reassembly validation, and partial-failure rollback. The existing 48 MiB history
  ceiling already gives a bounded single-blob limit.
- Hash canonicalized JSON values: canonicalization would add a semantic normalization contract,
  require another complete transformation of large values, and make the digest differ from the
  bytes served by the content route unless both forms were retained.
- Interpret reference-shaped objects recursively: opaque tool and Extension JSON could change
  meaning, and Pi output could forge Gateway authority.
- Advertise the capability before Browser and Runtime ownership are complete: a production peer
  could admit a reference that a downstream boundary cannot decode, retain, replay, or recover.
- Add a second generic-content database or make references valid across Gateway restarts: either
  choice would create content authority outside Pi JSONL and the current Gateway epoch.

## Verification

- Protocol tests cover version 1.2 compatibility, unadvertised version 1.3 definitions, final required
  capability negotiation, exact canonical budgets, strict wrappers, epoch fences, and root-only
  provenance.
- Store tests prove that text and JSON wrappers for the same UTF-8 bytes use one namespaced blob,
  raster and UTF-8 identities do not collide, byte and item accounting is shared, and GC, deletion,
  abort, restart, and shutdown cannot leak holds or file descriptors.
- Externalizer tests prove that 256 KiB minus one byte stays inline while values at 256 KiB and one
  byte above it externalize. They also cover the 48 MiB generic and 8 MiB raster ceilings; text and
  JSON encoding; mandatory `inline_json` or `external_json` roots; every allowlisted slot; opaque
  nested lookalikes; same-frame deduplication; rollback; and bounded-copy streaming seams.
- PiProcess and Runtime tests cover late and stale delivery, response-local evidence, authoritative
  terminal failures, startup history, event ordering, compaction, replay, snapshots, fork, clone,
  rekey, transition rollback, mixed crash retention, and cleanup-failure replacement fences.
- Browser tests cover trusted version 1.3 context, lazy tool materialization, ordered Extension editor
  and widget materialization, exact field guards, authenticated GET, one-shot resync, stale identity,
  and recovery without an inline fallback.
- The activation gate includes a faithful large tool result, replay and snapshot recovery, a large
  Extension editor or widget payload, cache exhaustion recovery, packaged Browser coverage, and the
  complete release verification suite.
