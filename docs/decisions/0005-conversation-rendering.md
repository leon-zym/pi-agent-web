# ADR 0005: Coalesce Session streams and defer renderer replacement

- Status: Accepted
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
- During streaming, render the changing Markdown tail as selectable plain text. Once settled,
  lazy-load the full GFM/code renderer so the large parser is absent from the initial application
  chunk.
- Do not adopt Markstream React 2.0.0 in the current release. Any future renderer must enter behind
  an adapter and pass the same security, semantics, style, accessibility, scroll, selection, and
  browser tests before replacing the settled renderer.
- Do not add turn virtualization until profiles after these changes show retained DOM/layout, not
  parsing or publication, is the remaining primary bottleneck.

## Measurements

On the same local benchmark fixture:

- 10,000 sequential reducer updates took about 1.35 ms; scheduler plus batch took about 0.71 ms.
- Eight Sessions × 2,000 compatible updates took about 1.88 ms in the scheduler path.
- Moving settled Markdown behind a lazy boundary reduced entry JavaScript from about
  888/271 kB gzip to 562/172 kB, with a separate 336/102 kB Markdown chunk.
- A 64 KiB GFM/code fixture costs roughly 130–180 ms in the current Node SSR
  parse/highlight/render proxy. This flags a browser long-task risk; it is not itself a Chromium
  mount/layout/paint measurement and is not claimed as solved by lazy loading.
- Markstream parsed/mounted the same shape substantially faster in an isolated `<pre>` setup, but
  its lazy JavaScript and CSS were about twice the current Markdown chunk footprint. Equivalent
  syntax highlighting was absent, stable-prefix reuse required explicit options and was disabled by
  final mode, and link/HTML/virtualization behavior differed.

## Consequences

Streaming and multi-Session background work become bounded and responsive without changing the
event model. Initial application load no longer pays for Markdown parsing. The SSR proxy shows that
a very large settled Markdown block may produce a browser main-thread long task; future work must
first measure production Chromium mount/layout/paint, then evaluate progressive/idle settlement or
a fully equivalent renderer adapter. The risk must remain visible in benchmarks and an Issue rather
than being hidden by a typewriter effect.

## Rejected alternatives

- rAF-only batching: hidden Session updates can stall indefinitely.
- Keeping only the latest `message_update`: Pi sends deltas, so text would be lost.
- Typewriter throttling: changes truth and only hides upstream update pressure.
- Immediate Markstream replacement: not functionally or visually equivalent and increases payload.
- Immediate turn virtualization: variable height, prepend anchors, expansion, selection, and tool
  inspection are unresolved without evidence that DOM count is now dominant.

## Verification

`session-event-scheduler.test.ts`, `projection-reducer.test.ts`, `projection.test.ts`,
`conversation-performance.bench.ts`, and packaged multi-Session browser tests cover ordering,
boundaries, hidden-tab publication, fairness, projection stability, background completion, and the
measured hot paths. Renderer replacement requires additional long-Markdown browser and a11y gates.
