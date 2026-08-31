# Protocol

This document defines the current upstream Pi RPC boundary and the local Browser/Gateway contract.
It describes interoperable behavior, not every DTO field. The Browser-facing protocol is owned by
this project and does not expose upstream Pi types.

## Protocol boundaries

```text
Pi RPC JSONL <-> PiRpcAdapter <-> product DTOs <-> Gateway 1.4 <-> Browser
```

These are separate compatibility concerns:

- Pi RPC has no advertised wire-version field. `PiRpcAdapter` supports only exact Pi versions backed
  by fixtures and conformance tests.
- Browser/Gateway protocol 1.4 is the sole production WebSocket contract. There is no production
  compatibility mode for an older Browser/Gateway minor.

## Pi RPC

The Gateway launches one `pi --mode rpc` process for each hot Session. Commands and output are
newline-delimited JSON on standard input and standard output. Standard error is diagnostic only and
never enters the product event stream.

`PiRpcAdapter` owns:

- command encoding and response correlation;
- complete response, event, message, and Extension UI decoding;
- translation into product-owned DTOs;
- redaction and rejection of upstream-only or malformed data;
- exact-version compatibility evidence.

Unknown authoritative frames, malformed nested data, or incompatible runtime behavior terminate the
Runtime with `protocol_incompatible`. They do not enter a restart loop. Only explicitly allowlisted
non-authoritative frames may be ignored.

Read-only commands include state, model, thinking, command, message, tree, stats, and export queries.
Mutations include prompt, steer, follow-up, abort, compact, model/thinking changes, fork, clone,
Session mutation, shell, and Extension responses. The shared command policy in `packages/protocol`
is authoritative.

## Runtime resolution

The normal runtime is the exact Pi dependency installed with the distribution. The Gateway resolves
its RPC entry from that package, not from the launch directory or an unrelated `pi` on `PATH`.
`--pi-path` and `PI_PATH` are expert overrides.

Every candidate passes a bounded version probe and the exact adapter matrix before readiness. Probe
failure exposes a stable redacted diagnostic. `/api/v1/health/live` reports process liveness;
`/api/v1/health/ready` reports whether a validated Pi runtime is available.

## Local access control

The Gateway accepts only loopback hosts. `/api/v1/bootstrap` validates the request origin and issues
an HttpOnly session cookie. Every other API and WebSocket request requires that cookie plus Host and
same-origin validation. Fetch Metadata covers same-origin Browser GETs that omit Origin.

Development uses Vite's same-origin proxy. Production serves the UI and API from one listener. These
checks do not make the product safe for public, LAN, remote, or multi-user exposure.

## REST surface

All paths below use the `/api/v1` prefix.

| Area | Contract |
| --- | --- |
| Bootstrap | `GET /bootstrap` issues the local session cookie |
| Health | `GET /health/live`, `GET /health/ready`; `/health` aliases readiness |
| Auth | Read provider status and store a bounded provider key in Pi's configured Agent directory |
| Workspaces | List, add, remove a discovery hint, activate, search bounded file metadata, capture an exact file reference, and list Sessions |
| Sessions | Create, inspect process state, abandon an untouched transient, or request fenced deletion |
| Attachments | Authenticated `GET /attachments/:serverEpoch/:sha256` for validated raster content |
| Content | Authenticated `GET /content/:serverEpoch/:sha256` for typed UTF-8 content |

Workspace and Session resources are projections over native Pi state. Removing a Workspace removes
only its preference. Session deletion is the separate fenced recoverable transaction described in
[Architecture](architecture.md).

Derived-content routes are read-only. They reject stale epochs, invalid digests, ranges, unsupported
methods, missing content, and closed stores. Responses are `no-store`, same-origin, and `nosniff`.
There is no public attachment or generic-content upload endpoint.

### Workspace file-reference ingress

Pi RPC accepts prompt text and inline images; it does not expand CLI `@file` arguments. The Gateway
therefore owns Workspace file expansion. `GET /workspaces/:workspaceHandle/files` returns bounded
metadata, policy flags, availability, and an ordinary-text preview where safe. It never returns a
credential-pattern preview. `POST /workspaces/:workspaceHandle/file-references/capture` requires the
exact metadata identity and an explicit confirmation bit, then reopens and revalidates the file
before returning captured prompt content.

Search is capped at 50 results, 300 directories, a 200-character query, 16 KiB of classification
input per candidate, and four concurrent file operations. Preview text is capped at 2 KiB. Files
above 64 KiB, images, binary files, hidden or ignored paths, generated output, credential patterns,
and unknown ignore policy require confirmation. Per-file capture ceilings are 256 KiB for UTF-8
text, 64 KiB for base64 binary, and 1.5 MiB raw for supported images. One Session draft retains at
most eight references and 512 KiB of captured text or base64. Downstream command and image budgets
remain authoritative if combined ordinary attachments consume the remaining capacity.

The path in the draft is a display label. Submission appends the already captured bytes using the
established Pi file envelope and inline image field; file-reference expansion does not ask Pi RPC to
reopen the path. Ordinary agent tools remain governed by their separate tool and Workspace policy.
Unavailable, truncated, confirmation-required, policy-blocked, cancelled, and stale-identity states
remain distinct.

## WebSocket negotiation

The endpoint is `/api/v1/ws`. The first Browser frame must be `client_hello` within the hello
deadline. The Gateway replies with `server_hello` before accepting Session traffic.

Both peers require exact protocol `{major: 1, minor: 4}`, including
`session.fenced_takeover`, and the production capability set. The
server hello binds:

- server build and server epoch;
- validated Pi version and adapter id `pi-rpc`;
- required capabilities;
- client, server, snapshot, and Extension request limits;
- the complete payload and content-reference budgets.

Missing capabilities, incomplete or inconsistent budgets, version mismatch, oversized hello, or
Session traffic before hello is terminal. A peer does not fall back to inline content or an older
protocol implementation.

## Session channel messages

Every Session-scoped message carries the canonical Session handle and exact identity fields required
by its operation. The primary Browser operations are:

- subscribe and unsubscribe;
- claim, release, and explicitly take over controller ownership;
- request replay, snapshot resync, or paged history;
- send a Pi command;
- respond to Extension UI;
- restart a recoverable inactive Runtime.

Read-only commands require exact Session identity but no controller lease. Every mutation and
Extension response requires the exact generation and current fencing token. The server rejects stale
generation, stale token, ambiguous identity, duplicate command ownership, and payload admission
failure before privileged work.

Controller lease views are revisioned by the exact `(serverEpoch, canonicalSessionHandle,
generation)` identity. A `lease_status` reports the global `leaseRevision`, free-or-held control
state, and transition provenance. The fencing token is present only in the controlling recipient's
view. A takeover carries the caller's exact generation and observed lease revision; the Gateway
performs one compare-and-swap that replaces the owner and fencing token without cancelling already
admitted work or changing Pi process ownership. An old handle, generation, revision, token, or
identity window fails closed. During catch-up or rekey the Bridge holds only the newest lease view
until the recipient has an authoritative baseline.

## Gateway publication

The Gateway publishes:

- negotiated hello or terminal protocol errors;
- the authoritative hot-Runtime inventory;
- subscription snapshots and history chunks;
- normalized sequenced events;
- command responses with a `barrierSeq`;
- revisioned controller, rekey, recovery, directory, auth, and terminal Session state changes.

Sequence is scoped to server epoch, Session handle, and generation. The Browser applies events in
order. A command is complete only when the response is received and projection covers its barrier.

Replay is allowed only for a proven cursor on the same identity. Snapshot resync is explicit and
cursorless when the epoch, identity, generation, content materialization, or sequence is uncertain.
History uses immutable snapshot ids and bounded chunks so large persisted Sessions do not require a
single WebSocket frame.

## Payloads and content references

The protocol package owns canonical byte, item, depth, command, replay, snapshot, and queue budgets.
Guards measure complete serialized frames at their boundaries. The exact table remains code-owned in
`packages/protocol/src/payload-budget.ts`; producer ceilings must fit downstream consumer ceilings.

Browser command images use bounded inline base64. Pi-owned raster output may become an
`attachment_ref`. Allowlisted large text and JSON roots may become typed `content_ref` wrappers.
References are valid only for their exact server epoch and declared budget.

The derived store is bounded and discardable. Runtime generations own references before publication;
HTTP readers pin them while streaming. A stale or missing reference produces one explicit recovery
attempt for the captured Session identity. It never becomes empty text, `null`, or an empty image.

Opaque Pi JSON is not recursively interpreted. Only closed, field-specific roots gain reference
semantics, and materialized values rerun the original field guard before becoming authoritative.

## Backpressure and failure

Admission occurs before expensive work. JSONL frames, Browser frames, decoded structures, history,
snapshots, replay, outbound queues, catch-up buffers, command results, projections, and derived
content all have independent ceilings and cancellation paths.

Slow clients cannot grow an unbounded outbound queue. A lagging Session channel enters bounded
catch-up or explicit resync. Projection overflow enters a recoverable inactive state. Malformed
authoritative data, ownership uncertainty, or cleanup failure terminates the affected Runtime and
fails closed.

Protocol error payloads use stable product codes and bounded metadata. Raw provider output,
credentials, runtime paths, validator internals, and diagnostic stacks do not cross the boundary.
