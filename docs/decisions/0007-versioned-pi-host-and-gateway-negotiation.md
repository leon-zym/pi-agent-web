# ADR 0007: Versioned Pi host and Gateway negotiation

- Status: Partly superseded by ADR 0013 and ADR 0015
- Date: 2026-08-25

The Pi host and runtime-resolution decisions remain active. The current single-version
Browser/Gateway contract lives in [Protocol](../protocol.md).

## Context

The distribution pins a Pi package version, but the Gateway preferred any `pi` on `PATH`, never
probed its version, and forwarded upstream TypeScript unions into the Browser protocol. A changed
nested response could fail inside UI projection; an unknown event could put a persisted Session into
a restart loop. Resolution failure hid behind a speculative `pi --mode rpc` fallback and an
always-healthy endpoint. Pi RPC advertises no version or capability discovery, and Browser and
Gateway builds update independently, so WebSocket compatibility cannot follow from the application
package version.

## Decision

1. The normal runtime is the exact Pi dependency declared by the server distribution. The Gateway
   resolves its ESM `./rpc-entry` export relative to the server module, never from the launch cwd or
   `PATH`. `--pi-path` / `PI_PATH` is the sole expert override.
2. Every selected runtime passes a bounded `--version` probe before the Gateway accepts it. An exact
   version-to-adapter capability matrix gates acceptance. Missing, failed, mismatched, unsupported,
   and capability-deficient runtimes produce a stable redacted diagnostic.
3. `PiHostAdapter` owns the upstream boundary, and `PiRpcAdapter` implements Pi's documented RPC
   command encoding plus complete response, event, and Extension UI decoding. A second adapter is
   introduced only if upstream publishes an evidenced, incompatible protocol contract.
4. Browser-facing payload families are product-owned DTOs with runtime guards and byte/item/depth
   limits; upstream-only data is validated and removed at the adapter. Protocol and UI packages do
   not import upstream Pi packages.
5. Unknown authoritative or malformed Pi data produces one terminal `protocol_incompatible`
   diagnostic and is not auto-restarted; only allowlisted non-authoritative frames may be ignored.
6. A WebSocket begins with `client_hello` within a bounded deadline; `server_hello` completes
   negotiation before Session traffic. Version mismatch and protocol errors are terminal and do not
   reconnect.
7. `/api/v1/health/live` reports Gateway process liveness; `/api/v1/health/ready` and the legacy
   `/health` alias report whether a validated Pi runtime is available. Startup fails fast when
   validation fails.

## Consequences

- A developer's unrelated global Pi can no longer silently change production behavior.
- Updating Pi requires captured compatibility fixtures and deliberate matrix promotion.
- Adapter diagnostics contain only stable codes and bounded metadata, never raw payloads,
  credentials, or runtime paths.
- The Browser and Gateway reject incompatible peers instead of negotiating a compatibility window.
  Resolver, protocol, and packaged-runtime tests cover runtime validation and terminal frames.

## Rejected alternatives

- **PATH-first resolution**: convenient, but the installed product then depends on unrelated local
  state.
- **Semver-range acceptance without fixtures**: a range would claim untested compatibility.
- **Shallow envelope validation**: defers failures into Session projections and cannot distinguish
  malformed authoritative data from safe side channels.
- **Optimistic hello fallback**: peers exchange frames before compatibility, risking reconnects.
