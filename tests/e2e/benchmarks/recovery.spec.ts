import type { WebSocket } from "@playwright/test";
import {
	dropControlledWebSockets,
	installWebSocketDropControl,
	observePageErrors,
	sendControlledWebSocketFrame,
} from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";
import {
	addSummaryGate,
	addValueGate,
	correctnessFailureCount,
	runBenchmarkScenario,
	scenariosFor,
} from "./benchmark-support";

test.use({ harnessOptions: { benchmarkGateway: true } });

interface WireFrame extends Record<string, unknown> {
	type?: string;
	sessionHandle?: string;
	generation?: number;
	isController?: boolean;
	fencingToken?: string;
	response?: {
		id?: string;
		success?: boolean;
		error?: string;
	};
}

function frame(payload: string | Buffer): WireFrame | undefined {
	try {
		return JSON.parse(payload.toString()) as WireFrame;
	} catch {
		return undefined;
	}
}

for (const scenario of scenariosFor("recovery-disconnect")) {
	test(`${scenario.id} repeats disconnect and explicit gap resync without projection corruption`, async ({
		page,
		harness,
	}, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, scenario, async (outcome) => {
			const errors = observePageErrors(page);
			await installWebSocketDropControl(page);
			const sockets: WebSocket[] = [];
			let closedSockets = 0;
			const received: WireFrame[] = [];
			page.on("websocket", (socket) => {
				sockets.push(socket);
				socket.on("close", () => {
					closedSockets += 1;
				});
				socket.on("framereceived", ({ payload }) => {
					const parsed = frame(payload);
					if (parsed) received.push(parsed);
				});
			});
			await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
			await expect(page.locator("#root > div")).toBeVisible();
			await expect(page.locator("textarea")).toBeEnabled();
			const trialCount = scenario.warmups + scenario.samples;

			for (let index = 0; index < trialCount; index += 1) {
				const prompt = `E2E_BENCH_GAP:${scenario.id}:${String(index)}`;
				await page.locator("textarea").fill(prompt);
				await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
				await expect
					.poll(() => harness.piEvents().some((event) => event.type === "delta" && event.text === prompt))
					.toBe(true);
				const socketsBefore = sockets.length;
				const closesBefore = closedSockets;
				const framesBefore = received.length;
				const startedAt = await page.evaluate(() => performance.now());
				await dropControlledWebSockets(page);
				harness.triggerReplayGap(prompt);
				await expect.poll(() => closedSockets).toBeGreaterThan(closesBefore);
				await expect
					.poll(() =>
						harness
							.piEvents()
							.some((event) => event.type === "benchmark_gap_emitted" && event.text === prompt),
					)
					.toBe(true);
				await expect
					.poll(() => harness.piEvents().some((event) => event.type === "settled" && event.text === prompt), {
						timeout: 30_000,
					})
					.toBe(true);
				await expect.poll(() => sockets.length, { timeout: 30_000 }).toBeGreaterThan(socketsBefore);
				await expect(page.locator("textarea")).toBeEnabled({ timeout: 30_000 });
				const turn = page
					.getByRole("region", { name: /^(Conversation turn|对话轮次)$/ })
					.filter({ hasText: prompt });
				await expect(turn.getByText(prompt, { exact: true })).toHaveCount(1);
				await expect(turn.getByText(`E2E_REPLY:${prompt}`, { exact: true })).toHaveCount(1);
				const finishedAt = await page.evaluate(() => performance.now());
				const resyncFrames = received
					.slice(framesBefore)
					.filter((candidate) => candidate.type === "resync_required");
				const gapResyncFrames = resyncFrames.filter((candidate) => candidate.reason === "gap");
				outcome.trials.push({
					index,
					warmup: index < scenario.warmups,
					metrics: {
						recoveryMs: finishedAt - startedAt,
						reconnectedSockets: sockets.length - socketsBefore,
						resyncFrames: resyncFrames.length,
						gapResyncFrames: gapResyncFrames.length,
					},
					correctness: {
						reconnected: sockets.length > socketsBefore,
						exactlyOnePrompt: (await turn.getByText(prompt, { exact: true }).count()) === 1,
						exactlyOneReply: (await turn.getByText(`E2E_REPLY:${prompt}`, { exact: true }).count()) === 1,
						exactlyOneGapResync: gapResyncFrames.length === 1,
						singlePiCommand:
							harness.piEvents().filter((event) => event.type === "prompt" && event.text === prompt)
								.length === 1,
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
				"Every recovery trial must have zero duplicate, lost, or replayed commands.",
			);
			addSummaryGate(
				outcome,
				"recoveryMs",
				"p95",
				"lte",
				5_000,
				"observe",
				"Reconnect-to-projection latency remains observational until a reference baseline is established.",
			);
			addSummaryGate(
				outcome,
				"reconnectedSockets",
				"max",
				"lte",
				2,
				"hard",
				"A single fault must not create an unbounded reconnect storm.",
			);
			addValueGate(
				outcome,
				"browserErrors",
				errors.console.length + errors.page.length,
				"eq",
				0,
				"hard",
				"Browser errors invalidate recovery success.",
			);
			outcome.notes.push(
				"After a clean socket close, the fixture emits one non-replayable notify while offline; every trial must reconnect through resync_required(reason=gap).",
			);
		});
	});
}

for (const scenario of scenariosFor("recovery-crash")) {
	test(`${scenario.id} repeats recoverable Pi process loss on independent Sessions`, async ({
		page,
		harness,
	}, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, scenario, async (outcome) => {
			const errors = observePageErrors(page);
			await installWebSocketDropControl(page);
			const received: WireFrame[] = [];
			page.on("websocket", (socket) => {
				socket.on("framereceived", ({ payload }) => {
					const parsed = frame(payload);
					if (parsed) received.push(parsed);
				});
			});
			await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
			await expect(page.locator("#root > div")).toBeVisible();
			await expect(page.locator("textarea")).toBeEnabled();
			const trialCount = scenario.warmups + scenario.samples;

			for (let index = 0; index < trialCount; index += 1) {
				const crashPrompt = `E2E_BENCH_CRASH:${scenario.id}:${String(index)}`;
				const beforePrompt = `E2E_BENCH_BEFORE_CRASH_${String(index)}`;
				await page.locator("textarea").fill(beforePrompt);
				await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
				const main = page.locator("main");
				await expect(main.getByText(`E2E_REPLY:${beforePrompt}`, { exact: true })).toHaveCount(1, {
					timeout: 30_000,
				});
				const oldLease = received.findLast(
					(candidate) =>
						candidate.type === "lease_status" &&
						candidate.isController === true &&
						typeof candidate.fencingToken === "string",
				);
				if (!oldLease?.sessionHandle || typeof oldLease.generation !== "number" || !oldLease.fencingToken) {
					throw new Error("Pre-crash controller lease is missing");
				}
				const startsBefore = harness.piEvents().filter((event) => event.type === "started").length;
				await page.locator("textarea").fill(crashPrompt);
				await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
				await expect
					.poll(() =>
						harness
							.piEvents()
							.find((event) => event.type === "crash_requested" && event.text === crashPrompt),
					)
					.toBeTruthy();
				const crashEvent = harness
					.piEvents()
					.find((event) => event.type === "crash_requested" && event.text === crashPrompt);
				if (!crashEvent) throw new Error("crash fixture marker is missing");
				await expect
					.poll(
						() =>
							harness
								.piEvents()
								.filter(
									(event) =>
										event.type === "started" &&
										event.sessionId === crashEvent.sessionId &&
										event.pid !== crashEvent.pid &&
										event.at >= crashEvent.at,
								).length,
						{ timeout: 30_000 },
					)
					.toBe(1);
				const currentRow = page.locator('[data-session-row][data-current="true"]');
				await expect(currentRow).toHaveCount(1);
				await currentRow.getByRole("button").first().click();
				await expect(page.locator("textarea")).toBeEnabled({ timeout: 30_000 });
				await expect
					.poll(
						() =>
							received.some(
								(candidate) =>
									candidate.type === "lease_status" &&
									candidate.isController === true &&
									typeof candidate.generation === "number" &&
									candidate.generation > (oldLease.generation ?? Number.MAX_SAFE_INTEGER),
							),
						{ timeout: 30_000 },
					)
					.toBe(true);
				const restarted = harness
					.piEvents()
					.find(
						(event) =>
							event.type === "started" &&
							event.sessionId === crashEvent.sessionId &&
							event.pid !== crashEvent.pid &&
							event.at >= crashEvent.at,
					);
				if (!restarted) throw new Error("restarted Pi marker is missing");
				const stalePrompt = `E2E_BENCH_STALE_AFTER_CRASH_${String(index)}`;
				const staleCommandId = `benchmark-stale-${String(index)}`;
				await sendControlledWebSocketFrame(page, {
					type: "command",
					sessionHandle: oldLease.sessionHandle,
					expectedGeneration: oldLease.generation,
					fencingToken: oldLease.fencingToken,
					command: { id: staleCommandId, type: "prompt", message: stalePrompt },
				});
				await expect
					.poll(
						() =>
							received.find(
								(candidate) => candidate.type === "response" && candidate.response?.id === staleCommandId,
							),
						{ timeout: 30_000 },
					)
					.toBeTruthy();
				const staleResponse = received.find(
					(candidate) => candidate.type === "response" && candidate.response?.id === staleCommandId,
				);
				const afterPrompt = `E2E_BENCH_AFTER_CRASH_${String(index)}`;
				await page.locator("textarea").fill(afterPrompt);
				await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
				await expect(main.getByText(`E2E_REPLY:${afterPrompt}`, { exact: true })).toHaveCount(1, {
					timeout: 30_000,
				});
				const recoveredAt = Date.now();
				outcome.trials.push({
					index,
					warmup: index < scenario.warmups,
					metrics: {
						recoveryMs: recoveredAt - crashEvent.at,
						processRestartMs: restarted.at - crashEvent.at,
						processStarts:
							harness.piEvents().filter((event) => event.type === "started").length - startsBefore,
					},
					correctness: {
						restartedSameNativeSession: restarted.sessionId === crashEvent.sessionId,
						newProcessIdentity: restarted.pid !== crashEvent.pid,
						commandPathRecovered:
							(await main.getByText(`E2E_REPLY:${afterPrompt}`, { exact: true }).count()) === 1,
						staleGenerationRejected:
							staleResponse?.response?.success === false &&
							(staleResponse.response.error?.includes("session_generation_stale") ?? false),
						staleMutationNotExecuted:
							harness.piEvents().filter((event) => event.type === "prompt" && event.text === stalePrompt)
								.length === 0,
						exactlyOneCrashCommand:
							harness.piEvents().filter((event) => event.type === "prompt" && event.text === crashPrompt)
								.length === 1,
					},
				});
				if (index < trialCount - 1) {
					await page
						.getByRole("navigation", { name: /^(Sidebar|侧栏)$/ })
						.getByRole("button", { name: /^(New session|新建会话)$/ })
						.first()
						.click();
					await expect(page.locator("textarea")).toBeEnabled();
				}
			}
			addValueGate(
				outcome,
				"correctnessFailures",
				correctnessFailureCount(outcome.trials),
				"eq",
				0,
				"hard",
				"Each process loss must restart the same persisted Session and restore command service.",
			);
			addSummaryGate(
				outcome,
				"recoveryMs",
				"p95",
				"lte",
				8_000,
				"observe",
				"Post-crash command reply/projection latency is hardware-sensitive until a reference baseline exists.",
			);
			addSummaryGate(
				outcome,
				"processStarts",
				"max",
				"eq",
				1,
				"hard",
				"One crash must create exactly one replacement Pi process.",
			);
			addValueGate(
				outcome,
				"browserErrors",
				errors.console.length + errors.page.length,
				"eq",
				0,
				"hard",
				"Browser errors invalidate crash recovery.",
			);
			outcome.notes.push(
				"Gateway restart is available through the common production harness, but no restart workload is added to this inherited recovery matrix.",
			);
		});
	});
}
