import { beforeEach, describe, expect, it } from "vitest";
import { useViewStore } from "../src/stores/view";

beforeEach(() => {
	useViewStore.setState({
		expandedThinking: {},
		expandedTools: {},
		selectedTool: null,
		selectedToolSessionId: null,
		rightPanelOpen: false,
		rightPanelMode: null,
	});
});

describe("details view state", () => {
	it("starts from the quiet, closed-panel state", () => {
		expect(useViewStore.getState()).toMatchObject({
			rightPanelOpen: false,
			rightPanelMode: null,
			selectedTool: null,
		});
	});

	it("reopens the shared details state when a tool is inspected", () => {
		useViewStore.getState().setRightPanelOpen(false);
		useViewStore.getState().setRightPanelMode("tree");

		useViewStore.getState().selectTool("session-a", "tool-a");

		expect(useViewStore.getState()).toMatchObject({
			rightPanelOpen: true,
			rightPanelMode: "inspector",
			selectedTool: "tool-a",
			selectedToolSessionId: "session-a",
		});
	});

	it("keeps the selected tool when the same inspector is reopened after closing", () => {
		useViewStore.getState().selectTool("session-a", "tool-a");
		useViewStore.getState().setRightPanelOpen(false);

		useViewStore.getState().selectTool("session-a", "tool-a");

		expect(useViewStore.getState()).toMatchObject({
			rightPanelOpen: true,
			rightPanelMode: "inspector",
			selectedTool: "tool-a",
			selectedToolSessionId: "session-a",
		});
	});
});
