import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { installBrowserBenchmarkObserver } from "./benchmark-support";

declare const afterEach: typeof import("node:test").afterEach;
declare const describe: typeof import("node:test").describe;
declare const it: typeof import("node:test").it;

const browsers: Array<Awaited<ReturnType<typeof chromium.launch>>> = [];

afterEach(async () => {
	for (const browser of browsers.splice(0)) await browser.close();
});

describe("benchmark Browser observer", () => {
	it("keeps native requestAnimationFrame intact while observing a native paint", async () => {
		const browser = await chromium.launch({
			headless: true,
			args: ["--enable-precise-memory-info"],
		});
		browsers.push(browser);
		const page = await browser.newPage();
		await installBrowserBenchmarkObserver(page);
		await page.goto("data:text/html,<main>benchmark observer</main>");

		const observed = await page.evaluate(async () => {
			type Snapshot = { inputToNextPaintMs: number | null };
			type BenchmarkWindow = Window & {
				__piwebBenchmark: {
					markSettled: () => void;
					markStreamEnd: () => void;
					snapshot: () => Snapshot;
					start: () => void;
				};
			};
			const nativeRequestAnimationFrame = window.requestAnimationFrame;
			const benchmark = (window as unknown as BenchmarkWindow).__piwebBenchmark;
			benchmark.start();
			const streaming = document.createElement("div");
			streaming.dataset.markdownStreaming = "true";
			streaming.textContent = "native paint observation";
			document.body.append(streaming);
			await new Promise<void>((resolve) =>
				window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
			);
			benchmark.markStreamEnd();
			benchmark.markSettled();
			return {
				inputToNextPaintMs: benchmark.snapshot().inputToNextPaintMs,
				nativeRequestAnimationFramePreserved: nativeRequestAnimationFrame === window.requestAnimationFrame,
			};
		});

		assert.equal(observed.nativeRequestAnimationFramePreserved, true);
		assert.notEqual(observed.inputToNextPaintMs, null);
		assert.ok((observed.inputToNextPaintMs ?? -1) >= 0);
	});
});
