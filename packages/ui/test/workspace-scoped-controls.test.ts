import type {
	NativeSessionCreateDto,
	NativeSessionDto,
	NativeWorkspaceDto,
	SessionRuntimeDto,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import { deleteSession, newSession, openSession, renameSession } from "../src/lib/session-controller";
import { selectCurrentWorkspaceSessions, useSessionDirectoryStore } from "../src/stores/session-directory";
import { sessionTransport } from "../src/stores/session-transport";

const originalTransport = sessionTransport.store.getState();
const originalDirectory = useSessionDirectoryStore.getState();

function workspace(workspaceHandle: string, available = true): NativeWorkspaceDto {
	return {
		workspaceHandle,
		path: `/tmp/${workspaceHandle}`,
		available,
		pinned: false,
		displayName: workspaceHandle,
		lastOpenedAt: null,
		sessionCount: 1,
		hasNativeHistory: true,
	};
}

function runtime(sessionHandle: string, workspaceHandle: string): SessionRuntimeDto {
	return {
		serverEpoch: "test-server-epoch",
		sessionHandle,
		workspaceId: workspaceHandle,
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/tmp/${workspaceHandle}/${sessionHandle}.jsonl`,
		cwd: `/tmp/${workspaceHandle}`,
		generation: 3,
		lastSeq: 0,
		state: "idle",
		lastActivityAt: 1,
		recoverable: true,
	};
}

function session(sessionHandle: string, workspaceHandle: string): NativeSessionDto {
	return {
		sessionHandle,
		workspaceHandle,
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/tmp/${workspaceHandle}/${sessionHandle}.jsonl`,
		persisted: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		modifiedAt: "2026-01-01T00:00:00.000Z",
		messageCount: 1,
		firstMessage: sessionHandle,
		runtime: null,
	};
}

function nativeList(sessions: NativeSessionDto[]) {
	return {
		sessions,
		layout: { sessionDir: "/tmp/sessions", source: "default" as const },
	};
}

function isolateTransportActions() {
	const subscribeSession = vi.fn();
	const claimSession = vi.fn(() => false);
	sessionTransport.store.setState({
		subscribeSession,
		claimSession,
		invalidateSessionSnapshot: vi.fn(() => false),
		releaseSession: vi.fn(() => false),
		unsubscribeSession: vi.fn(),
	});
	return { subscribeSession, claimSession };
}

afterEach(() => {
	vi.restoreAllMocks();
	sessionTransport.store.setState(originalTransport, true);
	useSessionDirectoryStore.setState(originalDirectory, true);
});

describe("Session-scoped controls", () => {
	it("keeps the empty Workspace Session snapshot referentially stable for React", () => {
		const state = useSessionDirectoryStore.getState();
		useSessionDirectoryStore.setState({ currentWorkspaceHandle: null, sessionsByWorkspace: {} });
		const first = selectCurrentWorkspaceSessions(useSessionDirectoryStore.getState());
		const second = selectCurrentWorkspaceSessions(useSessionDirectoryStore.getState());
		expect(first).toBe(second);
		useSessionDirectoryStore.setState(state, true);
	});

	it("boots into the most recently opened Workspace without opening its first Session", async () => {
		const firstWorkspace = workspace("workspace-first");
		const recentWorkspace = {
			...workspace("workspace-recent"),
			lastOpenedAt: 200,
		};
		const pinnedOlderWorkspace = {
			...workspace("workspace-pinned"),
			pinned: true,
			lastOpenedAt: 100,
		};
		const recentSession = session("session-recent", "workspace-recent");
		vi.spyOn(api, "listWorkspaces").mockResolvedValue([
			firstWorkspace,
			pinnedOlderWorkspace,
			recentWorkspace,
		]);
		vi.spyOn(api, "listSessions").mockImplementation(async (workspaceHandle) =>
			nativeList(workspaceHandle === "workspace-recent" ? [recentSession] : []),
		);
		const activateWorkspace = vi
			.spyOn(api, "activateWorkspace")
			.mockImplementation(async (workspaceHandle) => workspace(workspaceHandle));
		const { subscribeSession } = isolateTransportActions();
		useSessionDirectoryStore.setState({
			workspaces: [],
			currentWorkspaceHandle: null,
			currentSession: null,
			sessionsByWorkspace: {},
			selectedSessionByWorkspace: {},
		});

		await useSessionDirectoryStore.getState().loadWorkspaces();

		expect(useSessionDirectoryStore.getState()).toMatchObject({
			currentWorkspaceHandle: "workspace-recent",
			currentSession: null,
			selectedSessionByWorkspace: {},
			sessionsByWorkspace: {
				"workspace-recent": [{ sessionHandle: "session-recent" }],
			},
		});
		expect(subscribeSession).not.toHaveBeenCalled();
		expect(activateWorkspace).not.toHaveBeenCalled();
	});

	it("materializes the initial new Session in the preferred Workspace, not from history", async () => {
		const olderWorkspace = { ...workspace("workspace-older"), lastOpenedAt: 100 };
		const preferred = { ...workspace("workspace-preferred"), lastOpenedAt: 200 };
		const historical = session("session-historical", "workspace-preferred");
		const createdSession = {
			...session("session-created", "workspace-preferred"),
			messageCount: 0,
			firstMessage: "",
		};
		let resolveCreate: ((value: NativeSessionCreateDto) => void) | undefined;
		vi.spyOn(api, "listWorkspaces").mockResolvedValue([olderWorkspace, preferred]);
		vi.spyOn(api, "listSessions").mockResolvedValue(nativeList([historical]));
		const createSession = vi.spyOn(api, "createSession").mockReturnValue(
			new Promise<NativeSessionCreateDto>((resolve) => {
				resolveCreate = resolve;
			}),
		);
		isolateTransportActions();
		useSessionDirectoryStore.setState({
			workspaces: [],
			currentWorkspaceHandle: null,
			currentSession: null,
			sessionsByWorkspace: {},
			selectedSessionByWorkspace: {},
		});

		await useSessionDirectoryStore.getState().loadWorkspaces();
		const creation = newSession();

		expect(createSession).toHaveBeenCalledWith("workspace-preferred");
		expect(useSessionDirectoryStore.getState()).toMatchObject({
			currentSession: null,
			sessionCreation: { workspaceHandle: "workspace-preferred" },
		});
		resolveCreate?.({
			session: createdSession,
			runtime: runtime("session-created", "workspace-preferred"),
			layout: { sessionDir: "/tmp/sessions", source: "default" },
		});
		await creation;

		expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe("session-created");
	});

	it("keeps delayed native Session A results out of the selected Session B view", async () => {
		let releaseA: (() => void) | undefined;
		const gateA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const sessionA = session("session-a", "workspace-a");
		const sessionB = session("session-b", "workspace-b");
		vi.spyOn(api, "listSessions").mockImplementation(async (workspaceHandle) => {
			if (workspaceHandle === "workspace-a") await gateA;
			return nativeList(workspaceHandle === "workspace-a" ? [sessionA] : [sessionB]);
		});
		const activateWorkspace = vi
			.spyOn(api, "activateWorkspace")
			.mockImplementation(async (workspaceHandle) => workspace(workspaceHandle));
		isolateTransportActions();
		useSessionDirectoryStore.setState({
			workspaces: [workspace("workspace-a"), workspace("workspace-b")],
			currentWorkspaceHandle: null,
			currentSession: null,
			sessionsByWorkspace: {},
			selectedSessionByWorkspace: {},
		});

		const selectA = useSessionDirectoryStore.getState().selectWorkspace("workspace-a");
		const selectB = useSessionDirectoryStore.getState().selectWorkspace("workspace-b");
		await selectB;
		releaseA?.();
		await selectA;

		expect(useSessionDirectoryStore.getState()).toMatchObject({
			currentWorkspaceHandle: "workspace-b",
			currentSession: null,
			selectedSessionByWorkspace: {},
			sessionsByWorkspace: {
				"workspace-a": [{ sessionHandle: "session-a", nativeSessionId: "native-session-a" }],
				"workspace-b": [{ sessionHandle: "session-b", nativeSessionId: "native-session-b" }],
			},
		});
		expect(activateWorkspace).toHaveBeenCalledWith("workspace-a");
		expect(activateWorkspace).toHaveBeenCalledWith("workspace-b");
	});

	it("propagates an event-driven force refresh without letting an older response overwrite it", async () => {
		let releaseCached: (() => void) | undefined;
		const cachedGate = new Promise<void>((resolve) => {
			releaseCached = resolve;
		});
		const empty = { ...session("session-a", "workspace-a"), messageCount: 0, firstMessage: "" };
		const settled = {
			...session("session-a", "workspace-a"),
			messageCount: 2,
			firstMessage: "fresh prompt",
		};
		const listSessions = vi.spyOn(api, "listSessions").mockImplementation(async (_workspace, options) => {
			if (!options?.force) {
				await cachedGate;
				return nativeList([empty]);
			}
			return nativeList([settled]);
		});
		useSessionDirectoryStore.setState({
			workspaces: [workspace("workspace-a")],
			currentWorkspaceHandle: "workspace-a",
			currentSession: empty,
			sessionsByWorkspace: { "workspace-a": [empty] },
			selectedSessionByWorkspace: { "workspace-a": "session-a" },
		});

		const cachedReload = useSessionDirectoryStore.getState().reloadSessions("workspace-a");
		const forcedReload = useSessionDirectoryStore.getState().reloadSessions("workspace-a", { force: true });
		releaseCached?.();
		await Promise.all([cachedReload, forcedReload]);

		expect(listSessions).toHaveBeenCalledWith("workspace-a", { force: true });
		expect(useSessionDirectoryStore.getState()).toMatchObject({
			currentSession: { sessionHandle: "session-a", messageCount: 2, firstMessage: "fresh prompt" },
			sessionsByWorkspace: {
				"workspace-a": [{ sessionHandle: "session-a", messageCount: 2, firstMessage: "fresh prompt" }],
			},
		});
	});

	it("does not auto-select either stale or fresh Session results while loading a Workspace", async () => {
		let releaseSelection: (() => void) | undefined;
		const selectionGate = new Promise<void>((resolve) => {
			releaseSelection = resolve;
		});
		let releaseRefresh: (() => void) | undefined;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const stale = session("session-stale", "workspace-a");
		const fresh = session("session-fresh", "workspace-a");
		vi.spyOn(api, "listSessions").mockImplementation(async (_workspace, options) => {
			if (!options?.force) {
				await selectionGate;
				return nativeList([stale]);
			}
			await refreshGate;
			return nativeList([fresh]);
		});
		vi.spyOn(api, "activateWorkspace").mockImplementation(async (workspaceHandle) =>
			workspace(workspaceHandle),
		);
		isolateTransportActions();
		useSessionDirectoryStore.setState({
			workspaces: [workspace("workspace-a")],
			currentWorkspaceHandle: null,
			currentSession: null,
			sessionsByWorkspace: {},
			selectedSessionByWorkspace: {},
		});
		const observedSelections: string[] = [];
		const unsubscribe = useSessionDirectoryStore.subscribe((state) => {
			if (state.currentSession) observedSelections.push(state.currentSession.sessionHandle);
		});

		const selection = useSessionDirectoryStore.getState().selectWorkspace("workspace-a");
		const refresh = useSessionDirectoryStore.getState().reloadSessions("workspace-a", { force: true });
		releaseSelection?.();
		await Promise.resolve();
		releaseRefresh?.();
		await Promise.all([selection, refresh]);
		unsubscribe();

		expect(observedSelections).not.toContain("session-stale");
		expect(useSessionDirectoryStore.getState()).toMatchObject({
			currentWorkspaceHandle: "workspace-a",
			currentSession: null,
			selectedSessionByWorkspace: {},
			sessionsByWorkspace: {
				"workspace-a": [{ sessionHandle: "session-fresh" }],
			},
		});
	});

	it("leaves the old conversation synchronously without publishing a stale empty Session", async () => {
		const oldSession = session("session-old", "workspace-a");
		const nextSession = session("session-next", "workspace-a");
		const createdSession = {
			...session("session-created", "workspace-a"),
			messageCount: 0,
			firstMessage: "",
		};
		let resolveCreate: ((value: NativeSessionCreateDto) => void) | undefined;
		vi.spyOn(api, "createSession").mockReturnValue(
			new Promise<NativeSessionCreateDto>((resolve) => {
				resolveCreate = resolve;
			}),
		);
		vi.spyOn(api, "listSessions").mockResolvedValue(nativeList([createdSession, nextSession, oldSession]));
		isolateTransportActions();
		useSessionDirectoryStore.setState({
			workspaces: [workspace("workspace-a")],
			currentWorkspaceHandle: "workspace-a",
			currentSession: oldSession,
			sessionsByWorkspace: { "workspace-a": [oldSession, nextSession] },
			selectedSessionByWorkspace: { "workspace-a": "session-old" },
		});

		const creation = newSession();
		expect(useSessionDirectoryStore.getState()).toMatchObject({
			currentSession: null,
			sessionCreation: { workspaceHandle: "workspace-a" },
		});

		useSessionDirectoryStore.getState().selectSession(nextSession);
		expect(useSessionDirectoryStore.getState().sessionCreation).toBeNull();
		resolveCreate?.({
			session: createdSession,
			runtime: runtime("session-created", "workspace-a"),
			layout: { sessionDir: "/tmp/sessions", source: "default" },
		});
		await creation;

		expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe("session-next");
		expect(
			useSessionDirectoryStore
				.getState()
				.sessionsByWorkspace["workspace-a"]?.some(
					(candidate) => candidate.sessionHandle === "session-created",
				),
		).toBe(false);
	});

	it("opens an observer Session without requiring a controller lease", async () => {
		const observerSession = session("session-observer", "workspace-a");
		const activateWorkspace = vi.spyOn(api, "activateWorkspace").mockResolvedValue(workspace("workspace-a"));
		vi.spyOn(api, "listSessions").mockResolvedValue(nativeList([observerSession]));
		const { subscribeSession, claimSession } = isolateTransportActions();
		useSessionDirectoryStore.setState({
			workspaces: [workspace("workspace-a")],
			currentWorkspaceHandle: "workspace-a",
			currentSession: null,
			sessionsByWorkspace: { "workspace-a": [observerSession] },
			selectedSessionByWorkspace: {},
		});

		await openSession(observerSession);

		expect(useSessionDirectoryStore.getState().currentSession).toEqual(observerSession);
		expect(subscribeSession).toHaveBeenCalledWith("session-observer");
		expect(claimSession).toHaveBeenCalledWith("session-observer");
		expect(activateWorkspace).toHaveBeenCalledWith("workspace-a");
	});

	it("opens the exact cross-Workspace Session without an intermediate cached selection", async () => {
		let releaseTarget: (() => void) | undefined;
		const targetGate = new Promise<void>((resolve) => {
			releaseTarget = resolve;
		});
		const previousSession = session("session-previous", "workspace-a");
		const cachedFirst = session("session-cached-first", "workspace-b");
		const targetSession = session("session-target", "workspace-b");
		vi.spyOn(api, "activateWorkspace").mockResolvedValue(workspace("workspace-b"));
		vi.spyOn(api, "listSessions").mockImplementation(async () => {
			await targetGate;
			return nativeList([cachedFirst, targetSession]);
		});
		isolateTransportActions();
		useSessionDirectoryStore.setState({
			workspaces: [workspace("workspace-a"), workspace("workspace-b")],
			currentWorkspaceHandle: "workspace-a",
			currentSession: previousSession,
			sessionsByWorkspace: {
				"workspace-a": [previousSession],
				"workspace-b": [cachedFirst, targetSession],
			},
			selectedSessionByWorkspace: { "workspace-b": "session-cached-first" },
		});
		const observedSelections: string[] = [];
		const unsubscribe = useSessionDirectoryStore.subscribe((state) => {
			if (state.currentSession) observedSelections.push(state.currentSession.sessionHandle);
		});

		const opening = openSession(targetSession);
		expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe("session-target");
		releaseTarget?.();
		await opening;
		unsubscribe();

		expect(new Set(observedSelections)).toEqual(new Set(["session-target"]));
		expect(observedSelections).not.toContain("session-cached-first");
	});

	it("marks background settlement unread and clears it when that Session is selected", () => {
		const sessionA = session("session-a", "workspace-a");
		const sessionB = session("session-b", "workspace-a");
		isolateTransportActions();
		useSessionDirectoryStore.setState({
			workspaces: [workspace("workspace-a")],
			currentWorkspaceHandle: "workspace-a",
			currentSession: sessionB,
			sessionsByWorkspace: { "workspace-a": [sessionA, sessionB] },
			selectedSessionByWorkspace: { "workspace-a": "session-b" },
			unreadBySession: {},
		});

		useSessionDirectoryStore.getState().markSessionUnread("session-a");
		expect(useSessionDirectoryStore.getState().unreadBySession).toEqual({ "session-a": true });

		useSessionDirectoryStore.getState().selectSession(sessionA);
		expect(useSessionDirectoryStore.getState().unreadBySession).toEqual({});
	});

	it("refuses to rename a non-current Session even when its exact channel owns a lease", async () => {
		const sessionA = session("session-a", "workspace-a");
		const sessionB = session("session-b", "workspace-a");
		const sendCommand = vi.fn();
		sessionTransport.store.setState({
			sendCommand,
			sessions: {
				"session-a": {
					sessionHandle: "session-a",
					subscribed: true,
					controllerIntent: true,
					runtime: runtime("session-a", "workspace-a"),
					generation: 3,
					lastSeq: 0,
					projectedSeq: 0,
					baselineAuthoritative: true,
					freshLeaseBaseline: runtime("session-a", "workspace-a"),
					recovery: null,
					lease: { isController: true, fencingToken: "fence-a" },
					pendingExtensionRequests: [],
					resync: null,
					rawEvents: [],
				},
			},
		});
		useSessionDirectoryStore.setState({
			workspaces: [workspace("workspace-a")],
			currentWorkspaceHandle: "workspace-a",
			currentSession: sessionB,
			sessionsByWorkspace: { "workspace-a": [sessionA, sessionB] },
		});

		await renameSession(sessionA, "must not apply");

		expect(sendCommand).not.toHaveBeenCalled();
	});

	it("allows a controlled crashed Session to enter the gateway's recoverable deletion path", async () => {
		const crashedSession = session("session-crashed", "workspace-a");
		const crashedRuntime = { ...runtime("session-crashed", "workspace-a"), state: "crashed" as const };
		const releaseSession = vi.fn(() => true);
		const unsubscribeSession = vi.fn();
		sessionTransport.store.setState({
			releaseSession,
			unsubscribeSession,
			sessions: {
				"session-crashed": {
					sessionHandle: "session-crashed",
					subscribed: true,
					controllerIntent: true,
					runtime: crashedRuntime,
					generation: 3,
					lastSeq: 0,
					projectedSeq: 0,
					baselineAuthoritative: true,
					freshLeaseBaseline: crashedRuntime,
					recovery: null,
					lease: { isController: true, fencingToken: "fence-crashed" },
					pendingExtensionRequests: [],
					resync: null,
					rawEvents: [],
				},
			},
		});
		useSessionDirectoryStore.setState({
			workspaces: [workspace("workspace-a")],
			currentWorkspaceHandle: "workspace-a",
			currentSession: crashedSession,
			sessionsByWorkspace: { "workspace-a": [crashedSession] },
			selectedSessionByWorkspace: { "workspace-a": "session-crashed" },
		});
		const request = vi.spyOn(api, "deleteSession").mockResolvedValue({ ok: true, recoverable: true });
		vi.spyOn(api, "listWorkspaces").mockResolvedValue([workspace("workspace-a")]);

		await deleteSession(crashedSession);

		expect(request).toHaveBeenCalledWith("workspace-a", "session-crashed", {
			generation: 3,
			fencingToken: "fence-crashed",
		});
		expect(releaseSession).toHaveBeenCalledWith("session-crashed");
		expect(unsubscribeSession).toHaveBeenCalledWith("session-crashed");
	});
});
