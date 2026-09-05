import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(fixturesDir, "../../..");
const defaultFakePiPath = path.join(fixturesDir, "deterministic-pi.mjs");
const cliPath = path.join(repositoryRoot, "packages/cli/dist/cli.js");
const LISTENING_PATTERN = /listening on (http:\/\/127\.0\.0\.1:\d+)/;
const CREDENTIAL_ENV_PATTERN =
	/(api[_-]?key|token|secret|password|credential|openai|anthropic|gemini|deepseek)/i;
// Product readiness is bounded at 10s and its detached Pi-group stop is bounded at 1.1s.
const PRODUCT_BOUNDED_SHUTDOWN_WAIT_MS = 12_000;
export const MAX_HARNESS_ROOT_ENTRIES = 8;

export interface HarnessWorkspace {
	workspaceHandle: string;
	path: string;
}

export interface HarnessSession {
	sessionHandle: string;
	workspaceHandle: string;
	nativeSessionId: string;
	sessionFile: string | null;
	persisted: boolean;
	firstMessage: string;
	messageCount: number;
}

export interface HarnessLifecycleSnapshot {
	gatewayStarts: number;
	ownedGatewayCount: number;
	activeGatewayCount: number;
	activeGatewayPid: number | null;
	rootExists: boolean;
	rootEntryCount: number;
}

export function isBoundedHarnessLifecycle(snapshot: HarnessLifecycleSnapshot): boolean {
	return (
		snapshot.ownedGatewayCount === snapshot.gatewayStarts &&
		snapshot.activeGatewayCount === 1 &&
		snapshot.rootExists &&
		snapshot.rootEntryCount <= MAX_HARNESS_ROOT_ENTRIES
	);
}

export interface PiFixtureEvent {
	type: string;
	at: number;
	pid: number;
	sessionId: string;
	commandId?: string;
	commandType?: string;
	text?: string;
	label?: string;
	eventType?: string;
	frameBytes?: number;
	imageCount?: number;
	imageMimeTypes?: string[];
	imageChars?: number;
	deltaIndex?: number;
	deltaCount?: number;
	toolCount?: number;
	markdownChars?: number;
	targetBytes?: number;
	confirmed?: boolean;
	cancelled?: boolean;
}

export interface ProductionHarness {
	readonly origin: string;
	rootDir: string;
	workspacePath: string;
	workspace: HarnessWorkspace;
	session: HarnessSession;
	logs: () => string;
	piEvents: () => PiFixtureEvent[];
	releasePrompt: (text: string) => void;
	startPrompt: (text: string) => void;
	triggerReplayGap: (text: string) => void;
	requestJson: <T>(pathname: string, init?: RequestInit) => Promise<T>;
	restart: (page?: Page) => Promise<void>;
	lifecycle: () => HarnessLifecycleSnapshot;
	stop: () => Promise<void>;
}

export interface StartHarnessOptions {
	fakePiPath?: string;
	extraEnv?: NodeJS.ProcessEnv;
	/** Launch the benchmark-only child entry against the run-owned server/UI outputs. */
	benchmarkGateway?: boolean;
	seedHistoricalSession?: {
		userText: string;
		assistantText: string;
		turnCount?: number;
		/** Pad ASCII assistant content so the native JSONL has this exact byte length. */
		targetSourceBytes?: number;
	};
}

interface BenchmarkBuildPaths {
	buildRoot: string;
	serverDirectory: string;
	serverEntry: string;
	serverEntryHash: string;
	serverTreeHash: string;
	staticDir: string;
	uiTreeHash: string;
}

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function hashTree(directory: string): string {
	const files: string[] = [];
	const visit = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else if (entry.isFile()) files.push(entryPath);
		}
	};
	visit(directory);
	const hash = createHash("sha256");
	for (const filePath of files.sort((left, right) => left.localeCompare(right))) {
		hash.update(path.relative(directory, filePath).replaceAll(path.sep, "/"));
		hash.update("\0");
		hash.update(sha256(fs.readFileSync(filePath)));
		hash.update("\n");
	}
	return hash.digest("hex");
}

function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative.length > 0 &&
		!relative.startsWith(`..${path.sep}`) &&
		relative !== ".." &&
		!path.isAbsolute(relative)
	);
}

export function benchmarkBuildPathsFromEnvironment(): BenchmarkBuildPaths {
	const buildRoot = process.env.PI_WEB_BENCHMARK_VARIANT_BUILD_DIR;
	const serverEntry = process.env.PI_WEB_BENCHMARK_SERVER_ENTRY;
	const staticDir = process.env.PI_WEB_BENCHMARK_STATIC_DIR;
	const serverEntryHash = process.env.PI_WEB_BENCHMARK_SERVER_ENTRY_HASH;
	const serverTreeHash = process.env.PI_WEB_BENCHMARK_SERVER_TREE_HASH;
	const uiTreeHash = process.env.PI_WEB_BENCHMARK_UI_TREE_HASH;
	if (
		!buildRoot ||
		!serverEntry ||
		!staticDir ||
		!serverEntryHash ||
		!serverTreeHash ||
		!uiTreeHash ||
		!path.isAbsolute(buildRoot) ||
		!path.isAbsolute(serverEntry) ||
		!path.isAbsolute(staticDir) ||
		!/^[a-f0-9]{64}$/.test(serverEntryHash) ||
		!/^[a-f0-9]{64}$/.test(serverTreeHash) ||
		!/^[a-f0-9]{64}$/.test(uiTreeHash)
	) {
		throw new Error("benchmark harness requires exact run-owned server/UI paths and hashes");
	}
	const resolvedBuildRoot = fs.realpathSync(buildRoot);
	const resolvedEntry = fs.realpathSync(serverEntry);
	const resolvedStaticDir = fs.realpathSync(staticDir);
	if (!fs.statSync(resolvedEntry).isFile() || !fs.statSync(resolvedStaticDir).isDirectory()) {
		throw new Error("benchmark harness build paths must resolve to a server entry and static directory");
	}
	const resolvedServerDirectory = path.dirname(resolvedEntry);
	if (
		!isPathInside(resolvedBuildRoot, resolvedEntry) ||
		!isPathInside(resolvedBuildRoot, resolvedStaticDir) ||
		!isPathInside(resolvedBuildRoot, resolvedServerDirectory)
	) {
		throw new Error("benchmark harness refuses executable output outside its run-owned variant directory");
	}
	if (
		sha256(fs.readFileSync(resolvedEntry)) !== serverEntryHash ||
		hashTree(resolvedServerDirectory) !== serverTreeHash ||
		hashTree(resolvedStaticDir) !== uiTreeHash
	) {
		throw new Error(
			"benchmark harness build hashes do not match the run manifest; refusing stale or mixed output",
		);
	}
	return {
		buildRoot: resolvedBuildRoot,
		serverDirectory: resolvedServerDirectory,
		serverEntry: resolvedEntry,
		serverEntryHash,
		serverTreeHash,
		staticDir: resolvedStaticDir,
		uiTreeHash,
	};
}

export function assertPreservedHarnessIdentity(
	expectedWorkspace: HarnessWorkspace,
	expectedSession: HarnessSession,
	workspaces: HarnessWorkspace[],
	sessions: HarnessSession[],
): void {
	const preservedWorkspace = workspaces.find(
		(candidate) => candidate.workspaceHandle === expectedWorkspace.workspaceHandle,
	);
	if (!preservedWorkspace || preservedWorkspace.path !== expectedWorkspace.path) {
		throw new Error("Gateway restart did not preserve the owned Workspace root");
	}
	const preservedSession = sessions.find(
		(candidate) => candidate.sessionHandle === expectedSession.sessionHandle,
	);
	if (
		!preservedSession ||
		preservedSession.nativeSessionId !== expectedSession.nativeSessionId ||
		preservedSession.sessionFile !== expectedSession.sessionFile
	) {
		throw new Error("Gateway restart did not preserve the owned Session identity");
	}
}

function seedHistoricalSession(
	sessionDir: string,
	workspacePath: string,
	seed: NonNullable<StartHarnessOptions["seedHistoricalSession"]>,
): { nativeSessionId: string; sessionFile: string } {
	const nativeSessionId = "browser-e2e-history";
	const timestamp = "2026-01-01T00:00:00.000Z";
	const sessionFile = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${nativeSessionId}.jsonl`);
	const turnCount = Math.max(1, Math.floor(seed.turnCount ?? 1));
	const entries: Array<Record<string, unknown>> = [
		{
			type: "session",
			version: 3,
			id: nativeSessionId,
			timestamp,
			cwd: workspacePath,
		},
	];
	const assistantMessages: Array<{ content: Array<{ type: "text"; text: string }> }> = [];
	let parentId: string | null = null;
	for (let index = 0; index < turnCount; index += 1) {
		const userId = `${nativeSessionId}-user-${String(index + 1)}`;
		const assistantId = `${nativeSessionId}-assistant-${String(index + 1)}`;
		const userTimestamp = Date.parse(timestamp) + index * 2_000;
		const assistantTimestamp = userTimestamp + 1_000;
		const userText = turnCount === 1 ? seed.userText : `${seed.userText} [turn ${String(index + 1)}]`;
		const assistantText = turnCount === 1 ? seed.assistantText : `${seed.assistantText} ${String(index + 1)}`;
		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text" as const, text: assistantText }],
			api: "openai-completions",
			provider: "e2e",
			model: "deterministic",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: assistantTimestamp,
		};
		assistantMessages.push(assistantMessage);
		entries.push(
			{
				type: "message",
				id: userId,
				parentId,
				timestamp: new Date(userTimestamp).toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: userText }],
					timestamp: userTimestamp,
				},
			},
			{
				type: "message",
				id: assistantId,
				parentId: userId,
				timestamp: new Date(assistantTimestamp).toISOString(),
				message: assistantMessage,
			},
		);
		parentId = assistantId;
	}
	const serialize = () => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	if (seed.targetSourceBytes !== undefined) {
		if (!Number.isSafeInteger(seed.targetSourceBytes) || seed.targetSourceBytes <= 0) {
			throw new Error("historical Session targetSourceBytes must be a positive safe integer");
		}
		const baseBytes = Buffer.byteLength(serialize(), "utf8");
		const paddingBytes = seed.targetSourceBytes - baseBytes;
		if (paddingBytes < 0) {
			throw new Error(
				`historical Session base fixture ${String(baseBytes)} exceeds target ${String(seed.targetSourceBytes)}`,
			);
		}
		const perMessage = Math.floor(paddingBytes / assistantMessages.length);
		let remainder = paddingBytes % assistantMessages.length;
		for (const message of assistantMessages) {
			const extra = perMessage + (remainder > 0 ? 1 : 0);
			if (remainder > 0) remainder -= 1;
			const content = message.content[0];
			if (content) content.text += "x".repeat(extra);
		}
	}
	const serialized = serialize();
	if (
		seed.targetSourceBytes !== undefined &&
		Buffer.byteLength(serialized, "utf8") !== seed.targetSourceBytes
	) {
		throw new Error("historical Session source byte padding drifted");
	}
	fs.writeFileSync(sessionFile, serialized, "utf8");
	return { nativeSessionId, sessionFile: fs.realpathSync(sessionFile) };
}

function childEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!CREDENTIAL_ENV_PATTERN.test(key)) environment[key] = value;
	}
	return { ...environment, ...overrides };
}

function waitForListening(child: ChildProcessWithoutNullStreams, output: () => string): Promise<string> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`pi-web did not start:\n${output()}`)), 15_000);
		const inspect = () => {
			const match = output().match(LISTENING_PATTERN);
			if (!match?.[1]) return;
			clearTimeout(timeout);
			cleanup();
			resolve(match[1]);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			clearTimeout(timeout);
			cleanup();
			reject(
				new Error(
					`pi-web exited before listening (code=${String(code)}, signal=${String(signal)}):\n${output()}`,
				),
			);
		};
		const cleanup = () => {
			child.stdout.off("data", inspect);
			child.stderr.off("data", inspect);
			child.off("exit", onExit);
		};
		child.stdout.on("data", inspect);
		child.stderr.on("data", inspect);
		child.once("exit", onExit);
		inspect();
	});
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const waitForExit = (timeoutMs: number): Promise<boolean> =>
		new Promise((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve(true);
				return;
			}
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				child.off("exit", onExit);
				resolve(value);
			};
			const onExit = () => finish(true);
			const timeout = setTimeout(() => finish(false), timeoutMs);
			child.once("exit", onExit);
			if (child.exitCode !== null || child.signalCode !== null) finish(true);
		});
	const exited = waitForExit(PRODUCT_BOUNDED_SHUTDOWN_WAIT_MS);
	child.kill("SIGTERM");
	if (await exited) return;
	const forceExited = waitForExit(PRODUCT_BOUNDED_SHUTDOWN_WAIT_MS);
	child.kill("SIGKILL");
	await forceExited;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function bootstrapGateway(origin: string, output: () => string): Promise<string> {
	const deadline = Date.now() + 15_000;
	let lastFailure = "not attempted";
	while (Date.now() < deadline) {
		try {
			const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
			if (bootstrap.ok) {
				const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
				if (cookie) return cookie;
				lastFailure = "bootstrap did not issue a session cookie";
			} else {
				lastFailure = `bootstrap failed with ${String(bootstrap.status)}`;
			}
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : String(error);
		}
		await delay(25);
	}
	throw new Error(`pi-web did not become ready (${lastFailure}):\n${output()}`);
}

async function refreshBrowserAuthentication(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const response = await fetch("/api/v1/bootstrap", { credentials: "include" });
		if (!response.ok) throw new Error(`Browser bootstrap failed with ${String(response.status)}`);
	});
}

export async function startProductionHarness(options: StartHarnessOptions = {}): Promise<ProductionHarness> {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-browser-e2e-"));
	const agentDir = path.join(rootDir, "agent");
	const sessionDir = path.join(rootDir, "sessions");
	const webDataDir = path.join(rootDir, "web-data");
	const workspacePath = path.join(rootDir, "workspace");
	const controlDir = path.join(rootDir, "fixture-control");
	const markerPath = path.join(rootDir, "fake-pi.started");
	for (const directory of [agentDir, sessionDir, webDataDir, workspacePath, controlDir]) {
		fs.mkdirSync(directory, { recursive: true });
	}
	const seeded = options.seedHistoricalSession
		? seedHistoricalSession(sessionDir, workspacePath, options.seedHistoricalSession)
		: null;
	fs.writeFileSync(
		path.join(agentDir, "auth.json"),
		`${JSON.stringify({ e2e: { type: "api_key", key: "deterministic-test-key" } })}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);

	let output = "";
	let child: ChildProcessWithoutNullStreams | undefined;
	let origin = "";
	let listenPort: number | undefined;
	let cookie = "";
	let gatewayStarts = 0;
	const ownedChildren = new Set<ChildProcessWithoutNullStreams>();
	let lifecycleTail = Promise.resolve();
	const withLifecycleLock = async <T>(operation: () => Promise<T>): Promise<T> => {
		const previous = lifecycleTail;
		let release!: () => void;
		lifecycleTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	};
	const isActiveChild = (candidate: ChildProcessWithoutNullStreams): boolean =>
		candidate.exitCode === null && candidate.signalCode === null;
	try {
		const benchmarkGateway = options.benchmarkGateway === true;
		const benchmarkBuild = benchmarkGateway ? benchmarkBuildPathsFromEnvironment() : undefined;
		const startGateway = async (): Promise<void> => {
			if (child && isActiveChild(child)) throw new Error("production harness Gateway is already running");
			let startupOutput = "";
			const port = listenPort ?? 0;
			const nextChild = (
				benchmarkGateway
					? spawn(
							process.execPath,
							[
								benchmarkBuild!.serverEntry,
								"--pi-path",
								options.fakePiPath ?? defaultFakePiPath,
								"--host",
								"127.0.0.1",
								"--port",
								String(port),
								"--no-open",
							],
							{
								cwd: repositoryRoot,
								// The private IPC channel is only a parent-disconnect fence for benchmark-main.
								stdio: ["pipe", "pipe", "pipe", "ipc"],
								env: childEnvironment({
									...options.extraEnv,
									PI_CODING_AGENT_DIR: agentDir,
									PI_CODING_AGENT_SESSION_DIR: sessionDir,
									PI_WEB_DATA_DIR: webDataDir,
									PI_WEB_E2E_MARKER: markerPath,
									PI_WEB_E2E_CONTROL_DIR: controlDir,
									PI_WEB_BENCHMARK_STATIC_DIR: benchmarkBuild!.staticDir,
								}),
							},
						)
					: spawn(
							process.execPath,
							[
								cliPath,
								"--pi-path",
								options.fakePiPath ?? defaultFakePiPath,
								"--host",
								"127.0.0.1",
								"--port",
								String(port),
								"--no-open",
							],
							{
								cwd: repositoryRoot,
								stdio: ["pipe", "pipe", "pipe"],
								env: childEnvironment({
									...options.extraEnv,
									PI_CODING_AGENT_DIR: agentDir,
									PI_CODING_AGENT_SESSION_DIR: sessionDir,
									PI_WEB_DATA_DIR: webDataDir,
									PI_WEB_E2E_MARKER: markerPath,
									PI_WEB_E2E_CONTROL_DIR: controlDir,
								}),
							},
						)
			) as ChildProcessWithoutNullStreams;
			ownedChildren.add(nextChild);
			child = nextChild;
			nextChild.once("exit", () => {
				if (child === nextChild) child = undefined;
			});
			gatewayStarts += 1;
			nextChild.stdout.setEncoding("utf8");
			nextChild.stderr.setEncoding("utf8");
			nextChild.stdout.on("data", (chunk) => {
				const text = String(chunk);
				output += text;
				startupOutput += text;
			});
			nextChild.stderr.on("data", (chunk) => {
				const text = String(chunk);
				output += text;
				startupOutput += text;
			});
			try {
				const nextOrigin = await waitForListening(nextChild, () => startupOutput);
				const parsedOrigin = new URL(nextOrigin);
				const nextPort = Number(parsedOrigin.port);
				if (!Number.isSafeInteger(nextPort) || nextPort <= 0) {
					throw new Error(`production harness received an invalid Gateway origin: ${nextOrigin}`);
				}
				if (listenPort === undefined) {
					listenPort = nextPort;
					origin = nextOrigin;
				} else if (nextPort !== listenPort || nextOrigin !== origin) {
					throw new Error("production harness Gateway restart changed its loopback origin");
				}
				cookie = await bootstrapGateway(origin, () => startupOutput);
			} catch (error) {
				if (child === nextChild) child = undefined;
				await terminate(nextChild);
				throw error;
			}
		};
		await startGateway();

		const requestJson = async <T>(pathname: string, init: RequestInit = {}): Promise<T> => {
			const headers = new Headers(init.headers);
			headers.set("Origin", origin);
			headers.set("Cookie", cookie);
			if (init.body !== undefined && !headers.has("Content-Type")) {
				headers.set("Content-Type", "application/json");
			}
			const response = await fetch(`${origin}${pathname}`, { ...init, headers });
			const body = (await response.json()) as T & { error?: string | { message?: string } };
			if (!response.ok) {
				const detail = typeof body.error === "string" ? body.error : (body.error?.message ?? "unknown error");
				throw new Error(
					`${init.method ?? "GET"} ${pathname} failed with ${String(response.status)}: ${detail}`,
				);
			}
			return body;
		};

		const workspace = await requestJson<HarnessWorkspace>("/api/v1/workspaces", {
			method: "POST",
			body: JSON.stringify({ path: workspacePath, displayName: "Browser E2E" }),
		});
		let session: HarnessSession;
		if (seeded) {
			const directory = await requestJson<{ sessions: HarnessSession[] }>(
				`/api/v1/workspaces/${encodeURIComponent(workspace.workspaceHandle)}/sessions?refresh=1`,
			);
			const historical = directory.sessions.find(
				(candidate) =>
					candidate.nativeSessionId === seeded.nativeSessionId &&
					candidate.sessionFile === seeded.sessionFile,
			);
			if (!historical) {
				throw new Error(
					`seeded historical Session was not discovered: ${JSON.stringify(directory.sessions)}`,
				);
			}
			session = historical;
		} else {
			const created = await requestJson<{ session: HarnessSession }>(
				`/api/v1/workspaces/${encodeURIComponent(workspace.workspaceHandle)}/sessions`,
				{ method: "POST" },
			);
			session = created.session;
			if (!fs.existsSync(markerPath)) throw new Error("deterministic fake Pi was not started");
		}

		const restart = (page?: Page): Promise<void> =>
			withLifecycleLock(async () => {
				const previousChild = child;
				if (!previousChild || !isActiveChild(previousChild)) {
					throw new Error("production harness Gateway is not running");
				}
				child = undefined;
				await terminate(previousChild);
				if (isActiveChild(previousChild)) {
					throw new Error("production harness Gateway did not terminate before restart");
				}
				try {
					await startGateway();
					const workspaces = await requestJson<HarnessWorkspace[]>("/api/v1/workspaces");
					const directory = await requestJson<{ sessions: HarnessSession[] }>(
						`/api/v1/workspaces/${encodeURIComponent(workspace.workspaceHandle)}/sessions?refresh=1`,
					);
					assertPreservedHarnessIdentity(workspace, session, workspaces, directory.sessions);
					if (page) await refreshBrowserAuthentication(page);
				} catch (error) {
					const replacement = child;
					child = undefined;
					if (replacement) await terminate(replacement);
					throw error;
				}
			});

		const lifecycle = (): HarnessLifecycleSnapshot => ({
			gatewayStarts,
			ownedGatewayCount: ownedChildren.size,
			activeGatewayCount: [...ownedChildren].filter(isActiveChild).length,
			activeGatewayPid: [...ownedChildren].find(isActiveChild)?.pid ?? null,
			rootExists: fs.existsSync(rootDir),
			rootEntryCount: fs.existsSync(rootDir) ? fs.readdirSync(rootDir).length : 0,
		});

		return {
			get origin() {
				return origin;
			},
			rootDir,
			workspacePath,
			workspace,
			session,
			logs: () => output,
			piEvents: () => {
				if (!fs.existsSync(markerPath)) return [];
				const content = fs.readFileSync(markerPath, "utf8");
				const lines = content.split("\n");
				const events: PiFixtureEvent[] = [];
				for (const [index, line] of lines.entries()) {
					if (!line) continue;
					try {
						events.push(JSON.parse(line) as PiFixtureEvent);
					} catch (error) {
						if (index === lines.length - 1 && !content.endsWith("\n")) continue;
						throw new Error(`invalid deterministic Pi marker line ${String(index + 1)}`, {
							cause: error,
						});
					}
				}
				return events;
			},
			releasePrompt: (text) => {
				fs.writeFileSync(path.join(controlDir, `${encodeURIComponent(text)}.release`), "release\n", "utf8");
			},
			startPrompt: (text) => {
				fs.writeFileSync(path.join(controlDir, `${encodeURIComponent(text)}.start`), "start\n", "utf8");
			},
			triggerReplayGap: (text) => {
				fs.writeFileSync(path.join(controlDir, `${encodeURIComponent(text)}.gap`), "gap\n", "utf8");
			},
			requestJson,
			restart,
			lifecycle,
			stop: (): Promise<void> =>
				withLifecycleLock(async () => {
					child = undefined;
					for (const ownedChild of ownedChildren) await terminate(ownedChild);
					if ([...ownedChildren].some(isActiveChild)) {
						throw new Error("production harness still owns an active Gateway after stop");
					}
					fs.rmSync(rootDir, { recursive: true, force: true });
				}),
		};
	} catch (error) {
		child = undefined;
		for (const ownedChild of ownedChildren) await terminate(ownedChild);
		fs.rmSync(rootDir, { recursive: true, force: true });
		throw error;
	}
}
