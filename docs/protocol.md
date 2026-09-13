# Protocol

```text
Pi RPC JSONL <-> PiRpcAdapter <-> product DTOs <-> Gateway 1.4 <-> Browser
```

Pi RPC advertises no wire-version field, so `PiRpcAdapter` supports only the exact Pi versions backed by
fixtures and conformance tests. Browser/Gateway protocol 1.4 is the sole production WebSocket contract;
older minors have no compatibility mode.

## Pi RPC

The Gateway runs one `pi --mode rpc` process per hot Session, exchanging newline-delimited JSON on standard
input and output; standard error is diagnostic and stays out of the product event stream. `PiRpcAdapter` owns
command encoding, response correlation, complete response, event, message, and Extension UI decoding,
translation into product-owned DTOs, redaction of upstream-only or malformed data, and exact-version
compatibility evidence. Unknown authoritative frames, malformed nested data, and incompatible behavior
terminate the Runtime with `protocol_incompatible` instead of restarting it. The read-only command set lives in
`packages/protocol/src/index.ts`; every other command is a mutation, and the only ignorable upstream frame types
are in `packages/server/src/pi-rpc-adapter.ts`.

The normal runtime is the exact Pi dependency installed with the distribution: the Gateway resolves its RPC
entry from that package rather than the launch directory or an unrelated `pi` on `PATH`, and `--pi-path` and
`PI_PATH` are expert overrides. Every candidate passes a version probe and the exact adapter matrix before
readiness, and a probe failure exposes a stable redacted diagnostic. `/api/v1/health/live` reports liveness
and `/api/v1/health/ready` reports whether a validated Pi runtime is available.

## Local access control

The Gateway accepts only loopback hosts. `/api/v1/bootstrap` validates the request origin and issues an
HttpOnly session cookie; all other `/api/v1` API and WebSocket traffic requires that cookie plus Host and
same-origin validation, and Fetch Metadata covers same-origin Browser GETs that omit Origin.

Gateway restart rotates authentication. A reconnect refreshes bootstrap authentication with one cancellable,
time-limited same-origin request under the existing reconnect backoff, and disposal cancels that request.
Mutations resume after the new epoch establishes Session authority, and an old cookie or fence is never reused
as authority. [Security](../SECURITY.md#security-boundary) owns the supported threat boundary; development
proxies through Vite, and production serves the UI and API from one listener.

## REST surface

All paths below use the `/api/v1` prefix.

| Area | Contract |
| --- | --- |
| Bootstrap and health | `GET /bootstrap` issues the local session cookie; `GET /health/live` and `GET /health/ready` report liveness and readiness, and `/health` aliases readiness |
| Auth | The Gateway controls provider configuration: read provider status and store a provider key in Pi's configured Agent directory |
| Workspaces | List, add, remove a discovery hint, activate, search file metadata, capture an exact file reference, list Sessions |
| Sessions | Create, inspect process state, abandon an untouched transient, request fenced deletion |
| Content | Authenticated `GET /attachments/:serverEpoch/:sha256` for validated raster content and `GET /content/:serverEpoch/:sha256` for typed UTF-8 content |

Derived-content routes are read-only and reject stale epochs, invalid digests, ranges, unsupported methods,
missing content, and closed stores, with `no-store`, same-origin, and `nosniff` responses.

Pi RPC does not expand CLI `@file` arguments, so the Gateway expands Workspace files.
`GET /workspaces/:workspaceHandle/files` returns metadata, availability, policy flags, and an ordinary-text
preview where safe, and it never returns a credential-pattern preview.
`POST /workspaces/:workspaceHandle/file-references/capture` requires the exact metadata identity and an explicit
confirmation bit, then reopens and revalidates the file before returning prompt content.

Files above the size threshold, images, binary files, hidden or ignored paths, generated output, credential
patterns, and unknown ignore policy require confirmation. Search, preview, and capture budgets, including the
per-draft reference count and captured total, are code-owned in
`packages/protocol/src/workspace-file-reference.ts`, with operation admission in
`packages/server/src/workspace-file-references.ts`. The path in the draft is a display label: submission
appends the captured bytes through the Pi file envelope and inline image field, so expansion never asks Pi RPC
to reopen it. Downstream budgets still apply when ordinary attachments consume the remaining capacity, and
unavailable, truncated, confirmation-required, policy-blocked, cancelled, and stale-identity states stay
distinct.

## WebSocket negotiation

The endpoint is `/api/v1/ws`. The first Browser frame must be `client_hello` within the hello deadline, and
the Gateway replies with `server_hello` before accepting Session traffic.

Both peers require the exact protocol version, including `session.fenced_takeover`, and the production
capability set. The server hello binds the server build and epoch, the validated Pi version and `pi-rpc`
adapter id, capabilities, request limits, and the negotiated budgets. Missing capabilities, inconsistent
budgets, version mismatch, an oversized hello, and Session traffic before hello are terminal, and no peer
falls back to inline content or an older protocol.

## Session channels and publication

Every Session-scoped message carries the canonical Session handle and the exact identity fields its operation
needs. The Browser operations are subscribe and unsubscribe; claim, release, and explicit takeover; replay,
resync, and paged history; command send; Extension UI response; and restart of a recoverable inactive Runtime.
Read-only commands require exact Session identity and no controller lease. Every mutation and Extension UI
response carries the exact generation and current fencing token, and the server rejects stale generation, stale
token, ambiguous identity, duplicate command ownership, and payload admission failure before privileged work.

A controller lease view is revisioned by `(serverEpoch, canonicalSessionHandle, generation)`, and `lease_status`
reports the lease revision, control state, and transition provenance; the fencing token appears only in the
controlling recipient's view. A takeover carries the caller's exact generation and observed lease revision;
one compare-and-swap replaces owner and token without cancelling admitted work or changing Pi process
ownership. An old handle, generation, revision, token, or identity window fails closed, and during catch-up or
rekey the Bridge holds only the newest lease view until the recipient has an authoritative baseline.

The Gateway publishes negotiated hello or terminal protocol errors, the authoritative hot-Runtime inventory,
subscription snapshots and history chunks, normalized sequenced events, command responses with a `barrierSeq`,
and revisioned controller, rekey, recovery, directory, auth, and terminal Session state. Sequence is scoped to
server epoch, Session handle, and generation; the Browser applies events in order, and a command is complete
only when its response has arrived and the projection covers its barrier.

Replay requires a proven cursor on the same identity. Snapshot resync is explicit and cursorless when the
epoch, identity, generation, content materialization, or sequence is uncertain. History uses immutable
snapshot ids and chunked frames, so a large persisted Session does not need one WebSocket frame.

## Content references

Byte, item, depth, command, replay, snapshot, queue, and content-reference budgets are code-owned in
`packages/protocol/src/payload-budget.ts` and the boundary guards, and a producer ceiling must fit the consumer
ceiling. Browser command images use inline base64; Pi-owned raster output may become an `attachment_ref`, and
allowlisted large text and JSON roots may become `content_ref` wrappers.

A reference is valid only for its exact server epoch and declared budget. The derived store is bounded and
discardable; Runtime generations own references before publication, and HTTP readers pin them while streaming.
A stale or missing reference triggers one recovery attempt for the captured Session identity and never becomes
empty text, `null`, or an empty image.
Only closed, field-specific roots of opaque Pi JSON gain reference semantics, and a materialized value reruns the
original guard before becoming authoritative.

## Backpressure and failure

Admission happens before expensive work, and every buffering boundary carries its own ceiling and cancellation
path. A lagging Session channel takes catch-up or an explicit resync instead of growing an unbounded outbound
queue, and projection overflow enters a recoverable inactive state. Malformed authoritative data, ownership
uncertainty, and cleanup failure terminate the affected Runtime and fail closed. Protocol errors use stable
product codes; provider output, credentials, runtime paths, validator internals, and diagnostic stacks stay
inside the Gateway.
