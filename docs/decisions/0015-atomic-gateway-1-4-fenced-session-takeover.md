# ADR 0015: Atomic Gateway 1.4 fenced Session takeover contract

- Status: Accepted
- Date: 2026-08-31
- Amends: Browser/Gateway compatibility and control wording in ADRs 0007, 0010, 0011, and 0013

## Context

An observer can continue reading a Session while the controller's WebSocket remains connected, but
could not recover control when that controller page became unreachable. Claiming only covers a free
lease, while adding takeover changes both a strict Browser frame and the recipient-specific lease
view. Retaining a 1.3 success path would permit peers to disagree about fencing, lease revisions,
and token redaction.

## Decision

1. Gateway protocol 1.4 is the single exact Browser/Gateway production contract. Protocol 1.3 and
   earlier versions are terminal mismatch fixtures only; they do not select a second DTO family,
   compatibility mode, or fallback path.
2. Both hello directions require `session.fenced_takeover` alongside the existing production
   capabilities. A missing capability, incomplete exact version, or inconsistent hello terminates
   before Session traffic.
3. A `session_takeover` request identifies one canonical Session and carries its exact generation
   and observed lease revision. The Supervisor serializes claim, release, exact release, takeover,
   disconnect cleanup, and rekey through one lease transition domain. A successful takeover is one
   compare-and-swap that replaces the owner and fencing token without stopping, restarting,
   cancelling, or migrating Pi work already admitted by the Runtime.
4. Lease revisions are safe integers scoped to `(serverEpoch, canonicalSessionHandle, generation)`.
   They start free at zero, increment only for real owner transitions, reset for a new generation,
   and fail the affected control state closed rather than wrap on exhaustion. A lease view reports
   its revision, free-or-held state, and transition. The token is constructed per recipient and is
   present if and only if that recipient is the controller.
5. Catch-up and rekey preserve authoritative ordering. The Bridge keeps only the latest pending
   lease view for each recipient and Session until its baseline is authoritative. Rekey publishes
   the rekey fence, then the child baseline, then the child lease view. Equal revisions with
   conflicting recipient-visible state are rejected by the Browser control reducer.

## Consequences

The Browser and Gateway are released as one exact 1.4 unit. An old fencing token fails at the
existing privileged Runtime admission boundary after the takeover linearization point, while a
command admitted before that point can complete to its original requester. Lease state remains
in-memory and connection-scoped: no token, lease revision, or controller identity is persisted in
Pi JSONL, snapshots, or Workspace preferences.

The change establishes a non-visual transport capability. Product affordances and explanatory
surfaces consume the revisioned control state separately; this decision does not create a
Workspace-wide, multi-writer, remote, or persisted-control mode.

## Rejected alternatives

- **Accept protocol 1.3 with an optional takeover shape**: an old peer could treat a revisioned
  lease status as an unversioned owner view and retain an invalid fence.
- **Reuse a connection-local control-intent counter as the CAS revision**: it does not identify the
  Gateway's global lease state and cannot fence another connection.
- **Cancel work on takeover**: admission already separates accepted Pi work from later privileged
  requests; cancellation would violate Session continuity and is not required for fencing.
- **Broadcast one token-bearing status then redact it**: a shared payload can be retained or sent
  before redaction. Each recipient must receive an independently constructed view.

## Verification

- Strict protocol tests cover exact 1.4 hello/capabilities, 1.3 terminal mismatch, takeover frame
  validation, and recipient token rules.
- Supervisor and real-WebSocket bridge tests cover CAS races, disconnect/rekey ordering, revision
  exhaustion, token rotation, admitted-work continuity, and old-token mutation and Extension
  rejection.
- Transport tests cover baseline gating, monotonic revision adoption, stale-drop and
  same-revision-conflict fail-closed behavior, and the non-visual `takeoverSession` facade.
