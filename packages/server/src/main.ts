import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import {
	GATEWAY_CONTENT_REF_CAPABILITY,
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	GATEWAY_SESSION_HISTORY_CAPABILITY,
} from "@pi-agent-web/protocol";
import {
	createGatewayAccessControl,
	createGatewayAccessDenialReporter,
	type GatewayAccessControl,
} from "./access-control.js";
import { assertLoopbackHost, ENV_SESSION_DIR, loadConfig, type ServerConfig } from "./config.js";
import { EpochContentStore } from "./epoch-content-store.js";
import {
	createGatewayFuturePayloadActivation,
	createGatewayPayloadActivation,
	type GatewayFuturePayloadActivation,
	type GatewayPayloadActivation,
} from "./gateway-payload-activation.js";
import { NativeSessionCatalog, sessionHandleForCanonicalFile } from "./native-session-catalog.js";
import { RecoverableSessionTrash } from "./recoverable-session-trash.js";
import { type ProbedPiRuntime, resolvePiRuntime } from "./resolver.js";
import { createApp } from "./routes.js";
import { SessionLayoutResolver } from "./session-layout-resolver.js";
import {
	createFutureSessionSupervisor,
	createFutureSessionSupervisorRouteFacade,
	SessionSupervisor,
	type SessionSupervisorBaseOptions,
} from "./session-supervisor.js";
import {
	createFutureSessionWsBridge,
	type FutureSessionWsBridge,
	SessionWsBridge,
} from "./session-ws-bridge.js";
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

type FutureSessionSupervisor = ReturnType<typeof createFutureSessionSupervisor>;
type ServerProductMode = "current" | "future_content";
type PayloadActivationFor<M extends ServerProductMode> = M extends "future_content"
	? GatewayFuturePayloadActivation
	: GatewayPayloadActivation;
type SupervisorFor<M extends ServerProductMode> = M extends "future_content"
	? FutureSessionSupervisor
	: SessionSupervisor;
type BridgeFor<M extends ServerProductMode> = M extends "future_content"
	? FutureSessionWsBridge
	: SessionWsBridge;

interface ServerHandleBase<S, B> {
	server: ServerType;
	supervisor: S;
	bridge: B;
	catalog: NativeSessionCatalog;
	layoutResolver: SessionLayoutResolver;
	preferences: WorkspacePreferences;
	trash: RecoverableSessionTrash;
	contentStore: EpochContentStore;
	serverEpoch: string;
	config: ServerConfig;
	runtime: ProbedPiRuntime;
	accessControl: GatewayAccessControl;
	close: () => Promise<void>;
}

/** Production server handle after the atomic protocol 1.3 activation. */
export interface ServerHandle extends ServerHandleBase<FutureSessionSupervisor, FutureSessionWsBridge> {}

/** Legacy protocol 1.2 handle used only by explicit compatibility fixtures. */
export interface LegacyServerHandle extends ServerHandleBase<SessionSupervisor, SessionWsBridge> {}

export type FutureServerHandle = ServerHandle;

type ServerHandleFor<M extends ServerProductMode> = ServerHandleBase<SupervisorFor<M>, BridgeFor<M>>;

interface MainBridgeRuntime {
	version: string;
	adapterId: string;
	capabilities: readonly string[];
}

interface MainModeFactory<M extends ServerProductMode> {
	createPayloadActivation: (contentStore: EpochContentStore, serverEpoch: string) => PayloadActivationFor<M>;
	createSupervisor: (
		options: SessionSupervisorBaseOptions<M>,
		piPayloadServices: PayloadActivationFor<M>["supervisorServices"],
	) => SupervisorFor<M>;
	createBridge: (options: {
		supervisor: SupervisorFor<M>;
		serverBuild: string;
		runtime: MainBridgeRuntime;
		log: (level: "info" | "warn" | "error", message: string) => void;
		payloadActivation: PayloadActivationFor<M>;
	}) => BridgeFor<M>;
	broadcast: (
		bridge: BridgeFor<M>,
		message: Parameters<SessionSupervisorBaseOptions<M>["broadcast"]>[0],
	) => void;
	createRouteSupervisor: (supervisor: SupervisorFor<M>, resolved: ProbedPiRuntime) => SessionSupervisor;
	bridgeRuntime: (runtime: ProbedPiRuntime) => MainBridgeRuntime;
}

const CURRENT_MAIN_MODE: MainModeFactory<"current"> = {
	createPayloadActivation: createGatewayPayloadActivation,
	createSupervisor: (options, piPayloadServices) => new SessionSupervisor({ ...options, piPayloadServices }),
	createBridge: ({ supervisor, serverBuild, runtime, log, payloadActivation }) =>
		new SessionWsBridge({
			supervisor,
			serverBuild,
			runtime,
			log,
			payloadActivation: { context: payloadActivation.context },
		}),
	broadcast: (bridge, message) => bridge.broadcast(message),
	createRouteSupervisor: (supervisor) => supervisor,
	bridgeRuntime: (runtime) => ({
		version: runtime.version,
		adapterId: runtime.adapterId,
		capabilities: [
			...runtime.capabilities,
			"session.multiplex",
			GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
			GATEWAY_SESSION_HISTORY_CAPABILITY,
		],
	}),
};

const FUTURE_MAIN_MODE: MainModeFactory<"future_content"> = {
	createPayloadActivation: createGatewayFuturePayloadActivation,
	createSupervisor: (options, piPayloadServices) =>
		createFutureSessionSupervisor({ ...options, piPayloadServices }),
	createBridge: ({ supervisor, serverBuild, runtime, log, payloadActivation }) =>
		createFutureSessionWsBridge({
			supervisor,
			serverBuild,
			runtime,
			log,
			payloadActivation: {
				context: payloadActivation.context,
				externalizer: payloadActivation.externalizer,
				supervisorServices: payloadActivation.supervisorServices,
			},
		}),
	broadcast: (bridge, message) => bridge.broadcast(message),
	createRouteSupervisor: (supervisor, resolved) =>
		createFutureSessionSupervisorRouteFacade(supervisor, resolved),
	bridgeRuntime: (runtime) => ({
		version: runtime.version,
		adapterId: runtime.adapterId,
		capabilities: [
			...runtime.capabilities,
			"session.multiplex",
			GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
			GATEWAY_SESSION_HISTORY_CAPABILITY,
			GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
			GATEWAY_CONTENT_REF_CAPABILITY,
		],
	}),
};

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
	return startServerWithMode(options, FUTURE_MAIN_MODE);
}

/**
 * Server-private legacy entry point used by explicit 1.2 compatibility tests.
 * Production callers must use startServer(), which is the activated future mode.
 */
export async function startServerWithCurrentMode(
	options: StartServerOptions = {},
): Promise<LegacyServerHandle> {
	return startServerWithMode(options, CURRENT_MAIN_MODE);
}

async function startServerWithMode<M extends ServerProductMode>(
	options: StartServerOptions,
	mode: MainModeFactory<M>,
): Promise<ServerHandleFor<M>> {
	const mergedConfig: ServerConfig = { ...loadConfig(), ...options.config };
	const config: ServerConfig = { ...mergedConfig, webDataDir: path.resolve(mergedConfig.webDataDir) };
	assertLoopbackHost(config.host);
	const runtime = await resolvePiRuntime({ piPath: options.piPath });
	log("info", `Pi runtime resolved: ${runtime.source} Pi ${runtime.version} (${runtime.adapterId})`);
	const serverEpoch = randomUUID();
	fs.mkdirSync(config.webDataDir, { recursive: true, mode: 0o700 });
	const reportAccessDenial = createGatewayAccessDenialReporter(({ reason, suppressed }) => {
		const summary = suppressed > 0 ? ` (${String(suppressed)} additional denials suppressed)` : "";
		log("warn", `Gateway access denied: ${reason}${summary}`);
	});
	const accessControl = createGatewayAccessControl(randomBytes(32).toString("base64url"), {
		onDenied: reportAccessDenial,
	});

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
	let preferences: WorkspacePreferences | undefined;
	let contentStore: EpochContentStore | undefined;
	let supervisor: SupervisorFor<M> | undefined;
	let routeSupervisor: SessionSupervisor | undefined;
	let bridge: BridgeFor<M> | undefined;
	let server: ServerType | undefined;
	const sockets = new Set<Socket>();
	try {
		const activePreferences = new WorkspacePreferences(config.webDataDir);
		preferences = activePreferences;
		const catalog = new NativeSessionCatalog({
			layoutResolver,
			preferences: activePreferences,
			cacheTtlMs: 1_000,
		});
		const trash = new RecoverableSessionTrash(config.webDataDir);
		const activeContentStore = new EpochContentStore({ webDataDir: config.webDataDir, serverEpoch });
		contentStore = activeContentStore;
		await activeContentStore.initialize();
		const payloadActivation = mode.createPayloadActivation(activeContentStore, serverEpoch);

		let activeBridge!: BridgeFor<M>;
		const activeSupervisor = mode.createSupervisor(
			{
				serverEpoch,
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
				broadcast: (message) => mode.broadcast(activeBridge, message),
				onHotRuntimeInventory: (inventory) => activeBridge.broadcastHotRuntimeInventory(inventory),
				log,
			},
			payloadActivation.supervisorServices,
		);
		supervisor = activeSupervisor;
		const activeRouteSupervisor = mode.createRouteSupervisor(activeSupervisor, runtime);
		routeSupervisor = activeRouteSupervisor;
		activeBridge = mode.createBridge({
			supervisor: activeSupervisor,
			log,
			serverBuild: "0.1.0",
			runtime: mode.bridgeRuntime(runtime),
			payloadActivation,
		});
		bridge = activeBridge;

		const app = createApp({
			accessControl,
			contentStore: payloadActivation.contentStore,
			serverEpoch,
			config,
			catalog,
			layoutResolver,
			preferences: activePreferences,
			supervisor: activeRouteSupervisor,
			trash,
			readiness: {
				ready: true,
				runtime: {
					source: runtime.source,
					version: runtime.version,
					adapterId: runtime.adapterId,
					capabilities: runtime.capabilities,
				},
			},
		});
		serveStaticApp(app, options.staticDir);

		const activeServer = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
		server = activeServer;
		activeServer.on("connection", (socket: Socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
		});
		await waitForListening(activeServer);
		const address = activeServer.address();
		if (!address || typeof address === "string") {
			throw new Error("gateway did not expose a TCP address after listening");
		}
		log("info", `pi-agent-web server listening on http://${config.host}:${address.port}`);
		if (options.openInBrowser) openBrowser(config.host, address.port);

		activeServer.on("upgrade", (request, socket, head) => {
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
			activeBridge.wss.handleUpgrade(request, socket, head, (ws) => {
				activeBridge.wss.emit("connection", ws, request);
			});
		});

		const signalHandlers = new Map<NodeJS.Signals, () => void>();
		let closePromise: Promise<void> | null = null;
		const close = (): Promise<void> => {
			closePromise ??= (async () => {
				for (const [signal, handler] of signalHandlers) process.off(signal, handler);
				signalHandlers.clear();
				const errors: unknown[] = [];
				collectRejected(errors, await closeIngress(activeServer, activeBridge, sockets));
				const supervisorsToStop: Promise<void>[] = [activeSupervisor.stopAll()];
				if (activeRouteSupervisor !== activeSupervisor)
					supervisorsToStop.push(activeRouteSupervisor.stopAll());
				collectRejected(errors, await Promise.allSettled(supervisorsToStop));
				collectRejected(errors, await Promise.allSettled([activeContentStore.shutdown()]));
				try {
					activePreferences.close();
				} catch (error) {
					errors.push(error);
				}
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
			server: activeServer,
			supervisor: activeSupervisor,
			bridge: activeBridge,
			catalog,
			layoutResolver,
			preferences: activePreferences,
			trash,
			contentStore: activeContentStore,
			serverEpoch,
			config,
			runtime,
			accessControl,
			close,
		};
	} catch (error) {
		const cleanupErrors = await cleanupFailedStartup({
			server,
			bridge,
			supervisor,
			routeSupervisor,
			contentStore,
			preferences,
		});
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "gateway startup failed");
		}
		throw error;
	}
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

async function cleanupFailedStartup(resources: {
	server?: ServerType;
	bridge?: { close: () => Promise<void> };
	supervisor?: { stopAll: () => Promise<void> };
	routeSupervisor?: SessionSupervisor;
	contentStore?: EpochContentStore;
	preferences?: WorkspacePreferences;
}): Promise<unknown[]> {
	const errors: unknown[] = [];
	if (resources.server)
		collectRejected(errors, await Promise.allSettled([closeHttpServer(resources.server)]));
	if (resources.bridge) collectRejected(errors, await Promise.allSettled([resources.bridge.close()]));
	if (resources.supervisor)
		collectRejected(errors, await Promise.allSettled([resources.supervisor.stopAll()]));
	if (resources.routeSupervisor && resources.routeSupervisor !== resources.supervisor)
		collectRejected(errors, await Promise.allSettled([resources.routeSupervisor.stopAll()]));
	if (resources.contentStore)
		collectRejected(errors, await Promise.allSettled([resources.contentStore.shutdown()]));
	try {
		resources.preferences?.close();
	} catch (error) {
		errors.push(error);
	}
	return errors;
}

function collectRejected(errors: unknown[], results: PromiseSettledResult<unknown>[]): void {
	for (const result of results) {
		if (result.status === "rejected") errors.push(result.reason);
	}
}

async function closeIngress(
	server: ServerType,
	bridge: { close: () => Promise<void> },
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
