import type {
	HotRuntimeInventoryDto,
	HotRuntimeInventoryEntryDto,
	HotRuntimeStateDto,
	NativeSessionDto,
	NativeWorkspaceDto,
	SessionRuntimeDto,
} from "@pi-agent-web/protocol";
import { create } from "zustand";
import { api } from "../lib/api";
import { displayLabel } from "../lib/format";
import { runtimeIsBusy, runtimeIsReady, runtimeStateForDisplay } from "../lib/runtime-state";
import {
	createSessionBrowserIdentity,
	createWorkspaceBrowserIdentity,
	getSessionBrowserEffects,
} from "../lib/session-browser-effects";
import { useComposerStore } from "./composer";
import { useExtensionUiStore } from "./extension-ui";
import { useModelDirectoryStore } from "./model-directory";
import { useProjectionStore } from "./projection";
import { useSessionControlStore } from "./session-control";
import { useSessionStatsStore } from "./session-stats";
import { hasFreshLeaseBaseline, sessionTransport } from "./session-transport";
import { useSlashCommandsStore } from "./slash-commands";
import { useViewStore } from "./view";

export type HotSessionPersistenceFact =
	| { status: "unknown"; source: "inventory" }
	| { status: "persisted"; source: "catalog" | "runtime" }
	| { status: "unpersisted"; source: "runtime" };

export type HotTransientResumeStatus = "ready" | "pending" | "none";

export interface SessionDirectoryState {
	workspaces: NativeWorkspaceDto[];
	currentWorkspaceHandle: string | null;
	sessionsByWorkspace: Record<string, NativeSessionDto[]>;
	hotSessionsByWorkspace: Record<string, NativeSessionDto[]>;
	hotRuntimeStateBySession: Record<string, HotRuntimeStateDto>;
	hotRuntimeIdentityBySession: Record<string, HotRuntimeInventoryEntryDto>;
	currentSession: NativeSessionDto | null;
	retainedTransientByWorkspace: Record<string, NativeSessionDto>;
	locallyCreatedTransientSessions: Record<string, true>;
	navigationToken: number;
	sessionCreation: SessionCreationIntent | null;
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
	resumeTransientSession: (workspaceHandle: string) => boolean;
	hotTransientResumeStatus: (workspaceHandle: string) => HotTransientResumeStatus;
	beginSessionCreation: (workspaceHandle: string) => number;
	completeSessionCreation: (token: number, session: NativeSessionDto) => boolean;
	failSessionCreation: (token: number) => boolean;
	upsertSession: (session: NativeSessionDto) => void;
	applyRuntime: (runtime: SessionRuntimeDto) => void;
	applyHotRuntimeInventory: (inventory: HotRuntimeInventoryDto) => void;
	rekeySession: (previousSessionHandle: string, sessionHandle: string, runtime: SessionRuntimeDto) => void;
	removeSession: (workspaceHandle: string, sessionHandle: string) => void;
	markSessionUnread: (sessionHandle: string) => void;
	markSessionRead: (sessionHandle: string) => void;
	setSearchQuery: (query: string) => void;
}

export interface SessionCreationIntent {
	token: number;
	workspaceHandle: string;
}

interface SessionRequest {
	generation: number;
	completion: Promise<NativeSessionDto[]>;
}

const sessionRequestByWorkspace = new Map<string, SessionRequest>();
const transientAbandons = new Set<string>();
let sessionRequestCounter = 0;
let navigationTokenCounter = 0;
let cancelPendingVisibleSessionClaim: (() => void) | null = null;
let visibleSessionTransitionToken = 0;
let visibleSessionKey: string | null = null;

const TRANSIENT_CONTROL_WAIT_MS = 5_000;

export function isSessionBeingAbandoned(sessionHandle: string): boolean {
	return transientAbandons.has(sessionHandle);
}

function nextSessionRequest(): number {
	sessionRequestCounter += 1;
	return sessionRequestCounter;
}

function nextNavigationToken(): number {
	navigationTokenCounter += 1;
	return navigationTokenCounter;
}

function nextVisibleSessionTransition(sessionKey: string | null): number {
	if (sessionKey !== visibleSessionKey) {
		visibleSessionKey = sessionKey;
		visibleSessionTransitionToken += 1;
	}
	return visibleSessionTransitionToken;
}

function isLatestSessionRequest(workspaceHandle: string, request: number): boolean {
	return sessionRequestByWorkspace.get(workspaceHandle)?.generation === request;
}

function byMostRecent(left: NativeSessionDto, right: NativeSessionDto): number {
	const leftTime = left.modifiedAt ? Date.parse(left.modifiedAt) : 0;
	const rightTime = right.modifiedAt ? Date.parse(right.modifiedAt) : 0;
	return rightTime - leftTime;
}

function preferredWorkspace(workspaces: NativeWorkspaceDto[]): NativeWorkspaceDto | undefined {
	return workspaces.reduce<NativeWorkspaceDto | undefined>((preferred, candidate) => {
		if (!preferred) return candidate;
		if (candidate.lastOpenedAt === null) return preferred;
		if (preferred.lastOpenedAt === null || candidate.lastOpenedAt > preferred.lastOpenedAt) {
			return candidate;
		}
		return preferred;
	}, undefined);
}

function mergeSession(sessions: NativeSessionDto[], session: NativeSessionDto): NativeSessionDto[] {
	return [session, ...sessions.filter((candidate) => candidate.sessionHandle !== session.sessionHandle)].sort(
		byMostRecent,
	);
}

function hotSessionPlaceholder(runtime: HotRuntimeInventoryEntryDto): NativeSessionDto {
	return {
		sessionHandle: runtime.sessionHandle,
		workspaceHandle: runtime.workspaceId,
		nativeSessionId: "",
		sessionFile: null,
		persisted: false,
		createdAt: null,
		modifiedAt: null,
		messageCount: 0,
		firstMessage: "",
		runtime: null,
	};
}

function hotRuntimeState(runtime: {
	state: SessionRuntimeDto["state"];
	phase?: SessionRuntimeDto["phase"];
}): HotRuntimeStateDto | undefined {
	const state = runtimeStateForDisplay(runtime);
	if (!state || state === "crashed" || state === "dormant") return undefined;
	return state;
}

function runtimeMatchesHotIdentity(
	runtime: SessionRuntimeDto,
	identity: HotRuntimeInventoryEntryDto,
): boolean {
	return (
		runtime.serverEpoch === identity.serverEpoch &&
		runtime.workspaceId === identity.workspaceId &&
		runtime.sessionHandle === identity.sessionHandle &&
		runtime.generation === identity.generation
	);
}

export function resolveHotSessionPersistence(
	session: NativeSessionDto,
	identity: HotRuntimeInventoryEntryDto | undefined,
	durableSessions: NativeSessionDto[] | undefined,
): HotSessionPersistenceFact {
	if (durableSessions?.some((durable) => durable.sessionHandle === session.sessionHandle)) {
		return { status: "persisted", source: "catalog" };
	}
	if (session.runtime && (!identity || runtimeMatchesHotIdentity(session.runtime, identity))) {
		return {
			status: session.runtime.recoverable ? "persisted" : "unpersisted",
			source: "runtime",
		};
	}
	return { status: "unknown", source: "inventory" };
}

function hotTransientResumeStatus(
	state: SessionDirectoryState,
	workspaceHandle: string,
): HotTransientResumeStatus {
	let pending = false;
	for (const session of state.hotSessionsByWorkspace[workspaceHandle] ?? []) {
		const fact = resolveHotSessionPersistence(
			session,
			state.hotRuntimeIdentityBySession[session.sessionHandle],
			state.sessionsByWorkspace[workspaceHandle],
		);
		if (fact.status === "unpersisted") return "ready";
		if (fact.status === "unknown") pending = true;
	}
	return pending ? "pending" : "none";
}

function mergeVisibleSessions(durable: NativeSessionDto[], hot: NativeSessionDto[]): NativeSessionDto[] {
	const byHandle = new Map(durable.map((session) => [session.sessionHandle, session]));
	for (const session of hot) {
		const existing = byHandle.get(session.sessionHandle);
		byHandle.set(
			session.sessionHandle,
			existing ? { ...session, ...existing, runtime: session.runtime ?? existing.runtime } : session,
		);
	}
	return [...byHandle.values()].sort(byMostRecent);
}

function sessionFromRuntime(runtime: SessionRuntimeDto): NativeSessionDto {
	return {
		sessionHandle: runtime.sessionHandle,
		workspaceHandle: runtime.workspaceId,
		nativeSessionId: runtime.nativeSessionId,
		sessionFile: runtime.sessionFile,
		persisted: runtime.recoverable,
		createdAt: null,
		modifiedAt: new Date(runtime.lastActivityAt).toISOString(),
		messageCount: 0,
		firstMessage: "",
		runtime,
	};
}

function isDirectorySession(session: NativeSessionDto): boolean {
	if (!session.persisted) return false;
	return Boolean(session.messageCount > 0 || session.firstMessage.trim() || session.name?.trim());
}

function selectVisibleSessionState(sessionHandle: string | null): void {
	useProjectionStore.getState().setCurrentSession(sessionHandle);
	useComposerStore.getState().beginSession(sessionHandle);
	useModelDirectoryStore.getState().beginSession(sessionHandle);
	useSlashCommandsStore.getState().beginSession(sessionHandle);
	useSessionStatsStore.getState().beginSession(sessionHandle);
	useExtensionUiStore.getState().beginSession(sessionHandle);
	const currentSession = useSessionDirectoryStore.getState().currentSession;
	const transitionToken = nextVisibleSessionTransition(
		sessionHandle ? `${currentSession?.workspaceHandle ?? ""}:${sessionHandle}` : null,
	);
	if (sessionHandle) {
		const runtime =
			sessionTransport.store.getState().sessions[sessionHandle]?.runtime ??
			useSessionDirectoryStore.getState().currentSession?.runtime;
		if (runtime) {
			const identity = createSessionBrowserIdentity(runtime);
			const extensionTitle = useExtensionUiStore.getState().bySession[sessionHandle]?.title;
			const effects = getSessionBrowserEffects();
			effects.setCurrentIdentity(identity);
			effects.dispatch({
				type: "title",
				identity,
				dedupeKey: `session-title:${transitionToken}:${extensionTitle ?? ""}`,
				dedupeMode: "latest",
				dedupeGroup: "session-title",
				title: extensionTitle ? `${displayLabel(extensionTitle)} · Pi Agent Web` : "Pi Agent Web",
			});
		}
	} else if (typeof document !== "undefined") {
		// The no-Session baseline has no Session identity to carry through the sink.
		document.title = "Pi Agent Web";
	}
	useViewStore.getState().clearSession();
}

/** Wait for an authoritative lease before claiming a persisted visible Session. */
function claimVisibleSessionWhenFree(sessionHandle: string): void {
	cancelPendingVisibleSessionClaim?.();

	let cancelled = false;
	let unsubscribe = () => {};
	const cancel = () => {
		if (cancelled) return;
		cancelled = true;
		unsubscribe();
		if (cancelPendingVisibleSessionClaim === cancel) cancelPendingVisibleSessionClaim = null;
	};
	const inspect = () => {
		if (cancelled) return;
		const transport = sessionTransport.store.getState();
		const channel = transport.sessions[sessionHandle];
		if (!channel?.subscribed || !channel.baselineAuthoritative || !hasFreshLeaseBaseline(channel)) return;
		if (channel.lease.controlState !== "free") return;
		cancel();
		transport.claimSession(sessionHandle);
	};

	cancelPendingVisibleSessionClaim = cancel;
	unsubscribe = sessionTransport.store.subscribe(inspect);
	inspect();
}

function activateSessionView(session: NativeSessionDto | null): void {
	cancelPendingVisibleSessionClaim?.();
	const sessionHandle = session?.sessionHandle ?? null;
	selectVisibleSessionState(sessionHandle);
	if (!sessionHandle) return;
	const transport = sessionTransport.store.getState();
	if (!useProjectionStore.getState().projections[sessionHandle]) {
		transport.invalidateSessionSnapshot(sessionHandle);
	}
	transport.subscribeSession(sessionHandle);
	if (session?.runtime?.recoverable === false) {
		transport.claimSession(sessionHandle);
	} else {
		claimVisibleSessionWhenFree(sessionHandle);
	}
}

function releasableSessionState(sessionHandle: string): boolean {
	const runtime = sessionTransport.store.getState().sessions[sessionHandle]?.runtime;
	if (runtimeIsBusy(runtime)) return false;
	const composerState = useComposerStore.getState();
	const composer =
		composerState.bySession[sessionHandle] ??
		(composerState.activeSessionHandle === sessionHandle ? composerState : undefined);
	if (
		composer?.submitState === "submitting" ||
		(composer?.attachmentWorkCount ?? 0) > 0 ||
		(composer?.queue.steering.length ?? 0) > 0 ||
		(composer?.queue.followUp.length ?? 0) > 0
	) {
		return false;
	}
	if (useProjectionStore.getState().projections[sessionHandle]?.activeTurnId) return false;
	return (useExtensionUiStore.getState().bySession[sessionHandle]?.dialogs.length ?? 0) === 0;
}

function releaseSessionChannel(sessionHandle: string): void {
	const transport = sessionTransport.store.getState();
	const channel = transport.sessions[sessionHandle];
	if (
		!channel?.subscribed ||
		!channel.baselineAuthoritative ||
		!hasFreshLeaseBaseline(channel) ||
		!releasableSessionState(sessionHandle)
	)
		return;
	const runtime = channel.runtime;
	// The gateway cannot see browser-only drafts or attachments. Keep the lease for an
	// unmaterialized Session while local content exists so its orphan reaper cannot
	// discard the only runtime that still owns that draft's pending Session identity.
	if (runtime?.recoverable === false && hasLocalTransientContent(sessionHandle)) return;
	if (channel.lease.isController || channel.lease.fencingToken || channel.controllerIntent) {
		transport.releaseSession(sessionHandle);
	}
	if (
		runtime &&
		transport.hotRuntimeInventory?.runtimes.some(
			(candidate) =>
				candidate.sessionHandle === sessionHandle &&
				candidate.serverEpoch === runtime.serverEpoch &&
				candidate.workspaceId === runtime.workspaceId &&
				candidate.generation === runtime.generation,
		)
	) {
		return;
	}
	transport.unsubscribeSession(sessionHandle);
}

function transientManagement(sessionHandle: string): {
	workspaceHandle: string;
	generation: number;
	fencingToken: string;
} | null {
	const channel = sessionTransport.store.getState().sessions[sessionHandle];
	if (
		!channel?.subscribed ||
		!channel.baselineAuthoritative ||
		!hasFreshLeaseBaseline(channel) ||
		channel.generation === null ||
		!channel.lease.isController ||
		!channel.lease.fencingToken ||
		channel.runtime?.recoverable !== false ||
		!useSessionDirectoryStore.getState().locallyCreatedTransientSessions[sessionHandle] ||
		!runtimeIsReady(channel.runtime)
	) {
		return null;
	}
	return {
		workspaceHandle: channel.runtime.workspaceId,
		generation: channel.generation,
		fencingToken: channel.lease.fencingToken,
	};
}

function hasLocalTransientContent(sessionHandle: string): boolean {
	const composerState = useComposerStore.getState();
	const composer =
		composerState.bySession[sessionHandle] ??
		(composerState.activeSessionHandle === sessionHandle ? composerState : undefined);
	if (
		composer &&
		(composer.draft.length > 0 ||
			composer.images.length > 0 ||
			composer.trigger !== null ||
			composer.command !== null ||
			composer.submitState !== "plain" ||
			composer.attachmentWorkCount > 0 ||
			composer.queue.steering.length > 0 ||
			composer.queue.followUp.length > 0 ||
			composer.recentQueued.length > 0)
	) {
		return true;
	}

	const projection = useProjectionStore.getState().projections[sessionHandle];
	if (projection && (projection.turns.length > 0 || projection.activeTurnId !== null)) return true;

	const transport = sessionTransport.store.getState().sessions[sessionHandle];
	if ((transport?.pendingExtensionRequests.length ?? 0) > 0) return true;
	const extensionState = useExtensionUiStore.getState();
	const extension =
		extensionState.bySession[sessionHandle] ??
		(extensionState.activeSessionHandle === sessionHandle ? extensionState : undefined);
	return Boolean(
		extension &&
			(extension.dialogs.length > 0 ||
				Object.keys(extension.status).length > 0 ||
				Object.keys(extension.widgets).length > 0 ||
				extension.title ||
				extension.editorText),
	);
}

function retainLocalTransient(
	retained: Record<string, NativeSessionDto>,
	previousSession: NativeSessionDto | null,
	nextSessionHandle: string | null,
): Record<string, NativeSessionDto> {
	const next = { ...retained };
	if (
		previousSession &&
		previousSession.sessionHandle !== nextSessionHandle &&
		!previousSession.persisted &&
		hasLocalTransientContent(previousSession.sessionHandle)
	) {
		next[previousSession.workspaceHandle] = previousSession;
	}
	return next;
}

async function abandonTransientChannel(
	sessionHandle: string,
	management: NonNullable<ReturnType<typeof transientManagement>>,
): Promise<boolean> {
	if (transientAbandons.has(sessionHandle)) return true;
	transientAbandons.add(sessionHandle);
	try {
		await api.abandonTransientSession(management.workspaceHandle, sessionHandle, {
			generation: management.generation,
			fencingToken: management.fencingToken,
		});
		sessionTransport.store.getState().unsubscribeSession(sessionHandle);
		useSessionDirectoryStore.getState().removeSession(management.workspaceHandle, sessionHandle);
		return true;
	} catch {
		return false;
	} finally {
		transientAbandons.delete(sessionHandle);
	}
}

function abandonUntouchedView(sessionHandle: string): boolean {
	const management = transientManagement(sessionHandle);
	if (!management || hasLocalTransientContent(sessionHandle)) return false;
	void abandonTransientChannel(sessionHandle, management).then((abandoned) => {
		if (!abandoned) releaseSessionChannel(sessionHandle);
	});
	return true;
}

/** Re-run background lifecycle admission after an async composer operation settles. */
export function reconcileHiddenSessionLifecycle(sessionHandle: string): void {
	if (useSessionDirectoryStore.getState().currentSession?.sessionHandle === sessionHandle) return;
	const channel = sessionTransport.store.getState().sessions[sessionHandle];
	if (!channel?.subscribed || !channel.baselineAuthoritative || !hasFreshLeaseBaseline(channel)) return;
	if (abandonUntouchedView(sessionHandle)) return;
	releaseSessionChannel(sessionHandle);
}

function releaseDormantView(sessionHandle: string | undefined, nextSessionHandle: string | null): void {
	if (!sessionHandle || sessionHandle === nextSessionHandle) return;
	if (abandonUntouchedView(sessionHandle)) return;
	releaseSessionChannel(sessionHandle);
}

async function waitForTransientControl(
	sessionHandle: string,
): Promise<ReturnType<typeof transientManagement>> {
	const transport = sessionTransport.store;
	transport.getState().subscribeSession(sessionHandle);
	transport.getState().claimSession(sessionHandle);
	const existing = transientManagement(sessionHandle);
	if (existing) return existing;

	return new Promise((resolve) => {
		let settled = false;
		const finish = (management: ReturnType<typeof transientManagement>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(management);
		};
		const unsubscribe = transport.subscribe(() => {
			const management = transientManagement(sessionHandle);
			if (management) finish(management);
		});
		const timer = setTimeout(() => finish(null), TRANSIENT_CONTROL_WAIT_MS);
	});
}

async function discardStaleCreatedSession(session: NativeSessionDto): Promise<void> {
	const management = await waitForTransientControl(session.sessionHandle);
	if (management && (await abandonTransientChannel(session.sessionHandle, management))) return;
	releaseSessionChannel(session.sessionHandle);
	void useSessionDirectoryStore.getState().reloadSessions(session.workspaceHandle, { force: true });
}

async function discardTransientForWorkspaceRemoval(
	workspaceHandle: string,
	sessionHandle: string,
): Promise<void> {
	const management = transientManagement(sessionHandle);
	if (management && (await abandonTransientChannel(sessionHandle, management))) return;
	const transport = sessionTransport.store.getState();
	transport.releaseSession(sessionHandle);
	transport.unsubscribeSession(sessionHandle);
	useSessionDirectoryStore.getState().removeSession(workspaceHandle, sessionHandle);
}

export const useSessionDirectoryStore = create<SessionDirectoryState>()((set, get) => ({
	workspaces: [],
	currentWorkspaceHandle: null,
	sessionsByWorkspace: {},
	hotSessionsByWorkspace: {},
	hotRuntimeStateBySession: {},
	hotRuntimeIdentityBySession: {},
	currentSession: null,
	retainedTransientByWorkspace: {},
	locallyCreatedTransientSessions: {},
	navigationToken: 0,
	sessionCreation: null,
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
			const preferred = preferredWorkspace(workspaces);
			const previousSession = get().currentSession;
			const previousSessionHandle = previousSession?.sessionHandle;
			const retainedTransientByWorkspace = retainLocalTransient(
				get().retainedTransientByWorkspace,
				previousSession,
				null,
			);
			const navigationToken = nextNavigationToken();
			set({
				currentWorkspaceHandle: preferred?.workspaceHandle ?? null,
				currentSession: null,
				navigationToken,
				sessionCreation: null,
				loadingSessions: Boolean(preferred),
				retainedTransientByWorkspace,
			});
			releaseDormantView(previousSessionHandle, null);
			activateSessionView(null);
			if (preferred) await get().reloadSessions(preferred.workspaceHandle);
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
		const beforeRemoval = get();
		const transientHandles = new Set<string>();
		const hotSessions = beforeRemoval.hotSessionsByWorkspace[workspaceHandle] ?? [];
		const current = beforeRemoval.currentSession;
		if (current?.workspaceHandle === workspaceHandle && !current.persisted) {
			transientHandles.add(current.sessionHandle);
		}
		const retained = beforeRemoval.retainedTransientByWorkspace[workspaceHandle];
		if (retained) transientHandles.add(retained.sessionHandle);
		for (const session of hotSessions) {
			if (!session.persisted && beforeRemoval.locallyCreatedTransientSessions[session.sessionHandle]) {
				transientHandles.add(session.sessionHandle);
			}
		}
		// Keep browser-only drafts intact if removing the Workspace preference fails.
		// Active runtimes remain a supervisor-backed Workspace projection long enough
		// for the transient abandon request that follows a successful removal.
		await api.removeWorkspace(workspaceHandle);
		getSessionBrowserEffects().invalidateWorkspaceIdentity(
			createWorkspaceBrowserIdentity({ workspaceId: workspaceHandle }),
		);
		set({
			workspaces: get().workspaces.filter((workspace) => workspace.workspaceHandle !== workspaceHandle),
		});
		for (const sessionHandle of transientHandles) {
			await discardTransientForWorkspaceRemoval(workspaceHandle, sessionHandle);
		}
		const cleanedHandles = new Set(transientHandles);
		for (const session of hotSessions) {
			if (cleanedHandles.has(session.sessionHandle)) continue;
			const transport = sessionTransport.store.getState();
			transport.releaseSession(session.sessionHandle);
			transport.unsubscribeSession(session.sessionHandle);
			cleanedHandles.add(session.sessionHandle);
		}
		const sessions = get().sessionsByWorkspace[workspaceHandle] ?? [];
		for (const session of sessions) {
			if (cleanedHandles.has(session.sessionHandle)) continue;
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
		for (const session of hotSessions) delete unreadBySession[session.sessionHandle];
		const retainedTransientByWorkspace = { ...get().retainedTransientByWorkspace };
		delete retainedTransientByWorkspace[workspaceHandle];
		const hotSessionsByWorkspace = { ...get().hotSessionsByWorkspace };
		delete hotSessionsByWorkspace[workspaceHandle];
		const locallyCreatedTransientSessions = { ...get().locallyCreatedTransientSessions };
		for (const session of hotSessions) delete locallyCreatedTransientSessions[session.sessionHandle];
		const hotRuntimeStateBySession = { ...get().hotRuntimeStateBySession };
		const hotRuntimeIdentityBySession = { ...get().hotRuntimeIdentityBySession };
		for (const session of hotSessions) delete hotRuntimeStateBySession[session.sessionHandle];
		for (const session of hotSessions) delete hotRuntimeIdentityBySession[session.sessionHandle];
		if (get().currentWorkspaceHandle === workspaceHandle) {
			set({
				currentWorkspaceHandle: null,
				currentSession: null,
				sessionsByWorkspace,
				selectedSessionByWorkspace,
				unreadBySession,
				retainedTransientByWorkspace,
				hotSessionsByWorkspace,
				hotRuntimeStateBySession,
				hotRuntimeIdentityBySession,
				locallyCreatedTransientSessions,
			});
			activateSessionView(null);
		} else {
			set({
				sessionsByWorkspace,
				selectedSessionByWorkspace,
				unreadBySession,
				retainedTransientByWorkspace,
				hotSessionsByWorkspace,
				hotRuntimeStateBySession,
				hotRuntimeIdentityBySession,
				locallyCreatedTransientSessions,
			});
		}
		await get().loadWorkspaces();
	},

	selectWorkspace: async (workspaceHandle) => {
		const workspace = get().workspaces.find((candidate) => candidate.workspaceHandle === workspaceHandle);
		if (!workspace) return;
		const previousSession = get().currentSession;
		const previousSessionHandle = previousSession?.sessionHandle;
		const retainedTransientByWorkspace = retainLocalTransient(
			get().retainedTransientByWorkspace,
			previousSession,
			null,
		);
		const navigationToken = nextNavigationToken();
		set({
			currentWorkspaceHandle: workspaceHandle,
			currentSession: null,
			navigationToken,
			sessionCreation: null,
			loadingSessions: true,
			error: undefined,
			retainedTransientByWorkspace,
		});
		releaseDormantView(previousSessionHandle, null);
		activateSessionView(null);
		const activation = api
			.activateWorkspace(workspaceHandle)
			.then((activatedWorkspace) => {
				set((state) => ({
					workspaces: state.workspaces.map((candidate) =>
						candidate.workspaceHandle === activatedWorkspace.workspaceHandle ? activatedWorkspace : candidate,
					),
				}));
			})
			.catch((error) => {
				if (get().navigationToken !== navigationToken) return;
				set({ error: error instanceof Error ? error.message : String(error) });
			});
		await Promise.all([activation, get().reloadSessions(workspaceHandle)]);
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
				// Sidebar directory entries are durable Pi history, not hot runtime handles.
				// Keep an unmaterialized active Session in currentSession until Pi writes its
				// JSONL, then let a forced native-catalog refresh publish its real metadata.
				const sorted = sessions.filter(isDirectorySession).sort(byMostRecent);
				const current = get();
				const sessionsByWorkspace = { ...current.sessionsByWorkspace, [workspaceHandle]: sorted };
				const retainedTransientByWorkspace = { ...current.retainedTransientByWorkspace };
				const retained = retainedTransientByWorkspace[workspaceHandle];
				if (retained && sorted.some((session) => session.sessionHandle === retained.sessionHandle)) {
					delete retainedTransientByWorkspace[workspaceHandle];
				}
				const workspaces = current.workspaces.map((workspace) =>
					workspace.workspaceHandle === workspaceHandle
						? {
								...workspace,
								sessionCount: sorted.length,
								hasNativeHistory: sorted.length > 0,
							}
						: workspace,
				);
				const currentSession =
					current.currentWorkspaceHandle === workspaceHandle && current.currentSession
						? (sorted.find((session) => session.sessionHandle === current.currentSession?.sessionHandle) ??
							current.currentSession)
						: current.currentSession;
				set({
					workspaces,
					sessionsByWorkspace,
					retainedTransientByWorkspace,
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
		const previousSession = get().currentSession;
		const workspaceHandle = session?.workspaceHandle ?? get().currentWorkspaceHandle;
		const previousSessionHandle = previousSession?.sessionHandle;
		const retainedTransientByWorkspace = retainLocalTransient(
			get().retainedTransientByWorkspace,
			previousSession,
			session?.sessionHandle ?? null,
		);
		if (
			session &&
			retainedTransientByWorkspace[session.workspaceHandle]?.sessionHandle === session.sessionHandle
		) {
			delete retainedTransientByWorkspace[session.workspaceHandle];
		}
		const selectedSessionByWorkspace = { ...get().selectedSessionByWorkspace };
		if (workspaceHandle) {
			if (session) selectedSessionByWorkspace[workspaceHandle] = session.sessionHandle;
			else delete selectedSessionByWorkspace[workspaceHandle];
		}
		const unreadBySession = { ...get().unreadBySession };
		if (session) delete unreadBySession[session.sessionHandle];
		set({
			currentWorkspaceHandle: workspaceHandle,
			currentSession: session,
			navigationToken: nextNavigationToken(),
			sessionCreation: null,
			selectedSessionByWorkspace,
			unreadBySession,
			retainedTransientByWorkspace,
		});
		releaseDormantView(previousSessionHandle, session?.sessionHandle ?? null);
		activateSessionView(session);
	},

	resumeTransientSession: (workspaceHandle) => {
		const state = get();
		const isExplicitlyUnpersisted = (session: NativeSessionDto) =>
			resolveHotSessionPersistence(
				session,
				state.hotRuntimeIdentityBySession[session.sessionHandle],
				state.sessionsByWorkspace[workspaceHandle],
			).status === "unpersisted";
		const current = state.currentSession;
		if (
			current?.workspaceHandle === workspaceHandle &&
			isExplicitlyUnpersisted(current) &&
			hasLocalTransientContent(current.sessionHandle)
		) {
			return true;
		}
		const retained = state.retainedTransientByWorkspace[workspaceHandle];
		if (retained && isExplicitlyUnpersisted(retained)) {
			get().selectSession(retained);
			return true;
		}
		const recovered = state.hotSessionsByWorkspace[workspaceHandle]?.find((session) =>
			isExplicitlyUnpersisted(session),
		);
		if (!recovered) return false;
		get().selectSession(recovered);
		return true;
	},

	hotTransientResumeStatus: (workspaceHandle) => hotTransientResumeStatus(get(), workspaceHandle),

	beginSessionCreation: (workspaceHandle) => {
		const token = nextNavigationToken();
		const previousSessionHandle = get().currentSession?.sessionHandle;
		set({
			currentWorkspaceHandle: workspaceHandle,
			currentSession: null,
			navigationToken: token,
			sessionCreation: { token, workspaceHandle },
			error: undefined,
		});
		releaseDormantView(previousSessionHandle, null);
		activateSessionView(null);
		return token;
	},

	completeSessionCreation: (token, session) => {
		if (!session.persisted) {
			set({
				locallyCreatedTransientSessions: {
					...get().locallyCreatedTransientSessions,
					[session.sessionHandle]: true,
				},
			});
		}
		get().upsertSession(session);
		const state = get();
		if (
			state.navigationToken !== token ||
			state.sessionCreation?.token !== token ||
			state.currentWorkspaceHandle !== session.workspaceHandle
		) {
			void discardStaleCreatedSession(session);
			return false;
		}
		set({ sessionCreation: null });
		get().selectSession(session);
		return true;
	},

	failSessionCreation: (token) => {
		const state = get();
		if (state.navigationToken !== token || state.sessionCreation?.token !== token) return false;
		set({ sessionCreation: null });
		return true;
	},

	upsertSession: (session) => {
		if (session.persisted && get().locallyCreatedTransientSessions[session.sessionHandle]) {
			const locallyCreatedTransientSessions = { ...get().locallyCreatedTransientSessions };
			delete locallyCreatedTransientSessions[session.sessionHandle];
			set({ locallyCreatedTransientSessions });
		}
		if (!isDirectorySession(session)) {
			if (get().currentSession?.sessionHandle === session.sessionHandle) {
				set({ currentSession: session });
			}
			return;
		}
		const sessions = mergeSession(get().sessionsByWorkspace[session.workspaceHandle] ?? [], session);
		const retainedTransientByWorkspace = { ...get().retainedTransientByWorkspace };
		if (retainedTransientByWorkspace[session.workspaceHandle]?.sessionHandle === session.sessionHandle) {
			delete retainedTransientByWorkspace[session.workspaceHandle];
		}
		set({
			sessionsByWorkspace: { ...get().sessionsByWorkspace, [session.workspaceHandle]: sessions },
			retainedTransientByWorkspace,
			...(get().currentSession?.sessionHandle === session.sessionHandle ? { currentSession: session } : {}),
		});
	},

	applyRuntime: (runtime) => {
		const hotIdentity = get().hotRuntimeIdentityBySession[runtime.sessionHandle];
		if (hotIdentity && !runtimeMatchesHotIdentity(runtime, hotIdentity)) return;
		if (runtime.recoverable && get().locallyCreatedTransientSessions[runtime.sessionHandle]) {
			const locallyCreatedTransientSessions = { ...get().locallyCreatedTransientSessions };
			delete locallyCreatedTransientSessions[runtime.sessionHandle];
			set({ locallyCreatedTransientSessions });
		}
		const hotSessions = get().hotSessionsByWorkspace[runtime.workspaceId] ?? [];
		const hot = hotSessions.find((session) => session.sessionHandle === runtime.sessionHandle);
		if (hot) {
			set({
				hotSessionsByWorkspace: {
					...get().hotSessionsByWorkspace,
					[runtime.workspaceId]: hotSessions.map((session) =>
						session.sessionHandle === runtime.sessionHandle
							? {
									...session,
									nativeSessionId: runtime.nativeSessionId,
									sessionFile: runtime.sessionFile,
									persisted: runtime.recoverable,
									modifiedAt: new Date(runtime.lastActivityAt).toISOString(),
									runtime,
								}
							: session,
					),
				},
			});
		}
		const sessions = get().sessionsByWorkspace[runtime.workspaceId] ?? [];
		const existing = sessions.find((session) => session.sessionHandle === runtime.sessionHandle);
		if (existing?.persisted) {
			get().upsertSession({ ...existing, runtime });
			return;
		}
		const current = get().currentSession;
		if (current?.sessionHandle !== runtime.sessionHandle) {
			const retained = get().retainedTransientByWorkspace[runtime.workspaceId];
			if (retained?.sessionHandle !== runtime.sessionHandle) return;
			set({
				retainedTransientByWorkspace: {
					...get().retainedTransientByWorkspace,
					[runtime.workspaceId]: {
						...retained,
						nativeSessionId: runtime.nativeSessionId,
						sessionFile: runtime.sessionFile,
						persisted: runtime.recoverable,
						runtime,
					},
				},
			});
			return;
		}
		set({
			currentSession: {
				...current,
				nativeSessionId: runtime.nativeSessionId,
				sessionFile: runtime.sessionFile,
				persisted: runtime.recoverable,
				runtime,
			},
		});
	},

	applyHotRuntimeInventory: (inventory) => {
		const current = get();
		const next: Record<string, NativeSessionDto[]> = {};
		const hotRuntimeStateBySession: Record<string, HotRuntimeStateDto> = {};
		const hotRuntimeIdentityBySession: Record<string, HotRuntimeInventoryEntryDto> = {};
		for (const runtime of inventory.runtimes) {
			const displayState = hotRuntimeState(runtime);
			if (displayState) hotRuntimeStateBySession[runtime.sessionHandle] = displayState;
			hotRuntimeIdentityBySession[runtime.sessionHandle] = { ...runtime };
			const durable = current.sessionsByWorkspace[runtime.workspaceId]?.find(
				(session) => session.sessionHandle === runtime.sessionHandle,
			);
			const previous = current.hotSessionsByWorkspace[runtime.workspaceId]?.find(
				(session) => session.sessionHandle === runtime.sessionHandle,
			);
			const selected =
				current.currentSession?.sessionHandle === runtime.sessionHandle ? current.currentSession : undefined;
			const candidate = selected ?? previous;
			const matchingCandidate =
				candidate?.runtime && runtimeMatchesHotIdentity(candidate.runtime, runtime) ? candidate : undefined;
			const session = durable ?? matchingCandidate ?? hotSessionPlaceholder(runtime);
			next[runtime.workspaceId] = [...(next[runtime.workspaceId] ?? []), session];
		}
		set({ hotSessionsByWorkspace: next, hotRuntimeStateBySession, hotRuntimeIdentityBySession });
	},

	rekeySession: (previousSessionHandle, sessionHandle, runtime) => {
		const workspaceHandle = runtime.workspaceId;
		const sessions = get().sessionsByWorkspace[workspaceHandle] ?? [];
		const previous = sessions.find((session) => session.sessionHandle === previousSessionHandle);
		const current = get().currentSession;
		const replacement = {
			...(current?.sessionHandle === previousSessionHandle
				? current
				: (previous ?? sessionFromRuntime(runtime))),
			sessionHandle,
			workspaceHandle,
			nativeSessionId: runtime.nativeSessionId,
			sessionFile: runtime.sessionFile,
			persisted: runtime.recoverable,
			runtime,
		} satisfies NativeSessionDto;
		// Fork/clone moves the hot process to a child identity, but the persisted
		// parent remains independently reopenable. The child joins the directory
		// only through the native catalog once its JSONL metadata is available.
		const next = sessions.filter(isDirectorySession);
		const wasCurrent = current?.sessionHandle === previousSessionHandle;
		const selectedSessionByWorkspace = { ...get().selectedSessionByWorkspace };
		if (selectedSessionByWorkspace[workspaceHandle] === previousSessionHandle) {
			selectedSessionByWorkspace[workspaceHandle] = sessionHandle;
		}
		const unreadBySession = { ...get().unreadBySession };
		if (unreadBySession[previousSessionHandle]) unreadBySession[sessionHandle] = true;
		delete unreadBySession[previousSessionHandle];
		const retainedTransientByWorkspace = { ...get().retainedTransientByWorkspace };
		if (retainedTransientByWorkspace[workspaceHandle]?.sessionHandle === previousSessionHandle) {
			retainedTransientByWorkspace[workspaceHandle] = replacement;
		}
		const locallyCreatedTransientSessions = { ...get().locallyCreatedTransientSessions };
		if (locallyCreatedTransientSessions[previousSessionHandle]) {
			delete locallyCreatedTransientSessions[previousSessionHandle];
			if (!runtime.recoverable) locallyCreatedTransientSessions[sessionHandle] = true;
		}
		const hotSessionsByWorkspace = { ...get().hotSessionsByWorkspace };
		if (hotSessionsByWorkspace[workspaceHandle]) {
			hotSessionsByWorkspace[workspaceHandle] = hotSessionsByWorkspace[workspaceHandle].map((session) =>
				session.sessionHandle === previousSessionHandle ? replacement : session,
			);
		}
		const hotRuntimeStateBySession = { ...get().hotRuntimeStateBySession };
		delete hotRuntimeStateBySession[previousSessionHandle];
		const rekeyedHotState = hotRuntimeState(runtime);
		if (rekeyedHotState) hotRuntimeStateBySession[sessionHandle] = rekeyedHotState;
		const hotRuntimeIdentityBySession = { ...get().hotRuntimeIdentityBySession };
		delete hotRuntimeIdentityBySession[previousSessionHandle];
		if (rekeyedHotState) {
			hotRuntimeIdentityBySession[sessionHandle] = {
				serverEpoch: runtime.serverEpoch,
				sessionHandle,
				workspaceId: runtime.workspaceId,
				generation: runtime.generation,
				state: rekeyedHotState,
			};
		}
		set({
			sessionsByWorkspace: { ...get().sessionsByWorkspace, [workspaceHandle]: next },
			selectedSessionByWorkspace,
			unreadBySession,
			retainedTransientByWorkspace,
			locallyCreatedTransientSessions,
			hotSessionsByWorkspace,
			hotRuntimeStateBySession,
			hotRuntimeIdentityBySession,
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
		const retainedTransientByWorkspace = { ...get().retainedTransientByWorkspace };
		if (retainedTransientByWorkspace[workspaceHandle]?.sessionHandle === sessionHandle) {
			delete retainedTransientByWorkspace[workspaceHandle];
		}
		const locallyCreatedTransientSessions = { ...get().locallyCreatedTransientSessions };
		delete locallyCreatedTransientSessions[sessionHandle];
		const hotSessionsByWorkspace = { ...get().hotSessionsByWorkspace };
		if (hotSessionsByWorkspace[workspaceHandle]) {
			hotSessionsByWorkspace[workspaceHandle] = hotSessionsByWorkspace[workspaceHandle].filter(
				(session) => session.sessionHandle !== sessionHandle,
			);
		}
		const hotRuntimeStateBySession = { ...get().hotRuntimeStateBySession };
		delete hotRuntimeStateBySession[sessionHandle];
		const hotRuntimeIdentityBySession = { ...get().hotRuntimeIdentityBySession };
		delete hotRuntimeIdentityBySession[sessionHandle];
		set({
			sessionsByWorkspace: { ...get().sessionsByWorkspace, [workspaceHandle]: sessions },
			selectedSessionByWorkspace,
			unreadBySession,
			retainedTransientByWorkspace,
			locallyCreatedTransientSessions,
			hotSessionsByWorkspace,
			hotRuntimeStateBySession,
			hotRuntimeIdentityBySession,
			...(wasCurrent ? { currentSession: null } : {}),
		});
		if (wasCurrent) activateSessionView(null);
		useComposerStore.getState().forgetSession(sessionHandle);
		useModelDirectoryStore.getState().forgetSession(sessionHandle);
		useSlashCommandsStore.getState().forgetSession(sessionHandle);
		useSessionStatsStore.getState().forgetSession(sessionHandle);
		useExtensionUiStore.getState().forgetSession(sessionHandle);
		useSessionControlStore.getState().forgetSession(sessionHandle);
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
let cachedCurrentWorkspace: string | null = null;
let cachedCurrentDurable: NativeSessionDto[] = EMPTY_SESSIONS;
let cachedCurrentHot: NativeSessionDto[] = EMPTY_SESSIONS;
let cachedCurrentVisible: NativeSessionDto[] = EMPTY_SESSIONS;
let cachedDurableByWorkspace: Record<string, NativeSessionDto[]> | null = null;
let cachedHotByWorkspace: Record<string, NativeSessionDto[]> | null = null;
let cachedVisibleByWorkspace: Record<string, NativeSessionDto[]> = {};

export function selectCurrentWorkspaceSessions(state: SessionDirectoryState): NativeSessionDto[] {
	if (!state.currentWorkspaceHandle) return EMPTY_SESSIONS;
	const durable = state.sessionsByWorkspace[state.currentWorkspaceHandle] ?? EMPTY_SESSIONS;
	const hot = state.hotSessionsByWorkspace[state.currentWorkspaceHandle] ?? EMPTY_SESSIONS;
	if (
		cachedCurrentWorkspace === state.currentWorkspaceHandle &&
		cachedCurrentDurable === durable &&
		cachedCurrentHot === hot
	) {
		return cachedCurrentVisible;
	}
	cachedCurrentWorkspace = state.currentWorkspaceHandle;
	cachedCurrentDurable = durable;
	cachedCurrentHot = hot;
	cachedCurrentVisible = mergeVisibleSessions(durable, hot);
	return cachedCurrentVisible;
}

export function selectVisibleSessionsByWorkspace(
	state: SessionDirectoryState,
): Record<string, NativeSessionDto[]> {
	if (
		cachedDurableByWorkspace === state.sessionsByWorkspace &&
		cachedHotByWorkspace === state.hotSessionsByWorkspace
	) {
		return cachedVisibleByWorkspace;
	}
	const handles = new Set([
		...Object.keys(state.sessionsByWorkspace),
		...Object.keys(state.hotSessionsByWorkspace),
	]);
	cachedDurableByWorkspace = state.sessionsByWorkspace;
	cachedHotByWorkspace = state.hotSessionsByWorkspace;
	cachedVisibleByWorkspace = Object.fromEntries(
		[...handles].map((workspaceHandle) => [
			workspaceHandle,
			mergeVisibleSessions(
				state.sessionsByWorkspace[workspaceHandle] ?? EMPTY_SESSIONS,
				state.hotSessionsByWorkspace[workspaceHandle] ?? EMPTY_SESSIONS,
			),
		]),
	);
	return cachedVisibleByWorkspace;
}
