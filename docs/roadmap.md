# Roadmap and recovery status

This roadmap records the outcome of the architecture recovery milestone and routes deliberate
follow-up work to testable GitHub Issues. It is not a release promise or schedule.

## Recovered foundation

The previous Workspace-owned process design has been replaced by the accepted contracts in
`docs/decisions/`:

- Pi JSONL is durable truth; Workspace and Session identity are native projections.
- Each hot Session owns at most one Pi process; dormant history owns none; the pool is bounded.
- One authenticated socket multiplexes isolated Session subscriptions, leases, generations,
  fencing tokens, replay/resync, and Extension UI.
- Session deletion is fenced, identity-bound, and recoverable.
- Background Session publication is bounded and fair; hidden tabs do not depend on rAF.

These are current product invariants, not roadmap items.

## Post-MVP queue assessment

### 1. Interaction alignment

Completed in this milestone:

- Slash menu ArrowUp/ArrowDown cycling and highlighted Tab/Enter/click completion into an atomic,
  removable command Tag; Space remains argument input and unknown commands never silently become
  prompts.
- Semantic edit/diff presentation instead of summary-only tool rows.
- Model/thinking copy explains that a change applies to the next request; the current Turn is stable.
- Keyboard/unit regressions and packaged-browser layout checks.

Deferred: a generic, Session-scoped popup picker needs a real client-command contract rather than a
one-off menu. Tracked in [#1](https://github.com/leon-zym/pi-agent-web/issues/1).

### 2. Session control experience

Completed: observer/controller state is scoped to one Session, observers remain live and read-only,
and the UI explains that after closing the controlling tab the user reselects that Session to claim
normally. One tab can control multiple Sessions, and unrelated Sessions do not share a lease.

Deferred: explicit forced takeover needs atomic fencing and running/dialog semantics before it is safe.
Tracked in [#2](https://github.com/leon-zym/pi-agent-web/issues/2).

### 3. Real Pi compatibility

Completed opt-in coverage: native Session creation, model/thinking selection, two concurrent Sessions
on one socket, image-only multimodal input, content isolation, streaming follow-up, abort, clone/rekey,
parent/child history isolation, tree, stats, and command directory. The suite uses temporary roots and
does not scan or modify existing history.

Deferred: a comprehensive real-Pi Extension UI test extension and two-observer matrix is tracked in
[#9](https://github.com/leon-zym/pi-agent-web/issues/9).

### 4. Conversation performance and narrow screens

Completed:

- Per-Session compatible-delta batching with visible rAF, hidden bounded timer, immediate structural
  boundaries, byte/run ceilings, and multi-Session fairness.
- Stable/memoized conversation nodes, indexed tool results, and a lazy settled-Markdown chunk.
- Packaged 375×812 assertions for viewport and composer-control bounds; compact two-line Session header,
  contextual Details, explicit unavailable context, and no-model state.
- A measured Markstream React 2.0.0 evaluation. It is not production-equivalent today; ADR 0005 records
  the no-go decision rather than hiding the remaining large-settlement cost.

Deferred: measure the 64 KiB settled-Markdown browser mount/layout/paint path, then eliminate any
confirmed long task behind equivalence gates in
[#7](https://github.com/leon-zym/pi-agent-web/issues/7). Very-large projection resync beyond the bounded
snapshot line is separate protocol work in [#8](https://github.com/leon-zym/pi-agent-web/issues/8).

### 5. Product expansion

The following do not enter the sidebar or hot event path until their data, privacy, permission, and
performance contracts are approved:

- full-text native Session search: [#4](https://github.com/leon-zym/pi-agent-web/issues/4);
- bounded Agent trajectory view: [#5](https://github.com/leon-zym/pi-agent-web/issues/5);
- Workspace-scoped `@file` / filesystem browsing: [#6](https://github.com/leon-zym/pi-agent-web/issues/6).

Recoverable deletion currently guarantees file preservation but not a complete restore/purge product.
That lifecycle is tracked separately in [#3](https://github.com/leon-zym/pi-agent-web/issues/3).

Pi currently exposes a write command but no authoritative RPC read for auto-retry. The UI does not
fabricate a default switch value; a read/write-consistent settings surface is tracked in
[#10](https://github.com/leon-zym/pi-agent-web/issues/10).

GitHub private vulnerability reporting and vulnerability alerts require a repository administrator
to enable them before a useful `SECURITY.md` can name a working confidential channel. That release
hygiene task is tracked in [#11](https://github.com/leon-zym/pi-agent-web/issues/11); an unusable
template is intentionally not presented as a security process.

The credential-free CI workflow is tracked in this repository, but enforcing its jobs on `main`
requires an external GitHub ruleset. Required checks, force-push protection, and the temporary
single-maintainer review policy are tracked in [#12](https://github.com/leon-zym/pi-agent-web/issues/12).

## Issue acceptance rule

Every product implementation Issue states a user problem, observable success conditions, non-goals,
security/performance boundaries, and the required automated test layer as applicable. Repository-management
Issues state the independently verifiable external setting or policy. New work must not weaken the Session
identity, fencing, boundedness, or local-only contracts to make a UI path easier.
