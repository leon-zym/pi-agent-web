import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { type ProductionHarness, startProductionHarness } from "../fixtures/production-harness";
import { installBrowserBenchmarkObserver } from "./benchmark-support";

declare const afterEach: typeof import("node:test").afterEach;
declare const describe: typeof import("node:test").describe;
declare const it: typeof import("node:test").it;

const browsers: Array<Awaited<ReturnType<typeof chromium.launch>>> = [];
const harnesses: ProductionHarness[] = [];

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`deterministic Pi descendant ${String(pid)} survived the bounded gateway restart`);
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.stop();
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
			type Snapshot = {
				inputToNextPaintMs: number | null;
				heapSampleCount: number;
			};
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

	it("refreshes Browser authentication and restores the app WebSocket command path after restart", async () => {
		const harness = await startProductionHarness();
		harnesses.push(harness);
		const browser = await chromium.launch({ headless: true });
		browsers.push(browser);
		const page = await browser.newPage();
		await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
		await page.locator("textarea").waitFor({ state: "visible" });
		await page.locator("textarea").waitFor({ state: "attached" });

		const before = harness.gatewayObservation();
		const after = await harness.restartGateway(page);
		assert.equal(after.restartCount, before.restartCount + 1);
		await page.waitForFunction(
			() => {
				const textarea = document.querySelector("textarea") as HTMLTextAreaElement | null;
				return textarea !== null && textarea.disabled === false;
			},
			undefined,
			{ timeout: 30_000 },
		);
		const prompt = "E2E_BENCH_AUTH_RESTART";
		await page.locator("textarea").fill(prompt);
		await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
		await page.waitForFunction(
			(value) => document.body.textContent?.includes(`E2E_REPLY:${value}`) === true,
			prompt,
			{ timeout: 30_000 },
		);
	});

	it("reaps a delayed deterministic Pi descendant before a Gateway restart", async () => {
		const harness = await startProductionHarness({
			extraEnv: { PI_WEB_E2E_EXISTING_STATE_DELAY_MS: "250" },
		});
		harnesses.push(harness);
		const originalPids = [
			...new Set(
				harness
					.piEvents()
					.filter((event) => event.type === "started")
					.map((event) => event.pid),
			),
		];
		assert.ok(originalPids.length > 0, "deterministic Pi must be active before the restart");
		await harness.restartGateway();
		for (const pid of originalPids) await waitForProcessExit(pid);
	});
});
