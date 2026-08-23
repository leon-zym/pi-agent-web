import { useCallback, useEffect, useRef } from "react";

const HISTORY_CAP = 50;

export function getComposerHistoryKey(
	workspaceHandle?: string | null,
	sessionHandle?: string | null,
): string {
	return `piweb:history:${workspaceHandle ?? "default"}:${sessionHandle ?? "default"}`;
}

export function loadComposerHistory(
	workspaceHandle?: string | null,
	sessionHandle?: string | null,
): string[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw = localStorage.getItem(getComposerHistoryKey(workspaceHandle, sessionHandle));
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

export function saveComposerHistory(
	workspaceHandle: string | null | undefined,
	sessionHandle: string | null | undefined,
	history: string[],
): void {
	if (typeof localStorage === "undefined") return;
	try {
		const key = getComposerHistoryKey(workspaceHandle, sessionHandle);
		const capped = history.slice(-HISTORY_CAP);
		localStorage.setItem(key, JSON.stringify(capped));
	} catch {}
}

export function appendComposerHistory(
	workspaceHandle: string | null | undefined,
	sessionHandle: string | null | undefined,
	prompt: string,
): string[] {
	const trimmed = prompt.trim();
	if (!trimmed) return loadComposerHistory(workspaceHandle, sessionHandle);

	const existing = loadComposerHistory(workspaceHandle, sessionHandle);
	if (existing.length > 0 && existing[existing.length - 1] === trimmed) {
		return existing;
	}

	const updated = [...existing, trimmed].slice(-HISTORY_CAP);
	saveComposerHistory(workspaceHandle, sessionHandle, updated);
	return updated;
}

export function migrateComposerHistory(
	workspaceHandle: string | null | undefined,
	fromSessionHandle: string,
	toSessionHandle: string,
): void {
	if (typeof localStorage === "undefined") return;
	if (fromSessionHandle === toSessionHandle) return;
	const existing = loadComposerHistory(workspaceHandle, fromSessionHandle);
	if (existing.length > 0) {
		saveComposerHistory(workspaceHandle, toSessionHandle, existing);
		try {
			localStorage.removeItem(getComposerHistoryKey(workspaceHandle, fromSessionHandle));
		} catch {}
	}
}

export function isCursorAtFirstLine(text: string, cursorIndex: number): boolean {
	return !text.slice(0, cursorIndex).includes("\n");
}

export function isCursorAtLastLine(text: string, cursorIndex: number): boolean {
	return !text.slice(cursorIndex).includes("\n");
}

export function navigateHistoryUp(state: {
	history: string[];
	historyIndex: number | null;
	draft: string;
	stash: string;
}): { draft: string; historyIndex: number; stash: string } | null {
	const { history, historyIndex, draft, stash } = state;
	if (history.length === 0) return null;

	if (historyIndex === null) {
		// Entering history navigation from current draft
		const nextIndex = history.length - 1;
		return {
			draft: history[nextIndex] ?? "",
			historyIndex: nextIndex,
			stash: draft,
		};
	}

	if (historyIndex > 0) {
		const nextIndex = historyIndex - 1;
		return {
			draft: history[nextIndex] ?? "",
			historyIndex: nextIndex,
			stash,
		};
	}

	// Already at the oldest history item
	return null;
}

export function navigateHistoryDown(state: {
	history: string[];
	historyIndex: number | null;
	draft: string;
	stash: string;
}): { draft: string; historyIndex: number | null; stash: string } | null {
	const { history, historyIndex, stash } = state;
	if (historyIndex === null) return null;

	if (historyIndex < history.length - 1) {
		const nextIndex = historyIndex + 1;
		return {
			draft: history[nextIndex] ?? "",
			historyIndex: nextIndex,
			stash,
		};
	}

	// Past the newest history item, restore stashed draft
	return {
		draft: stash,
		historyIndex: null,
		stash: "",
	};
}

export interface UseComposerHistoryParams {
	workspaceHandle?: string | null;
	sessionHandle?: string | null;
	draft: string;
	setDraft: (draft: string) => void;
}

export function useComposerHistory({
	workspaceHandle,
	sessionHandle,
	draft,
	setDraft,
}: UseComposerHistoryParams) {
	const historyIndexRef = useRef<number | null>(null);
	const draftStashRef = useRef<string>("");

	// Reset index when session changes
	useEffect(() => {
		historyIndexRef.current = null;
		draftStashRef.current = "";
	}, [sessionHandle]);

	const recordPrompt = useCallback(
		(prompt: string) => {
			appendComposerHistory(workspaceHandle, sessionHandle, prompt);
			historyIndexRef.current = null;
			draftStashRef.current = "";
		},
		[workspaceHandle, sessionHandle],
	);

	const resetHistoryIndex = useCallback(() => {
		historyIndexRef.current = null;
		draftStashRef.current = "";
	}, []);

	const handleHistoryKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
			if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;

			const cursor = event.currentTarget.selectionStart ?? 0;
			const history = loadComposerHistory(workspaceHandle, sessionHandle);

			if (event.key === "ArrowUp" && isCursorAtFirstLine(draft, cursor)) {
				const result = navigateHistoryUp({
					history,
					historyIndex: historyIndexRef.current,
					draft,
					stash: draftStashRef.current,
				});
				if (result) {
					event.preventDefault();
					historyIndexRef.current = result.historyIndex;
					draftStashRef.current = result.stash;
					setDraft(result.draft);
					return true;
				}
			}

			if (
				event.key === "ArrowDown" &&
				historyIndexRef.current !== null &&
				isCursorAtLastLine(draft, cursor)
			) {
				const result = navigateHistoryDown({
					history,
					historyIndex: historyIndexRef.current,
					draft,
					stash: draftStashRef.current,
				});
				if (result) {
					event.preventDefault();
					historyIndexRef.current = result.historyIndex;
					draftStashRef.current = result.stash;
					setDraft(result.draft);
					return true;
				}
			}

			return false;
		},
		[workspaceHandle, sessionHandle, draft, setDraft],
	);

	return {
		onKeyDown: handleHistoryKeyDown,
		recordPrompt,
		resetHistoryIndex,
	};
}
