# ADR 0003: Multiplex isolated Session channels

- Status: Partly superseded by ADR 0008 and ADR 0015
- Date: 2026-08-21

The channel design below is generation-scoped.
[ADR 0008](0008-authoritative-epoch-aware-live-session-resync.md) supersedes its recovery cursor and
separate Extension baseline; [ADR 0015](0015-atomic-gateway-1-4-fenced-session-takeover.md) adds
fenced takeover while the previous controller remains connected. Current epoch, snapshot, lease, and
takeover semantics live in [Protocol](../protocol.md); the decisions below explain why channels and
response barriers are Session-scoped.

## Context

A single selected-Session socket scope drops background events and cannot support independent
controllers. Pi responses may interleave with events, while reconnects, generation changes, and
bounded replay can create gaps. Treating command responses as projection completion also exposes
stale UI state.

## Decision

- One authenticated WebSocket multiplexes any number of Session channels. Each channel has an
  independent subscription, runtime generation, sequence cursor, replay state, Extension UI
  snapshot, and controller lease.
- Read-only RPC commands require a subscription but no controller lease. Every mutation requires
  the exact runtime generation and the current Session's opaque fencing token.
- Event frames receive a generation-local monotonic `seq`. Replay is bounded; an initial load,
  invalid cursor, generation change, or gap produces explicit `resync_required` instead of a guess.
- Subscription catch-up sends an authoritative runtime baseline, replay or resync decision,
  Extension UI snapshot, and lease snapshot before live frames become visible to consumers.
- A response includes `barrierSeq`. The UI resolves the caller only after the corresponding
  projection has applied events through that barrier. Fork/clone responses may also identify the
  previous handle; unrelated pending parent commands are not rewritten.
- Controller intent is remembered across reconnects, but a new lease is claimed only after the
  channel baseline. Disconnect releases all leases and invalidates their fencing tokens.
- Dialog closure is an authoritative sequenced frame so every observer removes answered, expired,
  replaced, or process-lost requests.

## Consequences

A tab may control several Sessions, while different tabs may control different Sessions. A second
tab on the same Session is a read-only observer until the existing controller releases or
disconnects. Replay, catch-up, raw-event, Extension state, and outbound queues all require item and
byte limits.

## Rejected alternatives

- One Workspace lease: blocks unrelated Sessions and gives the wrong ownership boundary.
- Relying on response/event arrival order: Pi does not provide that causal guarantee.
- Silent cursor repair or last-writer-wins snapshots: can lose or reorder conversation state.
