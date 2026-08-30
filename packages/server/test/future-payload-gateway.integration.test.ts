import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	FutureProductSessionEventDto,
	FutureSessionWsServerMessage,
	SessionCommandDto,
	SessionContentRefDto,
	SessionRuntimeDto,
} from "@pi-agent-web/protocol";
import {
	GATEWAY_PROTOCOL_VERSION,
	SESSION_CONTENT_INLINE_THRESHOLD_BYTES,
	SESSION_PAYLOAD_BUDGET,
} from "@pi-agent-web/protocol";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createGatewayAccessControl } from "../src/access-control.js";
import { createContentRoutes } from "../src/content-routes.js";
import { EpochContentStore } from "../src/epoch-content-store.js";
import {
	createGatewayFuturePayloadActivation,
	createGatewayPayloadActivation,
} from "../src/gateway-payload-activation.js";
import { canonicalizeSessionFile, sessionHandleForFile } from "../src/native-session-catalog.js";
import { piRpcAdapter } from "../src/pi-rpc-adapter.js";
import type { ExistingSessionTarget } from "../src/session-runtime-types.js";
import { createFutureSessionSupervisor } from "../src/session-supervisor.js";
import { createFutureSessionWsBridge } from "../src/session-ws-bridge.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", "future-payload-pi.mjs");
const SERVER_EPOCH = "future-l3-epoch";
const LARGE_MARKER = "future-l3-large-marker";
const TEST_ORIGIN = "http://127.0.0.1:31415";
const TEST_SECRET = "future-l3-test-secret";

type FutureBridge = ReturnType<typeof createFutureSessionWsBridge>;
type FutureFrame = FutureSessionWsServerMessage;
type EventFrame = Extract<FutureFrame, { type: "event" }>;
type ResponseFrame = Extract<FutureFrame, { type: "response" }>;
type LeaseFrame = Extract<FutureFrame, { type: "lease_status" }>;

class TestSocket extends EventEmitter {
	readonly OPEN = WebSocket.OPEN;
	readonly CONNECTING = WebSocket.CONNECTING;
	readyState: number = WebSocket.OPEN;
	bufferedAmount = 0;
	readonly sent: string[] = [];

	send(payload: string, callback?: (error?: Error) => void): void {
		this.sent.push(payload);
		callback?.();
	}

	close(): void {
		this.readyState = WebSocket.CLOSING;
	}

	ping(): void {}
	terminate(): void {
		this.readyState = WebSocket.CLOSED;
	}
}

interface BridgeConnection {
	connection: { connectionId: string; helloComplete: boolean };
	socket: TestSocket;
	send: (message: FutureFrame) => void;
}

interface FutureHarness {
	root: string;
	target: ExistingSessionTarget;
	store: EpochContentStore;
	activation: ReturnType<typeof createGatewayFuturePayloadActivation>;
	supervisor: ReturnType<typeof createFutureSessionSupervisor>;
	bridge: FutureBridge;
}

const harnesses: FutureHarness[] = [];

function largeText(label: string): string {
	const prefix = `${LARGE_MARKER}:${label}:`;
	return `${prefix}${"x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES - Buffer.byteLength(prefix))}`;
}

function largeJson(label: string): { payload: string } {
	return { payload: largeText(label) };
}

function expectedTextRef(label: string): SessionContentRefDto {
	const body = Buffer.from(largeText(label), "utf8");
	return expectedRef(body);
}

function expectedJsonRef(label: string): SessionContentRefDto {
	const body = Buffer.from(JSON.stringify(largeJson(label)), "utf8");
	return expectedRef(body);
}

function expectedJsonArrayRef(label: string): SessionContentRefDto {
	const body = Buffer.from(JSON.stringify([largeText(label)]), "utf8");
	return expectedRef(body);
}

function expectedRef(body: Buffer): SessionContentRefDto {
	return {
		type: "content_ref",
		serverEpoch: SERVER_EPOCH,
		sha256: createHash("sha256").update(body).digest("hex"),
		byteLength: body.byteLength,
		encoding: "utf-8",
	};
}

function expectedToolResultRefs(label: string): SessionContentRefDto[] {
	return [expectedTextRef(`${label}-content`), expectedJsonRef(`${label}-details`)];
}

function parseFrames(socket: TestSocket): FutureFrame[] {
	return socket.sent.map((payload) => JSON.parse(payload) as FutureFrame);
}

function refsIn(value: unknown): SessionContentRefDto[] {
	const refs: SessionContentRefDto[] = [];
	const pending = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === null || typeof current !== "object") continue;
		if (!Array.isArray(current) && (current as { type?: unknown }).type === "content_ref") {
			refs.push(current as SessionContentRefDto);
			continue;
		}
		pending.push(...(Array.isArray(current) ? current : Object.values(current)));
	}
	return refs;
}

function eventFrames(frames: readonly FutureFrame[]): EventFrame[] {
	return frames.filter((frame): frame is EventFrame => frame.type === "event");
}

function uniqueRefs(values: readonly unknown[]): SessionContentRefDto[] {
	const refs = new Map<string, SessionContentRefDto>();
	for (const value of values) {
		for (const ref of refsIn(value)) refs.set(`${ref.serverEpoch}:${ref.sha256}`, ref);
	}
	return [...refs.values()];
}

function expectRefs(value: unknown, expected: readonly SessionContentRefDto[]): void {
	const actual = refsIn(value);
	for (const ref of expected) expect(actual).toContainEqual(ref);
}

function expectNoLargeMarker(value: unknown): void {
	expect(JSON.stringify(value)).not.toContain(LARGE_MARKER);
}

async function eventually<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition did not settle before timeout");
}

async function waitForFrame<T extends FutureFrame>(
	socket: TestSocket,
	predicate: (frame: FutureFrame) => frame is T,
	from: number,
): Promise<T> {
	return eventually(() => parseFrames(socket).slice(from).find(predicate));
}

async function waitForRuntime(
	harness: FutureHarness,
	predicate: (runtime: SessionRuntimeDto | undefined) => boolean,
): Promise<SessionRuntimeDto> {
	return eventually(() => {
		const runtime = harness.supervisor.getRuntime(harness.target.sessionHandle);
		return predicate(runtime) ? runtime : undefined;
	});
}

function connectFutureBridge(bridge: FutureBridge): BridgeConnection {
	const socket = new TestSocket();
	bridge.wss.emit("connection", socket as unknown as WebSocket, {});
	const internals = bridge as unknown as {
		connections: Set<{ connectionId: string; helloComplete: boolean; ws: TestSocket }>;
		send: (connection: { connectionId: string; helloComplete: boolean }, message: FutureFrame) => void;
	};
	const connection = [...internals.connections].find((candidate) => candidate.ws === socket);
	if (!connection) throw new Error("future bridge did not create a connection");
	connection.helloComplete = true;
	return { connection, socket, send: (message) => internals.send(connection, message) };
}

function sendClient(socket: TestSocket, message: unknown): void {
	socket.emit("message", Buffer.from(JSON.stringify(message)), false);
}

async function subscribe(
	socket: TestSocket,
	sessionHandle: string,
	cursor?: { serverEpoch: string; generation: number; seq: number },
): Promise<{ runtime: SessionRuntimeDto; frames: FutureFrame[] }> {
	const from = socket.sent.length;
	sendClient(socket, { type: "session_subscribe", sessionHandle, ...(cursor ? { cursor } : {}) });
	const runtimeFrame = await waitForFrame(
		socket,
		(frame): frame is Extract<FutureFrame, { type: "runtime_state" }> => frame.type === "runtime_state",
		from,
	);
	await waitForFrame(socket, (frame): frame is LeaseFrame => frame.type === "lease_status", from);
	return { runtime: runtimeFrame.runtime, frames: parseFrames(socket).slice(from) };
}

async function claim(socket: TestSocket, sessionHandle: string): Promise<LeaseFrame> {
	const from = socket.sent.length;
	sendClient(socket, { type: "session_claim", sessionHandle });
	return waitForFrame(
		socket,
		(frame): frame is LeaseFrame =>
			frame.type === "lease_status" && frame.sessionHandle === sessionHandle && frame.isController,
		from,
	);
}

async function sendCommand(
	socket: TestSocket,
	sessionHandle: string,
	runtime: SessionRuntimeDto,
	lease: LeaseFrame,
	command: SessionCommandDto,
): Promise<ResponseFrame> {
	const from = socket.sent.length;
	sendClient(socket, {
		type: "command",
		sessionHandle,
		expectedGeneration: runtime.generation,
		fencingToken: lease.fencingToken,
		command,
	});
	return waitForFrame(
		socket,
		(frame): frame is ResponseFrame =>
			frame.type === "response" &&
			frame.response.id === command.id &&
			frame.response.command === command.type,
		from,
	);
}

function createTarget(root: string): ExistingSessionTarget {
	const cwd = path.join(root, "workspace");
	const sessionDir = path.join(root, "sessions");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "2025-08-28T00-00-00-000Z_future-l3.jsonl");
	fs.writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "future-l3",
			timestamp: "2025-08-28T00:00:00.000Z",
			cwd,
		})}\n`,
	);
	return {
		kind: "existing",
		sessionHandle: sessionHandleForFile(sessionFile),
		workspaceId: "future-l3-workspace",
		cwd,
		sessionFile: canonicalizeSessionFile(sessionFile),
		nativeSessionId: "future-l3",
	};
}

function createContentApp(store: EpochContentStore): {
	app: Hono;
	authHeaders: Record<string, string>;
} {
	const access = createGatewayAccessControl(TEST_SECRET);
	const app = new Hono();
	app.use("/api/v1/content/*", async (context, next) => {
		await next();
		context.header("Cache-Control", "no-store");
	});
	app.use("/api/v1/*", async (context, next) => {
		if (!access.isAuthorized(context.req.raw.headers)) return context.json({ error: "forbidden" }, 403);
		await next();
	});
	app.route("/api/v1", createContentRoutes({ contentStore: store, serverEpoch: SERVER_EPOCH }));
	return {
		app,
		authHeaders: {
			host: "127.0.0.1:31415",
			origin: TEST_ORIGIN,
			cookie: access.createSessionCookie().split(";", 1)[0]!,
		},
	};
}

async function createHarness(
	options: { maxCacheItems?: number; smallHistory?: boolean } = {},
): Promise<FutureHarness> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-web-future-l3-"));
	const target = createTarget(root);
	const store = new EpochContentStore({
		webDataDir: path.join(root, "web-data"),
		serverEpoch: SERVER_EPOCH,
		...(options.maxCacheItems === undefined ? {} : { limits: { maxCacheItems: options.maxCacheItems } }),
	});
	await store.initialize();
	const activation = createGatewayFuturePayloadActivation(store, SERVER_EPOCH);
	let bridge: FutureBridge | undefined;
	const supervisor = createFutureSessionSupervisor({
		serverEpoch: SERVER_EPOCH,
		resolved: {
			command: process.execPath,
			args: [fixturePath],
			source: "pi-path",
			label: "future L3 payload fixture",
			adapter: piRpcAdapter,
			version: "0.84.2",
			adapterId: "pi-rpc",
			compatibilityStatus: "current",
			capabilities: piRpcAdapter.capabilities,
		},
		resolveSession: async (sessionHandle) => (sessionHandle === target.sessionHandle ? target : undefined),
		broadcast: (message) => bridge?.broadcast(message),
		onHotRuntimeInventory: (inventory) => bridge?.broadcastHotRuntimeInventory(inventory),
		piPayloadServices: activation.supervisorServices,
		env: options.smallHistory ? { PI_WEB_FUTURE_FIXTURE_SMALL_HISTORY: "1" } : undefined,
		readyTimeoutMs: 2_000,
		maxAutoRestarts: 0,
	});
	bridge = createFutureSessionWsBridge({
		supervisor,
		serverBuild: "0.1.0-private",
		runtime: {
			version: "0.84.2",
			adapterId: "pi-rpc",
			capabilities: piRpcAdapter.capabilities,
		},
		payloadActivation: activation,
		heartbeatIntervalMs: 60_000,
	});
	const harness = { root, target, store, activation, supervisor, bridge };
	harnesses.push(harness);
	return harness;
}

function futureQueueEvent(sessionHandle: string): EventFrame {
	return {
		type: "event",
		serverEpoch: SERVER_EPOCH,
		sessionHandle,
		workspaceId: "future-l3-workspace",
		generation: 1,
		seq: 1,
		event: { type: "queue_update", steering: [], followUp: [] },
	};
}

afterEach(async () => {
	for (const harness of harnesses.splice(0).reverse()) {
		await harness.bridge.close().catch(() => {});
		await harness.supervisor.stopAll().catch(() => {});
		await harness.store.shutdown().catch(() => {});
		await rm(harness.root, { recursive: true, force: true });
	}
});

describe("private future payload Gateway vertical integration", () => {
	it("externalizes large tool/history/extension roots across live, replay, snapshot, and authenticated GET", async () => {
		const harness = await createHarness();
		const client = connectFutureBridge(harness.bridge);
		const initial = await subscribe(client.socket, harness.target.sessionHandle);
		const lease = await claim(client.socket, harness.target.sessionHandle);
		const initialSnapshot = initial.frames.find(
			(frame): frame is Extract<FutureFrame, { type: "session_snapshot" }> =>
				frame.type === "session_snapshot",
		);
		expect(initialSnapshot).toBeDefined();
		expectNoLargeMarker(initial.frames);

		const toolStart = client.socket.sent.length;
		const toolResponse = await sendCommand(
			client.socket,
			harness.target.sessionHandle,
			initial.runtime,
			lease,
			{ id: "large-tools", type: "prompt", message: "large-tool-payloads" },
		);
		expect(toolResponse.response).toMatchObject({ id: "large-tools", command: "prompt", success: true });
		await waitForFrame(
			client.socket,
			(frame): frame is EventFrame => frame.type === "event" && frame.event.type === "agent_settled",
			toolStart,
		);
		const liveFrames = parseFrames(client.socket).slice(toolStart);
		const toolExpected = [
			expectedJsonRef("tool-args"),
			expectedJsonRef("tool-partial"),
			expectedJsonRef("tool-result"),
			...expectedToolResultRefs("tool-message"),
		];
		expectRefs(liveFrames, toolExpected);
		const liveEvents = eventFrames(liveFrames);
		const toolCallEnd = liveEvents.find(
			(frame) =>
				frame.event.type === "message_update" && frame.event.assistantMessageEvent.type === "toolcall_end",
		);
		if (toolCallEnd?.event.type !== "message_update") throw new Error("toolcall_end was not emitted");
		if (toolCallEnd.event.assistantMessageEvent.type !== "toolcall_end") {
			throw new Error("toolcall_end event shape was not preserved");
		}
		expect(toolCallEnd.event.assistantMessageEvent.toolCall.arguments).toMatchObject({
			type: "external_json",
		});
		const toolExecutionStart = liveEvents.find((frame) => frame.event.type === "tool_execution_start");
		const toolExecutionUpdate = liveEvents.find((frame) => frame.event.type === "tool_execution_update");
		const toolExecutionEnd = liveEvents.find((frame) => frame.event.type === "tool_execution_end");
		if (toolExecutionStart?.event.type !== "tool_execution_start") {
			throw new Error("tool execution start payload event was not emitted");
		}
		if (toolExecutionUpdate?.event.type !== "tool_execution_update") {
			throw new Error("tool execution update payload event was not emitted");
		}
		if (toolExecutionEnd?.event.type !== "tool_execution_end") {
			throw new Error("tool execution payload events were not emitted");
		}
		expect(toolExecutionStart.event.args).toMatchObject({ type: "external_json" });
		expect(toolExecutionUpdate.event.args).toMatchObject({ type: "external_json" });
		expect(toolExecutionUpdate.event.partialResult).toMatchObject({ type: "external_json" });
		expect(toolExecutionEnd.event.result).toMatchObject({ type: "external_json" });
		const toolMessageEnd = liveEvents.find((frame) => frame.event.type === "message_end");
		if (toolMessageEnd?.event.type !== "message_end") throw new Error("tool result was not emitted");
		expect(toolMessageEnd.event.message).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: { type: "external_text" } }],
			details: { type: "external_json" },
		});
		expectNoLargeMarker(liveFrames);

		const extensionStart = client.socket.sent.length;
		const extensionResponse = await sendCommand(
			client.socket,
			harness.target.sessionHandle,
			initial.runtime,
			lease,
			{ id: "large-extensions", type: "prompt", message: "large-extension-roots" },
		);
		expect(extensionResponse.response).toMatchObject({
			id: "large-extensions",
			command: "prompt",
			success: true,
		});
		const extensionFrames = await eventually(() => {
			const frames = parseFrames(client.socket).slice(extensionStart);
			return frames.filter((frame) => frame.type === "extension_ui_request").length >= 3 ? frames : undefined;
		});
		const extensionExpected = [
			expectedTextRef("extension-editor"),
			expectedTextRef("extension-set-editor-text"),
			expectedJsonArrayRef("extension-widget"),
		];
		expectRefs(extensionFrames, extensionExpected);
		expect(extensionFrames).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "extension_ui_request",
					request: expect.objectContaining({
						method: "editor",
						prefill: expect.objectContaining({ type: "external_text" }),
					}),
				}),
				expect.objectContaining({
					type: "extension_ui_request",
					request: expect.objectContaining({
						method: "set_editor_text",
						text: expect.objectContaining({ type: "external_text" }),
					}),
				}),
				expect.objectContaining({
					type: "extension_ui_request",
					request: expect.objectContaining({
						method: "setWidget",
						widgetLines: expect.objectContaining({ type: "external_json" }),
					}),
				}),
			]),
		);
		expectNoLargeMarker(extensionFrames);

		const historyCommands: Array<{ id: string; type: "get_messages" | "get_entries" | "get_tree" }> = [
			{ id: "history-messages", type: "get_messages" },
			{ id: "history-entries", type: "get_entries" },
			{ id: "history-tree", type: "get_tree" },
		];
		const historyResponses: ResponseFrame[] = [];
		for (const command of historyCommands) {
			const response = await sendCommand(
				client.socket,
				harness.target.sessionHandle,
				initial.runtime,
				lease,
				command.type === "get_entries" ? { ...command, since: undefined } : command,
			);
			historyResponses.push(response);
			expect(response.response).toMatchObject({ id: command.id, command: command.type, success: true });
			expectNoLargeMarker(response);
		}
		expectRefs(historyResponses[0], expectedToolResultRefs("history-get-messages"));
		expectRefs(historyResponses[1], expectedToolResultRefs("history-get-entries"));
		expectRefs(historyResponses[2], expectedToolResultRefs("history-get-tree"));

		const replayClient = connectFutureBridge(harness.bridge);
		const replay = await subscribe(replayClient.socket, harness.target.sessionHandle, {
			serverEpoch: SERVER_EPOCH,
			generation: initial.runtime.generation,
			seq: initial.runtime.lastSeq,
		});
		expect(
			replay.frames.some((frame) => frame.type === "event" && frame.event.type === "tool_execution_update"),
		).toBe(true);
		expectRefs(replay.frames, [...toolExpected, ...extensionExpected]);
		expectNoLargeMarker(replay.frames);

		const snapshotClient = connectFutureBridge(harness.bridge);
		const snapshot = await subscribe(snapshotClient.socket, harness.target.sessionHandle);
		const currentSnapshot = snapshot.frames.find(
			(frame): frame is Extract<FutureFrame, { type: "session_snapshot" }> =>
				frame.type === "session_snapshot",
		);
		if (!currentSnapshot) throw new Error("future snapshot was not emitted");
		expectRefs(currentSnapshot, [...toolExpected, ...extensionExpected]);
		expectNoLargeMarker(currentSnapshot);

		const allWireValues = [
			...parseFrames(client.socket),
			...parseFrames(replayClient.socket),
			...parseFrames(snapshotClient.socket),
			...historyResponses,
		];
		const expectedRefs = [
			...expectedToolResultRefs("history-startup"),
			...toolExpected,
			...extensionExpected,
			...expectedToolResultRefs("history-get-messages"),
			...expectedToolResultRefs("history-get-entries"),
			...expectedToolResultRefs("history-get-tree"),
		];
		const publishedRefs = uniqueRefs(allWireValues);
		expect(publishedRefs).toHaveLength(expectedRefs.length);
		for (const ref of expectedRefs) expect(publishedRefs).toContainEqual(ref);
		expectNoLargeMarker(allWireValues);

		const content = createContentApp(harness.store);
		for (const ref of expectedRefs) {
			const response = await content.app.request(`/api/v1/content/${SERVER_EPOCH}/${ref.sha256}`, {
				headers: content.authHeaders,
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Length")).toBe(String(ref.byteLength));
			const body = Buffer.from(await response.arrayBuffer());
			expect(body.byteLength).toBe(ref.byteLength);
			expect(createHash("sha256").update(body).digest("hex")).toBe(ref.sha256);
		}
		const unknownDigest = "0".repeat(64);
		expect(
			(
				await content.app.request(`/api/v1/content/${SERVER_EPOCH}/${unknownDigest}`, {
					headers: content.authHeaders,
				})
			).status,
		).toBe(404);
		expect(
			(
				await content.app.request(`/api/v1/content/old-${SERVER_EPOCH}/${expectedRefs[0]!.sha256}`, {
					headers: content.authHeaders,
				})
			).status,
		).toBe(410);
		expect(
			(
				await content.app.request(`/api/v1/content/${SERVER_EPOCH}/${expectedRefs[0]!.sha256}`, {
					headers: { host: "127.0.0.1:31415", origin: TEST_ORIGIN },
				})
			).status,
		).toBe(403);

		expect(harness.store.usage).toEqual({
			bytes: expectedRefs.reduce((total, ref) => total + ref.byteLength, 0),
			items: 16,
		});
		await harness.supervisor.stop(harness.target.sessionHandle);
		expect(await harness.store.gc()).toEqual({
			bytes: expectedRefs.reduce((total, ref) => total + ref.byteLength, 0),
			items: 16,
		});
		expect(harness.store.usage).toEqual({ bytes: 0, items: 0 });
		expect(
			(
				await content.app.request(`/api/v1/content/${SERVER_EPOCH}/${expectedRefs[0]!.sha256}`, {
					headers: content.authHeaders,
				})
			).status,
		).toBe(404);
	});

	it("fails closed at the adopted store cache boundary and releases the surviving generation hold", async () => {
		const harness = await createHarness({ maxCacheItems: 1, smallHistory: true });
		const client = connectFutureBridge(harness.bridge);
		const initial = await subscribe(client.socket, harness.target.sessionHandle);
		const lease = await claim(client.socket, harness.target.sessionHandle);
		const start = client.socket.sent.length;
		const response = await sendCommand(client.socket, harness.target.sessionHandle, initial.runtime, lease, {
			id: "cache-boundary",
			type: "prompt",
			message: "cache-boundary-extension",
		});
		expect(response.response).toMatchObject({ id: "cache-boundary", command: "prompt", success: true });
		const firstEditor = await waitForFrame(
			client.socket,
			(frame): frame is Extract<FutureFrame, { type: "extension_ui_request" }> =>
				frame.type === "extension_ui_request" && frame.request.method === "editor",
			start,
		);
		expectRefs(firstEditor, [expectedTextRef("cache-first")]);
		expectNoLargeMarker(parseFrames(client.socket).slice(start));
		await waitForRuntime(harness, (runtime) => runtime?.state === "crashed");
		expect(harness.store.usage).toEqual({
			bytes: Buffer.byteLength(largeText("cache-first")),
			items: 1,
		});
		await harness.supervisor.stop(harness.target.sessionHandle);
		expect(await harness.store.gc()).toEqual({
			bytes: Buffer.byteLength(largeText("cache-first")),
			items: 1,
		});
		expect(harness.store.usage).toEqual({ bytes: 0, items: 0 });
	});

	it("keeps the current activation separate and rejects wrong future context and product provenance", async () => {
		const harness = await createHarness({ smallHistory: true });
		const client = connectFutureBridge(harness.bridge);
		const valid = futureQueueEvent(harness.target.sessionHandle);
		const sentBefore = client.socket.sent.length;
		expect(() => client.send({ ...valid, serverEpoch: "foreign-epoch" })).toThrow("exact context guard");
		expect(client.socket.sent).toHaveLength(sentBefore);

		const foreignContext = { ...harness.activation.context, serverEpoch: "foreign-epoch" };
		expect(() =>
			createFutureSessionWsBridge({
				supervisor: harness.supervisor,
				serverBuild: "0.1.0-private",
				runtime: { version: "0.84.2", adapterId: "pi-rpc", capabilities: [] },
				payloadActivation: { ...harness.activation, context: foreignContext },
			}),
		).toThrow("payload activation is invalid");

		const badProductSchema = {
			...harness.activation.supervisorServices.productSchema,
			guardEvent: (_value: unknown): _value is FutureProductSessionEventDto => false,
		};
		const badBridge = createFutureSessionWsBridge({
			supervisor: harness.supervisor,
			serverBuild: "0.1.0-private",
			runtime: { version: "0.84.2", adapterId: "pi-rpc", capabilities: [] },
			payloadActivation: {
				...harness.activation,
				supervisorServices: {
					...harness.activation.supervisorServices,
					productSchema: badProductSchema,
				},
			},
		});
		const badClient = connectFutureBridge(badBridge);
		expect(() => badClient.send(valid)).toThrow("product provenance");
		expect(badClient.socket.sent).toHaveLength(0);
		await badBridge.close();

		const current = createGatewayPayloadActivation(harness.store, SERVER_EPOCH);
		expect(current.externalizer.mode).toBe("attachment");
		expect(current.context).toEqual({
			serverEpoch: SERVER_EPOCH,
			payloadBudget: SESSION_PAYLOAD_BUDGET,
		});
		expect(GATEWAY_PROTOCOL_VERSION).toEqual({ major: 1, minor: 3 });
		expect("contentRefBudget" in current.context).toBe(false);
	});
});
