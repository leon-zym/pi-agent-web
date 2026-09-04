import type {
	NativeSessionDto,
	PiSessionCommandResponseDto,
	SessionCommandDto,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forkLastTurn } from "../src/features/conversation/TurnTail";
import {
	createRecordingSessionBrowserEffects,
	getSessionBrowserEffects,
	type SessionBrowserIdentity,
	setSessionBrowserEffects,
} from "../src/lib/session-browser-effects";
import { forkFromEntry } from "../src/lib/session-controller";
import { useSessionDirectoryStore } from "../src/stores/session-directory";
import { emptySessionHistoryState, sessionTransport } from "../src/stores/session-transport";
import type { SessionChannelState, SessionCommandCompletion } from "../src/stores/session-transport-contract";

const originalSendCommand = sessionTransport.store.getState().sendCommand;
const originalSendCommandWithIdentity = sessionTransport.store.getState().sendCommandWithIdentity;
const originalSessions = sessionTransport.store.getState().sessions;
const originalDirectory = useSessionDirectoryStore.getState();
const originalBrowserEffects = getSessionBrowserEffects();

const initiatingIdentity: SessionBrowserIdentity = {
	serverEpoch: "epoch-test",
	workspaceId: "workspace-test",
	sessionHandle: "session-turn",
	generation: 1,
};

function readResponse(messages: Array<{ entryId: string; text: string }>): PiSessionCommandResponseDto {
	return {
		type: "response",
		command: "get_fork_messages",
		success: true,
		data: { messages },
	};
}

function channel(identity: SessionBrowserIdentity): SessionChannelState {
	return {
		sessionHandle: identity.sessionHandle,
		subscribed: true,
		controllerIntent: true,
		runtime: {
			...identity,
			nativeSessionId: "native-turn",
			sessionFile: "/tmp/session-turn.jsonl",
			cwd: "/tmp/workspace-test",
			lastSeq: 0,
			state: "idle",
			lastActivityAt: 1,
			recoverable: true,
		},
		generation: identity.generation,
		baselineAuthoritative: true,
		freshLeaseBaseline: identity,
		lastSeq: 0,
		projectedSeq: 0,
		lease: { isController: true, fencingToken: "fence-turn" },
		pendingExtensionRequests: [],
		resync: null,
		recovery: null,
		history: {
			...emptySessionHistoryState(),
		},
		rawEvents: [],
	};
}

function visibleSession(identity: SessionBrowserIdentity): NativeSessionDto {
	return {
		sessionHandle: identity.sessionHandle,
		workspaceHandle: identity.workspaceId,
		nativeSessionId: "native-turn",
		sessionFile: "/tmp/session-turn.jsonl",
		persisted: true,
		createdAt: null,
		modifiedAt: null,
		messageCount: 1,
		firstMessage: "turn",
		runtime: channel(identity).runtime,
	};
}

afterEach(() => {
	sessionTransport.store.setState({
		sendCommand: originalSendCommand,
		sendCommandWithIdentity: originalSendCommandWithIdentity,
		sessions: originalSessions,
	});
	useSessionDirectoryStore.setState(originalDirectory, true);
	setSessionBrowserEffects(originalBrowserEffects);
	vi.restoreAllMocks();
});

describe("TurnTail Session targeting", () => {
	it("routes a no-result fork preflight through the shared effect boundary", async () => {
		const effects = createRecordingSessionBrowserEffects();
		setSessionBrowserEffects(effects);
		effects.setCurrentIdentity(initiatingIdentity);
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: initiatingIdentity.workspaceId,
			currentSession: visibleSession(initiatingIdentity),
		});
		sessionTransport.store.setState({
			sessions: { [initiatingIdentity.sessionHandle]: channel(initiatingIdentity) },
			sendCommand: vi.fn(async (_sessionHandle: string, command: SessionCommandDto) => {
				expect(command).toEqual({ type: "get_fork_messages" });
				return readResponse([]);
			}),
		});

		await forkLastTurn(initiatingIdentity.sessionHandle);

		expect(effects.intents.filter((effect) => effect.type === "toast")).toEqual([
			expect.objectContaining({ level: "info" }),
		]);
	});

	it("routes an async fork preflight error through the shared effect boundary", async () => {
		const effects = createRecordingSessionBrowserEffects();
		setSessionBrowserEffects(effects);
		effects.setCurrentIdentity(initiatingIdentity);
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: initiatingIdentity.workspaceId,
			currentSession: visibleSession(initiatingIdentity),
		});
		sessionTransport.store.setState({
			sessions: { [initiatingIdentity.sessionHandle]: channel(initiatingIdentity) },
			sendCommand: vi.fn(async () => {
				throw new Error("preflight failed");
			}),
		});

		await forkLastTurn(initiatingIdentity.sessionHandle);

		expect(effects.intents.filter((effect) => effect.type === "toast")).toEqual([
			expect.objectContaining({ level: "error", description: "preflight failed" }),
		]);
	});

	it("drops stale fork preflight feedback after the Session identity changes", async () => {
		const effects = createRecordingSessionBrowserEffects();
		setSessionBrowserEffects(effects);
		effects.setCurrentIdentity(initiatingIdentity);
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: initiatingIdentity.workspaceId,
			currentSession: visibleSession(initiatingIdentity),
		});
		let resolveRead!: (response: PiSessionCommandResponseDto) => void;
		const readPending = new Promise<PiSessionCommandResponseDto>((resolve) => {
			resolveRead = resolve;
		});
		sessionTransport.store.setState({
			sessions: { [initiatingIdentity.sessionHandle]: channel(initiatingIdentity) },
			sendCommand: vi.fn(() => readPending),
		});

		const pending = forkLastTurn(initiatingIdentity.sessionHandle);
		await vi.waitFor(() => expect(sessionTransport.store.getState().sendCommand).toHaveBeenCalledTimes(1));
		useSessionDirectoryStore.setState({
			currentSession: visibleSession({ ...initiatingIdentity, sessionHandle: "session-other" }),
		});
		effects.setCurrentIdentity({ ...initiatingIdentity, generation: 2 });
		resolveRead(readResponse([]));
		await pending;

		expect(effects.intents.filter((effect) => effect.type === "toast")).toHaveLength(0);
	});

	it("drops a late fork failure after the initiating Session is no longer visible", async () => {
		const effects = createRecordingSessionBrowserEffects();
		setSessionBrowserEffects(effects);
		effects.setCurrentIdentity(initiatingIdentity);
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: initiatingIdentity.workspaceId,
			currentSession: visibleSession(initiatingIdentity),
		});
		let rejectFork!: (error: Error) => void;
		const forkPending = new Promise<SessionCommandCompletion>((_resolve, reject) => {
			rejectFork = reject;
		});
		sessionTransport.store.setState({
			sessions: { [initiatingIdentity.sessionHandle]: channel(initiatingIdentity) },
			sendCommandWithIdentity: vi.fn(() => forkPending),
		});

		const pending = forkFromEntry("entry-1", initiatingIdentity.sessionHandle, initiatingIdentity);
		await vi.waitFor(() =>
			expect(sessionTransport.store.getState().sendCommandWithIdentity).toHaveBeenCalledTimes(1),
		);
		useSessionDirectoryStore.setState({
			currentSession: visibleSession({ ...initiatingIdentity, sessionHandle: "session-other" }),
		});
		rejectFork(new Error("late fork failure"));
		await pending;

		expect(effects.intents.filter((effect) => effect.type === "toast")).toHaveLength(0);
	});

	it("forks the explicitly captured turn Session", async () => {
		const effects = createRecordingSessionBrowserEffects();
		setSessionBrowserEffects(effects);
		const childIdentity = {
			serverEpoch: "epoch-test",
			workspaceId: "workspace-test",
			sessionHandle: "session-child",
			generation: 2,
		};
		effects.setCurrentIdentity(childIdentity);
		const sendCommandWithIdentity = vi.fn(
			async (
				sessionHandle: string,
				command: SessionCommandDto,
				_timeoutMs?: number,
			): Promise<SessionCommandCompletion> => {
				expect(sessionHandle).toBe("session-turn");
				expect(command).toEqual({ type: "fork", entryId: "entry-1" });
				return {
					identity: childIdentity,
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
		expect(effects.intents.filter((effect) => effect.type === "toast")).toEqual([
			expect.objectContaining({ level: "success", identity: childIdentity }),
		]);
	});
});
