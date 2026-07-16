import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServerHandle, startServer } from "../src/main.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-gateway-test-"));
const workspacePath = path.join(tempRoot, "workspace");
const agentDir = path.join(tempRoot, "agent");
const sessionRootDir = path.join(tempRoot, "sessions");
const webDataDir = path.join(tempRoot, "web-data");
const fakePiPath = path.join(import.meta.dirname, "fixtures", "fake-pi.mjs");
const viteOrigin = "http://localhost:5173";

let handle: ServerHandle;
let base: string;
let cookie: string;
let workspaceId: string;

function authenticatedHeaders(origin = viteOrigin): Record<string, string> {
	return { Origin: origin, Cookie: cookie };
}

async function openSocket(headers: Record<string, string>): Promise<import("ws").WebSocket> {
	const WebSocketCtor = (await import("ws")).default;
	const ws = new WebSocketCtor(`${base.replace("http", "ws")}/api/v1/ws`, { headers });
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	return ws;
}

async function responseFor(
	ws: import("ws").WebSocket,
	id: string,
): Promise<{ id?: string; success?: boolean }> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`response ${id} timed out`)), 10_000);
		ws.on("message", (raw) => {
			const frame = JSON.parse(raw.toString()) as {
				type?: string;
				response?: { id?: string; success?: boolean };
			};
			if (frame.type !== "response" || frame.response?.id !== id) return;
			clearTimeout(timeout);
			resolve(frame.response);
		});
	});
}

beforeAll(async () => {
	fs.mkdirSync(workspacePath, { recursive: true });
	handle = await startServer({
		config: { port: 0, host: "127.0.0.1", agentDir, sessionRootDir, webDataDir },
		piPath: fakePiPath,
	});
	await new Promise<void>((resolve, reject) => {
		handle.server.once("listening", resolve);
		handle.server.once("error", reject);
	});
	const address = handle.server.address();
	if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
	base = `http://127.0.0.1:${String(address.port)}`;

	const bootstrap = await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: viteOrigin } });
	expect(bootstrap.status).toBe(200);
	expect(await bootstrap.json()).toEqual({ ok: true });
	const setCookie = bootstrap.headers.get("set-cookie");
	if (!setCookie) throw new Error("bootstrap did not set a session cookie");
	cookie = setCookie.split(";", 1)[0] ?? "";

	const workspace = await fetch(`${base}/api/v1/workspaces`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authenticatedHeaders() },
		body: JSON.stringify({ path: workspacePath }),
	});
	expect(workspace.status).toBe(201);
	workspaceId = ((await workspace.json()) as { id: string }).id;
});

afterAll(async () => {
	await handle?.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("gateway access control", () => {
	it("rejects non-loopback listener configuration", async () => {
		await expect(startServer({ config: { host: "0.0.0.0" } })).rejects.toThrow("PI_WEB_HOST");
	});

	it("boots from an allowed Vite origin without exposing the session secret", async () => {
		expect(cookie).toMatch(/^pi_web_session=/);
		expect(cookie).not.toContain("undefined");
		const sessionCookie = (
			await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: viteOrigin } })
		).headers.get("set-cookie");
		expect(sessionCookie).toContain("HttpOnly");
		expect(sessionCookie).toContain("SameSite=Strict");
		expect(
			(await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: "http://[::1]:5173" } })).status,
		).toBe(200);
	});

	it("rejects REST calls without a matching cookie and origin", async () => {
		expect((await fetch(`${base}/api/v1/workspaces`, { headers: { Origin: viteOrigin } })).status).toBe(403);
		expect(
			(
				await fetch(`${base}/api/v1/workspaces`, {
					headers: authenticatedHeaders("http://evil.example"),
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(`${base}/api/v1/workspaces`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Origin: "http://evil.example", Cookie: cookie },
					body: JSON.stringify({ path: workspacePath }),
				})
			).status,
		).toBe(403);
	});

	it("rejects unauthorized websocket upgrades and policy-violating frames", async () => {
		const WebSocketCtor = (await import("ws")).default;
		const unauthorized = new WebSocketCtor(`${base.replace("http", "ws")}/api/v1/ws`, {
			headers: { Origin: viteOrigin },
		});
		const status = await new Promise<number | undefined>((resolve) => {
			unauthorized.once("unexpected-response", (_request, response) => resolve(response.statusCode));
			unauthorized.once("error", () => resolve(undefined));
		});
		expect(status).toBe(403);

		const ws = await openSocket(authenticatedHeaders());
		const closeCode = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
		ws.send('{"type":"command"}');
		expect(await closeCode).toBe(1008);
	});

	it("isolates duplicate client command ids by connection", async () => {
		const [a, b] = await Promise.all([
			openSocket(authenticatedHeaders()),
			openSocket(authenticatedHeaders()),
		]);
		const responseA = responseFor(a, "same-client-id");
		const responseB = responseFor(b, "same-client-id");
		const command = JSON.stringify({
			type: "command",
			workspaceId,
			expectedSessionId: null,
			command: { id: "same-client-id", type: "get_state" },
		});
		a.send(command);
		b.send(command);

		await expect(responseA).resolves.toMatchObject({ id: "same-client-id", success: true });
		await expect(responseB).resolves.toMatchObject({ id: "same-client-id", success: true });
		a.close();
		b.close();
	});
});
