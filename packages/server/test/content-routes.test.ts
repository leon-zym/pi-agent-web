import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { SESSION_CONTENT_BLOB_MAX_BYTES, type SessionContentRefDto } from "@pi-agent-web/protocol";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayAccessControl } from "../src/access-control.js";
import { createContentRoutes, type Utf8ContentReadStore } from "../src/content-routes.js";
import {
	type EpochContentPin,
	EpochContentStore,
	EpochContentStoreError,
} from "../src/epoch-content-store.js";
import { type AppContext, createApp } from "../src/routes.js";

const EPOCH = "content-route-epoch";
const DIGEST = "a".repeat(64);
const temporaryRoots: string[] = [];

function ref(overrides: Partial<SessionContentRefDto> = {}): SessionContentRefDto {
	return {
		type: "content_ref",
		serverEpoch: EPOCH,
		sha256: DIGEST,
		byteLength: 5,
		encoding: "utf-8",
		...overrides,
	};
}

function pinned(
	stream: Readable = Readable.from([Buffer.from("hello")]),
	contentRef = ref(),
): {
	ref: SessionContentRefDto;
	stream: Readable;
	pin: EpochContentPin<SessionContentRefDto>;
} {
	const pin = Object.freeze({ ref: contentRef });
	return Object.freeze({ ref: contentRef, stream, pin });
}

function storeFor(
	overrides: Partial<Utf8ContentReadStore> = {},
): Utf8ContentReadStore & { pinUtf8ByDigest: ReturnType<typeof vi.fn> } {
	const pinUtf8ByDigest = vi.fn(async () => pinned());
	return {
		pinUtf8ByDigest,
		release: vi.fn(async () => undefined),
		...overrides,
	} as Utf8ContentReadStore & { pinUtf8ByDigest: ReturnType<typeof vi.fn> };
}

function appFor(store: Utf8ContentReadStore): Hono {
	const app = new Hono();
	app.route("/api/v1", createContentRoutes({ contentStore: store, serverEpoch: EPOCH }));
	return app;
}

async function errorCode(response: Response): Promise<string> {
	expect(response.headers.get("cache-control")).toBe("no-store");
	return ((await response.json()) as { error: { code: string } }).error.code;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generic UTF-8 content routes", () => {
	it("streams a published UTF-8 blob with exact non-sniffable response metadata", async () => {
		const store = storeFor();
		const response = await appFor(store).request(`/api/v1/content/${EPOCH}/${DIGEST}`);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
		expect(response.headers.get("content-length")).toBe("5");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-disposition")).toBeNull();
		expect(response.headers.get("content-encoding")).toBeNull();
		expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("hello"));
		expect(store.pinUtf8ByDigest).toHaveBeenCalledWith(DIGEST, { signal: expect.any(AbortSignal) });
		expect(store.release).toHaveBeenCalledTimes(1);
	});

	it("applies epoch, digest, method, and Range checks before namespace pinning", async () => {
		const store = storeFor();
		const app = appFor(store);

		const stale = await app.request(`/api/v1/content/stale/not-a-digest`, { method: "HEAD" });
		expect(stale.status).toBe(410);
		expect(stale.headers.get("cache-control")).toBe("no-store");
		for (const invalidDigest of ["not-a-digest", "A".repeat(64), "..%2Foutside"]) {
			const invalid = await app.request(`/api/v1/content/${EPOCH}/${invalidDigest}`);
			expect(invalid.status).toBe(400);
			expect(await errorCode(invalid)).toBe("invalid_content_digest");
		}
		const head = await app.request(`/api/v1/content/${EPOCH}/${DIGEST}`, { method: "HEAD" });
		expect(head.status).toBe(405);
		expect(head.headers.get("allow")).toBe("GET");
		const ranged = await app.request(`/api/v1/content/${EPOCH}/${DIGEST}`, {
			headers: { Range: "bytes=0-1" },
		});
		expect(ranged.status).toBe(416);
		expect(await errorCode(ranged)).toBe("range_not_supported");
		for (const method of ["PUT", "POST", "PATCH", "DELETE", "OPTIONS"]) {
			const unsupported = await app.request(`/api/v1/content/${EPOCH}/${DIGEST}`, {
				method,
				body: method === "OPTIONS" ? undefined : "must-not-be-read",
			});
			expect(unsupported.status).toBe(405);
			expect(unsupported.headers.get("allow")).toBe("GET");
			expect(unsupported.headers.get("cache-control")).toBe("no-store");
		}
		expect(store.pinUtf8ByDigest).not.toHaveBeenCalled();
	});

	it("maps only current-epoch published UTF-8 content as available", async () => {
		const errors = [
			["not_found", 404, "content_unavailable"],
			["not_published", 404, "content_unavailable"],
			["closed", 503, "content_store_unavailable"],
			["not_initialized", 503, "content_store_unavailable"],
			["manifest_mismatch", 500, "content_io_failure"],
			["unsafe_path", 500, "content_io_failure"],
			["io_failure", 500, "content_io_failure"],
		] as const;
		for (const [code, status, publicCode] of errors) {
			const store = storeFor({
				pinUtf8ByDigest: vi.fn(async () => {
					throw new EpochContentStoreError(code, "private /tmp/content-store path");
				}),
			});
			const response = await appFor(store).request(`/api/v1/content/${EPOCH}/${DIGEST}`);
			expect(response.status).toBe(status);
			expect(await errorCode(response)).toBe(publicCode);
		}
	});

	it("releases and fails closed when the store returns forged UTF-8 metadata", async () => {
		for (const forged of [
			ref({ serverEpoch: "wrong" }),
			ref({ sha256: "b".repeat(64) }),
			ref({ byteLength: SESSION_CONTENT_BLOB_MAX_BYTES + 1 }),
			{ ...ref(), type: "attachment_ref", mediaType: "image/png" },
			{ ...ref(), encoding: "utf-16" },
		]) {
			const released = vi.fn(async () => undefined);
			const store = storeFor({
				pinUtf8ByDigest: vi.fn(async () => pinned(undefined, forged as SessionContentRefDto)),
				release: released,
			});
			const response = await appFor(store).request(`/api/v1/content/${EPOCH}/${DIGEST}`);
			expect(response.status).toBe(500);
			expect(await errorCode(response)).toBe("content_io_failure");
			expect(released).toHaveBeenCalledTimes(1);
		}
	});

	it("releases a download pin exactly once on reader cancellation or stream failure", async () => {
		const stream = new PassThrough();
		stream.write("hello");
		const release = vi.fn(async () => {
			stream.destroy();
		});
		const store = storeFor({
			pinUtf8ByDigest: vi.fn(async () => pinned(stream)),
			release,
		});
		const response = await appFor(store).request(`/api/v1/content/${EPOCH}/${DIGEST}`);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("content response has no body");
		expect(await reader.read()).toMatchObject({ done: false });
		await reader.cancel("cancelled");
		expect(release).toHaveBeenCalledTimes(1);

		const failingStream = new PassThrough();
		const failingRelease = vi.fn(async () => {
			failingStream.destroy();
		});
		const failingStore = storeFor({
			pinUtf8ByDigest: vi.fn(async () => pinned(failingStream)),
			release: failingRelease,
		});
		const failingResponse = await appFor(failingStore).request(`/api/v1/content/${EPOCH}/${DIGEST}`);
		const failedRead = failingResponse.arrayBuffer();
		failingStream.destroy(new Error("private stream failure"));
		await expect(failedRead).rejects.toThrow("Content stream failed");
		expect(failingRelease).toHaveBeenCalledTimes(1);
	});

	it("observes release rejection instead of completing a body or producing an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const store = storeFor({
				release: vi.fn(async () => {
					throw new Error("private release failure");
				}),
			});
			const response = await appFor(store).request(`/api/v1/content/${EPOCH}/${DIGEST}`);
			await expect(response.arrayBuffer()).rejects.toThrow("Content stream failed");
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("passes request abort into the namespace pin and fails closed without abandoning it", async () => {
		let receivedSignal: AbortSignal | undefined;
		const store = storeFor({
			pinUtf8ByDigest: vi.fn(
				async (_digest: string, options?: { signal?: AbortSignal }) =>
					new Promise<never>((_resolve, reject) => {
						receivedSignal = options?.signal;
						options?.signal?.addEventListener(
							"abort",
							() => reject(new EpochContentStoreError("aborted", "private abort")),
							{ once: true },
						);
					}),
			),
		});
		const controller = new AbortController();
		const pending = appFor(store).request(`/api/v1/content/${EPOCH}/${DIGEST}`, {
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(receivedSignal).toBeDefined());
		expect(receivedSignal?.aborted).toBe(false);
		controller.abort();
		const response = await pending;
		expect(response.status).toBe(500);
		expect(await errorCode(response)).toBe("content_io_failure");
		expect(store.release).not.toHaveBeenCalled();
	});

	it("releases a content pin after a real HTTP client aborts the response socket", async () => {
		const stream = new PassThrough();
		stream.write(Buffer.from("hello"));
		let resolveReleased!: () => void;
		const released = new Promise<void>((resolve) => {
			resolveReleased = resolve;
		});
		const store = storeFor({
			pinUtf8ByDigest: vi.fn(async () => pinned(stream)),
			release: vi.fn(async () => {
				stream.destroy();
				resolveReleased();
			}),
		});
		const server = serve({ fetch: appFor(store).fetch, hostname: "127.0.0.1", port: 0 });
		try {
			if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("content test server did not bind");
			const socket = createConnection({ host: "127.0.0.1", port: address.port });
			socket.on("error", () => undefined);
			await new Promise<void>((resolve) => socket.once("connect", resolve));
			const firstData = new Promise<void>((resolve) => socket.once("data", resolve));
			socket.write(
				[
					`GET /api/v1/content/${EPOCH}/${DIGEST} HTTP/1.1`,
					`Host: 127.0.0.1:${String(address.port)}`,
					"Connection: keep-alive",
					"",
					"",
				].join("\r\n"),
			);
			await firstData;
			socket.destroy();
			await released;
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("selects the UTF-8 namespace when raster bytes have the same digest", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-web-content-route-"));
		temporaryRoots.push(root);
		const store = new EpochContentStore({ webDataDir: root, serverEpoch: EPOCH });
		await store.initialize();
		try {
			const bytes = Buffer.from("same");
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const raster = await store.stage({ source: Readable.from([bytes]), mediaType: "image/png" });
			await store.publish(raster.hold);
			await store.release(raster.hold);
			const missing = await appFor(store).request(`/api/v1/content/${EPOCH}/${sha256}`);
			expect(missing.status).toBe(404);

			const generic = await store.stageUtf8({ source: Readable.from([bytes]) });
			await store.publish(generic.hold);
			await store.release(generic.hold);
			const response = await appFor(store).request(`/api/v1/content/${EPOCH}/${sha256}`);
			expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		} finally {
			await store.shutdown();
		}
	});

	it("keeps authorization ahead of path and method disclosure", async () => {
		const store = storeFor();
		const accessControl = createGatewayAccessControl("content-secret");
		const app = createApp({
			accessControl,
			contentStore: store,
			serverEpoch: EPOCH,
			readiness: { ready: true },
		} as unknown as AppContext);
		const response = await app.request(`/api/v1/content/stale/not-a-digest`, { method: "PUT" });
		expect(response.status).toBe(403);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(store.pinUtf8ByDigest).not.toHaveBeenCalled();
	});
});
