import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/main.js";

if (process.env.PI_WEB_RUN_E2E !== "1") {
	console.log("E2E skipped: set PI_WEB_RUN_E2E=1 to run against a configured real Pi provider.");
} else {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-e2e-"));
	const workspacePath = path.join(tempRoot, "workspace");
	const sessionRootDir = path.join(tempRoot, "sessions");
	const webDataDir = path.join(tempRoot, "web-data");
	fs.mkdirSync(workspacePath, { recursive: true });
	let handle: Awaited<ReturnType<typeof startServer>> | undefined;

	try {
		const started = await startServer({
			config: { port: 0, host: "127.0.0.1", sessionRootDir, webDataDir },
		});
		handle = started;
		await new Promise<void>((resolve, reject) => {
			started.server.once("listening", resolve);
			started.server.once("error", reject);
		});
		const address = started.server.address();
		if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
		const base = `http://127.0.0.1:${String(address.port)}`;
		const bootstrap = await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: base } });
		if (!bootstrap.ok) throw new Error(`bootstrap failed: ${String(bootstrap.status)}`);
		const setCookie = bootstrap.headers.get("set-cookie");
		if (!setCookie) throw new Error("bootstrap did not set a session cookie");
		const cookie = setCookie.split(";", 1)[0] ?? "";
		const authHeaders = { Origin: base, Cookie: cookie };

		const workspaceResponse = await fetch(`${base}/api/v1/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authHeaders },
			body: JSON.stringify({ path: workspacePath }),
		});
		if (!workspaceResponse.ok) {
			throw new Error(`workspace registration failed: ${String(workspaceResponse.status)}`);
		}
		const workspace = (await workspaceResponse.json()) as { id: string };

		const WebSocketCtor = (await import("ws")).default;
		const ws = new WebSocketCtor(`ws://127.0.0.1:${String(address.port)}/api/v1/ws`, {
			headers: authHeaders,
		});
		await new Promise<void>((resolve, reject) => {
			ws.on("open", resolve);
			ws.on("error", reject);
		});

		const pending = new Map<
			string,
			(response: { success?: boolean; error?: string; data?: unknown }) => void
		>();
		const events: Array<{ type: string; extra?: string }> = [];
		ws.on("message", (raw) => {
			const frame = JSON.parse(raw.toString()) as {
				type: string;
				response?: { id?: string; success?: boolean; error?: string; data?: unknown };
				event?: { type: string; assistantMessageEvent?: { type: string } };
			};
			if (frame.type === "response" && frame.response?.id) {
				pending.get(frame.response.id)?.(frame.response);
				pending.delete(frame.response.id);
			} else if (frame.type === "event" && frame.event) {
				events.push({
					type: frame.event.type,
					extra: frame.event.type === "message_update" ? frame.event.assistantMessageEvent?.type : undefined,
				});
			}
		});

		let sequence = 0;
		const command = (payload: Record<string, unknown>) => {
			sequence += 1;
			const id = `e2e-${String(sequence)}`;
			const response = new Promise<{ success?: boolean; error?: string; data?: unknown }>((resolve) => {
				pending.set(id, resolve);
			});
			ws.send(
				JSON.stringify({
					type: "command",
					workspaceId: workspace.id,
					expectedSessionId: null,
					command: { id, ...payload },
				}),
			);
			return response;
		};
		const expectOk = async (
			label: string,
			response: Promise<{ success?: boolean; error?: string; data?: unknown }>,
		) => {
			const result = await response;
			if (result.success === false) throw new Error(`${label} failed: ${result.error}`);
			console.log(`${label} ok`);
			return result;
		};

		await expectOk("new_session", command({ type: "new_session" }));
		const state = await expectOk("get_state", command({ type: "get_state" }));
		const sessionId = (state.data as { sessionId: string }).sessionId;
		ws.send(JSON.stringify({ type: "session_listen", workspaceId: workspace.id, sessionId }));

		await expectOk(
			"set_model",
			command({ type: "set_model", provider: "deepseek", modelId: "deepseek-v4-flash" }),
		);
		await expectOk("set_thinking_level", command({ type: "set_thinking_level", level: "off" }));

		const waitForSettled = async (label: string, timeoutMs: number) => {
			const deadline = Date.now() + timeoutMs;
			while (!events.some((event) => event.type === "agent_settled")) {
				if (Date.now() >= deadline) throw new Error(`${label} timeout`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		};

		await expectOk(
			"prompt",
			command({ type: "prompt", message: "用一句话回复：你好，世界", streamingBehavior: "steer" }),
		);
		await waitForSettled("prompt", 120_000);

		const messages = await expectOk("get_messages", command({ type: "get_messages" }));
		const list = (messages.data as { messages: Array<{ role: string }> }).messages;
		if (!list.some((message) => message.role === "assistant")) {
			throw new Error("prompt did not yield an assistant message");
		}

		events.length = 0;
		await expectOk(
			"prompt2",
			command({
				type: "prompt",
				message: "请写一篇 2000 字的文章，主题是 Rust 异步编程，先写大纲",
				streamingBehavior: "steer",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await expectOk("abort", command({ type: "abort" }));
		await waitForSettled("abort", 90_000);

		await expectOk("get_commands", command({ type: "get_commands" }));
		await expectOk("get_tree", command({ type: "get_tree" }));
		await expectOk("get_session_stats", command({ type: "get_session_stats" }));
		ws.close();
		console.log("E2E CONVERSATION OK");
	} catch (error) {
		process.exitCode = 1;
		console.error("E2E ERROR:", error);
	} finally {
		await handle?.close();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}
