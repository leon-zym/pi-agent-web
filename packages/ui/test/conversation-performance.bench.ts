import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bench, describe } from "vitest";
import SettledMarkdown from "../src/features/conversation/SettledMarkdown";
import { type CoalescibleMessageUpdate, SessionEventScheduler } from "../src/lib/session-event-scheduler";
import { reduceProjection } from "../src/stores/projection-reducer";
import { createEmptyProjection } from "../src/types/view-models";

const usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const context = { now: 1_000 };

function textDelta(text: string): CoalescibleMessageUpdate {
	return {
		type: "message_update",
		usage,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
	} as CoalescibleMessageUpdate;
}

function startedProjection(sessionHandle: string) {
	let projection = createEmptyProjection(sessionHandle);
	projection = reduceProjection(projection, { type: "agent_start" }, context);
	return reduceProjection(projection, { type: "turn_start" }, context);
}

const markdownSection = `
## Streaming renderer benchmark

This paragraph contains **bold text**, a [link](https://example.com), inline \`code\`, and enough prose to
exercise GFM parsing without relying on a synthetic single token.

| Session | State | Tokens |
| --- | --- | ---: |
| A | running | 12,345 |
| B | settled | 67,890 |

\`\`\`ts
export function schedule(session: string): void {
  console.log(session)
}
\`\`\`
`;
const longMarkdown = markdownSection
	.repeat(Math.ceil((64 * 1024) / markdownSection.length))
	.slice(0, 64 * 1024);

describe("conversation rendering performance", () => {
	bench(
		"10k message_update events through the sequential reducer",
		() => {
			let projection = startedProjection("sequential");
			for (let index = 0; index < 10_000; index++) {
				projection = reduceProjection(projection, textDelta("x"), context);
			}
			void projection;
		},
		{ iterations: 8, time: 500 },
	);

	bench(
		"10k compatible events through scheduler and batched reducer",
		() => {
			let projection = startedProjection("scheduled");
			const scheduler = new SessionEventScheduler({
				onFlush: (_sessionHandle, _generation, events) => {
					for (const event of events) projection = reduceProjection(projection, event, context);
				},
				requestFrame: () => 1,
				cancelFrame: () => undefined,
			});
			for (let index = 0; index < 10_000; index++) {
				scheduler.enqueue("scheduled", 1, "message-1", textDelta("x"));
			}
			scheduler.flushAll();
			void projection;
		},
		{ iterations: 8, time: 500 },
	);

	bench(
		"eight Sessions with 2k deltas each share one publication frame",
		() => {
			const projections = new Map(
				Array.from({ length: 8 }, (_, index) => {
					const sessionHandle = `session-${String(index)}`;
					return [sessionHandle, startedProjection(sessionHandle)] as const;
				}),
			);
			const scheduler = new SessionEventScheduler({
				onFlush: (sessionHandle, _generation, events) => {
					let projection = projections.get(sessionHandle);
					if (!projection) return;
					for (const event of events) projection = reduceProjection(projection, event, context);
					projections.set(sessionHandle, projection);
				},
				requestFrame: () => 1,
				cancelFrame: () => undefined,
			});
			for (let index = 0; index < 2_000; index++) {
				for (let session = 0; session < 8; session++) {
					const sessionHandle = `session-${String(session)}`;
					scheduler.enqueue(sessionHandle, 1, "message-1", textDelta("x"));
				}
			}
			scheduler.flushAll();
			void projections;
		},
		{ iterations: 8, time: 500 },
	);

	bench(
		"settled 64 KiB GFM Markdown with syntax highlighting",
		() => {
			const html = renderToStaticMarkup(createElement(SettledMarkdown, { text: longMarkdown }));
			void html;
		},
		{ iterations: 8, time: 500 },
	);
});
