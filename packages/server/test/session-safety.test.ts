import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LegacyServerHandle, startServerWithCurrentMode } from "../src/main.js";
import { sessionHandleForFile } from "../src/native-session-catalog.js";
import { workspaceHandleForPath } from "../src/session-layout-resolver.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-session-safety-"));
const workspacePath = path.join(tempRoot, "workspace");
const otherWorkspacePath = path.join(tempRoot, "other-workspace");
const agentDir = path.join(tempRoot, "agent");
const sessionRootDir = path.join(tempRoot, "sessions");
const webDataDir = path.join(tempRoot, "web-data");
const fakePiPath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");

let handle: LegacyServerHandle;
let base: string;
let cookie: string;
let workspaceHandle: string;
let workspaceRealpath: string;

function authenticatedHeaders(): Record<string, string> {
	return { Origin: base, Cookie: cookie };
}

async function controlledDelete(sessionHandle: string): Promise<{
	connectionId: string;
	fencingToken: string;
	generation: number;
	headers: Record<string, string>;
}> {
	const connectionId = `delete-${crypto.randomUUID()}`;
	const lease = await handle.supervisor.claim(sessionHandle, connectionId);
	const runtime = handle.supervisor.getRuntime(sessionHandle);
	if (!lease.fencingToken || !runtime) throw new Error("unable to claim Session deletion control");
	return {
		connectionId,
		fencingToken: lease.fencingToken,
		generation: runtime.generation,
		headers: {
			...authenticatedHeaders(),
			"X-Pi-Session-Generation": String(runtime.generation),
			"X-Pi-Fencing-Token": lease.fencingToken,
		},
	};
}

function writeSession(
	fileName: string,
	options: { id: string; cwd: string; parentSession?: string },
): string {
	fs.mkdirSync(sessionRootDir, { recursive: true });
	const filePath = path.join(sessionRootDir, fileName);
	const timestamp = "2026-01-01T00:00:00.000Z";
	const lines = [
		{
			type: "session",
			version: 3,
			id: options.id,
			timestamp,
			cwd: options.cwd,
			...(options.parentSession ? { parentSession: options.parentSession } : {}),
		},
		{
			type: "message",
			id: `${options.id}-message`,
			parentId: null,
			timestamp,
			message: { role: "user", content: `question ${options.id}`, timestamp: Date.parse(timestamp) },
		},
	];
	fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	return fs.realpathSync(filePath);
}

function nextFile(label: string): string {
	return `2026-01-01T00-00-00-000Z_${label}-${crypto.randomUUID()}.jsonl`;
}

beforeAll(async () => {
	fs.mkdirSync(workspacePath, { recursive: true });
	fs.mkdirSync(otherWorkspacePath, { recursive: true });
	workspaceRealpath = fs.realpathSync(workspacePath);
	handle = await startServerWithCurrentMode({
		config: { port: 0, host: "127.0.0.1", agentDir, sessionRootDir, webDataDir },
		piPath: fakePiPath,
		handleSignals: false,
	});
	const address = handle.server.address();
	if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
	base = `http://127.0.0.1:${String(address.port)}`;

	const bootstrap = await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: base } });
	const setCookie = bootstrap.headers.get("set-cookie");
	if (!setCookie) throw new Error("bootstrap did not set a session cookie");
	cookie = setCookie.split(";", 1)[0] ?? "";

	const workspace = await fetch(`${base}/api/v1/workspaces`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authenticatedHeaders() },
		body: JSON.stringify({ path: workspacePath }),
	});
	workspaceHandle = ((await workspace.json()) as { workspaceHandle: string }).workspaceHandle;
});

afterAll(async () => {
	await handle?.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("native Session identity and deletion safety", () => {
	it("derives one Workspace identity from the canonical cwd", async () => {
		const aliasPath = path.join(tempRoot, "workspace-alias");
		fs.symlinkSync(workspacePath, aliasPath);
		const response = await fetch(`${base}/api/v1/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authenticatedHeaders() },
			body: JSON.stringify({ path: aliasPath }),
		});
		const alias = (await response.json()) as { workspaceHandle: string; path: string };
		expect(alias.workspaceHandle).toBe(workspaceHandle);
		expect(alias.path).toBe(workspaceRealpath);
		expect(workspaceHandle).toBe(workspaceHandleForPath(workspaceRealpath));
	});

	it("force-refreshes native storage and resolves only the canonical file handle", async () => {
		await handle.catalog.refresh({ force: true });
		const sessionFile = writeSession(nextFile("late"), { id: "late-native", cwd: workspaceRealpath });
		const sessionHandle = sessionHandleForFile(sessionFile);

		await expect(handle.supervisor.activate(sessionHandle)).resolves.toMatchObject({
			sessionHandle,
			workspaceId: workspaceHandle,
			sessionFile,
		});
		await expect(handle.supervisor.activate("session_forged")).rejects.toThrow("unknown_session");
		await handle.supervisor.stop(sessionHandle);
	});

	it("refuses a busy Session and later moves that exact controlled file to recoverable trash", async () => {
		const sessionFile = writeSession(nextFile("active"), {
			id: "header-id-not-used-as-file-identity",
			cwd: workspaceRealpath,
		});
		const sessionHandle = sessionHandleForFile(sessionFile);
		await handle.supervisor.activate(sessionHandle);
		const control = await controlledDelete(sessionHandle);
		await handle.supervisor.sendCommand(
			sessionHandle,
			{ id: "busy-delete", type: "prompt", message: "slow", streamingBehavior: "steer" },
			{
				connectionId: control.connectionId,
				expectedGeneration: control.generation,
				fencingToken: control.fencingToken,
			},
		);

		const active = await fetch(`${base}/api/v1/workspaces/${workspaceHandle}/sessions/${sessionHandle}`, {
			method: "DELETE",
			headers: control.headers,
		});
		expect(active.status).toBe(409);
		expect((await active.json()) as unknown).toMatchObject({ error: { code: "session_busy" } });
		expect(fs.existsSync(sessionFile)).toBe(true);

		await new Promise<void>((resolve) => setTimeout(resolve, 350));
		const deleted = await fetch(`${base}/api/v1/workspaces/${workspaceHandle}/sessions/${sessionHandle}`, {
			method: "DELETE",
			headers: control.headers,
		});
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toEqual({ ok: true, recoverable: true });
		expect(fs.existsSync(sessionFile)).toBe(false);
		const entries = fs.readdirSync(handle.trash.rootDirectory);
		const matchingMetadata = entries
			.map((entry) => path.join(handle.trash.rootDirectory, entry, "metadata.json"))
			.map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>)
			.find((metadata) => metadata.sessionHandle === sessionHandle);
		expect(matchingMetadata).toMatchObject({
			originalSessionFile: sessionFile,
			workspaceHandle,
			nativeSessionId: "header-id-not-used-as-file-identity",
		});
	});

	it("protects parent lineage and exact Workspace ownership", async () => {
		const parentFile = writeSession(nextFile("parent"), { id: "parent", cwd: workspaceRealpath });
		const childFile = writeSession(nextFile("child"), {
			id: "child",
			cwd: workspaceRealpath,
			parentSession: parentFile,
		});
		const foreignFile = writeSession(nextFile("foreign"), {
			id: "parent",
			cwd: fs.realpathSync(otherWorkspacePath),
		});
		const parentHandle = sessionHandleForFile(parentFile);
		const foreignHandle = sessionHandleForFile(foreignFile);
		const parentControl = await controlledDelete(parentHandle);

		const parent = await fetch(`${base}/api/v1/workspaces/${workspaceHandle}/sessions/${parentHandle}`, {
			method: "DELETE",
			headers: parentControl.headers,
		});
		expect(parent.status).toBe(409);
		expect((await parent.json()) as unknown).toMatchObject({
			error: { code: "session_has_children" },
		});
		expect(fs.existsSync(parentFile)).toBe(true);
		expect(fs.existsSync(childFile)).toBe(true);

		const crossWorkspace = await fetch(
			`${base}/api/v1/workspaces/${workspaceHandle}/sessions/${foreignHandle}`,
			{ method: "DELETE", headers: authenticatedHeaders() },
		);
		expect(crossWorkspace.status).toBe(404);
		expect(fs.existsSync(foreignFile)).toBe(true);
	});
});
