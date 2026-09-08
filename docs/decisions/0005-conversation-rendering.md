# ADR 0005: Coalesce Session streams and defer renderer replacement

- Status: Accepted (amended 2026-08-29)
- Date: 2026-08-21

## Context

Conversation rendering has two different costs: high-frequency delta publication while one or more
Sessions run, and parsing/mounting a large settled Markdown document. Publishing every delta clones
projection state and rerenders history. A visible-tab-only `requestAnimationFrame` policy is also
incorrect because browsers throttle or suspend rAF in hidden tabs, while background Sessions must
continue. Replacing the entire renderer without profiling risks changing Markdown, links, HTML,
selection, scrolling, accessibility, and bundle cost.

## Decision

- Keep the product model `ProductTurn → AssistantStep → ContentBlock`; thinking and tools remain
  independent semantic nodes rather than one Markdown document.
- Coalesce only delta-only text, thinking, tool-call, and usage updates with matching
  Session/generation/message/content identity. Structural, error, settled, rekey, resync, and dialog
  boundaries flush immediately.
- Publish compatible visible-tab work once per animation frame. Hidden tabs use a bounded timer so
  background Sessions catch up even when rAF is suspended. Per-Session and global character/run
  budgets bound the queue, and every ready Session receives work in the same flush cycle.
- Preserve references for unchanged turns/steps/blocks; memoize turn, step, and user-message
  surfaces. Index tool results by call id instead of filtering the full result list per block.
- Keep the full Markdown adapter behind a lazy boundary. While a text block is streaming,
  `StreamingText` renders selectable plain text in copied, fixed-size 16 KiB segments; it does not
  enter the settled Markdown parser. Append-only updates extend only the changing suffix, and
  segment boundaries never split a UTF-16 surrogate pair. ANSI/control characters are removed from
  the display projection without mutating the raw event or projection truth.
- After settlement, blocks at or below 256 KiB UTF-8 use the lazy ReactMarkdown/GFM path, retaining
  safe links, tables, code highlighting, DiffBlock, and clean copy behavior. A larger settled block
  uses the same bounded selectable plain-text surface instead of synchronously parsing an
  unbounded document. This fallback intentionally preserves complete text and selection, but does
  not promise heading/list/code semantic elements for that oversized block. Syntax highlighting and
  custom diff rendering remain behind their explicit character/UTF-8 byte circuit breakers.
- Markstream React 2.0.0 is not part of the current renderer. A renderer replacement must enter
  behind an adapter and pass the same security, semantics, style, accessibility, scroll, selection,
  and browser tests before replacing the settled renderer.
- Use an older-history window after the production profile showed that mounting every historical
  `TurnView` would defeat the DOM/layout bound: the newest 64 turns mount initially, and older/newer
  pages add 24 turns at a time. The full Product projection remains authoritative, every User Turn
  keeps a lightweight TOC tick, and prepend/reveal preserve a stable scroll anchor. This is a
  bounded turn window, not a second history database or a fixed-height virtualization spacer.

## Measurement rationale and historical evidence

Early reducer, scheduler, SSR, and renderer comparisons informed this decision. The observations
preserved in the [original recovered record](https://github.com/leon-zym/pi-agent-web/blob/5987e40dc4e9da45c45a7468fcc533323ce38f17/docs/decisions/0005-conversation-rendering.md)
are historical reports, not current benchmarks; that record does not establish raw-run provenance
for each number. Node SSR parsing/highlighting cost is a Browser long-task risk signal, not a
Chromium mount, layout, or paint measurement. Lazy loading and streaming fallbacks do not by
themselves prove that settled rendering is fast.

[PR #61](https://github.com/leon-zym/pi-agent-web/pull/61) records the historical entry-size comparison
and the separate [bundle-budget change](https://github.com/leon-zym/pi-agent-web/commit/82a772282bb2a2c61235228bacec84ad689c048a).
The old cap left little headroom for that candidate, motivating the rebaseline. Those byte counts
identify that experiment, not current main. Enforced limits remain in the
[bundle checker](../../scripts/check-ui-bundle-budget.mjs).

The budget must account for the full initial synchronous JavaScript graph if additional eager/static
chunks are introduced. Manual splitting or an immediate dynamic App import used only to move bytes
out of the checked entry is not a reduction. Truly lazy, non-initial surfaces remain excluded.

The isolated Markstream comparison lacked equivalent highlighting and differed in stable-prefix,
link, HTML, and virtualization behavior. A faster isolated render therefore did not justify replacing
the renderer. Current observation boundaries, reproducibility, and diagnostic limitations belong in
the [benchmark report](../benchmark-report.md#current-streaming-observer-semantics); calibration and
coverage delivery belong to [Issue #28](https://github.com/leon-zym/pi-agent-web/issues/28).

## Consequences

Streaming and multi-Session background work become bounded and responsive without changing the
event model. Initial application load no longer pays for Markdown parsing, and a live response does
not repeatedly parse its accumulated buffer. Oversized settled blocks remain complete and
selectable while avoiding synchronous rich parsing. The older-history window bounds mounted turn
DOM/layout cost without discarding Product projection truth; the TOC remains semantically complete
with one lightweight tick per User Turn.

## Rejected alternatives

- rAF-only batching: hidden Session updates can stall indefinitely.
- Keeping only the latest `message_update`: Pi sends deltas, so text would be lost.
- Typewriter throttling: changes truth and only hides upstream update pressure.
- Progressive rich Markdown during streaming: reparsing the accumulated document made live cost
  scale with the complete response and was not needed for the accepted settled semantics.
- Immediate Markstream replacement: not functionally or visually equivalent and increases payload.
- Sampled TOC ticks: omitted User Turns lose direct navigation and conflict with the accepted
  outline-rail contract; the bounded conversation window limits expensive turn DOM instead.
- Fixed-height full-history virtualization: variable-height turns, prepend anchors, expansion,
  selection, and tool inspection need a more complex spacer/measurement system than the current
  evidence justifies.

## Verification

`session-event-scheduler.test.ts`, `projection-reducer.test.ts`, `projection.test.ts`,
`markdown-block.test.tsx`, `streaming-text.test.ts`, `turn-window.test.ts`,
`settled-markdown.test.tsx`, `conversation-performance.bench.ts`,
`tests/e2e/specs/conversation-performance.spec.ts`,
`tests/e2e/specs/conversation-window.spec.ts`, and packaged multi-Session browser tests cover
ordering, boundaries, hidden-tab publication, fairness, projection stability, background
completion, renderer circuit breakers, Unicode-safe segments, bounded turn mounting, selection,
focus, resize anchoring, and the measured hot paths. Renderer replacement still requires the same
security, semantics, style, accessibility, scroll, selection, and browser gates.
