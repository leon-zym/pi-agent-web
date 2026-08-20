import type { NativeSessionDto, NativeWorkspaceDto, SessionRuntimeDto } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { api } from "../lib/api";
import { displayLabel } from "../lib/format";
import { useComposerStore } from "./composer";
import { useExtensionUiStore } from "./extension-ui";
import { useModelDirectoryStore } from "./model-directory";
import { useProjectionStore } from "./projection";
import { useSessionStatsStore } from "./session-stats";
import { sessionTransport } from "./session-transport";
import { useSlashCommandsStore } from "./slash-commands";
import { useViewStore } from "./view";

interface SessionDirectoryState {
	workspaces: NativeWorkspaceDto[];
	currentWorkspaceHandle: string | null;
	sessionsByWorkspace: Record<string, NativeSessionDto[]>;
	currentSession: NativeSessionDto | null;
	selectedSessionByWorkspace: Record<string, string>;
	unreadBySession: Record<string, boolean>;
	loadingWorkspaces: boolean;
	loadingSessions: boolean;
	searchQuery: string;
	error?: string;
	loadWorkspaces: () => Promise<void>;
	addWorkspace: (path: string) => Promise<NativeWorkspaceDto>;
	removeWorkspace: (workspaceHandle: string) => Promise<void>;
	selectWorkspace: (workspaceHandle: string) => Promise<void>;
	reloadSessions: (workspaceHandle?: string, options?: { force?: boolean }) => Promise<NativeSessionDto[]>;
	selectSession: (session: NativeSessionDto | null) => void;
	upsertSession: (session: NativeSessionDto) => void;
	applyRuntime: (runtime: SessionRuntimeDto) => void;
	rekeySession: (previousSessionHandle: string, sessionHandle: string, runtime: SessionRuntimeDto) => void;
	removeSession: (workspaceHandle: string, sessionHandle: string) => void;
	markSessionUnread: (sessionHandle: string) => void;
	markSessionRead: (sessionHandle: string) => void;
	setSearchQuery: (query: string) => void;
}

interface SessionRequest {
	generation: number;
	completion: Promise<NativeSessionDto[]>;
}

const sessionRequestByWorkspace = new Map<string, SessionRequest>();
let sessionRequestCounter = 0;

function nextSessionRequest(): number {
	sessionRequestCounter += 1;
	return sessionRequestCounter;
}

function isLatestSessionRequest(workspaceHandle: string, request: number): boolean {
	return sessionRequestByWorkspace.get(workspaceHandle)?.generation === request;
}

function byMostRecent(left: NativeSessionDto, right: NativeSessionDto): number {
	const leftTime = left.modifiedAt ? Date.parse(left.modifiedAt) : 0;
	const rightTime = right.modifiedAt ? Date.parse(right.modifiedAt) : 0;
	return rightTime - leftTime;
}

function mergeSession(sessions: NativeSessionDto[], session: NativeSessionDto): NativeSessionDto[] {
	return [session, ...sessions.filter((candidate) => candidate.sessionHandle !== session.sessionHandle)].sort(
		byMostRecent,
	);
}

function sessionFromRuntime(runtime: SessionRuntimeDto): NativeSessionDto {
	return {
		sessionHandle: runtime.sessionHandle,
		workspaceHandle: runtime.workspaceId,
		nativeSessionId: runtime.nativeSessionId,
		sessionFile: runtime.sessionFile,
		persisted: runtime.sessionFile !== null,
		createdAt: null,
		modifiedAt: new Date(runtime.lastActivityAt).toISOString(),
		messageCount: 0,
		firstMessage: "",
		runtime,
	};
}

function selectVisibleSessionState(sessionHandle: string | null): void {
	useProjectionStore.getState().setCurrentSession(sessionHandle);
	useComposerStore.getState().beginSession(sessionHandle);
	useModelDirectoryStore.getState().beginSession(sessionHandle);
	useSlashCommandsStore.getState().beginSession(sessionHandle);
	useSessionStatsStore.getState().beginSession(sessionHandle);
	useExtensionUiStore.getState().beginSession(sessionHandle);
	if (typeof document !== "undefined") {
		const extensionTitle = sessionHandle
			? useExtensionUiStore.getState().bySession[sessionHandle]?.title
			: null;
		document.title = extensionTitle ? `${displayLabel(extensionTitle)} · Pi Agent Web` : "Pi Agent Web";
	}
	useViewStore.getState().clearSession();
}

function activateSessionView(session: NativeSessionDto | null): void {
	const sessionHandle = session?.sessionHandle ?? null;
	selectVisibleSessionState(sessionHandle);
	if (!sessionHandle) return;
	const transport = sessionTransport.store.getState();
	if (!useProjectionStore.getState().projections[sessionHandle]) {
		transport.invalidateSessionSnapshot(sessionHandle);
	}
	transport.subscribeSession(sessionHandle);
	transport.claimSession(sessionHandle);
}

function releaseDormantView(sessionHandle: string | undefined, nextSessionHandle: string | null): void {
	if (!sessionHandle || sessionHandle === nextSessionHandle) return;
	const transport = sessionTransport.store.getState();
	const channel = transport.sessions[sessionHandle];
	if (
		channel?.runtime?.state === "running" ||
		channel?.runtime?.state === "waiting_ui" ||
		channel?.runtime?.state === "starting"
	) {
		return;
	}
	transport.releaseSession(sessionHandle);
	transport.unsubscribeSession(sessionHandle);
}

export const useSessionDirectoryStore = create<SessionDirectoryState>()((set, get) => ({
	workspaces: [],
	currentWorkspaceHandle: null,
	sessionsByWorkspace: {},
	currentSession: null,
	selectedSessionByWorkspace: {},
	unreadBySession: {},
	loadingWorkspaces: false,
	loadingSessions: false,
	searchQuery: "",

	loadWorkspaces: async () => {
		set({ loadingWorkspaces: true, error: undefined });
		try {
			const workspaces = await api.listWorkspaces();
			const current = get().currentWorkspaceHandle;
			set({ workspaces, loadingWorkspaces: false });
			if (current && workspaces.some((workspace) => workspace.workspaceHandle === current)) return;
			const preferred = [...workspaces].sort((left, right) => {
				if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
				return (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0);
			})[0];
			if (preferred) void get().selectWorkspace(preferred.workspaceHandle);
			else {
				set({ currentWorkspaceHandle: null, currentSession: null });
				activateSessionView(null);
			}
		} catch (error) {
			set({ loadingWorkspaces: false, error: error instanceof Error ? error.message : String(error) });
		}
	},

	addWorkspace: async (path) => {
		const workspace = await api.addWorkspace(path);
		await get().loadWorkspaces();
		await get().selectWorkspace(workspace.workspaceHandle);
		return workspace;
	},

	removeWorkspace: async (workspaceHandle) => {
		await api.removeWorkspace(workspaceHandle);
		const sessions = get().sessionsByWorkspace[workspaceHandle] ?? [];
		for (const session of sessions) {
			const transport = sessionTransport.store.getState();
			transport.releaseSession(session.sessionHandle);
			transport.unsubscribeSession(session.sessionHandle);
		}
		const sessionsByWorkspace = { ...get().sessionsByWorkspace };
		delete sessionsByWorkspace[workspaceHandle];
		const selectedSessionByWorkspace = { ...get().selectedSessionByWorkspace };
		delete selectedSessionByWorkspace[workspaceHandle];
		const unreadBySession = { ...get().unreadBySession };
		for (const session of sessions) delete unreadBySession[session.sessionHandle];
		if (get().currentWorkspaceHandle === workspaceHandle) {
			set({
				currentWorkspaceHandle: null,
				currentSession: null,
				sessionsByWorkspace,
				selectedSessionByWorkspace,
				unreadBySession,
			});
			activateSessionView(null);
		} else set({ sessionsByWorkspace, selectedSessionByWorkspace, unreadBySession });
		await get().loadWorkspaces();
	},

	selectWorkspace: async (workspaceHandle) => {
		const workspace = get().workspaces.find((candidate) => candidate.workspaceHandle === workspaceHandle);
		if (!workspace) return;
		const previousSelection = get().selectedSessionByWorkspace[workspaceHandle];
		const cached = get().sessionsByWorkspace[workspaceHandle] ?? [];
		const cachedSelection = cached.find((session) => session.sessionHandle === previousSelection) ?? null;
		set({
			currentWorkspaceHandle: workspaceHandle,
			currentSession: cachedSelection,
			loadingSessions: true,
			error: undefined,
		});
		activateSessionView(cachedSelection);
		const sessions = await get().reloadSessions(workspaceHandle);
		if (get().currentWorkspaceHandle !== workspaceHandle) return;
		const selectedHandle = get().selectedSessionByWorkspace[workspaceHandle];
		const selected = sessions.find((session) => session.sessionHandle === selectedHandle);
		get().selectSession(selected ?? sessions[0] ?? null);
	},

	reloadSessions: (requestedWorkspaceHandle, options = {}) => {
		const workspaceHandle = requestedWorkspaceHandle ?? get().currentWorkspaceHandle;
		if (!workspaceHandle) return Promise.resolve([]);
		const request = nextSessionRequest();
		if (get().currentWorkspaceHandle === workspaceHandle) set({ loadingSessions: true });
		const completion = (async () => {
			try {
				const { sessions } = await api.listSessions(
					workspaceHandle,
					options.force ? { force: true } : undefined,
				);
				if (!isLatestSessionRequest(workspaceHandle, request)) {
					return (
						sessionRequestByWorkspace.get(workspaceHandle)?.completion ??
						get().sessionsByWorkspace[workspaceHandle] ??
						[]
					);
				}
				const sorted = [...sessions].sort(byMostRecent);
				const current = get();
				const sessionsByWorkspace = { ...current.sessionsByWorkspace, [workspaceHandle]: sorted };
				const currentSession =
					current.currentWorkspaceHandle === workspaceHandle && current.currentSession
						? (sorted.find((session) => session.sessionHandle === current.currentSession?.sessionHandle) ??
							current.currentSession)
						: current.currentSession;
				set({
					sessionsByWorkspace,
					currentSession,
					...(current.currentWorkspaceHandle === workspaceHandle ? { loadingSessions: false } : {}),
				});
				return sorted;
			} catch (error) {
				if (!isLatestSessionRequest(workspaceHandle, request)) {
					return (
						sessionRequestByWorkspace.get(workspaceHandle)?.completion ??
						get().sessionsByWorkspace[workspaceHandle] ??
						[]
					);
				}
				if (get().currentWorkspaceHandle === workspaceHandle) {
					set({
						loadingSessions: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return get().sessionsByWorkspace[workspaceHandle] ?? [];
			}
		})();
		sessionRequestByWorkspace.set(workspaceHandle, { generation: request, completion });
		return completion;
	},

	selectSession: (session) => {
		const workspaceHandle = get().currentWorkspaceHandle;
		if (session && workspaceHandle !== session.workspaceHandle) return;
		const previousSessionHandle = get().currentSession?.sessionHandle;
		const selectedSessionByWorkspace = { ...get().selectedSessionByWorkspace };
		if (workspaceHandle) {
			if (session) selectedSessionByWorkspace[workspaceHandle] = session.sessionHandle;
			else delete selectedSessionByWorkspace[workspaceHandle];
		}
		const unreadBySession = { ...get().unreadBySession };
		if (session) delete unreadBySession[session.sessionHandle];
		set({ currentSession: session, selectedSessionByWorkspace, unreadBySession });
		releaseDormantView(previousSessionHandle, session?.sessionHandle ?? null);
		activateSessionView(session);
	},

	upsertSession: (session) => {
		const sessions = mergeSession(get().sessionsByWorkspace[session.workspaceHandle] ?? [], session);
		set({
			sessionsByWorkspace: { ...get().sessionsByWorkspace, [session.workspaceHandle]: sessions },
			...(get().currentSession?.sessionHandle === session.sessionHandle ? { currentSession: session } : {}),
		});
	},

	applyRuntime: (runtime) => {
		const sessions = get().sessionsByWorkspace[runtime.workspaceId] ?? [];
		const existing = sessions.find((session) => session.sessionHandle === runtime.sessionHandle);
		const session = existing ? { ...existing, runtime } : sessionFromRuntime(runtime);
		get().upsertSession(session);
	},

	rekeySession: (previousSessionHandle, sessionHandle, runtime) => {
		const workspaceHandle = runtime.workspaceId;
		const sessions = get().sessionsByWorkspace[workspaceHandle] ?? [];
		const previous = sessions.find((session) => session.sessionHandle === previousSessionHandle);
		const replacement = {
			...(previous ?? sessionFromRuntime(runtime)),
			sessionHandle,
			workspaceHandle,
			nativeSessionId: runtime.nativeSessionId,
			sessionFile: runtime.sessionFile,
			persisted: runtime.sessionFile !== null,
			runtime,
		} satisfies NativeSessionDto;
		const next = mergeSession(
			sessions.filter((session) => session.sessionHandle !== previousSessionHandle),
			replacement,
		);
		const wasCurrent = get().currentSession?.sessionHandle === previousSessionHandle;
		const selectedSessionByWorkspace = { ...get().selectedSessionByWorkspace };
		if (selectedSessionByWorkspace[workspaceHandle] === previousSessionHandle) {
			selectedSessionByWorkspace[workspaceHandle] = sessionHandle;
		}
		const unreadBySession = { ...get().unreadBySession };
		if (unreadBySession[previousSessionHandle]) unreadBySession[sessionHandle] = true;
		delete unreadBySession[previousSessionHandle];
		set({
			sessionsByWorkspace: { ...get().sessionsByWorkspace, [workspaceHandle]: next },
			selectedSessionByWorkspace,
			unreadBySession,
			...(wasCurrent ? { currentSession: replacement } : {}),
		});
		if (wasCurrent) {
			selectVisibleSessionState(sessionHandle);
		}
	},

	removeSession: (workspaceHandle, sessionHandle) => {
		const sessions = (get().sessionsByWorkspace[workspaceHandle] ?? []).filter(
			(session) => session.sessionHandle !== sessionHandle,
		);
		const selectedSessionByWorkspace = { ...get().selectedSessionByWorkspace };
		if (selectedSessionByWorkspace[workspaceHandle] === sessionHandle) {
			delete selectedSessionByWorkspace[workspaceHandle];
		}
		const wasCurrent = get().currentSession?.sessionHandle === sessionHandle;
		const unreadBySession = { ...get().unreadBySession };
		delete unreadBySession[sessionHandle];
		set({
			sessionsByWorkspace: { ...get().sessionsByWorkspace, [workspaceHandle]: sessions },
			selectedSessionByWorkspace,
			unreadBySession,
			...(wasCurrent ? { currentSession: null } : {}),
		});
		if (wasCurrent) activateSessionView(null);
		useComposerStore.getState().forgetSession(sessionHandle);
		useModelDirectoryStore.getState().forgetSession(sessionHandle);
		useSlashCommandsStore.getState().forgetSession(sessionHandle);
		useSessionStatsStore.getState().forgetSession(sessionHandle);
		useExtensionUiStore.getState().forgetSession(sessionHandle);
		useProjectionStore.getState().resetSession(sessionHandle);
	},

	markSessionUnread: (sessionHandle) => {
		if (get().currentSession?.sessionHandle === sessionHandle) return;
		set({ unreadBySession: { ...get().unreadBySession, [sessionHandle]: true } });
	},

	markSessionRead: (sessionHandle) => {
		if (!get().unreadBySession[sessionHandle]) return;
		const unreadBySession = { ...get().unreadBySession };
		delete unreadBySession[sessionHandle];
		set({ unreadBySession });
	},

	setSearchQuery: (searchQuery) => set({ searchQuery }),
}));

const EMPTY_SESSIONS: NativeSessionDto[] = [];

export function selectCurrentWorkspaceSessions(state: SessionDirectoryState): NativeSessionDto[] {
	return state.currentWorkspaceHandle
		? (state.sessionsByWorkspace[state.currentWorkspaceHandle] ?? EMPTY_SESSIONS)
		: EMPTY_SESSIONS;
}
