import type { InlineSessionReplayFrameDto } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRecordingSessionBrowserEffects,
	getSessionBrowserEffects,
	type RecordingSessionBrowserEffects,
	setSessionBrowserEffects,
} from "../src/lib/session-browser-effects";
import { initPipeline } from "../src/lib/stream-pipeline";
import { useSessionDirectoryStore } from "../src/stores/session-directory";
import { sessionTransport } from "../src/stores/session-transport";

const SESSION_HANDLE = "session-settled-effects";
const originalDirectory = useSessionDirectoryStore.getState();
const originalTransport = sessionTransport.store.getState();
const originalEffects = getSessionBrowserEffects();
let effectsForTest: RecordingSessionBrowserEffects | null = null;

afterEach(() => {
	effectsForTest?.dispose();
	effectsForTest = null;
	setSessionBrowserEffects(originalEffects);
	useSessionDirectoryStore.setState(originalDirectory, true);
	sessionTransport.store.setState(originalTransport, true);
	vi.restoreAllMocks();
});

describe("stream pipeline Browser effect repeatability", () => {
	it("plays completion audio for two legitimate settled events while deduping a duplicate frame", () => {
		effectsForTest = createRecordingSessionBrowserEffects();
		effectsForTest.setCurrentIdentity({
			serverEpoch: "epoch-a",
			workspaceId: "workspace-a",
			sessionHandle: SESSION_HANDLE,
			generation: 1,
		});
		useSessionDirectoryStore.setState({ currentSession: null });
		sessionTransport.store.setState({
			connect: vi.fn(),
			sendCommand: vi.fn(async () => {
				throw new Error("stats command is outside this test");
			}),
		});
		initPipeline({ effects: effectsForTest });

		const settled = (seq: number): Extract<InlineSessionReplayFrameDto, { type: "event" }> => ({
			type: "event",
			serverEpoch: "epoch-a",
			workspaceId: "workspace-a",
			sessionHandle: SESSION_HANDLE,
			generation: 1,
			seq,
			event: { type: "agent_settled" },
		});

		sessionTransport.frameBus.emit(SESSION_HANDLE, settled(1), 1);
		sessionTransport.frameBus.emit(SESSION_HANDLE, settled(1), 2);
		sessionTransport.frameBus.emit(SESSION_HANDLE, settled(2), 3);

		expect(effectsForTest.intents.filter((effect) => effect.type === "audio")).toHaveLength(2);
	});
});
