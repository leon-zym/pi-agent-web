import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import { chromium } from "@playwright/test";
import { installBrowserBenchmarkObserver } from "./benchmark-support";

const browsers: Array<Awaited<ReturnType<typeof chromium.launch>>> = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const browser of browsers.splice(0)) await browser.close();
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
});

async function observerPageUrl(): Promise<string> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<main>benchmark observer</main>");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("observer server did not bind a TCP port");
	return `http://127.0.0.1:${String(address.port)}`;
}

describe("benchmark Browser observer", () => {
	it("keeps native requestAnimationFrame intact while observing a post-mutation rAF callback", async () => {
		const browser = await chromium.launch({
			headless: true,
			args: ["--enable-precise-memory-info"],
		});
		browsers.push(browser);
		const page = await browser.newPage();
		await installBrowserBenchmarkObserver(page);
		await page.goto(await observerPageUrl());

		const observed = await page.evaluate(async () => {
			type Snapshot = { automationStartToFirstStreamingRafMs: number | null };
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
			streaming.textContent = "streaming DOM observation";
			document.body.append(streaming);
			await new Promise<void>((resolve) =>
				window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
			);
			benchmark.markStreamEnd();
			benchmark.markSettled();
			return {
				automationStartToFirstStreamingRafMs: benchmark.snapshot().automationStartToFirstStreamingRafMs,
				nativeRequestAnimationFramePreserved: nativeRequestAnimationFrame === window.requestAnimationFrame,
			};
		});

		assert.equal(observed.nativeRequestAnimationFramePreserved, true);
		assert.notEqual(observed.automationStartToFirstStreamingRafMs, null);
		assert.ok((observed.automationStartToFirstStreamingRafMs ?? -1) >= 0);
	});
});

describe("streaming DOM observer boundaries", () => {
	it("counts turn roots, requires nonempty streaming text and excludes unrelated mutations", async () => {
		const browser = await chromium.launch({ headless: true });
		browsers.push(browser);
		const page = await browser.newPage();
		await installBrowserBenchmarkObserver(page);
		await page.goto(await observerPageUrl());
		const observed = await page.evaluate(async () => {
			type Snapshot = {
				automationStartToFirstStreamingDomMs: number | null;
				automationStartToFirstStreamingRafMs: number | null;
				streamingDomMutationBatches: number;
				turnNodes: number;
			};
			const benchmark = (
				window as unknown as { __piwebBenchmark: { start: () => void; snapshot: () => Snapshot } }
			).__piwebBenchmark;
			benchmark.start();
			const empty = benchmark.snapshot();
			const turns = [document.createElement("section"), document.createElement("section")] as const;
			for (const [index, turn] of turns.entries()) turn.dataset.turnId = String(index);
			const streaming = document.createElement("div");
			streaming.dataset.markdownStreaming = "true";
			turns[1].append(streaming);
			document.body.append(...turns);
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const blank = benchmark.snapshot();
			streaming.textContent = "first delta";
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const first = benchmark.snapshot();
			const unrelated = document.createElement("aside");
			unrelated.textContent = "unrelated UI update";
			document.body.append(unrelated);
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const afterUnrelated = benchmark.snapshot();
			streaming.firstChild!.textContent = "second delta";
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			return {
				empty,
				blank,
				first,
				afterUnrelated,
				second: benchmark.snapshot(),
				descendantCount: turns[1].querySelectorAll("[data-turn-id]").length,
			};
		});
		assert.equal(observed.empty.turnNodes, 0);
		assert.equal(observed.empty.automationStartToFirstStreamingDomMs, null);
		assert.equal(observed.blank.streamingDomMutationBatches, 0);
		assert.equal(observed.blank.automationStartToFirstStreamingRafMs, null);
		assert.equal(observed.descendantCount, 0);
		assert.equal(observed.first.turnNodes, 2);
		assert.equal(observed.first.streamingDomMutationBatches, 1);
		assert.ok((observed.first.automationStartToFirstStreamingDomMs ?? -1) >= 0);
		assert.ok(
			(observed.first.automationStartToFirstStreamingRafMs ?? -1) >=
				observed.first.automationStartToFirstStreamingDomMs!,
		);
		assert.equal(observed.afterUnrelated.streamingDomMutationBatches, 1);
		assert.equal(observed.second.streamingDomMutationBatches, 2);
	});
});
