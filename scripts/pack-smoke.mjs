import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-pack-smoke-"));
const tarballDir = path.join(tempRoot, "tarballs");
const installDir = path.join(tempRoot, "install");
fs.mkdirSync(tarballDir);
fs.mkdirSync(installDir);

function run(command, args, cwd = root) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe", timeout: 120_000 });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
	}
	return result.stdout;
}

function packageManifest(tarball) {
	return JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"]));
}

function waitForOutput(child, pattern, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(
			() => reject(new Error(`CLI did not print ${String(pattern)}:\n${output}`)),
			timeoutMs,
		);
		const onData = (chunk) => {
			output += chunk.toString();
			const match = output.match(pattern);
			if (!match) return;
			clearTimeout(timer);
			child.stdout.off("data", onData);
			resolve(match);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.once("error", reject);
	});
}

function waitForChildExit(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		const finish = (exited) => {
			clearTimeout(timer);
			child.off("exit", onExit);
			resolve(exited);
		};
		child.once("exit", onExit);
	});
}

async function closeChild(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	if (await waitForChildExit(child, 2_000)) return;
	child.kill("SIGKILL");
	if (!(await waitForChildExit(child, 2_000))) throw new Error("Packaged CLI did not exit after SIGKILL");
}

function waitForSocket(socket, setup, timeoutMessage, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => {
			try {
				socket.terminate();
			} finally {
				finish(new Error(timeoutMessage));
			}
		}, timeoutMs);
		setup(finish);
	});
}

try {
	const packageNames = [
		"@pi-agent-web/protocol",
		"@pi-agent-web/server",
		"@pi-agent-web/ui",
		"@pi-agent-web/cli",
	];
	for (const packageName of packageNames) {
		run("pnpm", ["--filter", packageName, "pack", "--pack-destination", tarballDir]);
	}
	const tarballs = fs
		.readdirSync(tarballDir)
		.filter((entry) => entry.endsWith(".tgz"))
		.map((entry) => path.join(tarballDir, entry));
	if (tarballs.length !== 4) throw new Error(`Expected four tarballs, found ${String(tarballs.length)}`);
	for (const tarball of tarballs) {
		const files = run("tar", ["-tzf", tarball]);
		if (!files.includes("package/dist/"))
			throw new Error(`Missing dist directory in ${path.basename(tarball)}`);
		if (!files.includes("package/LICENSE")) throw new Error(`Missing LICENSE in ${path.basename(tarball)}`);
		if (files.includes("package/src/"))
			throw new Error(`Source directory leaked into ${path.basename(tarball)}`);
		const manifest = packageManifest(tarball);
		if (
			manifest.license !== "MIT" ||
			manifest.repository?.url !== "git+https://github.com/leon-zym/pi-agent-web.git"
		) {
			throw new Error(`Missing publish metadata in ${path.basename(tarball)}`);
		}
		if (JSON.stringify(manifest).includes("workspace:*")) {
			throw new Error(`Workspace dependency leaked into ${path.basename(tarball)}`);
		}
	}
	fs.writeFileSync(path.join(installDir, "package.json"), '{"name":"piweb-pack-smoke","private":true}\n');
	run("npm", ["install", "--ignore-scripts", ...tarballs], installDir);

	const bin = path.join(
		installDir,
		"node_modules",
		".bin",
		process.platform === "win32" ? "pi-web.cmd" : "pi-web",
	);
	run(bin, ["--help"], installDir);
	run("npx", ["--prefix", installDir, "--no-install", "pi-web", "--help"], installDir);

	const cliEntry = path.join(installDir, "node_modules", "@pi-agent-web", "cli", "dist", "cli.js");
	const externalWorkspace = path.join(tempRoot, "external-workspace");
	const emptyBinDir = path.join(tempRoot, "empty-bin");
	fs.mkdirSync(externalWorkspace);
	fs.mkdirSync(emptyBinDir);
	const packagedEnv = {
		...process.env,
		PATH: emptyBinDir,
		PI_CODING_AGENT_DIR: path.join(tempRoot, "agent"),
		PI_CODING_AGENT_SESSION_DIR: path.join(tempRoot, "sessions"),
		PI_WEB_DATA_DIR: path.join(tempRoot, "web-data"),
	};
	delete packagedEnv.PI_PATH;
	const child = spawn(process.execPath, [cliEntry, "--host", "127.0.0.1", "--port", "0", "--no-open"], {
		cwd: externalWorkspace,
		stdio: ["ignore", "pipe", "pipe"],
		env: packagedEnv,
	});
	try {
		const match = await waitForOutput(child, /listening on http:\/\/127\.0\.0\.1:(\d+)/);
		const origin = `http://127.0.0.1:${match[1]}`;
		const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
		const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
		if (!bootstrap.ok || !cookie) throw new Error("Bootstrap did not issue a session cookie");
		const response = await fetch(`${origin}/api/v1/health/ready`, {
			headers: { Origin: origin, Cookie: cookie },
		});
		if (!response.ok) throw new Error(`Health check failed with ${String(response.status)}`);
		const readiness = await response.json();
		if (
			readiness?.ready !== true ||
			readiness?.runtime?.source !== "bundled" ||
			readiness?.runtime?.version !== "0.84.2" ||
			readiness?.runtime?.adapterId !== "pi-rpc"
		) {
			throw new Error(`Packaged Gateway selected an unexpected runtime: ${JSON.stringify(readiness)}`);
		}
		const workspaceResponse = await fetch(`${origin}/api/v1/workspaces`, {
			method: "POST",
			headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
			body: JSON.stringify({ path: externalWorkspace }),
		});
		if (!workspaceResponse.ok) {
			throw new Error(`Packaged workspace creation failed with ${String(workspaceResponse.status)}`);
		}
		const workspace = await workspaceResponse.json();
		const sessionResponse = await fetch(
			`${origin}/api/v1/workspaces/${encodeURIComponent(workspace.workspaceHandle)}/sessions`,
			{ method: "POST", headers: { Origin: origin, Cookie: cookie } },
		);
		if (!sessionResponse.ok) {
			throw new Error(
				`Packaged Session activation failed with ${String(sessionResponse.status)}: ${await sessionResponse.text()}`,
			);
		}
		const session = await sessionResponse.json();
		if (session?.runtime?.state !== "idle") {
			throw new Error(`Packaged Session did not complete Pi readiness: ${JSON.stringify(session)}`);
		}
		const crossPort = await fetch(`${origin}/api/v1/health`, {
			headers: { Origin: "http://localhost:5173", Cookie: cookie },
		});
		if (crossPort.status !== 403) {
			throw new Error(`Packaged REST accepted a cross-port Origin with status ${String(crossPort.status)}`);
		}
		const spa = await fetch(origin);
		if (!spa.ok || !(await spa.text()).includes('<div id="root"></div>')) {
			throw new Error("Packaged SPA was not served from the CLI port");
		}
		const requireFromInstall = createRequire(path.join(installDir, "package.json"));
		const WebSocket = requireFromInstall("ws");
		const helloSocket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws`, {
			headers: { Origin: origin, Cookie: cookie },
		});
		await waitForSocket(
			helloSocket,
			(finish) => {
				const socket = helloSocket;
				socket.once("open", () => {
					socket.send(
						JSON.stringify({
							type: "client_hello",
							protocol: { major: 1, minor: 4 },
							clientBuild: "pack-smoke",
							capabilities: [
								"rpc.commands",
								"rpc.events",
								"rpc.extension_ui",
								"session.multiplex",
								"session.hot_runtime_inventory",
								"session.fenced_takeover",
								"payload.epoch_attachment_refs",
								"payload.epoch_content_refs",
							],
							limits: { maxServerFrameBytes: 68 * 1024 * 1024 },
						}),
					);
				});
				socket.once("message", (raw) => {
					const hello = JSON.parse(raw.toString());
					if (
						hello.type !== "server_hello" ||
						hello.protocol?.major !== 1 ||
						hello.protocol?.minor !== 4 ||
						hello.serverEpoch === undefined ||
						!hello.capabilities?.includes("session.fenced_takeover") ||
						!hello.capabilities?.includes("payload.epoch_attachment_refs") ||
						!hello.capabilities?.includes("payload.epoch_content_refs") ||
						hello.payloadBudget?.maxServerFrameBytes !== 65 * 1024 * 1024 ||
						hello.contentRefBudget?.maxContentBlobBytes !== 48 * 1024 * 1024 ||
						hello.contentRefBudget?.inlineContentThresholdBytes !== 256 * 1024
					) {
						finish(new Error(`Packaged WebSocket did not negotiate hello: ${raw.toString()}`));
						return;
					}
					socket.close();
					finish();
				});
				socket.once("error", finish);
			},
			"Packaged WebSocket hello timed out",
		);
		const legacyProtocolSocket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws`, {
			headers: { Origin: origin, Cookie: cookie },
		});
		await waitForSocket(
			legacyProtocolSocket,
			(finish) => {
				const socket = legacyProtocolSocket;
				let rejected = false;
				socket.once("open", () => {
					socket.send(
						JSON.stringify({
							type: "client_hello",
							protocol: { major: 1, minor: 3 },
							clientBuild: "pack-smoke-legacy",
							capabilities: [
								"rpc.commands",
								"rpc.events",
								"rpc.extension_ui",
								"session.multiplex",
								"session.hot_runtime_inventory",
								"session.fenced_takeover",
								"payload.epoch_attachment_refs",
								"payload.epoch_content_refs",
							],
							limits: { maxServerFrameBytes: 68 * 1024 * 1024 },
						}),
					);
				});
				socket.once("message", (raw) => {
					const error = JSON.parse(raw.toString());
					if (
						error.type !== "protocol_error" ||
						error.code !== "invalid_hello" ||
						error.supported?.major !== 1 ||
						error.supported?.minMinor !== 4 ||
						error.supported?.maxMinor !== 4
					) {
						finish(new Error(`Packaged WebSocket accepted protocol 1.3: ${raw.toString()}`));
						return;
					}
					rejected = true;
				});
				socket.once("close", () => {
					if (rejected) finish();
					else finish(new Error("Packaged WebSocket closed protocol 1.3 without a terminal error"));
				});
				socket.once("error", finish);
			},
			"Packaged WebSocket protocol 1.3 rejection timed out",
		);
		const rejectedSocket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws`, {
			headers: { Origin: "http://localhost:5173", Cookie: cookie },
		});
		await waitForSocket(
			rejectedSocket,
			(finish) => {
				const socket = rejectedSocket;
				socket.once("unexpected-response", (_request, rejected) => {
					rejected.resume();
					if (rejected.statusCode === 403) finish();
					else finish(new Error(`Packaged WebSocket rejection returned ${String(rejected.statusCode)}`));
				});
				socket.once("open", () => finish(new Error("Packaged WebSocket accepted a cross-port Origin")));
				socket.once("error", finish);
			},
			"Packaged cross-origin WebSocket check timed out",
		);
	} finally {
		await closeChild(child);
	}
	console.log("PACK SMOKE OK");
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
