import type { SessionCommandDto } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRecordingSessionBrowserEffects,
	getSessionBrowserEffects,
	setSessionBrowserEffects,
} from "../src/lib/session-browser-effects";
import { forkFromEntry } from "../src/lib/session-controller";
import { sessionTransport } from "../src/stores/session-transport";
import type { SessionCommandCompletion } from "../src/stores/session-transport-contract";

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		info: vi.fn(),
		success: vi.fn(),
	},
}));

const originalSendCommand = sessionTransport.store.getState().sendCommand;
const originalSendCommandWithIdentity = sessionTransport.store.getState().sendCommandWithIdentity;
const originalBrowserEffects = getSessionBrowserEffects();

afterEach(() => {
	sessionTransport.store.setState({
		sendCommand: originalSendCommand,
		sendCommandWithIdentity: originalSendCommandWithIdentity,
	});
	setSessionBrowserEffects(originalBrowserEffects);
	vi.restoreAllMocks();
});

describe("TurnTail Session targeting", () => {
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
