import type { NativeSessionDto, SessionRuntimeDto, SessionSnapshotDto } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import { initPipeline } from "../src/lib/stream-pipeline";
import { useComposerStore } from "../src/stores/composer";
import { useExtensionUiStore } from "../src/stores/extension-ui";
import { useProjectionStore } from "../src/stores/projection";
import { useSessionDirectoryStore } from "../src/stores/session-directory";
import { sessionTransport } from "../src/stores/session-transport";

const SESSION_HANDLE = "session-hidden-transient";
const TARGET_HANDLE = "session-visible-history";

const originalComposer = useComposerStore.getState();
const originalDirectory = useSessionDirectoryStore.getState();
const originalExtension = useExtensionUiStore.getState();
const originalProjection = useProjectionStore.getState();
const originalTransport = sessionTransport.store.getState();

function runtime(sessionHandle = SESSION_HANDLE): SessionRuntimeDto {
	return {
		serverEpoch: "epoch-a",
		workspaceId: "workspace-a",
		sessionHandle,
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/tmp/${sessionHandle}.jsonl`,
		cwd: "/tmp/workspace-a",
		generation: 4,
		lastSeq: 0,
		state: "idle",
		lastActivityAt: 1,
		recoverable: false,
	};
}

function nativeSession(sessionHandle: string, persisted: boolean): NativeSessionDto {
	return {
		sessionHandle,
		workspaceHandle: "workspace-a",
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/tmp/${sessionHandle}.jsonl`,
		persisted,
		createdAt: null,
		modifiedAt: null,
		messageCount: persisted ? 1 : 0,
		firstMessage: persisted ? "history" : "",
		runtime: runtime(sessionHandle),
	};
}

function snapshot(overrides: Partial<SessionSnapshotDto> = {}): SessionSnapshotDto {
	const snapshotRuntime = runtime();
	return {
		type: "session_snapshot",
		snapshotId: "snapshot-hidden",
		serverEpoch: snapshotRuntime.serverEpoch,
		workspaceId: snapshotRuntime.workspaceId,
		sessionHandle: snapshotRuntime.sessionHandle,
		generation: snapshotRuntime.generation,
		baseSeq: 0,
		asOfSeq: 0,
		runtime: snapshotRuntime,
		settledMessages: [],
		projectionEvents: [],
		queue: { steering: ["queued steering"], followUp: ["queued follow-up"] },
		pendingExtensionRequests: [],
		stickyExtensionState: [
			{
				type: "extension_ui_request",
				id: "editor-state",
				method: "set_editor_text",
				text: "authoritative editor text",
			},
		],
		...overrides,
	};
}

function prepareHiddenRecovery() {
	const transient = nativeSession(SESSION_HANDLE, false);
	const target = nativeSession(TARGET_HANDLE, true);
	const abandon = vi.spyOn(api, "abandonTransientSession");
	const releaseSession = vi.fn(() => true);
	const unsubscribeSession = vi.fn();
	useSessionDirectoryStore.setState({
		currentWorkspaceHandle: "workspace-a",
		currentSession: target,
		sessionsByWorkspace: { "workspace-a": [target] },
		selectedSessionByWorkspace: { "workspace-a": target.sessionHandle },
	});
	useComposerStore.getState().beginSession(SESSION_HANDLE);
	useExtensionUiStore.getState().beginSession(SESSION_HANDLE);
	sessionTransport.store.setState({
		connectionState: "online",
		connect: vi.fn(),
		sessions: {
			[SESSION_HANDLE]: {
				sessionHandle: SESSION_HANDLE,
				subscribed: true,
				controllerIntent: true,
				runtime: runtime(),
				generation: 4,
				baselineAuthoritative: false,
				freshLeaseBaseline: null,
				lastSeq: 0,
				projectedSeq: 0,
				lease: { isController: true, fencingToken: "stale-fence" },
				pendingExtensionRequests: [],
				resync: {
					reason: "gap",
					generation: 4,
					barrierSeq: 0,
					bufferedFrameCount: 0,
					requiresFreshBaseline: false,
				},
				recovery: null,
				rawEvents: [],
			},
		},
		releaseSession,
		unsubscribeSession,
	});
	return { abandon, releaseSession, target, transient, unsubscribeSession };
}

afterEach(() => {
	vi.restoreAllMocks();
	useComposerStore.setState(originalComposer, true);
	useSessionDirectoryStore.setState(originalDirectory, true);
	useExtensionUiStore.setState(originalExtension, true);
	useProjectionStore.setState(originalProjection, true);
	sessionTransport.store.setState(originalTransport, true);
});

describe("authoritative snapshot hidden lifecycle ordering", () => {
	it("waits for a matching fresh lease after snapshot commit before abandoning a hidden transient", async () => {
		const { abandon, releaseSession, unsubscribeSession } = prepareHiddenRecovery();
		abandon.mockResolvedValue({ ok: true, abandoned: true });
		initPipeline();

		sessionTransport.frameBus.emit(
			SESSION_HANDLE,
			snapshot({ queue: { steering: [], followUp: [] }, stickyExtensionState: [] }),
			1,
		);
		sessionTransport.store.setState((state) => ({
			sessions: {
				...state.sessions,
				[SESSION_HANDLE]: {
					...state.sessions[SESSION_HANDLE]!,
					baselineAuthoritative: true,
					resync: null,
				},
			},
		}));
		await Promise.resolve();

		expect(abandon).not.toHaveBeenCalled();
		expect(releaseSession).not.toHaveBeenCalled();
		expect(unsubscribeSession).not.toHaveBeenCalled();

		sessionTransport.ingestServerMessage({
			type: "lease_status",
			serverEpoch: "epoch-a",
			sessionHandle: SESSION_HANDLE,
			generation: 4,
			isController: true,
			fencingToken: "fresh-fence",
		});
		await Promise.resolve();

		expect(abandon).toHaveBeenCalledWith("workspace-a", SESSION_HANDLE, {
			generation: 4,
			fencingToken: "fresh-fence",
		});
	});

	it("does not reconcile lifecycle for a stale lease identity", async () => {
		const { abandon, releaseSession, unsubscribeSession } = prepareHiddenRecovery();
		initPipeline();
		sessionTransport.store.setState((state) => ({
			sessions: {
				...state.sessions,
				[SESSION_HANDLE]: {
					...state.sessions[SESSION_HANDLE]!,
					baselineAuthoritative: true,
					resync: null,
				},
			},
		}));

		sessionTransport.ingestServerMessage({
			type: "lease_status",
			serverEpoch: "epoch-stale",
			sessionHandle: SESSION_HANDLE,
			generation: 4,
			isController: true,
			fencingToken: "stale-fence",
		});
		await Promise.resolve();

		expect(abandon).not.toHaveBeenCalled();
		expect(releaseSession).not.toHaveBeenCalled();
		expect(unsubscribeSession).not.toHaveBeenCalled();
	});

	it("applies projection, queue, Extension, and runtime before considering transient cleanup", async () => {
		const { abandon, releaseSession, unsubscribeSession } = prepareHiddenRecovery();
		initPipeline();

		sessionTransport.frameBus.emit(SESSION_HANDLE, snapshot(), 1);

		expect(abandon).not.toHaveBeenCalled();
		expect(releaseSession).not.toHaveBeenCalled();
		expect(unsubscribeSession).not.toHaveBeenCalled();
		expect(useComposerStore.getState().bySession[SESSION_HANDLE]).toMatchObject({
			draft: "authoritative editor text",
			queue: { steering: ["queued steering"], followUp: ["queued follow-up"] },
		});
		expect(useExtensionUiStore.getState().bySession[SESSION_HANDLE]).toMatchObject({
			editorText: "authoritative editor text",
		});
		expect(useProjectionStore.getState().projections[SESSION_HANDLE]).toMatchObject({
			sessionId: SESSION_HANDLE,
			turns: [],
		});

		sessionTransport.store.setState((state) => ({
			sessions: {
				...state.sessions,
				[SESSION_HANDLE]: {
					...state.sessions[SESSION_HANDLE]!,
					baselineAuthoritative: true,
					resync: null,
				},
			},
		}));
		await Promise.resolve();

		expect(abandon).not.toHaveBeenCalled();
		expect(releaseSession).not.toHaveBeenCalled();
		expect(unsubscribeSession).not.toHaveBeenCalled();
	});

	it("cancels post-commit cleanup when the hidden Session becomes visible or rekeys", async () => {
		const { abandon, releaseSession, transient, unsubscribeSession } = prepareHiddenRecovery();
		initPipeline();
		sessionTransport.frameBus.emit(
			SESSION_HANDLE,
			snapshot({
				queue: { steering: [], followUp: [] },
				stickyExtensionState: [],
			}),
			1,
		);
		sessionTransport.store.setState((state) => ({
			sessions: {
				...state.sessions,
				[SESSION_HANDLE]: {
					...state.sessions[SESSION_HANDLE]!,
					baselineAuthoritative: true,
					resync: null,
				},
			},
		}));
		sessionTransport.ingestServerMessage({
			type: "lease_status",
			serverEpoch: "epoch-a",
			sessionHandle: SESSION_HANDLE,
			generation: 4,
			isController: true,
			fencingToken: "fresh-visible-fence",
		});
		useSessionDirectoryStore.setState({ currentSession: transient });
		await Promise.resolve();
		expect(abandon).not.toHaveBeenCalled();

		useSessionDirectoryStore.setState({ currentSession: nativeSession(TARGET_HANDLE, true) });
		sessionTransport.store.setState((state) => ({
			sessions: {
				...state.sessions,
				[SESSION_HANDLE]: {
					...state.sessions[SESSION_HANDLE]!,
					freshLeaseBaseline: null,
				},
			},
		}));
		sessionTransport.ingestServerMessage({
			type: "lease_status",
			serverEpoch: "epoch-a",
			sessionHandle: SESSION_HANDLE,
			generation: 4,
			isController: true,
			fencingToken: "fresh-rekey-fence",
		});
		sessionTransport.store.setState((state) => ({
			sessions: {
				...state.sessions,
				[SESSION_HANDLE]: {
					...state.sessions[SESSION_HANDLE]!,
					subscribed: false,
					controllerIntent: false,
					runtime: { ...runtime(), state: "dormant" },
					lease: { isController: false },
				},
				"session-rekeyed": {
					...state.sessions[SESSION_HANDLE]!,
					sessionHandle: "session-rekeyed",
					runtime: runtime("session-rekeyed"),
					baselineAuthoritative: true,
					resync: null,
				},
			},
		}));
		await Promise.resolve();

		expect(abandon).not.toHaveBeenCalled();
		expect(releaseSession).not.toHaveBeenCalled();
		expect(unsubscribeSession).not.toHaveBeenCalled();
	});
});
