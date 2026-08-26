import type {
	GatewayClientHelloDto,
	SessionRuntimeDto,
	SessionWsClientMessage,
} from "@pi-agent-web/protocol";
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
			protocol: { major: 1, minor: 0 },
			serverBuild: "test-server",
			serverEpoch: "test-epoch",
			piVersion: "0.84.2",
			adapterId: "legacy-rpc-v1",
			capabilities: ["rpc.commands", "rpc.events", "rpc.extension_ui", "session.multiplex"],
			limits: {
				maxClientFrameBytes: 8 * 1024 * 1024,
				maxSnapshotFrameBytes: 32 * 1024 * 1024,
				maxExtensionRequests: 256,
			},
		}),
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

function unpersistedRuntime(sessionHandle: string): SessionRuntimeDto {
	return {
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
			type: "extension_ui_snapshot",
			sessionHandle: "session-1",
			generation: 1,
			requests: [{ id: "req-1", method: "confirm", message: "Allow file write?" } as never],
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
