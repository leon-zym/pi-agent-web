import { create } from "zustand";

export type RightPanelMode = "inspector" | "tree" | "debug" | null;

interface ViewState {
	expandedThinking: Record<string, boolean>;
	expandedTools: Record<string, boolean>;
	/** Tool block key selected for the right inspector panel. */
	selectedTool: string | null;
	selectedToolSessionId: string | null;
	rightPanelOpen: boolean;
	rightPanelMode: RightPanelMode;
	toggleThinking: (key: string) => void;
	toggleTool: (key: string) => void;
	selectTool: (sessionId: string, key: string) => void;
	setRightPanelOpen: (open: boolean) => void;
	setRightPanelMode: (mode: RightPanelMode) => void;
	/** Clear per-session UI state on session switch (view state never persists). */
	clearSession: () => void;
}

export const useViewStore = create<ViewState>()((set) => ({
	expandedThinking: {},
	expandedTools: {},
	selectedTool: null,
	selectedToolSessionId: null,
	rightPanelOpen: false,
	rightPanelMode: null,

	toggleThinking: (key) =>
		set((s) => ({ expandedThinking: { ...s.expandedThinking, [key]: !s.expandedThinking[key] } })),
	toggleTool: (key) => set((s) => ({ expandedTools: { ...s.expandedTools, [key]: !s.expandedTools[key] } })),

	selectTool: (sessionId, key) =>
		set({
			selectedTool: key,
			selectedToolSessionId: sessionId,
			rightPanelMode: "inspector",
			rightPanelOpen: true,
		}),

	setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
	setRightPanelMode: (rightPanelMode) => set({ rightPanelMode }),
	clearSession: () =>
		set({ expandedThinking: {}, expandedTools: {}, selectedTool: null, selectedToolSessionId: null }),
}));
