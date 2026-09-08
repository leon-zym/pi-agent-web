import {
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	GATEWAY_SESSION_HISTORY_CAPABILITY,
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
	sessionHistoryChecksum,
	sessionHistoryMessagesBytes,
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
			capabilities: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES, GATEWAY_SESSION_HISTORY_CAPABILITY],
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

it("materializes and projects a page while another Session remains selected", async () => {
	const { controller, socket, useProjectionStore } = await setup();
	const startedAt = performance.now();
	const trace: unknown[] = [];
	let baselineReady = false;
	const record = (stage: string) => {
		if (baselineReady || (stage !== "baseline-wait-failed" && trace.length >= 31)) return;
		const state = controller.store.getState();
		const channel = state.sessions[SESSION_HANDLE];
		trace.push({
			stage,
			elapsedMs: Math.round(performance.now() - startedAt),
			connection: state.connectionState,
			subscribed: channel?.subscribed,
			generation: channel?.generation,
			baseline: channel?.baselineAuthoritative,
			lastSeq: channel?.lastSeq,
			projectedSeq: channel?.projectedSeq,
			resync: channel?.resync,
			recovery: channel?.recovery && {
				phase: channel.recovery.phase,
				attempt: channel.recovery.attempt,
				lastError: channel.recovery.lastError?.slice(0, 200),
			},
			history: channel?.history && {
				snapshotId: channel.history.snapshotId,
				asOfSeq: channel.history.asOfSeq,
				loading: channel.history.loading,
				loadedMessages: channel.history.loadedMessages,
				error: channel.history.error?.slice(0, 200),
			},
			projectionTurns: useProjectionStore.getState().projections[SESSION_HANDLE]?.turns.length ?? 0,
		});
	};
	record("setup-returned");
	const stopStateTrace = controller.store.subscribe(() => record("channel-change"));
	const stopFrameTrace = controller.frameBus.subscribeAll(({ sessionHandle, message, representation }) => {
		if (sessionHandle === SESSION_HANDLE) record(`bus:${message.type}:${representation}`);
	});
	const receive = socket.receive.bind(socket);
	const receiveTrace = vi.spyOn(socket, "receive").mockImplementation((message) => {
		record(`before:${(message as { type: string }).type}`);
		receive(message);
		record(`after:${(message as { type: string }).type}`);
	});

	try {
		const { useSessionDirectoryStore } = await import("../src/stores/session-directory");
		const { useComposerStore } = await import("../src/stores/composer");
		const latest = [{ role: "user" as const, content: "latest", timestamp: 1 }];
		const older = [{ role: "user" as const, content: "older", timestamp: 0 }];
		const identity = {
			serverEpoch: SERVER_EPOCH,
			workspaceId: "workspace-a",
			sessionHandle: SESSION_HANDLE,
			generation: 1,
			snapshotId: "pipeline-snapshot",
		};
		const history = {
			totalMessages: 2,
			loadedMessages: 1,
			totalBytes: 200,
			loadedBytes: sessionHistoryMessagesBytes(latest),
			nextCursor: "older-cursor",
		};
		const { settledMessages: _messages, ...header } = snapshot();
		socket.receive({ ...header, type: "session_snapshot_begin", baseSeq: 2, projectionEvents: [], history });
		socket.receive({
			...identity,
			type: "session_snapshot_chunk",
			chunkIndex: 0,
			messages: latest,
			itemCount: 1,
			byteCount: history.loadedBytes,
			checksum: sessionHistoryChecksum(latest),
		});
		socket.receive({
			...identity,
			type: "session_snapshot_end",
			chunkCount: 1,
			itemCount: 1,
			byteCount: history.loadedBytes,
			checksum: sessionHistoryChecksum([sessionHistoryChecksum(latest)]),
			nextCursor: history.nextCursor,
		});
		await vi.waitFor(() =>
			expect(controller.store.getState().sessions[SESSION_HANDLE]?.baselineAuthoritative).toBe(true),
		);
		baselineReady = true;
		expect(controller.store.getState().loadOlderSessionHistory(SESSION_HANDLE)).toBe(true);
		const request = socket.sent.find((message) => message.type === "session_history_page");
		if (request?.type !== "session_history_page") throw new Error("missing page request");
		const pageIdentity = { ...identity, requestId: request.id };
		const byteCount = sessionHistoryMessagesBytes(older);
		const checksum = sessionHistoryChecksum(older);
		socket.receive({
			...pageIdentity,
			type: "session_history_page_begin",
			asOfSeq: 2,
			cursor: history.nextCursor,
			history: { ...history, loadedBytes: byteCount, nextCursor: null },
		});
		socket.receive({
			...pageIdentity,
			type: "session_history_page_chunk",
			chunkIndex: 0,
			messages: older,
			itemCount: 1,
			byteCount,
			checksum,
		});
		const otherHandle = "other-session";
		useSessionDirectoryStore.setState({
			currentWorkspaceHandle: "workspace-a",
			currentSession: {
				sessionHandle: otherHandle,
				workspaceHandle: "workspace-a",
				nativeSessionId: "other-native",
				sessionFile: "/tmp/other.jsonl",
				persisted: true,
				createdAt: null,
				modifiedAt: null,
				messageCount: 0,
				firstMessage: "",
				runtime: null,
			},
			selectedSessionByWorkspace: { "workspace-a": otherHandle },
		});
		useComposerStore.getState().beginSession(otherHandle);
		useComposerStore.getState().setDraft("Keep while history loads");
		expect(
			useProjectionStore
				.getState()
				.projections[SESSION_HANDLE]?.turns.map((turn) => turn.userMessages[0]?.text),
		).toEqual(["latest"]);
		// Release only the end while selection stays elsewhere. This crosses the production
		// content materializer, ordered bus and pipeline before inspecting the hidden projection.
		socket.receive({
			...pageIdentity,
			type: "session_history_page_end",
			chunkCount: 1,
			itemCount: 1,
			byteCount,
			checksum: sessionHistoryChecksum([checksum]),
			nextCursor: null,
		});
		await vi.waitFor(() =>
			expect(controller.store.getState().sessions[SESSION_HANDLE]?.history).toMatchObject({
				loading: false,
				loadedMessages: 2,
				nextCursor: null,
			}),
		);
		expect(
			useProjectionStore
				.getState()
				.projections[SESSION_HANDLE]?.turns.map((turn) => turn.userMessages[0]?.text),
		).toEqual(["older", "latest"]);
		expect(useSessionDirectoryStore.getState().currentSession?.sessionHandle).toBe(otherHandle);
		expect(useSessionDirectoryStore.getState().selectedSessionByWorkspace["workspace-a"]).toBe(otherHandle);
		expect(useComposerStore.getState().draft).toBe("Keep while history loads");
		expect(socket.sent.filter((message) => message.type === "session_history_page")).toHaveLength(1);
	} catch (error) {
		if (!baselineReady) {
			record("baseline-wait-failed");
			console.error("PAGE_BASELINE_DIAGNOSTIC", JSON.stringify(trace));
		}
		throw error;
	} finally {
		stopStateTrace();
		stopFrameTrace();
		receiveTrace.mockRestore();
	}
});
