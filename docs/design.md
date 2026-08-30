# Visual design

This document is the visual contract for Pi Agent Web. It defines the durable design language and
acceptance criteria. Component behavior belongs in [UI and UX](ui-ux.md); token values and recipes
remain authoritative in `packages/ui/src/styles/index.css` and the shared UI components.

## Design intent

The workbench should feel quiet, direct, and trustworthy during long technical sessions.

- Conversation content leads; application chrome recedes.
- Hierarchy comes from spacing, typography, and semantic surfaces before decoration.
- Dense information remains legible without becoming dashboard-like.
- State is explicit. Running, blocked, stale, destructive, and recoverable actions do not rely on
  color alone.
- Motion confirms continuity or activity; it does not entertain or delay work.
- Light and dark themes express the same hierarchy.

Do not add decorative gradients, oversized marketing headings, glass effects, excessive cards,
floating pills, or animation without a functional reason.

## Semantic tokens

Use the shared semantic tokens instead of raw palette utilities in feature components:

- `base`, `sidebar`, `surface`, and `surface-2` establish depth;
- `ink`, `ink-2`, and `ink-3` establish text hierarchy;
- `border` and `border-strong` separate without boxing every region;
- `primary`, `success`, `warning`, and `danger` communicate action or state;
- paired soft tokens provide restrained backgrounds;
- `terminal` is reserved for terminal-style content.

New tokens require a recurring semantic role in both themes. A one-off color belongs neither in a
component nor in the token system. Never use semantic status color as the only label.

Radii and shadows form a short depth scale. Small controls use restrained corners; composer,
dialogs, and message surfaces may use larger corners. Shadows are reserved for overlays, elevated
composer states, and temporary surfaces, not ordinary rows.

## Typography and density

The system UI stack is the default. Monospace is reserved for code, paths, commands, key hints, and
structured technical values.

The base interface is compact. Body text must remain comfortable for long reading, while labels and
metadata can be smaller only when contrast and line height remain sufficient. Avoid reducing text
to solve layout pressure; collapse or move secondary UI first.

Use sentence case. Prefer short concrete labels. Truncation requires an accessible way to inspect
the full value when it matters.

## Application shell

The primary desktop composition has navigation, conversation, and optional details.

- The conversation keeps a stable readable axis.
- Navigation may collapse to a rail before the conversation becomes too narrow.
- Details yields first, then moves to an overlay when it cannot retain a useful width.
- User-resized panel widths remain bounded and persist locally.
- Overlays restore focus to their trigger when closed.

At tablet width, secondary surfaces become drawers or overlays. Below 768 px, a dedicated mobile top
bar, navigation sheet, full-width conversation, and visual-viewport-aware composer replace the
desktop shell. Touch behavior also responds to coarse pointers at wider widths.

## Navigation

Workspace and Session rows use stable alignment and restrained hover fill. Selection uses a clear
primary marker and text emphasis, not a large filled card. Running and attention state remain visible
without animating the entire row.

The collapsed rail keeps creation, navigation, and theme actions reachable. Hover-only icon swaps
must have a coarse-pointer state and an accessible name.

## Conversation surfaces

Assistant content sits directly on the reading axis. User messages use a quiet contrasting bubble
with a bounded width. System, warning, and recovery notices are compact semantic surfaces.

Thinking remains in place as it changes from active to settled. Active motion is subtle and disabled
under reduced motion. A settled disclosure includes a useful teaser and preserves keyboard state.

Tool activity has three levels:

1. a compact active row;
2. a settled group summary;
3. an explicit detail view for arguments, results, and diagnostics.

Failures and active steps may not be hidden by grouping. Diffs use a monospace gutter, semantic line
status, horizontal overflow where needed, and clean-copy behavior. Filenames are treated as untrusted
text.

Long Markdown, code, tool content, and conversation history have bounded fallbacks. A fallback must
remain readable and disclose that rich rendering was reduced.

The conversation outline is an aid, not a second navigation system. It stays outside the reading
column when space permits, avoids the composer and details surface, and collapses cleanly when it
would cover content.

## Composer and controls

The composer is the primary action surface and remains visible. Its border, focus state, attachment
strip, controls, and send/stop action read as one unit.

- Focus uses the shared visible ring and must survive both themes.
- Send, stop, retry, destructive, and blocked states are visibly distinct.
- Multiline expansion is deliberate and never traps the user.
- Attachments show identity, removal, progress, and failure without shifting the primary action.
- Model, thinking, usage, and context controls may compress or move, but the main action never hides
  in overflow.

Buttons use familiar shapes and restrained press feedback. Icon-only buttons require tooltips for
fine pointers and accessible names for every input type. Touch targets remain usable on coarse
pointers.

## Overlays and Extension UI

Dialogs, sheets, popovers, tooltips, and docks share the same surface, border, shadow, and focus
language. Only one surface owns focus at a time. Layering must remain predictable over the composer,
details panel, and mobile sheets.

Blocking Extension requests remain discoverable if minimized. Questions use clear choice states and
a separate confirmation action. Notifications and audio are supplemental feedback, never the only
feedback.

## Motion and feedback

Use short transitions for hover, press, disclosure, and panel continuity. Continuous motion is
limited to real active work such as reasoning or running status. Avoid layout animation on streaming
content.

`prefers-reduced-motion` disables nonessential animation, smooth scrolling, and scale feedback.
Background-tab feedback is restrained and user-controlled.

## Accessibility

- All controls have keyboard operation, visible focus, and an accessible name.
- Text, focus rings, statuses, diffs, and disabled states meet useful contrast in both themes.
- Dialogs and sheets expose titles and descriptions, trap focus, and restore it on close.
- Live regions announce state transitions rather than streamed tokens.
- Content order remains meaningful without color, motion, hover, or audio.
- Zoom, long translated copy, large paths, and unbroken model output must not hide critical actions.

## Visual acceptance matrix

Review every material UI change against:

- light and dark themes;
- `zh-CN` and `en` product locales;
- keyboard-only and coarse-pointer interaction;
- reduced motion;
- 320, 375, 640, 768, 1024, 1280, and 1600 px representative widths;
- empty, streaming, settled, failed, blocked, recovering, and long-content states;
- open navigation, details, dialogs, Extension UI, and software keyboard where applicable.

Automated screenshots support review but do not replace inspection. Check clipping, overlap, focus,
contrast, scroll anchoring, stale state after Session switching, and whether every critical action is
reachable.
