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
	const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
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
		const timer = setTimeout(() => reject(new Error(`CLI did not print ${String(pattern)}:\n${output}`)), timeoutMs);
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

async function closeChild(child) {
	if (child.exitCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	await exited;
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
		if (!files.includes("package/dist/")) throw new Error(`Missing dist directory in ${path.basename(tarball)}`);
		if (files.includes("package/src/")) throw new Error(`Source directory leaked into ${path.basename(tarball)}`);
		if (JSON.stringify(packageManifest(tarball)).includes("workspace:*")) {
			throw new Error(`Workspace dependency leaked into ${path.basename(tarball)}`);
		}
	}
	fs.writeFileSync(path.join(installDir, "package.json"), '{"name":"piweb-pack-smoke","private":true}\n');
	run("npm", ["install", "--ignore-scripts", ...tarballs], installDir);

	const bin = path.join(installDir, "node_modules", ".bin", process.platform === "win32" ? "pi-web.cmd" : "pi-web");
	run(bin, ["--help"], installDir);
	run("npx", ["--prefix", installDir, "--no-install", "pi-web", "--help"], installDir);

	const fakePiPath = path.join(tempRoot, "fake-rpc.mjs");
	fs.writeFileSync(fakePiPath, "process.stdin.resume();\n", "utf8");
	const child = spawn(bin, ["--pi-path", fakePiPath, "--host", "127.0.0.1", "--port", "0", "--no-open"], {
		cwd: installDir,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: path.join(tempRoot, "agent"),
			PI_CODING_AGENT_SESSION_DIR: path.join(tempRoot, "sessions"),
			PI_WEB_DATA_DIR: path.join(tempRoot, "web-data"),
		},
	});
	try {
		const match = await waitForOutput(child, /listening on http:\/\/127\.0\.0\.1:(\d+)/);
		const origin = `http://127.0.0.1:${match[1]}`;
		const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
		const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
		if (!bootstrap.ok || !cookie) throw new Error("Bootstrap did not issue a session cookie");
		const response = await fetch(`${origin}/api/v1/health`, { headers: { Origin: origin, Cookie: cookie } });
		if (!response.ok) throw new Error(`Health check failed with ${String(response.status)}`);
		const spa = await fetch(origin);
		if (!spa.ok || !(await spa.text()).includes('<div id="root"></div>')) {
			throw new Error("Packaged SPA was not served from the CLI port");
		}
		const requireFromInstall = createRequire(path.join(installDir, "package.json"));
		const WebSocket = requireFromInstall("ws");
		await new Promise((resolve, reject) => {
			const socket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws`, {
				headers: { Origin: origin, Cookie: cookie },
			});
			socket.once("open", () => {
				socket.close();
				resolve();
			});
			socket.once("error", reject);
		});
	} finally {
		await closeChild(child);
	}
	console.log("PACK SMOKE OK");
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
