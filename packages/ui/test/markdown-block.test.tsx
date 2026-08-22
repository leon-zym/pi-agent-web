import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SettledMarkdown from "../src/features/conversation/SettledMarkdown";
import { stripAnsi } from "../src/lib/format";

describe("MarkdownBlock progressive streaming markdown", () => {
	it("renders headings, lists, bold, and code blocks progressively during streaming", () => {
		const streamingMarkdown =
			"# Heading 1\n\nThis is **bold** and *italic* with `inline code`.\n\n- item 1\n- item 2\n\n```ts\nconst x = 42;\n```";
		const html = renderToStaticMarkup(
			createElement(SettledMarkdown, {
				text: streamingMarkdown,
				streaming: true,
			}),
		);

		expect(html).toContain("<h1>Heading 1</h1>");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>italic</em>");
		expect(html).toContain("<code>inline code</code>");
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>item 1</li>");
		expect(html).toContain("<pre><code");
		expect(html).toContain("x = ");
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
});
