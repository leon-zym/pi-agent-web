import fs from "node:fs";
import { observePageErrors } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";
import {
	addSummaryGate,
	addValueGate,
	correctnessFailureCount,
	installBrowserBenchmarkObserver,
	runBenchmarkScenario,
	scenariosFor,
} from "./benchmark-support";

const HISTORY_PROMPT = "E2E_BENCH_HISTORY_PROMPT";
const HISTORY_REPLY = "E2E_BENCH_HISTORY_REPLY";
const INITIAL_TURNS = 48;

for (const scenario of scenariosFor("history")) {
	const sourceBytes = scenario.sourceBytes;
	const turns = scenario.turns;
	const historyReadMode = Reflect.get(scenario, "historyReadMode");
	if (sourceBytes === undefined || turns === undefined || historyReadMode !== "verified_nonempty_native") {
		throw new Error(`history scenario ${scenario.id} is missing workload parameters`);
	}
	test.describe(scenario.id, () => {
		test.use({
			harnessOptions: {
				benchmarkGateway: true,
				seedHistoricalSession: {
					userText: HISTORY_PROMPT,
					assistantText: HISTORY_REPLY,
					turnCount: turns,
					targetSourceBytes: sourceBytes,
				},
			},
		});

		test("loads the exact native source and pages older turns", async ({ page, harness }, testInfo) => {
			test.slow();
			await runBenchmarkScenario(page, testInfo, harness, scenario, async (outcome, trials) => {
				const historyTimeoutMs = 90_000;
				const errors = observePageErrors(page);
				await installBrowserBenchmarkObserver(page);
				await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
				await expect(page.locator("#root > div")).toBeVisible();
				await expect(page.locator("textarea")).toBeEnabled();
				if (!harness.session.sessionFile) throw new Error("historical fixture omitted its session file");
				const actualSourceBytes = fs.statSync(harness.session.sessionFile).size;
				let getMessagesCount = 0;
				await trials.run(0, async () => {
					const heapBefore = await page.evaluate(
						() =>
							(performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
							null,
					);
					const firstPageStarted = await page.evaluate(() => performance.now());
					await page
						.locator("[data-session-row]")
						.filter({ hasText: HISTORY_PROMPT })
						.getByRole("button")
						.first()
						.click();
					const viewport = page.locator('[data-chat-viewport="true"]');
					const turnWindow = viewport.locator('[data-turn-window="true"]');
					await expect(turnWindow).toHaveAttribute("data-turn-window-total", /\d+/, {
						timeout: historyTimeoutMs,
					});
					await expect(turnWindow.locator("[data-turn-id]").last()).toContainText(HISTORY_REPLY, {
						timeout: historyTimeoutMs,
					});
					const firstPageFinished = await page.evaluate(() => performance.now());
					const initialTurns = Number(await turnWindow.getAttribute("data-turn-window-total"));
					const loadOlder = turnWindow.locator('[data-load-older-turns="true"]');
					let nextPageMs = 0;
					if (initialTurns < turns) {
						await expect(loadOlder).toBeVisible({ timeout: 90_000 });
						const nextPageStarted = await page.evaluate(() => performance.now());
						await loadOlder.click();
						await expect(turnWindow).toHaveAttribute("data-turn-window-total", String(turns), {
							timeout: 90_000,
						});
						await expect(turnWindow.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 90_000 });
						nextPageMs = (await page.evaluate(() => performance.now())) - nextPageStarted;
					}
					await page.locator("[data-toc-tick]").first().click({ force: true });
					await expect(viewport.getByText(`${HISTORY_PROMPT} [turn 1]`, { exact: true })).toBeVisible({
						timeout: 90_000,
					});
					const heapAfter = await page.evaluate(
						() =>
							(performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
							null,
					);
					getMessagesCount = harness
						.piEvents()
						.filter(
							(event) => event.sessionId === "browser-e2e-history" && event.commandType === "get_messages",
						).length;
					return {
						metrics: {
							firstPageMs: firstPageFinished - firstPageStarted,
							nextPageMs,
							sourceBytes: actualSourceBytes,
							heapDeltaBytes: heapBefore === null || heapAfter === null ? null : heapAfter - heapBefore,
							mountedTurnNodes: await turnWindow.locator("[data-turn-id]").count(),
						},
						correctness: {
							exactSourceBoundary: actualSourceBytes === sourceBytes,
							allTurnsPaged: (await turnWindow.getAttribute("data-turn-window-total")) === String(turns),
							historyWindowMatchesReadPath: initialTurns === Math.min(INITIAL_TURNS, turns),
							oldestTurnReachable: await viewport
								.getByText(`${HISTORY_PROMPT} [turn 1]`, { exact: true })
								.isVisible(),
							expectedHistoryReadPath: getMessagesCount === 0,
						},
					};
				});
				addValueGate(
					outcome,
					"correctnessFailures",
					correctnessFailureCount(outcome.trials),
					"eq",
					0,
					"hard",
					"Exact source boundaries and complete ordered pagination are non-negotiable.",
				);
				addSummaryGate(
					outcome,
					"mountedTurnNodes",
					"max",
					"lte",
					64,
					"hard",
					"Loading all history must not mount the full conversation DOM.",
				);
				addSummaryGate(
					outcome,
					"firstPageMs",
					"p95",
					"lte",
					30_000,
					"observe",
					"A single generated source is reported but cannot form an anti-noise timing gate.",
				);
				addSummaryGate(
					outcome,
					"nextPageMs",
					"p95",
					"lte",
					30_000,
					"observe",
					"Pagination latency remains observational until independent fixture repetitions are affordable.",
				);
				addSummaryGate(
					outcome,
					"heapDeltaBytes",
					"p95",
					"lte",
					512 * 1024 * 1024,
					"observe",
					"Heap is recorded for leak trends; one GC sample is not a portable regression gate.",
				);
				addValueGate(
					outcome,
					"browserErrors",
					errors.console.length + errors.page.length,
					"eq",
					0,
					"hard",
					"Browser errors invalidate the history sample.",
				);
				outcome.notes.push(
					`Declared history read path: ${historyReadMode}; Pi get_messages count: ${String(getMessagesCount)}.`,
					"History cancellation and post-cancel resource release remain an explicit coverage gap.",
				);
			});
		});
	});
}
