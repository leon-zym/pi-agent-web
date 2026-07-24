import type { SessionSummary, WorkspaceSummary } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { api } from "../lib/api";
import { useModelDirectoryStore } from "./model-directory";
import { useProjectionStore } from "./projection";
import { useSessionControlStore } from "./session-control";
import { useSlashCommandsStore } from "./slash-commands";
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
	reloadSessions: () => Promise<SessionSummary[]>;
	setCurrentSession: (session: SessionSummary | null) => void;
	setSearchQuery: (query: string) => void;
}

const sessionRequestByWorkspace = new Map<string, number>();
let sessionRequestCounter = 0;

function nextSessionRequest(workspaceId: string): number {
	sessionRequestCounter += 1;
	sessionRequestByWorkspace.set(workspaceId, sessionRequestCounter);
	return sessionRequestCounter;
}

function isLatestSessionRequest(workspaceId: string, request: number): boolean {
	return sessionRequestByWorkspace.get(workspaceId) === request;
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
			// First load: auto-open the most recently used workspace so the
			// workbench is immediately usable.
			if (!get().currentWorkspaceId && workspaces.length > 0) {
				const mostRecent = [...workspaces].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0];
				if (mostRecent) void get().selectWorkspace(mostRecent.id);
			}
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
			useProjectionStore.getState().setCurrentSession(null);
			useTransportStore.getState().setListen(null, null);
			useSessionControlStore.getState().selectWorkspace(null);
			useModelDirectoryStore.getState().beginWorkspace(null);
			useSlashCommandsStore.getState().beginWorkspace(null);
		}
		await get().loadWorkspaces();
	},

	selectWorkspace: async (workspaceId) => {
		const workspace = get().workspaces.find((w) => w.id === workspaceId);
		if (!workspace) return;
		set({ currentWorkspaceId: workspaceId, currentSession: null, sessions: [], loadingSessions: true });
		useProjectionStore.getState().setCurrentSession(null);
		useTransportStore.getState().setListen(workspaceId, null);
		useSessionControlStore.getState().selectWorkspace(workspaceId);
		useModelDirectoryStore.getState().beginWorkspace(workspaceId);
		useSlashCommandsStore.getState().beginWorkspace(workspaceId);
		useSessionControlStore.getState().claim(workspaceId);
		const request = nextSessionRequest(workspaceId);
		try {
			const { sessions } = await api.listSessions(workspaceId);
			if (get().currentWorkspaceId === workspaceId && isLatestSessionRequest(workspaceId, request)) {
				set({ sessions, loadingSessions: false });
			}
		} catch (error) {
			if (get().currentWorkspaceId === workspaceId && isLatestSessionRequest(workspaceId, request)) {
				set({ loadingSessions: false, error: error instanceof Error ? error.message : String(error) });
			}
		}
		// Warm up the workspace process (fires spawn + ready handshake).
		void useTransportStore
			.getState()
			.sendCommand(workspaceId, { type: "get_state" })
			.catch(() => {});
	},

	reloadSessions: async () => {
		const workspaceId = get().currentWorkspaceId;
		if (!workspaceId) return [];
		const request = nextSessionRequest(workspaceId);
		const { sessions } = await api.listSessions(workspaceId);
		if (get().currentWorkspaceId === workspaceId && isLatestSessionRequest(workspaceId, request))
			set({ sessions });
		return sessions;
	},

	setCurrentSession: (session) => set({ currentSession: session }),
	setSearchQuery: (searchQuery) => set({ searchQuery }),
}));
