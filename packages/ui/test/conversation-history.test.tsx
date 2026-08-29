import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationTurnWindow } from "../src/features/conversation/ConversationTurnWindow";
import type { ProductTurn } from "../src/types/view-models";

const turns: ProductTurn[] = [
	{
		id: "turn-1",
		userMessages: [
			{
				entryKey: "turn-1:u0",
				text: "latest",
				source: "prompt",
				delivered: true,
			},
		],
		steps: [],
		status: "settled",
	},
];

describe("conversation history controls", () => {
	it("shows a bounded remote history control with loading and retry states", () => {
		const scrollContainerRef = createRef<HTMLDivElement>();
		const loading = renderToStaticMarkup(
			createElement(ConversationTurnWindow, {
				turns,
				statusRows: [],
				sessionHandle: "session-history",
				remoteHistoryHasOlder: true,
				remoteHistoryLoading: true,
				scrollContainerRef,
			}),
		);
		const retry = renderToStaticMarkup(
			createElement(ConversationTurnWindow, {
				turns,
				statusRows: [],
				sessionHandle: "session-history",
				remoteHistoryHasOlder: true,
				remoteHistoryError: "history failed",
				scrollContainerRef,
			}),
		);

		expect(loading).toContain('data-load-older-turns="true"');
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toMatch(/正在加载更早消息|Loading older messages/);
		expect(retry).toMatch(/再次加载更早消息|Try loading older messages again/);
		expect(retry).toContain("history failed");
	});

	it("does not render a remote control when no older cursor exists", () => {
		const html = renderToStaticMarkup(
			createElement(ConversationTurnWindow, {
				turns,
				statusRows: [],
				sessionHandle: "session-history",
				remoteHistoryHasOlder: false,
				scrollContainerRef: createRef<HTMLDivElement>(),
			}),
		);

		expect(html).not.toContain('data-load-older-turns="true"');
	});
});
