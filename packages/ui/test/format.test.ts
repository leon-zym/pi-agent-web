import { RpcError, type SessionPayloadAdmissionErrorDto } from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import {
	displayError,
	displayLabel,
	exceedsUtf8ByteLimit,
	formatExactDateTime,
	stripAnsi,
	tailTeaser,
} from "../src/lib/format";
import { useI18n } from "../src/lib/i18n";
import { en } from "../src/lib/i18n/en";

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

	it("extracts tail teaser summary from multiline text", () => {
		expect(tailTeaser("First thought.\nSecond thought.\nFinal conclusion.")).toBe("Final conclusion.");
		expect(tailTeaser("  \n  Single line  \n  ")).toBe("Single line");
		expect(tailTeaser("")).toBe("");
	});

	it("keeps the last readable thought ahead of Markdown-only tail markers", () => {
		expect(tailTeaser("Draft\nReadable conclusion.\n```\n")).toBe("Readable conclusion.");
		expect(tailTeaser("Readable conclusion.\n###\n-\n| --- | :---: |")).toBe("Readable conclusion.");
		expect(tailTeaser("分析过程\n\u001b[31m最终结论。\u001b[0m\n~~~markdown")).toBe("最终结论。");
		expect(tailTeaser(" \n\t\n---\n```\n")).toBe("");
		expect(tailTeaser("Earlier\n## Readable heading")).toBe("## Readable heading");
		expect(tailTeaser("Earlier\n- readable list item")).toBe("- readable list item");
		expect(tailTeaser("| --- |\n| 可读内容 |")).toBe("| 可读内容 |");
	});
});

describe("UTF-8 text budgets", () => {
	it("counts Unicode code points at the exact boundary", () => {
		expect(exceedsUtf8ByteLimit("中文", 6)).toBe(false);
		expect(exceedsUtf8ByteLimit("中文", 5)).toBe(true);
		expect(exceedsUtf8ByteLimit("🧪", 4)).toBe(false);
		expect(exceedsUtf8ByteLimit("🧪", 3)).toBe(true);
	});
});

describe("payload admission errors", () => {
	it("maps every structured code through localized copy instead of Gateway error text", () => {
		useI18n.getState().setLocale("en");
		const cases: Array<[SessionPayloadAdmissionErrorDto, string]> = [
			[
				{
					type: "payload_admission_error",
					code: "payload_too_large",
					boundary: "attachment_blob",
					limitBytes: 1024,
					actualBytes: 2048,
				},
				"payloadAdmission.payload_too_large",
			],
			[
				{
					type: "payload_admission_error",
					code: "attachment_cache_exhausted",
					boundary: "attachment_cache",
					limitBytes: 1024,
					actualBytes: 2048,
				},
				"payloadAdmission.attachment_cache_exhausted",
			],
			[
				{
					type: "payload_admission_error",
					code: "attachment_cache_item_limit_exceeded",
					boundary: "attachment_cache",
					limitItems: 16,
					actualItems: 17,
				},
				"payloadAdmission.attachment_cache_item_limit_exceeded",
			],
			[
				{
					type: "payload_admission_error",
					code: "attachment_ref_invalid",
					boundary: "attachment_ref",
				},
				"payloadAdmission.attachment_ref_invalid",
			],
			[
				{
					type: "payload_admission_error",
					code: "attachment_ref_epoch_mismatch",
					boundary: "attachment_ref",
				},
				"payloadAdmission.attachment_ref_epoch_mismatch",
			],
			[
				{
					type: "payload_admission_error",
					code: "attachment_unavailable",
					boundary: "attachment_ref",
				},
				"payloadAdmission.attachment_unavailable",
			],
			[
				{
					type: "payload_admission_error",
					code: "capability_required",
					boundary: "capability",
				},
				"payloadAdmission.capability_required",
			],
		];
		const dictionary = en as Record<string, string>;

		for (const [admissionError, key] of cases) {
			expect(dictionary[key]).toEqual(expect.any(String));
			expect(displayError(new RpcError("prompt", "Gateway delivery failure", admissionError))).toBe(
				dictionary[key],
			);
		}
	});
});
