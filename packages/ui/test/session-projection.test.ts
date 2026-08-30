import type {
	AssistantMessageDto,
	PiSessionEventDto,
	ProductSessionEventDto,
	SessionContentRefDto,
	SessionExternalJsonDto,
	SessionExternalTextDto,
	SessionInlineJsonDto,
	SessionJsonValueDto,
	SessionMessageDto,
} from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import type {
	ProjectedSessionFrameMessage,
	ProjectedSessionReplayFrame,
	ProjectedSessionSnapshot,
} from "../src/lib/session-content-adapter";
import { initPipeline } from "../src/lib/stream-pipeline";
import { rebuildProjectionFromMessages, useProjectionStore } from "../src/stores/projection";
import { reduceProjection } from "../src/stores/projection-reducer";
import { OrderedSessionFrameBus } from "../src/stores/session-frame-bus";
import { sessionTransport } from "../src/stores/session-transport";
import { createEmptyProjection } from "../src/types/view-models";

const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function contentRef(seed: string): SessionContentRefDto {
	return {
		type: "content_ref",
		serverEpoch: "epoch-projected-ui",
		sha256: seed.repeat(64),
		byteLength: 512 * 1024,
		encoding: "utf-8",
	};
}

const textRef = { type: "external_text", ref: contentRef("a") } satisfies SessionExternalTextDto;
const jsonRef = { type: "external_json", ref: contentRef("b") } satisfies SessionExternalJsonDto;

function projectedAssistantMessage(): AssistantMessageDto {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "projected assistant" },
			{ type: "toolCall", id: "call-projected", name: "projected-tool", arguments: jsonRef },
		],
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

describe("wire and projected Session frame carriers", () => {
	it("keeps explicit product provenance on the single ordered Session bus", () => {
		const bus = new OrderedSessionFrameBus();
		const modes: string[] = [];
		const orders: number[] = [];
		const projectedMessages: ProjectedSessionFrameMessage[] = [];
		bus.subscribe("session-projected", (frame) => {
			modes.push(frame.representation);
			orders.push(frame.order);
			if (frame.representation === "projected") projectedMessages.push(frame.message);
		});
		const current: PiSessionEventDto = { type: "agent_start" };
		const projected: ProductSessionEventDto = {
			type: "tool_execution_start",
			toolCallId: "call-projected",
			toolName: "projected-tool",
			args: jsonRef,
		};

		bus.emit(
			"session-projected",
			{
				type: "event",
				serverEpoch: "epoch-projected-ui",
				workspaceId: "workspace-projected-ui",
				sessionHandle: "session-projected",
				generation: 2,
				seq: 1,
				event: current,
			},
			1,
		);
		const projectedFrame: ProjectedSessionReplayFrame = {
			type: "event",
			serverEpoch: "epoch-projected-ui",
			workspaceId: "workspace-projected-ui",
			sessionHandle: "session-projected",
			generation: 2,
			seq: 2,
			event: projected,
		};
		bus.emit("session-projected", projectedFrame, 2, "projected");
		const assertEmitRequiresMode = () => {
			// @ts-expect-error  projected frames must declare their representation.
			bus.emit("session-projected", projectedFrame, 2);
			// @ts-expect-error  projected frames cannot be mislabeled as wire.
			bus.emit("session-projected", projectedFrame, 2, "wire");
		};

		expect(modes).toEqual(["wire", "projected"]);
		expect(orders).toEqual([1, 2]);
		expect(projectedMessages).toEqual([projectedFrame]);
		expect(assertEmitRequiresMode).toBeTypeOf("function");
	});

	it("retains live projected text and JSON roots as explicit lazy UI payloads", () => {
		let projection = createEmptyProjection("session-projected");
		projection = reduceProjection(projection, { type: "agent_start" }, { now: 1 });
		projection = reduceProjection(projection, { type: "turn_start" }, { now: 2 });
		projection = reduceProjection(
			projection,
			{ type: "message_start", message: projectedAssistantMessage() },
			{ now: 3, representation: "projected" },
		);
		projection = reduceProjection(
			projection,
			{
				type: "message_start",
				message: {
					role: "toolResult",
					toolCallId: "call-projected",
					toolName: "projected-tool",
					content: [{ type: "text", text: textRef }],
					details: jsonRef,
					isError: false,
					timestamp: 4,
				},
			},
			{ now: 4, representation: "projected" },
		);

		expect(projection.turns[0]?.steps[0]?.blocks).toMatchObject([
			{
				type: "text",
				markdown: "projected assistant",
			},
			{
				type: "tool_call",
				argsText: "",
				args: undefined,
				argsPayload: { kind: "external", value: jsonRef },
			},
		]);
		expect(projection.turns[0]?.steps[0]?.toolResults).toMatchObject([
			{
				content: "",
				textPayloads: [{ kind: "external", value: textRef }],
				detailsPayload: { kind: "external", value: jsonRef },
			},
		]);
	});

	it("unwraps only a provenance-approved inline JSON root and preserves nested lookalikes", () => {
		const nestedLookalike: SessionJsonValueDto = {
			type: "external_json",
			ref: {
				type: "content_ref",
				serverEpoch: "epoch-projected-ui",
				sha256: "c".repeat(64),
				byteLength: 512 * 1024,
				encoding: "utf-8",
			},
		};
		const projected: ProductSessionEventDto = {
			type: "tool_execution_start",
			toolCallId: "call-projected",
			toolName: "projected-tool",
			args: { type: "inline_json", value: nestedLookalike },
		};
		const current: PiSessionEventDto = {
			type: "tool_execution_start",
			toolCallId: "call-current",
			toolName: "current-tool",
			args: { type: "inline_json", value: nestedLookalike },
		};

		let projectedProjection = reduceProjection(
			createEmptyProjection("session-projected"),
			{ type: "agent_start" },
			{ now: 1 },
		);
		projectedProjection = reduceProjection(
			projectedProjection,
			{
				type: "message_start",
				message: {
					...projectedAssistantMessage(),
					content: [
						{
							type: "toolCall",
							id: "call-projected",
							name: "projected-tool",
							arguments: { type: "inline_json", value: nestedLookalike },
						},
					],
				},
			},
			{ now: 2, representation: "projected" },
		);
		projectedProjection = reduceProjection(projectedProjection, projected, {
			now: 3,
			representation: "projected",
		});

		let currentProjection = reduceProjection(
			createEmptyProjection("session-current"),
			{ type: "agent_start" },
			{ now: 1 },
		);
		currentProjection = reduceProjection(
			currentProjection,
			{
				type: "message_start",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-current",
							name: "current-tool",
							arguments: { type: "inline_json", value: nestedLookalike },
						},
					],
					usage,
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			{ now: 2 },
		);
		currentProjection = reduceProjection(currentProjection, current, { now: 3 });

		expect(projectedProjection.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			args: nestedLookalike,
			argsPayload: { kind: "inline", value: nestedLookalike },
		});
		expect(currentProjection.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			argsText: JSON.stringify({ type: "inline_json", value: nestedLookalike }),
			args: { type: "inline_json", value: nestedLookalike },
		});
		expect(currentProjection.turns[0]?.steps[0]?.blocks[0]).not.toHaveProperty("argsPayload");
	});

	it("retains tool execution args, partial results, and final results through settlement", () => {
		const inlineArgs = {
			type: "inline_json",
			value: { command: "run" },
		} satisfies SessionInlineJsonDto;
		let projection = reduceProjection(
			createEmptyProjection("session-projected-tool"),
			{ type: "agent_start" },
			{ now: 1 },
		);
		projection = reduceProjection(
			projection,
			{
				type: "message_start",
				message: {
					...projectedAssistantMessage(),
					content: [
						{
							type: "toolCall",
							id: "call-projected",
							name: "projected-tool",
							arguments: inlineArgs,
						},
					],
				},
			},
			{ now: 2, representation: "projected" },
		);
		projection = reduceProjection(
			projection,
			{
				type: "tool_execution_start",
				toolCallId: "call-projected",
				toolName: "projected-tool",
				args: inlineArgs,
			},
			{ now: 3, representation: "projected" },
		);
		projection = reduceProjection(
			projection,
			{
				type: "tool_execution_update",
				toolCallId: "call-projected",
				toolName: "projected-tool",
				args: inlineArgs,
				partialResult: jsonRef,
			},
			{ now: 4, representation: "projected" },
		);
		projection = reduceProjection(
			projection,
			{
				type: "tool_execution_end",
				toolCallId: "call-projected",
				toolName: "projected-tool",
				result: jsonRef,
				isError: false,
			},
			{ now: 5, representation: "projected" },
		);
		projection = reduceProjection(
			projection,
			{
				type: "message_end",
				message: {
					...projectedAssistantMessage(),
					content: [
						{ type: "toolCall", id: "call-projected", name: "projected-tool", arguments: inlineArgs },
					],
				},
			},
			{ now: 6, representation: "projected" },
		);

		expect(projection.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			args: { command: "run" },
			argsPayload: { kind: "inline", value: { command: "run" } },
			partialResultPayload: { kind: "external", value: jsonRef },
			resultPayload: { kind: "external", value: jsonRef },
		});
	});

	it("passes projected bash and custom message roots without adding product projection state", () => {
		const initial = createEmptyProjection("session-projected-ignored");
		const afterBash = reduceProjection(
			initial,
			{
				type: "message_start",
				message: {
					role: "bashExecution",
					command: "printf output",
					output: textRef,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
			},
			{ now: 1, representation: "projected" },
		);
		const afterCustom = reduceProjection(
			afterBash,
			{
				type: "message_start",
				message: {
					role: "custom",
					customType: "projected-content",
					content: [{ type: "text", text: textRef }],
					display: false,
					details: jsonRef,
					timestamp: 2,
				},
			},
			{ now: 2, representation: "projected" },
		);

		expect(afterBash).toBe(initial);
		expect(afterCustom).toBe(initial);
	});

	it("retains supported projected roots while rebuilding settled snapshot messages", () => {
		const toolResult: SessionMessageDto = {
			role: "toolResult",
			toolCallId: "call-projected",
			toolName: "projected-tool",
			content: [{ type: "text", text: textRef }],
			details: jsonRef,
			isError: false,
			timestamp: 2,
		};
		const projection = rebuildProjectionFromMessages(
			"session-projected",
			[{ role: "user", content: "run", timestamp: 0 }, projectedAssistantMessage(), toolResult],
			"projected",
		);
		const step = projection.turns[0]?.steps[0];

		expect(step?.blocks).toMatchObject([
			{ type: "text", markdown: "projected assistant" },
			{ type: "tool_call", argsPayload: { kind: "external", value: jsonRef } },
		]);
		expect(step?.toolResults).toMatchObject([
			{
				content: "",
				textPayloads: [{ kind: "external", value: textRef }],
				details: undefined,
				detailsPayload: { kind: "external", value: jsonRef },
			},
		]);
	});

	it("propagates projected provenance through live frames and authoritative snapshot rebuilds", () => {
		useProjectionStore.setState({ projections: {}, order: [], currentSessionId: null });
		sessionTransport.store.setState({ connect: () => undefined });
		initPipeline();
		const envelope = {
			serverEpoch: "epoch-projected-ui",
			workspaceId: "workspace-projected-ui",
			sessionHandle: "session-projected-pipeline",
			generation: 3,
		};
		const emitEvent = (seq: number, event: ProductSessionEventDto): void => {
			sessionTransport.frameBus.emit(
				envelope.sessionHandle,
				{ ...envelope, type: "event", seq, event },
				seq,
				"projected",
			);
		};

		emitEvent(1, { type: "agent_start" });
		emitEvent(2, { type: "turn_start" });
		emitEvent(3, { type: "message_start", message: projectedAssistantMessage() });
		expect(
			useProjectionStore.getState().projections[envelope.sessionHandle]?.turns[0]?.steps[0]?.blocks[1],
		).toMatchObject({ argsPayload: { kind: "external", value: jsonRef } });

		const snapshot: ProjectedSessionSnapshot = {
			...envelope,
			type: "session_snapshot",
			snapshotId: "snapshot-projected-pipeline",
			baseSeq: 3,
			asOfSeq: 3,
			runtime: {
				...envelope,
				nativeSessionId: "native-projected-pipeline",
				sessionFile: "/tmp/projected-pipeline.jsonl",
				cwd: "/tmp",
				lastSeq: 3,
				state: "running",
				lastActivityAt: 3,
				recoverable: true,
			},
			settledMessages: [{ role: "user", content: "snapshot", timestamp: 0 }, projectedAssistantMessage()],
			projectionEvents: [],
			queue: { steering: [], followUp: [] },
			pendingExtensionRequests: [],
			stickyExtensionState: [],
		};
		sessionTransport.frameBus.emit(envelope.sessionHandle, snapshot, 4, "projected");

		expect(
			useProjectionStore.getState().projections[envelope.sessionHandle]?.turns[0]?.steps[0]?.blocks[1],
		).toMatchObject({ argsPayload: { kind: "external", value: jsonRef } });
		const authoritative = useProjectionStore.getState().projections[envelope.sessionHandle];
		emitEvent(4, {
			type: "message_start",
			message: {
				role: "bashExecution",
				command: "printf output",
				output: textRef,
				cancelled: false,
				truncated: false,
				timestamp: 4,
			},
		});
		emitEvent(5, {
			type: "message_start",
			message: {
				role: "custom",
				customType: "projected-content",
				content: [{ type: "text", text: textRef }],
				display: false,
				details: jsonRef,
				timestamp: 5,
			},
		});
		expect(useProjectionStore.getState().projections[envelope.sessionHandle]).toBe(authoritative);
	});
});
