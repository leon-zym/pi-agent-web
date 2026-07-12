import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { expectData, isErrorResponse, isWsClientMessage, RpcError } from "../src/index.js";

describe("protocol response helpers", () => {
	it("returns data from successful responses", () => {
		const response = {
			type: "response",
			id: "test-1",
			command: "get_state",
			success: true,
			data: { sessionId: "session-1" },
		} as RpcResponse;

		expect(expectData(response)).toEqual({ sessionId: "session-1" });
		expect(isErrorResponse(response)).toBe(false);
	});

	it("preserves command context for failed responses", () => {
		const response = {
			type: "response",
			id: "test-2",
			command: "get_messages",
			success: false,
			error: "not ready",
		} as RpcResponse;

		expect(isErrorResponse(response)).toBe(true);
		expect(() => expectData(response)).toThrow(RpcError);
		try {
			expectData(response);
		} catch (error) {
			expect(error).toMatchObject({ command: "get_messages", message: "not ready" });
		}
	});
});

describe("browser frame guard", () => {
	it("accepts supported command frames with bounded fields", () => {
		expect(
			isWsClientMessage({
				type: "command",
				workspaceId: "workspace-1",
				command: { id: "request-1", type: "prompt", message: "hello", streamingBehavior: "steer" },
			}),
		).toBe(true);
		expect(
			isWsClientMessage({
				type: "extension_ui_response",
				workspaceId: "workspace-1",
				response: { type: "extension_ui_response", id: "dialog-1", cancelled: true },
			}),
		).toBe(true);
	});

	it("rejects malformed, unsupported, and overlong browser frames", () => {
		expect(isWsClientMessage({ type: "command", workspaceId: "workspace-1" })).toBe(false);
		expect(
			isWsClientMessage({
				type: "command",
				workspaceId: "workspace-1",
				command: { id: "request-1", type: "unsupported" },
			}),
		).toBe(false);
		expect(
			isWsClientMessage({
				type: "command",
				workspaceId: "workspace-1",
				command: { type: "bash", command: "echo ok" },
			}),
		).toBe(false);
		expect(
			isWsClientMessage({
				type: "session_listen",
				workspaceId: "x".repeat(257),
				sessionId: null,
			}),
		).toBe(false);
	});
});
