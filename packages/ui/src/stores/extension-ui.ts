import type { ExtensionUiResponseDto, PiExtensionUiRequestDto } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { useComposerStore } from "./composer";
import { sessionTransport } from "./session-transport";

export type DialogRequest = Extract<
	PiExtensionUiRequestDto,
	{ method: "select" | "confirm" | "input" | "editor" }
>;

export interface PendingDialog {
	request: DialogRequest;
	sessionHandle: string;
	generation: number;
	receivedAt: number;
	deadlineAt?: number;
	/** The Host owns dialog closure; this only prevents duplicate local responses. */
	responding: boolean;
}

export interface PendingDialogInput {
	request: DialogRequest;
	generation: number;
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

export interface ExtensionUiSnapshot {
	generation: number | null;
	dialogs: PendingDialog[];
	minimizedDialogIds: Record<string, boolean>;
	status: Record<string, string>;
	widgets: Record<string, WidgetEntry>;
	title: string | null;
	editorText: string | null;
}

interface ExtensionUiState extends ExtensionUiSnapshot {
	bySession: Record<string, ExtensionUiSnapshot>;
	activeSessionHandle: string | null;
	beginSession: (sessionHandle: string | null) => void;
	forgetSession: (sessionHandle: string) => void;
	resetSessionForGeneration: (sessionHandle: string, generation: number) => void;
	pushDialog: (dialog: PendingDialog) => void;
	pushDialogForSession: (sessionHandle: string, dialog: PendingDialogInput) => void;
	respond: (dialog: PendingDialog, response: ExtensionUiResponseDto) => boolean;
	toggleMinimize: (id: string) => void;
	toggleMinimizeForSession: (sessionHandle: string, id: string) => void;
	minimize: (id: string) => void;
	minimizeForSession: (sessionHandle: string, id: string) => void;
	maximize: (id: string) => void;
	maximizeForSession: (sessionHandle: string, id: string) => void;
	dismissDialog: (id: string) => void;
	dismissDialogForSession: (sessionHandle: string, id: string) => void;
	closeRequestForSession: (sessionHandle: string, requestId: string) => void;
	clearDialogs: () => void;
	clearDialogsForSession: (sessionHandle: string) => void;
	applyStatus: (key: string, text: string | undefined) => void;
	applyStatusForSession: (
		sessionHandle: string,
		key: string,
		text: string | undefined,
		generation?: number,
	) => void;
	applyWidget: (key: string, lines: string[] | undefined, placement?: "aboveEditor" | "belowEditor") => void;
	applyWidgetForSession: (
		sessionHandle: string,
		key: string,
		lines: string[] | undefined,
		placement?: "aboveEditor" | "belowEditor",
		generation?: number,
	) => void;
	applyRequestForSession: (
		sessionHandle: string,
		request: PiExtensionUiRequestDto,
		generation: number,
		receivedAt?: number,
	) => void;
	replaceRequestsForSession: (
		sessionHandle: string,
		generation: number,
		requests: PiExtensionUiRequestDto[],
		receivedAt?: number,
	) => void;
}

function emptySnapshot(generation: number | null = null): ExtensionUiSnapshot {
	return {
		generation,
		dialogs: [],
		minimizedDialogIds: {},
		status: {},
		widgets: {},
		title: null,
		editorText: null,
	};
}

function visible(snapshot: ExtensionUiSnapshot): ExtensionUiSnapshot {
	return {
		generation: snapshot.generation,
		dialogs: snapshot.dialogs,
		minimizedDialogIds: snapshot.minimizedDialogIds,
		status: snapshot.status,
		widgets: snapshot.widgets,
		title: snapshot.title,
		editorText: snapshot.editorText,
	};
}

function timeoutFor(request: DialogRequest): number | undefined {
	if (!("timeout" in request) || typeof request.timeout !== "number" || request.timeout <= 0) {
		return undefined;
	}
	return request.timeout;
}

function pendingDialog(sessionHandle: string, input: PendingDialogInput): PendingDialog {
	const timeout = timeoutFor(input.request);
	return {
		...input,
		sessionHandle,
		...(timeout ? { deadlineAt: input.receivedAt + timeout } : {}),
		responding: false,
	};
}

function snapshotForGeneration(snapshot: ExtensionUiSnapshot, generation?: number): ExtensionUiSnapshot {
	if (generation === undefined || snapshot.generation === generation) return snapshot;
	return emptySnapshot(generation);
}

export const useExtensionUiStore = create<ExtensionUiState>()((set, get) => {
	const updateSession = (
		sessionHandle: string,
		update: (snapshot: ExtensionUiSnapshot) => ExtensionUiSnapshot,
	): void =>
		set((state) => {
			const snapshot = update(state.bySession[sessionHandle] ?? emptySnapshot());
			return {
				bySession: { ...state.bySession, [sessionHandle]: snapshot },
				...(state.activeSessionHandle === sessionHandle ? visible(snapshot) : {}),
			};
		});

	return {
		...emptySnapshot(),
		bySession: {},
		activeSessionHandle: null,

		beginSession: (activeSessionHandle) =>
			set((state) => ({
				activeSessionHandle,
				...visible(
					activeSessionHandle ? (state.bySession[activeSessionHandle] ?? emptySnapshot()) : emptySnapshot(),
				),
			})),

		forgetSession: (sessionHandle) =>
			set((state) => {
				const bySession = { ...state.bySession };
				delete bySession[sessionHandle];
				return {
					bySession,
					...(state.activeSessionHandle === sessionHandle
						? { activeSessionHandle: null, ...visible(emptySnapshot()) }
						: {}),
				};
			}),

		resetSessionForGeneration: (sessionHandle, generation) =>
			updateSession(sessionHandle, (snapshot) =>
				snapshot.generation === generation ? snapshot : emptySnapshot(generation),
			),

		pushDialog: (dialog) =>
			get().pushDialogForSession(dialog.sessionHandle, {
				request: dialog.request,
				generation: dialog.generation,
				receivedAt: dialog.receivedAt,
			}),

		pushDialogForSession: (sessionHandle, input) => {
			const next = pendingDialog(sessionHandle, input);
			updateSession(sessionHandle, (current) => {
				const snapshot = snapshotForGeneration(current, input.generation);
				return {
					...snapshot,
					dialogs: [...snapshot.dialogs.filter((entry) => entry.request.id !== input.request.id), next],
				};
			});
		},

		respond: (dialog, response) => {
			if (response.id !== dialog.request.id) return false;
			const current = get().bySession[dialog.sessionHandle];
			const pending = current?.dialogs.find((entry) => entry.request.id === dialog.request.id);
			if (!pending || pending.generation !== dialog.generation || pending.responding) return false;
			const delivered = sessionTransport.store
				.getState()
				.sendExtensionUiResponse(dialog.sessionHandle, response);
			if (!delivered) return false;
			updateSession(dialog.sessionHandle, (snapshot) => ({
				...snapshot,
				dialogs: snapshot.dialogs.map((entry) =>
					entry.request.id === dialog.request.id ? { ...entry, responding: true } : entry,
				),
			}));
			return true;
		},

		toggleMinimize: (id) => {
			const sessionHandle = get().activeSessionHandle;
			if (sessionHandle) get().toggleMinimizeForSession(sessionHandle, id);
		},
		toggleMinimizeForSession: (sessionHandle, id) =>
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				minimizedDialogIds: {
					...snapshot.minimizedDialogIds,
					[id]: !snapshot.minimizedDialogIds[id],
				},
			})),

		minimize: (id) => {
			const sessionHandle = get().activeSessionHandle;
			if (sessionHandle) get().minimizeForSession(sessionHandle, id);
		},
		minimizeForSession: (sessionHandle, id) =>
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				minimizedDialogIds: {
					...snapshot.minimizedDialogIds,
					[id]: true,
				},
			})),

		maximize: (id) => {
			const sessionHandle = get().activeSessionHandle;
			if (sessionHandle) get().maximizeForSession(sessionHandle, id);
		},
		maximizeForSession: (sessionHandle, id) =>
			updateSession(sessionHandle, (snapshot) => {
				const next = { ...snapshot.minimizedDialogIds };
				delete next[id];
				return {
					...snapshot,
					minimizedDialogIds: next,
				};
			}),

		dismissDialog: (id) => {
			const sessionHandle = get().activeSessionHandle;
			if (sessionHandle) get().dismissDialogForSession(sessionHandle, id);
		},
		dismissDialogForSession: (sessionHandle, id) =>
			updateSession(sessionHandle, (snapshot) => {
				const nextMinimized = { ...snapshot.minimizedDialogIds };
				delete nextMinimized[id];
				return {
					...snapshot,
					dialogs: snapshot.dialogs.filter((dialog) => dialog.request.id !== id),
					minimizedDialogIds: nextMinimized,
				};
			}),
		closeRequestForSession: (sessionHandle, requestId) =>
			get().dismissDialogForSession(sessionHandle, requestId),

		clearDialogs: () => {
			const sessionHandle = get().activeSessionHandle;
			if (sessionHandle) get().clearDialogsForSession(sessionHandle);
			else set({ dialogs: [], minimizedDialogIds: {} });
		},
		clearDialogsForSession: (sessionHandle) =>
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, dialogs: [], minimizedDialogIds: {} })),

		applyStatus: (key, text) => {
			const sessionHandle = get().activeSessionHandle;
			if (sessionHandle) get().applyStatusForSession(sessionHandle, key, text);
		},
		applyStatusForSession: (sessionHandle, key, text, generation) =>
			updateSession(sessionHandle, (current) => {
				const snapshot = snapshotForGeneration(current, generation);
				const status = { ...snapshot.status };
				if (text === undefined) delete status[key];
				else status[key] = text;
				return { ...snapshot, status };
			}),

		applyWidget: (key, lines, placement = "belowEditor") => {
			const sessionHandle = get().activeSessionHandle;
			if (sessionHandle) get().applyWidgetForSession(sessionHandle, key, lines, placement);
		},
		applyWidgetForSession: (sessionHandle, key, lines, placement = "belowEditor", generation) =>
			updateSession(sessionHandle, (current) => {
				const snapshot = snapshotForGeneration(current, generation);
				const widgets = { ...snapshot.widgets };
				if (lines === undefined) delete widgets[key];
				else widgets[key] = { key, lines, placement };
				return { ...snapshot, widgets };
			}),

		applyRequestForSession: (sessionHandle, request, generation, receivedAt = Date.now()) => {
			get().resetSessionForGeneration(sessionHandle, generation);
			switch (request.method) {
				case "select":
				case "confirm":
				case "input":
				case "editor":
					get().pushDialogForSession(sessionHandle, { request, generation, receivedAt });
					return;
				case "setStatus":
					get().applyStatusForSession(sessionHandle, request.statusKey, request.statusText, generation);
					return;
				case "setWidget":
					get().applyWidgetForSession(
						sessionHandle,
						request.widgetKey,
						request.widgetLines,
						request.widgetPlacement,
						generation,
					);
					return;
				case "setTitle":
					updateSession(sessionHandle, (current) => ({
						...snapshotForGeneration(current, generation),
						title: request.title,
					}));
					return;
				case "set_editor_text":
					updateSession(sessionHandle, (current) => ({
						...snapshotForGeneration(current, generation),
						editorText: request.text,
					}));
					useComposerStore.getState().setDraftForSession(sessionHandle, request.text);
					return;
				default:
					return;
			}
		},

		replaceRequestsForSession: (sessionHandle, generation, requests, receivedAt = Date.now()) => {
			const current = get().bySession[sessionHandle];
			const preservedMinimized = current?.generation === generation ? current.minimizedDialogIds : {};
			let snapshot: ExtensionUiSnapshot = {
				...emptySnapshot(generation),
				minimizedDialogIds: preservedMinimized,
			};
			for (const request of requests) {
				switch (request.method) {
					case "select":
					case "confirm":
					case "input":
					case "editor":
						snapshot = {
							...snapshot,
							dialogs: [
								...snapshot.dialogs.filter((entry) => entry.request.id !== request.id),
								pendingDialog(sessionHandle, { request, generation, receivedAt }),
							],
						};
						break;
					case "setStatus": {
						const status = { ...snapshot.status };
						if (request.statusText === undefined) delete status[request.statusKey];
						else status[request.statusKey] = request.statusText;
						snapshot = { ...snapshot, status };
						break;
					}
					case "setWidget": {
						const widgets = { ...snapshot.widgets };
						if (request.widgetLines === undefined) delete widgets[request.widgetKey];
						else {
							widgets[request.widgetKey] = {
								key: request.widgetKey,
								lines: request.widgetLines,
								placement: request.widgetPlacement ?? "belowEditor",
							};
						}
						snapshot = { ...snapshot, widgets };
						break;
					}
					case "setTitle":
						snapshot = { ...snapshot, title: request.title };
						break;
					case "set_editor_text":
						snapshot = { ...snapshot, editorText: request.text };
						break;
					default:
						break;
				}
			}
			const dialogIds = new Set(snapshot.dialogs.map((dialog) => dialog.request.id));
			snapshot = {
				...snapshot,
				minimizedDialogIds: Object.fromEntries(
					Object.entries(snapshot.minimizedDialogIds).filter(
						([requestId, minimized]) => minimized && dialogIds.has(requestId),
					),
				),
			};
			updateSession(sessionHandle, () => snapshot);
			if (snapshot.editorText !== null) {
				useComposerStore.getState().setDraftForSession(sessionHandle, snapshot.editorText);
			}
		},
	};
});
