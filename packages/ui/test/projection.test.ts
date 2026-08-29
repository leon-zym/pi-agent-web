import type { SessionEventDto } from "@pi-agent-web/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { useProjectionStore } from "../src/stores/projection";

const usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function resetProjectionStore(): void {
	useProjectionStore.setState({ projections: {}, order: [], currentSessionId: null });
}

describe("projection cache", () => {
	beforeEach(resetProjectionStore);

	it("preserves a trusted attachment ref while rebuilding settled history", () => {
		const ref = {
			type: "attachment_ref",
			serverEpoch: "epoch-a",
			sha256: "c".repeat(64),
			mediaType: "image/jpeg",
			byteLength: 128,
		};
		useProjectionStore.getState().rebuildFromMessages("s-ref", [
			{
				role: "user",
				content: [
					{ type: "text", text: "history ref" },
					{ type: "image", data: ref, mimeType: "image/jpeg" },
				],
				timestamp: 1,
			},
		]);

		expect(useProjectionStore.getState().projections["s-ref"]?.turns[0]?.userMessages[0]?.images).toEqual([
			{ type: "image", data: ref, mimeType: "image/jpeg" },
		]);
	});

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

	it("settles an active turn as an error and converges hanging tools when its Pi runtime is lost", () => {
		const store = useProjectionStore.getState();
		store.applyEvent("crashed", { type: "agent_start" } as never);
		store.applyEvent("crashed", {
			type: "message_start",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-crashed", name: "bash", arguments: { command: "sleep 10" } }],
			},
		} as never);
		store.markRuntimeFailure("crashed", "process exited");

		const projection = useProjectionStore.getState().projections.crashed;
		expect(projection?.activeTurnId).toBeNull();
		expect(projection?.replayable).toBe(true);
		const lastTurn = projection?.turns.at(-1);
		expect(lastTurn).toMatchObject({
			status: "error",
			errorMessage: "process exited",
		});
		expect(lastTurn?.steps[0]?.blocks[0]).toMatchObject({
			type: "tool_call",
			toolCallId: "call-crashed",
			status: "interrupted",
		});
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

	it("publishes one store commit for an ordered reducer batch", () => {
		const deltas = Array.from(
			{ length: 1_000 },
			() =>
				({
					type: "message_update",
					usage,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
				}) as SessionEventDto,
		);
		let commits = 0;
		const unsubscribe = useProjectionStore.subscribe(() => {
			commits += 1;
		});

		useProjectionStore
			.getState()
			.applyEvents("batched", [{ type: "agent_start" }, { type: "turn_start" }, ...deltas]);
		unsubscribe();

		expect(commits).toBe(1);
		expect(useProjectionStore.getState().projections.batched?.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			type: "text",
			markdown: "x".repeat(1_000),
		});
	});

	it("restores a running tool and its partial output from one authoritative snapshot", () => {
		const events: SessionEventDto[] = [
			{ type: "agent_start" },
			{ type: "turn_start" },
			{
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
			},
			{
				type: "message_update",
				usage,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "call-live", name: "bash", arguments: { command: "sleep 1" } },
				},
			},
			{
				type: "tool_execution_start",
				toolCallId: "call-live",
				toolName: "bash",
				args: { command: "sleep 1" },
			},
			{
				type: "tool_execution_update",
				toolCallId: "call-live",
				toolName: "bash",
				args: { command: "sleep 1" },
				partialResult: { output: "still running" },
			},
		];

		useProjectionStore.getState().applyAuthoritativeSnapshot("s1", [], events);

		const projection = useProjectionStore.getState().projections.s1;
		expect(projection?.activeTurnId).not.toBeNull();
		expect(projection?.turns.at(-1)?.steps[0]?.blocks[0]).toMatchObject({
			type: "tool_call",
			toolCallId: "call-live",
			status: "running",
			partialOutput: "still running",
		});
	});

	it("prepends older pages without changing the live tail or reusing view keys", () => {
		const store = useProjectionStore.getState();
		store.rebuildFromMessages("paged", [{ role: "user", content: "newest" }]);
		const newestBefore = useProjectionStore.getState().projections.paged?.turns[0];

		store.prependHistoricalMessages("paged", [{ role: "user", content: "older one" }]);
		store.prependHistoricalMessages("paged", [{ role: "user", content: "oldest" }]);

		const projection = useProjectionStore.getState().projections.paged;
		expect(projection?.turns.map((turn) => turn.userMessages[0]?.text)).toEqual([
			"oldest",
			"older one",
			"newest",
		]);
		expect(projection?.turns[2]).toBe(newestBefore);
		expect(new Set(projection?.turns.map((turn) => turn.id)).size).toBe(3);
		expect(
			new Set(projection?.turns.flatMap((turn) => turn.userMessages.map((message) => message.entryKey))).size,
		).toBe(3);
	});
});
