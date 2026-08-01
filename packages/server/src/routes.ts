import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { GatewayAccessControl } from "./access-control.js";
import { readAuthStatus, saveApiKey } from "./auth-storage.js";
import type { ServerConfig } from "./config.js";
import { getSessionDirForCwd } from "./config.js";
import { pickWorkspaceDirectory } from "./directory-picker.js";
import { findChildSessions, scanSessionDir, scanSessionFile } from "./session-scan.js";
import type { Supervisor } from "./supervisor.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

/**
 * REST API: workspace/session directory and auth management.
 * Real-time conversation flows over the WebSocket channel instead.
 */

export interface AppContext {
	accessControl: GatewayAccessControl;
	config: ServerConfig;
	registry: WorkspaceRegistry;
	supervisor: Supervisor;
}

interface SessionCountCacheEntry {
	directoryMtimeMs: number;
	count: number;
}

async function sessionCountFor(
	cache: Map<string, SessionCountCacheEntry>,
	sessionDir: string,
	expectedCwdRealpath: string,
): Promise<number> {
	const cacheKey = `${sessionDir}\u0000${expectedCwdRealpath}`;
	try {
		const stat = await fs.promises.stat(sessionDir);
		const cached = cache.get(cacheKey);
		if (cached?.directoryMtimeMs === stat.mtimeMs) return cached.count;
		const count = (
			await scanSessionDir(sessionDir, expectedCwdRealpath, {
				onDiagnostic: (message) => console.warn(`[pi-web] WARN ${message}`),
			})
		).length;
		cache.set(cacheKey, { directoryMtimeMs: stat.mtimeMs, count });
		return count;
	} catch {
		cache.delete(cacheKey);
		return 0;
	}
}

async function readJsonBody<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw new HTTPException(400, { message: "request body must be valid JSON" });
	}
}

function safeSessionId(raw: string): string {
	const decoded = decodeURIComponent(raw);
	if (decoded !== path.basename(decoded) || !decoded.endsWith(".jsonl")) {
		throw new HTTPException(400, { message: "invalid session id" });
	}
	return decoded;
}

export function createApp(ctx: AppContext): Hono {
	const { accessControl, config, registry, supervisor } = ctx;
	const sessionCountCache = new Map<string, SessionCountCacheEntry>();
	const app = new Hono();

	app.get("/api/v1/bootstrap", (c) => {
		if (!accessControl.isAllowedOrigin(c.req.raw.headers)) {
			return c.json({ error: "forbidden origin" }, 403);
		}
		c.header("Set-Cookie", accessControl.createSessionCookie());
		return c.json({ ok: true });
	});

	app.use("/api/v1/*", async (c, next) => {
		if (!accessControl.isAuthorized(c.req.raw.headers)) {
			return c.json({ error: "forbidden" }, 403);
		}
		await next();
	});

	app.get("/api/v1/health", (c) => {
		return c.json({ ok: true, service: "pi-agent-web", version: "0.1.0" });
	});

	// -------------------------------------------------------------------------
	// Workspaces
	// -------------------------------------------------------------------------

	app.get("/api/v1/workspaces", async (c) => {
		const records = registry.list();
		const counts = new Map<string, number>();
		await Promise.all(
			records.map(async (ws) => {
				const record = registry.get(ws.id);
				if (!record) return;
				const sessionDir = getSessionDirForCwd(record.cwdRealpath, config.sessionRootDir);
				counts.set(ws.id, await sessionCountFor(sessionCountCache, sessionDir, record.cwdRealpath));
			}),
		);
		return c.json(
			records.map((ws) => ({
				...ws,
				sessionCount: counts.get(ws.id) ?? ws.sessionCount,
			})),
		);
	});

	app.post("/api/v1/workspaces", async (c) => {
		const body = await readJsonBody<{ path?: string; displayName?: string }>(c.req.raw);
		if (!body?.path || typeof body.path !== "string") {
			throw new HTTPException(400, { message: "body.path is required" });
		}
		try {
			const summary = registry.add(body.path, body.displayName);
			supervisor.registerWorkspace(summary.id, registry.get(summary.id)!.cwdRealpath);
			return c.json(summary, 201);
		} catch (error) {
			throw new HTTPException(400, { message: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/api/v1/workspaces/pick-directory", async (c) => {
		try {
			return c.json({ path: await pickWorkspaceDirectory() });
		} catch (error) {
			throw new HTTPException(503, {
				message: error instanceof Error ? error.message : String(error),
			});
		}
	});

	app.delete("/api/v1/workspaces/:workspaceId", async (c) => {
		const workspaceId = c.req.param("workspaceId");
		const record = registry.get(workspaceId);
		if (!record) throw new HTTPException(404, { message: "workspace not found" });
		await supervisor.stop(workspaceId);
		registry.remove(workspaceId);
		return c.json({ ok: true });
	});

	// -------------------------------------------------------------------------
	// Sessions
	// -------------------------------------------------------------------------

	app.get("/api/v1/workspaces/:workspaceId/sessions", async (c) => {
		const record = registry.get(c.req.param("workspaceId"));
		if (!record) throw new HTTPException(404, { message: "workspace not found" });
		const sessionDir = getSessionDirForCwd(record.cwdRealpath, config.sessionRootDir);
		const sessions = await scanSessionDir(sessionDir, record.cwdRealpath, {
			onDiagnostic: (message) => console.warn(`[pi-web] WARN ${message}`),
		});
		registry.touch(record.id);
		return c.json({ sessions, sessionDir });
	});

	app.delete("/api/v1/workspaces/:workspaceId/sessions/:sessionId", async (c) => {
		const record = registry.get(c.req.param("workspaceId"));
		if (!record) throw new HTTPException(404, { message: "workspace not found" });

		const sessionId = safeSessionId(c.req.param("sessionId"));
		const sessionDir = getSessionDirForCwd(record.cwdRealpath, config.sessionRootDir);
		const targetPath = path.join(sessionDir, sessionId);

		await supervisor.withSessionTransition(record.id, async () => {
			// Reading the Header here, inside the same mutex as switches/new/fork,
			// makes the file identity check authoritative at deletion time.
			const target = await scanSessionFile(targetPath, record.cwdRealpath);
			if (!target) throw new HTTPException(404, { message: "session not found" });
			const targetCanonicalPath = await fs.promises.realpath(target.absolutePath);

			// Guard: never delete the file a live process currently has loaded. The
			// header UUID intentionally does not participate in this identity check.
			const status = supervisor.getStatus(record.id);
			if (status?.state === "running" && status.sessionFile) {
				const activeCanonicalPath = await fs.promises
					.realpath(status.sessionFile)
					.catch(() => path.resolve(status.sessionFile!));
				if (activeCanonicalPath === targetCanonicalPath) {
					throw new HTTPException(409, { message: "session is active in the running process" });
				}
			}

			// Lineage protection: reject when child sessions reference this file (409).
			const children = await findChildSessions(sessionDir, targetCanonicalPath, record.cwdRealpath);
			if (children.length > 0) {
				throw new HTTPException(409, {
					message: `session has ${children.length} forked child session(s); delete them first`,
				});
			}

			await fs.promises.unlink(target.absolutePath);
		});
		supervisor.notifySessionDirectoryChanged(record.id);
		return c.json({ ok: true });
	});

	// -------------------------------------------------------------------------
	// Auth
	// -------------------------------------------------------------------------

	app.get("/api/v1/auth/status", (c) => {
		return c.json({ providers: readAuthStatus(config.agentDir) });
	});

	app.post("/api/v1/auth/keys", async (c) => {
		const body = await readJsonBody<{ provider?: string; key?: string }>(c.req.raw);
		if (!body?.provider || typeof body.provider !== "string" || !body.key || typeof body.key !== "string") {
			throw new HTTPException(400, { message: "body.provider and body.key are required" });
		}
		try {
			await saveApiKey(config.agentDir, body.provider, body.key);
		} catch (error) {
			throw new HTTPException(400, { message: error instanceof Error ? error.message : String(error) });
		}
		// Running processes snapshot models at startup (15s background refresh in
		// pi). Tell clients to re-pull the model directory (auth refresh loop).
		supervisor.notifyAuthChanged();
		return c.json({ ok: true, providers: readAuthStatus(config.agentDir) });
	});

	// -------------------------------------------------------------------------
	// Process diagnostics
	// -------------------------------------------------------------------------

	app.get("/api/v1/workspaces/:workspaceId/process", (c) => {
		const record = registry.get(c.req.param("workspaceId"));
		if (!record) throw new HTTPException(404, { message: "workspace not found" });
		return c.json(
			supervisor.getStatus(record.id) ?? { state: "crashed", sessionId: null, sessionFile: null },
		);
	});

	app.post("/api/v1/workspaces/:workspaceId/process/restart", async (c) => {
		const record = registry.get(c.req.param("workspaceId"));
		if (!record) throw new HTTPException(404, { message: "workspace not found" });
		try {
			await supervisor.restart(record.id);
			return c.json({ ok: true });
		} catch (error) {
			throw new HTTPException(500, { message: error instanceof Error ? error.message : String(error) });
		}
	});

	app.notFound((c) => c.json({ error: "not found" }, 404));
	app.onError((error, c) => {
		if (error instanceof HTTPException) {
			return c.json({ error: error.message }, error.status);
		}
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
	});

	return app;
}
