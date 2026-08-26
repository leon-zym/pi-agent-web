import type { ExtensionUiRequestDto } from "@pi-agent-web/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerStore } from "../src/stores/composer";
import { useExtensionUiStore } from "../src/stores/extension-ui";
import { sessionTransport } from "../src/stores/session-transport";

function request(id: string, timeout?: number) {
	return {
		type: "extension_ui_request" as const,
		id,
		method: "confirm" as const,
		title: id,
		message: id,
		...(timeout ? { timeout } : {}),
	};
}

const originalTransport = sessionTransport.store.getState();

describe("Session-scoped extension UI", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		useExtensionUiStore.setState({
			bySession: {},
			activeSessionHandle: null,
			generation: null,
			dialogs: [],
			status: {},
			widgets: {},
			title: null,
			editorText: null,
		});
		useComposerStore.setState({
			bySession: {},
			activeSessionHandle: null,
			draft: "",
			images: [],
			trigger: null,
			command: null,
			submitState: "plain",
			activeSubmitId: null,
			attachmentWorkCount: 0,
			attachmentWorkIds: [],
			deliveryMode: "auto",
			queue: { steering: [], followUp: [] },
			recentQueued: [],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		sessionTransport.store.setState(originalTransport, true);
	});

	it("keeps timeout closure Host-authoritative", () => {
		useExtensionUiStore.getState().beginSession("session-a");
		useExtensionUiStore.getState().pushDialogForSession("session-a", {
			request: request("first", 100),
			generation: 2,
			receivedAt: Date.now(),
		});

		expect(useExtensionUiStore.getState().dialogs[0]?.deadlineAt).toBe(Date.now() + 100);
		vi.advanceTimersByTime(100);
		expect(useExtensionUiStore.getState().dialogs.map((entry) => entry.request.id)).toEqual(["first"]);

		useExtensionUiStore.getState().closeRequestForSession("session-a", "first");
		expect(useExtensionUiStore.getState().dialogs).toEqual([]);
	});

	it("keeps background dialogs, status, and widgets isolated and restores them on switch", () => {
		const store = useExtensionUiStore.getState();
		store.beginSession("session-a");
		store.pushDialogForSession("session-a", {
			request: request("a"),
			generation: 1,
			receivedAt: Date.now(),
		});
		store.applyStatusForSession("session-a", "branch", "A", 1);
		store.applyWidgetForSession("session-b", "tests", ["passing"], "aboveEditor", 4);
		store.pushDialogForSession("session-b", {
			request: request("b"),
			generation: 4,
			receivedAt: Date.now(),
		});

		expect(useExtensionUiStore.getState().dialogs.map((dialog) => dialog.request.id)).toEqual(["a"]);
		expect(useExtensionUiStore.getState().status).toEqual({ branch: "A" });

		store.beginSession("session-b");
		expect(useExtensionUiStore.getState().dialogs.map((dialog) => dialog.request.id)).toEqual(["b"]);
		expect(useExtensionUiStore.getState().status).toEqual({});
		expect(useExtensionUiStore.getState().widgets.tests?.lines).toEqual(["passing"]);
	});

	it("atomically replaces sticky snapshot state without replaying notifications", () => {
		const requests: ExtensionUiRequestDto[] = [
			request("blocking"),
			{
				type: "extension_ui_request",
				id: "notify",
				method: "notify",
				message: "must not be replayed",
			},
			{
				type: "extension_ui_request",
				id: "status",
				method: "setStatus",
				statusKey: "branch",
				statusText: "main",
			},
			{
				type: "extension_ui_request",
				id: "widget",
				method: "setWidget",
				widgetKey: "tests",
				widgetLines: ["42 passed"],
			},
			{ type: "extension_ui_request", id: "title", method: "setTitle", title: "Agent A" },
			{
				type: "extension_ui_request",
				id: "editor",
				method: "set_editor_text",
				text: "extension draft",
			},
		];

		useExtensionUiStore.getState().replaceRequestsForSession("session-a", 7, requests);
		useExtensionUiStore.getState().beginSession("session-a");
		useComposerStore.getState().beginSession("session-a");

		expect(useExtensionUiStore.getState()).toMatchObject({
			generation: 7,
			status: { branch: "main" },
			title: "Agent A",
			editorText: "extension draft",
		});
		expect(useExtensionUiStore.getState().dialogs.map((dialog) => dialog.request.id)).toEqual(["blocking"]);
		expect(useExtensionUiStore.getState().widgets.tests?.lines).toEqual(["42 passed"]);
		expect(useComposerStore.getState().draft).toBe("extension draft");
	});

	it("routes responses to their Session and waits for an authoritative close", () => {
		const sendExtensionUiResponse = vi.fn(() => true);
		sessionTransport.store.setState({ sendExtensionUiResponse });
		useExtensionUiStore.getState().beginSession("session-a");
		useExtensionUiStore.getState().pushDialogForSession("session-a", {
			request: request("confirm-a"),
			generation: 3,
			receivedAt: Date.now(),
		});
		const dialog = useExtensionUiStore.getState().dialogs[0];
		expect(dialog).toBeDefined();

		expect(
			useExtensionUiStore
				.getState()
				.respond(dialog!, { type: "extension_ui_response", id: "confirm-a", confirmed: true }),
		).toBe(true);
		expect(sendExtensionUiResponse).toHaveBeenCalledWith("session-a", {
			type: "extension_ui_response",
			id: "confirm-a",
			confirmed: true,
		});
		expect(useExtensionUiStore.getState().dialogs[0]?.responding).toBe(true);
		expect(
			useExtensionUiStore
				.getState()
				.respond(dialog!, { type: "extension_ui_response", id: "confirm-a", confirmed: true }),
		).toBe(false);

		useExtensionUiStore.getState().closeRequestForSession("session-a", "confirm-a");
		expect(useExtensionUiStore.getState().dialogs).toEqual([]);
	});

	it("tracks minimized dialogs per session and cleans up on dismissal", () => {
		const store = useExtensionUiStore.getState();
		store.beginSession("session-a");
		store.pushDialogForSession("session-a", {
			request: request("dlg-1"),
			generation: 1,
			receivedAt: Date.now(),
		});

		expect(useExtensionUiStore.getState().minimizedDialogIds["dlg-1"]).toBeUndefined();

		store.minimize("dlg-1");
		expect(useExtensionUiStore.getState().minimizedDialogIds["dlg-1"]).toBe(true);

		store.toggleMinimize("dlg-1");
		expect(useExtensionUiStore.getState().minimizedDialogIds["dlg-1"]).toBe(false);

		store.toggleMinimize("dlg-1");
		expect(useExtensionUiStore.getState().minimizedDialogIds["dlg-1"]).toBe(true);

		store.maximize("dlg-1");
		expect(useExtensionUiStore.getState().minimizedDialogIds["dlg-1"]).toBeUndefined();

		store.minimize("dlg-1");
		expect(useExtensionUiStore.getState().minimizedDialogIds["dlg-1"]).toBe(true);

		// Snapshot in same generation preserves minimized state
		store.replaceRequestsForSession("session-a", 1, [request("dlg-1"), request("dlg-2")]);
		expect(useExtensionUiStore.getState().minimizedDialogIds["dlg-1"]).toBe(true);

		// Snapshot in new generation resets minimized state
		store.replaceRequestsForSession("session-a", 2, [request("dlg-1")]);
		expect(useExtensionUiStore.getState().minimizedDialogIds["dlg-1"]).toBeUndefined();

		store.dismissDialog("dlg-1");
		expect(useExtensionUiStore.getState().minimizedDialogIds["dlg-1"]).toBeUndefined();
	});
});
