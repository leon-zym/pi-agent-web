# Architecture

This document is the current architecture contract for Pi Agent Web. It defines identity, state
ownership, concurrency, recovery, and resource boundaries. Historical rationale and superseded
approaches belong in [architecture decisions](decisions/README.md).

## Core principles

1. Pi JSONL is the only durable Session truth.
2. A Session is the unit of process ownership, ordering, control, recovery, and Browser state.
3. Browser navigation changes a view pointer, not Pi runtime ownership.
4. Identity and ordering uncertainty fail closed.
5. Memory, processes, buffers, and derived content have explicit bounds and owners.
6. The Gateway is a local single-user control surface, not a hosted service boundary.

## Topology and ownership

```text
Browser
  selected view + Session-scoped stores
  one authenticated multiplexed WebSocket
        |
Gateway
  native catalog + workspace hints + bounded Session supervisor
        |
  one Pi RPC process for each hot Session
        |
native Pi JSONL
```

| Package | Authority |
| --- | --- |
| `packages/protocol` | Browser-safe DTOs, runtime guards, policy, and shared budgets |
| `packages/server` | Runtime resolution, native discovery, Pi processes, lifecycle, REST, and WebSocket |
| `packages/ui` | Session projections, drafts, controls, materialization, and visible interaction |
| `packages/cli` | Local launch, static UI discovery, and shutdown |

Package ownership is directional. The protocol package imports neither Node APIs nor upstream Pi
packages. The Browser never receives raw upstream Pi types.

## Identity and discovery

### Persisted identity

A canonical JSONL file realpath is the persisted Session identity. The JSONL header `id` verifies
that file but is not a global key. The canonical header `cwd` is the Workspace identity. Encoded
directory names and saved Workspace preferences are discovery hints only.

The Gateway verifies path, header, and filesystem identity at sensitive transitions. A path or inode
change is not silently treated as the same Session.

### Pending and derived identity

A new Session begins with a pending in-memory handle. Pi can choose a native file only after the
first command. The active Runtime rekeys to the canonical file handle after the header identity is
materialized and frozen.

Fork and clone can allocate a child path before its file exists. The child remains unverified and
non-recoverable until its header is materialized. The active process moves to the child identity;
the parent remains independently discoverable and reopenable.

### Session layout

`SessionLayoutResolver` applies Pi's directory precedence and child-cwd semantics. Absolute default,
global, and environment-configured locations can be discovered without a saved Workspace. Project
configuration and relative Agent or Session directories require a known Workspace path.

Workspace preferences store labels, recency, and discovery hints. Removing a preference never
removes native history; adding the same canonical path restores its discovery hint.

## Session runtime ownership

Each hot Session owns at most one `pi --mode rpc` process. A dormant historical Session owns none.
The supervisor keeps a bounded process pool and admits concurrent Sessions from the same or
different Workspaces.

Process capacity is based on actual hot processes, not Browser selection or retained crash
projections. Idle persisted Sessions can become dormant. Untouched idle pending Sessions can be
abandoned with their exact generation or by the bounded orphan reaper. Abandonment stops and forgets
memory state only; it never deletes a file.

A Runtime owns:

- the Pi process and generation;
- normalized sequence and replay state;
- the active projection and bounded retained crash projection;
- command admission, cancellation, and response barriers;
- controller lease and fencing state;
- derived-content holds reachable from its state.

Physical operations have one custody owner. Replacement, timeout, abort, rekey, overflow, and
shutdown transfer or release that custody explicitly.

## Channels, control, and ordering

One authenticated WebSocket carries many Session channels. Subscription, generation, sequence,
replay cursor, command id, controller lease, fencing token, and Extension UI state are isolated per
Session.

Read-only commands do not require a controller lease. Every mutation and Extension response requires
the exact generation and current fencing token. A newer claim or release intent invalidates stale
work. There is no nullable-generation or best-effort control path.

The normalized event stream is authoritative. Each Session event has a monotonic sequence within a
server epoch and generation. A command response includes a `barrierSeq`; the Browser resolves the
command only after its projection covers that barrier.

On reconnect, the Gateway publishes an authoritative hot-Runtime inventory. The Browser reconciles
known channels by exact identity. A proven bounded gap can use replay. Missing or uncertain identity,
epoch, generation, or sequence requires an explicit snapshot resync.

## History and projections

Verified non-empty persisted JSONL uses native paged history. Empty, unmaterialized, and unverified
Sessions query Pi because no durable native history exists yet. Active unpersisted suffixes are
merged only under exact file and generation evidence.

History pages, live events, and snapshots use one product projection model. A snapshot initializes a
channel or replaces it during explicit recovery; it is not a competing event source.

Projection growth is bounded. If a live projection cannot fit, the Runtime enters
`session_snapshot_overflow`, stops normal publication, and retains only budgeted recoverable state.
The user can claim that inactive Runtime without starting Pi and issue an exact fenced restart.

## Derived content

Large raster, text, and JSON values can be externalized into an epoch-scoped `EpochContentStore`.
The store is bounded, discardable, and derived from Pi-owned state. It is never durable Session
authority.

References contain the exact server epoch, digest, representation facts, and byte length. Runtime
generations own holds; HTTP readers own short-lived pins. A Gateway restart invalidates all previous
references. Missing or invalid content triggers explicit recovery, never an empty substitute.

The Browser retrieves referenced content through authenticated same-origin GET routes. Browser
command images remain bounded inline ingress. There is no public upload endpoint for the derived
store.

Workspace file references are Host-owned prompt ingress. Search exposes bounded metadata and safe
preview text; capture revalidates the canonical Workspace, resolved target, and file identity around
a no-follow read. The owning Session keeps the captured bytes until submission, and file-reference
expansion does not ask Pi RPC to reopen the path. Ordinary agent tools remain a separate boundary.

Risk policy covers ignore state, hidden or generated paths, credential patterns, size, binary data,
and images. Uncertainty fails closed, no file index or content cache is durable, and the expanded Pi
user message remains native JSONL truth.

## Lifecycle and recovery

- Recoverable process crashes use bounded restart policy and preserve exact generation semantics.
- Protocol incompatibility, malformed authoritative data, uncertain ownership, and projection
  overflow fail closed instead of auto-repairing state.
- Manual stop, capacity eviction, replacement, rekey, overflow, deletion, and shutdown cancel work
  and release owned resources through bounded cleanup fences.
- A non-recoverable crash may retain one sealed projection only while it remains within aggregate
  retention budgets.

Session deletion is a recoverable transaction. It requires the exact controller state, reserves the
identity, revalidates the canonical path, header, and inode, then performs a same-filesystem atomic
move into private trash. Direct unlink and cross-filesystem copy-and-unlink are forbidden.

## Browser state

The selected Session is only a view pointer. Projection, draft, attachments, submit state,
model/thinking selection, slash commands, usage, control state, content materialization, and
Extension UI are partitioned by canonical Session handle.

Components consume stores, not WebSocket frames. Frames pass through the transport, ordered Session
bus, stream pipeline, and reducers. Async completions update the Session identity captured when work
started, even if another Session is now visible.

Compatible delta-only updates may be coalesced. Structural, settled, error, rekey, recovery, and
dialog-close boundaries flush synchronously. Background subscribed Sessions continue ingesting.

### Session lifecycle ownership

Session-scoped lifecycle changes are coordinated synchronously by the UI lifecycle registry. The
directory/current-view, composer, projection, model, slash-command, stats, and Extension owners
register one explicit `migrate`, `preserve`, `reset`, or `rebuild` policy for create, snapshot, rekey,
and dispose. Owners prepare before any commit; a failed commit restores owners already committed in
reverse order and reports projection recovery. Browser effects are typed intents with the complete
Session identity and a dedupe key, and run only after a successful state commit. Toasts, audio,
titles, tab badges, scheduled directory refreshes, and navigation use the injected
`SessionBrowserEffects` adapter, so stale incarnations and failed effect sinks cannot mutate a newer
Session.

## Resource and security boundary

The Gateway accepts only loopback listeners. Except for bootstrap-cookie issuance, REST and
WebSocket access require that cookie and same-origin checks. Host, Origin when present, and Fetch
Metadata are validated before privileged work.

Paths, JSONL headers, model output, extension payloads, filenames, and Browser frames are untrusted.
Every buffering boundary owns item and byte ceilings, admission before expensive work, cancellation,
and one cleanup path. Exact values are code-owned in `packages/protocol/src/payload-budget.ts` and
the adjacent boundary guards; documentation does not duplicate the full constant table.

## Non-goals

- A second Workspace or Session database.
- Hosted, remote, LAN, or multi-user operation.
- Cross-epoch persistence for derived content references.
- Global Pi navigation as Browser routing.
- Unlimited hot processes, replay, projections, history, or payloads.
- Silent identity, cursor, or ownership repair.
