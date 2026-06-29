import fs from "node:fs";
import { type ServerType, serve } from "@hono/node-server";
import { loadConfig, type ServerConfig } from "./config";
import { type ResolvedPi, resolvePiRuntime } from "./resolver";
import { createApp } from "./routes";
import { Supervisor } from "./supervisor";
import { WorkspaceRegistry } from "./workspace-registry";
import { WsBridge } from "./ws-bridge";

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
	close: () => Promise<void>;
}

function log(level: "info" | "warn" | "error", message: string): void {
	const prefix = level === "error" ? "[pi-web] ERROR" : level === "warn" ? "[pi-web] WARN" : "[pi-web]";
	const line = `${prefix} ${message}`;
	if (level === "error") console.error(line);
	else console.log(line);
}

export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
	const config: ServerConfig = { ...loadConfig(), ...options.config };
	fs.mkdirSync(config.webDataDir, { recursive: true });

	// Three-tier runtime resolution (design spec §7.2). Boot continues even
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
			return record ? { cwd: record.path } : undefined;
		},
		log,
	});

	const app = createApp({ config, registry, supervisor });

	// Production: serve the built SPA (fallback to index.html for client routes).
	const staticDir = options.staticDir;
	if (staticDir && fs.existsSync(staticDir)) {
		app.get("/*", async (c) => {
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
	});

	// WebSocket upgrade on /api/v1/ws
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/api/v1/ws") {
			socket.destroy();
			return;
		}
		bridge.wss.handleUpgrade(req, socket, head, (ws) => {
			bridge.wss.emit("connection", ws, req);
		});
	});

	// Auto-open browser (npx closure, design spec §7.3).
	if (options.openInBrowser) {
		const { exec } = await import("node:child_process");
		const url = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
		const command =
			process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
		exec(`${command} ${JSON.stringify(url)}`, () => {});
	}

	const close = async (): Promise<void> => {
		bridge.close();
		await supervisor.stopAll();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			void close().then(() => process.exit(0));
		});
	}

	return { server, supervisor, bridge, registry, config, runtime, close };
}
