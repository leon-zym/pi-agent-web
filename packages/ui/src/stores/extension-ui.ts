import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { create } from "zustand";
import { useTransportStore } from "./transport";

export type DialogRequest = Extract<
	RpcExtensionUIRequest,
	{ method: "select" | "confirm" | "input" | "editor" }
>;

export interface PendingDialog {
	request: DialogRequest;
	workspaceId: string;
	sessionId: string;
	receivedAt: number;
}

export interface StatusBarEntry {
	key: string;
	text: string;
}

export interface WidgetEntry {
	key: string;
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
}

interface ExtensionUiState {
	dialogs: PendingDialog[];
	status: Record<string, string>;
	widgets: Record<string, WidgetEntry>;
	pushDialog: (dialog: PendingDialog) => void;
	respond: (dialog: PendingDialog, response: RpcExtensionUIResponse) => void;
	dismissDialog: (id: string) => void;
	applyStatus: (key: string, text: string | undefined) => void;
	applyWidget: (key: string, lines: string[] | undefined, placement?: "aboveEditor" | "belowEditor") => void;
}

export const useExtensionUiStore = create<ExtensionUiState>()((set, get) => ({
	dialogs: [],
	status: {},
	widgets: {},

	pushDialog: (dialog) => set((s) => ({ dialogs: [...s.dialogs, dialog] })),

	respond: (dialog, response) => {
		useTransportStore.getState().sendExtensionUiResponse(dialog.workspaceId, response);
		get().dismissDialog(dialog.request.id);
	},

	dismissDialog: (id) => set((s) => ({ dialogs: s.dialogs.filter((d) => d.request.id !== id) })),

	applyStatus: (key, text) =>
		set((s) => {
			const status = { ...s.status };
			if (text === undefined) delete status[key];
			else status[key] = text;
			return { status };
		}),

	applyWidget: (key, lines, placement = "belowEditor") =>
		set((s) => {
			const widgets = { ...s.widgets };
			if (lines === undefined) delete widgets[key];
			else widgets[key] = { key, lines, placement };
			return { widgets };
		}),
}));
