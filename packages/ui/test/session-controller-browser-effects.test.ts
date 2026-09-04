import type {
	NativeSessionDto,
	PiSessionCommandResponseDto,
	SessionCommandDto,
	SessionRuntimeDto,
} from "@pi-agent-web/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import {
	createRecordingSessionBrowserEffects,
	getSessionBrowserEffects,
	setSessionBrowserEffects,
} from "../src/lib/session-browser-effects";
import { abortCurrentRun, newSession, submitDraft } from "../src/lib/session-controller";
import { useComposerStore } from "../src/stores/composer";
import { useSessionDirectoryStore } from "../src/stores/session-directory";
import { emptySessionHistoryState, sessionTransport } from "../src/stores/session-transport";
import type { SessionChannelState } from "../src/stores/session-transport-contract";

const identity: SessionRuntimeDto = {
	serverEpoch: "epoch-a",
	workspaceId: "workspace-a",
	sessionHandle: "session-a",
	generation: 3,
	nativeSessionId: "native-a",
	sessionFile: "/tmp/session-a.jsonl",
	cwd: "/tmp/workspace-a",
	lastSeq: 0,
	state: "idle",
	lastActivityAt: 1,
	recoverable: true,
};

const originalComposer = useComposerStore.getState();
const originalDirectory = useSessionDirectoryStore.getState();
const originalTransport = sessionTransport.store.getState();
const originalEffects = getSessionBrowserEffects();

let rejectCommand: (error: Error) => void = () => {};
let effectsForTest: ReturnType<typeof createRecordingSessionBrowserEffects>;

function channel(): SessionChannelState {
	return {
		sessionHandle: identity.sessionHandle,
		subscribed: true,
		controllerIntent: true,
		runtime: identity,
		generation: identity.generation,
		baselineAuthoritative: true,
		freshLeaseBaseline: identity,
		lastSeq: 0,
		projectedSeq: 0,
		lease: { isController: true, fencingToken: "fence-a" },
		pendingExtensionRequests: [],
		resync: null,
		recovery: null,
		history: emptySessionHistoryState(),
		rawEvents: [],
	};
}

function pendingCommand(): Promise<PiSessionCommandResponseDto> {
	return new Promise((_resolve, reject) => {
		rejectCommand = reject;
	});
}

beforeEach(() => {
	effectsForTest = createRecordingSessionBrowserEffects();
	effectsForTest.setCurrentIdentity(identity);
	setSessionBrowserEffects(effectsForTest);
	useSessionDirectoryStore.setState({
		currentWorkspaceHandle: identity.workspaceId,
		currentSession: {
			sessionHandle: identity.sessionHandle,
			workspaceHandle: identity.workspaceId,
		} as NativeSessionDto,
	});
	useComposerStore.setState({
		bySession: {},
		activeSessionHandle: null,
		draft: "",
		images: [],
		trigger: null,
		mentionTrigger: null,
		command: null,
		submitState: "plain",
		activeSubmitId: null,
		attachmentWorkCount: 0,
		fileReferences: [],
		attachmentWorkIds: [],
		deliveryMode: "auto",
		queue: { steering: [], followUp: [] },
		recentQueued: [],
		isExpanded: false,
	});
	sessionTransport.store.setState({
		connectionState: "online",
		sessions: { [identity.sessionHandle]: channel() },
		sendCommand: vi.fn((_sessionHandle: string, _command: SessionCommandDto) => pendingCommand()),
	});
});

afterEach(() => {
	getSessionBrowserEffects().dispose();
	setSessionBrowserEffects(originalEffects);
	useComposerStore.setState(originalComposer, true);
	useSessionDirectoryStore.setState(originalDirectory, true);
	sessionTransport.store.setState(originalTransport, true);
	vi.restoreAllMocks();
});

describe("controller Browser effect identity fencing", () => {
	it("drops a stale submit rejection and admits the next generation", async () => {
		useComposerStore.getState().beginSession(identity.sessionHandle);
		useComposerStore.getState().setDraft("late submit");
		const pending = submitDraft("prompt");
		await vi.waitFor(() => expect(sessionTransport.store.getState().sendCommand).toHaveBeenCalledTimes(1));

		const effects = effectsForTest;
		effects.setCurrentIdentity({ ...identity, generation: identity.generation + 1 });
		rejectCommand(new Error("old generation"));
		await pending;

		expect(effects.intents.filter((effect) => effect.type === "toast")).toHaveLength(0);
		expect(
			effects.dispatch({
				type: "toast",
				identity: { ...identity, generation: identity.generation + 1 },
				dedupeKey: "next-generation",
				level: "info",
				message: "next",
			}),
		).toBe(true);
	});

	it("drops a stale abort rejection", async () => {
		const pending = abortCurrentRun();
		await vi.waitFor(() => expect(sessionTransport.store.getState().sendCommand).toHaveBeenCalledTimes(1));

		const effects = effectsForTest;
		effects.setCurrentIdentity({ ...identity, generation: identity.generation + 1 });
		rejectCommand(new Error("old generation"));
		await pending;

		expect(effects.intents.filter((effect) => effect.type === "toast")).toHaveLength(0);
	});

	it("does not re-admit a Workspace after a late new-Session failure", async () => {
		let rejectCreate!: (error: Error) => void;
		const createPending = new Promise<never>((_resolve, reject) => {
			rejectCreate = reject;
		});
		vi.spyOn(api, "createSession").mockReturnValue(createPending);

		const pending = newSession();
		await vi.waitFor(() => expect(api.createSession).toHaveBeenCalledWith(identity.workspaceId));
		effectsForTest.invalidateWorkspaceIdentity({ workspaceId: identity.workspaceId });
		rejectCreate(new Error("late create failure"));
		await pending;

		expect(effectsForTest.currentWorkspaceIdentity(identity.workspaceId)).toBeNull();
		expect(effectsForTest.intents.filter((effect) => effect.type === "toast")).toHaveLength(0);
	});
});
