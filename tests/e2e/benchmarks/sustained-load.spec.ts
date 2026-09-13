import type { Page } from "@playwright/test";
import { observePageErrors } from "../fixtures/page-observation";
import type { PiFixtureEvent, ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";
import {
	addSummaryGate,
	addValueGate,
	browserSessionFrameSnapshot,
	browserSessionProjectionSnapshot,
	correctnessFailureCount,
	createTrialObservation,
	installBrowserBenchmarkObserver,
	resetBrowserSessionFrames,
	runBenchmarkScenario,
	scenariosFor,
	trackBrowserSessionProjection,
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
			const closedSockets: string[] = [];
			page.on("websocket", (socket) => {
				sockets.push(socket.url());
				socket.on("close", () => closedSockets.push(socket.url()));
			});
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
					await trackBrowserSessionProjection(page, sessionHandles);
					await resetBrowserSessionFrames(page, sessionHandles);
					// Baseline the visible settled turns before the schedule starts, so the midpoint count
					// measures what this trial projected rather than what earlier trials left behind.
					const preTrialSettledTurns = await page.locator('[data-markdown-settled="true"]').count();
					for (const prompt of prompts) harness.startPrompt(prompt);
					await expect
						.poll(() => prompts.every((prompt) => eventFor(harness, "delta", prompt) !== undefined), {
							timeout: 30_000,
						})
						.toBe(true);

					// Sample arrival-to-projection lag while the window is still open, so the measurement
					// observes live product behavior rather than the test's own post-window orchestration.
					// The observer tracks every subscribed Session on the shared socket and the projection
					// watermark is read in the same page evaluation, so all Sessions are sampled at one
					// instant instead of being visited one at a time.
					await page.waitForTimeout(Math.floor(sustainedWindowMs / 2));
					const projectedTurns = await page.locator('[data-markdown-settled="true"]').count();
					const sampled = await browserSessionProjectionSnapshot(page, sessionHandles);
					const arrivals = sampled.map((snapshot) => ({ projectionLagMs: snapshot.projectionLagMs }));

					// The window closes once every Session has delivered its declared schedule.
					await expect
						.poll(() => prompts.every((prompt) => eventFor(harness, "arrival_window_end", prompt)), {
							timeout: sustainedWindowMs * 3 + 120_000,
						})
						.toBeTruthy();
					const windowEvents = prompts.map((prompt) => eventFor(harness, "arrival_window_end", prompt));
					// The window fact carries what the fixture actually did, not the schedule it was asked
					// for, so the validator's declared-schedule claim compares two independent values.
					const fixtureDeltaCount = Math.min(...windowEvents.map((event) => event?.deltaCount ?? 0));
					const fixtureTurnCount = Math.min(...windowEvents.map((event) => event?.turnCount ?? 0));
					const deliveredFrames = await Promise.all(
						sessionHandles.map((handle) => browserSessionFrameSnapshot(page, handle)),
					);

					// The schedule claim reads the final per-Session arrival counts; the window and lag claims
					// read each Session's own observation, so no single Session can mask another.
					const observations = deliveredFrames.map((snapshot, sessionIndex) => ({
						baselineProjectedSeq: sampled[sessionIndex]?.baselineProjectedSeq ?? -1,
						deltaFrames: snapshot.deltaFrames,
						projectionLagMs: arrivals[sessionIndex]?.projectionLagMs ?? -1,
						projectedSeq: sampled[sessionIndex]?.projectedSeq ?? -1,
						windowMs: windowEvents[sessionIndex]?.windowMs ?? 0,
					}));
					const totalObserved = observations.reduce((sum, entry) => sum + entry.deltaFrames, 0);
					const shortestWindowMs = Math.min(...observations.map((entry) => entry.windowMs));
					const longestWindowMs = Math.max(...observations.map((entry) => entry.windowMs));
					// The DOM count is compared against the pre-window baseline, so a turn projected by an
					// earlier trial cannot satisfy this trial's claim.
					const trialProjectedTurns = projectedTurns - preTrialSettledTurns;
					const correctness = {
						allSessionsObserved: observations.length === sessionCount,
						fixtureEmittedDeclaredSchedule: fixtureDeltaCount === emittedPerSession,
						fixtureWindowCovered: shortestWindowMs >= sustainedWindowMs,
						sustainedPerSessionWindow: observations.every(
							(entry) => entry.windowMs >= sustainedWindowMs && entry.windowMs <= sustainedWindowMs * 2,
						),
						sustainedScheduleHeld: observations.every((entry) => entry.deltaFrames >= emittedPerSession),
						// Every Session must have advanced its own projection during the window, and the
						// visible conversation must show a turn this trial projected.
						allSessionsProjected: observations.every(
							(entry) => entry.projectedSeq > entry.baselineProjectedSeq,
						),
						midWindowProjectedTurn: trialProjectedTurns >= 1,
						singleMultiplexedSocket: sockets.length === 1 && closedSockets.length === 0,
					};
					return {
						metrics: {
							sustainedWindowMs: longestWindowMs,
							sustainedShortestWindowMs: shortestWindowMs,
							sustainedDeltaPerTurn: deltasPerTurn,
							sustainedTurnCount: fixtureTurnCount,
							sustainedScheduledDeltaCount: fixtureTurnCount * deltasPerTurn,
							sustainedFixtureDeltaCount: fixtureDeltaCount,
							sustainedObservedDeltaCount: totalObserved,
							sustainedAggregateDeltaPerSecond:
								longestWindowMs > 0 ? (totalObserved * 1_000) / longestWindowMs : 0,
							sustainedMinimumDeltaFrames: Math.min(...observations.map((entry) => entry.deltaFrames)),
							sustainedMidWindowSettledTurns: projectedTurns,
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
								socket: { closed: closedSockets.length, opened: sockets.length },
								window: {
									arrivalDeltaPerSecond,
									declaredWindowMs: sustainedWindowMs,
									deltasPerTurn,
									fixtureDeltaCount,
									fixtureWindowMs: longestWindowMs,
									midWindowSettledTurns: trialProjectedTurns,
									turnCount: fixtureTurnCount,
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
				sessionCount * arrivalDeltaPerSecond * 0.5,
				"observe",
				"Reported achieved rate. The enforced bound is the hard-gated correctness claim: every Session window stays between the declared duration and twice it, so the achieved rate cannot fall below half the declared schedule.",
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
