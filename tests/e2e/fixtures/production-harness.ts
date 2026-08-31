import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(fixturesDir, "../../..");
const defaultFakePiPath = path.join(fixturesDir, "deterministic-pi.mjs");
const cliPath = path.join(repositoryRoot, "packages/cli/dist/cli.js");
const benchmarkMainPath = path.join(repositoryRoot, "packages/server/dist-benchmark/benchmark-main.js");
const benchmarkStaticDir = path.join(repositoryRoot, "packages/ui/dist");
const LISTENING_PATTERN = /listening on (http:\/\/127\.0\.0\.1:\d+)/;
const CREDENTIAL_ENV_PATTERN =
	/(api[_-]?key|token|secret|password|credential|openai|anthropic|gemini|deepseek)/i;
const BENCHMARK_GATEWAY_COUNTER_MESSAGE = "piweb-benchmark-gateway-counters";
const BENCHMARK_COUNTER_KEYS = ["maxHeapUsedBytes", "maxRssBytes", "publicationCount", "snapshotBuildCount"];

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
	origin: string;
	port: number;
	rootDir: string;
	workspacePath: string;
	workspace: HarnessWorkspace;
	session: HarnessSession;
	logs: () => string;
	piEvents: () => PiFixtureEvent[];
	releasePrompt: (text: string) => void;
	startPrompt: (text: string) => void;
	triggerReplayGap: (text: string) => void;
	gatewayObservation: () => GatewayObservation;
	restartGateway: () => Promise<GatewayObservation>;
	requestJson: <T>(pathname: string, init?: RequestInit) => Promise<T>;
	stop: () => Promise<void>;
}

export interface StartHarnessOptions {
	fakePiPath?: string;
	extraEnv?: NodeJS.ProcessEnv;
	/** Explicitly launch the benchmark-only Gateway entry and receive aggregate counters over IPC. */
	benchmarkGateway?: boolean;
	/** A deterministic seed exposed only to benchmark fixture processes. */
	benchmarkSeed?: string;
	/** Tests may reserve an explicit loopback port; the default finds one once and reuses it on restart. */
	port?: number;
	seedHistoricalSession?: {
		userText: string;
		assistantText: string;
		turnCount?: number;
		/** Pad ASCII assistant content so the native JSONL has this exact byte length. */
		targetSourceBytes?: number;
	};
}

export interface GatewayObservation {
	origin: string;
	port: number;
	pid: number;
	restartCount: number;
	benchmarkCounters?: Readonly<BenchmarkGatewayCounters>;
}

interface BenchmarkGatewayCounters {
	maxHeapUsedBytes: number;
	maxRssBytes: number;
	publicationCount: number;
	snapshotBuildCount: number;
}

interface BenchmarkGatewayCounterMessage {
	type: typeof BENCHMARK_GATEWAY_COUNTER_MESSAGE;
	counters: BenchmarkGatewayCounters;
}

function isSafeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBenchmarkGatewayCounterMessage(value: unknown): value is BenchmarkGatewayCounterMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	if (Object.keys(message).sort().join(",") !== "counters,type") return false;
	if (message.type !== BENCHMARK_GATEWAY_COUNTER_MESSAGE) return false;
	if (typeof message.counters !== "object" || message.counters === null || Array.isArray(message.counters)) {
		return false;
	}
	const counters = message.counters as Record<string, unknown>;
	return (
		Object.keys(counters).sort().join(",") === BENCHMARK_COUNTER_KEYS.join(",") &&
		isSafeCounter(counters.maxHeapUsedBytes) &&
		isSafeCounter(counters.maxRssBytes) &&
		isSafeCounter(counters.publicationCount) &&
		isSafeCounter(counters.snapshotBuildCount)
	);
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
	for (let index = 0; index < turnCount; index++) {
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
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGTERM");
	const graceful = await Promise.race([
		exited.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
	]);
	if (graceful) return;
	child.kill("SIGKILL");
	await exited;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function availableLoopbackPort(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => {
			server.close(() => resolve(true));
		});
	});
}

async function reserveLoopbackPort(): Promise<number> {
	const server = createServer();
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string" || address.port < 1) {
				server.close(() => reject(new Error("unable to reserve a loopback benchmark port")));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolve(address.port);
			});
		});
	});
}

async function waitForLoopbackPortRelease(port: number, output: () => string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await availableLoopbackPort(port)) return;
		await delay(25);
	}
	throw new Error(`loopback port ${String(port)} was not released:\n${output()}`);
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

async function waitForBenchmarkCounters(
	read: () => Readonly<BenchmarkGatewayCounters> | undefined,
	readError: () => string | undefined,
	output: () => string,
): Promise<Readonly<BenchmarkGatewayCounters>> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const error = readError();
		if (error) throw new Error(`${error}\n${output()}`);
		const counters = read();
		if (counters) return counters;
		await delay(25);
	}
	throw new Error(`benchmark Gateway did not publish strict aggregate counters:\n${output()}`);
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
	const port = options.port ?? (await reserveLoopbackPort());
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		fs.rmSync(rootDir, { recursive: true, force: true });
		throw new Error("production harness port must be an explicit loopback TCP port");
	}
	const origin = `http://127.0.0.1:${String(port)}`;
	let activeChild: ChildProcessWithoutNullStreams | undefined;
	let cookie = "";
	let restartCount = 0;
	let latestBenchmarkCounters: Readonly<BenchmarkGatewayCounters> | undefined;
	let benchmarkIpcError: string | undefined;
	const benchmarkGateway = options.benchmarkGateway === true;

	const startGateway = async (): Promise<void> => {
		let childOutput = "";
		latestBenchmarkCounters = undefined;
		benchmarkIpcError = undefined;
		if (benchmarkGateway && (!fs.existsSync(benchmarkMainPath) || !fs.existsSync(benchmarkStaticDir))) {
			throw new Error(
				"benchmark Gateway entry or built UI is missing; refusing to fall back to the standard CLI",
			);
		}
		const child = (
			benchmarkGateway
				? spawn(
						process.execPath,
						[
							benchmarkMainPath,
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
							stdio: ["pipe", "pipe", "pipe", "ipc"],
							env: childEnvironment({
								...options.extraEnv,
								// These isolated roots deliberately replace all default Pi roots for every launch.
								PI_CODING_AGENT_DIR: agentDir,
								PI_CODING_AGENT_SESSION_DIR: sessionDir,
								PI_WEB_DATA_DIR: webDataDir,
								PI_WEB_E2E_MARKER: markerPath,
								PI_WEB_E2E_CONTROL_DIR: controlDir,
								PI_WEB_BENCHMARK_STATIC_DIR: benchmarkStaticDir,
								...(options.benchmarkSeed ? { PI_WEB_BENCHMARK_SEED: options.benchmarkSeed } : {}),
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
								// These isolated roots deliberately replace all default Pi roots for every launch.
								PI_CODING_AGENT_DIR: agentDir,
								PI_CODING_AGENT_SESSION_DIR: sessionDir,
								PI_WEB_DATA_DIR: webDataDir,
								PI_WEB_E2E_MARKER: markerPath,
								PI_WEB_E2E_CONTROL_DIR: controlDir,
								...(options.benchmarkSeed ? { PI_WEB_BENCHMARK_SEED: options.benchmarkSeed } : {}),
							}),
						},
					)
		) as ChildProcessWithoutNullStreams;
		activeChild = child;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		const recordOutput = (chunk: unknown) => {
			const text = String(chunk);
			childOutput += text;
			output += text;
		};
		child.stdout.on("data", recordOutput);
		child.stderr.on("data", recordOutput);
		if (benchmarkGateway) {
			child.on("message", (message: unknown) => {
				if (!isBenchmarkGatewayCounterMessage(message)) {
					benchmarkIpcError = "benchmark Gateway sent a non-counter IPC payload";
					return;
				}
				latestBenchmarkCounters = Object.freeze({ ...message.counters });
			});
		}
		try {
			const observedOrigin = await waitForListening(child, () => childOutput);
			if (observedOrigin !== origin) {
				throw new Error(`gateway listened on ${observedOrigin}, expected stable origin ${origin}`);
			}
			cookie = await bootstrapGateway(origin, () => childOutput);
			if (benchmarkGateway) {
				await waitForBenchmarkCounters(
					() => latestBenchmarkCounters,
					() => benchmarkIpcError,
					() => childOutput,
				);
			}
		} catch (error) {
			await terminate(child);
			if (activeChild === child) activeChild = undefined;
			throw error;
		}
	};

	const observation = (): GatewayObservation => {
		if (!activeChild?.pid) throw new Error("production harness gateway is not running");
		if (!benchmarkGateway) return { origin, port, pid: activeChild.pid, restartCount };
		if (benchmarkIpcError) throw new Error(benchmarkIpcError);
		if (!latestBenchmarkCounters) throw new Error("benchmark Gateway counters are unavailable");
		return {
			origin,
			port,
			pid: activeChild.pid,
			restartCount,
			benchmarkCounters: Object.freeze({ ...latestBenchmarkCounters }),
		};
	};

	try {
		await startGateway();

		const requestJson = async <T>(pathname: string, init: RequestInit = {}): Promise<T> => {
			const headers = new Headers(init.headers);
			headers.set("Origin", origin);
			headers.set("Cookie", cookie);
			if (init.body !== undefined && !headers.has("Content-Type"))
				headers.set("Content-Type", "application/json");
			const response = await fetch(`${origin}${pathname}`, { ...init, headers });
			const body = (await response.json()) as T & {
				error?: string | { message?: string };
			};
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
				{
					method: "POST",
				},
			);
			session = created.session;
			if (!fs.existsSync(markerPath)) throw new Error("deterministic fake Pi was not started");
		}

		return {
			origin,
			port,
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
						// A reader can observe only the final line while another Pi process appends it.
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
			gatewayObservation: observation,
			restartGateway: async () => {
				const previous = activeChild;
				if (!previous) throw new Error("production harness gateway is not running");
				await terminate(previous);
				if (activeChild === previous) activeChild = undefined;
				await waitForLoopbackPortRelease(port, () => output);
				await startGateway();
				restartCount += 1;
				return observation();
			},
			requestJson,
			stop: async () => {
				if (activeChild) await terminate(activeChild);
				activeChild = undefined;
				fs.rmSync(rootDir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		if (activeChild) await terminate(activeChild);
		fs.rmSync(rootDir, { recursive: true, force: true });
		throw error;
	}
}
