import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { rebuildProjectionFromMessages } from "../src/stores/projection";
import { reduceProjection } from "../src/stores/projection-reducer";
import { createEmptyProjection } from "../src/types/view-models";

const usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ctx = { now: 1000 };

describe("hanging tool status convergence", () => {
	it("converges running tool calls to interrupted upon agent_settled", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-hanging", name: "bash", arguments: { command: "sleep 100" } },
					],
				},
			} as never,
			ctx,
		);
		p = reduceProjection(
			p,
			{
				type: "tool_execution_start",
				toolCallId: "call-hanging",
				toolName: "bash",
				args: { command: "sleep 100" },
			},
			ctx,
		);

		expect(p.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			type: "tool_call",
			toolCallId: "call-hanging",
			status: "running",
		});

		// Turn settles without tool_execution_end
		p = reduceProjection(p, { type: "turn_end", message: {} as never, toolResults: [] }, ctx);
		p = reduceProjection(p, { type: "agent_settled" }, ctx);

		expect(p.turns[0]?.status).toBe("settled");
		expect(p.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			type: "tool_call",
			toolCallId: "call-hanging",
			status: "interrupted",
		});
	});

	it("converges preparing tool calls to interrupted upon agent_settled", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(
			p,
			{
				type: "message_update",
				usage,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "call-prep", name: "read_file", arguments: { path: "foo.txt" } },
				},
			} as Extract<JsonAgentSessionEvent, { type: "message_update" }>,
			ctx,
		);

		expect(p.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			type: "tool_call",
			toolCallId: "call-prep",
			status: "preparing",
		});

		p = reduceProjection(p, { type: "agent_settled" }, ctx);

		expect(p.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			type: "tool_call",
			toolCallId: "call-prep",
			status: "interrupted",
		});
	});

	it("converges hanging tools to interrupted on aborted or error message_end", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-aborted", name: "bash", arguments: { command: "curl" } }],
				},
			} as never,
			ctx,
		);
		p = reduceProjection(
			p,
			{
				type: "tool_execution_start",
				toolCallId: "call-aborted",
				toolName: "bash",
				args: { command: "curl" },
			},
			ctx,
		);

		p = reduceProjection(
			p,
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-aborted", name: "bash", arguments: { command: "curl" } }],
					usage,
					stopReason: "aborted",
					timestamp: 0,
				},
			} as never,
			ctx,
		);

		expect(p.turns[0]?.status).toBe("aborted");
		expect(p.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			type: "tool_call",
			toolCallId: "call-aborted",
			status: "interrupted",
		});
	});

	it("preserves done, error, and skipped tool call statuses when settling", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-done", name: "bash", arguments: {} },
						{ type: "toolCall", id: "call-error", name: "bash", arguments: {} },
					],
				},
			} as never,
			ctx,
		);
		p = reduceProjection(
			p,
			{ type: "tool_execution_end", toolCallId: "call-done", toolName: "bash", result: "ok", isError: false },
			ctx,
		);
		p = reduceProjection(
			p,
			{
				type: "tool_execution_end",
				toolCallId: "call-error",
				toolName: "bash",
				result: "failed",
				isError: true,
			},
			ctx,
		);
		p = reduceProjection(p, { type: "agent_settled" }, ctx);

		expect(p.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			toolCallId: "call-done",
			status: "done",
		});
		expect(p.turns[0]?.steps[0]?.blocks[1]).toMatchObject({
			toolCallId: "call-error",
			status: "error",
		});
	});

	it("converges un-resulted tools to interrupted in rebuildProjectionFromMessages", () => {
		const messages = [
			{
				role: "user",
				content: "hello",
			},
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-crashed", name: "bash", arguments: { command: "npm test" } },
					{ type: "toolCall", id: "call-with-result", name: "read_file", arguments: { path: "a.txt" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "call-with-result",
				toolName: "read_file",
				content: "file content",
				isError: false,
			},
		];

		const p = rebuildProjectionFromMessages("s1", messages as never);
		expect(p.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			toolCallId: "call-crashed",
			status: "interrupted",
		});
		expect(p.turns[0]?.steps[0]?.blocks[1]).toMatchObject({
			toolCallId: "call-with-result",
			status: "done",
		});
	});
});
