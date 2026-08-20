import type { NativeSessionDto, SessionRuntimeDto } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import { useComposerStore } from "../src/stores/composer";
import { useExtensionUiStore } from "../src/stores/extension-ui";
import { useProjectionStore } from "../src/stores/projection";
import { reconcileHiddenSessionLifecycle, useSessionDirectoryStore } from "../src/stores/session-directory";
import { sessionTransport } from "../src/stores/session-transport";

const originalComposer = useComposerStore.getState();
const originalDirectory = useSessionDirectoryStore.getState();
const originalExtension = useExtensionUiStore.getState();
const originalProjection = useProjectionStore.getState();
const originalTransport = sessionTransport.store.getState();

function runtime(sessionHandle: string, recoverable = false): SessionRuntimeDto {
	return {
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
	return {
		sessionHandle,
		subscribed: true,
		controllerIntent: true,
		runtime: runtime(sessionHandle),
		generation: 4,
		lastSeq: 0,
		projectedSeq: 0,
		lease: { isController: true, fencingToken: "fence-transient" },
		pendingExtensionRequests: [],
		resync: null,
		rawEvents: [],
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	useComposerStore.setState(originalComposer, true);
	useSessionDirectoryStore.setState(originalDirectory, true);
	useExtensionUiStore.setState(originalExtension, true);
	useProjectionStore.setState(originalProjection, true);
	sessionTransport.store.setState(originalTransport, true);
});

describe("transient Session navigation", () => {
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
			sessionsByWorkspace: { "workspace-a": [transient, target] },
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

	it("keeps the lease for an unpersisted Session whose draft exists only in the browser", () => {
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
			sessionsByWorkspace: { "workspace-a": [transient, target] },
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
			sessionsByWorkspace: { "workspace-a": [transient, target] },
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
