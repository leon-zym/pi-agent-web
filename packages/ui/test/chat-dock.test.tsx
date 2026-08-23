import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeHarness = vi.hoisted(() => ({
	transport: {
		sessions: {
			"session-a": {
				lease: { isController: true, fencingToken: "tok-1" },
			},
		} as Record<string, any>,
	},
	ext: {
		dialogs: [] as any[],
		minimizedDialogIds: {} as Record<string, boolean>,
		activeSessionHandle: "session-a",
		respond: vi.fn(),
		maximize: vi.fn(),
		dismissDialog: vi.fn(),
	},
}));

vi.mock("../src/stores/session-transport", () => ({
	useSessionTransportStore: (selector: (state: typeof storeHarness.transport) => unknown) =>
		selector(storeHarness.transport),
}));

vi.mock("../src/stores/extension-ui", () => ({
	useExtensionUiStore: Object.assign(
		(selector: (state: typeof storeHarness.ext) => unknown) => selector(storeHarness.ext),
		{ getState: () => storeHarness.ext },
	),
}));

import { ChatDock } from "../src/features/extension-ui/ChatDock";

describe("ChatDock component", () => {
	beforeEach(() => {
		storeHarness.ext.dialogs = [
			{
				request: {
					type: "extension_ui_request",
					id: "dlg-1",
					method: "confirm",
					title: "Delete File?",
					message: "Are you sure you want to delete file.txt?",
				},
				sessionHandle: "session-a",
				generation: 1,
				receivedAt: Date.now(),
				responding: false,
			},
		];
		storeHarness.ext.minimizedDialogIds = { "dlg-1": true };
	});

	it("renders minimized confirm dialog with quick actions", () => {
		const html = renderToStaticMarkup(createElement(ChatDock));
		expect(html).toContain('data-testid="chat-dock"');
		expect(html).toContain("Delete File?");
		expect(html).toContain("Are you sure you want to delete file.txt?");
	});

	it("does not render when dialog is not minimized", () => {
		storeHarness.ext.minimizedDialogIds = {};
		const html = renderToStaticMarkup(createElement(ChatDock));
		expect(html).toBe("");
	});

	it("renders select dialog options in dock", () => {
		storeHarness.ext.dialogs = [
			{
				request: {
					type: "extension_ui_request",
					id: "dlg-select",
					method: "select",
					title: "Choose Action",
					options: ["Retry", "Skip", "Abort"],
				},
				sessionHandle: "session-a",
				generation: 1,
				receivedAt: Date.now(),
				responding: false,
			},
		];
		storeHarness.ext.minimizedDialogIds = { "dlg-select": true };

		const html = renderToStaticMarkup(createElement(ChatDock));
		expect(html).toContain("Choose Action");
		expect(html).toContain("Retry");
		expect(html).toContain("Skip");
		expect(html).toContain("Abort");
	});
});
