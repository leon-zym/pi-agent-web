import { observePageErrors } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";
import {
	addSummaryGate,
	addValueGate,
	correctnessFailureCount,
	finishBrowserMeasurement,
	installBrowserBenchmarkObserver,
	markBrowserStreamEnd,
	runBenchmarkScenario,
	scenariosFor,
	startBrowserMeasurement,
} from "./benchmark-support";

for (const scenario of scenariosFor("streaming")) {
	test(`${scenario.id} emits a reproducible Chromium streaming profile`, async ({
		page,
		harness,
	}, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, scenario, async (outcome) => {
			const targetBytes = scenario.targetBytes;
			const chunkBytes = scenario.chunkBytes;
			const chunkDelayMs = scenario.chunkDelayMs;
			if (targetBytes === undefined || chunkBytes === undefined || chunkDelayMs === undefined) {
				throw new Error("streaming scenario is missing workload parameters");
			}
			const errors = observePageErrors(page);
			await installBrowserBenchmarkObserver(page);
			await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
			await expect(page.locator("#root > div")).toBeVisible();
			await expect(page.locator("textarea")).toBeEnabled();
			const cdp = await page.context().newCDPSession(page);
			const trialCount = scenario.warmups + scenario.samples;

			for (let index = 0; index < trialCount; index += 1) {
				const prompt = [
					"E2E_BENCH_STREAM",
					String(targetBytes),
					String(chunkBytes),
					String(chunkDelayMs),
					`${scenario.id}-${String(index)}`,
				].join(":");
				await cdp.send("HeapProfiler.collectGarbage");
				await startBrowserMeasurement(page);
				await page.locator("textarea").fill(prompt);
				await page.getByRole("button", { name: /^(Send|发送)$/ }).click();

				await expect
					.poll(() => harness.piEvents().some((event) => event.type === "delta" && event.text === prompt))
					.toBe(true);
				const streaming = page.locator('[data-markdown-streaming="true"]');
				await expect(streaming).toHaveCount(1);
				await expect
					.poll(() => streaming.evaluate((element) => element.textContent?.length ?? 0))
					.toBeGreaterThan(0);
				const liveRichNodes = await streaming.locator("h1,h2,h3,strong,em,pre,table,ul,ol").count();
				await expect
					.poll(
						() => harness.piEvents().find((event) => event.type === "stream_end" && event.text === prompt),
						{ timeout: 30_000 },
					)
					.toBeTruthy();
				const streamEnd = harness
					.piEvents()
					.find((event) => event.type === "stream_end" && event.text === prompt);
				if (streamEnd?.markdownChars === undefined || streamEnd.deltaCount === undefined) {
					throw new Error("stream fixture did not record its final character and delta counts");
				}
				await expect
					.poll(() => streaming.evaluate((element) => element.textContent?.length ?? 0))
					.toBe(streamEnd.markdownChars);
				await markBrowserStreamEnd(page);
				harness.releasePrompt(prompt);
				await expect
					.poll(() => harness.piEvents().some((event) => event.type === "settled" && event.text === prompt), {
						timeout: 30_000,
					})
					.toBe(true);
				const settled = page.locator('[data-markdown-settled="true"]').last();
				await expect(settled).toBeVisible({ timeout: 30_000 });
				const settledText = await settled.textContent();
				const largeFrames = harness
					.piEvents()
					.filter((event) => event.type === "large_frame" && event.text === prompt);
				await cdp.send("HeapProfiler.collectGarbage");
				const metrics = await finishBrowserMeasurement(page);
				outcome.trials.push({
					index,
					warmup: index < scenario.warmups,
					metrics: {
						...metrics,
						deltaCount: streamEnd.deltaCount,
						publicationRatio: metrics.publicationBatches / streamEnd.deltaCount,
					},
					correctness: {
						liveTailStayedPlain: liveRichNodes === 0,
						settledEndSentinel: settledText?.includes("STREAM_BUDGET_END") ?? false,
						settledUnicode: settledText?.includes("🧪") ?? false,
						structuralFramesFlushed:
							largeFrames.map((event) => event.eventType).join(",") === "text_end,message_end",
						frameBudgetPreserved: largeFrames.every((event) => (event.frameBytes ?? 0) > targetBytes),
					},
				});
			}

			addValueGate(
				outcome,
				"correctnessFailures",
				correctnessFailureCount(outcome.trials),
				"eq",
				0,
				"hard",
				"Streaming and structural boundaries are correctness constraints, including warmups.",
			);
			addSummaryGate(
				outcome,
				"publicationRatio",
				"p95",
				"lte",
				0.5,
				"hard",
				"DOM publication batches must remain materially below incoming small-delta count.",
			);
			addSummaryGate(
				outcome,
				"inputToNextPaintMs",
				"p95",
				"lte",
				1_000,
				"hard",
				"Three-sample p95 with a generous budget detects a lost/coarsely delayed first paint.",
			);
			addSummaryGate(
				outcome,
				"liveLongTaskMaxMs",
				"p95",
				"lte",
				250,
				"hard",
				"Extends the existing 200 ms single-run diagnostic with a noise margin and repeated p95.",
			);
			addSummaryGate(
				outcome,
				"liveLongTasksOver50Ms",
				"p95",
				"lte",
				6,
				"hard",
				"Repeated long-task bursts indicate coalescing or rendering regression.",
			);
			addSummaryGate(
				outcome,
				"settlementMs",
				"p95",
				"lte",
				2_500,
				"hard",
				"Structural settle has a repeated-sample budget derived from the existing 2 s cold gate.",
			);
			addSummaryGate(
				outcome,
				"heapDeltaBytes",
				"p95",
				"lte",
				96 * 1024 * 1024,
				"hard",
				"Precise-heap p95 allows GC noise above the prior 64 MiB one-shot budget.",
			);
			addSummaryGate(
				outcome,
				"turnNodes",
				"max",
				"lte",
				64,
				"hard",
				"Conversation virtualization must keep the retained turn DOM bounded.",
			);
			addSummaryGate(
				outcome,
				"totalCompletionMs",
				"p95",
				"lte",
				15_000,
				"observe",
				"End-to-end completion includes deterministic fixture pacing and is recorded, not a portable gate.",
			);
			addValueGate(
				outcome,
				"browserErrors",
				errors.console.length + errors.page.length,
				"eq",
				0,
				"hard",
				"Browser console and page failures invalidate performance samples.",
			);
		});
	});
}
