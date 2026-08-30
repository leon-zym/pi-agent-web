import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayAccessControl } from "../src/access-control.js";
import { type AttachmentContentStore, createAttachmentRoutes } from "../src/attachment-routes.js";
import { EpochContentStore, EpochContentStoreError } from "../src/epoch-content-store.js";
import { type AppContext, createApp } from "../src/routes.js";

const EPOCH = "route-epoch-a";
const PNG = Buffer.from(
	"89504e470d0a1a0a0000000d4948445200000001000000010806000000000000000000000149444154000000000000000049454e4400000000",
	"hex",
);
const JPEG = Buffer.from("ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9", "hex");
const WEBP = Buffer.concat([
	Buffer.from("RIFF"),
	Buffer.from([22, 0, 0, 0]),
	Buffer.from("WEBPVP8 "),
	Buffer.from([10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]),
]);
const GIF = Buffer.from("474946383961010001000000002c00000000010001000002024401003b", "hex");

function largeWebp(byteLength: number): Buffer {
	const payload = Buffer.alloc(byteLength, 7);
	payload.write("RIFF", 0, "ascii");
	payload.writeUInt32LE(byteLength - 8, 4);
	payload.write("WEBPVP8 ", 8, "ascii");
	payload.writeUInt32LE(byteLength - 20, 16);
	payload.set(Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]), 20);
	return payload;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function appFor(store: AttachmentContentStore): Hono {
	const app = new Hono();
	app.route("/api/v1", createAttachmentRoutes({ contentStore: store, serverEpoch: EPOCH }));
	return app;
}

async function seedAttachment(
	store: EpochContentStore,
	bytes: Uint8Array,
	mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif",
) {
	const staged = await store.stage({ source: Readable.from([bytes]), mediaType });
	await store.publish(staged.hold);
	await store.release(staged.hold);
	return staged.ref;
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
	] as const)("retrieves internally published %s content", async (mediaType, bytes) => {
		const { app, store } = await realApp();
		const ref = await seedAttachment(store, bytes, mediaType);
		const downloaded = await app.request(`/api/v1/attachments/${EPOCH}/${ref.sha256}`);
		expect(downloaded.status).toBe(200);
		expect(downloaded.headers.get("content-type")).toBe(mediaType);
		expect(downloaded.headers.get("content-length")).toBe(String(bytes.byteLength));
		expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
		expect(downloaded.headers.get("content-disposition")).toMatch(/^attachment; filename="[0-9a-f]{64}\./);
		expect(downloaded.headers.get("cache-control")).toBe("no-store");
		expect(downloaded.headers.get("cross-origin-resource-policy")).toBe("same-origin");
		expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
	});

	it("does not expose a public attachment upload ingress", async () => {
		const pinByDigest = vi.fn();
		const release = vi.fn();
		const app = appFor({ pinByDigest, release });
		const response = await app.request(`/api/v1/attachments/${EPOCH}/${"a".repeat(64)}`, {
			method: "PUT",
			headers: { "Content-Type": "image/png" },
			body: PNG,
		});
		expect(response.status).toBe(404);
		expect(pinByDigest).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
	});

	it("rejects stale epoch, invalid digest, traversal, and Range before pinning", async () => {
		const pinByDigest = vi.fn();
		const app = appFor({ pinByDigest, release: vi.fn() });

		const stale = await app.request(`/api/v1/attachments/other/${"a".repeat(64)}`);
		expect(stale.status).toBe(410);
		expect(await stale.json()).toEqual({
			type: "payload_admission_error",
			code: "attachment_ref_epoch_mismatch",
			boundary: "attachment_ref",
		});

		for (const target of [
			`/api/v1/attachments/${EPOCH}/not-a-digest`,
			`/api/v1/attachments/${EPOCH}/..%2Foutside`,
		]) {
			const response = await app.request(target);
			expect(response.status).toBe(400);
		}

		const ranged = await app.request(`/api/v1/attachments/${EPOCH}/${"a".repeat(64)}`, {
			headers: { Range: "bytes=0-1" },
		});
		expect(ranged.status).toBe(416);
		expect(await errorCode(ranged)).toBe("range_not_supported");
		expect(pinByDigest).not.toHaveBeenCalled();
	});

	it("mounts behind auth and rejects HEAD without pinning", async () => {
		const pinByDigest = vi.fn();
		const contentStore = { pinByDigest, release: vi.fn() } satisfies AttachmentContentStore;
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
		const head = await app.request(url, {
			method: "HEAD",
			headers: {
				Host: "127.0.0.1:31415",
				Origin: "http://127.0.0.1:31415",
				Cookie: cookie,
			},
		});
		expect(head.status).toBe(405);
		expect(head.headers.get("allow")).toBe("GET");
		expect(head.headers.get("cache-control")).toBe("no-store");
		expect(pinByDigest).not.toHaveBeenCalled();
	});

	it("returns 404 for unavailable content and releases a managed GET pin on cancellation", async () => {
		const released: unknown[] = [];
		const stream = new PassThrough();
		stream.write(Buffer.from("chunk"));
		const sha256 = "b".repeat(64);
		const pin = Object.freeze({
			ref: {
				type: "attachment_ref" as const,
				serverEpoch: EPOCH,
				sha256,
				mediaType: "image/gif",
				byteLength: 5,
			},
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
		const ref = await seedAttachment(store, bytes, "image/webp");
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
					`GET /api/v1/attachments/${EPOCH}/${ref.sha256} HTTP/1.1`,
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
			expect(server.listening).toBe(true);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});
