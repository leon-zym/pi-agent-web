# Visual design

Visual language for Pi Agent Web. Interaction behavior lives in [UI and UX](ui-ux.md); token values
live in `packages/ui/src/styles/index.css` and the shared UI components.

## Design intent

The workbench stays quiet, direct, and trustworthy. Conversation content leads and chrome recedes;
hierarchy comes from spacing, typography, and semantic surfaces before decoration. Dense information
stays legible without becoming dashboard-like, and both themes express the same hierarchy.

Motion confirms continuity or activity; it never delays work. Do not add decorative gradients,
oversized headings, glass effects, excessive cards, floating pills, or aimless animation.

## Semantic tokens

Use the shared semantic tokens instead of raw palette utilities: `base`, `sidebar`, `surface`, and
`surface-2` establish depth; `ink`, `ink-2`, and `ink-3` establish text hierarchy; `border` and
`border-strong` separate without boxing every region; `primary`, `success`, `warning`, and `danger`
carry action and state; paired soft tokens provide restrained backgrounds; `terminal` marks
terminal-style content.
New tokens require a recurring semantic role in both themes; a one-off color is not a token.

Radii and shadows form a short depth scale: small controls take restrained corners, the composer and
dialogs may take larger ones, and shadows are reserved for overlays, elevated composer states, and
temporary surfaces rather than ordinary rows.

## Typography and density

The system UI stack is the default; monospace is reserved for code, paths, commands, and key hints.
The base interface is compact, and body text stays comfortable for long reading while labels and
metadata may shrink when contrast and line height hold. Collapse or move secondary UI before
reducing text size, use sentence case and short labels, and give truncation a path to the full
value.

## Shell and responsive composition

The desktop composition has navigation, conversation, and optional details, and the conversation
keeps a stable readable axis. Navigation collapses to a rail before the conversation becomes too
narrow; details yields first and then becomes an overlay. Layout pressure removes secondary surfaces
before primary actions, and user-resized panel widths are clamped and persist locally.

At tablet width, secondary surfaces become drawers or overlays. Below 768 px, a mobile top bar,
navigation sheet, full-width conversation, and viewport-aware composer replace the desktop shell.

Navigation rows use stable alignment and restrained hover fill; selection uses a primary marker and
text emphasis, and running state stays visible without animating the row. The collapsed rail keeps
creation, navigation, and theme actions reachable; hover-only swaps need a coarse-pointer state.

## Conversation surfaces

Assistant content sits on the reading axis; user messages use a quiet contrasting bubble with a
bounded width; system, warning, and recovery notices are compact semantic surfaces.

Thinking stays in place as it moves from active to settled, with subtle motion. Tool activity has
three levels: a compact active row, a settled group summary, and a detail view for arguments,
results, and diagnostics. Diffs use a monospace gutter, semantic line status, and clean copy; long
Markdown, code, and tool content keep a readable fallback stating that rich rendering was reduced.
The conversation outline is an aid, not a second navigation system. It stays outside the reading
column when space permits, avoids the composer and details surface, and collapses cleanly when it
would cover content.

## Composer

The composer stays visible: border, focus state, attachment strip, controls, and send or stop read
as one unit. Send, stop, retry, destructive, and blocked states are visibly distinct. Attachments
show identity, removal, progress, and failure without moving the primary action. Buttons use
familiar shapes with restrained press feedback; icon-only buttons expose tooltips on fine pointers.

## Overlays and motion

Dialogs, sheets, popovers, tooltips, and docks share one surface, border, shadow, and focus
language; one surface owns focus, and layering stays predictable over the composer and details.

Transitions for hover, press, disclosure, and panel continuity are short. Continuous motion is
limited to active work such as reasoning or running status, and streaming content does not animate
layout. `prefers-reduced-motion` disables nonessential animation, smooth scrolling, and scale
feedback.

## Contrast and focus

Text, focus rings, statuses, diffs, and disabled states keep sufficient contrast in both themes, and
no state relies on color alone. Content order remains meaningful without color, motion, hover, or
audio. Focus uses the shared visible ring. Zoom, long translated copy, large paths, and unbroken
model output must not hide critical actions.

## Visual acceptance matrix

Review every material UI change against:

- light and dark themes;
- `zh-CN` and `en` product locales;
- keyboard-only and coarse-pointer interaction;
- reduced motion;
- 320, 375, 640, 768, 1024, 1280, and 1600 px representative widths;
- empty, streaming, settled, failed, blocked, recovering, and long-content states;
- open navigation, details, dialogs, Extension UI, and software keyboard where applicable.

Screenshots support this review but do not replace it. Check clipping, overlap, focus, contrast,
scroll anchoring, and stale state after Session switching.
