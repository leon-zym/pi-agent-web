import { observePageErrors } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";

test.use({
	launchOptions: {
		args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
	},
});

const STREAM_FIXTURES = [
	{ label: "10 KiB", prompt: "E2E_STREAM_BUDGET_10K", targetBytes: 10 * 1024 },
	{ label: "64 KiB", prompt: "E2E_STREAM_BUDGET_64K", targetBytes: 64 * 1024 },
	{ label: "120 KiB", prompt: "E2E_STREAM_BUDGET_120K", targetBytes: 120 * 1024 },
	{ label: "1 MiB", prompt: "E2E_STREAM_BUDGET_1M", targetBytes: 1024 * 1024 },
] as const;

const COLD_SETTLEMENT_BUDGET_MS = 2_000;
const WARM_SETTLEMENT_BUDGET_MS = 1_500;
const MAX_RICH_MARKDOWN_UTF8_BYTES = 256 * 1024;
const MAX_LIVE_LONG_TASK_MS = 200;
const MAX_LIVE_LONG_TASKS_OVER_50_MS = 4;
const MAX_HEAP_DELTA_BYTES = 64 * 1024 * 1024;

interface ConversationPerformanceSnapshot {
	liveLongTasks: number[];
	liveLongTaskMaxMs: number;
	settlementMs: number | null;
	heapDeltaBytes: number | null;
	turnNodes: number;
}

interface ConversationPerformanceCapabilities {
	longTaskObserver: boolean;
	memory: boolean;
}

async function installConversationPerformanceObserver(page: Parameters<typeof observePageErrors>[0]) {
	await page.addInitScript(() => {
		const state = {
			startedAt: 0,
			streamEndedAt: null as number | null,
			settledAt: null as number | null,
			heapStartedAt: null as number | null,
			longTasks: [] as Array<{ startTime: number; duration: number }>,
		};
		const getUsedHeap = () => {
			const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
			return memory?.usedJSHeapSize ?? null;
		};
		const collectGarbage = () => {
			(globalThis as typeof globalThis & { gc?: () => void }).gc?.();
		};
		let longTaskObserverInstalled = false;
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
			}
		});
		try {
			observer.observe({ entryTypes: ["longtask"] });
			longTaskObserverInstalled = true;
		} catch {
			// The test asserts this capability before treating the result as a gate.
		}
		const target = window as typeof window & {
			__piwebConversationPerformance: {
				capabilities: () => ConversationPerformanceCapabilities;
				start: () => void;
				markStreamingEnd: () => void;
				markSettled: () => void;
				snapshot: () => ConversationPerformanceSnapshot;
			};
		};
		target.__piwebConversationPerformance = {
			capabilities: () => ({
				longTaskObserver: longTaskObserverInstalled,
				memory: getUsedHeap() !== null,
			}),
			start: () => {
				collectGarbage();
				state.startedAt = performance.now();
				state.streamEndedAt = null;
				state.settledAt = null;
				state.heapStartedAt = getUsedHeap();
				state.longTasks.length = 0;
			},
			markStreamingEnd: () => {
				state.streamEndedAt = performance.now();
			},
			markSettled: () => {
				state.settledAt = performance.now();
			},
			snapshot: () => {
				const streamEnd = state.streamEndedAt ?? performance.now();
				const liveLongTasks = state.longTasks
					.filter((entry) => entry.startTime >= state.startedAt && entry.startTime < streamEnd)
					.map((entry) => entry.duration);
				collectGarbage();
				const heapNow = getUsedHeap();
				return {
					liveLongTasks,
					liveLongTaskMaxMs: Math.max(0, ...liveLongTasks),
					settlementMs:
						state.streamEndedAt !== null && state.settledAt !== null
							? state.settledAt - state.streamEndedAt
							: null,
					heapDeltaBytes:
						state.heapStartedAt !== null && heapNow !== null ? heapNow - state.heapStartedAt : null,
					turnNodes: document.querySelectorAll("[data-turn-id]").length,
				};
			},
		};
	});
}

test("production Chromium keeps live Markdown and settled rendering within documented budgets", async ({
	page,
	harness,
}) => {
	test.slow();
	const errors = observePageErrors(page);
	await installConversationPerformanceObserver(page);
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
	const capabilities = await page.evaluate(() =>
		(
			window as typeof window & {
				__piwebConversationPerformance: {
					capabilities: () => ConversationPerformanceCapabilities;
				};
			}
		).__piwebConversationPerformance.capabilities(),
	);
	expect(capabilities.longTaskObserver, "Chromium long-task observer must be available").toBe(true);
	expect(capabilities.memory, "Chromium precise heap measurement must be available").toBe(true);
	const cdp = await page.context().newCDPSession(page);
	const fixtures = STREAM_FIXTURES;

	for (const [index, fixture] of fixtures.entries()) {
		await cdp.send("HeapProfiler.collectGarbage");
		await page.evaluate(() => {
			(
				window as typeof window & {
					__piwebConversationPerformance: { start: () => void };
				}
			).__piwebConversationPerformance.start();
		});
		await page.locator("textarea").fill(fixture.prompt);
		await page.getByRole("button", { name: /^(Send|发送)$/ }).click();

		await expect
			.poll(() => harness.piEvents().some((event) => event.type === "delta" && event.text === fixture.prompt))
			.toBe(true);
		const streamingMarkdown = page.locator('[data-markdown-streaming="true"]');
		await expect(streamingMarkdown).toHaveCount(1);
		await expect
			.poll(() => streamingMarkdown.evaluate((element) => element.textContent?.length ?? 0))
			.toBeGreaterThan(0);
		const streamingShape = await streamingMarkdown.evaluate((element) => ({
			textLength: element.textContent?.length ?? 0,
			richNodes: element.querySelectorAll("h1,h2,h3,strong,em,pre,table,ul,ol").length,
		}));
		expect(streamingShape.textLength, `${fixture.label} streaming text should be mounted`).toBeGreaterThan(0);
		expect(streamingShape.richNodes, `${fixture.label} must not parse the live tail`).toBe(0);

		await expect
			.poll(
				() =>
					harness.piEvents().some((event) => event.type === "stream_end" && event.text === fixture.prompt),
				{
					timeout: 15_000,
				},
			)
			.toBe(true);
		await page.evaluate(() => {
			(
				window as typeof window & {
					__piwebConversationPerformance: { markStreamingEnd: () => void };
				}
			).__piwebConversationPerformance.markStreamingEnd();
		});
		await expect
			.poll(
				() => harness.piEvents().some((event) => event.type === "settled" && event.text === fixture.prompt),
				{
					timeout: 15_000,
				},
			)
			.toBe(true);
		const largeFrames = harness
			.piEvents()
			.filter((event) => event.type === "large_frame" && event.text === fixture.prompt);
		expect(largeFrames.map((event) => event.eventType)).toEqual(["text_end", "message_end"]);
		expect(largeFrames.every((event) => (event.frameBytes ?? 0) > fixture.targetBytes)).toBe(true);
		expect((largeFrames[1]?.at ?? 0) - (largeFrames[0]?.at ?? 0)).toBeGreaterThanOrEqual(90);
		const settledMarkdown = page.locator('[data-markdown-settled="true"]').last();
		await expect(settledMarkdown).toBeVisible({ timeout: 15_000 });
		if (fixture.targetBytes <= MAX_RICH_MARKDOWN_UTF8_BYTES) {
			await expect(
				page.getByRole("heading", {
					name: `Streaming budget fixture ${String(fixture.targetBytes)} bytes`,
					level: 2,
				}),
			).toBeVisible({ timeout: 15_000 });
		} else {
			const heading = `## Streaming budget fixture ${String(fixture.targetBytes)} bytes`;
			await expect
				.poll(() =>
					page
						.locator('[data-markdown-large="true"]')
						.last()
						.evaluate((element, expected) => element.textContent?.includes(expected) ?? false, heading),
				)
				.toBe(true);
		}
		const settledShape = await settledMarkdown.evaluate((element) => {
			const text = element.textContent ?? "";
			return {
				hasUnicode: text.includes("🧪"),
				hasEndSentinel: text.includes("STREAM_BUDGET_END"),
				hasUnfinishedFence: text.includes("unfinished fence remains literal until the response settles"),
				textLength: text.length,
			};
		});
		expect(settledShape.hasUnicode, `${fixture.label} settled text lost Unicode`).toBe(true);
		expect(settledShape.hasEndSentinel, `${fixture.label} settled text was truncated`).toBe(true);
		expect(settledShape.hasUnfinishedFence, `${fixture.label} settled text lost the unfinished fence`).toBe(
			true,
		);
		expect(settledShape.textLength).toBeGreaterThan(0);
		await page.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
		await cdp.send("HeapProfiler.collectGarbage");
		await page.evaluate(() => {
			(
				window as typeof window & {
					__piwebConversationPerformance: { markSettled: () => void };
				}
			).__piwebConversationPerformance.markSettled();
		});

		const metrics = await page.evaluate(() =>
			(
				window as typeof window & {
					__piwebConversationPerformance: {
						snapshot: () => ConversationPerformanceSnapshot;
					};
				}
			).__piwebConversationPerformance.snapshot(),
		);
		const overBudgetLiveTasks = metrics.liveLongTasks.filter((duration) => duration > 50);
		expect(
			metrics.liveLongTaskMaxMs,
			`${fixture.label} live long tasks ${JSON.stringify(metrics)}`,
		).toBeLessThanOrEqual(MAX_LIVE_LONG_TASK_MS);
		expect(
			overBudgetLiveTasks.length,
			`${fixture.label} repeated live long tasks ${JSON.stringify(metrics)}`,
		).toBeLessThanOrEqual(MAX_LIVE_LONG_TASKS_OVER_50_MS);
		expect(metrics.settlementMs, `${fixture.label} settlement measurement`).not.toBeNull();
		expect(metrics.settlementMs, `${fixture.label} settlement budget`).toBeLessThan(
			index === 0 ? COLD_SETTLEMENT_BUDGET_MS : WARM_SETTLEMENT_BUDGET_MS,
		);
		expect(metrics.turnNodes, `${fixture.label} retained turn DOM`).toBeLessThanOrEqual(64);
		expect(metrics.heapDeltaBytes, `${fixture.label} heap measurement`).not.toBeNull();
		if (metrics.heapDeltaBytes !== null) {
			expect(metrics.heapDeltaBytes, `${fixture.label} retained heap delta`).toBeLessThanOrEqual(
				MAX_HEAP_DELTA_BYTES,
			);
		}
	}

	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});
