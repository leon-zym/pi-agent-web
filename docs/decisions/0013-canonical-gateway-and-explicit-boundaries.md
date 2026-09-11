# ADR 0013: Keep one canonical Gateway and explicit boundaries

- Status: Partly superseded by [ADR 0015](0015-atomic-gateway-1-4-fenced-session-takeover.md)
- Date: 2026-08-30
- Supersedes: ADR 0012 and the Browser/Gateway compatibility wording in ADRs 0007, 0010, and 0011

## Context

Protocol 1.3 added typed content references while 1.2 remained a parallel success path: Server
factories, DTO families, Browser transports, and tests duplicated inline and content-reference
execution. A shallow TypeBox registry also repeated structural checks before the existing contextual
guards. The public attachment PUT route had no product caller, because Browser command images remain
inline and Pi output uses an internal staged publication path. The duplication increased review
surface, bundle size, and the chance that a fix reached only one mode.

## Decision

1. At adoption, Browser/Gateway protocol 1.3 was the only production implementation, and both peers
   required the exact version and capability set. Protocol 1.2 remained only as a terminal mismatch
   fixture; it was not a second transport, DTO family, server pipeline, or Browser mode.
2. Pi RPC remains a separate upstream compatibility boundary, implemented as `PiRpcAdapter` with
   diagnostic id `pi-rpc`. It supports exact Pi versions only after fixture and conformance review.
   The name does not imply imminent removal or invent an upstream protocol version that Pi does not
   advertise.
3. Product and Pi boundary decoders keep UTF-8, depth, item, identity, ownership, redaction, and
   complete-frame checks in one contextual traversal. The redundant shallow TypeBox registries and
   their runtime dependency are removed.
4. Typed content references remain part of the protocol, and their production Browser scenarios run
   in the default Browser gate.
5. Derived attachment and content stores expose authenticated read routes only. Pi externalization
   keeps its private staged publication API; the unused public attachment PUT ingress is removed.

## Consequences

- There is one production DTO set, handshake, Server pipeline, UI transport, and Browser gate.
- Compatibility failures are earlier and clearer, but an older Browser and newer Gateway cannot
  negotiate a temporary success mode.
- Pi compatibility remains deliberate: the supported adapter keeps its `PiRpcAdapter` name.
- Security and resource checks stay at the boundary guards; a new generic schema layer requires
  evidence that it replaces rather than duplicates those checks.
- The public API is smaller; every write route has a product caller.

## Rejected alternatives

- Keep 1.2 for hypothetical independently updated clients: no supported distribution or rollout
  model requires it, while every change would continue to maintain two products.
- Rename the upstream adapter `legacy`, `v1`, or `jsonl`: Pi calls the interface RPC Mode and
  exposes no protocol version, while JSONL framing belongs to the process transport rather than
  adapter identity.
- Retain shallow schemas as documentation: TypeScript DTOs, fixtures, and contextual guards already
  provide that contract, while the runtime layer added cost without removing validation work.
- Keep public PUT for future uploads: speculative API surface adds authentication, lifecycle, and
  resource obligations before a caller exists.
