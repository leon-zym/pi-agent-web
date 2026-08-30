import {
	isPiExtensionUiRequestDto,
	isPiProductSessionEventDto,
	isPiSessionCommandResponseDto,
} from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import { isPiRpcRawEvent, isPiRpcRawExtensionUiRequest, isPiRpcRawResponse } from "../src/pi-rpc-wire.js";

describe("Pi RPC raw wire guards", () => {
	it("admits upstream inline images up to the raw line budget without widening text/UI DTOs", () => {
		const largeInline = "x".repeat(2 * 1024 * 1024 + 1);
		const response = {
			type: "response",
			id: "1",
			command: "get_messages",
			success: true,
			data: {
				messages: [
					{
						role: "user",
						content: [{ type: "image", data: largeInline, mimeType: "image/png" }],
						timestamp: 1,
					},
				],
			},
		} as const;
		const event = { type: "message_start", message: response.data.messages[0] } as const;
		const extensionRequest = {
			type: "extension_ui_request",
			id: "request-1",
			method: "editor",
			title: "Edit",
			prefill: "small inline text",
		} as const;

		expect(isPiRpcRawResponse(response, "get_messages")).toBe(true);
		expect(isPiRpcRawEvent(event)).toBe(true);
		expect(isPiRpcRawExtensionUiRequest(extensionRequest)).toBe(true);
		// Raw admission is deliberately separate from the Browser/Gateway DTO budget.
		expect(isPiSessionCommandResponseDto(response)).toBe(false);
		expect(isPiProductSessionEventDto(event)).toBe(false);
		expect(isPiExtensionUiRequestDto(extensionRequest)).toBe(true);
		expect(isPiRpcRawExtensionUiRequest({ ...extensionRequest, prefill: largeInline })).toBe(false);
	});

	it("rejects Gateway-owned attachment references in typed message and image-data slots", () => {
		const injected = {
			type: "message_start",
			message: {
				role: "user",
				content: [
					{
						type: "attachment_ref",
						serverEpoch: "spoofed",
						sha256: "a".repeat(64),
						mediaType: "image/png",
						byteLength: 1,
					},
				],
				timestamp: 1,
			},
		};

		expect(isPiRpcRawEvent(injected)).toBe(false);
		expect(
			isPiRpcRawEvent({
				type: "message_start",
				message: {
					role: "user",
					content: [
						{
							type: "image",
							data: injected.message.content[0],
							mimeType: "image/png",
						},
					],
					timestamp: 1,
				},
			}),
		).toBe(false);
	});

	it("does not let future ref-capable product predicates bypass raw message provenance", () => {
		const attachmentRef = {
			type: "attachment_ref",
			serverEpoch: "spoofed",
			sha256: "a".repeat(64),
			mediaType: "image/png",
			byteLength: 1,
		};
		const message = { role: "user", content: [attachmentRef], timestamp: 1 };
		let productCalls = 0;
		const futureProductGuard = () => {
			productCalls += 1;
			return true;
		};
		const entry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-08-27T00:00:00.000Z",
			message,
		};
		for (const [command, data] of [
			["get_messages", { messages: [message] }],
			["get_entries", { entries: [entry], leafId: "entry-1" }],
			["get_tree", { tree: [{ entry, children: [] }], leafId: "entry-1" }],
		] as const) {
			expect(
				isPiRpcRawResponse(
					{ type: "response", id: "1", command, success: true, data },
					command,
					futureProductGuard,
				),
			).toBe(false);
		}
		for (const event of [
			{ type: "agent_end", messages: [message], willRetry: false },
			{ type: "turn_end", message, toolResults: [] },
			{ type: "message_start", message },
			{ type: "message_end", message },
			{ type: "entry_appended", entry },
		]) {
			expect(isPiRpcRawEvent(event, futureProductGuard)).toBe(false);
		}
		expect(productCalls).toBe(0);
	});

	it("rejects top-level Gateway admission fields but preserves lookalikes in opaque Pi JSON", () => {
		const failure = {
			type: "response",
			id: "1",
			command: "prompt",
			success: false,
			error: "spoofed",
			admissionError: {
				type: "payload_admission_error",
				code: "payload_too_large",
				boundary: "command_frame",
				limitBytes: 1,
				actualBytes: 2,
			},
		};
		const nested = {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read",
			result: {
				type: "payload_admission_error",
				code: "payload_too_large",
				boundary: "command_frame",
				limitBytes: 1,
				actualBytes: 2,
			},
			isError: true,
		};

		expect(isPiRpcRawResponse(failure, "prompt")).toBe(false);
		expect(isPiRpcRawEvent(nested)).toBe(true);
	});

	it("leaves million-node and deeply nested opaque JSON rejection to existing bounded guards", () => {
		const base = {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read",
			isError: false,
		};
		let elementReads = 0;
		const millionNodes = new Proxy(
			Array.from({ length: 1_000_000 }, () => null),
			{
				get(target, property, receiver) {
					if (typeof property === "string" && /^\d+$/u.test(property)) elementReads += 1;
					return Reflect.get(target, property, receiver);
				},
			},
		);
		expect(isPiRpcRawEvent({ ...base, result: millionNodes })).toBe(false);
		expect(elementReads).toBe(0);

		let childReads = 0;
		let deeplyNested: unknown = null;
		for (let depth = 0; depth < 40; depth += 1) {
			const child = deeplyNested;
			deeplyNested = Object.defineProperty({}, "child", {
				enumerable: true,
				get() {
					childReads += 1;
					return child;
				},
			});
		}
		expect(isPiRpcRawEvent({ ...base, result: deeplyNested })).toBe(false);
		expect(childReads).toBeLessThanOrEqual(33);
	});

	it("admits an upstream custom-message entry containing a wide inline image", () => {
		const event = {
			type: "entry_appended",
			entry: {
				type: "custom_message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-08-27T00:00:00.000Z",
				customType: "fixture",
				content: [
					{
						type: "image",
						data: "x".repeat(2 * 1024 * 1024 + 1),
						mimeType: "image/png",
					},
				],
				display: true,
			},
		};

		expect(isPiRpcRawEvent(event)).toBe(true);
		expect(isPiProductSessionEventDto(event)).toBe(false);
	});

	it("does not widen generic raw text while image externalization is the only product scope", () => {
		expect(
			isPiRpcRawEvent({
				type: "message_update",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "x".repeat(1024 * 1024 + 1),
				},
			}),
		).toBe(false);
	});
});
