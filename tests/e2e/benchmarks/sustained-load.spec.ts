import type { Page } from "@playwright/test";
import { observePageErrors } from "../fixtures/page-observation";
import type { PiFixtureEvent, ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";
import {
	addSummaryGate,
	addValueGate,
	browserSessionFrameSnapshot,
	correctnessFailureCount,
	createTrialObservation,
	installBrowserBenchmarkObserver,
	resetBrowserSessionFrames,
	runBenchmarkScenario,
	scenariosFor,
} from "./benchmark-support";

test.use({ harnessOptions: { benchmarkGateway: true } });

async function sendPrompt(page: Page, prompt: string): Promise<void> {
	await page.locator("textarea").fill(prompt);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
}

function eventFor(harness: ProductionHarness, type: string, prompt: string): PiFixtureEvent | undefined {
	return harness.piEvents().find((event) => event.type === type && event.text === prompt);
}

/**
 * A sustained profile asks a different question from the byte-bounded concurrency scenario: a fixed
 * arrival schedule must hold for a declared duration, and every subscribed Session must still project
 * arrivals when the window closes. The runtime bounds live projection events per active turn, so the
 * fixture delivers the window as consecutive settled turns, which is what a real agent produces; the
 * window duration is then a measured consequence of the declared schedule.
 */
for (const scenario of scenariosFor("sustained-load")) {
	test(`${scenario.id} sustains a fixed aggregate arrival window`, async ({ page, harness }, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, harness, scenario, async (outcome, trials) => {
			const sessionCount = scenario.sessions;
			const chunkBytes = scenario.chunkBytes;
			const chunkDelayMs = scenario.chunkDelayMs;
			const arrivalDeltaPerSecond = scenario.arrivalDeltaPerSecond;
			const sustainedWindowMs = scenario.sustainedWindowMs;
			const deltasPerTurn = scenario.deltasPerTurn;
			if (
				sessionCount === undefined ||
				chunkBytes === undefined ||
				chunkDelayMs === undefined ||
				arrivalDeltaPerSecond === undefined ||
				sustainedWindowMs === undefined ||
				deltasPerTurn === undefined
			) {
				throw new Error("sustained-load scenario is missing workload parameters");
			}
			const scheduledPerSession = Math.floor((arrivalDeltaPerSecond * sustainedWindowMs) / 1_000);
			const turnCount = Math.ceil(scheduledPerSession / deltasPerTurn);
			const emittedPerSession = turnCount * deltasPerTurn;
			const errors = observePageErrors(page);
			const sockets: string[] = [];
			page.on("websocket", (socket) => sockets.push(socket.url()));
			await installBrowserBenchmarkObserver(page);
			await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
			await expect(page.locator("#root > div")).toBeVisible();
			await expect(page.locator("textarea")).toBeEnabled();
			const sessionIdentityPrompts: Array<string | undefined> = Array.from({ length: sessionCount });
			const trialCount = scenario.warmups + scenario.samples;

			for (let index = 0; index < trialCount; index += 1) {
				await trials.run(index, async () => {
					const errorStart = { console: errors.console.length, page: errors.page.length };
					const prompts = Array.from({ length: sessionCount }, (_, sessionIndex) =>
						[
							"E2E_BENCH_SUSTAINED",
							String(deltasPerTurn),
							String(chunkBytes),
							String(chunkDelayMs),
							String(turnCount),
							`g${index.toString(36)}s${sessionIndex.toString(36)}`,
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
					const directory = await harness.requestJson<{
						sessions: Array<{ nativeSessionId: string; sessionHandle: string }>;
					}>(
						`/api/v1/workspaces/${encodeURIComponent(harness.workspace.workspaceHandle)}/sessions?refresh=1`,
					);
					const sessionHandles = prompts.map((prompt) => {
						const nativeSessionId = eventFor(harness, "prompt", prompt)?.sessionId;
						const session = directory.sessions.find(
							(candidate) => candidate.nativeSessionId === nativeSessionId,
						);
						if (!session) throw new Error(`Unable to resolve the materialized Session for ${prompt}`);
						return session.sessionHandle;
					});
					await resetBrowserSessionFrames(page, sessionHandles);
					for (const prompt of prompts) harness.startPrompt(prompt);
					await expect
						.poll(() => prompts.every((prompt) => eventFor(harness, "delta", prompt) !== undefined), {
							timeout: 30_000,
						})
						.toBe(true);

					// Sample arrival-to-projection lag while the window is still open, so the measurement
					// observes live product behavior rather than the test's own post-window orchestration.
					await page.waitForTimeout(Math.floor(sustainedWindowMs / 2));
					const arrivals: Array<{ deltaFrames: number; projectionLagMs: number }> = [];
					for (const [sessionIndex] of prompts.entries()) {
						const identityPrompt = sessionIdentityPrompts[sessionIndex];
						if (!identityPrompt) throw new Error("Session identity prompt was not captured");
						const row = page.locator("[data-session-row]").filter({ hasText: identityPrompt });
						await expect(row).toHaveCount(1);
						await row.getByRole("button").first().click();
						await expect(page.locator("textarea")).toBeEnabled();
						const streaming = page.locator('[data-markdown-streaming="true"]');
						await expect(streaming).toHaveCount(1);
						const arrival = await browserSessionFrameSnapshot(page, sessionHandles[sessionIndex] ?? "");
						// The window spans many settled turns, so the streaming DOM carries the turn that is
						// arriving now: it must show at least one projected delta rather than the whole window.
						await expect
							.poll(() => streaming.evaluate((element) => element.textContent?.length ?? 0), {
								timeout: 30_000,
							})
							.toBeGreaterThanOrEqual(chunkBytes);
						const projectedAt = await page.evaluate(() => performance.now());
						arrivals.push({
							deltaFrames: arrival.deltaFrames,
							projectionLagMs:
								arrival.lastArrivalAt === null ? -1 : Math.max(0, projectedAt - arrival.lastArrivalAt),
						});
					}

					// The window closes once every Session has delivered its declared schedule.
					await expect
						.poll(() => prompts.every((prompt) => eventFor(harness, "arrival_window_end", prompt)), {
							timeout: sustainedWindowMs * 3 + 120_000,
						})
						.toBeTruthy();
					const windowEvents = prompts.map((prompt) => eventFor(harness, "arrival_window_end", prompt));
					const windowMs = Math.max(...windowEvents.map((event) => event?.windowMs ?? 0));
					const fixtureDeltaCount = Math.min(...windowEvents.map((event) => event?.deltaCount ?? 0));
					const deliveredFrames = await Promise.all(
						sessionHandles.map((handle) => browserSessionFrameSnapshot(page, handle)),
					);

					// The schedule claim reads the final per-Session arrival counts; the lag claim reads the
					// mid-window samples, so neither observes the test's own post-window orchestration.
					const observations = deliveredFrames.map((snapshot, sessionIndex) => ({
						deltaFrames: snapshot.deltaFrames,
						projectionLagMs: arrivals[sessionIndex]?.projectionLagMs ?? -1,
					}));
					const totalObserved = observations.reduce((sum, entry) => sum + entry.deltaFrames, 0);
					const correctness = {
						allSessionsObserved: observations.length === sessionCount,
						fixtureEmittedDeclaredSchedule: fixtureDeltaCount === emittedPerSession,
						fixtureWindowCovered: windowMs >= sustainedWindowMs,
						sustainedScheduleHeld: observations.every((entry) => entry.deltaFrames >= emittedPerSession),
						projectionsConverged: observations.every((entry) => entry.projectionLagMs >= 0),
						singleMultiplexedSocket: sockets.length === 1,
					};
					return {
						metrics: {
							sustainedWindowMs: windowMs,
							sustainedDeltaPerTurn: deltasPerTurn,
							sustainedTurnCount: turnCount,
							sustainedScheduledDeltaCount: emittedPerSession,
							sustainedFixtureDeltaCount: fixtureDeltaCount,
							sustainedObservedDeltaCount: totalObserved,
							sustainedAggregateDeltaPerSecond: windowMs > 0 ? (totalObserved * 1_000) / windowMs : 0,
							sustainedMinimumDeltaFrames: Math.min(...observations.map((entry) => entry.deltaFrames)),
							sustainedProjectionLagMs: Math.max(0, ...observations.map((entry) => entry.projectionLagMs)),
						},
						correctness,
						observation: createTrialObservation(
							"sustained-load",
							{
								console: errors.console.slice(errorStart.console),
								page: errors.page.slice(errorStart.page),
							},
							{
								sessions: observations,
								socket: { closed: 0, opened: sockets.length },
								window: {
									arrivalDeltaPerSecond,
									declaredWindowMs: sustainedWindowMs,
									deltasPerTurn,
									fixtureDeltaCount,
									fixtureWindowMs: windowMs,
									turnCount,
								},
							},
						),
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
				"Every Session must hold the declared arrival schedule and close the window with a projection.",
			);
			addSummaryGate(
				outcome,
				"sustainedAggregateDeltaPerSecond",
				"median",
				"gte",
				sessionCount * arrivalDeltaPerSecond * 0.8,
				"observe",
				"Achieved aggregate arrival rate over the declared window; the schedule itself is enforced by correctness.",
			);
			addSummaryGate(
				outcome,
				"sustainedProjectionLagMs",
				"p95",
				"lte",
				15_000,
				"observe",
				"Worst-Session arrival-to-projection lag sampled mid-window; diagnostic until a reference host exists.",
			);
			addValueGate(
				outcome,
				"browserErrors",
				errors.console.length + errors.page.length,
				"eq",
				0,
				"hard",
				"Console or page errors invalidate sustained-load samples.",
			);
		});
	});
}
