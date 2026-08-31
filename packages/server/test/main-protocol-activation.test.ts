import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	isGatewayServerHello,
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer } from "../src/main.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", "content-reference-pi.mjs");
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("production protocol 1.4 Main activation", () => {
	it("uses one canonical payload activation and rejects protocol 1.3", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-main-future-"));
		temporaryRoots.push(root);
		const handle = await startServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				agentDir: path.join(root, "agent"),
				sessionRootDir: path.join(root, "sessions"),
				webDataDir: path.join(root, "web-data"),
			},
			piPath: fixturePath,
			handleSignals: false,
		});

		try {
			const address = handle.server.address();
			if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
			const origin = `http://127.0.0.1:${String(address.port)}`;
			const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
			const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
			if (!cookie) throw new Error("bootstrap did not issue a cookie");
			const ws = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws`, {
				headers: { Cookie: cookie, Origin: origin },
			});
			try {
				await new Promise<void>((resolve, reject) => {
					ws.once("open", resolve);
					ws.once("error", reject);
				});
				const hello = new Promise<unknown>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("server hello timed out")), 2_000);
					ws.once("message", (raw) => {
						clearTimeout(timer);
						resolve(JSON.parse(raw.toString()) as unknown);
					});
				});
				ws.send(
					JSON.stringify({
						type: "client_hello",
						protocol: GATEWAY_PROTOCOL_VERSION,
						clientBuild: "main-protocol-activation-test",
						capabilities: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES],
						limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
					}),
				);
				const value = await hello;
				expect(isGatewayServerHello(value)).toBe(true);
				if (!isGatewayServerHello(value)) throw new Error("Gateway did not activate protocol 1.4");
				expect(value.protocol).toEqual({ major: 1, minor: 4 });
				expect(value.capabilities).toEqual(expect.arrayContaining([...GATEWAY_SERVER_REQUIRED_CAPABILITIES]));
				expect(value.payloadBudget).toEqual(SESSION_PAYLOAD_BUDGET);
				expect(value.contentRefBudget).toEqual(SESSION_CONTENT_REF_BUDGET);
				expect(handle.contentStore.usage).toEqual({ bytes: 0, items: 0 });
			} finally {
				ws.close();
			}

			const legacyWs = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws`, {
				headers: { Cookie: cookie, Origin: origin },
			});
			try {
				await new Promise<void>((resolve, reject) => {
					legacyWs.once("open", resolve);
					legacyWs.once("error", reject);
				});
				const legacyFrame = new Promise<unknown>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("legacy protocol error timed out")), 2_000);
					legacyWs.once("message", (raw) => {
						clearTimeout(timer);
						resolve(JSON.parse(raw.toString()) as unknown);
					});
				});
				legacyWs.send(
					JSON.stringify({
						type: "client_hello",
						protocol: { major: 1, minor: 3 },
						clientBuild: "legacy-compatibility-test",
						capabilities: [
							"rpc.commands",
							"rpc.events",
							"rpc.extension_ui",
							"session.multiplex",
							"session.hot_runtime_inventory",
							"payload.epoch_attachment_refs",
						],
						limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
					}),
				);
				expect(await legacyFrame).toMatchObject({
					type: "protocol_error",
					code: "invalid_hello",
				});
			} finally {
				legacyWs.close();
			}
		} finally {
			await handle.close();
		}
	});
});
