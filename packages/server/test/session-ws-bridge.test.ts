import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type {
	HotRuntimeInventoryDto,
	SessionCommandDto,
	SessionCommandResponseDto,
	SessionRuntimeDto,
	SessionWsClientMessage,
	SessionWsServerMessage,
} from "@pi-agent-web/protocol";
import {
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	GATEWAY_SESSION_HISTORY_CAPABILITY,
	RpcError,
	SESSION_PAYLOAD_BUDGET,
	SESSION_TEXT_MAX_BYTES,
	SESSION_WS_SERVER_MAX_BYTES,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MAX_JSONL_SNAPSHOT_LINE_BYTES } from "../src/jsonl.js";
import { legacyRpcV1Adapter } from "../src/legacy-rpc-v1.js";
import { canonicalizeSessionFile, sessionHandleForFile } from "../src/native-session-catalog.js";
import type { ExistingSessionTarget } from "../src/session-runtime-types.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import {
	MAX_SESSION_WS_BUFFERED_BYTES,
	MAX_SESSION_WS_GATEWAY_PENDING_COMMAND_RESPONSE_BYTES,
	MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS,
	MAX_SESSION_WS_METADATA_RESPONSE_HEADROOM_BYTES,
	MAX_SESSION_WS_PENDING_COMMAND_RESPONSE_BYTES,
	SessionWsBridge,
	type SessionWsBridgeOptions,
} from "../src/session-ws-bridge.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");
const TEST_SERVER_EPOCH = "session-ws-bridge-test-epoch";
const temporaryRoots: string[] = [];
const harnesses: Harness[] = [];

type LeaseFrame = Extract<SessionWsServerMessage, { type: "lease_status" }>;
type ResponseFrame = Extract<SessionWsServerMessage, { type: "response" }>;

class NonClosingSocket extends EventEmitter {
	readonly OPEN = WebSocket.OPEN;
	readonly CONNECTING = WebSocket.CONNECTING;
	readyState: number = WebSocket.OPEN;
	bufferedAmount = 0;
	readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
	readonly sent: string[] = [];

	send(payload: string): void {
		this.sent.push(payload);
	}

	close(code?: number, reason?: string): void {
		this.closeCalls.push({ code, reason });
		this.readyState = WebSocket.CLOSING;
	}

	ping(): void {}

	terminate(): void {
		this.readyState = WebSocket.CLOSED;
	}
}

class ControlledSendSocket extends EventEmitter {
	readonly OPEN = WebSocket.OPEN;
	readonly CONNECTING = WebSocket.CONNECTING;
	readyState: number = WebSocket.OPEN;
	bufferedAmount = 0;
	readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
	readonly sentBytes: number[] = [];
	readonly sentPayloads: string[] = [];
	private deferNext = false;
	private deferredCallback: ((error?: Error) => void) | undefined;

	deferNextSend(): void {
		this.deferNext = true;
	}

	send(payload: string, callback?: (error?: Error) => void): void {
		this.sentBytes.push(Buffer.byteLength(payload));
		this.sentPayloads.push(payload);
		if (this.deferNext) {
			this.deferNext = false;
			this.deferredCallback = callback;
			return;
		}
		queueMicrotask(() => callback?.());
	}

	releaseDeferredSend(): void {
		const callback = this.deferredCallback;
		this.deferredCallback = undefined;
		queueMicrotask(() => callback?.());
	}

	close(code?: number, reason?: string): void {
		this.closeCalls.push({ code, reason });
		this.readyState = WebSocket.CLOSING;
	}

	ping(): void {}

	terminate(): void {
		this.readyState = WebSocket.CLOSED;
	}
}

class ClientProbe {
	readonly frames: SessionWsServerMessage[] = [];

	constructor(readonly ws: WebSocket) {
		ws.on("message", (raw) => {
			this.frames.push(JSON.parse(raw.toString()) as SessionWsServerMessage);
		});
	}

	mark(): number {
		return this.frames.length;
	}

	send(message: SessionWsClientMessage): void {
		this.ws.send(JSON.stringify(message));
	}

	async waitForFrame<T extends SessionWsServerMessage>(
		predicate: (frame: SessionWsServerMessage) => frame is T,
		from = 0,
		timeoutMs = 2_000,
	): Promise<T> {
		return eventually(() => this.frames.slice(from).find(predicate), timeoutMs);
	}

	async close(): Promise<void> {
		if (this.ws.readyState === WebSocket.CLOSED) return;
		const closed = new Promise<void>((resolve) => this.ws.once("close", () => resolve()));
		this.ws.close();
		await closed;
	}
}

interface Harness {
	server: http.Server;
	supervisor: SessionSupervisor;
	bridge: SessionWsBridge;
	url: string;
	clients: ClientProbe[];
	connectionEvents: string[];
}

interface BridgeTestLimits {
	maxConnections?: number;
	maxSubscribedChannels?: number;
	maxConcurrentCatchUps?: number;
	maxConcurrentHistoryPages?: number;
	maxSubscriptionAliases?: number;
	maxPendingCommandResponseBytes?: number;
	maxGatewayPendingCommandResponseBytes?: number;
	maxGatewayOutboundBytes?: number;
}

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-session-ws-bridge-"));
	temporaryRoots.push(root);
	return root;
}

function createNativeSession(root: string, cwd: string, nativeSessionId: string): ExistingSessionTarget {
	const sessionDir = path.join(root, "sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, `2026-08-20T00-00-00-000Z_${nativeSessionId}.jsonl`);
	fs.writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: nativeSessionId,
			timestamp: "2026-08-20T00:00:00.000Z",
			cwd,
		})}\n`,
	);
	return {
		kind: "existing",
		sessionHandle: sessionHandleForFile(sessionFile),
		workspaceId: `workspace-${path.basename(cwd)}`,
		cwd,
		sessionFile: canonicalizeSessionFile(sessionFile),
		nativeSessionId,
	};
}

function appendLargeNativeHistory(target: ExistingSessionTarget, count: number, textBytes: number): void {
	let parentId: string | null = null;
	const text = "h".repeat(textBytes);
	for (let index = 0; index < count; index += 1) {
		const id = `history-entry-${String(index)}`;
		fs.appendFileSync(
			target.sessionFile,
			`${JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: "2026-08-20T00:00:00.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: `${String(index)}:${text}` }],
					timestamp: index + 1,
				},
			})}\n`,
		);
		parentId = id;
	}
}

function snapshotResponse(textBytes: number): SessionWsServerMessage {
	return {
		type: "session_snapshot",
		snapshotId: "snapshot-id",
		serverEpoch: TEST_SERVER_EPOCH,
		sessionHandle: "snapshot-session",
		workspaceId: "snapshot-workspace",
		generation: 1,
		baseSeq: 0,
		asOfSeq: 0,
		runtime: {
			serverEpoch: TEST_SERVER_EPOCH,
			sessionHandle: "snapshot-session",
			workspaceId: "snapshot-workspace",
			nativeSessionId: "snapshot-native",
			sessionFile: "/snapshot-session.jsonl",
			cwd: "/snapshot-workspace",
			generation: 1,
			lastSeq: 0,
			state: "idle",
			lastActivityAt: 0,
			recoverable: true,
		},
		settledMessages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "x".repeat(textBytes) }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
		],
		projectionEvents: [],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests: [],
		stickyExtensionState: [],
	};
}

function ordinaryLargeEvent(textBytes: number, seq = 1): Extract<SessionWsServerMessage, { type: "event" }> {
	return {
		type: "event",
		serverEpoch: TEST_SERVER_EPOCH,
		sessionHandle: "ordinary-large-session",
		workspaceId: "ordinary-large-workspace",
		generation: 1,
		seq,
		event: {
			type: "tool_execution_update",
			toolCallId: "ordinary-large-tool",
			toolName: "large-result",
			args: {},
			partialResult: "x".repeat(textBytes),
		},
	};
}

function largeGetMessagesResponse(
	textBytes: number,
	id = "large-get-messages",
): Extract<SessionWsServerMessage, { type: "response" }> {
	return {
		type: "response",
		serverEpoch: TEST_SERVER_EPOCH,
		sessionHandle: "large-response-session",
		generation: 1,
		barrierSeq: 0,
		response: {
			type: "response",
			id,
			command: "get_messages",
			success: true,
			data: {
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "x".repeat(textBytes) }],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 0,
					},
				],
			},
		},
	};
}

function bridgeConnection(bridge: SessionWsBridge): {
	connection: unknown;
	send: (connection: unknown, message: SessionWsServerMessage) => void;
} {
	const internals = bridge as unknown as {
		connections: Set<unknown>;
		send: (connection: unknown, message: SessionWsServerMessage) => void;
	};
	const connection = [...internals.connections][0];
	if (!connection) throw new Error("bridge test socket did not create a connection");
	return { connection, send: internals.send.bind(bridge) };
}

function markBridgeConnectionHelloComplete(bridge: SessionWsBridge): void {
	const { connection } = bridgeConnection(bridge);
	(connection as { helloComplete: boolean }).helloComplete = true;
}

function markBridgeConnectionInventoryNegotiated(bridge: SessionWsBridge): void {
	const { connection } = bridgeConnection(bridge);
	Object.assign(connection as object, {
		helloComplete: true,
		hotInventoryNegotiated: true,
		hotInventoryRevision: -1,
	});
}

async function createHarness(
	targets: ExistingSessionTarget[],
	options: {
		replayLimit?: number;
		serverEpoch?: string;
		env?: Record<string, string>;
		projectionLimits?: { maxLiveEventItems?: number };
		maxAutoRestarts?: number;
		historyCapability?: boolean;
		bridge?: BridgeTestLimits;
	} = {},
): Promise<Harness> {
	const connectionEvents: string[] = [];
	const targetMap = new Map(targets.map((target) => [target.sessionHandle, target]));
	let bridge: SessionWsBridge;
	const supervisor = new SessionSupervisor({
		serverEpoch: options.serverEpoch ?? TEST_SERVER_EPOCH,
		resolved: {
			command: process.execPath,
			args: [fixturePath],
			source: "pi-path",
			label: "session runtime fixture",
			adapter: legacyRpcV1Adapter,
			version: "0.84.2",
			adapterId: "legacy-rpc-v1",
			compatibilityStatus: "current",
			capabilities: legacyRpcV1Adapter.capabilities,
		},
		resolveSession: async (sessionHandle) => targetMap.get(sessionHandle),
		env: options.env,
		broadcast: (message) => bridge.broadcast(message),
		onHotRuntimeInventory: (inventory) => bridge.broadcastHotRuntimeInventory(inventory),
		replayLimit: options.replayLimit ?? 32,
		projectionLimits: options.projectionLimits,
		maxAutoRestarts: options.maxAutoRestarts,
		readyTimeoutMs: 2_000,
		idleTtlMs: 60_000,
	});
	bridge = new SessionWsBridge({
		supervisor,
		serverBuild: "0.1.0-test",
		runtime: {
			version: "0.84.2",
			adapterId: "legacy-rpc-v1",
			capabilities: [
				"rpc.commands",
				"rpc.events",
				"rpc.extension_ui",
				"session.multiplex",
				GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
				...(options.historyCapability ? [GATEWAY_SESSION_HISTORY_CAPABILITY] : []),
			],
		},
		payloadActivation: {
			context: {
				serverEpoch: options.serverEpoch ?? TEST_SERVER_EPOCH,
				payloadBudget: SESSION_PAYLOAD_BUDGET,
			},
		},
		heartbeatIntervalMs: 60_000,
		log: (_level, message) => connectionEvents.push(message),
		...(options.bridge ?? {}),
	} satisfies SessionWsBridgeOptions);

	const server = http.createServer();
	server.on("upgrade", (request, socket, head) => {
		bridge.wss.handleUpgrade(request, socket, head, (ws) => {
			bridge.wss.emit("connection", ws, request);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const port = (server.address() as AddressInfo).port;
	const harness = {
		server,
		supervisor,
		bridge,
		url: `ws://127.0.0.1:${String(port)}`,
		clients: [],
		connectionEvents,
	};
	harnesses.push(harness);
	return harness;
}

async function openClient(
	harness: Harness,
	options: { historyCapability?: boolean } = {},
): Promise<ClientProbe> {
	const ws = new WebSocket(harness.url);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const hello = new Promise<Record<string, unknown>>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("server_hello timed out")), 2_000);
		ws.once("message", (raw) => {
			clearTimeout(timeout);
			resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
		});
	});
	ws.send(
		JSON.stringify({
			type: "client_hello",
			protocol: { major: 1, minor: 2 },
			clientBuild: "0.1.0-test",
			capabilities: [
				"rpc.commands",
				"rpc.events",
				"rpc.extension_ui",
				"session.multiplex",
				GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
				...(options.historyCapability ? [GATEWAY_SESSION_HISTORY_CAPABILITY] : []),
			],
			limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
		}),
	);
	if ((await hello).type !== "server_hello") throw new Error("Gateway rejected test client hello");
	const probe = new ClientProbe(ws);
	harness.clients.push(probe);
	return probe;
}

async function openInventoryClient(
	harness: Harness,
	overrides: {
		minor?: number;
		capability?: boolean;
		maxServerFrameBytes?: number;
	} = {},
): Promise<ClientProbe> {
	const ws = new WebSocket(harness.url);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const probe = new ClientProbe(ws);
	harness.clients.push(probe);
	ws.send(
		JSON.stringify({
			type: "client_hello",
			protocol: { major: 1, minor: overrides.minor ?? 2 },
			clientBuild: "0.1.0-inventory-test",
			capabilities: [
				"rpc.commands",
				"rpc.events",
				"rpc.extension_ui",
				"session.multiplex",
				GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
				...(overrides.capability === false ? [] : [GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY]),
			],
			limits: {
				maxServerFrameBytes: overrides.maxServerFrameBytes ?? SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
			},
		}),
	);
	return probe;
}

async function subscribe(
	client: ClientProbe,
	sessionHandle: string,
	cursor?: { serverEpoch?: string; generation: number; seq: number },
	timeoutMs = 2_000,
): Promise<{ runtime: SessionRuntimeDto; lease: LeaseFrame; frames: SessionWsServerMessage[] }> {
	const mark = client.mark();
	client.send({
		type: "session_subscribe",
		sessionHandle,
		...(cursor ? { cursor: { serverEpoch: cursor.serverEpoch ?? TEST_SERVER_EPOCH, ...cursor } } : {}),
	});
	const lease = await client.waitForFrame(
		(frame): frame is LeaseFrame => frame.type === "lease_status" && frame.sessionHandle === sessionHandle,
		mark,
		timeoutMs,
	);
	const frames = client.frames.slice(mark);
	const runtimeFrames = frames.filter(
		(frame): frame is Extract<SessionWsServerMessage, { type: "runtime_state" }> =>
			frame.type === "runtime_state" && frame.runtime.sessionHandle === sessionHandle,
	);
	const runtime = runtimeFrames.at(-1)?.runtime;
	if (!runtime) throw new Error(`subscription ${sessionHandle} did not include runtime_state`);
	return { runtime, lease, frames };
}

async function claim(client: ClientProbe, sessionHandle: string): Promise<LeaseFrame> {
	const mark = client.mark();
	client.send({ type: "session_claim", sessionHandle });
	return client.waitForFrame(
		(frame): frame is LeaseFrame => frame.type === "lease_status" && frame.sessionHandle === sessionHandle,
		mark,
	);
}

async function command(
	client: ClientProbe,
	sessionHandle: string,
	expectedGeneration: number,
	rpcCommand: SessionCommandDto,
	fencingToken?: string,
): Promise<ResponseFrame> {
	const mark = client.mark();
	client.send({
		type: "command",
		sessionHandle,
		expectedGeneration,
		...(fencingToken ? { fencingToken } : {}),
		command: rpcCommand,
	});
	return client.waitForFrame(
		(frame): frame is ResponseFrame => frame.type === "response" && frame.response.id === rpcCommand.id,
		mark,
	);
}

async function eventually<T>(read: () => T | undefined | false, timeoutMs = 2_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined && value !== false) return value;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition did not settle before timeout");
}

afterEach(async () => {
	for (const harness of harnesses.splice(0).reverse()) {
		for (const client of harness.clients) {
			if (client.ws.readyState !== WebSocket.CLOSED) client.ws.terminate();
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		await harness.bridge.close();
		await harness.supervisor.stopAll();
		await new Promise<void>((resolve) => harness.server.close(() => resolve()));
	}
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SessionWsBridge", () => {
	it("rejects a connection above the Gateway socket budget with a retryable close", async () => {
		const harness = await createHarness([], { bridge: { maxConnections: 1 } });
		await openClient(harness);

		const rejected = new WebSocket(harness.url);
		const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
			rejected.once("error", reject);
			rejected.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
		});

		expect(await closed).toEqual({ code: 1013, reason: "gateway capacity" });
	});

	it("streams a large native snapshot and serves an older history page atomically", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "chunked-history-ws");
		appendLargeNativeHistory(target, 110, 600 * 1024);
		const harness = await createHarness([target], { historyCapability: true });
		const client = await openClient(harness, { historyCapability: true });
		const subscription = await subscribe(client, target.sessionHandle, undefined, 15_000);
		const begin = subscription.frames.find(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_snapshot_begin" }> =>
				frame.type === "session_snapshot_begin",
		);
		const snapshotChunks = subscription.frames.filter(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_snapshot_chunk" }> =>
				frame.type === "session_snapshot_chunk",
		);
		const end = subscription.frames.find(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_snapshot_end" }> =>
				frame.type === "session_snapshot_end",
		);
		expect(begin?.history).toMatchObject({ totalMessages: 110, loadedMessages: 96 });
		expect(snapshotChunks.length).toBeGreaterThan(1);
		expect(snapshotChunks.reduce((total, chunk) => total + chunk.messages.length, 0)).toBe(96);
		expect(end).toMatchObject({ chunkCount: snapshotChunks.length, itemCount: 96 });
		if (!begin || !end) throw new Error("chunked snapshot markers were not delivered");

		const mark = client.mark();
		client.send({
			type: "session_history_page",
			id: "history-page-1",
			sessionHandle: target.sessionHandle,
			expectedGeneration: begin.generation,
			snapshotId: begin.snapshotId,
			asOfSeq: begin.asOfSeq,
			cursor: begin.history.nextCursor!,
			limit: 8,
		});
		const pageEnd = await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_history_page_end" }> =>
				frame.type === "session_history_page_end" && frame.requestId === "history-page-1",
			mark,
		);
		const pageBegin = client.frames
			.slice(mark)
			.find(
				(frame): frame is Extract<SessionWsServerMessage, { type: "session_history_page_begin" }> =>
					frame.type === "session_history_page_begin" && frame.requestId === "history-page-1",
			);
		const pageChunks = client.frames
			.slice(mark)
			.filter(
				(frame): frame is Extract<SessionWsServerMessage, { type: "session_history_page_chunk" }> =>
					frame.type === "session_history_page_chunk" && frame.requestId === "history-page-1",
			);
		expect(pageBegin?.history).toMatchObject({ loadedMessages: 8 });
		expect(pageChunks.reduce((total, chunk) => total + chunk.messages.length, 0)).toBe(8);
		expect(pageEnd).toMatchObject({ chunkCount: pageChunks.length, itemCount: 8 });
	});

	it("single-flights history reads and holds admission until cancelled I/O settles", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "history-single-flight");
		appendLargeNativeHistory(target, 110, 600 * 1024);
		const harness = await createHarness([target], {
			historyCapability: true,
			bridge: { maxConcurrentHistoryPages: 2 },
		});
		const first = await openClient(harness, { historyCapability: true });
		const subscription = await subscribe(first, target.sessionHandle, undefined, 15_000);
		const begin = subscription.frames.find(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_snapshot_begin" }> =>
				frame.type === "session_snapshot_begin",
		);
		if (!begin?.history.nextCursor) throw new Error("history fixture did not expose an older page");
		const second = await openClient(harness, { historyCapability: true });
		const internals = harness.bridge as unknown as {
			connections: Set<{
				ws: WebSocket;
				subscriptions: Set<string>;
				historyNegotiated: boolean;
				historySnapshots: Map<
					string,
					{
						snapshotId: string;
						workspaceId: string;
						generation: number;
						asOfSeq: number;
						chunked: {
							readPage: (...args: unknown[]) => Promise<unknown>;
						};
					}
				>;
			}>;
		};
		const connections = [...internals.connections];
		const [firstState, secondState] = connections;
		const history = firstState?.historySnapshots.get(target.sessionHandle);
		if (!firstState || !secondState || !history) throw new Error("history Bridge state was unavailable");
		secondState.subscriptions.add(target.sessionHandle);
		secondState.historyNegotiated = true;
		secondState.historySnapshots.set(target.sessionHandle, history);
		const originalReadPage = history.chunked.readPage.bind(history.chunked);
		let readCalls = 0;
		let firstReadStarted: (() => void) | undefined;
		const firstReadEntered = new Promise<void>((resolve) => {
			firstReadStarted = resolve;
		});
		let settleFirstRead: (() => void) | undefined;
		const firstReadSettlement = new Promise<void>((resolve) => {
			settleFirstRead = resolve;
		});
		history.chunked.readPage = async (...args: unknown[]) => {
			readCalls += 1;
			if (readCalls === 1) {
				firstReadStarted?.();
				// FileHandle.read cannot be interrupted by AbortSignal. Model the real
				// ownership boundary by settling only when the underlying read completes.
				await firstReadSettlement;
			}
			return originalReadPage(...args);
		};
		const pageRequest = (id: string): SessionWsClientMessage => ({
			type: "session_history_page",
			id,
			sessionHandle: target.sessionHandle,
			expectedGeneration: begin.generation,
			snapshotId: begin.snapshotId,
			asOfSeq: begin.asOfSeq,
			cursor: begin.history.nextCursor!,
			limit: 2,
		});

		first.send(pageRequest("history-held"));
		await firstReadEntered;
		const secondMark = second.mark();
		second.send(pageRequest("history-busy"));
		const busy = await second.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" && frame.operation === "history_page",
			secondMark,
		);
		expect(busy.code).toBe("session_history_busy");
		expect(busy.retryable).toBe(true);
		expect(readCalls).toBe(1);
		const otherSessionHandle = "history-independent-session";
		secondState.subscriptions.add(otherSessionHandle);
		secondState.historySnapshots.set(otherSessionHandle, {
			...history,
			snapshotId: "history-independent-snapshot",
		});
		const independentMark = second.mark();
		second.send({
			type: "session_history_page",
			id: "history-independent",
			sessionHandle: otherSessionHandle,
			expectedGeneration: begin.generation,
			snapshotId: "history-independent-snapshot",
			asOfSeq: begin.asOfSeq,
			cursor: begin.history.nextCursor,
			limit: 2,
		});
		await second.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_history_page_end" }> =>
				frame.type === "session_history_page_end" && frame.requestId === "history-independent",
			independentMark,
		);
		expect(readCalls).toBe(2);

		await first.close();
		const heldOperations = (
			harness.bridge as unknown as {
				historyPageOperations: Map<string, unknown>;
			}
		).historyPageOperations;
		expect(heldOperations.size).toBe(1);
		const cancelledMark = second.mark();
		second.send(pageRequest("history-still-settling"));
		const stillBusy = await second.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" && frame.operation === "history_page",
			cancelledMark,
		);
		expect(stillBusy.code).toBe("session_history_busy");
		expect(readCalls).toBe(2);
		settleFirstRead?.();
		await eventually(() => heldOperations.size === 0);
		const retryMark = second.mark();
		second.send(pageRequest("history-retry"));
		await second.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_history_page_end" }> =>
				frame.type === "session_history_page_end" && frame.requestId === "history-retry",
			retryMark,
		);
		expect(readCalls).toBe(3);
	});

	it("recovers snapshot overflow through an explicit generation-and-lease-fenced restart", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "overflow-bridge-restart");
		const harness = await createHarness([target], {
			projectionLimits: { maxLiveEventItems: 8 },
			maxAutoRestarts: 0,
			env: { PI_WEB_FIXTURE_OVERFLOW_MARKER: path.join(root, "overflow-once.marker") },
		});
		const client = await openClient(harness);
		const initial = await subscribe(client, target.sessionHandle);
		const lease = await claim(client, target.sessionHandle);
		if (!lease.fencingToken) throw new Error("overflow fixture did not acquire a controller lease");

		const overflowMark = client.mark();
		client.send({
			type: "command",
			sessionHandle: target.sessionHandle,
			expectedGeneration: initial.runtime.generation,
			fencingToken: lease.fencingToken,
			command: { type: "prompt", id: "overflow-command", message: "overflow-once" },
		});
		await eventually(() => harness.supervisor.getRuntime(target.sessionHandle)?.state === "crashed");
		const overflowed = harness.supervisor.getRuntime(target.sessionHandle)!;
		expect(overflowed.error).toBe("session_snapshot_overflow");
		await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "resync_required" }> =>
				frame.type === "resync_required" && frame.runtime.generation === overflowed.generation,
			overflowMark,
		);
		const releaseMark = client.mark();
		client.send({ type: "session_release", sessionHandle: target.sessionHandle });
		await client.waitForFrame(
			(frame): frame is LeaseFrame =>
				frame.type === "lease_status" &&
				frame.sessionHandle === target.sessionHandle &&
				frame.isController === false,
			releaseMark,
		);
		const observer = await openClient(harness);
		const observerMark = observer.mark();
		observer.send({ type: "session_subscribe", sessionHandle: target.sessionHandle });
		await observer.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" &&
				frame.operation === "subscribe" &&
				frame.code === "session_snapshot_overflow",
			observerMark,
		);
		const rejectedRestartMark = observer.mark();
		observer.send({
			type: "session_restart",
			sessionHandle: target.sessionHandle,
			expectedGeneration: overflowed.generation,
		});
		const rejectedRestart = await observer.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" && frame.operation === "restart",
			rejectedRestartMark,
		);
		expect(rejectedRestart.code).toBe("session_read_only");
		expect(harness.supervisor.getRuntime(target.sessionHandle)?.generation).toBe(overflowed.generation);

		const observerLease = await claim(observer, target.sessionHandle);
		expect(observerLease).toMatchObject({
			generation: overflowed.generation,
			isController: true,
		});
		await observer.close();
		const successor = await openClient(harness);
		const successorMark = successor.mark();
		successor.send({ type: "session_subscribe", sessionHandle: target.sessionHandle });
		await successor.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" &&
				frame.operation === "subscribe" &&
				frame.code === "session_snapshot_overflow",
			successorMark,
		);
		const successorLease = await claim(successor, target.sessionHandle);
		if (!successorLease.fencingToken) {
			throw new Error("inactive overflow claim did not acquire a fenced controller lease");
		}

		const restartMark = successor.mark();
		const observerRecoveryMark = client.mark();
		successor.send({
			type: "session_restart",
			sessionHandle: target.sessionHandle,
			expectedGeneration: overflowed.generation,
			fencingToken: successorLease.fencingToken,
		});
		const restarted = await successor.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "runtime_state" }> =>
				frame.type === "runtime_state" &&
				frame.runtime.generation === overflowed.generation + 1 &&
				frame.runtime.state === "idle",
			restartMark,
			5_000,
		);
		expect(restarted.runtime).toMatchObject({ state: "idle" });
		expect(restarted.runtime.error).toBeUndefined();
		await successor.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_snapshot" }> =>
				frame.type === "session_snapshot" && frame.generation === restarted.runtime.generation,
			restartMark,
			5_000,
		);
		await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_snapshot" }> =>
				frame.type === "session_snapshot" && frame.generation === restarted.runtime.generation,
			observerRecoveryMark,
			5_000,
		);
	});

	it("rejects a subscription above the shared channel budget without disturbing existing channels", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "subscription-capacity-first");
		const second = createNativeSession(root, cwd, "subscription-capacity-second");
		const harness = await createHarness([first, second], { bridge: { maxSubscribedChannels: 1 } });
		const client = await openClient(harness);
		await subscribe(client, first.sessionHandle);

		const mark = client.mark();
		client.send({ type: "session_subscribe", sessionHandle: second.sessionHandle });
		const error = await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" &&
				frame.sessionHandle === second.sessionHandle &&
				frame.operation === "subscribe",
			mark,
		);

		expect(error.error).toBe("session_subscription_capacity");
		expect(error.code).toBe("session_subscription_capacity");
		expect(error.retryable).toBe(true);
		const { connection } = bridgeConnection(harness.bridge);
		expect((connection as { subscriptions: Set<string> }).subscriptions).toEqual(
			new Set([first.sessionHandle]),
		);
	});

	it("rejects a catch-up storm at the shared budget and accepts a retry after release", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "catchup-capacity-first");
		const second = createNativeSession(root, cwd, "catchup-capacity-second");
		const harness = await createHarness([first, second], { bridge: { maxConcurrentCatchUps: 1 } });
		const client = await openClient(harness);
		const originalSubscribe = harness.supervisor.subscribe.bind(harness.supervisor);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: (() => void) | undefined;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		harness.supervisor.subscribe = async (...args) => {
			entered?.();
			await gate;
			return originalSubscribe(...args);
		};

		client.send({ type: "session_subscribe", sessionHandle: first.sessionHandle });
		await enteredPromise;
		const rejectedMark = client.mark();
		client.send({ type: "session_subscribe", sessionHandle: second.sessionHandle });
		const rejected = await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" &&
				frame.sessionHandle === second.sessionHandle &&
				frame.operation === "subscribe",
			rejectedMark,
		);
		expect(rejected.error).toBe("session_catchup_capacity");
		expect(rejected.code).toBe("session_catchup_capacity");
		expect(rejected.retryable).toBe(true);

		release?.();
		await client.waitForFrame(
			(frame): frame is LeaseFrame =>
				frame.type === "lease_status" && frame.sessionHandle === first.sessionHandle,
		);
		await subscribe(client, second.sessionHandle);
	});

	it("bounds historical subscription aliases while retaining the current canonical handle", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "alias-capacity");
		const harness = await createHarness([target], { bridge: { maxSubscriptionAliases: 2 } });
		const client = await openClient(harness);
		const initial = await subscribe(client, target.sessionHandle);
		const firstChild = `${target.sessionHandle}-child-1`;
		const secondChild = `${target.sessionHandle}-child-2`;
		const rekey = (previousSessionHandle: string, sessionHandle: string): void => {
			harness.bridge.broadcast({
				type: "session_rekeyed",
				previousSessionHandle,
				runtime: { ...initial.runtime, sessionHandle },
			} as Parameters<SessionWsBridge["broadcast"]>[0]);
		};

		rekey(target.sessionHandle, firstChild);
		rekey(firstChild, secondChild);

		const { connection } = bridgeConnection(harness.bridge);
		const state = connection as {
			subscriptions: Set<string>;
			subscriptionAliases: Map<string, string>;
		};
		expect(state.subscriptions).toEqual(new Set([secondChild]));
		expect(state.subscriptionAliases.size).toBeLessThanOrEqual(2);
		expect(state.subscriptionAliases.get(secondChild)).toBe(secondChild);
	});

	it("rejects commands whose weighted pending responses exceed the connection budget", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "pending-response-capacity");
		const harness = await createHarness([target], {
			bridge: { maxPendingCommandResponseBytes: 4 * 1024 * 1024 },
		});
		const client = await openClient(harness);
		const subscription = await subscribe(client, target.sessionHandle);
		const originalSendCommand = harness.supervisor.sendCommand.bind(harness.supervisor);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.supervisor.sendCommand = async (...args) => {
			await gate;
			return originalSendCommand(...args);
		};

		for (const id of ["pending-1", "pending-2"]) {
			client.send({
				type: "command",
				sessionHandle: target.sessionHandle,
				expectedGeneration: subscription.runtime.generation,
				command: { type: "get_state", id },
			});
		}
		const mark = client.mark();
		client.send({
			type: "command",
			sessionHandle: target.sessionHandle,
			expectedGeneration: subscription.runtime.generation,
			command: { type: "get_state", id: "pending-3" },
		});
		const rejected = await client.waitForFrame(
			(frame): frame is ResponseFrame => frame.type === "response" && frame.response.id === "pending-3",
			mark,
		);
		expect(rejected.response).toMatchObject({
			success: false,
			error: "pending_command_response_capacity",
		});

		release?.();
		await client.waitForFrame(
			(frame): frame is ResponseFrame => frame.type === "response" && frame.response.id === "pending-2",
		);
		const largeMark = client.mark();
		client.send({
			type: "command",
			sessionHandle: target.sessionHandle,
			expectedGeneration: subscription.runtime.generation,
			command: { type: "get_tree", id: "pending-large" },
		});
		const largeRejected = await client.waitForFrame(
			(frame): frame is ResponseFrame => frame.type === "response" && frame.response.id === "pending-large",
			largeMark,
		);
		expect(largeRejected.response).toMatchObject({
			success: false,
			error: "pending_command_response_capacity",
		});
	});

	it("reserves the legal bash and command-list response ceilings before RPC execution", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "large-command-response-capacity");
		const harness = await createHarness([target], {
			bridge: {
				maxPendingCommandResponseBytes: SESSION_WS_SERVER_MAX_BYTES,
				maxGatewayPendingCommandResponseBytes: SESSION_WS_SERVER_MAX_BYTES,
			},
		});
		const client = await openClient(harness);
		const subscription = await subscribe(client, target.sessionHandle);
		const lease = await claim(client, target.sessionHandle);
		const originalSendCommand = harness.supervisor.sendCommand.bind(harness.supervisor);
		let entered: (() => void) | undefined;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.supervisor.sendCommand = async (...args) => {
			entered?.();
			await gate;
			return originalSendCommand(...args);
		};

		client.send({
			type: "command",
			sessionHandle: target.sessionHandle,
			expectedGeneration: subscription.runtime.generation,
			fencingToken: lease.fencingToken,
			command: { type: "bash", id: "held-bash", command: "printf bounded" },
		});
		await enteredPromise;
		const mark = client.mark();
		client.send({
			type: "command",
			sessionHandle: target.sessionHandle,
			expectedGeneration: subscription.runtime.generation,
			command: { type: "get_commands", id: "blocked-command-list" },
		});
		const rejected = await client.waitForFrame(
			(frame): frame is ResponseFrame =>
				frame.type === "response" && frame.response.id === "blocked-command-list",
			mark,
		);
		expect(rejected.response).toMatchObject({
			success: false,
			error: "pending_command_response_capacity",
		});
		release?.();
	});

	it("admits the bounded metadata burst used after a Session snapshot", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "metadata-response-capacity");
		const harness = await createHarness([target]);
		const client = await openClient(harness);
		const subscription = await subscribe(client, target.sessionHandle);
		const originalSendCommand = harness.supervisor.sendCommand.bind(harness.supervisor);
		let commandCalls = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.supervisor.sendCommand = async (...args) => {
			commandCalls += 1;
			await gate;
			return originalSendCommand(...args);
		};
		const commands: SessionCommandDto[] = [
			{ type: "get_commands", id: "metadata-commands" },
			{ type: "get_available_models", id: "metadata-models" },
			{ type: "get_state", id: "metadata-state" },
			{ type: "get_available_thinking_levels", id: "metadata-levels" },
			{ type: "get_session_stats", id: "metadata-stats" },
			{ type: "get_last_assistant_text", id: "metadata-racing-read" },
		];

		for (const command of commands) {
			client.send({
				type: "command",
				sessionHandle: target.sessionHandle,
				expectedGeneration: subscription.runtime.generation,
				command,
			});
		}

		await eventually(() => commandCalls === commands.length);
		expect(MAX_SESSION_WS_METADATA_RESPONSE_HEADROOM_BYTES).toBe(16 * SESSION_TEXT_MAX_BYTES);
		expect(MAX_SESSION_WS_PENDING_COMMAND_RESPONSE_BYTES).toBe(
			SESSION_WS_SERVER_MAX_BYTES + MAX_SESSION_WS_METADATA_RESPONSE_HEADROOM_BYTES,
		);
		expect(MAX_SESSION_WS_PENDING_COMMAND_RESPONSE_BYTES).toBeLessThan(
			MAX_SESSION_WS_GATEWAY_PENDING_COMMAND_RESPONSE_BYTES,
		);
		const overflowMark = client.mark();
		client.send({
			type: "command",
			sessionHandle: target.sessionHandle,
			expectedGeneration: subscription.runtime.generation,
			command: { type: "get_state", id: "metadata-overflow" },
		});
		const overflow = await client.waitForFrame(
			(frame): frame is ResponseFrame =>
				frame.type === "response" && frame.response.id === "metadata-overflow",
			overflowMark,
		);
		expect(overflow.response).toMatchObject({
			success: false,
			error: "pending_command_response_capacity",
		});
		expect(commandCalls).toBe(commands.length);
		release?.();
		for (const command of commands) {
			await client.waitForFrame(
				(frame): frame is ResponseFrame => frame.type === "response" && frame.response.id === command.id,
			);
		}
	});

	it("holds the Gateway command reservation across sockets and disconnect", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "gateway-pending-response-capacity");
		const harness = await createHarness([target], {
			bridge: {
				maxPendingCommandResponseBytes: 4 * 1024 * 1024,
				maxGatewayPendingCommandResponseBytes: 2 * 1024 * 1024,
			},
		});
		const first = await openClient(harness);
		const second = await openClient(harness);
		const firstSubscription = await subscribe(first, target.sessionHandle);
		const secondSubscription = await subscribe(second, target.sessionHandle);
		const originalSendCommand = harness.supervisor.sendCommand.bind(harness.supervisor);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: (() => void) | undefined;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		harness.supervisor.sendCommand = async (...args) => {
			entered?.();
			await gate;
			return originalSendCommand(...args);
		};

		first.send({
			type: "command",
			sessionHandle: target.sessionHandle,
			expectedGeneration: firstSubscription.runtime.generation,
			command: { type: "get_state", id: "gateway-pending-first" },
		});
		await enteredPromise;
		await first.close();

		const mark = second.mark();
		second.send({
			type: "command",
			sessionHandle: target.sessionHandle,
			expectedGeneration: secondSubscription.runtime.generation,
			command: { type: "get_state", id: "gateway-pending-second" },
		});
		const rejected = await second.waitForFrame(
			(frame): frame is ResponseFrame =>
				frame.type === "response" && frame.response.id === "gateway-pending-second",
			mark,
		);
		expect(rejected.response).toMatchObject({
			success: false,
			error: "gateway_pending_command_response_capacity",
		});

		release?.();
		await eventually(() => {
			const bridge = harness.bridge as unknown as { gatewayPendingCommandResponseBytes: number };
			return bridge.gatewayPendingCommandResponseBytes === 0;
		});
	});

	it("holds the aggregate command reservation while a serialized response waits on a slow socket", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "outbound-command-reservation");
		const harness = await createHarness([target], {
			bridge: {
				maxPendingCommandResponseBytes: SESSION_WS_SERVER_MAX_BYTES,
				maxGatewayPendingCommandResponseBytes: SESSION_WS_SERVER_MAX_BYTES,
			},
		});
		await harness.supervisor.activate(target.sessionHandle);
		const originalSendCommand = harness.supervisor.sendCommand.bind(harness.supervisor);
		let commandCalls = 0;
		harness.supervisor.sendCommand = async (...args) => {
			commandCalls += 1;
			return originalSendCommand(...args);
		};
		const connectSocket = (socket: ControlledSendSocket) => {
			harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
			const connections = [
				...(harness.bridge as unknown as { connections: Set<Record<string, unknown>> }).connections,
			];
			const connection = connections.at(-1);
			if (!connection) throw new Error("slow socket did not create Bridge state");
			connection.helloComplete = true;
			(connection.subscriptions as Set<string>).add(target.sessionHandle);
			(connection.subscriptionAliases as Map<string, string>).set(target.sessionHandle, target.sessionHandle);
			return connection;
		};
		const request = (id: string) =>
			Buffer.from(
				JSON.stringify({
					type: "command",
					sessionHandle: target.sessionHandle,
					expectedGeneration: harness.supervisor.getRuntime(target.sessionHandle)?.generation ?? 0,
					command: { type: "get_commands", id },
				}),
			);

		const first = new ControlledSendSocket();
		first.deferNextSend();
		connectSocket(first);
		first.emit("message", request("slow-outbound-first"), false);
		await eventually(() => {
			const connection = [
				...(harness.bridge as unknown as { connections: Set<{ outboundSending: boolean }> }).connections,
			][0];
			return commandCalls === 1 && connection?.outboundSending;
		});
		expect(
			(harness.bridge as unknown as { gatewayPendingCommandResponseBytes: number })
				.gatewayPendingCommandResponseBytes,
		).toBe(SESSION_WS_SERVER_MAX_BYTES);

		const second = new ControlledSendSocket();
		connectSocket(second);
		await new Promise<void>((resolve) => setImmediate(resolve));
		second.emit("message", request("slow-outbound-second"), false);
		const rejection = await eventually(() =>
			second.sentPayloads
				.map((payload) => JSON.parse(payload) as SessionWsServerMessage)
				.find((frame) => frame.type === "response" && frame.response.id === "slow-outbound-second"),
		);
		expect(commandCalls).toBe(1);
		expect(rejection).toMatchObject({
			response: { success: false, error: "gateway_pending_command_response_capacity" },
		});

		first.emit("close");
		await eventually(
			() =>
				(harness.bridge as unknown as { gatewayPendingCommandResponseBytes: number })
					.gatewayPendingCommandResponseBytes === 0,
		);
		first.releaseDeferredSend();
	});

	it("sends hello then the initial full hot inventory only after capability negotiation", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-initial");
		const harness = await createHarness([target]);
		await harness.supervisor.activate(target.sessionHandle);
		const client = await openInventoryClient(harness);
		const frames = client.frames as unknown as Array<Record<string, unknown>>;
		const inventory = await eventually(() => frames.find((frame) => frame.type === "hot_runtime_inventory"));

		expect(frames.slice(0, 2).map((frame) => frame.type)).toEqual(["server_hello", "hot_runtime_inventory"]);
		expect(frames[0]).toMatchObject({
			type: "server_hello",
			protocol: { major: 1, minor: 2 },
			capabilities: expect.arrayContaining([GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY]),
		});
		expect(inventory).toMatchObject({
			serverEpoch: TEST_SERVER_EPOCH,
			runtimes: [expect.objectContaining({ sessionHandle: target.sessionHandle, state: "idle" })],
		});
	});

	it("gates inventory by minor, capability, and full-frame receive ceiling", async () => {
		const harness = await createHarness([]);
		for (const client of [await openInventoryClient(harness, { capability: false })]) {
			const frames = client.frames as unknown as Array<Record<string, unknown>>;
			await eventually(() => frames.find((frame) => frame.type === "server_hello"));
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			expect(frames.some((frame) => frame.type === "hot_runtime_inventory")).toBe(false);
		}
		const undersized = await openInventoryClient(harness, {
			maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes - 1,
		});
		const frames = undersized.frames as unknown as Array<Record<string, unknown>>;
		await eventually(() => frames.find((frame) => frame.type === "protocol_error"));
		expect(frames.some((frame) => frame.type === "server_hello")).toBe(false);
	});

	it("broadcasts full revisions to two sockets and unregisters a disconnected watcher", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-two-sockets");
		const harness = await createHarness([target]);
		const left = await openInventoryClient(harness);
		const right = await openInventoryClient(harness);
		const leftFrames = left.frames as unknown as HotRuntimeInventoryDto[];
		const rightFrames = right.frames as unknown as HotRuntimeInventoryDto[];
		await eventually(() => leftFrames.find((frame) => frame.type === "hot_runtime_inventory"));
		await eventually(() => rightFrames.find((frame) => frame.type === "hot_runtime_inventory"));

		await harness.supervisor.activate(target.sessionHandle);
		const leftHot = await eventually(() =>
			leftFrames.find((frame) => frame.type === "hot_runtime_inventory" && frame.runtimes.length === 1),
		);
		const rightHot = await eventually(() =>
			rightFrames.find((frame) => frame.type === "hot_runtime_inventory" && frame.runtimes.length === 1),
		);
		expect(rightHot.revision).toBe(leftHot.revision);

		await left.close();
		const leftCount = leftFrames.length;
		await harness.supervisor.stop(target.sessionHandle);
		await eventually(() =>
			rightFrames.find(
				(frame) =>
					frame.type === "hot_runtime_inventory" &&
					frame.revision > rightHot.revision &&
					frame.runtimes.length === 0,
			),
		);
		expect(leftFrames).toHaveLength(leftCount);
	});

	it("uses exact-hot catch-up without activation and preserves stale cursor reasons", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const active = createNativeSession(root, cwd, "inventory-exact-active");
		const dormant = createNativeSession(root, cwd, "inventory-exact-dormant");
		const lifecycleMarker = path.join(root, "lifecycle.log");
		const harness = await createHarness([active, dormant], {
			env: { PI_WEB_FIXTURE_LIFECYCLE_MARKER: lifecycleMarker },
		});
		await harness.supervisor.activate(active.sessionHandle);
		const client = await openInventoryClient(harness);
		const inventoryFrames = client.frames as unknown as HotRuntimeInventoryDto[];
		const inventory = await eventually(() =>
			inventoryFrames.find((frame) => frame.type === "hot_runtime_inventory" && frame.runtimes.length === 1),
		);
		const hot = inventory.runtimes[0]!;
		const mismatchMark = client.mark();
		client.send({
			type: "session_subscribe",
			sessionHandle: hot.sessionHandle,
			expectedHotRuntime: {
				serverEpoch: hot.serverEpoch,
				sessionHandle: hot.sessionHandle,
				workspaceId: hot.workspaceId,
				generation: hot.generation + 1,
			},
		});
		await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" && frame.error.includes("hot_runtime_identity_changed"),
			mismatchMark,
		);
		const mark = client.mark();
		client.send({
			type: "session_subscribe",
			sessionHandle: hot.sessionHandle,
			expectedHotRuntime: {
				serverEpoch: hot.serverEpoch,
				sessionHandle: hot.sessionHandle,
				workspaceId: hot.workspaceId,
				generation: hot.generation,
			},
			cursor: { serverEpoch: "stale-epoch", generation: hot.generation, seq: 0 },
		});
		await client.waitForFrame((frame): frame is LeaseFrame => frame.type === "lease_status", mark);
		expect(client.frames.slice(mark)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "resync_required", reason: "epoch_changed" }),
				expect.objectContaining({ type: "lease_status", isController: false }),
			]),
		);

		const startsBefore = fs.readFileSync(lifecycleMarker, "utf8").match(/^start:/gm)?.length ?? 0;
		client.send({
			type: "session_subscribe",
			sessionHandle: dormant.sessionHandle,
			expectedHotRuntime: {
				serverEpoch: TEST_SERVER_EPOCH,
				sessionHandle: dormant.sessionHandle,
				workspaceId: dormant.workspaceId,
				generation: 1,
			},
		});
		await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" && frame.error.includes("hot_runtime_not_found"),
			mark,
		);
		const startsAfter = fs.readFileSync(lifecycleMarker, "utf8").match(/^start:/gm)?.length ?? 0;
		expect(startsAfter).toBe(startsBefore);
	});

	it("fails an exact-hot catch-up closed when the observed Runtime rekeys", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "inventory-exact-rekey");
		const harness = await createHarness([parent]);
		const owner = await openClient(harness);
		const ownerSubscription = await subscribe(owner, parent.sessionHandle);
		const ownerLease = await claim(owner, parent.sessionHandle);
		const observer = await openInventoryClient(harness);
		const inventoryFrames = observer.frames as unknown as HotRuntimeInventoryDto[];
		const inventory = await eventually(() =>
			inventoryFrames.find((frame) => frame.type === "hot_runtime_inventory" && frame.runtimes.length === 1),
		);
		const hot = inventory.runtimes[0]!;
		const originalSubscribeHotExact = harness.supervisor.subscribeHotExact.bind(harness.supervisor);
		let entered: (() => void) | undefined;
		const subscribeEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.supervisor.subscribeHotExact = async (expected, cursor) => {
			entered?.();
			await gate;
			return originalSubscribeHotExact(expected, cursor);
		};
		const mark = observer.mark();
		observer.send({
			type: "session_subscribe",
			sessionHandle: hot.sessionHandle,
			expectedHotRuntime: {
				serverEpoch: hot.serverEpoch,
				sessionHandle: hot.sessionHandle,
				workspaceId: hot.workspaceId,
				generation: hot.generation,
			},
		});
		await subscribeEntered;
		const child = await command(
			owner,
			parent.sessionHandle,
			ownerSubscription.runtime.generation,
			{ id: "exact-rekey-race", type: "clone" },
			ownerLease.fencingToken,
		);
		release?.();
		await observer.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" && frame.error.includes("hot_runtime_not_found"),
			mark,
		);
		const racedFrames = observer.frames.slice(mark);
		const rekeyIndex = racedFrames.findIndex(
			(frame) => frame.type === "session_rekeyed" && frame.runtime.sessionHandle === child.sessionHandle,
		);
		const childInventoryIndex = racedFrames.findIndex(
			(frame) =>
				frame.type === "hot_runtime_inventory" &&
				frame.runtimes.some((runtime) => runtime.sessionHandle === child.sessionHandle),
		);
		expect(rekeyIndex).toBeGreaterThanOrEqual(0);
		expect(childInventoryIndex).toBeGreaterThan(rekeyIndex);
		expect(
			racedFrames.some(
				(frame) => frame.type === "runtime_state" && frame.runtime.sessionHandle === child.sessionHandle,
			),
		).toBe(false);
	});

	it("fails an exact-hot catch-up closed across stop and restart", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-exact-restart");
		const harness = await createHarness([target]);
		await harness.supervisor.activate(target.sessionHandle);
		const observer = await openInventoryClient(harness);
		const inventoryFrames = observer.frames as unknown as HotRuntimeInventoryDto[];
		const inventory = await eventually(() =>
			inventoryFrames.find((frame) => frame.type === "hot_runtime_inventory" && frame.runtimes.length === 1),
		);
		const hot = inventory.runtimes[0]!;
		const originalSubscribeHotExact = harness.supervisor.subscribeHotExact.bind(harness.supervisor);
		let entered: (() => void) | undefined;
		const subscribeEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.supervisor.subscribeHotExact = async (expected, cursor) => {
			entered?.();
			await gate;
			return originalSubscribeHotExact(expected, cursor);
		};
		const mark = observer.mark();
		observer.send({
			type: "session_subscribe",
			sessionHandle: hot.sessionHandle,
			expectedHotRuntime: {
				serverEpoch: hot.serverEpoch,
				sessionHandle: hot.sessionHandle,
				workspaceId: hot.workspaceId,
				generation: hot.generation,
			},
		});
		await subscribeEntered;
		await harness.supervisor.stop(target.sessionHandle);
		const restarted = await harness.supervisor.restart(target.sessionHandle);
		release?.();
		await observer.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" && frame.error.includes("hot_runtime_identity_changed"),
			mark,
		);
		expect(
			observer.frames
				.slice(mark)
				.some((frame) => frame.type === "runtime_state" && frame.runtime.generation === restarted.generation),
		).toBe(false);
	});

	it("treats exact-hot subscribe for an existing claimed live member as an idempotent no-op", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-exact-preserve-live");
		const harness = await createHarness([target]);
		const client = await openInventoryClient(harness);
		const subscription = await subscribe(client, target.sessionHandle);
		const lease = await claim(client, target.sessionHandle);
		if (!lease.fencingToken) throw new Error("claimed fixture lease did not include a fencing token");

		const operationMark = client.mark();
		client.send({
			type: "session_subscribe",
			sessionHandle: target.sessionHandle,
			expectedHotRuntime: {
				serverEpoch: TEST_SERVER_EPOCH,
				sessionHandle: target.sessionHandle,
				workspaceId: target.workspaceId,
				generation: subscription.runtime.generation + 1,
			},
		});
		const response = await command(
			client,
			target.sessionHandle,
			subscription.runtime.generation,
			{ id: "exact-failure-preserves-live", type: "prompt", message: "small-structural-turn" },
			lease.fencingToken,
		);
		expect(response.response.success).toBe(true);
		await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "event" }> =>
				frame.type === "event" && frame.event.type === "agent_settled",
			operationMark,
		);
		expect(client.frames.slice(operationMark).some((frame) => frame.type === "session_error")).toBe(false);
		expect(
			client.frames
				.slice(operationMark)
				.filter((frame) => frame.type === "event" && frame.event.type === "agent_settled"),
		).toHaveLength(1);
	});

	it("allows only one fresh exact-hot transaction per handle", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-exact-single-flight");
		const harness = await createHarness([target]);
		await harness.supervisor.activate(target.sessionHandle);
		const observer = await openInventoryClient(harness);
		const inventory = await eventually(() =>
			(observer.frames as unknown as HotRuntimeInventoryDto[]).find(
				(frame) => frame.type === "hot_runtime_inventory" && frame.runtimes.length === 1,
			),
		);
		const hot = inventory.runtimes[0]!;
		const expectedHotRuntime = {
			serverEpoch: hot.serverEpoch,
			sessionHandle: hot.sessionHandle,
			workspaceId: hot.workspaceId,
			generation: hot.generation,
		};
		const originalSubscribeHotExact = harness.supervisor.subscribeHotExact.bind(harness.supervisor);
		let calls = 0;
		let entered: (() => void) | undefined;
		const firstEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.supervisor.subscribeHotExact = async (expected, cursor) => {
			calls += 1;
			entered?.();
			await gate;
			return originalSubscribeHotExact(expected, cursor);
		};

		observer.send({
			type: "session_subscribe",
			sessionHandle: hot.sessionHandle,
			expectedHotRuntime,
		});
		await firstEntered;
		const secondMark = observer.mark();
		observer.send({
			type: "session_subscribe",
			sessionHandle: hot.sessionHandle,
			expectedHotRuntime,
		});
		setTimeout(() => release?.(), 50);
		await observer.waitForFrame(
			(frame): frame is LeaseFrame =>
				frame.type === "lease_status" && frame.sessionHandle === hot.sessionHandle,
			secondMark,
		);
		expect(calls).toBe(1);
		expect(observer.frames.slice(secondMark).some((frame) => frame.type === "session_error")).toBe(false);
	});

	it("delivers a non-replayable notify exactly once during fresh exact-hot catch-up", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-exact-notify");
		const harness = await createHarness([target]);
		const owner = await openClient(harness);
		const ownerSubscription = await subscribe(owner, target.sessionHandle);
		const ownerLease = await claim(owner, target.sessionHandle);
		const observer = await openInventoryClient(harness);
		const inventory = await eventually(() =>
			(observer.frames as unknown as HotRuntimeInventoryDto[]).find(
				(frame) => frame.type === "hot_runtime_inventory" && frame.runtimes.length === 1,
			),
		);
		const hot = inventory.runtimes[0]!;
		const originalSubscribeHotExact = harness.supervisor.subscribeHotExact.bind(harness.supervisor);
		let entered: (() => void) | undefined;
		const subscribeEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.supervisor.subscribeHotExact = async (expected, cursor) => {
			entered?.();
			await gate;
			return originalSubscribeHotExact(expected, cursor);
		};

		const mark = observer.mark();
		observer.send({
			type: "session_subscribe",
			sessionHandle: hot.sessionHandle,
			expectedHotRuntime: {
				serverEpoch: hot.serverEpoch,
				sessionHandle: hot.sessionHandle,
				workspaceId: hot.workspaceId,
				generation: hot.generation,
			},
		});
		await subscribeEntered;
		await command(
			owner,
			target.sessionHandle,
			ownerSubscription.runtime.generation,
			{ id: "notify-during-exact", type: "prompt", message: "notify-then-event" },
			ownerLease.fencingToken,
		);
		release?.();
		await observer.waitForFrame(
			(frame): frame is LeaseFrame =>
				frame.type === "lease_status" && frame.sessionHandle === hot.sessionHandle,
			mark,
		);
		expect(
			observer.frames
				.slice(mark)
				.filter(
					(frame) =>
						frame.type === "extension_ui_request" && frame.request.id === `notify-${target.nativeSessionId}`,
				),
		).toHaveLength(1);
	});

	it("caps fresh exact-hot transactions per connection before Supervisor admission", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-exact-inflight-cap");
		const harness = await createHarness([target]);
		const observer = await openInventoryClient(harness);
		const originalSubscribeHotExact = harness.supervisor.subscribeHotExact.bind(harness.supervisor);
		let calls = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.supervisor.subscribeHotExact = async (expected, cursor) => {
			calls += 1;
			await gate;
			return originalSubscribeHotExact(expected, cursor);
		};
		const identity = (index: number) => ({
			serverEpoch: TEST_SERVER_EPOCH,
			sessionHandle: `${target.sessionHandle}-${String(index)}`,
			workspaceId: target.workspaceId,
			generation: 1,
		});
		expect(MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS).toBeLessThanOrEqual(256);
		for (let index = 0; index < MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS; index += 1) {
			const expectedHotRuntime = identity(index);
			observer.send({
				type: "session_subscribe",
				sessionHandle: expectedHotRuntime.sessionHandle,
				expectedHotRuntime,
			});
		}
		await eventually(() => calls === MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS);
		const mark = observer.mark();
		const overflow = identity(MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS);
		observer.send({
			type: "session_subscribe",
			sessionHandle: overflow.sessionHandle,
			expectedHotRuntime: overflow,
		});
		setTimeout(() => release?.(), 50);
		await observer.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" &&
				frame.sessionHandle === overflow.sessionHandle &&
				frame.error.includes("too_many_in_flight_exact_subscriptions"),
			mark,
		);
		expect(calls).toBe(MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS);
	});

	it("holds exact-hot admission capacity until Supervisor promises settle after unsubscribe", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-exact-operation-cap");
		const harness = await createHarness([target]);
		await harness.supervisor.activate(target.sessionHandle);
		const observer = await openInventoryClient(harness);
		const inventory = await eventually(() =>
			(observer.frames as unknown as HotRuntimeInventoryDto[]).find(
				(frame) => frame.type === "hot_runtime_inventory" && frame.runtimes.length === 1,
			),
		);
		const hot = inventory.runtimes[0]!;
		const originalSubscribeHotExact = harness.supervisor.subscribeHotExact.bind(harness.supervisor);
		let calls = 0;
		let completed = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.supervisor.subscribeHotExact = async (expected, cursor) => {
			calls += 1;
			await gate;
			try {
				return await originalSubscribeHotExact(expected, cursor);
			} finally {
				completed += 1;
			}
		};
		const identity = (index: number) => ({
			serverEpoch: TEST_SERVER_EPOCH,
			sessionHandle: `${target.sessionHandle}-operation-${String(index)}`,
			workspaceId: target.workspaceId,
			generation: hot.generation,
		});
		for (let index = 0; index < MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS; index += 1) {
			const expectedHotRuntime = identity(index);
			observer.send({
				type: "session_subscribe",
				sessionHandle: expectedHotRuntime.sessionHandle,
				expectedHotRuntime,
			});
			observer.send({ type: "session_unsubscribe", sessionHandle: expectedHotRuntime.sessionHandle });
		}
		await eventually(() => calls === MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS);
		const mark = observer.mark();
		const overflow = identity(MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS);
		observer.send({
			type: "session_subscribe",
			sessionHandle: overflow.sessionHandle,
			expectedHotRuntime: overflow,
		});
		setTimeout(() => release?.(), 50);
		await observer.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" &&
				frame.sessionHandle === overflow.sessionHandle &&
				frame.error.includes("too_many_in_flight_exact_subscriptions"),
			mark,
		);
		expect(calls).toBe(MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS);
		await eventually(() => completed === MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS);

		const recoveryMark = observer.mark();
		observer.send({
			type: "session_subscribe",
			sessionHandle: hot.sessionHandle,
			expectedHotRuntime: {
				serverEpoch: hot.serverEpoch,
				sessionHandle: hot.sessionHandle,
				workspaceId: hot.workspaceId,
				generation: hot.generation,
			},
		});
		await observer.waitForFrame(
			(frame): frame is LeaseFrame =>
				frame.type === "lease_status" && frame.sessionHandle === hot.sessionHandle,
			recoveryMark,
		);
		expect(calls).toBe(MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS + 1);
	});

	it("does not release admitted exact-hot capacity when its connection disconnects", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-exact-disconnect-cap");
		const harness = await createHarness([target]);
		await harness.supervisor.activate(target.sessionHandle);
		const observer = await openInventoryClient(harness);
		const inventory = await eventually(() =>
			(observer.frames as unknown as HotRuntimeInventoryDto[]).find(
				(frame) => frame.type === "hot_runtime_inventory" && frame.runtimes.length === 1,
			),
		);
		const hot = inventory.runtimes[0]!;
		const { connection } = bridgeConnection(harness.bridge);
		const operationState = connection as { admittedExactOperations?: number };
		const originalSubscribeHotExact = harness.supervisor.subscribeHotExact.bind(harness.supervisor);
		let entered: (() => void) | undefined;
		const subscribeEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.supervisor.subscribeHotExact = async (expected, cursor) => {
			entered?.();
			await gate;
			return originalSubscribeHotExact(expected, cursor);
		};
		observer.send({
			type: "session_subscribe",
			sessionHandle: hot.sessionHandle,
			expectedHotRuntime: {
				serverEpoch: hot.serverEpoch,
				sessionHandle: hot.sessionHandle,
				workspaceId: hot.workspaceId,
				generation: hot.generation,
			},
		});
		await subscribeEntered;
		expect(operationState.admittedExactOperations).toBe(1);
		await observer.close();
		expect(operationState.admittedExactOperations).toBe(1);
		release?.();
		await eventually(() => operationState.admittedExactOperations === 0);
	});

	it("treats exact-hot subscribe during a slow ordinary catch-up as an idempotent no-op", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-exact-preserve-catchup");
		const harness = await createHarness([target], {
			env: { PI_WEB_FIXTURE_READY_DELAY_MS: "400" },
		});
		const activation = harness.supervisor.activate(target.sessionHandle);
		void activation.catch(() => {});
		const observer = await openInventoryClient(harness);
		const inventory = await eventually(() =>
			(observer.frames as HotRuntimeInventoryDto[]).find(
				(frame) =>
					frame.type === "hot_runtime_inventory" &&
					frame.runtimes.some(
						(runtime) => runtime.sessionHandle === target.sessionHandle && runtime.state === "starting",
					),
			),
		);
		const hot = inventory.runtimes.find((runtime) => runtime.sessionHandle === target.sessionHandle)!;
		const originalSubscribe = harness.supervisor.subscribe.bind(harness.supervisor);
		let ordinaryEntered: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			ordinaryEntered = resolve;
		});
		let baselineCaptured: (() => void) | undefined;
		const captured = new Promise<void>((resolve) => {
			baselineCaptured = resolve;
		});
		let releaseOrdinary: (() => void) | undefined;
		const ordinaryGate = new Promise<void>((resolve) => {
			releaseOrdinary = resolve;
		});
		let firstSubscribe = true;
		harness.supervisor.subscribe = async (sessionHandle, cursor) => {
			if (!firstSubscribe) return originalSubscribe(sessionHandle, cursor);
			firstSubscribe = false;
			ordinaryEntered?.();
			const result = await originalSubscribe(sessionHandle, cursor);
			baselineCaptured?.();
			await ordinaryGate;
			return result;
		};

		const ordinaryMark = observer.mark();
		observer.send({ type: "session_subscribe", sessionHandle: target.sessionHandle });
		await entered;
		observer.send({
			type: "session_subscribe",
			sessionHandle: target.sessionHandle,
			expectedHotRuntime: {
				serverEpoch: hot.serverEpoch,
				sessionHandle: hot.sessionHandle,
				workspaceId: hot.workspaceId,
				generation: hot.generation,
			},
		});
		await activation;
		await captured;

		const owner = await openClient(harness);
		const ownerSubscription = await subscribe(owner, target.sessionHandle);
		const ownerLease = await claim(owner, target.sessionHandle);
		await command(
			owner,
			target.sessionHandle,
			ownerSubscription.runtime.generation,
			{ id: "ordinary-catchup-suffix", type: "prompt", message: "small-structural-turn" },
			ownerLease.fencingToken,
		);
		const current = await eventually(() => {
			const runtime = harness.supervisor.getRuntime(target.sessionHandle);
			return runtime?.state === "idle" && runtime.lastSeq > 0 ? runtime : undefined;
		});
		releaseOrdinary?.();
		const lease = await observer.waitForFrame(
			(frame): frame is LeaseFrame =>
				frame.type === "lease_status" && frame.sessionHandle === target.sessionHandle,
			ordinaryMark,
		);
		await observer.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "event" }> =>
				frame.type === "event" &&
				frame.sessionHandle === target.sessionHandle &&
				frame.seq === current.lastSeq,
			ordinaryMark,
		);
		expect(lease.isController).toBe(false);
		expect(observer.frames.slice(ordinaryMark).some((frame) => frame.type === "session_error")).toBe(false);
		const sequences = observer.frames
			.slice(ordinaryMark)
			.flatMap((frame) => (frame.type === "event" ? [frame.seq] : []));
		expect(sequences).toEqual(Array.from({ length: current.lastSeq }, (_value, index) => index + 1));
	});

	it("rejects exact-hot subscribe unless inventory observation was negotiated", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-exact-capability-gate");
		const harness = await createHarness([target]);
		const runtime = await harness.supervisor.activate(target.sessionHandle);
		for (const client of [await openInventoryClient(harness, { capability: false })]) {
			await eventually(() =>
				(client.frames as unknown as Array<{ type: string }>).find((frame) => frame.type === "server_hello"),
			);
			const mark = client.mark();
			client.send({
				type: "session_subscribe",
				sessionHandle: target.sessionHandle,
				expectedHotRuntime: {
					serverEpoch: TEST_SERVER_EPOCH,
					sessionHandle: target.sessionHandle,
					workspaceId: target.workspaceId,
					generation: runtime.generation,
				},
			});
			await client.waitForFrame(
				(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
					frame.type === "session_error" && frame.error.includes("hot_runtime_inventory_not_negotiated"),
				mark,
			);
			expect(client.frames.slice(mark).some((frame) => frame.type === "runtime_state")).toBe(false);
		}
	});

	it("revalidates exact Pi ownership after baseline capture and before publishing it", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "inventory-exact-post-return-race");
		const harness = await createHarness([target]);
		await harness.supervisor.activate(target.sessionHandle);
		const observer = await openInventoryClient(harness);
		const inventory = await eventually(() =>
			(observer.frames as HotRuntimeInventoryDto[]).find(
				(frame) => frame.type === "hot_runtime_inventory" && frame.runtimes.length === 1,
			),
		);
		const hot = inventory.runtimes[0]!;
		const originalSubscribeHotExact = harness.supervisor.subscribeHotExact.bind(harness.supervisor);
		let baselineReturned: (() => void) | undefined;
		const returned = new Promise<void>((resolve) => {
			baselineReturned = resolve;
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.supervisor.subscribeHotExact = async (expected, cursor) => {
			const result = await originalSubscribeHotExact(expected, cursor);
			baselineReturned?.();
			await gate;
			return result;
		};

		const mark = observer.mark();
		observer.send({
			type: "session_subscribe",
			sessionHandle: target.sessionHandle,
			expectedHotRuntime: {
				serverEpoch: hot.serverEpoch,
				sessionHandle: hot.sessionHandle,
				workspaceId: hot.workspaceId,
				generation: hot.generation,
			},
		});
		await returned;
		await harness.supervisor.stop(target.sessionHandle);
		release?.();
		await observer.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" && frame.error.includes("hot_runtime_identity_changed"),
			mark,
		);
		expect(observer.frames.slice(mark).some((frame) => frame.type === "runtime_state")).toBe(false);
	});

	it("bounds shutdown when a peer never completes the close handshake", async () => {
		const harness = await createHarness([]);
		const client = await openClient(harness);
		const socket = (client.ws as unknown as { _socket?: { pause: () => void } })._socket;
		if (!socket) throw new Error("ws test client did not expose its transport socket");
		socket.pause();

		const startedAt = Date.now();
		await harness.bridge.close();

		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	it("sends the authoritative cold-start baseline before startup broadcasts", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "cold-start-order");
		const harness = await createHarness([target]);
		const client = await openClient(harness);

		const subscription = await subscribe(client, target.sessionHandle);
		const scopedTypes = subscription.frames.flatMap((frame) => {
			if (frame.type === "runtime_state" && frame.runtime.sessionHandle === target.sessionHandle) {
				return [frame.type];
			}
			if ("sessionHandle" in frame && frame.sessionHandle === target.sessionHandle) {
				return [frame.type];
			}
			return [];
		});

		expect(subscription.runtime.state).toBe("idle");
		expect(scopedTypes).toEqual(["runtime_state", "resync_required", "session_snapshot", "lease_status"]);
		const snapshot = subscription.frames.find((frame) => frame.type === "session_snapshot");
		expect(snapshot).toMatchObject({
			serverEpoch: TEST_SERVER_EPOCH,
			sessionHandle: target.sessionHandle,
			baseSeq: 0,
			asOfSeq: subscription.runtime.lastSeq,
		});
	});

	it("fences a cursor issued by Gateway A when the same Session reconnects to Gateway B", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "previous-gateway-epoch");
		const gatewayA = await createHarness([target], { serverEpoch: "gateway-a-epoch" });
		const owner = await openClient(gatewayA);
		const initial = await subscribe(owner, target.sessionHandle);
		const lease = await claim(owner, target.sessionHandle);
		await command(
			owner,
			target.sessionHandle,
			initial.runtime.generation,
			{ id: "gateway-a-events", type: "prompt", message: "events" },
			lease.fencingToken,
		);
		const gatewayACursor = await eventually(() => {
			const runtime = gatewayA.supervisor.getRuntime(target.sessionHandle);
			return runtime?.state === "idle" && runtime.lastSeq > 0
				? {
						serverEpoch: runtime.serverEpoch,
						generation: runtime.generation,
						seq: runtime.lastSeq,
					}
				: undefined;
		});
		await owner.close();
		await gatewayA.bridge.close();
		await gatewayA.supervisor.stopAll();
		await new Promise<void>((resolve) => gatewayA.server.close(() => resolve()));
		const gatewayAIndex = harnesses.indexOf(gatewayA);
		if (gatewayAIndex >= 0) harnesses.splice(gatewayAIndex, 1);

		const gatewayB = await createHarness([target], { serverEpoch: "gateway-b-epoch" });
		const observer = await openClient(gatewayB);
		const restarted = await subscribe(observer, target.sessionHandle, gatewayACursor);
		expect(restarted.frames).toContainEqual(
			expect.objectContaining({
				type: "resync_required",
				serverEpoch: "gateway-b-epoch",
				reason: "epoch_changed",
			}),
		);
		expect(restarted.frames).toContainEqual(
			expect.objectContaining({
				type: "session_snapshot",
				serverEpoch: "gateway-b-epoch",
				asOfSeq: restarted.runtime.lastSeq,
			}),
		);
		expect(
			restarted.frames.filter(
				(frame) =>
					frame.type === "event" ||
					frame.type === "extension_ui_request" ||
					frame.type === "extension_ui_closed",
			),
		).toEqual([]);
	});

	it("fails a stale generation cursor closed with one fresh snapshot and zero replay", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "stale-generation-cursor");
		const harness = await createHarness([target]);
		const client = await openClient(harness);
		const initial = await subscribe(client, target.sessionHandle);
		client.send({ type: "session_unsubscribe", sessionHandle: target.sessionHandle });
		await harness.supervisor.stop(target.sessionHandle);

		const restarted = await subscribe(client, target.sessionHandle, {
			generation: initial.runtime.generation,
			seq: initial.runtime.lastSeq,
		});

		expect(restarted.runtime.generation).toBeGreaterThan(initial.runtime.generation);
		expect(restarted.frames.filter((frame) => frame.type === "resync_required")).toEqual([
			expect.objectContaining({ reason: "generation_changed" }),
		]);
		expect(restarted.frames.filter((frame) => frame.type === "session_snapshot")).toHaveLength(1);
		expect(
			restarted.frames.filter(
				(frame) =>
					frame.type === "event" ||
					frame.type === "extension_ui_request" ||
					frame.type === "extension_ui_closed",
			),
		).toEqual([]);
	});

	it.each(["thinking", "text", "tool", "dialog"] as const)(
		"gives an active %s checkpoint observer an equivalent snapshot and one contiguous suffix",
		async (stage) => {
			const root = temporaryRoot();
			const cwd = path.join(root, "workspace");
			const checkpointDir = path.join(root, "checkpoints");
			fs.mkdirSync(cwd);
			fs.mkdirSync(checkpointDir);
			const target = createNativeSession(root, cwd, `active-${stage}-snapshot`);
			const harness = await createHarness([target], {
				env: { PI_WEB_FIXTURE_CHECKPOINT_DIR: checkpointDir },
			});
			const owner = await openClient(harness);
			const observer = await openClient(harness);
			const ownerSubscription = await subscribe(owner, target.sessionHandle);
			const ownerLease = await claim(owner, target.sessionHandle);
			const ownerMark = owner.mark();

			await command(
				owner,
				target.sessionHandle,
				ownerSubscription.runtime.generation,
				{ id: `checkpoint-${stage}`, type: "prompt", message: `snapshot-checkpoint:${stage}` },
				ownerLease.fencingToken,
			);
			await eventually(() => {
				const frames = owner.frames.slice(ownerMark);
				if (stage === "thinking") {
					return frames.some(
						(frame) =>
							frame.type === "event" &&
							frame.event.type === "message_update" &&
							frame.event.assistantMessageEvent.type === "thinking_delta",
					);
				}
				if (stage === "text") {
					return frames.some(
						(frame) =>
							frame.type === "event" &&
							frame.event.type === "message_update" &&
							frame.event.assistantMessageEvent.type === "text_delta",
					);
				}
				if (stage === "tool") {
					return frames.some(
						(frame) => frame.type === "event" && frame.event.type === "tool_execution_update",
					);
				}
				return frames.some(
					(frame) => frame.type === "extension_ui_request" && frame.request.method === "confirm",
				);
			});

			const observed = await subscribe(observer, target.sessionHandle);
			const snapshot = observed.frames.find(
				(frame): frame is Extract<SessionWsServerMessage, { type: "session_snapshot" }> =>
					frame.type === "session_snapshot",
			);
			if (!snapshot) throw new Error(`${stage} subscription did not include a Session snapshot`);
			expect(snapshot).toMatchObject({
				serverEpoch: TEST_SERVER_EPOCH,
				sessionHandle: target.sessionHandle,
				workspaceId: target.workspaceId,
				generation: ownerSubscription.runtime.generation,
				baseSeq: 0,
				asOfSeq: snapshot.runtime.lastSeq,
				runtime: { state: stage === "dialog" ? "waiting_ui" : "running" },
			});
			const ownerProjection = owner.frames
				.slice(ownerMark)
				.filter(
					(frame): frame is Extract<SessionWsServerMessage, { type: "event" }> =>
						frame.type === "event" && frame.seq <= snapshot.asOfSeq,
				);
			expect(snapshot.projectionEvents).toEqual(ownerProjection);

			const snapshotEvents = snapshot.projectionEvents.map((frame) => frame.event);
			expect(snapshotEvents).toContainEqual(expect.objectContaining({ type: "agent_start" }));
			if (stage !== "thinking") {
				expect(snapshotEvents).toContainEqual(
					expect.objectContaining({
						type: "message_update",
						assistantMessageEvent: expect.objectContaining({
							type: "text_delta",
							delta: "checkpoint-text",
						}),
					}),
				);
			}
			if (stage === "tool" || stage === "dialog") {
				expect(snapshotEvents).toContainEqual(
					expect.objectContaining({
						type: "tool_execution_update",
						partialResult: { text: "checkpoint-tool-partial" },
					}),
				);
				expect(snapshotEvents.some((event) => event.type === "tool_execution_end")).toBe(false);
			}
			if (stage === "dialog") {
				const requestId = `checkpoint-dialog-${target.nativeSessionId}`;
				expect(snapshot.pendingExtensionRequests.filter((request) => request.id === requestId)).toHaveLength(
					1,
				);
				expect(
					owner.frames
						.slice(ownerMark)
						.filter((frame) => frame.type === "extension_ui_request" && frame.request.id === requestId),
				).toHaveLength(1);
				expect(
					observed.frames.filter(
						(frame) => frame.type === "extension_ui_request" && frame.request.id === requestId,
					),
				).toEqual([]);
			} else {
				expect(snapshot.pendingExtensionRequests).toEqual([]);
			}

			const suffixMark = observer.mark();
			if (stage === "dialog") {
				const requestId = `checkpoint-dialog-${target.nativeSessionId}`;
				const responseMark = owner.mark();
				owner.send({
					type: "extension_ui_response",
					sessionHandle: target.sessionHandle,
					expectedGeneration: ownerSubscription.runtime.generation,
					fencingToken: ownerLease.fencingToken!,
					response: { type: "extension_ui_response", id: requestId, confirmed: true },
				});
				await owner.waitForFrame(
					(frame): frame is Extract<SessionWsServerMessage, { type: "extension_ui_result" }> =>
						frame.type === "extension_ui_result" &&
						frame.requestId === requestId &&
						frame.outcome === "accepted",
					responseMark,
				);
			}
			fs.writeFileSync(path.join(checkpointDir, `${target.nativeSessionId}-${stage}.release`), "release\n");
			await observer.waitForFrame(
				(frame): frame is Extract<SessionWsServerMessage, { type: "event" }> =>
					frame.type === "event" && frame.event.type === "agent_settled",
				suffixMark,
			);
			const current = await eventually(() => {
				const runtime = harness.supervisor.getRuntime(target.sessionHandle);
				return runtime?.state === "idle" ? runtime : undefined;
			});
			const suffixSequences = observer.frames
				.slice(suffixMark)
				.flatMap((frame) =>
					frame.type === "event" ||
					frame.type === "extension_ui_request" ||
					frame.type === "extension_ui_closed"
						? [frame.seq]
						: [],
				);
			expect(suffixSequences).toEqual(
				Array.from(
					{ length: current.lastSeq - snapshot.asOfSeq },
					(_value, index) => snapshot.asOfSeq + index + 1,
				),
			);
		},
	);

	it("buffers events during catch-up and flushes every newer sequence exactly once", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "catch-up-order");
		const harness = await createHarness([target]);
		const owner = await openClient(harness);
		const observer = await openClient(harness);
		const ownerSubscription = await subscribe(owner, target.sessionHandle);
		const ownerLease = await claim(owner, target.sessionHandle);
		const originalSubscribe = harness.supervisor.subscribe.bind(harness.supervisor);
		let capturedBaseline: (() => void) | undefined;
		const baselineCaptured = new Promise<void>((resolve) => {
			capturedBaseline = resolve;
		});
		let releaseCatchUp: (() => void) | undefined;
		const catchUpGate = new Promise<void>((resolve) => {
			releaseCatchUp = resolve;
		});
		harness.supervisor.subscribe = async (sessionHandle, cursor) => {
			const result = await originalSubscribe(sessionHandle, cursor);
			capturedBaseline?.();
			await catchUpGate;
			return result;
		};

		const observerSubscription = subscribe(observer, target.sessionHandle);
		await baselineCaptured;
		await command(
			owner,
			target.sessionHandle,
			ownerSubscription.runtime.generation,
			{ id: "events-during-catch-up", type: "prompt", message: "events" },
			ownerLease.fencingToken,
		);
		const current = await eventually(() => {
			const runtime = harness.supervisor.getRuntime(target.sessionHandle);
			return runtime?.state === "idle" && runtime.lastSeq >= 4 ? runtime : undefined;
		});
		releaseCatchUp?.();
		const caughtUp = await observerSubscription;
		const scopedFrames = caughtUp.frames.filter((frame) => {
			if (frame.type === "runtime_state") {
				return frame.runtime.sessionHandle === target.sessionHandle;
			}
			return "sessionHandle" in frame && frame.sessionHandle === target.sessionHandle;
		});
		const baselineIndex = scopedFrames.findIndex((frame) => frame.type === "runtime_state");
		const resyncIndex = scopedFrames.findIndex((frame) => frame.type === "resync_required");
		const snapshotIndex = scopedFrames.findIndex((frame) => frame.type === "session_snapshot");
		const leaseIndex = scopedFrames.findIndex((frame) => frame.type === "lease_status");
		const eventSequences = scopedFrames.flatMap((frame) => (frame.type === "event" ? [frame.seq] : []));

		expect([baselineIndex, resyncIndex, snapshotIndex, leaseIndex]).toEqual([0, 1, 2, 3]);
		expect(eventSequences).toEqual(Array.from({ length: current.lastSeq }, (_value, index) => index + 1));
	});

	it("publishes an extension request exactly once across the replay snapshot barrier", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "extension-snapshot-barrier");
		const harness = await createHarness([target]);
		const owner = await openClient(harness);
		const observer = await openClient(harness);
		const ownerSubscription = await subscribe(owner, target.sessionHandle);
		const ownerLease = await claim(owner, target.sessionHandle);
		const originalSubscribe = harness.supervisor.subscribe.bind(harness.supervisor);
		let baselineCaptured: (() => void) | undefined;
		const captured = new Promise<void>((resolve) => {
			baselineCaptured = resolve;
		});
		let releaseCatchUp: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseCatchUp = resolve;
		});
		harness.supervisor.subscribe = async (sessionHandle, cursor) => {
			const result = await originalSubscribe(sessionHandle, cursor);
			baselineCaptured?.();
			await gate;
			return result;
		};

		const observerSubscription = subscribe(observer, target.sessionHandle);
		await captured;
		await command(
			owner,
			target.sessionHandle,
			ownerSubscription.runtime.generation,
			{ id: "dialog-during-catch-up", type: "prompt", message: "open-dialog-no-agent" },
			ownerLease.fencingToken,
		);
		await eventually(() =>
			harness.supervisor
				.getPendingExtensionRequests(target.sessionHandle)
				?.some((request) => request.id === `dialog-${target.nativeSessionId}`),
		);
		releaseCatchUp?.();
		const caughtUp = await observerSubscription;
		const requestId = `dialog-${target.nativeSessionId}`;
		const snapshotOccurrences = caughtUp.frames.flatMap((frame) =>
			frame.type === "session_snapshot"
				? frame.pendingExtensionRequests.filter((request) => request.id === requestId)
				: [],
		).length;
		const liveOccurrences = caughtUp.frames.filter(
			(frame) => frame.type === "extension_ui_request" && frame.request.id === requestId,
		).length;

		expect(snapshotOccurrences + liveOccurrences).toBe(1);
		expect(snapshotOccurrences).toBe(0);
		expect(liveOccurrences).toBe(1);
	});

	it("absorbs parent-to-child rekeys into the final catch-up baseline", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "catch-up-rekey");
		const harness = await createHarness([parent]);
		const owner = await openClient(harness);
		const observer = await openInventoryClient(harness);
		const ownerSubscription = await subscribe(owner, parent.sessionHandle);
		const ownerLease = await claim(owner, parent.sessionHandle);
		const originalSubscribe = harness.supervisor.subscribe.bind(harness.supervisor);
		let baselineCaptured: (() => void) | undefined;
		const captured = new Promise<void>((resolve) => {
			baselineCaptured = resolve;
		});
		let releaseParentBaseline: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseParentBaseline = resolve;
		});
		let subscribeCalls = 0;
		harness.supervisor.subscribe = async (sessionHandle, cursor) => {
			const result = await originalSubscribe(sessionHandle, cursor);
			subscribeCalls += 1;
			if (subscribeCalls !== 1) return result;
			baselineCaptured?.();
			await gate;
			return result;
		};

		const observerMark = observer.mark();
		observer.send({ type: "session_subscribe", sessionHandle: parent.sessionHandle });
		await captured;
		const child = await command(
			owner,
			parent.sessionHandle,
			ownerSubscription.runtime.generation,
			{ id: "fork-child-during-catch-up", type: "fork", entryId: "entry-child" },
			ownerLease.fencingToken,
		);
		const grandchild = await command(
			owner,
			child.sessionHandle,
			child.generation,
			{ id: "fork-grandchild-during-catch-up", type: "fork", entryId: "entry-grandchild" },
			ownerLease.fencingToken,
		);
		releaseParentBaseline?.();
		await observer.waitForFrame(
			(frame): frame is LeaseFrame =>
				frame.type === "lease_status" && frame.sessionHandle === grandchild.sessionHandle,
			observerMark,
		);
		const sessionFrames = observer.frames.slice(observerMark).filter((frame) => {
			if (frame.type === "runtime_state") {
				return frame.runtime.sessionHandle === grandchild.sessionHandle;
			}
			return (
				frame.type === "session_rekeyed" ||
				("sessionHandle" in frame && frame.sessionHandle === grandchild.sessionHandle)
			);
		});

		expect(subscribeCalls).toBe(2);
		expect(sessionFrames.map((frame) => frame.type)).toEqual([
			"session_rekeyed",
			"runtime_state",
			"resync_required",
			"session_snapshot",
			"lease_status",
		]);
		expect(sessionFrames.filter((frame) => frame.type === "session_rekeyed")).toEqual([
			{
				type: "session_rekeyed",
				serverEpoch: TEST_SERVER_EPOCH,
				previousSessionHandle: parent.sessionHandle,
				runtime: expect.objectContaining({ sessionHandle: grandchild.sessionHandle }),
			},
		]);
		const racedFrames = observer.frames.slice(observerMark);
		const rekeyIndex = racedFrames.findIndex(
			(frame) => frame.type === "session_rekeyed" && frame.runtime.sessionHandle === grandchild.sessionHandle,
		);
		const inventoryIndex = racedFrames.findIndex(
			(frame) =>
				frame.type === "hot_runtime_inventory" &&
				frame.runtimes.some((runtime) => runtime.sessionHandle === grandchild.sessionHandle),
		);
		expect(rekeyIndex).toBeGreaterThanOrEqual(0);
		expect(inventoryIndex).toBeGreaterThan(rekeyIndex);
	});

	it("gives concurrent parent subscribers one exact rekey before the resolved baseline", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "concurrent-catch-up-rekey");
		const harness = await createHarness([parent]);
		const owner = await openClient(harness);
		const observers = await Promise.all([openClient(harness), openClient(harness)]);
		const ownerSubscription = await subscribe(owner, parent.sessionHandle);
		const ownerLease = await claim(owner, parent.sessionHandle);
		const originalSubscribe = harness.supervisor.subscribe.bind(harness.supervisor);
		let capturedParentBaselines: (() => void) | undefined;
		const baselinesCaptured = new Promise<void>((resolve) => {
			capturedParentBaselines = resolve;
		});
		let releaseParentBaselines: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseParentBaselines = resolve;
		});
		let blockedParentSubscriptions = 0;
		harness.supervisor.subscribe = async (sessionHandle, cursor) => {
			const result = await originalSubscribe(sessionHandle, cursor);
			if (sessionHandle !== parent.sessionHandle || blockedParentSubscriptions >= observers.length) {
				return result;
			}
			blockedParentSubscriptions += 1;
			if (blockedParentSubscriptions === observers.length) capturedParentBaselines?.();
			await gate;
			return result;
		};

		const observerMarks = observers.map((observer) => observer.mark());
		for (const observer of observers) {
			observer.send({ type: "session_subscribe", sessionHandle: parent.sessionHandle });
		}
		await baselinesCaptured;
		const child = await command(
			owner,
			parent.sessionHandle,
			ownerSubscription.runtime.generation,
			{ id: "fork-child-for-concurrent-catch-up", type: "fork", entryId: "entry-child" },
			ownerLease.fencingToken,
		);
		const grandchild = await command(
			owner,
			child.sessionHandle,
			child.generation,
			{ id: "fork-grandchild-for-concurrent-catch-up", type: "fork", entryId: "entry-grandchild" },
			ownerLease.fencingToken,
		);
		releaseParentBaselines?.();

		for (const [index, observer] of observers.entries()) {
			const mark = observerMarks[index] ?? 0;
			await observer.waitForFrame(
				(frame): frame is LeaseFrame =>
					frame.type === "lease_status" && frame.sessionHandle === grandchild.sessionHandle,
				mark,
			);
			const scopedFrames = observer.frames.slice(mark).filter((frame) => {
				if (frame.type === "session_rekeyed") {
					return frame.previousSessionHandle === parent.sessionHandle;
				}
				if (frame.type === "runtime_state") {
					return frame.runtime.sessionHandle === grandchild.sessionHandle;
				}
				return "sessionHandle" in frame && frame.sessionHandle === grandchild.sessionHandle;
			});

			expect(scopedFrames.map((frame) => frame.type)).toEqual([
				"session_rekeyed",
				"runtime_state",
				"resync_required",
				"session_snapshot",
				"lease_status",
			]);
			expect(scopedFrames.filter((frame) => frame.type === "session_rekeyed")).toEqual([
				{
					type: "session_rekeyed",
					serverEpoch: TEST_SERVER_EPOCH,
					previousSessionHandle: parent.sessionHandle,
					runtime: expect.objectContaining({ sessionHandle: grandchild.sessionHandle }),
				},
			]);
		}
	});

	it("keeps a reopened fork parent isolated from its live child on one socket", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "fork-parent-reopen");
		const harness = await createHarness([parent]);
		const client = await openClient(harness);
		const initial = await subscribe(client, parent.sessionHandle);
		const childLease = await claim(client, parent.sessionHandle);
		const child = await command(
			client,
			parent.sessionHandle,
			initial.runtime.generation,
			{ id: "fork-before-parent-reopen", type: "fork", entryId: "entry-reopen" },
			childLease.fencingToken,
		);

		const activationMark = client.mark();
		await harness.supervisor.activate(parent.sessionHandle);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(
			client.frames
				.slice(activationMark)
				.filter(
					(frame) => frame.type === "runtime_state" && frame.runtime.sessionHandle === parent.sessionHandle,
				),
		).toEqual([]);

		const reopenedParent = await subscribe(client, parent.sessionHandle);
		const parentLease = await claim(client, parent.sessionHandle);
		expect(parentLease.isController).toBe(true);
		const eventMark = client.mark();
		await Promise.all([
			command(
				client,
				child.sessionHandle,
				child.generation,
				{ id: "prompt-fork-child", type: "prompt", message: "child" },
				childLease.fencingToken,
			),
			command(
				client,
				parent.sessionHandle,
				reopenedParent.runtime.generation,
				{ id: "prompt-reopened-parent", type: "prompt", message: "parent" },
				parentLease.fencingToken,
			),
		]);
		await eventually(() => {
			const handles = new Set(
				client.frames
					.slice(eventMark)
					.flatMap((frame) =>
						frame.type === "event" && frame.event.type === "message_update" ? [frame.sessionHandle] : [],
					),
			);
			return handles.size === 2 ? handles : undefined;
		});
		const updateHandles = client.frames
			.slice(eventMark)
			.flatMap((frame) =>
				frame.type === "event" && frame.event.type === "message_update" ? [frame.sessionHandle] : [],
			);

		expect(updateHandles.sort()).toEqual([child.sessionHandle, parent.sessionHandle].sort());
		expect(harness.supervisor.listRuntimes()).toHaveLength(2);
	});

	it("does not migrate a child subscription through a historical parent alias", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "historical-alias-parent");
		const harness = await createHarness([parent]);
		const childOwner = await openClient(harness);
		const parentOwner = await openClient(harness);
		const initial = await subscribe(childOwner, parent.sessionHandle);
		const childLease = await claim(childOwner, parent.sessionHandle);
		const child = await command(
			childOwner,
			parent.sessionHandle,
			initial.runtime.generation,
			{ id: "fork-historical-child", type: "fork", entryId: "entry-historical-child" },
			childLease.fencingToken,
		);
		const reopenedParent = await subscribe(parentOwner, parent.sessionHandle);
		const parentLease = await claim(parentOwner, parent.sessionHandle);
		const childMark = childOwner.mark();
		const grandchild = await command(
			parentOwner,
			parent.sessionHandle,
			reopenedParent.runtime.generation,
			{ id: "fork-independent-grandchild", type: "fork", entryId: "entry-independent-grandchild" },
			parentLease.fencingToken,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(
			childOwner.frames
				.slice(childMark)
				.filter(
					(frame) => frame.type === "session_rekeyed" && frame.previousSessionHandle === parent.sessionHandle,
				),
		).toEqual([]);
		const promptMark = childOwner.mark();
		await command(
			childOwner,
			child.sessionHandle,
			child.generation,
			{ id: "prompt-still-owned-child", type: "prompt", message: "still-child" },
			childLease.fencingToken,
		);
		const childUpdate = await childOwner.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "event" }> =>
				frame.type === "event" &&
				frame.sessionHandle === child.sessionHandle &&
				frame.event.type === "message_update",
			promptMark,
		);

		expect(childUpdate.sessionHandle).toBe(child.sessionHandle);
		expect(grandchild.sessionHandle).not.toBe(child.sessionHandle);
		expect(harness.supervisor.listRuntimes()).toHaveLength(2);
	});

	it("does not complete a delayed subscription after it was unsubscribed", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const delayed = createNativeSession(root, cwd, "unsubscribe-delayed");
		const acknowledgement = createNativeSession(root, cwd, "unsubscribe-ack");
		const harness = await createHarness([delayed, acknowledgement]);
		await harness.supervisor.activate(delayed.sessionHandle);
		await harness.supervisor.activate(acknowledgement.sessionHandle);
		const client = await openClient(harness);
		const originalSubscribe = harness.supervisor.subscribe.bind(harness.supervisor);
		let delayedStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			delayedStarted = resolve;
		});
		let releaseDelayed: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseDelayed = resolve;
		});
		harness.supervisor.subscribe = async (sessionHandle, cursor) => {
			const result = await originalSubscribe(sessionHandle, cursor);
			if (sessionHandle !== delayed.sessionHandle) return result;
			delayedStarted?.();
			await gate;
			return result;
		};

		const mark = client.mark();
		client.send({ type: "session_subscribe", sessionHandle: delayed.sessionHandle });
		await started;
		client.send({ type: "session_unsubscribe", sessionHandle: delayed.sessionHandle });
		await subscribe(client, acknowledgement.sessionHandle);
		releaseDelayed?.();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(
			client.frames.slice(mark).filter((frame) => {
				if (frame.type === "runtime_state") {
					return frame.runtime.sessionHandle === delayed.sessionHandle;
				}
				return "sessionHandle" in frame && frame.sessionHandle === delayed.sessionHandle;
			}),
		).toEqual([]);
	});

	it("lets only the newest delayed subscribe continuation establish the subscription", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "subscribe-superseded");
		const harness = await createHarness([target]);
		await harness.supervisor.activate(target.sessionHandle);
		const client = await openClient(harness);
		const originalSubscribe = harness.supervisor.subscribe.bind(harness.supervisor);
		let firstStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstReturned: (() => void) | undefined;
		const returned = new Promise<void>((resolve) => {
			firstReturned = resolve;
		});
		let callCount = 0;
		harness.supervisor.subscribe = async (sessionHandle, cursor) => {
			const result = await originalSubscribe(sessionHandle, cursor);
			callCount += 1;
			if (callCount !== 1) return result;
			firstStarted?.();
			await firstGate;
			firstReturned?.();
			return result;
		};

		const mark = client.mark();
		client.send({ type: "session_subscribe", sessionHandle: target.sessionHandle });
		await started;
		await subscribe(client, target.sessionHandle);
		releaseFirst?.();
		await returned;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const frames = client.frames.slice(mark);

		expect(frames.filter((frame) => frame.type === "runtime_state")).toHaveLength(1);
		expect(frames.filter((frame) => frame.type === "resync_required")).toHaveLength(1);
		expect(frames.filter((frame) => frame.type === "session_snapshot")).toHaveLength(1);
		expect(frames.filter((frame) => frame.type === "lease_status")).toHaveLength(1);
	});

	it("freezes a catch-up immediately when its bounded buffer overflows", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "catch-up-overflow");
		const harness = await createHarness([target]);
		const originalSubscribe = harness.supervisor.subscribe.bind(harness.supervisor);
		let subscribeStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			subscribeStarted = resolve;
		});
		let releaseSubscribe: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseSubscribe = resolve;
		});
		harness.supervisor.subscribe = async (sessionHandle, cursor) => {
			const result = await originalSubscribe(sessionHandle, cursor);
			subscribeStarted?.();
			await gate;
			return result;
		};
		const socket = new NonClosingSocket();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		const { connection } = bridgeConnection(harness.bridge);
		socket.emit(
			"message",
			Buffer.from(JSON.stringify({ type: "session_subscribe", sessionHandle: target.sessionHandle })),
			false,
		);
		await started;
		const runtime = harness.supervisor.getRuntime(target.sessionHandle);
		if (!runtime) throw new Error("overflow fixture runtime did not activate");
		const oversizedEvent = {
			...ordinaryLargeEvent(MAX_SESSION_WS_BUFFERED_BYTES + 1, runtime.lastSeq + 1),
			sessionHandle: runtime.sessionHandle,
			workspaceId: runtime.workspaceId,
			generation: runtime.generation,
		};

		harness.bridge.broadcast(oversizedEvent);
		expect(socket.closeCalls).toEqual([]);
		harness.bridge.broadcast(oversizedEvent);
		releaseSubscribe?.();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(socket.closeCalls).toEqual([{ code: 1008, reason: "policy violation" }]);
		expect(socket.sent).toEqual([]);
		expect(connection).toMatchObject({
			catchUpSmallBufferedBytes: 0,
			catchUpLargeItems: 0,
		});
		expect((connection as { catchUps: Set<unknown> }).catchUps.size).toBe(0);
		expect(harness.connectionEvents.filter((message) => message.startsWith("ws disconnected"))).toHaveLength(
			1,
		);
	});

	it("flushes one large ordinary event buffered during catch-up", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "catch-up-large-event");
		const harness = await createHarness([target]);
		const originalSubscribe = harness.supervisor.subscribe.bind(harness.supervisor);
		let subscribeStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			subscribeStarted = resolve;
		});
		let releaseSubscribe: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseSubscribe = resolve;
		});
		harness.supervisor.subscribe = async (sessionHandle, cursor) => {
			const result = await originalSubscribe(sessionHandle, cursor);
			subscribeStarted?.();
			await gate;
			return result;
		};
		const socket = new ControlledSendSocket();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		socket.emit(
			"message",
			Buffer.from(JSON.stringify({ type: "session_subscribe", sessionHandle: target.sessionHandle })),
			false,
		);
		await started;
		const runtime = harness.supervisor.getRuntime(target.sessionHandle);
		if (!runtime) throw new Error("large catch-up fixture runtime did not activate");

		harness.bridge.broadcast({
			...ordinaryLargeEvent(MAX_SESSION_WS_BUFFERED_BYTES + 1, runtime.lastSeq + 1),
			sessionHandle: runtime.sessionHandle,
			workspaceId: runtime.workspaceId,
			generation: runtime.generation,
		});
		expect(socket.closeCalls).toEqual([]);
		releaseSubscribe?.();

		await eventually(() => socket.sentBytes.some((bytes) => bytes > MAX_SESSION_WS_BUFFERED_BYTES));
		expect(socket.closeCalls).toEqual([]);
	});

	it("disconnects a peer whose existing outbound backlog already exceeds the limit", async () => {
		const harness = await createHarness([]);
		const socket = new NonClosingSocket();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		socket.bufferedAmount = MAX_SESSION_WS_BUFFERED_BYTES + 1;

		harness.bridge.broadcast({ type: "auth_changed" });

		expect(socket.sent).toEqual([]);
		expect(socket.closeCalls).toEqual([{ code: 1008, reason: "policy violation" }]);
		expect(harness.connectionEvents).toContainEqual(expect.stringContaining("slow WebSocket client"));
	});

	it("sends one ordinary event above the small-backlog budget as the only large frame", async () => {
		const harness = await createHarness([]);
		const socket = new ControlledSendSocket();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		const { connection, send } = bridgeConnection(harness.bridge);

		send(connection, ordinaryLargeEvent(MAX_SESSION_WS_BUFFERED_BYTES + 1));

		expect(socket.sentBytes).toHaveLength(1);
		expect(socket.sentBytes[0]).toBeGreaterThan(MAX_SESSION_WS_BUFFERED_BYTES);
		expect(socket.closeCalls).toEqual([]);
		expect(socket.readyState).toBe(WebSocket.OPEN);
		await eventually(() => (connection as { outboundLargeItems: number }).outboundLargeItems === 0);
		send(connection, ordinaryLargeEvent(MAX_SESSION_WS_BUFFERED_BYTES + 1, 2));
		await eventually(() => socket.sentBytes.length === 2);
		expect(socket.closeCalls).toEqual([]);
	});

	it("applies ordinary frame and backlog ceilings to hot inventory refreshes", async () => {
		const harness = await createHarness([]);
		const socket = new ControlledSendSocket();
		socket.deferNextSend();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionInventoryNegotiated(harness.bridge);

		harness.bridge.broadcastHotRuntimeInventory({
			type: "hot_runtime_inventory",
			serverEpoch: TEST_SERVER_EPOCH,
			revision: 1,
			runtimes: [],
		});
		harness.bridge.broadcastHotRuntimeInventory({
			type: "hot_runtime_inventory",
			serverEpoch: TEST_SERVER_EPOCH,
			revision: 2,
			runtimes: [
				{
					serverEpoch: TEST_SERVER_EPOCH,
					sessionHandle: "queued-hot",
					workspaceId: "queued-workspace",
					generation: 1,
					state: "idle",
				},
			],
		});
		expect(socket.sentBytes).toHaveLength(1);
		expect(socket.closeCalls).toEqual([]);
		socket.releaseDeferredSend();
		await eventually(() => socket.sentBytes.length === 2);
		expect(socket.closeCalls).toEqual([]);

		const oversizedHarness = await createHarness([]);
		const oversizedSocket = new ControlledSendSocket();
		oversizedHarness.bridge.wss.emit(
			"connection",
			oversizedSocket as unknown as WebSocket,
			{} as http.IncomingMessage,
		);
		markBridgeConnectionInventoryNegotiated(oversizedHarness.bridge);
		oversizedHarness.bridge.broadcastHotRuntimeInventory({
			type: "hot_runtime_inventory",
			serverEpoch: TEST_SERVER_EPOCH,
			revision: 1,
			runtimes: [
				{
					serverEpoch: TEST_SERVER_EPOCH,
					sessionHandle: "x".repeat(MAX_SESSION_WS_BUFFERED_BYTES),
					workspaceId: "oversized-workspace",
					generation: 1,
					state: "idle",
				},
			],
		});
		expect(oversizedSocket.sentBytes).toEqual([]);
		expect(oversizedSocket.closeCalls).toEqual([{ code: 1008, reason: "policy violation" }]);
	});

	it("queues one near-limit atomic Session snapshot behind an in-flight frame", async () => {
		const harness = await createHarness([]);
		const socket = new ControlledSendSocket();
		socket.deferNextSend();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		const { connection, send } = bridgeConnection(harness.bridge);

		send(connection, { type: "auth_changed" });
		send(connection, snapshotResponse(MAX_JSONL_SNAPSHOT_LINE_BYTES - 4_096));

		expect(socket.sentBytes).toHaveLength(1);
		expect(socket.closeCalls).toEqual([]);
		socket.releaseDeferredSend();
		await eventually(() => socket.sentBytes.length === 2);
		expect(socket.sentBytes[1]).toBeGreaterThan(MAX_JSONL_SNAPSHOT_LINE_BYTES - 4_096);
		expect(socket.closeCalls).toEqual([]);
		expect(socket.readyState).toBe(WebSocket.OPEN);
	});

	it("bounds aggregate serialized snapshot retention across slow sockets", async () => {
		const harness = await createHarness([], {
			bridge: { maxGatewayOutboundBytes: 3 * 1024 * 1024 },
		});
		const connections = () => [
			...(harness.bridge as unknown as { connections: Set<Record<string, unknown>> }).connections,
		];
		const send = (
			harness.bridge as unknown as {
				send: (connection: unknown, message: SessionWsServerMessage) => void;
			}
		).send.bind(harness.bridge);
		const attach = (socket: ControlledSendSocket) => {
			socket.deferNextSend();
			harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
			const connection = connections().at(-1);
			if (!connection) throw new Error("slow socket did not create Bridge state");
			connection.helloComplete = true;
			return connection;
		};
		const first = new ControlledSendSocket();
		const firstConnection = attach(first);
		send(firstConnection, snapshotResponse(2 * 1024 * 1024));
		expect(first.sentBytes).toHaveLength(1);
		const retained = (harness.bridge as unknown as { gatewayOutboundBytes: number }).gatewayOutboundBytes;
		expect(retained).toBeGreaterThan(2 * 1024 * 1024);

		const second = new ControlledSendSocket();
		const secondConnection = attach(second);
		send(secondConnection, snapshotResponse(2 * 1024 * 1024));
		expect(second.sentBytes).toEqual([]);
		expect(second.closeCalls).toEqual([{ code: 1008, reason: "policy violation" }]);
		expect((harness.bridge as unknown as { gatewayOutboundBytes: number }).gatewayOutboundBytes).toBe(
			retained,
		);

		first.emit("close");
		await eventually(
			() => (harness.bridge as unknown as { gatewayOutboundBytes: number }).gatewayOutboundBytes === 0,
		);
		first.releaseDeferredSend();
	});

	it("keeps the next in-flight history frame inside the stream byte budget", async () => {
		const harness = await createHarness([]);
		const socket = new ControlledSendSocket();
		socket.deferNextSend();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		const { connection, send } = bridgeConnection(harness.bridge);
		const frame: SessionWsServerMessage = {
			type: "session_history_page_end",
			serverEpoch: TEST_SERVER_EPOCH,
			sessionHandle: "history-session",
			workspaceId: "history-workspace",
			generation: 1,
			requestId: "history-request",
			snapshotId: "history-snapshot",
			chunkCount: 0,
			itemCount: 0,
			byteCount: 0,
			checksum: "00000000",
			nextCursor: null,
		};
		const bytes = Buffer.byteLength(JSON.stringify(frame));

		send(connection, frame);
		send(connection, frame);
		expect((connection as { outboundHistoryQueuedBytes: number }).outboundHistoryQueuedBytes).toBe(bytes * 2);

		socket.deferNextSend();
		socket.releaseDeferredSend();
		await eventually(() => socket.sentBytes.length === 2);
		expect(socket.sentBytes).toHaveLength(2);
		expect((connection as { outboundHistoryQueuedBytes: number }).outboundHistoryQueuedBytes).toBe(bytes);
	});

	it("keeps additional backlog bounded while one oversized Session snapshot is queued", async () => {
		const harness = await createHarness([]);
		const socket = new ControlledSendSocket();
		socket.deferNextSend();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		const { connection, send } = bridgeConnection(harness.bridge);
		const backlogFrame = (suffix: string): SessionWsServerMessage => ({
			type: "session_error",
			serverEpoch: TEST_SERVER_EPOCH,
			sessionHandle: "snapshot-session",
			operation: "subscribe",
			error: `${suffix}${"x".repeat(600_000)}`,
		});

		send(connection, { type: "auth_changed" });
		send(connection, snapshotResponse(2_000_000));
		expect(socket.closeCalls).toEqual([]);
		send(connection, backlogFrame("first"));
		expect(socket.closeCalls).toEqual([]);
		send(connection, backlogFrame("second"));

		expect(socket.closeCalls).toEqual([{ code: 1008, reason: "policy violation" }]);
		expect(harness.connectionEvents).toContainEqual(expect.stringContaining("slow WebSocket client"));
	});

	it("allows a large chunked snapshot begin frame within the server frame ceiling", async () => {
		const harness = await createHarness([]);
		const socket = new NonClosingSocket();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		const { connection, send } = bridgeConnection(harness.bridge);
		const sessionHandle = "large-snapshot-begin-session";
		const workspaceId = "large-snapshot-begin-workspace";
		const baseline = snapshotResponse(0);
		if (baseline.type !== "session_snapshot") throw new Error("snapshot fixture is not a snapshot");
		const projectionEvents = Array.from({ length: 2_048 }, (_, index) => ({
			...ordinaryLargeEvent(600, index + 1),
			sessionHandle,
			workspaceId,
		}));
		const begin = {
			type: "session_snapshot_begin",
			serverEpoch: TEST_SERVER_EPOCH,
			sessionHandle,
			workspaceId,
			generation: 1,
			snapshotId: "large-snapshot-begin",
			baseSeq: 0,
			asOfSeq: projectionEvents.length,
			runtime: {
				...baseline.runtime,
				sessionHandle,
				workspaceId,
				lastSeq: projectionEvents.length,
			},
			projectionEvents,
			queue: { steering: [], followUp: [] },
			pendingExtensionRequests: [],
			stickyExtensionState: [],
			history: {
				totalMessages: 0,
				loadedMessages: 0,
				loadedBytes: 0,
				totalBytes: 0,
				nextCursor: null,
			},
		} as SessionWsServerMessage;

		expect(Buffer.byteLength(JSON.stringify(begin))).toBeGreaterThan(MAX_SESSION_WS_BUFFERED_BYTES);
		send(connection, begin);

		expect(socket.closeCalls).toEqual([]);
		expect(socket.sent).toHaveLength(1);
	});

	it("rejects a second large ordinary event while the first is still in flight", async () => {
		const harness = await createHarness([]);
		const socket = new ControlledSendSocket();
		socket.deferNextSend();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		const { connection, send } = bridgeConnection(harness.bridge);

		send(connection, ordinaryLargeEvent(2_000_000, 1));
		expect(socket.closeCalls).toEqual([]);
		send(connection, ordinaryLargeEvent(2_000_000, 2));

		expect(socket.sentBytes).toHaveLength(1);
		expect(socket.closeCalls).toEqual([{ code: 1008, reason: "policy violation" }]);
		expect(harness.connectionEvents).toContainEqual(expect.stringContaining("slow WebSocket client"));
	});

	it("rejects a second large response while the first is still in flight", async () => {
		const harness = await createHarness([]);
		const socket = new ControlledSendSocket();
		socket.deferNextSend();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		const { connection, send } = bridgeConnection(harness.bridge);

		send(connection, largeGetMessagesResponse(2_000_000, "large-response-1"));
		expect(socket.closeCalls).toEqual([]);
		send(connection, largeGetMessagesResponse(2_000_000, "large-response-2"));

		expect(socket.sentBytes).toHaveLength(1);
		expect(socket.closeCalls).toEqual([{ code: 1008, reason: "policy violation" }]);
		expect(harness.connectionEvents).toContainEqual(expect.stringContaining("slow WebSocket client"));
	});

	it("checks socket bufferedAmount before draining a callback-delayed queue", async () => {
		const harness = await createHarness([]);
		const socket = new ControlledSendSocket();
		socket.deferNextSend();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		const { connection, send } = bridgeConnection(harness.bridge);

		send(connection, { type: "auth_changed" });
		send(connection, { type: "session_directory_changed", workspaceId: "buffered-workspace" });
		socket.bufferedAmount = MAX_SESSION_WS_BUFFERED_BYTES + 1;
		socket.releaseDeferredSend();

		await eventually(() => socket.closeCalls.length === 1);
		expect(socket.sentBytes).toHaveLength(1);
		expect(socket.closeCalls).toEqual([{ code: 1008, reason: "policy violation" }]);
	});

	it("clears small-byte and large-item queue accounting when a peer disconnects", async () => {
		const harness = await createHarness([]);
		const socket = new ControlledSendSocket();
		socket.deferNextSend();
		harness.bridge.wss.emit("connection", socket as unknown as WebSocket, {} as http.IncomingMessage);
		markBridgeConnectionHelloComplete(harness.bridge);
		const { connection, send } = bridgeConnection(harness.bridge);

		send(connection, { type: "auth_changed" });
		send(connection, ordinaryLargeEvent(2_000_000));
		send(connection, { type: "session_directory_changed", workspaceId: "buffered-workspace" });
		socket.emit("close");

		expect(connection).toMatchObject({
			outboundQueue: [],
			outboundSmallQueuedBytes: 0,
			outboundLargeItems: 0,
			outboundSending: false,
		});
		socket.releaseDeferredSend();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(socket.sentBytes).toHaveLength(1);
	});

	it("releases a delayed parent claim from the child identity after a rekey", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "claim-during-rekey");
		const harness = await createHarness([parent]);
		const client = await openClient(harness);
		const subscription = await subscribe(client, parent.sessionHandle);
		const originalClaim = harness.supervisor.claim.bind(harness.supervisor);
		let claimedConnectionId: string | undefined;
		let claimedFencingToken: string | undefined;
		let claimAcquired: (() => void) | undefined;
		const acquired = new Promise<void>((resolve) => {
			claimAcquired = resolve;
		});
		let releaseClaim: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseClaim = resolve;
		});
		let claimReturned: (() => void) | undefined;
		const returned = new Promise<void>((resolve) => {
			claimReturned = resolve;
		});
		harness.supervisor.claim = async (sessionHandle, connectionId) => {
			const lease = await originalClaim(sessionHandle, connectionId);
			claimedConnectionId = connectionId;
			claimedFencingToken = lease.fencingToken;
			claimAcquired?.();
			await gate;
			claimReturned?.();
			return lease;
		};

		client.send({ type: "session_claim", sessionHandle: parent.sessionHandle });
		await acquired;
		if (!claimedConnectionId || !claimedFencingToken) {
			throw new Error("delayed claim did not acquire a controller lease");
		}
		const child = await harness.supervisor.sendCommand(
			parent.sessionHandle,
			{ id: "fork-while-claim-delayed", type: "fork", entryId: "entry-claim-rekey" },
			{
				connectionId: claimedConnectionId,
				expectedGeneration: subscription.runtime.generation,
				fencingToken: claimedFencingToken,
			},
		);
		expect(harness.supervisor.leaseFor(child.sessionHandle, claimedConnectionId).isController).toBe(true);
		releaseClaim?.();
		await returned;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(harness.supervisor.leaseFor(child.sessionHandle, claimedConnectionId).isController).toBe(false);

		harness.supervisor.claim = originalClaim;
		const successor = await openClient(harness);
		await subscribe(successor, child.sessionHandle);
		const successorLease = await claim(successor, child.sessionHandle);
		expect(successorLease.isController).toBe(true);
	});

	it("does not let delayed claim cleanup erase a newer controller fence", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "claim-release-intent-order");
		const harness = await createHarness([target]);
		const client = await openClient(harness);
		await subscribe(client, target.sessionHandle);
		const originalClaim = harness.supervisor.claim.bind(harness.supervisor);
		let acquired: (() => void) | undefined;
		const acquiredPromise = new Promise<void>((resolve) => {
			acquired = resolve;
		});
		let returnClaim: (() => void) | undefined;
		const returnGate = new Promise<void>((resolve) => {
			returnClaim = resolve;
		});
		let claimCalls = 0;
		harness.supervisor.claim = async (...args) => {
			const lease = await originalClaim(...args);
			claimCalls += 1;
			if (claimCalls === 1) {
				acquired?.();
				await returnGate;
			}
			return lease;
		};

		const mark = client.mark();
		client.send({ type: "session_claim", sessionHandle: target.sessionHandle });
		await acquiredPromise;
		client.send({ type: "session_release", sessionHandle: target.sessionHandle });
		const released = await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "lease_status" }> =>
				frame.type === "lease_status" &&
				frame.sessionHandle === target.sessionHandle &&
				frame.isController === false,
			mark,
		);
		expect(released.isController).toBe(false);
		client.send({ type: "session_claim", sessionHandle: target.sessionHandle });
		const reclaimed = await client.waitForFrame(
			(frame): frame is LeaseFrame =>
				frame.type === "lease_status" &&
				frame.sessionHandle === target.sessionHandle &&
				frame.isController === true,
			mark,
		);
		if (!reclaimed.fencingToken) throw new Error("replacement claim did not return a fence");
		returnClaim?.();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const connectionId = (bridgeConnection(harness.bridge).connection as { connectionId: string })
			.connectionId;
		expect(harness.supervisor.leaseFor(target.sessionHandle, connectionId)).toMatchObject({
			isController: true,
			fencingToken: reclaimed.fencingToken,
		});
		expect(
			client.frames
				.slice(mark)
				.filter(
					(frame) =>
						frame.type === "lease_status" &&
						frame.sessionHandle === target.sessionHandle &&
						frame.isController,
				),
		).toHaveLength(1);
	});

	it("does not retain release intents for never-subscribed handles", async () => {
		const harness = await createHarness([]);
		const client = await openClient(harness);
		for (let index = 0; index < 1_024; index += 1) {
			client.send({ type: "session_unsubscribe", sessionHandle: `never-subscribed-${index}` });
		}
		const mark = client.mark();
		client.send({ type: "session_claim", sessionHandle: "ordering-sentinel" });
		await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_error" }> =>
				frame.type === "session_error" && frame.sessionHandle === "ordering-sentinel",
			mark,
		);
		const { connection } = bridgeConnection(harness.bridge);
		expect((connection as { controlIntents: Map<string, unknown> }).controlIntents.size).toBe(0);
	});

	it("releases a canonical lease acquired after its socket already closed", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "claim-after-close");
		const harness = await createHarness([target]);
		const abandoned = await openClient(harness);
		await subscribe(abandoned, target.sessionHandle);
		const originalClaim = harness.supervisor.claim.bind(harness.supervisor);
		let claimStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			claimStarted = resolve;
		});
		let releaseClaim: (() => void) | undefined;
		const claimGate = new Promise<void>((resolve) => {
			releaseClaim = resolve;
		});
		let claimReturned: (() => void) | undefined;
		const returned = new Promise<void>((resolve) => {
			claimReturned = resolve;
		});
		harness.supervisor.claim = async (sessionHandle, connectionId) => {
			claimStarted?.();
			await claimGate;
			const lease = await originalClaim(sessionHandle, connectionId);
			claimReturned?.();
			return lease;
		};

		abandoned.send({ type: "session_claim", sessionHandle: target.sessionHandle });
		await started;
		await abandoned.close();
		await eventually(() => harness.connectionEvents.some((message) => message.startsWith("ws disconnected")));
		releaseClaim?.();
		await returned;
		await new Promise<void>((resolve) => setImmediate(resolve));

		const successor = await openClient(harness);
		await subscribe(successor, target.sessionHandle);
		const successorLease = await claim(successor, target.sessionHandle);
		expect(successorLease.isController).toBe(true);
	});

	it("multiplexes independent Session event streams over one socket", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "multiplex-a");
		const second = createNativeSession(root, cwd, "multiplex-b");
		const harness = await createHarness([first, second]);
		const client = await openClient(harness);

		const firstSubscription = await subscribe(client, first.sessionHandle);
		const secondSubscription = await subscribe(client, second.sessionHandle);
		const firstLease = await claim(client, first.sessionHandle);
		const secondLease = await claim(client, second.sessionHandle);
		expect(firstLease).toMatchObject({ isController: true });
		expect(secondLease).toMatchObject({ isController: true });

		const eventMark = client.mark();
		await Promise.all([
			command(
				client,
				first.sessionHandle,
				firstSubscription.runtime.generation,
				{ id: "prompt-a", type: "prompt", message: "slow" },
				firstLease.fencingToken,
			),
			command(
				client,
				second.sessionHandle,
				secondSubscription.runtime.generation,
				{ id: "prompt-b", type: "prompt", message: "fast" },
				secondLease.fencingToken,
			),
		]);
		await eventually(() => {
			const handles = new Set(
				client.frames
					.slice(eventMark)
					.flatMap((frame) =>
						frame.type === "event" && frame.event.type === "message_update" ? [frame.sessionHandle] : [],
					),
			);
			return handles.size === 2 ? handles : undefined;
		});

		const updateHandles = client.frames
			.slice(eventMark)
			.flatMap((frame) =>
				frame.type === "event" && frame.event.type === "message_update" ? [frame.sessionHandle] : [],
			);
		expect(new Set(updateHandles)).toEqual(new Set([first.sessionHandle, second.sessionHandle]));
		expect(harness.supervisor.listRuntimes()).toHaveLength(2);
	});

	it("accepts an image-only prompt without disconnecting the Session socket", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "image-only-prompt");
		const harness = await createHarness([target]);
		const client = await openClient(harness);
		const subscription = await subscribe(client, target.sessionHandle);
		const lease = await claim(client, target.sessionHandle);

		const response = await command(
			client,
			target.sessionHandle,
			subscription.runtime.generation,
			{
				id: "image-only",
				type: "prompt",
				message: "",
				images: [{ type: "image", data: "YQ==", mimeType: "image/png" }],
			},
			lease.fencingToken,
		);

		expect(response.response).toMatchObject({ id: "image-only", success: true });
		expect(client.ws.readyState).toBe(WebSocket.OPEN);
	});

	it("keeps subscriptions read-only until an explicit per-Session claim", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "observe-only");
		const harness = await createHarness([target]);
		const client = await openClient(harness);

		const subscription = await subscribe(client, target.sessionHandle);
		expect(subscription.lease).toEqual({
			type: "lease_status",
			serverEpoch: TEST_SERVER_EPOCH,
			sessionHandle: target.sessionHandle,
			generation: subscription.runtime.generation,
			isController: false,
		});
		const response = await command(client, target.sessionHandle, subscription.runtime.generation, {
			id: "unclaimed-write",
			type: "set_session_name",
			name: "must fail",
		});
		expect(response.response).toMatchObject({
			id: "unclaimed-write",
			success: false,
			error: "session_read_only",
		});
	});

	it("isolates leases per Session and fences a second controller for the same Session", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "lease-a");
		const second = createNativeSession(root, cwd, "lease-b");
		const harness = await createHarness([first, second]);
		const left = await openClient(harness);
		const right = await openClient(harness);
		const leftFirst = await subscribe(left, first.sessionHandle);
		await subscribe(left, second.sessionHandle);
		await subscribe(right, first.sessionHandle);
		const rightSecond = await subscribe(right, second.sessionHandle);

		const leftFirstLease = await claim(left, first.sessionHandle);
		const rightFirstLease = await claim(right, first.sessionHandle);
		const rightSecondLease = await claim(right, second.sessionHandle);
		const leftSecondLease = await claim(left, second.sessionHandle);
		expect(leftFirstLease.isController).toBe(true);
		expect(rightFirstLease).toMatchObject({ isController: false });
		expect(rightSecondLease.isController).toBe(true);
		expect(leftSecondLease).toMatchObject({ isController: false });

		await expect(
			command(
				left,
				first.sessionHandle,
				leftFirst.runtime.generation,
				{ id: "left-controls-first", type: "set_session_name", name: "first" },
				leftFirstLease.fencingToken,
			),
		).resolves.toMatchObject({ response: { success: true } });
		await expect(
			command(
				right,
				second.sessionHandle,
				rightSecond.runtime.generation,
				{ id: "right-controls-second", type: "set_session_name", name: "second" },
				rightSecondLease.fencingToken,
			),
		).resolves.toMatchObject({ response: { success: true } });
		await expect(
			command(
				right,
				first.sessionHandle,
				leftFirst.runtime.generation,
				{ id: "right-cannot-control-first", type: "set_session_name", name: "blocked" },
				rightSecondLease.fencingToken,
			),
		).resolves.toMatchObject({ response: { success: false, error: "session_read_only" } });
	});

	it("releases controller ownership on unsubscribe and through a stale pre-rekey handle", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "lease-release-rekey");
		const harness = await createHarness([parent]);
		const owner = await openClient(harness);
		const successor = await openClient(harness);
		const subscription = await subscribe(owner, parent.sessionHandle);
		const ownerLease = await claim(owner, parent.sessionHandle);
		const child = await command(
			owner,
			parent.sessionHandle,
			subscription.runtime.generation,
			{ id: "fork-before-stale-release", type: "fork", entryId: "entry-release" },
			ownerLease.fencingToken,
		);

		const releaseMark = owner.mark();
		owner.send({ type: "session_release", sessionHandle: parent.sessionHandle });
		const released = await owner.waitForFrame(
			(frame): frame is LeaseFrame =>
				frame.type === "lease_status" && frame.sessionHandle === child.sessionHandle,
			releaseMark,
		);
		expect(released.isController).toBe(false);

		await subscribe(successor, child.sessionHandle);
		expect((await claim(successor, child.sessionHandle)).isController).toBe(true);
		successor.send({ type: "session_unsubscribe", sessionHandle: child.sessionHandle });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const third = await openClient(harness);
		await subscribe(third, child.sessionHandle);
		expect((await claim(third, child.sessionHandle)).isController).toBe(true);
	});

	it("routes command responses only to the requester and restores its client id", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "response-routing");
		const harness = await createHarness([target]);
		const requester = await openClient(harness);
		const observer = await openClient(harness);
		const subscription = await subscribe(requester, target.sessionHandle);
		await subscribe(observer, target.sessionHandle);
		const observerMark = observer.mark();

		const response = await command(requester, target.sessionHandle, subscription.runtime.generation, {
			id: "client-visible-id",
			type: "get_state",
		});
		expect(response.response).toMatchObject({
			id: "client-visible-id",
			command: "get_state",
			success: true,
		});
		expect(response.response.id).not.toMatch(/^bridge-/);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(
			observer.frames
				.slice(observerMark)
				.filter((frame) => frame.type === "response" && frame.response.id === "client-visible-id"),
		).toEqual([]);
	});

	it("preserves structured admission details only from a genuine Gateway RpcError", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "structured-command-error");
		const harness = await createHarness([target]);
		const client = await openClient(harness);
		const subscription = await subscribe(client, target.sessionHandle);
		const admissionError = {
			type: "payload_admission_error",
			code: "payload_too_large",
			boundary: "command_frame",
			limitBytes: 8,
			actualBytes: 9,
		} as const;
		harness.supervisor.sendCommand = async () => {
			throw new RpcError("prompt", "payload rejected", admissionError);
		};

		const admitted = await command(client, target.sessionHandle, subscription.runtime.generation, {
			id: "structured-admission",
			type: "prompt",
			message: "too large",
		});
		expect(admitted.response).toMatchObject({
			id: "structured-admission",
			success: false,
			error: "payload rejected",
			admissionError,
		});

		harness.supervisor.sendCommand = async () => {
			throw Object.assign(new Error("ordinary failure"), { admissionError });
		};
		const ordinary = await command(client, target.sessionHandle, subscription.runtime.generation, {
			id: "ordinary-error",
			type: "get_state",
		});
		expect(ordinary.response).toMatchObject({
			id: "ordinary-error",
			success: false,
			error: "ordinary failure",
		});
		expect(ordinary.response).not.toHaveProperty("admissionError");
	});

	it("sends a valid get_messages command response above the small-backlog budget", async () => {
		const responseBytes = 1_100_000;
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, `large-response-${String(responseBytes)}`);
		const harness = await createHarness([target]);
		const client = await openClient(harness);
		const subscription = await subscribe(client, target.sessionHandle);
		const originalSendCommand = harness.supervisor.sendCommand.bind(harness.supervisor);
		harness.supervisor.sendCommand = async (sessionHandle, rpcCommand, context) => {
			const result = await originalSendCommand(sessionHandle, rpcCommand, context);
			if (rpcCommand.type !== "get_messages") return result;
			return {
				...result,
				response: {
					type: "response",
					id: rpcCommand.id,
					command: rpcCommand.type,
					success: true,
					data: {
						messages: [
							{
								role: "assistant",
								content: [{ type: "text", text: "x".repeat(responseBytes) }],
							},
						],
					},
				} as unknown as SessionCommandResponseDto,
			};
		};

		const result = await command(client, target.sessionHandle, subscription.runtime.generation, {
			id: `large-response-${String(responseBytes)}`,
			type: "get_messages",
		});
		expect(result.response).toMatchObject({
			command: "get_messages",
			success: true,
		});
		expect(client.ws.readyState).toBe(WebSocket.OPEN);
	});

	it("rewrites streamed bash ids only for the originating connection", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "bash-id-first");
		const second = createNativeSession(root, cwd, "bash-id-second");
		const harness = await createHarness([first, second]);
		const left = await openClient(harness);
		const right = await openClient(harness);
		const leftFirst = await subscribe(left, first.sessionHandle);
		await subscribe(left, second.sessionHandle);
		await subscribe(right, first.sessionHandle);
		const rightSecond = await subscribe(right, second.sessionHandle);
		const leftLease = await claim(left, first.sessionHandle);
		const rightLease = await claim(right, second.sessionHandle);
		const originalSendCommand = harness.supervisor.sendCommand.bind(harness.supervisor);
		harness.supervisor.sendCommand = async (sessionHandle, rpcCommand, context) => {
			const result = await originalSendCommand(sessionHandle, rpcCommand, context);
			if (rpcCommand.type === "bash" && rpcCommand.id) {
				const runtime = harness.supervisor.getRuntime(result.sessionHandle);
				if (!runtime) throw new Error("bash id fixture runtime disappeared");
				harness.bridge.broadcast({
					type: "event",
					serverEpoch: TEST_SERVER_EPOCH,
					sessionHandle: runtime.sessionHandle,
					workspaceId: runtime.workspaceId,
					generation: runtime.generation,
					seq: runtime.lastSeq + 1,
					event: { type: "bash_execution_update", id: rpcCommand.id, delta: runtime.nativeSessionId },
				});
			}
			return result;
		};

		const sharedClientId = "same-bash-id";
		const leftMark = left.mark();
		const rightMark = right.mark();
		await Promise.all([
			command(
				left,
				first.sessionHandle,
				leftFirst.runtime.generation,
				{ id: sharedClientId, type: "bash", command: "first" },
				leftLease.fencingToken,
			),
			command(
				right,
				second.sessionHandle,
				rightSecond.runtime.generation,
				{ id: sharedClientId, type: "bash", command: "second" },
				rightLease.fencingToken,
			),
		]);
		const leftUpdates = left.frames
			.slice(leftMark)
			.filter(
				(frame): frame is Extract<SessionWsServerMessage, { type: "event" }> =>
					frame.type === "event" && frame.event.type === "bash_execution_update",
			);
		const rightUpdates = right.frames
			.slice(rightMark)
			.filter(
				(frame): frame is Extract<SessionWsServerMessage, { type: "event" }> =>
					frame.type === "event" && frame.event.type === "bash_execution_update",
			);

		expect(leftUpdates).toHaveLength(2);
		expect(rightUpdates).toHaveLength(2);
		expect(leftUpdates.find((frame) => frame.sessionHandle === first.sessionHandle)?.event).toMatchObject({
			id: sharedClientId,
		});
		expect(rightUpdates.find((frame) => frame.sessionHandle === second.sessionHandle)?.event).toMatchObject({
			id: sharedClientId,
		});
		const leftObservedId = leftUpdates.find((frame) => frame.sessionHandle === second.sessionHandle)?.event;
		const rightObservedId = rightUpdates.find((frame) => frame.sessionHandle === first.sessionHandle)?.event;
		expect(leftObservedId).toMatchObject({ id: expect.stringMatching(/^bridge-/) });
		expect(rightObservedId).toMatchObject({ id: expect.stringMatching(/^bridge-/) });
		expect((leftObservedId as { id?: string } | undefined)?.id).not.toBe(
			(rightObservedId as { id?: string } | undefined)?.id,
		);
	});

	it.each(["session_unsubscribe", "session_release"] as const)(
		"releases a rekeyed lease through %s while the owner is catching up",
		async (releaseType) => {
			const root = temporaryRoot();
			const cwd = path.join(root, "workspace");
			fs.mkdirSync(cwd);
			const parent = createNativeSession(root, cwd, `catch-up-${releaseType}`);
			const harness = await createHarness([parent]);
			const owner = await openClient(harness);
			const successor = await openClient(harness);
			const subscription = await subscribe(owner, parent.sessionHandle);
			const originalClaim = harness.supervisor.claim.bind(harness.supervisor);
			let ownerConnectionId: string | undefined;
			harness.supervisor.claim = async (sessionHandle, connectionId) => {
				ownerConnectionId = connectionId;
				return originalClaim(sessionHandle, connectionId);
			};
			const ownerLease = await claim(owner, parent.sessionHandle);
			if (!ownerConnectionId || !ownerLease.fencingToken) {
				throw new Error("catch-up release fixture did not acquire a controller lease");
			}

			const originalSubscribe = harness.supervisor.subscribe.bind(harness.supervisor);
			let catchUpCaptured: (() => void) | undefined;
			const captured = new Promise<void>((resolve) => {
				catchUpCaptured = resolve;
			});
			let releaseCatchUp: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				releaseCatchUp = resolve;
			});
			harness.supervisor.subscribe = async (sessionHandle, cursor) => {
				const result = await originalSubscribe(sessionHandle, cursor);
				catchUpCaptured?.();
				await gate;
				return result;
			};

			owner.send({
				type: "session_subscribe",
				sessionHandle: parent.sessionHandle,
				cursor: {
					serverEpoch: TEST_SERVER_EPOCH,
					generation: subscription.runtime.generation,
					seq: subscription.runtime.lastSeq,
				},
			});
			await captured;
			const child = await harness.supervisor.sendCommand(
				parent.sessionHandle,
				{ id: `fork-${releaseType}`, type: "fork", entryId: "entry-catch-up-release" },
				{
					connectionId: ownerConnectionId,
					expectedGeneration: subscription.runtime.generation,
					fencingToken: ownerLease.fencingToken,
				},
			);
			try {
				owner.send({ type: releaseType, sessionHandle: parent.sessionHandle });
				await eventually(
					() => !harness.supervisor.leaseFor(child.sessionHandle, ownerConnectionId!).isController,
				);
			} finally {
				releaseCatchUp?.();
			}

			await subscribe(successor, child.sessionHandle);
			expect((await claim(successor, child.sessionHandle)).isController).toBe(true);
		},
	);

	it("replays retained frames and reports an explicit gap for an expired cursor", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "replay");
		const harness = await createHarness([target], { replayLimit: 2 });
		const owner = await openClient(harness);
		const subscription = await subscribe(owner, target.sessionHandle);
		const lease = await claim(owner, target.sessionHandle);
		await command(
			owner,
			target.sessionHandle,
			subscription.runtime.generation,
			{ id: "generate-events", type: "prompt", message: "events" },
			lease.fencingToken,
		);
		const current = await eventually(() => {
			const runtime = harness.supervisor.getRuntime(target.sessionHandle);
			return runtime?.state === "idle" && runtime.lastSeq >= 4 ? runtime : undefined;
		});

		const gapClient = await openClient(harness);
		const gap = await subscribe(gapClient, target.sessionHandle, {
			generation: current.generation,
			seq: 0,
		});
		expect(gap.frames.find((frame) => frame.type === "resync_required")).toMatchObject({
			type: "resync_required",
			sessionHandle: target.sessionHandle,
			runtime: {
				sessionHandle: current.sessionHandle,
				generation: current.generation,
				lastSeq: current.lastSeq,
			},
			reason: "gap",
		});
		expect(gap.frames.filter((frame) => frame.type === "event")).toEqual([]);

		const replayClient = await openClient(harness);
		const replay = await subscribe(replayClient, target.sessionHandle, {
			generation: current.generation,
			seq: current.lastSeq - 1,
		});
		const replayedEvents = replay.frames.filter(
			(frame): frame is Extract<SessionWsServerMessage, { type: "event" }> => frame.type === "event",
		);
		expect(replayedEvents).toHaveLength(1);
		expect(replayedEvents[0]).toMatchObject({
			sessionHandle: target.sessionHandle,
			generation: current.generation,
			seq: current.lastSeq,
		});
		expect(replay.frames.some((frame) => frame.type === "resync_required")).toBe(false);
	});

	it("keeps a pending extension dialog across unsubscribe, navigation, and reconnect", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const dialogSession = createNativeSession(root, cwd, "dialog");
		const otherSession = createNativeSession(root, cwd, "other");
		const harness = await createHarness([dialogSession, otherSession]);
		const client = await openClient(harness);
		const subscription = await subscribe(client, dialogSession.sessionHandle);
		const lease = await claim(client, dialogSession.sessionHandle);
		const requestMark = client.mark();
		await command(
			client,
			dialogSession.sessionHandle,
			subscription.runtime.generation,
			{ id: "open-dialog", type: "prompt", message: "open-dialog" },
			lease.fencingToken,
		);
		const requestFrame = await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "extension_ui_request" }> =>
				frame.type === "extension_ui_request" && frame.sessionHandle === dialogSession.sessionHandle,
			requestMark,
		);
		expect(harness.supervisor.getPendingExtensionRequests(dialogSession.sessionHandle)).toContainEqual(
			requestFrame.request,
		);

		client.send({ type: "session_unsubscribe", sessionHandle: dialogSession.sessionHandle });
		await subscribe(client, otherSession.sessionHandle);
		expect(harness.supervisor.getPendingExtensionRequests(dialogSession.sessionHandle)).toContainEqual(
			requestFrame.request,
		);

		const restored = await subscribe(client, dialogSession.sessionHandle);
		const snapshot = restored.frames.find(
			(frame): frame is Extract<SessionWsServerMessage, { type: "session_snapshot" }> =>
				frame.type === "session_snapshot" && frame.sessionHandle === dialogSession.sessionHandle,
		);
		expect(snapshot?.pendingExtensionRequests).toContainEqual(requestFrame.request);
		const observer = await openClient(harness);
		const observed = await subscribe(observer, dialogSession.sessionHandle);
		expect(
			observed.frames
				.find((frame) => frame.type === "session_snapshot")
				?.pendingExtensionRequests.some((request) => request.id === requestFrame.request.id),
		).toBe(true);
		const restoredLease = await claim(client, dialogSession.sessionHandle);
		if (!restoredLease.fencingToken) throw new Error("restored controller lease is missing its token");
		const responseMark = client.mark();
		const observerMark = observer.mark();
		client.send({
			type: "extension_ui_response",
			sessionHandle: dialogSession.sessionHandle,
			expectedGeneration: restored.runtime.generation,
			fencingToken: restoredLease.fencingToken,
			response: { type: "extension_ui_response", id: requestFrame.request.id, confirmed: true },
		});
		const result = await client.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "extension_ui_result" }> =>
				frame.type === "extension_ui_result" && frame.requestId === requestFrame.request.id,
			responseMark,
		);
		expect(result.outcome).toBe("accepted");
		const closed = await observer.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "extension_ui_closed" }> =>
				frame.type === "extension_ui_closed" && frame.requestId === requestFrame.request.id,
			observerMark,
		);
		expect(closed.reason).toBe("answered");
		expect(harness.supervisor.getPendingExtensionRequests(dialogSession.sessionHandle)).not.toContainEqual(
			requestFrame.request,
		);
		await client.close();
		expect(harness.supervisor.getPendingExtensionRequests(dialogSession.sessionHandle)).not.toContainEqual(
			requestFrame.request,
		);
	});

	it.each([
		["open-dialog-timeout", "expired"],
		["open-dialog-crash", "process_lost"],
	] as const)("closes every observer dialog when %s", async (prompt, expectedReason) => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, `dialog-${expectedReason}`);
		const harness = await createHarness([target]);
		const owner = await openClient(harness);
		const observer = await openClient(harness);
		const ownerSubscription = await subscribe(owner, target.sessionHandle);
		await subscribe(observer, target.sessionHandle);
		const lease = await claim(owner, target.sessionHandle);
		const observerMark = observer.mark();

		await command(
			owner,
			target.sessionHandle,
			ownerSubscription.runtime.generation,
			{ id: `trigger-${expectedReason}`, type: "prompt", message: prompt },
			lease.fencingToken,
		);
		const request = await observer.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "extension_ui_request" }> =>
				frame.type === "extension_ui_request" && frame.sessionHandle === target.sessionHandle,
			observerMark,
		);
		const closed = await observer.waitForFrame(
			(frame): frame is Extract<SessionWsServerMessage, { type: "extension_ui_closed" }> =>
				frame.type === "extension_ui_closed" && frame.requestId === request.request.id,
			observerMark,
		);

		expect(closed.reason).toBe(expectedReason);
		expect(closed.seq).toBeGreaterThan(request.seq);
	});

	it("releases every Session lease when its owning socket disconnects", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "disconnect-lease");
		const harness = await createHarness([target]);
		const owner = await openClient(harness);
		const successor = await openClient(harness);
		await subscribe(owner, target.sessionHandle);
		await subscribe(successor, target.sessionHandle);
		const originalLease = await claim(owner, target.sessionHandle);
		expect(originalLease.isController).toBe(true);

		await owner.close();
		await eventually(() => harness.connectionEvents.some((message) => message.startsWith("ws disconnected")));
		const successorLease = await claim(successor, target.sessionHandle);
		expect(successorLease.isController).toBe(true);
		expect(successorLease.fencingToken).not.toBe(originalLease.fencingToken);
	});

	it.each([
		["malformed JSON", (ws: WebSocket) => ws.send("{not-json")],
		["a binary frame", (ws: WebSocket) => ws.send(Buffer.from("{}"))],
	])("closes with policy violation for %s", async (_label, sendInvalid) => {
		const harness = await createHarness([]);
		const client = await openClient(harness);
		const closed = new Promise<{ code: number; reason: string }>((resolve) => {
			client.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
		});
		sendInvalid(client.ws);

		await expect(closed).resolves.toEqual({ code: 1008, reason: "policy violation" });
	});
});
