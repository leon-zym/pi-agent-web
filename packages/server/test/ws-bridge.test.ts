import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { Supervisor } from "../src/supervisor";
import { WsBridge } from "../src/ws-bridge";

/**
 * Disconnect protection unit test:
 * pending dialogs are cancelled only when the LAST listener of a
 * (workspaceId, sessionId) pair disconnects.
 */

interface StubSupervisor {
	cancelled: Array<{ workspaceId: string; sessionId: string }>;
	responses: Array<{ workspaceId: string; response: unknown }>;
}

function makeStub(): StubSupervisor & Record<string, unknown> {
	const stub: StubSupervisor = { cancelled: [], responses: [] };
	(stub as unknown as Record<string, unknown>).cancelDialogsForSession = (
		workspaceId: string,
		sessionId: string,
	) => {
		stub.cancelled.push({ workspaceId, sessionId });
		return 1;
	};
	(stub as unknown as Record<string, unknown>).sendExtensionUiResponse = (
		workspaceId: string,
		response: unknown,
	) => {
		stub.responses.push({ workspaceId, response });
		return "accepted";
	};
	(stub as unknown as Record<string, unknown>).claimController = () => true;
	(stub as unknown as Record<string, unknown>).releaseController = () => true;
	(stub as unknown as Record<string, unknown>).isController = () => true;
	(stub as unknown as Record<string, unknown>).sendCommand = async () => ({
		type: "response",
		command: "get_state",
		success: true,
		data: { sessionId: "s1" },
	});
	return stub as unknown as StubSupervisor & Record<string, unknown>;
}

async function openClient(port: number): Promise<import("ws").WebSocket> {
	const WebSocketCtor = (await import("ws")).default;
	const ws = new WebSocketCtor(`ws://127.0.0.1:${port}`);
	await new Promise<void>((resolve, reject) => {
		ws.on("open", () => resolve());
		ws.on("error", reject);
	});
	return ws;
}

function listen(ws: import("ws").WebSocket, workspaceId: string, sessionId: string): void {
	ws.send(JSON.stringify({ type: "session_listen", workspaceId, sessionId }));
}

async function closeClient(ws: import("ws").WebSocket): Promise<void> {
	await new Promise<void>((resolve) => {
		ws.on("close", () => resolve());
		ws.close();
	});
}

describe("ws bridge disconnect protection", () => {
	let wss: WebSocketServer;
	let bridge: WsBridge;
	let stub: StubSupervisor & Record<string, unknown>;

	afterEach(async () => {
		bridge?.close();
		wss?.close();
	});

	async function setup(): Promise<number> {
		stub = makeStub();
		wss = new WebSocketServer({ port: 0 });
		const port = (wss.address() as { port: number }).port;
		bridge = new WsBridge({
			supervisor: stub as unknown as Supervisor,
			getWorkspace: (id) => ({ cwd: `/tmp/${id}` }),
			heartbeatIntervalMs: 60_000,
		});
		// Simulate the upgrade path used in main.ts.
		wss.on("connection", (ws) => bridge.wss.emit("connection", ws));
		return port;
	}

	it("does not cancel while another tab still listens to the same session", async () => {
		const port = await setup();
		const a = await openClient(port);
		const b = await openClient(port);
		listen(a, "ws1", "s1");
		listen(b, "ws1", "s1");
		await new Promise((r) => setTimeout(r, 30));

		await closeClient(a);
		await new Promise((r) => setTimeout(r, 30));
		expect(stub.cancelled).toEqual([]);

		await closeClient(b);
		await new Promise((r) => setTimeout(r, 30));
		expect(stub.cancelled).toEqual([{ workspaceId: "ws1", sessionId: "s1" }]);
	});

	it("cancels only the abandoned session, not other sessions", async () => {
		const port = await setup();
		const a = await openClient(port);
		const b = await openClient(port);
		listen(a, "ws1", "s1");
		listen(b, "ws1", "s2");
		await new Promise((r) => setTimeout(r, 30));

		await closeClient(a);
		await new Promise((r) => setTimeout(r, 30));
		expect(stub.cancelled).toEqual([{ workspaceId: "ws1", sessionId: "s1" }]);

		await closeClient(b);
		await new Promise((r) => setTimeout(r, 30));
		expect(stub.cancelled).toEqual([
			{ workspaceId: "ws1", sessionId: "s1" },
			{ workspaceId: "ws1", sessionId: "s2" },
		]);
	});

	it("switching the listen target decrements the previous pair", async () => {
		const port = await setup();
		const a = await openClient(port);
		listen(a, "ws1", "s1");
		await new Promise((r) => setTimeout(r, 30));

		listen(a, "ws1", "s2");
		await new Promise((r) => setTimeout(r, 30));
		expect(stub.cancelled).toEqual([{ workspaceId: "ws1", sessionId: "s1" }]);

		await closeClient(a);
		await new Promise((r) => setTimeout(r, 30));
		expect(stub.cancelled).toEqual([
			{ workspaceId: "ws1", sessionId: "s1" },
			{ workspaceId: "ws1", sessionId: "s2" },
		]);
	});

	it("relays extension_ui_response to the supervisor", async () => {
		const port = await setup();
		const a = await openClient(port);
		listen(a, "ws1", "s1");
		await new Promise((r) => setTimeout(r, 30));

		a.send(
			JSON.stringify({
				type: "extension_ui_response",
				workspaceId: "ws1",
				expectedSessionId: null,
				response: { type: "extension_ui_response", id: "req-1", confirmed: true },
			}),
		);
		await new Promise((r) => setTimeout(r, 30));
		expect(stub.responses).toEqual([
			{ workspaceId: "ws1", response: { type: "extension_ui_response", id: "req-1", confirmed: true } },
		]);
		await closeClient(a);
	});
});
