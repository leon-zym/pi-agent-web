import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SessionSummary } from "@pi-agent-web/protocol";

/**
 * Session directory scanning (see docs/protocol.md for the storage layout).
 *
 * - Only the first-line SessionHeader is authoritative: read with a 4KB buffer
 *   and a 1MB hard cap (session-manager.ts:571-615). Oversized/corrupt files are
 *   skipped so one bad file never blocks the whole list.
 * - Additionally, a bounded info window (128KB) is scanned for cheap metadata:
 *   session_info.name, message count, first user message text.
 * - modified comes from stat.mtime (official sort key is mtime, not the filename).
 */

const HEADER_READ_BUFFER_SIZE = 4096;
const MAX_HEADER_SCAN_BYTES = 1024 * 1024;
const INFO_WINDOW_BYTES = 128 * 1024;
const FIRST_MESSAGE_MAX_CHARS = 200;
export const SESSION_SCAN_CONCURRENCY = 8;

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface SessionScanOptions {
	/** Receives per-file failures without aborting the whole directory scan. */
	onDiagnostic?: (message: string) => void;
}

interface ScanAccum {
	header?: SessionHeader;
	name?: string;
	messageCount: number;
	firstMessage?: string;
	/** true once the header line has been fully read */
	headerParsed: boolean;
	headerTooLarge: boolean;
}

function extractUserText(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const m = message as { role?: unknown; content?: unknown };
	if (m.role !== "user") return undefined;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		for (const block of m.content) {
			if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
				const text = (block as { text?: unknown }).text;
				if (typeof text === "string") return text;
			}
		}
	}
	return undefined;
}

function applyEntry(acc: ScanAccum, entry: unknown): void {
	if (typeof entry !== "object" || entry === null) return;
	const e = entry as Record<string, unknown>;
	switch (e.type) {
		case "session_info": {
			const name = e.name;
			if (typeof name === "string" && name.length > 0) acc.name = name;
			break;
		}
		case "message": {
			acc.messageCount += 1;
			if (acc.firstMessage === undefined) {
				const text = extractUserText(e.message);
				if (text !== undefined && text.trim().length > 0) {
					acc.firstMessage = text.trim().slice(0, FIRST_MESSAGE_MAX_CHARS);
				}
			}
			break;
		}
		default:
			break;
	}
}

/**
 * Scan a single session file. Returns a SessionSummary or null when the file
 * has no valid header within the scan budget.
 */
export async function scanSessionFile(
	filePath: string,
	expectedCwdRealpath?: string,
): Promise<SessionSummary | null> {
	const stat = await fs.promises.stat(filePath);
	if (!stat.isFile()) return null;
	if (stat.size === 0) return null;

	const fd = await fs.promises.open(filePath, "r");
	const decoder = new StringDecoder("utf8");
	const acc: ScanAccum = { messageCount: 0, headerParsed: false, headerTooLarge: false };

	let scanned = 0;
	let leftover = "";
	try {
		// Phase 1: header line (budget 1MB). Phase 2: entry info window (128KB).
		while (!(acc.headerParsed && scanned >= INFO_WINDOW_BYTES)) {
			const budget = acc.headerParsed ? INFO_WINDOW_BYTES : MAX_HEADER_SCAN_BYTES;
			if (scanned >= budget) break;
			const readLength = Math.min(HEADER_READ_BUFFER_SIZE, budget - scanned);
			const buffer = Buffer.allocUnsafe(readLength);
			const { bytesRead } = await fd.read(buffer, 0, readLength, null);
			if (bytesRead === 0) break;
			scanned += bytesRead;

			let chunk = leftover + decoder.write(buffer.subarray(0, bytesRead));
			leftover = "";
			let newlineIndex = chunk.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = chunk.slice(0, newlineIndex);
				chunk = chunk.slice(newlineIndex + 1);
				newlineIndex = chunk.indexOf("\n");

				if (!acc.headerParsed) {
					try {
						const header = JSON.parse(line) as SessionHeader;
						if (
							header &&
							header.type === "session" &&
							typeof header.id === "string" &&
							typeof header.timestamp === "string" &&
							typeof header.cwd === "string"
						) {
							acc.header = header;
						} else {
							// First line is not a session header: not a session file.
							return null;
						}
					} catch {
						return null;
					}
					acc.headerParsed = true;
					continue;
				}

				try {
					applyEntry(acc, JSON.parse(line));
				} catch {
					// Corrupt middle line: ignore, keep scanning.
				}
			}
			leftover = chunk;
		}
		if (!acc.headerParsed) {
			// Header exceeded the 1MB scan budget: skip this file (session-manager.ts behavior).
			return null;
		}
	} finally {
		await fd.close();
	}

	if (!acc.header) return null;
	if (expectedCwdRealpath !== undefined) {
		try {
			if ((await fs.promises.realpath(acc.header.cwd)) !== expectedCwdRealpath) return null;
		} catch {
			return null;
		}
	}

	return {
		path: path.basename(filePath),
		absolutePath: path.resolve(filePath),
		id: acc.header.id,
		name: acc.name,
		cwd: acc.header.cwd,
		messageCount: acc.messageCount,
		firstMessage: acc.firstMessage,
		created: acc.header.timestamp,
		modified: stat.mtimeMs,
		parentSessionPath: acc.header.parentSession,
	};
}

/**
 * List all sessions in a workspace session dir, sorted by modified desc
 * (official ordering: mtime, not filename).
 */
export async function scanSessionDir(
	sessionDir: string,
	expectedCwdRealpath?: string,
	options: SessionScanOptions = {},
): Promise<SessionSummary[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(sessionDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files = entries
		.filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
		.map((e) => path.join(sessionDir, e.name));

	const summaries = await mapWithConcurrency(files, SESSION_SCAN_CONCURRENCY, async (filePath) => {
		try {
			return await scanSessionFile(filePath, expectedCwdRealpath);
		} catch (error) {
			options.onDiagnostic?.(
				`Skipping unreadable session file ${path.basename(filePath)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		}
	});
	const valid = summaries.filter((s): s is SessionSummary => s !== null);
	valid.sort((a, b) => b.modified - a.modified);
	return valid;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const worker = async () => {
		for (;;) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) return;
			results[index] = await mapper(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}

/**
 * Lineage protection: find sessions whose header references targetPath
 * as parentSession. Used to reject deletion with 409.
 */
export async function findChildSessions(
	sessionDir: string,
	targetAbsolutePath: string,
	expectedCwdRealpath?: string,
): Promise<string[]> {
	const all = await scanSessionDir(sessionDir, expectedCwdRealpath);
	const targetCanonicalPath = await fs.promises
		.realpath(targetAbsolutePath)
		.catch(() => path.resolve(targetAbsolutePath));
	const children = await Promise.all(
		all.map(async (session) => {
			if (session.parentSessionPath === undefined) return undefined;
			const parentCanonicalPath = await fs.promises
				.realpath(session.parentSessionPath)
				.catch(() => path.resolve(session.parentSessionPath!));
			return parentCanonicalPath === targetCanonicalPath ? session.absolutePath : undefined;
		}),
	);
	return children.filter((child): child is string => child !== undefined);
}
