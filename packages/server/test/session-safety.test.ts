import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSessionDirForCwd } from "../src/config.js";
import { type ServerHandle, startServer } from "../src/main.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-session-safety-"));
const workspacePath = path.join(tempRoot, "a-b");
const collidingWorkspacePath = path.join(tempRoot, "a", "b");
const agentDir = path.join(tempRoot, "agent");
const sessionRootDir = path.join(tempRoot, "sessions");
const webDataDir = path.join(tempRoot, "web-data");
const fakePiPath = path.join(import.meta.dirname, "fixtures", "fake-pi.mjs");
const viteOrigin = "http://localhost:5173";

let handle: ServerHandle;
let base: string;
let cookie: string;
let workspaceId: string;
let workspaceRealpath: string;
let sessionDir: string;

function authenticatedHeaders(): Record<string, string> {
	return { Origin: viteOrigin, Cookie: cookie };
}

function writeSession(
	fileName: string,
	options: { id: string; cwd: string; parentSession?: string },
): string {
	const filePath = path.join(sessionDir, fileName);
	const header = {
		type: "session",
		version: 3,
		id: options.id,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: options.cwd,
		...(options.parentSession ? { parentSession: options.parentSession } : {}),
	};
	fs.writeFileSync(filePath, `${JSON.stringify(header)}\n`, "utf8");
	return filePath;
}

function nextFile(label: string): string {
	return `2026-01-01T00-00-00-000Z_${label}-${crypto.randomUUID()}.jsonl`;
}

async function waitForMicrotasks(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeAll(async () => {
	fs.mkdirSync(workspacePath, { recursive: true });
	fs.mkdirSync(collidingWorkspacePath, { recursive: true });

	handle = await startServer({
		config: { port: 0, host: "127.0.0.1", agentDir, sessionRootDir, webDataDir },
		piPath: fakePiPath,
	});
	await new Promise<void>((resolve, reject) => {
		handle.server.once("listening", resolve);
		handle.server.once("error", reject);
	});
	const address = handle.server.address();
	if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
	base = `http://127.0.0.1:${String(address.port)}`;

	const bootstrap = await fetch(`${base}/api/v1/bootstrap`, { headers: { Origin: viteOrigin } });
	const setCookie = bootstrap.headers.get("set-cookie");
	if (!setCookie) throw new Error("bootstrap did not set a session cookie");
	cookie = setCookie.split(";", 1)[0] ?? "";

	const workspace = handle.registry.add(workspacePath);
	workspaceId = workspace.id;
	const record = handle.registry.get(workspaceId);
	if (!record) throw new Error("workspace registration was not retained");
	workspaceRealpath = record.cwdRealpath;
	sessionDir = getSessionDirForCwd(workspaceRealpath, sessionRootDir);
	fs.mkdirSync(sessionDir, { recursive: true });
	handle.supervisor.registerWorkspace(workspaceId, workspaceRealpath);
});

afterAll(async () => {
	await handle?.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("session file identity and transition safety", () => {
	it("uses a workspace realpath as the stable registry identity", () => {
		const aliasPath = path.join(tempRoot, "workspace-alias");
		fs.symlinkSync(workspacePath, aliasPath);
		const aliasedWorkspace = handle.registry.add(aliasPath);
		expect(aliasedWorkspace.id).toBe(workspaceId);
		expect(handle.registry.get(workspaceId)?.cwdRealpath).toBe(workspaceRealpath);
	});

	it("refuses to delete the active file even when the Header UUID differs from its filename", async () => {
		const fileName = nextFile("active");
		const activePath = writeSession(fileName, { id: "header-uuid-not-the-filename", cwd: workspaceRealpath });
		await handle.supervisor.sendCommand(workspaceId, workspaceRealpath, {
			type: "switch_session",
			sessionPath: activePath,
		});

		expect(handle.supervisor.getStatus(workspaceId)?.sessionFile).toBe(activePath);
		const response = await fetch(`${base}/api/v1/workspaces/${workspaceId}/sessions/${fileName}`, {
			method: "DELETE",
			headers: authenticatedHeaders(),
		});
		expect(response.status).toBe(409);
		expect(fs.existsSync(activePath)).toBe(true);
	});

	it("refuses to delete a parent session while a same-workspace child remains", async () => {
		const parentPath = writeSession(nextFile("parent"), { id: "parent-header", cwd: workspaceRealpath });
		const childPath = writeSession(nextFile("child"), {
			id: "child-header",
			cwd: workspaceRealpath,
			parentSession: parentPath,
		});
		const response = await fetch(
			`${base}/api/v1/workspaces/${workspaceId}/sessions/${path.basename(parentPath)}`,
			{
				method: "DELETE",
				headers: authenticatedHeaders(),
			},
		);
		expect(response.status).toBe(409);
		expect(fs.existsSync(parentPath)).toBe(true);
		expect(fs.existsSync(childPath)).toBe(true);
	});

	it("filters encoded-directory collisions by Header cwd and refuses a foreign switch", async () => {
		const foreignRealpath = fs.realpathSync(collidingWorkspacePath);
		expect(getSessionDirForCwd(foreignRealpath, sessionRootDir)).toBe(sessionDir);
		const foreignPath = writeSession(nextFile("foreign"), { id: "foreign-header", cwd: foreignRealpath });

		const sessionsResponse = await fetch(`${base}/api/v1/workspaces/${workspaceId}/sessions`, {
			headers: authenticatedHeaders(),
		});
		const body = (await sessionsResponse.json()) as { sessions: Array<{ absolutePath: string }> };
		expect(body.sessions.some((session) => session.absolutePath === foreignPath)).toBe(false);

		await expect(
			handle.supervisor.sendCommand(workspaceId, workspaceRealpath, {
				type: "switch_session",
				sessionPath: foreignPath,
			}),
		).rejects.toThrow("Session header does not belong to this workspace");
	});

	it("serializes a pending switch ahead of deletion so the newly active file survives", async () => {
		const fileName = nextFile("queued-active");
		const queuedPath = writeSession(fileName, { id: "queued-header", cwd: workspaceRealpath });
		let release: (() => void) | undefined;
		const heldTransition = handle.supervisor.withSessionTransition(
			workspaceId,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await waitForMicrotasks();

		const switchPromise = handle.supervisor.sendCommand(workspaceId, workspaceRealpath, {
			type: "switch_session",
			sessionPath: queuedPath,
		});
		await waitForMicrotasks();
		const deletePromise = fetch(`${base}/api/v1/workspaces/${workspaceId}/sessions/${fileName}`, {
			method: "DELETE",
			headers: authenticatedHeaders(),
		});
		await waitForMicrotasks();

		release?.();
		await heldTransition;
		await expect(switchPromise).resolves.toMatchObject({ success: true, command: "switch_session" });
		expect((await deletePromise).status).toBe(409);
		expect(fs.existsSync(queuedPath)).toBe(true);
	});
});
