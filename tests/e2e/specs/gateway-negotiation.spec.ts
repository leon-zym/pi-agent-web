import type { Page, WebSocket } from "@playwright/test";
import { expect, test } from "../fixtures/test";

interface HelloOverride {
	clientBuild: string;
	maxServerFrameBytes?: number;
	major: number;
	minor: number;
}

async function overrideClientHello(page: Page, override: HelloOverride): Promise<void> {
	await page.addInitScript((helloOverride) => {
		const NativeWebSocket = window.WebSocket;
		const WrappedWebSocket = new Proxy(NativeWebSocket, {
			construct(target, args) {
				const socket = Reflect.construct(target, args) as InstanceType<typeof NativeWebSocket>;
				const nativeSend = socket.send.bind(socket);
				socket.send = (data) => {
					if (typeof data !== "string") {
						nativeSend(data);
						return;
					}
					try {
						const frame = JSON.parse(data) as Record<string, unknown>;
						if (frame.type === "client_hello") {
							frame.clientBuild = helloOverride.clientBuild;
							frame.protocol = { major: helloOverride.major, minor: helloOverride.minor };
							if (helloOverride.maxServerFrameBytes !== undefined) {
								frame.limits = { maxServerFrameBytes: helloOverride.maxServerFrameBytes };
							}
							nativeSend(JSON.stringify(frame));
							return;
						}
					} catch {
						// Forward non-JSON application data unchanged.
					}
					nativeSend(data);
				};
				return socket;
			},
		});
		Object.defineProperty(window, "WebSocket", {
			configurable: true,
			writable: true,
			value: WrappedWebSocket,
		});
	}, override);
}

function jsonFrame(payload: string | Buffer): Record<string, unknown> | undefined {
	try {
		return JSON.parse(payload.toString()) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function observeSockets(page: Page): {
	sockets: WebSocket[];
	sent: Record<string, unknown>[];
	received: Record<string, unknown>[];
	closed: WebSocket[];
} {
	const observation = {
		sockets: [] as WebSocket[],
		sent: [] as Record<string, unknown>[],
		received: [] as Record<string, unknown>[],
		closed: [] as WebSocket[],
	};
	page.on("websocket", (socket) => {
		observation.sockets.push(socket);
		socket.on("framesent", ({ payload }) => {
			const frame = jsonFrame(payload);
			if (frame) observation.sent.push(frame);
		});
		socket.on("framereceived", ({ payload }) => {
			const frame = jsonFrame(payload);
			if (frame) observation.received.push(frame);
		});
		socket.on("close", () => observation.closed.push(socket));
	});
	return observation;
}

test("a real browser negotiates an independently versioned client hello", async ({ page, harness }) => {
	await overrideClientHello(page, {
		clientBuild: "7.3.1-browser-test",
		major: 1,
		minor: 7,
		maxServerFrameBytes: 1024 * 1024,
	});
	const observed = observeSockets(page);

	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect(page.locator("textarea")).toBeEnabled();
	await expect
		.poll(() => observed.received.find((frame) => frame.type === "server_hello"))
		.toMatchObject({
			protocol: { major: 1, minor: 2 },
			serverBuild: "0.1.0",
			piVersion: "0.84.2",
			adapterId: "legacy-rpc-v1",
			capabilities: [
				"rpc.commands",
				"rpc.events",
				"rpc.extension_ui",
				"session.multiplex",
				"session.hot_runtime_inventory",
			],
			limits: { maxSnapshotFrameBytes: 1024 * 1024 },
		});
	expect(observed.sent[0]).toMatchObject({
		type: "client_hello",
		clientBuild: "7.3.1-browser-test",
		protocol: { major: 1, minor: 7 },
		limits: { maxServerFrameBytes: 1024 * 1024 },
	});
});

test("a real browser treats a protocol-major mismatch as terminal", async ({ page, harness }) => {
	await overrideClientHello(page, { clientBuild: "99.0.0-browser-test", major: 99, minor: 0 });
	const observed = observeSockets(page);

	await page.goto(harness.origin, { waitUntil: "domcontentloaded" });
	await expect
		.poll(() => observed.received.find((frame) => frame.type === "protocol_error"))
		.toMatchObject({ type: "protocol_error", code: "protocol_major_unsupported" });
	await expect.poll(() => observed.closed.length).toBe(1);
	await page.waitForTimeout(1_000);
	expect(observed.sockets).toHaveLength(1);
	expect(observed.sent.filter((frame) => frame.type === "client_hello")).toHaveLength(1);
});
