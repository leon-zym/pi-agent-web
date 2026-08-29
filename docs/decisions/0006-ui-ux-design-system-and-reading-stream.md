# ADR 0006: UI/UX design system, reading stream orchestration, and client lifecycle invariants

- Status: Accepted (amended 2026-08-29)
- Date: 2026-08-22

## Context

As the workbench scales to handle complex agent interactions and multi-session concurrency, several critical UI/UX and lifecycle challenges emerge:

1. **Reading Stream Ergonomics**: Extended thinking blocks and dozens of sequential read/grep/write tool calls create visual noise and push essential assistant prose out of the viewport. However, prematurely collapsing in-flight tool calls creates a "false deadlock" perception where users cannot verify agent liveness.
2. **Code Modification Visibility**: Generic diff previews lack line-level gutters, visual add/delete markers, and clean clipboard copying, hindering rapid code review.
3. **Long Conversation Navigation**: Multi-turn sessions lack an overview map for jumping between queries, while full-width sidebars encroach upon central reading space.
4. **Composer Delivery Arbitration**: During active execution, typing large prompts requires multi-line breathing room without colliding with the keyboard semantics of immediate steering (`Enter`) vs queued follow-up (`Cmd/Ctrl+Enter`).
5. **Blocking Interaction Deadlocks**: Full-screen modal dialogs for Extension UI approvals prevent users from scrolling the conversation to inspect the code or logs requiring confirmation.
6. **Multi-Session Lifecycle & Resource Bounding**: Maintaining open WebSocket subscriptions across dozens of background sessions exhausts browser memory, but blind LRU eviction inadvertently severs streaming pipelines and silences notifications for active tasks.
7. **Hanging Tool Artifacts**: Unsettled tool calls resulting from process terminations, network drops, or aborts risk rendering perpetual loading spinners.

## Decision

### 1. Two-Stage In-Place Thinking Disclosure
- **Streaming Stage**: Maintain a bounded 5-line scrolling viewport that smoothly auto-scrolls to the latest generated tokens (`scrollTop = scrollHeight`), accompanied by a restrained 2.6s `.thinking-sweep` pulse animation.
- **Settled Stage**: Smoothly collapse via CSS Grid animation (`grid-template-rows: 0fr 1fr`) to a tail teaser summarizing the concluding paragraph of the chain of thought.
- **In-Place Primary Toggle**: Clicking the thinking disclosure triggers an inline smooth expansion/collapse without forcibly sliding open the right DetailsPanel, preserving the central reading axis. A micro-icon `<ExternalLink>` in the header provides optional escalation to the full-height Inspector.

### 2. Three-Tier ToolGroup Architecture
- **In-Flight Liveness Guard**: While an agent is executing tool calls, active rows must remain expanded with live spinners and real-time parameter summaries to guarantee transparent execution progress.
- **Settled Aggregation**: When a turn step settles and contains consecutive $>2$ non-interactive tool calls, automatically aggregate them into a single-line summary badge (`⚡ 13 tool calls · read_file × 8, grep × 4, bash × 1 · 3.4s [✓ Done]`).
- **Stacked Hairline Layout**: Expanding the ToolGroup renders a compact 1px divider stacked list (`rounded-t-md` on first, `rounded-none` on middle, `rounded-b-md` on last) with line-count badges (`+N -M`) for file mutations.
- **Tier 3 Interaction Cards**: Reserve full-card visual prominence strictly for high-attention blocking Extension UI requests.

### 3. Line-Level DiffBlock Gutter & Clean Copy
- Dedicated parsing for ````diff` blocks and file edit outputs, rendering dual-column line gutters (original/new alignment), `+`/`-` indicators, semantic success/danger background tints, and a clean-copy action that automatically strips diff markers.

### 4. Conversation TOC Outline Rail
- A floating miniature outline rail docked to the right of the conversation column with tick marks per user turn, expanding a 220px preview bubble on hover/focus and highlighting the active turn in the viewport via `IntersectionObserver`.
- Collision Guard: Automatically hidden (`visibility: hidden`) when right viewport margin $<240\text{px}$ or wide content blocks expand horizontally.
- The rail keeps one lightweight tick per User Turn. Expensive conversation Turn DOM is independently
  bounded by ADR 0005's newest-64/older-24 window, and a TOC selection reveals an unmounted Turn before
  scrolling to it.

### 5. 70vh Immersive Composer & Keyboard Arbitration
- Provide a smooth expansion to `70vh` viewport height for extended drafting.
- Disambiguate execution keybindings:
  - *Idle*: Default height `Enter` submits / `Shift+Enter` wraps; 70vh height `Enter` wraps / `Cmd/Ctrl+Enter` submits.
  - *Running*: Default height `Enter` steers / `Cmd/Ctrl+Enter` queues follow-up; 70vh height presents an explicit `[Steer | Follow-up]` segmented switcher, where `Enter` wraps and `Cmd/Ctrl+Enter` submits with the chosen delivery mode.
- Shell-style prompt history (`↑`/`↓`, 50 items in `localStorage`) scoped per session/workspace, seamlessly migrating indices upon session rekey.

### 6. Extension UI ChatDock & QuestionCard
- **ChatDock**: When a blocking Extension UI request arrives, allow minimizing the modal into a floating capsule docked above the composer, unmasking the entire conversation stream for inspection while keeping RPC channels and timeout deadlines active.
- **QuestionCard**: Structure Extension `select` dialogs with `1~9` keyboard selection, recommended option styling, and write-in custom text inputs, strictly adhering to the single-value `{ value: string }` response contract.
- **Soft Idempotency**: Treat abort and expired dialog responses as soft no-ops without intrusive error toasts.

### 7. Mobile Adaptation & Sensory Feedback
- Mobile (`<768px`): 48px `MobileTopBar`, `MobileSwitcherSheet` bottom drawer with $\ge 40\text{px}$ touch targets, and `visualViewport` dynamic height calculation to prevent software keyboard occlusion.
- Multi-Sensory: Native Web Audio API 120ms sine chime (440Hz $\to$ 880Hz) on completion/approval requests, coupled with dynamic background tab titles and favicon indicator dots.

### 8. Active WS Subscription Admission Target with Running Liveness Guard
- Treat `MAX_ACTIVE_SUBSCRIPTIONS = 6` as a soft admission target for idle/persisted subscriptions,
  not as a hard connection-wide ceiling.
- When the target is reached, eviction is restricted to persisted `idle`/`dormant` sessions with no
  pending Extension request. Sessions in `running`, `waiting_ui`, `starting`, or `unpersisted`
  states are protected and may temporarily take the connection above the target.
- Cross-layer resource governance is owned by the shared Gateway boundaries: hot process and retained
  projection reservations, WebSocket connection/channel/catch-up/alias/pending-response ceilings, and
  bounded native discovery. The Browser receives explicit Runtime phase facts and structured
  `session_error.code`/`retryable` metadata.
- The UI distinguishes a protected overage from a rejected subscription and offers retry only for a
  retryable rejection after the transport is usable. The projection reservation is conservative
  admission accounting, not a claim about exact Browser heap usage; there is still no total Browser
  memory guarantee.

### 9. Hanging Tool Convergence to `interrupted`
- Any incomplete tool call discovered upon session load, step settlement, or abort converges to an explicit `interrupted` status (muted gray badge), preventing infinite loading spinners without faking success.

### 10. Optimistic Message ContentShape Reconciliation
- Reconcile optimistic user messages against authoritative `message_start` events using a composite `contentShape` (text fingerprint + attachment count) and FIFO queue matching to eliminate visual flicker and duplicate bubbles.

## Consequences

- Delivers a quiet, uncluttered, high-density workbench interface true to the Linear / ShadCN visual philosophy.
- Eliminates execution blindness during tool streaming while preventing transcript clutter once settled.
- Solves modal deadlocks by enabling users to review historical code while handling Extension approvals.
- Keeps idle subscription pressure target-bounded without breaking background tasks or audio notifications;
  it does not claim a hard browser-memory bound while protected sessions exceed the target.
- Automates design system compliance via `scripts/check-style.mjs`.

## Rejected Alternatives

- **Forcing thinking logs into DetailsPanel**: Evicted the central reading focus and caused horizontal canvas thrashing.
- **Collapsing tools during streaming**: Created anxiety that the agent had frozen or dropped execution.
- **Unbounded WebSocket subscriptions**: Produced memory leaks and socket backpressure across heavy multi-session usage.
- **Unconditional LRU eviction**: Silently dropped background running sessions and broke real-time completion alerts.
- **Full-screen-only modal dialogs**: Blocked users from inspecting the very code changes requiring approval.

## Verification

- `scripts/check-style.mjs` enforces zero design-system anti-patterns.
- Reducer and projection tests verify `interrupted` tool convergence, `contentShape` reconciliation, and `soft idempotency`.
- Performance benchmarks (`conversation-performance.bench.ts`) report reducer/scheduler path timing and
  fairness. Production Chromium specs (`conversation-performance.spec.ts` and
  `conversation-window.spec.ts`) establish the conversation-specific live/settlement, retained-Turn,
  heap, selection, focus, resize, and scroll-anchor budgets; they do not turn the broader protected
  multi-Session subscription policy into a total browser-memory guarantee.
