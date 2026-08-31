import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
	closeChild,
	inspectPackageTarballs,
	installedBin,
	installTarballs,
	launchInstalledCli,
	packWorkspacePackages,
	run,
	waitForOutput,
	waitForSocket,
} from "./lib/package-smoke.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-pack-smoke-"));
const tarballDir = path.join(tempRoot, "tarballs");
const installDir = path.join(tempRoot, "install");
fs.mkdirSync(tarballDir);
fs.mkdirSync(installDir);

try {
	const tarballs = packWorkspacePackages({ tarballDir });
	inspectPackageTarballs(tarballs);
	installTarballs({ tarballs, installDir });

	const bin = installedBin(installDir);
	run(bin, ["--help"], { cwd: installDir });
	run("npx", ["--prefix", installDir, "--no-install", "pi-web", "--help"], { cwd: installDir });

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
	const child = launchInstalledCli({
		installDir,
		args: ["--host", "127.0.0.1", "--port", "0", "--no-open"],
		cwd: externalWorkspace,
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
							protocol: { major: 1, minor: 3 },
							clientBuild: "pack-smoke",
							capabilities: [
								"rpc.commands",
								"rpc.events",
								"rpc.extension_ui",
								"session.multiplex",
								"session.hot_runtime_inventory",
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
						hello.protocol?.minor !== 3 ||
						hello.serverEpoch === undefined ||
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
