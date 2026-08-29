import type { NativeSessionDto, SessionRuntimeDto } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import { newSession } from "../src/lib/session-controller";
import { useComposerStore } from "../src/stores/composer";
import { useExtensionUiStore } from "../src/stores/extension-ui";
import { useProjectionStore } from "../src/stores/projection";
import { reconcileHiddenSessionLifecycle, useSessionDirectoryStore } from "../src/stores/session-directory";
import { emptySessionHistoryState, sessionTransport } from "../src/stores/session-transport";

const originalComposer = useComposerStore.getState();
const originalDirectory = useSessionDirectoryStore.getState();
const originalExtension = useExtensionUiStore.getState();
const originalProjection = useProjectionStore.getState();
const originalTransport = sessionTransport.store.getState();

function runtime(sessionHandle: string, recoverable = false): SessionRuntimeDto {
	return {
		serverEpoch: "test-server-epoch",
		sessionHandle,
		workspaceId: "workspace-a",
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/tmp/sessions/${sessionHandle}.jsonl`,
		cwd: "/tmp/workspace-a",
		generation: 4,
		lastSeq: 0,
		state: "idle",
		lastActivityAt: 1,
		recoverable,
	};
}

function session(sessionHandle: string, persisted: boolean): NativeSessionDto {
	return {
		sessionHandle,
		workspaceHandle: "workspace-a",
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/tmp/sessions/${sessionHandle}.jsonl`,
		persisted,
		createdAt: null,
		modifiedAt: null,
		messageCount: persisted ? 1 : 0,
		firstMessage: persisted ? sessionHandle : "",
		runtime: runtime(sessionHandle, persisted),
	};
}

function controlledTransient(sessionHandle: string) {
	const runtimeValue = runtime(sessionHandle);
	return {
		sessionHandle,
		subscribed: true,
		controllerIntent: true,
		runtime: runtimeValue,
		generation: 4,
		lastSeq: 0,
		projectedSeq: 0,
		baselineAuthoritative: true,
		freshLeaseBaseline: runtimeValue,
		recovery: null,
		lease: { isController: true, fencingToken: "fence-transient" },
		pendingExtensionRequests: [],
		resync: null,
		history: emptySessionHistoryState(),
		rawEvents: [],
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	useComposerStore.setState(originalComposer, true);
	useSessionDirectoryStore.setState(originalDirectory, true);
	useExtensionUiStore.setState(originalExtension, true);
	useProjectionStore.setState(originalProjection, true);
	sessionTransport.store.setState(originalTransport, true);
});

describe("transient Session navigation", () => {
	it("keeps a newly created unpersisted Session active without publishing an Empty session directory row", () => {
		const created = session("session-transient", false);
		sessionTransport.store.setState({
			sessions: {},
			releaseSession: vi.fn(() => true),
			unsubscribeSession: vi.fn(),
			subscribeSession: vi.fn(),
			claimSession: vi.fn(() => true),
			invalidateSessionSnapshot: vi.fn(() => false),
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: null,
			sessionsByWorkspace: { "workspace-a": [] },
			selectedSessionByWorkspace: {},
		});

		const token = useSessionDirectoryStore.getState().beginSessionCreation("workspace-a");
		expect(useSessionDirectoryStore.getState().completeSessionCreation(token, created)).toBe(true);

		expect(useSessionDirectoryStore.getState().currentSession).toMatchObject({
			sessionHandle: created.sessionHandle,
			persisted: false,
		});
		expect(useSessionDirectoryStore.getState().sessionsByWorkspace["workspace-a"]).toEqual([]);
	});

	it("publishes a materialized Session only after native metadata supplies its real title", async () => {
		const transient = session("session-transient", false);
		const runtimeOnly = {
			...transient,
			persisted: true,
			modifiedAt: "2026-08-21T00:00:00.000Z",
			runtime: runtime("session-transient", true),
		};
		const materialized = {
			...session("session-transient", true),
			createdAt: "2026-08-21T00:00:00.000Z",
			messageCount: 2,
			firstMessage: "Actual first prompt",
		};
		const listSessions = vi.spyOn(api, "listSessions").mockImplementation(async (_workspace, options) => ({
			sessions: options?.force ? [materialized] : [runtimeOnly],
			layout: { sessionDir: "/tmp/sessions", source: "default" as const },
		}));
		useSessionDirectoryStore.setState({
			workspaces: [
				{
					workspaceHandle: "workspace-a",
					path: "/tmp/workspace-a",
					available: true,
					pinned: false,
					displayName: "workspace-a",
					lastOpenedAt: null,
					sessionCount: 0,
					hasNativeHistory: false,
				},
			],
			currentWorkspaceHandle: "workspace-a",
			currentSession: transient,
			sessionsByWorkspace: { "workspace-a": [] },
			selectedSessionByWorkspace: { "workspace-a": transient.sessionHandle },
		});

		useSessionDirectoryStore.getState().applyRuntime(runtimeOnly.runtime);
		expect(useSessionDirectoryStore.getState().currentSession).toMatchObject({
			sessionHandle: transient.sessionHandle,
			persisted: true,
		});
		expect(useSessionDirectoryStore.getState().sessionsByWorkspace["workspace-a"]).toEqual([]);

		await useSessionDirectoryStore.getState().reloadSessions("workspace-a");
		expect(useSessionDirectoryStore.getState().sessionsByWorkspace["workspace-a"]).toEqual([]);
		expect(useSessionDirectoryStore.getState().workspaces[0]).toMatchObject({
			sessionCount: 0,
			hasNativeHistory: false,
		});
		expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe(transient.sessionHandle);

		await useSessionDirectoryStore.getState().reloadSessions("workspace-a", { force: true });
		expect(listSessions).toHaveBeenLastCalledWith("workspace-a", { force: true });
		expect(useSessionDirectoryStore.getState()).toMatchObject({
			workspaces: [{ sessionCount: 1, hasNativeHistory: true }],
			currentSession: {
				sessionHandle: materialized.sessionHandle,
				persisted: true,
				firstMessage: "Actual first prompt",
			},
			sessionsByWorkspace: {
				"workspace-a": [
					{
						sessionHandle: materialized.sessionHandle,
						persisted: true,
						firstMessage: "Actual first prompt",
					},
				],
			},
		});
	});

	it("keeps a persisted Fork parent while publishing the child only after native metadata lands", async () => {
		const parent = session("session-parent", true);
		const childRuntime = runtime("session-child", false);
		const materializedChild = {
			...session("session-child", true),
			createdAt: "2026-08-21T00:00:00.000Z",
			messageCount: 2,
			firstMessage: "Fork child prompt",
		};
		vi.spyOn(api, "listSessions").mockResolvedValue({
			sessions: [materializedChild, parent],
			layout: { sessionDir: "/tmp/sessions", source: "default" },
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: parent,
			sessionsByWorkspace: { "workspace-a": [parent] },
			selectedSessionByWorkspace: { "workspace-a": parent.sessionHandle },
		});

		useSessionDirectoryStore
			.getState()
			.rekeySession(parent.sessionHandle, childRuntime.sessionHandle, childRuntime);

		expect(useSessionDirectoryStore.getState().currentSession).toMatchObject({
			sessionHandle: childRuntime.sessionHandle,
			persisted: false,
		});
		expect(useSessionDirectoryStore.getState().sessionsByWorkspace["workspace-a"]).toEqual([parent]);

		useSessionDirectoryStore.getState().applyRuntime(runtime("session-child", true));
		expect(useSessionDirectoryStore.getState().sessionsByWorkspace["workspace-a"]).toEqual([parent]);
		await useSessionDirectoryStore.getState().reloadSessions("workspace-a", { force: true });
		expect(useSessionDirectoryStore.getState().currentSession).toMatchObject({
			sessionHandle: materializedChild.sessionHandle,
			persisted: true,
			firstMessage: "Fork child prompt",
		});
		expect(
			useSessionDirectoryStore
				.getState()
				.sessionsByWorkspace["workspace-a"]?.map((candidate) => candidate.sessionHandle),
		).toEqual([materializedChild.sessionHandle, parent.sessionHandle]);
	});

	it("abandons an untouched unpersisted Session without delaying the target view", async () => {
		const transient = session("session-transient", false);
		const target = session("session-history", true);
		let finishAbandon: (() => void) | undefined;
		const abandon = vi.spyOn(api, "abandonTransientSession").mockReturnValue(
			new Promise((resolve) => {
				finishAbandon = () => resolve({ ok: true, abandoned: true });
			}),
		);
		const releaseSession = vi.fn(() => true);
		const unsubscribeSession = vi.fn();
		sessionTransport.store.setState({
			sessions: { "session-transient": controlledTransient("session-transient") },
			releaseSession,
			unsubscribeSession,
			subscribeSession: vi.fn(),
			claimSession: vi.fn(() => true),
			invalidateSessionSnapshot: vi.fn(() => false),
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: transient,
			sessionsByWorkspace: { "workspace-a": [target] },
			locallyCreatedTransientSessions: { [transient.sessionHandle]: true },
			selectedSessionByWorkspace: { "workspace-a": transient.sessionHandle },
		});
		useComposerStore.getState().beginSession(transient.sessionHandle);

		useSessionDirectoryStore.getState().selectSession(target);

		expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe(target.sessionHandle);
		expect(abandon).toHaveBeenCalledWith("workspace-a", transient.sessionHandle, {
			generation: 4,
			fencingToken: "fence-transient",
		});
		expect(releaseSession).not.toHaveBeenCalledWith(transient.sessionHandle);
		finishAbandon?.();
		await vi.waitFor(() => {
			expect(unsubscribeSession).toHaveBeenCalledWith(transient.sessionHandle);
			expect(
				useSessionDirectoryStore
					.getState()
					.sessionsByWorkspace["workspace-a"]?.some(
						(candidate) => candidate.sessionHandle === transient.sessionHandle,
					),
			).toBe(false);
		});
	});

	it("releases but keeps the observer subscription for a recovered hot transient", () => {
		const recovered = session("session-recovered", false);
		const target = session("session-history", true);
		const abandon = vi.spyOn(api, "abandonTransientSession");
		const releaseSession = vi.fn(() => true);
		const unsubscribeSession = vi.fn();
		sessionTransport.store.setState({
			hotRuntimeInventory: {
				type: "hot_runtime_inventory",
				serverEpoch: "test-server-epoch",
				revision: 1,
				runtimes: [
					{
						serverEpoch: "test-server-epoch",
						sessionHandle: recovered.sessionHandle,
						workspaceId: "workspace-a",
						generation: 4,
						state: "idle",
					},
				],
			},
			sessions: { [recovered.sessionHandle]: controlledTransient(recovered.sessionHandle) },
			releaseSession,
			unsubscribeSession,
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: target,
			sessionsByWorkspace: { "workspace-a": [target] },
			locallyCreatedTransientSessions: {},
		});

		reconcileHiddenSessionLifecycle(recovered.sessionHandle);

		expect(abandon).not.toHaveBeenCalled();
		expect(releaseSession).toHaveBeenCalledWith(recovered.sessionHandle);
		expect(unsubscribeSession).not.toHaveBeenCalledWith(recovered.sessionHandle);
	});

	it("keeps a pinned recovered observer without a release acknowledgement loop", () => {
		const recovered = session("session-observer", false);
		const target = session("session-history", true);
		const releaseSession = vi.fn(() => true);
		const unsubscribeSession = vi.fn();
		sessionTransport.store.setState({
			hotRuntimeInventory: {
				type: "hot_runtime_inventory",
				serverEpoch: "test-server-epoch",
				revision: 1,
				runtimes: [
					{
						serverEpoch: "test-server-epoch",
						sessionHandle: recovered.sessionHandle,
						workspaceId: "workspace-a",
						generation: 4,
						state: "idle",
					},
				],
			},
			sessions: {
				[recovered.sessionHandle]: {
					...controlledTransient(recovered.sessionHandle),
					controllerIntent: false,
					lease: { isController: false },
				},
			},
			releaseSession,
			unsubscribeSession,
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: target,
			sessionsByWorkspace: { "workspace-a": [target] },
			locallyCreatedTransientSessions: {},
		});

		reconcileHiddenSessionLifecycle(recovered.sessionHandle);
		reconcileHiddenSessionLifecycle(recovered.sessionHandle);

		expect(releaseSession).not.toHaveBeenCalled();
		expect(unsubscribeSession).not.toHaveBeenCalled();
	});

	it("never abandons or releases a hidden transient Session before its baseline is authoritative", () => {
		const transient = session("session-transient", false);
		const target = session("session-history", true);
		const abandon = vi.spyOn(api, "abandonTransientSession");
		const releaseSession = vi.fn(() => true);
		const unsubscribeSession = vi.fn();
		sessionTransport.store.setState({
			sessions: {
				[transient.sessionHandle]: {
					...controlledTransient(transient.sessionHandle),
					baselineAuthoritative: false,
				},
			},
			releaseSession,
			unsubscribeSession,
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: target.workspaceHandle,
			currentSession: transient,
			sessionsByWorkspace: { [target.workspaceHandle]: [target] },
			selectedSessionByWorkspace: { [target.workspaceHandle]: transient.sessionHandle },
		});

		useSessionDirectoryStore.getState().selectSession(target);
		reconcileHiddenSessionLifecycle(transient.sessionHandle);

		expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe(target.sessionHandle);
		expect(abandon).not.toHaveBeenCalled();
		expect(releaseSession).not.toHaveBeenCalled();
		expect(unsubscribeSession).not.toHaveBeenCalled();
	});

	it("keeps a browser-only draft reachable through New session", async () => {
		const transient = session("session-transient", false);
		const target = session("session-history", true);
		const abandon = vi.spyOn(api, "abandonTransientSession");
		const createSession = vi.spyOn(api, "createSession");
		const releaseSession = vi.fn(() => true);
		const unsubscribeSession = vi.fn();
		sessionTransport.store.setState({
			sessions: { "session-transient": controlledTransient("session-transient") },
			releaseSession,
			unsubscribeSession,
			subscribeSession: vi.fn(),
			claimSession: vi.fn(() => true),
			invalidateSessionSnapshot: vi.fn(() => false),
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: transient,
			sessionsByWorkspace: { "workspace-a": [target] },
			locallyCreatedTransientSessions: { [transient.sessionHandle]: true },
			selectedSessionByWorkspace: { "workspace-a": transient.sessionHandle },
		});
		useComposerStore.getState().beginSession(transient.sessionHandle);
		useComposerStore.getState().setDraftForSession(transient.sessionHandle, "unfinished prompt");

		useSessionDirectoryStore.getState().selectSession(target);
		reconcileHiddenSessionLifecycle(transient.sessionHandle);

		expect(abandon).not.toHaveBeenCalled();
		expect(releaseSession).not.toHaveBeenCalledWith(transient.sessionHandle);
		expect(unsubscribeSession).not.toHaveBeenCalledWith(transient.sessionHandle);
		expect(useComposerStore.getState().bySession[transient.sessionHandle]?.draft).toBe("unfinished prompt");
		expect(useSessionDirectoryStore.getState().retainedTransientByWorkspace["workspace-a"]).toEqual(
			transient,
		);

		await newSession();
		expect(createSession).not.toHaveBeenCalled();
		expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe(transient.sessionHandle);
		expect(useSessionDirectoryStore.getState().retainedTransientByWorkspace["workspace-a"]).toBeUndefined();
		expect(useComposerStore.getState().draft).toBe("unfinished prompt");
	});

	it.each<[string, (sessionHandle: string) => void]>([
		[
			"draft",
			(sessionHandle) => useComposerStore.getState().setDraftForSession(sessionHandle, "unfinished prompt"),
		],
		[
			"image",
			(sessionHandle) =>
				useComposerStore
					.getState()
					.setImagesForSession(sessionHandle, [
						{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
					]),
		],
		[
			"selected command",
			(sessionHandle) =>
				useComposerStore.getState().setCommandForSession(sessionHandle, {
					name: "skill:e2e",
					displayName: "e2e",
					source: "skill",
				}),
		],
		[
			"attachment preparation",
			(sessionHandle) => {
				useComposerStore.getState().beginAttachmentWorkForSession(sessionHandle);
			},
		],
	])("retains transient control beyond the orphan TTL when local %s exists", (_label, prepare) => {
		vi.useFakeTimers();
		const transient = session("session-transient", false);
		const target = session("session-history", true);
		const abandon = vi.spyOn(api, "abandonTransientSession");
		const releaseSession = vi.fn(() => true);
		const unsubscribeSession = vi.fn();
		sessionTransport.store.setState({
			sessions: { "session-transient": controlledTransient("session-transient") },
			releaseSession,
			unsubscribeSession,
			subscribeSession: vi.fn(),
			claimSession: vi.fn(() => true),
			invalidateSessionSnapshot: vi.fn(() => false),
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: transient,
			sessionsByWorkspace: { "workspace-a": [target] },
			selectedSessionByWorkspace: { "workspace-a": transient.sessionHandle },
		});
		useComposerStore.getState().beginSession(transient.sessionHandle);
		prepare(transient.sessionHandle);

		useSessionDirectoryStore.getState().selectSession(target);
		reconcileHiddenSessionLifecycle(transient.sessionHandle);
		vi.advanceTimersByTime(31_000);

		expect(abandon).not.toHaveBeenCalled();
		expect(releaseSession).not.toHaveBeenCalledWith(transient.sessionHandle);
		expect(unsubscribeSession).not.toHaveBeenCalledWith(transient.sessionHandle);
		expect(
			useSessionDirectoryStore.getState().retainedTransientByWorkspace["workspace-a"]?.sessionHandle,
		).toBe(transient.sessionHandle);
	});

	it("abandons a hidden local draft when its Workspace is explicitly removed", async () => {
		const transient = session("session-transient", false);
		const target = session("session-history", true);
		const abandon = vi.spyOn(api, "abandonTransientSession").mockResolvedValue({
			ok: true,
			abandoned: true,
		});
		vi.spyOn(api, "removeWorkspace").mockResolvedValue({ ok: true, nativeHistoryRetained: true });
		vi.spyOn(api, "listWorkspaces").mockResolvedValue([]);
		const releaseSession = vi.fn(() => true);
		const unsubscribeSession = vi.fn();
		sessionTransport.store.setState({
			sessions: { "session-transient": controlledTransient("session-transient") },
			releaseSession,
			unsubscribeSession,
			subscribeSession: vi.fn(),
			claimSession: vi.fn(() => true),
			invalidateSessionSnapshot: vi.fn(() => false),
		});
		useSessionDirectoryStore.setState({
			workspaces: [
				{
					workspaceHandle: "workspace-a",
					path: "/tmp/workspace-a",
					available: true,
					pinned: false,
					displayName: "workspace-a",
					lastOpenedAt: null,
					sessionCount: 1,
					hasNativeHistory: true,
				},
			],
			currentWorkspaceHandle: "workspace-a",
			currentSession: target,
			sessionsByWorkspace: { "workspace-a": [target] },
			retainedTransientByWorkspace: { "workspace-a": transient },
			locallyCreatedTransientSessions: { [transient.sessionHandle]: true },
			selectedSessionByWorkspace: { "workspace-a": target.sessionHandle },
		});
		useComposerStore.getState().beginSession(transient.sessionHandle);
		useComposerStore.getState().setDraftForSession(transient.sessionHandle, "discard with Workspace");

		await useSessionDirectoryStore.getState().removeWorkspace("workspace-a");

		expect(abandon).toHaveBeenCalledWith("workspace-a", transient.sessionHandle, {
			generation: 4,
			fencingToken: "fence-transient",
		});
		expect(unsubscribeSession).toHaveBeenCalledWith(transient.sessionHandle);
		expect(useSessionDirectoryStore.getState().retainedTransientByWorkspace["workspace-a"]).toBeUndefined();
		expect(useSessionDirectoryStore.getState().currentWorkspaceHandle).toBeNull();
	});

	it("abandons every local hot transient while only releasing recovered hot Runtimes", async () => {
		const localA = session("local-a", false);
		const localB = session("local-b", false);
		const recovered = session("recovered-hot", false);
		const target = session("session-history", true);
		const abandon = vi.spyOn(api, "abandonTransientSession").mockResolvedValue({
			ok: true,
			abandoned: true,
		});
		vi.spyOn(api, "removeWorkspace").mockResolvedValue({ ok: true, nativeHistoryRetained: true });
		vi.spyOn(api, "listWorkspaces").mockResolvedValue([]);
		const releaseSession = vi.fn(() => true);
		const unsubscribeSession = vi.fn();
		sessionTransport.store.setState({
			sessions: {
				[localA.sessionHandle]: controlledTransient(localA.sessionHandle),
				[localB.sessionHandle]: controlledTransient(localB.sessionHandle),
				[recovered.sessionHandle]: controlledTransient(recovered.sessionHandle),
			},
			releaseSession,
			unsubscribeSession,
			subscribeSession: vi.fn(),
			claimSession: vi.fn(() => true),
			invalidateSessionSnapshot: vi.fn(() => false),
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: target,
			sessionsByWorkspace: { "workspace-a": [target] },
			hotSessionsByWorkspace: { "workspace-a": [localA, localB, recovered] },
			locallyCreatedTransientSessions: {
				[localA.sessionHandle]: true,
				[localB.sessionHandle]: true,
			},
			selectedSessionByWorkspace: { "workspace-a": target.sessionHandle },
		});

		await useSessionDirectoryStore.getState().removeWorkspace("workspace-a");

		expect(abandon.mock.calls.map(([, sessionHandle]) => sessionHandle).sort()).toEqual([
			"local-a",
			"local-b",
		]);
		expect(abandon).not.toHaveBeenCalledWith("workspace-a", recovered.sessionHandle, expect.anything());
		expect(releaseSession).toHaveBeenCalledWith(recovered.sessionHandle);
		expect(unsubscribeSession).toHaveBeenCalledWith(recovered.sessionHandle);
	});

	it("preserves a hidden local draft when removing its Workspace preference fails", async () => {
		const transient = session("session-transient", false);
		const abandon = vi.spyOn(api, "abandonTransientSession");
		vi.spyOn(api, "removeWorkspace").mockRejectedValue(new Error("preference write failed"));
		sessionTransport.store.setState({
			sessions: { "session-transient": controlledTransient("session-transient") },
			releaseSession: vi.fn(() => true),
			unsubscribeSession: vi.fn(),
			subscribeSession: vi.fn(),
			claimSession: vi.fn(() => true),
			invalidateSessionSnapshot: vi.fn(() => false),
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: null,
			sessionsByWorkspace: { "workspace-a": [] },
			retainedTransientByWorkspace: { "workspace-a": transient },
		});
		useComposerStore.getState().beginSession(transient.sessionHandle);
		useComposerStore.getState().setDraftForSession(transient.sessionHandle, "must survive failure");

		await expect(useSessionDirectoryStore.getState().removeWorkspace("workspace-a")).rejects.toThrow(
			"preference write failed",
		);

		expect(abandon).not.toHaveBeenCalled();
		expect(
			useSessionDirectoryStore.getState().retainedTransientByWorkspace["workspace-a"]?.sessionHandle,
		).toBe(transient.sessionHandle);
		expect(useComposerStore.getState().bySession[transient.sessionHandle]?.draft).toBe(
			"must survive failure",
		);
	});

	it("retains a local draft across Workspace navigation and resumes it from New session", async () => {
		const transient = session("session-transient", false);
		const createSession = vi.spyOn(api, "createSession");
		vi.spyOn(api, "activateWorkspace").mockImplementation(async (workspaceHandle) => ({
			workspaceHandle,
			path: `/tmp/${workspaceHandle}`,
			available: true,
			pinned: false,
			displayName: workspaceHandle,
			lastOpenedAt: null,
			sessionCount: 0,
			hasNativeHistory: false,
		}));
		vi.spyOn(api, "listSessions").mockResolvedValue({
			sessions: [],
			layout: { sessionDir: "/tmp/sessions", source: "default" },
		});
		sessionTransport.store.setState({
			sessions: { "session-transient": controlledTransient("session-transient") },
			releaseSession: vi.fn(() => true),
			unsubscribeSession: vi.fn(),
			subscribeSession: vi.fn(),
			claimSession: vi.fn(() => true),
			invalidateSessionSnapshot: vi.fn(() => false),
		});
		useSessionDirectoryStore.setState({
			workspaces: [
				{
					workspaceHandle: "workspace-a",
					path: "/tmp/workspace-a",
					available: true,
					pinned: false,
					displayName: "workspace-a",
					lastOpenedAt: null,
					sessionCount: 0,
					hasNativeHistory: false,
				},
				{
					workspaceHandle: "workspace-b",
					path: "/tmp/workspace-b",
					available: true,
					pinned: false,
					displayName: "workspace-b",
					lastOpenedAt: null,
					sessionCount: 0,
					hasNativeHistory: false,
				},
			],
			currentWorkspaceHandle: "workspace-a",
			currentSession: transient,
			locallyCreatedTransientSessions: { [transient.sessionHandle]: true },
			sessionsByWorkspace: { "workspace-a": [], "workspace-b": [] },
			selectedSessionByWorkspace: { "workspace-a": transient.sessionHandle },
		});
		useComposerStore.getState().beginSession(transient.sessionHandle);
		useComposerStore.getState().setDraftForSession(transient.sessionHandle, "cross-workspace draft");

		await useSessionDirectoryStore.getState().selectWorkspace("workspace-b");
		expect(
			useSessionDirectoryStore.getState().retainedTransientByWorkspace["workspace-a"]?.sessionHandle,
		).toBe(transient.sessionHandle);
		await useSessionDirectoryStore.getState().selectWorkspace("workspace-a");
		await newSession();

		expect(createSession).not.toHaveBeenCalled();
		expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe(transient.sessionHandle);
		expect(useComposerStore.getState().draft).toBe("cross-workspace draft");
	});

	it("defers cleanup during attachment preparation and abandons after an empty failure settles", async () => {
		const transient = session("session-transient", false);
		const target = session("session-history", true);
		const abandon = vi.spyOn(api, "abandonTransientSession").mockResolvedValue({
			ok: true,
			abandoned: true,
		});
		const releaseSession = vi.fn(() => true);
		const unsubscribeSession = vi.fn();
		sessionTransport.store.setState({
			sessions: { "session-transient": controlledTransient("session-transient") },
			releaseSession,
			unsubscribeSession,
			subscribeSession: vi.fn(),
			claimSession: vi.fn(() => true),
			invalidateSessionSnapshot: vi.fn(() => false),
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: transient,
			sessionsByWorkspace: { "workspace-a": [target] },
			locallyCreatedTransientSessions: { [transient.sessionHandle]: true },
			selectedSessionByWorkspace: { "workspace-a": transient.sessionHandle },
		});
		useComposerStore.getState().beginSession(transient.sessionHandle);
		const workId = useComposerStore.getState().beginAttachmentWorkForSession(transient.sessionHandle);

		useSessionDirectoryStore.getState().selectSession(target);
		expect(abandon).not.toHaveBeenCalled();
		expect(releaseSession).not.toHaveBeenCalledWith(transient.sessionHandle);

		useComposerStore.getState().finishAttachmentWorkForSession(transient.sessionHandle, workId);
		reconcileHiddenSessionLifecycle(transient.sessionHandle);
		await vi.waitFor(() => {
			expect(abandon).toHaveBeenCalledWith("workspace-a", transient.sessionHandle, {
				generation: 4,
				fencingToken: "fence-transient",
			});
			expect(unsubscribeSession).toHaveBeenCalledWith(transient.sessionHandle);
		});
	});

	it("cleans up a delayed create response without stealing navigation back from history", async () => {
		const created = session("session-created-late", false);
		const target = session("session-history", true);
		const abandon = vi.spyOn(api, "abandonTransientSession").mockResolvedValue({ ok: true, abandoned: true });
		const unsubscribeSession = vi.fn();
		const subscribeSession = vi.fn((sessionHandle: string) => {
			if (sessionHandle !== created.sessionHandle) return;
			sessionTransport.store.setState((state) => ({
				sessions: {
					...state.sessions,
					[sessionHandle]: controlledTransient(sessionHandle),
				},
			}));
		});
		sessionTransport.store.setState({
			sessions: {},
			subscribeSession,
			claimSession: vi.fn(() => true),
			releaseSession: vi.fn(() => true),
			unsubscribeSession,
			invalidateSessionSnapshot: vi.fn(() => false),
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: null,
			sessionsByWorkspace: { "workspace-a": [target] },
			selectedSessionByWorkspace: {},
		});
		const creationToken = useSessionDirectoryStore.getState().beginSessionCreation("workspace-a");
		useSessionDirectoryStore.getState().selectSession(target);

		expect(useSessionDirectoryStore.getState().completeSessionCreation(creationToken, created)).toBe(false);

		await vi.waitFor(() => {
			expect(abandon).toHaveBeenCalledWith("workspace-a", created.sessionHandle, {
				generation: 4,
				fencingToken: "fence-transient",
			});
			expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe(target.sessionHandle);
			expect(unsubscribeSession).toHaveBeenCalledWith(created.sessionHandle);
		});
	});
});
