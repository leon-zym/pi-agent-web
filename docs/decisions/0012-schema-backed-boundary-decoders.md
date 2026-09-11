# ADR 0012: Schema-backed boundary decoders for Pi compatibility

- Status: Superseded by [ADR 0013](0013-canonical-gateway-and-explicit-boundaries.md)
- Date: 2026-08-30

## Context

Pi RPC wire types and Browser/Gateway DTOs evolve at different speeds. The project already has
hand-written guards for UTF-8 accounting, bounded traversal, epoch ownership, payload leases,
normalization, and redaction. Replacing those guards with one generic validator would either lose
those security decisions or duplicate the same nested traversal.

## Decision

The original design separated shallow Pi and product envelope registries and used TypeBox for
structural checks before contextual guards. Registry identifiers were diagnostic and fixture
identifiers, not wire versions. The intent was to detect upstream type drift while keeping resource,
identity, ownership, and redaction decisions in the guards that understood them.

Pi imports stayed type-only and Server-local, and fixture review remained necessary before an exact
candidate version could become the bundled runtime. Structural schemas did not authorize a semver
range or make upstream types part of the Browser contract.

## Consequences

The shallow registries added a Browser dependency and repeated structural traversal without
replacing contextual validation. [ADR 0013](0013-canonical-gateway-and-explicit-boundaries.md)
records their removal. [Protocol](../protocol.md#pi-rpc) owns current Pi compatibility and decoding
semantics; [Development](../development.md#verification-layers) owns the verification lanes.

Upstream conformance and product-boundary safety require separate evidence: a structural pass cannot
replace malformed-frame, resource, identity, redaction, or installed-runtime checks.

## Rejected alternatives

- **One universal schema for Pi and product DTOs**: conflates ownership and would make Pi lookalikes
  authoritative.
- **A blanket Zod/TypeBox rewrite of all guards**: duplicates bounded traversal and risks dropping
  contextual or UTF-8 checks.
- **Accepting candidate bundled versions automatically**: makes an unpromoted fixture review a
  production compatibility claim.
- **Runtime latest or semver ranges**: the legacy Pi RPC protocol has no capability negotiation that
  could justify an untested range.
