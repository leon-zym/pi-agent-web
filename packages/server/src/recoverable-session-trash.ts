import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { sessionHandleForCanonicalFile } from "./native-session-catalog.js";
import { workspaceHandleForPath } from "./session-layout-resolver.js";

const TRASH_ENTRY_RESERVATION_ATTEMPTS = 8;
const STORED_SESSION_FILE = "session.jsonl";
const METADATA_FILE = "metadata.json";
const QUARANTINE_FILE = "quarantine.json";
const MAX_SESSION_HEADER_BYTES = 64 * 1024;

type RenameOperation = (source: string, destination: string) => Promise<void>;

export interface RecoverableSessionTrashMetadata {
	version: 1;
	trashId: string;
	trashedAt: string;
	originalSessionFile: string;
	sessionHandle: string;
	workspaceHandle: string;
	nativeSessionId: string;
	storedFileName: typeof STORED_SESSION_FILE;
	originalFile: {
		name: string;
		size: number;
		mode: number;
		mtimeMs: number;
	};
}

export interface RecoverableSessionTrashResult {
	trashId: string;
	entryDirectory: string;
	sessionFile: string;
	metadataFile: string;
}

export interface RecoverableSessionTrashTarget {
	sessionHandle: string;
	workspaceHandle: string;
	nativeSessionId: string;
	sessionFile: string;
}

export interface RecoverableSessionTrashOptions {
	now?: () => number;
	randomId?: () => string;
	/** Dependency seam used to prove that EXDEV is never handled with copy-and-unlink. */
	rename?: RenameOperation;
}

/**
 * Moves native Pi Session files into gateway-owned recoverable storage.
 *
 * The source-to-trash rename is the only file mutation. It is atomic when the
 * source and web data directory share a filesystem. An EXDEV error is surfaced
 * without a copy-and-unlink fallback because that fallback can lose the source
 * after a partial copy or process crash.
 */
export class RecoverableSessionTrash {
	readonly rootDirectory: string;
	private readonly now: () => number;
	private readonly randomId: () => string;
	private readonly rename: RenameOperation;

	constructor(webDataDir: string, options: RecoverableSessionTrashOptions = {}) {
		this.rootDirectory = path.join(path.resolve(webDataDir), "trash", "sessions");
		this.now = options.now ?? Date.now;
		this.randomId = options.randomId ?? randomUUID;
		this.rename = options.rename ?? fs.promises.rename;
	}

	async move(target: RecoverableSessionTrashTarget): Promise<RecoverableSessionTrashResult> {
		const source = path.resolve(target.sessionFile);
		if (path.extname(source) !== ".jsonl") {
			throw new Error("recoverable trash accepts only JSONL Session files");
		}

		let sourceDescriptor: FileHandle | undefined;
		let sourceStat: fs.Stats;
		try {
			const pathStat = await fs.promises.lstat(source);
			const canonical = await fs.promises.realpath(source);
			if (!pathStat.isFile() || canonical !== source) {
				throw new Error("recoverable trash source must be a canonical regular file");
			}
			if (sessionHandleForCanonicalFile(canonical) !== target.sessionHandle) {
				throw new Error("recoverable trash Session handle does not match its canonical file");
			}
			sourceDescriptor = await fs.promises.open(
				source,
				fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
			);
			sourceStat = await sourceDescriptor.stat();
			if (!sameStableFile(pathStat, sourceStat)) {
				throw new Error("recoverable trash source identity changed while it was opened");
			}
			await assertNativeHeaderIdentity(sourceDescriptor, target);
		} catch (error) {
			await sourceDescriptor?.close().catch(() => undefined);
			if (error instanceof Error && error.message.includes("canonical regular file")) throw error;
			throw new Error(`unable to inspect recoverable trash source: ${errorText(error)}`, {
				cause: error,
			});
		}

		try {
			await fs.promises.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
			await fs.promises.chmod(this.rootDirectory, 0o700);
			const trashedAt = new Date(this.now());
			if (!Number.isFinite(trashedAt.getTime())) {
				throw new Error("recoverable trash timestamp is invalid");
			}
			const reservation = await this.reserveEntry(trashedAt);
			const sessionFile = path.join(reservation.entryDirectory, STORED_SESSION_FILE);
			const metadataFile = path.join(reservation.entryDirectory, METADATA_FILE);
			const metadata: RecoverableSessionTrashMetadata = {
				version: 1,
				trashId: reservation.trashId,
				trashedAt: trashedAt.toISOString(),
				originalSessionFile: source,
				sessionHandle: target.sessionHandle,
				workspaceHandle: target.workspaceHandle,
				nativeSessionId: target.nativeSessionId,
				storedFileName: STORED_SESSION_FILE,
				originalFile: {
					name: path.basename(source),
					size: sourceStat.size,
					mode: sourceStat.mode & 0o777,
					mtimeMs: sourceStat.mtimeMs,
				},
			};

			let keepEntry = false;
			try {
				await writeExclusiveJson(metadataFile, metadata);
				const beforeMove = await fs.promises.lstat(source);
				if (!sameStableFile(sourceStat, beforeMove)) {
					throw new Error("recoverable trash source identity changed before the atomic move");
				}
				try {
					await this.rename(source, sessionFile);
					keepEntry = true;
				} catch (error) {
					if (errorCode(error) === "EXDEV") {
						throw new Error(
							"recoverable trash requires the Session file and web data directory to share the same filesystem",
							{ cause: error },
						);
					}
					throw error;
				}

				const movedStat = await fs.promises.lstat(sessionFile);
				if (!sameStableFile(sourceStat, movedStat)) {
					keepEntry = !(await restoreWithoutOverwrite(sessionFile, source));
					if (keepEntry) {
						await writeQuarantineRecord(reservation.entryDirectory, target, "moved inode mismatch");
					}
					throw new Error("recoverable trash source identity changed during the atomic move");
				}
				try {
					await assertNativeHeaderIdentity(sourceDescriptor, target);
				} catch (error) {
					keepEntry = !(await restoreWithoutOverwrite(sessionFile, source));
					if (keepEntry) {
						await writeQuarantineRecord(
							reservation.entryDirectory,
							target,
							`moved Header mismatch: ${errorText(error)}`,
						);
					}
					throw error;
				}
				fsyncDirectoryBestEffort(reservation.entryDirectory);
				fsyncDirectoryBestEffort(path.dirname(source));
				return {
					trashId: reservation.trashId,
					entryDirectory: reservation.entryDirectory,
					sessionFile,
					metadataFile,
				};
			} finally {
				if (!keepEntry) {
					await fs.promises
						.rm(reservation.entryDirectory, { recursive: true, force: true })
						.catch(() => undefined);
					fsyncDirectoryBestEffort(this.rootDirectory);
				}
			}
		} finally {
			await sourceDescriptor.close().catch(() => undefined);
		}
	}

	private async reserveEntry(trashedAt: Date): Promise<{ trashId: string; entryDirectory: string }> {
		const timestamp = trashedAt.toISOString().replaceAll(":", "-").replace(".", "-");
		for (let attempt = 0; attempt < TRASH_ENTRY_RESERVATION_ATTEMPTS; attempt += 1) {
			const trashId = `${timestamp}_${safeId(this.randomId())}`;
			const entryDirectory = path.join(this.rootDirectory, trashId);
			try {
				await fs.promises.mkdir(entryDirectory, { mode: 0o700 });
				fsyncDirectoryBestEffort(this.rootDirectory);
				return { trashId, entryDirectory };
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
			}
		}
		throw new Error("unable to reserve a unique trash entry");
	}
}

async function writeExclusiveJson(filePath: string, metadata: unknown): Promise<void> {
	const descriptor = await fs.promises.open(filePath, "wx", 0o600);
	try {
		await descriptor.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
		await descriptor.sync();
	} finally {
		await descriptor.close();
	}
}

async function assertNativeHeaderIdentity(
	descriptor: FileHandle,
	target: RecoverableSessionTrashTarget,
): Promise<void> {
	const header = await readSessionHeader(descriptor);
	if (header.id !== target.nativeSessionId) {
		throw new Error("recoverable trash Header id does not match the native Session identity");
	}
	let canonicalCwd: string;
	try {
		canonicalCwd = await fs.promises.realpath(header.cwd);
		const stat = await fs.promises.stat(canonicalCwd);
		if (!stat.isDirectory()) throw new Error("Header cwd is not a directory");
	} catch (error) {
		throw new Error(`recoverable trash Header cwd is unavailable: ${errorText(error)}`, {
			cause: error,
		});
	}
	if (workspaceHandleForPath(canonicalCwd) !== target.workspaceHandle) {
		throw new Error("recoverable trash Header cwd does not match the Workspace identity");
	}
}

async function readSessionHeader(descriptor: FileHandle): Promise<{ id: string; cwd: string }> {
	const buffer = Buffer.allocUnsafe(MAX_SESSION_HEADER_BYTES);
	let length = 0;
	for (;;) {
		if (length >= buffer.length) throw new Error("Pi Session Header exceeds the safe size limit");
		const { bytesRead } = await descriptor.read(buffer, length, buffer.length - length, length);
		if (bytesRead === 0) throw new Error("Pi Session file does not contain a complete Header line");
		length += bytesRead;
		const newline = buffer.subarray(0, length).indexOf(0x0a);
		if (newline < 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "")) as unknown;
		} catch (error) {
			throw new Error(`Pi Session Header is not valid JSON: ${errorText(error)}`, { cause: error });
		}
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			(value as { type?: unknown }).type !== "session" ||
			typeof (value as { id?: unknown }).id !== "string" ||
			typeof (value as { cwd?: unknown }).cwd !== "string"
		) {
			throw new Error("Pi Session Header is missing a valid type, id, or cwd");
		}
		return {
			id: (value as { id: string }).id,
			cwd: (value as { cwd: string }).cwd,
		};
	}
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
	return (
		left.isFile() &&
		right.isFile() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs
	);
}

async function restoreWithoutOverwrite(destination: string, source: string): Promise<boolean> {
	try {
		await fs.promises.link(destination, source);
	} catch {
		return false;
	}
	try {
		await fs.promises.unlink(destination);
		return true;
	} catch {
		// Both hard links remain. Retaining the trash entry avoids data loss.
		return false;
	}
}

async function writeQuarantineRecord(
	entryDirectory: string,
	target: RecoverableSessionTrashTarget,
	reason: string,
): Promise<void> {
	await writeExclusiveJson(path.join(entryDirectory, QUARANTINE_FILE), {
		version: 1,
		state: "identity_mismatch",
		detectedAt: new Date().toISOString(),
		reason,
		expected: target,
	}).catch(() => undefined);
}

function safeId(input: string): string {
	const safe = input.replaceAll(/[^a-zA-Z0-9_-]/g, "");
	if (!safe) throw new Error("recoverable trash id is invalid");
	return safe.slice(0, 128);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fsyncDirectoryBestEffort(directory: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(directory, "r");
		fs.fsyncSync(descriptor);
	} catch {
		// Directory fsync is not available on every supported filesystem.
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}
