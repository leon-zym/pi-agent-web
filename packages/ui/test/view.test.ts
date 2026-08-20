import { beforeEach, describe, expect, it } from "vitest";
import { useViewStore } from "../src/stores/view";

beforeEach(() => {
	useViewStore.setState({
		expandedThinking: {},
		expandedTools: {},
		selectedTool: null,
		selectedToolSessionId: null,
		rightPanelOpen: true,
		rightPanelMode: null,
	});
});

describe("details view state", () => {
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
});
