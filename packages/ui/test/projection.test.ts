import { beforeEach, describe, expect, it } from "vitest";
import { useProjectionStore } from "../src/stores/projection";

function resetProjectionStore(): void {
	useProjectionStore.setState({ projections: {}, order: [], currentSessionId: null });
}

describe("projection cache", () => {
	beforeEach(resetProjectionStore);

	it("keeps recently touched sessions instead of evicting the newest snapshots", () => {
		const store = useProjectionStore.getState();
		for (const sessionId of ["s1", "s2", "s3"]) {
			store.applyEvent(sessionId, { type: "agent_settled" } as never);
		}
		store.setCurrentSession("s1");
		store.applyEvent("s4", { type: "agent_settled" } as never);
		store.applyEvent("s5", { type: "agent_settled" } as never);

		const state = useProjectionStore.getState();
		expect(state.order).toEqual(["s5", "s4", "s1"]);
		expect(state.projections.s4).toBeDefined();
		expect(state.projections.s5).toBeDefined();
		expect(state.projections.s1).toBeDefined();
	});

	it("never evicts an active stream when trimming cached snapshots", () => {
		const store = useProjectionStore.getState();
		store.applyEvent("streaming", { type: "agent_start" } as never);
		for (const sessionId of ["s1", "s2", "s3", "s4"]) {
			store.applyEvent(sessionId, { type: "agent_settled" } as never);
		}

		const state = useProjectionStore.getState();
		expect(state.projections.streaming?.activeTurnId).not.toBeNull();
		expect(state.order).toContain("streaming");
	});

	it("marks replayed tool calls as errors when their tool result failed", () => {
		useProjectionStore.getState().rebuildFromMessages("s1", [
			{ role: "user", content: "Run it", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "false" } }],
			},
			{ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "failed", isError: true },
		]);

		const step = useProjectionStore.getState().projections.s1?.turns[0]?.steps[0];
		expect(step?.blocks[0]).toMatchObject({ type: "tool_call", toolCallId: "call-1", status: "error" });
		expect(step?.toolResults).toEqual([
			expect.objectContaining({ toolCallId: "call-1", content: "failed", isError: true }),
		]);
	});
});
