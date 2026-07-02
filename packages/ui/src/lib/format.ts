/** Compact formatting helpers. Numbers use tabular-nums at the call site. */

export function formatRelativeTime(timestampMs: number, now = Date.now()): string {
	const delta = now - timestampMs;
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days} 天前`;
	const date = new Date(timestampMs);
	const nowDate = new Date(now);
	if (date.getFullYear() === nowDate.getFullYear()) {
		return `${date.getMonth() + 1}月${date.getDate()}日`;
	}
	return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

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
	if (count >= 1_000_000) return (count / 1_000_000).toFixed(2) + "M";
	if (count >= 1_000) return (count / 1_000).toFixed(1) + "k";
	return String(count);
}

export function formatCost(usd: number): string {
	if (usd === 0) return "$0.00";
	if (usd < 0.01) return "<$0.01";
	return "$" + usd.toFixed(2);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
	return (bytes / 1024 / 1024).toFixed(1) + " MB";
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
