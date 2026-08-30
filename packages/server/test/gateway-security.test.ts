import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
	GATEWAY_CONTENT_REF_CAPABILITY,
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	SESSION_PAYLOAD_BUDGET,
} from "@pi-agent-web/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServerHandle, startServer } from "../src/main.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-gateway-test-"));
const workspacePath = path.join(tempRoot, "workspace");
const agentDir = path.join(tempRoot, "agent");
const sessionRootDir = path.join(tempRoot, "sessions");
const webDataDir = path.join(tempRoot, "web-data");
const fakePiPath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");
const viteOrigin = "http://localhost:5173";
const REST_JSON_BODY_LIMIT_BYTES = 64 * 1024;
const PROVIDER_ID_LIMIT = 256;
const API_KEY_LIMIT = 16 * 1024;
const WORKSPACE_PATH_LIMIT = 8192;

let handle: ServerHandle;
let base: string;
let cookie: string;
let workspaceHandle: string;
let sessionHandle: string;
let sessionGeneration: number;

function authenticatedHeaders(origin = base): Record<string, string> {
	return { Origin: origin, Cookie: cookie };
}

async function openSocket(headers: Record<string, string>): Promise<import("ws").WebSocket> {
	const WebSocketCtor = (await import("ws")).default;
	const ws = new WebSocketCtor(`${base.replace("http", "ws")}/api/v1/ws`, { headers });
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const hello = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("server hello timed out")), 10_000);
		ws.once("message", (raw) => {
			clearTimeout(timeout);
			const frame = JSON.parse(raw.toString()) as { type?: string };
			if (frame.type === "server_hello") resolve();
			else reject(new Error("Gateway rejected client hello"));
		});
	});
	ws.send(
		JSON.stringify({
			type: "client_hello",
			protocol: GATEWAY_PROTOCOL_VERSION,
			clientBuild: "gateway-security-test",
			capabilities: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES],
			limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
		}),
	);
	await hello;
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

async function rawGet(pathname: string, headers: Record<string, string>): Promise<number | undefined> {
	const target = new URL(base);
	return new Promise((resolve, reject) => {
		const request = http.get(
			{
				host: target.hostname,
				port: Number(target.port),
				path: pathname,
				headers,
			},
			(response) => {
				response.resume();
				response.once("end", () => resolve(response.statusCode));
			},
		);
		request.once("error", reject);
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

	const bootstrap = await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: base } });
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
	workspaceHandle = ((await workspace.json()) as { workspaceHandle: string }).workspaceHandle;
	const session = await fetch(`${base}/api/v1/workspaces/${workspaceHandle}/sessions`, {
		method: "POST",
		headers: authenticatedHeaders(),
	});
	expect(session.status).toBe(201);
	const created = (await session.json()) as {
		runtime: { sessionHandle: string; generation: number };
	};
	sessionHandle = created.runtime.sessionHandle;
	sessionGeneration = created.runtime.generation;
});

afterAll(async () => {
	await handle?.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("gateway access control", () => {
	it("rejects non-loopback listener configuration", async () => {
		await expect(startServer({ config: { host: "0.0.0.0" } })).rejects.toThrow("PI_WEB_HOST");
	});

	it("boots only from the Gateway origin without exposing the session secret", async () => {
		expect(cookie).toMatch(/^pi_web_session=/);
		expect(cookie).not.toContain("undefined");
		const sessionCookie = (
			await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: base } })
		).headers.get("set-cookie");
		expect(sessionCookie).toContain("HttpOnly");
		expect(sessionCookie).toContain("SameSite=Strict");
		expect((await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: viteOrigin } })).status).toBe(403);
	});

	it("advertises the canonical content-reference contract in the production hello", async () => {
		const WebSocketCtor = (await import("ws")).default;
		const ws = new WebSocketCtor(`${base.replace("http", "ws")}/api/v1/ws`, {
			headers: authenticatedHeaders(),
		});
		try {
			await new Promise<void>((resolve, reject) => {
				ws.once("open", resolve);
				ws.once("error", reject);
			});
			const hello = new Promise<{
				protocol: { major: number; minor: number };
				capabilities: string[];
			}>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("server hello timed out")), 10_000);
				ws.once("message", (raw) => {
					clearTimeout(timeout);
					resolve(JSON.parse(raw.toString()));
				});
			});
			ws.send(
				JSON.stringify({
					type: "client_hello",
					protocol: GATEWAY_PROTOCOL_VERSION,
					clientBuild: "generic-content-inert-test",
					capabilities: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES],
					limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
				}),
			);
			const serverHello = await hello;
			expect(serverHello.protocol).toEqual(GATEWAY_PROTOCOL_VERSION);
			expect(serverHello.capabilities).toContain(GATEWAY_CONTENT_REF_CAPABILITY);
		} finally {
			ws.close();
		}
	});

	it("rejects a production cross-port origin even when it presents a valid cookie", async () => {
		expect(
			(
				await fetch(`${base}/api/v1/workspaces`, {
					headers: { Origin: viteOrigin, Cookie: cookie },
				})
			).status,
		).toBe(403);

		const WebSocketCtor = (await import("ws")).default;
		const socket = new WebSocketCtor(`${base.replace("http", "ws")}/api/v1/ws`, {
			headers: { Origin: viteOrigin, Cookie: cookie },
		});
		const status = await new Promise<number | undefined>((resolve) => {
			socket.once("unexpected-response", (_request, response) => resolve(response.statusCode));
			socket.once("error", () => resolve(undefined));
		});
		expect(status).toBe(403);
	});

	it("accepts browser same-origin GET requests that omit Origin", async () => {
		const bootstrap = await fetch(`${base}/api/v1/bootstrap`, {
			headers: { "Sec-Fetch-Site": "same-origin" },
		});
		expect(bootstrap.status).toBe(200);
		const browserCookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
		expect(browserCookie).toMatch(/^pi_web_session=/);

		const workspaces = await fetch(`${base}/api/v1/workspaces`, {
			headers: { "Sec-Fetch-Site": "same-origin", Cookie: browserCookie ?? "" },
		});
		expect(workspaces.status).toBe(200);

		const crossSite = await fetch(`${base}/api/v1/bootstrap`, {
			headers: { "Sec-Fetch-Site": "cross-site" },
		});
		expect(crossSite.status).toBe(403);
	});

	it("protects generic content GETs with the same Cookie, target, Origin, and Fetch Metadata checks", async () => {
		const url = `${base}/api/v1/content/${handle.serverEpoch}/${"a".repeat(64)}`;
		const authorized = await fetch(url, {
			headers: { "Sec-Fetch-Site": "same-origin", Cookie: cookie },
		});
		expect(authorized.status).toBe(404);
		expect(authorized.headers.get("cache-control")).toBe("no-store");

		for (const response of [
			await fetch(url, { headers: { Origin: base } }),
			await fetch(url, { headers: { Origin: viteOrigin, Cookie: cookie } }),
			await fetch(url, { headers: { "Sec-Fetch-Site": "cross-site", Cookie: cookie } }),
		]) {
			expect(response.status).toBe(403);
			expect(response.headers.get("cache-control")).toBe("no-store");
		}

		const port = new URL(base).port;
		expect(
			await rawGet(`/api/v1/content/${handle.serverEpoch}/${"a".repeat(64)}`, {
				Host: `evil.example:${port}`,
				"Sec-Fetch-Site": "same-origin",
				Cookie: cookie,
			}),
		).toBe(403);
	});

	it("rejects DNS-rebinding requests with a non-loopback Host", async () => {
		const port = new URL(base).port;
		expect(
			await rawGet("/api/v1/bootstrap", {
				Host: `evil.example:${port}`,
				"Sec-Fetch-Site": "same-origin",
			}),
		).toBe(403);
		expect(
			await rawGet("/api/v1/workspaces", {
				Host: `evil.example:${port}`,
				"Sec-Fetch-Site": "same-origin",
				Cookie: cookie,
			}),
		).toBe(403);
	});

	it("rejects REST calls without a matching cookie and origin", async () => {
		expect((await fetch(`${base}/api/v1/workspaces`, { headers: { Origin: base } })).status).toBe(403);
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

	it("returns a client error for malformed or invalid write bodies", async () => {
		expect(
			(
				await fetch(`${base}/api/v1/workspaces`, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...authenticatedHeaders() },
					body: "{",
				})
			).status,
		).toBe(400);
		expect(
			(
				await fetch(`${base}/api/v1/auth/keys`, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...authenticatedHeaders() },
					body: JSON.stringify({ provider: "  ", key: "  " }),
				})
			).status,
		).toBe(400);
	});

	it("rejects oversized authenticated JSON bodies from Content-Length and streaming uploads", async () => {
		const contentLengthSentinel = "CONTENT_LENGTH_SECRET_SENTINEL";
		const declared = await fetch(`${base}/api/v1/auth/keys`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authenticatedHeaders() },
			body: JSON.stringify({
				provider: "bounded-provider",
				key: `${contentLengthSentinel}${"x".repeat(REST_JSON_BODY_LIMIT_BYTES)}`,
			}),
		});
		const declaredBody = (await declared.json()) as {
			error?: { code?: string; message?: string };
		};
		expect(declared.status).toBe(413);
		expect(declaredBody.error?.code).toBe("request_body_too_large");
		expect(declaredBody.error?.message).not.toContain(contentLengthSentinel);

		const streamedText = JSON.stringify({
			path: workspacePath,
			padding: "y".repeat(REST_JSON_BODY_LIMIT_BYTES),
		});
		const encoded = new TextEncoder().encode(streamedText);
		const streamedBody = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < encoded.length; offset += 4096) {
					controller.enqueue(encoded.subarray(offset, Math.min(offset + 4096, encoded.length)));
				}
				controller.close();
			},
		});
		const streamed = await fetch(`${base}/api/v1/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authenticatedHeaders() },
			body: streamedBody,
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		const streamedResponseBody = (await streamed.json()) as {
			error?: { code?: string; message?: string };
		};
		expect(streamed.status).toBe(413);
		expect(streamedResponseBody.error?.code).toBe("request_body_too_large");

		const health = await fetch(`${base}/api/v1/health`, { headers: authenticatedHeaders() });
		expect(health.status).toBe(200);
	});

	it("bounds credential and workspace fields without reflecting credential values", async () => {
		const provider = await fetch(`${base}/api/v1/auth/keys`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authenticatedHeaders() },
			body: JSON.stringify({ provider: "p".repeat(PROVIDER_ID_LIMIT + 1), key: "unused" }),
		});
		expect(provider.status).toBe(422);
		expect((await provider.json()) as unknown).toMatchObject({ error: { code: "invalid_provider" } });

		const keySentinel = "FIELD_SECRET_SENTINEL";
		const key = await fetch(`${base}/api/v1/auth/keys`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authenticatedHeaders() },
			body: JSON.stringify({
				provider: "bounded-provider",
				key: `${keySentinel}${"k".repeat(API_KEY_LIMIT)}`,
			}),
		});
		const keyResponseText = await key.text();
		expect(key.status).toBe(422);
		expect(JSON.parse(keyResponseText)).toMatchObject({ error: { code: "invalid_key" } });
		expect(keyResponseText).not.toContain(keySentinel);
		const authFile = path.join(agentDir, "auth.json");
		if (fs.existsSync(authFile)) expect(fs.readFileSync(authFile, "utf8")).not.toContain(keySentinel);

		const workspace = await fetch(`${base}/api/v1/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authenticatedHeaders() },
			body: JSON.stringify({ path: `/${"w".repeat(WORKSPACE_PATH_LIMIT)}` }),
		});
		expect(workspace.status).toBe(422);
		expect((await workspace.json()) as unknown).toMatchObject({ error: { code: "invalid_path" } });
	});

	it("rejects unauthorized websocket upgrades and policy-violating frames", async () => {
		const WebSocketCtor = (await import("ws")).default;
		const unauthorized = new WebSocketCtor(`${base.replace("http", "ws")}/api/v1/ws`, {
			headers: { Origin: base },
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
		const subscribe = (ws: import("ws").WebSocket) =>
			new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("subscribe timed out")), 10_000);
				const onMessage = (raw: Buffer) => {
					const frame = JSON.parse(raw.toString()) as {
						type?: string;
						runtime?: { sessionHandle?: string };
					};
					if (frame.type !== "runtime_state" || frame.runtime?.sessionHandle !== sessionHandle) return;
					clearTimeout(timeout);
					ws.off("message", onMessage);
					resolve();
				};
				ws.on("message", onMessage);
				ws.send(JSON.stringify({ type: "session_subscribe", sessionHandle }));
			});
		await Promise.all([subscribe(a), subscribe(b)]);
		const responseA = responseFor(a, "same-client-id");
		const responseB = responseFor(b, "same-client-id");
		const command = JSON.stringify({
			type: "command",
			sessionHandle,
			expectedGeneration: sessionGeneration,
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
