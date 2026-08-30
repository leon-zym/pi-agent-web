import http from "node:http";
import type { AddressInfo } from "node:net";
import {
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	SESSION_PAYLOAD_BUDGET,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { SessionSupervisor } from "../src/session-supervisor.js";
import { SessionWsBridge } from "../src/session-ws-bridge.js";
import { createCanonicalPayloadFixture } from "./helpers/canonical-payload.js";

interface Harness {
	server: http.Server;
	bridge: SessionWsBridge;
	url: string;
}

const SERVER_EPOCH = "gateway-epoch-test";
const harnesses: Harness[] = [];

async function createHarness(options: { helloTimeoutMs?: number; omitServerInventory?: boolean } = {}) {
	const payloadActivation = createCanonicalPayloadFixture(SERVER_EPOCH);
	const capabilities = options.omitServerInventory
		? GATEWAY_SERVER_REQUIRED_CAPABILITIES.filter(
				(capability) => capability !== "session.hot_runtime_inventory",
			)
		: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES];
	const bridge = new SessionWsBridge({
		supervisor: {
			serverEpoch: SERVER_EPOCH,
			releaseConnection: () => undefined,
			getHotRuntimeInventory: () => ({
				type: "hot_runtime_inventory",
				serverEpoch: SERVER_EPOCH,
				revision: 0,
				runtimes: [],
			}),
		} as unknown as SessionSupervisor,
		serverBuild: "0.1.0-test",
		runtime: { version: "0.84.2", adapterId: "pi-rpc", capabilities },
		payloadActivation,
		helloTimeoutMs: options.helloTimeoutMs,
	});
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
	const harness = { server, bridge, url: `ws://127.0.0.1:${String(port)}` };
	harnesses.push(harness);
	return harness;
}

async function openSocket(url: string): Promise<WebSocket> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	return ws;
}

function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Gateway hello frame timed out")), 2_000);
		ws.once("message", (raw) => {
			clearTimeout(timer);
			resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
		});
	});
}

function nextClose(ws: WebSocket): Promise<number> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Gateway close frame timed out")), 2_000);
		ws.once("close", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

function sendHello(
	ws: WebSocket,
	overrides: {
		protocol?: { major: number; minor: number };
		capabilities?: string[];
		maxServerFrameBytes?: number;
	} = {},
): void {
	ws.send(
		JSON.stringify({
			type: "client_hello",
			protocol: overrides.protocol ?? GATEWAY_PROTOCOL_VERSION,
			clientBuild: "0.1.0-test",
			capabilities: overrides.capabilities ?? [...GATEWAY_SERVER_REQUIRED_CAPABILITIES],
			limits: {
				maxServerFrameBytes: overrides.maxServerFrameBytes ?? SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
			},
		}),
	);
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.bridge.close();
		await new Promise<void>((resolve) => harness.server.close(() => resolve()));
	}
});

describe("Gateway WebSocket hello negotiation", () => {
	it("closes a silent client that never sends client_hello", async () => {
		const ws = await openSocket((await createHarness({ helloTimeoutMs: 20 })).url);
		await expect(nextClose(ws)).resolves.toBe(1008);
	});

	it("requires client_hello before any Session frame", async () => {
		const ws = await openSocket((await createHarness()).url);
		const frame = nextJson(ws);
		ws.send(JSON.stringify({ type: "session_subscribe", sessionHandle: "before-hello" }));
		await expect(frame).resolves.toMatchObject({ type: "protocol_error", code: "hello_required" });
	});

	it("rejects an incompatible major with one terminal diagnostic", async () => {
		const ws = await openSocket((await createHarness()).url);
		const frame = nextJson(ws);
		sendHello(ws, { protocol: { major: 99, minor: 3 } });
		await expect(frame).resolves.toMatchObject({
			type: "protocol_error",
			code: "invalid_hello",
			supported: { major: 1, minMinor: 3, maxMinor: 3 },
		});
	});

	it("rejects protocol 1.2 instead of activating a compatibility path", async () => {
		const ws = await openSocket((await createHarness()).url);
		const frame = nextJson(ws);
		sendHello(ws, { protocol: { major: 1, minor: 2 } });
		await expect(frame).resolves.toMatchObject({
			type: "protocol_error",
			code: "invalid_hello",
			supported: { major: 1, minMinor: 3, maxMinor: 3 },
		});
	});

	it("rejects a client missing one canonical capability", async () => {
		const ws = await openSocket((await createHarness()).url);
		const frame = nextJson(ws);
		sendHello(ws, {
			capabilities: GATEWAY_SERVER_REQUIRED_CAPABILITIES.filter(
				(capability) => capability !== "payload.epoch_content_refs",
			),
		});
		await expect(frame).resolves.toMatchObject({ type: "protocol_error", code: "invalid_hello" });
	});

	it("rejects a Gateway missing a required canonical capability", async () => {
		const ws = await openSocket((await createHarness({ omitServerInventory: true })).url);
		const frame = nextJson(ws);
		sendHello(ws);
		await expect(frame).resolves.toMatchObject({
			type: "protocol_error",
			code: "capability_unsupported",
		});
	});

	it("negotiates only exact protocol 1.3 with both payload budgets", async () => {
		const ws = await openSocket((await createHarness()).url);
		const frame = nextJson(ws);
		sendHello(ws);
		await expect(frame).resolves.toMatchObject({
			type: "server_hello",
			protocol: GATEWAY_PROTOCOL_VERSION,
			serverEpoch: SERVER_EPOCH,
			adapterId: "pi-rpc",
			payloadBudget: SESSION_PAYLOAD_BUDGET,
		});
	});
});
