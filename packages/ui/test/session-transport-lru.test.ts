import type {
	GatewayClientHelloDto,
	HotRuntimeInventoryDto,
	SessionRuntimeDto,
	SessionWsClientMessage,
} from "@pi-agent-web/protocol";
import { GATEWAY_PAYLOAD_BUDGET_CAPABILITY, SESSION_PAYLOAD_BUDGET } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	createSessionTransport,
	MAX_ACTIVE_SUBSCRIPTIONS,
	type SessionTransportController,
	type SessionWebSocket,
} from "../src/stores/session-transport";

class FakeSocket implements SessionWebSocket {
	readyState = 1;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	readonly sent: Array<SessionWsClientMessage | GatewayClientHelloDto> = [];

	send(data: string): void {
		this.sent.push(JSON.parse(data) as SessionWsClientMessage | GatewayClientHelloDto);
	}
	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}
}

function open(socket: FakeSocket | undefined): void {
	if (!socket) throw new Error("transport did not create a socket");
	socket.onopen?.();
	socket.onmessage?.({
		data: JSON.stringify({
			type: "server_hello",
			protocol: { major: 1, minor: 2 },
			serverBuild: "test-server",
			serverEpoch: "test-epoch",
			piVersion: "0.84.2",
			adapterId: "pi-rpc",
			capabilities: [
				"rpc.commands",
				"rpc.events",
				"rpc.extension_ui",
				"session.multiplex",
				"session.hot_runtime_inventory",
				GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
			],
			limits: {
				maxClientFrameBytes: 8 * 1024 * 1024,
				maxSnapshotFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
				maxExtensionRequests: 256,
			},
			payloadBudget: SESSION_PAYLOAD_BUDGET,
		}),
	});
	socket.onmessage?.({
		data: JSON.stringify({
			type: "hot_runtime_inventory",
			serverEpoch: "test-epoch",
			revision: 0,
			runtimes: [],
		} satisfies HotRuntimeInventoryDto),
	});
}

interface Harness {
	controller: SessionTransportController;
	sockets: FakeSocket[];
}

const controllers: SessionTransportController[] = [];

function harness(options: { maxActiveSubscriptions?: number } = {}): Harness {
	const sockets: FakeSocket[] = [];
	const controller = createSessionTransport({
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		url: () => "ws://test/ws",
		protocolVersion: { major: 1, minor: 2 },
		...options,
	});
	controllers.push(controller);
	return { controller, sockets };
}

afterEach(() => {
	for (const controller of controllers) controller.dispose();
	controllers.length = 0;
});

function idlePersistedRuntime(sessionHandle: string): SessionRuntimeDto {
	return {
		serverEpoch: "test-epoch",
		sessionHandle,
		workspaceId: "ws-1",
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/path/to/${sessionHandle}.jsonl`,
		cwd: "/workspace",
		generation: 1,
		lastSeq: 10,
		state: "idle",
		lastActivityAt: Date.now(),
		recoverable: true,
	};
}

function runningRuntime(sessionHandle: string): SessionRuntimeDto {
	return {
		serverEpoch: "test-epoch",
		sessionHandle,
		workspaceId: "ws-1",
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: `/path/to/${sessionHandle}.jsonl`,
		cwd: "/workspace",
		generation: 1,
		lastSeq: 10,
		state: "running",
		lastActivityAt: Date.now(),
		recoverable: true,
	};
}

function commandBusyRuntime(sessionHandle: string): SessionRuntimeDto {
	return {
		...idlePersistedRuntime(sessionHandle),
		phase: "busy",
		operationCount: 1,
		busyReasons: ["command"],
	};
}

function unpersistedRuntime(sessionHandle: string): SessionRuntimeDto {
	return {
		serverEpoch: "test-epoch",
		sessionHandle,
		workspaceId: "ws-1",
		nativeSessionId: `native-${sessionHandle}`,
		sessionFile: null,
		cwd: "/workspace",
		generation: 1,
		lastSeq: 0,
		state: "idle",
		lastActivityAt: Date.now(),
		recoverable: false,
	};
}

describe("Active WebSocket Subscription LRU admission target with liveness guard", () => {
	it("pins every authoritative hot Runtime even above the ordinary LRU target", () => {
		const { controller, sockets } = harness({ maxActiveSubscriptions: 2 });
		controller.store.getState().connect();
		open(sockets[0]);
		const socket = sockets[0];
		if (!socket) throw new Error("transport did not create a socket");
		socket.onmessage?.({
			data: JSON.stringify({
				type: "hot_runtime_inventory",
				serverEpoch: "test-epoch",
				revision: 1,
				runtimes: Array.from({ length: 7 }, (_, index) => ({
					serverEpoch: "test-epoch",
					sessionHandle: `hot-${String(index)}`,
					workspaceId: "ws-1",
					generation: 1,
					state: "idle" as const,
				})),
			} satisfies HotRuntimeInventoryDto),
		});

		expect(
			Object.values(controller.store.getState().sessions).filter(({ subscribed }) => subscribed),
		).toHaveLength(7);
		expect(socket.sent.filter(({ type }) => type === "session_unsubscribe")).toEqual([]);
		expect(
			socket.sent.filter(
				(message) => message.type === "session_subscribe" && message.expectedHotRuntime !== undefined,
			),
		).toHaveLength(1);
	});

	it("exports the soft MAX_ACTIVE_SUBSCRIPTIONS target as 6", () => {
		expect(MAX_ACTIVE_SUBSCRIPTIONS).toBe(6);
	});

	it("allows up to MAX_ACTIVE_SUBSCRIPTIONS without eviction", () => {
		const { controller, sockets } = harness();
		controller.store.getState().connect();
		open(sockets[0]);

		for (let i = 1; i <= 6; i++) {
			const handle = `session-${i}`;
			controller.store.getState().subscribeSession(handle);
			controller.ingestServerMessage({
				type: "runtime_state",
				runtime: idlePersistedRuntime(handle),
			});
		}

		const sessions = controller.store.getState().sessions;
		for (let i = 1; i <= 6; i++) {
			expect(sessions[`session-${i}`]?.subscribed).toBe(true);
		}
	});

	it("evicts the least recently used idle persisted session when capacity exceeds limit", () => {
		const { controller, sockets } = harness();
		controller.store.getState().connect();
		open(sockets[0]);

		// Subscribe session-1 to session-6
		for (let i = 1; i <= 6; i++) {
			const handle = `session-${i}`;
			controller.store.getState().subscribeSession(handle);
			controller.ingestServerMessage({
				type: "runtime_state",
				runtime: idlePersistedRuntime(handle),
			});
		}

		// Now subscribe session-7
		controller.store.getState().subscribeSession("session-7");
		controller.ingestServerMessage({
			type: "runtime_state",
			runtime: idlePersistedRuntime("session-7"),
		});

		const sessions = controller.store.getState().sessions;
		// session-1 was LRU, should be evicted (subscribed: false)
		expect(sessions["session-1"]?.subscribed).toBe(false);
		// session-2 through session-7 are subscribed
		for (let i = 2; i <= 7; i++) {
			expect(sessions[`session-${i}`]?.subscribed).toBe(true);
		}

		// Check session_unsubscribe was sent on wire for session-1
		const unsubs = sockets[0]?.sent.filter(
			(msg) => msg.type === "session_unsubscribe" && msg.sessionHandle === "session-1",
		);
		expect(unsubs?.length).toBeGreaterThan(0);
	});

	it("does not evict running sessions even if they are LRU (Liveness Guard)", () => {
		const { controller, sockets } = harness();
		controller.store.getState().connect();
		open(sockets[0]);

		// session-1 is running
		controller.store.getState().subscribeSession("session-1");
		controller.ingestServerMessage({
			type: "runtime_state",
			runtime: runningRuntime("session-1"),
		});

		// session-2 to session-6 are idle
		for (let i = 2; i <= 6; i++) {
			const handle = `session-${i}`;
			controller.store.getState().subscribeSession(handle);
			controller.ingestServerMessage({
				type: "runtime_state",
				runtime: idlePersistedRuntime(handle),
			});
		}

		// Subscribe session-7: session-1 is oldest, but running, so session-2 should be evicted instead!
		controller.store.getState().subscribeSession("session-7");
		controller.ingestServerMessage({
			type: "runtime_state",
			runtime: idlePersistedRuntime("session-7"),
		});

		const sessions = controller.store.getState().sessions;
		expect(sessions["session-1"]?.subscribed).toBe(true); // Protected by liveness guard
		expect(sessions["session-2"]?.subscribed).toBe(false); // Evicted as least recent idle candidate
		expect(sessions["session-7"]?.subscribed).toBe(true);
	});

	it("does not evict a command-busy session whose legacy state is still idle", () => {
		const { controller, sockets } = harness();
		controller.store.getState().connect();
		open(sockets[0]);

		controller.store.getState().subscribeSession("session-1");
		controller.ingestServerMessage({
			type: "runtime_state",
			runtime: commandBusyRuntime("session-1"),
		});
		for (let i = 2; i <= 6; i++) {
			const handle = `session-${i}`;
			controller.store.getState().subscribeSession(handle);
			controller.ingestServerMessage({
				type: "runtime_state",
				runtime: idlePersistedRuntime(handle),
			});
		}

		controller.store.getState().subscribeSession("session-7");

		const sessions = controller.store.getState().sessions;
		expect(sessions["session-1"]?.subscribed).toBe(true);
		expect(sessions["session-2"]?.subscribed).toBe(false);
	});

	it("does not evict unpersisted sessions (transient sessions)", () => {
		const { controller, sockets } = harness();
		controller.store.getState().connect();
		open(sockets[0]);

		// session-1 is unpersisted
		controller.store.getState().subscribeSession("session-1");
		controller.ingestServerMessage({
			type: "runtime_state",
			runtime: unpersistedRuntime("session-1"),
		});

		// session-2 to session-6 are idle
		for (let i = 2; i <= 6; i++) {
			const handle = `session-${i}`;
			controller.store.getState().subscribeSession(handle);
			controller.ingestServerMessage({
				type: "runtime_state",
				runtime: idlePersistedRuntime(handle),
			});
		}

		// Subscribe session-7: session-1 is unpersisted, so session-2 is evicted instead
		controller.store.getState().subscribeSession("session-7");

		const sessions = controller.store.getState().sessions;
		expect(sessions["session-1"]?.subscribed).toBe(true); // Protected because unpersisted
		expect(sessions["session-2"]?.subscribed).toBe(false);
		expect(sessions["session-7"]?.subscribed).toBe(true);
	});

	it("does not evict sessions with pending extension requests", () => {
		const { controller, sockets } = harness();
		controller.store.getState().connect();
		open(sockets[0]);

		// session-1 has pending extension UI request
		controller.store.getState().subscribeSession("session-1");
		controller.ingestServerMessage({
			type: "runtime_state",
			runtime: idlePersistedRuntime("session-1"),
		});
		controller.ingestServerMessage({
			type: "resync_required",
			serverEpoch: "test-epoch",
			sessionHandle: "session-1",
			runtime: idlePersistedRuntime("session-1"),
			reason: "initial",
		});
		controller.ingestServerMessage({
			type: "session_snapshot",
			snapshotId: "snapshot-session-1",
			serverEpoch: "test-epoch",
			workspaceId: "ws-1",
			sessionHandle: "session-1",
			generation: 1,
			baseSeq: 10,
			asOfSeq: 10,
			runtime: idlePersistedRuntime("session-1"),
			settledMessages: [],
			projectionEvents: [],
			queue: { steering: [], followUp: [] },
			pendingExtensionRequests: [
				{
					type: "extension_ui_request",
					id: "req-1",
					method: "confirm",
					title: "Confirm",
					message: "Allow file write?",
				},
			],
			stickyExtensionState: [],
		});

		// session-2 to session-6 are idle with no pending requests
		for (let i = 2; i <= 6; i++) {
			const handle = `session-${i}`;
			controller.store.getState().subscribeSession(handle);
			controller.ingestServerMessage({
				type: "runtime_state",
				runtime: idlePersistedRuntime(handle),
			});
		}

		// Subscribe session-7: session-1 has pending dialog, so session-2 is evicted instead
		controller.store.getState().subscribeSession("session-7");

		const sessions = controller.store.getState().sessions;
		expect(sessions["session-1"]?.subscribed).toBe(true); // Protected by pendingExtensionRequests guard
		expect(sessions["session-2"]?.subscribed).toBe(false);
		expect(sessions["session-7"]?.subscribed).toBe(true);
	});

	it("allows protected sessions to exceed the soft target when no safe eviction exists", () => {
		const { controller, sockets } = harness();
		controller.store.getState().connect();
		open(sockets[0]);

		// All 6 sessions are running
		for (let i = 1; i <= 6; i++) {
			const handle = `session-${i}`;
			controller.store.getState().subscribeSession(handle);
			controller.ingestServerMessage({
				type: "runtime_state",
				runtime: runningRuntime(handle),
			});
		}

		// Subscribe 7th session
		controller.store.getState().subscribeSession("session-7");

		const sessions = controller.store.getState().sessions;
		// All 7 remain subscribed because no candidate could be evicted safely
		for (let i = 1; i <= 7; i++) {
			expect(sessions[`session-${i}`]?.subscribed).toBe(true);
		}
		expect(sessions["session-7"]?.subscriptionAdmission).toEqual({
			kind: "protected_overage",
			retryable: false,
		});
	});

	it("records a retryable rejected subscription and exposes a manual retry", () => {
		const { controller, sockets } = harness({ maxActiveSubscriptions: 1 });
		controller.store.getState().connect();
		open(sockets[0]);
		const socket = sockets[0];
		if (!socket) throw new Error("transport did not create a socket");

		controller.store.getState().subscribeSession("rejected");
		socket.onmessage?.({
			data: JSON.stringify({
				type: "session_error",
				serverEpoch: "test-epoch",
				sessionHandle: "rejected",
				operation: "subscribe",
				error: "session_subscription_capacity",
			}),
		});

		expect(controller.store.getState().sessions.rejected).toMatchObject({
			subscribed: false,
			subscriptionAdmission: {
				kind: "rejected",
				code: "session_subscription_capacity",
				retryable: true,
			},
		});
		expect(controller.store.getState().retrySessionSubscription?.("rejected")).toBe(true);
		expect(controller.store.getState().sessions.rejected?.subscriptionAdmission).toBeNull();
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "rejected" });
	});

	it("uses structured server error metadata for snapshot retry admission", () => {
		const { controller, sockets } = harness();
		controller.store.getState().connect();
		open(sockets[0]);
		const socket = sockets[0];
		if (!socket) throw new Error("transport did not create a socket");

		controller.store.getState().subscribeSession("snapshot");
		socket.onmessage?.({
			data: JSON.stringify({
				type: "session_error",
				serverEpoch: "test-epoch",
				sessionHandle: "snapshot",
				operation: "subscribe",
				error: "session_snapshot_unavailable",
				code: "session_snapshot_unavailable",
				retryable: true,
			}),
		});

		expect(controller.store.getState().sessions.snapshot?.subscriptionAdmission).toEqual({
			kind: "rejected",
			code: "session_snapshot_unavailable",
			retryable: true,
		});
		expect(controller.store.getState().retrySessionSubscription?.("snapshot")).toBe(true);
		expect(socket.sent.at(-1)).toEqual({ type: "session_subscribe", sessionHandle: "snapshot" });
	});

	it("clears protected overage markers as rejected subscriptions leave the overage", () => {
		const { controller, sockets } = harness({ maxActiveSubscriptions: 1 });
		controller.store.getState().connect();
		open(sockets[0]);
		const socket = sockets[0];
		if (!socket) throw new Error("transport did not create a socket");

		for (const handle of ["first", "second"]) {
			controller.store.getState().subscribeSession(handle);
			controller.ingestServerMessage({
				type: "runtime_state",
				runtime: runningRuntime(handle),
			});
		}
		expect(controller.store.getState().sessions.second?.subscriptionAdmission).toEqual({
			kind: "protected_overage",
			retryable: false,
		});

		socket.onmessage?.({
			data: JSON.stringify({
				type: "session_error",
				serverEpoch: "test-epoch",
				sessionHandle: "first",
				operation: "subscribe",
				error: "session_subscription_capacity",
				code: "session_subscription_capacity",
				retryable: true,
			}),
		});

		expect(controller.store.getState().sessions.first?.subscriptionAdmission).toMatchObject({
			kind: "rejected",
		});
		expect(controller.store.getState().sessions.second?.subscriptionAdmission).toBeNull();
	});

	it("keeps a retryable rejection visible while the transport is offline", () => {
		const { controller, sockets } = harness();
		controller.store.getState().connect();
		open(sockets[0]);
		const socket = sockets[0];
		if (!socket) throw new Error("transport did not create a socket");

		controller.store.getState().subscribeSession("offline-retry");
		socket.onmessage?.({
			data: JSON.stringify({
				type: "session_error",
				serverEpoch: "test-epoch",
				sessionHandle: "offline-retry",
				operation: "subscribe",
				error: "session_subscription_capacity",
				code: "session_subscription_capacity",
				retryable: true,
			}),
		});
		const sentBeforeDisconnect = socket.sent.length;
		socket.close();

		expect(controller.store.getState().retrySessionSubscription?.("offline-retry")).toBe(false);
		expect(controller.store.getState().sessions["offline-retry"]?.subscriptionAdmission).toEqual({
			kind: "rejected",
			code: "session_subscription_capacity",
			retryable: true,
		});
		expect(socket.sent).toHaveLength(sentBeforeDisconnect);
	});

	it("evicts dormant historical sessions when pool exceeds capacity", () => {
		const { controller, sockets } = harness();
		controller.store.getState().connect();
		open(sockets[0]);

		// Subscribe 6 dormant historical sessions
		for (let i = 1; i <= 6; i++) {
			const handle = `session-${i}`;
			controller.store.getState().subscribeSession(handle);
			controller.ingestServerMessage({
				type: "runtime_state",
				runtime: {
					...idlePersistedRuntime(handle),
					state: "dormant",
				},
			});
		}

		// Subscribe 7th session
		controller.store.getState().subscribeSession("session-7");

		const sessions = controller.store.getState().sessions;
		expect(sessions["session-1"]?.subscribed).toBe(false); // LRU dormant session evicted
		expect(sessions["session-7"]?.subscribed).toBe(true);
	});
});
