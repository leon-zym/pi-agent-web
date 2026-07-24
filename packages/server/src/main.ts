import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { type ServerType, serve } from "@hono/node-server";
import { createGatewayAccessControl, type GatewayAccessControl } from "./access-control.js";
import { assertLoopbackHost, loadConfig, type ServerConfig } from "./config.js";
import { type ResolvedPi, resolvePiRuntime } from "./resolver.js";
import { createApp } from "./routes.js";
import { Supervisor } from "./supervisor.js";
import { WorkspaceRegistry } from "./workspace-registry.js";
import { WsBridge } from "./ws-bridge.js";

/**
 * Server bootstrap: config -> runtime resolution -> supervisor + ws bridge ->
 * REST API + SPA static hosting (production).
 */

export interface StartServerOptions {
	config?: Partial<ServerConfig>;
	piPath?: string;
	/** Serve the built SPA from this directory (production mode). */
	staticDir?: string;
	openInBrowser?: boolean;
}

export interface ServerHandle {
	server: ServerType;
	supervisor: Supervisor;
	bridge: WsBridge;
	registry: WorkspaceRegistry;
	config: ServerConfig;
	runtime: ResolvedPi;
	accessControl: GatewayAccessControl;
	close: () => Promise<void>;
}

function log(level: "info" | "warn" | "error", message: string): void {
	const prefix = level === "error" ? "[pi-web] ERROR" : level === "warn" ? "[pi-web] WARN" : "[pi-web]";
	const line = `${prefix} ${message}`;
	if (level === "error") console.error(line);
	else console.log(line);
}

function openBrowser(host: string, port: number): void {
	assertLoopbackHost(host);
	if (!Number.isInteger(port) || port < 1 || port > 65_535)
		throw new Error("browser port must be between 1 and 65535");
	const hostname = host === "::1" ? "[::1]" : host;
	const url = `http://${hostname}:${String(port)}`;
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["explorer.exe", [url]]
				: ["xdg-open", [url]];
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.unref();
		child.on("error", () => {
			// Browser launch is best-effort and must never bring down the gateway.
		});
	} catch {
		// Browser launch is best-effort and must never bring down the gateway.
	}
}

export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
	const config: ServerConfig = { ...loadConfig(), ...options.config };
	assertLoopbackHost(config.host);
	fs.mkdirSync(config.webDataDir, { recursive: true });
	const accessControl = createGatewayAccessControl(randomBytes(32).toString("base64url"));

	// Three-tier runtime resolution. Boot continues even
	// without pi so the UI can explain the situation; workspace opens will fail
	// with the resolver error until a runtime is available.
	let runtime: ResolvedPi;
	let runtimeWarning: string | undefined;
	try {
		runtime = await resolvePiRuntime({ piPath: options.piPath, baseDir: process.cwd() });
		log("info", `Pi runtime resolved: ${runtime.label}`);
	} catch (error) {
		runtimeWarning = error instanceof Error ? error.message : String(error);
		log("error", runtimeWarning);
		runtime = { command: "pi", args: ["--mode", "rpc"], source: "system", label: "unresolved" };
	}

	const registry = new WorkspaceRegistry(config.webDataDir);

	// Register every persisted workspace with the supervisor so WS commands can
	// find it immediately after boot (process spawn stays lazy on demand).

	const supervisor = new Supervisor({
		resolved: runtime,
		sessionRootDir: config.sessionRootDir,
		broadcast: (message) => bridge.broadcast(message),
		log,
	});

	const bridge = new WsBridge({
		supervisor,
		getWorkspace: (workspaceId) => {
			const record = registry.get(workspaceId);
			return record ? { cwd: record.cwdRealpath } : undefined;
		},
		log,
	});

	// Register every persisted workspace with the supervisor so WS commands
	// resolve immediately after boot (process spawn stays lazy on demand).
	for (const ws of registry.list()) {
		const record = registry.get(ws.id);
		if (record) supervisor.registerWorkspace(ws.id, record.cwdRealpath);
	}

	const app = createApp({ accessControl, config, registry, supervisor });

	// Production: serve the built SPA (fallback to index.html for client routes).
	// Only paths outside /api reach this handler; API routes win regardless.
	const staticDir = options.staticDir;
	if (staticDir && fs.existsSync(staticDir)) {
		app.get("/*", async (c) => {
			if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
			const urlPath = c.req.path;
			const filePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
			const candidate = `${staticDir}/${filePath}`;
			if (!filePath.includes("..") && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				const ext = filePath.split(".").pop() ?? "";
				const contentType: Record<string, string> = {
					html: "text/html; charset=utf-8",
					js: "text/javascript",
					css: "text/css",
					svg: "image/svg+xml",
					png: "image/png",
					jpg: "image/jpeg",
					jpeg: "image/jpeg",
					webp: "image/webp",
					ico: "image/x-icon",
					json: "application/json",
					woff2: "font/woff2",
					woff: "font/woff",
				};
				const body = fs.readFileSync(candidate);
				return new Response(new Uint8Array(body), {
					headers: { "Content-Type": contentType[ext ?? ""] ?? "application/octet-stream" },
				});
			}
			// SPA fallback
			const index = fs.readFileSync(`${staticDir}/index.html`);
			return new Response(new Uint8Array(index), { headers: { "Content-Type": "text/html; charset=utf-8" } });
		});
	}

	const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
		log("info", `pi-agent-web server listening on http://${config.host}:${info.port}`);
		if (runtimeWarning) log("warn", runtimeWarning);
		if (options.openInBrowser) openBrowser(config.host, info.port);
	});

	// WebSocket upgrade on /api/v1/ws
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/api/v1/ws") {
			socket.destroy();
			return;
		}
		if (!accessControl.isAuthorized(req.headers)) {
			const body = "Forbidden";
			socket.write(
				[
					"HTTP/1.1 403 Forbidden",
					"Connection: close",
					"Content-Type: text/plain; charset=utf-8",
					`Content-Length: ${String(Buffer.byteLength(body))}`,
					"",
					body,
				].join("\r\n"),
			);
			socket.destroy();
			return;
		}
		bridge.wss.handleUpgrade(req, socket, head, (ws) => {
			bridge.wss.emit("connection", ws, req);
		});
	});

	const close = async (): Promise<void> => {
		bridge.close();
		await supervisor.stopAll();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		registry.close();
	};

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			void close().then(() => process.exit(0));
		});
	}

	return { server, supervisor, bridge, registry, config, runtime, accessControl, close };
}

// Run as the main entry (node dist/main.js / tsx src/main.ts).
import { pathToFileURL } from "node:url";

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
	void startServer();
}
