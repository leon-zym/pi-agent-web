# ADR 0005: Coalesce Session streams and defer renderer replacement

- Status: Accepted (amended 2026-08-29)
- Date: 2026-08-21

## Context

Conversation rendering has two costs: high-frequency delta publication while one or more Sessions
run, and parsing/mounting a large settled Markdown document. Publishing every delta clones
projection state and rerenders history. A visible-tab-only `requestAnimationFrame` policy fails:
browsers suspend rAF in hidden tabs while background Sessions run. Replacing the renderer without
profiling risks Markdown, links, HTML, selection, scrolling, accessibility, and bundle behavior.

## Decision

- Keep the product model `ProductTurn → AssistantStep → ContentBlock`; thinking and tools remain
  independent semantic nodes rather than one Markdown document.
- Coalesce delta-only text, thinking, tool-call, and usage updates by identity: Session, generation,
  message, and content. Structural, error, settled, rekey, resync, and dialog boundaries flush
  immediately.
- Publish compatible visible-tab work once per animation frame; hidden tabs use a bounded timer so
  background Sessions catch up while rAF is suspended. Per-Session and global character/run budgets
  bound the queue, and every ready Session receives work in the same flush cycle.
- Preserve references for unchanged turns, steps, and blocks, and memoize turn, step, and
  user-message surfaces. Index tool results by call id.
- Keep the full Markdown adapter behind a lazy boundary. Streaming text renders as selectable plain
  text in copied `streaming-text.tsx` segments outside the settled parser; append-only updates
  extend the changing suffix, and segments never split a UTF-16 surrogate pair. ANSI and control
  characters leave the display projection without mutating the raw event or projection truth.
- After settlement, blocks within the `MarkdownBlock.tsx` byte limit take the lazy ReactMarkdown/GFM
  path, keeping links, tables, code highlighting, DiffBlock, and clean copy. A larger block keeps
  the bounded selectable plain-text surface instead of synchronously parsing an unbounded document;
  text and selection survive, while heading, list, and code elements are not promised. Highlighting
  and diff rendering stay behind `code-display.ts` breakers.
- Markstream React 2.0.0 is not the current renderer. A replacement enters behind an adapter and
  passes the same security, semantics, style, accessibility, scroll, selection, and browser gates.
- Use an older-history window because mounting every historical `TurnView` defeats the DOM/layout
  bound; `turn-window.ts` sets the mounted count and page size. The full Product projection stays
  authoritative, every User Turn keeps a TOC tick, and prepend/reveal preserve a stable scroll
  anchor. This is not a second history database or a fixed-height virtualization spacer.
- The bundle budget must account for the full initial synchronous JavaScript graph if additional
  eager/static chunks are introduced. Manual splitting or an immediate dynamic App import used only
  to move bytes out of the checked entry is not a reduction. Truly lazy, non-initial surfaces remain
  excluded.

## Consequences

Streaming and multi-Session work becomes responsive without changing the event model. Application
load drops Markdown parsing, and a live response never reparses its buffer. Oversized settled blocks
stay complete and selectable without synchronous rich parsing. The older-history window bounds
mounted turn DOM cost; the TOC keeps one tick per User Turn. Performance claims follow the
[benchmark page](../benchmark.md). Node SSR parsing/highlighting cost is a Browser long-task risk
signal, not a Chromium mount, layout, or paint measurement. Lazy loading and streaming fallbacks do
not by themselves prove that settled rendering is fast.

## Rejected alternatives

- rAF-only batching: hidden Session updates can stall indefinitely.
- Keeping only the latest `message_update`: Pi sends deltas, so text would be lost.
- Typewriter throttling: changes truth and only hides upstream update pressure.
- Progressive rich Markdown during streaming: reparsing the accumulated document made live cost
  scale with the complete response and was not needed for the accepted settled semantics.
- Immediate Markstream replacement: the isolated comparison lacked equivalent highlighting and
  differed in stable-prefix, link, HTML, and virtualization behavior, and adding it increases
  payload. A faster isolated render therefore did not justify replacing the renderer.
- Sampled TOC ticks: omitted User Turns lose navigation and violate the outline-rail contract.
- Fixed-height full-history virtualization: variable-height turns, prepend anchors, expansion,
  selection, and tool inspection need a more complex spacer and measurement system.
