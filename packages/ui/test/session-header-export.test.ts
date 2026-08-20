import { describe, expect, it, vi } from "vitest";
import { copyExportHtmlUrl, parseExportHtmlResult } from "../src/features/conversation/SessionHeader";

describe("SessionHeader HTML export", () => {
	it("accepts a file URL and copies it exactly once", async () => {
		const result = parseExportHtmlResult({
			path: "/tmp/report #1 中文.html",
			url: "file:///tmp/report%20%231%20%E4%B8%AD%E6%96%87.html",
		});
		const writeText = vi.fn(async () => undefined);

		await copyExportHtmlUrl(result, { writeText });

		expect(writeText).toHaveBeenCalledOnce();
		expect(writeText).toHaveBeenCalledWith(result.url);
	});

	it("fails closed on a non-file URL", () => {
		expect(() =>
			parseExportHtmlResult({ path: "/tmp/report.html", url: "javascript:alert(document.cookie)" }),
		).toThrow("invalid export URL");
	});

	it("preserves clipboard rejection for diagnostic feedback", async () => {
		const result = parseExportHtmlResult({
			path: "/tmp/report.html",
			url: "file:///tmp/report.html",
		});
		const writeText = vi.fn(async () => {
			throw new Error("clipboard permission denied");
		});

		await expect(copyExportHtmlUrl(result, { writeText })).rejects.toThrow("clipboard permission denied");
		expect(writeText).toHaveBeenCalledOnce();
	});
});
