import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	detectMentionTrigger,
	isMentionCommitKey,
	selectFileMention,
} from "../src/features/composer/composer-input";
import { FileMentionMenu } from "../src/features/composer/FileMentionMenu";
import { useComposerStore } from "../src/stores/composer";

describe("file mention triggers and helpers", () => {
	it("detects @ mention triggers at word boundaries", () => {
		expect(detectMentionTrigger("@", 1)).toEqual({ index: 0, query: "" });
		expect(detectMentionTrigger("@src", 4)).toEqual({ index: 0, query: "src" });
		expect(detectMentionTrigger("hello @file", 11)).toEqual({ index: 6, query: "file" });
		expect(detectMentionTrigger("check (@comp", 12)).toEqual({ index: 7, query: "comp" });
		expect(detectMentionTrigger("foo[@bar", 8)).toEqual({ index: 4, query: "bar" });
		expect(detectMentionTrigger("foo{@bar", 8)).toEqual({ index: 4, query: "bar" });

		// Should not trigger inside words or after spaces in query
		expect(detectMentionTrigger("user@example.com", 16)).toBeNull();
		expect(detectMentionTrigger("@file name", 10)).toBeNull();
		expect(detectMentionTrigger("no at symbol", 5)).toBeNull();
	});

	it("selects and formats file mention in draft text", () => {
		const res1 = selectFileMention("@", { index: 0, query: "" }, "src/index.ts");
		expect(res1.draft).toBe("@src/index.ts ");
		expect(res1.cursor).toBe(14);

		const res2 = selectFileMention(
			"Please check @ind for details",
			{ index: 13, query: "ind" },
			"src/index.ts",
			17,
		);
		expect(res2.draft).toBe("Please check @src/index.ts for details");
		expect(res2.cursor).toBe(26);
	});

	it("identifies mention commit keys correctly", () => {
		expect(isMentionCommitKey({ key: "Enter" })).toBe(true);
		expect(isMentionCommitKey({ key: "Tab" })).toBe(true);
		expect(isMentionCommitKey({ key: "Enter", shiftKey: true })).toBe(false);
		expect(isMentionCommitKey({ key: "Enter", metaKey: true })).toBe(false);
		expect(isMentionCommitKey({ key: "Enter", ctrlKey: true })).toBe(false);
		expect(isMentionCommitKey({ key: "ArrowDown" })).toBe(false);
	});
});

describe("FileMentionMenu component markup", () => {
	beforeEach(() => {
		useComposerStore.setState({
			mentionTrigger: { index: 0, query: "" },
		});
		vi.restoreAllMocks();
	});

	it("renders loading or empty state correctly when mounted initially", () => {
		const html = renderToStaticMarkup(
			createElement(FileMentionMenu, {
				workspaceHandle: "ws-test",
				onCapture: async () => {
					throw new Error("not called during server render");
				},
				onSelect: () => undefined,
			}),
		);

		expect(html).toContain('data-testid="file-mention-empty"');
	});
});
