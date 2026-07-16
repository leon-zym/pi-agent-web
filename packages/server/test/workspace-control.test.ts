import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServerHandle, startServer } from "../src/main.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-workspace-control-"));
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
	predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("server frame timed out")), 10_000);
		const onMessage = (raw: Buffer) => {
			const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
			if (!predicate(frame)) return;
			clearTimeout(timer);
			ws.off("message", onMessage);
			resolve(frame);
		};
		ws.on("message", onMessage);
	});
}

function responseFor(ws: import("ws").WebSocket, id: string): Promise<{ success?: boolean; error?: string }> {
	return frameFor(
		ws,
		(frame) =>
			frame.type === "response" &&
			typeof frame.response === "object" &&
			frame.response !== null &&
			(frame.response as { id?: unknown }).id === id,
	).then((frame) => frame.response as { success?: boolean; error?: string });
}

async function closeSocket(ws: import("ws").WebSocket): Promise<void> {
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
	});
	await new Promise<void>((resolve, reject) => {
		handle.server.once("listening", resolve);
		handle.server.once("error", reject);
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
	workspaceId = ((await workspace.json()) as { id: string }).id;
});

afterAll(async () => {
	await handle?.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("workspace controller leases", () => {
	it("serializes controller ownership, rejects stale writes, and releases on disconnect", async () => {
		const [a, b] = await Promise.all([openSocket(), openSocket()]);
		const aLease = frameFor(a, (frame) => frame.type === "lease_status" && frame.isController === true);
		a.send(JSON.stringify({ type: "session_listen", workspaceId, sessionId: "fake-session" }));
		await expect(aLease).resolves.toMatchObject({ workspaceId, isController: true });

		const bLease = frameFor(b, (frame) => frame.type === "lease_status" && frame.isController === false);
		b.send(JSON.stringify({ type: "session_listen", workspaceId, sessionId: "fake-session" }));
		await expect(bLease).resolves.toMatchObject({ workspaceId, isController: false });

		const stateResponse = responseFor(a, "a-state");
		a.send(
			JSON.stringify({
				type: "command",
				workspaceId,
				expectedSessionId: null,
				command: { id: "a-state", type: "get_state" },
			}),
		);
		await expect(stateResponse).resolves.toMatchObject({ success: true });

		for (const command of [
			{ id: "b-prompt", type: "prompt", message: "blocked" },
			{ id: "b-abort", type: "abort" },
			{ id: "b-switch", type: "switch_session", sessionPath: path.join(workspacePath, "foreign.jsonl") },
		]) {
			const response = responseFor(b, command.id);
			b.send(JSON.stringify({ type: "command", workspaceId, expectedSessionId: "fake-session", command }));
			await expect(response).resolves.toMatchObject({ success: false, error: "workspace_read_only" });
		}

		const staleResponse = responseFor(a, "a-stale");
		a.send(
			JSON.stringify({
				type: "command",
				workspaceId,
				expectedSessionId: "old-session",
				command: { id: "a-stale", type: "prompt", message: "stale" },
			}),
		);
		await expect(staleResponse).resolves.toMatchObject({ success: false, error: "session_stale" });

		const dialogFrame = frameFor(
			a,
			(frame) =>
				frame.type === "extension_ui_request" && (frame.request as { id?: unknown }).id === "fake-dialog",
		);
		const dialogPrompt = responseFor(a, "a-dialog");
		a.send(
			JSON.stringify({
				type: "command",
				workspaceId,
				expectedSessionId: "fake-session",
				command: { id: "a-dialog", type: "prompt", message: "open-dialog" },
			}),
		);
		await expect(dialogPrompt).resolves.toMatchObject({ success: true });
		await dialogFrame;

		b.send(
			JSON.stringify({
				type: "extension_ui_response",
				workspaceId,
				expectedSessionId: "fake-session",
				response: { type: "extension_ui_response", id: "fake-dialog", confirmed: true },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(handle.supervisor.cancelDialogsForSession(workspaceId, "fake-session")).toBe(1);

		const bReleasedLease = frameFor(
			b,
			(frame) => frame.type === "lease_status" && frame.isController === false,
		);
		await closeSocket(a);
		await expect(bReleasedLease).resolves.toMatchObject({ workspaceId, isController: false });
		const bClaim = frameFor(b, (frame) => frame.type === "lease_status" && frame.isController === true);
		b.send(JSON.stringify({ type: "session_claim", workspaceId }));
		await expect(bClaim).resolves.toMatchObject({ workspaceId, isController: true });

		const resumedResponse = responseFor(b, "b-resumed");
		b.send(
			JSON.stringify({
				type: "command",
				workspaceId,
				expectedSessionId: "fake-session",
				command: { id: "b-resumed", type: "prompt", message: "resumed" },
			}),
		);
		await expect(resumedResponse).resolves.toMatchObject({ success: true });
		await closeSocket(b);
	});
});
