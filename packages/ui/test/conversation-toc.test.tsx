import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationToc } from "../src/features/conversation/ConversationToc";
import type { ProductTurn } from "../src/types/view-models";

describe("ConversationToc outline rail", () => {
	const mockTurns: ProductTurn[] = [
		{
			id: "turn-1",
			status: "settled",
			userMessages: [
				{
					entryKey: "m-1",
					text: "First prompt about refactoring",
					source: "prompt",
					delivered: true,
				},
			],
			steps: [],
		},
		{
			id: "turn-2",
			status: "settled",
			userMessages: [
				{
					entryKey: "m-2",
					text: "Second prompt about adding tests",
					source: "prompt",
					delivered: true,
				},
			],
			steps: [],
		},
		{
			id: "turn-3",
			status: "running",
			userMessages: [
				{
					entryKey: "m-3",
					text: "Third prompt running",
					source: "steer",
					delivered: true,
				},
			],
			steps: [],
		},
	];

	it("renders miniature tick marks for each turn", () => {
		const html = renderToStaticMarkup(
			createElement(ConversationToc, {
				turns: mockTurns,
				activeTurnId: "turn-1",
				rightMargin: 300,
			}),
		);

		expect(html).toContain('data-conversation-toc="true"');
		expect(html).toContain('data-toc-tick="turn-1"');
		expect(html).toContain('data-toc-tick="turn-2"');
		expect(html).toContain('data-toc-tick="turn-3"');
	});

	it("highlights the active tick mark", () => {
		const html = renderToStaticMarkup(
			createElement(ConversationToc, {
				turns: mockTurns,
				activeTurnId: "turn-2",
				rightMargin: 300,
			}),
		);

		expect(html).toContain('data-toc-active="true"');
		expect(html).toMatch(/data-toc-tick="turn-2"[^>]*data-toc-active="true"/);
	});

	it("renders a 220px preview bubble with prompt text", () => {
		const html = renderToStaticMarkup(
			createElement(ConversationToc, {
				turns: mockTurns,
				activeTurnId: "turn-1",
				rightMargin: 300,
			}),
		);

		expect(html).toContain("w-[220px]");
		expect(html).toContain("First prompt about refactoring");
		expect(html).toContain("Second prompt about adding tests");
	});

	it("auto-hides with opacity-0 and pointer-events-none when right margin < 240px", () => {
		const html = renderToStaticMarkup(
			createElement(ConversationToc, {
				turns: mockTurns,
				activeTurnId: "turn-1",
				rightMargin: 200,
			}),
		);

		expect(html).toContain("opacity-0");
		expect(html).toContain("pointer-events-none");
	});

	it("does not render when turns is empty", () => {
		const html = renderToStaticMarkup(
			createElement(ConversationToc, {
				turns: [],
				activeTurnId: null,
				rightMargin: 300,
			}),
		);

		expect(html).toBe("");
	});
});
