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
	id: string;
	path: string;
}

export interface ProductionHarness {
	origin: string;
	rootDir: string;
	workspace: HarnessWorkspace;
	logs: () => string;
	requestJson: <T>(pathname: string, init?: RequestInit) => Promise<T>;
	stop: () => Promise<void>;
}

export interface StartHarnessOptions {
	fakePiPath?: string;
	extraEnv?: NodeJS.ProcessEnv;
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
	const markerPath = path.join(rootDir, "fake-pi.started");
	for (const directory of [agentDir, sessionDir, webDataDir, workspacePath]) {
		fs.mkdirSync(directory, { recursive: true });
	}
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
			const body = (await response.json()) as T & { error?: string };
			if (!response.ok) {
				throw new Error(
					`${init.method ?? "GET"} ${pathname} failed with ${String(response.status)}: ${body.error ?? "unknown error"}`,
				);
			}
			return body;
		};

		const workspace = await requestJson<HarnessWorkspace>("/api/v1/workspaces", {
			method: "POST",
			body: JSON.stringify({ path: workspacePath, displayName: "Browser E2E" }),
		});
		await requestJson(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/process/restart`, {
			method: "POST",
		});
		if (!fs.existsSync(markerPath)) throw new Error("deterministic fake Pi was not started");

		return {
			origin,
			rootDir,
			workspace,
			logs: () => output,
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
