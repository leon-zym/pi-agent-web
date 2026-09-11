# UI and UX

The workbench states which Workspace and Session is visible, whether that Session is observing, controlled,
running, recovering, or blocked, and whether an action affects only the visible Session or durable Pi history.

## Workspace and Session navigation

The sidebar groups native Sessions by canonical Workspace. Expanding a Workspace keeps the current
selection; selecting changes only the visible view. Background Sessions keep ingesting and show
running or attention state.

Session deletion is a destructive action with confirmation and exact-control checks, and it names
what moves to recoverable trash. Removing a Workspace keeps Pi history and Sessions. Stale identity,
missing control, running work, or filesystem verification failure blocks it with a next action.

A fresh Browser profile opens the most recently used Workspace; an untouched pending Session may be
abandoned without durable history. New, forked, and cloned Sessions move from pending to canonical
identity. A rekey preserves the draft, projection, selection, and control, and keeps the parent
available.

## Connection and control

Connection state is global; subscription, controller ownership, generation, recovery, and errors are
displayed per Session.

Read-only observers follow a Session without claiming control. When another Browser owns control,
the UI shows a per-Session view-only state that explains the conflict and offers `Take over` when
the lease permits. That confirmation names the Session, keeps the Agent running, makes the previous
page read-only, and preserves admitted work; an uncertain mutation is never retried silently.

A command reports completion after its result is visible. Disconnect, identity change, stale fence,
or sequence uncertainty keeps the draft when safe and shows actionable recovery. After Gateway
restart, Session authority recovers without a reload; mutations wait, and the draft stays available.

Terminal protocol incompatibility stays terminal.

Subscription pressure and rejection are distinct states, and retry is offered only for a retryable
rejection once transport is usable.

## Conversation

Streaming text, thinking, tool calls, and structural events keep their source order.

- Thinking is visible while active and settles into an in-place disclosure. A settled disclosure
  includes a useful teaser and preserves keyboard state.
- Tool activity groups after settlement without hiding failure, duration, or the active step.
- Settled Markdown renders GFM, code, tables, and links.
- Untrusted filenames and labels render as text, never markup.
- Windowing preserves reading position, selection, focus, and nearby context.

Coalescing never crosses a structural, settled, error, rekey, or dialog-close boundary. The details
surface holds inspection, conversation tree, and diagnostics; closing restores position and focus.

## Composer

The composer belongs to the visible Session: draft text, attachments, submit state, model, thinking
level, slash commands, and input history stay scoped to that Session.

- In compact mode, `Enter` submits an idle prompt or steers a running Session, `Shift+Enter` inserts
  a newline, and `Cmd/Ctrl+Enter` queues a follow-up while running.
- In expanded mode, `Enter` inserts a newline and `Cmd/Ctrl+Enter` submits; while running, the
  Steer/Follow-up selection determines delivery, and composition input does not submit.
- Expanded editing restores focus on exit; input history never steals caret movement.
- Slash and skill commands stay atomic while composing and deleting.
- File mentions use the selected Workspace and stay keyboard accessible; results show type, size,
  estimated context cost, policy flags, and a safe preview. Risky content requires confirmation;
  blocked, unavailable, truncated, or changed files stay visible with a reason.
- Captured references are Session-scoped attachments; navigation, rekey, failure, and removal never
  leak bytes or discard unrelated draft work.
- Image-only prompts are valid, and failed submission preserves text and attachments.
- Steering, follow-up, abort, and queued state are explicit, never inferred from optimistic UI.

Model and thinking controls reflect the captured Session, not a global preference: loads apply only
while that identity is current, and unsupported choices are disabled or explained. Usage indicators
show remaining capacity without false precision; the context meter keeps send and stop visible.

## Large history and referenced content

Persisted history loads page by page. Loading older messages preserves the visible anchor and does
not block live publication for any Session; an in-flight older-page load completes for its captured
Session while another is visible, keeping the other draft.

Large tool, message, and Extension values may stay typed references until a visible consumer needs
them. Materialization shows a restrained loading state, is cancellable, applies to the captured
Session only, and resyncs once before showing an error. Raster references render from authenticated
same-origin URLs; text and JSON use their typed slot.

## Extension UI

Ordered Extension requests belong to one Session; dialogs, questions, editor text, widgets,
notifications, and status updates keep that identity across navigation.

Blocking requests stay discoverable, and a minimized request uses a visible dock. An observer still
sees the pending request and its deadline read-only, with the same Session-scoped takeover action;
only the current controller can answer or cancel it. Question choices, free text, confirmation,
cancel, and keyboard focus are accessible.
Submitting, replacing, aborting, or settling a request closes its obsolete UI synchronously.

## Responsive behavior

- No critical action is reachable only through hover or clipped overflow.
- Responsive decisions use viewport width and input characteristics together.
- Touch targets stay usable on coarse pointers at every width.
- The software keyboard must not hide the composer or shift critical controls beyond reach.

## Accessibility and feedback

- Every control is keyboard reachable and shows `:focus-visible` and an accessible name.
- Dialogs trap focus, expose a name and description, and restore focus on close.
- Dynamic status uses restrained live regions without announcing every streamed token.
- Audio and tab-title feedback stay user-controlled, synchronized across tabs, and supplemental.

Copy goes through `packages/ui/src/lib/i18n`; `zh-CN` is default and `en` has the same key shape.

## Acceptance baseline

Changes to navigation, conversation, composer, control, recovery, Extension UI, or responsive layout
need a deterministic Browser regression ([acceptance matrix](design.md#visual-acceptance-matrix),
[browser gate](development.md#deterministic-browser-e2e)).
