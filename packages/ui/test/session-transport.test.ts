import {
	type ExtensionUiRequestDto,
	GATEWAY_PROTOCOL_VERSION,
	type GatewayClientHelloDto,
	type GatewayProtocolErrorDto,
	type GatewayServerHelloDto,
	type NativeSessionDto,
	type ProductSessionEventDto,
	SESSION_WS_CLIENT_MAX_BYTES,
	SESSION_WS_SERVER_MAX_BYTES,
	type SessionCommandResponseDto,
	type SessionReplayFrameDto,
	type SessionRuntimeDto,
	type SessionWsClientMessage,
	type SessionWsServerMessage,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionDeleteCapability } from "../src/lib/session-capabilities";
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
		if (negotiate) this.serverMessage(serverHello());
	}

	serverMessage(message: SessionWsServerMessage | GatewayServerHelloDto | GatewayProtocolErrorDto): void {
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

function serverHello(overrides: Partial<GatewayServerHelloDto> = {}): GatewayServerHelloDto {
	return {
		type: "server_hello",
		protocol: GATEWAY_PROTOCOL_VERSION,
		serverBuild: "9.7.0-independent-server",
		serverEpoch: "test-server-epoch",
		piVersion: "0.84.2",
		adapterId: "legacy-rpc-v1",
		capabilities: ["rpc.commands", "rpc.events", "rpc.extension_ui", "session.multiplex"],
		limits: {
			maxClientFrameBytes: 8 * 1024 * 1024,
			maxSnapshotFrameBytes: 32 * 1024 * 1024,
			maxExtensionRequests: 256,
		},
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
		protocolVersion?: { major: number; minor: number };
		onResyncRequired?: (message: Extract<SessionWsServerMessage, { type: "resync_required" }>) => void;
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

function runtime(sessionHandle: string, generation = 1, lastSeq = 0): SessionRuntimeDto {
	return {
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
): Extract<SessionReplayFrameDto, { type: "event" }> {
	return {
		type: "event",
		sessionHandle,
		workspaceId: "workspace-a",
		generation,
		seq,
		event: { type: "agent_start" } as ProductSessionEventDto,
	};
}

function extensionRequest(id: string): ExtensionUiRequestDto {
	return {
		type: "extension_ui_request",
		id,
		method: "confirm",
		title: id,
		message: id,
	} as ExtensionUiRequestDto;
}

function successResponse(
	sessionHandle: string,
	generation: number,
	id: string,
	command: string,
	barrierSeq = 0,
): Extract<SessionWsServerMessage, { type: "response" }> {
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
		sessionHandle,
		generation,
		barrierSeq,
		response: {
			id,
			type: "response",
			command,
			success: true,
			...(data === undefined ? {} : { data }),
		} as SessionCommandResponseDto,
	};
}

function extensionFrame(
	sessionHandle: string,
	generation: number,
	seq: number,
	request: ExtensionUiRequestDto,
): Extract<SessionReplayFrameDto, { type: "extension_ui_request" }> {
	return {
		type: "extension_ui_request",
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
		sessionHandle,
		runtime: snapshot,
		reason: "initial",
	});
	h.controller.ingestServerMessage({
		type: "extension_ui_snapshot",
		sessionHandle,
		generation,
		requests: [],
	});
	h.controller.store.getState().completeResync(sessionHandle, { generation, seq: lastSeq });
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
			protocol: GATEWAY_PROTOCOL_VERSION,
			clientBuild: "2.4.1-independent-ui",
			capabilities: ["rpc.commands", "rpc.events", "rpc.extension_ui", "session.multiplex"],
			limits: { maxServerFrameBytes: SESSION_WS_SERVER_MAX_BYTES },
		});
		expect(h.controller.store.getState().connectionState).toBe("connecting");
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toEqual([]);

		socket.serverMessage(serverHello({ serverBuild: "99.0.0-independent-server" }));
		expect(h.controller.store.getState().connectionState).toBe("online");
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toEqual([
			{ type: "session_subscribe", sessionHandle: "session-a" },
		]);
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
		const h = harness({ protocolVersion: { major: 1, minor: 3 } });
		h.controller.store.getState().connect();
		const socket = h.sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		socket.open(false);
		socket.serverMessage(serverHello({ protocol: { major: 1, minor: 4 } }));

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
		const missingCapability = harness();
		missingCapability.controller.store.getState().connect();
		const capabilitySocket = missingCapability.sockets[0];
		if (!capabilitySocket) throw new Error("transport did not create a socket");
		capabilitySocket.open(false);
		capabilitySocket.serverMessage(
			serverHello({ capabilities: ["rpc.commands", "rpc.events", "session.multiplex"] }),
		);
		expect(missingCapability.controller.store.getState().connectionState).toBe("incompatible");

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
		subscribeAndPrime(h, "session-large");
		const pending = h.controller.store
			.getState()
			.sendCommand("session-large", { id: "large-history", type: "get_messages" });
		const frame: Extract<SessionWsServerMessage, { type: "response" }> = {
			type: "response",
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
	it("ingests foreground and background Sessions independently over one socket", () => {
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
			sessionHandle: "session-a",
			generation: 1,
			requests: [extensionRequest("request-a")],
		});
		h.controller.ingestServerMessage({
			type: "extension_ui_snapshot",
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
			}) as unknown as SessionReplayFrameDto;
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
			sessionHandle: "session-a",
			runtime: initial,
			reason: "initial",
		});
		socket.serverMessage({
			type: "extension_ui_snapshot",
			sessionHandle: "session-a",
			generation: 1,
			requests: [],
		});
		socket.serverMessage({ type: "lease_status", sessionHandle: "session-a", isController: false });
		expect(socket.sent.filter(({ type }) => type === "session_claim")).toEqual([
			{ type: "session_claim", sessionHandle: "session-a" },
		]);
	});

	it("fails closed and releases control when a recovery subscription fails", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		expect(h.controller.store.getState().claimSession("session-a")).toBe(true);
		socket.serverMessage({
			type: "lease_status",
			sessionHandle: "session-a",
			isController: true,
			fencingToken: "session-token",
		});
		const pending = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "read-during-recovery", type: "get_state" });

		expect(h.controller.reportProjectionFailure("session-a", 1, new Error("projection failed"))).toBe(true);
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		socket.serverMessage({
			type: "session_error",
			sessionHandle: "session-a",
			operation: "subscribe",
			error: "session_runtime_capacity",
		});

		await expect(pending).rejects.toMatchObject({ code: "session_not_subscribed" });
		expect(h.controller.store.getState().sessions["session-a"]).toMatchObject({
			subscribed: false,
			lease: { isController: false },
		});
		expect(socket.sent).toContainEqual({ type: "session_release", sessionHandle: "session-a" });
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
		await Promise.resolve();

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
			sessionHandle: "session-a",
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
		} as unknown as SessionWsServerMessage;
		socket.serverMessage(malformed);
		await expect(affected).rejects.toMatchObject({ code: "unavailable" });

		expect(observed).toEqual([]);
		expect(h.controller.store.getState().connectionState).toBe("incompatible");
		expect(h.controller.store.getState().sessions["session-a"]?.lastSeq).toBe(0);
		expect(h.controller.store.getState().sessions["session-a"]?.projectedSeq).toBe(0);
		expect(h.controller.store.getState().sessions["session-a"]?.resync).toBeNull();
		expect(h.controller.store.getState().sessions["session-a"]?.lease).toEqual({ isController: false });
		expect(leaseStates).toEqual([true, false]);
		expect(
			sessionDeleteCapability(
				{ persisted: true, runtime: runtime("session-a") } as NativeSessionDto,
				h.controller.store.getState().sessions["session-a"],
			),
		).toEqual({ allowed: false, reason: "controller_required" });
	});

	it("does not expose a resync consumer until the atomic subscription baseline is complete", async () => {
		const h = harness();
		const socket = connect(h);
		h.controller.store.getState().subscribeSession("session-a");
		const snapshots: Array<Promise<SessionCommandResponseDto>> = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type !== "resync_required") return;
			snapshots.push(
				h.controller.store
					.getState()
					.sendCommand("session-a", { id: "baseline-messages", type: "get_messages" }),
			);
		});
		const initial = runtime("session-a", 1, 0);
		socket.serverMessage({ type: "runtime_state", runtime: initial });
		socket.serverMessage({
			type: "resync_required",
			sessionHandle: "session-a",
			runtime: initial,
			reason: "initial",
		});

		expect(snapshots).toEqual([]);
		expect(sentCommand(socket, "baseline-messages")).toBeUndefined();
		socket.serverMessage({
			type: "extension_ui_snapshot",
			sessionHandle: "session-a",
			generation: 1,
			requests: [],
		});
		expect(snapshots).toHaveLength(1);
		expect(sentCommand(socket, "baseline-messages")).toBeDefined();
		socket.serverMessage(successResponse("session-a", 1, "baseline-messages", "get_messages"));
		await expect(snapshots[0]).resolves.toMatchObject({ id: "baseline-messages", success: true });
		h.controller.store.getState().completeResync("session-a");
	});

	it("retains independent cursors and resubscribes every Session after reconnect", () => {
		vi.useFakeTimers();
		const h = harness({ reconnectBaseMs: 10 });
		const first = connect(h);
		subscribeAndPrime(h, "session-a");
		subscribeAndPrime(h, "session-b");
		first.serverMessage(eventFrame("session-a", 1, 1));
		first.serverMessage(eventFrame("session-a", 1, 2));
		first.serverMessage(eventFrame("session-b", 1, 1));

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
					cursor: { generation: 1, seq: 2 },
				},
				{
					type: "session_subscribe",
					sessionHandle: "session-b",
					cursor: { generation: 1, seq: 1 },
				},
			]),
		);
	});

	it("invalidates only a dormant snapshot so its next subscription has no cursor", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage(eventFrame("session-a", 1, 1));
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

		h.controller.store.getState().completeResync("session-a", { generation: 1, seq: 2 });
		expect(delivered).toEqual([1, 2, "resync_required", 3, 4]);
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
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));

		h.controller.store.getState().completeResync("session-a", { generation: 1, seq: 0 });

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

		h.controller.store.getState().completeResync("session-a", { generation: 1, seq: 0 });
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

	it("delivers a resync snapshot response before completion and advances its covered barrier", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const delivered: number[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "event") delivered.push(message.seq);
		});

		h.controller.ingestServerMessage({
			type: "resync_required",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 1));
		const snapshot = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "resync-messages", type: "get_messages" }, 100);
		const ordinaryRead = h.controller.store
			.getState()
			.sendCommand("session-a", { id: "resync-state", type: "get_state" });
		let ordinarySettled = false;
		ordinaryRead.then(() => {
			ordinarySettled = true;
		});

		socket.serverMessage(successResponse("session-a", 1, "resync-messages", "get_messages", 1));
		socket.serverMessage(successResponse("session-a", 1, "resync-state", "get_state", 2));
		await expect(snapshot).resolves.toMatchObject({ id: "resync-messages", command: "get_messages" });
		expect(ordinarySettled).toBe(false);
		expect(h.controller.store.getState().sessions["session-a"]?.resync).toMatchObject({
			barrierSeq: 1,
			bufferedFrameCount: 0,
		});

		// The authoritative message snapshot covers sequence 1. Only the later
		// buffered frame may reach incremental projection consumers.
		h.controller.ingestServerMessage(eventFrame("session-a", 1, 2));
		h.controller.store.getState().completeResync("session-a");
		expect(delivered).toEqual([2]);
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
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});

		for (let seq = 1; seq <= EXPECTED_RESYNC_FRAME_LIMIT + 1; seq += 1) {
			h.controller.ingestServerMessage(eventFrame("session-a", 1, seq));
		}

		expect(h.controller.store.getState().sessions["session-a"]?.resync).toMatchObject({
			reason: "gap",
			barrierSeq: EXPECTED_RESYNC_FRAME_LIMIT + 1,
			bufferedFrameCount: 0,
		});
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		expect(notices.at(-1)).toEqual({ reason: "gap", barrierSeq: 0 });
		h.controller.ingestServerMessage({
			type: "resync_required",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, EXPECTED_RESYNC_FRAME_LIMIT + 1),
			reason: "initial",
		});
		h.controller.ingestServerMessage({
			type: "extension_ui_snapshot",
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
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		const oversized = {
			...eventFrame("session-a", 1, 1),
			event: { type: "agent_start", detail: "x".repeat(EXPECTED_RESYNC_BYTE_LIMIT + 1) },
		} as unknown as SessionReplayFrameDto;
		h.controller.ingestServerMessage(oversized);

		expect(h.controller.store.getState().sessions["session-a"]?.resync).toMatchObject({
			barrierSeq: 1,
			bufferedFrameCount: 0,
		});
	});

	it("refreshes the atomic extension snapshot after a replay-buffer overflow", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const dialog = extensionRequest("dialog-one");
		h.controller.ingestServerMessage({
			type: "extension_ui_snapshot",
			sessionHandle: "session-a",
			generation: 1,
			requests: [dialog],
		});
		h.controller.ingestServerMessage({
			type: "resync_required",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		const oversized = {
			...eventFrame("session-a", 1, 1),
			event: { type: "agent_start", detail: "x".repeat(EXPECTED_RESYNC_BYTE_LIMIT + 1) },
		} as unknown as SessionReplayFrameDto;
		h.controller.ingestServerMessage(oversized);
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		expect(h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests).toEqual([]);

		h.controller.ingestServerMessage({
			type: "runtime_state",
			runtime: runtime("session-a", 1, 1),
		});
		h.controller.ingestServerMessage({
			type: "resync_required",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 1),
			reason: "initial",
		});
		h.controller.ingestServerMessage({
			type: "extension_ui_snapshot",
			sessionHandle: "session-a",
			generation: 1,
			requests: [dialog],
		});
		expect(
			h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests.map(({ id }) => id),
		).toEqual(["dialog-one"]);
	});

	it("does not expose an overflow resync consumer before the replacement baseline", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		h.controller.ingestServerMessage({
			type: "resync_required",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "gap",
		});
		const snapshots: Array<Promise<SessionCommandResponseDto>> = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type !== "resync_required") return;
			snapshots.push(
				h.controller.store
					.getState()
					.sendCommand("session-a", { id: "overflow-messages", type: "get_messages" }),
			);
		});
		const oversized = {
			...eventFrame("session-a", 1, 1),
			event: { type: "agent_start", detail: "x".repeat(EXPECTED_RESYNC_BYTE_LIMIT + 1) },
		} as unknown as SessionReplayFrameDto;
		h.controller.ingestServerMessage(oversized);

		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "session-a" });
		expect(snapshots).toEqual([]);
		h.controller.ingestServerMessage({
			type: "runtime_state",
			runtime: runtime("session-a", 1, 1),
		});
		h.controller.ingestServerMessage({
			type: "resync_required",
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 1),
			reason: "initial",
		});
		h.controller.ingestServerMessage({
			type: "extension_ui_snapshot",
			sessionHandle: "session-a",
			generation: 1,
			requests: [],
		});
		expect(snapshots).toHaveLength(1);
		socket.serverMessage(successResponse("session-a", 1, "overflow-messages", "get_messages", 1));
		await expect(snapshots[0]).resolves.toMatchObject({ id: "overflow-messages", success: true });
		h.controller.store.getState().completeResync("session-a");
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

		expect(second.sent).toContainEqual({
			type: "session_subscribe",
			sessionHandle: "session-a",
			cursor: { generation: 1, seq: 1 },
		});
		h.controller.ingestServerMessage({
			type: "extension_ui_snapshot",
			sessionHandle: "session-a",
			generation: 1,
			requests: [],
		});
		expect(notices.filter((reason) => reason === "gap")).toHaveLength(2);
		h.controller.store.getState().completeResync("session-a", { generation: 1, seq: 0 });
		expect(delivered).toEqual([1]);
	});

	it("consumes a buffered dialog only after its server acknowledgement", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			sessionHandle: "session-a",
			isController: true,
			fencingToken: "dialog-token",
		});
		h.controller.ingestServerMessage({
			type: "resync_required",
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
		).toBe(true);
		expect(
			h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests.map(({ id }) => id),
		).toEqual(["dialog-one"]);
		socket.serverMessage({
			type: "extension_ui_result",
			sessionHandle: "session-a",
			generation: 1,
			requestId: "dialog-one",
			outcome: "accepted",
		});
		h.controller.store.getState().completeResync("session-a", { generation: 1, seq: 0 });
		expect(deliveredDialogs).toBe(0);
		expect(h.controller.store.getState().sessions["session-a"]?.lastSeq).toBe(1);
		expect(socket.sent).toContainEqual({
			type: "extension_ui_response",
			sessionHandle: "session-a",
			expectedGeneration: 1,
			fencingToken: "dialog-token",
			response: { type: "extension_ui_response", id: "dialog-one", confirmed: true },
		});
	});

	it("forwards extension response results only for the current generation", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			sessionHandle: "session-a",
			isController: true,
			fencingToken: "dialog-token",
		});
		socket.serverMessage(extensionFrame("session-a", 1, 1, extensionRequest("dialog-one")));
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
			sessionHandle: "session-a",
			generation: 2,
			requestId: "dialog-one",
			outcome: "not_running",
		});
		expect(
			h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests.map(({ id }) => id),
		).toEqual(["dialog-one"]);
		expect(outcomes).toEqual([]);

		socket.serverMessage({
			type: "extension_ui_result",
			sessionHandle: "session-a",
			generation: 1,
			requestId: "dialog-one",
			outcome: "accepted",
		});
		expect(h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests).toEqual([]);
		expect(outcomes).toEqual(["accepted"]);
	});

	it("applies extension close frames in replay order", () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		const delivered: string[] = [];
		h.controller.frameBus.subscribe("session-a", ({ message }) => {
			if (message.type === "extension_ui_request") delivered.push(`open:${message.request.id}`);
			if (message.type === "extension_ui_closed") delivered.push(`close:${message.requestId}`);
		});

		socket.serverMessage(extensionFrame("session-a", 1, 1, extensionRequest("dialog-one")));
		socket.serverMessage({
			type: "extension_ui_closed",
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 1,
			seq: 2,
			requestId: "dialog-one",
			reason: "expired",
		});

		expect(delivered).toEqual(["open:dialog-one", "close:dialog-one"]);
		expect(h.controller.store.getState().sessions["session-a"]?.lastSeq).toBe(2);
		expect(h.controller.store.getState().sessions["session-a"]?.pendingExtensionRequests).toEqual([]);
	});

	it("retains only blocking and semantic sticky extension state under a hard total cap", () => {
		const h = harness();
		connect(h);
		subscribeAndPrime(h, "session-a");
		let seq = 0;
		const ingest = (request: ExtensionUiRequestDto) => {
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
			sessionHandle: "session-a",
			runtime: runtime("session-a", 1, 0),
			reason: "generation_changed",
		});
		socket.serverMessage(eventFrame("session-a", 1, 1));
		socket.serverMessage(eventFrame("session-a", 2, 1));
		expect(delivered).toEqual([1]);
		expect(h.controller.store.getState().sessions["session-a"]?.generation).toBe(2);
	});
});

describe("session transport commands and identity", () => {
	it("rejects an oversized command before WebSocket.send without dropping the connection", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			sessionHandle: "session-a",
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
			previousSessionHandle: "session-requested",
			runtime: runtime("session-resolved", 7, 4),
		});
		socket.serverMessage({
			type: "runtime_state",
			runtime: runtime("session-resolved", 7, 4),
		});
		socket.serverMessage({
			type: "resync_required",
			sessionHandle: "session-resolved",
			runtime: runtime("session-resolved", 7, 4),
			reason: "initial",
		});
		socket.serverMessage({
			type: "extension_ui_snapshot",
			sessionHandle: "session-resolved",
			generation: 7,
			requests: [extensionRequest("resolved-dialog")],
		});
		socket.serverMessage({
			type: "lease_status",
			sessionHandle: "session-resolved",
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
		await expect(snapshot).resolves.toMatchObject({ id: "resolved-messages", success: true });
		h.controller.store.getState().completeResync("session-resolved");

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
			"session-resolved:extension_ui_snapshot",
			"session-resolved:resync_required",
			"session-resolved:lease_status",
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
			sessionHandle: "session-parent",
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
			previousSessionHandle: "session-parent",
			runtime: runtime("session-child", 2, 0),
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
		h.controller.store.getState().completeResync("session-child");
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
			lease: { isController: true, fencingToken: "parent-token" },
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
			sessionHandle: "session-parent",
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
			previousSessionHandle: "session-parent",
			runtime: runtime("session-child", 2, 0),
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
		expect(socket.sent.filter(({ type }) => type === "session_subscribe")).toHaveLength(1);
	});

	it("fails the local lease closed immediately after release is sent", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		socket.serverMessage({
			type: "lease_status",
			sessionHandle: "session-a",
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
		});
		expect(leaseFrames).toEqual([false]);
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

	it("adds fencing only to mutations and never shares a lease across Sessions", async () => {
		const h = harness();
		const socket = connect(h);
		subscribeAndPrime(h, "session-a");
		subscribeAndPrime(h, "session-b");
		socket.serverMessage({
			type: "lease_status",
			sessionHandle: "session-a",
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
			sessionHandle: "session-a",
			isController: true,
			fencingToken: "token-a",
		});
		first.serverMessage({
			type: "lease_status",
			sessionHandle: "session-b",
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
			second.serverMessage({ type: "lease_status", sessionHandle, isController: false });
		}
		expect(second.sent.filter(({ type }) => type === "session_claim")).toEqual([
			{ type: "session_claim", sessionHandle: "session-b" },
			{ type: "session_claim", sessionHandle: "session-a" },
		]);

		// A denied claim acknowledgement must not create an immediate retry loop.
		second.serverMessage({ type: "lease_status", sessionHandle: "session-a", isController: false });
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
			sessionHandle: "session-a",
			runtime: initial,
			reason: "initial",
		});
		socket.serverMessage({
			type: "extension_ui_snapshot",
			sessionHandle: "session-a",
			generation: 1,
			requests: [],
		});
		expect(socket.sent.filter(({ type }) => type === "session_claim")).toEqual([]);
		socket.serverMessage({ type: "lease_status", sessionHandle: "session-a", isController: false });
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
		socket.serverMessage({ type: "lease_status", sessionHandle: "session-observer", isController: false });
		socket.serverMessage({ type: "lease_status", sessionHandle: "session-a", isController: false });
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
