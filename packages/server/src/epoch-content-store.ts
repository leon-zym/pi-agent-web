import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	rm as removeFile,
	rename as renameFile,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import { addAbortSignal, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
	isSessionAttachmentRefDto,
	SESSION_ATTACHMENT_BLOB_MAX_BYTES,
	SESSION_ATTACHMENT_CACHE_MAX_BYTES,
	SESSION_ATTACHMENT_CACHE_MAX_ITEMS,
	type SessionAttachmentRefDto,
} from "@pi-agent-web/protocol";
import lockfile from "proper-lockfile";

export type { SessionAttachmentRefDto } from "@pi-agent-web/protocol";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_MANIFEST_BYTES = 1024;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const TEMP_RE = /^\.tmp-[0-9a-f-]{36}$/;
const TOMBSTONE_RE = /^\.tombstone-[0-9a-f-]{36}$/;
const CONTENT_FILE = "content";
const MANIFEST_FILE = "manifest.json";

export interface EpochContentStoreLimits {
	maxBlobBytes: number;
	maxCacheBytes: number;
	maxCacheItems: number;
}

export interface EpochContentStoreOptions {
	webDataDir: string;
	serverEpoch: string;
	limits?: Partial<EpochContentStoreLimits>;
	/** Async filesystem seam for deterministic commit-failure tests. */
	rename?: (from: string, to: string) => Promise<void>;
	/** Recursive-remove seam for deterministic tombstone cleanup tests. */
	remove?: (target: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
	/** Async open seam for deterministic descriptor-race tests. */
	openFile?: (filePath: string, flags: string | number, mode?: number) => Promise<FileHandle>;
	/** Lifecycle-lock seam. The default is a non-waiting proper-lockfile lock. */
	acquireLock?: (storeRoot: string) => Promise<() => Promise<void>>;
}

export interface EpochContentPutInput {
	source: Readable;
	mediaType: string;
	expectedSha256?: string;
	expectedByteLength?: number;
	signal?: AbortSignal;
}

export interface EpochContentHold {
	readonly ref: SessionAttachmentRefDto;
}

export interface EpochContentPin {
	readonly ref: SessionAttachmentRefDto;
}

export interface StagedEpochContent {
	readonly ref: SessionAttachmentRefDto;
	readonly hold: EpochContentHold;
}

export interface PinnedEpochContent {
	readonly ref: SessionAttachmentRefDto;
	readonly stream: Readable;
	readonly pin: EpochContentPin;
}

export type EpochContentStoreErrorCode =
	| "aborted"
	| "blob_too_large"
	| "cache_bytes_exhausted"
	| "cache_items_exhausted"
	| "closed"
	| "declared_digest_mismatch"
	| "declared_length_mismatch"
	| "digest_collision"
	| "empty_blob"
	| "epoch_mismatch"
	| "invalid_handle"
	| "invalid_limits"
	| "invalid_ref"
	| "io_failure"
	| "manifest_mismatch"
	| "not_found"
	| "not_initialized"
	| "not_published"
	| "store_locked"
	| "unsafe_layout"
	| "unsafe_path";

export class EpochContentStoreError extends Error {
	readonly code: EpochContentStoreErrorCode;
	readonly limit?: number;
	readonly actual?: number;

	constructor(
		code: EpochContentStoreErrorCode,
		message: string,
		details: { limit?: number; actual?: number } = {},
	) {
		super(message);
		this.name = "EpochContentStoreError";
		this.code = code;
		this.limit = details.limit;
		this.actual = details.actual;
	}
}

type StoreState = "uninitialized" | "initializing" | "ready" | "closed";
type FileHandle = Awaited<ReturnType<typeof open>>;
type FileStats = Awaited<ReturnType<typeof lstat>>;
type Manifest = { version: 1; published: boolean; ref: SessionAttachmentRefDto };
type Entry = {
	ref: SessionAttachmentRefDto;
	published: boolean;
	holds: number;
	pins: number;
	deleting: boolean;
};
type TombstoneEntry = { bytes: number; items: 1 };
type Reservation = { bytes: number; active: boolean };
type TokenState = { kind: "hold" | "pin"; digest: string; active: boolean; stream?: Readable };

function errno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException)?.code === code;
}

function isPositiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function fail(code: EpochContentStoreErrorCode, message: string): never {
	throw new EpochContentStoreError(code, message);
}

function normalizeError(error: unknown): EpochContentStoreError {
	if (error instanceof EpochContentStoreError) return error;
	if (
		(error instanceof Error && error.name === "AbortError") ||
		(error as NodeJS.ErrnoException | undefined)?.code === "ABORT_ERR"
	) {
		return new EpochContentStoreError("aborted", "Content store operation was aborted");
	}
	return new EpochContentStoreError("io_failure", "Content store operation failed");
}

function refsEqual(left: SessionAttachmentRefDto, right: SessionAttachmentRefDto): boolean {
	return (
		left.type === right.type &&
		left.serverEpoch === right.serverEpoch &&
		left.sha256 === right.sha256 &&
		left.mediaType === right.mediaType &&
		left.byteLength === right.byteLength
	);
}

function immutableRef(ref: SessionAttachmentRefDto): SessionAttachmentRefDto {
	return Object.freeze({ ...ref });
}

function isManifest(value: unknown): value is Manifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (Object.getPrototypeOf(value) !== Object.prototype) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	return (
		keys.length === 3 &&
		keys.includes("version") &&
		keys.includes("published") &&
		keys.includes("ref") &&
		record.version === 1 &&
		typeof record.published === "boolean" &&
		isSessionAttachmentRefDto(record.ref)
	);
}

async function secureExistingDirectory(
	directory: string,
	openFile: (filePath: string, flags: string | number, mode?: number) => Promise<FileHandle>,
): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await openFile(
			directory,
			fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
		);
		const metadata = await handle.stat();
		if (!metadata.isDirectory()) fail("unsafe_path", "Store directory is unsafe");
		await handle.chmod(DIRECTORY_MODE);
	} catch (error) {
		if (errno(error, "ELOOP") || errno(error, "ENOTDIR")) {
			fail("unsafe_path", "Store directory is unsafe");
		}
		throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function secureDirectory(
	directory: string,
	recursive: boolean,
	openFile: (filePath: string, flags: string | number, mode?: number) => Promise<FileHandle>,
): Promise<void> {
	try {
		await mkdir(directory, { recursive, mode: DIRECTORY_MODE });
	} catch (error) {
		if (!errno(error, "EEXIST")) throw error;
	}
	await secureExistingDirectory(directory, openFile);
}

async function hashReadable(readable: Readable): Promise<{ digest: string; bytes: number }> {
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of readable) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		hash.update(buffer);
		bytes += buffer.byteLength;
	}
	return { digest: hash.digest("hex"), bytes };
}

async function readBoundedFile(
	filePath: string,
	maxBytes: number,
	errorCode: "manifest_mismatch" | "unsafe_layout",
): Promise<string> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		const before = await handle.stat();
		if (!before.isFile() || before.size <= 0 || before.size > maxBytes) {
			fail(errorCode, "Store metadata file is unsafe");
		}
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		let offset = 0;
		while (offset <= maxBytes) {
			const { bytesRead } = await handle.read(buffer, offset, maxBytes + 1 - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (
			offset <= 0 ||
			offset > maxBytes ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			after.size !== offset
		) {
			fail(errorCode, "Store metadata changed during bounded read");
		}
		await handle.chmod(FILE_MODE);
		return buffer.subarray(0, offset).toString("utf8");
	} catch (error) {
		if (errno(error, "ELOOP")) fail(errorCode, "Store metadata symlinks are forbidden");
		throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
}

export class EpochContentStore {
	readonly #serverEpoch: string;
	readonly #limits: EpochContentStoreLimits;
	readonly #rename: (from: string, to: string) => Promise<void>;
	readonly #remove: (target: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
	readonly #openFile: (filePath: string, flags: string | number, mode?: number) => Promise<FileHandle>;
	readonly #acquireLock: (storeRoot: string) => Promise<() => Promise<void>>;
	readonly #webDataDir: string;
	readonly #storeRoot: string;
	readonly #epochsRoot: string;
	readonly #epochRoot: string;
	readonly #blobsRoot: string;
	readonly #lifecycleAbort = new AbortController();
	readonly #active = new Set<Promise<unknown>>();
	readonly #temporaryPaths = new Set<string>();
	readonly #digestTails = new Map<string, Promise<void>>();
	readonly #entries = new Map<string, Entry>();
	readonly #tombstones = new Map<string, TombstoneEntry>();
	readonly #tokens = new WeakMap<EpochContentHold | EpochContentPin, TokenState>();
	readonly #tokenObjects = new Set<EpochContentHold | EpochContentPin>();
	#state: StoreState = "uninitialized";
	#initialization: Promise<void> | undefined;
	#shutdownPromise: Promise<void> | undefined;
	#releaseLock: (() => Promise<void>) | undefined;
	#bytes = 0;
	#items = 0;
	#reservedBytes = 0;
	#reservedItems = 0;
	#tombstoneTail: Promise<void> = Promise.resolve();

	constructor(options: EpochContentStoreOptions) {
		const limits: EpochContentStoreLimits = {
			maxBlobBytes: options.limits?.maxBlobBytes ?? SESSION_ATTACHMENT_BLOB_MAX_BYTES,
			maxCacheBytes: options.limits?.maxCacheBytes ?? SESSION_ATTACHMENT_CACHE_MAX_BYTES,
			maxCacheItems: options.limits?.maxCacheItems ?? SESSION_ATTACHMENT_CACHE_MAX_ITEMS,
		};
		if (
			!isPositiveInteger(limits.maxBlobBytes) ||
			!isPositiveInteger(limits.maxCacheBytes) ||
			!isPositiveInteger(limits.maxCacheItems) ||
			limits.maxBlobBytes > limits.maxCacheBytes ||
			limits.maxBlobBytes > SESSION_ATTACHMENT_BLOB_MAX_BYTES ||
			limits.maxCacheBytes > SESSION_ATTACHMENT_CACHE_MAX_BYTES ||
			limits.maxCacheItems > SESSION_ATTACHMENT_CACHE_MAX_ITEMS
		) {
			throw new EpochContentStoreError("invalid_limits", "Content store limits are invalid");
		}
		const probe: SessionAttachmentRefDto = {
			type: "attachment_ref",
			serverEpoch: options.serverEpoch,
			sha256: "0".repeat(64),
			mediaType: "application/octet-stream",
			byteLength: 1,
		};
		if (!isSessionAttachmentRefDto(probe))
			throw new EpochContentStoreError("invalid_ref", "serverEpoch is invalid");
		if (!path.isAbsolute(options.webDataDir))
			throw new EpochContentStoreError("unsafe_path", "webDataDir must be absolute");

		this.#serverEpoch = options.serverEpoch;
		this.#limits = limits;
		this.#rename = options.rename ?? renameFile;
		this.#remove = options.remove ?? removeFile;
		this.#openFile = options.openFile ?? open;
		this.#acquireLock =
			options.acquireLock ?? (async (storeRoot) => lockfile.lock(storeRoot, { realpath: false, retries: 0 }));
		this.#webDataDir = path.resolve(options.webDataDir);
		this.#storeRoot = path.join(this.#webDataDir, "content", "attachments", "v1");
		this.#epochsRoot = path.join(this.#storeRoot, "epochs");
		const epochKey = createHash("sha256").update(this.#serverEpoch).digest("hex");
		this.#epochRoot = path.join(this.#epochsRoot, epochKey);
		this.#blobsRoot = path.join(this.#epochRoot, "blobs");
	}

	get usage(): Readonly<{ bytes: number; items: number }> {
		return Object.freeze({ bytes: this.#bytes, items: this.#items });
	}

	async initialize(): Promise<void> {
		if (this.#state === "closed") fail("closed", "Content store is closed");
		if (this.#state === "ready") return;
		if (this.#initialization) return this.#initialization;
		this.#state = "initializing";
		this.#initialization = this.#initializeInternal();
		try {
			await this.#initialization;
			if (!this.#isClosed()) this.#state = "ready";
		} catch (error) {
			await this.#releaseLifecycleLock();
			if (!this.#isClosed()) this.#state = "uninitialized";
			throw normalizeError(error);
		} finally {
			this.#initialization = undefined;
		}
	}

	stage(input: EpochContentPutInput): Promise<StagedEpochContent> {
		const source = input?.source instanceof Readable ? input.source : undefined;
		const observeSourceError = (): void => {};
		source?.on("error", observeSourceError);
		let staged: Promise<StagedEpochContent>;
		try {
			this.#assertReady();
			staged = this.#stageInternal(input);
		} catch (error) {
			staged = Promise.reject(error);
		}
		const operation = this.#publicOperation(this.#withOwnedStageSource(staged, source, observeSourceError));
		this.#track(operation);
		return operation;
	}

	publish(hold: EpochContentHold): Promise<void> {
		try {
			this.#assertReady();
			const token = this.#requireToken(hold, "hold");
			const operation = this.#publicOperation(this.#publishInternal(hold, token));
			this.#track(operation);
			return operation;
		} catch (error) {
			return Promise.reject(error);
		}
	}

	pin(ref: SessionAttachmentRefDto, options: { signal?: AbortSignal } = {}): Promise<PinnedEpochContent> {
		try {
			this.#assertReady();
			this.#validateRef(ref);
			const operation = this.#publicOperation(this.#pinInternal(ref, options.signal));
			this.#track(operation);
			return operation;
		} catch (error) {
			return Promise.reject(error);
		}
	}

	pinByDigest(digest: string, options: { signal?: AbortSignal } = {}): Promise<PinnedEpochContent> {
		try {
			this.#assertReady();
			if (!DIGEST_RE.test(digest)) fail("invalid_ref", "Attachment digest is invalid");
			const entry = this.#entries.get(digest);
			if (!entry || entry.deleting) fail("not_found", "Attachment content is unavailable");
			const operation = this.#publicOperation(this.#pinInternal(entry.ref, options.signal));
			this.#track(operation);
			return operation;
		} catch (error) {
			return Promise.reject(error);
		}
	}

	release(handle: EpochContentHold | EpochContentPin): Promise<void> {
		const token = this.#tokens.get(handle);
		if (!token?.active) return Promise.resolve();
		const operation = this.#publicOperation(this.#releaseInternal(handle, token));
		this.#track(operation);
		return operation;
	}

	gc(): Promise<{ bytes: number; items: number }> {
		try {
			this.#assertReady();
		} catch (error) {
			return Promise.reject(error);
		}
		const candidates = [...this.#entries.entries()].filter(
			([, entry]) => entry.published && entry.holds === 0 && entry.pins === 0 && !entry.deleting,
		);
		const operation = this.#publicOperation(this.#gcInternal(candidates));
		this.#track(operation);
		return operation;
	}

	shutdown(): Promise<void> {
		if (this.#shutdownPromise) return this.#shutdownPromise;
		this.#shutdownPromise = this.#shutdownInternal();
		return this.#shutdownPromise;
	}

	async #shutdownInternal(): Promise<void> {
		const initialization = this.#initialization;
		this.#state = "closed";
		this.#lifecycleAbort.abort();
		for (const handle of this.#tokenObjects) {
			const token = this.#tokens.get(handle);
			if (!token?.active) continue;
			token.active = false;
			token.stream?.destroy(this.#lifecycleAbort.signal.reason);
			const entry = this.#entries.get(token.digest);
			if (!entry) continue;
			if (token.kind === "hold") entry.holds = Math.max(0, entry.holds - 1);
			else entry.pins = Math.max(0, entry.pins - 1);
		}
		if (initialization) await Promise.allSettled([initialization]);
		await Promise.allSettled([...this.#active]);
		for (const [digest, entry] of this.#entries) {
			if (!entry.published) await this.#deleteEntry(digest, entry).catch(() => {});
		}
		await Promise.allSettled([...this.#temporaryPaths].map((temporaryPath) => unlink(temporaryPath)));
		this.#temporaryPaths.clear();
		this.#reservedBytes = 0;
		this.#reservedItems = 0;
		await this.#releaseLifecycleLock();
	}

	async #initializeInternal(): Promise<void> {
		await secureDirectory(this.#webDataDir, true, this.#openFile);
		let current = this.#webDataDir;
		for (const segment of ["content", "attachments", "v1"]) {
			current = path.join(current, segment);
			await secureDirectory(current, false, this.#openFile);
		}
		try {
			this.#releaseLock = await this.#acquireLock(this.#storeRoot);
		} catch (error) {
			if (errno(error, "ELOCKED")) fail("store_locked", "Content store is owned by another Gateway");
			throw error;
		}
		await secureDirectory(this.#epochsRoot, false, this.#openFile);
		await this.#removeStaleEpochs();
		await secureDirectory(this.#epochRoot, false, this.#openFile);
		await this.#ensureEpochMarker();
		await secureDirectory(this.#blobsRoot, false, this.#openFile);
		await this.#scanCurrentEpoch();
	}

	async #removeStaleEpochs(): Promise<void> {
		for (const entry of await readdir(this.#epochsRoot, { withFileTypes: true })) {
			const entryPath = path.join(this.#epochsRoot, entry.name);
			const metadata = await lstat(entryPath);
			if (!metadata.isDirectory() || metadata.isSymbolicLink())
				fail("unsafe_layout", "Epoch entry is unsafe");
			if (TOMBSTONE_RE.test(entry.name)) {
				await this.#remove(entryPath, { recursive: true, force: false });
				continue;
			}
			if (!DIGEST_RE.test(entry.name)) fail("unsafe_layout", "Epoch entry is malformed");
			if (entryPath === this.#epochRoot) continue;
			const tombstone = path.join(this.#epochsRoot, `.tombstone-${randomUUID()}`);
			await this.#rename(entryPath, tombstone);
			await this.#remove(tombstone, { recursive: true, force: false });
		}
	}

	async #ensureEpochMarker(): Promise<void> {
		const markerPath = path.join(this.#epochRoot, "epoch");
		let handle: FileHandle | undefined;
		try {
			handle = await this.#openFile(markerPath, "wx", FILE_MODE);
			await handle.writeFile(this.#serverEpoch, "utf8");
			await handle.chmod(FILE_MODE);
			await handle.close();
			handle = undefined;
		} catch (error) {
			await handle?.close().catch(() => {});
			if (!errno(error, "EEXIST")) throw error;
			const metadata = await lstat(markerPath);
			if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 128) {
				fail("unsafe_layout", "Epoch marker is unsafe");
			}
			if ((await readBoundedFile(markerPath, 128, "unsafe_layout")) !== this.#serverEpoch)
				fail("unsafe_layout", "Epoch marker mismatches");
		}
	}

	async #scanCurrentEpoch(): Promise<void> {
		let bytes = 0;
		let items = 0;
		for (const entry of await readdir(this.#blobsRoot, { withFileTypes: true })) {
			const entryPath = path.join(this.#blobsRoot, entry.name);
			if (TOMBSTONE_RE.test(entry.name)) {
				const metadata = await lstat(entryPath);
				if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
					fail("unsafe_layout", "Blob tombstone is unsafe");
				}
				await this.#remove(entryPath, { recursive: true, force: false });
				continue;
			}
			if (TEMP_RE.test(entry.name)) {
				await this.#removePlainTemp(entryPath);
				continue;
			}
			if (!DIGEST_RE.test(entry.name)) fail("unsafe_layout", "Blob entry is malformed");
			await secureExistingDirectory(entryPath, this.#openFile);
			for (const child of (await readdir(entryPath)).filter((name) => TEMP_RE.test(name))) {
				await this.#removePlainTemp(path.join(entryPath, child));
			}
			const remaining = await readdir(entryPath);
			if (
				remaining.length === 0 ||
				(remaining.length === 1 && (remaining[0] === CONTENT_FILE || remaining[0] === MANIFEST_FILE))
			) {
				const tombstone = path.join(this.#blobsRoot, `.tombstone-${randomUUID()}`);
				await this.#rename(entryPath, tombstone);
				await this.#remove(tombstone, { recursive: true, force: false });
				continue;
			}
			if (remaining.length !== 2 || !remaining.includes(CONTENT_FILE) || !remaining.includes(MANIFEST_FILE)) {
				fail("unsafe_layout", "Blob digest directory is incomplete");
			}
			const manifest = await this.#readManifest(entry.name, "unsafe_layout");
			if (!manifest.published) {
				await this.#remove(entryPath, { recursive: true, force: false });
				continue;
			}
			const verified = await this.#verifyBlob(manifest.ref, undefined, "unsafe_layout");
			if (verified.bytes !== manifest.ref.byteLength || verified.digest !== manifest.ref.sha256) {
				fail("unsafe_layout", "Stored blob does not match its manifest");
			}
			bytes += verified.bytes;
			items += 1;
			if (bytes > this.#limits.maxCacheBytes || items > this.#limits.maxCacheItems) {
				fail("unsafe_layout", "Existing content exceeds cache limits");
			}
			this.#entries.set(entry.name, {
				ref: manifest.ref,
				published: true,
				holds: 0,
				pins: 0,
				deleting: false,
			});
		}
		this.#bytes = bytes;
		this.#items = items;
	}

	async #stageInternal(input: EpochContentPutInput): Promise<StagedEpochContent> {
		this.#validateInput(input);
		const reservation = this.#reserve(input.expectedByteLength ?? this.#limits.maxBlobBytes);
		const signal = input.signal
			? AbortSignal.any([input.signal, this.#lifecycleAbort.signal])
			: this.#lifecycleAbort.signal;
		const stagedPath = path.join(this.#blobsRoot, `.tmp-${randomUUID()}`);
		this.#temporaryPaths.add(stagedPath);
		let bytes = 0;
		let stagedHandle: FileHandle | undefined;
		const hash = createHash("sha256");
		try {
			signal.throwIfAborted();
			stagedHandle = await this.#openFile(
				stagedPath,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
				FILE_MODE,
			);
			await stagedHandle.chmod(FILE_MODE);
			if (input.source.errored) throw input.source.errored;
			const readable = addAbortSignal(signal, input.source);
			for await (const chunk of readable) {
				signal.throwIfAborted();
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				bytes += buffer.byteLength;
				if (input.expectedByteLength !== undefined && bytes > input.expectedByteLength) {
					fail("declared_length_mismatch", "Blob exceeds its declared length");
				}
				if (bytes > this.#limits.maxBlobBytes) {
					throw new EpochContentStoreError("blob_too_large", "Blob exceeds its limit", {
						limit: this.#limits.maxBlobBytes,
						actual: bytes,
					});
				}
				hash.update(buffer);
				let offset = 0;
				while (offset < buffer.byteLength) {
					const { bytesWritten } = await stagedHandle.write(buffer, offset, buffer.byteLength - offset);
					if (bytesWritten <= 0) fail("io_failure", "Content store write made no progress");
					offset += bytesWritten;
				}
			}
			await stagedHandle.sync();
			await stagedHandle.close();
			stagedHandle = undefined;
			if (bytes === 0) fail("empty_blob", "Empty blobs are not supported");
			if (input.expectedByteLength !== undefined && bytes !== input.expectedByteLength) {
				fail("declared_length_mismatch", "Blob does not match its declared length");
			}
			const digest = hash.digest("hex");
			if (input.expectedSha256 !== undefined && digest !== input.expectedSha256) {
				fail("declared_digest_mismatch", "Blob does not match its declared digest");
			}
			signal.throwIfAborted();
			const ref = immutableRef({
				type: "attachment_ref",
				serverEpoch: this.#serverEpoch,
				sha256: digest,
				mediaType: input.mediaType,
				byteLength: bytes,
			});
			return await this.#withDigestLock(digest, () =>
				this.#commitStage(stagedPath, ref, reservation, signal),
			);
		} finally {
			await stagedHandle?.close().catch(() => {});
			this.#rollbackReservation(reservation);
			await unlink(stagedPath).catch(() => {});
			this.#temporaryPaths.delete(stagedPath);
		}
	}

	async #withOwnedStageSource<T>(
		operation: Promise<T>,
		source: Readable | undefined,
		observeSourceError: () => void,
	): Promise<T> {
		try {
			return await operation;
		} finally {
			if (source) {
				const settled = finished(source, { cleanup: true, readable: true, writable: false }).catch(() => {});
				if (!source.destroyed) source.destroy();
				await settled;
				source.off("error", observeSourceError);
			}
		}
	}

	async #commitStage(
		stagedPath: string,
		ref: SessionAttachmentRefDto,
		reservation: Reservation,
		signal: AbortSignal,
	): Promise<StagedEpochContent> {
		signal.throwIfAborted();
		const existing = this.#entries.get(ref.sha256);
		if (existing) {
			if (existing.deleting || !refsEqual(existing.ref, ref))
				fail("manifest_mismatch", "Digest metadata differs");
			await this.#verifyEntry(existing.ref, undefined, existing.published);
			this.#rollbackReservation(reservation);
			return Object.freeze({ ref: existing.ref, hold: this.#createHold(existing) });
		}
		if (await this.#digestPathExists(ref.sha256)) fail("digest_collision", "Unowned digest path exists");
		const directory = this.#blobDirectory(ref.sha256);
		const innerTemp = path.join(directory, `.tmp-${randomUUID()}`);
		let directoryOwned = false;
		try {
			await mkdir(directory, { mode: DIRECTORY_MODE });
			directoryOwned = true;
			await secureExistingDirectory(directory, this.#openFile);
			this.#temporaryPaths.add(innerTemp);
			await this.#rename(stagedPath, innerTemp);
			this.#temporaryPaths.delete(stagedPath);
			signal.throwIfAborted();
			await this.#rename(innerTemp, this.#blobPath(ref.sha256));
			this.#temporaryPaths.delete(innerTemp);
			signal.throwIfAborted();
			await this.#writeManifest(ref.sha256, { version: 1, published: false, ref });
			signal.throwIfAborted();
			const entry: Entry = { ref, published: false, holds: 0, pins: 0, deleting: false };
			this.#entries.set(ref.sha256, entry);
			this.#commitReservation(reservation, ref.byteLength);
			return Object.freeze({ ref: entry.ref, hold: this.#createHold(entry) });
		} catch (error) {
			this.#temporaryPaths.delete(innerTemp);
			if (directoryOwned) await this.#remove(directory, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
	}

	async #publishInternal(hold: EpochContentHold, token: TokenState): Promise<void> {
		await this.#withDigestLock(token.digest, async () => {
			if (!token.active) fail("invalid_handle", "Content hold is inactive");
			const entry = this.#entries.get(token.digest);
			if (!entry || entry.deleting || !refsEqual(entry.ref, hold.ref))
				fail("invalid_handle", "Content hold is stale");
			if (entry.published) return;
			await this.#verifyEntry(entry.ref, undefined, false);
			await this.#writeManifest(token.digest, { version: 1, published: true, ref: entry.ref });
			entry.published = true;
		});
	}

	async #pinInternal(ref: SessionAttachmentRefDto, callerSignal?: AbortSignal): Promise<PinnedEpochContent> {
		const entry = this.#entries.get(ref.sha256);
		if (!entry || entry.deleting) fail("not_found", "Attachment content is unavailable");
		if (!refsEqual(entry.ref, ref)) fail("manifest_mismatch", "Attachment metadata differs");
		if (!entry.published) fail("not_published", "Attachment is not published");
		entry.pins += 1;
		const signal = callerSignal
			? AbortSignal.any([callerSignal, this.#lifecycleAbort.signal])
			: this.#lifecycleAbort.signal;
		try {
			signal.throwIfAborted();
			await this.#verifyManifest(ref, true);
			let handle: FileHandle | undefined = await this.#openVerifiedBlob(ref, signal);
			try {
				let stream = handle.createReadStream({ autoClose: true, start: 0, end: ref.byteLength - 1 });
				stream = addAbortSignal(signal, stream);
				handle = undefined;
				const pin = Object.freeze({ ref: entry.ref }) satisfies EpochContentPin;
				this.#tokens.set(pin, { kind: "pin", digest: ref.sha256, active: true, stream });
				this.#tokenObjects.add(pin);
				this.#track(finished(stream).finally(() => this.release(pin)));
				return Object.freeze({ ref: entry.ref, stream, pin });
			} finally {
				await handle?.close().catch(() => {});
			}
		} catch (error) {
			entry.pins = Math.max(0, entry.pins - 1);
			throw error;
		}
	}

	async #releaseInternal(handle: EpochContentHold | EpochContentPin, token: TokenState): Promise<void> {
		if (!token.active) return;
		token.active = false;
		this.#tokenObjects.delete(handle);
		if (token.kind === "pin") token.stream?.destroy();
		let releasedEntry: Entry | undefined;
		try {
			await this.#withDigestLock(token.digest, async () => {
				const entry = this.#entries.get(token.digest);
				if (!entry) return;
				releasedEntry = entry;
				if (token.kind === "hold") entry.holds = Math.max(0, entry.holds - 1);
				else entry.pins = Math.max(0, entry.pins - 1);
				if (!entry.published && entry.holds === 0 && entry.pins === 0 && !entry.deleting) {
					entry.deleting = true;
					await this.#deleteEntry(token.digest, entry);
				}
			});
		} catch (error) {
			if (releasedEntry && this.#entries.get(token.digest) === releasedEntry) {
				if (token.kind === "hold") releasedEntry.holds += 1;
				else releasedEntry.pins += 1;
				releasedEntry.deleting = false;
				token.active = true;
				this.#tokenObjects.add(handle);
			}
			throw error;
		}
	}

	async #gcInternal(candidates: Array<[string, Entry]>): Promise<{ bytes: number; items: number }> {
		const cleaned = await this.#cleanupBlobTombstones();
		let bytes = cleaned.bytes;
		let items = cleaned.items;
		for (const [digest, entry] of candidates) {
			try {
				await this.#withDigestLock(digest, async () => {
					if (entry.deleting || entry.holds !== 0 || entry.pins !== 0 || !entry.published) return;
					entry.deleting = true;
					const deleted = await this.#deleteEntry(digest, entry);
					bytes += deleted.bytes;
					items += deleted.items;
				});
			} catch (error) {
				if (this.#entries.get(digest) === entry) entry.deleting = false;
				throw error;
			}
		}
		return { bytes, items };
	}

	async #deleteEntry(digest: string, entry: Entry): Promise<{ bytes: number; items: number }> {
		return this.#withTombstoneLock(async () => {
			if (this.#entries.get(digest) !== entry) return { bytes: 0, items: 0 };
			const tombstone = path.join(this.#blobsRoot, `.tombstone-${randomUUID()}`);
			await this.#rename(this.#blobDirectory(digest), tombstone);
			this.#entries.delete(digest);
			this.#tombstones.set(tombstone, { bytes: entry.ref.byteLength, items: 1 });
			return this.#removeTrackedTombstone(tombstone);
		});
	}

	async #cleanupBlobTombstones(): Promise<{ bytes: number; items: number }> {
		return this.#withTombstoneLock(async () => {
			let bytes = 0;
			let items = 0;
			for (const name of await readdir(this.#blobsRoot)) {
				if (!TOMBSTONE_RE.test(name)) continue;
				const tombstone = path.join(this.#blobsRoot, name);
				const metadata = await lstat(tombstone);
				if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
					fail("unsafe_layout", "Blob tombstone is unsafe");
				}
				const removed = await this.#removeTrackedTombstone(tombstone);
				bytes += removed.bytes;
				items += removed.items;
			}
			return { bytes, items };
		});
	}

	async #removeTrackedTombstone(tombstone: string): Promise<{ bytes: number; items: number }> {
		await this.#remove(tombstone, { recursive: true, force: false });
		const retained = this.#tombstones.get(tombstone);
		if (!retained) return { bytes: 0, items: 0 };
		this.#tombstones.delete(tombstone);
		this.#bytes -= retained.bytes;
		this.#items -= retained.items;
		return retained;
	}

	async #writeManifest(digest: string, manifest: Manifest): Promise<void> {
		const temporaryPath = path.join(this.#blobDirectory(digest), `.tmp-${randomUUID()}`);
		this.#temporaryPaths.add(temporaryPath);
		let handle: FileHandle | undefined;
		try {
			handle = await this.#openFile(temporaryPath, "wx", FILE_MODE);
			await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
			await handle.chmod(FILE_MODE);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.#rename(temporaryPath, this.#manifestPath(digest));
			this.#temporaryPaths.delete(temporaryPath);
		} finally {
			await handle?.close().catch(() => {});
			await unlink(temporaryPath).catch(() => {});
			this.#temporaryPaths.delete(temporaryPath);
		}
	}

	async #readManifest(digest: string, errorCode: "unsafe_layout" | "manifest_mismatch"): Promise<Manifest> {
		let metadata: FileStats;
		try {
			metadata = await lstat(this.#manifestPath(digest));
		} catch (error) {
			if (errno(error, "ENOENT")) fail(errorCode, "Content manifest is missing");
			throw error;
		}
		if (
			!metadata.isFile() ||
			metadata.isSymbolicLink() ||
			metadata.size <= 0 ||
			metadata.size > MAX_MANIFEST_BYTES
		) {
			fail(errorCode, "Content manifest is unsafe");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readBoundedFile(this.#manifestPath(digest), MAX_MANIFEST_BYTES, errorCode));
		} catch {
			fail(errorCode, "Content manifest is invalid");
		}
		if (!isManifest(parsed) || parsed.ref.serverEpoch !== this.#serverEpoch || parsed.ref.sha256 !== digest) {
			fail(errorCode, "Content manifest has the wrong identity");
		}
		return Object.freeze({ ...parsed, ref: immutableRef(parsed.ref) });
	}

	async #verifyEntry(
		ref: SessionAttachmentRefDto,
		signal?: AbortSignal,
		expectedPublished?: boolean,
	): Promise<void> {
		await this.#verifyManifest(ref, expectedPublished);
		await this.#verifyBlob(ref, signal);
	}

	async #verifyManifest(ref: SessionAttachmentRefDto, expectedPublished?: boolean): Promise<void> {
		const manifest = await this.#readManifest(ref.sha256, "manifest_mismatch");
		if (!refsEqual(manifest.ref, ref)) fail("manifest_mismatch", "Content manifest metadata differs");
		if (expectedPublished !== undefined && manifest.published !== expectedPublished) {
			fail("manifest_mismatch", "Content manifest publication state differs");
		}
	}

	async #verifyBlob(
		ref: SessionAttachmentRefDto,
		signal?: AbortSignal,
		errorCode: "digest_collision" | "unsafe_layout" = "digest_collision",
	): Promise<{ digest: string; bytes: number }> {
		let handle: FileHandle | undefined;
		try {
			handle = await this.#openVerifiedBlob(ref, signal, errorCode);
			return { digest: ref.sha256, bytes: ref.byteLength };
		} finally {
			await handle?.close().catch(() => {});
		}
	}

	async #openVerifiedBlob(
		ref: SessionAttachmentRefDto,
		signal?: AbortSignal,
		errorCode: "digest_collision" | "unsafe_layout" = "digest_collision",
	): Promise<FileHandle> {
		let handle: FileHandle | undefined;
		try {
			handle = await this.#openFile(
				this.#blobPath(ref.sha256),
				fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
			);
			const before = await handle.stat();
			if (!before.isFile() || before.size <= 0 || before.size > this.#limits.maxBlobBytes) {
				fail(errorCode, "Blob file is unsafe");
			}
			let readable = handle.createReadStream({
				autoClose: false,
				start: 0,
				end: this.#limits.maxBlobBytes,
			});
			if (signal) readable = addAbortSignal(signal, readable);
			const verified = await hashReadable(readable);
			const after = await handle.stat();
			if (
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				before.size !== after.size ||
				verified.bytes !== ref.byteLength ||
				verified.digest !== ref.sha256
			) {
				fail(errorCode, "Blob content identity differs");
			}
			await handle.chmod(FILE_MODE);
			const verifiedHandle = handle;
			handle = undefined;
			return verifiedHandle;
		} catch (error) {
			if (errno(error, "ENOENT")) fail("not_found", "Attachment content is unavailable");
			if (errno(error, "ELOOP")) fail("unsafe_path", "Blob symlinks are forbidden");
			throw error;
		} finally {
			await handle?.close().catch(() => {});
		}
	}

	async #digestPathExists(digest: string): Promise<boolean> {
		try {
			await lstat(this.#blobDirectory(digest));
			return true;
		} catch (error) {
			if (errno(error, "ENOENT")) return false;
			throw error;
		}
	}

	async #removePlainTemp(filePath: string): Promise<void> {
		const metadata = await lstat(filePath);
		if (!metadata.isFile() || metadata.isSymbolicLink()) fail("unsafe_layout", "Temporary content is unsafe");
		await unlink(filePath);
	}

	#validateInput(input: EpochContentPutInput): void {
		const probe: SessionAttachmentRefDto = {
			type: "attachment_ref",
			serverEpoch: this.#serverEpoch,
			sha256: "0".repeat(64),
			mediaType: input.mediaType,
			byteLength: 1,
		};
		if (!(input.source instanceof Readable) || !isSessionAttachmentRefDto(probe))
			fail("invalid_ref", "Input is invalid");
		if (input.expectedSha256 !== undefined && !DIGEST_RE.test(input.expectedSha256))
			fail("invalid_ref", "Digest is invalid");
		if (
			input.expectedByteLength !== undefined &&
			(!isPositiveInteger(input.expectedByteLength) || input.expectedByteLength > this.#limits.maxBlobBytes)
		) {
			fail("invalid_ref", "Length is invalid");
		}
	}

	#validateRef(ref: SessionAttachmentRefDto): void {
		if (!isSessionAttachmentRefDto(ref) || ref.byteLength > this.#limits.maxBlobBytes)
			fail("invalid_ref", "Reference is invalid");
		if (ref.serverEpoch !== this.#serverEpoch) fail("epoch_mismatch", "Reference belongs to another epoch");
	}

	#reserve(bytes: number): Reservation {
		const nextBytes = this.#bytes + this.#reservedBytes + bytes;
		if (nextBytes > this.#limits.maxCacheBytes) {
			throw new EpochContentStoreError("cache_bytes_exhausted", "Cache byte quota is exhausted", {
				limit: this.#limits.maxCacheBytes,
				actual: nextBytes,
			});
		}
		const nextItems = this.#items + this.#reservedItems + 1;
		if (nextItems > this.#limits.maxCacheItems) {
			throw new EpochContentStoreError("cache_items_exhausted", "Cache item quota is exhausted", {
				limit: this.#limits.maxCacheItems,
				actual: nextItems,
			});
		}
		this.#reservedBytes += bytes;
		this.#reservedItems += 1;
		return { bytes, active: true };
	}

	#commitReservation(reservation: Reservation, actualBytes: number): void {
		if (!reservation.active) fail("unsafe_layout", "Reservation was already released");
		reservation.active = false;
		this.#reservedBytes -= reservation.bytes;
		this.#reservedItems -= 1;
		this.#bytes += actualBytes;
		this.#items += 1;
	}

	#rollbackReservation(reservation: Reservation): void {
		if (!reservation.active) return;
		reservation.active = false;
		this.#reservedBytes -= reservation.bytes;
		this.#reservedItems -= 1;
	}

	#createHold(entry: Entry): EpochContentHold {
		entry.holds += 1;
		const hold = Object.freeze({ ref: entry.ref }) satisfies EpochContentHold;
		this.#tokens.set(hold, { kind: "hold", digest: entry.ref.sha256, active: true });
		this.#tokenObjects.add(hold);
		return hold;
	}

	#requireToken(handle: EpochContentHold | EpochContentPin, kind: TokenState["kind"]): TokenState {
		const token = this.#tokens.get(handle);
		if (!token?.active || token.kind !== kind) fail("invalid_handle", "Content handle is invalid");
		return token;
	}

	async #withDigestLock<T>(digest: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#digestTails.get(digest) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => current);
		this.#digestTails.set(digest, tail);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.#digestTails.get(digest) === tail) this.#digestTails.delete(digest);
		}
	}

	async #withTombstoneLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#tombstoneTail;
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.#tombstoneTail = previous.then(() => current);
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	#blobDirectory(digest: string): string {
		return path.join(this.#blobsRoot, digest);
	}

	#blobPath(digest: string): string {
		return path.join(this.#blobDirectory(digest), CONTENT_FILE);
	}

	#manifestPath(digest: string): string {
		return path.join(this.#blobDirectory(digest), MANIFEST_FILE);
	}

	#assertReady(): void {
		if (this.#state === "closed") fail("closed", "Content store is closed");
		if (this.#state !== "ready") fail("not_initialized", "Content store is not initialized");
	}

	#isClosed(): boolean {
		return this.#state === "closed";
	}

	#track<T>(operation: Promise<T>): void {
		this.#active.add(operation);
		void operation.finally(() => this.#active.delete(operation)).catch(() => {});
	}

	async #publicOperation<T>(operation: Promise<T>): Promise<T> {
		try {
			return await operation;
		} catch (error) {
			throw normalizeError(error);
		}
	}

	async #releaseLifecycleLock(): Promise<void> {
		const release = this.#releaseLock;
		this.#releaseLock = undefined;
		try {
			await release?.();
		} catch (error) {
			throw normalizeError(error);
		}
	}
}
