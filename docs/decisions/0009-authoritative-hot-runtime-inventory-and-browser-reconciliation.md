# ADR 0009: Authoritative hot Runtime inventory and Browser reconciliation

- Status: Accepted
- Date: 2026-08-27

## Context

Pi JSONL and the native catalog describe durable Sessions. They cannot describe every live Pi
process. A Runtime may be running, waiting for Extension UI, or still unpersisted, and multiple such
Runtimes may belong to different Workspaces while one Browser displays only one selected Session.

A new Browser connection or hard reload therefore cannot recover live ownership from the selected
pointer or REST history. Recovering only the selected Session loses background work. Subscribing to
every catalog row activates dormant history, consumes the bounded process pool, and still misses
unpersisted Runtimes. Persisting a separate Web inventory would duplicate Pi's Session database.

Recovery also has identity and ordering hazards. An inventory update can race initial directory
loading, a Runtime can rekey while an exact baseline is being built, and a failed observation must
not replace a valid existing channel. Large legal snapshots make unconstrained parallel recovery a
backpressure risk. Notifications produced inside snapshot catch-up need exact-once presentation even
though they are intentionally absent from snapshots.

## Decision

1. `SessionSupervisor` is the sole authority for hot Pi process ownership. It publishes a bounded
   `hot_runtime_inventory` with one `serverEpoch`, a monotonically increasing safe-integer
   `revision`, and exact Runtime entries. A revision is a full replacement, not a delta.
2. Each entry contains `{serverEpoch, workspaceId, sessionHandle, generation, state}`. State is one
   of `starting`, `idle`, `running`, or `waiting_ui`. Pending identities, crashed Runtimes, and
   dormant Sessions are excluded. The inventory is ephemeral and never becomes durable Session
   truth.
3. Inventory is negotiated through the `session.hot_runtime_inventory` capability. The Browser and
   Gateway use the shared required-capability and frame-limit negotiation. After a successful hello,
   the Bridge sends the current full inventory. Later Supervisor revisions fan out to every
   negotiated connection. An incompatible version, missing required capability, or insufficient
   frame ceiling is terminal for the Browser connection.
4. `session_subscribe.expectedHotRuntime` requests exact, only-if-hot observation. Its complete
   identity must match the outer handle and a current live process observation. The Supervisor
   captures the process incarnation, obtains replay or snapshot, and revalidates the observation
   immediately before the Bridge exposes the baseline. It never activates a dormant Session or
   silently falls back to ordinary subscribe.
5. Exact catch-up is transactional. Success installs the authoritative runtime baseline, replay or
   snapshot, fresh lease snapshot, and contiguous buffered suffix before becoming live. Failure
   preserves an existing live subscription, catch-up, and lease. A duplicate exact request for an
   identity already live on that connection is a silent no-op. Each connection has a bounded exact
   operation admission limit.
6. Inventory publication is fenced when a catch-up contains a pending identity migration. A
   connection retains only the newest deferred full replacement. A successful child transition
   publishes rekey before the canonical child inventory and staged child frames. If staged commit
   fails after identity commit, observers receive rekey, inventory removal, and one terminal Runtime
   result, while the deferred staged frames remain hidden.
7. Browser bootstrap waits for the initial inventory before reconciling the REST directory or
   creating a Session. The directory load is fenced to the same online Gateway epoch. Revision
   changes within that epoch do not restart bootstrap; the newest same-epoch replacement is applied
   independently. An epoch or connection change retries the bootstrap boundary. Automatic initial
   creation waits while any relevant hot identity has unknown persistence. A matching degraded,
   manual-only recovery ends that wait without creating a Session, while an explicit New Session
   remains available. Automatic and explicit creation share one in-flight create operation per
   Workspace within one Browser.
8. The Browser treats every inventory entry as a desired background observer. Desired identities
   are tracked per handle, exact requests are single-flight per handle, and fresh exact baseline
   recovery is globally serialized. A stale attempt cannot clear a newer desired identity. A
   matching full-identity degraded Session remains manual-only across reconnects and does not block
   recovery of other hot Sessions. A changed identity is eligible for normal recovery.
9. Every authoritative hot channel is pinned above the ordinary subscription LRU target. The
   selected Session claims controller capability only after an authoritative baseline and a fresh
   matching lease snapshot. Background hot Sessions remain observers and continue projection.
10. The Session directory merges durable catalog rows and the full-replacement hot overlay by
    handle. This exposes multiple unpersisted hot Sessions without duplicating persisted rows.
    Loaded Workspace counts use the merged rows. Unloaded counts preserve the known durable total
    and add only entries known to be unpersisted. A catalog match proves persistence, but catalog
    absence does not prove that a Session is unpersisted because the directory may filter a
    materialized empty Session. Runtime persistence evidence is accepted only when its complete
    `{serverEpoch, workspaceId, sessionHandle, generation}` identity matches the current inventory;
    otherwise its persistence remains unknown.
11. Transient cleanup is provenance-sensitive. Only an unpersisted Session created by the current
    Browser may use transient abandon after exact baseline, lease, controller, idle, and untouched
    checks succeed. A recovered hot-only Session may be released but is never inferred safe to
    abandon. Inventory removal, rekey, and stop do not auto-select or activate dormant history.
12. Snapshots continue to exclude `notify`. Exact catch-up separately journals fresh notifications
    produced inside its transaction. The Browser delivers them once under a bounded full-identity
    dedupe key, even when their sequence is at or below snapshot `asOfSeq`. Notification delivery
    does not advance, repair, or roll back the projection waterline.

## Consequences

A new Browser connection can recover all live work, including background and unpersisted Sessions,
without starting dormant Pi processes. Hard reload keeps selection as a view concern while the
inventory restores every independent hot channel.

The Browser may hold more than the ordinary subscription target because all authoritative hot
Runtimes are pinned. Exact baselines are serialized, so recovery latency grows with the number and
size of hot Sessions, but one legal large snapshot cannot multiply outbound pressure.

Hot-only Sidebar rows are intentionally ephemeral. They disappear when the authoritative full
replacement removes their Runtime unless Pi has materialized durable JSONL history. No new database
or recovery log is introduced.

## Rejected alternatives

- Infer hot ownership from REST history: this misses unpersisted Runtimes and cannot distinguish
  dormant files from live processes.
- Recover only the selected Session: background streaming, tools, queues, and Extension UI would be
  lost after reload.
- Ordinary-subscribe every catalog row: this activates dormant history and violates bounded pool
  intent.
- Fall back to activation when exact identity mismatches: a stale inventory could start or attach to
  the wrong Runtime incarnation.
- Publish inventory deltas: a lost update or late listener could leave an incomplete desired set.
- Recover exact snapshots in parallel without admission: several legal oversized snapshots could
  exhaust per-connection buffering.
- Persist the hot inventory: this would create a second Session ownership database beside Pi JSONL.
- Let recovered hot-only rows use transient abandon: the Browser does not own their creation
  provenance and cannot prove they are safe to forget.

## Verification

- Protocol tests cover capability negotiation, strict inventory guards, full identities, unique
  handles, item and byte ceilings, and exact subscribe shape.
- Supervisor and Bridge tests cover initial and revised inventory publication, exact observation
  races, duplicate requests, transaction rollback, backpressure, rekey ordering, disconnect cleanup,
  and notification journal transfer.
- UI tests cover bootstrap fencing, stale revisions, multi-Workspace overlays, exact recovery
  serialization, LRU pinning, degraded manual recovery, rekey and removal, lease-gated claim,
  transient provenance, merged counts, and bounded notification dedupe.
- Packaged Browser tests keep seven distinct Runtimes hot, including multiple running unpersisted
  Sessions, while a dormant JSONL remains inactive. They verify hard reload and a new Browser
  context restore all hot rows and projections, preserve observer and controller boundaries, avoid
  automatic Session creation, and deliver the Extension response exactly once.
