import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServerHandle, startServer } from "../src/main.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-session-control-"));
const workspacePath = path.join(tempRoot, "workspace");
const agentDir = path.join(tempRoot, "agent");
const sessionRootDir = path.join(tempRoot, "sessions");
const webDataDir = path.join(tempRoot, "web-data");
const fakePiPath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");
const viteOrigin = "http://localhost:5173";

interface RuntimeIdentity {
	sessionHandle: string;
	generation: number;
}

let handle: ServerHandle;
let base: string;
let cookie: string;
let workspaceHandle: string;
let sessions: [RuntimeIdentity, RuntimeIdentity];

function headers(): Record<string, string> {
	return { Origin: viteOrigin, Cookie: cookie };
}

async function openSocket(): Promise<import("ws").WebSocket> {
	const WebSocketCtor = (await import("ws")).default;
	const ws = new WebSocketCtor(`${base.replace("http", "ws")}/api/v1/ws`, { headers: headers() });
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	return ws;
}

function frameFor(
	ws: import("ws").WebSocket,
	predicate: (frame: Record<string, any>) => boolean,
): Promise<Record<string, any>> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("server frame timed out")), 10_000);
		const onMessage = (raw: Buffer) => {
			const frame = JSON.parse(raw.toString()) as Record<string, any>;
			if (!predicate(frame)) return;
			clearTimeout(timer);
			ws.off("message", onMessage);
			resolve(frame);
		};
		ws.on("message", onMessage);
	});
}

async function subscribe(ws: import("ws").WebSocket, sessionHandle: string): Promise<void> {
	const baseline = frameFor(
		ws,
		(frame) => frame.type === "runtime_state" && frame.runtime?.sessionHandle === sessionHandle,
	);
	const lease = frameFor(
		ws,
		(frame) =>
			frame.type === "lease_status" && frame.sessionHandle === sessionHandle && frame.isController === false,
	);
	ws.send(JSON.stringify({ type: "session_subscribe", sessionHandle }));
	await Promise.all([baseline, lease]);
}

async function claim(
	ws: import("ws").WebSocket,
	sessionHandle: string,
): Promise<{ isController: boolean; fencingToken?: string }> {
	const status = frameFor(
		ws,
		(frame) => frame.type === "lease_status" && frame.sessionHandle === sessionHandle,
	);
	ws.send(JSON.stringify({ type: "session_claim", sessionHandle }));
	return (await status) as { isController: boolean; fencingToken?: string };
}

async function command(
	ws: import("ws").WebSocket,
	runtime: RuntimeIdentity,
	id: string,
	fencingToken: string | undefined,
): Promise<Record<string, any>> {
	const response = frameFor(ws, (frame) => frame.type === "response" && frame.response?.id === id);
	ws.send(
		JSON.stringify({
			type: "command",
			sessionHandle: runtime.sessionHandle,
			expectedGeneration: runtime.generation,
			...(fencingToken ? { fencingToken } : {}),
			command: { id, type: "set_session_name", name: id },
		}),
	);
	return response;
}

async function closeSocket(ws: import("ws").WebSocket): Promise<void> {
	if (ws.readyState === ws.CLOSED) return;
	await new Promise<void>((resolve) => {
		ws.once("close", resolve);
		ws.close();
	});
}

beforeAll(async () => {
	fs.mkdirSync(workspacePath, { recursive: true });
	handle = await startServer({
		config: { port: 0, host: "127.0.0.1", agentDir, sessionRootDir, webDataDir },
		piPath: fakePiPath,
		handleSignals: false,
	});
	const address = handle.server.address();
	if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
	base = `http://127.0.0.1:${String(address.port)}`;

	const bootstrap = await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: viteOrigin } });
	const setCookie = bootstrap.headers.get("set-cookie");
	if (!setCookie) throw new Error("bootstrap did not set a session cookie");
	cookie = setCookie.split(";", 1)[0] ?? "";

	const workspace = await fetch(`${base}/api/v1/workspaces`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers() },
		body: JSON.stringify({ path: workspacePath }),
	});
	workspaceHandle = ((await workspace.json()) as { workspaceHandle: string }).workspaceHandle;
	const created = await Promise.all(
		[0, 1].map(async () => {
			const response = await fetch(`${base}/api/v1/workspaces/${workspaceHandle}/sessions`, {
				method: "POST",
				headers: headers(),
			});
			expect(response.status).toBe(201);
			return ((await response.json()) as { runtime: RuntimeIdentity }).runtime;
		}),
	);
	sessions = [created[0]!, created[1]!];
});

afterAll(async () => {
	await handle?.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("Session controller leases", () => {
	it("isolates ownership per Session and releases a lease on disconnect", async () => {
		const [left, right] = await Promise.all([openSocket(), openSocket()]);
		await Promise.all([
			subscribe(left, sessions[0].sessionHandle),
			subscribe(right, sessions[0].sessionHandle),
			subscribe(right, sessions[1].sessionHandle),
		]);

		const leftFirst = await claim(left, sessions[0].sessionHandle);
		expect(leftFirst).toMatchObject({ isController: true, fencingToken: expect.any(String) });
		await expect(claim(right, sessions[0].sessionHandle)).resolves.toMatchObject({
			isController: false,
		});
		await expect(command(right, sessions[0], "blocked", undefined)).resolves.toMatchObject({
			response: { success: false, error: "session_read_only" },
		});
		await expect(command(left, sessions[0], "left-owned", leftFirst.fencingToken)).resolves.toMatchObject({
			response: { success: true },
		});

		const rightSecond = await claim(right, sessions[1].sessionHandle);
		expect(rightSecond).toMatchObject({ isController: true, fencingToken: expect.any(String) });
		await expect(command(right, sessions[1], "right-owned", rightSecond.fencingToken)).resolves.toMatchObject(
			{ response: { success: true } },
		);

		await closeSocket(left);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const reclaimed = await claim(right, sessions[0].sessionHandle);
		expect(reclaimed).toMatchObject({ isController: true, fencingToken: expect.any(String) });
		await expect(command(right, sessions[0], "reclaimed", reclaimed.fencingToken)).resolves.toMatchObject({
			response: { success: true },
		});

		expect(handle.supervisor.listRuntimes()).toHaveLength(2);
		await closeSocket(right);
	});
});
