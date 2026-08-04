# DESIGN.md — pi-agent-web 视觉方向契约

Direction locked for the whole UI surface. Every new surface reuses this vocabulary;
a deviation needs a stated reason in the PR description.

## Visual thesis
A quiet terminal workbench: near-white editorial reading surface with a light-gray
sidebar, hierarchy carried by typography and position instead of borders, a single
blue reserved for primary actions, running state, and links. The terminal identity
comes from monospace status lines (timing, tool summaries, token meters).

## Content plan (app shell)
Utility mode, no hero. Left sidebar orients (workspaces, sessions, search), the
center column shows status and conversation, the right details panel inspects
(tool output, branch tree). The composer is a persistent floating capsule.

## Interaction thesis
- Press scale `scale(0.96)` on every pressable control (100-160ms), hover alone
  is never feedback.
- The 2.6s light sweep on a streaming thinking row is the one ambient motion;
  everything else is 200ms `cubic-bezier(0.4, 0, 0.2, 1)` ease-out.
- `prefers-reduced-motion` disables the sweep and all non-essential motion.

## CSS strategy
Tailwind CSS v4 only. Tokens live in `@theme` with static class names only
(no dynamically constructed class names). No CSS Modules on the same element.
All motion is CSS transitions/keyframes on transform/opacity; no layout-property
animation, no `transition: all`.

## Palette (semantic tokens in @theme)
Light: base `#ffffff`, sidebar `#f9fafb`, input surface `#ffffff`,
user bubble `#edf3fe`, primary `#4176e6`, text-primary `#0f1115`.
Dark: base `#151517`, sidebar `#1b1b1c`, input surface `#2c2c2e`,
user bubble `#2c2c2e`, primary `#679efe`, text-primary `#f9fafb`.
Status: success `#16a34a`/`#4ade80`, warning `#d97706`/`#fbbf24`,
error `#dc2626`/`#ef4444`. Neutrals tinted toward blue by construction
(bg-muted, border tokens). Gray text never sits on colored backgrounds.
Blue appears nowhere except primary actions, running/streaming states, links,
and the active tab underline.

## Typography
- UI: system stack, Latin first with CJK fallthrough:
  `-apple-system, "SF Pro Text", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif`.
  CJK body line-height 1.75 (assistant prose `text-[15px] leading-[26px]`-class
  tuned to 1.7+), UI captions 12/13/14px ladders. No negative tracking on CJK runs.
- Mono voice (status/timing/tool summaries/token meters): `"SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace`.
- Numbers that update (timers, token counts, costs): `tabular-nums`.
- Headings sentence case, no exclamation marks in success copy, no "Oops" errors.

## Radius scale (named, committed)
`xs 6px` inline code · `sm 8px` rows/inputs/buttons · `md 12px` menus/cards ·
`lg 16px` · `xl 22px` composer capsule and user bubble · `full` pill send button (34px circle).
Concentric rule: outer = inner + padding.

## Components
- Assistant prose: no bubble, max 748px content width, 15px/26px+ reading type.
- User message: right-aligned light-blue bubble (22px radius, 10/16 padding), max 525px.
- Thinking: 24px compact disclosure row; expanded body indents 22px; running row
  shows a 2.6s sweep; settled row shows the first-line summary.
- Tool call: standalone row node (never inside markdown), collapsed by default,
  `[status icon] name · summary` layout; inline expansion capped (terminal 224px,
  code 260px); full log goes to the right details panel. Skipped state shows no
  execution animation.
- Composer: floating capsule (22px radius), 1px border + level-2 shadow, auto-
  grows to 14 lines, toolbar row under the textarea; queue dock slides in above.
- Rows (sessions, models, commands): 32-40px, hover fill only, no card borders.
- Buttons: one fixed radius per role; primary action = full pill; toolbar and
  rows = sm (8px); send/stop = 34px circle.

## Layout
App shell `sidebar 280px (264-420) | center min 640 | details 360px (300-520)`.
Squeeze order: details -> 300px -> details to 0 (subtree stays mounted) -> center
below 640px last. Sidebar collapses to a 56px rail under 1024px. Conversation
content 748px, composer 780px, side clearance 16px.

Visibility affordance is part of the layout contract: an open Details panel exposes
its close control, a closed panel leaves a persistent narrow reopen rail, and the
Sidebar has matching collapse/expand controls between its full tree and 56px rail.
Tool and branch entry points may reopen Details, but no panel may depend on a hidden
or hover-only control for recovery.

## Depth
Background steps, not borders: white base + `#f9fafb` sidebar + hover fills.
Shadows only on floating surfaces: composer, menus, dialogs, tooltips, toasts.
Light mode: `0 1px 3px rgba(0,0,0,0.10)` minimum for cards, level-2 for popovers.
Dark mode: elevation by white overlay steps (`rgba(255,255,255,0.02/0.04/0.05)`)
and `rgba(255,255,255,0.05/0.08)` borders; near-black canvas `#151517`.

## Do / don't
- Do: hover fill rows, mono status text, pinned-follow scrolling, thin active-tab
  underline, 500ms-delay tooltips, `focus-visible` rings everywhere.
- Don't: gradient text, glass cards, thick side-border accents, border-wrapped
  cards in rows, `transition: all`, layout-property animation, motion on
  keyboard-initiated changes, blue for non-action decoration.

## Responsive
Desktop-first workbench. <1024px sidebar becomes a 56px rail; details panel
auto-closes; center shrinks before anything else. Touch: hover states behind
`@media (hover: hover)`, 40px minimum hit areas, `touch-action: manipulation`.

## Prompt guide (for AI collaborators)
Generate UI with this file as the single source of visual truth. Reuse tokens,
radius names, and component recipes above. Chinese UI copy, sentence-case
headings, English code comments. Never invent a new color or radius on the fly.
