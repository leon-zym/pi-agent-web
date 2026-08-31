import {
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	type GatewayClientHelloDto,
	type GatewayServerHelloDto,
	type InlineSessionReplayFrameDto,
	type InlineSessionSnapshotDto,
	isInlineSessionSnapshotDto,
	isInlineSessionWsServerMessage,
	type PiExtensionUiRequestDto,
	type PiProductSessionEventDto,
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
	type SessionRuntimeDto,
	type SessionWsClientMessage,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSessionTransport,
	SESSION_FRAME_DEFERRED,
	type SessionTransportController,
	type SessionWebSocket,
} from "../src/stores/session-transport";

const SERVER_EPOCH = "pipeline-epoch";
const SESSION_HANDLE = "pipeline-session";
const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
			protocol: { major: 1, minor: 4 },
			serverBuild: "test",
			serverEpoch: SERVER_EPOCH,
			piVersion: "test",
			adapterId: "test",
			capabilities: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES],
			limits: {
				maxClientFrameBytes: 8 * 1024 * 1024,
				maxSnapshotFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
				maxExtensionRequests: 256,
			},
			payloadBudget: SESSION_PAYLOAD_BUDGET,
			contentRefBudget: SESSION_CONTENT_REF_BUDGET,
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

function runtime(lastSeq: number): SessionRuntimeDto {
	return {
		serverEpoch: SERVER_EPOCH,
		workspaceId: "workspace-a",
		sessionHandle: SESSION_HANDLE,
		generation: 1,
		nativeSessionId: "native-a",
		sessionFile: "/tmp/a.jsonl",
		cwd: "/tmp",
		lastSeq,
		state: "running",
		lastActivityAt: 1,
		recoverable: true,
	};
}

function frame(
	seq: number,
	event: PiProductSessionEventDto,
): Extract<InlineSessionReplayFrameDto, { type: "event" }> {
	return {
		type: "event",
		serverEpoch: SERVER_EPOCH,
		workspaceId: "workspace-a",
		sessionHandle: SESSION_HANDLE,
		generation: 1,
		seq,
		event,
	};
}

function snapshot(
	pendingExtensionRequests: InlineSessionSnapshotDto["pendingExtensionRequests"] = [],
): InlineSessionSnapshotDto {
	return {
		type: "session_snapshot",
		snapshotId: "pipeline-snapshot",
		serverEpoch: SERVER_EPOCH,
		workspaceId: "workspace-a",
		sessionHandle: SESSION_HANDLE,
		generation: 1,
		baseSeq: 0,
		asOfSeq: 2,
		runtime: runtime(2),
		settledMessages: [],
		projectionEvents: [frame(1, { type: "agent_start" }), frame(2, { type: "turn_start" })],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests,
		stickyExtensionState: [],
	};
}

const controllers: SessionTransportController[] = [];

async function setup() {
	vi.resetModules();
	const sockets: FakeSocket[] = [];
	const controller = createSessionTransport({
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		url: () => "ws://pipeline.test",
		protocolVersion: { major: 1, minor: 4 },
	});
	controllers.push(controller);
	vi.doMock("../src/stores/session-transport", async () => ({
		...(await vi.importActual<typeof import("../src/stores/session-transport")>(
			"../src/stores/session-transport",
		)),
		sessionTransport: controller,
		SESSION_FRAME_DEFERRED,
	}));
	const [{ initPipeline }, { useExtensionUiStore }, { useProjectionStore }] = await Promise.all([
		import("../src/lib/stream-pipeline"),
		import("../src/stores/extension-ui"),
		import("../src/stores/projection"),
	]);
	initPipeline();
	const socket = sockets[0];
	if (!socket) throw new Error("pipeline did not connect");
	socket.open();
	controller.store.getState().subscribeSession(SESSION_HANDLE);
	socket.receive({ type: "runtime_state", runtime: runtime(2) });
	socket.receive({
		type: "resync_required",
		serverEpoch: SERVER_EPOCH,
		sessionHandle: SESSION_HANDLE,
		runtime: runtime(2),
		reason: "gap",
	});
	return { controller, socket, useExtensionUiStore, useProjectionStore };
}

afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
	vi.doUnmock("../src/stores/session-transport");
	vi.useRealTimers();
});

describe("stream pipeline snapshot suffix delivery", () => {
	it("publishes a delta-only suffix on its bounded scheduler before confirming recovery", async () => {
		vi.useFakeTimers();
		const { controller, socket, useProjectionStore } = await setup();
		const delta = frame(3, {
			type: "message_update",
			usage: USAGE,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
		} as PiProductSessionEventDto);
		expect(isInlineSessionWsServerMessage(delta)).toBe(true);
		expect(isInlineSessionSnapshotDto(snapshot())).toBe(true);
		socket.receive(delta);
		socket.receive(snapshot());
		await vi.advanceTimersByTimeAsync(0);

		expect(controller.store.getState().sessions[SESSION_HANDLE]).toMatchObject({
			baselineAuthoritative: false,
			lastSeq: 3,
			projectedSeq: 2,
		});
		await vi.advanceTimersByTimeAsync(16);

		expect(controller.store.getState().sessions[SESSION_HANDLE]).toMatchObject({
			baselineAuthoritative: true,
			lastSeq: 3,
			projectedSeq: 3,
			resync: null,
		});
		expect(
			useProjectionStore.getState().projections[SESSION_HANDLE]?.turns[0]?.steps[0]?.blocks[0],
		).toMatchObject({
			type: "text",
			markdown: "hello",
		});
	});

	it("flushes a deferred delta synchronously before a structural suffix boundary", async () => {
		const { controller, socket, useProjectionStore } = await setup();
		const delta = frame(3, {
			type: "message_update",
			usage: USAGE,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" },
		} as PiProductSessionEventDto);
		expect(isInlineSessionWsServerMessage(delta)).toBe(true);
		socket.receive(delta);
		socket.receive(frame(4, { type: "agent_settled" }));
		socket.receive(snapshot());
		await vi.waitFor(() =>
			expect(controller.store.getState().sessions[SESSION_HANDLE]?.baselineAuthoritative).toBe(true),
		);

		expect(controller.store.getState().sessions[SESSION_HANDLE]).toMatchObject({
			baselineAuthoritative: true,
			lastSeq: 4,
			projectedSeq: 4,
			resync: null,
		});
		expect(
			useProjectionStore.getState().projections[SESSION_HANDLE]?.turns[0]?.steps[0]?.blocks[0],
		).toMatchObject({
			type: "text",
			markdown: "done",
		});
	});

	it("does not let an acknowledged skipped request advance past an unconfirmed delta", async () => {
		vi.useFakeTimers();
		const { controller, socket, useExtensionUiStore } = await setup();
		const request: Extract<PiExtensionUiRequestDto, { method: "confirm" }> = {
			type: "extension_ui_request",
			id: "already-answered",
			method: "confirm",
			title: "Confirm",
			message: "Confirm",
		};
		const delta = frame(3, {
			type: "message_update",
			usage: USAGE,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before request" },
		} as PiProductSessionEventDto);
		const requestFrame = {
			type: "extension_ui_request",
			serverEpoch: SERVER_EPOCH,
			workspaceId: "workspace-a",
			sessionHandle: SESSION_HANDLE,
			generation: 1,
			seq: 4,
			request,
		} as const;
		expect(isInlineSessionWsServerMessage(delta)).toBe(true);
		expect(isInlineSessionWsServerMessage(requestFrame)).toBe(true);
		socket.receive(delta);
		socket.receive(requestFrame);
		socket.receive({
			type: "extension_ui_result",
			serverEpoch: SERVER_EPOCH,
			sessionHandle: SESSION_HANDLE,
			generation: 1,
			requestId: request.id,
			outcome: "accepted",
		});
		socket.receive(snapshot([request]));
		await vi.advanceTimersByTimeAsync(0);

		expect(controller.store.getState().sessions[SESSION_HANDLE]).toMatchObject({
			baselineAuthoritative: false,
			lastSeq: 4,
			projectedSeq: 2,
		});
		expect(useExtensionUiStore.getState().bySession[SESSION_HANDLE]?.dialogs).toEqual([]);

		await vi.advanceTimersByTimeAsync(16);
		expect(controller.store.getState().sessions[SESSION_HANDLE]).toMatchObject({
			baselineAuthoritative: true,
			lastSeq: 4,
			projectedSeq: 4,
			pendingExtensionRequests: [],
			resync: null,
		});
		expect(useExtensionUiStore.getState().bySession[SESSION_HANDLE]?.dialogs).toEqual([]);
	});
});
