import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/lib/format";

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
});
