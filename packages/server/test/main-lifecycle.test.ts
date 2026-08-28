import { createHash } from "node:crypto";
import fs from "node:fs";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { EpochContentStore } from "../src/epoch-content-store.js";
import { startServer } from "../src/main.js";
import { WorkspacePreferences } from "../src/workspace-preferences.js";

const temporaryRoots: string[] = [];
const fixturePath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");

function webpPayload(byteLength: number, fill: number): Buffer {
	const payload = Buffer.alloc(byteLength, fill);
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

async function authenticatedOrigin(handle: Awaited<ReturnType<typeof startServer>>): Promise<{
	origin: string;
	headers: Record<string, string>;
}> {
	const address = handle.server.address();
	if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
	const origin = `http://127.0.0.1:${String(address.port)}`;
	const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
	const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
	if (!cookie) throw new Error("bootstrap did not issue a cookie");
	return { origin, headers: { Origin: origin, Cookie: cookie } };
}

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-main-lifecycle-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("production server lifecycle", () => {
	it("resolves only after binding and cannot resurrect after an immediate close", async () => {
		const root = temporaryRoot();
		const webDataDir = path.join(root, "web-data");
		const handle = await startServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				agentDir: path.join(root, "agent"),
				sessionRootDir: path.join(root, "sessions"),
				webDataDir,
			},
			piPath: fixturePath,
			handleSignals: false,
		});

		expect(handle.server.listening).toBe(true);
		expect(handle.server.address()).not.toBeNull();
		expect(handle.serverEpoch).toMatch(/^[0-9a-f-]{36}$/);
		expect(handle.contentStore.usage).toEqual({ bytes: 0, items: 0 });
		await handle.close();
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(handle.server.listening).toBe(false);
		expect(handle.server.address()).toBeNull();

		const replacement = new WorkspacePreferences(webDataDir);
		replacement.close();
		const replacementStore = new EpochContentStore({ webDataDir, serverEpoch: "replacement" });
		await replacementStore.initialize();
		await replacementStore.shutdown();
	});

	it("rejects a bind failure and releases every startup resource", async () => {
		const root = temporaryRoot();
		const blocker = createServer();
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen(0, "127.0.0.1", resolve);
		});
		const address = blocker.address();
		if (!address || typeof address === "string") throw new Error("blocker did not bind a TCP port");
		const webDataDir = path.join(root, "web-data");
		try {
			await expect(
				startServer({
					config: {
						port: address.port,
						host: "127.0.0.1",
						agentDir: path.join(root, "agent"),
						sessionRootDir: path.join(root, "sessions"),
						webDataDir,
					},
					piPath: fixturePath,
					handleSignals: false,
				}),
			).rejects.toMatchObject({ code: "EADDRINUSE" });
		} finally {
			await new Promise<void>((resolve, reject) => {
				blocker.close((error) => (error ? reject(error) : resolve()));
			});
		}

		const replacement = new WorkspacePreferences(webDataDir);
		replacement.close();
		const replacementStore = new EpochContentStore({ webDataDir, serverEpoch: "replacement" });
		await replacementStore.initialize();
		await replacementStore.shutdown();
	});

	it("releases preferences after attachment-store initialization and synchronous serve failures", async () => {
		const root = temporaryRoot();
		const webDataDir = path.join(root, "web-data");
		fs.mkdirSync(webDataDir, { recursive: true });
		fs.writeFileSync(path.join(webDataDir, "content"), "unsafe non-directory");
		await expect(
			startServer({
				config: {
					port: 0,
					host: "127.0.0.1",
					agentDir: path.join(root, "agent"),
					sessionRootDir: path.join(root, "sessions"),
					webDataDir,
				},
				piPath: fixturePath,
				handleSignals: false,
			}),
		).rejects.toMatchObject({ code: "unsafe_path" });
		const preferencesAfterInitFailure = new WorkspacePreferences(webDataDir);
		preferencesAfterInitFailure.close();

		fs.rmSync(path.join(webDataDir, "content"), { force: true });
		await expect(
			startServer({
				config: {
					port: -1,
					host: "127.0.0.1",
					agentDir: path.join(root, "agent"),
					sessionRootDir: path.join(root, "sessions"),
					webDataDir,
				},
				piPath: fixturePath,
				handleSignals: false,
			}),
		).rejects.toBeInstanceOf(Error);
		const preferencesAfterServeFailure = new WorkspacePreferences(webDataDir);
		preferencesAfterServeFailure.close();
		const storeAfterServeFailure = new EpochContentStore({ webDataDir, serverEpoch: "replacement" });
		await storeAfterServeFailure.initialize();
		await storeAfterServeFailure.shutdown();
	});

	it("force-closes an active streaming attachment upload within the shutdown bound", async () => {
		const root = temporaryRoot();
		const webDataDir = path.join(root, "web-data");
		const handle = await startServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				agentDir: path.join(root, "agent"),
				sessionRootDir: path.join(root, "sessions"),
				webDataDir,
			},
			piPath: fixturePath,
			handleSignals: false,
		});
		const address = handle.server.address();
		if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
		const origin = `http://127.0.0.1:${String(address.port)}`;
		const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
		const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
		if (!cookie) throw new Error("bootstrap did not issue a cookie");
		const stageEntered = deferred();
		const allowStage = deferred();
		const realStage = handle.contentStore.stage.bind(handle.contentStore);
		handle.contentStore.stage = async (input) => {
			stageEntered.resolve();
			await allowStage.promise;
			return realStage(input);
		};
		const socket = createConnection({ host: "127.0.0.1", port: address.port });
		socket.on("error", () => undefined);
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		await new Promise<void>((resolve, reject) => {
			socket.write(
				[
					`PUT /api/v1/attachments/${handle.serverEpoch}/${"0".repeat(64)} HTTP/1.1`,
					`Host: 127.0.0.1:${String(address.port)}`,
					`Origin: ${origin}`,
					`Cookie: ${cookie}`,
					"Content-Type: image/png",
					`Content-Length: ${String(8 * 1024 * 1024)}`,
					"Connection: keep-alive",
					"",
					"",
				].join("\r\n"),
			);
			socket.write(PNG_HEADER, (error) => (error ? reject(error) : resolve()));
		});
		await stageEntered.promise;
		const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

		const startedAt = Date.now();
		const closing = handle.close();
		allowStage.resolve();
		await closing;
		await socketClosed;
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(socket.destroyed).toBe(true);

		const replacement = new WorkspacePreferences(webDataDir);
		replacement.close();
		const replacementStore = new EpochContentStore({ webDataDir, serverEpoch: "replacement" });
		await replacementStore.initialize();
		await replacementStore.shutdown();
	});

	it("waits for WebSocket and runtime shutdown before releasing preferences", async () => {
		const root = temporaryRoot();
		const webDataDir = path.join(root, "web-data");
		const staticDir = path.join(root, "static");
		fs.mkdirSync(staticDir);
		fs.writeFileSync(path.join(staticDir, "index.html"), "<main>fallback</main>");
		fs.writeFileSync(path.join(staticDir, "asset.txt"), "public asset");
		const privateFile = path.join(root, "private.txt");
		fs.writeFileSync(privateFile, "must not leak");
		fs.symlinkSync(privateFile, path.join(staticDir, "leak.txt"));
		const handle = await startServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				agentDir: path.join(root, "agent"),
				sessionRootDir: path.join(root, "sessions"),
				webDataDir,
			},
			piPath: fixturePath,
			staticDir,
			handleSignals: false,
		});
		const address = handle.server.address();
		if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
		const origin = `http://127.0.0.1:${String(address.port)}`;
		const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
		const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
		if (!cookie) throw new Error("bootstrap did not issue a cookie");
		expect(await (await fetch(`${origin}/asset.txt`)).text()).toBe("public asset");
		expect(await (await fetch(`${origin}/leak.txt`)).text()).toBe("<main>fallback</main>");
		const WebSocketCtor = (await import("ws")).default;
		const socket = new WebSocketCtor(`${origin.replace("http", "ws")}/api/v1/ws`, {
			headers: { Origin: origin, Cookie: cookie },
		});
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		const stopAllEntered = deferred();
		const allowStopAll = deferred();
		const storeShutdownEntered = deferred();
		const allowStoreShutdown = deferred();
		let storeShutdownStarted = false;
		const realStopAll = handle.supervisor.stopAll.bind(handle.supervisor);
		handle.supervisor.stopAll = async () => {
			stopAllEntered.resolve();
			await allowStopAll.promise;
			return realStopAll();
		};
		const realStoreShutdown = handle.contentStore.shutdown.bind(handle.contentStore);
		handle.contentStore.shutdown = async () => {
			storeShutdownStarted = true;
			storeShutdownEntered.resolve();
			expect(handle.supervisor.listRuntimes()).toEqual([]);
			await allowStoreShutdown.promise;
			return realStoreShutdown();
		};

		const firstClose = handle.close();
		expect(handle.close()).toBe(firstClose);
		await stopAllEntered.promise;
		expect(storeShutdownStarted).toBe(false);
		allowStopAll.resolve();
		await storeShutdownEntered.promise;
		expect(() => new WorkspacePreferences(webDataDir)).toThrow();
		allowStoreShutdown.resolve();
		await firstClose;
		await socketClosed;
		expect(handle.server.listening).toBe(false);
		expect(handle.supervisor.listRuntimes()).toEqual([]);

		const replacement = new WorkspacePreferences(webDataDir);
		replacement.close();
		const replacementStore = new EpochContentStore({ webDataDir, serverEpoch: "replacement" });
		await replacementStore.initialize();
		await replacementStore.shutdown();
	});

	it("uses one canonical webDataDir and epoch for authenticated attachment traffic and cancellation", async () => {
		const root = temporaryRoot();
		const canonicalWebDataDir = path.join(root, "web-data");
		const relativeWebDataDir = path.relative(process.cwd(), canonicalWebDataDir);
		const handle = await startServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				agentDir: path.join(root, "agent"),
				sessionRootDir: path.join(root, "sessions"),
				webDataDir: relativeWebDataDir,
			},
			piPath: fixturePath,
			handleSignals: false,
		});
		try {
			expect(handle.config.webDataDir).toBe(canonicalWebDataDir);
			const { origin, headers } = await authenticatedOrigin(handle);
			const bytes = webpPayload(256 * 1024, 7);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const uploaded = await fetch(`${origin}/api/v1/attachments/${handle.serverEpoch}/${sha256}`, {
				method: "PUT",
				headers: {
					...headers,
					"Content-Type": "image/webp",
				},
				body: bytes,
			});
			expect(uploaded.status).toBe(201);
			const stale = await fetch(`${origin}/api/v1/attachments/old-epoch/${sha256}`, { headers });
			expect(stale.status).toBe(410);

			const downloaded = await fetch(`${origin}/api/v1/attachments/${handle.serverEpoch}/${sha256}`, {
				headers,
			});
			const reader = downloaded.body?.getReader();
			if (!reader) throw new Error("attachment GET did not expose a body");
			await reader.read();
			await reader.cancel("integration cancellation");
			let collected = { bytes: 0, items: 0 };
			for (let attempt = 0; attempt < 20 && collected.bytes === 0; attempt += 1) {
				collected = await handle.contentStore.gc();
				if (collected.bytes === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			}
			expect(collected).toEqual({ bytes: bytes.byteLength, items: 1 });

			const largeBytes = webpPayload(8 * 1024 * 1024, 9);
			const largeDigest = createHash("sha256").update(largeBytes).digest("hex");
			const largeUpload = await fetch(`${origin}/api/v1/attachments/${handle.serverEpoch}/${largeDigest}`, {
				method: "PUT",
				headers: {
					...headers,
					"Content-Type": "image/webp",
				},
				body: largeBytes,
			});
			expect(largeUpload.status).toBe(201);
			const pinEntered = deferred();
			const pinReleased = deferred();
			let activePin: Awaited<ReturnType<typeof handle.contentStore.pinByDigest>>["pin"] | undefined;
			let activePinWasReleased = false;
			const realPinByDigest = handle.contentStore.pinByDigest.bind(handle.contentStore);
			const realRelease = handle.contentStore.release.bind(handle.contentStore);
			handle.contentStore.pinByDigest = async (...args) => {
				const pinned = await realPinByDigest(...args);
				activePin = pinned.pin;
				pinEntered.resolve();
				return pinned;
			};
			handle.contentStore.release = async (resource) => {
				if (resource === activePin) {
					activePinWasReleased = true;
					pinReleased.resolve();
				}
				return realRelease(resource);
			};
			const address = handle.server.address();
			if (!address || typeof address === "string") throw new Error("server address disappeared");
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
					`GET /api/v1/attachments/${handle.serverEpoch}/${largeDigest} HTTP/1.1`,
					`Host: 127.0.0.1:${String(address.port)}`,
					`Origin: ${origin}`,
					`Cookie: ${headers.Cookie}`,
					"Connection: keep-alive",
					"",
					"",
				].join("\r\n"),
			);
			await firstData;
			await pinEntered.promise;
			expect(activePinWasReleased).toBe(false);
			const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
			const startedAt = Date.now();
			await handle.close();
			await pinReleased.promise;
			expect(activePinWasReleased).toBe(true);
			socket.resume();
			await socketClosed;
			expect(Date.now() - startedAt).toBeLessThan(1_000);
		} finally {
			await handle.close();
		}
	});

	it("serves directly seeded UTF-8 content from the production store without enabling uploads", async () => {
		const root = temporaryRoot();
		const handle = await startServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				agentDir: path.join(root, "agent"),
				sessionRootDir: path.join(root, "sessions"),
				webDataDir: path.join(root, "web-data"),
			},
			piPath: fixturePath,
			handleSignals: false,
		});
		try {
			const { origin, headers } = await authenticatedOrigin(handle);
			const bytes = Buffer.from('{"generic":"content"}');
			const staged = await handle.contentStore.stageUtf8({
				source: Readable.from([bytes]),
				expectedByteLength: bytes.byteLength,
			});
			await handle.contentStore.publish(staged.hold);
			await handle.contentStore.release(staged.hold);

			const downloaded = await fetch(`${origin}/api/v1/content/${handle.serverEpoch}/${staged.ref.sha256}`, {
				headers,
			});
			expect(downloaded.status).toBe(200);
			expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
			expect(downloaded.headers.get("content-length")).toBe(String(bytes.byteLength));
			expect(downloaded.headers.get("cache-control")).toBe("no-store");
			expect(downloaded.headers.get("cross-origin-resource-policy")).toBe("same-origin");
			expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
			expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);

			const stale = await fetch(`${origin}/api/v1/content/old-epoch/${staged.ref.sha256}`, {
				headers,
			});
			expect(stale.status).toBe(410);
			const put = await fetch(`${origin}/api/v1/content/${handle.serverEpoch}/${staged.ref.sha256}`, {
				method: "PUT",
				headers,
				body: "browser upload is forbidden",
			});
			expect(put.status).toBe(405);
			expect(put.headers.get("allow")).toBe("GET");

			let collected = { bytes: 0, items: 0 };
			for (let attempt = 0; attempt < 20 && collected.items === 0; attempt += 1) {
				collected = await handle.contentStore.gc();
				if (collected.items === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			}
			expect(collected).toEqual({ bytes: bytes.byteLength, items: 1 });
		} finally {
			await handle.close();
		}
	});

	it("continues shutdown through a content-store lock failure and releases preferences", async () => {
		const root = temporaryRoot();
		const webDataDir = path.join(root, "web-data");
		const handle = await startServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				agentDir: path.join(root, "agent"),
				sessionRootDir: path.join(root, "sessions"),
				webDataDir,
			},
			piPath: fixturePath,
			handleSignals: false,
		});
		const realStoreShutdown = handle.contentStore.shutdown.bind(handle.contentStore);
		const shutdownEntered = deferred();
		const failShutdown = deferred();
		handle.contentStore.shutdown = async () => {
			shutdownEntered.resolve();
			await failShutdown.promise;
			throw new Error("injected store shutdown failure");
		};
		const firstClose = handle.close();
		expect(handle.close()).toBe(firstClose);
		await shutdownEntered.promise;
		expect(() => new WorkspacePreferences(webDataDir)).toThrow();
		failShutdown.resolve();
		await expect(firstClose).rejects.toBeInstanceOf(AggregateError);
		const replacementPreferences = new WorkspacePreferences(webDataDir);
		replacementPreferences.close();
		await realStoreShutdown();
		const replacementStore = new EpochContentStore({ webDataDir, serverEpoch: "replacement" });
		await replacementStore.initialize();
		await replacementStore.shutdown();
	});
});
