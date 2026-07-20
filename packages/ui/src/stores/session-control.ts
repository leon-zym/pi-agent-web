import type { WsServerMessage } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { serverFrameBus, useTransportStore } from "./transport";

export type LeaseState = "unknown" | "controller" | "observer";

export interface SessionLease {
	id: string | null;
	file: string | null;
	epoch: number;
}

interface SessionControlState {
	workspaceId: string | null;
	lease: LeaseState;
	reconciling: boolean;
	session: SessionLease;
	selectWorkspace: (workspaceId: string | null) => void;
	claim: (workspaceId: string) => boolean;
	release: () => boolean;
	setReconciling: (workspaceId: string, reconciling: boolean) => void;
	canControl: (workspaceId: string | null) => boolean;
}

export const useSessionControlStore = create<SessionControlState>()((set, get) => ({
	workspaceId: null,
	lease: "unknown",
	reconciling: false,
	session: { id: null, file: null, epoch: 0 },

	selectWorkspace: (workspaceId) => {
		if (get().workspaceId === workspaceId) return;
		set({ workspaceId, lease: "unknown", reconciling: false, session: { id: null, file: null, epoch: 0 } });
	},

	claim: (workspaceId) => {
		get().selectWorkspace(workspaceId);
		set({ lease: "unknown" });
		return useTransportStore.getState().claimController(workspaceId);
	},

	release: () => {
		const workspaceId = get().workspaceId;
		if (!workspaceId) return false;
		return useTransportStore.getState().releaseController(workspaceId);
	},

	setReconciling: (workspaceId, reconciling) => {
		if (get().workspaceId === workspaceId) set({ reconciling });
	},

	canControl: (workspaceId) =>
		workspaceId !== null &&
		get().workspaceId === workspaceId &&
		get().lease === "controller" &&
		!get().reconciling,
}));

serverFrameBus.addEventListener("frame", ((event: CustomEvent<WsServerMessage>) => {
	const message = event.detail;
	const state = useSessionControlStore.getState();
	if (message.type === "lease_status" && message.workspaceId === state.workspaceId) {
		useSessionControlStore.setState({ lease: message.isController ? "controller" : "observer" });
	}
	if (message.type === "session_state" && message.workspaceId === state.workspaceId) {
		useSessionControlStore.setState({
			session: { id: message.sessionId, file: message.sessionFile, epoch: message.epoch },
		});
	}
}) as EventListener);

if (typeof window !== "undefined") {
	window.addEventListener("piweb:ws-online", () => {
		const state = useSessionControlStore.getState();
		if (state.workspaceId) state.claim(state.workspaceId);
	});
}
