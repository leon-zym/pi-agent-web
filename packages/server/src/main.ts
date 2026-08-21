import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { createGatewayAccessControl, type GatewayAccessControl } from "./access-control.js";
import { assertLoopbackHost, ENV_SESSION_DIR, loadConfig, type ServerConfig } from "./config.js";
import { NativeSessionCatalog, sessionHandleForCanonicalFile } from "./native-session-catalog.js";
import { RecoverableSessionTrash } from "./recoverable-session-trash.js";
import { type ResolvedPi, resolvePiRuntime } from "./resolver.js";
import { createApp } from "./routes.js";
import { SessionLayoutResolver } from "./session-layout-resolver.js";
import { SessionSupervisor } from "./session-supervisor.js";
import { SessionWsBridge } from "./session-ws-bridge.js";
import { WorkspacePreferences } from "./workspace-preferences.js";

/** Server bootstrap for Pi-native, Session-scoped runtime ownership. */

const INGRESS_SHUTDOWN_GRACE_MS = 250;

export interface StartServerOptions {
	config?: Partial<ServerConfig>;
	piPath?: string;
	/** Serve the built SPA from this directory (production mode). */
	staticDir?: string;
	openInBrowser?: boolean;
	/** The CLI owns signal handling so it can await a clean shutdown itself. */
	handleSignals?: boolean;
}

export interface ServerHandle {
	server: ServerType;
	supervisor: SessionSupervisor;
	bridge: SessionWsBridge;
	catalog: NativeSessionCatalog;
	layoutResolver: SessionLayoutResolver;
	preferences: WorkspacePreferences;
	trash: RecoverableSessionTrash;
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
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("browser port must be between 1 and 65535");
	}
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
	fs.mkdirSync(config.webDataDir, { recursive: true, mode: 0o700 });
	const accessControl = createGatewayAccessControl(randomBytes(32).toString("base64url"));

	let runtime: ResolvedPi;
	let runtimeWarning: string | undefined;
	try {
		runtime = await resolvePiRuntime({ piPath: options.piPath, baseDir: process.cwd() });
		log("info", `Pi runtime resolved: ${runtime.label}`);
	} catch (error) {
		runtimeWarning = errorText(error);
		log("error", runtimeWarning);
		runtime = { command: "pi", args: ["--mode", "rpc"], source: "system", label: "unresolved" };
	}

	const layoutEnv: NodeJS.ProcessEnv = { ...process.env };
	if (Object.hasOwn(options.config ?? {}, "sessionRootDir")) {
		layoutEnv[ENV_SESSION_DIR] = config.sessionRootDir;
	}
	const layoutResolver = new SessionLayoutResolver({
		...(Object.hasOwn(options.config ?? {}, "agentDir") ? { agentDir: config.agentDir } : {}),
		env: layoutEnv,
		runtimeCwd: process.cwd(),
		settingsProbeCwd: process.cwd(),
	});
	const preferences = new WorkspacePreferences(config.webDataDir);
	const catalog = new NativeSessionCatalog({
		layoutResolver,
		preferences,
		cacheTtlMs: 1_000,
	});
	const trash = new RecoverableSessionTrash(config.webDataDir);

	let bridge!: SessionWsBridge;
	const supervisor = new SessionSupervisor({
		resolved: runtime,
		envForWorkspace: (cwd) => layoutResolver.normalizedChildEnvForWorkspace(cwd),
		resolveSession: async (sessionHandle) => {
			const snapshot = await catalog.refresh({ force: true });
			const session = snapshot.sessions.find((candidate) => candidate.sessionHandle === sessionHandle);
			if (!session?.workspaceAvailable || !session.workspacePath) return undefined;
			let canonicalFile: string;
			try {
				canonicalFile = await fs.promises.realpath(session.sessionFile);
			} catch {
				return undefined;
			}
			if (
				canonicalFile !== session.sessionFile ||
				sessionHandleForCanonicalFile(canonicalFile) !== sessionHandle
			) {
				return undefined;
			}
			return {
				kind: "existing" as const,
				sessionHandle: session.sessionHandle,
				workspaceId: session.workspaceHandle,
				cwd: session.workspacePath,
				sessionFile: canonicalFile,
				nativeSessionId: session.nativeSessionId,
			};
		},
		broadcast: (message) => bridge.broadcast(message),
		log,
	});
	bridge = new SessionWsBridge({ supervisor, log });

	const app = createApp({
		accessControl,
		config,
		catalog,
		layoutResolver,
		preferences,
		supervisor,
		trash,
	});
	serveStaticApp(app, options.staticDir);

	let server: ServerType;
	try {
		server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
	} catch (error) {
		await cleanupFailedStartup(bridge, supervisor, preferences);
		throw error;
	}
	const sockets = new Set<Socket>();
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	try {
		await waitForListening(server);
	} catch (error) {
		await cleanupFailedStartup(bridge, supervisor, preferences, server);
		throw error;
	}
	const address = server.address();
	if (!address || typeof address === "string") {
		await cleanupFailedStartup(bridge, supervisor, preferences, server);
		throw new Error("gateway did not expose a TCP address after listening");
	}
	log("info", `pi-agent-web server listening on http://${config.host}:${address.port}`);
	if (runtimeWarning) log("warn", runtimeWarning);
	if (options.openInBrowser) openBrowser(config.host, address.port);

	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== "/api/v1/ws") {
			socket.destroy();
			return;
		}
		if (!accessControl.isAuthorized(request.headers)) {
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
		bridge.wss.handleUpgrade(request, socket, head, (ws) => {
			bridge.wss.emit("connection", ws, request);
		});
	});

	const signalHandlers = new Map<NodeJS.Signals, () => void>();
	let closePromise: Promise<void> | null = null;
	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			for (const [signal, handler] of signalHandlers) process.off(signal, handler);
			signalHandlers.clear();
			const results = await closeIngress(server, bridge, sockets);
			results.push(...(await Promise.allSettled([supervisor.stopAll()])));
			preferences.close();
			const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length > 0) throw new AggregateError(errors, "gateway shutdown failed");
		})();
		return closePromise;
	};

	if (options.handleSignals !== false) {
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			const handler = () => {
				void close().then(
					() => process.exit(0),
					(error: unknown) => {
						log("error", `shutdown failed: ${errorText(error)}`);
						process.exit(1);
					},
				);
			};
			signalHandlers.set(signal, handler);
			process.on(signal, handler);
		}
	}

	return {
		server,
		supervisor,
		bridge,
		catalog,
		layoutResolver,
		preferences,
		trash,
		config,
		runtime,
		accessControl,
		close,
	};
}

function serveStaticApp(app: ReturnType<typeof createApp>, staticDir: string | undefined): void {
	if (!staticDir || !fs.existsSync(staticDir)) return;
	const staticRoot = fs.realpathSync(staticDir);
	app.get("/*", async (c) => {
		if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
		const filePath = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\//, "");
		const resolved = resolveStaticFile(staticRoot, filePath);
		if (resolved) {
			const extension = path.extname(resolved).slice(1);
			const body = fs.readFileSync(resolved);
			return new Response(new Uint8Array(body), {
				headers: { "Content-Type": contentTypeFor(extension) },
			});
		}
		const index = fs.readFileSync(`${staticRoot}/index.html`);
		return new Response(new Uint8Array(index), {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	});
}

function resolveStaticFile(staticRoot: string, requestedPath: string): string | undefined {
	const candidate = path.resolve(staticRoot, requestedPath);
	if (!isPathInside(staticRoot, candidate)) return undefined;
	try {
		const canonical = fs.realpathSync(candidate);
		if (!isPathInside(staticRoot, canonical) || !fs.statSync(canonical).isFile()) return undefined;
		return canonical;
	} catch {
		return undefined;
	}
}

function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

function contentTypeFor(extension: string): string {
	const contentTypes: Record<string, string> = {
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
	return contentTypes[extension] ?? "application/octet-stream";
}

function waitForListening(server: ServerType): Promise<void> {
	if (server.listening) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		server.once("listening", onListening);
		server.once("error", onError);
	});
}

async function cleanupFailedStartup(
	bridge: SessionWsBridge,
	supervisor: SessionSupervisor,
	preferences: WorkspacePreferences,
	server?: ServerType,
): Promise<void> {
	await Promise.allSettled([
		bridge.close(),
		supervisor.stopAll(),
		...(server ? [closeHttpServer(server)] : []),
	]);
	preferences.close();
}

async function closeIngress(
	server: ServerType,
	bridge: SessionWsBridge,
	sockets: Set<Socket>,
): Promise<PromiseSettledResult<void>[]> {
	const closing = Promise.allSettled([closeHttpServer(server), bridge.close()]);
	const forceTimer = setTimeout(() => {
		for (const socket of sockets) socket.destroy();
		const forceClose = server as ServerType & { closeAllConnections?: () => void };
		forceClose.closeAllConnections?.();
	}, INGRESS_SHUTDOWN_GRACE_MS);
	try {
		return await closing;
	} finally {
		clearTimeout(forceTimer);
	}
}

function closeHttpServer(server: ServerType): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
	void startServer();
}
