import {
	type ExtensionUiRequestDto,
	GATEWAY_FENCED_TAKEOVER_CAPABILITY,
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	GATEWAY_SESSION_HISTORY_CAPABILITY,
	type GatewayClientHelloDto,
	type GatewayServerHelloDto,
	type InlineSessionHistoryPageChunkDto,
	type InlineSessionReplayFrameDto,
	type InlineSessionSnapshotBeginDto,
	type InlineSessionSnapshotChunkDto,
	type InlineSessionSnapshotDto,
	type InlineSessionWsServerMessage,
	type NativeSessionDto,
	type PiExtensionUiRequestDto,
	type PiProductSessionEventDto,
	type PiSessionCommandResponseDto,
	type PiSessionMessageDto,
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
	SESSION_WS_CLIENT_MAX_BYTES,
	SESSION_WS_SERVER_MAX_BYTES,
	type SessionContentRefGuardContext,
	type SessionHistoryPageBeginDto,
	type SessionHistoryPageEndDto,
	type SessionMessageDto,
	type SessionReplayFrameDto,
	type SessionRuntimeDto,
	type SessionSnapshotBeginDto,
	type SessionSnapshotChunkDto,
	type SessionSnapshotDto,
	type SessionSnapshotEndDto,
	type SessionWsClientMessage,
	sessionHistoryChecksum,
	sessionHistoryMessagesBytes,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionDeleteCapability } from "../src/lib/session-capabilities";
import {
	createSessionContentAdapter,
	type SessionContentAdapter,
	type SessionExtensionMaterializer,
} from "../src/lib/session-content-adapter";
import { isCoalescibleMessageUpdate } from "../src/lib/session-event-scheduler";
import {
	createSessionTransport,
	OrderedSessionFrameBus,
	SESSION_FRAME_DEFERRED,
	type SessionTransportController,
	type SessionWebSocket,
} from "../src/stores/session-transport";

const EXPECTED_RESYNC_FRAME_LIMIT = 1_024;
const EXPECTED_RESYNC_BYTE_LIMIT = 1024 * 1024;
const EXPECTED_PENDING_EXTENSION_LIMIT = 256;

class FakeSocket implements SessionWebSocket {
	readyState = 0;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	readonly sent: Array<SessionWsClientMessage | GatewayClientHelloDto> = [];
	throwOnSend = false;

	send(data: string): void {
		if (this.throwOnSend) throw new Error("send failed");
		if (this.readyState !== 1) throw new Error("socket is not open");
		this.sent.push(JSON.parse(data) as SessionWsClientMessage | GatewayClientHelloDto);
	}

	open(negotiate = true): void {
		this.readyState = 1;
		this.onopen?.();
		if (negotiate) {
			this.serverMessage(serverHello());
			this.serverMessage(hotInventory());
		}
	}

	serverMessage(message: object): void {
		this.onmessage?.({ data: JSON.stringify(message) });
	}

	serverClose(): void {
		this.readyState = 3;
		this.onclose?.();
	}

	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}
}

type ServerHelloOverrides = Omit<Partial<GatewayServerHelloDto>, "protocol"> & {
	protocol?: { major: number; minor: number };
};

function serverHello(overrides: ServerHelloOverrides = {}): GatewayServerHelloDto {
	return {
		type: "server_hello",
		protocol: { major: 1, minor: 4 },
		serverBuild: "9.7.0-independent-server",
		serverEpoch: "test-server-epoch",
		piVersion: "0.84.2",
		adapterId: "pi-rpc",
		capabilities: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES],
		limits: {
			maxClientFrameBytes: 8 * 1024 * 1024,
			maxSnapshotFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
			maxExtensionRequests: 256,
		},
		payloadBudget: SESSION_PAYLOAD_BUDGET,
		...overrides,
		contentRefBudget: overrides.contentRefBudget ?? SESSION_CONTENT_REF_BUDGET,
	} as GatewayServerHelloDto;
}

function hotInventory(
	overrides: Partial<Extract<InlineSessionWsServerMessage, { type: "hot_runtime_inventory" }>> = {},
): Extract<InlineSessionWsServerMessage, { type: "hot_runtime_inventory" }> {
	return {
		type: "hot_runtime_inventory",
		serverEpoch: "test-server-epoch",
		revision: 0,
		runtimes: [],
		...overrides,
	};
}

interface Harness {
	controller: SessionTransportController;
	sockets: FakeSocket[];
}

const controllers: SessionTransportController[] = [];

function harness(
	options: {
		rawEventLimit?: number;
		rawEventMaxBytes?: number;
		rawEventGlobalLimit?: number;
		rawEventGlobalMaxBytes?: number;
		reconnectBaseMs?: number;
		helloTimeoutMs?: number;
		clientBuild?: string;
		onResyncRequired?: (message: Extract<InlineSessionWsServerMessage, { type: "resync_required" }>) => void;
		resyncClock?: {
			now: () => number;
			setTimeout: (callback: () => void, delayMs: number) => unknown;
			clearTimeout: (timer: unknown) => void;
		};
		resyncRandom?: () => number;
		contentAdapter?: SessionContentAdapter;
	} = {},
): Harness {
	const sockets: FakeSocket[] = [];
	let clock = 1_000;
	const controller = createSessionTransport({
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		url: () => "ws://session-transport.test/api/v1/ws",
		now: () => {
			clock += 1;
			return clock;
		},
		...options,
	});
	controllers.push(controller);
	return { controller, sockets };
}

const projectedContentContext: SessionContentRefGuardContext = Object.freeze({
	serverEpoch: "test-server-epoch",
	payloadBudget: SESSION_PAYLOAD_BUDGET,
	contentRefBudget: SESSION_CONTENT_REF_BUDGET,
});

function projectedAdapter(
	materializeExtensionRequest: SessionExtensionMaterializer["materializeExtensionRequest"],
): SessionContentAdapter {
	return createSessionContentAdapter({
		trustedContext: projectedContentContext,
		resolver: { materializeExtensionRequest },
	});
}

function projectedSetEditorFrame(
	sessionHandle: string,
	generation: number,
	seq: number,
	id: string,
): Extract<SessionReplayFrameDto, { type: "extension_ui_request" }> {
	return {
		type: "extension_ui_request",
		serverEpoch: "test-server-epoch",
		sessionHandle,
		workspaceId: "workspace-a",
		generation,
		seq,
		request: {
			type: "extension_ui_request",
			id,
			method: "set_editor_text",
			text: {
				type: "external_text",
				ref: {
					type: "content_ref",
					serverEpoch: "test-server-epoch",
					sha256: "a".repeat(64),
					byteLength: SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes,
					encoding: "utf-8",
				},
			},
		},
	};
}

function projectedEventFrame(
	sessionHandle: string,
	generation: number,
	seq: number,
): Extract<SessionReplayFrameDto, { type: "event" }> {
	return {
		type: "event",
		serverEpoch: "test-server-epoch",
		sessionHandle,
		workspaceId: "workspace-a",
		generation,
		seq,
		event: { type: "agent_start" },
	};
}

function projectedToolEventFrame(
	sessionHandle: string,
	generation: number,
	seq: number,
): Extract<SessionReplayFrameDto, { type: "event" }> {
	return {
		type: "event",
		serverEpoch: "test-server-epoch",
		sessionHandle,
		workspaceId: "workspace-a",
		generation,
		seq,
		event: {
			type: "tool_execution_start",
			toolCallId: "projected-tool-call",
			toolName: "fixture",
			args: {
				type: "external_json",
				ref: {
					type: "content_ref",
					serverEpoch: "test-server-epoch",
					sha256: "b".repeat(64),
					byteLength: SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes,
					encoding: "utf-8",
				},
			},
		},
	};
}

function projectedSnapshot(sessionHandle: string, generation: number, id: string): SessionSnapshotDto {
	const request = projectedSetEditorFrame(sessionHandle, generation, 1, id).request;
	if (request.method !== "set_editor_text") throw new Error("projected editor fixture was not sticky");
	const runtimeValue = runtime(sessionHandle, generation, 0);
	return {
		type: "session_snapshot",
		snapshotId: `projected-${id}`,
		serverEpoch: runtimeValue.serverEpoch,
		workspaceId: runtimeValue.workspaceId,
		sessionHandle,
		generation,
		baseSeq: 0,
		asOfSeq: 0,
		runtime: runtimeValue,
		settledMessages: [],
		projectionEvents: [],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests: [],
		stickyExtensionState: [request],
	};
}

function projectedChunkedSnapshotFrames(
	sessionHandle: string,
	id: string,
): [SessionSnapshotBeginDto, SessionSnapshotChunkDto, SessionSnapshotEndDto] {
	const snapshot = projectedSnapshot(sessionHandle, 1, id);
	const { type: _type, settledMessages: _settledMessages, ...snapshotHeader } = snapshot;
	const runtimeValue = snapshot.runtime;
	const message: SessionMessageDto = { role: "user", content: "snapshot", timestamp: 1 };
	const loadedBytes = sessionHistoryMessagesBytes([message]);
	const begin: SessionSnapshotBeginDto = {
		...snapshotHeader,
		type: "session_snapshot_begin",
		history: {
			totalMessages: 1,
			loadedMessages: 1,
			loadedBytes,
			totalBytes: loadedBytes,
			nextCursor: null,
		},
	};
	const chunk: SessionSnapshotChunkDto = {
		serverEpoch: runtimeValue.serverEpoch,
		sessionHandle,
		workspaceId: runtimeValue.workspaceId,
		generation: 1,
		type: "session_snapshot_chunk",
		snapshotId: snapshot.snapshotId,
		chunkIndex: 0,
		messages: [message],
		itemCount: 1,
		byteCount: loadedBytes,
		checksum: sessionHistoryChecksum([message]),
	};
	const end: SessionSnapshotEndDto = {
		serverEpoch: runtimeValue.serverEpoch,
		sessionHandle,
		workspaceId: runtimeValue.workspaceId,
		generation: 1,
		type: "session_snapshot_end",
		snapshotId: snapshot.snapshotId,
		chunkCount: 1,
		itemCount: 1,
		byteCount: loadedBytes,
		checksum: sessionHistoryChecksum([chunk.checksum]),
		nextCursor: null,
	};
	return [begin, chunk, end];
}

function projectedWireBytes(message: Parameters<SessionTransportController["ingestFrameMessage"]>[0]) {
	return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

function ingest(
	controller: SessionTransportController,
	message: Parameters<SessionTransportController["ingestFrameMessage"]>[0],
	rawWireBytes = projectedWireBytes(message),
) {
	return controller.ingestFrameMessage(message, rawWireBytes);
}

class ResyncClock {
	nowValue = 0;
	nextId = 1;
	timers = new Map<number, { at: number; callback: () => void }>();

	now = () => this.nowValue;
	setTimeout = (callback: () => void, delayMs: number) => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.nowValue + delayMs, callback });
		return id;
	};
	clearTimeout = (timer: unknown) => this.timers.delete(timer as number);
	advanceBy(delayMs: number) {
		const target = this.nowValue + delayMs;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
			if (!due) break;
			this.nowValue = due[1].at;
			this.timers.delete(due[0]);
			due[1].callback();
		}
		this.nowValue = target;
	}
}

async function flushPromises() {
	for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

function runtime(sessionHandle: string, generation = 1, lastSeq = 0): SessionRuntimeDto {
	return {
		serverEpoch: "test-server-epoch",
		sessionHandle,
		workspaceId: "workspace-a",
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/tmp/${sessionHandle}.jsonl`,
		cwd: "/tmp/workspace-a",
		generation,
		lastSeq,
		state: "idle",
		lastActivityAt: 100,
		recoverable: true,
	};
}

function eventFrame(
	sessionHandle: string,
	generation: number,
	seq: number,
): Extract<InlineSessionReplayFrameDto, { type: "event" }> {
	return {
		type: "event",
		serverEpoch: "test-server-epoch",
		sessionHandle,
		workspaceId: "workspace-a",
		generation,
		seq,
		event: { type: "agent_start" } as PiProductSessionEventDto,
	};
}

function attachmentRef(overrides: { serverEpoch?: string; byteLength?: number } = {}) {
	return {
		type: "attachment_ref" as const,
		serverEpoch: overrides.serverEpoch ?? "test-server-epoch",
		sha256: "a".repeat(64),
		mediaType: "image/png",
		byteLength: overrides.byteLength ?? 48,
	};
}

function extensionRequest(id: string): Extract<PiExtensionUiRequestDto, { method: "confirm" }> {
	return {
		type: "extension_ui_request",
		id,
		method: "confirm",
		title: id,
		message: id,
	};
}

function successResponse(
	sessionHandle: string,
	generation: number,
	id: string,
	command: string,
	barrierSeq = 0,
): Extract<InlineSessionWsServerMessage, { type: "response" }> {
	const data =
		command === "get_state"
			? {
					thinkingLevel: "medium",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					sessionId: sessionHandle,
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				}
			: command === "get_messages"
				? { messages: [] }
				: command === "fork"
					? { text: "", cancelled: false }
					: command === "clone"
						? { cancelled: false }
						: undefined;
	return {
		type: "response",
		serverEpoch: "test-server-epoch",
		sessionHandle,
		generation,
		barrierSeq,
		response: {
			id,
			type: "response",
			command,
			success: true,
			...(data === undefined ? {} : { data }),
		} as PiSessionCommandResponseDto,
	};
}

function extensionFrame(
	sessionHandle: string,
	generation: number,
	seq: number,
	request: PiExtensionUiRequestDto,
): Extract<InlineSessionReplayFrameDto, { type: "extension_ui_request" }> {
	return {
		type: "extension_ui_request",
		serverEpoch: "test-server-epoch",
		sessionHandle,
		workspaceId: "workspace-a",
		generation,
		seq,
		request,
	};
}

function connect(h: Harness): FakeSocket {
	h.controller.store.getState().connect();
	const socket = h.sockets.at(-1);
	if (!socket) throw new Error("transport did not create a socket");
	socket.open();
	return socket;
}

function subscribeAndPrime(h: Harness, sessionHandle: string, generation = 1, lastSeq = 0): void {
	const state = h.controller.store.getState();
	state.subscribeSession(sessionHandle);
	const snapshot = runtime(sessionHandle, generation, lastSeq);
	h.controller.ingestServerMessage({ type: "runtime_state", runtime: snapshot });
	h.controller.ingestServerMessage({
		type: "resync_required",
		serverEpoch: "test-server-epoch",
		sessionHandle,
		runtime: snapshot,
		reason: "initial",
	});
	h.controller.ingestServerMessage({
		type: "extension_ui_snapshot",
		serverEpoch: "test-server-epoch",
		sessionHandle,
		generation,
		requests: [],
	});
	completeWithSnapshot(h, sessionHandle, generation, lastSeq);
}

function completeWithSnapshot(
	h: Harness,
	sessionHandle: string,
	generation: number,
	asOfSeq?: number,
	pendingExtensionRequests: InlineSessionSnapshotDto["pendingExtensionRequests"] = [],
	runtimeOverride?: SessionRuntimeDto,
): void {
	const channel = h.controller.store.getState().sessions[sessionHandle];
	const seq = asOfSeq ?? channel?.resync?.barrierSeq ?? 0;
	const runtimeValue = runtimeOverride ?? runtime(sessionHandle, generation, seq);
	h.controller.ingestServerMessage({
		type: "session_snapshot",
		snapshotId: `snapshot-${sessionHandle}-${String(generation)}-${String(seq)}`,
		serverEpoch: runtimeValue.serverEpoch,
		workspaceId: runtimeValue.workspaceId,
		sessionHandle,
		generation,
		baseSeq: seq,
		asOfSeq: seq,
		runtime: runtimeValue,
		settledMessages: [],
		projectionEvents: [],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests,
		stickyExtensionState: [],
	} satisfies InlineSessionSnapshotDto);
}

function rejectSubscriptionDuringResync(h: Harness, socket: FakeSocket, sessionHandle = "session-a"): void {
	subscribeAndPrime(h, sessionHandle);
	const resyncRuntime = runtime(sessionHandle, 1, 0);
	socket.serverMessage({
		type: "resync_required",
		serverEpoch: resyncRuntime.serverEpoch,
		sessionHandle,
		runtime: resyncRuntime,
		reason: "gap",
	});
	socket.serverMessage({
		type: "session_error",
		serverEpoch: resyncRuntime.serverEpoch,
		sessionHandle,
		operation: "subscribe",
		error: "session_subscription_capacity",
		code: "session_subscription_capacity",
		retryable: true,
	});
	expect(h.controller.store.getState().sessions[sessionHandle]).toMatchObject({
		subscribed: true,
		baselineAuthoritative: false,
		subscriptionAdmission: {
			kind: "rejected",
			code: "session_subscription_capacity",
			retryable: true,
		},
	});
}

function historySnapshotFrames(
	sessionHandle: string,
	generation = 1,
): [InlineSessionSnapshotBeginDto, InlineSessionSnapshotChunkDto, SessionSnapshotEndDto] {
	const runtimeValue = runtime(sessionHandle, generation, 0);
	const messages: PiSessionMessageDto[] = [{ role: "user", content: "newest", timestamp: 1 }];
	const chunkChecksum = sessionHistoryChecksum(messages);
	const loadedBytes = sessionHistoryMessagesBytes(messages);
	const nextCursor = "cursor-older";
	return [
		{
			type: "session_snapshot_begin",
			snapshotId: "history-snapshot",
			serverEpoch: runtimeValue.serverEpoch,
			workspaceId: runtimeValue.workspaceId,
			sessionHandle,
			generation,
			baseSeq: 0,
			asOfSeq: 0,
			runtime: runtimeValue,
			projectionEvents: [],
			queue: { steering: [], followUp: [] },
			pendingExtensionRequests: [],
			stickyExtensionState: [],
			history: {
				totalMessages: 2,
				loadedMessages: messages.length,
				loadedBytes,
				totalBytes: loadedBytes + 32,
				nextCursor,
			},
		},
		{
			type: "session_snapshot_chunk",
			serverEpoch: runtimeValue.serverEpoch,
			workspaceId: runtimeValue.workspaceId,
			sessionHandle,
			generation,
			snapshotId: "history-snapshot",
			chunkIndex: 0,
			messages,
			itemCount: messages.length,
			byteCount: loadedBytes,
			checksum: chunkChecksum,
		},
		{
			type: "session_snapshot_end",
			serverEpoch: runtimeValue.serverEpoch,
			workspaceId: runtimeValue.workspaceId,
			sessionHandle,
			generation,
			snapshotId: "history-snapshot",
			chunkCount: 1,
			itemCount: messages.length,
			byteCount: loadedBytes,
			checksum: sessionHistoryChecksum([chunkChecksum]),
			nextCursor,
		},
	];
}

function historyPageFrames(
	sessionHandle: string,
	requestId: string,
	generation = 1,
): [SessionHistoryPageBeginDto, InlineSessionHistoryPageChunkDto, SessionHistoryPageEndDto] {
	const runtimeValue = runtime(sessionHandle, generation, 0);
	const messages: PiSessionMessageDto[] = [{ role: "user", content: "older", timestamp: 0 }];
	const chunkChecksum = sessionHistoryChecksum(messages);
	const loadedBytes = sessionHistoryMessagesBytes(messages);
	return [
		{
			type: "session_history_page_begin",
			serverEpoch: runtimeValue.serverEpoch,
			workspaceId: runtimeValue.workspaceId,
			sessionHandle,
			generation,
			requestId,
			snapshotId: "history-snapshot",
			asOfSeq: 0,
			cursor: "cursor-older",
			history: {
				totalMessages: 2,
				loadedMessages: messages.length,
				loadedBytes,
				totalBytes: loadedBytes + 32,
				nextCursor: null,
			},
		},
		{
			type: "session_history_page_chunk",
			serverEpoch: runtimeValue.serverEpoch,
			workspaceId: runtimeValue.workspaceId,
			sessionHandle,
			generation,
			requestId,
			snapshotId: "history-snapshot",
			chunkIndex: 0,
			messages,
			itemCount: messages.length,
			byteCount: loadedBytes,
			checksum: chunkChecksum,
		},
		{
			type: "session_history_page_end",
			serverEpoch: runtimeValue.serverEpoch,
			workspaceId: runtimeValue.workspaceId,
			sessionHandle,
			generation,
			requestId,
			snapshotId: "history-snapshot",
			chunkCount: 1,
			itemCount: messages.length,
			byteCount: loadedBytes,
			checksum: sessionHistoryChecksum([chunkChecksum]),
			nextCursor: null,
		},
	];
}

function connectWithHistory(h: Harness): FakeSocket {
	h.controller.store.getState().connect();
	const socket = h.sockets[0];
	if (!socket) throw new Error("transport did not create a socket");
	socket.open(false);
	socket.serverMessage(
		serverHello({
			capabilities: [...serverHello().capabilities, GATEWAY_SESSION_HISTORY_CAPABILITY],
		}),
	);
	socket.serverMessage(hotInventory());
	return socket;
}

function sentCommand(socket: FakeSocket, id: string) {
	return socket.sent.find(
		(message): message is Extract<SessionWsClientMessage, { type: "command" }> =>
			message.type === "command" && message.command.id === id,
	);
}

afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
	vi.useRealTimers();
});

describe("session transport Gateway negotiation", () => {
	it("sends client_hello first and waits for an independently-versioned server hello", () => {
		const h = harness({ clientBuild: "2.4.1-independent-ui" });
		h.controller.store.getState().connect();
		const socket = h.sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		h.controller.store.getState().subscribeSession("session-a");

		socket.open(false);
		expect(socket.sent[0]).toEqual({
			type: "client_hello",
			protocol: { major: 1, minor: 4 },
			clientBuild: "2.4.1-independent-ui",
			capabilities: [
				"rpc.commands",
				"rpc.events",
				"rpc.extension_ui",
				"session.multiplex",
				GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
				GATEWAY_FENCED_TAKEOVER_CAPABILITY,
				GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
				"payload.epoch_content_refs",
				GATEWAY_SESSION_HISTORY_CAPABILITY,
			],
			limits: { maxServerFrameBytes: SESSION_WS_SERVER_MAX_BYTES },
		});
		expect(h.controller.store.getState().connectionState).toBe("connecting");
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toEqual([]);

		socket.serverMessage(serverHello({ serverBuild: "99.0.0-independent-server" }));
		expect(h.controller.store.getState().connectionState).toBe("connecting");
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toEqual([]);

		socket.serverMessage(hotInventory());
		expect(h.controller.store.getState().connectionState).toBe("online");
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toEqual([
			{ type: "session_subscribe", sessionHandle: "session-a" },
		]);
	});

	it("subscribes every initial hot Runtime exactly only after the authoritative inventory", () => {
		const h = harness();
		h.controller.store.getState().connect();
		const socket = h.sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		socket.open(false);
		socket.serverMessage(serverHello());

		expect(h.controller.store.getState().connectionState).toBe("connecting");
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toEqual([]);

		socket.serverMessage(
			hotInventory({
				revision: 4,
				runtimes: [
					{
						serverEpoch: "test-server-epoch",
						sessionHandle: "hot-a",
						workspaceId: "workspace-a",
						generation: 2,
						state: "running",
					},
					{
						serverEpoch: "test-server-epoch",
						sessionHandle: "hot-b",
						workspaceId: "workspace-a",
						generation: 1,
						state: "waiting_ui",
					},
				],
			}),
		);

		expect(h.controller.store.getState().connectionState).toBe("online");
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toEqual([
			{
				type: "session_subscribe",
				sessionHandle: "hot-a",
				expectedHotRuntime: {
					serverEpoch: "test-server-epoch",
					sessionHandle: "hot-a",
					workspaceId: "workspace-a",
					generation: 2,
				},
			},
		]);

		const first = runtime("hot-a", 2, 0);
		socket.serverMessage({ type: "runtime_state", runtime: first });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: first.serverEpoch,
			sessionHandle: first.sessionHandle,
			runtime: first,
			reason: "initial",
		});
		completeWithSnapshot(h, "hot-a", 2, 0);
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toHaveLength(1);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: first.serverEpoch,
			sessionHandle: first.sessionHandle,
			generation: first.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});

		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toEqual([
			{
				type: "session_subscribe",
				sessionHandle: "hot-a",
				expectedHotRuntime: {
					serverEpoch: "test-server-epoch",
					sessionHandle: "hot-a",
					workspaceId: "workspace-a",
					generation: 2,
				},
			},
			{
				type: "session_subscribe",
				sessionHandle: "hot-b",
				expectedHotRuntime: {
					serverEpoch: "test-server-epoch",
					sessionHandle: "hot-b",
					workspaceId: "workspace-a",
					generation: 1,
				},
			},
		]);
	});

	it("advances the exact recovery queue after a failed item without dropping its observer", () => {
		const h = harness();
		h.controller.store.getState().connect();
		const socket = h.sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		socket.open(false);
		socket.serverMessage(serverHello());
		const entry = (sessionHandle: string) => ({
			serverEpoch: "test-server-epoch",
			sessionHandle,
			workspaceId: "workspace-a",
			generation: 1,
			state: "idle" as const,
		});
		socket.serverMessage(hotInventory({ revision: 1, runtimes: [entry("hot-a"), entry("hot-b")] }));
		expect(
			socket.sent.filter(
				(message) => message.type === "session_subscribe" && message.expectedHotRuntime !== undefined,
			),
		).toHaveLength(1);

		socket.serverMessage({
			type: "session_error",
			serverEpoch: "test-server-epoch",
			sessionHandle: "hot-a",
			operation: "subscribe",
			error: "session_snapshot_unavailable",
		});

		expect(
			socket.sent.flatMap((message) =>
				message.type === "session_subscribe" && message.expectedHotRuntime !== undefined
					? [message.sessionHandle]
					: [],
			),
		).toEqual(["hot-a", "hot-b"]);
		expect(h.controller.store.getState().sessions["hot-a"]?.subscribed).toBe(true);
	});

	it("releases the next exact hot subscription after a deferred lease commits with an async snapshot", async () => {
		let releaseSnapshot!: () => void;
		const snapshotGate = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		let snapshotProjectionStarted = false;
		const adapter = projectedAdapter(async (request: ExtensionUiRequestDto) => {
			if (request.id === "hot-existing-snapshot") {
				snapshotProjectionStarted = true;
				await snapshotGate;
			}
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: `resolved:${request.id}` };
		});
		const h = harness({ contentAdapter: adapter });
		const socket = connect(h);
		const existing = {
			serverEpoch: "test-server-epoch",
			sessionHandle: "hot-existing",
			workspaceId: "workspace-a",
			generation: 1,
			state: "idle" as const,
		};
		const existingRuntime = runtime(existing.sessionHandle, existing.generation, 0);
		socket.serverMessage(hotInventory({ revision: 1, runtimes: [existing] }));
		socket.serverMessage({ type: "runtime_state", runtime: existingRuntime });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: existingRuntime.serverEpoch,
			sessionHandle: existingRuntime.sessionHandle,
			runtime: existingRuntime,
			reason: "initial",
		});
		expect(
			ingest(
				h.controller,
				projectedSnapshot(existing.sessionHandle, existing.generation, "hot-existing-snapshot"),
			),
		).toBe(true);
		await vi.waitFor(() => expect(snapshotProjectionStarted).toBe(true));

		socket.serverMessage({
			type: "lease_status",
			serverEpoch: existingRuntime.serverEpoch,
			sessionHandle: existingRuntime.sessionHandle,
			generation: existingRuntime.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		const late = {
			serverEpoch: "test-server-epoch",
			sessionHandle: "hot-late",
			workspaceId: "workspace-a",
			generation: 1,
			state: "idle" as const,
		};
		socket.serverMessage(hotInventory({ revision: 2, runtimes: [existing, late] }));
		const exactSubscriptions = (sessionHandle: string) =>
			socket.sent.filter(
				(message) =>
					message.type === "session_subscribe" &&
					message.sessionHandle === sessionHandle &&
					message.expectedHotRuntime !== undefined,
			);
		expect(exactSubscriptions(existing.sessionHandle)).toHaveLength(1);
		expect(exactSubscriptions(late.sessionHandle)).toHaveLength(0);

		releaseSnapshot();
		await vi.waitFor(() => {
			expect(h.controller.store.getState().sessions[existing.sessionHandle]).toMatchObject({
				baselineAuthoritative: true,
				freshLeaseBaseline: expect.objectContaining({
					serverEpoch: existing.serverEpoch,
					sessionHandle: existing.sessionHandle,
					workspaceId: existing.workspaceId,
					generation: existing.generation,
				}),
				lease: { isController: false, leaseRevision: 0, controlState: "free" },
			});
			expect(exactSubscriptions(late.sessionHandle)).toHaveLength(1);
		});

		const lateRuntime = runtime(late.sessionHandle, late.generation, 0);
		socket.serverMessage({ type: "runtime_state", runtime: lateRuntime });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: lateRuntime.serverEpoch,
			sessionHandle: lateRuntime.sessionHandle,
			runtime: lateRuntime,
			reason: "initial",
		});
		expect(h.controller.store.getState().claimSession(late.sessionHandle)).toBe(true);
		completeWithSnapshot(h, late.sessionHandle, late.generation, 0);
		expect(h.controller.store.getState().sessions[late.sessionHandle]).toMatchObject({
			baselineAuthoritative: true,
			freshLeaseBaseline: null,
		});
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: lateRuntime.serverEpoch,
			sessionHandle: lateRuntime.sessionHandle,
			generation: lateRuntime.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});

		expect(h.controller.store.getState().sessions[late.sessionHandle]).toMatchObject({
			baselineAuthoritative: true,
			freshLeaseBaseline: expect.objectContaining({
				serverEpoch: late.serverEpoch,
				sessionHandle: late.sessionHandle,
				workspaceId: late.workspaceId,
				generation: late.generation,
			}),
			lease: { isController: false, leaseRevision: 0, controlState: "free" },
		});
		expect(
			socket.sent.filter(
				(message) => message.type === "session_claim" && message.sessionHandle === late.sessionHandle,
			),
		).toEqual([{ type: "session_claim", sessionHandle: late.sessionHandle }]);
	});

	it("migrates an uncertain rekey while the parent baseline subscription is in flight", () => {
		const h = harness();
		const socket = connect(h);
		const parent = runtime("session-parent", 1, 0);
		h.controller.store.getState().subscribeSession(parent.sessionHandle);
		socket.serverMessage({ type: "runtime_state", runtime: parent });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: parent.serverEpoch,
			sessionHandle: parent.sessionHandle,
			runtime: parent,
			reason: "initial",
		});
		expect(h.controller.store.getState().claimSession(parent.sessionHandle)).toBe(true);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: parent.serverEpoch,
			sessionHandle: parent.sessionHandle,
			generation: parent.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});

		const child = runtime("session-child", 2, 0);
		socket.serverMessage({
			type: "session_rekeyed",
			serverEpoch: child.serverEpoch,
			previousSessionHandle: parent.sessionHandle,
			runtime: child,
		});
		expect(
			socket.sent.filter(
				(message) => message.type === "session_subscribe" && message.sessionHandle === child.sessionHandle,
			),
		).toHaveLength(0);

		socket.serverMessage({
			type: "resync_required",
			serverEpoch: child.serverEpoch,
			sessionHandle: child.sessionHandle,
			runtime: child,
			reason: "generation_changed",
		});
		expect(
			socket.sent.filter(
				(message) => message.type === "session_subscribe" && message.sessionHandle === child.sessionHandle,
			),
		).toHaveLength(0);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: child.serverEpoch,
			sessionHandle: child.sessionHandle,
			generation: child.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "rekey",
			isController: false,
		});
		completeWithSnapshot(h, child.sessionHandle, child.generation, 0);

		expect(h.controller.store.getState().sessions[parent.sessionHandle]?.subscribed).toBe(false);
		expect(h.controller.store.getState().sessions[child.sessionHandle]).toMatchObject({
			controllerIntent: true,
			baselineAuthoritative: true,
			freshLeaseBaseline: expect.objectContaining({
				serverEpoch: child.serverEpoch,
				sessionHandle: child.sessionHandle,
				workspaceId: child.workspaceId,
				generation: child.generation,
			}),
			lease: { isController: false, leaseRevision: 0, controlState: "free" },
		});
		expect(
			socket.sent.filter(
				(message) => message.type === "session_claim" && message.sessionHandle === child.sessionHandle,
			),
		).toEqual([{ type: "session_claim", sessionHandle: child.sessionHandle }]);
	});

	it("returns an epoch and revision token only after the initial inventory", async () => {
		const h = harness();
		const pending = h.controller.waitForInitialHotInventory();
		h.controller.store.getState().connect();
		const socket = h.sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		socket.open(false);
		socket.serverMessage(serverHello({ serverEpoch: "epoch-token" }));
		socket.serverMessage(hotInventory({ serverEpoch: "epoch-token", revision: 7 }));

		await expect(pending).resolves.toEqual({ serverEpoch: "epoch-token", revision: 7 });
	});

	it("rejects initial inventory waiters on incompatible hello, timeout, and dispose", async () => {
		const incompatible = harness();
		const incompatibleWait = incompatible.controller.waitForInitialHotInventory();
		incompatible.controller.store.getState().connect();
		const incompatibleSocket = incompatible.sockets[0];
		if (!incompatibleSocket) throw new Error("transport did not create a socket");
		incompatibleSocket.open(false);
		incompatibleSocket.serverMessage(serverHello({ protocol: { major: 2, minor: 1 } }));
		await expect(incompatibleWait).rejects.toMatchObject({ code: "unavailable" });

		vi.useFakeTimers();
		const timedOut = harness({ helloTimeoutMs: 25 });
		const timeoutWait = timedOut.controller.waitForInitialHotInventory();
		timedOut.controller.store.getState().connect();
		const timeoutSocket = timedOut.sockets[0];
		if (!timeoutSocket) throw new Error("transport did not create a socket");
		timeoutSocket.open(false);
		vi.advanceTimersByTime(25);
		await expect(timeoutWait).rejects.toMatchObject({ code: "unavailable" });

		const disposed = harness();
		const disposedWait = disposed.controller.waitForInitialHotInventory();
		disposed.controller.dispose();
		await expect(disposedWait).rejects.toMatchObject({ code: "unavailable" });
	});

	it("uses the shared hot inventory negotiation floor", () => {
		const minorZero = harness();
		minorZero.controller.store.getState().connect();
		const minorSocket = minorZero.sockets[0];
		if (!minorSocket) throw new Error("transport did not create a socket");
		minorSocket.open(false);
		minorSocket.serverMessage(serverHello({ protocol: { major: 1, minor: 0 } }));
		expect(minorZero.controller.store.getState().connectionState).toBe("incompatible");

		const undersized = harness();
		undersized.controller.store.getState().connect();
		const undersizedSocket = undersized.sockets[0];
		if (!undersizedSocket) throw new Error("transport did not create a socket");
		undersizedSocket.open(false);
		undersizedSocket.serverMessage(
			serverHello({
				limits: {
					maxClientFrameBytes: 8 * 1024 * 1024,
					maxSnapshotFrameBytes: 512 * 1024,
					maxExtensionRequests: 256,
				},
			}),
		);
		expect(undersized.controller.store.getState().connectionState).toBe("incompatible");
	});

	it("sends the last authoritative cursor when an expected hot incarnation changes", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "hot-a", 1, 5);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "hot-a",
			generation: 1,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		const before = socket.sent.filter(({ type }) => type === "session_subscribe").length;

		socket.serverMessage(
			hotInventory({
				revision: 1,
				runtimes: [
					{
						serverEpoch: "test-server-epoch",
						sessionHandle: "hot-a",
						workspaceId: "workspace-a",
						generation: 2,
						state: "idle",
					},
				],
			}),
		);

		expect(socket.sent.filter(({ type }) => type === "session_subscribe").slice(before)).toEqual([
			{
				type: "session_subscribe",
				sessionHandle: "hot-a",
				cursor: { serverEpoch: "test-server-epoch", generation: 1, seq: 5 },
				expectedHotRuntime: {
					serverEpoch: "test-server-epoch",
					sessionHandle: "hot-a",
					workspaceId: "workspace-a",
					generation: 2,
				},
			},
		]);
	});

	it("preserves a stale cursor across an epoch reconnect until the Gateway fences it", () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 5 });
		const firstSocket = connect(h);
		subscribeAndPrime(h, "hot-a", 1, 5);
		firstSocket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "hot-a",
			generation: 1,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		firstSocket.serverClose();
		vi.advanceTimersByTime(5);
		const secondSocket = h.sockets[1];
		if (!secondSocket) throw new Error("transport did not reconnect");
		secondSocket.open(false);
		secondSocket.serverMessage(serverHello({ serverEpoch: "next-server-epoch" }));
		secondSocket.serverMessage(
			hotInventory({
				serverEpoch: "next-server-epoch",
				revision: 1,
				runtimes: [
					{
						serverEpoch: "next-server-epoch",
						sessionHandle: "hot-a",
						workspaceId: "workspace-a",
						generation: 1,
						state: "idle",
					},
				],
			}),
		);

		expect(
			secondSocket.sent.filter(
				(message) => message.type === "session_subscribe" && message.expectedHotRuntime !== undefined,
			),
		).toEqual([
			{
				type: "session_subscribe",
				sessionHandle: "hot-a",
				cursor: { serverEpoch: "test-server-epoch", generation: 1, seq: 5 },
				expectedHotRuntime: {
					serverEpoch: "next-server-epoch",
					sessionHandle: "hot-a",
					workspaceId: "workspace-a",
					generation: 1,
				},
			},
		]);
	});

	it("rejects direct adapter frames from an old epoch and all frames after disposal", () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 5 });
		const firstSocket = connect(h);
		subscribeAndPrime(h, "session-a", 1, 0);
		firstSocket.serverClose();
		vi.advanceTimersByTime(5);
		const secondSocket = h.sockets[1];
		if (!secondSocket) throw new Error("transport did not reconnect");
		secondSocket.open(false);
		secondSocket.serverMessage(serverHello({ serverEpoch: "next-server-epoch" }));
		secondSocket.serverMessage(hotInventory({ serverEpoch: "next-server-epoch", revision: 1 }));

		const beforeOldEpoch = h.controller.store.getState().sessions["session-a"]?.runtime;
		h.controller.ingestServerMessage({
			type: "runtime_state",
			runtime: { ...runtime("session-a", 99, 99), serverEpoch: "test-server-epoch" },
		});
		expect(h.controller.store.getState().sessions["session-a"]?.runtime).toEqual(beforeOldEpoch);

		const disposed = harness();
		connect(disposed);
		disposed.controller.dispose();
		const afterDispose = disposed.controller.store.getState().hotRuntimeInventory;
		disposed.controller.ingestServerMessage(
			hotInventory({
				revision: 1,
				runtimes: [
					{
						serverEpoch: "test-server-epoch",
						sessionHandle: "late-session",
						workspaceId: "workspace-a",
						generation: 1,
						state: "idle",
					},
				],
			}),
		);
		expect(disposed.controller.store.getState().hotRuntimeInventory).toEqual(afterDispose);
	});

	it("keeps one exact request in flight and retries the newest same-handle identity", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "hot-a", 1, 5);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "hot-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "old-fence",
		});
		const exactCount = () =>
			socket.sent.filter(
				(
					message,
				): message is Extract<SessionWsClientMessage, { type: "session_subscribe" }> & {
					expectedHotRuntime: NonNullable<
						Extract<SessionWsClientMessage, { type: "session_subscribe" }>["expectedHotRuntime"]
					>;
				} => message.type === "session_subscribe" && message.expectedHotRuntime !== undefined,
			);
		const desired = (generation: number) => ({
			serverEpoch: "test-server-epoch",
			sessionHandle: "hot-a",
			workspaceId: "workspace-a",
			generation,
			state: "idle" as const,
		});

		socket.serverMessage(hotInventory({ revision: 1, runtimes: [desired(2)] }));
		socket.serverMessage(hotInventory({ revision: 2, runtimes: [desired(3)] }));
		expect(exactCount()).toHaveLength(1);
		socket.serverMessage({
			type: "session_error",
			serverEpoch: "test-server-epoch",
			sessionHandle: "hot-a",
			operation: "subscribe",
			error: "generation_changed",
		});

		expect(exactCount().map((message) => message.expectedHotRuntime?.generation)).toEqual([2, 3]);
		expect(h.controller.store.getState().sessions["hot-a"]).toMatchObject({
			subscribed: true,
			baselineAuthoritative: true,
			lease: { isController: true, fencingToken: "old-fence" },
		});
	});

	it("does not restart an exact child subscription after rekey baseline and lease settle", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-parent", 1, 0);
		h.controller.store.getState().claimSession("session-parent");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-parent",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "child-fence",
		});
		const child = runtime("session-child", 2, 0);
		socket.serverMessage({
			type: "session_rekeyed",
			serverEpoch: child.serverEpoch,
			previousSessionHandle: "session-parent",
			runtime: child,
		});
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: child.serverEpoch,
			sessionHandle: child.sessionHandle,
			runtime: child,
			reason: "generation_changed",
		});
		completeWithSnapshot(h, child.sessionHandle, child.generation, 0);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: child.serverEpoch,
			sessionHandle: child.sessionHandle,
			generation: child.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "rekey",
			isController: false,
		});
		const beforeInventory = socket.sent.filter(
			(message) => message.type === "session_subscribe" && message.sessionHandle === child.sessionHandle,
		).length;

		socket.serverMessage(
			hotInventory({
				revision: 1,
				runtimes: [
					{
						serverEpoch: child.serverEpoch,
						sessionHandle: child.sessionHandle,
						workspaceId: child.workspaceId,
						generation: child.generation,
						state: "idle",
					},
				],
			}),
		);

		expect(
			socket.sent.filter(
				(message) => message.type === "session_subscribe" && message.sessionHandle === child.sessionHandle,
			),
		).toHaveLength(beforeInventory);
		expect(h.controller.store.getState().sessions[child.sessionHandle]).toMatchObject({
			baselineAuthoritative: true,
			freshLeaseBaseline: child,
			lease: {
				isController: false,
				leaseRevision: 0,
				controlState: "free",
				transition: "rekey",
			},
		});
	});

	it("keeps an exact parent attempt fenced until its post-rekey error before subscribing the child", () => {
		const h = harness();
		const socket = connect(h);
		const parent = {
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-parent",
			workspaceId: "workspace-a",
			generation: 1,
			state: "idle" as const,
		};
		socket.serverMessage(hotInventory({ revision: 1, runtimes: [parent] }));
		const child = runtime("session-child", 2, 0);
		socket.serverMessage({
			type: "session_rekeyed",
			serverEpoch: child.serverEpoch,
			previousSessionHandle: parent.sessionHandle,
			runtime: child,
		});
		expect(
			socket.sent.flatMap((message) =>
				message.type === "session_subscribe" && message.expectedHotRuntime ? [message.sessionHandle] : [],
			),
		).toEqual(["session-parent"]);

		socket.serverMessage({
			type: "session_error",
			serverEpoch: parent.serverEpoch,
			sessionHandle: parent.sessionHandle,
			operation: "subscribe",
			error: "expected_hot_runtime_rekeyed",
		});
		socket.serverMessage(
			hotInventory({
				revision: 2,
				runtimes: [
					{
						serverEpoch: child.serverEpoch,
						sessionHandle: child.sessionHandle,
						workspaceId: child.workspaceId,
						generation: child.generation,
						state: "idle",
					},
				],
			}),
		);

		expect(
			socket.sent.flatMap((message) =>
				message.type === "session_subscribe" && message.expectedHotRuntime ? [message.sessionHandle] : [],
			),
		).toEqual(["session-parent", "session-child"]);
	});

	it("releases global exact admission after one hot Runtime degrades and does not duplicate its live observer", async () => {
		const clock = new ResyncClock();
		const h = harness({ resyncClock: clock, resyncRandom: () => 0.5 });
		const socket = connect(h);
		const hot = (sessionHandle: string) => ({
			serverEpoch: "test-server-epoch",
			sessionHandle,
			workspaceId: "workspace-a",
			generation: 1,
			state: "idle" as const,
		});
		socket.serverMessage(hotInventory({ revision: 1, runtimes: [hot("hot-a"), hot("hot-b")] }));
		const active = runtime("hot-a", 1, 0);
		socket.serverMessage({ type: "runtime_state", runtime: active });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: active.serverEpoch,
			sessionHandle: active.sessionHandle,
			runtime: active,
			reason: "initial",
		});
		const failAttempt = () =>
			socket.serverMessage({
				type: "session_error",
				serverEpoch: active.serverEpoch,
				sessionHandle: active.sessionHandle,
				operation: "subscribe",
				error: "projection failed",
			});
		for (const delay of [500, 1_000, 2_000]) {
			failAttempt();
			await flushPromises();
			clock.advanceBy(delay);
			await flushPromises();
		}
		expect(
			socket.sent.flatMap((message) =>
				message.type === "session_subscribe" && message.expectedHotRuntime ? [message.sessionHandle] : [],
			),
		).toEqual(["hot-a"]);
		failAttempt();
		await flushPromises();

		expect(h.controller.store.getState().sessions["hot-a"]?.recovery).toMatchObject({
			phase: "degraded",
			attempt: 4,
		});
		expect(
			socket.sent.flatMap((message) =>
				message.type === "session_subscribe" && message.expectedHotRuntime ? [message.sessionHandle] : [],
			),
		).toEqual(["hot-a", "hot-b"]);

		socket.serverMessage(hotInventory({ revision: 2, runtimes: [hot("hot-a"), hot("hot-b")] }));
		expect(
			socket.sent.flatMap((message) =>
				message.type === "session_subscribe" && message.expectedHotRuntime ? [message.sessionHandle] : [],
			),
		).toEqual(["hot-a", "hot-b"]);
	});

	it("skips exact recovery for an already-observed degraded live channel while admitting another hot Runtime", async () => {
		const clock = new ResyncClock();
		const h = harness({ resyncClock: clock, resyncRandom: () => 0.5 });
		const socket = connect(h);
		subscribeAndPrime(h, "hot-a", 1, 0);
		expect(h.controller.reportProjectionFailure("hot-a", 1, new Error("projection failed"))).toBe(true);
		const failAttempt = () =>
			socket.serverMessage({
				type: "session_error",
				serverEpoch: "test-server-epoch",
				sessionHandle: "hot-a",
				operation: "subscribe",
				error: "projection failed",
			});
		for (const delay of [500, 1_000, 2_000]) {
			failAttempt();
			await flushPromises();
			clock.advanceBy(delay);
			await flushPromises();
		}
		failAttempt();
		await flushPromises();
		expect(h.controller.store.getState().sessions["hot-a"]?.recovery?.phase).toBe("degraded");

		const hot = (sessionHandle: string) => ({
			serverEpoch: "test-server-epoch",
			sessionHandle,
			workspaceId: "workspace-a",
			generation: 1,
			state: "idle" as const,
		});
		socket.serverMessage(hotInventory({ revision: 1, runtimes: [hot("hot-a"), hot("hot-b")] }));

		expect(
			socket.sent.flatMap((message) =>
				message.type === "session_subscribe" && message.expectedHotRuntime ? [message.sessionHandle] : [],
			),
		).toEqual(["hot-b"]);
		expect(h.controller.store.getState().sessions["hot-a"]?.recovery?.phase).toBe("degraded");
	});

	it("keeps a matching degraded hot Runtime manual-only across reconnect while recovering other hot Runtimes", async () => {
		const clock = new ResyncClock();
		const h = harness({ resyncClock: clock, resyncRandom: () => 0.5, reconnectBaseMs: 5 });
		let socket = connect(h);
		subscribeAndPrime(h, "hot-a", 1, 0);
		expect(h.controller.reportProjectionFailure("hot-a", 1, new Error("projection failed"))).toBe(true);
		const failAttempt = () =>
			socket.serverMessage({
				type: "session_error",
				serverEpoch: "test-server-epoch",
				sessionHandle: "hot-a",
				operation: "subscribe",
				error: "projection failed",
			});
		for (const delay of [500, 1_000, 2_000]) {
			failAttempt();
			await flushPromises();
			clock.advanceBy(delay);
			await flushPromises();
		}
		failAttempt();
		await flushPromises();
		expect(h.controller.store.getState().sessions["hot-a"]?.recovery?.phase).toBe("degraded");

		h.controller.store.getState().disconnect();
		h.controller.store.getState().connect();
		socket = h.sockets.at(-1)!;
		socket.open(false);
		socket.serverMessage(serverHello());
		const hot = (sessionHandle: string) => ({
			serverEpoch: "test-server-epoch",
			sessionHandle,
			workspaceId: "workspace-a",
			generation: 1,
			state: "idle" as const,
		});
		socket.serverMessage(hotInventory({ revision: 1, runtimes: [hot("hot-a"), hot("hot-b")] }));

		expect(
			socket.sent.flatMap((message) =>
				message.type === "session_subscribe" && message.expectedHotRuntime ? [message.sessionHandle] : [],
			),
		).toEqual(["hot-b"]);
		expect(h.controller.store.getState().sessions["hot-a"]?.recovery?.phase).toBe("degraded");

		const runtimeB = runtime("hot-b", 1, 0);
		socket.serverMessage({ type: "runtime_state", runtime: runtimeB });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: runtimeB.serverEpoch,
			sessionHandle: runtimeB.sessionHandle,
			runtime: runtimeB,
			reason: "initial",
		});
		completeWithSnapshot(h, "hot-b", 1, 0);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: runtimeB.serverEpoch,
			sessionHandle: runtimeB.sessionHandle,
			generation: runtimeB.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});

		expect(h.controller.store.getState().manualRetryResync("hot-a")).toBe(true);
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "hot-a" });
		completeWithSnapshot(h, "hot-a", 1, 0);
		await flushPromises();
		expect(h.controller.store.getState().sessions["hot-a"]).toMatchObject({
			baselineAuthoritative: true,
			recovery: null,
		});
	});

	it("recovers a changed hot incarnation even when the previous identity was degraded", async () => {
		const clock = new ResyncClock();
		const h = harness({ resyncClock: clock, resyncRandom: () => 0.5 });
		let socket = connect(h);
		subscribeAndPrime(h, "hot-a", 1, 0);
		expect(h.controller.reportProjectionFailure("hot-a", 1, new Error("projection failed"))).toBe(true);
		for (const delay of [500, 1_000, 2_000]) {
			socket.serverMessage({
				type: "session_error",
				serverEpoch: "test-server-epoch",
				sessionHandle: "hot-a",
				operation: "subscribe",
				error: "projection failed",
			});
			await flushPromises();
			clock.advanceBy(delay);
			await flushPromises();
		}
		socket.serverMessage({
			type: "session_error",
			serverEpoch: "test-server-epoch",
			sessionHandle: "hot-a",
			operation: "subscribe",
			error: "projection failed",
		});
		await flushPromises();
		expect(h.controller.store.getState().sessions["hot-a"]?.recovery?.phase).toBe("degraded");

		h.controller.store.getState().disconnect();
		h.controller.store.getState().connect();
		socket = h.sockets.at(-1)!;
		socket.open(false);
		socket.serverMessage(serverHello());
		socket.serverMessage(
			hotInventory({
				revision: 1,
				runtimes: [
					{
						serverEpoch: "test-server-epoch",
						sessionHandle: "hot-a",
						workspaceId: "workspace-a",
						generation: 2,
						state: "idle",
					},
				],
			}),
		);

		expect(
			socket.sent.find(
				(message) => message.type === "session_subscribe" && message.expectedHotRuntime !== undefined,
			),
		).toMatchObject({
			type: "session_subscribe",
			sessionHandle: "hot-a",
			expectedHotRuntime: { generation: 2 },
		});
	});

	it("continues the exact-hot queue when runtime_state precedes resync_required after reconnect", () => {
		const h = harness();
		let socket = connect(h);
		const hot = (sessionHandle: string, generation: number) => ({
			serverEpoch: "test-server-epoch",
			sessionHandle,
			workspaceId: "workspace-a",
			generation,
			state: "idle" as const,
		});
		const initial = runtime("hot-a", 1, 0);
		socket.serverMessage(hotInventory({ revision: 1, runtimes: [hot("hot-a", 1)] }));
		socket.serverMessage({ type: "runtime_state", runtime: initial });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: initial.serverEpoch,
			sessionHandle: initial.sessionHandle,
			runtime: initial,
			reason: "initial",
		});
		completeWithSnapshot(h, initial.sessionHandle, initial.generation, initial.lastSeq);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: initial.serverEpoch,
			sessionHandle: initial.sessionHandle,
			generation: initial.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});

		h.controller.store.getState().disconnect();
		h.controller.store.getState().connect();
		socket = h.sockets.at(-1)!;
		socket.open(false);
		socket.serverMessage(serverHello());
		socket.serverMessage(hotInventory({ revision: 1, runtimes: [hot("hot-a", 2), hot("hot-b", 1)] }));
		const exactSubscriptionHandles = () =>
			socket.sent.flatMap((message) =>
				message.type === "session_subscribe" && message.expectedHotRuntime ? [message.sessionHandle] : [],
			);
		expect(exactSubscriptionHandles()).toEqual(["hot-a"]);

		const next = runtime("hot-a", 2, 0);
		socket.serverMessage({ type: "runtime_state", runtime: next });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: next.serverEpoch,
			sessionHandle: next.sessionHandle,
			runtime: next,
			reason: "generation_changed",
		});
		completeWithSnapshot(h, next.sessionHandle, next.generation, next.lastSeq);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: next.serverEpoch,
			sessionHandle: next.sessionHandle,
			generation: next.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});

		expect(exactSubscriptionHandles()).toEqual(["hot-a", "hot-b"]);
	});

	it("ignores stale inventory revisions and releases a removed observer without reopening history", () => {
		const h = harness();
		const socket = connect(h);
		const hot = {
			serverEpoch: "test-server-epoch",
			sessionHandle: "hot-a",
			workspaceId: "workspace-a",
			generation: 1,
			state: "idle" as const,
		};
		socket.serverMessage(hotInventory({ revision: 2, runtimes: [hot] }));
		expect(h.controller.store.getState().sessions["hot-a"]?.subscribed).toBe(true);

		socket.serverMessage(hotInventory({ revision: 1, runtimes: [] }));
		expect(h.controller.store.getState().hotRuntimeInventory?.revision).toBe(2);
		expect(h.controller.store.getState().sessions["hot-a"]?.subscribed).toBe(true);
		socket.serverMessage(hotInventory({ revision: 3, runtimes: [hot] }));
		expect(
			socket.sent.filter(
				(message) => message.type === "session_subscribe" && message.expectedHotRuntime !== undefined,
			),
		).toHaveLength(1);

		socket.serverMessage(hotInventory({ revision: 4, runtimes: [] }));
		expect(h.controller.store.getState().sessions["hot-a"]?.subscribed).toBe(false);
		expect(socket.sent.at(-1)).toEqual({ type: "session_unsubscribe", sessionHandle: "hot-a" });
	});

	it("does not reopen a removed selected hot Runtime through an ordinary history subscribe", () => {
		const h = harness();
		const socket = connect(h);
		const hot = {
			serverEpoch: "test-server-epoch",
			sessionHandle: "selected-hot",
			workspaceId: "workspace-a",
			generation: 1,
			state: "idle" as const,
		};
		socket.serverMessage(hotInventory({ revision: 1, runtimes: [hot] }));
		h.controller.store.getState().claimSession(hot.sessionHandle);
		socket.serverMessage(hotInventory({ revision: 2, runtimes: [] }));

		expect(h.controller.store.getState().sessions[hot.sessionHandle]?.subscribed).toBe(false);
		expect(
			socket.sent.filter(
				(message) => message.type === "session_subscribe" && message.sessionHandle === hot.sessionHandle,
			),
		).toHaveLength(1);
		expect(socket.sent.at(-1)).toEqual({
			type: "session_unsubscribe",
			sessionHandle: hot.sessionHandle,
		});
	});

	it("waits for an exact baseline and matching fresh lease before claiming a selected hot Runtime", () => {
		const h = harness();
		const socket = connect(h);
		const hot = {
			serverEpoch: "test-server-epoch",
			sessionHandle: "hot-a",
			workspaceId: "workspace-a",
			generation: 3,
			state: "idle" as const,
		};
		socket.serverMessage(hotInventory({ revision: 1, runtimes: [hot] }));
		h.controller.store.getState().claimSession(hot.sessionHandle);
		expect(socket.sent.filter(({ type }) => type === "session_claim")).toEqual([]);

		const active = runtime(hot.sessionHandle, hot.generation, 0);
		socket.serverMessage({ type: "runtime_state", runtime: active });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: active.serverEpoch,
			sessionHandle: active.sessionHandle,
			runtime: active,
			reason: "initial",
		});
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: active.serverEpoch,
			sessionHandle: active.sessionHandle,
			generation: active.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		expect(socket.sent.filter(({ type }) => type === "session_claim")).toEqual([]);
		completeWithSnapshot(h, hot.sessionHandle, hot.generation, 0);
		expect(socket.sent.at(-1)).toEqual({ type: "session_claim", sessionHandle: hot.sessionHandle });
	});

	it("enters a terminal incompatible state for a mismatched server protocol major", () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 5 });
		h.controller.store.getState().connect();
		const socket = h.sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		socket.open(false);
		socket.serverMessage(serverHello({ protocol: { major: 2, minor: 0 } }));

		expect(h.controller.store.getState().connectionState).toBe("incompatible");
		vi.advanceTimersByTime(60_000);
		h.controller.store.getState().connect();
		expect(h.sockets).toHaveLength(1);
	});

	it("rejects a server minor newer than the client requested", () => {
		const h = harness();
		h.controller.store.getState().connect();
		const socket = h.sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		socket.open(false);
		socket.serverMessage(serverHello({ protocol: { major: 1, minor: 5 } }));

		expect(h.controller.store.getState().connectionState).toBe("incompatible");
	});

	it("treats a Gateway protocol_error as terminal and does not reconnect", () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 5 });
		h.controller.store.getState().connect();
		const socket = h.sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		socket.open(false);
		socket.serverMessage({
			type: "protocol_error",
			code: "protocol_major_unsupported",
			supported: { major: 1, minMinor: 0, maxMinor: 0 },
		});

		expect(h.controller.store.getState().connectionState).toBe("incompatible");
		vi.advanceTimersByTime(60_000);
		expect(h.sockets).toHaveLength(1);
	});

	it("fails closed when the Host never completes hello or sends a malformed first frame", () => {
		vi.useFakeTimers();
		const timedOut = harness({ helloTimeoutMs: 25, reconnectBaseMs: 5 });
		timedOut.controller.store.getState().connect();
		const timeoutSocket = timedOut.sockets[0];
		if (!timeoutSocket) throw new Error("transport did not create a socket");
		timeoutSocket.open(false);
		vi.advanceTimersByTime(25);
		expect(timedOut.controller.store.getState().connectionState).toBe("incompatible");
		vi.advanceTimersByTime(60_000);
		timedOut.controller.store.getState().connect();
		expect(timedOut.sockets).toHaveLength(1);

		const malformed = harness();
		malformed.controller.store.getState().connect();
		const malformedSocket = malformed.sockets[0];
		if (!malformedSocket) throw new Error("transport did not create a socket");
		malformedSocket.open(false);
		malformedSocket.onmessage?.({ data: "not-json" });
		expect(malformed.controller.store.getState().connectionState).toBe("incompatible");
	});

	it("retries when sending client_hello fails", () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 5 });
		h.controller.store.getState().connect();
		const socket = h.sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		socket.throwOnSend = true;
		socket.open(false);

		expect(h.controller.store.getState().connectionState).toBe("offline");
		vi.advanceTimersByTime(5);
		expect(h.sockets).toHaveLength(2);
	});

	it("requires negotiated capabilities and an honored server-frame limit", () => {
		const missingPayload = harness();
		missingPayload.controller.store.getState().connect();
		const payloadSocket = missingPayload.sockets[0];
		if (!payloadSocket) throw new Error("transport did not create a socket");
		payloadSocket.open(false);
		const inlineOnlyHello = serverHello();
		inlineOnlyHello.capabilities = inlineOnlyHello.capabilities.filter(
			(capability) => capability !== GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
		);
		delete (inlineOnlyHello as { payloadBudget?: unknown }).payloadBudget;
		payloadSocket.serverMessage(inlineOnlyHello);
		expect(missingPayload.controller.store.getState().connectionState).toBe("incompatible");

		const missingBaseCapability = harness();
		missingBaseCapability.controller.store.getState().connect();
		const capabilitySocket = missingBaseCapability.sockets[0];
		if (!capabilitySocket) throw new Error("transport did not create a socket");
		capabilitySocket.open(false);
		const helloWithoutEvents = serverHello();
		helloWithoutEvents.capabilities = helloWithoutEvents.capabilities.filter(
			(capability) => capability !== "rpc.events",
		);
		capabilitySocket.serverMessage(helloWithoutEvents);
		expect(missingBaseCapability.controller.store.getState().connectionState).toBe("incompatible");

		const excessiveLimit = harness();
		excessiveLimit.controller.store.getState().connect();
		const limitSocket = excessiveLimit.sockets[0];
		if (!limitSocket) throw new Error("transport did not create a socket");
		limitSocket.open(false);
		limitSocket.serverMessage(
			serverHello({
				limits: {
					maxClientFrameBytes: 8 * 1024 * 1024,
					maxSnapshotFrameBytes: 66 * 1024 * 1024,
					maxExtensionRequests: 256,
				},
			}),
		);
		expect(excessiveLimit.controller.store.getState().connectionState).toBe("incompatible");
	});

	it("accepts a valid history snapshot above the former 32 MiB ceiling", async () => {
		const h = harness();
		h.controller.store.getState().connect();
		const socket = h.sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		socket.open(false);
		socket.serverMessage(
			serverHello({
				limits: {
					maxClientFrameBytes: SESSION_WS_CLIENT_MAX_BYTES,
					maxSnapshotFrameBytes: SESSION_WS_SERVER_MAX_BYTES,
					maxExtensionRequests: 256,
				},
			}),
		);
		socket.serverMessage(hotInventory());
		subscribeAndPrime(h, "session-large");
		const pending = h.controller.store
			.getState()
			.sendCommand("session-large", { id: "large-history", type: "get_messages" });
		const frame: Extract<InlineSessionWsServerMessage, { type: "response" }> = {
			type: "response",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-large",
			generation: 1,
			barrierSeq: 0,
			response: {
				id: "large-history",
				type: "response",
				command: "get_messages",
				success: true,
				data: {
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "x".repeat(33 * 1024 * 1024) }],
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: 1,
						},
					],
				},
			},
		};
		socket.serverMessage(frame);

		await expect(pending).resolves.toMatchObject({ id: "large-history", success: true });
		expect(h.controller.store.getState().connectionState).toBe("online");
	});
});

describe("session transport multiplexing", () => {
	it("uses the negotiated attachment context for authoritative ref events", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const delivered: unknown[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "event") delivered.push(message);
		});
		const frame = {
			...eventFrame("session-a", 1, 1),
			event: {
				type: "message_start",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "restored" },
						{ type: "image", data: attachmentRef(), mimeType: "image/png" },
					],
					timestamp: 1,
				},
			} as PiProductSessionEventDto,
		} satisfies Extract<InlineSessionReplayFrameDto, { type: "event" }>;

		socket.serverMessage(frame);
		await flushPromises();

		expect(h.controller.store.getState().connectionState).toBe("online");
		expect(delivered).toEqual([frame]);
	});

	it("uses the negotiated attachment context for authoritative ref snapshots", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		socket.serverMessage({
			type: "session_snapshot",
			snapshotId: "snapshot-with-ref",
			serverEpoch: "test-server-epoch",
			workspaceId: "workspace-a",
			sessionHandle: "session-a",
			generation: 1,
			baseSeq: 0,
			asOfSeq: 0,
			runtime: runtime("session-a", 1, 0),
			settledMessages: [
				{
					role: "user",
					content: [{ type: "image", data: attachmentRef(), mimeType: "image/png" }],
					timestamp: 1,
				},
			],
			projectionEvents: [],
			queue: { steering: [], followUp: [] },
			pendingExtensionRequests: [],
			stickyExtensionState: [],
		} satisfies InlineSessionSnapshotDto);
		await flushPromises();

		expect(h.controller.store.getState().sessions["session-a"]?.resync).toBeNull();
		expect(h.controller.store.getState().connectionState).toBe("online");
	});

	it("keeps a correlated structured admission failure local to its command", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.store.getState().claimSession("session-a");
		h.controller.ingestServerMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "token-a",
		});
		const failed = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "cache-full", type: "prompt", message: "keep draft" });
		socket.serverMessage({
			type: "response",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			barrierSeq: 0,
			response: {
				type: "response",
				id: "cache-full",
				command: "prompt",
				success: false,
				error: "Gateway delivery failure",
				admissionError: {
					type: "payload_admission_error",
					code: "attachment_cache_exhausted",
					boundary: "attachment_cache",
					limitBytes: 1024,
					actualBytes: 2048,
				},
			},
		});

		await expect(failed).resolves.toMatchObject({
			success: false,
			admissionError: { code: "attachment_cache_exhausted" },
		});
		expect(h.controller.store.getState().connectionState).toBe("online");
		const next = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "retry", type: "prompt", message: "retry" });
		socket.serverMessage(successResponse("session-a", 1, "retry", "prompt"));
		await expect(next).resolves.toMatchObject({ success: true });
	});

	it("coalesces attachment load failures into one cursorless resync for the exact identity", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a", 1, 4);
		const before = socket.sent.filter(({ type }) => type === "session_subscribe").length;

		expect(h.controller.reportProjectionFailure("session-a", 1, new Error("attachment unavailable"))).toBe(
			true,
		);
		expect(h.controller.reportProjectionFailure("session-a", 1, new Error("duplicate image error"))).toBe(
			false,
		);
		expect(h.controller.reportProjectionFailure("session-a", 2, new Error("stale image error"))).toBe(false);
		const resubscriptions = socket.sent
			.filter(
				(message): message is Extract<SessionWsClientMessage, { type: "session_subscribe" }> =>
					message.type === "session_subscribe",
			)
			.slice(before);
		expect(resubscriptions).toEqual([{ type: "session_subscribe", sessionHandle: "session-a" }]);
	});

	it("ingests foreground and background Sessions independently over one socket", async () => {
		const h = harness({ rawEventLimit: 2 });
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		subscribeAndPrime(h, "session-b");

		const aSequences: number[] = [];
		const bSequences: number[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "event") aSequences.push(message.seq);
		});
		h.controller.frameBus.subscribe("session-b", ({ message }) => {
			if (message.type === "event") bSequences.push(message.seq);
		});

		socket.serverMessage(eventFrame("session-a", 1, 1));
		socket.serverMessage(eventFrame("session-b", 1, 1));
		socket.serverMessage(eventFrame("session-a", 1, 2));
		socket.serverMessage(eventFrame("session-a", 1, 3));
		await flushPromises();

		expect(aSequences).toEqual([1, 2, 3]);
		expect(bSequences).toEqual([1]);
		expect(h.controller.store.getState().sessions["session-b"]?.lastSeq).toBe(1);
		expect(
			h.controller.store.getState().sessions["session-a"]?.rawEvents.map((record) => record.seq),
		).toEqual([2, 3]);
	});

	it("keeps pending extension snapshots isolated by Session", () => {
		const h = harness();
		connect(h);
		subscribeAndPrime(h, "session-a");
		subscribeAndPrime(h, "session-b");

		h.controller.ingestServerMessage({
			type: "extension_ui_snapshot",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			requests: [extensionRequest("request-a")],
		});
		h.controller.ingestServerMessage({
			type: "extension_ui_snapshot",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-b",
			generation: 1,
			requests: [extensionRequest("request-b")],
		});

		expect(
			h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests.map(({ id }) => id),
		).toEqual(["request-a"]);
		expect(
			h.controller.store.getState().sessions["session-b"]?.pendingExtensionRequests.map(({ id }) => id),
		).toEqual(["request-b"]);
	});

	it("bounds retained raw events by per-Session and global count", () => {
		const h = harness({
			rawEventLimit: 2,
			rawEventGlobalLimit: 3,
			rawEventMaxBytes: 1024 * 1024,
			rawEventGlobalMaxBytes: 1024 * 1024,
		});
		connect(h);
		subscribeAndPrime(h, "session-a");
		subscribeAndPrime(h, "session-b");
		for (let seq = 1; seq <= 3; seq += 1) {
			h.controller.ingestServerMessage(eventFrame("session-a", 1, seq));
		}
		h.controller.ingestServerMessage(eventFrame("session-b", 1, 1));
		h.controller.ingestServerMessage(eventFrame("session-b", 1, 2));

		expect(
			h.controller.store.getState().sessions["session-a"]?.rawEvents.map((record) => record.seq),
		).toEqual([3]);
		expect(
			h.controller.store.getState().sessions["session-b"]?.rawEvents.map((record) => record.seq),
		).toEqual([1, 2]);
	});

	it("bounds retained raw events by per-Session and global bytes", () => {
		const h = harness({
			rawEventLimit: 10,
			rawEventGlobalLimit: 10,
			rawEventMaxBytes: 1_000,
			rawEventGlobalMaxBytes: 1_500,
		});
		connect(h);
		subscribeAndPrime(h, "session-a");
		subscribeAndPrime(h, "session-b");
		const largeEvent = (sessionHandle: string, seq: number) =>
			({
				...eventFrame(sessionHandle, 1, seq),
				event: { type: "agent_start", detail: "x".repeat(700) },
			}) as unknown as InlineSessionReplayFrameDto;
		h.controller.ingestServerMessage(largeEvent("session-a", 1));
		h.controller.ingestServerMessage(largeEvent("session-a", 2));
		expect(
			h.controller.store.getState().sessions["session-a"]?.rawEvents.map((record) => record.seq),
		).toEqual([2]);

		h.controller.ingestServerMessage(largeEvent("session-b", 1));
		expect(h.controller.store.getState().sessions["session-a"]?.rawEvents).toEqual([]);
		expect(
			h.controller.store.getState().sessions["session-b"]?.rawEvents.map((record) => record.seq),
		).toEqual([1]);
	});
});

describe("session transport replay and recovery", () => {
	it("makes a failed subscription explicitly retryable without losing controller intent", () => {
		const h = harness();
		const socket = connect(h);
		const errors: string[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "session_error") errors.push(message.error);
		});

		h.controller.store.getState().subscribeSession("session-a");
		expect(h.controller.store.getState().claimSession("session-a")).toBe(true);
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toHaveLength(1);

		socket.serverMessage({
			type: "session_error",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			operation: "subscribe",
			error: "workspace_identity_transitioning",
		});

		expect(errors).toEqual(["workspace_identity_transitioning"]);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			subscribed: false,
			controllerIntent: true,
			lease: { isController: false },
		});

		h.controller.store.getState().subscribeSession("session-a");
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toHaveLength(2);

		const initial = runtime("session-a", 1, 0);
		socket.serverMessage({ type: "runtime_state", runtime: initial });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: initial,
			reason: "initial",
		});
		socket.serverMessage({
			type: "extension_ui_snapshot",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			requests: [],
		});
		completeWithSnapshot(h, "session-a", 1, 0);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		expect(socket.sent.filter(({ type }) => type === "session_claim")).toEqual([
			{ type: "session_claim", sessionHandle: "session-a" },
		]);
	});

	it("keeps a failed recovery subscribed while the bounded coordinator retries", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		expect(h.controller.store.getState().claimSession("session-a")).toBe(true);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "session-token",
		});
		expect(h.controller.reportProjectionFailure("session-a", 1, new Error("projection failed"))).toBe(true);
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		socket.serverMessage({
			type: "session_error",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			operation: "subscribe",
			error: "session_runtime_capacity",
		});
		await flushPromises();

		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			subscribed: true,
			baselineAuthoritative: false,
			recovery: { phase: "retry_wait", attempt: 1 },
		});
		expect(socket.sent).not.toContainEqual({ type: "session_release", sessionHandle: "session-a" });
	});

	it("holds a response barrier until deferred projection work is confirmed", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.frameBus.subscribe("session-a", ({ message }) =>
			message.type === "event" ? SESSION_FRAME_DEFERRED : undefined,
		);

		const pending = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "deferred-barrier", type: "get_state" });
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {},
		);
		socket.serverMessage(successResponse("session-a", 1, "deferred-barrier", "get_state", 1));
		socket.serverMessage(eventFrame("session-a", 1, 1));
		await flushPromises();

		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lastSeq: 1,
			projectedSeq: 0,
		});
		expect(settled).toBe(false);
		expect(h.controller.confirmProjectionDelivery("session-a", 1)).toBe(true);
		await expect(pending).resolves.toMatchObject({ id: "deferred-barrier", success: true });
		expect(h.controller.store.getState().sessions["session-a"]?.projectedSeq).toBe(1);
	});

	it("rolls a deferred cursor back when asynchronous projection reports failure", async () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 5 });
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.frameBus.subscribe("session-a", ({ message }) =>
			message.type === "event" ? SESSION_FRAME_DEFERRED : undefined,
		);
		const pending = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "failed-deferred-barrier", type: "get_state" });
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {},
		);
		socket.serverMessage(successResponse("session-a", 1, "failed-deferred-barrier", "get_state", 1));
		socket.serverMessage(eventFrame("session-a", 1, 1));

		expect(h.controller.reportProjectionFailure("session-a", 1, new Error("rAF reducer failed"))).toBe(true);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lastSeq: 0,
			projectedSeq: 0,
			resync: { barrierSeq: 0, requiresFreshBaseline: true },
		});
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });

		socket.serverClose();
		vi.advanceTimersByTime(5);
		const replacement = h.sockets[1];
		if (!replacement) throw new Error("transport did not reconnect");
		replacement.open();
		expect(replacement.sent).toContainEqual({
			type: "session_subscribe",
			sessionHandle: "session-a",
		});
	});

	it("treats a malformed authoritative Gateway event as terminal", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		subscribeAndPrime(h, "session-b");
		const observed: string[] = [];
		const leaseStates: boolean[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type !== "event" || message.event.type !== "message_update") return;
			isCoalescibleMessageUpdate(message.event);
		});
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "event") observed.push(`a:${String(message.seq)}`);
			if (message.type === "lease_status") leaseStates.push(message.isController);
		});
		h.controller.frameBus.subscribe("session-b", ({ message }) => {
			if (message.type === "event") observed.push(`b:${String(message.seq)}`);
		});

		const affected = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "affected-barrier", type: "get_state" });
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "lease-before-incompatible",
		});
		expect(
			sessionDeleteCapability(
				{ persisted: true, runtime: runtime("session-a") } as NativeSessionDto,
				h.controller.store.getState().sessions["session-a"],
			),
		).toEqual({ allowed: true, reason: null });
		socket.serverMessage(successResponse("session-a", 1, "affected-barrier", "get_state", 1));
		const malformed = {
			...eventFrame("session-a", 1, 1),
			event: { type: "message_update", usage: {} },
		} as unknown as InlineSessionWsServerMessage;
		socket.serverMessage(malformed);
		await expect(affected).rejects.toMatchObject({ code: "unavailable" });

		expect(observed).toEqual([]);
		expect(h.controller.store.getState().connectionState).toBe("incompatible");
		expect(h.controller.store.getState().sessions["session-a"]?.lastSeq).toBe(0);
		expect(h.controller.store.getState().sessions["session-a"]?.projectedSeq).toBe(0);
		expect(h.controller.store.getState().sessions["session-a"]?.resync).toBeNull();
		expect(h.controller.store.getState().sessions["session-a"]?.lease).toEqual({ isController: false });
		expect(leaseStates).toEqual([true]);
		expect(
			sessionDeleteCapability(
				{ persisted: true, runtime: runtime("session-a") } as NativeSessionDto,
				h.controller.store.getState().sessions["session-a"],
			),
		).toEqual({ allowed: false, reason: "controller_required" });
	});

	it("keeps the channel non-authoritative until session_snapshot commits", () => {
		const h = harness();
		const socket = connect(h);
		h.controller.store.getState().subscribeSession("session-a");
		let resyncNotices = 0;
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "resync_required") resyncNotices += 1;
		});
		const initial = runtime("session-a", 1, 0);
		socket.serverMessage({ type: "runtime_state", runtime: initial });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: initial,
			reason: "initial",
		});

		expect(resyncNotices).toBe(1);
		expect(h.controller.store.getState().sessions["session-a"]?.baselineAuthoritative).toBe(false);
		expect(sentCommand(socket, "baseline-messages")).toBeUndefined();
		socket.serverMessage({
			type: "extension_ui_snapshot",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			requests: [],
		});
		expect(h.controller.store.getState().sessions["session-a"]?.baselineAuthoritative).toBe(false);
		completeWithSnapshot(h, "session-a", 1);
		expect(h.controller.store.getState().sessions["session-a"]?.baselineAuthoritative).toBe(true);
	});

	it("retains independent cursors and resubscribes every Session after reconnect", async () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 10 });
		const first = connect(h);
		subscribeAndPrime(h, "session-a");
		subscribeAndPrime(h, "session-b");
		first.serverMessage(eventFrame("session-a", 1, 1));
		first.serverMessage(eventFrame("session-a", 1, 2));
		first.serverMessage(eventFrame("session-b", 1, 1));
		await flushPromises();

		first.serverClose();
		expect(h.controller.store.getState().connectionState).toBe("offline");
		vi.advanceTimersByTime(10);
		const second = h.sockets[1];
		if (!second) throw new Error("transport did not reconnect");
		second.open();

		expect(second.sent).toEqual(
			expect.arrayContaining([
				{
					type: "session_subscribe",
					sessionHandle: "session-a",
					cursor: { serverEpoch: "test-server-epoch", generation: 1, seq: 2 },
				},
				{
					type: "session_subscribe",
					sessionHandle: "session-b",
					cursor: { serverEpoch: "test-server-epoch", generation: 1, seq: 1 },
				},
			]),
		);
	});

	it("invalidates only a dormant snapshot so its next subscription has no cursor", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage(eventFrame("session-a", 1, 1));
		await flushPromises();
		expect(h.controller.store.getState().invalidateSessionSnapshot("session-a")).toBe(false);
		expect(h.controller.store.getState().sessions["session-a"]?.lastSeq).toBe(1);

		h.controller.store.getState().unsubscribeSession("session-a");
		expect(h.controller.store.getState().invalidateSessionSnapshot("session-a")).toBe(true);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			subscribed: false,
			controllerIntent: false,
			runtime: null,
			generation: null,
			lastSeq: 0,
			resync: null,
			rawEvents: [],
		});

		h.controller.store.getState().subscribeSession("session-a");
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
	});

	it("buffers every post-resync frame until the snapshot barrier is completed", () => {
		const notices: string[] = [];
		const h = harness({ onResyncRequired: (message) => notices.push(message.reason) });
		connect(h);
		subscribeAndPrime(h, "session-a");
		const delivered: Array<string | number> = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			delivered.push(message.type === "event" ? message.seq : message.type);
		});
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 2));

		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 2),
			reason: "gap",
		});
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 3));
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 4));

		expect(delivered).toEqual([1, 2, "resync_required"]);
		expect(h.controller.store.getState().sessions["session-a"]?.resync).toMatchObject({
			barrierSeq: 2,
			bufferedFrameCount: 2,
		});
		expect(h.controller.store.getState().sessions["session-a"]?.lastSeq).toBe(4);

		completeWithSnapshot(h, "session-a", 1, 2);
		expect(delivered).toEqual([1, 2, "resync_required", "session_snapshot", 3, 4]);
		expect(h.controller.store.getState().sessions["session-a"]?.resync).toBeNull();
		expect(notices).toContain("gap");
	});

	it("fails closed when a buffered replay frame throws during resync completion", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "event") throw new Error("buffered projection failed");
		});
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));

		completeWithSnapshot(h, "session-a", 1, 0);

		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lastSeq: 0,
			projectedSeq: 0,
			resync: {
				barrierSeq: 0,
				bufferedFrameCount: 0,
				requiresFreshBaseline: true,
			},
		});
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
	});

	it("resolves responses only after the projected channel covers the response barrier", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const order: string[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "event") order.push(`event:${String(message.seq)}`);
		});

		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));
		const duringResync = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "barrier-one", type: "get_state" });
		duringResync.then(() => order.push("response:1"));
		socket.serverMessage(successResponse("session-a", 1, "barrier-one", "get_state", 1));
		await Promise.resolve();
		expect(order).toEqual([]);

		completeWithSnapshot(h, "session-a", 1, 0);
		await expect(duringResync).resolves.toMatchObject({ id: "barrier-one" });
		await Promise.resolve();
		expect(order).toEqual(["event:1", "response:1"]);

		const aheadOfCursor = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "barrier-two", type: "get_state" });
		let secondSettled = false;
		aheadOfCursor.then(() => {
			secondSettled = true;
			order.push("response:2");
		});
		socket.serverMessage(successResponse("session-a", 1, "barrier-two", "get_state", 2));
		await Promise.resolve();
		expect(secondSettled).toBe(false);
		socket.serverMessage(eventFrame("session-a", 1, 2));
		await expect(aheadOfCursor).resolves.toMatchObject({ id: "barrier-two" });
		await Promise.resolve();
		expect(order.slice(-2)).toEqual(["event:2", "response:2"]);
	});

	it("never lets get_messages advance an authoritative snapshot barrier", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const delivered: number[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "event") delivered.push(message.seq);
		});

		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));
		const snapshot = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "resync-messages", type: "get_messages" });
		const ordinaryRead = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "resync-state", type: "get_state" });
		let ordinarySettled = false;
		ordinaryRead.then(() => {
			ordinarySettled = true;
		});

		socket.serverMessage(successResponse("session-a", 1, "resync-messages", "get_messages", 1));
		socket.serverMessage(successResponse("session-a", 1, "resync-state", "get_state", 2));
		let snapshotSettled = false;
		void snapshot.then(() => {
			snapshotSettled = true;
		});
		await Promise.resolve();
		expect(snapshotSettled).toBe(false);
		expect(ordinarySettled).toBe(false);
		expect(h.controller.store.getState().sessions["session-a"]?.resync).toMatchObject({
			barrierSeq: 0,
			bufferedFrameCount: 1,
		});

		// The authoritative message snapshot covers sequence 1. Only the later
		// buffered frame may reach incremental projection consumers.
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 2));
		completeWithSnapshot(h, "session-a", 1, 1);
		expect(delivered).toEqual([2]);
		await expect(snapshot).resolves.toMatchObject({ id: "resync-messages", command: "get_messages" });
		await expect(ordinaryRead).resolves.toMatchObject({ id: "resync-state", command: "get_state" });
	});

	it("hard-limits buffered replay frames and raises a new snapshot barrier on overflow", () => {
		const notices: Array<{ reason: string; barrierSeq: number }> = [];
		const h = harness({
			onResyncRequired: (message) =>
				notices.push({ reason: message.reason, barrierSeq: message.runtime.lastSeq }),
		});
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});

		for (let seq = 1; seq <= EXPECTED_RESYNC_FRAME_LIMIT + 1; seq += 1) {
			h.controller.ingestServerMessage(eventFrame("session-a", 1, seq));
		}

		expect(h.controller.store.getState().sessions["session-a"]?.resync).toMatchObject({
			reason: "gap",
			barrierSeq: 0,
			bufferedFrameCount: 0,
		});
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		expect(notices.at(-1)).toEqual({ reason: "gap", barrierSeq: 0 });
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, EXPECTED_RESYNC_FRAME_LIMIT + 1),
			reason: "initial",
		});
		h.controller.ingestServerMessage({
			type: "extension_ui_snapshot",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			requests: [],
		});
		expect(notices.at(-1)).toEqual({
			reason: "initial",
			barrierSeq: EXPECTED_RESYNC_FRAME_LIMIT + 1,
		});
	});

	it("hard-limits replay buffer bytes independently of frame count", () => {
		const h = harness();
		connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		const oversized = {
			...eventFrame("session-a", 1, 1),
			event: { type: "agent_start", detail: "x".repeat(EXPECTED_RESYNC_BYTE_LIMIT + 1) },
		} as unknown as InlineSessionReplayFrameDto;
		h.controller.ingestServerMessage(oversized);

		expect(h.controller.store.getState().sessions["session-a"]?.resync).toMatchObject({
			barrierSeq: 0,
			bufferedFrameCount: 0,
		});
	});

	it("refreshes the atomic extension snapshot after a replay-buffer overflow", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const dialog = extensionRequest("dialog-one");
		h.controller.ingestServerMessage(extensionFrame("session-a", 1, 1, dialog));
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 1),
			reason: "gap",
		});
		const oversized = {
			...eventFrame("session-a", 1, 2),
			event: { type: "agent_start", detail: "x".repeat(EXPECTED_RESYNC_BYTE_LIMIT + 1) },
		} as unknown as InlineSessionReplayFrameDto;
		h.controller.ingestServerMessage(oversized);
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		expect(h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests).toEqual([]);

		h.controller.ingestServerMessage({
			type: "runtime_state",
			runtime: runtime("session-a", 1, 2),
		});
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 2),
			reason: "initial",
		});
		completeWithSnapshot(h, "session-a", 1, 2, [dialog]);
		expect(
			h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests.map(({ id }) => id),
		).toEqual(["dialog-one"]);
	});

	it("requests only a cursorless subscription after replay-buffer overflow", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		const oversized = {
			...eventFrame("session-a", 1, 1),
			event: { type: "agent_start", detail: "x".repeat(EXPECTED_RESYNC_BYTE_LIMIT + 1) },
		} as unknown as InlineSessionReplayFrameDto;
		h.controller.ingestServerMessage(oversized);

		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		expect(sentCommand(socket, "overflow-messages")).toBeUndefined();
		h.controller.ingestServerMessage({
			type: "runtime_state",
			runtime: runtime("session-a", 1, 1),
		});
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 1),
			reason: "initial",
		});
		completeWithSnapshot(h, "session-a", 1, 1);
		expect(h.controller.store.getState().sessions["session-a"]?.baselineAuthoritative).toBe(true);
	});

	it("re-announces an unfinished resync after reconnect without losing its buffer", () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const h = harness({
			reconnectBaseMs: 5,
			onResyncRequired: (message) => notices.push(message.reason),
		});
		const first = connect(h);
		subscribeAndPrime(h, "session-a");
		const delivered: number[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "event") delivered.push(message.seq);
		});

		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));
		first.serverClose();
		vi.advanceTimersByTime(5);
		const second = h.sockets[1];
		if (!second) throw new Error("transport did not reconnect");
		second.open();

		expect(second.sent).toContainEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		h.controller.ingestServerMessage({
			type: "extension_ui_snapshot",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			requests: [],
		});
		expect(notices.filter((reason) => reason === "gap")).toHaveLength(1);
		completeWithSnapshot(h, "session-a", 1, 0);
		expect(delivered).toEqual([1]);
	});

	it("blocks a buffered dialog response until the authoritative snapshot commits", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "dialog-token",
		});
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		let deliveredDialogs = 0;
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "extension_ui_request") deliveredDialogs += 1;
		});
		h.controller.ingestServerMessage({
			type: "extension_ui_request",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 1,
			seq: 1,
			request: extensionRequest("dialog-one"),
		});

		expect(
			h.controller.store.getState().sendExtensionUiResponse("session-a", {
				type: "extension_ui_response",
				id: "dialog-one",
				confirmed: true,
			}),
		).toBe(false);
		expect(
			h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests.map(({ id }) => id),
		).toEqual(["dialog-one"]);
		completeWithSnapshot(h, "session-a", 1, 0);
		expect(deliveredDialogs).toBe(1);
		expect(h.controller.store.getState().sessions["session-a"]?.lastSeq).toBe(1);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "dialog-token",
		});
		expect(
			h.controller.store.getState().sendExtensionUiResponse("session-a", {
				type: "extension_ui_response",
				id: "dialog-one",
				confirmed: true,
			}),
		).toBe(true);
		expect(socket.sent).toContainEqual({
			type: "extension_ui_response",
			sessionHandle: "session-a",
			expectedGeneration: 1,
			fencingToken: "dialog-token",
			response: { type: "extension_ui_response", id: "dialog-one", confirmed: true },
		});
	});

	it("forwards extension response results only for the current generation", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		expect(h.controller.store.getState().connectionState).toBe("online");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "dialog-token",
		});
		expect(h.controller.store.getState().connectionState).toBe("online");
		socket.serverMessage(extensionFrame("session-a", 1, 1, extensionRequest("dialog-one")));
		await flushPromises();
		expect(h.controller.store.getState().connectionState).toBe("online");
		const outcomes: string[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "extension_ui_result") outcomes.push(message.outcome);
		});

		expect(
			h.controller.store.getState().sendExtensionUiResponse("session-a", {
				type: "extension_ui_response",
				id: "dialog-one",
				confirmed: true,
			}),
		).toBe(true);
		expect(
			h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests.map(({ id }) => id),
		).toEqual(["dialog-one"]);

		socket.serverMessage({
			type: "extension_ui_result",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 2,
			requestId: "dialog-one",
			outcome: "not_running",
		});
		await flushPromises();
		expect(
			h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests.map(({ id }) => id),
		).toEqual(["dialog-one"]);
		expect(outcomes).toEqual([]);

		socket.serverMessage({
			type: "extension_ui_result",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			requestId: "dialog-one",
			outcome: "accepted",
		});
		await flushPromises();
		expect(h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests).toEqual([]);
		expect(outcomes).toEqual(["accepted"]);
	});

	it("applies extension close frames in replay order", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			baselineAuthoritative: true,
			generation: 1,
			lastSeq: 0,
		});
		const delivered: string[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "extension_ui_request") delivered.push(`open:${message.request.id}`);
			if (message.type === "extension_ui_closed") delivered.push(`close:${message.requestId}`);
		});

		socket.serverMessage(extensionFrame("session-a", 1, 1, extensionRequest("dialog-one")));
		socket.serverMessage({
			type: "extension_ui_closed",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 1,
			seq: 2,
			requestId: "dialog-one",
			reason: "expired",
		});
		await flushPromises();

		expect(delivered).toEqual(["open:dialog-one", "close:dialog-one"]);
		expect(h.controller.store.getState().sessions["session-a"]?.lastSeq).toBe(2);
		expect(h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests).toEqual([]);
	});

	it("retains only blocking and semantic sticky extension state under a hard total cap", () => {
		const h = harness();
		connect(h);
		subscribeAndPrime(h, "session-a");
		let seq = 0;
		const ingest = (request: PiExtensionUiRequestDto) => {
			seq += 1;
			h.controller.ingestServerMessage(extensionFrame("session-a", 1, seq, request));
		};

		ingest({
			type: "extension_ui_request",
			id: "notice-one",
			method: "notify",
			message: "transient",
		});
		ingest({
			type: "extension_ui_request",
			id: "status-old",
			method: "setStatus",
			statusKey: "build",
			statusText: "old",
		});
		ingest({
			type: "extension_ui_request",
			id: "status-new",
			method: "setStatus",
			statusKey: "build",
			statusText: "new",
		});
		ingest({
			type: "extension_ui_request",
			id: "title-old",
			method: "setTitle",
			title: "old",
		});
		ingest({
			type: "extension_ui_request",
			id: "title-new",
			method: "setTitle",
			title: "new",
		});
		expect(
			h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests.map(({ id }) => id),
		).toEqual(["status-new", "title-new"]);

		for (let index = 0; index < EXPECTED_PENDING_EXTENSION_LIMIT + 10; index += 1) {
			ingest(extensionRequest(`dialog-${String(index)}`));
		}
		const pending = h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests ?? [];
		expect(pending).toHaveLength(EXPECTED_PENDING_EXTENSION_LIMIT);
		expect(pending.at(-1)?.id).toBe(`dialog-${String(EXPECTED_PENDING_EXTENSION_LIMIT + 9)}`);
		expect(pending.some(({ id }) => id === "notice-one")).toBe(false);
		expect(pending.some(({ id }) => id === "status-old")).toBe(false);
	});

	it("delivers a journaled notify at or below the snapshot waterline exactly once", () => {
		const h = harness();
		connect(h);
		subscribeAndPrime(h, "session-a", 1, 5);
		const delivered: number[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "extension_ui_request" && message.request.method === "notify") {
				delivered.push(message.seq);
			}
		});
		const journaledNotify = extensionFrame("session-a", 1, 4, {
			type: "extension_ui_request",
			id: "notify-during-catch-up",
			method: "notify",
			message: "shown once",
		});

		h.controller.ingestServerMessage(journaledNotify);
		h.controller.ingestServerMessage(journaledNotify);

		expect(delivered).toEqual([4]);
		expect(h.controller.store.getState().sessions["session-a"]?.lastSeq).toBe(5);
		expect(h.controller.store.getState().sessions["session-a"]?.projectedSeq).toBe(5);
	});

	it("drops stale runtime, resync, and event generations and rejects a mismatched response envelope", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const delivered: number[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "event") delivered.push(message.seq);
		});

		const response = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "state-mismatch", type: "get_state" });
		socket.serverMessage(successResponse("session-a", 2, "state-mismatch", "get_state"));
		await expect(response).rejects.toMatchObject({
			code: "response_mismatch",
		});

		socket.serverMessage({ type: "runtime_state", runtime: runtime("session-a", 2, 0) });
		socket.serverMessage({ type: "runtime_state", runtime: runtime("session-a", 1, 0) });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "generation_changed",
		});
		socket.serverMessage(eventFrame("session-a", 1, 1));
		socket.serverMessage(eventFrame("session-a", 2, 1));
		await flushPromises();
		expect(delivered).toEqual([1]);
		expect(h.controller.store.getState().sessions["session-a"]?.generation).toBe(2);
	});

	it("finishes a matching replay subscription before reclaiming controller intent", () => {
		const h = harness();
		let socket = connect(h);
		subscribeAndPrime(h, "session-a", 1, 2);
		h.controller.store.getState().claimSession("session-a");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "old-fence",
		});
		h.controller.store.getState().disconnect();
		h.controller.store.getState().connect();
		socket = h.sockets.at(-1)!;
		socket.open();
		socket.serverMessage({ type: "runtime_state", runtime: runtime("session-a", 1, 2) });
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 2,
			controlState: "free",
			transition: "disconnect",
			isController: false,
		});

		expect(socket.sent).toContainEqual({ type: "session_claim", sessionHandle: "session-a" });
	});

	it("keeps a degraded identity degraded across reconnect until manual retry", async () => {
		const clock = new ResyncClock();
		const h = harness({ resyncClock: clock, resyncRandom: () => 0.5 });
		let socket = connect(h);
		h.controller.store.getState().subscribeSession("session-a");
		const current = runtime("session-a", 1, 0);
		const requireResync = () =>
			socket.serverMessage({
				type: "resync_required",
				serverEpoch: current.serverEpoch,
				sessionHandle: current.sessionHandle,
				runtime: current,
				reason: "gap",
			});
		const failAttempt = () =>
			socket.serverMessage({
				type: "session_error",
				serverEpoch: current.serverEpoch,
				sessionHandle: current.sessionHandle,
				operation: "subscribe",
				error: "snapshot failed",
			});
		socket.serverMessage({ type: "runtime_state", runtime: current });
		requireResync();
		for (const delay of [500, 1_000, 2_000]) {
			failAttempt();
			await flushPromises();
			clock.advanceBy(delay);
			await flushPromises();
		}
		failAttempt();
		await flushPromises();
		expect(h.controller.store.getState().sessions["session-a"]?.recovery?.phase).toBe("degraded");

		h.controller.store.getState().disconnect();
		h.controller.store.getState().connect();
		socket = h.sockets.at(-1)!;
		socket.open();
		expect(socket.sent).not.toContainEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		requireResync();
		expect(h.controller.store.getState().sessions["session-a"]?.recovery).toMatchObject({
			phase: "degraded",
			attempt: 4,
		});
		expect(clock.timers.size).toBe(0);
		expect(h.controller.store.getState().manualRetryResync("session-a")).toBe(true);
		expect(socket.sent).toContainEqual({ type: "session_subscribe", sessionHandle: "session-a" });
	});

	it("uses explicit fenced restart for a degraded snapshot-overflow runtime", async () => {
		const clock = new ResyncClock();
		const h = harness({ resyncClock: clock, resyncRandom: () => 0.5 });
		const socket = connect(h);
		subscribeAndPrime(h, "session-a", 3, 8);
		const overflowed = {
			...runtime("session-a", 3, 9),
			state: "crashed" as const,
			error: "session_snapshot_overflow",
		};
		socket.serverMessage({ type: "runtime_state", runtime: overflowed });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: overflowed.serverEpoch,
			sessionHandle: overflowed.sessionHandle,
			runtime: overflowed,
			reason: "gap",
		});
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: overflowed.serverEpoch,
			sessionHandle: overflowed.sessionHandle,
			generation: overflowed.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		const failAttempt = () =>
			socket.serverMessage({
				type: "session_error",
				serverEpoch: overflowed.serverEpoch,
				sessionHandle: overflowed.sessionHandle,
				operation: "subscribe",
				error: "session_snapshot_overflow",
				code: "session_snapshot_overflow",
				retryable: true,
			});
		for (const delay of [500, 1_000, 2_000]) {
			failAttempt();
			await flushPromises();
			clock.advanceBy(delay);
			await flushPromises();
		}
		failAttempt();
		await flushPromises();
		expect(h.controller.store.getState().sessions["session-a"]?.recovery?.phase).toBe("degraded");

		expect(h.controller.store.getState().manualRetryResync("session-a")).toBe(true);
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		completeWithSnapshot(
			h,
			overflowed.sessionHandle,
			overflowed.generation,
			overflowed.lastSeq,
			[],
			overflowed,
		);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: overflowed.serverEpoch,
			sessionHandle: overflowed.sessionHandle,
			generation: overflowed.generation,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		expect(socket.sent.at(-1)).toEqual({ type: "session_claim", sessionHandle: "session-a" });
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: overflowed.serverEpoch,
			sessionHandle: overflowed.sessionHandle,
			generation: overflowed.generation,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "overflow-fence",
		});
		expect(socket.sent.at(-1)).toEqual({
			type: "session_restart",
			sessionHandle: "session-a",
			expectedGeneration: 3,
			fencingToken: "overflow-fence",
		});
	});

	it("fences a failed snapshot waiter before creating its immediate replacement", async () => {
		const h = harness();
		connect(h);
		subscribeAndPrime(h, "session-a");
		let shouldFailSuffix = true;
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "event" && message.seq === 1 && shouldFailSuffix) {
				shouldFailSuffix = false;
				throw new Error("suffix failed");
			}
		});
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));
		completeWithSnapshot(h, "session-a", 1, 0);
		await flushPromises();
		expect(h.controller.store.getState().sessions["session-a"]?.baselineAuthoritative).toBe(false);

		completeWithSnapshot(h, "session-a", 1, 0);
		await flushPromises();
		expect(h.controller.store.getState().sessions["session-a"]?.baselineAuthoritative).toBe(true);
		expect(h.controller.store.getState().sessions["session-a"]?.recovery).toBeNull();
	});

	it.each(["accepted", "no_dialog"] as const)(
		"filters an acknowledged %s dialog from snapshot and buffered suffix while advancing seq",
		(outcome) => {
			const h = harness();
			connect(h);
			subscribeAndPrime(h, "session-a");
			const delivered: string[] = [];
			h.controller.frameBus.subscribe("session-a", ({ message }) => {
				if (message.type === "extension_ui_request") delivered.push(message.request.id);
			});
			h.controller.ingestServerMessage({
				type: "resync_required",
				serverEpoch: "test-server-epoch",
				sessionHandle: "session-a",
				runtime: runtime("session-a", 1, 0),
				reason: "gap",
			});
			h.controller.ingestServerMessage(extensionFrame("session-a", 1, 1, extensionRequest("acked")));
			h.controller.ingestServerMessage({
				type: "extension_ui_result",
				serverEpoch: "test-server-epoch",
				sessionHandle: "session-a",
				generation: 1,
				requestId: "acked",
				outcome,
			});
			completeWithSnapshot(h, "session-a", 1, 0, [extensionRequest("acked")]);

			expect(delivered).toEqual([]);
			expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
				lastSeq: 1,
				projectedSeq: 1,
				pendingExtensionRequests: [],
			});
		},
	);

	it("keeps a deferred snapshot suffix non-authoritative until its exact endpoint is confirmed", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "fence",
		});
		h.controller.frameBus.subscribe("session-a", ({ message }) =>
			message.type === "event" && message.seq === 1 ? SESSION_FRAME_DEFERRED : undefined,
		);
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));
		completeWithSnapshot(h, "session-a", 1, 0);

		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			baselineAuthoritative: false,
			lastSeq: 1,
			projectedSeq: 0,
		});
		await expect(
			h.controller.store.getState().sendCommand("session-a", { type: "prompt", message: "blocked" }),
		).rejects.toMatchObject({ code: "session_not_ready" });
		expect(h.controller.confirmProjectionDelivery("session-a", 1)).toBe(true);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			baselineAuthoritative: true,
			projectedSeq: 1,
			resync: null,
		});
	});

	it("stages the exact snapshot suffix endpoint before a structural listener flushes deferred work", () => {
		const h = harness();
		connect(h);
		subscribeAndPrime(h, "session-a");
		const confirmations: boolean[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type !== "event") return;
			if (message.seq === 1) return SESSION_FRAME_DEFERRED;
			if (message.seq === 2) {
				confirmations.push(h.controller.confirmProjectionDelivery("session-a", 1));
			}
		});
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 2));
		completeWithSnapshot(h, "session-a", 1, 0);

		expect(confirmations).toEqual([true]);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			baselineAuthoritative: true,
			lastSeq: 2,
			projectedSeq: 2,
			resync: null,
		});
	});

	it("rejects mutations using an old same-identity lease until the catch-up lease baseline commits", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "old-fence",
		});
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		completeWithSnapshot(h, "session-a", 1, 0);

		await expect(
			h.controller.store.getState().sendCommand("session-a", { type: "prompt", message: "stale" }, 0),
		).rejects.toMatchObject({ code: "session_not_ready" });
		expect(
			h.controller.store.getState().sendExtensionUiResponse("session-a", {
				type: "extension_ui_response",
				id: "dialog-a",
				confirmed: true,
			}),
		).toBe(false);

		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 2,
			controlState: "held",
			transition: "takeover",
			isController: true,
			fencingToken: "fresh-fence",
		});
		expect(
			h.controller.store.getState().sendExtensionUiResponse("session-a", {
				type: "extension_ui_response",
				id: "dialog-a",
				confirmed: true,
			}),
		).toBe(true);
	});

	it("clears lease and raw debug state atomically when the full runtime identity changes", async () => {
		const h = harness({ rawEventLimit: 10 });
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "old-fence",
		});
		socket.serverMessage(eventFrame("session-a", 1, 1));
		await flushPromises();
		expect(h.controller.store.getState().sessions["session-a"]?.rawEvents).toHaveLength(1);
		const next = runtime("session-a", 2, 0);
		h.controller.ingestServerMessage({ type: "runtime_state", runtime: next });

		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lease: { isController: false },
			baselineAuthoritative: false,
			rawEvents: [],
		});
	});

	it("rejects a snapshot whose contiguous endpoint remains below the current response barrier", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		const pending = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "barrier-ahead", type: "get_state" });
		socket.serverMessage(successResponse("session-a", 1, "barrier-ahead", "get_state", 2));
		await flushPromises();
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));
		completeWithSnapshot(h, "session-a", 1, 0);
		await flushPromises();

		expect(h.controller.store.getState().sessions["session-a"]?.baselineAuthoritative).toBe(false);
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await flushPromises();
		expect(settled).toBe(false);
	});
});

describe("session transport commands and identity", () => {
	it("rejects an oversized command before WebSocket.send without dropping the connection", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "session-token",
		});
		const sentBeforeCommand = socket.sent.length;

		await expect(
			h.controller.store.getState().sendCommand(
				"session-a",
				{
					id: "oversized-prompt",
					type: "prompt",
					message: "x".repeat(SESSION_WS_CLIENT_MAX_BYTES),
				},
				0,
			),
		).rejects.toMatchObject({ code: "payload_too_large" });
		expect(socket.sent).toHaveLength(sentBeforeCommand);
		expect(socket.readyState).toBe(1);
		expect(h.controller.store.getState().connectionState).toBe("online");
	});

	it("migrates an unresolved subscription alias before accepting the resolved child baseline", async () => {
		const notices: Array<{ sessionHandle: string; reason: string }> = [];
		const h = harness({
			onResyncRequired: (message) =>
				notices.push({ sessionHandle: message.sessionHandle, reason: message.reason }),
		});
		const socket = connect(h);
		h.controller.store.getState().subscribeSession("session-requested");
		const busFrames: string[] = [];
		h.controller.frameBus.subscribe("session-requested", ({ sessionHandle, message }) => {
			busFrames.push(`${sessionHandle}:${message.type}`);
		});

		expect(h.controller.store.getState().sessions["session-requested"]).toMatchObject({
			subscribed: true,
			runtime: null,
			generation: null,
		});
		socket.serverMessage({
			type: "session_rekeyed",
			serverEpoch: "test-server-epoch",
			previousSessionHandle: "session-requested",
			runtime: runtime("session-resolved", 7, 4),
		});
		socket.serverMessage({
			type: "runtime_state",
			runtime: runtime("session-resolved", 7, 4),
		});
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-resolved",
			runtime: runtime("session-resolved", 7, 4),
			reason: "initial",
		});
		socket.serverMessage({
			type: "extension_ui_snapshot",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-resolved",
			generation: 7,
			requests: [extensionRequest("resolved-dialog")],
		});
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-resolved",
			generation: 7,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});

		const snapshot = h.controller.store
			.getState()
			.sendCommand("session-resolved", { id: "resolved-messages", type: "get_messages" });
		expect(sentCommand(socket, "resolved-messages")).toMatchObject({
			sessionHandle: "session-resolved",
			expectedGeneration: 7,
		});
		socket.serverMessage(successResponse("session-resolved", 7, "resolved-messages", "get_messages", 4));
		completeWithSnapshot(h, "session-resolved", 7, 4, [extensionRequest("resolved-dialog")]);
		await expect(snapshot).resolves.toMatchObject({ id: "resolved-messages", success: true });

		const state = h.controller.store.getState();
		expect(state.sessions["session-requested"]).toMatchObject({
			subscribed: false,
			runtime: null,
			generation: null,
			lease: { isController: false },
		});
		expect(state.sessions["session-resolved"]).toMatchObject({
			subscribed: true,
			generation: 7,
			lastSeq: 4,
			lease: { isController: false },
			resync: null,
		});
		expect(state.sessions["session-resolved"]?.pendingExtensionRequests.map(({ id }) => id)).toEqual([
			"resolved-dialog",
		]);
		expect(busFrames).toEqual([
			"session-resolved:session_rekeyed",
			"session-resolved:runtime_state",
			"session-resolved:resync_required",
			"session-resolved:session_snapshot",
			"session-resolved:lease_status",
			"session-resolved:extension_ui_snapshot",
		]);
		expect(notices).toEqual([{ sessionHandle: "session-resolved", reason: "initial" }]);
	});

	it("rekeys only the transition response while preserving concurrent parent command correlation", async () => {
		const notices: Array<{ sessionHandle: string; reason: string }> = [];
		const h = harness({
			onResyncRequired: (message) =>
				notices.push({ sessionHandle: message.sessionHandle, reason: message.reason }),
		});
		const socket = connect(h);
		subscribeAndPrime(h, "session-parent");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-parent",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "parent-token",
		});
		const busFrames: string[] = [];
		h.controller.frameBus.subscribe("session-parent", ({ sessionHandle, message }) => {
			busFrames.push(`${sessionHandle}:${message.type}`);
		});

		const command = h.controller.store.getState().sendCommand("session-parent", {
			id: "fork-one",
			type: "fork",
			entryId: "entry-1",
		});
		const parentRead = h.controller.store
			.getState()
			.sendCommand("session-parent", { id: "parent-read", type: "get_state" });
		socket.serverMessage({
			type: "session_rekeyed",
			serverEpoch: "test-server-epoch",
			previousSessionHandle: "session-parent",
			runtime: runtime("session-child", 2, 0),
		});
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toEqual([
			{ type: "session_subscribe", sessionHandle: "session-parent" },
			{ type: "session_subscribe", sessionHandle: "session-child" },
		]);
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-child",
			runtime: runtime("session-child", 2, 0),
			reason: "generation_changed",
		});
		socket.serverMessage(successResponse("session-parent", 1, "parent-read", "get_state"));
		socket.serverMessage({
			...successResponse("session-child", 2, "fork-one", "fork"),
			previousSessionHandle: "session-parent",
		});
		await expect(parentRead).resolves.toMatchObject({ id: "parent-read", success: true });
		let transitionSettled = false;
		command.then(() => {
			transitionSettled = true;
		});
		await Promise.resolve();
		expect(transitionSettled).toBe(false);
		completeWithSnapshot(h, "session-child", 2);
		await expect(command).resolves.toMatchObject({ id: "fork-one", success: true });

		const state = h.controller.store.getState();
		expect(state.sessions["session-parent"]).toMatchObject({
			subscribed: false,
			generation: 1,
			lease: { isController: false },
			resync: null,
		});
		expect(state.sessions["session-child"]).toMatchObject({
			subscribed: true,
			generation: 2,
			lease: { isController: false },
			resync: null,
			rawEvents: [],
		});
		expect(busFrames).toContain("session-child:session_rekeyed");
		expect(notices).toContainEqual({
			sessionHandle: "session-child",
			reason: "generation_changed",
		});
	});

	it("rejects a transition response whose command type does not match the pending command", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-parent");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-parent",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "parent-token",
		});
		const command = h.controller.store.getState().sendCommand("session-parent", {
			id: "fork-one",
			type: "fork",
			entryId: "entry-1",
		});
		socket.serverMessage({
			type: "session_rekeyed",
			serverEpoch: "test-server-epoch",
			previousSessionHandle: "session-parent",
			runtime: runtime("session-child", 2, 0),
		});
		socket.serverMessage({
			...successResponse("session-child", 2, "fork-one", "clone"),
			previousSessionHandle: "session-parent",
		});

		await expect(command).rejects.toMatchObject({ code: "response_mismatch" });
	});

	it("forces a generation-changed child resync when rekey interrupts a parent resync", () => {
		const notices: Array<{ sessionHandle: string; reason: string }> = [];
		const h = harness({
			onResyncRequired: (message) =>
				notices.push({ sessionHandle: message.sessionHandle, reason: message.reason }),
		});
		const socket = connect(h);
		subscribeAndPrime(h, "session-parent");
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-parent",
			runtime: runtime("session-parent", 1, 0),
			reason: "gap",
		});
		h.controller.ingestServerMessage(eventFrame("session-parent", 1, 1));
		const delivered: string[] = [];
		h.controller.frameBus.subscribe("session-parent", ({ sessionHandle, message }) => {
			delivered.push(`${sessionHandle}:${message.type}`);
		});

		socket.serverMessage({
			type: "session_rekeyed",
			serverEpoch: "test-server-epoch",
			previousSessionHandle: "session-parent",
			runtime: runtime("session-child", 2, 0),
		});
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-child",
			runtime: runtime("session-child", 2, 0),
			reason: "generation_changed",
		});

		expect(h.controller.store.getState().sessions["session-parent"]).toMatchObject({
			subscribed: false,
			resync: {
				reason: "gap",
				generation: 1,
				barrierSeq: 0,
				bufferedFrameCount: 0,
			},
		});
		expect(h.controller.store.getState().sessions["session-child"]).toMatchObject({
			subscribed: true,
			generation: 2,
			lastSeq: 0,
			pendingExtensionRequests: [],
			resync: {
				reason: "generation_changed",
				generation: 2,
				barrierSeq: 0,
				bufferedFrameCount: 0,
			},
		});
		expect(delivered).toEqual(["session-child:session_rekeyed", "session-child:resync_required"]);
		expect(notices.at(-1)).toEqual({
			sessionHandle: "session-child",
			reason: "generation_changed",
		});
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toEqual([
			{ type: "session_subscribe", sessionHandle: "session-parent" },
		]);
	});

	it("fails the local lease closed immediately after release is sent", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "session-token",
		});
		socket.serverMessage(extensionFrame("session-a", 1, 1, extensionRequest("dialog-one")));
		const leaseFrames: boolean[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "lease_status") leaseFrames.push(message.isController);
		});

		expect(h.controller.store.getState().releaseSession("session-a")).toBe(true);
		expect(h.controller.store.getState().sessions["session-a"]?.lease).toEqual({
			isController: false,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
		});
		expect(leaseFrames).toEqual([]);
		expect(
			h.controller.store.getState().sendExtensionUiResponse("session-a", {
				type: "extension_ui_response",
				id: "dialog-one",
				confirmed: true,
			}),
		).toBe(false);
		await expect(
			h.controller.store.getState().sendCommand("session-a", {
				id: "prompt-after-release",
				type: "prompt",
				message: "must fail closed",
			}),
		).rejects.toMatchObject({ code: "session_read_only" });
		expect(
			h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests.map(({ id }) => id),
		).toEqual(["dialog-one"]);
		expect(socket.sent).toContainEqual({ type: "session_release", sessionHandle: "session-a" });
	});

	it("defers takeover until the authoritative baseline, then sends one revision-fenced request", () => {
		const h = harness();
		const socket = connect(h);
		const sessionHandle = "session-takeover";
		h.controller.store.getState().subscribeSession(sessionHandle);
		const initial = runtime(sessionHandle, 3, 0);
		h.controller.ingestServerMessage({ type: "runtime_state", runtime: initial });
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: initial.serverEpoch,
			sessionHandle,
			runtime: initial,
			reason: "initial",
		});
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: initial.serverEpoch,
			sessionHandle,
			generation: initial.generation,
			leaseRevision: 7,
			controlState: "held",
			transition: "claim",
			isController: false,
		});
		expect(h.controller.store.getState().takeoverSession(sessionHandle)).toBe(false);

		completeWithSnapshot(h, sessionHandle, initial.generation, initial.lastSeq);
		expect(h.controller.store.getState().sessions[sessionHandle]).toMatchObject({
			baselineAuthoritative: true,
			lease: {
				isController: false,
				leaseRevision: 7,
				controlState: "held",
				transition: "claim",
			},
		});
		expect(h.controller.store.getState().takeoverSession(sessionHandle)).toBe(true);
		expect(h.controller.store.getState().takeoverSession(sessionHandle)).toBe(false);
		expect(socket.sent.at(-1)).toEqual({
			type: "session_takeover",
			sessionHandle,
			expectedGeneration: 3,
			expectedLeaseRevision: 7,
		});

		socket.serverMessage({
			type: "session_error",
			serverEpoch: initial.serverEpoch,
			sessionHandle,
			operation: "takeover",
			error: "session_lease_revision_stale",
			code: "session_lease_revision_stale",
			retryable: true,
		});
		expect(h.controller.store.getState().takeoverSession(sessionHandle)).toBe(false);
		expect(socket.sent.filter((message) => message.type === "session_takeover")).toHaveLength(1);

		socket.serverMessage({
			type: "lease_status",
			serverEpoch: initial.serverEpoch,
			sessionHandle,
			generation: initial.generation,
			leaseRevision: 8,
			controlState: "held",
			transition: "takeover",
			isController: false,
		});
		expect(h.controller.store.getState().takeoverSession(sessionHandle)).toBe(true);
		expect(socket.sent.at(-1)).toEqual({
			type: "session_takeover",
			sessionHandle,
			expectedGeneration: 3,
			expectedLeaseRevision: 8,
		});
	});

	it("keeps a newer lease baseline after a delayed loser takeover error", () => {
		const h = harness();
		const socket = connect(h);
		const sessionHandle = "session-takeover-late-error";
		subscribeAndPrime(h, sessionHandle);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle,
			generation: 1,
			leaseRevision: 7,
			controlState: "held",
			transition: "claim",
			isController: false,
		});
		expect(h.controller.store.getState().takeoverSession(sessionHandle)).toBe(true);

		// The Gateway serializes a winning transition before this loser's stale CAS
		// error arrives. The r+1 recipient-local status is the fresh authority.
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle,
			generation: 1,
			leaseRevision: 8,
			controlState: "held",
			transition: "takeover",
			isController: false,
		});
		socket.serverMessage({
			type: "session_error",
			serverEpoch: "test-server-epoch",
			sessionHandle,
			operation: "takeover",
			error: "session_lease_revision_stale",
			code: "session_lease_revision_stale",
			retryable: true,
		});

		expect(h.controller.store.getState().sessions[sessionHandle]).toMatchObject({
			freshLeaseBaseline: runtime(sessionHandle, 1, 0),
			lease: {
				leaseRevision: 8,
				controlState: "held",
				transition: "takeover",
				isController: false,
			},
		});
		expect(h.controller.store.getState().takeoverSession(sessionHandle)).toBe(true);
		expect(socket.sent.at(-1)).toEqual({
			type: "session_takeover",
			sessionHandle,
			expectedGeneration: 1,
			expectedLeaseRevision: 8,
		});
	});

	it.each([
		{ transition: "claim" as const, leaseRevision: 1, fencingToken: "bridge-claim-fence" },
		{ transition: "takeover" as const, leaseRevision: 2, fencingToken: "bridge-takeover-fence" },
	])(
		"accepts same-revision Bridge %s rebaselines for controller and observer recipients",
		({ transition, leaseRevision, fencingToken }) => {
			const sessionHandle = `session-bridge-${transition}-baseline`;
			const controllerHarness = harness();
			const observerHarness = harness();
			const controllerSocket = connect(controllerHarness);
			const observerSocket = connect(observerHarness);
			subscribeAndPrime(controllerHarness, sessionHandle);
			subscribeAndPrime(observerHarness, sessionHandle);

			for (const { current, socket, isController } of [
				{ current: controllerHarness, socket: controllerSocket, isController: true },
				{ current: observerHarness, socket: observerSocket, isController: false },
			]) {
				socket.serverMessage({
					type: "lease_status",
					serverEpoch: "test-server-epoch",
					sessionHandle,
					generation: 1,
					leaseRevision,
					controlState: "held",
					transition,
					isController,
					...(isController ? { fencingToken } : {}),
				});
				expect(
					current.controller.reportProjectionFailure(sessionHandle, 1, new Error("controlled resync")),
				).toBe(true);
				expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle });
				completeWithSnapshot(current, sessionHandle, 1, 0);
				socket.serverMessage({
					type: "lease_status",
					serverEpoch: "test-server-epoch",
					sessionHandle,
					generation: 1,
					leaseRevision,
					controlState: "held",
					transition: "baseline",
					isController,
					...(isController ? { fencingToken } : {}),
				});
				const channel = current.controller.store.getState().sessions[sessionHandle];
				expect(channel).toMatchObject({
					baselineAuthoritative: true,
					freshLeaseBaseline: runtime(sessionHandle, 1, 0),
					lease: {
						leaseRevision,
						controlState: "held",
						transition,
						isController,
					},
				});
				if (isController) expect(channel?.lease.fencingToken).toBe(fencingToken);
				else expect(Object.hasOwn(channel?.lease ?? {}, "fencingToken")).toBe(false);
			}
		},
	);

	it("fails closed on same-revision lease contradictions until a newer authoritative status arrives", async () => {
		const h = harness();
		const socket = connect(h);
		const sessionHandle = "session-lease-conflict";
		subscribeAndPrime(h, sessionHandle);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle,
			generation: 1,
			leaseRevision: 4,
			controlState: "held",
			transition: "claim",
			isController: false,
		});
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle,
			generation: 1,
			leaseRevision: 4,
			controlState: "held",
			transition: "takeover",
			isController: false,
		});

		expect(h.controller.store.getState().sessions[sessionHandle]).toMatchObject({
			freshLeaseBaseline: null,
			lease: {
				isController: false,
				leaseRevision: 4,
				controlState: "held",
				transition: "takeover",
				conflicted: true,
			},
		});
		expect(h.controller.store.getState().takeoverSession(sessionHandle)).toBe(false);
		await expect(
			h.controller.store.getState().sendCommand(sessionHandle, {
				id: "conflicted-observer-mutation",
				type: "prompt",
				message: "must stay fenced",
			}),
		).rejects.toMatchObject({ code: "session_read_only" });

		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle,
			generation: 1,
			leaseRevision: 5,
			controlState: "held",
			transition: "takeover",
			isController: false,
		});
		expect(h.controller.store.getState().sessions[sessionHandle]).toMatchObject({
			lease: {
				isController: false,
				leaseRevision: 5,
				controlState: "held",
				transition: "takeover",
			},
		});
		expect(h.controller.store.getState().sessions[sessionHandle]?.lease.conflicted).toBeUndefined();
		expect(h.controller.store.getState().takeoverSession(sessionHandle)).toBe(true);
	});

	it("retains a waiting Extension request while observer controls are fenced", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "owner-token",
		});
		socket.serverMessage(extensionFrame("session-a", 1, 1, extensionRequest("waiting-observer-dialog")));
		await flushPromises();
		expect(h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests).toMatchObject([
			{ id: "waiting-observer-dialog" },
		]);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 2,
			controlState: "free",
			transition: "release",
			isController: false,
		});
		await flushPromises();

		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lease: { isController: false },
			pendingExtensionRequests: [{ id: "waiting-observer-dialog" }],
		});
		expect(
			h.controller.store.getState().sendExtensionUiResponse("session-a", {
				type: "extension_ui_response",
				id: "waiting-observer-dialog",
				confirmed: true,
			}),
		).toBe(false);
		await expect(
			h.controller.store.getState().sendCommand("session-a", {
				id: "observer-prompt",
				type: "prompt",
				message: "must remain read-only",
			}),
		).rejects.toMatchObject({ code: "session_read_only" });
	});

	it("rejects a late controller acknowledgement after the release intent changed", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		expect(h.controller.store.getState().claimSession("session-a")).toBe(true);
		expect(h.controller.store.getState().releaseSession("session-a")).toBe(true);

		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "late-token",
		});

		expect(h.controller.store.getState().sessions["session-a"]?.lease).toEqual({
			isController: false,
		});
		expect(socket.sent.filter(({ type }) => type === "session_release")).toEqual([
			{ type: "session_release", sessionHandle: "session-a" },
			{ type: "session_release", sessionHandle: "session-a" },
		]);
	});

	it("adds fencing only to mutations and never shares a lease across Sessions", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		subscribeAndPrime(h, "session-b");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "token-a",
		});

		await expect(
			h.controller.store.getState().sendCommand("session-b", {
				id: "prompt-b",
				type: "prompt",
				message: "background mutation",
			}),
		).rejects.toMatchObject({ code: "session_read_only" });

		const read = h.controller.store.getState().sendCommand("session-b", { id: "read-b", type: "get_state" });
		const mutation = h.controller.store.getState().sendCommand("session-a", {
			id: "prompt-a",
			type: "prompt",
			message: "foreground mutation",
		});
		expect(sentCommand(socket, "read-b")?.fencingToken).toBeUndefined();
		expect(sentCommand(socket, "read-b")?.expectedGeneration).toBe(1);
		expect(sentCommand(socket, "prompt-a")?.fencingToken).toBe("token-a");
		expect(sentCommand(socket, "prompt-a")?.expectedGeneration).toBe(1);

		socket.serverMessage(successResponse("session-b", 1, "read-b", "get_state"));
		socket.serverMessage(successResponse("session-a", 1, "prompt-a", "prompt"));
		await Promise.all([read, mutation]);
		expect(h.controller.store.getState().sessions["session-b"]?.lease).toEqual({
			isController: false,
		});
	});

	it("restores only explicit per-Session controller intents after reconnect subscription", () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 5 });
		const first = connect(h);
		subscribeAndPrime(h, "session-a");
		subscribeAndPrime(h, "session-b");
		subscribeAndPrime(h, "session-observer");
		expect(h.controller.store.getState().claimSession("session-a")).toBe(true);
		expect(h.controller.store.getState().claimSession("session-b")).toBe(true);
		first.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "token-a",
		});
		first.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-b",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "token-b",
		});

		first.serverClose();
		vi.advanceTimersByTime(5);
		const second = h.sockets[1];
		if (!second) throw new Error("transport did not reconnect");
		second.open();
		expect(second.sent.filter(({ type }) => type === "session_claim")).toEqual([]);

		// lease_status is the subscription baseline acknowledgement. Controller
		// intent is restored only after that point, never for an observer.
		for (const sessionHandle of ["session-b", "session-observer", "session-a"]) {
			second.serverMessage({
				type: "lease_status",
				serverEpoch: "test-server-epoch",
				sessionHandle,
				generation: 1,
				leaseRevision: sessionHandle === "session-observer" ? 0 : 2,
				controlState: "free",
				transition: sessionHandle === "session-observer" ? "baseline" : "disconnect",
				isController: false,
			});
		}
		expect(second.sent.filter(({ type }) => type === "session_claim")).toEqual([
			{ type: "session_claim", sessionHandle: "session-b" },
			{ type: "session_claim", sessionHandle: "session-a" },
		]);

		// A denied claim acknowledgement must not create an immediate retry loop.
		second.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 3,
			controlState: "held",
			transition: "claim",
			isController: false,
		});
		expect(second.sent.filter(({ type }) => type === "session_claim")).toHaveLength(2);
	});

	it("defers an online selection claim until its subscription baseline lease arrives", () => {
		const h = harness();
		const socket = connect(h);
		h.controller.store.getState().subscribeSession("session-a");
		expect(h.controller.store.getState().claimSession("session-a")).toBe(true);
		expect(socket.sent.filter(({ type }) => type !== "client_hello")).toEqual([
			{ type: "session_subscribe", sessionHandle: "session-a" },
		]);

		const initial = runtime("session-a", 1, 0);
		socket.serverMessage({ type: "runtime_state", runtime: initial });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: initial,
			reason: "initial",
		});
		socket.serverMessage({
			type: "extension_ui_snapshot",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			requests: [],
		});
		completeWithSnapshot(h, "session-a", 1, 0);
		expect(socket.sent.filter(({ type }) => type === "session_claim")).toEqual([]);
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		expect(socket.sent.filter(({ type }) => type === "session_claim")).toEqual([
			{ type: "session_claim", sessionHandle: "session-a" },
		]);
	});

	it("records controller intent while connecting and claims only after the subscription baseline", () => {
		const h = harness();
		h.controller.store.getState().connect();
		const socket = h.sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		h.controller.store.getState().subscribeSession("session-a");
		h.controller.store.getState().subscribeSession("session-observer");
		expect(h.controller.store.getState().claimSession("session-a")).toBe(true);
		expect(h.controller.store.getState().sessions["session-a"]?.controllerIntent).toBe(true);

		socket.open();
		expect(socket.sent.filter(({ type }) => type === "session_claim")).toEqual([]);
		for (const sessionHandle of ["session-observer", "session-a"]) {
			const runtimeValue = runtime(sessionHandle, 1, 0);
			h.controller.ingestServerMessage({ type: "runtime_state", runtime: runtimeValue });
			h.controller.ingestServerMessage({
				type: "resync_required",
				serverEpoch: "test-server-epoch",
				sessionHandle,
				runtime: runtimeValue,
				reason: "initial",
			});
			completeWithSnapshot(h, sessionHandle, 1, 0);
		}
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-observer",
			generation: 1,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		expect(socket.sent.filter(({ type }) => type === "session_claim")).toEqual([
			{ type: "session_claim", sessionHandle: "session-a" },
		]);
	});

	it("rejects every pending command and clears timers when the socket disconnects", async () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 1_000 });
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const pending = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "pending-read", type: "get_state" }, 60_000);

		socket.serverClose();
		await expect(pending).rejects.toMatchObject({
			code: "disconnected",
		});
		expect(h.controller.store.getState().sessions["session-a"]?.lease).toEqual({
			isController: false,
		});
		h.controller.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("canonical Session content transport", () => {
	it("serializes projected live materialization behind a chunked snapshot", async () => {
		let releaseSnapshot!: () => void;
		const snapshotGate = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		let liveMaterializationStarted = false;
		const adapter = projectedAdapter(async (request: ExtensionUiRequestDto) => {
			if (request.id === "projected-chunked-snapshot") await snapshotGate;
			if (request.id === "projected-chunked-live") liveMaterializationStarted = true;
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: `resolved:${request.id}` };
		});
		const h = harness({ contentAdapter: adapter });
		connect(h);
		const sessionHandle = "projected-chunked-session";
		const state = h.controller.store.getState();
		state.subscribeSession(sessionHandle);
		const runtimeValue = runtime(sessionHandle, 1, 0);
		h.controller.ingestServerMessage({ type: "runtime_state", runtime: runtimeValue });
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: runtimeValue.serverEpoch,
			sessionHandle,
			runtime: runtimeValue,
			reason: "initial",
		});

		const [begin, chunk, end] = projectedChunkedSnapshotFrames(sessionHandle, "projected-chunked-snapshot");
		const delivered: string[] = [];
		h.controller.frameBus.subscribe(sessionHandle, ({ message: frame }) => {
			if (frame.type === "session_snapshot") delivered.push("snapshot");
			if (frame.type === "extension_ui_request") delivered.push(frame.request.id);
		});

		expect(ingest(h.controller, begin)).toBe(true);
		expect(ingest(h.controller, chunk)).toBe(true);
		expect(ingest(h.controller, end)).toBe(true);
		expect(ingest(h.controller, projectedSetEditorFrame(sessionHandle, 1, 1, "projected-chunked-live"))).toBe(
			true,
		);
		await flushPromises();

		expect(liveMaterializationStarted).toBe(false);
		expect(delivered).toEqual([]);
		releaseSnapshot();
		await vi.waitFor(() => expect(delivered).toEqual(["snapshot", "projected-chunked-live"]));
	});

	it("replaces a pending projected snapshot before starting a chunked snapshot", async () => {
		let releasePrevious!: () => void;
		let previousSignal: AbortSignal | undefined;
		const previousGate = new Promise<void>((resolve) => {
			releasePrevious = resolve;
		});
		const adapter = projectedAdapter(async (request, signal) => {
			if (request.id === "projected-ordinary-snapshot") {
				previousSignal = signal;
				await previousGate;
			}
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: `resolved:${request.id}` };
		});
		const h = harness({ contentAdapter: adapter });
		connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "initial",
		});
		expect(ingest(h.controller, projectedSnapshot("session-a", 1, "projected-ordinary-snapshot"))).toBe(true);
		await vi.waitFor(() => expect(previousSignal).toBeDefined());

		const [begin, chunk, end] = projectedChunkedSnapshotFrames("session-a", "projected-replacement");
		expect(ingest(h.controller, begin)).toBe(true);
		expect(ingest(h.controller, chunk)).toBe(true);
		expect(ingest(h.controller, end)).toBe(true);
		await vi.waitFor(() =>
			expect(h.controller.store.getState().sessions["session-a"]?.baselineAuthoritative).toBe(true),
		);

		expect(previousSignal?.aborted).toBe(true);
		expect(h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests).toEqual([
			expect.objectContaining({ id: "projected-replacement" }),
		]);
		releasePrevious();
		await flushPromises();
	});

	it("serializes projected Extension materialization per Session without blocking another Session", async () => {
		let releaseSlow!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const adapter = projectedAdapter(async (request: ExtensionUiRequestDto) => {
			if (request.id === "slow-a") await slowGate;
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: `resolved:${request.id}` };
		});
		const h = harness({ contentAdapter: adapter });
		connect(h);
		subscribeAndPrime(h, "session-a");
		subscribeAndPrime(h, "session-b");
		const delivered: string[] = [];
		h.controller.frameBus.subscribeAll(({ message, representation }) => {
			if (message.type === "extension_ui_request") {
				delivered.push(`${message.sessionHandle}:${message.request.id}:${representation}`);
			} else if (message.type === "event") {
				delivered.push(`${message.sessionHandle}:${String(message.seq)}:${representation}`);
			}
		});

		expect(ingest(h.controller, projectedSetEditorFrame("session-a", 1, 1, "slow-a"))).toBe(true);
		expect(ingest(h.controller, projectedEventFrame("session-a", 1, 2))).toBe(true);
		expect(ingest(h.controller, projectedEventFrame("session-b", 1, 1))).toBe(true);
		await flushPromises();

		expect(delivered).toEqual(["session-b:1:projected"]);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lastSeq: 0,
			projectedSeq: 0,
			pendingExtensionRequests: [],
		});
		expect(h.controller.store.getState().sessions["session-b"]?.lastSeq).toBe(1);

		releaseSlow();
		await vi.waitFor(() => expect(delivered).toHaveLength(3));

		expect(delivered).toEqual([
			"session-b:1:projected",
			"session-a:slow-a:projected",
			"session-a:2:projected",
		]);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lastSeq: 2,
			projectedSeq: 2,
			pendingExtensionRequests: [expect.objectContaining({ id: "slow-a", text: "resolved:slow-a" })],
		});
	});

	it("fails projected materialization with zero semantic progress and one cursorless resync", async () => {
		const notices: string[] = [];
		const adapter = projectedAdapter(async () => {
			throw new Error("content unavailable");
		});
		const h = harness({
			contentAdapter: adapter,
			onResyncRequired: (message) => notices.push(message.reason),
		});
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const before = socket.sent.filter(({ type }) => type === "session_subscribe").length;
		const delivered: string[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "extension_ui_request") delivered.push(message.request.id);
		});

		ingest(h.controller, projectedSetEditorFrame("session-a", 1, 1, "failure-one"));
		await flushPromises();
		await flushPromises();

		expect(delivered).toEqual([]);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lastSeq: 0,
			projectedSeq: 0,
			pendingExtensionRequests: [],
			resync: { requiresFreshBaseline: true, barrierSeq: 0 },
		});
		expect(socket.sent.filter(({ type }) => type === "session_subscribe").slice(before)).toEqual([
			{ type: "session_subscribe", sessionHandle: "session-a" },
		]);

		ingest(h.controller, projectedSetEditorFrame("session-a", 1, 1, "failure-two"));
		await flushPromises();
		await flushPromises();

		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toHaveLength(before + 1);
		expect(notices.filter((reason) => reason === "gap")).toHaveLength(1);
	});

	it("retries a failed projected snapshot waiter cursorlessly before committing the replacement", async () => {
		const clock = new ResyncClock();
		let attempts = 0;
		const adapter = projectedAdapter(async (request) => {
			attempts += 1;
			if (attempts === 1) throw new Error("first snapshot content failed");
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: "recovered snapshot text" };
		});
		const h = harness({
			contentAdapter: adapter,
			resyncClock: clock,
			resyncRandom: () => 0.5,
		});
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const before = socket.sent.filter(({ type }) => type === "session_subscribe").length;
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});

		expect(ingest(h.controller, projectedSnapshot("session-a", 1, "snapshot-one"))).toBe(true);
		await vi.waitFor(() =>
			expect(h.controller.store.getState().sessions["session-a"]?.recovery?.phase).toBe("retry_wait"),
		);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			baselineAuthoritative: false,
			lastSeq: 0,
			projectedSeq: 0,
			pendingExtensionRequests: [],
			resync: { requiresFreshBaseline: true },
		});

		clock.advanceBy(500);
		await flushPromises();
		expect(socket.sent.filter(({ type }) => type === "session_subscribe").slice(before)).toEqual([
			{ type: "session_subscribe", sessionHandle: "session-a" },
		]);

		expect(ingest(h.controller, projectedSnapshot("session-a", 1, "snapshot-two"))).toBe(true);
		await vi.waitFor(() =>
			expect(h.controller.store.getState().sessions["session-a"]?.baselineAuthoritative).toBe(true),
		);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			resync: null,
			pendingExtensionRequests: [
				expect.objectContaining({ id: "snapshot-two", text: "recovered snapshot text" }),
			],
		});
	});

	it("aborts a pending projected tail that exceeds the replay wire-byte budget", async () => {
		let materializerSignal: AbortSignal | undefined;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const notices: string[] = [];
		const adapter = projectedAdapter(async (request, signal) => {
			materializerSignal = signal;
			await gate;
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: "late text" };
		});
		const h = harness({
			contentAdapter: adapter,
			onResyncRequired: (message) => notices.push(message.reason),
		});
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const before = socket.sent.filter(({ type }) => type === "session_subscribe").length;
		const delivered: string[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "extension_ui_request" || message.type === "event") {
				delivered.push(message.type);
			}
		});

		expect(
			ingest(
				h.controller,
				projectedSetEditorFrame("session-a", 1, 1, "slow-byte-tail"),
				EXPECTED_RESYNC_BYTE_LIMIT - 1,
			),
		).toBe(true);
		await vi.waitFor(() => expect(materializerSignal).toBeDefined());
		expect(ingest(h.controller, projectedEventFrame("session-a", 1, 2), 2)).toBe(true);

		expect(materializerSignal?.aborted).toBe(true);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lastSeq: 0,
			projectedSeq: 0,
			pendingExtensionRequests: [],
			resync: { requiresFreshBaseline: true, barrierSeq: 0 },
		});
		expect(socket.sent.filter(({ type }) => type === "session_subscribe").slice(before)).toEqual([
			{ type: "session_subscribe", sessionHandle: "session-a" },
		]);
		expect(notices.filter((reason) => reason === "gap")).toHaveLength(1);
		release();
		await flushPromises();
		expect(delivered).toEqual([]);
	});

	it("aborts a pending projected tail that exceeds the replay frame-count budget", async () => {
		let materializerSignal: AbortSignal | undefined;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const adapter = projectedAdapter(async (request, signal) => {
			materializerSignal = signal;
			await gate;
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: "late text" };
		});
		const h = harness({ contentAdapter: adapter });
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const before = socket.sent.filter(({ type }) => type === "session_subscribe").length;

		expect(ingest(h.controller, projectedSetEditorFrame("session-a", 1, 1, "slow-count-tail"), 1)).toBe(true);
		await vi.waitFor(() => expect(materializerSignal).toBeDefined());
		for (let seq = 2; seq <= EXPECTED_RESYNC_FRAME_LIMIT; seq += 1) {
			expect(ingest(h.controller, projectedEventFrame("session-a", 1, seq), 1)).toBe(true);
		}
		expect(
			ingest(h.controller, projectedEventFrame("session-a", 1, EXPECTED_RESYNC_FRAME_LIMIT + 1), 1),
		).toBe(true);

		expect(materializerSignal?.aborted).toBe(true);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lastSeq: 0,
			projectedSeq: 0,
			pendingExtensionRequests: [],
			resync: { requiresFreshBaseline: true },
		});
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toHaveLength(before + 1);
		release();
		await flushPromises();
	});

	it("fails the exact snapshot waiter when a second projected snapshot occupies its tail slot", async () => {
		const clock = new ResyncClock();
		let materializerSignal: AbortSignal | undefined;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const adapter = projectedAdapter(async (request, signal) => {
			materializerSignal = signal;
			await gate;
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: "late text" };
		});
		const h = harness({
			contentAdapter: adapter,
			resyncClock: clock,
			resyncRandom: () => 0.5,
		});
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		const before = socket.sent.filter(({ type }) => type === "session_subscribe").length;

		expect(ingest(h.controller, projectedSnapshot("session-a", 1, "snapshot-slot-one"))).toBe(true);
		await vi.waitFor(() => expect(materializerSignal).toBeDefined());
		expect(ingest(h.controller, projectedSnapshot("session-a", 1, "snapshot-slot-two"))).toBe(true);

		expect(materializerSignal?.aborted).toBe(true);
		await vi.waitFor(() =>
			expect(h.controller.store.getState().sessions["session-a"]?.recovery?.phase).toBe("retry_wait"),
		);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lastSeq: 0,
			projectedSeq: 0,
			pendingExtensionRequests: [],
			resync: { requiresFreshBaseline: true },
		});
		clock.advanceBy(500);
		await flushPromises();
		expect(socket.sent.filter(({ type }) => type === "session_subscribe").slice(before)).toEqual([
			{ type: "session_subscribe", sessionHandle: "session-a" },
		]);
		release();
		await flushPromises();
	});

	it("fails a pending snapshot waiter when an ordinary projected frame overflows its tail", async () => {
		const clock = new ResyncClock();
		let materializerSignal: AbortSignal | undefined;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const adapter = projectedAdapter(async (request, signal) => {
			materializerSignal = signal;
			await gate;
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: "late snapshot text" };
		});
		const h = harness({
			contentAdapter: adapter,
			resyncClock: clock,
			resyncRandom: () => 0.5,
		});
		connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "initial",
		});
		expect(ingest(h.controller, projectedSnapshot("session-a", 1, "overflowed"))).toBe(true);
		await vi.waitFor(() => expect(materializerSignal).toBeDefined());

		expect(ingest(h.controller, projectedEventFrame("session-a", 1, 1), EXPECTED_RESYNC_BYTE_LIMIT + 1)).toBe(
			true,
		);

		expect(materializerSignal?.aborted).toBe(true);
		await vi.waitFor(() =>
			expect(h.controller.store.getState().sessions["session-a"]?.recovery?.phase).toBe("retry_wait"),
		);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			baselineAuthoritative: false,
			lastSeq: 0,
			projectedSeq: 0,
			pendingExtensionRequests: [],
			resync: { requiresFreshBaseline: true },
		});
		release();
		await flushPromises();
	});

	it("fails a queued snapshot waiter when an earlier ordinary materializer fails", async () => {
		const clock = new ResyncClock();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const adapter = projectedAdapter(async (request) => {
			if (request.id === "ordinary-fails") {
				await gate;
				throw new Error("ordinary content failed");
			}
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: "snapshot text" };
		});
		const h = harness({
			contentAdapter: adapter,
			resyncClock: clock,
			resyncRandom: () => 0.5,
		});
		connect(h);
		subscribeAndPrime(h, "session-a");
		expect(ingest(h.controller, projectedSetEditorFrame("session-a", 1, 1, "ordinary-fails"))).toBe(true);
		await flushPromises();
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "initial",
		});
		expect(ingest(h.controller, projectedSnapshot("session-a", 1, "queued"))).toBe(true);

		release();
		await vi.waitFor(() =>
			expect(h.controller.store.getState().sessions["session-a"]?.recovery?.phase).toBe("retry_wait"),
		);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			baselineAuthoritative: false,
			lastSeq: 0,
			projectedSeq: 0,
			pendingExtensionRequests: [],
			resync: { requiresFreshBaseline: true },
		});
	});

	it("retains projected provenance for a buffered snapshot suffix in delivery order", async () => {
		const adapter = projectedAdapter(async (request) => request);
		const h = harness({ contentAdapter: adapter });
		connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		const delivered: Array<{ type: string; representation: string; args?: unknown }> = [];
		h.controller.frameBus.subscribe("session-a", ({ message, representation }) => {
			delivered.push({
				type: message.type,
				representation,
				args:
					message.type === "event" && message.event.type === "tool_execution_start"
						? message.event.args
						: undefined,
			});
		});

		expect(ingest(h.controller, projectedToolEventFrame("session-a", 1, 1))).toBe(true);
		await vi.waitFor(() =>
			expect(h.controller.store.getState().sessions["session-a"]?.resync?.bufferedFrameCount).toBe(1),
		);
		const snapshot = {
			...projectedSnapshot("session-a", 1, "suffix"),
			stickyExtensionState: [],
		};
		expect(ingest(h.controller, snapshot)).toBe(true);
		await vi.waitFor(() =>
			expect(h.controller.store.getState().sessions["session-a"]?.baselineAuthoritative).toBe(true),
		);

		expect(delivered).toEqual([
			{ type: "session_snapshot", representation: "projected", args: undefined },
			{
				type: "event",
				representation: "projected",
				args: expect.objectContaining({
					type: "external_json",
					ref: expect.objectContaining({ sha256: "b".repeat(64) }),
				}),
			},
		]);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lastSeq: 1,
			projectedSeq: 1,
			resync: null,
		});
	});

	it("aborts projected work on disconnect and ignores a late materializer settlement", async () => {
		let materializerSignal: AbortSignal | undefined;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const adapter = projectedAdapter(async (request, signal) => {
			materializerSignal = signal;
			await gate;
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: "late text" };
		});
		const h = harness({ contentAdapter: adapter });
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const delivered: string[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "extension_ui_request") delivered.push(message.request.id);
		});

		ingest(h.controller, projectedSetEditorFrame("session-a", 1, 1, "disconnect-late"));
		await vi.waitFor(() => expect(materializerSignal).toBeDefined());
		socket.serverClose();
		expect(materializerSignal?.aborted).toBe(true);
		release();
		await flushPromises();
		await flushPromises();

		expect(delivered).toEqual([]);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			lastSeq: 0,
			projectedSeq: 0,
			pendingExtensionRequests: [],
			resync: null,
		});
	});

	it("cuts off a parent projected tail synchronously at rekey before child delivery", async () => {
		let parentSignal: AbortSignal | undefined;
		let releaseParent!: () => void;
		const parentGate = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});
		const adapter = projectedAdapter(async (request, signal) => {
			if (request.id === "parent-late") {
				parentSignal = signal;
				await parentGate;
			}
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: `resolved:${request.id}` };
		});
		const h = harness({ contentAdapter: adapter });
		connect(h);
		subscribeAndPrime(h, "session-parent");
		const delivered: string[] = [];
		h.controller.frameBus.subscribe("session-parent", ({ sessionHandle, message, representation }) => {
			delivered.push(`${sessionHandle}:${message.type}:${representation}`);
		});

		ingest(h.controller, projectedSetEditorFrame("session-parent", 1, 1, "parent-late"));
		await vi.waitFor(() => expect(parentSignal).toBeDefined());
		h.controller.ingestServerMessage({
			type: "session_rekeyed",
			serverEpoch: "test-server-epoch",
			previousSessionHandle: "session-parent",
			runtime: runtime("session-child", 2, 0),
		});

		expect(parentSignal?.aborted).toBe(true);
		expect(delivered).toEqual(["session-child:session_rekeyed:wire"]);
		releaseParent();
		await flushPromises();
		expect(ingest(h.controller, projectedSetEditorFrame("session-child", 2, 1, "child"))).toBe(true);
		await vi.waitFor(() => expect(delivered).toHaveLength(2));

		expect(delivered).toEqual([
			"session-child:session_rekeyed:wire",
			"session-child:extension_ui_request:projected",
		]);
		expect(h.controller.store.getState().sessions["session-parent"]?.pendingExtensionRequests).toEqual([]);
		expect(h.controller.store.getState().sessions["session-child"]).toMatchObject({
			lastSeq: 1,
			pendingExtensionRequests: [expect.objectContaining({ id: "child" })],
			resync: null,
		});
	});

	it("aborts an old-generation projected tail before installing a resync identity", async () => {
		let materializerSignal: AbortSignal | undefined;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const adapter = projectedAdapter(async (request, signal) => {
			materializerSignal = signal;
			await gate;
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: "late old-generation text" };
		});
		const h = harness({ contentAdapter: adapter });
		connect(h);
		subscribeAndPrime(h, "session-a");
		const delivered: string[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "extension_ui_request") delivered.push(message.request.id);
		});
		ingest(h.controller, projectedSetEditorFrame("session-a", 1, 1, "old-generation"));
		await vi.waitFor(() => expect(materializerSignal).toBeDefined());

		h.controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 2, 0),
			reason: "generation_changed",
		});

		expect(materializerSignal?.aborted).toBe(true);
		release();
		await flushPromises();
		expect(delivered).toEqual([]);
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			generation: 2,
			lastSeq: 0,
			projectedSeq: 0,
			pendingExtensionRequests: [],
		});
	});

	it("aborts projected work when protocol incompatibility resets the transport", async () => {
		let materializerSignal: AbortSignal | undefined;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const adapter = projectedAdapter(async (request, signal) => {
			materializerSignal = signal;
			await gate;
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: "late incompatible text" };
		});
		const h = harness({ contentAdapter: adapter });
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const delivered: string[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "extension_ui_request") delivered.push(message.request.id);
		});
		ingest(h.controller, projectedSetEditorFrame("session-a", 1, 1, "incompatible"));
		await vi.waitFor(() => expect(materializerSignal).toBeDefined());

		socket.onmessage?.({ data: "{}" });

		expect(h.controller.store.getState().connectionState).toBe("incompatible");
		expect(materializerSignal?.aborted).toBe(true);
		release();
		await flushPromises();
		expect(delivered).toEqual([]);
	});

	it("aborts projected work when a terminal subscribe error closes the Session", async () => {
		let materializerSignal: AbortSignal | undefined;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const adapter = projectedAdapter(async (request, signal) => {
			materializerSignal = signal;
			await gate;
			if (request.method !== "set_editor_text") throw new Error("unexpected fixture request");
			return { ...request, text: "late terminal text" };
		});
		const h = harness({ contentAdapter: adapter });
		connect(h);
		subscribeAndPrime(h, "session-a");
		const delivered: string[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "extension_ui_request") delivered.push(message.request.id);
		});
		ingest(h.controller, projectedSetEditorFrame("session-a", 1, 1, "terminal"));
		await vi.waitFor(() => expect(materializerSignal).toBeDefined());

		h.controller.ingestServerMessage({
			type: "session_error",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			operation: "subscribe",
			error: "closed",
		});

		expect(h.controller.store.getState().sessions["session-a"]?.subscribed).toBe(false);
		expect(materializerSignal?.aborted).toBe(true);
		release();
		await flushPromises();
		expect(delivered).toEqual([]);
	});
});

describe("chunked Session history transport", () => {
	it("commits a chunked snapshot atomically and loads an older page through the same fence", async () => {
		const h = harness();
		const socket = connectWithHistory(h);
		const sessionHandle = "history-a";
		h.controller.store.getState().subscribeSession(sessionHandle);
		const runtimeValue = runtime(sessionHandle, 1, 0);
		socket.serverMessage({ type: "runtime_state", runtime: runtimeValue });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: runtimeValue.serverEpoch,
			sessionHandle,
			runtime: runtimeValue,
			reason: "initial",
		});
		const [begin, chunk, end] = historySnapshotFrames(sessionHandle);
		socket.serverMessage(begin);
		socket.serverMessage(chunk);
		socket.serverMessage(end);
		await flushPromises();

		expect(h.controller.store.getState().sessions[sessionHandle]).toMatchObject({
			baselineAuthoritative: true,
			history: {
				snapshotId: "history-snapshot",
				asOfSeq: 0,
				loadedMessages: 1,
				totalMessages: 2,
				nextCursor: "cursor-older",
				loading: false,
			},
		});

		const loadedPages: PiSessionMessageDto[][] = [];
		const unsubscribe = h.controller.frameBus.subscribe(sessionHandle, ({ message }) => {
			if (message.type === "session_history_page_loaded") loadedPages.push(message.messages);
		});
		expect(h.controller.store.getState().loadOlderSessionHistory(sessionHandle)).toBe(true);
		const request = socket.sent.find(
			(message): message is Extract<SessionWsClientMessage, { type: "session_history_page" }> =>
				message.type === "session_history_page",
		);
		expect(request).toBeDefined();
		const page = historyPageFrames(sessionHandle, request?.id ?? "missing");
		for (const frame of page) socket.serverMessage(frame);
		await flushPromises();
		unsubscribe();

		expect(loadedPages).toEqual([[{ role: "user", content: "older", timestamp: 0 }]]);
		expect(h.controller.store.getState().sessions[sessionHandle]?.history).toMatchObject({
			loadedMessages: 2,
			nextCursor: null,
			loading: false,
			error: null,
		});
	});

	it("fails closed when a snapshot chunk is reordered without publishing a partial baseline", () => {
		const h = harness();
		const socket = connectWithHistory(h);
		const sessionHandle = "history-reordered";
		h.controller.store.getState().subscribeSession(sessionHandle);
		const runtimeValue = runtime(sessionHandle, 1, 0);
		socket.serverMessage({ type: "runtime_state", runtime: runtimeValue });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: runtimeValue.serverEpoch,
			sessionHandle,
			runtime: runtimeValue,
			reason: "initial",
		});
		const [begin, chunk] = historySnapshotFrames(sessionHandle);
		socket.serverMessage(begin);
		socket.serverMessage({ ...chunk, chunkIndex: 1 });

		expect(h.controller.store.getState().sessions[sessionHandle]).toMatchObject({
			baselineAuthoritative: false,
			history: { snapshotId: "history-snapshot", loading: false, error: expect.any(String) },
		});
		expect(h.controller.store.getState().sessions[sessionHandle]?.resync).not.toBeNull();
	});

	it("cancels an in-flight older page and ignores its late frames", async () => {
		const h = harness();
		const socket = connectWithHistory(h);
		const sessionHandle = "history-cancel";
		h.controller.store.getState().subscribeSession(sessionHandle);
		const runtimeValue = runtime(sessionHandle, 1, 0);
		socket.serverMessage({ type: "runtime_state", runtime: runtimeValue });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: runtimeValue.serverEpoch,
			sessionHandle,
			runtime: runtimeValue,
			reason: "initial",
		});
		for (const frame of historySnapshotFrames(sessionHandle)) socket.serverMessage(frame);
		await flushPromises();
		expect(h.controller.store.getState().loadOlderSessionHistory(sessionHandle)).toBe(true);
		const request = socket.sent.find(
			(message): message is Extract<SessionWsClientMessage, { type: "session_history_page" }> =>
				message.type === "session_history_page",
		);
		expect(request).toBeDefined();
		expect(h.controller.store.getState().cancelSessionHistory(sessionHandle)).toBe(true);
		expect(socket.sent).toContainEqual({
			type: "session_history_cancel",
			id: request?.id,
			sessionHandle,
			expectedGeneration: 1,
			snapshotId: "history-snapshot",
		});

		for (const frame of historyPageFrames(sessionHandle, request?.id ?? "missing"))
			socket.serverMessage(frame);
		await flushPromises();
		expect(h.controller.store.getState().sessions[sessionHandle]?.history).toMatchObject({
			loadedMessages: 1,
			nextCursor: "cursor-older",
			loading: false,
		});
	});

	it("fails a page whose begin frame crosses the snapshot identity fence", async () => {
		const h = harness();
		const socket = connectWithHistory(h);
		const sessionHandle = "history-page-fence";
		h.controller.store.getState().subscribeSession(sessionHandle);
		const runtimeValue = runtime(sessionHandle, 1, 0);
		socket.serverMessage({ type: "runtime_state", runtime: runtimeValue });
		socket.serverMessage({
			type: "resync_required",
			serverEpoch: runtimeValue.serverEpoch,
			sessionHandle,
			runtime: runtimeValue,
			reason: "initial",
		});
		for (const frame of historySnapshotFrames(sessionHandle)) socket.serverMessage(frame);
		await flushPromises();
		expect(h.controller.store.getState().loadOlderSessionHistory(sessionHandle)).toBe(true);
		const request = socket.sent.find(
			(message): message is Extract<SessionWsClientMessage, { type: "session_history_page" }> =>
				message.type === "session_history_page",
		);
		if (!request) throw new Error("history page request was not sent");

		const [begin] = historyPageFrames(sessionHandle, request.id);
		socket.serverMessage({ ...begin, snapshotId: "foreign-snapshot" });
		await flushPromises();

		expect(h.controller.store.getState().sessions[sessionHandle]?.history).toMatchObject({
			loading: false,
			error: expect.any(String),
		});
	});
});

describe("ordered session frame bus", () => {
	it("lets a pre-rekey disposer remove the migrated listener", () => {
		const bus = new OrderedSessionFrameBus();
		const listener = vi.fn();
		const unsubscribe = bus.subscribe("session-parent", listener);
		bus.rekey("session-parent", "session-child");
		unsubscribe();
		bus.emit("session-child", { type: "runtime_state", runtime: runtime("session-child", 2, 0) }, 1);

		expect(listener).not.toHaveBeenCalled();
	});
});

describe("Session transport characterization before machine extraction", () => {
	it("keeps the connection hello, terminal mismatch, reconnect, and epoch sequence", () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 5 });
		h.controller.store.getState().subscribeSession("session-a");
		h.controller.store.getState().connect();
		const first = h.sockets[0];
		if (!first) throw new Error("first transport socket was not created");

		expect(h.controller.store.getState().connectionState).toBe("connecting");
		first.open(false);
		expect(first.sent[0]?.type).toBe("client_hello");
		first.serverMessage(serverHello({ serverEpoch: "epoch-a" }));
		expect(h.controller.store.getState().connectionState).toBe("connecting");
		first.serverMessage(hotInventory({ serverEpoch: "epoch-a", revision: 1 }));
		expect(h.controller.store.getState().connectionState).toBe("online");
		expect(h.controller.store.getState().hotRuntimeInventory?.serverEpoch).toBe("epoch-a");

		first.serverClose();
		expect(h.controller.store.getState().connectionState).toBe("offline");
		vi.advanceTimersByTime(5);
		const second = h.sockets[1];
		if (!second) throw new Error("transport did not schedule its reconnect");
		second.open(false);
		second.serverMessage(serverHello({ serverEpoch: "epoch-b" }));
		second.serverMessage(hotInventory({ serverEpoch: "epoch-b", revision: 0 }));
		expect(h.controller.store.getState().connectionState).toBe("online");
		expect(h.controller.store.getState().hotRuntimeInventory?.serverEpoch).toBe("epoch-b");

		const terminal = harness();
		terminal.controller.store.getState().connect();
		const terminalSocket = terminal.sockets[0];
		if (!terminalSocket) throw new Error("terminal transport socket was not created");
		terminalSocket.open(false);
		terminalSocket.serverMessage(serverHello({ protocol: { major: 2, minor: 0 } }));
		expect(terminal.controller.store.getState().connectionState).toBe("incompatible");
		vi.advanceTimersByTime(60_000);
		expect(terminal.sockets).toHaveLength(1);
	});

	it("keeps retryable subscription admission through a deferred matching lease status", () => {
		const h = harness();
		const socket = connect(h);
		rejectSubscriptionDuringResync(h, socket);

		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});

		expect(h.controller.store.getState().sessions["session-a"]?.subscriptionAdmission).toEqual({
			kind: "rejected",
			code: "session_subscription_capacity",
			retryable: true,
		});
		expect(h.controller.store.getState().retrySessionSubscription?.("session-a")).toBe(true);
	});

	it("keeps retryable subscription admission through stale lower-revision lease status", () => {
		const h = harness();
		const socket = connect(h);
		rejectSubscriptionDuringResync(h, socket);

		for (const leaseRevision of [4, 3]) {
			socket.serverMessage({
				type: "lease_status",
				serverEpoch: "test-server-epoch",
				sessionHandle: "session-a",
				generation: 1,
				leaseRevision,
				controlState: "free",
				transition: "baseline",
				isController: false,
			});
		}

		expect(h.controller.store.getState().sessions["session-a"]?.subscriptionAdmission).toEqual({
			kind: "rejected",
			code: "session_subscription_capacity",
			retryable: true,
		});
		expect(h.controller.store.getState().retrySessionSubscription?.("session-a")).toBe(true);
	});

	it("keeps retryable subscription admission through same-revision contradictory lease status", () => {
		const h = harness();
		const socket = connect(h);
		rejectSubscriptionDuringResync(h, socket);

		for (const lease of [
			{ controlState: "free" as const, isController: false },
			{ controlState: "held" as const, isController: true },
		]) {
			socket.serverMessage({
				type: "lease_status",
				serverEpoch: "test-server-epoch",
				sessionHandle: "session-a",
				generation: 1,
				leaseRevision: 4,
				controlState: lease.controlState,
				transition: "baseline",
				isController: lease.isController,
				...(lease.isController ? { fencingToken: "contradictory-fence" } : {}),
			});
		}

		expect(h.controller.store.getState().sessions["session-a"]?.lease.conflicted).toBe(true);
		expect(h.controller.store.getState().sessions["session-a"]?.subscriptionAdmission).toEqual({
			kind: "rejected",
			code: "session_subscription_capacity",
			retryable: true,
		});
		expect(h.controller.store.getState().retrySessionSubscription?.("session-a")).toBe(true);
	});

	it("clears retryable subscription admission only after an authoritative resync baseline", async () => {
		const clock = new ResyncClock();
		const h = harness({ resyncClock: clock, resyncRandom: () => 0.5 });
		const socket = connect(h);
		rejectSubscriptionDuringResync(h, socket);

		await flushPromises();
		expect(h.controller.store.getState().sessions["session-a"]?.subscriptionAdmission).toMatchObject({
			kind: "rejected",
		});

		clock.advanceBy(500);
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		completeWithSnapshot(h, "session-a", 1, 0);

		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			baselineAuthoritative: true,
			subscriptionAdmission: null,
		});
	});

	it("keeps revisioned control transitions fenced through claim, release, takeover, and conflict", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 0,
			controlState: "free",
			transition: "baseline",
			isController: false,
		});
		expect(h.controller.store.getState().claimSession("session-a")).toBe(true);
		expect(socket.sent.at(-1)).toEqual({ type: "session_claim", sessionHandle: "session-a" });
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 1,
			controlState: "held",
			transition: "claim",
			isController: true,
			fencingToken: "fence-1",
		});
		expect(h.controller.store.getState().sessions["session-a"]?.lease).toMatchObject({
			isController: true,
			leaseRevision: 1,
			fencingToken: "fence-1",
		});

		expect(h.controller.store.getState().releaseSession("session-a")).toBe(true);
		expect(h.controller.store.getState().sessions["session-a"]?.lease).toMatchObject({
			isController: false,
			leaseRevision: 1,
		});
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 2,
			controlState: "held",
			transition: "takeover",
			isController: false,
		});
		expect(h.controller.store.getState().takeoverSession("session-a")).toBe(true);
		expect(socket.sent.at(-1)).toEqual({
			type: "session_takeover",
			sessionHandle: "session-a",
			expectedGeneration: 1,
			expectedLeaseRevision: 2,
		});
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 2,
			controlState: "held",
			transition: "takeover",
			isController: true,
			fencingToken: "foreign-fence",
		});
		expect(h.controller.store.getState().sessions["session-a"]?.lease).toMatchObject({
			isController: false,
			conflicted: true,
		});
		socket.serverMessage({
			type: "lease_status",
			serverEpoch: "test-server-epoch",
			sessionHandle: "session-a",
			generation: 1,
			leaseRevision: 3,
			controlState: "free",
			transition: "release",
			isController: false,
		});
		expect(h.controller.store.getState().sessions["session-a"]?.lease).toMatchObject({
			leaseRevision: 3,
		});
		expect(h.controller.store.getState().sessions["session-a"]?.lease.conflicted).toBeUndefined();
	});

	it("correlates commands by captured identity, waits for barrier delivery, and ignores timeout-late responses", async () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 5 });
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const barrier = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "barrier-command", type: "get_state" });
		socket.serverMessage(successResponse("session-a", 1, "barrier-command", "get_state", 1));
		let barrierSettled = false;
		void barrier.then(() => {
			barrierSettled = true;
		});
		await Promise.resolve();
		expect(barrierSettled).toBe(false);
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));
		await expect(barrier).resolves.toMatchObject({ id: "barrier-command" });

		const timedOut = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "timeout-command", type: "get_state" }, 10);
		vi.advanceTimersByTime(10);
		await expect(timedOut).rejects.toMatchObject({ code: "timeout" });
		socket.serverMessage(successResponse("session-a", 1, "timeout-command", "get_state"));

		const captured = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "captured-command", type: "get_state" });
		h.controller.ingestServerMessage({ type: "runtime_state", runtime: runtime("session-a", 2, 1) });
		socket.serverMessage(successResponse("session-a", 1, "captured-command", "get_state"));
		await expect(captured).rejects.toMatchObject({ code: "response_mismatch" });
	});
});
