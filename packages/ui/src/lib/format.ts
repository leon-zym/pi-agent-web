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
