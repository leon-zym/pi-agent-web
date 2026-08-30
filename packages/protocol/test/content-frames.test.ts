import { describe, expect, it } from "vitest";
import {
	isExtensionUiRequestDto,
	isExtensionUiResponseDto,
	isInlineSessionSnapshotDto,
	isInlineSessionWsServerMessage,
	isPiExtensionUiRequestDto,
	isPiProductSessionEventDto,
	isPiSessionCommandResponseDto,
	isPiSessionMessageDto,
	isProductSessionEventDto,
	isSessionCommandResponseDto,
	isSessionEntryDto,
	isSessionMessageDto,
	isSessionProjectionEventDto,
	isSessionReplayFrameDto,
	isSessionSnapshotDto,
	isSessionTreeDto,
	isSessionWsClientMessage,
	isSessionWsServerMessage,
	SESSION_CONTENT_INLINE_THRESHOLD_BYTES,
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
} from "../src/index.js";

const serverEpoch = "future-frame-epoch";
const context = {
	serverEpoch,
	payloadBudget: SESSION_PAYLOAD_BUDGET,
	contentRefBudget: SESSION_CONTENT_REF_BUDGET,
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
			expect(isExtensionUiRequestDto(request, context)).toBe(true);
			expect(isExtensionUiRequestDto(request)).toBe(false);
			expect(isExtensionUiRequestDto(request, { ...context, serverEpoch: "wrong" })).toBe(
				request.id === "widget-inline-a",
			);
			expect(isPiExtensionUiRequestDto(request)).toBe(false);
		}

		expect(
			isExtensionUiRequestDto(
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
			isExtensionUiRequestDto(
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
			isExtensionUiRequestDto(
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
			isExtensionUiRequestDto(
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
			expect(isSessionMessageDto(message, context)).toBe(true);
			expect(isSessionMessageDto(message)).toBe(false);
			expect(isSessionMessageDto(message, { ...context, serverEpoch: "wrong" })).toBe(false);
		}
		expect(isPiSessionMessageDto(toolResult(), attachmentContext)).toBe(false);
		// In 1.2 this exact JSON root remains ordinary tool argument data; only the
		// future contextual guard gives it wrapper semantics.
		expect(isPiSessionMessageDto(assistant(), attachmentContext)).toBe(true);
	});

	it("keeps unreviewed message slots on the current contract", () => {
		expect(isSessionMessageDto({ role: "user", content: externalText, timestamp: 1 }, context)).toBe(false);
		expect(
			isSessionMessageDto(
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
			isSessionMessageDto(
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
		expect(isSessionEntryDto(entry(), context)).toBe(true);
		expect(isSessionEntryDto(entry())).toBe(false);
		expect(isSessionEntryDto(customMessage, context)).toBe(true);
		expect(isSessionTreeDto(tree, context)).toBe(true);
		expect(isSessionTreeDto(tree)).toBe(false);
		expect(
			isSessionEntryDto(
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
			expect(isProductSessionEventDto(event, context)).toBe(true);
		}
		expect(isProductSessionEventDto(events[0])).toBe(false);
		expect(
			isPiProductSessionEventDto({ type: "message_end", message: toolResult() }, attachmentContext),
		).toBe(false);
		expect(
			isPiProductSessionEventDto(
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
		expect(isProductSessionEventDto(opaqueCompaction, context)).toBe(true);
		expect(isPiProductSessionEventDto(opaqueCompaction, attachmentContext)).toBe(true);
		expect(
			isProductSessionEventDto(
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
		expect(isSessionCommandResponseDto(response, context)).toBe(true);
		expect(isSessionCommandResponseDto(response)).toBe(false);
		expect(isPiSessionCommandResponseDto(response, attachmentContext)).toBe(false);
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
		expect(isSessionProjectionEventDto(event, context)).toBe(true);
		expect(isSessionProjectionEventDto(event)).toBe(false);
		expect(isSessionReplayFrameDto(event, context)).toBe(true);
		expect(isSessionReplayFrameDto(event)).toBe(false);
		expect(isSessionSnapshotDto(snapshot(), context)).toBe(true);
		expect(isSessionSnapshotDto(snapshot())).toBe(false);
		expect(isSessionWsServerMessage(event, context)).toBe(true);
		expect(isSessionWsServerMessage(snapshot(), context)).toBe(true);
		expect(isSessionWsServerMessage(responseFrame, context)).toBe(true);
		expect(isSessionWsServerMessage(event)).toBe(false);
		expect(isInlineSessionSnapshotDto(snapshot(), attachmentContext)).toBe(false);
		expect(isInlineSessionWsServerMessage(responseFrame, attachmentContext)).toBe(false);
		expect(
			isSessionWsServerMessage(
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
		expect(isSessionReplayFrameDto(futureExtensionFrame, context)).toBe(true);
		expect(isInlineSessionWsServerMessage(futureExtensionFrame, attachmentContext)).toBe(false);
		const extensionSnapshot = {
			type: "extension_ui_snapshot",
			serverEpoch,
			sessionHandle: "session-a",
			generation: 2,
			requests: [futureExtensionFrame.request],
		} as const;
		expect(isSessionWsServerMessage(extensionSnapshot, context)).toBe(true);
		expect(isInlineSessionWsServerMessage(extensionSnapshot, attachmentContext)).toBe(false);

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
		expect(isExtensionUiRequestDto(snapshotWithExtension.pendingExtensionRequests[0], context)).toBe(true);
		expect(isExtensionUiRequestDto(snapshotWithExtension.stickyExtensionState[0], context)).toBe(true);
		expect(isSessionSnapshotDto({ ...snapshotWithExtension, stickyExtensionState: [] }, context)).toBe(true);
		expect(isSessionSnapshotDto({ ...snapshotWithExtension, pendingExtensionRequests: [] }, context)).toBe(
			true,
		);
		expect(isSessionSnapshotDto(snapshotWithExtension, context)).toBe(true);
		expect(isInlineSessionSnapshotDto(snapshotWithExtension, attachmentContext)).toBe(false);
	});

	it("keeps upstream Pi inline guards separate from Browser content-reference DTOs", () => {
		expect("maxContentBlobBytes" in SESSION_PAYLOAD_BUDGET).toBe(false);
		expect(isPiSessionMessageDto({ role: "user", content: "current", timestamp: 1 })).toBe(true);
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "get_messages",
				success: true,
				data: { messages: [] },
			}),
		).toBe(true);
	});
});
