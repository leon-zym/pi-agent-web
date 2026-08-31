import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
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
const BENCHMARK_GATEWAY_COUNTER_MESSAGE = "piweb-benchmark-gateway-counters";
const BENCHMARK_GATEWAY_TRIAL_CONTROL_MESSAGE = "piweb-benchmark-gateway-trial";
const BENCHMARK_COUNTER_KEYS = [
	"maxHeapUsedBytes",
	"maxRssBytes",
	"memorySampleCount",
	"memorySampleIntervalMs",
	"memorySamplerOverheadMs",
	"publicationCount",
	"snapshotBuildCount",
	"trialEpoch",
];
const BENCHMARK_MESSAGE_KEYS = ["counters", "generation", "trial", "type"];
const BENCHMARK_TRIAL_KEYS = ["epoch", "id", "state"];
// Product readiness is bounded at 10s and its detached Pi-group stop is bounded at 1.1s.
const PRODUCT_BOUNDED_SHUTDOWN_WAIT_MS = 12_000;

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
	beginBenchmarkTrial: (trialId: string) => Promise<Readonly<BenchmarkGatewaySnapshot>>;
	endBenchmarkTrial: (trialId: string) => Promise<Readonly<BenchmarkGatewaySnapshot>>;
	abortBenchmarkTrial: (trialId: string) => Promise<Readonly<BenchmarkGatewaySnapshot>>;
	gatewayObservation: () => GatewayObservation;
	refreshBrowserAuthentication: (page: Page) => Promise<void>;
	restartGateway: (page?: Page) => Promise<GatewayObservation>;
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
	benchmarkSnapshot?: Readonly<BenchmarkGatewaySnapshot>;
}

export interface BenchmarkGatewayCounters {
	maxHeapUsedBytes: number;
	maxRssBytes: number;
	memorySampleCount: number;
	memorySampleIntervalMs: number;
	memorySamplerOverheadMs: number;
	publicationCount: number;
	snapshotBuildCount: number;
	trialEpoch: number;
}

export interface BenchmarkGatewayTrial {
	epoch: number;
	id: string | null;
	state: "aborted" | "active" | "ended" | "idle";
}

export interface BenchmarkGatewaySnapshot {
	counters: Readonly<BenchmarkGatewayCounters>;
	generation: string;
	trial: Readonly<BenchmarkGatewayTrial>;
}

interface BenchmarkGatewayCounterMessage extends BenchmarkGatewaySnapshot {
	type: typeof BENCHMARK_GATEWAY_COUNTER_MESSAGE;
}

interface BenchmarkGatewayTrialControlMessage {
	action: "abort" | "begin" | "end";
	trialId: string;
	type: typeof BENCHMARK_GATEWAY_TRIAL_CONTROL_MESSAGE;
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

type BenchmarkIpcChild = ChildProcessWithoutNullStreams & {
	connected: boolean;
	send: (message: BenchmarkGatewayTrialControlMessage, callback?: (error: Error | null) => void) => boolean;
};

function isSafeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidBenchmarkId(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function isBenchmarkGatewayTrial(value: unknown): value is BenchmarkGatewayTrial {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const trial = value as Record<string, unknown>;
	return (
		exactKeys(trial, BENCHMARK_TRIAL_KEYS) &&
		isSafeCounter(trial.epoch) &&
		(trial.id === null || isValidBenchmarkId(trial.id)) &&
		["aborted", "active", "ended", "idle"].includes(String(trial.state)) &&
		((trial.state === "idle" && trial.id === null && trial.epoch === 0) ||
			(trial.state !== "idle" && trial.id !== null && trial.epoch > 0))
	);
}

function isBenchmarkGatewayCounterMessage(value: unknown): value is BenchmarkGatewayCounterMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	if (!exactKeys(message, BENCHMARK_MESSAGE_KEYS)) return false;
	if (message.type !== BENCHMARK_GATEWAY_COUNTER_MESSAGE) return false;
	if (!isValidBenchmarkId(message.generation) || !isBenchmarkGatewayTrial(message.trial)) return false;
	if (typeof message.counters !== "object" || message.counters === null || Array.isArray(message.counters)) {
		return false;
	}
	const counters = message.counters as Record<string, unknown>;
	return (
		exactKeys(counters, BENCHMARK_COUNTER_KEYS) &&
		isSafeCounter(counters.maxHeapUsedBytes) &&
		isSafeCounter(counters.maxRssBytes) &&
		isSafeCounter(counters.memorySampleCount) &&
		isSafeCounter(counters.memorySampleIntervalMs) &&
		isFiniteCounter(counters.memorySamplerOverheadMs) &&
		isSafeCounter(counters.publicationCount) &&
		isSafeCounter(counters.snapshotBuildCount) &&
		isSafeCounter(counters.trialEpoch) &&
		counters.trialEpoch === (message.trial as BenchmarkGatewayTrial).epoch
	);
}

function benchmarkTrialControl(action: BenchmarkGatewayTrialControlMessage["action"], trialId: string) {
	return {
		type: BENCHMARK_GATEWAY_TRIAL_CONTROL_MESSAGE,
		action,
		trialId,
	} satisfies BenchmarkGatewayTrialControlMessage;
}

export interface BenchmarkGatewayIpcFence {
	expect: (control: BenchmarkGatewayTrialControlMessage) => void;
	error: () => string | undefined;
	fail: (message: string) => void;
	generation: () => string | undefined;
	receive: (message: unknown) => void;
	reset: () => void;
	snapshot: () => Readonly<BenchmarkGatewaySnapshot> | undefined;
}

/**
 * A benchmark child may publish only strict, generation-bound counter snapshots. This fence is
 * deliberately separate from the child-process identity check so a stale child can be discarded
 * before it reaches the active generation's trial state.
 */
export function createBenchmarkGatewayIpcFence(): BenchmarkGatewayIpcFence {
	let latest: Readonly<BenchmarkGatewaySnapshot> | undefined;
	let generation: string | undefined;
	let expected: BenchmarkGatewayTrialControlMessage | undefined;
	let failure: string | undefined;
	const fail = (message: string) => {
		failure ??= message;
	};
	return Object.freeze({
		expect: (control: BenchmarkGatewayTrialControlMessage) => {
			expected = control;
		},
		error: () => failure,
		fail,
		generation: () => generation,
		receive: (message: unknown) => {
			if (!isBenchmarkGatewayCounterMessage(message)) {
				fail("benchmark Gateway sent malformed or unexpected IPC after launch");
				return;
			}
			if (!generation) generation = message.generation;
			if (message.generation !== generation) {
				fail("benchmark Gateway IPC generation changed without a harness restart");
				return;
			}
			const previous = latest;
			const expectedBegin =
				expected?.action === "begin" &&
				expected.trialId === message.trial.id &&
				message.trial.state === "active";
			if (expected) {
				const requiredState =
					expected.action === "begin" ? "active" : expected.action === "end" ? "ended" : "aborted";
				if (message.trial.id === expected.trialId && message.trial.state === requiredState) {
					expected = undefined;
				} else if (
					message.trial.state !== "idle" &&
					(!previous ||
						message.trial.id !== previous.trial.id ||
						message.trial.epoch !== previous.trial.epoch ||
						message.trial.state !== previous.trial.state)
				) {
					fail("benchmark Gateway IPC does not match the requested trial lifecycle transition");
					return;
				}
			}
			if (previous && message.trial.epoch < previous.trial.epoch) {
				fail("benchmark Gateway IPC trial epoch regressed");
				return;
			}
			if (
				previous &&
				message.trial.epoch > previous.trial.epoch &&
				message.trial.state === "active" &&
				!expectedBegin
			) {
				fail("benchmark Gateway activated an unrequested trial");
				return;
			}
			latest = Object.freeze({
				generation: message.generation,
				trial: Object.freeze({ ...message.trial }),
				counters: Object.freeze({ ...message.counters }),
			});
		},
		reset: () => {
			latest = undefined;
			generation = undefined;
			expected = undefined;
			failure = undefined;
		},
		snapshot: () => latest,
	});
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

function benchmarkBuildPathsFromEnvironment(): BenchmarkBuildPaths {
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
	const graceful = await exited;
	if (graceful) return;
	const forceExited = waitForExit(PRODUCT_BOUNDED_SHUTDOWN_WAIT_MS);
	child.kill("SIGKILL");
	await forceExited;
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

async function waitForBenchmarkSnapshot(
	read: () => Readonly<BenchmarkGatewaySnapshot> | undefined,
	readError: () => string | undefined,
	output: () => string,
	predicate: (snapshot: Readonly<BenchmarkGatewaySnapshot>) => boolean = () => true,
): Promise<Readonly<BenchmarkGatewaySnapshot>> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const error = readError();
		if (error) throw new Error(`${error}\n${output()}`);
		const snapshot = read();
		if (snapshot && predicate(snapshot)) return snapshot;
		await delay(25);
	}
	throw new Error(`benchmark Gateway did not publish the required strict aggregate snapshot:\n${output()}`);
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
	const benchmarkGateway = options.benchmarkGateway === true;
	const benchmarkBuild = benchmarkGateway ? benchmarkBuildPathsFromEnvironment() : undefined;
	let benchmarkChild: BenchmarkIpcChild | undefined;
	let benchmarkTerminationInProgress = false;
	const benchmarkIpcFence = createBenchmarkGatewayIpcFence();
	const clearBenchmarkIpcState = () => {
		benchmarkChild = undefined;
		benchmarkTerminationInProgress = false;
		benchmarkIpcFence.reset();
	};
	const recordBenchmarkSnapshot = (child: BenchmarkIpcChild, message: unknown) => {
		if (activeChild !== child || benchmarkChild !== child) return;
		benchmarkIpcFence.receive(message);
	};
	const terminateGatewayChild = async (
		child: ChildProcessWithoutNullStreams,
	): Promise<string | undefined> => {
		if (benchmarkChild === child) benchmarkTerminationInProgress = true;
		try {
			await terminate(child);
			return benchmarkIpcFence.error();
		} finally {
			if (activeChild === child) activeChild = undefined;
			if (benchmarkChild === child) benchmarkChild = undefined;
			benchmarkTerminationInProgress = false;
		}
	};

	const startGateway = async (): Promise<void> => {
		let childOutput = "";
		clearBenchmarkIpcState();
		const child = (
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
							stdio: ["pipe", "pipe", "pipe", "ipc"],
							env: childEnvironment({
								...options.extraEnv,
								// These isolated roots deliberately replace all default Pi roots for every launch.
								PI_CODING_AGENT_DIR: agentDir,
								PI_CODING_AGENT_SESSION_DIR: sessionDir,
								PI_WEB_DATA_DIR: webDataDir,
								PI_WEB_E2E_MARKER: markerPath,
								PI_WEB_E2E_CONTROL_DIR: controlDir,
								PI_WEB_BENCHMARK_STATIC_DIR: benchmarkBuild!.staticDir,
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
			const ipcChild = child as BenchmarkIpcChild;
			benchmarkChild = ipcChild;
			ipcChild.on("message", (message: unknown) => recordBenchmarkSnapshot(ipcChild, message));
			ipcChild.once("exit", () => {
				if (activeChild === ipcChild && !benchmarkTerminationInProgress && !benchmarkIpcFence.error()) {
					benchmarkIpcFence.fail("benchmark Gateway exited before the harness completed its lifecycle");
				}
				if (benchmarkChild === ipcChild) benchmarkChild = undefined;
			});
		}
		try {
			const observedOrigin = await waitForListening(child, () => childOutput);
			if (observedOrigin !== origin) {
				throw new Error(`gateway listened on ${observedOrigin}, expected stable origin ${origin}`);
			}
			cookie = await bootstrapGateway(origin, () => childOutput);
			if (benchmarkGateway) {
				await waitForBenchmarkSnapshot(
					() => benchmarkIpcFence.snapshot(),
					() => benchmarkIpcFence.error(),
					() => childOutput,
					(snapshot) => snapshot.trial.state === "idle" && snapshot.trial.epoch === 0,
				);
			}
		} catch (error) {
			const ipcFailure = await terminateGatewayChild(child);
			if (benchmarkChild === child) clearBenchmarkIpcState();
			if (ipcFailure) throw new Error(ipcFailure, { cause: error });
			throw error;
		}
	};

	const observation = (): GatewayObservation => {
		if (!activeChild?.pid) throw new Error("production harness gateway is not running");
		if (!benchmarkGateway) return { origin, port, pid: activeChild.pid, restartCount };
		const latestBenchmarkSnapshot = benchmarkIpcFence.snapshot();
		const ipcError = benchmarkIpcFence.error();
		if (ipcError) throw new Error(ipcError);
		if (!latestBenchmarkSnapshot) throw new Error("benchmark Gateway counters are unavailable");
		return {
			origin,
			port,
			pid: activeChild.pid,
			restartCount,
			benchmarkCounters: Object.freeze({ ...latestBenchmarkSnapshot.counters }),
			benchmarkSnapshot: Object.freeze({
				generation: latestBenchmarkSnapshot.generation,
				trial: Object.freeze({ ...latestBenchmarkSnapshot.trial }),
				counters: Object.freeze({ ...latestBenchmarkSnapshot.counters }),
			}),
		};
	};
	const controlBenchmarkTrial = async (
		action: BenchmarkGatewayTrialControlMessage["action"],
		trialId: string,
	): Promise<Readonly<BenchmarkGatewaySnapshot>> => {
		const latestBenchmarkSnapshot = benchmarkIpcFence.snapshot();
		const benchmarkGeneration = benchmarkIpcFence.generation();
		if (!benchmarkGateway || !benchmarkChild || !benchmarkGeneration || !latestBenchmarkSnapshot) {
			throw new Error("benchmark trial lifecycle is unavailable on the normal production harness");
		}
		const ipcError = benchmarkIpcFence.error();
		if (ipcError) throw new Error(ipcError);
		if (!isValidBenchmarkId(trialId)) throw new Error("benchmark trial id is invalid");
		const current = latestBenchmarkSnapshot.trial;
		if (action === "begin" && current.state === "active") {
			throw new Error("benchmark harness refuses to overlap trials");
		}
		if (action !== "begin" && (current.state !== "active" || current.id !== trialId)) {
			throw new Error("benchmark harness trial lifecycle does not match the active child trial");
		}
		const control = benchmarkTrialControl(action, trialId);
		benchmarkIpcFence.expect(control);
		await new Promise<void>((resolve, reject) => {
			if (!benchmarkChild?.connected) {
				reject(new Error("benchmark Gateway IPC channel is disconnected"));
				return;
			}
			const sent = benchmarkChild.send(control, (error) => {
				if (error) reject(error);
				else resolve();
			});
			if (!sent) reject(new Error("benchmark Gateway refused a trial lifecycle IPC message"));
		});
		const expectedState = action === "begin" ? "active" : action === "end" ? "ended" : "aborted";
		const snapshot = await waitForBenchmarkSnapshot(
			() => benchmarkIpcFence.snapshot(),
			() => benchmarkIpcFence.error(),
			() => output,
			(candidate) =>
				candidate.generation === benchmarkGeneration &&
				candidate.trial.id === trialId &&
				candidate.trial.state === expectedState,
		);
		return Object.freeze({
			generation: snapshot.generation,
			trial: Object.freeze({ ...snapshot.trial }),
			counters: Object.freeze({ ...snapshot.counters }),
		});
	};
	const refreshBrowserAuthentication = async (page: Page): Promise<void> => {
		await page.evaluate(async () => {
			const response = await fetch("/api/v1/bootstrap", { credentials: "include" });
			if (!response.ok) throw new Error(`Browser bootstrap failed with ${String(response.status)}`);
		});
		await page.evaluate(async (gatewayOrigin) => {
			const websocketOrigin = gatewayOrigin.replace(/^http/, "ws");
			await new Promise<void>((resolve, reject) => {
				const socket = new WebSocket(`${websocketOrigin}/api/v1/ws`);
				const timeout = window.setTimeout(() => {
					socket.close();
					reject(new Error("authenticated WebSocket did not open after Gateway restart"));
				}, 10_000);
				socket.addEventListener("open", () => {
					window.clearTimeout(timeout);
					socket.close();
					resolve();
				});
				socket.addEventListener("error", () => {
					window.clearTimeout(timeout);
					reject(new Error("authenticated WebSocket failed after Gateway restart"));
				});
			});
		}, origin);
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
			beginBenchmarkTrial: (trialId) => controlBenchmarkTrial("begin", trialId),
			endBenchmarkTrial: (trialId) => controlBenchmarkTrial("end", trialId),
			abortBenchmarkTrial: (trialId) => controlBenchmarkTrial("abort", trialId),
			gatewayObservation: observation,
			refreshBrowserAuthentication,
			restartGateway: async (page) => {
				const previous = activeChild;
				if (!previous) throw new Error("production harness gateway is not running");
				const ipcFailure = await terminateGatewayChild(previous);
				clearBenchmarkIpcState();
				if (ipcFailure) throw new Error(ipcFailure);
				await waitForLoopbackPortRelease(port, () => output);
				await startGateway();
				restartCount += 1;
				if (page) await refreshBrowserAuthentication(page);
				return observation();
			},
			requestJson,
			stop: async () => {
				const child = activeChild;
				const ipcFailure = child ? await terminateGatewayChild(child) : benchmarkIpcFence.error();
				clearBenchmarkIpcState();
				fs.rmSync(rootDir, { recursive: true, force: true });
				if (ipcFailure) throw new Error(ipcFailure);
			},
		};
	} catch (error) {
		const child = activeChild;
		const ipcFailure = child ? await terminateGatewayChild(child) : benchmarkIpcFence.error();
		clearBenchmarkIpcState();
		fs.rmSync(rootDir, { recursive: true, force: true });
		if (ipcFailure) throw new Error(ipcFailure, { cause: error });
		throw error;
	}
}
