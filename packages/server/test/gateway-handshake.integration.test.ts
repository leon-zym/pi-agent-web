import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { SessionSupervisor } from "../src/session-supervisor.js";
import { SessionWsBridge } from "../src/session-ws-bridge.js";

interface Harness {
	server: http.Server;
	bridge: SessionWsBridge;
	url: string;
}

const harnesses: Harness[] = [];

async function createHarness(options: { helloTimeoutMs?: number } = {}): Promise<Harness> {
	const bridge = new SessionWsBridge({
		supervisor: { releaseConnection: () => undefined } as unknown as SessionSupervisor,
		serverEpoch: "gateway-epoch-test",
		serverBuild: "0.1.0-test",
		runtime: {
			version: "0.84.2",
			adapterId: "legacy-rpc-v1",
			capabilities: ["rpc.commands", "rpc.events", "rpc.extension_ui", "session.multiplex"],
		},
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

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.bridge.close();
		await new Promise<void>((resolve) => harness.server.close(() => resolve()));
	}
});

describe("Gateway WebSocket hello negotiation", () => {
	it("closes a silent client that never sends client_hello", async () => {
		const harness = await createHarness({ helloTimeoutMs: 20 });
		const ws = await openSocket(harness.url);

		await expect(nextClose(ws)).resolves.toBe(1008);
	});

	it("requires client_hello before any Session frame", async () => {
		const harness = await createHarness();
		const ws = await openSocket(harness.url);
		const frame = nextJson(ws);
		ws.send(JSON.stringify({ type: "session_subscribe", sessionHandle: "session-before-hello" }));

		await expect(frame).resolves.toMatchObject({ type: "protocol_error", code: "hello_required" });
	});

	it("rejects an incompatible client major with one stable terminal diagnostic", async () => {
		const harness = await createHarness();
		const ws = await openSocket(harness.url);
		const frame = nextJson(ws);
		ws.send(
			JSON.stringify({
				type: "client_hello",
				protocol: { major: 99, minor: 0 },
				clientBuild: "future-ui",
				capabilities: [],
				limits: { maxServerFrameBytes: 32 * 1024 * 1024 },
			}),
		);

		await expect(frame).resolves.toMatchObject({
			type: "protocol_error",
			code: "protocol_major_unsupported",
			supported: { major: 1 },
		});
	});

	it("rejects a client missing a required negotiated capability", async () => {
		const harness = await createHarness();
		const ws = await openSocket(harness.url);
		const frame = nextJson(ws);
		ws.send(
			JSON.stringify({
				type: "client_hello",
				protocol: { major: 1, minor: 0 },
				clientBuild: "partial-ui",
				capabilities: ["rpc.commands", "rpc.events", "session.multiplex"],
				limits: { maxServerFrameBytes: 32 * 1024 * 1024 },
			}),
		);

		await expect(frame).resolves.toMatchObject({
			type: "protocol_error",
			code: "capability_unsupported",
		});
	});

	it("negotiates a compatible minor and reports the selected Pi adapter", async () => {
		const harness = await createHarness();
		const ws = await openSocket(harness.url);
		const frame = nextJson(ws);
		ws.send(
			JSON.stringify({
				type: "client_hello",
				protocol: { major: 1, minor: 7 },
				clientBuild: "0.1.0-test",
				capabilities: [
					"rpc.commands",
					"rpc.events",
					"rpc.extension_ui",
					"session.multiplex",
					"unknown-future-capability",
				],
				limits: { maxServerFrameBytes: 4096 },
			}),
		);

		await expect(frame).resolves.toMatchObject({
			type: "server_hello",
			protocol: { major: 1, minor: 0 },
			serverBuild: "0.1.0-test",
			serverEpoch: "gateway-epoch-test",
			piVersion: "0.84.2",
			adapterId: "legacy-rpc-v1",
			capabilities: ["rpc.commands", "rpc.events", "rpc.extension_ui", "session.multiplex"],
			limits: {
				maxClientFrameBytes: expect.any(Number),
				maxSnapshotFrameBytes: 4096,
				maxExtensionRequests: expect.any(Number),
			},
		});
		ws.close();
	});

	it("enforces the negotiated server-frame ceiling after hello", async () => {
		const harness = await createHarness();
		const ws = await openSocket(harness.url);
		const hello = nextJson(ws);
		ws.send(
			JSON.stringify({
				type: "client_hello",
				protocol: { major: 1, minor: 0 },
				clientBuild: "bounded-ui",
				capabilities: ["rpc.commands", "rpc.events", "rpc.extension_ui", "session.multiplex"],
				limits: { maxServerFrameBytes: 1024 },
			}),
		);
		await expect(hello).resolves.toMatchObject({
			type: "server_hello",
			limits: { maxSnapshotFrameBytes: 1024 },
		});

		const closed = nextClose(ws);
		harness.bridge.broadcast({ type: "auth_changed", workspaceId: "x".repeat(2_000) });

		await expect(closed).resolves.toBe(1008);
	});
});
