# Architecture

## Core principles

1. Pi JSONL is the only durable Session truth.
2. A Session is the unit of process ownership, ordering, control, recovery, and Browser state.
3. Browser navigation changes a view pointer, not Pi runtime ownership.
4. Identity and ordering uncertainty fail closed.
5. Memory, processes, buffers, and derived content have owners.
6. The Gateway is a local single-user control surface, not a hosted service.

## Topology and ownership

```text
Browser: view pointer + Session-scoped stores
Gateway: catalog + workspace hints + Session supervisor
   | one authenticated multiplexed WebSocket, one Pi RPC process per hot Session
native Pi JSONL
```

| Package | Authority |
| --- | --- |
| `packages/protocol` | Browser-safe DTOs, guards, policy, budgets; no Node or upstream Pi imports |
| `packages/server` | Runtime resolution, native discovery, Pi processes, lifecycle, REST, WebSocket |
| `packages/ui` | Session projections, drafts, controls, materialization, and visible interaction |
| `packages/cli` | Local launch, static UI discovery, and shutdown |

Package ownership is directional: the protocol package imports no Node API and no upstream Pi package, and
the Browser receives no raw upstream Pi type.

## Identity and discovery

A canonical JSONL file realpath is the persisted Session identity; the header `id` verifies that file,
and the canonical header `cwd` is the Workspace identity. A pending Session rekeys to the canonical
file handle once Pi materializes and freezes the header identity. A fork or clone child stays
unverified and non-recoverable until its header is materialized, and the active process moves to the
child identity while the parent stays independently discoverable and reopenable.

The Gateway re-verifies path, header, and filesystem identity at sensitive transitions.
`SessionLayoutResolver` owns Pi's directory precedence, and project and relative directories need a
known Workspace path. A saved Workspace preference is a hint: removing it never removes native history,
and re-adding the canonical path restores it.

## Session runtime ownership

Each hot Session owns at most one `pi --mode rpc` process, and a dormant historical Session owns none.
The supervisor admits concurrent Sessions from any Workspace and caps how many stay hot by counting
actual processes, not Browser selection or crash projections.

Idle persisted Sessions can become dormant; untouched idle pending Sessions can be abandoned with
their exact generation or by the orphan reaper, which stops and forgets memory state without deleting
a file. A Runtime owns its Pi process, generation, replay state, active and retained crash projections,
command admission and cancellation, controller lease and fencing state, and derived-content holds.
Replacement, timeout, abort, rekey, overflow, and shutdown transfer or release the single custody owner
of physical operations.

## Channels, control, and ordering

One authenticated WebSocket carries many Session channels: subscription, generation, replay cursor,
controller lease, fencing token, and Extension UI state are isolated per Session. A newer claim or
release intent invalidates work issued against a stale generation or fencing token.

The normalized event stream is authoritative: each Session event carries a monotonic sequence within a
server epoch and generation, and a command settles once its projection covers the response barrier. On
reconnect the Browser reconciles channels by exact identity against the published hot-Runtime
inventory; a proven gap can replay, and uncertain identity or sequence requires a snapshot resync.
Eviction candidates are subscribed, persisted, non-hot Sessions with no pending Extension requests.

## History and projections

Verified non-empty persisted JSONL uses native paged history; empty, unmaterialized, and unverified
Sessions have no durable history, so Pi answers. Active unpersisted suffixes merge only under exact
file and generation evidence. History pages, live events, and snapshots share one product projection
model: a snapshot initializes a channel or replaces it during explicit recovery, never a competing
event source. Projection growth is capped per Runtime: one that cannot fit stops publication, enters
`session_snapshot_overflow`, and keeps recoverable state for a fenced restart.

Each Session has at most one owned older-history page operation, keeping its identity, snapshot, and
cancellation ownership through ordered settlement. Changing the visible Session does not transfer it,
and late completion cannot recreate a channel after cancellation, replacement, rekey, or retirement.

## Derived content

Large raster, text, and JSON values can be externalized into an epoch-scoped `EpochContentStore`,
never durable Session authority; missing or invalid content triggers explicit recovery, never an empty
substitute. References carry the server epoch, digest, and byte length; Runtime generations own holds,
a Gateway restart invalidates previous references, and the store accepts no public upload.

Workspace file references are Host-owned prompt ingress: capture revalidates the canonical Workspace,
resolved target, and file identity around a no-follow read, and the owning Session keeps the captured
bytes until submission. Risk policy in `packages/server/src/workspace-file-references.ts` keeps
ignored, hidden, generated, and credential files out; uncertainty fails closed.

## Lifecycle and recovery

- Recoverable process crashes restart under the supervisor policy and keep exact generation semantics.
- Protocol incompatibility, malformed data, uncertain ownership, and overflow fail closed.
- Stop, eviction, rekey, overflow, deletion, and shutdown release resources through cleanup fences.
- Abandoning a Session stops and forgets memory state and never deletes a file.
- A non-recoverable crash may retain one sealed projection within aggregate retention budgets.

Session deletion is a recoverable transaction: it reserves the identity, requires the exact controller
state, revalidates the canonical path, header, and inode, then moves the file into private trash by
same-filesystem atomic rename. Direct unlink and copy-and-unlink across filesystems are forbidden.

## Browser state

The selected Session is only a view pointer. Projection, draft, attachments, submit state, model
selection, and Extension UI are partitioned by canonical Session handle, and async completions update
the Session identity captured when work started.

Components consume stores, not WebSocket frames: frames pass through the transport, ordered Session
bus, stream pipeline, and reducers. Compatible delta-only updates may coalesce, while structural,
settled, error, rekey, recovery, and dialog-close boundaries flush synchronously. Confirmed deletion
and completed transient abandonment retire the local transport channel, its machine state, pending
operations, and bus ordering metadata; late completions are fenced by canceled operation ownership,
and cleanup preserves other Sessions and their drafts.

## Resource and security boundary

[Protocol](protocol.md#local-access-control) owns bootstrap, reconnect authentication, and privileged
request checks. [Security](../SECURITY.md#security-boundary) defines the supported threat boundary.

Pi JSONL content, model output, extension payloads, filenames, and Browser frames are untrusted. Every
buffering boundary owns item and byte ceilings, admission before expensive work, cancellation, and one
cleanup path; budget values live in `packages/protocol/src/payload-budget.ts` and the adjacent guards.

## Non-goals

- A second Workspace or Session database, and hosted, remote, or multi-user operation.
- Cross-epoch persistence for derived content references.
- Global Pi navigation as Browser routing.
- Unlimited hot processes, replay, projections, history, or payloads.
- Silent identity, cursor, or ownership repair.
