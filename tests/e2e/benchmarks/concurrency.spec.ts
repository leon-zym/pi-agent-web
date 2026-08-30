import type { Page, WebSocket } from "@playwright/test";
import { observePageErrors } from "../fixtures/page-observation";
import type { PiFixtureEvent, ProductionHarness } from "../fixtures/production-harness";
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

async function sendPrompt(page: Page, prompt: string): Promise<void> {
	await page.locator("textarea").fill(prompt);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
}

function eventFor(harness: ProductionHarness, type: string, prompt: string): PiFixtureEvent | undefined {
	return harness.piEvents().find((event) => event.type === type && event.text === prompt);
}

function maxProgressGap(events: PiFixtureEvent[], prompt: string): number {
	const promptEvent = events.find((event) => event.type === "prompt" && event.text === prompt);
	const progress = events
		.filter((event) => event.text === prompt && (event.type === "delta" || event.type === "stream_end"))
		.map((event) => event.at)
		.sort((left, right) => left - right);
	if (!promptEvent || progress.length === 0) return Number.POSITIVE_INFINITY;
	let previous = promptEvent.at;
	let maximum = 0;
	for (const at of progress) {
		maximum = Math.max(maximum, at - previous);
		previous = at;
	}
	return maximum;
}

for (const scenario of scenariosFor("concurrency")) {
	test(`${scenario.id} keeps background Sessions progressing without starvation`, async ({
		page,
		harness,
	}, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, scenario, async (outcome) => {
			const sessionCount = scenario.sessions;
			const targetBytes = scenario.targetBytes;
			const chunkBytes = scenario.chunkBytes;
			const chunkDelayMs = scenario.chunkDelayMs;
			if (
				sessionCount === undefined ||
				targetBytes === undefined ||
				chunkBytes === undefined ||
				chunkDelayMs === undefined
			) {
				throw new Error("concurrency scenario is missing workload parameters");
			}
			const errors = observePageErrors(page);
			const sockets: WebSocket[] = [];
			const closedSockets: WebSocket[] = [];
			page.on("websocket", (socket) => {
				sockets.push(socket);
				socket.on("close", () => closedSockets.push(socket));
			});
			await installBrowserBenchmarkObserver(page);
			await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
			await expect(page.locator("#root > div")).toBeVisible();
			await expect(page.locator("textarea")).toBeEnabled();
			const cdp = await page.context().newCDPSession(page);
			const sessionIdentityPrompts: Array<string | undefined> = Array.from({ length: sessionCount });
			const trialCount = scenario.warmups + scenario.samples;

			for (let index = 0; index < trialCount; index += 1) {
				const prompts = Array.from({ length: sessionCount }, (_, sessionIndex) =>
					[
						"E2E_BENCH_STREAM",
						String(targetBytes),
						String(chunkBytes),
						String(chunkDelayMs),
						`${index.toString(36)}${sessionIndex.toString(36)}s${String(sessionCount)}`,
					].join(":"),
				);
				await cdp.send("HeapProfiler.collectGarbage");
				await startBrowserMeasurement(page);

				for (const [sessionIndex, prompt] of prompts.entries()) {
					const identityPrompt = sessionIdentityPrompts[sessionIndex];
					if (identityPrompt) {
						const row = page.locator("[data-session-row]").filter({ hasText: identityPrompt });
						await expect(row).toHaveCount(1);
						await row.getByRole("button").first().click();
						await expect(page.locator("textarea")).toBeEnabled();
					}
					await sendPrompt(page, prompt);
					await expect.poll(() => eventFor(harness, "delta", prompt), { timeout: 30_000 }).toBeTruthy();
					sessionIdentityPrompts[sessionIndex] ??= prompt;
					if (index === 0 && sessionIndex < sessionCount - 1) {
						await page
							.getByRole("navigation", { name: /^(Sidebar|侧栏)$/ })
							.getByRole("button", { name: /^(New session|新建会话)$/ })
							.first()
							.click();
						await expect(page.locator("textarea")).toBeEnabled();
					}
				}

				await expect
					.poll(() => prompts.every((prompt) => eventFor(harness, "stream_end", prompt) !== undefined), {
						timeout: 90_000,
					})
					.toBe(true);
				await markBrowserStreamEnd(page);
				for (const prompt of prompts) harness.releasePrompt(prompt);
				await expect
					.poll(() => prompts.every((prompt) => eventFor(harness, "settled", prompt) !== undefined), {
						timeout: 90_000,
					})
					.toBe(true);

				let projectedSessions = 0;
				for (const [sessionIndex] of prompts.entries()) {
					const identityPrompt = sessionIdentityPrompts[sessionIndex];
					if (!identityPrompt) throw new Error("Session identity prompt was not captured");
					const row = page.locator("[data-session-row]").filter({ hasText: identityPrompt });
					await expect(row).toHaveCount(1);
					await row.getByRole("button").first().click();
					const settled = page.locator('[data-markdown-settled="true"]').last();
					await expect(settled).toContainText("STREAM_BUDGET_END", { timeout: 30_000 });
					projectedSessions += 1;
				}
				await cdp.send("HeapProfiler.collectGarbage");
				const browserMetrics = await finishBrowserMeasurement(page);
				const events = harness.piEvents();
				const starts = prompts.map((prompt) => eventFor(harness, "prompt", prompt)?.at ?? 0);
				const ends = prompts.map((prompt) => eventFor(harness, "stream_end", prompt)?.at ?? 0);
				const deltaCount = prompts.reduce(
					(total, prompt) => total + (eventFor(harness, "stream_end", prompt)?.deltaCount ?? 0),
					0,
				);
				const overlapMs = Math.max(...ends) - Math.min(...starts);
				outcome.trials.push({
					index,
					warmup: index < scenario.warmups,
					metrics: {
						...browserMetrics,
						maxProgressGapMs: Math.max(...prompts.map((prompt) => maxProgressGap(events, prompt))),
						completionSkewMs: Math.max(...ends) - Math.min(...ends),
						aggregateDeltaPerSecond: overlapMs > 0 ? (deltaCount * 1_000) / overlapMs : null,
					},
					correctness: {
						allSessionsStarted: starts.every((at) => at > 0),
						allSessionsSettled: ends.every((at) => at > 0),
						allBackgroundProjectionsRecovered: projectedSessions === sessionCount,
						singleMultiplexedSocket: sockets.length === 1 && closedSockets.length === 0,
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
				"Every subscribed Session must settle once and remain recoverable from its background projection.",
			);
			addSummaryGate(
				outcome,
				"maxProgressGapMs",
				"p95",
				"lte",
				1_000,
				"hard",
				"A one-second progress silence is a practical starvation signal under deterministic pacing.",
			);
			addSummaryGate(
				outcome,
				"completionSkewMs",
				"p95",
				"lte",
				2_000,
				"hard",
				"Repeated p95 completion skew bounds gross cross-Session unfairness without timing exactness.",
			);
			addSummaryGate(
				outcome,
				"liveLongTaskMaxMs",
				"p95",
				"lte",
				300,
				"hard",
				"Visible-session rendering must not monopolize Chromium while background channels ingest.",
			);
			addSummaryGate(
				outcome,
				"heapDeltaBytes",
				"p95",
				"lte",
				256 * 1024 * 1024,
				"observe",
				"Cross-platform GC makes this a recorded trend until reference-host baselines exist.",
			);
			addSummaryGate(
				outcome,
				"aggregateDeltaPerSecond",
				"median",
				"gte",
				sessionCount === 8 && scenario.samples >= 8 ? 800 : 1,
				"observe",
				"Stress 8-Session runs target roughly 1000 aggregate deltas/s; arrival rate is reported, not fabricated.",
			);
			addValueGate(
				outcome,
				"browserErrors",
				errors.console.length + errors.page.length,
				"eq",
				0,
				"hard",
				"Console or page errors invalidate fairness samples.",
			);
		});
	});
}
