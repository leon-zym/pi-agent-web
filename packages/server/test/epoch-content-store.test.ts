import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type EpochContentPutInput,
	EpochContentStore,
	EpochContentStoreError,
	type EpochContentStoreLimits,
	type EpochUtf8ContentPutInput,
	type SessionAttachmentRefDto,
	type SessionContentRefDto,
} from "../src/epoch-content-store.js";

const epochKey = (epoch: string): string => createHash("sha256").update(epoch).digest("hex");
const digestOf = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function storePaths(webDataDir: string, epoch: string) {
	const storeRoot = path.join(webDataDir, "content", "attachments", "v1");
	const epochRoot = path.join(storeRoot, "epochs", epochKey(epoch));
	return {
		storeRoot,
		epochRoot,
		blobsRoot: path.join(epochRoot, "blobs"),
		utf8Root: path.join(epochRoot, "utf8"),
		blobDirectory(digest: string) {
			return path.join(epochRoot, "blobs", digest);
		},
		blobPath(digest: string) {
			return path.join(epochRoot, "blobs", digest, "content");
		},
		manifestPath(digest: string) {
			return path.join(epochRoot, "blobs", digest, "manifest.json");
		},
		utf8Directory(digest: string) {
			return path.join(epochRoot, "utf8", digest);
		},
		utf8BlobPath(digest: string) {
			return path.join(epochRoot, "utf8", digest, "content");
		},
		utf8ManifestPath(digest: string) {
			return path.join(epochRoot, "utf8", digest, "manifest.json");
		},
	};
}

function source(value: string | Buffer): Readable {
	return Readable.from([value]);
}

async function readStream(readable: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks);
}

async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const child = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(child)));
		else files.push(child);
	}
	return files;
}

describe("EpochContentStore", () => {
	let webDataDir: string;
	const stores: EpochContentStore[] = [];

	beforeEach(async () => {
		webDataDir = await mkdtemp(path.join(tmpdir(), "pi-web-epoch-content-"));
	});

	afterEach(async () => {
		await Promise.allSettled(stores.map((store) => store.shutdown()));
		await rm(webDataDir, { recursive: true, force: true });
	});

	async function createStore(
		epoch = "epoch-a",
		limits: Partial<EpochContentStoreLimits> = {},
		options: ConstructorParameters<typeof EpochContentStore>[0] = { webDataDir, serverEpoch: epoch },
	): Promise<EpochContentStore> {
		const store = new EpochContentStore({ ...options, webDataDir, serverEpoch: epoch, limits });
		stores.push(store);
		await store.initialize();
		return store;
	}

	async function publishContent(
		store: EpochContentStore,
		input: EpochContentPutInput,
	): Promise<SessionAttachmentRefDto> {
		const staged = await store.stage(input);
		await store.publish(staged.hold);
		await store.release(staged.hold);
		return staged.ref;
	}

	async function readContent(store: EpochContentStore, ref: SessionAttachmentRefDto): Promise<Buffer> {
		const pinned = await store.pin(ref);
		try {
			return await readStream(pinned.stream);
		} finally {
			await store.release(pinned.pin);
		}
	}

	async function publishUtf8(
		store: EpochContentStore,
		input: EpochUtf8ContentPutInput,
	): Promise<SessionContentRefDto> {
		const staged = await store.stageUtf8(input);
		await store.publish(staged.hold);
		await store.release(staged.hold);
		return staged.ref;
	}

	async function readUtf8(store: EpochContentStore, ref: SessionContentRefDto): Promise<Buffer> {
		const pinned = await store.pinUtf8(ref);
		try {
			return await readStream(pinned.stream);
		} finally {
			await store.release(pinned.pin);
		}
	}

	it("deduplicates generic UTF-8 bytes without binding text or JSON semantics into the manifest", async () => {
		const epoch = "epoch-utf8-dedupe";
		const store = await createStore(epoch);
		const [first, duplicate] = await Promise.all([
			store.stageUtf8({ source: source('{"answer":42}'), expectedByteLength: 13 }),
			store.stageUtf8({ source: source('{"answer":42}'), expectedByteLength: 13 }),
		]);

		expect([first.created, duplicate.created].sort()).toEqual([false, true]);
		expect(duplicate.ref).toBe(first.ref);
		expect(first.ref).toEqual({
			type: "content_ref",
			serverEpoch: epoch,
			sha256: digestOf('{"answer":42}'),
			byteLength: 13,
			encoding: "utf-8",
		});
		expect(store.usage).toEqual({ bytes: 13, items: 1 });

		await store.publish(first.hold);
		await store.publish(duplicate.hold);
		await store.release(first.hold);
		await store.release(duplicate.hold);
		const paths = storePaths(webDataDir, epoch);
		expect(JSON.parse(await readFile(paths.utf8ManifestPath(first.ref.sha256), "utf8"))).toEqual({
			version: 1,
			published: true,
			namespace: "utf8",
			serverEpoch: epoch,
			sha256: first.ref.sha256,
			byteLength: first.ref.byteLength,
			encoding: "utf-8",
		});
		await expect(readUtf8(store, first.ref)).resolves.toEqual(Buffer.from('{"answer":42}'));
		const pinnedByDigest = await store.pinUtf8ByDigest(first.ref.sha256);
		expect(pinnedByDigest.ref).toBe(first.ref);
		await expect(readStream(pinnedByDigest.stream)).resolves.toEqual(Buffer.from('{"answer":42}'));
		await store.release(pinnedByDigest.pin);
	});

	it("isolates identical generic and raster bytes while charging one combined quota", async () => {
		const epoch = "epoch-namespace-isolation";
		const store = await createStore(epoch, {
			maxBlobBytes: 4,
			maxContentBlobBytes: 4,
			maxCacheBytes: 8,
			maxCacheItems: 2,
		});
		const raster = await publishContent(store, { source: source("same"), mediaType: "image/png" });
		const generic = await publishUtf8(store, { source: source("same") });

		expect(generic.sha256).toBe(raster.sha256);
		expect(store.usage).toEqual({ bytes: 8, items: 2 });
		const paths = storePaths(webDataDir, epoch);
		await expect(access(paths.blobPath(raster.sha256))).resolves.toBeUndefined();
		await expect(access(paths.utf8BlobPath(generic.sha256))).resolves.toBeUndefined();
		await expect(readContent(store, raster)).resolves.toEqual(Buffer.from("same"));
		await expect(readUtf8(store, generic)).resolves.toEqual(Buffer.from("same"));
		await expect(store.stageUtf8({ source: source("x"), expectedByteLength: 1 })).rejects.toMatchObject({
			code: "cache_bytes_exhausted",
		});
		await store.shutdown();

		const itemStore = await createStore("epoch-namespace-item-quota", {
			maxBlobBytes: 4,
			maxContentBlobBytes: 4,
			maxCacheBytes: 8,
			maxCacheItems: 1,
		});
		await publishContent(itemStore, { source: source("a"), mediaType: "image/png" });
		await expect(itemStore.stageUtf8({ source: source("b"), expectedByteLength: 1 })).rejects.toMatchObject({
			code: "cache_items_exhausted",
		});
	});

	it("keeps the raster and generic blob ceilings independent", async () => {
		const store = await createStore("epoch-independent-limits");
		await expect(
			store.stage({
				source: source("x"),
				mediaType: "image/png",
				expectedByteLength: 8 * 1024 * 1024,
			}),
		).rejects.toMatchObject({ code: "declared_length_mismatch" });
		await expect(
			store.stage({
				source: source("x"),
				mediaType: "image/png",
				expectedByteLength: 8 * 1024 * 1024 + 1,
			}),
		).rejects.toMatchObject({ code: "invalid_ref" });
		await expect(
			store.stageUtf8({ source: source("x"), expectedByteLength: 48 * 1024 * 1024 }),
		).rejects.toMatchObject({ code: "declared_length_mismatch" });
		await expect(
			store.stageUtf8({ source: source("x"), expectedByteLength: 48 * 1024 * 1024 + 1 }),
		).rejects.toMatchObject({ code: "invalid_ref" });
	});

	it("shares reservation and item admission atomically across namespaces", async () => {
		const store = await createStore("epoch-combined-reservation", {
			maxBlobBytes: 4,
			maxContentBlobBytes: 4,
			maxCacheBytes: 4,
			maxCacheItems: 1,
		});
		const controller = new AbortController();
		const pendingSource = new PassThrough();
		const pending = store.stageUtf8({
			source: pendingSource,
			expectedByteLength: 4,
			signal: controller.signal,
		});
		await expect(
			store.stage({ source: source("x"), mediaType: "image/png", expectedByteLength: 1 }),
		).rejects.toMatchObject({ code: "cache_bytes_exhausted" });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
	});

	it("retains generic holds through restart and collects utf8 orphans and released content", async () => {
		const epoch = "epoch-utf8-lifecycle";
		const store = await createStore(epoch);
		const ref = await publishUtf8(store, { source: source("persistent") });
		const hold = await store.holdPublishedUtf8(ref);
		expect(await store.gc()).toEqual({ bytes: 0, items: 0 });
		await store.release(hold);
		await store.shutdown();

		const paths = storePaths(webDataDir, epoch);
		await writeFile(path.join(paths.utf8Root, ".tmp-00000000-0000-4000-8000-000000000000"), "orphan", {
			mode: 0o600,
		});
		const incompleteDigest = digestOf("incomplete");
		await mkdir(paths.utf8Directory(incompleteDigest), { mode: 0o700 });
		await writeFile(paths.utf8BlobPath(incompleteDigest), "incomplete", { mode: 0o600 });
		const reopened = await createStore(epoch);
		expect(reopened.usage).toEqual({ bytes: ref.byteLength, items: 1 });
		await expect(readUtf8(reopened, ref)).resolves.toEqual(Buffer.from("persistent"));
		expect(await readdir(paths.utf8Root)).toEqual([ref.sha256]);
		expect(await reopened.gc()).toEqual({ bytes: ref.byteLength, items: 1 });
		expect(reopened.usage).toEqual({ bytes: 0, items: 0 });
	});

	it("rejects cross-namespace refs and generic manifest semantic or intrinsic substitution", async () => {
		const epoch = "epoch-utf8-manifest";
		const store = await createStore(epoch);
		const raster = await publishContent(store, { source: source("raster"), mediaType: "image/png" });
		const generic = await publishUtf8(store, { source: source("generic") });
		await expect(store.pinUtf8(raster as unknown as SessionContentRefDto)).rejects.toMatchObject({
			code: "invalid_ref",
		});
		await expect(store.pin(generic as unknown as SessionAttachmentRefDto)).rejects.toMatchObject({
			code: "invalid_ref",
		});
		await store.shutdown();

		const paths = storePaths(webDataDir, epoch);
		const manifest = JSON.parse(await readFile(paths.utf8ManifestPath(generic.sha256), "utf8"));
		const { namespace: _namespace, ...missingNamespace } = manifest;
		await writeFile(paths.utf8ManifestPath(generic.sha256), JSON.stringify(missingNamespace));
		const semanticSubstitution = new EpochContentStore({ webDataDir, serverEpoch: epoch });
		stores.push(semanticSubstitution);
		await expect(semanticSubstitution.initialize()).rejects.toMatchObject({ code: "unsafe_layout" });

		await writeFile(
			paths.utf8ManifestPath(generic.sha256),
			JSON.stringify({ ...manifest, semanticKind: "json" }),
		);
		await expect(semanticSubstitution.initialize()).rejects.toMatchObject({ code: "unsafe_layout" });

		await writeFile(
			paths.utf8ManifestPath(generic.sha256),
			JSON.stringify({ ...manifest, namespace: "attachment" }),
		);
		await expect(semanticSubstitution.initialize()).rejects.toMatchObject({ code: "unsafe_layout" });

		await writeFile(
			paths.utf8ManifestPath(generic.sha256),
			JSON.stringify({ ...manifest, byteLength: generic.byteLength + 1 }),
		);
		await expect(semanticSubstitution.initialize()).rejects.toMatchObject({ code: "unsafe_layout" });
	});

	it("does not leak generic holds or pins when a live manifest loses its namespace provenance", async () => {
		const epoch = "epoch-utf8-live-namespace";
		const store = await createStore(epoch);
		const generic = await publishUtf8(store, { source: source("collect-after-tamper") });
		const paths = storePaths(webDataDir, epoch);
		const manifest = JSON.parse(await readFile(paths.utf8ManifestPath(generic.sha256), "utf8"));
		const { namespace: _namespace, ...missingNamespace } = manifest;

		await writeFile(paths.utf8ManifestPath(generic.sha256), JSON.stringify(missingNamespace));
		await expect(store.holdPublishedUtf8(generic)).rejects.toMatchObject({ code: "manifest_mismatch" });
		await writeFile(
			paths.utf8ManifestPath(generic.sha256),
			JSON.stringify({ ...manifest, namespace: "attachment" }),
		);
		await expect(store.pinUtf8(generic)).rejects.toMatchObject({ code: "manifest_mismatch" });

		await writeFile(paths.utf8ManifestPath(generic.sha256), JSON.stringify(manifest));
		expect(await store.gc()).toEqual({ bytes: generic.byteLength, items: 1 });
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
	});

	it("accepts blobs below and at the per-blob limit and rejects the first byte above it", async () => {
		const store = await createStore("epoch-a", {
			maxBlobBytes: 4,
			maxCacheBytes: 16,
			maxCacheItems: 4,
		});

		await expect(
			publishContent(store, { source: source("abc"), mediaType: "text/plain" }),
		).resolves.toMatchObject({
			byteLength: 3,
		});
		await expect(
			publishContent(store, { source: source("wxyz"), mediaType: "text/plain" }),
		).resolves.toMatchObject({
			byteLength: 4,
		});
		await expect(
			publishContent(store, { source: source("12345"), mediaType: "text/plain" }),
		).rejects.toMatchObject({
			code: "blob_too_large",
			limit: 4,
			actual: 5,
		});
		expect(store.usage).toEqual({ bytes: 7, items: 2 });
	});

	it("enforces cache byte and item limits while accounting duplicate content only once", async () => {
		const byteStore = await createStore("epoch-bytes", {
			maxBlobBytes: 4,
			maxCacheBytes: 4,
			maxCacheItems: 3,
		});
		const ref = await publishContent(byteStore, {
			source: source("ab"),
			mediaType: "text/plain",
			expectedByteLength: 2,
		});
		await expect(
			publishContent(byteStore, { source: source("ab"), mediaType: "text/plain", expectedByteLength: 2 }),
		).resolves.toEqual(ref);
		await publishContent(byteStore, { source: source("cd"), mediaType: "text/plain", expectedByteLength: 2 });
		await expect(
			publishContent(byteStore, { source: source("e"), mediaType: "text/plain", expectedByteLength: 1 }),
		).rejects.toMatchObject({
			code: "cache_bytes_exhausted",
		});
		expect(byteStore.usage).toEqual({ bytes: 4, items: 2 });
		await byteStore.shutdown();

		const itemStore = await createStore("epoch-items", {
			maxBlobBytes: 4,
			maxCacheBytes: 12,
			maxCacheItems: 2,
		});
		await publishContent(itemStore, { source: source("a"), mediaType: "text/plain" });
		await publishContent(itemStore, { source: source("b"), mediaType: "text/plain" });
		await expect(
			publishContent(itemStore, { source: source("c"), mediaType: "text/plain" }),
		).rejects.toMatchObject({
			code: "cache_items_exhausted",
		});
		expect(itemStore.usage).toEqual({ bytes: 2, items: 2 });
	});

	it("atomically admits competing quota reservations and rolls failed commits back", async () => {
		const store = await createStore("epoch-race", {
			maxBlobBytes: 3,
			maxCacheBytes: 3,
			maxCacheItems: 2,
		});
		const raced = await Promise.allSettled([
			publishContent(store, { source: source("one"), mediaType: "text/plain", expectedByteLength: 3 }),
			publishContent(store, { source: source("two"), mediaType: "text/plain", expectedByteLength: 3 }),
		]);
		expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(store.usage).toEqual({ bytes: 3, items: 1 });
		await store.gc();
		await store.shutdown();

		let failRename = true;
		const rollbackStore = await createStore(
			"epoch-race",
			{ maxBlobBytes: 3, maxCacheBytes: 3, maxCacheItems: 1 },
			{
				webDataDir,
				serverEpoch: "epoch-race",
				async rename(from, to) {
					if (failRename) {
						failRename = false;
						throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
					}
					const { rename } = await import("node:fs/promises");
					await rename(from, to);
				},
			},
		);
		await expect(
			publishContent(rollbackStore, { source: source("bad"), mediaType: "text/plain" }),
		).rejects.toMatchObject({ code: "io_failure", message: "Content store operation failed" });
		expect(rollbackStore.usage).toEqual({ bytes: 0, items: 0 });
		await expect(
			publishContent(rollbackStore, {
				source: source("new"),
				mediaType: "text/plain",
				expectedByteLength: 3,
			}),
		).resolves.toMatchObject({ byteLength: 3 });
		expect(rollbackStore.usage).toEqual({ bytes: 3, items: 1 });
	});

	it("deduplicates concurrent identical streams and performs the final rename beside the content", async () => {
		const renames: Array<[string, string]> = [];
		const { rename } = await import("node:fs/promises");
		const store = await createStore(
			"epoch-dedupe",
			{ maxBlobBytes: 8, maxCacheBytes: 8, maxCacheItems: 2 },
			{
				webDataDir,
				serverEpoch: "epoch-dedupe",
				async rename(from, to) {
					renames.push([from, to]);
					await rename(from, to);
				},
			},
		);

		const [first, second] = await Promise.all([
			publishContent(store, { source: source("same"), mediaType: "text/plain", expectedByteLength: 4 }),
			publishContent(store, { source: source("same"), mediaType: "text/plain", expectedByteLength: 4 }),
		]);
		expect(second).toEqual(first);
		expect(store.usage).toEqual({ bytes: 4, items: 1 });
		const files = await listFiles(storePaths(webDataDir, "epoch-dedupe").blobsRoot);
		expect(files.filter((file) => path.basename(file) === "content")).toHaveLength(1);
		expect(files.filter((file) => path.basename(file) === "manifest.json")).toHaveLength(1);
		expect(
			renames.some(
				([from, to]) =>
					path.dirname(from) === path.dirname(to) &&
					path.basename(from).startsWith(".tmp-") &&
					path.basename(to) === "content",
			),
		).toBe(true);
	});

	it("streams content back only for a strict reference in the current epoch", async () => {
		const store = await createStore();
		const ref = await publishContent(store, { source: source("payload"), mediaType: "text/plain" });
		await expect(readContent(store, ref)).resolves.toEqual(Buffer.from("payload"));
		await expect(store.pin({ ...ref, serverEpoch: "epoch-b" })).rejects.toMatchObject({
			code: "epoch_mismatch",
		});
		await expect(store.pin({ ...ref, sha256: "A".repeat(64) })).rejects.toMatchObject({
			code: "invalid_ref",
		});
		await expect(store.pin({ ...ref, sha256: "../outside" })).rejects.toMatchObject({
			code: "invalid_ref",
		});
	});

	it("aborts active writes and removes temporary files on caller abort and shutdown", async () => {
		const store = await createStore("epoch-abort", {
			maxBlobBytes: 16,
			maxCacheBytes: 16,
			maxCacheItems: 2,
		});
		const blocked = new PassThrough();
		const controller = new AbortController();
		const pending = store.stage({
			mediaType: "text/plain",
			signal: controller.signal,
			source: blocked,
		});
		blocked.write("a");
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		await expect(pending).rejects.toSatisfy((error: unknown) => error instanceof Error);
		expect(
			(await listFiles(storePaths(webDataDir, "epoch-abort").blobsRoot)).filter((file) =>
				file.includes(".tmp-"),
			),
		).toEqual([]);

		const shutdownSource = new PassThrough();
		const duringShutdown = store.stage({
			mediaType: "text/plain",
			source: shutdownSource,
		});
		shutdownSource.write("c");
		await new Promise((resolve) => setImmediate(resolve));
		await store.shutdown();
		await expect(duringShutdown).rejects.toSatisfy((error: unknown) => error instanceof Error);
		expect(
			(await listFiles(storePaths(webDataDir, "epoch-abort").blobsRoot)).filter((file) =>
				file.includes(".tmp-"),
			),
		).toEqual([]);
	});

	it("does not publish a stage whose commit loses the shutdown race", async () => {
		let renameEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			renameEntered = resolve;
		});
		let allowRename!: () => void;
		const renameGate = new Promise<void>((resolve) => {
			allowRename = resolve;
		});
		let firstRename = true;
		const { rename } = await import("node:fs/promises");
		const store = await createStore(
			"epoch-shutdown-commit",
			{},
			{
				webDataDir,
				serverEpoch: "epoch-shutdown-commit",
				async rename(from, to) {
					if (firstRename) {
						firstRename = false;
						renameEntered();
						await renameGate;
					}
					await rename(from, to);
				},
			},
		);
		const staging = store.stage({ source: source("shutdown"), mediaType: "text/plain" });
		await entered;
		const shutdown = store.shutdown();
		allowRename();
		await expect(staging).rejects.toMatchObject({ code: "aborted" });
		await shutdown;
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
	});

	it("cleans stale temporary files and prior epoch directories during initialization", async () => {
		const oldStore = await createStore("old-epoch");
		await publishContent(oldStore, { source: source("old"), mediaType: "text/plain" });
		await oldStore.shutdown();
		const oldPaths = storePaths(webDataDir, "old-epoch");
		await writeFile(path.join(oldPaths.blobsRoot, ".tmp-stale"), "partial", { mode: 0o600 });

		const currentStore = await createStore("current-epoch");
		await expect(access(oldPaths.epochRoot, fsConstants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(storePaths(webDataDir, "current-epoch").blobsRoot)).toEqual([]);
		expect(currentStore.usage).toEqual({ bytes: 0, items: 0 });
	});

	it("cleans an interrupted blob tombstone without treating it as content", async () => {
		const epoch = "epoch-blob-tombstone";
		const store = await createStore(epoch);
		await store.shutdown();
		const tombstone = path.join(
			storePaths(webDataDir, epoch).blobsRoot,
			".tombstone-00000000-0000-4000-8000-000000000000",
		);
		await mkdir(tombstone, { mode: 0o700 });
		await writeFile(path.join(tombstone, "partial"), "orphan", { mode: 0o600 });
		const reopened = await createStore(epoch);
		expect(reopened.usage).toEqual({ bytes: 0, items: 0 });
		await expect(access(tombstone, fsConstants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes a crash-interrupted unpublished digest directory before rebuilding the ledger", async () => {
		const epoch = "epoch-incomplete-digest";
		const store = await createStore(epoch);
		await store.shutdown();
		const digest = digestOf("partial-content");
		const paths = storePaths(webDataDir, epoch);
		await mkdir(paths.blobDirectory(digest), { mode: 0o700 });
		await writeFile(paths.blobPath(digest), "partial-content", { mode: 0o600 });

		const reopened = await createStore(epoch);
		expect(reopened.usage).toEqual({ bytes: 0, items: 0 });
		await expect(access(paths.blobDirectory(digest), fsConstants.F_OK)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("fails closed on digest collisions, symlink substitution, and malformed on-disk paths", async () => {
		const collisionStore = await createStore("epoch-collision");
		const collisionDigest = digestOf("good");
		const collisionPaths = storePaths(webDataDir, "epoch-collision");
		await mkdir(collisionPaths.blobDirectory(collisionDigest), { mode: 0o700 });
		await writeFile(collisionPaths.blobPath(collisionDigest), "evil", { mode: 0o600 });
		await expect(
			publishContent(collisionStore, { source: source("good"), mediaType: "text/plain" }),
		).rejects.toMatchObject({ code: "digest_collision" });
		expect(await readFile(collisionPaths.blobPath(collisionDigest), "utf8")).toBe("evil");

		const ref = await publishContent(collisionStore, { source: source("safe"), mediaType: "text/plain" });
		const safePath = collisionPaths.blobPath(ref.sha256);
		await rm(safePath);
		await symlink(path.join(webDataDir, "outside"), safePath);
		await expect(collisionStore.pin(ref)).rejects.toMatchObject({ code: "unsafe_path" });

		await rm(safePath);
		await writeFile(safePath, "safe", { mode: 0o600 });
		await collisionStore.shutdown();
		await writeFile(path.join(collisionPaths.blobsRoot, "not-a-digest"), "unexpected");
		const reopened = new EpochContentStore({ webDataDir, serverEpoch: "epoch-collision" });
		stores.push(reopened);
		await expect(reopened.initialize()).rejects.toMatchObject({ code: "unsafe_layout" });
	});

	it("reserves declared or worst-case capacity before consuming a stream and releases it on mismatch", async () => {
		const store = await createStore("epoch-reserve", {
			maxBlobBytes: 4,
			maxCacheBytes: 4,
			maxCacheItems: 2,
		});
		const held = new PassThrough();
		const pending = store.stage({
			source: held,
			mediaType: "text/plain",
			expectedByteLength: 4,
		});
		await expect(
			store.stage({ source: source("x"), mediaType: "text/plain", expectedByteLength: 1 }),
		).rejects.toMatchObject({ code: "cache_bytes_exhausted" });
		held.destroy(new Error("cancel held upload"));
		await expect(pending).rejects.toMatchObject({ code: "io_failure" });

		await expect(
			store.stage({
				source: source("abc"),
				mediaType: "text/plain",
				expectedByteLength: 2,
			}),
		).rejects.toMatchObject({ code: "declared_length_mismatch" });
		await expect(
			store.stage({
				source: source("abc"),
				mediaType: "text/plain",
				expectedByteLength: 3,
				expectedSha256: "0".repeat(64),
			}),
		).rejects.toMatchObject({ code: "declared_digest_mismatch" });
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
		await expect(
			publishContent(store, { source: source("done"), mediaType: "text/plain", expectedByteLength: 4 }),
		).resolves.toMatchObject({ byteLength: 4 });
	});

	it("owns and settles a valid source before a cache-full admission failure", async () => {
		const store = await createStore("epoch-admission-source", {
			maxBlobBytes: 1,
			maxCacheBytes: 1,
			maxCacheItems: 1,
		});
		await publishContent(store, {
			source: source("a"),
			mediaType: "text/plain",
			expectedByteLength: 1,
		});
		const rejectedSource = new PassThrough();
		await expect(
			store.stage({
				source: rejectedSource,
				mediaType: "text/plain",
				expectedByteLength: 1,
			}),
		).rejects.toMatchObject({ code: "cache_bytes_exhausted" });
		const sourceWasDestroyedByAdmission = rejectedSource.destroyed;
		rejectedSource.destroy(new Error("late-source"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(sourceWasDestroyedByAdmission).toBe(true);
		expect(store.usage).toEqual({ bytes: 1, items: 1 });

		expect(await store.gc()).toEqual({ bytes: 1, items: 1 });
		await expect(
			publishContent(store, {
				source: source("b"),
				mediaType: "text/plain",
				expectedByteLength: 1,
			}),
		).resolves.toMatchObject({ byteLength: 1 });
	});

	it("holds an exclusive lifecycle lock and rebuilds the same epoch only after release", async () => {
		const first = await createStore("epoch-lock");
		const ref = await publishContent(first, { source: source("locked"), mediaType: "text/plain" });
		const competing = new EpochContentStore({ webDataDir, serverEpoch: "epoch-lock" });
		stores.push(competing);
		await expect(competing.initialize()).rejects.toMatchObject({ code: "store_locked" });
		await expect(readContent(first, ref)).resolves.toEqual(Buffer.from("locked"));

		await first.shutdown();
		await competing.initialize();
		expect(competing.usage).toEqual({ bytes: 6, items: 1 });
		await expect(readContent(competing, ref)).resolves.toEqual(Buffer.from("locked"));
	});

	it("atomically tombstones an old epoch only while holding the lifecycle lock", async () => {
		const oldStore = await createStore("epoch-old");
		await publishContent(oldStore, { source: source("old"), mediaType: "text/plain" });
		await oldStore.shutdown();
		const renames: Array<[string, string]> = [];
		const { rename } = await import("node:fs/promises");
		const current = await createStore(
			"epoch-current",
			{},
			{
				webDataDir,
				serverEpoch: "epoch-current",
				async rename(from, to) {
					renames.push([from, to]);
					await rename(from, to);
				},
			},
		);
		expect(current.usage).toEqual({ bytes: 0, items: 0 });
		expect(
			renames.some(
				([from, to]) =>
					path.basename(from) === epochKey("epoch-old") && path.basename(to).startsWith(".tombstone-"),
			),
		).toBe(true);
	});

	it("persists an exact manifest and rejects media-type or manifest substitution", async () => {
		const epoch = "epoch-manifest";
		const store = await createStore(epoch);
		const ref = await publishContent(store, { source: source("image"), mediaType: "image/png" });
		const paths = storePaths(webDataDir, epoch);
		expect(JSON.parse(await readFile(paths.manifestPath(ref.sha256), "utf8"))).toEqual({
			version: 1,
			published: true,
			ref,
		});
		await expect(store.stage({ source: source("image"), mediaType: "image/webp" })).rejects.toMatchObject({
			code: "manifest_mismatch",
		});
		await expect(store.pin({ ...ref, mediaType: "image/webp" })).rejects.toMatchObject({
			code: "manifest_mismatch",
		});
		await writeFile(paths.manifestPath(ref.sha256), JSON.stringify({ version: 1, published: false, ref }));
		await expect(store.pin(ref)).rejects.toMatchObject({ code: "manifest_mismatch" });
		await writeFile(paths.manifestPath(ref.sha256), JSON.stringify({ version: 1, published: true, ref }));
		const outsideManifest = path.join(webDataDir, "outside-manifest.json");
		await writeFile(outsideManifest, JSON.stringify({ version: 1, published: true, ref }));
		await rm(paths.manifestPath(ref.sha256));
		await symlink(outsideManifest, paths.manifestPath(ref.sha256));
		await expect(store.pin(ref)).rejects.toMatchObject({ code: "manifest_mismatch" });
		await rm(paths.manifestPath(ref.sha256));
		await writeFile(paths.manifestPath(ref.sha256), JSON.stringify({ version: 1, published: true, ref }));

		await store.shutdown();
		await writeFile(
			paths.manifestPath(ref.sha256),
			JSON.stringify({ version: 1, published: true, ref: { ...ref, byteLength: ref.byteLength + 1 } }),
		);
		const reopened = new EpochContentStore({ webDataDir, serverEpoch: epoch });
		stores.push(reopened);
		await expect(reopened.initialize()).rejects.toMatchObject({ code: "unsafe_layout" });
	});

	it("pins an open stream until shutdown aborts and observes it", async () => {
		const store = await createStore("epoch-open-pin");
		const ref = await publishContent(store, {
			source: source(Buffer.alloc(128 * 1024, 7)),
			mediaType: "application/octet-stream",
		});
		const pinned = await store.pin(ref);
		const readable = pinned.stream;
		expect(readable.destroyed).toBe(false);
		await store.shutdown();
		expect(readable.destroyed).toBe(true);
	});

	it("streams from the same descriptor whose digest was verified", async () => {
		let contentOpens = 0;
		let armReplacement = false;
		const { open } = await import("node:fs/promises");
		const store = await createStore(
			"epoch-pin-fd",
			{},
			{
				webDataDir,
				serverEpoch: "epoch-pin-fd",
				async openFile(filePath, flags, mode) {
					if (path.basename(filePath) === "content" && ++contentOpens === 2 && armReplacement) {
						await writeFile(filePath, "evil", { mode: 0o600 });
					}
					return open(filePath, flags, mode);
				},
			},
		);
		const ref = await publishContent(store, { source: source("good"), mediaType: "text/plain" });
		contentOpens = 0;
		armReplacement = true;
		await expect(readContent(store, ref)).resolves.toEqual(Buffer.from("good"));
		expect(contentOpens).toBe(1);
	});

	it("pins published content by a strict digest using manifest-owned metadata", async () => {
		const store = await createStore("epoch-pin-digest");
		const staged = await store.stage({ source: source("digest-get"), mediaType: "text/plain" });
		await expect(store.pinByDigest(staged.ref.sha256)).rejects.toMatchObject({ code: "not_published" });
		await store.publish(staged.hold);
		const pinned = await store.pinByDigest(staged.ref.sha256);
		expect(pinned.ref).toEqual(staged.ref);
		expect(Object.isFrozen(pinned.ref)).toBe(true);
		await expect(readStream(pinned.stream)).resolves.toEqual(Buffer.from("digest-get"));
		await store.release(pinned.pin);
		await store.release(staged.hold);
		await expect(store.pinByDigest("../outside")).rejects.toMatchObject({ code: "invalid_ref" });
		await expect(store.pinByDigest("A".repeat(64))).rejects.toMatchObject({ code: "invalid_ref" });
	});

	it("acquires and releases an exact published hold without opening the blob", async () => {
		let contentOpens = 0;
		const { open } = await import("node:fs/promises");
		const store = await createStore(
			"epoch-published-hold",
			{},
			{
				webDataDir,
				serverEpoch: "epoch-published-hold",
				async openFile(filePath, flags, mode) {
					if (path.basename(filePath) === "content") contentOpens += 1;
					return open(filePath, flags, mode);
				},
			},
		);
		const ref = await publishContent(store, { source: source("hold-me"), mediaType: "image/png" });
		contentOpens = 0;

		const hold = await store.holdPublished(ref);
		expect(hold.ref).toBe(ref);
		expect(contentOpens).toBe(0);
		expect(await store.gc()).toEqual({ bytes: 0, items: 0 });
		await store.release(hold);
		expect(await store.gc()).toEqual({ bytes: ref.byteLength, items: 1 });
		expect(contentOpens).toBe(0);
	});

	it("requires exact published metadata when acquiring a hold", async () => {
		const store = await createStore("epoch-hold-metadata");
		const staged = await store.stage({ source: source("metadata"), mediaType: "image/png" });
		await expect(store.holdPublished(staged.ref)).rejects.toMatchObject({ code: "not_published" });
		await store.publish(staged.hold);
		await store.release(staged.hold);

		await expect(store.holdPublished({ ...staged.ref, mediaType: "image/webp" })).rejects.toMatchObject({
			code: "manifest_mismatch",
		});
		await expect(
			store.holdPublished({ ...staged.ref, byteLength: staged.ref.byteLength + 1 }),
		).rejects.toMatchObject({
			code: "manifest_mismatch",
		});
		await expect(store.holdPublished({ ...staged.ref, sha256: "f".repeat(64) })).rejects.toMatchObject({
			code: "not_found",
		});
	});

	it("serializes published hold acquisition with GC deletion", async () => {
		let gcRenameEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			gcRenameEntered = resolve;
		});
		let allowGcRename!: () => void;
		const gate = new Promise<void>((resolve) => {
			allowGcRename = resolve;
		});
		const { rename } = await import("node:fs/promises");
		const store = await createStore(
			"epoch-hold-gc-race",
			{},
			{
				webDataDir,
				serverEpoch: "epoch-hold-gc-race",
				async rename(from, to) {
					if (/^[0-9a-f]{64}$/.test(path.basename(from)) && path.basename(to).startsWith(".tombstone-")) {
						gcRenameEntered();
						await gate;
					}
					await rename(from, to);
				},
			},
		);
		const ref = await publishContent(store, { source: source("collect"), mediaType: "image/png" });

		const collecting = store.gc();
		await entered;
		const holding = store.holdPublished(ref);
		allowGcRename();
		expect(await collecting).toEqual({ bytes: ref.byteLength, items: 1 });
		await expect(holding).rejects.toMatchObject({ code: "not_found" });
	});

	it("rechecks a snapshotted GC candidate after a published hold wins the digest lock", async () => {
		const store = await createStore("epoch-hold-wins-gc");
		const ref = await publishContent(store, { source: source("retained"), mediaType: "image/png" });

		const holding = store.holdPublished(ref);
		const collecting = store.gc();
		const hold = await holding;
		expect(await collecting).toEqual({ bytes: 0, items: 0 });
		await expect(readContent(store, ref)).resolves.toEqual(Buffer.from("retained"));
		await store.release(hold);
	});

	it("fails closed when shutdown races published hold acquisition", async () => {
		const store = await createStore("epoch-hold-shutdown-race");
		const ref = await publishContent(store, { source: source("shutdown-hold"), mediaType: "image/png" });

		const holding = store.holdPublished(ref);
		const shutdown = store.shutdown();
		await expect(holding).rejects.toMatchObject({ code: "closed" });
		await shutdown;
		await expect(store.holdPublished(ref)).rejects.toMatchObject({ code: "closed" });
	});

	it("establishes manifest permissions before rename so publish cannot split disk and memory state", async () => {
		let manifestChmods = 0;
		const { open } = await import("node:fs/promises");
		const store = await createStore(
			"epoch-manifest-commit",
			{},
			{
				webDataDir,
				serverEpoch: "epoch-manifest-commit",
				async openFile(filePath, flags, mode) {
					const handle = await open(filePath, flags, mode);
					const chmod = handle.chmod.bind(handle);
					return new Proxy(handle, {
						get(target, property) {
							if (property === "chmod") {
								return async (requestedMode: number) => {
									if (
										path.basename(filePath).startsWith(".tmp-") &&
										/^[0-9a-f]{64}$/.test(path.basename(path.dirname(filePath)))
									) {
										manifestChmods += 1;
									}
									await chmod(requestedMode);
								};
							}
							const value = Reflect.get(target, property, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
				},
			},
		);
		const staged = await store.stage({ source: source("manifest-commit"), mediaType: "text/plain" });
		await expect(store.publish(staged.hold)).resolves.toBeUndefined();
		await expect(readContent(store, staged.ref)).resolves.toEqual(Buffer.from("manifest-commit"));
		expect(manifestChmods).toBe(2);
	});

	it("keeps staged content private until publish and garbage-collects only released unpinned content", async () => {
		const store = await createStore("epoch-lifecycle");
		const staged = await store.stage({ source: source("lifecycle"), mediaType: "text/plain" });
		await expect(store.pin(staged.ref)).rejects.toMatchObject({ code: "not_published" });
		expect(await store.gc()).toEqual({ bytes: 0, items: 0 });

		await store.publish(staged.hold);
		expect(await store.gc()).toEqual({ bytes: 0, items: 0 });
		const pinned = await store.pin(staged.ref);
		await store.release(staged.hold);
		await store.release(staged.hold);
		expect(await store.gc()).toEqual({ bytes: 0, items: 0 });
		await store.release(pinned.pin);
		await store.release(pinned.pin);
		expect(await store.gc()).toEqual({ bytes: 9, items: 1 });
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
		await expect(store.pin(staged.ref)).rejects.toMatchObject({ code: "not_found" });
	});

	it("never exposes a mutable alias to ledger accounting fields", async () => {
		const store = await createStore("epoch-immutable-ref");
		const staged = await store.stage({ source: source("four"), mediaType: "text/plain" });
		expect(Object.isFrozen(staged.ref)).toBe(true);
		expect(Object.isFrozen(staged.hold.ref)).toBe(true);
		expect(Reflect.set(staged.ref, "byteLength", 8)).toBe(false);
		expect(Reflect.set(staged.hold.ref, "mediaType", "text/html")).toBe(false);
		await store.publish(staged.hold);
		await store.release(staged.hold);
		expect(await store.gc()).toEqual({ bytes: 4, items: 1 });
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
	});

	it("does not strand later GC candidates when the first transactional rename fails", async () => {
		let failFirstGcRename = true;
		const { rename } = await import("node:fs/promises");
		const store = await createStore(
			"epoch-gc-batch",
			{},
			{
				webDataDir,
				serverEpoch: "epoch-gc-batch",
				async rename(from, to) {
					if (
						failFirstGcRename &&
						/^[0-9a-f]{64}$/.test(path.basename(from)) &&
						path.basename(to).startsWith(".tombstone-")
					) {
						failFirstGcRename = false;
						throw Object.assign(new Error("injected gc rename failure"), { code: "EIO" });
					}
					await rename(from, to);
				},
			},
		);
		await publishContent(store, { source: source("first"), mediaType: "text/plain" });
		await publishContent(store, { source: source("second"), mediaType: "text/plain" });
		await expect(store.gc()).rejects.toMatchObject({ code: "io_failure" });
		expect(await store.gc()).toEqual({ bytes: 11, items: 2 });
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
	});

	it("retains tombstone quota until physical removal succeeds and retries cleanup", async () => {
		let allowTombstoneRemove = false;
		const { rm: remove } = await import("node:fs/promises");
		const store = await createStore(
			"epoch-gc-tombstone",
			{ maxBlobBytes: 4, maxCacheBytes: 4, maxCacheItems: 1 },
			{
				webDataDir,
				serverEpoch: "epoch-gc-tombstone",
				async remove(target, options) {
					if (!allowTombstoneRemove && path.basename(target).startsWith(".tombstone-")) {
						throw Object.assign(new Error("injected tombstone remove failure"), { code: "EIO" });
					}
					await remove(target, options);
				},
			},
		);
		await publishContent(store, { source: source("gone"), mediaType: "text/plain" });
		await expect(store.gc()).rejects.toMatchObject({ code: "io_failure" });
		expect(store.usage).toEqual({ bytes: 4, items: 1 });
		expect(
			(await readdir(storePaths(webDataDir, "epoch-gc-tombstone").blobsRoot)).some((name) =>
				name.startsWith(".tombstone-"),
			),
		).toBe(true);
		await expect(
			store.stage({ source: source("next"), mediaType: "text/plain", expectedByteLength: 4 }),
		).rejects.toMatchObject({ code: "cache_bytes_exhausted" });
		await expect(store.gc()).rejects.toMatchObject({ code: "io_failure" });
		expect(store.usage).toEqual({ bytes: 4, items: 1 });
		allowTombstoneRemove = true;
		expect(await store.gc()).toEqual({ bytes: 4, items: 1 });
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
		expect(await readdir(storePaths(webDataDir, "epoch-gc-tombstone").blobsRoot)).toEqual([]);
		await expect(
			publishContent(store, { source: source("next"), mediaType: "text/plain", expectedByteLength: 4 }),
		).resolves.toMatchObject({ byteLength: 4 });
	});

	it("does not delete content when its hold is released during a successful publish", async () => {
		let manifestRenames = 0;
		let publishRenameEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			publishRenameEntered = resolve;
		});
		let allowPublishRename!: () => void;
		const publishGate = new Promise<void>((resolve) => {
			allowPublishRename = resolve;
		});
		const { rename } = await import("node:fs/promises");
		const store = await createStore(
			"epoch-publish-release",
			{},
			{
				webDataDir,
				serverEpoch: "epoch-publish-release",
				async rename(from, to) {
					if (path.basename(to) === "manifest.json" && ++manifestRenames === 2) {
						publishRenameEntered();
						await publishGate;
					}
					await rename(from, to);
				},
			},
		);
		const staged = await store.stage({ source: source("publish-race"), mediaType: "text/plain" });
		const publishing = store.publish(staged.hold);
		await entered;
		const releasing = store.release(staged.hold);
		allowPublishRename();
		await Promise.all([publishing, releasing]);
		await expect(readContent(store, staged.ref)).resolves.toEqual(Buffer.from("publish-race"));
	});

	it("removes an unpublished orphan when its final hold is released", async () => {
		const store = await createStore("epoch-orphan");
		const staged = await store.stage({ source: source("orphan"), mediaType: "text/plain" });
		expect(store.usage).toEqual({ bytes: 6, items: 1 });
		await store.release(staged.hold);
		await store.release(staged.hold);
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
		await expect(store.pin(staged.ref)).rejects.toMatchObject({ code: "not_found" });
	});

	it("restores the final unpublished hold when its tombstone rename fails", async () => {
		let failTombstoneRename = true;
		const { rename } = await import("node:fs/promises");
		const store = await createStore(
			"epoch-orphan-retry",
			{ maxBlobBytes: 6, maxCacheBytes: 6, maxCacheItems: 1 },
			{
				webDataDir,
				serverEpoch: "epoch-orphan-retry",
				async rename(from, to) {
					if (
						failTombstoneRename &&
						/^[0-9a-f]{64}$/.test(path.basename(from)) &&
						path.basename(to).startsWith(".tombstone-")
					) {
						failTombstoneRename = false;
						throw Object.assign(new Error("injected orphan rename failure"), { code: "EIO" });
					}
					await rename(from, to);
				},
			},
		);
		const staged = await store.stage({
			source: source("orphan"),
			mediaType: "text/plain",
			expectedByteLength: 6,
		});
		await expect(store.release(staged.hold)).rejects.toMatchObject({ code: "io_failure" });
		expect(store.usage).toEqual({ bytes: 6, items: 1 });
		await expect(
			store.stage({ source: source("x"), mediaType: "text/plain", expectedByteLength: 1 }),
		).rejects.toMatchObject({ code: "cache_bytes_exhausted" });
		await expect(store.release(staged.hold)).resolves.toBeUndefined();
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
		await expect(store.pin(staged.ref)).rejects.toMatchObject({ code: "not_found" });
	});

	it("establishes directory and staging permissions through verified open descriptors", async () => {
		let directoryDescriptorChmods = 0;
		let stagingDescriptorChmods = 0;
		const { open } = await import("node:fs/promises");
		const store = await createStore(
			"epoch-descriptor-modes",
			{},
			{
				webDataDir,
				serverEpoch: "epoch-descriptor-modes",
				async openFile(filePath, flags, mode) {
					const handle = await open(filePath, flags, mode);
					const metadata = await handle.stat();
					const chmod = handle.chmod.bind(handle);
					return new Proxy(handle, {
						get(target, property) {
							if (property === "chmod") {
								return async (requestedMode: number) => {
									if (metadata.isDirectory()) directoryDescriptorChmods += 1;
									else if (
										path.basename(filePath).startsWith(".tmp-") &&
										path.basename(path.dirname(filePath)) === "blobs"
									) {
										stagingDescriptorChmods += 1;
									}
									await chmod(requestedMode);
								};
							}
							const value = Reflect.get(target, property, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
				},
			},
		);
		const staged = await store.stage({ source: source("private"), mediaType: "text/plain" });
		expect(directoryDescriptorChmods).toBeGreaterThan(0);
		expect(stagingDescriptorChmods).toBe(1);
		await store.release(staged.hold);
	});

	it("creates private directories and files and restores private modes on restart", async () => {
		const epoch = "epoch-modes";
		const store = await createStore(epoch);
		const ref = await publishContent(store, { source: source("secret"), mediaType: "text/plain" });
		const paths = storePaths(webDataDir, epoch);
		for (const directory of [
			paths.storeRoot,
			paths.epochRoot,
			paths.blobsRoot,
			paths.blobDirectory(ref.sha256),
		]) {
			expect((await lstat(directory)).mode & 0o777).toBe(0o700);
		}
		expect((await lstat(paths.blobPath(ref.sha256))).mode & 0o777).toBe(0o600);
		expect((await lstat(paths.manifestPath(ref.sha256))).mode & 0o777).toBe(0o600);

		await chmod(paths.blobsRoot, 0o755);
		await chmod(paths.blobPath(ref.sha256), 0o644);
		await store.shutdown();
		const reopened = await createStore(epoch);
		expect(reopened.usage).toEqual({ bytes: 6, items: 1 });
		expect((await lstat(paths.blobsRoot)).mode & 0o777).toBe(0o700);
		expect((await lstat(paths.blobPath(ref.sha256))).mode & 0o777).toBe(0o600);
	});

	it("rejects invalid limits and operations before initialization or after shutdown", async () => {
		expect(
			() =>
				new EpochContentStore({
					webDataDir,
					serverEpoch: "epoch-a",
					limits: { maxBlobBytes: 5, maxCacheBytes: 4 },
				}),
		).toThrow(EpochContentStoreError);
		const store = new EpochContentStore({ webDataDir, serverEpoch: "epoch-a" });
		stores.push(store);
		await expect(store.stage({ source: source("x"), mediaType: "text/plain" })).rejects.toMatchObject({
			code: "not_initialized",
		});
		await store.initialize();
		await store.shutdown();
		await expect(store.stage({ source: source("x"), mediaType: "text/plain" })).rejects.toMatchObject({
			code: "closed",
		});
	});

	it("normalizes lifecycle lock release failures without leaking filesystem paths", async () => {
		const store = new EpochContentStore({
			webDataDir,
			serverEpoch: "epoch-release-error",
			async acquireLock() {
				return async () => {
					throw new Error("release failed at /private/attachment-cache.lock");
				};
			},
		});
		stores.push(store);
		await store.initialize();
		await expect(store.shutdown()).rejects.toMatchObject({
			code: "io_failure",
			message: "Content store operation failed",
		});
		await expect(store.stage({ source: source("x"), mediaType: "text/plain" })).rejects.toMatchObject({
			code: "closed",
		});
	});

	it("shares one shutdown promise and one terminal lock-release result", async () => {
		let allowRelease!: () => void;
		const releaseGate = new Promise<void>((resolve) => {
			allowRelease = resolve;
		});
		const store = new EpochContentStore({
			webDataDir,
			serverEpoch: "epoch-shutdown-single-flight",
			async acquireLock() {
				return async () => {
					await releaseGate;
					throw new Error("release failed at /private/single-flight.lock");
				};
			},
		});
		stores.push(store);
		await store.initialize();
		const first = store.shutdown();
		const second = store.shutdown();
		expect(second).toBe(first);
		allowRelease();
		await expect(first).rejects.toMatchObject({ code: "io_failure" });
		await expect(second).rejects.toMatchObject({ code: "io_failure" });
	});

	it("waits for an in-flight initialization before releasing its lifecycle lock on shutdown", async () => {
		let entered!: () => void;
		const lockEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let allowAcquire!: () => void;
		const acquireGate = new Promise<void>((resolve) => {
			allowAcquire = resolve;
		});
		let released = 0;
		const store = new EpochContentStore({
			webDataDir,
			serverEpoch: "epoch-init-shutdown",
			async acquireLock() {
				entered();
				await acquireGate;
				return async () => {
					released += 1;
				};
			},
		});
		stores.push(store);
		const initialization = store.initialize();
		await lockEntered;
		const shutdown = store.shutdown();
		allowAcquire();
		await Promise.allSettled([initialization, shutdown]);
		expect(released).toBe(1);
	});
});
