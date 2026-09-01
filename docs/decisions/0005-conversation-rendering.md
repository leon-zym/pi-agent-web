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

## Measurements

On the same local benchmark fixture:

- 10,000 sequential reducer updates took about 1.35 ms; scheduler plus batch took about 0.71 ms.
- Eight Sessions × 2,000 compatible updates took about 1.88 ms in the scheduler path.
- Moving settled Markdown behind a lazy boundary keeps the initial route independent from the
  syntax-highlighting/Markdown chunk; the current production sizes and working budgets are listed
  below.
- A 64 KiB GFM/code fixture costs roughly 130 to 180 ms in the current Node SSR
  parse/highlight/render proxy. This flags a browser long-task risk; it is not itself a Chromium
  mount/layout/paint measurement and is not claimed as solved by lazy loading or the streaming
  circuit breakers.
- Production Chromium fixtures cover 10 KiB, 64 KiB, 120 KiB, and 1 MiB streamed responses. They
  emit live long-task, cold/warm settlement, mounted-turn, and post-GC heap-delta metrics alongside
  deterministic content, structure, and safety assertions. Host-sensitive numerical metrics are
  diagnostic observations rather than hard budgets or a latest-pass claim until a calibrated
  reference-host baseline and variance policy exist. Settlement timing starts at the final
  stream-delta boundary and ends only after the settled DOM is present; the measurement reads
  numeric DOM/heap values in the page and does not pull the full text across the Playwright
  boundary.
- The exact current-main production build is 243,266 bytes gzip for the entry JavaScript; the
  unmodified 24-S2a candidate is 246,386 bytes gzip. The former 240 KiB entry cap (245,760 bytes)
  consumes about 99.0% of that cap and leaves only 2,494 bytes, so the cap was nearly exhausted and
  no longer provided a meaningful working margin. The entry cap is rebaselined to 256 KiB (262,144
  bytes), leaving 15,758 bytes, or about 6.4%, of headroom above the candidate. The settled-Markdown
  and UI CSS budgets remain unchanged at ≤110 KiB and ≤12 KiB gzip; root `pnpm build` runs
  `scripts/check-ui-bundle-budget.mjs` and fails when one is exceeded.
- The current build has one eager entry chunk, and the hard cap applies to that chunk. If the build
  configuration later introduces additional eager/static JavaScript chunks, the checker must
  aggregate the full initial synchronous graph before that change can pass. Manual/static chunk
  splitting or an immediate dynamic App import used only to move bytes out of the checked entry may
  not be credited as a reduction. Truly lazy, non-initial surfaces remain excluded.
- Markstream parsed/mounted the same shape substantially faster in an isolated `<pre>` setup, but
  its lazy JavaScript and CSS were about twice the current Markdown chunk footprint. Equivalent
  syntax highlighting was absent, stable-prefix reuse required explicit options and was disabled by
  final mode, and link/HTML/virtualization behavior differed.

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
