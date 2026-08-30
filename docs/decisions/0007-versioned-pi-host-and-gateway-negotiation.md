# ADR 0007: Versioned Pi host and Gateway negotiation

- Status: Accepted
- Date: 2026-08-25

## Context

The distribution pins a Pi package version, but the Gateway previously preferred any `pi` found on
`PATH`, did not probe its version, and forwarded upstream TypeScript unions into the Browser
protocol. A changed nested response could therefore fail inside UI projection, while an unknown
event could put a persisted Session into a restart loop. Runtime resolution failure was also hidden
behind a speculative `pi --mode rpc` fallback and an always-healthy endpoint.

The documented Pi RPC stream has no protocol version or capability discovery command. Browser and
Gateway builds can also update independently, so WebSocket compatibility cannot be inferred from
the application package version.

## Decision

1. The normal runtime is the exact Pi dependency declared by the server distribution. The Gateway
   resolves its ESM `./rpc-entry` export relative to the server module, never from the launch cwd or
   `PATH`. `--pi-path` / `PI_PATH` is the sole expert override.
2. Every selected runtime passes a bounded `--version` probe before the Gateway accepts it. An exact
   version-to-adapter capability matrix records the current distribution version and reviewed
   candidates. Missing, failed, mismatched, unsupported, and capability-deficient runtimes use
   stable redacted diagnostics.
3. `PiHostAdapter` owns the upstream boundary, and `PiRpcAdapter` implements Pi's documented RPC
   command encoding plus complete response, event, and Extension UI decoding. Its stable diagnostic
   id is `pi-rpc`; a second adapter is introduced only if upstream publishes an evidenced,
   incompatible protocol contract.
4. Browser-facing commands, responses, events, messages, models, stats, trees, and Extension UI are
   product-owned DTOs with runtime guards and byte/item/depth limits. Provider routing data,
   response tokens, deferred handles, and diagnostic stacks are validated and removed at the
   adapter. Protocol and UI packages do not import upstream Pi packages.
5. Unknown authoritative or malformed Pi data produces one terminal `protocol_incompatible`
   diagnostic and is not auto-restarted. Only explicitly allowlisted non-authoritative frames may
   be ignored.
6. A WebSocket must begin with `client_hello` within a bounded deadline. `server_hello` reports the
   negotiated Gateway protocol major/minor, server build and epoch, selected Pi version and adapter,
   capability
   intersection, and limits. Major mismatch and protocol errors are terminal and do not reconnect.
   The same server epoch will later be carried by replay cursors under issue #17.
7. `/api/v1/health/live` reports only Gateway process liveness. `/api/v1/health/ready` and the legacy
   `/health` alias report whether a validated Pi runtime is available; startup fails fast when the
   runtime cannot be validated.

## Consequences

- A developer's unrelated global Pi can no longer silently change production behavior.
- Updating Pi requires adding captured compatibility fixtures and deliberately promoting the
  version in the matrix.
- UI and Gateway builds can reject incompatible majors and negotiate compatible minors without
  coupling to their package release numbers.
- Adapter diagnostics contain only stable codes and bounded metadata, never raw payloads,
  credentials, or runtime paths.

## Rejected alternatives

- **PATH-first resolution**: convenient but makes the installed product depend on unrelated local
  state.
- **Semver-range acceptance without fixtures**: Pi RPC exposes no capability negotiation, so a
  version range would claim compatibility that was not tested.
- **Shallow envelope validation**: defers failures into Session projections and cannot distinguish
  malformed authoritative data from safe side channels.
- **Optimistic hello fallback**: permits independently updated clients to exchange Session frames
  before compatibility is known and can create reconnect storms.

## Verification

- Resolver/probe tests cover current `0.84.2`, reviewed candidate `0.84.3`, package exports, missing
  runtimes, timeout, nonzero exit, malformed/oversized output, mismatch, and missing capabilities.
- Protocol and adapter matrices cover command-specific nested responses, events, Extension UI,
  bounded JSON, ignorable frames, and terminal authoritative failures.
- Server, UI, and Browser tests cover hello ordering, independent build versions, major mismatch,
  negotiated capabilities/limits, deadlines, and terminal no-reconnect behavior.
- Pack smoke launches installed tarballs outside the install directory with a controlled PATH,
  verifies bundled readiness metadata, and activates a Session through the real bundled Pi runtime.
