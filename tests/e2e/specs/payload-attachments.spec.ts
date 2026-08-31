import type { Page, WebSocket } from "@playwright/test";
import { observePageErrors } from "../fixtures/page-observation";
import type { ProductionHarness } from "../fixtures/production-harness";
import { expect, test } from "../fixtures/test";

const LARGE_IMAGE_PROMPT = "E2E_PAYLOAD_ATTACHMENT";
const AFTER_ATTACHMENT_PROMPT = "E2E_AFTER_PAYLOAD_ATTACHMENT";
const PNG_BASE64_PREFIX = "iVBORw0KGgo";
const MIB = 1024 * 1024;
const CONTENT_REF_PROTOCOL_MINOR = 4;
const SESSION_HISTORY_CAPABILITY = "session.chunked_history";
const CONTENT_REF_BUDGET = {
	maxContentBlobBytes: 48 * MIB,
	inlineContentThresholdBytes: 256 * 1024,
};
const EXPECTED_SERVER_CAPABILITIES = [
	"rpc.commands",
	"rpc.events",
	"rpc.extension_ui",
	"session.multiplex",
	"session.hot_runtime_inventory",
	"session.fenced_takeover",
	SESSION_HISTORY_CAPABILITY,
	"payload.epoch_attachment_refs",
	"payload.epoch_content_refs",
];
const EXPECTED_PAYLOAD_BUDGET = {
	maxCommandFrameBytes: 8 * MIB,
	maxCommandTextBytes: MIB,
	maxInlineImageBase64Bytes: 2 * MIB,
	maxInlineImagesBase64Bytes: 6 * MIB,
	maxImageCount: 16,
	maxPiJsonlFrameBytes: 8 * MIB,
	maxPiSnapshotJsonlFrameBytes: 64 * MIB,
	maxNormalizedEventFrameBytes: 8 * MIB + 4 * 1024,
	maxReplayFrameBytes: 8 * MIB + 4 * 1024,
	maxReplayBytes: 16 * MIB,
	maxSnapshotCanonicalBytes: 64 * MIB,
	maxServerFrameBytes: 65 * MIB,
	maxQueuedBacklogBytes: MIB,
	maxCatchUpBacklogBytes: MIB,
	maxAttachmentBlobBytes: 8 * MIB,
	maxAttachmentCacheBytes: 64 * MIB,
	maxAttachmentCacheItems: 256,
};
const ONE_PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	"base64",
);

interface WireFrame extends Record<string, unknown> {
	type?: string;
}

interface ObservedAttachmentRef {
	type: "attachment_ref";
	serverEpoch: string;
	sha256: string;
	mediaType: string;
	byteLength: number;
}

interface WireObservation {
	sockets: WebSocket[];
	closed: WebSocket[];
	events: Array<{ direction: "received" | "sent"; frame: WireFrame; raw: string }>;
}

function parseFrame(payload: string | Buffer): { frame: WireFrame; raw: string } | undefined {
	const raw = payload.toString();
	try {
		return { frame: JSON.parse(raw) as WireFrame, raw };
	} catch {
		return undefined;
	}
}

function observeWire(page: Page): WireObservation {
	const observation: WireObservation = { sockets: [], closed: [], events: [] };
	page.on("websocket", (socket) => {
		observation.sockets.push(socket);
		socket.on("framesent", ({ payload }) => {
			const parsed = parseFrame(payload);
			if (parsed) observation.events.push({ direction: "sent", ...parsed });
		});
		socket.on("framereceived", ({ payload }) => {
			const parsed = parseFrame(payload);
			if (parsed) observation.events.push({ direction: "received", ...parsed });
		});
		socket.on("close", () => observation.closed.push(socket));
	});
	return observation;
}

async function openWorkbench(page: Page, harness: ProductionHarness): Promise<void> {
	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("#root > div")).toBeVisible();
	await expect(page.locator("textarea")).toBeEnabled();
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
	await page.locator("textarea").fill(prompt);
	await page.getByRole("button", { name: /^(Send|发送)$/ }).click();
}

function receivedFrames(observation: WireObservation): WireFrame[] {
	return observation.events.filter((event) => event.direction === "received").map((event) => event.frame);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function attachmentRef(frame: WireFrame): ObservedAttachmentRef | undefined {
	if (frame.type !== "event") return undefined;
	const event = record(frame.event);
	const message = record(event?.message);
	const content = message?.content;
	if (!Array.isArray(content)) return undefined;
	for (const candidate of content) {
		const image = record(candidate);
		const ref = record(image?.data);
		if (
			image?.type === "image" &&
			ref?.type === "attachment_ref" &&
			typeof ref.serverEpoch === "string" &&
			typeof ref.sha256 === "string" &&
			typeof ref.mediaType === "string" &&
			typeof ref.byteLength === "number"
		) {
			return ref as unknown as ObservedAttachmentRef;
		}
	}
	return undefined;
}

function attachmentEvents(observation: WireObservation): WireFrame[] {
	return receivedFrames(observation).filter((frame) => attachmentRef(frame) !== undefined);
}

async function attachValidPng(page: Page): Promise<void> {
	await page.locator("#piweb-image-input").setInputFiles({
		name: "payload-trigger.png",
		mimeType: "image/png",
		buffer: ONE_PIXEL_PNG,
	});
	await expect(page.getByAltText(/^(Attachment 1|附件 1)$/)).toBeVisible();
}

test("a packaged Browser renders a large Pi image by authenticated attachment ref without poisoning the socket", async ({
	page,
	harness,
}) => {
	const errors = observePageErrors(page);
	const wire = observeWire(page);

	await openWorkbench(page, harness);
	await expect
		.poll(() => receivedFrames(wire).find((frame) => frame.type === "server_hello"))
		.toMatchObject({
			protocol: { major: 1, minor: CONTENT_REF_PROTOCOL_MINOR },
			capabilities: EXPECTED_SERVER_CAPABILITIES,
			payloadBudget: EXPECTED_PAYLOAD_BUDGET,
			contentRefBudget: CONTENT_REF_BUDGET,
		});

	const attachmentResponse = page.waitForResponse((response) =>
		new URL(response.url()).pathname.startsWith("/api/v1/attachments/"),
	);
	await attachValidPng(page);
	await sendPrompt(page, LARGE_IMAGE_PROMPT);
	await expect.poll(() => attachmentEvents(wire).length).toBeGreaterThanOrEqual(2);
	const refs = attachmentEvents(wire).map((frame) => attachmentRef(frame));
	expect(refs.every((ref) => ref !== undefined)).toBe(true);
	expect(new Set(refs.map((ref) => JSON.stringify(ref))).size).toBe(1);
	expect(refs[0]?.byteLength).toBeGreaterThan(1024 * 1024);
	expect(attachmentEvents(wire).map((frame) => record(frame.event)?.type)).toEqual(
		expect.arrayContaining(["message_start", "message_end"]),
	);
	const image = page.getByAltText(/^(Attachment image 1|附件图片 1)$/);
	await expect(image).toBeVisible();
	await expect(image).toHaveAttribute(
		"src",
		`/api/v1/attachments/${encodeURIComponent(refs[0]?.serverEpoch ?? "")}/${refs[0]?.sha256 ?? ""}`,
	);
	const response = await attachmentResponse;
	expect(response.status()).toBe(200);
	expect(response.request().method()).toBe("GET");
	expect((await response.request().allHeaders()).cookie).toMatch(/(?:^|;\s*)pi_web_session=[^;]+/);
	expect(response.headers()["cache-control"]).toBe("no-store");
	await expect
		.poll(() =>
			image.evaluate((element) => {
				const attachment = element as HTMLImageElement;
				return attachment.complete && attachment.naturalWidth > 0;
			}),
		)
		.toBe(true);

	const receivedRaw = wire.events.filter((event) => event.direction === "received").map((event) => event.raw);
	expect(receivedRaw.some((raw) => raw.includes('"attachment_ref"'))).toBe(true);
	expect(receivedRaw.some((raw) => raw.includes(PNG_BASE64_PREFIX))).toBe(false);
	expect(await image.getAttribute("src")).not.toMatch(/^data:/);

	await sendPrompt(page, AFTER_ATTACHMENT_PROMPT);
	await expect(page.locator("main")).toContainText(`E2E_REPLY:${AFTER_ATTACHMENT_PROMPT}`);
	expect(wire.sockets).toHaveLength(1);
	expect(wire.closed).toEqual([]);
	expect(errors.console).toEqual([]);
	expect(errors.page).toEqual([]);
});

test("an unavailable exact attachment triggers one cursorless fresh resubscribe without inline fallback", async ({
	page,
	harness,
}) => {
	const errors = observePageErrors(page);
	const wire = observeWire(page);
	let failedAttachmentRequests = 0;
	await page.route("**/api/v1/attachments/**", async (route) => {
		failedAttachmentRequests += 1;
		await route.fulfill({ status: 410, contentType: "text/plain", body: "expired test attachment" });
	});

	await openWorkbench(page, harness);
	await attachValidPng(page);
	await sendPrompt(page, LARGE_IMAGE_PROMPT);
	await expect.poll(() => attachmentEvents(wire).length).toBeGreaterThanOrEqual(2);
	const firstAttachmentEventIndex = wire.events.findIndex(
		(event) => event.direction === "received" && attachmentRef(event.frame) !== undefined,
	);
	const event = attachmentEvents(wire)[0];
	const unavailableRef = event ? attachmentRef(event) : undefined;
	const sessionHandle = event?.sessionHandle;
	expect(typeof sessionHandle).toBe("string");
	expect(unavailableRef).toBeDefined();
	if (typeof sessionHandle !== "string") throw new Error("attachment event omitted sessionHandle");
	if (!unavailableRef) throw new Error("attachment event omitted exact ref");

	await expect.poll(() => failedAttachmentRequests).toBeGreaterThanOrEqual(1);
	const subscriptionsAfterFailure = () =>
		wire.events
			.slice(firstAttachmentEventIndex + 1)
			.filter(
				(event) =>
					event.direction === "sent" &&
					event.frame.type === "session_subscribe" &&
					event.frame.sessionHandle === sessionHandle,
			);
	await expect.poll(() => subscriptionsAfterFailure().length).toBe(1);
	expect(subscriptionsAfterFailure()[0]?.frame).not.toHaveProperty("cursor");
	await expect
		.poll(() =>
			wire.events
				.slice(firstAttachmentEventIndex + 1)
				.some(
					(candidate) =>
						candidate.direction === "received" &&
						candidate.frame.type === "session_snapshot" &&
						candidate.frame.sessionHandle === sessionHandle,
				),
		)
		.toBe(true);

	const image = page.getByAltText(/^(Attachment image 1|附件图片 1)$/);
	await expect(image).toHaveAttribute(
		"src",
		`/api/v1/attachments/${encodeURIComponent(unavailableRef.serverEpoch)}/${unavailableRef.sha256}`,
	);
	expect(await image.getAttribute("src")).not.toMatch(/^data:/);
	await expect(page.locator("textarea")).toBeEnabled();
	await sendPrompt(page, AFTER_ATTACHMENT_PROMPT);
	await expect(page.locator("main")).toContainText(`E2E_REPLY:${AFTER_ATTACHMENT_PROMPT}`);
	expect(subscriptionsAfterFailure()).toHaveLength(1);
	expect(failedAttachmentRequests).toBe(1);
	expect(
		wire.events
			.filter((candidate) => candidate.direction === "received")
			.some((candidate) => candidate.raw.includes(PNG_BASE64_PREFIX)),
	).toBe(false);
	expect(wire.sockets).toHaveLength(1);
	expect(wire.closed).toEqual([]);
	expect(errors.console).toEqual([
		expect.stringMatching(/Failed to load resource: the server responded with a status of 410/),
	]);
	expect(errors.console.join("\n")).not.toContain(PNG_BASE64_PREFIX);
	expect(errors.console.join("\n")).not.toContain("data:image/");
	expect(errors.page).toEqual([]);
});
