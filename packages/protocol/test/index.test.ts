import { describe, expect, it } from "vitest";
import {
	commandTimeoutMs,
	expectCommandData,
	expectData,
	isErrorResponse,
	isReadOnlyRpcCommand,
	isSessionWsClientMessage,
	isSessionWsServerMessage,
	RpcError,
	SESSION_IMAGE_MAX_BASE64_CHARS,
	SESSION_TEXT_MAX_BYTES,
	SESSION_WS_CLIENT_MAX_BYTES,
	type SessionCommandResponseDto,
	sessionWsClientMessageBytes,
} from "../src/index.js";

describe("protocol response helpers", () => {
	it("returns data from successful responses", () => {
		const response = {
			type: "response",
			id: "test-1",
			command: "get_state",
			success: true,
			data: { sessionId: "session-1" },
		} as SessionCommandResponseDto;

		expect(expectData(response)).toEqual({ sessionId: "session-1" });
		expect(isErrorResponse(response)).toBe(false);
	});

	it("extracts typed data only for the matching command", () => {
		const response = {
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages: [] },
		} satisfies SessionCommandResponseDto;

		expect(expectCommandData(response, "get_messages")).toEqual({ messages: [] });
		expect(() => expectCommandData(response, "get_state")).toThrow(
			"expected get_state response, received get_messages",
		);
	});

	it("preserves command context for failed responses", () => {
		const response = {
			type: "response",
			id: "test-2",
			command: "get_messages",
			success: false,
			error: "not ready",
		} as SessionCommandResponseDto;

		expect(isErrorResponse(response)).toBe(true);
		expect(() => expectData(response)).toThrow(RpcError);
		try {
			expectData(response);
		} catch (error) {
			expect(error).toMatchObject({ command: "get_messages", message: "not ready" });
		}
	});
});

describe("gateway command deadlines", () => {
	it("keeps long-running control commands above the ordinary read deadline", () => {
		expect(commandTimeoutMs("get_state")).toBe(30_000);
		expect(commandTimeoutMs("prompt")).toBe(120_000);
		expect(commandTimeoutMs("abort")).toBe(90_000);
		expect(commandTimeoutMs("compact")).toBe(120_000);
		expect(commandTimeoutMs("export_html")).toBe(120_000);
	});
});

describe("Session runtime browser frame guard", () => {
	it("accepts multi-Session subscriptions and generation-fenced commands", () => {
		expect(
			isSessionWsClientMessage({
				type: "session_subscribe",
				sessionHandle: "session_native-a",
				cursor: { serverEpoch: "gateway-epoch-a", generation: 4, seq: 18 },
			}),
		).toBe(true);
		expect(
			isSessionWsClientMessage({
				type: "command",
				sessionHandle: "session_native-b",
				expectedGeneration: 2,
				fencingToken: "lease-token",
				command: { id: "request-1", type: "prompt", message: "hello" },
			}),
		).toBe(true);
	});

	it("accepts practical image payloads but bounds each image and the aggregate frame", () => {
		const command = (
			images: Array<{ type: "image"; data: string; mimeType: string }>,
			message = "inspect",
		) => ({
			type: "command",
			sessionHandle: "session-native-b",
			expectedGeneration: 2,
			fencingToken: "lease-token",
			command: { id: "image-request", type: "prompt", message, images },
		});
		expect(
			isSessionWsClientMessage(command([{ type: "image", data: "YQ==", mimeType: "image/png" }], "")),
		).toBe(true);
		expect(isSessionWsClientMessage(command([], ""))).toBe(false);
		expect(
			isSessionWsClientMessage(
				command([{ type: "image", data: "a".repeat(1_500_000), mimeType: "image/webp" }]),
			),
		).toBe(true);
		expect(
			isSessionWsClientMessage(
				command([{ type: "image", data: "a".repeat(2 * 1024 * 1024 + 1), mimeType: "image/png" }]),
			),
		).toBe(false);
		expect(
			isSessionWsClientMessage(
				command(
					Array.from({ length: 4 }, (_, index) => ({
						type: "image" as const,
						data: String(index).repeat(1_600_000),
						mimeType: "image/webp",
					})),
				),
			),
		).toBe(false);
	});

	it("bounds text by UTF-8 bytes and the complete serialized browser frame", () => {
		const command = (message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>) => ({
			type: "command",
			sessionHandle: "session-native-b",
			expectedGeneration: 2,
			fencingToken: "lease-token",
			command: { id: "utf8-request", type: "prompt", message, ...(images ? { images } : {}) },
		});
		const nearLimitCjk = "界".repeat(Math.floor(SESSION_TEXT_MAX_BYTES / 3));
		const overLimitCjk = `${nearLimitCjk}界`;
		const nearLimitImages = Array.from({ length: 3 }, () => ({
			type: "image" as const,
			data: "a".repeat(SESSION_IMAGE_MAX_BASE64_CHARS),
			mimeType: "image/png",
		}));

		expect(isSessionWsClientMessage(command(nearLimitCjk))).toBe(true);
		expect(isSessionWsClientMessage(command(overLimitCjk))).toBe(false);
		expect(isSessionWsClientMessage(command(nearLimitCjk, nearLimitImages))).toBe(true);

		const escapedText = "\\".repeat(SESSION_TEXT_MAX_BYTES);
		const oversizedWireFrame = command(escapedText, nearLimitImages);
		expect(sessionWsClientMessageBytes(oversizedWireFrame)).toBeGreaterThan(SESSION_WS_CLIENT_MAX_BYTES);
		expect(isSessionWsClientMessage(oversizedWireFrame)).toBe(false);
	});

	it("rejects invalid cursors, unknown keys, and unfenced dialog responses", () => {
		expect(
			isSessionWsClientMessage({
				type: "command",
				sessionHandle: "session-a",
				expectedGeneration: null,
				command: { type: "get_state" },
			}),
		).toBe(false);
		expect(
			isSessionWsClientMessage({
				type: "session_subscribe",
				sessionHandle: "session-a",
				cursor: { generation: 1, seq: -1 },
			}),
		).toBe(false);
		expect(
			isSessionWsClientMessage({
				type: "session_claim",
				sessionHandle: "session-a",
				workspaceId: "must-not-be-trusted",
			}),
		).toBe(false);
		expect(
			isSessionWsClientMessage({
				type: "extension_ui_response",
				sessionHandle: "session-a",
				expectedGeneration: 1,
				response: { type: "extension_ui_response", id: "dialog", confirmed: true },
			}),
		).toBe(false);
	});

	it("accepts an intentionally empty input or editor response", () => {
		expect(
			isSessionWsClientMessage({
				type: "extension_ui_response",
				sessionHandle: "session-a",
				expectedGeneration: 1,
				fencingToken: "lease-a",
				response: { type: "extension_ui_response", id: "input-a", value: "" },
			}),
		).toBe(true);
	});

	it("shares controller-lease command policy across browser and gateway", () => {
		expect(isReadOnlyRpcCommand("get_state")).toBe(true);
		expect(isReadOnlyRpcCommand({ type: "get_messages" })).toBe(true);
		expect(isReadOnlyRpcCommand({ type: "prompt" })).toBe(false);
	});

	it("accepts valid Session server frames and rejects malformed runtime envelopes", () => {
		const runtime = {
			serverEpoch: "gateway-epoch-a",
			sessionHandle: "session-native",
			workspaceId: "workspace-native",
			nativeSessionId: "native-id",
			sessionFile: "/tmp/native.jsonl",
			cwd: "/tmp/workspace",
			generation: 2,
			lastSeq: 4,
			state: "idle",
			lastActivityAt: 123,
			recoverable: true,
		};
		expect(isSessionWsServerMessage({ type: "runtime_state", runtime })).toBe(true);
		expect(
			isSessionWsServerMessage({
				type: "extension_ui_snapshot",
				serverEpoch: runtime.serverEpoch,
				sessionHandle: runtime.sessionHandle,
				generation: runtime.generation,
				requests: [
					{
						type: "extension_ui_request",
						id: "dialog-1",
						method: "confirm",
						title: "Confirm",
						message: "Proceed?",
					},
				],
			}),
		).toBe(true);
		expect(
			isSessionWsServerMessage({
				type: "extension_ui_result",
				serverEpoch: runtime.serverEpoch,
				sessionHandle: runtime.sessionHandle,
				generation: runtime.generation,
				requestId: "dialog-1",
				outcome: "accepted",
			}),
		).toBe(true);
		expect(isSessionWsServerMessage({ type: "runtime_state", runtime: { ...runtime, lastSeq: -1 } })).toBe(
			false,
		);
		expect(
			isSessionWsServerMessage({
				type: "event",
				serverEpoch: runtime.serverEpoch,
				sessionHandle: runtime.sessionHandle,
				workspaceId: runtime.workspaceId,
				generation: runtime.generation,
				seq: 5,
				event: {},
			}),
		).toBe(false);
	});
});
