import type { DeliveryMode, SlashTrigger } from "../../stores/composer";

export function detectSlashTrigger(text: string, cursorIndex: number): SlashTrigger | null {
	const start = text.lastIndexOf("/", cursorIndex - 1);
	if (start === -1 || text.slice(0, start).trim().length > 0) return null;
	const after = text.slice(start + 1, cursorIndex);
	if (/\s/.test(after) || after.startsWith("/")) return null;
	return { index: start, query: after };
}

export function resolveRunningSubmitKind(
	deliveryMode: DeliveryMode,
	queueShortcut: boolean,
): "steer" | "follow_up" {
	if (queueShortcut) return "follow_up";
	return deliveryMode === "follow_up" ? "follow_up" : "steer";
}

export function isSlashCommitKey(event: {
	key: string;
	shiftKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	ctrlKey?: boolean;
}): boolean {
	if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
	return event.key === "Tab" || event.key === "Enter";
}

export function shouldRemoveCommandOnBackspace(input: {
	hasCommand: boolean;
	draft: string;
	key: string;
	composing: boolean;
	selectionStart: number | null;
	selectionEnd: number | null;
}): boolean {
	return (
		input.hasCommand &&
		input.key === "Backspace" &&
		!input.composing &&
		input.draft.length === 0 &&
		input.selectionStart === 0 &&
		input.selectionEnd === 0
	);
}
