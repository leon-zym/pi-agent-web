import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	FutureProductSessionEventDto,
	FutureSessionWsServerMessage,
	SessionRuntimeDto,
	SessionRuntimeIdentityDto,
	SessionWsServerMessage,
} from "@pi-agent-web/protocol";
import {
	FUTURE_SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
	SESSION_TEXT_MAX_BYTES,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EpochContentStore } from "../src/epoch-content-store.js";
import {
	createGatewayFuturePayloadActivation,
	createGatewayPayloadActivation,
} from "../src/gateway-payload-activation.js";
import type { FutureSessionWsBridgeOptions } from "../src/session-ws-bridge.js";
import { createFutureSessionWsBridge, SessionWsBridge } from "../src/session-ws-bridge.js";

const SERVER_EPOCH = "stage7c-epoch";

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

function runtime(sessionHandle = "session-a"): SessionRuntimeDto {
	return {
		serverEpoch: SERVER_EPOCH,
		sessionHandle,
		workspaceId: "workspace-a",
		nativeSessionId: "native-a",
		sessionFile: "/tmp/session-a.jsonl",
		cwd: "/tmp/workspace-a",
		generation: 1,
		lastSeq: 1,
		state: "idle",
		lastActivityAt: 1,
		recoverable: true,
	};
}

function futureEvent(
	serverEpoch = SERVER_EPOCH,
	sessionHandle = "session-a",
	seq = 1,
): Extract<FutureSessionWsServerMessage, { type: "event" }> {
	return {
		type: "event",
		serverEpoch,
		sessionHandle,
		workspaceId: "workspace-a",
		generation: 1,
		seq,
		event: {
			type: "tool_execution_start",
			toolCallId: "tool-a",
			toolName: "read",
			args: {
				type: "inline_json",
				value: { nested: { type: "external_json", ref: { serverEpoch, fake: true } }, value: "ordinary" },
			},
		} satisfies FutureProductSessionEventDto,
	};
}

function futureSupervisor(): FutureSessionWsBridgeOptions["supervisor"] {
	const currentRuntime = runtime();
	return {
		serverEpoch: SERVER_EPOCH,
		getRuntime: () => currentRuntime,
		getHotRuntimeInventory: () => ({
			type: "hot_runtime_inventory",
			serverEpoch: SERVER_EPOCH,
			revision: 1,
			runtimes: [],
		}),
		subscribe: async () => ({
			type: "replay",
			runtime: currentRuntime,
			frames: [],
		}),
		subscribeHotExact: async (_expected: SessionRuntimeIdentityDto) => ({
			type: "replay",
			runtime: currentRuntime,
			frames: [],
			observationToken: { kind: "hot_runtime_subscription" },
		}),
		revalidateHotExactSubscription: () => true,
		claim: async () => ({
			serverEpoch: SERVER_EPOCH,
			sessionHandle: currentRuntime.sessionHandle,
			generation: currentRuntime.generation,
			isController: false,
		}),
		release: () => true,
		releaseConnection: () => [],
		leaseFor: () => ({
			serverEpoch: SERVER_EPOCH,
			sessionHandle: currentRuntime.sessionHandle,
			generation: currentRuntime.generation,
			isController: false,
		}),
		restart: async () => currentRuntime,
		sendCommand: async () => ({
			serverEpoch: SERVER_EPOCH,
			sessionHandle: currentRuntime.sessionHandle,
			generation: currentRuntime.generation,
			barrierSeq: currentRuntime.lastSeq,
			response: {
				type: "response",
				command: "get_state",
				success: false,
				error: "test",
			},
		}),
		sendExtensionUiResponse: async () => "not_running",
	};
}

function bridgeConnection(bridge: ReturnType<typeof createFutureSessionWsBridge>): {
	connection: { helloComplete: boolean };
	socket: TestSocket;
	send: (message: FutureSessionWsServerMessage) => void;
} {
	const socket = new TestSocket();
	bridge.wss.emit("connection", socket as unknown as WebSocket, {});
	const internals = bridge as unknown as {
		connections: Set<{ helloComplete: boolean; ws: TestSocket }>;
		send: (connection: { helloComplete: boolean }, message: FutureSessionWsServerMessage) => void;
	};
	const connection = [...internals.connections][0];
	if (!connection) throw new Error("Stage7C bridge did not create a connection");
	connection.helloComplete = true;
	return { connection, socket, send: (message) => internals.send(connection, message) };
}

describe("Stage7C private future SessionWsBridge", () => {
	let webDataDir: string | undefined;
	let store: EpochContentStore | undefined;
	let bridge: ReturnType<typeof createFutureSessionWsBridge> | undefined;

	afterEach(async () => {
		await bridge?.close();
		await store?.shutdown();
		if (webDataDir) await rm(webDataDir, { recursive: true, force: true });
	});

	async function createFutureBridge() {
		webDataDir = await mkdtemp(path.join(tmpdir(), "pi-web-stage7c-"));
		store = new EpochContentStore({ webDataDir, serverEpoch: SERVER_EPOCH });
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, SERVER_EPOCH);
		bridge = createFutureSessionWsBridge({
			supervisor: futureSupervisor(),
			serverBuild: "0.1.0-private",
			runtime: { version: "0.84.2", adapterId: "legacy-rpc-v1", capabilities: [] },
			payloadActivation: activation,
			heartbeatIntervalMs: 60_000,
		});
		return { activation, bridge };
	}

	it("requires exact future context, generic externalizer, and future product provenance", async () => {
		const { activation } = await createFutureBridge();
		const other = createGatewayFuturePayloadActivation(store!, SERVER_EPOCH);
		expect(activation.context).toMatchObject({
			serverEpoch: SERVER_EPOCH,
			payloadBudget: SESSION_PAYLOAD_BUDGET,
			contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
		});
		expect(activation.externalizer.context).toBe(activation.context);
		expect(activation.externalizer.mode).toBe("future_content");
		expect(activation.supervisorServices.externalizer).toBe(activation.externalizer);
		expect(() =>
			createFutureSessionWsBridge({
				supervisor: futureSupervisor(),
				serverBuild: "0.1.0-private",
				runtime: { version: "0.84.2", adapterId: "legacy-rpc-v1", capabilities: [] },
				payloadActivation: { ...activation, externalizer: other.externalizer },
			}),
		).toThrow("payload activation is invalid");
	});

	it("accepts root-only nested lookalikes and the exact normalized-frame boundary", async () => {
		const { bridge: futureBridge } = await createFutureBridge();
		const { socket, send } = bridgeConnection(futureBridge);
		const valid = futureEvent();
		send(valid);
		expect(socket.sent).toHaveLength(1);
		expect(JSON.parse(socket.sent[0]!)).toEqual(valid);

		const schema = (
			futureBridge as unknown as {
				futureActivation: { supervisorServices: { productSchema: { maxNormalizedEventWireBytes: number } } };
			}
		).futureActivation.supervisorServices.productSchema;
		const makeQueueEvent = (totalBytes: number): FutureSessionWsServerMessage => {
			const base = {
				type: "event" as const,
				serverEpoch: SERVER_EPOCH,
				sessionHandle: "session-a",
				workspaceId: "workspace-a",
				generation: 1,
				seq: 2,
				event: { type: "queue_update" as const, steering: Array.from({ length: 9 }, () => ""), followUp: [] },
			};
			const baseBytes = Buffer.byteLength(JSON.stringify(base));
			const textBytes = Math.max(0, totalBytes - baseBytes);
			const parts = Array.from({ length: 9 }, (_, index) => {
				const remaining = textBytes - index * SESSION_TEXT_MAX_BYTES;
				return "x".repeat(Math.max(0, Math.min(SESSION_TEXT_MAX_BYTES, remaining)));
			});
			return { ...base, event: { ...base.event, steering: parts } };
		};
		const exact = makeQueueEvent(schema.maxNormalizedEventWireBytes);
		send(exact);
		expect(socket.sent).toHaveLength(2);
		expect(() => send(makeQueueEvent(schema.maxNormalizedEventWireBytes + 1))).toThrow(
			"normalized wire budget",
		);
		expect(socket.sent).toHaveLength(2);
	});

	it("fails closed for wrong epoch/session and malformed future history responses", async () => {
		const { bridge: futureBridge } = await createFutureBridge();
		const { socket, send } = bridgeConnection(futureBridge);
		expect(() => send(futureEvent("wrong-epoch"))).toThrow("exact context guard");
		expect(socket.sent).toHaveLength(0);

		futureBridge.broadcast(futureEvent(SERVER_EPOCH, "other-session"));
		expect(socket.sent).toHaveLength(0);

		const malformed = {
			type: "response",
			serverEpoch: SERVER_EPOCH,
			sessionHandle: "session-a",
			generation: 1,
			barrierSeq: 1,
			response: {
				type: "response",
				command: "get_messages",
				success: true,
				data: {
					messages: [
						{
							role: "toolResult",
							toolCallId: "tool-a",
							toolName: "read",
							content: [{ type: "text", text: { type: "external_text", ref: { serverEpoch: "wrong" } } }],
							isError: false,
							timestamp: 1,
						},
					],
				},
			},
		} as unknown as FutureSessionWsServerMessage;
		expect(() => send(malformed)).toThrow("exact context guard");
		expect(socket.sent).toHaveLength(0);
	});

	it("keeps the current 1.2 Bridge and attachment activation surface unchanged", async () => {
		webDataDir = await mkdtemp(path.join(tmpdir(), "pi-web-stage7c-current-"));
		store = new EpochContentStore({ webDataDir, serverEpoch: SERVER_EPOCH });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, SERVER_EPOCH);
		expect(activation.externalizer.mode).toBe("attachment");
		expect(activation.context).not.toHaveProperty("contentRefBudget");
		expect(SessionWsBridge).toBeTypeOf("function");
		expect({} as SessionWsServerMessage).toBeTypeOf("object");
	});
});
