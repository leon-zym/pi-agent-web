import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/main.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-smoke-"));
const workspacePath = path.join(tempRoot, "workspace");
const agentDir = path.join(tempRoot, "agent");
const sessionRootDir = path.join(tempRoot, "sessions");
const webDataDir = path.join(tempRoot, "web-data");
const fakePiPath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");
fs.mkdirSync(workspacePath, { recursive: true });

let handle: Awaited<ReturnType<typeof startServer>> | undefined;

try {
	const started = await startServer({
		config: { port: 0, host: "127.0.0.1", agentDir, sessionRootDir, webDataDir },
		piPath: fakePiPath,
		handleSignals: false,
	});
	handle = started;
	const address = started.server.address();
	if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
	const base = `http://127.0.0.1:${String(address.port)}`;
	const bootstrap = await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: base } });
	if (!bootstrap.ok) throw new Error(`bootstrap failed: ${String(bootstrap.status)}`);
	const setCookie = bootstrap.headers.get("set-cookie");
	if (!setCookie) throw new Error("bootstrap did not set a session cookie");
	const cookie = setCookie.split(";", 1)[0] ?? "";
	const authHeaders = { Origin: base, Cookie: cookie };

	const health = await fetch(`${base}/api/v1/health`, { headers: authHeaders });
	if (!health.ok) throw new Error(`health check failed: ${String(health.status)}`);

	const workspaceResponse = await fetch(`${base}/api/v1/workspaces`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders },
		body: JSON.stringify({ path: workspacePath }),
	});
	if (!workspaceResponse.ok)
		throw new Error(`workspace registration failed: ${String(workspaceResponse.status)}`);
	const workspace = (await workspaceResponse.json()) as { workspaceHandle: string };
	const sessionResponse = await fetch(`${base}/api/v1/workspaces/${workspace.workspaceHandle}/sessions`, {
		method: "POST",
		headers: authHeaders,
	});
	if (!sessionResponse.ok) throw new Error(`session creation failed: ${String(sessionResponse.status)}`);
	const created = (await sessionResponse.json()) as {
		runtime: { sessionHandle: string; generation: number };
	};

	const WebSocketCtor = (await import("ws")).default;
	const ws = new WebSocketCtor(`ws://127.0.0.1:${String(address.port)}/api/v1/ws`, { headers: authHeaders });
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const subscribed = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Session subscribe timed out")), 10_000);
		ws.on("message", (raw) => {
			const frame = JSON.parse(raw.toString()) as {
				type?: string;
				runtime?: { sessionHandle?: string };
			};
			if (frame.type !== "runtime_state" || frame.runtime?.sessionHandle !== created.runtime.sessionHandle) {
				return;
			}
			clearTimeout(timeout);
			resolve();
		});
	});
	ws.send(JSON.stringify({ type: "session_subscribe", sessionHandle: created.runtime.sessionHandle }));
	await subscribed;
	const state = await new Promise<{ sessionId: string }>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("get_state timed out")), 10_000);
		ws.on("message", (raw) => {
			const frame = JSON.parse(raw.toString()) as {
				type?: string;
				response?: { id?: string; success?: boolean; data?: { sessionId?: string } };
			};
			if (frame.type !== "response" || frame.response?.id !== "smoke-state") return;
			clearTimeout(timeout);
			if (frame.response.success !== true || typeof frame.response.data?.sessionId !== "string") {
				reject(new Error("get_state returned an invalid response"));
				return;
			}
			resolve({ sessionId: frame.response.data.sessionId });
		});
		ws.once("error", reject);
		ws.send(
			JSON.stringify({
				type: "command",
				sessionHandle: created.runtime.sessionHandle,
				expectedGeneration: created.runtime.generation,
				command: { id: "smoke-state", type: "get_state" },
			}),
		);
	});
	ws.close();
	console.log(`SMOKE OK: workspace ${workspace.workspaceHandle}, session ${state.sessionId}`);
} catch (error) {
	process.exitCode = 1;
	console.error("SMOKE ERROR:", error);
} finally {
	await handle?.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
