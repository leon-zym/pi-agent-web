# UI and UX

This document defines user-visible behavior. [Design](design.md) defines the visual language;
[Architecture](architecture.md) defines state ownership and recovery.

## Product experience

Pi Agent Web is a focused local workbench, not a dashboard. The conversation is the primary surface.
Navigation, status, controls, and inspection remain available without competing with the reading
stream.

The UI must make three facts clear:

1. which Workspace and Session is visible;
2. whether that Session is observing, controlled, running, recovering, or blocked;
3. whether an action affects only the visible Session or persistent Pi history.

## Workspace and Session navigation

The sidebar groups native Sessions by canonical Workspace. Expanding a Workspace does not change the
active Session. Selecting a Session changes only the visible view; subscribed background Sessions
continue ingesting and expose restrained running or attention state.

Adding a Workspace stores a discovery hint. Removing it does not delete Pi history. Session deletion
is a separately labelled destructive action with confirmation and exact-control checks.

On a fresh Browser profile, the workbench opens a new Session in the most recently used Workspace
when possible. An untouched pending Session may be abandoned. It must not create empty durable
history merely because it was selected.

New, forked, and cloned Sessions can change from pending to canonical identity. The UI preserves the
draft, projection, control, and selection through an exact rekey and keeps the parent independently
available.

## Connection and control

One connection carries all active Session channels. Connection state is global; subscription,
controller ownership, generation, recovery, and errors are displayed per Session.

Read-only observers can inspect and follow a Session without claiming control. A mutation claims or
uses the current controller lease and exact fence. If another Browser owns control, the UI explains
the conflict and offers an explicit claim path. It never retries an uncertain mutation silently.

Command completion waits for both the response and its projection barrier. Disconnect, identity
change, stale fence, or sequence uncertainty preserves the user's draft when safe and presents an
actionable recovery state.

## Conversation

Assistant output uses a quiet reading column rather than chat bubbles. User messages remain visually
distinct. Streaming text, thinking, tool calls, and structural events keep their source order.

- Thinking is visible while active and settles into an in-place disclosure with a useful teaser.
- Related tool activity can group after settlement without hiding failure, duration, or the active
  step.
- Diffs expose line status and clean-copy behavior. Untrusted filenames and labels are rendered as
  text, never markup.
- Settled Markdown supports GFM, code, tables, and links within bounded rendering fallbacks.
- A conversation outline helps navigate long threads without covering content or critical controls.
- Windowing may reduce DOM cost but must preserve reading position, selection, focus, and nearby
  context.

Coalescing is a scheduling optimization only. It must not reorder content or cross a structural,
settled, error, rekey, or dialog-close boundary.

## Composer

The composer is persistent and belongs to the visible Session. Draft text, attachments, submit
state, model, thinking level, slash commands, and input history do not leak between Sessions.

Required behavior:

- `Enter` submits when the current input mode permits; `Shift+Enter` inserts a newline.
- Expanded editing provides a deliberate multiline mode and restores focus on exit.
- Input-history navigation runs only when it does not steal normal caret movement.
- Slash and skill commands remain atomic while composing and deleting.
- Workspace file mentions use the selected Workspace and remain keyboard accessible.
- File mention results show type, size, estimated context cost, policy flags, and a bounded safe
  preview. Risky content requires confirmation; blocked, unavailable, truncated, and changed files
  remain visible with a reason.
- Captured references are Session-scoped attachments. Navigation, rekey, failure, and removal cannot
  leak bytes across Sessions or discard unrelated draft work.
- Image-only prompts are valid; failed submission preserves text and attachments.
- Steering, follow-up, abort, and queued state are explicit rather than inferred from optimistic UI.

Touch targets stay usable on coarse pointers even at wide viewport widths. The software keyboard
must not hide the composer or shift critical controls beyond reach.

## Model, thinking, and usage

Model and thinking controls reflect the captured Session, not a global preference. Async loads and
updates apply only if that Session identity is still current. Unsupported choices are disabled or
explained rather than silently substituted.

Usage and context indicators communicate remaining capacity without false precision. The context
meter remains reachable at narrow widths and does not conceal the primary send or stop action.

## Large history and referenced content

Persisted history loads in bounded pages. Loading older messages preserves the visible anchor and
does not block live publication for the same or another Session.

Large tool, message, and Extension values may remain typed references until a visible consumer needs
them. Materialization shows a restrained loading state, is cancellable, and updates the captured
Session only. A stale epoch, missing blob, decode failure, or field-guard failure requests one exact
resync and then presents an actionable error if recovery fails.

Raster references render from authenticated same-origin URLs. Text and JSON materialize according to
their typed slot; opaque JSON never gains reference meaning from a lookalike object.

## Extension UI

Ordered Extension requests belong to one Session and generation. Dialogs, questions, editor text,
widgets, notifications, and status updates keep that identity even when the user navigates away.

Blocking requests remain discoverable. A minimized request uses a visible dock rather than
disappearing. Question choices, free text, confirmation, cancel, and keyboard focus are accessible.
Submitting, replacing, aborting, or settling a request closes its obsolete UI synchronously.

## Details and destructive actions

The details surface combines inspection, conversation tree, and bounded diagnostics. Opening and
closing it preserves conversation position and returns focus to the invoking control.

Session deletion states exactly what will move to recoverable trash. The UI does not imply that
removing a Workspace deletes Sessions. Stale identity, missing control, running work, or filesystem
verification failure blocks deletion with a specific next action.

## Responsive behavior

- Desktop presents navigation, conversation, and optional details without narrowing the reading
  column below a useful width.
- Tablet collapses secondary surfaces before hiding primary actions.
- Phone uses dedicated navigation and details sheets, a stable top bar, and a composer that follows
  the visual viewport.

No critical action may exist only in hover UI or clipped overflow. Responsive decisions use both
viewport width and input characteristics where touch behavior matters.

## Accessibility and feedback

- Every interactive element is keyboard reachable and has a visible `:focus-visible` state.
- Icon-only controls have accessible names; status is not conveyed by color alone.
- Dialogs trap focus, expose a name and description, and restore focus on close.
- Dynamic status uses restrained live regions without announcing every streamed token.
- Reduced-motion preference disables nonessential animation and smooth scrolling.
- Light and dark themes preserve contrast for text, focus, errors, diffs, and disabled controls.
- Optional audio and tab-title feedback are user-controlled, synchronized across tabs, and never the
  only signal.

User-visible copy goes through `packages/ui/src/lib/i18n`. `zh-CN` is the default product locale and
`en` has the same key shape. Tracked project documentation and code comments remain English.

## Acceptance baseline

Changes to navigation, conversation, composer, control, recovery, Extension UI, or responsive layout
require a deterministic Browser regression. Visual review covers both themes, both locales, keyboard
focus, reduced motion, fine and coarse pointers, and representative phone, tablet, desktop, and wide
desktop widths. See [Development](development.md) for the executable gate.
