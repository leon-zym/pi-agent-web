import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { create } from "zustand";
import { sendControlExtensionUiResponse } from "../lib/session-controller";

export type DialogRequest = Extract<
	RpcExtensionUIRequest,
	{ method: "select" | "confirm" | "input" | "editor" }
>;

export interface PendingDialog {
	request: DialogRequest;
	workspaceId: string;
	sessionId: string;
	epoch: number;
	receivedAt: number;
	deadlineAt?: number;
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
	clearDialogsOutside: (workspaceId: string, sessionId: string | null, epoch: number) => void;
	clearDialogs: () => void;
	applyStatus: (key: string, text: string | undefined) => void;
	applyWidget: (key: string, lines: string[] | undefined, placement?: "aboveEditor" | "belowEditor") => void;
}

const dialogTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearDialogTimer(id: string): void {
	const timer = dialogTimers.get(id);
	if (timer) clearTimeout(timer);
	dialogTimers.delete(id);
}

function timeoutFor(request: DialogRequest): number | undefined {
	if (!("timeout" in request) || typeof request.timeout !== "number" || request.timeout <= 0)
		return undefined;
	return request.timeout;
}

export const useExtensionUiStore = create<ExtensionUiState>()((set, get) => ({
	dialogs: [],
	status: {},
	widgets: {},

	pushDialog: (dialog) => {
		clearDialogTimer(dialog.request.id);
		const timeout = timeoutFor(dialog.request);
		const deadlineAt = timeout ? Date.now() + timeout : undefined;
		const next = { ...dialog, ...(deadlineAt ? { deadlineAt } : {}) };
		set((s) => ({ dialogs: [...s.dialogs.filter((entry) => entry.request.id !== dialog.request.id), next] }));
		if (timeout) {
			const timer = setTimeout(() => get().dismissDialog(dialog.request.id), timeout);
			timer.unref?.();
			dialogTimers.set(dialog.request.id, timer);
		}
	},

	respond: (dialog, response) => {
		if (sendControlExtensionUiResponse(dialog.workspaceId, response)) get().dismissDialog(dialog.request.id);
	},

	dismissDialog: (id) => {
		clearDialogTimer(id);
		set((s) => ({ dialogs: s.dialogs.filter((d) => d.request.id !== id) }));
	},

	clearDialogsOutside: (workspaceId, sessionId, epoch) =>
		set((s) => {
			const discarded = s.dialogs.filter(
				(dialog) =>
					dialog.workspaceId !== workspaceId || dialog.sessionId !== sessionId || dialog.epoch !== epoch,
			);
			for (const dialog of discarded) clearDialogTimer(dialog.request.id);
			return { dialogs: s.dialogs.filter((dialog) => !discarded.includes(dialog)) };
		}),

	clearDialogs: () => {
		for (const dialog of get().dialogs) clearDialogTimer(dialog.request.id);
		set({ dialogs: [] });
	},

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
