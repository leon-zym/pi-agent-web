import { describe, expect, it } from "vitest";
import {
	commandResponseReservationBytes,
	commandTimeoutMs,
	expectCommandData,
	expectData,
	isErrorResponse,
	isInlineSessionWsServerMessage,
	isPiSessionCommandResponseDto,
	isReadOnlyRpcCommand,
	isSessionWsClientMessage,
	type PiSessionCommandResponseDto,
	RpcError,
	SESSION_IMAGE_MAX_BASE64_CHARS,
	SESSION_MODEL_LIST_MAX_ITEMS,
	SESSION_MODEL_LIST_RESPONSE_GUARD_MAX_BYTES,
	SESSION_MODEL_LIST_RESPONSE_RESERVATION_BYTES,
	SESSION_PRODUCT_IDENTIFIER_MAX_CHARS,
	SESSION_SLASH_COMMAND_LIST_MAX_ITEMS,
	SESSION_TEXT_MAX_BYTES,
	SESSION_WS_CLIENT_MAX_BYTES,
	SESSION_WS_SERVER_MAX_BYTES,
	type SessionCommandTypeDto,
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
		} as PiSessionCommandResponseDto;

		expect(expectData(response)).toEqual({ sessionId: "session-1" });
		expect(isErrorResponse(response)).toBe(false);
	});

	it("extracts typed data only for the matching command", () => {
		const response = {
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages: [] },
		} satisfies PiSessionCommandResponseDto;

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
		} as PiSessionCommandResponseDto;

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

describe("gateway command response reservations", () => {
	const noData = Symbol("no-data");
	const successData = {
		prompt: noData,
		steer: noData,
		follow_up: noData,
		abort: noData,
		new_session: { cancelled: false },
		get_state: {
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			sessionId: "session-a",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		},
		set_model: { id: "model", name: "Model", provider: "provider" },
		cycle_model: null,
		get_available_models: { models: [] },
		set_thinking_level: noData,
		cycle_thinking_level: null,
		get_available_thinking_levels: { levels: ["off"] },
		set_steering_mode: noData,
		set_follow_up_mode: noData,
		compact: { summary: "done", firstKeptEntryId: "entry", tokensBefore: 0 },
		set_auto_compaction: noData,
		set_auto_retry: noData,
		abort_retry: noData,
		bash: { output: "", cancelled: false, truncated: false },
		abort_bash: noData,
		get_session_stats: {
			sessionId: "session-a",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		},
		export_html: { path: "/tmp/export.html" },
		switch_session: { cancelled: false },
		fork: { text: "", cancelled: false },
		clone: { cancelled: false },
		get_fork_messages: { messages: [] },
		get_entries: { entries: [], leafId: null },
		get_tree: { tree: [], leafId: null },
		get_last_assistant_text: { text: null },
		set_session_name: noData,
		get_messages: { messages: [] },
		get_commands: { commands: [] },
	} as const satisfies Readonly<Record<SessionCommandTypeDto, unknown>>;

	function responseFrame(command: SessionCommandTypeDto, response: Record<string, unknown>) {
		return {
			type: "response",
			serverEpoch: "epoch-a",
			sessionHandle: "session-a",
			generation: 1,
			barrierSeq: 0,
			response: { type: "response", id: "request-a", command, ...response },
		};
	}

	it("covers every command's complete success frame and maximal shared failure", () => {
		for (const [command, data] of Object.entries(successData) as Array<[SessionCommandTypeDto, unknown]>) {
			const success = responseFrame(command, {
				success: true,
				...(data === noData ? {} : { data }),
			});
			expect(isInlineSessionWsServerMessage(success), command).toBe(true);
			expect(new TextEncoder().encode(JSON.stringify(success)).byteLength, command).toBeLessThanOrEqual(
				commandResponseReservationBytes(command),
			);

			const failure = responseFrame(command, {
				success: false,
				error: "\u0000".repeat(64 * 1024),
			});
			expect(isInlineSessionWsServerMessage(failure), `${command} failure`).toBe(true);
			expect(
				new TextEncoder().encode(JSON.stringify(failure)).byteLength,
				`${command} failure`,
			).toBeLessThanOrEqual(commandResponseReservationBytes(command));
		}
	});

	it("reserves the full legal wire ceiling only for oversized history and unknown responses", () => {
		expect(commandResponseReservationBytes("bash")).toBeLessThan(SESSION_WS_SERVER_MAX_BYTES);
		expect(commandResponseReservationBytes("get_commands")).toBe(8 * SESSION_TEXT_MAX_BYTES);
		expect(commandResponseReservationBytes("get_fork_messages")).toBe(8 * SESSION_TEXT_MAX_BYTES);
		expect(commandResponseReservationBytes("get_last_assistant_text")).toBe(8 * SESSION_TEXT_MAX_BYTES);
		expect(commandResponseReservationBytes("get_messages")).toBe(SESSION_WS_SERVER_MAX_BYTES);
		expect(commandResponseReservationBytes("get_entries")).toBe(SESSION_WS_SERVER_MAX_BYTES);
		expect(commandResponseReservationBytes("get_tree")).toBe(SESSION_WS_SERVER_MAX_BYTES);
		expect(commandResponseReservationBytes("unknown_future_command")).toBe(SESSION_WS_SERVER_MAX_BYTES);
	});

	it("reserves above the maximal model-list guard payload without using the wire ceiling", () => {
		const escapedIdentifier = "\u0000".repeat(SESSION_PRODUCT_IDENTIFIER_MAX_CHARS);
		const maximalModel = {
			id: escapedIdentifier,
			name: escapedIdentifier,
			provider: escapedIdentifier,
			reasoning: false,
			contextWindow: Number.MAX_SAFE_INTEGER,
			cost: {
				input: -Number.MAX_SAFE_INTEGER,
				output: Number.MIN_VALUE,
				cacheRead: Number.MAX_SAFE_INTEGER,
				cacheWrite: -Number.MAX_SAFE_INTEGER,
				total: Number.MIN_VALUE,
			},
		};
		const response = {
			type: "response",
			id: escapedIdentifier,
			command: "get_available_models",
			success: true,
			data: { models: Array.from({ length: SESSION_MODEL_LIST_MAX_ITEMS }, () => maximalModel) },
		} as const;

		expect(isPiSessionCommandResponseDto(response)).toBe(true);
		expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(
			SESSION_MODEL_LIST_RESPONSE_GUARD_MAX_BYTES,
		);
		expect(SESSION_MODEL_LIST_RESPONSE_GUARD_MAX_BYTES).toBeLessThanOrEqual(
			SESSION_MODEL_LIST_RESPONSE_RESERVATION_BYTES,
		);
		expect(commandResponseReservationBytes("get_available_models")).toBe(
			SESSION_MODEL_LIST_RESPONSE_RESERVATION_BYTES,
		);
		expect(
			isPiSessionCommandResponseDto({
				...response,
				data: { models: [...response.data.models, maximalModel] },
			}),
		).toBe(false);
	});

	it("uses the serialized response guard as the command-list byte boundary", () => {
		const command = {
			name: "review",
			description: "x".repeat(1_025),
			source: "extension",
			sourceInfo: {
				path: `/${"p".repeat(4_096)}`,
				source: "local",
				scope: "temporary",
				origin: "top-level",
				baseDir: `/${"b".repeat(4_096)}`,
			},
		} as const;
		const frame = responseFrame("get_commands", {
			success: true,
			data: {
				commands: Array.from({ length: 97 }, () => command),
			},
		});
		expect(isInlineSessionWsServerMessage(frame)).toBe(true);
		expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength).toBeLessThanOrEqual(
			commandResponseReservationBytes("get_commands"),
		);
		expect(
			isPiSessionCommandResponseDto({
				type: "response",
				command: "get_commands",
				success: true,
				data: {
					commands: Array.from({ length: SESSION_SLASH_COMMAND_LIST_MAX_ITEMS + 1 }, () => ({
						...command,
						description: "x",
					})),
				},
			}),
		).toBe(false);
		const overSerializedBudget = {
			type: "response",
			command: "get_commands",
			success: true,
			data: {
				commands: Array.from({ length: 8 }, (_, index) => ({
					...command,
					name: `review-${index}`,
					description: "x".repeat(SESSION_TEXT_MAX_BYTES),
				})),
			},
		} as const;
		expect(new TextEncoder().encode(JSON.stringify(overSerializedBudget)).byteLength).toBeGreaterThan(
			8 * SESSION_TEXT_MAX_BYTES - 16 * 1024,
		);
		expect(isPiSessionCommandResponseDto(overSerializedBudget)).toBe(false);
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

	it("keeps protocol 1.3 control frames limited to claim and release", () => {
		expect(isSessionWsClientMessage({ type: "session_claim", sessionHandle: "session-native-a" })).toBe(true);
		expect(isSessionWsClientMessage({ type: "session_release", sessionHandle: "session-native-a" })).toBe(
			true,
		);
		expect(
			isSessionWsClientMessage({
				type: "session_takeover",
				sessionHandle: "session-native-a",
				expectedGeneration: 2,
			}),
		).toBe(false);
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

	it("keeps Browser image commands inline-only even when the server output protocol supports refs", () => {
		const attachment = {
			type: "attachment_ref",
			serverEpoch: "gateway-epoch-a",
			sha256: "a".repeat(64),
			mediaType: "image/png",
			byteLength: 4,
		};
		for (const type of ["prompt", "steer", "follow_up"] as const) {
			expect(
				isSessionWsClientMessage({
					type: "command",
					sessionHandle: "session-native-b",
					expectedGeneration: 2,
					fencingToken: "lease-token",
					command: { id: `ref-${type}`, type, message: "inspect", images: [{ ...attachment }] },
				}),
			).toBe(false);
		}
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

	it("accepts only generation-fenced Session restart requests", () => {
		expect(
			isSessionWsClientMessage({
				type: "session_restart",
				sessionHandle: "session-a",
				expectedGeneration: 3,
				fencingToken: "lease-a",
			}),
		).toBe(true);
		expect(
			isSessionWsClientMessage({
				type: "session_restart",
				sessionHandle: "session-a",
				expectedGeneration: 3,
			}),
		).toBe(false);
		expect(
			isSessionWsClientMessage({
				type: "session_restart",
				sessionHandle: "session-a",
			}),
		).toBe(false);
		expect(
			isSessionWsClientMessage({
				type: "session_restart",
				sessionHandle: "session-a",
				expectedGeneration: 3,
				unexpected: true,
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
		expect(isInlineSessionWsServerMessage({ type: "runtime_state", runtime })).toBe(true);
		expect(
			isInlineSessionWsServerMessage({
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
			isInlineSessionWsServerMessage({
				type: "extension_ui_result",
				serverEpoch: runtime.serverEpoch,
				sessionHandle: runtime.sessionHandle,
				generation: runtime.generation,
				requestId: "dialog-1",
				outcome: "accepted",
			}),
		).toBe(true);
		expect(
			isInlineSessionWsServerMessage({ type: "runtime_state", runtime: { ...runtime, lastSeq: -1 } }),
		).toBe(false);
		expect(
			isInlineSessionWsServerMessage({
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
