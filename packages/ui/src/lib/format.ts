/**
 * Compact formatting helpers. Numbers use tabular-nums at the call site.
 * Relative time is localized; this module re-exports the i18n implementation
 * for backward-compatible imports.
 */

export { formatRelativeTimeLocal as formatRelativeTime } from "./i18n";

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "--";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
}

export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

export function formatCost(usd: number): string {
	if (usd === 0) return "$0.00";
	if (usd < 0.01) return "<$0.01";
	return `$${usd.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Format a local timestamp without dropping seconds in compact UI tooltips. */
export function formatExactDateTime(timestampMs: number): string {
	if (!Number.isFinite(timestampMs)) return "--";
	const date = new Date(timestampMs);
	if (Number.isNaN(date.getTime())) return "--";
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function consumeControlString(text: string, start: number): number {
	let index = start;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code === 0x07 || code === 0x9c) return index + 1;
		if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2;
		index += 1;
	}
	return index;
}

function consumeControlSequence(text: string, start: number): number {
	let index = start;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		index += 1;
		if (code >= 0x40 && code <= 0x7e) break;
	}
	return index;
}

/**
 * Remove terminal control sequences from display text without mutating the
 * event or projection that supplied it. Handles CSI colors/cursor movement,
 * OSC hyperlinks/titles, DCS-style strings, C0/C1 controls, bidi formatting
 * controls, and short ESC forms. Newlines and tabs remain available to text
 * surfaces; protocol values must retain their raw identity separately.
 */
export function stripAnsi(text: string): string {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code === 0x1b) {
			const next = text.charCodeAt(index + 1);
			if (next === 0x5b) {
				index = consumeControlSequence(text, index + 2);
				continue;
			}
			if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
				index = consumeControlString(text, index + 2);
				continue;
			}
			index += 1;
			while (index < text.length && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x2f) {
				index += 1;
			}
			if (index < text.length) index += 1;
			continue;
		}
		if (code === 0x9b) {
			index = consumeControlSequence(text, index + 1);
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
			index = consumeControlString(text, index + 1);
			continue;
		}
		if (code >= 0x80 && code <= 0x9f) {
			index += 1;
			continue;
		}
		if (
			(code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
			code === 0x7f ||
			code === 0x061c ||
			code === 0x200e ||
			code === 0x200f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			index += 1;
			continue;
		}
		output += text[index];
		index += 1;
	}
	return output;
}

/** Convert an unknown failure into inert display text without reflecting control sequences. */
export function displayError(error: unknown): string {
	return stripAnsi(error instanceof Error ? error.message : String(error));
}

/** Sanitize a single-line label or document title and collapse layout whitespace. */
export function displayLabel(text: string): string {
	return stripAnsi(text).replace(/\s+/gu, " ").trim();
}

/** First non-empty line of a block of text (thinking summaries, tool output). */
export function firstLine(text: string): string {
	const line = text.split("\n").find((l) => l.trim().length > 0);
	return line ? line.trim() : "";
}

/** Last non-empty line, for the streaming thinking sweep. */
export function lastLine(text: string): string {
	for (let i = text.length - 1; i >= 0; i--) {
		if (text[i] === "\n") {
			const line = text.slice(i + 1).trim();
			if (line.length > 0) return line;
		}
	}
	return text.trim();
}
