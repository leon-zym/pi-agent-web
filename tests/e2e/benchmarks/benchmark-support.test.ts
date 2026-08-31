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
	it("keeps native requestAnimationFrame intact while observing a native paint", async () => {
		const browser = await chromium.launch({
			headless: true,
			args: ["--enable-precise-memory-info"],
		});
		browsers.push(browser);
		const page = await browser.newPage();
		await installBrowserBenchmarkObserver(page);
		await page.goto(await observerPageUrl());

		const observed = await page.evaluate(async () => {
			type Snapshot = { inputToNextPaintMs: number | null };
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
});
