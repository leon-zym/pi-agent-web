import { describe, expect, it } from "vitest";
import {
	isExtensionUiResponseDto,
	isInlineSessionWsServerMessage,
	isPiExtensionUiRequestDto,
	isPiProductSessionEventDto,
	isPiSessionCommandResponseDto,
	isPiSessionMessageDto,
	isPiSessionTreeDto,
	SESSION_PAYLOAD_BUDGET,
} from "../src/index.js";

const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const state = {
	thinkingLevel: "medium",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "one-at-a-time",
	sessionId: "session-1",
	autoCompactionEnabled: true,
	messageCount: 4,
	pendingMessageCount: 0,
};

const attachmentRef = {
	type: "attachment_ref",
	serverEpoch: "gateway-epoch-a",
	sha256: "a".repeat(64),
	mediaType: "image/png",
	byteLength: 4,
} as const;

const attachmentContext = {
	serverEpoch: "gateway-epoch-a",
	payloadBudget: SESSION_PAYLOAD_BUDGET,
};

function response(data: unknown) {
	return {
		type: "response",
		serverEpoch: "gateway-epoch-a",
		sessionHandle: "session-1",
		generation: 1,
		barrierSeq: 0,
		response: { type: "response", id: "request-1", command: "get_state", success: true, data },
	};
}

function event(payload: unknown) {
	return {
		type: "event",
		serverEpoch: "gateway-epoch-a",
		sessionHandle: "session-1",
		workspaceId: "workspace-1",
		generation: 1,
		seq: 1,
		event: payload,
	};
}

describe("product-owned protocol decoders", () => {
	it("admits image references only with the trusted epoch and complete negotiated budget", () => {
		const message = {
			role: "user",
			content: [{ type: "image", data: attachmentRef, mimeType: "image/png" }],
			timestamp: 1,
		};

		expect(isPiSessionMessageDto(message)).toBe(false);
		expect(isPiSessionMessageDto(message, attachmentContext)).toBe(true);
		expect(isPiSessionMessageDto(message, { ...attachmentContext, serverEpoch: "gateway-epoch-b" })).toBe(
			false,
		);
		expect(
			isPiSessionMessageDto(message, {
				...attachmentContext,
				payloadBudget: { ...SESSION_PAYLOAD_BUDGET, maxAttachmentBlobBytes: 3 },
			}),
		).toBe(false);
	});

	it("fails closed for ref media mismatches, non-raster refs, and excess image items", () => {
		const message = (data: unknown, mimeType: string) => ({
			role: "toolResult",
			toolCallId: "call",
			toolName: "tool",
			content: [{ type: "image", data, mimeType }],
			isError: false,
			timestamp: 1,
		});

		expect(isPiSessionMessageDto(message(attachmentRef, "image/jpeg"), attachmentContext)).toBe(false);
		expect(
			isPiSessionMessageDto(
				message({ ...attachmentRef, mediaType: "application/json" }, "application/json"),
				attachmentContext,
			),
		).toBe(false);
		expect(
			isPiSessionMessageDto(
				{
					...message(attachmentRef, "image/png"),
					content: Array.from({ length: 2 }, () => ({
						type: "image",
						data: attachmentRef,
						mimeType: "image/png",
					})),
				},
				{
					...attachmentContext,
					payloadBudget: { ...SESSION_PAYLOAD_BUDGET, maxImageCount: 1 },
				},
			),
		).toBe(false);
	});

	it("validates image refs through event and response paths against the trusted outer epoch", () => {
		const message = {
			role: "user",
			content: [{ type: "image", data: attachmentRef, mimeType: "image/png" }],
			timestamp: 1,
		};
		const refEvent = event({ type: "message_start", message });
		const refResponse = {
			...response(state),
			response: {
				type: "response",
				id: "request-1",
				command: "get_messages",
				success: true,
				data: { messages: [message] },
			},
		};

		expect(isInlineSessionWsServerMessage(refEvent)).toBe(false);
		expect(isInlineSessionWsServerMessage(refEvent, attachmentContext)).toBe(true);
		expect(isInlineSessionWsServerMessage(refResponse, attachmentContext)).toBe(true);
		expect(
			isInlineSessionWsServerMessage(
				{
					...refEvent,
					serverEpoch: "gateway-epoch-b",
					event: {
						type: "message_start",
						message: {
							...message,
							content: [
								{
									type: "image",
									data: { ...attachmentRef, serverEpoch: "gateway-epoch-b" },
									mimeType: "image/png",
								},
							],
						},
					},
				},
				attachmentContext,
			),
		).toBe(false);
	});

	it("propagates image-ref admission through every historical response container", () => {
		const message = {
			role: "toolResult",
			toolCallId: "call",
			toolName: "image-tool",
			content: [{ type: "image", data: attachmentRef, mimeType: "image/png" }],
			isError: false,
			timestamp: 1,
		};
		const entry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-08-27T00:00:00.000Z",
			message,
		};
		const responses = [
			{
				type: "response",
				command: "get_messages",
				success: true,
				data: { messages: [message] },
			},
			{
				type: "response",
				command: "get_entries",
				success: true,
				data: { entries: [entry], leafId: "entry-1" },
			},
			{
				type: "response",
				command: "get_tree",
				success: true,
				data: { tree: [{ entry, children: [] }], leafId: "entry-1" },
			},
		];

		for (const candidate of responses) {
			expect(isPiSessionCommandResponseDto(candidate)).toBe(false);
			expect(isPiSessionCommandResponseDto(candidate, attachmentContext)).toBe(true);
		}
	});

	it("accepts every bounded optional field emitted by the supported Pi message schema", () => {
		const extendedUsage = { ...usage, cacheWrite1h: 1, reasoning: 1 };
		expect(
			isPiSessionMessageDto({
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				responseModel: "claude-current",
				responseId: "response-1",
				diagnostics: [
					{
						type: "provider-warning",
						timestamp: 1,
						error: { name: "Error", message: "warning", stack: "stack", code: 429 },
						details: { retryable: true },
					},
				],
				usage: extendedUsage,
				stopReason: "deferred",
				deferred: {
					provider: "anthropic",
					modelId: "claude",
					api: "anthropic-messages",
					id: "deferred-1",
					expiresAt: 2,
					pollAfterMs: 100,
					data: { row: 1 },
				},
				rawStopReason: "pause_turn",
				endTurn: false,
				timestamp: 1,
			}),
		).toBe(true);

		expect(
			isPiSessionMessageDto({
				role: "toolResult",
				toolCallId: "call",
				toolName: "tool",
				content: [],
				usage: extendedUsage,
				addedToolNames: ["new_tool"],
				isError: false,
				timestamp: 1,
			}),
		).toBe(true);

		expect(
			isPiSessionMessageDto({
				role: "bashExecution",
				command: "pwd",
				output: "ok",
				fullOutputPath: "/tmp/output",
				excludeFromContext: true,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			}),
		).toBe(true);
	});

	it("accepts supported optional Session entry metadata", () => {
		for (const entry of [
			{
				type: "compaction",
				id: "compact",
				parentId: null,
				timestamp: "2026-08-26T00:00:00.000Z",
				summary: "summary",
				firstKeptEntryId: "entry-1",
				tokensBefore: 10,
				details: { source: "extension" },
				usage,
				fromHook: true,
			},
			{
				type: "branch_summary",
				id: "branch",
				parentId: null,
				timestamp: "2026-08-26T00:00:00.000Z",
				fromId: "entry-1",
				summary: "summary",
				details: { source: "extension" },
				usage,
				fromHook: false,
			},
			{
				type: "custom_message",
				id: "custom",
				parentId: null,
				timestamp: "2026-08-26T00:00:00.000Z",
				customType: "extension",
				content: "hello",
				details: { visible: true },
				display: true,
			},
		]) {
			expect(isPiSessionTreeDto([{ entry, children: [] }])).toBe(true);
		}
	});

	it.each([
		["deferred handle", { deferred: { provider: "p", modelId: "m", api: "a", id: "d", extra: true } }],
		[
			"diagnostic error",
			{
				diagnostics: [{ type: "warning", timestamp: 1, error: { message: "bad", extra: true } }],
			},
		],
	] as const)("rejects unknown fields in %s", (_label, fields) => {
		expect(
			isPiSessionMessageDto({
				role: "assistant",
				content: [],
				usage,
				stopReason: "stop",
				timestamp: 1,
				...fields,
			}),
		).toBe(false);
	});

	it("rejects a non-tool message in turn_end.toolResults", () => {
		expect(
			isPiProductSessionEventDto({
				type: "turn_end",
				message: { role: "user", content: "done", timestamp: 1 },
				toolResults: [{ role: "user", content: "not a tool result", timestamp: 1 }],
			}),
		).toBe(false);
	});

	it.each([
		[
			"response envelope",
			{ type: "response", command: "get_state", success: true, data: state, unexpected: "secret" },
		],
		[
			"get_state data",
			{ type: "response", command: "get_state", success: true, data: { ...state, unexpected: true } },
		],
		[
			"model",
			{
				type: "response",
				command: "get_state",
				success: true,
				data: { ...state, model: { id: "m", name: "M", provider: "p", unexpected: true } },
			},
		],
		[
			"model cost",
			{
				type: "response",
				command: "get_state",
				success: true,
				data: {
					...state,
					model: {
						id: "m",
						name: "M",
						provider: "p",
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unexpected: true },
					},
				},
			},
		],
		[
			"failed response",
			{ type: "response", command: "get_state", success: false, error: "failed", unexpected: true },
		],
		[
			"get_available_models data",
			{
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [], unexpected: true },
			},
		],
		[
			"cycle_model data",
			{
				type: "response",
				command: "cycle_model",
				success: true,
				data: {
					model: { id: "m", name: "M", provider: "p" },
					thinkingLevel: "off",
					isScoped: false,
					unexpected: true,
				},
			},
		],
		[
			"get_fork_messages item",
			{
				type: "response",
				command: "get_fork_messages",
				success: true,
				data: { messages: [{ entryId: "e", text: "hello", unexpected: true }] },
			},
		],
		[
			"bash result",
			{
				type: "response",
				command: "bash",
				success: true,
				data: { output: "ok", cancelled: false, truncated: false, unexpected: true },
			},
		],
		[
			"compaction result",
			{
				type: "response",
				command: "compact",
				success: true,
				data: { summary: "done", firstKeptEntryId: "e", tokensBefore: 1, unexpected: true },
			},
		],
	] as const)("rejects unknown fields in %s", (_label, value) => {
		expect(isPiSessionCommandResponseDto(value)).toBe(false);
	});

	it.each([
		["user message", { role: "user", content: "hello", timestamp: 1, unexpected: true }],
		[
			"assistant message",
			{ role: "assistant", content: [], usage, stopReason: "stop", timestamp: 1, unexpected: true },
		],
		[
			"tool result message",
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "tool",
				content: [],
				isError: false,
				timestamp: 1,
				unexpected: true,
			},
		],
		[
			"bash execution message",
			{
				role: "bashExecution",
				command: "pwd",
				output: "ok",
				cancelled: false,
				truncated: false,
				timestamp: 1,
				unexpected: true,
			},
		],
		[
			"custom message",
			{
				role: "custom",
				customType: "notice",
				content: "hello",
				display: true,
				timestamp: 1,
				unexpected: true,
			},
		],
		[
			"branch summary",
			{ role: "branchSummary", summary: "done", fromId: "e", timestamp: 1, unexpected: true },
		],
		[
			"compaction summary",
			{ role: "compactionSummary", summary: "done", tokensBefore: 1, timestamp: 1, unexpected: true },
		],
		[
			"text content",
			{
				role: "user",
				content: [{ type: "text", text: "hello", unexpected: true }],
				timestamp: 1,
			},
		],
		[
			"image content",
			{
				role: "user",
				content: [{ type: "image", data: "a", mimeType: "image/png", unexpected: true }],
				timestamp: 1,
			},
		],
		[
			"thinking content",
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "hmm", unexpected: true }],
				usage,
				stopReason: "stop",
				timestamp: 1,
			},
		],
		[
			"tool call content",
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call", name: "tool", arguments: {}, unexpected: true }],
				usage,
				stopReason: "stop",
				timestamp: 1,
			},
		],
		[
			"usage",
			{
				role: "assistant",
				content: [],
				usage: { ...usage, unexpected: true },
				stopReason: "stop",
				timestamp: 1,
			},
		],
		[
			"usage cost",
			{
				role: "assistant",
				content: [],
				usage: { ...usage, cost: { ...usage.cost, unexpected: true } },
				stopReason: "stop",
				timestamp: 1,
			},
		],
	] as const)("rejects unknown fields in %s", (_label, value) => {
		expect(isPiSessionMessageDto(value)).toBe(false);
	});

	it.each([
		["empty event", { type: "agent_start", unexpected: true }],
		[
			"event envelope",
			{ type: "message_update", usage, assistantMessageEvent: { type: "start" }, unexpected: true },
		],
		[
			"stream event",
			{
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", unexpected: true },
			},
		],
		[
			"extension error",
			{ type: "extension_error", extensionPath: "/tmp/e", event: "load", error: "bad", unexpected: true },
		],
	] as const)("rejects unknown fields in %s", (_label, value) => {
		expect(isPiProductSessionEventDto(value)).toBe(false);
	});

	it.each([
		{
			type: "extension_ui_request",
			id: "1",
			method: "select",
			title: "Pick",
			options: ["a"],
			unexpected: true,
		},
		{
			type: "extension_ui_request",
			id: "2",
			method: "confirm",
			title: "Sure?",
			message: "Go",
			unexpected: true,
		},
		{ type: "extension_ui_request", id: "3", method: "input", title: "Value", unexpected: true },
		{ type: "extension_ui_request", id: "4", method: "editor", title: "Edit", unexpected: true },
		{ type: "extension_ui_request", id: "5", method: "notify", message: "Done", unexpected: true },
		{ type: "extension_ui_request", id: "6", method: "setStatus", statusKey: "s", unexpected: true },
		{ type: "extension_ui_request", id: "7", method: "setWidget", widgetKey: "w", unexpected: true },
		{ type: "extension_ui_request", id: "8", method: "setTitle", title: "Title", unexpected: true },
		{ type: "extension_ui_request", id: "9", method: "set_editor_text", text: "Text", unexpected: true },
	] as const)("rejects unknown fields in Extension UI request $method", (value) => {
		expect(isPiExtensionUiRequestDto(value)).toBe(false);
	});

	it("rejects unknown fields in Extension UI responses", () => {
		expect(
			isExtensionUiResponseDto({ type: "extension_ui_response", id: "1", value: "x", unexpected: true }),
		).toBe(false);
	});

	it("rejects unknown tree-node and entry fields", () => {
		const baseEntry = {
			type: "session_info",
			id: "entry",
			parentId: null,
			timestamp: "2026-08-25T00:00:00.000Z",
		};
		expect(isPiSessionTreeDto([{ entry: baseEntry, children: [], unexpected: true }])).toBe(false);
		expect(isPiSessionTreeDto([{ entry: { ...baseEntry, unexpected: true }, children: [] }])).toBe(false);
	});

	it("keeps explicitly opaque fields open while enforcing their resource bounds", () => {
		expect(
			isPiProductSessionEventDto({
				type: "tool_execution_start",
				toolCallId: "call",
				toolName: "tool",
				args: { future: { nested: [1, true, "ok"] } },
			}),
		).toBe(true);
		expect(
			isPiSessionMessageDto({
				role: "toolResult",
				toolCallId: "call",
				toolName: "tool",
				content: [],
				details: { future: { nested: [1, true, "ok"] } },
				isError: false,
				timestamp: 1,
			}),
		).toBe(true);
	});

	it("bounds the shared failure envelope to a 64 KiB raw error", () => {
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "get_state",
				success: false,
				error: "\u0000".repeat(64 * 1024),
			}),
		).toBe(true);
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "get_state",
				success: false,
				error: "x".repeat(64 * 1024 + 1),
			}),
		).toBe(false);
	});

	it("bounds ordinary-line response products before Gateway serialization", () => {
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "bash",
				success: true,
				data: {
					output: "x".repeat(64 * 1024),
					cancelled: false,
					truncated: false,
				},
			}),
		).toBe(false);
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "get_state",
				success: true,
				data: {
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					sessionId: "session-a",
					sessionName: "\u0000".repeat(96 * 1024),
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				},
			}),
		).toBe(false);
	});

	it("accepts only the upstream Pi SourceInfo fields", () => {
		const command = {
			name: "review",
			source: "skill",
			sourceInfo: {
				path: "/tmp/review/SKILL.md",
				source: "review",
				scope: "user",
				origin: "top-level",
			},
		} as const;
		const response = {
			type: "response",
			command: "get_commands",
			success: true,
			data: { commands: [command] },
		} as const;
		expect(isPiSessionCommandResponseDto(response)).toBe(true);
		expect(
			isPiSessionCommandResponseDto({
				...response,
				data: {
					commands: [{ ...command, sourceInfo: { ...command.sourceInfo, unexpected: true } }],
				},
			}),
		).toBe(false);
	});

	it("fully validates command-specific response data", () => {
		expect(isPiSessionCommandResponseDto(response(state).response)).toBe(true);
		expect(isInlineSessionWsServerMessage(response(state))).toBe(true);
		expect(isInlineSessionWsServerMessage(response({ sessionId: "only-the-shallow-envelope" }))).toBe(false);
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [{ id: "m", name: "M", provider: "p", contextWindow: Number.NaN }] },
			}),
		).toBe(false);
	});

	it("accepts the Gateway-enriched export URL but no other export fields", () => {
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "export_html",
				success: true,
				data: { path: "/tmp/export.html", url: "file:///tmp/export.html" },
			}),
		).toBe(true);
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "export_html",
				success: true,
				data: { path: "/tmp/export.html", url: "file:///tmp/export.html", unexpected: true },
			}),
		).toBe(false);
	});

	it("validates compact and bash results instead of accepting arbitrary JSON", () => {
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "compact",
				success: true,
				data: { summary: "done", firstKeptEntryId: "entry-1", tokensBefore: 42 },
			}),
		).toBe(true);
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "compact",
				success: true,
				data: { summary: "missing required fields" },
			}),
		).toBe(false);
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "bash",
				success: true,
				data: { output: "ok", exitCode: null, cancelled: false, truncated: false },
			}),
		).toBe(false);
	});

	it("admits large bounded history blocks but rejects blocks near the snapshot ceiling", () => {
		const messagesResponse = (text: string) => ({
			type: "response",
			command: "get_messages",
			success: true,
			data: {
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text }],
						usage,
						stopReason: "stop",
						timestamp: 1,
					},
				],
			},
		});
		expect(isPiSessionCommandResponseDto(messagesResponse("x".repeat(9 * 1024 * 1024)))).toBe(true);
		expect(isPiSessionCommandResponseDto(messagesResponse("x".repeat(49 * 1024 * 1024)))).toBe(false);
	});

	it("rejects malformed and unknown nested event discriminants", () => {
		const valid = {
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
		};
		expect(isPiProductSessionEventDto(valid)).toBe(true);
		expect(isInlineSessionWsServerMessage(event(valid))).toBe(true);
		expect(
			isInlineSessionWsServerMessage(
				event({ ...valid, assistantMessageEvent: { type: "future_authoritative_delta", delta: "x" } }),
			),
		).toBe(false);
		expect(
			isInlineSessionWsServerMessage(event({ ...valid, usage: { ...usage, totalTokens: Number.NaN } })),
		).toBe(false);
		expect(isInlineSessionWsServerMessage(event({ type: "future_authoritative_event" }))).toBe(false);
	});

	it("validates every Extension UI request variant beyond its envelope", () => {
		expect(
			isPiExtensionUiRequestDto({
				type: "extension_ui_request",
				id: "select-1",
				method: "select",
				title: "Choose",
				options: ["A", "B"],
			}),
		).toBe(true);
		expect(
			isPiExtensionUiRequestDto({ type: "extension_ui_request", id: "confirm-1", method: "confirm" }),
		).toBe(false);
		expect(
			isPiExtensionUiRequestDto({
				type: "extension_ui_request",
				id: "widget-1",
				method: "setWidget",
				widgetKey: "status",
				widgetLines: ["ok", 42],
			}),
		).toBe(false);
	});

	it("bounds recursive tree depth and rejects unknown entry types", () => {
		const entry = (id: string) => ({
			type: "session_info",
			id,
			parentId: null,
			timestamp: "2026-08-25T00:00:00.000Z",
		});
		const root = { entry: entry("root"), children: [] as unknown[] };
		let cursor = root;
		for (let depth = 0; depth < 130; depth += 1) {
			const child = { entry: entry(`node-${String(depth)}`), children: [] as unknown[] };
			cursor.children.push(child);
			cursor = child;
		}
		expect(isPiSessionTreeDto([root])).toBe(false);
		expect(
			isPiSessionTreeDto([
				{
					entry: { ...entry("future"), type: "future_entry" },
					children: [],
				},
			]),
		).toBe(false);
	});
});
