# ADR 0013: Keep one canonical Gateway and explicit boundaries

- Status: Accepted
- Date: 2026-08-30
- Supersedes: ADR 0012 and the Browser/Gateway compatibility wording in ADRs 0007, 0010, and 0011

## Context

Protocol 1.3 added typed content references while 1.2 remained implemented as a parallel success
path. Server factories, DTO families, Browser transports, and tests duplicated current and future
execution. A shallow TypeBox registry also repeated structural checks before the existing contextual
guards. The public attachment PUT route had no product caller because Browser command images remain
inline and Pi output uses an internal staged publication path.

This multiplicity increased review surface, bundle size, and the chance that fixes reached only one
mode. There was no supported independently released client or product requirement that justified
the parallel architecture.

## Decision

1. Browser/Gateway protocol 1.3 is the only production implementation. Both peers require the exact
   version and capability set. Protocol 1.2 remains only as a terminal mismatch fixture; it is not a
   second transport, DTO family, server pipeline, or Browser mode.
2. Pi RPC remains a separate upstream compatibility boundary. Its implementation is named
   `PiRpcAdapter` with stable diagnostic id `pi-rpc`. It supports exact Pi versions only after fixture
   and conformance review. The name does not imply imminent removal or invent an upstream protocol
   version that Pi does not advertise.
3. Product and Pi boundary decoders use explicit contextual guards. They retain UTF-8, depth, item,
   identity, ownership, redaction, and complete-frame checks in one traversal. The redundant shallow
   TypeBox registries and runtime dependency are removed.
4. Typed content references remain part of the canonical protocol and their production Browser
   scenarios run in the default Browser gate.
5. Derived attachment and content stores expose authenticated read routes only. Pi externalization
   keeps its private staged publication API; the unused public attachment PUT ingress is removed.

## Consequences

- There is one production DTO set, handshake, Server pipeline, UI transport, and Browser gate.
- Compatibility failures are earlier and clearer, but an older Browser and newer Gateway cannot
  negotiate a temporary success mode.
- Pi compatibility remains deliberate without labelling the supported adapter as legacy.
- Contextual security and resource checks stay explicit; adding a new generic schema layer requires
  evidence that it replaces rather than duplicates those checks.
- The public API is smaller and does not expose a write surface without a product caller.

## Rejected alternatives

- Keep 1.2 for hypothetical independently updated clients: no supported distribution or rollout
  model requires it, while every change would continue to maintain two products.
- Rename the upstream adapter `legacy`, `v1`, or `jsonl`: Pi calls the interface RPC Mode, exposes no
  protocol version, and JSONL framing belongs to the process transport rather than adapter identity.
- Retain shallow schemas as documentation: TypeScript DTOs, fixtures, and contextual guards already
  provide that contract, while the runtime layer added cost without removing validation work.
- Keep public PUT for future uploads: speculative API surface adds authentication, lifecycle, and
  resource obligations before a caller exists.

## Verification

- Protocol and compatibility suites cover exact Gateway 1.3 negotiation, terminal mismatch, strict
  guards, current and reviewed Pi fixtures, and `PiRpcAdapter` diagnostics.
- Server tests cover the single production pipeline, authenticated content reads, internal staged
  publication, cancellation, ownership, recovery, and terminal protocol failure.
- UI typechecking and focused transport tests cover the canonical hello, Session channels, typed
  content, recovery, and no-reconnect terminal mismatch.
- The default Browser suite includes seven production content-reference scenarios. Production bundle
  checks verify that the removed schema dependency is absent and the UI remains within budget.
