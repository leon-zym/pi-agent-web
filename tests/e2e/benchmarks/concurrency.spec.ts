import type { Page, WebSocket } from "@playwright/test";
import { observePageErrors } from "../fixtures/page-observation";
import type { HarnessSession, PiFixtureEvent, ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";
import {
	addSummaryGate,
	addValueGate,
	browserSessionFrameSnapshot,
	correctnessFailureCount,
	finishBrowserMeasurement,
	installBrowserBenchmarkObserver,
	markBrowserStreamEnd,
	resetBrowserSessionFrames,
	runBenchmarkScenario,
	scenariosFor,
	startBrowserMeasurement,
} from "./benchmark-support";

test.use({ harnessOptions: { benchmarkGateway: true } });

async function sendPrompt(page: Page, prompt: string): Promise<void> {
	await page.locator("textarea").fill(prompt);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
}

function eventFor(harness: ProductionHarness, type: string, prompt: string): PiFixtureEvent | undefined {
	return harness.piEvents().find((event) => event.type === type && event.text === prompt);
}

function maxProgressGap(events: PiFixtureEvent[], prompt: string): number {
	const startEvent = events.find(
		(event) => event.type === "benchmark_start_observed" && event.text === prompt,
	);
	const progress = events
		.filter((event) => event.text === prompt && (event.type === "delta" || event.type === "stream_end"))
		.map((event) => event.at)
		.sort((left, right) => left - right);
	if (!startEvent || progress.length === 0) return Number.POSITIVE_INFINITY;
	let previous = startEvent.at;
	let maximum = 0;
	for (const at of progress) {
		maximum = Math.max(maximum, at - previous);
		previous = at;
	}
	return maximum;
}

async function sessionHandlesForPrompts(harness: ProductionHarness, prompts: string[]): Promise<string[]> {
	const directory = await harness.requestJson<{ sessions: HarnessSession[] }>(
		`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions?refresh=1`,
	);
	return prompts.map((prompt) => {
		const nativeSessionId = eventFor(harness, "prompt", prompt)?.sessionId;
		const session = directory.sessions.find((candidate) => candidate.nativeSessionId === nativeSessionId);
		if (!session) throw new Error(`Unable to resolve the materialized Session for ${prompt}`);
		return session.sessionHandle;
	});
}

for (const scenario of scenariosFor("concurrency")) {
	test(`${scenario.id} keeps background Sessions progressing without starvation`, async ({
		page,
		harness,
	}, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, harness, scenario, async (outcome, trials) => {
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
			const sessionIdentityPrompts: Array<string | undefined> = Array.from({ length: sessionCount });
			const trialCount = scenario.warmups + scenario.samples;

			for (let index = 0; index < trialCount; index += 1) {
				await trials.run(index, async () => {
					await startBrowserMeasurement(page);
					const prompts = Array.from({ length: sessionCount }, (_, sessionIndex) =>
						[
							"E2E_BENCH_STREAM",
							String(targetBytes),
							String(chunkBytes),
							String(chunkDelayMs),
							`g${index.toString(36)}${sessionIndex.toString(36)}s${String(sessionCount)}`,
						].join(":"),
					);
					for (const [sessionIndex, prompt] of prompts.entries()) {
						const identityPrompt = sessionIdentityPrompts[sessionIndex];
						if (identityPrompt) {
							const row = page.locator("[data-session-row]").filter({ hasText: identityPrompt });
							await expect(row).toHaveCount(1);
							await row.getByRole("button").first().click();
							await expect(page.locator("textarea")).toBeEnabled();
						}
						await sendPrompt(page, prompt);
						await expect.poll(() => eventFor(harness, "prompt", prompt), { timeout: 30_000 }).toBeTruthy();
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
					const sessionHandles = await sessionHandlesForPrompts(harness, prompts);
					await resetBrowserSessionFrames(page, sessionHandles);
					for (const prompt of prompts) harness.startPrompt(prompt);
					await expect
						.poll(() => prompts.every((prompt) => eventFor(harness, "delta", prompt) !== undefined), {
							timeout: 30_000,
						})
						.toBe(true);

					const expectedDeltas = Math.ceil(targetBytes / chunkBytes);
					const checkpoints = [
						Math.min(16, Math.max(1, expectedDeltas - 1)),
						Math.min(64, Math.max(2, Math.floor(expectedDeltas / 2))),
					].filter((checkpoint, checkpointIndex, values) => values.indexOf(checkpoint) === checkpointIndex);
					const observations = prompts.map(
						() =>
							[] as Array<{
								background: boolean;
								backgroundProgress: boolean;
								deltaFrames: number;
								projectionLagMs: number;
								maxFrameGapMs: number;
							}>,
					);
					let selectedSessionIndex = sessionCount - 1;
					const backgroundBaselines: Array<number | null> = prompts.map((_, sessionIndex) =>
						sessionIndex === selectedSessionIndex ? null : 0,
					);

					for (const checkpoint of checkpoints) {
						for (const [sessionIndex, prompt] of prompts.entries()) {
							const previous = observations[sessionIndex]?.at(-1)?.deltaFrames ?? 0;
							const backgroundBaseline = backgroundBaselines[sessionIndex];
							if (backgroundBaseline === undefined) throw new Error("Background baseline is missing");
							const minimumFrames = Math.min(
								expectedDeltas,
								Math.max(checkpoint, previous + 1, backgroundBaseline === null ? 0 : backgroundBaseline + 1),
							);
							await expect
								.poll(
									async () =>
										(await browserSessionFrameSnapshot(page, sessionHandles[sessionIndex] ?? "")).deltaFrames,
									{ timeout: 30_000 },
								)
								.toBeGreaterThanOrEqual(minimumFrames);
							const arrival = await browserSessionFrameSnapshot(page, sessionHandles[sessionIndex] ?? "");
							const identityPrompt = sessionIdentityPrompts[sessionIndex];
							if (!identityPrompt) throw new Error("Session identity prompt was not captured");
							const row = page.locator("[data-session-row]").filter({ hasText: identityPrompt });
							const wasBackground = (await row.getAttribute("data-current")) === "false";
							if (selectedSessionIndex !== sessionIndex) {
								const previousSelected = selectedSessionIndex;
								await row.getByRole("button").first().click();
								const previousHandle = sessionHandles[previousSelected];
								if (!previousHandle) throw new Error("Selected Session handle is missing");
								backgroundBaselines[previousSelected] = (
									await browserSessionFrameSnapshot(page, previousHandle)
								).deltaFrames;
								backgroundBaselines[sessionIndex] = null;
								selectedSessionIndex = sessionIndex;
							}
							const turn = page
								.getByRole("region", { name: /^(Conversation turn|对话轮次)$/ })
								.filter({ hasText: prompt });
							const streaming = turn.locator('[data-markdown-streaming="true"]');
							await expect(streaming).toHaveCount(1);
							await expect
								.poll(() => streaming.evaluate((element) => element.textContent?.length ?? 0), {
									timeout: 30_000,
								})
								.toBeGreaterThanOrEqual(arrival.deltaChars);
							const projectedAt = await page.evaluate(() => performance.now());
							observations[sessionIndex]?.push({
								background: sessionCount === 1 || wasBackground,
								backgroundProgress:
									sessionCount === 1 ||
									arrival.deltaFrames >= expectedDeltas ||
									(backgroundBaseline !== null && arrival.deltaFrames > backgroundBaseline),
								deltaFrames: arrival.deltaFrames,
								projectionLagMs:
									arrival.lastArrivalAt === null
										? Number.POSITIVE_INFINITY
										: projectedAt - arrival.lastArrivalAt,
								maxFrameGapMs: arrival.maxFrameGapMs,
							});
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
					const browserMetrics = await finishBrowserMeasurement(page);
					const events = harness.piEvents();
					const starts = prompts.map(
						(prompt) => eventFor(harness, "benchmark_start_observed", prompt)?.at ?? 0,
					);
					const ends = prompts.map((prompt) => eventFor(harness, "stream_end", prompt)?.at ?? 0);
					const durations = starts.map((startedAt, index) => (ends[index] ?? 0) - startedAt);
					const deltaCount = prompts.reduce(
						(total, prompt) => total + (eventFor(harness, "stream_end", prompt)?.deltaCount ?? 0),
						0,
					);
					const overlapMs = Math.max(...ends) - Math.min(...starts);
					const flatObservations = observations.flat();
					const minimumProjectionCheckpoints = Math.min(
						...observations.map((sessionObservations) => sessionObservations.length),
					);
					const minimumBackgroundCheckpoints =
						sessionCount === 1
							? 0
							: Math.min(
									...observations.map(
										(sessionObservations) =>
											sessionObservations.filter(
												(observation) => observation.background && observation.backgroundProgress,
											).length,
									),
								);
					return {
						metrics: {
							...browserMetrics,
							producerProgressGapMs: Math.max(...prompts.map((prompt) => maxProgressGap(events, prompt))),
							browserProjectionLagMs: Math.max(
								...flatObservations.map((observation) => observation.projectionLagMs),
							),
							browserFrameArrivalGapMs: Math.max(
								...flatObservations.map((observation) => observation.maxFrameGapMs),
							),
							browserProjectionCheckpointDeficit: Math.max(0, 2 - minimumProjectionCheckpoints),
							backgroundIngestCheckpointDeficit:
								sessionCount === 1 ? 0 : Math.max(0, 2 - minimumBackgroundCheckpoints),
							completionSkewMs: Math.max(...ends) - Math.min(...ends),
							durationSkewMs: Math.max(...durations) - Math.min(...durations),
							aggregateDeltaPerSecond: overlapMs > 0 ? (deltaCount * 1_000) / overlapMs : null,
						},
						correctness: {
							allSessionsStarted: starts.every((at) => at > 0),
							allSessionsSettled: ends.every((at) => at > 0),
							allBackgroundProjectionsRecovered: projectedSessions === sessionCount,
							allSessionsObservedTwice: minimumProjectionCheckpoints >= 2,
							backgroundSessionsIngestedBetweenSwitches:
								sessionCount === 1 || minimumBackgroundCheckpoints >= 2,
							singleMultiplexedSocket: sockets.length === 1 && closedSockets.length === 0,
						},
					};
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
				"producerProgressGapMs",
				"p95",
				"lte",
				1_000,
				"observe",
				"Deterministic Pi pacing is an input diagnostic; it cannot establish Browser publication fairness.",
			);
			addSummaryGate(
				outcome,
				"browserProjectionCheckpointDeficit",
				"max",
				"lte",
				0,
				"hard",
				"Every Session must publish two Browser-side checkpoints, progressing until the terminal delta count.",
			);
			addSummaryGate(
				outcome,
				"backgroundIngestCheckpointDeficit",
				"max",
				"lte",
				0,
				"hard",
				"Every background Session must progress between view switches or already have reached the terminal delta count.",
			);
			addSummaryGate(
				outcome,
				"durationSkewMs",
				"p95",
				"lte",
				2_000,
				"observe",
				"Duration skew is hardware-sensitive and remains observational until a reference baseline exists.",
			);
			addSummaryGate(
				outcome,
				"completionSkewMs",
				"p95",
				"lte",
				10_000,
				"observe",
				"Absolute completion skew is retained for trend analysis; synchronized duration is the stable gate.",
			);
			addSummaryGate(
				outcome,
				"browserProjectionLagMs",
				"p95",
				"lte",
				2_000,
				"observe",
				"Worst-Session Browser arrival-to-projection lag is measured, but not release-gated without a reference host.",
			);
			addSummaryGate(
				outcome,
				"browserFrameArrivalGapMs",
				"p95",
				"lte",
				2_000,
				"observe",
				"Worst-Session Browser frame-arrival gaps are retained separately from producer pacing.",
			);
			addSummaryGate(
				outcome,
				"liveLongTaskMaxMs",
				"p95",
				"lte",
				500,
				"observe",
				"Long-task timing is hardware-sensitive and cannot be a shared release gate before calibration.",
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
