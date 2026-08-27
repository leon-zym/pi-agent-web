import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(fixturesDir, "../../..");
const defaultFakePiPath = path.join(fixturesDir, "deterministic-pi.mjs");
const cliPath = path.join(repositoryRoot, "packages/cli/dist/cli.js");
const LISTENING_PATTERN = /listening on (http:\/\/127\.0\.0\.1:\d+)/;
const CREDENTIAL_ENV_PATTERN =
	/(api[_-]?key|token|secret|password|credential|openai|anthropic|gemini|deepseek)/i;

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
	imageCount?: number;
	imageMimeTypes?: string[];
	imageChars?: number;
	deltaIndex?: number;
	toolCount?: number;
	markdownChars?: number;
	confirmed?: boolean;
	cancelled?: boolean;
}

export interface ProductionHarness {
	origin: string;
	rootDir: string;
	workspacePath: string;
	workspace: HarnessWorkspace;
	session: HarnessSession;
	logs: () => string;
	piEvents: () => PiFixtureEvent[];
	releasePrompt: (text: string) => void;
	requestJson: <T>(pathname: string, init?: RequestInit) => Promise<T>;
	stop: () => Promise<void>;
}

export interface StartHarnessOptions {
	fakePiPath?: string;
	extraEnv?: NodeJS.ProcessEnv;
	seedHistoricalSession?: {
		userText: string;
		assistantText: string;
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
	const userId = `${nativeSessionId}-user`;
	const assistantId = `${nativeSessionId}-assistant`;
	const entries = [
		{
			type: "session",
			version: 3,
			id: nativeSessionId,
			timestamp,
			cwd: workspacePath,
		},
		{
			type: "message",
			id: userId,
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text: seed.userText }],
				timestamp: Date.parse(timestamp),
			},
		},
		{
			type: "message",
			id: assistantId,
			parentId: userId,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: seed.assistantText }],
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
				timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
			},
		},
	];
	fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
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
	const child = spawn(
		process.execPath,
		[
			cliPath,
			"--pi-path",
			options.fakePiPath ?? defaultFakePiPath,
			"--host",
			"127.0.0.1",
			"--port",
			"0",
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
	);
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});

	try {
		const origin = await waitForListening(child, () => output);
		const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
		if (!bootstrap.ok) throw new Error(`bootstrap failed with ${String(bootstrap.status)}`);
		const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
		if (!cookie) throw new Error("bootstrap did not issue a session cookie");

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
			requestJson,
			stop: async () => {
				await terminate(child);
				fs.rmSync(rootDir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await terminate(child);
		fs.rmSync(rootDir, { recursive: true, force: true });
		throw error;
	}
}
