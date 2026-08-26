import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RpcError } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyRpcV1Adapter } from "../src/legacy-rpc-v1.js";
import {
	createNativeRoutes,
	type NativeRouteSupervisor,
	type RecoverableTrashTarget,
} from "../src/native-routes.js";
import {
	canonicalizeSessionFile,
	NativeSessionCatalog,
	sessionHandleForFile,
} from "../src/native-session-catalog.js";
import { SessionLayoutResolver, workspaceHandleForPath } from "../src/session-layout-resolver.js";
import type { SessionRuntimeSnapshot } from "../src/session-runtime-types.js";
import {
	type CreateSessionRequest,
	type SessionManagementContext,
	SessionSupervisor,
} from "../src/session-supervisor.js";
import { WorkspacePreferences } from "../src/workspace-preferences.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");
const temporaryRoots: string[] = [];
const preferencesToClose: WorkspacePreferences[] = [];
const supervisorsToClose: SessionSupervisor[] = [];

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-native-routes-"));
	temporaryRoots.push(root);
	return root;
}

function createResolver(root: string, env: Record<string, string | undefined> = {}): SessionLayoutResolver {
	return new SessionLayoutResolver({
		agentDir: path.join(root, "agent"),
		env,
		runtimeCwd: root,
		settingsProbeCwd: root,
	});
}

function createPreferences(root: string): WorkspacePreferences {
	const preferences = new WorkspacePreferences(path.join(root, "web-data"));
	preferencesToClose.push(preferences);
	return preferences;
}

function writeSession(
	directory: string,
	fileName: string,
	options: { id: string; cwd: string; parentSessionPath?: string; message?: string },
): string {
	fs.mkdirSync(directory, { recursive: true });
	const timestamp = "2026-08-20T00:00:00.000Z";
	const lines: unknown[] = [
		{
			type: "session",
			version: 3,
			id: options.id,
			timestamp,
			cwd: options.cwd,
			...(options.parentSessionPath ? { parentSession: options.parentSessionPath } : {}),
		},
		{
			type: "message",
			id: `${options.id}-message`,
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: options.message ?? `question ${options.id}`,
				timestamp: Date.parse(timestamp),
			},
		},
	];
	const sessionFile = path.join(directory, fileName);
	fs.writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return sessionFile;
}

class FakeSupervisor implements NativeRouteSupervisor {
	readonly serverEpoch = "native-routes-test-epoch";
	readonly runtimes = new Map<string, SessionRuntimeSnapshot>();
	readonly active = new Set<string>();
	readonly createRequests: CreateSessionRequest[] = [];
	readonly abandonRequests: Array<{
		workspaceId: string;
		sessionHandle: string;
		context: SessionManagementContext;
	}> = [];

	listRuntimes(): SessionRuntimeSnapshot[] {
		return [...this.runtimes.values()];
	}

	getRuntime(sessionHandle: string): SessionRuntimeSnapshot | undefined {
		return this.runtimes.get(sessionHandle);
	}

	async createSession(request: CreateSessionRequest): Promise<SessionRuntimeSnapshot> {
		this.createRequests.push(request);
		const nativeSessionId = `new-${String(this.createRequests.length)}`;
		const sessionFile = canonicalizeSessionFile(path.join(request.sessionDir, `${nativeSessionId}.jsonl`));
		const runtime: SessionRuntimeSnapshot = {
			serverEpoch: this.serverEpoch,
			sessionHandle: sessionHandleForFile(sessionFile),
			workspaceId: request.workspaceId,
			nativeSessionId,
			sessionFile,
			cwd: request.cwd,
			generation: 1,
			lastSeq: 0,
			state: "idle",
			lastActivityAt: Date.parse("2026-08-20T00:00:00.000Z") + this.createRequests.length,
			recoverable: false,
		};
		this.runtimes.set(runtime.sessionHandle, runtime);
		this.active.add(runtime.sessionHandle);
		return runtime;
	}

	async withControlledSessionDeletion<T>(
		_workspaceId: string,
		sessionHandle: string,
		context: SessionManagementContext,
		operation: () => Promise<T>,
	): Promise<T> {
		if (context.expectedGeneration !== 1 || context.fencingToken !== "test-fencing-token") {
			throw new Error("session_read_only");
		}
		if (this.active.has(sessionHandle)) throw new Error("session_active");
		return operation();
	}

	async abandonTransient(
		workspaceId: string,
		sessionHandle: string,
		context: SessionManagementContext,
	): Promise<void> {
		this.abandonRequests.push({ workspaceId, sessionHandle, context });
		if (context.expectedGeneration !== 1) throw new Error("session_generation_stale");
		if (context.fencingToken !== "test-fencing-token") throw new Error("session_read_only");
		const runtime = this.runtimes.get(sessionHandle);
		if (!runtime || runtime.workspaceId !== workspaceId) throw new Error("session_control_required");
		this.runtimes.delete(sessionHandle);
		this.active.delete(sessionHandle);
	}
}

const controlledDeleteHeaders = {
	"X-Pi-Session-Generation": "1",
	"X-Pi-Fencing-Token": "test-fencing-token",
};

function createHarness(options: {
	root: string;
	resolver?: SessionLayoutResolver;
	preferences?: WorkspacePreferences;
	supervisor?: NativeRouteSupervisor;
	trashSession?: (target: RecoverableTrashTarget) => Promise<void>;
	cacheTtlMs?: number;
}) {
	const resolver = options.resolver ?? createResolver(options.root);
	const preferences = options.preferences ?? createPreferences(options.root);
	const supervisor = options.supervisor ?? new FakeSupervisor();
	const catalog = new NativeSessionCatalog({
		layoutResolver: resolver,
		preferences,
		cacheTtlMs: options.cacheTtlMs ?? 0,
	});
	const trashSession = options.trashSession ?? vi.fn(async () => undefined);
	return {
		app: createNativeRoutes({
			catalog,
			layoutResolver: resolver,
			preferences,
			supervisor,
			trashSession,
			now: () => Date.parse("2026-08-20T12:00:00.000Z"),
		}),
		catalog,
		preferences,
		resolver,
		supervisor,
		trashSession,
	};
}

async function json(response: Response): Promise<Record<string, any>> {
	return (await response.json()) as Record<string, any>;
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition did not settle before timeout");
}

afterEach(async () => {
	await Promise.all(supervisorsToClose.splice(0).map((supervisor) => supervisor.stopAll()));
	for (const preferences of preferencesToClose.splice(0)) preferences.close();
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("native REST routes", () => {
	it("force-refreshes Session metadata after Pi appends to a cached native JSONL file", async () => {
		const root = temporaryRoot();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const sessionFile = writeSession(resolver.defaultSessionDirForWorkspace(workspace), "native.jsonl", {
			id: "native",
			cwd: workspace,
			message: "first prompt",
		});
		const workspaceHandle = workspaceHandleForPath(workspace);
		const { app } = createHarness({ root, resolver, cacheTtlMs: 60_000 });
		const endpoint = `/workspaces/${workspaceHandle}/sessions`;

		const initial = await json(await app.request(endpoint));
		expect(initial.sessions[0]).toMatchObject({ messageCount: 1, firstMessage: "first prompt" });

		fs.appendFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				id: "native-assistant",
				parentId: "native-message",
				timestamp: "2026-08-20T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "completed" }],
					timestamp: Date.parse("2026-08-20T00:00:01.000Z"),
				},
			})}\n`,
		);

		const cached = await json(await app.request(endpoint));
		expect(cached.sessions[0].messageCount).toBe(1);
		const refreshed = await json(await app.request(`${endpoint}?refresh=1`));
		expect(refreshed.sessions[0]).toMatchObject({ messageCount: 2, firstMessage: "first prompt" });
	});

	it("merges default and custom native storage with preference-only workspaces", async () => {
		const root = temporaryRoot();
		const resolver = createResolver(root);
		const preferences = createPreferences(root);
		const defaultWorkspace = path.join(root, "default-workspace");
		const customWorkspace = path.join(root, "custom-workspace");
		const emptyWorkspace = path.join(root, "empty-workspace");
		const customSessionDir = path.join(root, "custom-sessions");
		fs.mkdirSync(defaultWorkspace);
		fs.mkdirSync(path.join(customWorkspace, ".pi"), { recursive: true });
		fs.mkdirSync(emptyWorkspace);
		fs.writeFileSync(
			path.join(customWorkspace, ".pi", "settings.json"),
			JSON.stringify({ sessionDir: customSessionDir }),
		);
		writeSession(resolver.defaultSessionDirForWorkspace(defaultWorkspace), "default.jsonl", {
			id: "default-native",
			cwd: defaultWorkspace,
		});
		writeSession(customSessionDir, "custom.jsonl", {
			id: "custom-native",
			cwd: customWorkspace,
		});
		preferences.upsert({
			pathHint: defaultWorkspace,
			pinned: true,
			displayName: "Pinned native",
			lastOpenedAt: 20,
		});
		preferences.upsert({ pathHint: customWorkspace, lastOpenedAt: 10 });
		preferences.upsert({ pathHint: emptyWorkspace, displayName: "Empty", lastOpenedAt: 5 });
		const { app } = createHarness({ root, resolver, preferences });

		const response = await app.request("/workspaces");
		const body = (await response.json()) as Array<Record<string, unknown>>;

		expect(response.status).toBe(200);
		expect(body).toHaveLength(3);
		expect(body[0]).toMatchObject({
			workspaceHandle: workspaceHandleForPath(defaultWorkspace),
			pinned: true,
			displayName: "Pinned native",
			sessionCount: 1,
			hasNativeHistory: true,
			available: true,
		});
		expect(body).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					workspaceHandle: workspaceHandleForPath(customWorkspace),
					sessionCount: 1,
					hasNativeHistory: true,
				}),
				expect.objectContaining({
					workspaceHandle: workspaceHandleForPath(emptyWorkspace),
					sessionCount: 0,
					hasNativeHistory: false,
				}),
			]),
		);
	});

	it("validates a real readable path and force-refreshes project session storage", async () => {
		const root = temporaryRoot();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		const linkedWorkspace = path.join(root, "workspace-link");
		const customSessionDir = path.join(root, "project-sessions");
		fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
		fs.symlinkSync(workspace, linkedWorkspace, "dir");
		fs.writeFileSync(
			path.join(workspace, ".pi", "settings.json"),
			JSON.stringify({ sessionDir: customSessionDir }),
		);
		writeSession(customSessionDir, "native.jsonl", { id: "native", cwd: workspace });
		const notDirectory = path.join(root, "file.txt");
		fs.writeFileSync(notDirectory, "file");
		const { app, preferences } = createHarness({ root, resolver });

		expect(
			(
				await app.request("/workspaces", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: "relative" }),
				})
			).status,
		).toBe(422);
		expect(
			(
				await app.request("/workspaces", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: notDirectory }),
				})
			).status,
		).toBe(422);

		const response = await app.request("/workspaces", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: linkedWorkspace, pinned: true, displayName: "Project" }),
		});
		const body = await json(response);

		expect(response.status).toBe(201);
		expect(body).toMatchObject({
			workspaceHandle: workspaceHandleForPath(workspace),
			path: fs.realpathSync(workspace),
			pinned: true,
			displayName: "Project",
			sessionCount: 1,
		});
		expect(preferences.get(body.workspaceHandle)).toMatchObject({
			pathHint: fs.realpathSync(workspace),
			lastOpenedAt: Date.parse("2026-08-20T12:00:00.000Z"),
		});
	});

	it("persists last-opened Workspace only for an explicit activation, not a Session list read", async () => {
		const root = temporaryRoot();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		writeSession(resolver.defaultSessionDirForWorkspace(workspace), "native.jsonl", {
			id: "native",
			cwd: workspace,
		});
		const preferences = createPreferences(root);
		const existing = preferences.upsert({ pathHint: workspace, lastOpenedAt: 1 });
		const { app } = createHarness({ root, resolver, preferences });

		const listed = await app.request(`/workspaces/${existing.workspaceHandle}/sessions`);
		expect(listed.status).toBe(200);
		expect(preferences.get(existing.workspaceHandle)?.lastOpenedAt).toBe(1);

		const activated = await app.request(`/workspaces/${existing.workspaceHandle}/activate`, {
			method: "POST",
		});
		expect(activated.status).toBe(200);
		expect(await json(activated)).toMatchObject({
			workspaceHandle: existing.workspaceHandle,
			path: fs.realpathSync(workspace),
			lastOpenedAt: Date.parse("2026-08-20T12:00:00.000Z"),
		});
		expect(preferences.get(existing.workspaceHandle)?.lastOpenedAt).toBe(
			Date.parse("2026-08-20T12:00:00.000Z"),
		);
	});

	it("removes only workspace preferences while retaining native Pi history", async () => {
		const root = temporaryRoot();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const sessionFile = writeSession(resolver.defaultSessionDirForWorkspace(workspace), "native.jsonl", {
			id: "native",
			cwd: workspace,
		});
		const preferences = createPreferences(root);
		const preference = preferences.upsert({ pathHint: workspace, pinned: true });
		const { app } = createHarness({ root, resolver, preferences });

		const response = await app.request(`/workspaces/${preference.workspaceHandle}`, {
			method: "DELETE",
		});
		expect(response.status).toBe(200);
		expect(await json(response)).toEqual({ ok: true, nativeHistoryRetained: true });
		expect(preferences.get(preference.workspaceHandle)).toBeUndefined();
		expect(fs.existsSync(sessionFile)).toBe(true);

		const listed = await (await app.request("/workspaces")).json();
		expect(listed).toEqual([
			expect.objectContaining({
				workspaceHandle: preference.workspaceHandle,
				pinned: false,
				sessionCount: 1,
				hasNativeHistory: true,
			}),
		]);
	});

	it("maps typed supervisor admission conflicts to stable HTTP 409 errors", async () => {
		const root = temporaryRoot();
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const preferences = createPreferences(root);
		const preference = preferences.upsert({ pathHint: workspace });
		const supervisor = new FakeSupervisor();
		vi.spyOn(supervisor, "createSession").mockRejectedValue(
			new RpcError("new_session", "workspace_session_deleting"),
		);
		const { app } = createHarness({ root, preferences, supervisor });

		const response = await app.request(`/workspaces/${preference.workspaceHandle}/sessions`, {
			method: "POST",
		});
		expect(response.status).toBe(409);
		expect((await json(response)).error.code).toBe("workspace_session_deleting");
	});

	it("filters exact workspace/session identities and trashes only an inactive canonical target", async () => {
		const root = temporaryRoot();
		const resolver = createResolver(root);
		const workspaceA = path.join(root, "workspace-a");
		const workspaceB = path.join(root, "workspace-b");
		fs.mkdirSync(workspaceA);
		fs.mkdirSync(workspaceB);
		const sessionFileA = writeSession(resolver.defaultSessionDirForWorkspace(workspaceA), "a.jsonl", {
			id: "duplicate-native-id",
			cwd: workspaceA,
		});
		const sessionFileB = writeSession(resolver.defaultSessionDirForWorkspace(workspaceB), "b.jsonl", {
			id: "duplicate-native-id",
			cwd: workspaceB,
		});
		const sessionHandleA = sessionHandleForFile(sessionFileA);
		const sessionHandleB = sessionHandleForFile(sessionFileB);
		const workspaceHandleA = workspaceHandleForPath(workspaceA);
		const workspaceHandleB = workspaceHandleForPath(workspaceB);
		const supervisor = new FakeSupervisor();
		const trashDir = path.join(root, "trash");
		fs.mkdirSync(trashDir);
		const trashSession = vi.fn(async (target: RecoverableTrashTarget) => {
			fs.renameSync(target.sessionFile, path.join(trashDir, path.basename(target.sessionFile)));
		});
		const { app } = createHarness({ root, resolver, supervisor, trashSession });

		const listA = await json(await app.request(`/workspaces/${workspaceHandleA}/sessions`));
		expect(listA.sessions).toHaveLength(1);
		expect(listA.sessions[0]).toMatchObject({
			sessionHandle: sessionHandleA,
			nativeSessionId: "duplicate-native-id",
		});

		const crossWorkspace = await app.request(`/workspaces/${workspaceHandleA}/sessions/${sessionHandleB}`, {
			method: "DELETE",
		});
		expect(crossWorkspace.status).toBe(404);
		expect(
			(
				await app.request(`/workspaces/${workspaceHandleB}/sessions/session_forged`, {
					method: "DELETE",
				})
			).status,
		).toBe(404);
		expect(trashSession).not.toHaveBeenCalled();
		const observerDelete = await app.request(`/workspaces/${workspaceHandleA}/sessions/${sessionHandleA}`, {
			method: "DELETE",
		});
		expect(observerDelete.status).toBe(409);
		expect((await json(observerDelete)).error.code).toBe("session_control_required");
		const staleControllerDelete = await app.request(
			`/workspaces/${workspaceHandleA}/sessions/${sessionHandleA}`,
			{
				method: "DELETE",
				headers: { ...controlledDeleteHeaders, "X-Pi-Fencing-Token": "stale-token" },
			},
		);
		expect(staleControllerDelete.status).toBe(409);
		expect((await json(staleControllerDelete)).error.code).toBe("session_read_only");

		supervisor.active.add(sessionHandleA);
		const active = await app.request(`/workspaces/${workspaceHandleA}/sessions/${sessionHandleA}`, {
			method: "DELETE",
			headers: controlledDeleteHeaders,
		});
		expect(active.status).toBe(409);
		expect((await json(active)).error.code).toBe("session_active");
		expect(trashSession).not.toHaveBeenCalled();

		supervisor.active.delete(sessionHandleA);
		const deleted = await app.request(`/workspaces/${workspaceHandleA}/sessions/${sessionHandleA}`, {
			method: "DELETE",
			headers: controlledDeleteHeaders,
		});
		expect(deleted.status).toBe(200);
		expect(await json(deleted)).toEqual({ ok: true, recoverable: true });
		expect(trashSession).toHaveBeenCalledWith({
			sessionHandle: sessionHandleA,
			workspaceHandle: workspaceHandleA,
			nativeSessionId: "duplicate-native-id",
			sessionFile: canonicalizeSessionFile(sessionFileA),
		});
		expect(fs.existsSync(sessionFileA)).toBe(false);
		expect(fs.existsSync(sessionFileB)).toBe(true);
	});

	it("creates independent runtimes without counting them as persisted Workspace history", async () => {
		const root = temporaryRoot();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const preferences = createPreferences(root);
		const preference = preferences.upsert({ pathHint: workspace });
		const catalog = new NativeSessionCatalog({ layoutResolver: resolver, preferences, cacheTtlMs: 0 });
		const supervisor = new SessionSupervisor({
			resolved: {
				command: process.execPath,
				args: [fixturePath],
				source: "pi-path",
				label: "native routes fixture",
				adapter: legacyRpcV1Adapter,
				version: "0.84.2",
				adapterId: "legacy-rpc-v1",
				compatibilityStatus: "current",
				capabilities: legacyRpcV1Adapter.capabilities,
			},
			resolveSession: async () => undefined,
			broadcast: () => undefined,
			readyTimeoutMs: 2_000,
			idleTtlMs: 60_000,
		});
		supervisorsToClose.push(supervisor);
		const app = createNativeRoutes({
			catalog,
			layoutResolver: resolver,
			preferences,
			supervisor,
			trashSession: async () => undefined,
		});

		const [firstResponse, secondResponse] = await Promise.all([
			app.request(`/workspaces/${preference.workspaceHandle}/sessions`, { method: "POST" }),
			app.request(`/workspaces/${preference.workspaceHandle}/sessions`, { method: "POST" }),
		]);
		const first = await json(firstResponse);
		const second = await json(secondResponse);

		expect(firstResponse.status).toBe(201);
		expect(secondResponse.status).toBe(201);
		expect(first.runtime.sessionHandle).not.toBe(second.runtime.sessionHandle);
		expect(first.layout).toEqual({
			sessionDir: resolver.defaultSessionDirForWorkspace(fs.realpathSync(workspace)),
			source: "default",
		});
		expect(supervisor.listRuntimes()).toHaveLength(2);
		expect(supervisor.listRuntimes().every((runtime) => runtime.state === "idle")).toBe(true);

		const listed = await json(await app.request(`/workspaces/${preference.workspaceHandle}/sessions`));
		expect(listed.sessions).toHaveLength(2);
		expect(listed.sessions.every((session: any) => session.persisted === false)).toBe(true);
		expect(listed.layout).toEqual({
			sessionDir: resolver.defaultSessionDirForWorkspace(fs.realpathSync(workspace)),
			source: "default",
		});
		const workspaces = (await (await app.request("/workspaces")).json()) as Array<Record<string, unknown>>;
		expect(workspaces).toEqual([
			expect.objectContaining({
				workspaceHandle: preference.workspaceHandle,
				displayName: path.basename(workspace),
				sessionCount: 0,
				hasNativeHistory: false,
			}),
		]);
	});

	it("abandons an unpersisted Session through exact management headers without touching native history", async () => {
		const root = temporaryRoot();
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const preferences = createPreferences(root);
		const preference = preferences.upsert({ pathHint: workspace });
		const supervisor = new FakeSupervisor();
		const { app, trashSession } = createHarness({ root, preferences, supervisor });
		const createdResponse = await app.request(`/workspaces/${preference.workspaceHandle}/sessions`, {
			method: "POST",
		});
		const created = await json(createdResponse);
		const endpoint = `/workspaces/${preference.workspaceHandle}/sessions/${created.runtime.sessionHandle}/transient`;

		const observer = await app.request(endpoint, { method: "DELETE" });
		expect(observer.status).toBe(409);
		expect((await json(observer)).error.code).toBe("session_control_required");
		expect(supervisor.abandonRequests).toEqual([]);

		const staleGeneration = await app.request(endpoint, {
			method: "DELETE",
			headers: { ...controlledDeleteHeaders, "X-Pi-Session-Generation": "2" },
		});
		expect(staleGeneration.status).toBe(409);
		expect((await json(staleGeneration)).error.code).toBe("session_generation_stale");

		const stale = await app.request(endpoint, {
			method: "DELETE",
			headers: { ...controlledDeleteHeaders, "X-Pi-Fencing-Token": "stale-token" },
		});
		expect(stale.status).toBe(409);
		expect((await json(stale)).error.code).toBe("session_read_only");

		const abandoned = await app.request(endpoint, {
			method: "DELETE",
			headers: controlledDeleteHeaders,
		});
		expect(abandoned.status).toBe(200);
		expect(await json(abandoned)).toEqual({ ok: true, abandoned: true });
		expect(supervisor.abandonRequests.at(-1)).toEqual({
			workspaceId: preference.workspaceHandle,
			sessionHandle: created.runtime.sessionHandle,
			context: { expectedGeneration: 1, fencingToken: "test-fencing-token" },
		});
		expect(supervisor.getRuntime(created.runtime.sessionHandle)).toBeUndefined();
		expect(trashSession).not.toHaveBeenCalled();
	});

	it("maps transient abandon lifecycle conflicts to stable HTTP 409 codes", async () => {
		const root = temporaryRoot();
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const preferences = createPreferences(root);
		const preference = preferences.upsert({ pathHint: workspace });
		const supervisor = new FakeSupervisor();
		const { app } = createHarness({ root, preferences, supervisor });
		const created = await json(
			await app.request(`/workspaces/${preference.workspaceHandle}/sessions`, { method: "POST" }),
		);
		vi.spyOn(supervisor, "abandonTransient").mockRejectedValue(
			new RpcError("abandon", "session_not_abandonable"),
		);

		const response = await app.request(
			`/workspaces/${preference.workspaceHandle}/sessions/${created.runtime.sessionHandle}/transient`,
			{ method: "DELETE", headers: controlledDeleteHeaders },
		);
		expect(response.status).toBe(409);
		expect((await json(response)).error.code).toBe("session_not_abandonable");
	});

	it("refuses to trash a fork child before its Workspace identity commit", async () => {
		const root = temporaryRoot();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const sessionDir = resolver.defaultSessionDirForWorkspace(workspace);
		writeSession(sessionDir, "parent.jsonl", { id: "route-transition-parent", cwd: workspace });
		const preferences = createPreferences(root);
		const preference = preferences.upsert({ pathHint: workspace });
		const catalog = new NativeSessionCatalog({ layoutResolver: resolver, preferences, cacheTtlMs: 0 });
		const supervisor = new SessionSupervisor({
			resolved: {
				command: process.execPath,
				args: [fixturePath],
				source: "pi-path",
				label: "native routes transition fixture",
				adapter: legacyRpcV1Adapter,
				version: "0.84.2",
				adapterId: "legacy-rpc-v1",
				compatibilityStatus: "current",
				capabilities: legacyRpcV1Adapter.capabilities,
			},
			env: { PI_WEB_FIXTURE_TRANSITION_STATE_DELAY_MS: "250" },
			resolveSession: async (sessionHandle) => {
				const session = (await catalog.refresh({ force: true })).sessions.find(
					(candidate) => candidate.sessionHandle === sessionHandle,
				);
				return session
					? {
							kind: "existing" as const,
							sessionHandle: session.sessionHandle,
							workspaceId: session.workspaceHandle,
							cwd: session.cwd,
							sessionFile: session.sessionFile,
							nativeSessionId: session.nativeSessionId,
						}
					: undefined;
			},
			broadcast: () => undefined,
			readyTimeoutMs: 2_000,
			idleTtlMs: 60_000,
		});
		supervisorsToClose.push(supervisor);
		const trashSession = vi.fn(async ({ sessionFile }: RecoverableTrashTarget) => {
			fs.rmSync(sessionFile);
		});
		const app = createNativeRoutes({
			catalog,
			layoutResolver: resolver,
			preferences,
			supervisor,
			trashSession,
		});
		const parent = (await catalog.refresh({ force: true })).sessions[0];
		if (!parent) throw new Error("parent Session was not discovered");
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		if (!lease.fencingToken) throw new Error("controller lease was not granted");
		const runtime = supervisor.getRuntime(parent.sessionHandle)!;
		const clone = supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "connection",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		let childFile = "";
		await eventually(() => {
			childFile =
				fs
					.readdirSync(sessionDir)
					.map((file) => path.join(sessionDir, file))
					.find((file) => file.includes("route-transition-parent-clone")) ?? "";
			return Boolean(childFile);
		});
		const childHandle = sessionHandleForFile(childFile);

		const deleted = await app.request(`/workspaces/${preference.workspaceHandle}/sessions/${childHandle}`, {
			method: "DELETE",
			headers: {
				"X-Pi-Session-Generation": String(runtime.generation),
				"X-Pi-Fencing-Token": lease.fencingToken,
			},
		});
		expect(deleted.status).toBe(409);
		expect((await json(deleted)).error.code).toBe("workspace_identity_transitioning");
		expect(trashSession).not.toHaveBeenCalled();
		expect(fs.existsSync(childFile)).toBe(true);

		const transitioned = await clone;
		expect(transitioned.sessionHandle).toBe(childHandle);
		expect(supervisor.getRuntime(childHandle)).toMatchObject({ recoverable: true, state: "idle" });
	});

	it("reports dormant process state without exposing an unfenced REST restart", async () => {
		const root = temporaryRoot();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const sessionFile = writeSession(resolver.defaultSessionDirForWorkspace(workspace), "session.jsonl", {
			id: "native",
			cwd: workspace,
		});
		const sessionHandle = sessionHandleForFile(sessionFile);
		const workspaceHandle = workspaceHandleForPath(workspace);
		const supervisor = new FakeSupervisor();
		const { app } = createHarness({ root, resolver, supervisor });

		const dormant = await app.request(`/workspaces/${workspaceHandle}/sessions/${sessionHandle}/process`);
		expect(dormant.status).toBe(200);
		expect(await json(dormant)).toMatchObject({
			serverEpoch: supervisor.serverEpoch,
			sessionHandle,
			workspaceId: workspaceHandle,
			state: "dormant",
			generation: 0,
			recoverable: true,
		});

		const restart = await app.request(
			`/workspaces/${workspaceHandle}/sessions/${sessionHandle}/process/restart`,
			{ method: "POST" },
		);
		expect(restart.status).toBe(404);
	});

	it("safely searches workspace files excluding git, node_modules, dist, and .pi", async () => {
		const root = temporaryRoot();
		const workspace = path.join(root, "my-workspace");
		fs.mkdirSync(workspace);
		fs.mkdirSync(path.join(workspace, "src", "components"), { recursive: true });
		fs.mkdirSync(path.join(workspace, ".git", "objects"), { recursive: true });
		fs.mkdirSync(path.join(workspace, "node_modules", "lib"), { recursive: true });
		fs.mkdirSync(path.join(workspace, "dist"), { recursive: true });
		fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });

		fs.writeFileSync(path.join(workspace, "src", "index.ts"), "console.log(1)");
		fs.writeFileSync(path.join(workspace, "src", "components", "Button.tsx"), "export const Button = 1;");
		fs.writeFileSync(path.join(workspace, "src", "components", "Card.tsx"), "export const Card = 1;");
		fs.writeFileSync(path.join(workspace, "package.json"), "{}");
		fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref");
		fs.writeFileSync(path.join(workspace, "node_modules", "lib", "index.js"), "");
		fs.writeFileSync(path.join(workspace, "dist", "bundle.js"), "");
		fs.writeFileSync(path.join(workspace, ".pi", "settings.json"), "{}");

		const preferences = createPreferences(root);
		const preference = preferences.upsert({ pathHint: workspace });
		const { app } = createHarness({ root, preferences });

		const resAll = await app.request(`/workspaces/${preference.workspaceHandle}/files`);
		expect(resAll.status).toBe(200);
		const dataAll = await json(resAll);
		expect(dataAll.files).toEqual(
			expect.arrayContaining([
				"package.json",
				"src/index.ts",
				"src/components/Button.tsx",
				"src/components/Card.tsx",
			]),
		);
		expect(dataAll.files).not.toEqual(
			expect.arrayContaining([
				expect.stringContaining(".git"),
				expect.stringContaining("node_modules"),
				expect.stringContaining("dist/"),
				expect.stringContaining(".pi/"),
			]),
		);

		// Test query filter
		const resQuery = await app.request(`/workspaces/${preference.workspaceHandle}/files?q=Card`);
		expect(resQuery.status).toBe(200);
		const dataQuery = await json(resQuery);
		expect(dataQuery.files).toEqual(["src/components/Card.tsx"]);

		// Test non-existent workspace
		const resMissing = await app.request("/workspaces/non-existent-workspace/files");
		expect(resMissing.status).toBe(404);
	});
});
