import type { PiSessionCommandResponseDto, SessionCommandDto } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forkFromEntry } from "../src/lib/session-controller";
import { sessionTransport } from "../src/stores/session-transport";

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		info: vi.fn(),
		success: vi.fn(),
	},
}));

const originalSendCommand = sessionTransport.store.getState().sendCommand;

afterEach(() => {
	sessionTransport.store.setState({ sendCommand: originalSendCommand });
	vi.restoreAllMocks();
});

describe("TurnTail Session targeting", () => {
	it("forks the explicitly captured turn Session", async () => {
		const sendCommand = vi.fn(
			async (
				sessionHandle: string,
				command: SessionCommandDto,
				_timeoutMs?: number,
			): Promise<PiSessionCommandResponseDto> => {
				expect(sessionHandle).toBe("session-turn");
				expect(command).toEqual({ type: "fork", entryId: "entry-1" });
				return {
					type: "response",
					command: "fork",
					success: true,
					data: { text: "", cancelled: false },
				};
			},
		);
		sessionTransport.store.setState({ sendCommand });

		await forkFromEntry("entry-1", "session-turn");

		expect(sendCommand).toHaveBeenCalledTimes(1);
	});
});
