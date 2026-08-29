/** Browser-safe limits and integrity helpers for bounded Session history streams. */

import { SESSION_WS_SERVER_MAX_BYTES } from "./payload-budget.js";

export const GATEWAY_SESSION_HISTORY_CAPABILITY = "session.chunked_history";

/** A history chunk remains comfortably below the negotiated server frame ceiling. */
export const SESSION_HISTORY_MAX_CHUNK_BYTES = SESSION_WS_SERVER_MAX_BYTES - 256 * 1024;
/** Total bytes retained by one snapshot/page history stream, including framing headroom. */
export const SESSION_HISTORY_MAX_STREAM_BYTES = SESSION_HISTORY_MAX_CHUNK_BYTES + 256 * 1024;
export const SESSION_HISTORY_MAX_CHUNK_MESSAGES = 256;
export const SESSION_HISTORY_MAX_MESSAGES = 1_000_000;
export const SESSION_HISTORY_MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;
export const SESSION_HISTORY_MAX_CURSOR_BYTES = 1024;
export const SESSION_HISTORY_MAX_SNAPSHOT_ID_BYTES = 128;

const UTF8_ENCODER = new TextEncoder();

function serializedBytes(value: unknown): number {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string"
			? UTF8_ENCODER.encode(serialized).byteLength
			: Number.POSITIVE_INFINITY;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** Exact UTF-8 size of the JSON array carried by one history chunk. */
export function sessionHistoryMessagesBytes(messages: readonly unknown[]): number {
	return serializedBytes(messages);
}

/**
 * Stable, non-cryptographic integrity marker for one chunk or an ordered list
 * of chunk markers. It detects corruption and reordering; it is not auth.
 */
export function sessionHistoryChecksum(value: unknown): string {
	let hash = 0x811c9dc5;
	try {
		const serialized = JSON.stringify(value);
		if (typeof serialized !== "string") return "00000000";
		for (const byte of UTF8_ENCODER.encode(serialized)) {
			hash ^= byte;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, "0");
	} catch {
		return "00000000";
	}
}

export function isSessionHistoryChecksum(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}$/.test(value);
}
