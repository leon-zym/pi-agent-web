import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/main";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-smoke-"));
const handle = await startServer({
	config: { port: 3999, webDataDir: tmpData },
});

try {
	const base = "http://127.0.0.1:3999";
	const wsResp = (await (
		await fetch(`${base}/api/v1/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/Users/leonzhang/Code/pi-agent-web" }),
		})
	).json()) as { id: string };
	console.log("workspace registered:", wsResp.id);

	const WebSocket = (await import("ws")).default;
	const ws = new WebSocket("ws://127.0.0.1:3999/api/v1/ws");
	await new Promise<void>((resolve, reject) => {
		ws.on("open", () => resolve());
		ws.on("error", reject);
	});
	console.log("ws open");

	const frames: any[] = [];
	ws.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		console.log("FRAME:", JSON.stringify(frame).slice(0, 200));
		frames.push(frame);
	});

	ws.send(
		JSON.stringify({
			type: "command",
			workspaceId: wsResp.id,
			command: { id: "smoke-1", type: "get_state" },
		}),
	);
	console.log("sent get_state");

	const deadline = Date.now() + 30000;
	let state: any;
	while (Date.now() < deadline && !state) {
		const resp = frames.find((f) => f.type === "response" && f.response?.id === "smoke-1");
		if (resp) state = resp.response;
		if (!state) await new Promise((r) => setTimeout(r, 100));
	}
	console.log(
		"state:",
		JSON.stringify(state?.data ? { success: state.success, sessionId: state.data.sessionId } : state),
	);

	ws.close();
	console.log("SMOKE OK");
} catch (error) {
	console.error("SMOKE ERROR:", error);
} finally {
	await handle.close();
	fs.rmSync(tmpData, { recursive: true, force: true });
	process.exit(0);
}
