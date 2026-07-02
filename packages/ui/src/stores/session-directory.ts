import type { SessionSummary, WorkspaceSummary } from "@pi-agent-web/server";
import { create } from "zustand";
import { api } from "../lib/api";
import { useProjectionStore } from "./projection";
import { useTransportStore } from "./transport";

interface SessionDirectoryState {
	workspaces: WorkspaceSummary[];
	currentWorkspaceId: string | null;
	sessions: SessionSummary[];
	currentSession: SessionSummary | null;
	loadingWorkspaces: boolean;
	loadingSessions: boolean;
	searchQuery: string;
	error?: string;
	loadWorkspaces: () => Promise<void>;
	addWorkspace: (path: string) => Promise<WorkspaceSummary>;
	removeWorkspace: (workspaceId: string) => Promise<void>;
	selectWorkspace: (workspaceId: string) => Promise<void>;
	reloadSessions: () => Promise<void>;
	setCurrentSession: (session: SessionSummary | null) => void;
	setSearchQuery: (query: string) => void;
}

export const useSessionDirectoryStore = create<SessionDirectoryState>()((set, get) => ({
	workspaces: [],
	currentWorkspaceId: null,
	sessions: [],
	currentSession: null,
	loadingWorkspaces: false,
	loadingSessions: false,
	searchQuery: "",

	loadWorkspaces: async () => {
		set({ loadingWorkspaces: true, error: undefined });
		try {
			const workspaces = await api.listWorkspaces();
			set({ workspaces, loadingWorkspaces: false });
		} catch (error) {
			set({ loadingWorkspaces: false, error: error instanceof Error ? error.message : String(error) });
		}
	},

	addWorkspace: async (path) => {
		const workspace = await api.addWorkspace(path);
		await get().loadWorkspaces();
		return workspace;
	},

	removeWorkspace: async (workspaceId) => {
		await api.removeWorkspace(workspaceId);
		if (get().currentWorkspaceId === workspaceId) {
			set({ currentWorkspaceId: null, sessions: [], currentSession: null });
		}
		await get().loadWorkspaces();
	},

	selectWorkspace: async (workspaceId) => {
		const workspace = get().workspaces.find((w) => w.id === workspaceId);
		if (!workspace) return;
		set({ currentWorkspaceId: workspaceId, currentSession: null, sessions: [], loadingSessions: true });
		useProjectionStore.getState().setCurrentSession(null);
		useTransportStore.getState().setListen(workspaceId, null);
		try {
			const { sessions } = await api.listSessions(workspaceId);
			set({ sessions, loadingSessions: false });
		} catch (error) {
			set({ loadingSessions: false, error: error instanceof Error ? error.message : String(error) });
		}
		// Warm up the workspace process (fires spawn + ready handshake).
		void useTransportStore
			.getState()
			.sendCommand(workspaceId, { type: "get_state" })
			.catch(() => {});
	},

	reloadSessions: async () => {
		const workspaceId = get().currentWorkspaceId;
		if (!workspaceId) return;
		const { sessions } = await api.listSessions(workspaceId);
		set({ sessions });
	},

	setCurrentSession: (session) => set({ currentSession: session }),
	setSearchQuery: (searchQuery) => set({ searchQuery }),
}));
