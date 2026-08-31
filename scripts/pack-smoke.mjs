import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createReleaseBundle, inspectDeterministicTarGz } from "./create-release-bundle.mjs";
import {
	assertInstalledProductIsolation,
	closeChild,
	controlledNpxEnvironment,
	extractBundleArchive,
	installBundle,
	launchInstalledCli,
	run,
	terminateChildWithin,
	waitForOutput,
	waitForProcessesToExit,
	waitForSocket,
} from "./lib/package-smoke.mjs";

const timeout = (promise, timeoutMs, label) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`)),
			timeoutMs,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});

async function waitUntil(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`${label} timed out after ${String(timeoutMs)}ms`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function closeSocket(socket) {
	if (!socket || socket.readyState === socket.CLOSED) return;
	await new Promise((resolve) => {
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, 1_000);
		socket.once("close", finish);
		socket.once("error", finish);
		socket.close();
	});
}

async function bootstrap(origin) {
	const response = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	if (!response.ok || !cookie) throw new Error("Bootstrap did not issue a session cookie");
	return { cookie, headers: { Origin: origin, Cookie: cookie } };
}

async function createWorkspaceAndSession({ headers, origin, workspacePath }) {
	const workspaceResponse = await fetch(`${origin}/api/v1/workspaces`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({ path: workspacePath }),
	});
	if (!workspaceResponse.ok) {
		throw new Error(`Packaged workspace creation failed with ${String(workspaceResponse.status)}`);
	}
	const workspace = await workspaceResponse.json();
	const sessionResponse = await fetch(
		`${origin}/api/v1/workspaces/${encodeURIComponent(workspace.workspaceHandle)}/sessions`,
		{ method: "POST", headers },
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
	if (
		typeof session.runtime.sessionHandle !== "string" ||
		!Number.isSafeInteger(session.runtime.generation) ||
		session.runtime.generation < 1
	) {
		throw new Error(`Packaged Session exposed an invalid Runtime identity: ${JSON.stringify(session)}`);
	}
	return session.runtime;
}

async function installedProtocol(bundleRoot) {
	const protocolEntry = path.join(
		bundleRoot,
		"node_modules",
		"@pi-agent-web",
		"protocol",
		"dist",
		"index.js",
	);
	return import(pathToFileURL(protocolEntry).href);
}

function installedWebSocket(bundleRoot) {
	const requireFromInstall = createRequire(path.join(bundleRoot, "package.json"));
	return requireFromInstall("ws");
}

function assertServerHello(hello, protocol) {
	if (
		hello.type !== "server_hello" ||
		hello.protocol?.major !== protocol.GATEWAY_PROTOCOL_VERSION.major ||
		hello.protocol?.minor !== protocol.GATEWAY_PROTOCOL_VERSION.minor ||
		hello.serverEpoch === undefined ||
		!protocol.GATEWAY_SERVER_REQUIRED_CAPABILITIES.every((capability) =>
			hello.capabilities?.includes(capability),
		) ||
		hello.payloadBudget?.maxServerFrameBytes !== protocol.SESSION_PAYLOAD_BUDGET.maxServerFrameBytes ||
		hello.contentRefBudget?.maxContentBlobBytes !== protocol.SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes ||
		hello.contentRefBudget?.inlineContentThresholdBytes !==
			protocol.SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes
	) {
		throw new Error(`Packaged WebSocket did not negotiate hello: ${JSON.stringify(hello)}`);
	}
}

async function openGatewaySocket({ WebSocket, cookie, origin, protocol, clientBuild }) {
	const socket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws`, {
		headers: { Origin: origin, Cookie: cookie },
	});
	try {
		await timeout(
			new Promise((resolve, reject) => {
				socket.once("open", resolve);
				socket.once("error", reject);
			}),
			10_000,
			"Packaged WebSocket open",
		);
		await timeout(
			new Promise((resolve, reject) => {
				socket.once("message", (raw) => {
					try {
						const hello = JSON.parse(raw.toString());
						assertServerHello(hello, protocol);
						resolve();
					} catch (error) {
						reject(error);
					}
				});
				socket.once("error", reject);
				socket.send(
					JSON.stringify({
						type: "client_hello",
						protocol: protocol.GATEWAY_PROTOCOL_VERSION,
						clientBuild,
						capabilities: [...protocol.GATEWAY_SERVER_REQUIRED_CAPABILITIES],
						limits: { maxServerFrameBytes: protocol.SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
					}),
				);
			}),
			10_000,
			"Packaged WebSocket hello",
		);
		return socket;
	} catch (error) {
		await closeSocket(socket);
		throw error;
	}
}

async function verifyCrossOriginRejection({ WebSocket, cookie, origin }) {
	const socket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws`, {
		headers: { Origin: "http://localhost:5173", Cookie: cookie },
	});
	await waitForSocket(
		socket,
		(finish) => {
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
}

async function verifyBundledReadiness({ bundleRoot, child, expectedPiVersion, workspacePath }) {
	const match = await waitForOutput(child, /listening on http:\/\/127\.0\.0\.1:(\d+)/);
	const origin = `http://127.0.0.1:${match[1]}`;
	const { cookie, headers } = await bootstrap(origin);
	const response = await fetch(`${origin}/api/v1/health/ready`, { headers });
	if (!response.ok) throw new Error(`Health check failed with ${String(response.status)}`);
	const readiness = await response.json();
	if (
		readiness?.ready !== true ||
		readiness?.runtime?.source !== "bundled" ||
		readiness?.runtime?.version !== expectedPiVersion ||
		readiness?.runtime?.adapterId !== "pi-rpc"
	) {
		throw new Error(`Packaged Gateway selected an unexpected bundled runtime: ${JSON.stringify(readiness)}`);
	}
	await createWorkspaceAndSession({ headers, origin, workspacePath });
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
	const protocol = await installedProtocol(bundleRoot);
	const WebSocket = installedWebSocket(bundleRoot);
	const socket = await openGatewaySocket({
		WebSocket,
		cookie,
		origin,
		protocol,
		clientBuild: "pack-smoke-bundled",
	});
	await closeSocket(socket);
	await verifyCrossOriginRejection({ WebSocket, cookie, origin });
}

function fixtureProcessIds(markerPath) {
	if (!fs.existsSync(markerPath)) return [];
	const processIds = new Set();
	for (const line of fs.readFileSync(markerPath, "utf8").split("\n")) {
		const match = line.match(/^start:([1-9][0-9]*)$/);
		if (!match) continue;
		const processId = Number(match[1]);
		if (Number.isSafeInteger(processId) && processId !== process.pid) processIds.add(processId);
	}
	return [...processIds];
}

async function runNonEmptyConversation({ WebSocket, cookie, origin, protocol, runtime }) {
	const socket = await openGatewaySocket({
		WebSocket,
		cookie,
		origin,
		protocol,
		clientBuild: "pack-smoke-deterministic",
	});
	const state = {
		error: undefined,
		fencingToken: undefined,
		generation: runtime.generation,
		runtime: undefined,
		settled: 0,
		streamed: false,
	};
	const responses = new Map();
	const onMessage = (raw) => {
		let frame;
		try {
			frame = JSON.parse(raw.toString());
		} catch (error) {
			state.error = error;
			return;
		}
		if (frame.type === "runtime_state" && frame.runtime?.sessionHandle === runtime.sessionHandle) {
			state.runtime = frame.runtime;
			state.generation = frame.runtime.generation;
			return;
		}
		if (frame.type === "lease_status" && frame.sessionHandle === runtime.sessionHandle) {
			if (frame.isController === true && typeof frame.fencingToken === "string")
				state.fencingToken = frame.fencingToken;
			return;
		}
		if (frame.type === "session_error" && frame.sessionHandle === runtime.sessionHandle) {
			state.error = new Error(`Packaged Session ${String(frame.operation)} failed: ${String(frame.error)}`);
			return;
		}
		if (frame.type === "response" && frame.sessionHandle === runtime.sessionHandle && frame.response?.id) {
			responses.set(frame.response.id, frame.response);
			return;
		}
		if (frame.type !== "event" || frame.sessionHandle !== runtime.sessionHandle || !frame.event) return;
		if (
			frame.event.type === "message_update" &&
			frame.event.assistantMessageEvent?.type === "text_delta" &&
			typeof frame.event.assistantMessageEvent.delta === "string" &&
			frame.event.assistantMessageEvent.delta.length > 0
		) {
			state.streamed = true;
		}
		if (frame.event.type === "agent_settled") state.settled += 1;
	};
	socket.on("message", onMessage);
	try {
		socket.send(JSON.stringify({ type: "session_subscribe", sessionHandle: runtime.sessionHandle }));
		await waitUntil(
			() => Boolean(state.runtime) || Boolean(state.error),
			10_000,
			"packaged Session subscribe",
		);
		if (state.error) throw state.error;
		socket.send(JSON.stringify({ type: "session_claim", sessionHandle: runtime.sessionHandle }));
		await waitUntil(
			() => Boolean(state.fencingToken) || Boolean(state.error),
			10_000,
			"packaged Session claim",
		);
		if (state.error || !state.fencingToken)
			throw state.error ?? new Error("Packaged Session did not issue a fence");

		const commandId = "pack-smoke-non-empty-prompt";
		const settledBefore = state.settled;
		socket.send(
			JSON.stringify({
				type: "command",
				sessionHandle: runtime.sessionHandle,
				expectedGeneration: state.generation,
				fencingToken: state.fencingToken,
				command: {
					id: commandId,
					type: "prompt",
					message: "installed-product smoke prompt",
					streamingBehavior: "steer",
				},
			}),
		);
		await waitUntil(
			() => responses.has(commandId) || Boolean(state.error),
			10_000,
			"non-empty prompt response",
		);
		if (state.error) throw state.error;
		const response = responses.get(commandId);
		if (response?.success !== true) throw new Error(`Non-empty prompt failed: ${String(response?.error)}`);
		await waitUntil(
			() => (state.streamed && state.settled > settledBefore) || Boolean(state.error),
			10_000,
			"non-empty streamed and settled reply",
		);
		if (state.error) throw state.error;
	} finally {
		socket.off("message", onMessage);
		await closeSocket(socket);
	}
}

function assertPublicRegistryLock(bundleRoot) {
	const lockfile = JSON.parse(fs.readFileSync(path.join(bundleRoot, "package-lock.json"), "utf8"));
	for (const entry of Object.values(lockfile.packages ?? {})) {
		if (!entry || typeof entry !== "object" || typeof entry.resolved !== "string") continue;
		if (entry.resolved.startsWith("http") && !entry.resolved.startsWith("https://registry.npmjs.org/")) {
			throw new Error(`Installed bundle lockfile points at a non-public registry: ${entry.resolved}`);
		}
	}
}

async function terminatePackagedProcess(child, fixturePids = []) {
	let stopped = false;
	try {
		await terminateChildWithin(child, 2_000, { processGroup: true });
		if (fixturePids.length > 0) await waitForProcessesToExit(fixturePids, 2_000);
		stopped = true;
	} finally {
		if (!stopped) {
			await closeChild(child, 2_000, { processGroup: true });
			if (fixturePids.length > 0) await waitForProcessesToExit(fixturePids, 2_000);
		}
	}
}

async function runBundledRuntimeSmoke({ bundleRoot, expectedPiVersion, tempRoot }) {
	const emptyBinDir = path.join(tempRoot, "bundled-empty-bin");
	const workspacePath = path.join(tempRoot, "bundled-external-workspace");
	fs.mkdirSync(emptyBinDir);
	fs.mkdirSync(workspacePath);
	const env = {
		...controlledNpxEnvironment({ emptyBinDir }),
		PI_CODING_AGENT_DIR: path.join(tempRoot, "bundled-agent"),
		PI_CODING_AGENT_SESSION_DIR: path.join(tempRoot, "bundled-sessions"),
		PI_WEB_DATA_DIR: path.join(tempRoot, "bundled-web-data"),
	};
	delete env.PI_PATH;
	const child = launchInstalledCli({
		installDir: bundleRoot,
		args: ["--host", "127.0.0.1", "--port", "0", "--no-open"],
		cwd: workspacePath,
		detached: process.platform !== "win32",
		env,
	});
	try {
		await verifyBundledReadiness({ bundleRoot, child, expectedPiVersion, workspacePath });
	} finally {
		await terminatePackagedProcess(child);
	}
}

async function runDeterministicConversationSmoke({ bundleRoot, expectedPiVersion, tempRoot }) {
	const emptyBinDir = path.join(tempRoot, "deterministic-empty-bin");
	const workspacePath = path.join(tempRoot, "deterministic-external-workspace");
	const fixturePath = path.join(tempRoot, "deterministic-pi.mjs");
	const lifecycleMarker = path.join(tempRoot, "deterministic-pi-lifecycle.log");
	fs.mkdirSync(emptyBinDir);
	fs.mkdirSync(workspacePath);
	fs.copyFileSync(
		path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"../packages/server/test/fixtures/session-runtime-pi.mjs",
		),
		fixturePath,
		fs.constants.COPYFILE_EXCL,
	);
	fs.chmodSync(fixturePath, 0o644);
	const env = {
		...controlledNpxEnvironment({ emptyBinDir }),
		PI_CODING_AGENT_DIR: path.join(tempRoot, "deterministic-agent"),
		PI_CODING_AGENT_SESSION_DIR: path.join(tempRoot, "deterministic-sessions"),
		PI_WEB_DATA_DIR: path.join(tempRoot, "deterministic-web-data"),
		PI_WEB_FIXTURE_LIFECYCLE_MARKER: lifecycleMarker,
	};
	delete env.PI_PATH;
	const child = launchInstalledCli({
		installDir: bundleRoot,
		args: ["--pi-path", fixturePath, "--host", "127.0.0.1", "--port", "0", "--no-open"],
		cwd: workspacePath,
		detached: process.platform !== "win32",
		env,
	});
	let processIds = [];
	try {
		const match = await waitForOutput(child, /listening on http:\/\/127\.0\.0\.1:(\d+)/);
		const origin = `http://127.0.0.1:${match[1]}`;
		const { cookie, headers } = await bootstrap(origin);
		const response = await fetch(`${origin}/api/v1/health/ready`, { headers });
		if (!response.ok) throw new Error(`Explicit Pi health check failed with ${String(response.status)}`);
		const readiness = await response.json();
		if (
			readiness?.ready !== true ||
			readiness?.runtime?.source !== "pi-path" ||
			readiness?.runtime?.version !== expectedPiVersion ||
			readiness?.runtime?.adapterId !== "pi-rpc"
		) {
			throw new Error(
				`Packaged Gateway did not use the explicit deterministic Pi runtime: ${JSON.stringify(readiness)}`,
			);
		}
		const runtime = await createWorkspaceAndSession({ headers, origin, workspacePath });
		const protocol = await installedProtocol(bundleRoot);
		const WebSocket = installedWebSocket(bundleRoot);
		await runNonEmptyConversation({ WebSocket, cookie, origin, protocol, runtime });
		processIds = fixtureProcessIds(lifecycleMarker);
		if (processIds.length === 0) throw new Error("Explicit deterministic Pi did not record a child process");
	} finally {
		await terminatePackagedProcess(child, processIds);
	}
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-pack-smoke-"));

try {
	const bundleOutput = path.join(tempRoot, "bundle-output");
	const bundle = createReleaseBundle({ mode: "candidate", outputDir: bundleOutput });
	const archive = fs.readFileSync(bundle.archivePath);
	const entries = inspectDeterministicTarGz(archive, { rootName: bundle.manifest.bundle.name });
	if (entries.some((entry) => entry.path.includes("..")))
		throw new Error("Bundle archive contains a traversal entry");
	const bundleRoot = extractBundleArchive({
		archivePath: bundle.archivePath,
		destinationDir: path.join(tempRoot, "extracted"),
		bundleName: bundle.manifest.bundle.name,
	});
	assertPublicRegistryLock(bundleRoot);
	installBundle({ bundleRoot });
	assertInstalledProductIsolation({ installDir: bundleRoot });
	run("npx", ["--no-install", "pi-web", "--help"], { cwd: bundleRoot });
	await runBundledRuntimeSmoke({
		bundleRoot,
		expectedPiVersion: bundle.manifest.runtime.piVersion,
		tempRoot,
	});
	await runDeterministicConversationSmoke({
		bundleRoot,
		expectedPiVersion: bundle.manifest.runtime.piVersion,
		tempRoot,
	});
	console.log("PACK SMOKE OK");
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
