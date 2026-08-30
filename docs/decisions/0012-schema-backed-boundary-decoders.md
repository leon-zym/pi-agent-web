# ADR 0012: Schema-backed boundary decoders for Pi compatibility

- Status: Accepted
- Date: 2026-08-30

## Context

Pi RPC wire types and Browser/Gateway DTOs evolve at different speeds. The project already has
hand-written guards for UTF-8 accounting, bounded traversal, epoch ownership, payload leases,
normalization, and redaction. Replacing those guards with one generic validator would either lose
those security decisions or duplicate the same nested traversal.

## Decision

1. Keep two explicit runtime registries: `PI_WIRE_RUNTIME_SCHEMA_REGISTRY` for shallow Pi-owned
   envelopes and `PRODUCT_RUNTIME_SCHEMA_REGISTRY` for product-owned envelopes. Their stable ids are
   diagnostic and fixture identifiers, not wire protocol versions.
2. Use TypeBox declarations as the bounded structural gate. The existing semantic guards remain the
   authority for discriminants, nested data, UTF-8 bytes, item/depth limits, identity, leases, and
   redaction. A schema failure is redacted to a stable `schema_invalid` result; raw validator details
   never cross the boundary.
3. Keep upstream Pi imports type-only and Server-local. `satisfies`/conditional type assertions in
   the adapter conformance test make removal of a product-relevant upstream command, event, or
   Extension method fail before runtime. Product DTOs and the Browser protocol remain independent.
4. Compatibility remains exact-version and fixture-driven. A candidate may be exercised through an
   explicit `PI_PATH`, but bundled resolution rejects it until its matrix status is promoted to
   `current`. The compatibility workflow runs the fixture/conformance lane and schema benchmark;
   repository CI separately runs the packaged empty-PATH smoke.

## Consequences

- Pi upgrades have one visible fixture and conformance surface without a semver-range claim.
- Fail-closed resource and identity policy stays in the code that understands its context.
- The shallow registry adds a measurable browser dependency and must remain within the documented
  same-host benchmark budget and existing UI bundle budget.

## Rejected alternatives

- **One universal schema for Pi and product DTOs**: conflates ownership and would make Pi lookalikes
  authoritative.
- **A blanket Zod/TypeBox rewrite of all guards**: duplicates bounded traversal and risks dropping
  contextual or UTF-8 checks.
- **Accepting candidate bundled versions automatically**: makes an unpromoted fixture review a
  production compatibility claim.
- **Runtime latest or semver ranges**: the legacy Pi RPC protocol has no capability negotiation that
  could justify an untested range.

## Verification

- Protocol unit tests cover registry separation, structural-before-semantic ordering, redacted
  diagnostics, immutable lookup, and revoked/proxy fail-closed behavior.
- Server tests cover current/candidate fixtures, malformed frames, exact resolver promotion, and
  type-only upstream conformance.
- `pnpm test:compat`, `pnpm --filter @pi-agent-web/protocol bench:schema`, existing Gateway
  negotiation integration tests, packaged Browser E2E, and `pnpm test:pack` form the upgrade lane.
