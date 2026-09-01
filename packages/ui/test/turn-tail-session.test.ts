import type { NativeSessionDto, SessionCommandDto, SessionRuntimeDto } from "@pi-agent-web/protocol";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forkFromEntry } from "../src/lib/session-controller";
import { sessionStateOwners } from "../src/lib/session-state-owners";
import { useComposerStore } from "../src/stores/composer";
import { useExtensionUiStore } from "../src/stores/extension-ui";
import { useModelDirectoryStore } from "../src/stores/model-directory";
import { useProjectionStore } from "../src/stores/projection";
import { useSessionDirectoryStore } from "../src/stores/session-directory";
import { useSessionStatsStore } from "../src/stores/session-stats";
import { sessionTransport } from "../src/stores/session-transport";
import type { SessionCommandCompletion } from "../src/stores/session-transport-contract";
import { useSlashCommandsStore } from "../src/stores/slash-commands";
import { useViewStore } from "../src/stores/view";

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		info: vi.fn(),
		success: vi.fn(),
	},
}));

const originalSendCommand = sessionTransport.store.getState().sendCommand;
const originalSendCommandWithIdentity = sessionTransport.store.getState().sendCommandWithIdentity;
const originalComposer = useComposerStore.getState();
const originalExtension = useExtensionUiStore.getState();
const originalModel = useModelDirectoryStore.getState();
const originalProjection = useProjectionStore.getState();
const originalDirectory = useSessionDirectoryStore.getState();
const originalStats = useSessionStatsStore.getState();
const originalSlash = useSlashCommandsStore.getState();
const originalView = useViewStore.getState();

afterEach(() => {
	for (const sessionHandle of ["session-fork-child", "session-fork-parent"]) {
		const identity = sessionStateOwners.registry.currentIdentity(sessionHandle);
		if (identity) {
			sessionStateOwners.disposeSession({
				identity,
				workspaceHandle: identity.workspaceId,
			});
		}
	}
	sessionTransport.store.setState({ sendCommand: originalSendCommand });
	sessionTransport.store.setState({ sendCommandWithIdentity: originalSendCommandWithIdentity });
	useComposerStore.setState(originalComposer, true);
	useExtensionUiStore.setState(originalExtension, true);
	useModelDirectoryStore.setState(originalModel, true);
	useProjectionStore.setState(originalProjection, true);
	useSessionDirectoryStore.setState(originalDirectory, true);
	useSessionStatsStore.setState(originalStats, true);
	useSlashCommandsStore.setState(originalSlash, true);
	useViewStore.setState(originalView, true);
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

const WORKSPACE = "workspace-fork-lifecycle";

function runtime(sessionHandle: string, generation: number): SessionRuntimeDto {
	return {
		serverEpoch: "epoch-fork-lifecycle",
		workspaceId: WORKSPACE,
		sessionHandle,
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/tmp/${sessionHandle}.jsonl`,
		cwd: "/tmp/workspace-fork-lifecycle",
		generation,
		lastSeq: 0,
		state: "idle",
		lastActivityAt: 1,
		recoverable: true,
	};
}

function nativeSession(sessionRuntime: SessionRuntimeDto): NativeSessionDto {
	return {
		sessionHandle: sessionRuntime.sessionHandle,
		workspaceHandle: WORKSPACE,
		nativeSessionId: sessionRuntime.nativeSessionId,
		sessionFile: sessionRuntime.sessionFile,
		persisted: true,
		createdAt: null,
		modifiedAt: null,
		messageCount: 1,
		firstMessage: "fork parent",
		runtime: sessionRuntime,
	};
}

describe("TurnTail Session targeting", () => {
	it("forks the explicitly captured turn Session", async () => {
		const sendCommandWithIdentity = vi.fn(
			async (
				sessionHandle: string,
				command: SessionCommandDto,
				_timeoutMs?: number,
			): Promise<SessionCommandCompletion> => {
				expect(sessionHandle).toBe("session-turn");
				expect(command).toEqual({ type: "fork", entryId: "entry-1" });
				return {
					identity: {
						serverEpoch: "epoch-turn",
						workspaceId: "workspace-turn",
						sessionHandle,
						generation: 1,
					},
					barrierSeq: 0,
					response: {
						type: "response",
						command: "fork",
						success: true,
						data: { text: "", cancelled: false },
					},
				};
			},
		);
		sessionTransport.store.setState({ sendCommandWithIdentity });

		await forkFromEntry("entry-1", "session-turn");

		expect(sendCommandWithIdentity).toHaveBeenCalledTimes(1);
	});

	it("acknowledges a fork after rekey with the child identity and fences stale effects", async () => {
		const parentRuntime = runtime("session-fork-parent", 1);
		const childRuntime = runtime("session-fork-child", 2);
		const parentIdentity = {
			serverEpoch: parentRuntime.serverEpoch,
			workspaceId: WORKSPACE,
			sessionHandle: parentRuntime.sessionHandle,
			generation: parentRuntime.generation,
		} as const;
		const childIdentity = {
			serverEpoch: childRuntime.serverEpoch,
			workspaceId: WORKSPACE,
			sessionHandle: childRuntime.sessionHandle,
			generation: childRuntime.generation,
		} as const;

		expect(
			sessionStateOwners.createSession({
				identity: parentIdentity,
				session: nativeSession(parentRuntime),
			}).status,
		).toBe("committed");

		let complete!: (completion: SessionCommandCompletion) => void;
		const sendCommandWithIdentity = vi.fn(
			() =>
				new Promise<SessionCommandCompletion>((resolve) => {
					complete = resolve;
				}),
		);
		sessionTransport.store.setState({ sendCommandWithIdentity });
		const fork = forkFromEntry("entry-1", parentRuntime.sessionHandle);

		const rekeyed = sessionStateOwners.rekeySession({
			previousIdentity: parentIdentity,
			identity: childIdentity,
			runtime: childRuntime,
		});
		expect(rekeyed.status).toBe("committed");
		expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe(
			childRuntime.sessionHandle,
		);

		const staleRun = vi.fn();
		expect(
			sessionStateOwners.effects.dispatch({
				type: "timer",
				identity: parentIdentity,
				dedupeKey: "fork-parent-stale",
				delayMs: 0,
				run: staleRun,
			}),
		).toBe(false);

		complete({
			identity: childIdentity,
			barrierSeq: 0,
			response: {
				type: "response",
				command: "fork",
				success: true,
				data: { text: "forked", cancelled: false },
			},
			previousSessionHandle: parentRuntime.sessionHandle,
		});
		await fork;

		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(staleRun).not.toHaveBeenCalled();
	});
});
