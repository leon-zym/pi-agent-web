import { describe, expect, it } from "vitest";
import {
	FUTURE_SESSION_CONTENT_REF_BUDGET,
	isExtensionUiRequestDto,
	isExtensionUiResponseDto,
	isFutureExtensionUiRequestDto,
	isFutureProductSessionEventDto,
	isFutureSessionCommandResponseDto,
	isFutureSessionEntryDto,
	isFutureSessionMessageDto,
	isFutureSessionProjectionEventDto,
	isFutureSessionReplayFrameDto,
	isFutureSessionSnapshotDto,
	isFutureSessionTreeDto,
	isFutureSessionWsServerMessage,
	isProductSessionEventDto,
	isSessionCommandResponseDto,
	isSessionMessageDto,
	isSessionSnapshotDto,
	isSessionWsClientMessage,
	isSessionWsServerMessage,
	SESSION_CONTENT_INLINE_THRESHOLD_BYTES,
	SESSION_PAYLOAD_BUDGET,
} from "../src/index.js";

const serverEpoch = "future-frame-epoch";
const context = {
	serverEpoch,
	payloadBudget: SESSION_PAYLOAD_BUDGET,
	contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
};
const attachmentContext = { serverEpoch, payloadBudget: SESSION_PAYLOAD_BUDGET };
const ref = {
	type: "content_ref",
	serverEpoch,
	sha256: "a".repeat(64),
	byteLength: SESSION_CONTENT_INLINE_THRESHOLD_BYTES,
	encoding: "utf-8",
} as const;
const externalText = { type: "external_text", ref } as const;
const externalJson = { type: "external_json", ref } as const;
const inlineJson = { type: "inline_json", value: { nested: { type: "external_json", ref } } } as const;
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function assistant() {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: externalJson }],
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	} as const;
}

function toolResult() {
	return {
		role: "toolResult",
		toolCallId: "tool-1",
		toolName: "read",
		content: [{ type: "text", text: { type: "external_text", ref: { ...ref } } }],
		details: {
			type: "inline_json",
			value: { nested: { type: "external_json", ref: { ...ref } } },
		},
		isError: false,
		timestamp: 1,
	} as const;
}

function entry() {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: "2026-08-28T00:00:00.000Z",
		message: toolResult(),
	} as const;
}

function runtime() {
	return {
		serverEpoch,
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		nativeSessionId: "native-a",
		sessionFile: "/tmp/session-a.jsonl",
		cwd: "/tmp/workspace-a",
		generation: 2,
		lastSeq: 2,
		state: "idle",
		lastActivityAt: 1,
		recoverable: true,
	} as const;
}

function projectionEvent() {
	return {
		type: "event",
		serverEpoch,
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		generation: 2,
		seq: 2,
		event: { type: "message_end", message: toolResult() },
	} as const;
}

function snapshot() {
	return {
		type: "session_snapshot",
		snapshotId: "snapshot-a",
		serverEpoch,
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		generation: 2,
		baseSeq: 1,
		asOfSeq: 2,
		runtime: runtime(),
		settledMessages: [toolResult()],
		projectionEvents: [projectionEvent()],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests: [],
		stickyExtensionState: [],
	} as const;
}

describe("future protocol 1.3 content-bearing frames", () => {
	it("admits only the three closed Extension UI roots with an exact future context", () => {
		const requests = [
			{
				type: "extension_ui_request",
				id: "editor-a",
				method: "editor",
				title: "Edit",
				prefill: externalText,
			},
			{
				type: "extension_ui_request",
				id: "editor-text-a",
				method: "set_editor_text",
				text: externalText,
			},
			{
				type: "extension_ui_request",
				id: "widget-inline-a",
				method: "setWidget",
				widgetKey: "tests",
				widgetLines: { type: "inline_json", value: ["one", "two"] },
			},
			{
				type: "extension_ui_request",
				id: "widget-external-a",
				method: "setWidget",
				widgetKey: "tests",
				widgetLines: externalJson,
			},
		] as const;
		for (const request of requests) {
			expect(isFutureExtensionUiRequestDto(request, context)).toBe(true);
			expect(isFutureExtensionUiRequestDto(request)).toBe(false);
			expect(isFutureExtensionUiRequestDto(request, { ...context, serverEpoch: "wrong" })).toBe(
				request.id === "widget-inline-a",
			);
			expect(isExtensionUiRequestDto(request)).toBe(false);
		}

		expect(
			isFutureExtensionUiRequestDto(
				{
					type: "extension_ui_request",
					id: "widget-clear",
					method: "setWidget",
					widgetKey: "tests",
				},
				context,
			),
		).toBe(true);
		expect(
			isFutureExtensionUiRequestDto(
				{
					type: "extension_ui_request",
					id: "widget-bare",
					method: "setWidget",
					widgetKey: "tests",
					widgetLines: ["not-normalized"],
				},
				context,
			),
		).toBe(false);
		expect(
			isFutureExtensionUiRequestDto(
				{
					type: "extension_ui_request",
					id: "widget-wrong-shape",
					method: "setWidget",
					widgetKey: "tests",
					widgetLines: { type: "inline_json", value: [{ type: "external_json", ref }] },
				},
				context,
			),
		).toBe(false);
		expect(
			isFutureExtensionUiRequestDto(
				{
					type: "extension_ui_request",
					id: "status-a",
					method: "setStatus",
					statusKey: "status",
					statusText: externalText,
				},
				context,
			),
		).toBe(false);
		expect(
			isExtensionUiResponseDto({
				type: "extension_ui_response",
				id: "editor-a",
				value: externalText,
			}),
		).toBe(false);
		expect(
			isSessionWsClientMessage({
				type: "extension_ui_response",
				sessionHandle: "session-a",
				expectedGeneration: 2,
				fencingToken: "lease-a",
				response: {
					type: "extension_ui_response",
					id: "editor-a",
					value: externalText,
				},
			}),
		).toBe(false);
		expect(
			isSessionWsClientMessage({
				type: "extension_ui_response",
				sessionHandle: "session-a",
				expectedGeneration: 2,
				fencingToken: "lease-a",
				response: { type: "extension_ui_response", id: "editor-a", value: "inline" },
			}),
		).toBe(true);
	});

	it("admits every reviewed message slot only with the exact future context", () => {
		const messages = [
			assistant(),
			toolResult(),
			{
				role: "custom",
				customType: "fixture",
				content: [{ type: "text", text: externalText }],
				details: externalJson,
				display: true,
				timestamp: 1,
			},
			{
				role: "bashExecution",
				command: "printf x",
				output: externalText,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		] as const;
		for (const message of messages) {
			expect(isFutureSessionMessageDto(message, context)).toBe(true);
			expect(isFutureSessionMessageDto(message)).toBe(false);
			expect(isFutureSessionMessageDto(message, { ...context, serverEpoch: "wrong" })).toBe(false);
		}
		expect(isSessionMessageDto(toolResult(), attachmentContext)).toBe(false);
		// In 1.2 this exact JSON root remains ordinary tool argument data; only the
		// future contextual guard gives it wrapper semantics.
		expect(isSessionMessageDto(assistant(), attachmentContext)).toBe(true);
	});

	it("keeps unreviewed message slots on the current contract", () => {
		expect(isFutureSessionMessageDto({ role: "user", content: externalText, timestamp: 1 }, context)).toBe(
			false,
		);
		expect(
			isFutureSessionMessageDto(
				{
					role: "assistant",
					content: [{ type: "text", text: externalText }],
					usage,
					stopReason: "stop",
					timestamp: 1,
				},
				context,
			),
		).toBe(false);
		expect(
			isFutureSessionMessageDto(
				{ role: "custom", customType: "bare", content: externalText, display: true, timestamp: 1 },
				context,
			),
		).toBe(false);
	});

	it("guards message/custom_message entries and trees while leaving other entry JSON current", () => {
		const customMessage = {
			type: "custom_message",
			id: "custom-1",
			parentId: null,
			timestamp: "2026-08-28T00:00:00.000Z",
			customType: "fixture",
			content: [{ type: "text", text: externalText }],
			details: externalJson,
			display: true,
		} as const;
		const tree = [{ entry: entry(), children: [{ entry: customMessage, children: [] }] }];
		expect(isFutureSessionEntryDto(entry(), context)).toBe(true);
		expect(isFutureSessionEntryDto(entry())).toBe(false);
		expect(isFutureSessionEntryDto(customMessage, context)).toBe(true);
		expect(isFutureSessionTreeDto(tree, context)).toBe(true);
		expect(isFutureSessionTreeDto(tree)).toBe(false);
		expect(
			isFutureSessionEntryDto(
				{
					type: "custom",
					id: "opaque-1",
					parentId: null,
					timestamp: "2026-08-28T00:00:00.000Z",
					customType: "opaque",
					data: { type: "external_json", ref },
				},
				context,
			),
		).toBe(true);
	});

	it("guards only the closed event roots and keeps done/error/delta/compaction current", () => {
		const events = [
			{ type: "agent_end", messages: [toolResult()], willRetry: false },
			{ type: "turn_end", message: assistant(), toolResults: [toolResult()] },
			{ type: "message_start", message: toolResult() },
			{ type: "message_end", message: toolResult() },
			{ type: "entry_appended", entry: entry() },
			{
				type: "message_update",
				usage,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "tool-1", name: "read", arguments: externalJson },
				},
			},
			{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: inlineJson },
			{
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "read",
				args: externalJson,
				partialResult: inlineJson,
			},
			{
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "read",
				result: externalJson,
				isError: false,
			},
		] as const;
		for (const event of events) {
			expect(isFutureProductSessionEventDto(event, context)).toBe(true);
		}
		expect(isFutureProductSessionEventDto(events[0])).toBe(false);
		expect(isProductSessionEventDto({ type: "message_end", message: toolResult() }, attachmentContext)).toBe(
			false,
		);
		expect(
			isProductSessionEventDto(
				{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: inlineJson },
				attachmentContext,
			),
		).toBe(true);
		const opaqueCompaction = {
			type: "compaction_end",
			reason: "manual",
			result: { type: "external_json", ref },
			aborted: false,
			willRetry: false,
		} as const;
		expect(isFutureProductSessionEventDto(opaqueCompaction, context)).toBe(true);
		expect(isProductSessionEventDto(opaqueCompaction, attachmentContext)).toBe(true);
		expect(
			isFutureProductSessionEventDto(
				{
					type: "message_update",
					usage,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: externalText },
				},
				context,
			),
		).toBe(false);
	});

	it.each(["get_messages", "get_entries", "get_tree"] as const)("guards reviewed %s responses", (command) => {
		const data =
			command === "get_messages"
				? { messages: [toolResult()] }
				: command === "get_entries"
					? { entries: [entry()], leafId: "entry-1" }
					: { tree: [{ entry: entry(), children: [] }], leafId: "entry-1" };
		const response = { type: "response", command, success: true, data } as const;
		expect(isFutureSessionCommandResponseDto(response, context)).toBe(true);
		expect(isFutureSessionCommandResponseDto(response)).toBe(false);
		expect(isSessionCommandResponseDto(response, attachmentContext)).toBe(false);
	});

	it("carries future content through replay, projection, snapshot, and WS guards", () => {
		const event = projectionEvent();
		const responseFrame = {
			type: "response",
			serverEpoch,
			sessionHandle: "session-a",
			generation: 2,
			barrierSeq: 2,
			response: {
				type: "response",
				command: "get_messages",
				success: true,
				data: { messages: [toolResult()] },
			},
		} as const;
		expect(isFutureSessionProjectionEventDto(event, context)).toBe(true);
		expect(isFutureSessionProjectionEventDto(event)).toBe(false);
		expect(isFutureSessionReplayFrameDto(event, context)).toBe(true);
		expect(isFutureSessionReplayFrameDto(event)).toBe(false);
		expect(isFutureSessionSnapshotDto(snapshot(), context)).toBe(true);
		expect(isFutureSessionSnapshotDto(snapshot())).toBe(false);
		expect(isFutureSessionWsServerMessage(event, context)).toBe(true);
		expect(isFutureSessionWsServerMessage(snapshot(), context)).toBe(true);
		expect(isFutureSessionWsServerMessage(responseFrame, context)).toBe(true);
		expect(isFutureSessionWsServerMessage(event)).toBe(false);
		expect(isSessionSnapshotDto(snapshot(), attachmentContext)).toBe(false);
		expect(isSessionWsServerMessage(responseFrame, attachmentContext)).toBe(false);
		expect(
			isFutureSessionWsServerMessage(
				{
					type: "extension_ui_result",
					serverEpoch,
					sessionHandle: "session-a",
					generation: 2,
					requestId: "request-a",
					outcome: "accepted",
				},
				context,
			),
		).toBe(true);
		const futureExtensionFrame = {
			type: "extension_ui_request",
			serverEpoch,
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 2,
			seq: 3,
			request: {
				type: "extension_ui_request",
				id: "editor-a",
				method: "set_editor_text",
				text: externalText,
			},
		} as const;
		expect(isFutureSessionReplayFrameDto(futureExtensionFrame, context)).toBe(true);
		expect(isSessionWsServerMessage(futureExtensionFrame, attachmentContext)).toBe(false);
		const extensionSnapshot = {
			type: "extension_ui_snapshot",
			serverEpoch,
			sessionHandle: "session-a",
			generation: 2,
			requests: [futureExtensionFrame.request],
		} as const;
		expect(isFutureSessionWsServerMessage(extensionSnapshot, context)).toBe(true);
		expect(isSessionWsServerMessage(extensionSnapshot, attachmentContext)).toBe(false);

		const snapshotWithExtension = {
			...snapshot(),
			pendingExtensionRequests: [
				{
					type: "extension_ui_request",
					id: "editor-prefill-a",
					method: "editor",
					title: "Edit",
					prefill: externalText,
				},
			],
			stickyExtensionState: [
				{
					...futureExtensionFrame.request,
					text: { type: "external_text", ref: { ...ref } },
				},
			],
		} as const;
		expect(isFutureExtensionUiRequestDto(snapshotWithExtension.pendingExtensionRequests[0], context)).toBe(
			true,
		);
		expect(isFutureExtensionUiRequestDto(snapshotWithExtension.stickyExtensionState[0], context)).toBe(true);
		expect(isFutureSessionSnapshotDto({ ...snapshotWithExtension, stickyExtensionState: [] }, context)).toBe(
			true,
		);
		expect(
			isFutureSessionSnapshotDto({ ...snapshotWithExtension, pendingExtensionRequests: [] }, context),
		).toBe(true);
		expect(isFutureSessionSnapshotDto(snapshotWithExtension, context)).toBe(true);
		expect(isSessionSnapshotDto(snapshotWithExtension, attachmentContext)).toBe(false);
	});

	it("keeps current 1.2 full-frame guards and wire budgets frozen", () => {
		expect("maxContentBlobBytes" in SESSION_PAYLOAD_BUDGET).toBe(false);
		expect(isSessionMessageDto({ role: "user", content: "current", timestamp: 1 })).toBe(true);
		expect(
			isSessionCommandResponseDto({
				type: "response",
				command: "get_messages",
				success: true,
				data: { messages: [] },
			}),
		).toBe(true);
		expect(isSessionWsServerMessage({ type: "runtime_state", runtime: runtime() })).toBe(true);
	});
});
