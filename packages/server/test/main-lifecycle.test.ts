import fs from "node:fs";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/main.js";
import { WorkspacePreferences } from "../src/workspace-preferences.js";

const temporaryRoots: string[] = [];
const fixturePath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-main-lifecycle-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("production server lifecycle", () => {
	it("resolves only after binding and cannot resurrect after an immediate close", async () => {
		const root = temporaryRoot();
		const webDataDir = path.join(root, "web-data");
		const handle = await startServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				agentDir: path.join(root, "agent"),
				sessionRootDir: path.join(root, "sessions"),
				webDataDir,
			},
			piPath: fixturePath,
			handleSignals: false,
		});

		expect(handle.server.listening).toBe(true);
		expect(handle.server.address()).not.toBeNull();
		await handle.close();
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(handle.server.listening).toBe(false);
		expect(handle.server.address()).toBeNull();

		const replacement = new WorkspacePreferences(webDataDir);
		replacement.close();
	});

	it("rejects a bind failure and releases every startup resource", async () => {
		const root = temporaryRoot();
		const blocker = createServer();
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen(0, "127.0.0.1", resolve);
		});
		const address = blocker.address();
		if (!address || typeof address === "string") throw new Error("blocker did not bind a TCP port");
		const webDataDir = path.join(root, "web-data");
		try {
			await expect(
				startServer({
					config: {
						port: address.port,
						host: "127.0.0.1",
						agentDir: path.join(root, "agent"),
						sessionRootDir: path.join(root, "sessions"),
						webDataDir,
					},
					piPath: fixturePath,
					handleSignals: false,
				}),
			).rejects.toMatchObject({ code: "EADDRINUSE" });
		} finally {
			await new Promise<void>((resolve, reject) => {
				blocker.close((error) => (error ? reject(error) : resolve()));
			});
		}

		const replacement = new WorkspacePreferences(webDataDir);
		replacement.close();
	});

	it("force-closes an incomplete HTTP request within the shutdown bound", async () => {
		const root = temporaryRoot();
		const webDataDir = path.join(root, "web-data");
		const handle = await startServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				agentDir: path.join(root, "agent"),
				sessionRootDir: path.join(root, "sessions"),
				webDataDir,
			},
			piPath: fixturePath,
			handleSignals: false,
		});
		const address = handle.server.address();
		if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
		const origin = `http://127.0.0.1:${String(address.port)}`;
		const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
		const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
		if (!cookie) throw new Error("bootstrap did not issue a cookie");
		const socket = createConnection({ host: "127.0.0.1", port: address.port });
		socket.on("error", () => undefined);
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		await new Promise<void>((resolve, reject) => {
			socket.write(
				[
					"POST /api/v1/auth/keys HTTP/1.1",
					`Host: 127.0.0.1:${String(address.port)}`,
					`Origin: ${origin}`,
					`Cookie: ${cookie}`,
					"Content-Type: application/json",
					"Content-Length: 1000",
					"Connection: keep-alive",
					"",
					"{",
				].join("\r\n"),
				(error) => (error ? reject(error) : resolve()),
			);
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

		const startedAt = Date.now();
		await handle.close();
		await socketClosed;
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(socket.destroyed).toBe(true);

		const replacement = new WorkspacePreferences(webDataDir);
		replacement.close();
	});

	it("waits for WebSocket and runtime shutdown before releasing preferences", async () => {
		const root = temporaryRoot();
		const webDataDir = path.join(root, "web-data");
		const staticDir = path.join(root, "static");
		fs.mkdirSync(staticDir);
		fs.writeFileSync(path.join(staticDir, "index.html"), "<main>fallback</main>");
		fs.writeFileSync(path.join(staticDir, "asset.txt"), "public asset");
		const privateFile = path.join(root, "private.txt");
		fs.writeFileSync(privateFile, "must not leak");
		fs.symlinkSync(privateFile, path.join(staticDir, "leak.txt"));
		const handle = await startServer({
			config: {
				port: 0,
				host: "127.0.0.1",
				agentDir: path.join(root, "agent"),
				sessionRootDir: path.join(root, "sessions"),
				webDataDir,
			},
			piPath: fixturePath,
			staticDir,
			handleSignals: false,
		});
		const address = handle.server.address();
		if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
		const origin = `http://127.0.0.1:${String(address.port)}`;
		const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
		const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
		if (!cookie) throw new Error("bootstrap did not issue a cookie");
		expect(await (await fetch(`${origin}/asset.txt`)).text()).toBe("public asset");
		expect(await (await fetch(`${origin}/leak.txt`)).text()).toBe("<main>fallback</main>");
		const WebSocketCtor = (await import("ws")).default;
		const socket = new WebSocketCtor(`${origin.replace("http", "ws")}/api/v1/ws`, {
			headers: { Origin: origin, Cookie: cookie },
		});
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

		const firstClose = handle.close();
		expect(handle.close()).toBe(firstClose);
		await firstClose;
		await socketClosed;
		expect(handle.server.listening).toBe(false);
		expect(handle.supervisor.listRuntimes()).toEqual([]);

		const replacement = new WorkspacePreferences(webDataDir);
		replacement.close();
	});
});
