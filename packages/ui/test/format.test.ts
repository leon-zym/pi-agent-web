import { describe, expect, it } from "vitest";
import { displayLabel, formatExactDateTime, stripAnsi } from "../src/lib/format";

it("formats an exact local timestamp through seconds", () => {
	const timestamp = new Date(2026, 7, 21, 6, 7, 8).getTime();
	expect(formatExactDateTime(timestamp)).toBe("2026-08-21 06:07:08");
	expect(formatExactDateTime(Number.NaN)).toBe("--");
});

describe("stripAnsi", () => {
	it("removes CSI colors and cursor controls", () => {
		expect(stripAnsi("\u001b[31mred\u001b[0m plain \u001b[2Kdone")).toBe("red plain done");
		expect(stripAnsi("\u009b32mgreen\u009b0m")).toBe("green");
	});

	it("removes OSC hyperlinks terminated by BEL or ST", () => {
		const linked = "\u001b]8;;https://example.com\u0007link\u001b]8;;\u001b\\";
		expect(stripAnsi(linked)).toBe("link");
	});

	it("removes DCS strings and short escape forms", () => {
		expect(stripAnsi("a\u001bPignored\u001b\\b\u001b(0c")).toBe("abc");
	});

	it("preserves ordinary text, newlines, and tabs", () => {
		const text = "alpha\n\tbeta 中文";
		expect(stripAnsi(text)).toBe(text);
	});

	it("removes standalone controls and bidi formatting without flattening lines", () => {
		expect(stripAnsi("safe\u0000\u0007\b\u007f\u202eevil\u202c\nnext\tcell")).toBe("safeevil\nnext\tcell");
	});

	it("collapses whitespace for one-line presentation labels", () => {
		expect(displayLabel("  title\n\u001b[31mred\u001b[0m\tvalue  ")).toBe("title red value");
	});
});
