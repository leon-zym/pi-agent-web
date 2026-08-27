import { describe, expect, it } from "vitest";
import {
	isProductSessionEventDto,
	isSessionMessageDto,
	isSessionSnapshotDto,
	isSessionWsClientMessage,
	isSessionWsServerMessage,
	SESSION_PAYLOAD_BUDGET,
	type SessionRuntimeDto,
	type SessionSnapshotDto,
	sessionWsServerMessageBytes,
} from "../src/index.js";

const serverEpoch = "gateway-epoch-a";

function runtime(overrides: Partial<SessionRuntimeDto> = {}): SessionRuntimeDto {
	return {
		serverEpoch,
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		nativeSessionId: "native-a",
		sessionFile: "/tmp/session-a.jsonl",
		cwd: "/tmp/workspace-a",
		generation: 2,
		lastSeq: 4,
		state: "running",
		lastActivityAt: 123,
		recoverable: true,
		...overrides,
	};
}

function projectionEvent(seq: number, epoch = serverEpoch) {
	return {
		type: "event" as const,
		serverEpoch: epoch,
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		generation: 2,
		seq,
		event: { type: "turn_start" as const },
	};
}

function snapshot(overrides: Partial<SessionSnapshotDto> = {}): SessionSnapshotDto {
	return {
		type: "session_snapshot",
		snapshotId: "snapshot-a",
		serverEpoch,
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		generation: 2,
		baseSeq: 1,
		asOfSeq: 4,
		runtime: runtime(),
		settledMessages: [{ role: "user", content: "settled", timestamp: 1 }],
		projectionEvents: [projectionEvent(2), projectionEvent(4)],
		queue: { steering: ["steer"], followUp: ["follow-up"] },
		pendingExtensionRequests: [
			{
				type: "extension_ui_request",
				id: "confirm-a",
				method: "confirm",
				title: "Confirm",
				message: "Continue?",
			},
		],
		stickyExtensionState: [
			{
				type: "extension_ui_request",
				id: "status-a",
				method: "setStatus",
				statusKey: "build",
				statusText: "running",
			},
			{
				type: "extension_ui_request",
				id: "title-a",
				method: "setTitle",
				title: "Session title",
			},
		],
		...overrides,
	};
}

describe("epoch-aware Session resync protocol", () => {
	it("requires serverEpoch in replay cursors and fails legacy cursors closed", () => {
		expect(
			isSessionWsClientMessage({
				type: "session_subscribe",
				sessionHandle: "session-a",
				cursor: { serverEpoch, generation: 2, seq: 4 },
			}),
		).toBe(true);
		expect(
			isSessionWsClientMessage({
				type: "session_subscribe",
				sessionHandle: "session-a",
				cursor: { generation: 2, seq: 4 },
			}),
		).toBe(false);
	});

	it("carries epoch through runtime, replay, response, lease, rekey, and resync frames", () => {
		const frames = [
			{ type: "runtime_state", runtime: runtime() },
			projectionEvent(5),
			{
				type: "response",
				serverEpoch,
				sessionHandle: "session-a",
				generation: 2,
				barrierSeq: 4,
				response: { type: "response", command: "get_messages", success: true, data: { messages: [] } },
			},
			{
				type: "lease_status",
				serverEpoch,
				sessionHandle: "session-a",
				generation: 2,
				isController: false,
			},
			{
				type: "session_rekeyed",
				serverEpoch,
				previousSessionHandle: "pending-a",
				runtime: runtime(),
			},
			{
				type: "resync_required",
				serverEpoch,
				sessionHandle: "session-a",
				runtime: runtime(),
				reason: "epoch_changed",
			},
		];
		for (const frame of frames) expect(isSessionWsServerMessage(frame), JSON.stringify(frame)).toBe(true);

		for (const frame of frames.slice(1)) {
			const { serverEpoch: _omitted, ...legacy } = frame as Record<string, unknown>;
			expect(isSessionWsServerMessage(legacy), JSON.stringify(legacy)).toBe(false);
		}
		expect(
			isSessionWsServerMessage({
				type: "session_rekeyed",
				serverEpoch: "wrong-epoch",
				previousSessionHandle: "pending-a",
				runtime: runtime(),
			}),
		).toBe(false);
		expect(
			isSessionWsServerMessage({
				type: "resync_required",
				serverEpoch: "wrong-epoch",
				sessionHandle: "session-a",
				runtime: runtime(),
				reason: "epoch_changed",
			}),
		).toBe(false);
	});

	it("strictly rejects unknown runtime and envelope fields", () => {
		expect(
			isSessionWsServerMessage({
				type: "runtime_state",
				runtime: runtime({ unexpected: true } as Partial<SessionRuntimeDto>),
			}),
		).toBe(false);
		expect(isSessionWsServerMessage({ ...projectionEvent(5), unexpected: true })).toBe(false);
		expect(
			isSessionWsServerMessage({
				type: "response",
				serverEpoch,
				sessionHandle: "session-a",
				generation: 2,
				barrierSeq: 4,
				response: { type: "response", command: "get_messages", success: true, data: { messages: [] } },
				unexpected: true,
			}),
		).toBe(false);
	});

	it("accepts one bounded atomic snapshot without authority or ephemeral notify state", () => {
		const valid = snapshot();
		expect(isSessionSnapshotDto(valid)).toBe(true);
		expect(isSessionWsServerMessage(valid)).toBe(true);

		expect(isSessionSnapshotDto({ ...valid, fencingToken: "must-not-cross" })).toBe(false);
		expect(isSessionSnapshotDto({ ...valid, lease: { isController: true } })).toBe(false);
		expect(
			isSessionSnapshotDto({
				...valid,
				stickyExtensionState: [
					{
						type: "extension_ui_request",
						id: "notify-a",
						method: "notify",
						message: "transient",
					},
				],
			}),
		).toBe(false);
	});

	it("admits snapshot image refs only against the trusted current epoch and budget", () => {
		const attachment = {
			type: "attachment_ref" as const,
			serverEpoch,
			sha256: "a".repeat(64),
			mediaType: "image/png",
			byteLength: 4,
		};
		const value = snapshot({
			settledMessages: [
				{
					role: "user",
					content: [{ type: "image", data: attachment, mimeType: "image/png" }],
					timestamp: 1,
				},
			],
			projectionEvents: [
				{
					...projectionEvent(2),
					event: {
						type: "message_start",
						message: {
							role: "user",
							content: [{ type: "image", data: { ...attachment }, mimeType: "image/png" }],
							timestamp: 1,
						},
					},
				},
				projectionEvent(4),
			],
		});
		const context = { serverEpoch, payloadBudget: SESSION_PAYLOAD_BUDGET };

		expect(isSessionMessageDto(value.settledMessages[0], context)).toBe(true);
		expect(isProductSessionEventDto(value.projectionEvents[0]?.event, context)).toBe(true);
		expect(isSessionSnapshotDto(value)).toBe(false);
		expect(isSessionSnapshotDto(value, context)).toBe(true);
		expect(isSessionWsServerMessage(value, context)).toBe(true);
		expect(isSessionSnapshotDto(value, { ...context, serverEpoch: "gateway-epoch-b" })).toBe(false);
	});

	it("rejects mixed incarnations and invalid snapshot waterlines", () => {
		expect(isSessionSnapshotDto(snapshot({ baseSeq: 5 }))).toBe(false);
		expect(isSessionSnapshotDto(snapshot({ asOfSeq: 3 }))).toBe(false);
		expect(isSessionSnapshotDto(snapshot({ runtime: runtime({ lastSeq: 3 }) }))).toBe(false);
		expect(isSessionSnapshotDto(snapshot({ runtime: runtime({ serverEpoch: "wrong-epoch" }) }))).toBe(false);
		expect(isSessionSnapshotDto(snapshot({ projectionEvents: [projectionEvent(2, "wrong-epoch")] }))).toBe(
			false,
		);
		expect(
			isSessionSnapshotDto(snapshot({ projectionEvents: [projectionEvent(2), projectionEvent(2)] })),
		).toBe(false);
		expect(isSessionSnapshotDto(snapshot({ projectionEvents: [projectionEvent(1)] }))).toBe(false);
		expect(isSessionSnapshotDto(snapshot({ projectionEvents: [projectionEvent(5)] }))).toBe(false);
	});

	it("enforces snapshot item, nesting, and text byte ceilings", () => {
		expect(
			isSessionSnapshotDto(
				snapshot({
					pendingExtensionRequests: Array.from({ length: 257 }, (_, index) => ({
						type: "extension_ui_request" as const,
						id: `confirm-${String(index)}`,
						method: "confirm" as const,
						title: "Confirm",
						message: "Continue?",
					})),
				}),
			),
		).toBe(false);

		let nested: Record<string, unknown> = {};
		for (let depth = 0; depth < 40; depth += 1) nested = { child: nested };
		expect(
			isSessionSnapshotDto(
				snapshot({
					projectionEvents: [
						{
							...projectionEvent(2),
							event: {
								type: "tool_execution_start",
								toolCallId: "tool-a",
								toolName: "tool",
								args: nested,
							},
						},
					],
				}),
			),
		).toBe(false);

		expect(
			isSessionSnapshotDto(
				snapshot({
					settledMessages: [
						{
							role: "user",
							content: "x".repeat(1024 * 1024 + 1),
							timestamp: 1,
						},
					],
				}),
			),
		).toBe(false);
	});

	it("rejects inherited required fields and prototype-backed nested records", () => {
		const valid = snapshot();
		const inheritedRoot = Object.create(valid) as unknown;
		const inheritedQueue = Object.create({ steering: [], followUp: [] }) as unknown;

		expect(isSessionSnapshotDto(inheritedRoot)).toBe(false);
		expect(isSessionSnapshotDto({ ...valid, queue: inheritedQueue })).toBe(false);
	});

	it("rejects serialization hooks, accessors, symbols, and non-enumerable properties", () => {
		const withToJson = snapshot() as SessionSnapshotDto & { toJSON?: () => unknown };
		Object.defineProperty(withToJson, "toJSON", {
			value: () => ({}),
			enumerable: false,
		});

		const withAccessor = snapshot();
		Object.defineProperty(withAccessor, "snapshotId", {
			get: () => "snapshot-from-accessor",
			enumerable: true,
		});

		const withSymbol = snapshot() as SessionSnapshotDto & Record<PropertyKey, unknown>;
		withSymbol[Symbol("hidden")] = "not-on-the-wire";

		const withHiddenProperty = snapshot();
		Object.defineProperty(withHiddenProperty, "hidden", {
			value: "not-on-the-wire",
			enumerable: false,
		});

		expect(isSessionSnapshotDto(withToJson)).toBe(false);
		expect(isSessionSnapshotDto(withAccessor)).toBe(false);
		expect(isSessionSnapshotDto(withSymbol)).toBe(false);
		expect(isSessionSnapshotDto(withHiddenProperty)).toBe(false);
	});

	it("rejects exotic containers that are not deeply immutable JSON values", () => {
		const frozenMap = Object.freeze(new Map<string, string>());
		frozenMap.set("still", "mutable");
		expect(frozenMap.size).toBe(1);

		for (const args of [frozenMap, new Set(["value"]), new Date(0)]) {
			const candidate = snapshot({
				asOfSeq: 2,
				runtime: runtime({ lastSeq: 2 }),
				projectionEvents: [
					{
						...projectionEvent(2),
						event: {
							type: "tool_execution_start",
							toolCallId: "tool-a",
							toolName: "tool",
							args,
						},
					},
				] as SessionSnapshotDto["projectionEvents"],
			});
			expect(isSessionSnapshotDto(candidate), Object.prototype.toString.call(args)).toBe(false);
		}
	});

	it("measures the exact UTF-8 JSON representation admitted on the wire", () => {
		const candidate = snapshot({
			queue: { steering: ["汉字"], followUp: ["🙂"] },
		});
		const expectedBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
		expect(isSessionSnapshotDto(candidate)).toBe(true);
		expect(sessionWsServerMessageBytes(candidate)).toBe(expectedBytes);
	});
});
