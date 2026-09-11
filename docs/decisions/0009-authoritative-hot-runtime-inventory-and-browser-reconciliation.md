# ADR 0009: Authoritative hot Runtime inventory and Browser reconciliation

- Status: Accepted
- Date: 2026-08-27

## Context

Pi JSONL and the native catalog describe durable Sessions. They cannot describe every live Pi process. A
Runtime may be running, waiting for Extension UI, or still unpersisted, and multiple such Runtimes may
belong to different Workspaces while one Browser displays only one selected Session.

A new Browser connection or hard reload therefore cannot recover live ownership from the selected pointer or
REST history. Recovering only the selected Session loses background work; subscribing to every catalog row
activates dormant history, consumes the bounded process pool, and still misses unpersisted Runtimes.

Recovery also carries identity and ordering hazards: an inventory update can race directory loading, a
Runtime can rekey while an exact baseline is built, and a failed observation must not replace a valid
channel. Parallel snapshot recovery adds backpressure; catch-up notifications need exact-once presentation.

## Decision

1. `SessionSupervisor` is the sole authority for hot Pi process ownership. It publishes a bounded
   `hot_runtime_inventory` with one `serverEpoch`, a monotonically increasing safe-integer `revision`, and
   exact Runtime entries; a revision is a full replacement, not a delta.
2. Each entry contains `{serverEpoch, workspaceId, sessionHandle, generation, state}`. State is one of
   `starting`, `idle`, `running`, or `waiting_ui`. Pending identities, crashed Runtimes, and dormant
   Sessions are excluded. The inventory is ephemeral and never becomes durable Session truth.
3. Inventory is negotiated through the `session.hot_runtime_inventory` capability. The Browser and Gateway
   use the shared required-capability and frame-limit negotiation. After a successful hello, the Bridge
   sends the current full inventory; later Supervisor revisions fan out to every negotiated connection. An
   incompatible version, missing required capability, or insufficient frame ceiling is terminal for the
   Browser connection.
4. `session_subscribe.expectedHotRuntime` requests exact, only-if-hot observation. Its complete identity
   must match the outer handle and a current live process observation. The Supervisor captures the process
   incarnation, obtains replay or snapshot, and revalidates the observation immediately before the Bridge
   exposes the baseline. It never activates a dormant Session or silently falls back to ordinary subscribe.
5. Exact catch-up is transactional. Success installs the authoritative runtime baseline, replay or snapshot,
   fresh lease snapshot, and contiguous buffered suffix before becoming live; failure preserves an existing
   live subscription, catch-up, and lease. A duplicate exact request for an identity already live on that
   connection is a no-op. Each connection has a bounded exact operation admission limit.
6. Inventory publication is fenced when a catch-up contains a pending identity migration. A connection
   retains only the newest deferred full replacement. A successful child transition publishes rekey before
   the canonical child inventory and staged child frames. If staged commit fails after identity commit,
   observers receive rekey, inventory removal, and one terminal Runtime result, while the deferred staged
   frames remain hidden.
7. Browser bootstrap waits for the initial inventory before reconciling the REST directory or creating a
   Session, and the directory load is fenced to the same online Gateway epoch. Revision changes within that
   epoch apply independently without restarting bootstrap; an epoch or connection change retries the
   boundary. Automatic initial creation waits while a relevant hot identity has unknown persistence, and a
   matching degraded, manual-only recovery ends that wait without creating a Session, while an explicit New
   Session remains available. Automatic and explicit creation share one in-flight create operation per
   Workspace.
8. The Browser treats every inventory entry as a desired background observer, tracked per handle with
   single-flight exact requests and globally serialized baselines, so a stale attempt cannot clear a newer
   desired identity. A matching full-identity degraded Session stays manual-only across reconnects without
   blocking other hot Sessions, while a changed identity is eligible for normal recovery.
9. Every authoritative hot channel is pinned above the ordinary subscription LRU target. The selected
   Session claims controller capability only after an authoritative baseline and a fresh matching lease
   snapshot, and background hot Sessions stay observers.
10. The Session directory merges durable catalog rows and the full-replacement hot overlay by handle, so
    unpersisted hot Sessions appear without duplicating persisted rows. Loaded Workspace counts use the merged
    rows; unloaded counts keep the known durable total and add only entries known to be unpersisted. A catalog
    match proves persistence, while catalog absence leaves it unproven because the directory may filter a
    materialized empty Session. Runtime persistence evidence is accepted only when its complete
    `{serverEpoch, workspaceId, sessionHandle, generation}` identity matches the current inventory.
11. Transient cleanup is provenance-sensitive. Only an unpersisted Session created by the current Browser
    may use transient abandon after exact baseline, lease, controller, idle, and untouched checks succeed. A
    recovered hot-only Session may be released but is never inferred safe to abandon. Inventory removal,
    rekey, and stop do not auto-select or activate dormant history.
12. Snapshots continue to exclude `notify`. Exact catch-up separately journals fresh notifications produced
    inside its transaction. The Browser delivers them once under a bounded full-identity dedupe key, even
    when their sequence is at or below snapshot `asOfSeq`.

## Consequences

A new Browser connection can recover all live work, including background and unpersisted Sessions, without
starting dormant Pi processes; hard reload keeps selection as a view concern while the inventory restores
every independent hot channel.

The Browser may hold more than the ordinary subscription target because all authoritative hot Runtimes are
pinned. Exact baselines are serialized, so recovery latency grows with the number and size of hot Sessions,
while one legal large snapshot cannot multiply outbound pressure.

Hot-only Sidebar rows disappear with their Runtime unless Pi materialized durable JSONL history. No
new database or recovery log is introduced.

## Rejected alternatives

- Infer hot ownership from REST history: this misses unpersisted Runtimes and cannot distinguish dormant
  files from live processes.
- Recover only the selected Session: background streaming, tools, queues, and Extension UI would be lost
  after reload.
- Ordinary-subscribe every catalog row: this activates dormant history and violates bounded pool intent.
- Fall back to activation on mismatch: a stale inventory could start or attach to the wrong Runtime
  incarnation.
- Publish inventory deltas: a lost update or late listener could leave an incomplete desired set.
- Recover exact snapshots in parallel without admission: legal oversized snapshots could exhaust
  per-connection buffering.
- Persist the hot inventory: this would create a second Session ownership database beside Pi JSONL.
- Let recovered hot-only rows use transient abandon: the Browser does not own their creation provenance and
  cannot prove they are safe to forget.
