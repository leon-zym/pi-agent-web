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
		serverEpoch: "epoch-future-ui",
		sha256: seed.repeat(64),
		byteLength: 512 * 1024,
		encoding: "utf-8",
	};
}

const textRef = { type: "external_text", ref: contentRef("a") } satisfies SessionExternalTextDto;
const jsonRef = { type: "external_json", ref: contentRef("b") } satisfies SessionExternalJsonDto;

function futureAssistantMessage(): AssistantMessageDto {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "future assistant" },
			{ type: "toolCall", id: "call-future", name: "future-tool", arguments: jsonRef },
		],
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

describe("future Session projection carriers", () => {
	it("keeps explicit product provenance on the single ordered Session bus", () => {
		const bus = new OrderedSessionFrameBus();
		const modes: string[] = [];
		const orders: number[] = [];
		const futureMessages: ProjectedSessionFrameMessage[] = [];
		bus.subscribe("session-future", (frame) => {
			modes.push(frame.productMode);
			orders.push(frame.order);
			if (frame.productMode === "future") futureMessages.push(frame.message);
		});
		const current: PiSessionEventDto = { type: "agent_start" };
		const future: ProductSessionEventDto = {
			type: "tool_execution_start",
			toolCallId: "call-future",
			toolName: "future-tool",
			args: jsonRef,
		};

		bus.emit(
			"session-future",
			{
				type: "event",
				serverEpoch: "epoch-future-ui",
				workspaceId: "workspace-future-ui",
				sessionHandle: "session-future",
				generation: 2,
				seq: 1,
				event: current,
			},
			1,
		);
		const futureFrame: ProjectedSessionReplayFrame = {
			type: "event",
			serverEpoch: "epoch-future-ui",
			workspaceId: "workspace-future-ui",
			sessionHandle: "session-future",
			generation: 2,
			seq: 2,
			event: future,
		};
		bus.emit("session-future", futureFrame, 2, "future");
		const assertEmitRequiresMode = () => {
			// @ts-expect-error  frames must never fall through the current-default overload.
			bus.emit("session-future", futureFrame, 2);
			// @ts-expect-error  frames cannot be mislabeled as current.
			bus.emit("session-future", futureFrame, 2, "current");
		};

		expect(modes).toEqual(["current", "future"]);
		expect(orders).toEqual([1, 2]);
		expect(futureMessages).toEqual([futureFrame]);
		expect(assertEmitRequiresMode).toBeTypeOf("function");
	});

	it("retains live future text and JSON roots as explicit lazy UI payloads", () => {
		let projection = createEmptyProjection("session-future");
		projection = reduceProjection(projection, { type: "agent_start" }, { now: 1 });
		projection = reduceProjection(projection, { type: "turn_start" }, { now: 2 });
		projection = reduceProjection(
			projection,
			{ type: "message_start", message: futureAssistantMessage() },
			{ now: 3, productMode: "future" },
		);
		projection = reduceProjection(
			projection,
			{
				type: "message_start",
				message: {
					role: "toolResult",
					toolCallId: "call-future",
					toolName: "future-tool",
					content: [{ type: "text", text: textRef }],
					details: jsonRef,
					isError: false,
					timestamp: 4,
				},
			},
			{ now: 4, productMode: "future" },
		);

		expect(projection.turns[0]?.steps[0]?.blocks).toMatchObject([
			{
				type: "text",
				markdown: "future assistant",
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
				serverEpoch: "epoch-future-ui",
				sha256: "c".repeat(64),
				byteLength: 512 * 1024,
				encoding: "utf-8",
			},
		};
		const future: ProductSessionEventDto = {
			type: "tool_execution_start",
			toolCallId: "call-future",
			toolName: "future-tool",
			args: { type: "inline_json", value: nestedLookalike },
		};
		const current: PiSessionEventDto = {
			type: "tool_execution_start",
			toolCallId: "call-current",
			toolName: "current-tool",
			args: { type: "inline_json", value: nestedLookalike },
		};

		let futureProjection = reduceProjection(
			createEmptyProjection("session-future"),
			{ type: "agent_start" },
			{ now: 1 },
		);
		futureProjection = reduceProjection(
			futureProjection,
			{
				type: "message_start",
				message: {
					...futureAssistantMessage(),
					content: [
						{
							type: "toolCall",
							id: "call-future",
							name: "future-tool",
							arguments: { type: "inline_json", value: nestedLookalike },
						},
					],
				},
			},
			{ now: 2, productMode: "future" },
		);
		futureProjection = reduceProjection(futureProjection, future, {
			now: 3,
			productMode: "future",
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

		expect(futureProjection.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
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
			createEmptyProjection("session-future-tool"),
			{ type: "agent_start" },
			{ now: 1 },
		);
		projection = reduceProjection(
			projection,
			{
				type: "message_start",
				message: {
					...futureAssistantMessage(),
					content: [
						{
							type: "toolCall",
							id: "call-future",
							name: "future-tool",
							arguments: inlineArgs,
						},
					],
				},
			},
			{ now: 2, productMode: "future" },
		);
		projection = reduceProjection(
			projection,
			{
				type: "tool_execution_start",
				toolCallId: "call-future",
				toolName: "future-tool",
				args: inlineArgs,
			},
			{ now: 3, productMode: "future" },
		);
		projection = reduceProjection(
			projection,
			{
				type: "tool_execution_update",
				toolCallId: "call-future",
				toolName: "future-tool",
				args: inlineArgs,
				partialResult: jsonRef,
			},
			{ now: 4, productMode: "future" },
		);
		projection = reduceProjection(
			projection,
			{
				type: "tool_execution_end",
				toolCallId: "call-future",
				toolName: "future-tool",
				result: jsonRef,
				isError: false,
			},
			{ now: 5, productMode: "future" },
		);
		projection = reduceProjection(
			projection,
			{
				type: "message_end",
				message: {
					...futureAssistantMessage(),
					content: [{ type: "toolCall", id: "call-future", name: "future-tool", arguments: inlineArgs }],
				},
			},
			{ now: 6, productMode: "future" },
		);

		expect(projection.turns[0]?.steps[0]?.blocks[0]).toMatchObject({
			args: { command: "run" },
			argsPayload: { kind: "inline", value: { command: "run" } },
			partialResultPayload: { kind: "external", value: jsonRef },
			resultPayload: { kind: "external", value: jsonRef },
		});
	});

	it("passes future bash and custom message roots without adding product projection state", () => {
		const initial = createEmptyProjection("session-future-ignored");
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
			{ now: 1, productMode: "future" },
		);
		const afterCustom = reduceProjection(
			afterBash,
			{
				type: "message_start",
				message: {
					role: "custom",
					customType: "future-content",
					content: [{ type: "text", text: textRef }],
					display: false,
					details: jsonRef,
					timestamp: 2,
				},
			},
			{ now: 2, productMode: "future" },
		);

		expect(afterBash).toBe(initial);
		expect(afterCustom).toBe(initial);
	});

	it("retains supported future roots while rebuilding settled snapshot messages", () => {
		const toolResult: SessionMessageDto = {
			role: "toolResult",
			toolCallId: "call-future",
			toolName: "future-tool",
			content: [{ type: "text", text: textRef }],
			details: jsonRef,
			isError: false,
			timestamp: 2,
		};
		const projection = rebuildProjectionFromMessages(
			"session-future",
			[{ role: "user", content: "run", timestamp: 0 }, futureAssistantMessage(), toolResult],
			"future",
		);
		const step = projection.turns[0]?.steps[0];

		expect(step?.blocks).toMatchObject([
			{ type: "text", markdown: "future assistant" },
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

	it("propagates future provenance through live frames and authoritative snapshot rebuilds", () => {
		useProjectionStore.setState({ projections: {}, order: [], currentSessionId: null });
		sessionTransport.store.setState({ connect: () => undefined });
		initPipeline();
		const envelope = {
			serverEpoch: "epoch-future-ui",
			workspaceId: "workspace-future-ui",
			sessionHandle: "session-future-pipeline",
			generation: 3,
		};
		const emitEvent = (seq: number, event: ProductSessionEventDto): void => {
			sessionTransport.frameBus.emit(
				envelope.sessionHandle,
				{ ...envelope, type: "event", seq, event },
				seq,
				"future",
			);
		};

		emitEvent(1, { type: "agent_start" });
		emitEvent(2, { type: "turn_start" });
		emitEvent(3, { type: "message_start", message: futureAssistantMessage() });
		expect(
			useProjectionStore.getState().projections[envelope.sessionHandle]?.turns[0]?.steps[0]?.blocks[1],
		).toMatchObject({ argsPayload: { kind: "external", value: jsonRef } });

		const snapshot: ProjectedSessionSnapshot = {
			...envelope,
			type: "session_snapshot",
			snapshotId: "snapshot-future-pipeline",
			baseSeq: 3,
			asOfSeq: 3,
			runtime: {
				...envelope,
				nativeSessionId: "native-future-pipeline",
				sessionFile: "/tmp/future-pipeline.jsonl",
				cwd: "/tmp",
				lastSeq: 3,
				state: "running",
				lastActivityAt: 3,
				recoverable: true,
			},
			settledMessages: [{ role: "user", content: "snapshot", timestamp: 0 }, futureAssistantMessage()],
			projectionEvents: [],
			queue: { steering: [], followUp: [] },
			pendingExtensionRequests: [],
			stickyExtensionState: [],
		};
		sessionTransport.frameBus.emit(envelope.sessionHandle, snapshot, 4, "future");

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
				customType: "future-content",
				content: [{ type: "text", text: textRef }],
				display: false,
				details: jsonRef,
				timestamp: 5,
			},
		});
		expect(useProjectionStore.getState().projections[envelope.sessionHandle]).toBe(authoritative);
	});
});
