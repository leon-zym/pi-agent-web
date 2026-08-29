import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownBlock } from "../src/features/conversation/MarkdownBlock";
import SettledMarkdown from "../src/features/conversation/SettledMarkdown";
import { stripAnsi } from "../src/lib/format";

describe("MarkdownBlock progressive streaming markdown", () => {
	it("keeps the streaming tail as selectable plain text", () => {
		const streamingMarkdown =
			"# Heading 1\n\nThis is **bold** and *italic* with `inline code`.\n\n- item 1\n- item 2\n\n```ts\nconst x = 42;\n```";
		const html = renderToStaticMarkup(
			createElement(MarkdownBlock, {
				text: streamingMarkdown,
				streaming: true,
			}),
		);

		expect(html).toContain("# Heading 1");
		expect(html).toContain("**bold**");
		expect(html).toContain("`inline code`");
		expect(html).toContain("- item 1");
		expect(html).toContain("```ts");
		expect(html).toContain("whitespace-pre-wrap");
		expect(html).not.toContain("<h1>");
		expect(html).not.toContain("<strong>");
		expect(html).not.toContain("<pre>");
	});

	it("sanitizes terminal controls before mounting the streaming tail", () => {
		const html = renderToStaticMarkup(
			createElement(MarkdownBlock, {
				text: "\u001b[31mLive alert\u001b[0m",
				streaming: true,
			}),
		);

		expect(html).toContain("Live alert");
		expect(html).not.toContain("\u001b[31m");
	});

	it("strips ANSI color escape sequences cleanly", () => {
		const ansiText = "\u001b[31mRed Alert\u001b[0m: all good";
		const clean = stripAnsi(ansiText);
		const html = renderToStaticMarkup(
			createElement(SettledMarkdown, {
				text: clean,
			}),
		);

		expect(html).toContain("Red Alert: all good");
		expect(html).not.toContain("\u001b[31m");
	});

	it("uses a bounded selectable fallback for oversized settled Markdown", () => {
		const largeMarkdown = `# Large response\n\n${"plain text ".repeat(30_000)}`;
		const html = renderToStaticMarkup(
			createElement(MarkdownBlock, {
				text: largeMarkdown,
				streaming: false,
			}),
		);

		expect(html).toContain('data-markdown-large="true"');
		expect(html).toContain("# Large response");
		expect(html).not.toContain("<h1>");
	});
});
