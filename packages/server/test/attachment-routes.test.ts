import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { serve } from "@hono/node-server";
import { SESSION_ATTACHMENT_BLOB_MAX_BYTES } from "@pi-agent-web/protocol";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayAccessControl } from "../src/access-control.js";
import { type AttachmentContentStore, createAttachmentRoutes } from "../src/attachment-routes.js";
import { EpochContentStore, EpochContentStoreError } from "../src/epoch-content-store.js";
import { type AppContext, createApp } from "../src/routes.js";

const EPOCH = "route-epoch-a";
const PNG_IHDR = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000000000000", "hex");
const PNG_IEND = Buffer.from("0000000049454e4400000000", "hex");
const PNG = Buffer.concat([PNG_IHDR, Buffer.from("00000001494441540000000000", "hex"), PNG_IEND]);
const JPEG = Buffer.from("ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9", "hex");
const WEBP = Buffer.concat([
	Buffer.from("RIFF"),
	Buffer.from([22, 0, 0, 0]),
	Buffer.from("WEBPVP8 "),
	Buffer.from([10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]),
]);
const GIF = Buffer.from("474946383961010001000000002c00000000010001000002024401003b", "hex");
const GIF_ALT = Buffer.from(GIF);
GIF_ALT[GIF_ALT.byteLength - 2] = GIF_ALT[GIF_ALT.byteLength - 2]! ^ 1;

function webpChunk(type: string, data: Uint8Array): Buffer {
	const size = Buffer.alloc(4);
	size.writeUInt32LE(data.byteLength);
	return Buffer.concat([
		Buffer.from(type),
		size,
		Buffer.from(data),
		...(data.byteLength & 1 ? [Buffer.alloc(1)] : []),
	]);
}

function webpRiff(chunks: readonly Buffer[]): Buffer {
	const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
	const size = Buffer.alloc(4);
	size.writeUInt32LE(body.byteLength);
	return Buffer.concat([Buffer.from("RIFF"), size, body]);
}

function vp8xData(flags = 0): Buffer {
	return Buffer.from([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

const WEBP_VP8X_ONLY = webpRiff([webpChunk("VP8X", vp8xData())]);
const WEBP_OPAQUE_EXTENDED = webpRiff([
	webpChunk("VP8X", vp8xData(0x02)),
	webpChunk("ANMF", Buffer.alloc(17)),
]);

function largeWebp(byteLength: number): Buffer {
	const payload = Buffer.alloc(byteLength, 7);
	payload.write("RIFF", 0, "ascii");
	payload.writeUInt32LE(byteLength - 8, 4);
	payload.write("WEBPVP8 ", 8, "ascii");
	payload.writeUInt32LE(byteLength - 20, 16);
	payload.set(Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]), 20);
	return payload;
}

function digest(body: Uint8Array): string {
	return createHash("sha256").update(body).digest("hex");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function appFor(store: AttachmentContentStore): Hono {
	if (typeof store.pinByDigest !== "function") {
		store.pinByDigest = async () => {
			throw new EpochContentStoreError("not_found", "test store has no existing attachment");
		};
	}
	const app = new Hono();
	app.route("/api/v1", createAttachmentRoutes({ contentStore: store, serverEpoch: EPOCH }));
	return app;
}

function put(
	app: Hono,
	body: Uint8Array,
	options: {
		sha256?: string;
		epoch?: string;
		mediaType?: string;
		contentLength?: string | null;
		contentEncoding?: string;
	} = {},
): Promise<Response> {
	const headers = new Headers({
		"Content-Type": options.mediaType ?? "image/png",
	});
	if (options.contentLength !== null) {
		headers.set("Content-Length", options.contentLength ?? String(body.byteLength));
	}
	if (options.contentEncoding) headers.set("Content-Encoding", options.contentEncoding);
	return Promise.resolve(
		app.request(`/api/v1/attachments/${options.epoch ?? EPOCH}/${options.sha256 ?? digest(body)}`, {
			method: "PUT",
			headers,
			body,
		}),
	);
}

async function errorCode(response: Response): Promise<string> {
	expect(response.headers.get("cache-control")).toBe("no-store");
	const body = (await response.clone().json()) as
		| { type: "payload_admission_error"; code: string }
		| { error: { code: string } };
	return "error" in body ? body.error.code : body.code;
}

describe("attachment REST routes", () => {
	let webDataDir: string;
	const stores: EpochContentStore[] = [];

	beforeEach(async () => {
		webDataDir = await mkdtemp(path.join(tmpdir(), "pi-web-attachment-routes-"));
	});

	afterEach(async () => {
		await Promise.allSettled(stores.map((store) => store.shutdown()));
		await rm(webDataDir, { recursive: true, force: true });
	});

	async function realApp(limits: ConstructorParameters<typeof EpochContentStore>[0]["limits"] = {}) {
		const store = new EpochContentStore({ webDataDir, serverEpoch: EPOCH, limits });
		stores.push(store);
		await store.initialize();
		return { app: appFor(store), store };
	}

	it.each([
		["image/png", PNG],
		["image/jpeg", JPEG],
		["image/webp", WEBP],
		["image/gif", GIF],
	] as const)(
		"streams, publishes, and retrieves %s without buffering the route body",
		async (mediaType, bytes) => {
			const { app } = await realApp();
			const sha256 = digest(bytes);
			const created = await put(app, bytes, { mediaType, sha256 });
			expect(created.status).toBe(201);
			expect(await created.json()).toEqual({
				attachment: {
					type: "attachment_ref",
					serverEpoch: EPOCH,
					sha256,
					mediaType,
					byteLength: bytes.byteLength,
				},
			});

			const repeated = await put(app, bytes, { mediaType, sha256 });
			expect(repeated.status).toBe(200);

			const downloaded = await app.request(`/api/v1/attachments/${EPOCH}/${sha256}`);
			expect(downloaded.status).toBe(200);
			expect(downloaded.headers.get("content-type")).toBe(mediaType);
			expect(downloaded.headers.get("content-length")).toBe(String(bytes.byteLength));
			expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
			expect(downloaded.headers.get("content-disposition")).toMatch(/^attachment; filename="[0-9a-f]{64}\./);
			expect(downloaded.headers.get("cache-control")).toBe("no-store");
			expect(downloaded.headers.get("cross-origin-resource-policy")).toBe("same-origin");
			expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
		},
	);

	it("starts bounded store staging before pulling the upload body", async () => {
		const sha256 = digest(PNG);
		const ref = Object.freeze({
			type: "attachment_ref" as const,
			serverEpoch: EPOCH,
			sha256,
			mediaType: "image/png",
			byteLength: PNG.byteLength,
		});
		let bodyController!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				bodyController = controller;
			},
		});
		const stage = vi.fn(async ({ source }: Parameters<AttachmentContentStore["stage"]>[0]) => {
			const chunks: Buffer[] = [];
			for await (const chunk of source) chunks.push(Buffer.from(chunk));
			expect(Buffer.concat(chunks)).toEqual(PNG);
			return { ref, hold: { ref }, created: true };
		});
		const app = appFor({
			stage,
			publish: vi.fn(async () => undefined),
			release: vi.fn(async () => undefined),
		} as unknown as AttachmentContentStore);
		const request = new Request(`http://localhost/api/v1/attachments/${EPOCH}/${sha256}`, {
			method: "PUT",
			headers: { "Content-Length": String(PNG.byteLength), "Content-Type": "image/png" },
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		const responsePromise = Promise.resolve(app.request(request));
		await new Promise<void>((resolve) => setImmediate(resolve));
		const stagesBeforeBody = stage.mock.calls.length;
		bodyController.enqueue(PNG.subarray(0, 10));
		bodyController.enqueue(PNG.subarray(10, -5));
		bodyController.enqueue(PNG.subarray(-5));
		bodyController.close();
		const response = await responsePromise;

		expect(stagesBeforeBody).toBe(1);
		expect(response.status).toBe(201);
	});

	it.each(["abort", "body error"] as const)(
		"releases an existing-content pin exactly once on repeat upload %s",
		async (failureMode) => {
			const sha256 = digest(PNG);
			const ref = Object.freeze({
				type: "attachment_ref" as const,
				serverEpoch: EPOCH,
				sha256,
				mediaType: "image/png",
				byteLength: PNG.byteLength,
			});
			const pin = Object.freeze({ ref });
			const pinnedStream = new PassThrough();
			const pinByDigest = vi.fn(async () => ({ ref, stream: pinnedStream, pin }));
			const stage = vi.fn();
			const release = vi.fn(async (handle: unknown) => {
				expect(handle).toBe(pin);
				pinnedStream.destroy();
			});
			const app = appFor({ pinByDigest, stage, release } as unknown as AttachmentContentStore);
			let bodyController!: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					bodyController = controller;
				},
			});
			const uploadAbort = new AbortController();
			const request = new Request(`http://localhost/api/v1/attachments/${EPOCH}/${sha256}`, {
				method: "PUT",
				headers: { "Content-Length": String(PNG.byteLength), "Content-Type": "image/png" },
				body,
				duplex: "half",
				signal: uploadAbort.signal,
			} as RequestInit & { duplex: "half" });
			const responsePromise = Promise.resolve(app.request(request));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(pinByDigest).toHaveBeenCalledTimes(1);
			expect(stage).not.toHaveBeenCalled();

			if (failureMode === "abort") uploadAbort.abort();
			else bodyController.error(new Error("synthetic upload failure"));
			const response = await responsePromise;
			expect(response.status).toBe(500);
			expect(release).toHaveBeenCalledTimes(1);
		},
	);

	it("requires a positive safe Content-Length and identity transfer encoding before store admission", async () => {
		const stage = vi.fn();
		const app = appFor({ stage } as unknown as AttachmentContentStore);

		const missing = await put(app, PNG, { contentLength: null });
		expect(missing.status).toBe(411);
		expect(await errorCode(missing)).toBe("content_length_required");

		for (const contentLength of ["0", "-1", "1.5", "9007199254740992"]) {
			const invalid = await put(app, PNG, { contentLength });
			expect(invalid.status).toBe(400);
			expect(await errorCode(invalid)).toBe("invalid_content_length");
		}

		const oversized = await put(app, PNG, {
			contentLength: String(SESSION_ATTACHMENT_BLOB_MAX_BYTES + 1),
		});
		expect(oversized.status).toBe(413);
		expect(oversized.headers.get("cache-control")).toBe("no-store");
		expect(await oversized.json()).toEqual({
			type: "payload_admission_error",
			code: "payload_too_large",
			boundary: "attachment_blob",
			limitBytes: SESSION_ATTACHMENT_BLOB_MAX_BYTES,
			actualBytes: SESSION_ATTACHMENT_BLOB_MAX_BYTES + 1,
		});

		const encoded = await put(app, PNG, { contentEncoding: "gzip" });
		expect(encoded.status).toBe(415);
		expect(await errorCode(encoded)).toBe("unsupported_content_encoding");
		expect(stage).not.toHaveBeenCalled();
	});

	it("rejects unsafe media types, wrong magic, truncation, digest mismatch, and actual length mismatch", async () => {
		const { app } = await realApp();

		const svg = await put(app, PNG, { mediaType: "image/svg+xml" });
		expect(svg.status).toBe(415);
		expect(await errorCode(svg)).toBe("unsupported_media_type");

		const wrongMagic = await put(app, Buffer.alloc(24, 1));
		expect(wrongMagic.status).toBe(422);
		expect(await errorCode(wrongMagic)).toBe("invalid_raster_magic");

		const unknownWebpEncoding = await put(app, webpRiff([webpChunk("JUNK", Buffer.alloc(2))]), {
			mediaType: "image/webp",
		});
		expect(unknownWebpEncoding.status).toBe(422);
		expect(await errorCode(unknownWebpEncoding)).toBe("invalid_raster_magic");

		for (const [mediaType, bytes, minimumHeaderBytes] of [
			["image/png", PNG, 24],
			["image/jpeg", JPEG, 6],
			["image/webp", WEBP, 20],
			["image/gif", GIF, 13],
		] as const) {
			const truncated = await put(app, bytes.subarray(0, minimumHeaderBytes - 1), { mediaType });
			expect(truncated.status).toBe(422);
			expect(await errorCode(truncated)).toBe("truncated_raster_header");
		}

		const wrongDigest = await put(app, PNG, { sha256: "0".repeat(64) });
		expect(wrongDigest.status).toBe(422);
		expect(await errorCode(wrongDigest)).toBe("declared_digest_mismatch");

		const wrongLength = await put(app, PNG, { contentLength: String(PNG.byteLength - 1) });
		expect(wrongLength.status).toBe(422);
		expect(await errorCode(wrongLength)).toBe("declared_length_mismatch");

		const invalidGif = Buffer.from(GIF);
		invalidGif[invalidGif.byteLength - 1] = 0;
		const digestBeforeGross = await put(app, invalidGif, { sha256: "0".repeat(64), mediaType: "image/gif" });
		expect(await errorCode(digestBeforeGross)).toBe("declared_digest_mismatch");
		const lengthBeforeDigestAndGross = await put(app, Buffer.concat([invalidGif, Buffer.from([0])]), {
			sha256: "0".repeat(64),
			mediaType: "image/gif",
			contentLength: String(invalidGif.byteLength),
		});
		expect(await errorCode(lengthBeforeDigestAndGross)).toBe("declared_length_mismatch");
	});

	it.each([
		["image/png", PNG.subarray(0, -12)],
		["image/jpeg", JPEG.subarray(0, -2)],
		["image/gif", GIF.subarray(0, -1)],
		[
			"image/webp",
			Buffer.concat([
				Buffer.from("RIFF"),
				Buffer.from([13, 0, 0, 0]),
				Buffer.from("WEBPVP8 "),
				Buffer.from([2, 0, 0, 0, 1, 2]),
			]),
		],
		[
			"image/webp",
			Buffer.concat([
				Buffer.from("RIFF"),
				Buffer.from([14, 0, 0, 0]),
				Buffer.from("WEBPVP8 "),
				Buffer.from([4, 0, 0, 0, 1, 2]),
			]),
		],
	] as const)("rejects a grossly truncated %s container before publish", async (mediaType, bytes) => {
		const { app, store } = await realApp();
		const response = await put(app, bytes, { mediaType });
		expect(response.status).toBe(422);
		expect(await errorCode(response)).toBe("invalid_raster_structure");
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
	});

	it.each([
		["image/png", Buffer.concat([PNG_IHDR, PNG_IEND])],
		["image/jpeg", Buffer.from("ffd8ffffe00002ffd9", "hex")],
		["image/gif", Buffer.from("474946383961010001000000003b", "hex")],
		["image/webp", WEBP_VP8X_ONLY],
		["image/webp", WEBP_OPAQUE_EXTENDED],
	] as const)(
		"accepts grossly intact %s containers without claiming codec decodability",
		async (mediaType, bytes) => {
			const { app } = await realApp();
			const response = await put(app, bytes, { mediaType });
			expect(response.status).toBe(201);
		},
	);

	it("returns exactly one 201 and one 200 for concurrent identical PUTs", async () => {
		const { app, store } = await realApp();
		const responses = await Promise.all([
			put(app, PNG, { mediaType: "image/png" }),
			put(app, PNG, { mediaType: "image/png" }),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
		expect(store.usage).toEqual({ bytes: PNG.byteLength, items: 1 });
	});

	it("rejects stale epoch, digest, traversal, and Range before touching the store", async () => {
		const stage = vi.fn();
		const pinByDigest = vi.fn();
		const app = appFor({ stage, pinByDigest } as unknown as AttachmentContentStore);

		const stale = await app.request(`/api/v1/attachments/other/${"a".repeat(64)}`);
		expect(stale.status).toBe(410);
		expect(stale.headers.get("cache-control")).toBe("no-store");
		expect(await stale.json()).toEqual({
			type: "payload_admission_error",
			code: "attachment_ref_epoch_mismatch",
			boundary: "attachment_ref",
		});

		for (const target of [
			`/api/v1/attachments/${EPOCH}/not-a-digest`,
			`/api/v1/attachments/${EPOCH}/..%2Foutside`,
		]) {
			const response = await app.request(target, {
				method: "PUT",
				headers: { "Content-Length": "1", "Content-Type": "image/gif" },
				body: new Uint8Array([1]),
			});
			expect(response.status).toBe(400);
		}

		const ranged = await app.request(`/api/v1/attachments/${EPOCH}/${"a".repeat(64)}`, {
			headers: { Range: "bytes=0-1" },
		});
		expect(ranged.status).toBe(416);
		expect(await errorCode(ranged)).toBe("range_not_supported");
		expect(stage).not.toHaveBeenCalled();
		expect(pinByDigest).not.toHaveBeenCalled();
	});

	it("mounts behind the existing auth middleware and rejects HEAD without pinning", async () => {
		const stage = vi.fn();
		const pinByDigest = vi.fn();
		const contentStore = { stage, pinByDigest } as unknown as AttachmentContentStore;
		const accessControl = createGatewayAccessControl("attachment-route-secret");
		const app = createApp({
			accessControl,
			contentStore,
			serverEpoch: EPOCH,
			readiness: { ready: true },
		} as AppContext);
		const url = `/api/v1/attachments/${EPOCH}/${"a".repeat(64)}`;
		const unauthorized = await app.request(url);
		expect(unauthorized.status).toBe(403);
		expect(unauthorized.headers.get("cache-control")).toBe("no-store");

		const cookie = accessControl.createSessionCookie().split(";", 1)[0] ?? "";
		const authorizedHeaders = {
			Host: "127.0.0.1:31415",
			Origin: "http://127.0.0.1:31415",
			Cookie: cookie,
		};
		const head = await app.request(url, { method: "HEAD", headers: authorizedHeaders });
		expect(head.status).toBe(405);
		expect(head.headers.get("allow")).toBe("GET, PUT");
		expect(head.headers.get("cache-control")).toBe("no-store");
		expect(pinByDigest).not.toHaveBeenCalled();
		expect(stage).not.toHaveBeenCalled();
	});

	it("reuses a full-cache digest without reservation and maps genuine exhaustion to 507", async () => {
		const { app, store } = await realApp({
			maxBlobBytes: GIF.byteLength,
			maxCacheBytes: GIF.byteLength,
			maxCacheItems: 1,
		});
		expect((await put(app, GIF, { mediaType: "image/gif" })).status).toBe(201);
		const stage = vi.spyOn(store, "stage");
		const repeated = await put(app, GIF, { mediaType: "image/gif" });
		expect(repeated.status).toBe(200);
		expect(stage).not.toHaveBeenCalled();
		expect(store.usage).toEqual({ bytes: GIF.byteLength, items: 1 });

		const wrongBody = await put(app, GIF_ALT, { mediaType: "image/gif", sha256: digest(GIF) });
		expect(wrongBody.status).toBe(422);
		expect(await errorCode(wrongBody)).toBe("declared_digest_mismatch");
		const invalidContainer = Buffer.from(GIF);
		invalidContainer[invalidContainer.byteLength - 1] = 0;
		const wrongStructure = await put(app, invalidContainer, {
			mediaType: "image/gif",
			sha256: digest(GIF),
		});
		expect(wrongStructure.status).toBe(422);
		expect(await errorCode(wrongStructure)).toBe("declared_digest_mismatch");
		const wrongType = await put(app, GIF, { mediaType: "image/png", sha256: digest(GIF) });
		expect(wrongType.status).toBe(422);
		expect(await errorCode(wrongType)).toBe("manifest_mismatch");
		const wrongLength = await put(app, GIF, {
			mediaType: "image/gif",
			sha256: digest(GIF),
			contentLength: String(GIF.byteLength - 1),
		});
		expect(wrongLength.status).toBe(422);
		expect(await errorCode(wrongLength)).toBe("manifest_mismatch");
		const extraBodyByte = await put(app, Buffer.concat([GIF, Buffer.from([0x3b])]), {
			mediaType: "image/gif",
			sha256: digest(GIF),
			contentLength: String(GIF.byteLength),
		});
		expect(extraBodyByte.status).toBe(422);
		expect(await errorCode(extraBodyByte)).toBe("declared_length_mismatch");
		expect(stage).not.toHaveBeenCalled();

		const exhausted = await put(app, GIF_ALT, { mediaType: "image/gif" });
		expect(exhausted.status).toBe(507);
		expect(exhausted.headers.get("cache-control")).toBe("no-store");
		expect(await exhausted.json()).toEqual({
			type: "payload_admission_error",
			code: "attachment_cache_exhausted",
			boundary: "attachment_cache",
			limitBytes: GIF.byteLength,
			actualBytes: GIF.byteLength * 2,
		});
	});

	it("maps item exhaustion and unknown I/O to fixed redacted errors", async () => {
		const itemLimited = appFor({
			async stage() {
				throw new EpochContentStoreError("cache_items_exhausted", "private", { limit: 1, actual: 2 });
			},
		} as unknown as AttachmentContentStore);
		const itemFailure = await put(itemLimited, PNG);
		expect(itemFailure.status).toBe(507);
		expect(await itemFailure.json()).toEqual({
			type: "payload_admission_error",
			code: "attachment_cache_item_limit_exceeded",
			boundary: "attachment_cache",
			limitItems: 1,
			actualItems: 2,
		});

		const failing = appFor({
			async stage() {
				throw new Error("EIO at /private/pi-web/secret/content");
			},
		} as unknown as AttachmentContentStore);
		const failed = await put(failing, PNG);
		expect(failed.status).toBe(500);
		expect(await failed.text()).toBe(
			JSON.stringify({ error: { code: "attachment_io_failure", message: "Attachment operation failed" } }),
		);
	});

	it("returns 404 for unavailable content and releases a managed GET pin when the client cancels", async () => {
		const released: unknown[] = [];
		const stream = new PassThrough();
		stream.write(Buffer.from("chunk"));
		const sha256 = "b".repeat(64);
		const pin = Object.freeze({
			ref: { type: "attachment_ref", serverEpoch: EPOCH, sha256, mediaType: "image/gif", byteLength: 5 },
		});
		const store = {
			async pinByDigest(requested: string) {
				if (requested !== sha256) throw new EpochContentStoreError("not_found", "private path");
				return { ref: pin.ref, stream, pin };
			},
			async release(handle: unknown) {
				released.push(handle);
				stream.destroy();
			},
		} as unknown as AttachmentContentStore;
		const app = appFor(store);
		const missing = await app.request(`/api/v1/attachments/${EPOCH}/${"c".repeat(64)}`);
		expect(missing.status).toBe(404);
		expect(missing.headers.get("cache-control")).toBe("no-store");
		expect(await missing.json()).toEqual({
			type: "payload_admission_error",
			code: "attachment_unavailable",
			boundary: "attachment_ref",
		});

		const response = await app.request(`/api/v1/attachments/${EPOCH}/${sha256}`);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("GET response did not expose a body");
		expect(await reader.read()).toMatchObject({ done: false });
		await reader.cancel("client cancelled");
		expect(released).toEqual([pin]);
	});

	it("releases a real HTTP GET pin after socket abort while the server remains available", async () => {
		const { app, store } = await realApp();
		const bytes = largeWebp(8 * 1024 * 1024);
		const sha256 = digest(bytes);
		expect((await put(app, bytes, { mediaType: "image/webp", sha256 })).status).toBe(201);
		const pinEntered = deferred();
		const pinReleased = deferred();
		let activePin: Awaited<ReturnType<typeof store.pinByDigest>>["pin"] | undefined;
		let activePinWasReleased = false;
		const realPinByDigest = store.pinByDigest.bind(store);
		const realRelease = store.release.bind(store);
		store.pinByDigest = async (...args) => {
			const pinned = await realPinByDigest(...args);
			activePin = pinned.pin;
			pinEntered.resolve();
			return pinned;
		};
		store.release = async (resource) => {
			if (resource === activePin) {
				activePinWasReleased = true;
				pinReleased.resolve();
			}
			return realRelease(resource);
		};
		const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
		try {
			if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("test server did not bind");
			const socket = createConnection({ host: "127.0.0.1", port: address.port });
			socket.on("error", () => undefined);
			await new Promise<void>((resolve) => socket.once("connect", resolve));
			const firstData = new Promise<void>((resolve) => {
				socket.once("data", () => {
					socket.pause();
					resolve();
				});
			});
			socket.write(
				[
					`GET /api/v1/attachments/${EPOCH}/${sha256} HTTP/1.1`,
					`Host: 127.0.0.1:${String(address.port)}`,
					"Connection: keep-alive",
					"",
					"",
				].join("\r\n"),
			);
			await firstData;
			await pinEntered.promise;
			expect(activePinWasReleased).toBe(false);
			socket.destroy();
			await new Promise<void>((resolve) => socket.once("close", resolve));
			await pinReleased.promise;
			expect(activePinWasReleased).toBe(true);

			let collected = { bytes: 0, items: 0 };
			for (let attempt = 0; attempt < 100 && collected.items === 0; attempt += 1) {
				collected = await store.gc();
				if (collected.items === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			}
			expect(server.listening).toBe(true);
			expect(collected).toEqual({ bytes: bytes.byteLength, items: 1 });
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});
