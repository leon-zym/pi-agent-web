import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import {
	SESSION_HISTORY_MAX_CHUNK_BYTES,
	SESSION_HISTORY_MAX_CHUNK_MESSAGES,
	SESSION_HISTORY_MAX_MESSAGES,
	SESSION_HISTORY_MAX_TOTAL_BYTES,
	SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
	SESSION_SNAPSHOT_MAX_BYTES,
} from "@pi-agent-web/protocol";
import { canonicalizePathAllowMissing } from "./session-layout-resolver.js";

const SCAN_BUFFER_BYTES = 64 * 1024;
const DEFAULT_INITIAL_MESSAGE_LIMIT = 96;
const DEFAULT_INITIAL_SOURCE_BYTE_LIMIT = SESSION_SNAPSHOT_MAX_BYTES - 4 * 1024 * 1024;

export type SessionHistoryErrorCode =
	| "session_history_cancelled"
	| "session_history_changed"
	| "session_history_invalid_header"
	| "session_history_invalid_entry"
	| "session_history_invalid_cursor"
	| "session_history_too_large";

export class SessionHistoryError extends Error {
	readonly code: SessionHistoryErrorCode;

	constructor(code: SessionHistoryErrorCode, message: string) {
		super(message);
		this.name = "SessionHistoryError";
		this.code = code;
	}
}

interface SessionHistoryFingerprint {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

interface SessionHistoryRecord {
	offset: number;
	length: number;
	id: string;
	parentId: string | null;
	type: string;
	messageCount: number;
	byteLength: number;
	startsTurn: boolean;
	firstKeptEntryId?: string;
}

export interface NativeSessionHistorySlice {
	entries: SessionEntry[];
	itemCount: number;
	nextCursor: string | null;
}

export interface NativeSessionHistoryScanOptions {
	expectedNativeSessionId?: string;
	expectedCwd?: string;
	initialMessageLimit?: number;
	initialSourceByteLimit?: number;
	maxSourceBytes?: number;
	maxLineBytes?: number;
}

export class NativeSessionHistoryPlan {
	readonly planId = randomUUID();
	readonly totalMessages: number;
	readonly totalBytes: number;
	readonly initialStart: number;
	readonly initialCursor: string | null;
	readonly sessionFile: string;

	private readonly records: readonly SessionHistoryRecord[];
	private readonly fingerprint: SessionHistoryFingerprint;

	constructor(args: {
		sessionFile: string;
		fingerprint: SessionHistoryFingerprint;
		records: readonly SessionHistoryRecord[];
		initialStart: number;
		totalMessages: number;
	}) {
		this.sessionFile = args.sessionFile;
		this.fingerprint = args.fingerprint;
		this.records = args.records;
		this.initialStart = args.initialStart;
		this.totalMessages = args.totalMessages;
		this.totalBytes = Number(args.fingerprint.size);
		this.initialCursor = this.encodeCursor(args.initialStart);
	}

	async readInitial(signal?: AbortSignal): Promise<NativeSessionHistorySlice> {
		return this.readRange(this.initialStart, this.records.length, signal);
	}

	async readPage(
		cursor: string,
		limit = SESSION_HISTORY_MAX_CHUNK_MESSAGES,
		signal?: AbortSignal,
	): Promise<NativeSessionHistorySlice> {
		throwIfAborted(signal);
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > SESSION_HISTORY_MAX_CHUNK_MESSAGES) {
			throw new SessionHistoryError("session_history_invalid_cursor", "history page limit is invalid");
		}
		const end = this.decodeCursor(cursor);
		let start = end;
		let remaining = limit;
		let sourceBytes = 0;
		while (start > 0 && remaining > 0) {
			const record = this.records[start - 1]!;
			if (sourceBytes + record.byteLength > SESSION_HISTORY_MAX_CHUNK_BYTES) {
				if (sourceBytes === 0) {
					throw new SessionHistoryError(
						"session_history_too_large",
						"native Session history page contains an oversized entry",
					);
				}
				break;
			}
			start -= 1;
			remaining -= record.messageCount;
			sourceBytes += record.byteLength;
		}
		while (start > 0 && !this.records[start]!.startsTurn) {
			const record = this.records[start - 1]!;
			if (sourceBytes + record.byteLength > SESSION_HISTORY_MAX_CHUNK_BYTES) break;
			start -= 1;
			sourceBytes += record.byteLength;
		}
		return this.readRange(start, end, signal);
	}

	/** Check the persisted source without retaining or reading its contents. */
	isSourceCurrent(): boolean {
		try {
			const stats = statSync(this.sessionFile, { bigint: true });
			return (
				stats.isFile() &&
				stats.dev === this.fingerprint.dev &&
				stats.ino === this.fingerprint.ino &&
				stats.size === this.fingerprint.size &&
				stats.mtimeNs === this.fingerprint.mtimeNs &&
				stats.ctimeNs === this.fingerprint.ctimeNs
			);
		} catch {
			return false;
		}
	}

	private decodeCursor(cursor: string): number {
		try {
			const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
				planId?: unknown;
				start?: unknown;
			};
			if (
				parsed.planId !== this.planId ||
				typeof parsed.start !== "number" ||
				!Number.isSafeInteger(parsed.start) ||
				parsed.start <= 0 ||
				parsed.start > this.records.length
			) {
				throw new Error("invalid cursor");
			}
			return parsed.start;
		} catch {
			throw new SessionHistoryError("session_history_invalid_cursor", "history cursor is invalid");
		}
	}

	private encodeCursor(start: number): string | null {
		if (start <= 0) return null;
		return Buffer.from(JSON.stringify({ planId: this.planId, start }), "utf8").toString("base64url");
	}

	private async readRange(
		start: number,
		end: number,
		signal?: AbortSignal,
	): Promise<NativeSessionHistorySlice> {
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 0 ||
			end < start ||
			end > this.records.length
		) {
			throw new SessionHistoryError("session_history_invalid_cursor", "history range is invalid");
		}
		throwIfAborted(signal);
		const handle = await open(this.sessionFile, "r");
		try {
			assertFingerprint(await fingerprintFor(handle), this.fingerprint);
			const entries: SessionEntry[] = [];
			for (let index = start; index < end; index += 1) {
				throwIfAborted(signal);
				entries.push(await readEntry(handle, this.records[index]!, signal));
			}
			assertFingerprint(await fingerprintFor(handle), this.fingerprint);
			return {
				entries,
				itemCount: this.records.slice(start, end).reduce((total, record) => total + record.messageCount, 0),
				nextCursor: this.encodeCursor(start),
			};
		} finally {
			await handle.close();
		}
	}
}

export async function scanNativeSessionHistory(
	sessionFile: string,
	options: NativeSessionHistoryScanOptions = {},
	signal?: AbortSignal,
): Promise<NativeSessionHistoryPlan> {
	const maxSourceBytes = options.maxSourceBytes ?? SESSION_HISTORY_MAX_TOTAL_BYTES;
	const maxLineBytes = options.maxLineBytes ?? SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES;
	const initialMessageLimit = options.initialMessageLimit ?? DEFAULT_INITIAL_MESSAGE_LIMIT;
	const initialSourceByteLimit = options.initialSourceByteLimit ?? DEFAULT_INITIAL_SOURCE_BYTE_LIMIT;
	if (
		!Number.isSafeInteger(maxSourceBytes) ||
		maxSourceBytes <= 0 ||
		maxSourceBytes > SESSION_HISTORY_MAX_TOTAL_BYTES ||
		!Number.isSafeInteger(maxLineBytes) ||
		maxLineBytes <= 0 ||
		maxLineBytes > SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES ||
		!Number.isSafeInteger(initialMessageLimit) ||
		initialMessageLimit <= 0 ||
		initialMessageLimit > SESSION_HISTORY_MAX_CHUNK_MESSAGES ||
		!Number.isSafeInteger(initialSourceByteLimit) ||
		initialSourceByteLimit <= 0 ||
		initialSourceByteLimit > SESSION_HISTORY_MAX_CHUNK_BYTES
	) {
		throw new SessionHistoryError("session_history_too_large", "history reader limits are invalid");
	}

	throwIfAborted(signal);
	const handle = await open(sessionFile, "r");
	try {
		const initialFingerprint = await fingerprintFor(handle);
		if (initialFingerprint.size > BigInt(maxSourceBytes)) {
			throw new SessionHistoryError(
				"session_history_too_large",
				"native Session history exceeds the bounded source limit",
			);
		}
		const records: SessionHistoryRecord[] = [];
		const byId = new Map<string, SessionHistoryRecord>();
		let header: SessionHeader | null = null;
		let lineStart = 0;
		let lineBytes = 0;
		let lineParts: Buffer[] = [];
		let readOffset = 0;
		const buffer = Buffer.allocUnsafe(SCAN_BUFFER_BYTES);

		const processLine = (line: Buffer, offset: number): void => {
			throwIfAborted(signal);
			if (line.toString("utf8").trim().length === 0) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line.toString("utf8")) as unknown;
			} catch {
				return;
			}
			if (header === null) {
				if (!isSessionHeader(parsed)) {
					throw new SessionHistoryError(
						"session_history_invalid_header",
						"native Session history header is invalid",
					);
				}
				header = parsed;
				if (options.expectedNativeSessionId !== undefined && header.id !== options.expectedNativeSessionId) {
					throw new SessionHistoryError(
						"session_history_invalid_header",
						"native Session id does not match the requested Session",
					);
				}
				if (
					options.expectedCwd !== undefined &&
					canonicalizePathAllowMissing(header.cwd) !== options.expectedCwd
				) {
					throw new SessionHistoryError(
						"session_history_invalid_header",
						"native Session cwd does not match the requested Workspace",
					);
				}
				return;
			}
			if (!isSessionEntry(parsed)) {
				throw new SessionHistoryError(
					"session_history_invalid_entry",
					"native Session history entry is invalid",
				);
			}
			if (byId.has(parsed.id)) {
				throw new SessionHistoryError(
					"session_history_invalid_entry",
					"native Session history contains duplicate entry ids",
				);
			}
			const record: SessionHistoryRecord = {
				offset,
				length: line.length,
				id: parsed.id,
				parentId: parsed.parentId,
				type: parsed.type,
				messageCount: sessionEntryMessageCount(parsed),
				byteLength: line.length,
				startsTurn: sessionEntryStartsTurn(parsed),
				...(parsed.type === "compaction" ? { firstKeptEntryId: parsed.firstKeptEntryId } : {}),
			};
			records.push(record);
			byId.set(record.id, record);
		};

		while (true) {
			throwIfAborted(signal);
			const result = await handle.read(buffer, 0, buffer.length, readOffset);
			if (result.bytesRead === 0) break;
			if (readOffset + result.bytesRead > maxSourceBytes) {
				throw new SessionHistoryError(
					"session_history_too_large",
					"native Session history exceeded the bounded source limit while reading",
				);
			}
			const chunk = buffer.subarray(0, result.bytesRead);
			let cursor = 0;
			while (cursor < chunk.length) {
				const newline = chunk.indexOf(0x0a, cursor);
				const end = newline < 0 ? chunk.length : newline;
				const part = chunk.subarray(cursor, end);
				lineBytes += part.length;
				if (lineBytes > maxLineBytes) {
					throw new SessionHistoryError(
						"session_history_too_large",
						"native Session history contains an oversized JSONL line",
					);
				}
				if (part.length > 0) lineParts.push(Buffer.from(part));
				if (newline < 0) break;
				const line = lineParts.length === 1 ? lineParts[0]! : Buffer.concat(lineParts, lineBytes);
				processLine(line, lineStart);
				lineStart = readOffset + newline + 1;
				lineBytes = 0;
				lineParts = [];
				cursor = newline + 1;
			}
			readOffset += result.bytesRead;
		}
		if (lineBytes > 0) {
			const line = lineParts.length === 1 ? lineParts[0]! : Buffer.concat(lineParts, lineBytes);
			processLine(line, lineStart);
		}
		if (header === null) {
			throw new SessionHistoryError("session_history_invalid_header", "native Session history is empty");
		}
		assertFingerprint(await fingerprintFor(handle), initialFingerprint);
		const contextRecords = activeContextRecords(records, byId);
		const totalMessages = contextRecords.reduce((total, record) => total + record.messageCount, 0);
		if (totalMessages > SESSION_HISTORY_MAX_MESSAGES) {
			throw new SessionHistoryError(
				"session_history_too_large",
				"native Session history contains too many context messages",
			);
		}
		let initialStart = contextRecords.length;
		let remaining = initialMessageLimit;
		let initialSourceBytes = 0;
		while (initialStart > 0 && remaining > 0) {
			const record = contextRecords[initialStart - 1]!;
			if (initialSourceBytes + record.byteLength > initialSourceByteLimit) {
				if (initialSourceBytes === 0) {
					throw new SessionHistoryError(
						"session_history_too_large",
						"native Session history initial page contains an oversized entry",
					);
				}
				break;
			}
			initialStart -= 1;
			remaining -= record.messageCount;
			initialSourceBytes += record.byteLength;
		}
		while (initialStart > 0 && !contextRecords[initialStart]!.startsTurn) {
			const record = contextRecords[initialStart - 1]!;
			if (initialSourceBytes + record.byteLength > initialSourceByteLimit) break;
			initialStart -= 1;
			initialSourceBytes += record.byteLength;
		}
		return new NativeSessionHistoryPlan({
			sessionFile,
			fingerprint: initialFingerprint,
			records: contextRecords,
			initialStart,
			totalMessages,
		});
	} finally {
		await handle.close();
	}
}

function activeContextRecords(
	records: readonly SessionHistoryRecord[],
	byId: ReadonlyMap<string, SessionHistoryRecord>,
): SessionHistoryRecord[] {
	if (records.length === 0) return [];
	const path: SessionHistoryRecord[] = [];
	const seen = new Set<string>();
	let current: SessionHistoryRecord | undefined = records[records.length - 1];
	while (current) {
		if (seen.has(current.id)) {
			throw new SessionHistoryError(
				"session_history_invalid_entry",
				"native Session history contains a parent cycle",
			);
		}
		seen.add(current.id);
		path.push(current);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	path.reverse();
	let compactionIndex = -1;
	for (let index = 0; index < path.length; index += 1) {
		if (path[index]!.type === "compaction") compactionIndex = index;
	}
	if (compactionIndex < 0) return path.filter((record) => record.messageCount > 0);
	const compaction = path[compactionIndex]!;
	const firstKeptEntryId = compaction.firstKeptEntryId;
	if (!firstKeptEntryId) {
		return [compaction, ...path.slice(compactionIndex + 1)].filter((record) => record.messageCount > 0);
	}
	let firstKeptIndex = -1;
	for (let index = 0; index < compactionIndex; index += 1) {
		if (path[index]!.id === firstKeptEntryId) {
			firstKeptIndex = index;
			break;
		}
	}
	return [
		compaction,
		...(firstKeptIndex >= 0 ? path.slice(firstKeptIndex, compactionIndex) : []),
		...path.slice(compactionIndex + 1),
	].filter((record) => record.messageCount > 0);
}

function sessionEntryMessageCount(entry: SessionEntry): number {
	if (entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction") return 1;
	return entry.type === "branch_summary" && typeof entry.summary === "string" && entry.summary.length > 0
		? 1
		: 0;
}

function sessionEntryStartsTurn(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

function isSessionHeader(value: unknown): value is SessionHeader {
	return (
		isRecord(value) &&
		value.type === "session" &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.cwd === "string"
	);
}

function isSessionEntry(value: unknown): value is SessionEntry {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		value.type !== "session" &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		(value.parentId === null || typeof value.parentId === "string")
	);
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readEntry(
	handle: FileHandle,
	record: SessionHistoryRecord,
	signal?: AbortSignal,
): Promise<SessionEntry> {
	throwIfAborted(signal);
	const buffer = Buffer.allocUnsafe(record.length);
	let total = 0;
	while (total < buffer.length) {
		throwIfAborted(signal);
		const result = await handle.read(buffer, total, buffer.length - total, record.offset + total);
		if (result.bytesRead === 0) {
			throw new SessionHistoryError(
				"session_history_changed",
				"native Session history ended during a bounded read",
			);
		}
		total += result.bytesRead;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(buffer.toString("utf8")) as unknown;
	} catch {
		throw new SessionHistoryError(
			"session_history_changed",
			"native Session history changed during a bounded read",
		);
	}
	if (
		!isSessionEntry(parsed) ||
		parsed.id !== record.id ||
		parsed.parentId !== record.parentId ||
		parsed.type !== record.type
	) {
		throw new SessionHistoryError(
			"session_history_changed",
			"native Session history entry identity changed during a bounded read",
		);
	}
	return parsed;
}

async function fingerprintFor(handle: FileHandle): Promise<SessionHistoryFingerprint> {
	const stats = await handle.stat({ bigint: true });
	return {
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
	};
}

function assertFingerprint(actual: SessionHistoryFingerprint, expected: SessionHistoryFingerprint): void {
	if (
		actual.dev !== expected.dev ||
		actual.ino !== expected.ino ||
		actual.size !== expected.size ||
		actual.mtimeNs !== expected.mtimeNs ||
		actual.ctimeNs !== expected.ctimeNs
	) {
		throw new SessionHistoryError(
			"session_history_changed",
			"native Session history changed during a bounded read",
		);
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new SessionHistoryError("session_history_cancelled", "native Session history read was cancelled");
	}
}
