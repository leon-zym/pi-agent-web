import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExtensionUiStore } from "../src/stores/extension-ui";

function dialog(id: string, timeout?: number) {
	return {
		request: {
			type: "extension_ui_request" as const,
			id,
			method: "confirm" as const,
			title: id,
			message: id,
			...(timeout ? { timeout } : {}),
		},
		workspaceId: "workspace-a",
		sessionId: "session-a",
		epoch: 2,
		receivedAt: Date.now(),
	};
}

describe("extension dialog deadlines", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useExtensionUiStore.getState().clearDialogs();
	});

	afterEach(() => vi.useRealTimers());

	it("expires timed dialogs without blocking the next queued request", () => {
		useExtensionUiStore.getState().pushDialog(dialog("first", 100));
		useExtensionUiStore.getState().pushDialog(dialog("second"));
		expect(useExtensionUiStore.getState().dialogs.map((entry) => entry.request.id)).toEqual([
			"first",
			"second",
		]);

		vi.advanceTimersByTime(100);
		expect(useExtensionUiStore.getState().dialogs.map((entry) => entry.request.id)).toEqual(["second"]);
	});

	it("clears a deadline when a dialog is dismissed manually", () => {
		useExtensionUiStore.getState().pushDialog(dialog("first", 100));
		useExtensionUiStore.getState().dismissDialog("first");
		vi.advanceTimersByTime(100);
		expect(useExtensionUiStore.getState().dialogs).toEqual([]);
	});

	it("drops dialogs that no longer match the Host session epoch", () => {
		useExtensionUiStore.getState().pushDialog(dialog("current"));
		useExtensionUiStore.getState().pushDialog({ ...dialog("stale"), epoch: 1 });
		useExtensionUiStore.getState().clearDialogsOutside("workspace-a", "session-a", 2);
		expect(useExtensionUiStore.getState().dialogs.map((entry) => entry.request.id)).toEqual(["current"]);
	});
});
