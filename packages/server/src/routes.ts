import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { GatewayAccessControl } from "./access-control.js";
import { readAuthStatus, saveApiKey } from "./auth-storage.js";
import type { ServerConfig } from "./config.js";
import { pickWorkspaceDirectory } from "./directory-picker.js";
import { createNativeRoutes } from "./native-routes.js";
import type { NativeSessionCatalog } from "./native-session-catalog.js";
import type { RecoverableSessionTrash } from "./recoverable-session-trash.js";
import {
	MAX_AUTH_API_KEY_LENGTH,
	MAX_AUTH_PROVIDER_ID_LENGTH,
	RequestInputError,
	readBoundedJsonObject,
	requiredBoundedStringField,
} from "./request-input.js";
import type { SessionLayoutResolver } from "./session-layout-resolver.js";
import type { SessionSupervisor } from "./session-supervisor.js";
import type { WorkspacePreferences } from "./workspace-preferences.js";

/**
 * Same-origin REST shell. Workspace and Session resources are projections over
 * Pi's native JSONL storage and are implemented by createNativeRoutes.
 */
export interface AppContext {
	accessControl: GatewayAccessControl;
	config: ServerConfig;
	catalog: NativeSessionCatalog;
	layoutResolver: SessionLayoutResolver;
	preferences: WorkspacePreferences;
	supervisor: SessionSupervisor;
	trash: RecoverableSessionTrash;
	readiness: GatewayReadiness;
}

export interface GatewayReadiness {
	ready: boolean;
	runtime?: {
		source: "bundled" | "pi-path" | "system" | "homebrew";
		version: string;
		adapterId: string;
		capabilities: readonly string[];
	};
	diagnostic?: {
		code: string;
	};
}

export function createApp(ctx: AppContext): Hono {
	const { accessControl, config, supervisor } = ctx;
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

	app.get("/api/v1/health/live", (c) => c.json({ ok: true, service: "pi-agent-web", version: "0.1.0" }));

	app.get("/api/v1/health/ready", (c) => {
		const body = readinessBody(ctx.readiness);
		return c.json(body, ctx.readiness.ready ? 200 : 503);
	});

	// Compatibility alias for existing launchers. It intentionally reflects
	// readiness rather than claiming that a live-but-unusable host is healthy.
	app.get("/api/v1/health", (c) => {
		const body = readinessBody(ctx.readiness);
		return c.json(body, ctx.readiness.ready ? 200 : 503);
	});

	app.post("/api/v1/workspaces/pick-directory", async (c) => {
		try {
			return c.json({ path: await pickWorkspaceDirectory() });
		} catch (error) {
			throw new HTTPException(503, { message: errorText(error) });
		}
	});

	app.get("/api/v1/auth/status", (c) => {
		return c.json({ providers: readAuthStatus(config.agentDir) });
	});

	app.post("/api/v1/auth/keys", async (c) => {
		const body = await readBoundedJsonObject(c.req.raw);
		const provider = requiredBoundedStringField(body, "provider", MAX_AUTH_PROVIDER_ID_LENGTH);
		const key = requiredBoundedStringField(body, "key", MAX_AUTH_API_KEY_LENGTH);
		try {
			await saveApiKey(config.agentDir, provider, key);
		} catch (error) {
			throw new HTTPException(400, { message: errorText(error) });
		}
		supervisor.notifyAuthChanged();
		return c.json({ ok: true, providers: readAuthStatus(config.agentDir) });
	});

	app.route(
		"/api/v1",
		createNativeRoutes({
			catalog: ctx.catalog,
			layoutResolver: ctx.layoutResolver,
			preferences: ctx.preferences,
			supervisor,
			trashSession: async (target) => {
				await ctx.trash.move(target);
			},
		}),
	);

	app.notFound((c) => c.json({ error: "not found" }, 404));
	app.onError((error, c) => {
		if (error instanceof RequestInputError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}
		if (error instanceof HTTPException) {
			return c.json({ error: error.message }, error.status);
		}
		return c.json({ error: errorText(error) }, 500);
	});

	return app;
}

function readinessBody(readiness: GatewayReadiness): {
	ok: boolean;
	ready: boolean;
	service: "pi-agent-web";
	version: "0.1.0";
	runtime?: GatewayReadiness["runtime"];
	diagnostic?: GatewayReadiness["diagnostic"];
} {
	return {
		ok: readiness.ready,
		ready: readiness.ready,
		service: "pi-agent-web",
		version: "0.1.0",
		...(readiness.runtime ? { runtime: readiness.runtime } : {}),
		...(readiness.diagnostic ? { diagnostic: readiness.diagnostic } : {}),
	};
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
