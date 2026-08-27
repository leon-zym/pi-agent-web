import {
	GATEWAY_PROTOCOL_VERSION,
	type GatewayClientHelloDto,
	type GatewayServerHelloDto,
	type SessionReplayFrameDto,
	type SessionRuntimeDto,
	type SessionSnapshotDto,
	type SessionWsClientMessage,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	createSessionTransport,
	type SessionTransportController,
	type SessionWebSocket,
} from "../src/stores/session-transport";

const SERVER_EPOCH = "epoch-a";

class FakeSocket implements SessionWebSocket {
	readyState = 0;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	readonly sent: Array<SessionWsClientMessage | GatewayClientHelloDto> = [];

	send(data: string): void {
		this.sent.push(JSON.parse(data));
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.();
		this.receive({
			type: "server_hello",
			protocol: GATEWAY_PROTOCOL_VERSION,
			serverBuild: "test",
			serverEpoch: SERVER_EPOCH,
			piVersion: "test",
			adapterId: "test",
			capabilities: [
				"rpc.commands",
				"rpc.events",
				"rpc.extension_ui",
				"session.multiplex",
				"session.hot_runtime_inventory",
			],
			limits: {
				maxClientFrameBytes: 8 * 1024 * 1024,
				maxSnapshotFrameBytes: 32 * 1024 * 1024,
				maxExtensionRequests: 256,
			},
		} satisfies GatewayServerHelloDto);
		this.receive({
			type: "hot_runtime_inventory",
			serverEpoch: SERVER_EPOCH,
			revision: 0,
			runtimes: [],
		});
	}

	receive(message: object): void {
		this.onmessage?.({ data: JSON.stringify(message) });
	}

	close(): void {
		this.readyState = 3;
	}
}

function runtime(lastSeq = 0): SessionRuntimeDto {
	return {
		serverEpoch: SERVER_EPOCH,
		workspaceId: "workspace-a",
		sessionHandle: "session-a",
		generation: 1,
		nativeSessionId: "native-a",
		sessionFile: "/tmp/a.jsonl",
		cwd: "/tmp",
		lastSeq,
		state: "idle",
		lastActivityAt: 1,
		recoverable: true,
	};
}

function snapshot(asOfSeq = 0): SessionSnapshotDto {
	return {
		type: "session_snapshot",
		snapshotId: `snapshot-${String(asOfSeq)}`,
		serverEpoch: SERVER_EPOCH,
		workspaceId: "workspace-a",
		sessionHandle: "session-a",
		generation: 1,
		baseSeq: asOfSeq,
		asOfSeq,
		runtime: runtime(asOfSeq),
		settledMessages: [],
		projectionEvents: [],
		queue: { steering: ["steer"], followUp: ["follow"] },
		pendingExtensionRequests: [],
		stickyExtensionState: [],
	};
}

function event(seq: number): SessionReplayFrameDto {
	return {
		type: "event",
		serverEpoch: SERVER_EPOCH,
		workspaceId: "workspace-a",
		sessionHandle: "session-a",
		generation: 1,
		seq,
		event: { type: "agent_start" },
	};
}

const controllers: SessionTransportController[] = [];

function setup() {
	const sockets: FakeSocket[] = [];
	const controller = createSessionTransport({
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		url: () => "ws://test",
	});
	controllers.push(controller);
	controller.store.getState().connect();
	const socket = sockets[0];
	if (!socket) throw new Error("missing socket");
	socket.open();
	controller.store.getState().subscribeSession("session-a");
	return { controller, socket, sockets };
}

afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
});

describe("authoritative Session snapshot transport", () => {
	it("commits one guarded snapshot before releasing only its contiguous suffix", () => {
		const { controller, socket } = setup();
		const delivered: Array<string | number> = [];
		controller.frameBus.subscribe("session-a", ({ message }) => {
			delivered.push(message.type === "event" ? message.seq : message.type);
		});
		socket.receive({ type: "runtime_state", runtime: runtime(0) });
		socket.receive({
			type: "resync_required",
			serverEpoch: SERVER_EPOCH,
			sessionHandle: "session-a",
			runtime: runtime(0),
			reason: "initial",
		});
		socket.receive(event(1));
		socket.receive(snapshot(0));

		expect(delivered).toEqual(["runtime_state", "resync_required", "session_snapshot", 1]);
		expect(controller.store.getState().sessions["session-a"]).toMatchObject({
			baselineAuthoritative: true,
			lastSeq: 1,
			projectedSeq: 1,
			resync: null,
		});
	});

	it("keeps mutations fail closed before the authoritative baseline", async () => {
		const { controller, socket } = setup();
		socket.receive({ type: "runtime_state", runtime: runtime(0) });
		socket.receive({
			type: "lease_status",
			serverEpoch: SERVER_EPOCH,
			sessionHandle: "session-a",
			generation: 1,
			isController: true,
			fencingToken: "fence-a",
		});

		await expect(
			controller.store.getState().sendCommand("session-a", { type: "prompt", message: "unsafe" }),
		).rejects.toMatchObject({ code: "session_not_ready" });
		expect(
			controller.store.getState().sendExtensionUiResponse("session-a", {
				type: "extension_ui_response",
				id: "dialog-a",
				confirmed: true,
			}),
		).toBe(false);
	});

	it("retains an old-epoch cursor until the server explicitly fences it", () => {
		const { controller, socket, sockets } = setup();
		socket.receive({ type: "runtime_state", runtime: runtime(2) });
		socket.receive({
			type: "resync_required",
			serverEpoch: SERVER_EPOCH,
			sessionHandle: "session-a",
			runtime: runtime(2),
			reason: "initial",
		});
		socket.receive(snapshot(2));
		controller.store.getState().disconnect();
		controller.store.getState().connect();
		const second = sockets[1];
		if (!second) throw new Error("missing reconnect socket");
		second.open();
		const reconnect = second.sent.filter((message) => message.type === "session_subscribe").at(-1);

		expect(reconnect).toMatchObject({
			cursor: { serverEpoch: SERVER_EPOCH, generation: 1, seq: 2 },
		});
	});

	it("exposes a stable manual retry entry point", () => {
		const { controller } = setup();
		expect(controller.store.getState().manualRetryResync("session-a")).toBe(false);
	});
});
