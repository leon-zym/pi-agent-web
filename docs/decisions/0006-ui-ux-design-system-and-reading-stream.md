# ADR 0006: Reading continuity and background Session liveness

- Status: Accepted (amended 2026-08-29)
- Date: 2026-08-22

[UI and UX](../ui-ux.md) owns current interaction behavior; [Design](../design.md) owns visual
acceptance and code-owned token values. [Architecture](../architecture.md#channels-control-and-ordering)
owns subscription retention and Session lifecycle. This record preserves the reasons for those
choices, not component dimensions, animation recipes, or a second acceptance checklist.

## Context

Long thinking output and sequential tool calls compete with assistant prose for reading space.
Collapsing active work too early hides liveness, while moving every detail to another panel disrupts
reading. A blocking approval can require inspecting the conversation that a full-screen dialog
covers. Meanwhile, evicting subscriptions by recency alone can disconnect ongoing background work.

## Decision

- Keep thinking disclosure in place, with optional full-height inspection. Active output remains
  visible; settled output can collapse to a teaser without moving the reading axis.
- Keep active tool progress visible and group settled, non-interactive calls. Reserve prominent
  interaction cards for blocking requests. Diff gutters and clean copying let users inspect code
  changes without copying presentation markers.
- Keep one lightweight outline tick per User Turn. Revealing an unmounted turn precedes scrolling
  to it; expensive Turn DOM is bounded independently by [ADR 0005](0005-conversation-rendering.md).
  The outline yields space rather than covering content or controls.
- Provide deliberate multiline composing with explicit steering/follow-up delivery. Session-scoped
  input history follows exact rekey. Keyboard behavior belongs in [Composer](../ui-ux.md#composer),
  rather than being inferred from the panel's height.
- Allow blocking Extension requests to minimize into a discoverable dock while their deadlines and
  channels remain active. Keyboard choices and write-in text retain the single-value select response
  contract. Already-aborted or expired responses are soft no-ops, not repeated intrusive errors.
- Adapt the shell to the software keyboard and coarse pointers. Optional audio, title, and favicon
  feedback supplements visible state rather than becoming the only signal.
- Evict only eligible inactive subscriptions. Running or otherwise protected work can exceed the
  soft admission target; this preserves background progress without asserting a total heap bound.
- Converge abandoned incomplete tool calls to `interrupted`, never fabricated success. Reconcile
  optimistic user messages with authoritative starts using text/attachment shape and FIFO ordering
  so the optimistic display does not become a second message authority.

## Consequences

Users can inspect details and approval context without leaving the conversation. Settled grouping
reduces clutter while active work stays visible. Subscription retention trades a strict Browser
count cap for protected-work continuity; shared Gateway admission and resource limits still apply.

## Rejected alternatives

- Force thinking into the details panel: disrupts the central reading focus.
- Collapse tools while streaming: hides progress and can make execution appear stalled.
- Leave subscriptions unbounded: retains avoidable inactive state and increases backpressure.
- Evict every least-recently-used Session: can drop running work and completion feedback.
- Require full-screen approval dialogs: prevents inspection of the code or logs needing approval.

## Verification rationale

Projection tests need to distinguish interrupted tools and optimistic reconciliation from successful
execution. Browser regressions must exercise reading position, focus, disclosure, approval inspection,
and background liveness. Timing or finite retained-history observations do not establish a total
Browser-memory guarantee. [Development](../development.md) owns executable verification layers.
