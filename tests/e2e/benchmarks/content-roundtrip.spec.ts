import { deflateSync } from "node:zlib";
import type { WebSocket } from "@playwright/test";
import { observePageErrors } from "../fixtures/page-observation";
import { expect, test } from "../fixtures/test";
import {
	addSummaryGate,
	addValueGate,
	correctnessFailureCount,
	runBenchmarkScenario,
	scenariosFor,
} from "./benchmark-support";

const PROMPT = "E2E_PAYLOAD_ATTACHMENT";

interface WireFrame extends Record<string, unknown> {
	type?: string;
}

interface WireEvent {
	direction: "sent" | "received";
	raw: string;
	frame: WireFrame;
}

function crc32(input: Buffer): number {
	let crc = 0xffff_ffff;
	for (const byte of input) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
		}
	}
	return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const chunk = Buffer.allocUnsafe(12 + data.byteLength);
	chunk.writeUInt32BE(data.byteLength, 0);
	typeBytes.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
	return chunk;
}

function validPng(byteLength: number): Buffer {
	const signature = Buffer.from("89504e470d0a1a0a", "hex");
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr.set([8, 6, 0, 0, 0], 8);
	const idat = pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0])));
	const fixed = [signature, pngChunk("IHDR", ihdr), idat, pngChunk("IEND", Buffer.alloc(0))];
	const fixedBytes = fixed.reduce((total, part) => total + part.byteLength, 0);
	const paddingBytes = byteLength - fixedBytes - 12;
	if (paddingBytes < 1) throw new Error("PNG benchmark fixture is too small");
	return Buffer.concat([
		fixed[0] ?? Buffer.alloc(0),
		fixed[1] ?? Buffer.alloc(0),
		pngChunk("paWa", Buffer.alloc(paddingBytes, 0x61)),
		...fixed.slice(2),
	]);
}

function parseWire(payload: string | Buffer): { raw: string; frame: WireFrame } | undefined {
	const raw = payload.toString();
	try {
		return { raw, frame: JSON.parse(raw) as WireFrame };
	} catch {
		return undefined;
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function hasAttachmentRef(frame: WireFrame): boolean {
	if (frame.type !== "event") return false;
	const event = record(frame.event);
	const message = record(event?.message);
	if (!Array.isArray(message?.content)) return false;
	return message.content.some((candidate) => {
		const image = record(candidate);
		const ref = record(image?.data);
		return image?.type === "image" && ref?.type === "attachment_ref";
	});
}

for (const scenario of scenariosFor("content-roundtrip")) {
	test(`${scenario.id} measures near-limit Browser input through typed output refs`, async ({
		page,
		harness,
	}, testInfo) => {
		test.slow();
		await runBenchmarkScenario(page, testInfo, scenario, async (outcome) => {
			if (scenario.inputBytes === undefined) throw new Error("content scenario is missing inputBytes");
			const input = validPng(scenario.inputBytes);
			const inputBase64Chars = input.toString("base64").length;
			const errors = observePageErrors(page);
			const sockets: WebSocket[] = [];
			const closedSockets: WebSocket[] = [];
			const wire: WireEvent[] = [];
			page.on("websocket", (socket) => {
				sockets.push(socket);
				socket.on("close", () => closedSockets.push(socket));
				socket.on("framesent", ({ payload }) => {
					const parsed = parseWire(payload);
					if (parsed) wire.push({ direction: "sent", ...parsed });
				});
				socket.on("framereceived", ({ payload }) => {
					const parsed = parseWire(payload);
					if (parsed) wire.push({ direction: "received", ...parsed });
				});
			});
			await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
			await expect(page.locator("#root > div")).toBeVisible();
			await expect(page.locator("textarea")).toBeEnabled();
			const cdp = await page.context().newCDPSession(page);
			const trialCount = scenario.warmups + scenario.samples;
			let authenticatedAttachmentFetch = false;

			for (let index = 0; index < trialCount; index += 1) {
				await cdp.send("HeapProfiler.collectGarbage");
				const heapBefore = await page.evaluate(
					() =>
						(performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
						null,
				);
				const selectionStarted = await page.evaluate(() => performance.now());
				await page.locator("#piweb-image-input").setInputFiles({
					name: `near-limit-${String(index)}.png`,
					mimeType: "image/png",
					buffer: input,
				});
				await expect(page.getByAltText(/^(Attachment 1|附件 1)$/)).toBeVisible({ timeout: 30_000 });
				const selectionFinished = await page.evaluate(() => performance.now());
				const wireStart = wire.length;
				const roundTripStarted = await page.evaluate(() => performance.now());
				const attachmentResponse =
					index === 0
						? page.waitForResponse((response) =>
								new URL(response.url()).pathname.startsWith("/api/v1/attachments/"),
							)
						: null;
				await page.locator("textarea").fill(PROMPT);
				await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
				await expect
					.poll(
						() =>
							harness
								.piEvents()
								.filter((event) => event.type === "prompt" && event.text === PROMPT)
								.at(-1),
						{ timeout: 30_000 },
					)
					.toMatchObject({ imageCount: 1, imageChars: inputBase64Chars });
				await expect
					.poll(() => wire.slice(wireStart).filter((event) => hasAttachmentRef(event.frame)).length)
					.toBeGreaterThanOrEqual(2);
				const image = page.getByAltText(/^(Attachment image 1|附件图片 1)$/).last();
				await expect(image).toBeVisible({ timeout: 30_000 });
				await expect
					.poll(() =>
						image.evaluate((element) => {
							const target = element as HTMLImageElement;
							return target.complete && target.naturalWidth > 0;
						}),
					)
					.toBe(true);
				if (attachmentResponse) {
					const response = await attachmentResponse;
					authenticatedAttachmentFetch =
						response.status() === 200 &&
						response.request().method() === "GET" &&
						(await response.request().allHeaders()).cookie?.includes("pi_web_session=") === true;
				}
				const roundTripFinished = await page.evaluate(() => performance.now());
				await cdp.send("HeapProfiler.collectGarbage");
				const heapAfter = await page.evaluate(
					() =>
						(performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
						null,
				);
				const trialWire = wire.slice(wireStart);
				const sentBytes = trialWire
					.filter((event) => event.direction === "sent")
					.map((event) => Buffer.byteLength(event.raw, "utf8"));
				const receivedBytes = trialWire
					.filter((event) => event.direction === "received")
					.map((event) => Buffer.byteLength(event.raw, "utf8"));
				const receivedRaw = trialWire
					.filter((event) => event.direction === "received")
					.map((event) => event.raw)
					.join("\n");
				outcome.trials.push({
					index,
					warmup: index < scenario.warmups,
					metrics: {
						selectionMs: selectionFinished - selectionStarted,
						roundTripMs: roundTripFinished - roundTripStarted,
						inputBase64Chars,
						maxSentFrameBytes: Math.max(0, ...sentBytes),
						maxReceivedFrameBytes: Math.max(0, ...receivedBytes),
						heapDeltaBytes: heapBefore === null || heapAfter === null ? null : heapAfter - heapBefore,
					},
					correctness: {
						inputReachedPiAtExpectedSize:
							harness
								.piEvents()
								.filter((event) => event.type === "prompt" && event.text === PROMPT)
								.at(-1)?.imageChars === inputBase64Chars,
						typedOutputRefsObserved: trialWire.filter((event) => hasAttachmentRef(event.frame)).length >= 2,
						outputBlobResolved: await image.evaluate((element) => {
							const target = element as HTMLImageElement;
							return target.complete && target.naturalWidth > 0;
						}),
						largeOutputStayedOffWebSocket: !receivedRaw.includes("iVBORw0KGgo"),
						socketRemainedUsable: sockets.length === 1 && closedSockets.length === 0,
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
				"Near-limit input and large output must preserve exact typed-reference custody.",
			);
			addValueGate(
				outcome,
				"authenticatedAttachmentFetch",
				authenticatedAttachmentFetch ? 1 : 0,
				"eq",
				1,
				"hard",
				"At least one uncached output fetch must exercise authenticated no-inline blob custody.",
			);
			addSummaryGate(
				outcome,
				"selectionMs",
				"p95",
				"lte",
				3_000,
				"observe",
				"Selection latency is hardware-sensitive and remains observational before reference calibration.",
			);
			addSummaryGate(
				outcome,
				"roundTripMs",
				"p95",
				"lte",
				5_000,
				"observe",
				"Round-trip latency is recorded but cannot be a shared release gate without a reference host.",
			);
			addSummaryGate(
				outcome,
				"maxSentFrameBytes",
				"max",
				"lte",
				8 * 1024 * 1024,
				"hard",
				"Browser command frames must remain inside the negotiated command ceiling.",
			);
			addSummaryGate(
				outcome,
				"maxReceivedFrameBytes",
				"max",
				"lte",
				256 * 1024,
				"hard",
				"Large Pi output must stay behind an attachment_ref instead of re-entering WebSocket frames.",
			);
			addSummaryGate(
				outcome,
				"heapDeltaBytes",
				"p95",
				"lte",
				128 * 1024 * 1024,
				"observe",
				"Heap copies are recorded until reference-host baselines establish a stable portable budget.",
			);
			addValueGate(
				outcome,
				"browserErrors",
				errors.console.length + errors.page.length,
				"eq",
				0,
				"hard",
				"Browser errors invalidate the content round trip.",
			);
			outcome.notes.push(
				"This production lane covers epoch attachment refs. Private future content-root refs remain separate.",
			);
		});
	});
}
