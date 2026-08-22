import type { DeliveryMode, SlashTrigger } from "../../stores/composer";

export function detectSlashTrigger(text: string, cursorIndex: number): SlashTrigger | null {
	// Pi dispatches extension, prompt-template, and skill commands only when the
	// entire message starts with "/". Mirror that protocol boundary instead of
	// suggesting an inline token that Pi would send as ordinary prompt text.
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

export type ComposerKeyAction =
	| { type: "submit"; mode: "prompt" | "steer" | "follow_up" }
	| { type: "newline" }
	| { type: "none" };

/**
 * Keybinding arbitration state machine (DESIGN.md Section 6.2):
 * - Idle + Normal: Enter sends prompt, Shift+Enter wraps.
 * - Idle + 70vh: Enter wraps, Cmd/Ctrl+Enter sends prompt.
 * - Running + Normal: Enter steers, Cmd/Ctrl+Enter follow_up.
 * - Running + 70vh: Enter wraps, Cmd/Ctrl+Enter sends with selected delivery mode.
 */
export function resolveComposerKeyAction(input: {
	key: string;
	shiftKey?: boolean;
	metaKey?: boolean;
	ctrlKey?: boolean;
	composing?: boolean;
	running: boolean;
	isExpanded: boolean;
	deliveryMode: DeliveryMode;
}): ComposerKeyAction {
	if (input.composing) return { type: "none" };
	if (input.key !== "Enter") return { type: "none" };

	const isModifier = Boolean(input.metaKey || input.ctrlKey);

	if (!input.isExpanded) {
		// Normal mode
		if (input.shiftKey) {
			return { type: "newline" };
		}
		if (input.running) {
			if (isModifier) {
				return { type: "submit", mode: "follow_up" };
			}
			return { type: "submit", mode: "steer" };
		}
		// Idle
		return { type: "submit", mode: "prompt" };
	}

	// 70vh mode: Enter always wraps (newlines) unless Cmd/Ctrl is pressed
	if (isModifier) {
		if (input.running) {
			return {
				type: "submit",
				mode: input.deliveryMode === "follow_up" ? "follow_up" : "steer",
			};
		}
		return { type: "submit", mode: "prompt" };
	}

	return { type: "newline" };
}
