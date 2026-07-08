import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { readAuthStatus, saveApiKey } from "./auth-storage.js";
import type { ServerConfig } from "./config.js";
import { getSessionDirForCwd } from "./config.js";
import { findChildSessions, scanSessionDir } from "./session-scan.js";
import type { Supervisor } from "./supervisor.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

/**
 * REST API (design spec §4.1): workspace/session directory and auth management.
 * Real-time conversation flows over the WebSocket channel instead.
 */

export interface AppContext {
	config: ServerConfig;
	registry: WorkspaceRegistry;
	supervisor: Supervisor;
}

function safeSessionId(raw: string): string {
	const decoded = decodeURIComponent(raw);
	if (decoded !== path.basename(decoded) || !decoded.endsWith(".jsonl")) {
		throw new HTTPException(400, { message: "invalid session id" });
	}
	return decoded;
}

export function createApp(ctx: AppContext): Hono {
	const { config, registry, supervisor } = ctx;
	const app = new Hono();

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
				const sessionDir = getSessionDirForCwd(ws.path, config.sessionRootDir);
				counts.set(ws.id, (await scanSessionDir(sessionDir)).length);
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
		const body = await c.req.json<{ path?: string; displayName?: string }>();
		if (!body?.path || typeof body.path !== "string") {
			throw new HTTPException(400, { message: "body.path is required" });
		}
		try {
			const summary = registry.add(body.path, body.displayName);
			supervisor.registerWorkspace(summary.id, summary.path);
			return c.json(summary, 201);
		} catch (error) {
			throw new HTTPException(400, { message: error instanceof Error ? error.message : String(error) });
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
		const sessionDir = getSessionDirForCwd(record.path, config.sessionRootDir);
		const sessions = await scanSessionDir(sessionDir);
		registry.touch(record.id);
		return c.json({ sessions, sessionDir });
	});

	app.delete("/api/v1/workspaces/:workspaceId/sessions/:sessionId", async (c) => {
		const record = registry.get(c.req.param("workspaceId"));
		if (!record) throw new HTTPException(404, { message: "workspace not found" });

		const sessionId = safeSessionId(c.req.param("sessionId"));
		const sessionDir = getSessionDirForCwd(record.path, config.sessionRootDir);
		const targetPath = path.join(sessionDir, sessionId);
		if (!fs.existsSync(targetPath)) throw new HTTPException(404, { message: "session not found" });

		// Guard: never delete the session a live process currently has loaded.
		const status = supervisor.getStatus(record.id);
		if (status?.state === "running" && status.sessionId === sessionId) {
			throw new HTTPException(409, { message: "session is active in the running process" });
		}

		// Lineage protection: reject when child sessions reference this file (409).
		const children = await findChildSessions(sessionDir, path.resolve(targetPath));
		if (children.length > 0) {
			throw new HTTPException(409, {
				message: `session has ${children.length} forked child session(s); delete them first`,
			});
		}

		await fs.promises.unlink(targetPath);
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
		const body = await c.req.json<{ provider?: string; key?: string }>();
		if (!body?.provider || typeof body.provider !== "string" || !body.key || typeof body.key !== "string") {
			throw new HTTPException(400, { message: "body.provider and body.key are required" });
		}
		await saveApiKey(config.agentDir, body.provider, body.key);
		// Running processes snapshot models at startup (15s background refresh in
		// pi). Tell clients to re-pull the model directory (§7.3 closed loop).
		supervisor.notifyAuthChanged();
		return c.json({ ok: true, providers: readAuthStatus(config.agentDir) });
	});

	// -------------------------------------------------------------------------
	// Process diagnostics
	// -------------------------------------------------------------------------

	app.get("/api/v1/workspaces/:workspaceId/process", (c) => {
		const record = registry.get(c.req.param("workspaceId"));
		if (!record) throw new HTTPException(404, { message: "workspace not found" });
		return c.json(supervisor.getStatus(record.id) ?? { state: "crashed", sessionId: null });
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
