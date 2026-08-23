import { beforeEach, describe, expect, it } from "vitest";
import {
	appendComposerHistory,
	getComposerHistoryKey,
	isCursorAtFirstLine,
	isCursorAtLastLine,
	loadComposerHistory,
	migrateComposerHistory,
	navigateHistoryDown,
	navigateHistoryUp,
	saveComposerHistory,
} from "../src/features/composer/use-composer-history";

describe("composer shell-style prompt history", () => {
	const storage = new Map<string, string>();

	beforeEach(() => {
		storage.clear();
		globalThis.localStorage = {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => {
				storage.set(key, value);
			},
			removeItem: (key: string) => {
				storage.delete(key);
			},
			clear: () => {
				storage.clear();
			},
			key: (index: number) => Array.from(storage.keys())[index] ?? null,
			get length() {
				return storage.size;
			},
		};
	});

	it("namespaces history keys by workspace and session", () => {
		expect(getComposerHistoryKey("ws-1", "sess-1")).toBe("piweb:history:ws-1:sess-1");
		expect(getComposerHistoryKey(null, null)).toBe("piweb:history:default:default");
	});

	it("appends prompts to history, ignores empty prompts, caps at 50, and avoids consecutive duplicates", () => {
		expect(appendComposerHistory("ws-1", "sess-1", "first prompt")).toEqual(["first prompt"]);
		expect(appendComposerHistory("ws-1", "sess-1", "second prompt")).toEqual([
			"first prompt",
			"second prompt",
		]);
		// duplicate consecutive prompt is not duplicated
		expect(appendComposerHistory("ws-1", "sess-1", "second prompt")).toEqual([
			"first prompt",
			"second prompt",
		]);
		// empty whitespace prompt is ignored
		expect(appendComposerHistory("ws-1", "sess-1", "   ")).toEqual(["first prompt", "second prompt"]);

		// Test 50 items cap
		for (let i = 3; i <= 60; i++) {
			appendComposerHistory("ws-1", "sess-1", `prompt ${i}`);
		}
		const loaded = loadComposerHistory("ws-1", "sess-1");
		expect(loaded).toHaveLength(50);
		expect(loaded[loaded.length - 1]).toBe("prompt 60");
		expect(loaded[0]).toBe("prompt 11");
	});

	it("migrates history from pending session handle to canonical session handle", () => {
		saveComposerHistory("ws-1", "pending-sess", ["prompt a", "prompt b"]);
		migrateComposerHistory("ws-1", "pending-sess", "canonical-sess");

		expect(loadComposerHistory("ws-1", "pending-sess")).toEqual([]);
		expect(loadComposerHistory("ws-1", "canonical-sess")).toEqual(["prompt a", "prompt b"]);
	});

	it("detects whether cursor is at first line or last line", () => {
		const singleLine = "hello world";
		expect(isCursorAtFirstLine(singleLine, 0)).toBe(true);
		expect(isCursorAtFirstLine(singleLine, 5)).toBe(true);
		expect(isCursorAtLastLine(singleLine, 5)).toBe(true);
		expect(isCursorAtLastLine(singleLine, 11)).toBe(true);

		const multiLine = "line 1\nline 2\nline 3";
		// Cursor in line 1
		expect(isCursorAtFirstLine(multiLine, 3)).toBe(true);
		expect(isCursorAtLastLine(multiLine, 3)).toBe(false);

		// Cursor in line 2
		expect(isCursorAtFirstLine(multiLine, 9)).toBe(false);
		expect(isCursorAtLastLine(multiLine, 9)).toBe(false);

		// Cursor in line 3
		expect(isCursorAtFirstLine(multiLine, 16)).toBe(false);
		expect(isCursorAtLastLine(multiLine, 16)).toBe(true);
	});

	it("navigates history up and down with draft stashing and restoration", () => {
		const history = ["item 1", "item 2", "item 3"];

		// Start with draft "current draft"
		// 1. Up -> loads "item 3", stashes "current draft"
		const step1 = navigateHistoryUp({
			history,
			historyIndex: null,
			draft: "current draft",
			stash: "",
		});
		expect(step1).toEqual({
			draft: "item 3",
			historyIndex: 2,
			stash: "current draft",
		});

		// 2. Up again -> loads "item 2"
		const step2 = navigateHistoryUp({
			history,
			historyIndex: step1!.historyIndex,
			draft: step1!.draft,
			stash: step1!.stash,
		});
		expect(step2).toEqual({
			draft: "item 2",
			historyIndex: 1,
			stash: "current draft",
		});

		// 3. Up again -> loads "item 1"
		const step3 = navigateHistoryUp({
			history,
			historyIndex: step2!.historyIndex,
			draft: step2!.draft,
			stash: step2!.stash,
		});
		expect(step3).toEqual({
			draft: "item 1",
			historyIndex: 0,
			stash: "current draft",
		});

		// 4. Up at top -> stays at "item 1"
		const step4 = navigateHistoryUp({
			history,
			historyIndex: step3!.historyIndex,
			draft: step3!.draft,
			stash: step3!.stash,
		});
		expect(step4).toBeNull();

		// 5. Down -> loads "item 2"
		const step5 = navigateHistoryDown({
			history,
			historyIndex: step3!.historyIndex,
			draft: step3!.draft,
			stash: step3!.stash,
		});
		expect(step5).toEqual({
			draft: "item 2",
			historyIndex: 1,
			stash: "current draft",
		});

		// 6. Down -> loads "item 3"
		const step6 = navigateHistoryDown({
			history,
			historyIndex: step5!.historyIndex,
			draft: step5!.draft,
			stash: step5!.stash,
		});
		expect(step6).toEqual({
			draft: "item 3",
			historyIndex: 2,
			stash: "current draft",
		});

		// 7. Down past latest -> restores stashed draft "current draft"
		const step7 = navigateHistoryDown({
			history,
			historyIndex: step6!.historyIndex,
			draft: step6!.draft,
			stash: step6!.stash,
		});
		expect(step7).toEqual({
			draft: "current draft",
			historyIndex: null,
			stash: "",
		});
	});
});
