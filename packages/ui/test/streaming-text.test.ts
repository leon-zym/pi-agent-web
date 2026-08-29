import { describe, expect, it } from "vitest";
import { appendStreamingTextSegments, splitStreamingText } from "../src/features/conversation/streaming-text";

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				index += 1;
				continue;
			}
			return true;
		}
		if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

describe("streaming text segments", () => {
	it("splits the initial text into bounded segments", () => {
		expect(splitStreamingText("abcdefgh", 4)).toEqual(["abcd", "efgh"]);
		expect(splitStreamingText("abc", 4)).toEqual(["abc"]);
	});

	it("appends only the changing suffix and keeps segment boundaries bounded", () => {
		const previous = splitStreamingText("abcdefgh", 4);
		expect(appendStreamingTextSegments(previous, "ijkl", 4)).toEqual(["abcd", "efgh", "ijkl"]);
		expect(appendStreamingTextSegments(previous, "ijk", 4)).toEqual(["abcd", "efgh", "ijk"]);
	});

	it("does not split astral Unicode characters at a segment boundary", () => {
		const emoji = "🧪";
		const segments = splitStreamingText(`aaa${emoji}bb`, 4);

		expect(segments.join(" ")).toBe(`aaa ${emoji}bb`);
		expect(segments.every((segment) => !hasUnpairedSurrogate(segment))).toBe(true);
		expect(appendStreamingTextSegments(splitStreamingText("aa", 4), `${emoji}bb`, 4).join("")).toBe(
			`aa${emoji}bb`,
		);
	});

	it("joins a surrogate pair that arrives across two stream deltas", () => {
		const highSurrogate = "\ud83e";
		const lowSurrogate = "\uddea";
		const segments = appendStreamingTextSegments(
			splitStreamingText(`aaa${highSurrogate}`, 4),
			`${lowSurrogate}bb`,
			4,
		);

		expect(segments.join("")).toBe("aaa🧪bb");
		expect(segments.every((segment) => !hasUnpairedSurrogate(segment))).toBe(true);
	});
});
