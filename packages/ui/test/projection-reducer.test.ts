import type { SessionEventDto } from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import { reduceProjection } from "../src/stores/projection-reducer";
import { createEmptyProjection } from "../src/types/view-models";

/**
 * Stream assembler state machine tests. Fixtures are the
 * minimal wire shapes; the reducer only reads the fields it needs.
 */

const usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textDelta(
	contentIndex: number,
	delta: string,
): Extract<SessionEventDto, { type: "message_update" }> {
	return {
		type: "message_update",
		usage,
		assistantMessageEvent: { type: "text_delta", contentIndex, delta },
	} as Extract<SessionEventDto, { type: "message_update" }>;
}

function finalAssistant(
	text: string,
	stopReason = "stop",
	content?: unknown,
): Extract<SessionEventDto, { type: "message_end" }> {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: content ?? [{ type: "text", text }],
			api: "openai-completions",
			provider: "deepseek",
			model: "m",
			usage,
			stopReason,
			timestamp: 0,
		},
	} as Extract<SessionEventDto, { type: "message_end" }>;
}

const ctx = { now: 1000 };

describe("projection reducer", () => {
	it("preserves a trusted attachment ref in a live user message", () => {
		const ref = {
			type: "attachment_ref",
			serverEpoch: "epoch-a",
			sha256: "b".repeat(64),
			mediaType: "image/png",
			byteLength: 48,
		};
		const projection = reduceProjection(
			createEmptyProjection("s-ref"),
			{
				type: "message_start",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "with ref" },
						{ type: "image", data: ref, mimeType: "image/png" },
					],
					timestamp: 1,
				},
			} as never,
			ctx,
		);

		expect(projection.turns[0]?.userMessages[0]?.images).toEqual([
			{ type: "image", data: ref, mimeType: "image/png" },
		]);
	});

	it("assembles a full prompt round trip into one settled turn", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
			} as never,
			ctx,
		);
		p = reduceProjection(
			p,
			{
				type: "message_end",
				message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
			} as never,
			ctx,
		);
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: { role: "assistant", content: [] },
			} as never,
			ctx,
		);

		expect(p.turns).toHaveLength(1);
		expect(p.activeTurnId).toBe("turn-1");
		expect(p.turns[0]?.userMessages[0]?.text).toBe("hi");
		expect(p.turns[0]?.userMessages[0]?.source).toBe("prompt");

		p = reduceProjection(p, textDelta(0, "Hel"), ctx);
		p = reduceProjection(p, textDelta(0, "lo"), ctx);
		expect(p.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			type: "text",
			markdown: "Hello",
			isStreaming: true,
		});

		p = reduceProjection(p, finalAssistant("Hello, world"), ctx);
		// Final swap keeps the block key and settles the step.
		expect(p.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			type: "text",
			markdown: "Hello, world",
			isStreaming: false,
			key: "turn-1:0:0",
		});

		p = reduceProjection(p, { type: "turn_end", message: {} as never, toolResults: [] }, ctx);
		p = reduceProjection(p, { type: "agent_end", messages: [], willRetry: false }, ctx);
		expect(p.turns[0]?.status).toBe("running"); // agent_end never settles
		p = reduceProjection(p, { type: "agent_settled" }, ctx);
		expect(p.turns[0]?.status).toBe("settled");
		expect(p.activeTurnId).toBeNull();
		expect(p.replayable).toBe(true);
	});

	it("keeps the turn running when agent_end reports willRetry", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "agent_end", messages: [], willRetry: true }, ctx);
		expect(p.turns[0]?.status).toBe("running");
		expect(p.activeTurnId).toBe("turn-1");
	});

	it("marks aborted turns and keeps partial text", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(p, textDelta(0, "partial"), ctx);
		p = reduceProjection(p, finalAssistant("partial", "aborted"), ctx);
		p = reduceProjection(p, { type: "agent_settled" }, ctx);
		expect(p.turns[0]?.status).toBe("aborted");
		expect(p.turns[0]?.steps[0]?.blocks[0]).toMatchObject({ markdown: "partial", isStreaming: false });
	});

	it("marks error turns with the error message", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(p, finalAssistant("", "error"), ctx);
		p = reduceProjection(p, { type: "agent_settled" }, ctx);
		expect(p.turns[0]?.status).toBe("error");
	});

	it("tracks tool calls through preparing, running and done states", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(
			p,
			{
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
			} as Extract<SessionEventDto, { type: "message_update" }>,
			ctx,
		);
		p = reduceProjection(
			p,
			{
				type: "message_update",
				usage,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 1,
					toolCall: { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
				},
			} as Extract<SessionEventDto, { type: "message_update" }>,
			ctx,
		);
		const tool = () => p.turns[0]?.steps[0]?.blocks[1];
		expect(tool()).toMatchObject({
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "bash",
			status: "preparing",
		});

		p = reduceProjection(
			p,
			{ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } },
			ctx,
		);
		expect(tool()).toMatchObject({ status: "running" });

		p = reduceProjection(
			p,
			{
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				args: {},
				partialResult: { output: "file" },
			},
			ctx,
		);
		expect(tool()).toMatchObject({ partialOutput: "file" });

		p = reduceProjection(
			p,
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "bash",
				result: { output: "file\n" },
				isError: false,
			},
			ctx,
		);
		expect(tool()).toMatchObject({ status: "done", result: { output: "file\n" } });
	});

	it("marks preparing tools skipped when stopReason is length", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(
			p,
			{
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
			} as never,
			ctx,
		);
		p = reduceProjection(
			p,
			finalAssistant("", "length", [{ type: "toolCall", id: "call-x", name: "x", arguments: {} }]),
			ctx,
		);
		const tool = p.turns[0]?.steps[0]?.blocks[0];
		expect(tool).toMatchObject({ type: "tool_call", status: "skipped" });

		// A skipped tool never flips back to running.
		p = reduceProjection(p, { type: "tool_execution_start", toolCallId: "", toolName: "x", args: {} }, ctx);
		expect(p.turns[0]?.steps[0]?.blocks[0]).toMatchObject({ status: "skipped" });
	});

	it("attaches tool results to the step and mirrors queue updates", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "out" }],
					isError: false,
					timestamp: 0,
				},
			} as never,
			ctx,
		);
		expect(p.turns[0]?.steps[0]?.toolResults[0]).toMatchObject({ toolCallId: "call-1", content: "out" });

		p = reduceProjection(p, { type: "queue_update", steering: ["s1"], followUp: [] }, ctx);
		expect(p.queue.steering).toEqual(["s1"]);
	});

	it("promotes a tool block to error when its streamed result fails", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-fail", name: "bash", arguments: {} }],
				},
			} as never,
			ctx,
		);
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: {
					role: "toolResult",
					toolCallId: "call-fail",
					toolName: "bash",
					content: "failed",
					isError: true,
				},
			} as never,
			ctx,
		);

		const steps = p.turns[0]?.steps ?? [];
		const step = steps[steps.length - 1];
		expect(step?.blocks[0]).toMatchObject({ type: "tool_call", status: "error" });
		expect(step?.toolResults).toEqual([expect.objectContaining({ isError: true, content: "failed" })]);
	});

	it("labels injected user messages as steer via the injection source resolver", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: { role: "user", content: [{ type: "text", text: "steer me" }], timestamp: 0 },
			} as never,
			{ now: 2000, resolveInjectionSource: (text) => (text === "steer me" ? "steer" : undefined) },
		);
		expect(p.turns[0]?.userMessages[0]?.source).toBe("steer");
	});

	it("defaults a later user message to steer only after real conversation work", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "agent_start" }, ctx);
		p = reduceProjection(p, { type: "turn_start" }, ctx);
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: { role: "user", content: [{ type: "text", text: "initial" }], timestamp: 0 },
			} as never,
			ctx,
		);
		p = reduceProjection(p, textDelta(0, "working"), ctx);
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: { role: "user", content: [{ type: "text", text: "interrupt" }], timestamp: 1 },
			} as never,
			ctx,
		);

		expect(p.turns[0]?.userMessages.map((message) => message.source)).toEqual(["prompt", "steer"]);
	});

	it("collapses Pi-expanded skills into an invocation tag and keeps only user arguments", () => {
		let p = createEmptyProjection("skill");
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: {
					role: "user",
					content:
						'<skill name="review" location="/private/skill/SKILL.md">\nReferences are relative to /private/skill.\n\nSECRET INTERNAL BODY\n</skill>\n\nfocus on auth',
				},
			} as never,
			ctx,
		);

		expect(p.turns[0]?.userMessages[0]).toMatchObject({
			command: "/skill:review",
			text: "focus on auth",
		});
		expect(JSON.stringify(p.turns[0]?.userMessages[0])).not.toContain("SECRET INTERNAL BODY");
	});

	it("fails private when an expanded skill body contains an ambiguous closing delimiter", () => {
		let p = createEmptyProjection("ambiguous-skill");
		p = reduceProjection(
			p,
			{
				type: "message_start",
				message: {
					role: "user",
					content:
						'<skill name="review" location="/private/skill/SKILL.md">\nExample delimiter:\n</skill>\n\nSECRET BODY AFTER EXAMPLE\n</skill>\n\nreal user args',
				},
			} as never,
			ctx,
		);

		expect(p.turns[0]?.userMessages[0]).toMatchObject({
			command: "/skill:review",
			text: "",
		});
		expect(JSON.stringify(p.turns[0]?.userMessages[0])).not.toContain("SECRET");
		expect(JSON.stringify(p.turns[0]?.userMessages[0])).not.toContain("/private");
	});

	it("aggregates compaction and retry status rows", () => {
		let p = createEmptyProjection("s1");
		p = reduceProjection(p, { type: "compaction_start", reason: "manual" }, ctx);
		p = reduceProjection(
			p,
			{ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false },
			ctx,
		);
		expect(p.statusRows.find((r) => r.kind === "compaction")).toMatchObject({ state: "done" });
	});
});
