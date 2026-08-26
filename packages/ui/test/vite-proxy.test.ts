import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { createServer, type ProxyOptions, type UserConfig } from "vite";
import { describe, expect, it } from "vitest";
import config, { createGatewayProxy, DEV_GATEWAY_ORIGIN } from "../vite.config.js";

function proxyOptions(value: string | ProxyOptions | undefined): ProxyOptions {
	if (!value || typeof value === "string") throw new Error("expected explicit Vite proxy options");
	return value;
}

describe("development Gateway proxy", () => {
	it("rewrites REST and WebSocket requests to the Gateway origin", () => {
		const proxy = (config as UserConfig).server?.proxy;
		const rest = proxyOptions(proxy?.["/api"]);
		const socket = proxyOptions(proxy?.["/api/v1/ws"]);

		expect(rest).toMatchObject({
			target: DEV_GATEWAY_ORIGIN,
			changeOrigin: true,
			headers: { Origin: DEV_GATEWAY_ORIGIN },
		});
		expect(socket).toMatchObject({
			target: DEV_GATEWAY_ORIGIN.replace("http:", "ws:"),
			changeOrigin: true,
			headers: { Origin: DEV_GATEWAY_ORIGIN },
			ws: true,
		});
	});

	it("forwards REST and WebSocket upgrades with matching Gateway Host and Origin", async () => {
		let restRequests = 0;
		let upgradeRequests = 0;
		let resolveUpgrade!: (headers: http.IncomingHttpHeaders) => void;
		const upgradeHeaders = new Promise<http.IncomingHttpHeaders>((resolve) => {
			resolveUpgrade = resolve;
		});
		const gateway = http.createServer((request, response) => {
			restRequests += 1;
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ host: request.headers.host, origin: request.headers.origin }));
		});
		gateway.on("upgrade", (request, socket) => {
			upgradeRequests += 1;
			resolveUpgrade(request.headers);
			const key = request.headers["sec-websocket-key"];
			if (typeof key !== "string") {
				socket.destroy();
				return;
			}
			const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
			socket.end(
				[
					"HTTP/1.1 101 Switching Protocols",
					"Connection: Upgrade",
					"Upgrade: websocket",
					`Sec-WebSocket-Accept: ${accept}`,
					"",
					"",
				].join("\r\n"),
			);
		});
		await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
		const gatewayAddress = gateway.address() as AddressInfo;
		const gatewayOrigin = `http://127.0.0.1:${String(gatewayAddress.port)}`;
		const vite = await createServer({
			configFile: false,
			logLevel: "silent",
			server: { host: "127.0.0.1", port: 0, proxy: createGatewayProxy(gatewayOrigin) },
		});

		try {
			await vite.listen();
			const viteAddress = vite.httpServer?.address() as AddressInfo;
			const viteOrigin = `http://127.0.0.1:${String(viteAddress.port)}`;
			const rest = await fetch(`${viteOrigin}/api/v1/bootstrap`, {
				headers: { Origin: viteOrigin },
			});
			expect(await rest.json()).toEqual({
				host: `127.0.0.1:${String(gatewayAddress.port)}`,
				origin: gatewayOrigin,
			});

			const websocketResponse = (origin: string) =>
				new Promise<string>((resolve, reject) => {
					let response = "";
					let settled = false;
					let socket: net.Socket | undefined;
					const timeout = setTimeout(() => {
						socket?.destroy();
						finish();
					}, 500);
					const finish = () => {
						if (settled) return;
						settled = true;
						clearTimeout(timeout);
						socket?.destroy();
						resolve(response);
					};
					const client = net.connect(viteAddress.port, "127.0.0.1", () => {
						client.write(
							[
								"GET /api/v1/ws HTTP/1.1",
								`Host: 127.0.0.1:${String(viteAddress.port)}`,
								`Origin: ${origin}`,
								"Cookie: pi_web_session=valid-browser-cookie",
								"Connection: Upgrade",
								"Upgrade: websocket",
								"Sec-WebSocket-Version: 13",
								"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
								"",
								"",
							].join("\r\n"),
						);
					});
					socket = client;
					client.on("data", (data) => {
						response += data.toString("utf8");
						if (response.includes("\r\n\r\n")) finish();
					});
					client.once("close", finish);
					client.once("end", finish);
					client.once("error", reject);
				});
			expect(await websocketResponse(viteOrigin)).toContain("101 Switching Protocols");
			expect(await upgradeHeaders).toMatchObject({
				host: `127.0.0.1:${String(gatewayAddress.port)}`,
				origin: gatewayOrigin,
			});

			const crossPortOrigin = "http://127.0.0.1:65534";
			const rejectedRest = await fetch(`${viteOrigin}/api/v1/workspaces`, {
				headers: { Origin: crossPortOrigin, Cookie: "pi_web_session=valid-browser-cookie" },
			});
			expect(rejectedRest.status).toBe(404);
			expect(await websocketResponse(crossPortOrigin)).toContain("404 Not Found");
			const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
				const request = http.get(
					{
						host: "127.0.0.1",
						port: viteAddress.port,
						path: "/api/v1/bootstrap",
						headers: {
							Host: `0.0.0.0:${String(viteAddress.port)}`,
							Origin: `http://0.0.0.0:${String(viteAddress.port)}`,
						},
					},
					(response) => {
						response.resume();
						response.once("end", () => resolve(response.statusCode));
					},
				);
				request.once("error", reject);
			});
			expect(invalidHostStatus).toBe(404);
			expect(restRequests).toBe(1);
			expect(upgradeRequests).toBe(1);
		} finally {
			await vite.close();
			await new Promise<void>((resolve, reject) =>
				gateway.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
