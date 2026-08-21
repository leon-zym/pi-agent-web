import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	formatJsonCode,
	formatToolArguments,
	MAX_SYNTAX_HIGHLIGHT_CHARACTERS,
	MAX_SYNTAX_HIGHLIGHT_UTF8_BYTES,
	shouldSyntaxHighlight,
} from "../src/features/conversation/code-display";
import { HighlightedCode } from "../src/features/conversation/HighlightedCode";
import HighlightedCodeContent from "../src/features/conversation/HighlightedCodeContent";

describe("structured code display", () => {
	it("prefers settled structured arguments over compact streamed text", () => {
		expect(
			formatToolArguments({ path: "src/app.ts", range: { start: 1, end: 4 } }, '{"stale":true}'),
		).toEqual({
			code: '{\n  "path": "src/app.ts",\n  "range": {\n    "start": 1,\n    "end": 4\n  }\n}',
			language: "json",
		});
	});

	it("pretty-prints complete streamed JSON and preserves incomplete JSON verbatim", () => {
		expect(formatToolArguments(undefined, '{"path":"src/app.ts"}')).toEqual({
			code: '{\n  "path": "src/app.ts"\n}',
			language: "json",
		});
		expect(formatToolArguments(undefined, '{"path":')).toEqual({
			code: '{"path":',
			language: undefined,
		});
	});

	it("serializes event payloads as stable pretty JSON", () => {
		expect(formatJsonCode({ type: "message", payload: "<img src=x onerror=alert(1)>" })).toBe(
			'{\n  "type": "message",\n  "payload": "<img src=x onerror=alert(1)>"\n}',
		);
	});

	it("escapes markup in highlighted JSON instead of creating executable HTML", () => {
		const html = renderToStaticMarkup(
			<HighlightedCodeContent code={'{"payload":"<img src=x onerror=alert(1)>"}'} language="json" />,
		);
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain("<img");
	});

	it("bounds syntax highlighting by both character count and UTF-8 bytes", () => {
		expect(shouldSyntaxHighlight("x".repeat(MAX_SYNTAX_HIGHLIGHT_CHARACTERS))).toBe(true);
		expect(shouldSyntaxHighlight("x".repeat(MAX_SYNTAX_HIGHLIGHT_CHARACTERS + 1))).toBe(false);

		const utf8Heavy = "界".repeat(Math.floor(MAX_SYNTAX_HIGHLIGHT_UTF8_BYTES / 3) + 1);
		expect(Array.from(utf8Heavy)).toHaveLength(Math.floor(MAX_SYNTAX_HIGHLIGHT_UTF8_BYTES / 3) + 1);
		expect(shouldSyntaxHighlight(utf8Heavy)).toBe(false);
	});

	it("keeps multi-MiB streamed arguments raw instead of synchronously parsing and pretty-printing", () => {
		const raw = `{"payload":"${"x".repeat(3 * 1024 * 1024)}"}`;
		const formatted = formatToolArguments(undefined, raw);
		expect(formatted.language).toBe("json");
		expect(formatted.code === raw).toBe(true);
	});

	it("renders oversized JSON as escaped plain text without loading the highlighter surface", () => {
		const dangerous = '<img src=x onerror="globalThis.pwned=true">';
		const code = `{"payload":"${dangerous}${"x".repeat(1024 * 1024)}"}`;
		const html = renderToStaticMarkup(<HighlightedCode code={code} language="json" />);

		expect(html).toContain('data-syntax-highlight="skipped-size"');
		expect(html).toContain("&lt;img src=x onerror=&quot;globalThis.pwned=true&quot;&gt;");
		expect(html.includes("<img")).toBe(false);
		expect(html.includes("hljs-attr")).toBe(false);
	});

	it("defensively skips direct highlighter calls for oversized Bash", () => {
		const code = `printf '<unsafe>'\n${"echo payload\n".repeat(250_000)}`;
		const html = renderToStaticMarkup(<HighlightedCodeContent code={code} language="bash" />);

		expect(Buffer.byteLength(code, "utf8")).toBeGreaterThan(3 * 1024 * 1024);
		expect(html).toContain('data-syntax-highlight="skipped-size"');
		expect(html).toContain("&lt;unsafe&gt;");
		expect(html.includes("hljs-string")).toBe(false);
	});
});
