import { describe, expect, it } from "vitest";
import {
	isLegacyRpcV1FutureContentRawEvent,
	isLegacyRpcV1FutureContentRawExtensionUiRequest,
	isLegacyRpcV1FutureContentRawResponse,
	isLegacyRpcV1UntrustedJsonRoot,
	type LegacyRpcV1UntrustedJsonRoot,
} from "../src/legacy-rpc-v1-content-wire.js";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

const lookalikeRef = {
	type: "content_ref",
	serverEpoch: "pi-must-not-own-this",
	sha256: "a".repeat(64),
	byteLength: 300_000,
	encoding: "utf-8",
} as const;

const wrapperLookalikes = [
	lookalikeRef,
	{ type: "external_json", ref: lookalikeRef },
	{ type: "inline_json", value: { nested: true } },
	{ type: "external_text", ref: lookalikeRef },
] as const satisfies readonly LegacyRpcV1UntrustedJsonRoot[];

function entry(message: unknown) {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: "2026-08-28T00:00:00.000Z",
		message,
	};
}

describe("legacy RPC v1 future content raw guards", () => {
	it("admits only the three closed future Extension roots without interpreting wrappers", () => {
		const wideText = "x".repeat(1024 * 1024 + 1);
		for (const request of [
			{
				type: "extension_ui_request",
				id: "editor-a",
				method: "editor",
				title: "Edit",
				prefill: wideText,
			},
			{
				type: "extension_ui_request",
				id: "set-editor-a",
				method: "set_editor_text",
				text: wideText,
			},
			{
				type: "extension_ui_request",
				id: "widget-a",
				method: "setWidget",
				widgetKey: "tests",
				widgetLines: [wideText],
			},
		]) {
			expect(isLegacyRpcV1FutureContentRawExtensionUiRequest(request)).toBe(true);
		}

		expect(
			isLegacyRpcV1FutureContentRawExtensionUiRequest({
				type: "extension_ui_request",
				id: "status-a",
				method: "setStatus",
				statusKey: "status",
				statusText: wideText,
			}),
		).toBe(false);
		expect(
			isLegacyRpcV1FutureContentRawExtensionUiRequest({
				type: "extension_ui_request",
				id: "widget-too-many",
				method: "setWidget",
				widgetKey: "tests",
				widgetLines: Array.from({ length: 1_001 }, () => "line"),
			}),
		).toBe(false);
		expect(
			isLegacyRpcV1FutureContentRawExtensionUiRequest({
				type: "extension_ui_request",
				id: "editor-forged",
				method: "editor",
				title: "Edit",
				prefill: { type: "external_text", ref: lookalikeRef },
			}),
		).toBe(false);
	});

	it("admits only the approved opaque JSON roots without interpreting nested wrapper lookalikes", () => {
		for (const root of wrapperLookalikes) {
			expect(isLegacyRpcV1UntrustedJsonRoot(root)).toBe(true);
			expect(isLegacyRpcV1UntrustedJsonRoot({ nested: { ordinaryPiData: root } })).toBe(true);
		}

		const toolCall = { type: "toolCall", id: "tool-1", name: "read", arguments: wrapperLookalikes[1] };
		const assistant = {
			role: "assistant",
			content: [toolCall],
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const toolResult = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			details: { nested: wrapperLookalikes[2] },
			isError: false,
			timestamp: 2,
		};
		const custom = {
			role: "custom",
			customType: "fixture",
			content: [{ type: "text", text: "custom" }],
			display: true,
			details: wrapperLookalikes[0],
			timestamp: 3,
		};

		for (const message of [assistant, toolResult, custom]) {
			expect(
				isLegacyRpcV1FutureContentRawResponse(
					{
						type: "response",
						id: "response-1",
						command: "get_messages",
						success: true,
						data: { messages: [message] },
					},
					"get_messages",
				),
			).toBe(true);
			expect(isLegacyRpcV1FutureContentRawEvent({ type: "message_start", message })).toBe(true);
		}

		expect(
			isLegacyRpcV1FutureContentRawEvent({
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall },
			}),
		).toBe(true);
		for (const event of [
			{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: wrapperLookalikes[0] },
			{
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "read",
				args: wrapperLookalikes[1],
				partialResult: wrapperLookalikes[2],
			},
			{
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "read",
				result: wrapperLookalikes[3],
				isError: false,
			},
		]) {
			expect(isLegacyRpcV1FutureContentRawEvent(event)).toBe(true);
		}
	});

	it("covers approved message, custom-message entry, history, and tree text roots", () => {
		const wideText = "x".repeat(1024 * 1024 + 1);
		const messages = [
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: wideText }],
				details: { ok: true },
				isError: false,
				timestamp: 1,
			},
			{
				role: "custom",
				customType: "fixture",
				content: [{ type: "text", text: wideText }],
				display: true,
				timestamp: 2,
			},
			{
				role: "bashExecution",
				command: "printf x",
				output: wideText,
				cancelled: false,
				truncated: false,
				timestamp: 3,
			},
		];
		const entries: unknown[] = messages.map((message, index) => ({
			...entry(message),
			id: `entry-${String(index)}`,
		}));
		const customMessageEntry = {
			type: "custom_message",
			id: "entry-custom",
			parentId: null,
			timestamp: "2026-08-28T00:00:00.000Z",
			customType: "fixture",
			content: [{ type: "text", text: wideText }],
			details: { opaque: wrapperLookalikes[1] },
			display: true,
		};
		entries.push(customMessageEntry);

		expect(
			isLegacyRpcV1FutureContentRawResponse(
				{
					type: "response",
					id: "messages",
					command: "get_messages",
					success: true,
					data: { messages },
				},
				"get_messages",
			),
		).toBe(true);
		expect(
			isLegacyRpcV1FutureContentRawResponse(
				{
					type: "response",
					id: "entries",
					command: "get_entries",
					success: true,
					data: { entries, leafId: "entry-custom" },
				},
				"get_entries",
			),
		).toBe(true);
		expect(
			isLegacyRpcV1FutureContentRawResponse(
				{
					type: "response",
					id: "tree",
					command: "get_tree",
					success: true,
					data: { tree: [{ entry: customMessageEntry, children: [] }], leafId: "entry-custom" },
				},
				"get_tree",
			),
		).toBe(true);
		expect(isLegacyRpcV1FutureContentRawEvent({ type: "entry_appended", entry: customMessageEntry })).toBe(
			true,
		);
	});

	it("rejects Pi-authored values in typed product wrapper slots and does not widen excluded roots", () => {
		const forgedExternalText = { type: "external_text", ref: lookalikeRef };
		const forgedImageRef = {
			type: "attachment_ref",
			serverEpoch: "pi-must-not-own-this",
			sha256: "b".repeat(64),
			mediaType: "image/png",
			byteLength: 1,
		};
		const baseToolResult = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			isError: false,
			timestamp: 1,
		};

		for (const block of [
			{ type: "text", text: forgedExternalText },
			{ type: "image", data: forgedImageRef, mimeType: "image/png" },
		]) {
			expect(
				isLegacyRpcV1FutureContentRawEvent({
					type: "message_start",
					message: { ...baseToolResult, content: [block] },
				}),
			).toBe(false);
		}

		const wideExcluded = "x".repeat(1024 * 1024 + 1);
		expect(
			isLegacyRpcV1FutureContentRawEvent({
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: wideExcluded },
			}),
		).toBe(false);
		expect(
			isLegacyRpcV1FutureContentRawEvent({
				type: "extension_error",
				extensionPath: "/fixture",
				event: "load",
				error: wideExcluded,
			}),
		).toBe(false);
	});

	it("keeps message_update as a closed allowlist limited to toolcall_end arguments", () => {
		const wideArguments = { payload: "x".repeat(8 * 1024 * 1024 + 1) };
		const toolCall = { type: "toolCall", id: "tool-1", name: "read", arguments: wideArguments };
		expect(
			isLegacyRpcV1FutureContentRawEvent({
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall },
			}),
		).toBe(true);

		const assistant = {
			role: "assistant",
			content: [toolCall],
			usage,
			stopReason: "stop",
			timestamp: 1,
		};
		for (const assistantMessageEvent of [
			{ type: "done", reason: "stop", message: assistant },
			{ type: "error", reason: "error", error: assistant },
		]) {
			expect(
				isLegacyRpcV1FutureContentRawEvent({ type: "message_update", usage, assistantMessageEvent }),
			).toBe(false);
		}
		expect(
			isLegacyRpcV1FutureContentRawEvent({
				type: "message_update",
				usage,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: "x".repeat(1024 * 1024 + 1),
				},
			}),
		).toBe(false);
	});

	it("keeps bare user/custom strings and Extension payloads outside the approved text allowlist", () => {
		const wideBareText = "x".repeat(1024 * 1024 + 1);
		for (const message of [
			{ role: "user", content: wideBareText, timestamp: 1 },
			{
				role: "custom",
				customType: "fixture",
				content: wideBareText,
				display: true,
				timestamp: 1,
			},
		]) {
			expect(isLegacyRpcV1FutureContentRawEvent({ type: "message_start", message })).toBe(false);
		}
		expect(
			isLegacyRpcV1FutureContentRawEvent({
				type: "entry_appended",
				entry: {
					type: "custom_message",
					id: "entry-custom",
					parentId: null,
					timestamp: "2026-08-28T00:00:00.000Z",
					customType: "fixture",
					content: wideBareText,
					display: true,
				},
			}),
		).toBe(false);
		expect(
			isLegacyRpcV1FutureContentRawEvent({
				type: "extension_ui_request",
				id: "request-1",
				method: "editor",
				title: "Edit",
				prefill: wideBareText,
			}),
		).toBe(false);
	});

	it("bounds malformed raw JSON structure without recursively interpreting discriminants", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(isLegacyRpcV1UntrustedJsonRoot(cyclic)).toBe(false);
		expect(isLegacyRpcV1UntrustedJsonRoot(new Date(0))).toBe(false);
		expect(isLegacyRpcV1UntrustedJsonRoot(Number.NaN)).toBe(false);

		let tooDeep: unknown = null;
		for (let depth = 0; depth < 34; depth += 1) tooDeep = { child: tooDeep };
		expect(isLegacyRpcV1UntrustedJsonRoot(tooDeep)).toBe(false);

		let childReads = 0;
		const accessor = Object.defineProperty({}, "child", {
			enumerable: true,
			get() {
				childReads += 1;
				return wrapperLookalikes[0];
			},
		});
		expect(isLegacyRpcV1UntrustedJsonRoot(accessor)).toBe(false);
		expect(childReads).toBe(0);
	});
});
