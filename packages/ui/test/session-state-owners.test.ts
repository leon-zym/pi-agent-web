import type { NativeSessionDto, SessionRuntimeDto } from "@pi-agent-web/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendComposerHistory, loadComposerHistory } from "../src/features/composer/use-composer-history";
import {
	createRecordingSessionBrowserEffects,
	type RecordingSessionBrowserEffects,
} from "../src/lib/session-browser-effects";
import { createSessionStateOwners } from "../src/lib/session-state-owners";
import { useComposerStore } from "../src/stores/composer";
import { useExtensionUiStore } from "../src/stores/extension-ui";
import { useModelDirectoryStore } from "../src/stores/model-directory";
import { useProjectionStore } from "../src/stores/projection";
import { useSessionControlStore } from "../src/stores/session-control";
import { useSessionDirectoryStore } from "../src/stores/session-directory";
import { useSessionStatsStore } from "../src/stores/session-stats";
import { useSlashCommandsStore } from "../src/stores/slash-commands";
import { useViewStore } from "../src/stores/view";

const WORKSPACE = "workspace-state-owners";
const PARENT = "pending-parent";
const CHILD = "canonical-child";

function runtime(sessionHandle: string, generation: number): SessionRuntimeDto {
	return {
		serverEpoch: "epoch-state-owners",
		workspaceId: WORKSPACE,
		sessionHandle,
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/tmp/${sessionHandle}.jsonl`,
		cwd: "/tmp/workspace-state-owners",
		generation,
		lastSeq: 0,
		state: "idle",
		lastActivityAt: 1,
		recoverable: true,
	};
}

function session(sessionHandle: string, sessionRuntime: SessionRuntimeDto): NativeSessionDto {
	return {
		sessionHandle,
		workspaceHandle: WORKSPACE,
		nativeSessionId: sessionRuntime.nativeSessionId,
		sessionFile: sessionRuntime.sessionFile,
		persisted: true,
		createdAt: null,
		modifiedAt: null,
		messageCount: 0,
		firstMessage: "",
		runtime: sessionRuntime,
	};
}

describe("SessionStateOwners", () => {
	const originalComposer = useComposerStore.getState();
	const originalExtension = useExtensionUiStore.getState();
	const originalModel = useModelDirectoryStore.getState();
	const originalProjection = useProjectionStore.getState();
	const originalControl = useSessionControlStore.getState();
	const originalDirectory = useSessionDirectoryStore.getState();
	const originalStats = useSessionStatsStore.getState();
	const originalSlash = useSlashCommandsStore.getState();
	const originalView = useViewStore.getState();
	let effects: RecordingSessionBrowserEffects;

	beforeEach(() => {
		effects = createRecordingSessionBrowserEffects();
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		});
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: WORKSPACE,
			currentSession: null,
			sessionsByWorkspace: { [WORKSPACE]: [session(PARENT, runtime(PARENT, 1))] },
			selectedSessionByWorkspace: {},
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		useComposerStore.setState(originalComposer, true);
		useExtensionUiStore.setState(originalExtension, true);
		useModelDirectoryStore.setState(originalModel, true);
		useProjectionStore.setState(originalProjection, true);
		useSessionControlStore.setState(originalControl, true);
		useSessionDirectoryStore.setState(originalDirectory, true);
		useSessionStatsStore.setState(originalStats, true);
		useSlashCommandsStore.setState(originalSlash, true);
		useViewStore.setState(originalView, true);
	});

	it("applies create, snapshot, rekey, and dispose through every registered owner", () => {
		const owners = createSessionStateOwners({ effects });
		const parentRuntime = runtime(PARENT, 1);
		const parent = session(PARENT, parentRuntime);
		const created = owners.createSession({
			identity: {
				serverEpoch: parentRuntime.serverEpoch,
				workspaceId: WORKSPACE,
				sessionHandle: PARENT,
				generation: 1,
			},
			session: parent,
		});
		expect(created.status).toBe("committed");

		useComposerStore.getState().setDraftForSession(PARENT, "keep this draft");
		appendComposerHistory(WORKSPACE, PARENT, "keep this history");
		useProjectionStore
			.getState()
			.rebuildFromMessages(PARENT, [{ role: "user", content: "parent message", timestamp: 1 }]);
		useExtensionUiStore.getState().pushDialogForSession(PARENT, {
			request: {
				type: "extension_ui_request",
				id: "parent-dialog",
				method: "confirm",
				title: "Parent",
				message: "Keep parent state",
			},
			generation: 1,
			receivedAt: 1,
		});

		const childRuntime = runtime(CHILD, 2);
		const rekeyed = owners.rekeySession({
			previousIdentity: {
				serverEpoch: parentRuntime.serverEpoch,
				workspaceId: WORKSPACE,
				sessionHandle: PARENT,
				generation: 1,
			},
			identity: {
				serverEpoch: childRuntime.serverEpoch,
				workspaceId: WORKSPACE,
				sessionHandle: CHILD,
				generation: 2,
			},
			runtime: childRuntime,
		});
		expect(rekeyed.status).toBe("committed");
		expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe(CHILD);
		expect(useComposerStore.getState().bySession[CHILD]?.draft).toBe("keep this draft");
		expect(useComposerStore.getState().bySession[PARENT]).toBeUndefined();
		expect(useProjectionStore.getState().projections[PARENT]).toBeDefined();
		expect(useProjectionStore.getState().projections[CHILD]).toBeUndefined();
		expect(useModelDirectoryStore.getState().activeSessionHandle).toBe(CHILD);
		expect(useSlashCommandsStore.getState().activeSessionHandle).toBe(CHILD);
		expect(useSessionStatsStore.getState().activeSessionHandle).toBe(CHILD);
		expect(useExtensionUiStore.getState().bySession[PARENT]?.dialogs).toHaveLength(1);
		expect(useExtensionUiStore.getState().bySession[CHILD]?.dialogs).toEqual([]);
		expect(loadComposerHistory(WORKSPACE, CHILD)).toEqual(["keep this history"]);

		const snapshot = owners.applySnapshot({
			identity: {
				serverEpoch: childRuntime.serverEpoch,
				workspaceId: WORKSPACE,
				sessionHandle: CHILD,
				generation: 2,
			},
			runtime: childRuntime,
			settledMessages: [{ role: "user", content: "authoritative child", timestamp: 2 }],
			projectionEvents: [],
			queue: { steering: ["steer"], followUp: ["follow up"] },
			extensionRequests: [],
		});
		expect(snapshot.status).toBe("committed");
		expect(useComposerStore.getState().bySession[CHILD]?.queue).toEqual({
			steering: ["steer"],
			followUp: ["follow up"],
		});
		expect(useProjectionStore.getState().projections[CHILD]?.turns[0]?.userMessages[0]?.text).toBe(
			"authoritative child",
		);

		const disposed = owners.disposeSession({
			identity: {
				serverEpoch: childRuntime.serverEpoch,
				workspaceId: WORKSPACE,
				sessionHandle: CHILD,
				generation: 2,
			},
			workspaceHandle: WORKSPACE,
		});
		expect(disposed.status).toBe("committed");
		expect(owners.registry.currentIdentity(CHILD)).toBeNull();
		expect(useSessionDirectoryStore.getState().currentSession).toBeNull();
		expect(useProjectionStore.getState().projections[CHILD]).toBeUndefined();
		expect(useComposerStore.getState().bySession[CHILD]).toBeUndefined();
		expect(useExtensionUiStore.getState().bySession[CHILD]).toBeUndefined();
	});
});
