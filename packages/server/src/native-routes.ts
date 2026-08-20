import fs from "node:fs";
import path from "node:path";
import { type NativeSessionDto, type NativeWorkspaceDto, RpcError } from "@pi-agent-web/protocol";
import { Hono } from "hono";
import type {
	NativeSessionCatalog,
	NativeSessionCatalogSnapshot,
	NativeSessionRecord,
	NativeWorkspaceRecord,
} from "./native-session-catalog.js";
import { sessionHandleForCanonicalFile } from "./native-session-catalog.js";
import {
	MAX_WORKSPACE_PATH_LENGTH,
	optionalBoundedStringField,
	RequestInputError,
	readBoundedJsonObject,
} from "./request-input.js";
import { canonicalizePathAllowMissing, type SessionLayoutResolver } from "./session-layout-resolver.js";
import type { SessionRuntimeSnapshot } from "./session-runtime-types.js";
import type { CreateSessionRequest, SessionManagementContext } from "./session-supervisor.js";
import type { WorkspacePreference, WorkspacePreferences } from "./workspace-preferences.js";

export type { NativeSessionDto, NativeWorkspaceDto } from "@pi-agent-web/protocol";

export interface RecoverableTrashTarget {
	sessionHandle: string;
	workspaceHandle: string;
	nativeSessionId: string;
	/** Canonical file identity resolved by NativeSessionCatalog. */
	sessionFile: string;
}

export interface NativeRouteSupervisor {
	listRuntimes(): SessionRuntimeSnapshot[];
	getRuntime(sessionHandle: string): SessionRuntimeSnapshot | undefined;
	createSession(request: CreateSessionRequest): Promise<SessionRuntimeSnapshot>;
	withControlledSessionDeletion<T>(
		workspaceId: string,
		sessionHandle: string,
		context: SessionManagementContext,
		operation: () => Promise<T>,
	): Promise<T>;
}

export interface NativeRoutesContext {
	catalog: NativeSessionCatalog;
	layoutResolver: SessionLayoutResolver;
	preferences: WorkspacePreferences;
	supervisor: NativeRouteSupervisor;
	/** Must move the exact canonical file to a recoverable trash location. */
	trashSession: (target: RecoverableTrashTarget) => Promise<void>;
	now?: () => number;
}

type NativeRouteStatus = 400 | 404 | 409 | 422 | 500 | 502;

class NativeRouteError extends Error {
	constructor(
		readonly status: NativeRouteStatus,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

interface WorkspaceProjection {
	dto: NativeWorkspaceDto;
	native?: NativeWorkspaceRecord;
	preference?: WorkspacePreference;
}

/**
 * Native Pi REST surface. Mount this under `/api/v1` after the gateway auth
 * middleware. Conversation traffic and controller leases remain WebSocket-only.
 */
export function createNativeRoutes(ctx: NativeRoutesContext): Hono {
	const app = new Hono();
	const now = ctx.now ?? Date.now;

	app.get("/workspaces", async (c) => {
		const snapshot = await ctx.catalog.refresh();
		return c.json(await projectWorkspaces(snapshot, ctx.preferences, ctx.supervisor.listRuntimes()));
	});

	app.post("/workspaces", async (c) => {
		const body = await readBoundedJsonObject(c.req.raw);
		const candidate =
			optionalBoundedStringField(body, "path", MAX_WORKSPACE_PATH_LENGTH) ??
			optionalBoundedStringField(body, "pathHint", MAX_WORKSPACE_PATH_LENGTH);
		if (!candidate) throw new NativeRouteError(400, "workspace_path_required", "body.path is required");
		const workspacePath = await validateWorkspacePath(candidate);
		const displayName = optionalDisplayName(body);
		const pinned = optionalBoolean(body, "pinned");
		const preference = ctx.preferences.upsert({
			pathHint: workspacePath,
			...(pinned === undefined ? {} : { pinned }),
			...(displayName.present ? { displayName: displayName.value } : {}),
			lastOpenedAt: now(),
		});
		const snapshot = await ctx.catalog.refresh({ force: true });
		const projection = await findWorkspaceProjection(
			snapshot,
			ctx.preferences,
			preference.workspaceHandle,
			ctx.supervisor.listRuntimes(),
		);
		if (!projection) {
			throw new NativeRouteError(500, "workspace_projection_failed", "workspace could not be projected");
		}
		return c.json(projection.dto, 201);
	});

	app.delete("/workspaces/:workspaceHandle", async (c) => {
		const workspaceHandle = c.req.param("workspaceHandle");
		const snapshot = await ctx.catalog.refresh();
		const projection = await findWorkspaceProjection(
			snapshot,
			ctx.preferences,
			workspaceHandle,
			ctx.supervisor.listRuntimes(),
		);
		if (!projection) throw notFound("workspace_not_found", "workspace not found");
		ctx.preferences.remove(workspaceHandle);
		await ctx.catalog.refresh({ force: true });
		return c.json({ ok: true, nativeHistoryRetained: projection.dto.hasNativeHistory });
	});

	app.get("/workspaces/:workspaceHandle/sessions", async (c) => {
		const workspaceHandle = c.req.param("workspaceHandle");
		const snapshot = await ctx.catalog.refresh({ force: c.req.query("refresh") === "1" });
		await requireWorkspace(snapshot, ctx.preferences, workspaceHandle, ctx.supervisor.listRuntimes());
		ctx.preferences.touch(workspaceHandle, now());
		const sessions = projectSessions(snapshot, ctx.supervisor.listRuntimes(), workspaceHandle);
		const workspace = await requireWorkspace(
			snapshot,
			ctx.preferences,
			workspaceHandle,
			ctx.supervisor.listRuntimes(),
		);
		const layout = workspace.dto.path ? ctx.layoutResolver.resolveForWorkspace(workspace.dto.path) : null;
		return c.json({
			sessions,
			layout: layout ? { sessionDir: layout.sessionDir, source: layout.source } : null,
		});
	});

	app.post("/workspaces/:workspaceHandle/sessions", async (c) => {
		const workspaceHandle = c.req.param("workspaceHandle");
		const snapshot = await ctx.catalog.refresh();
		const workspace = await requireWorkspace(
			snapshot,
			ctx.preferences,
			workspaceHandle,
			ctx.supervisor.listRuntimes(),
		);
		if (!workspace.dto.path || !workspace.dto.available) {
			throw new NativeRouteError(
				409,
				"workspace_unavailable",
				"workspace must be an available local directory",
			);
		}
		const layout = ctx.layoutResolver.resolveForWorkspace(workspace.dto.path);
		let runtime: SessionRuntimeSnapshot;
		try {
			runtime = await ctx.supervisor.createSession({
				workspaceId: workspaceHandle,
				cwd: workspace.dto.path,
				sessionDir: layout.sessionDir,
			});
		} catch (error) {
			throw supervisorError(error, "create_session_failed");
		}
		ctx.preferences.touch(workspaceHandle, now());
		const refreshed = await ctx.catalog.refresh({ force: true });
		const summary = projectSessions(refreshed, ctx.supervisor.listRuntimes(), workspaceHandle).find(
			(session) => session.sessionHandle === runtime.sessionHandle,
		);
		return c.json(
			{
				session: summary ?? sessionDtoFromRuntime(runtime),
				runtime,
				layout: { sessionDir: layout.sessionDir, source: layout.source },
			},
			201,
		);
	});

	app.delete("/workspaces/:workspaceHandle/sessions/:sessionHandle", async (c) => {
		const workspaceHandle = c.req.param("workspaceHandle");
		const sessionHandle = c.req.param("sessionHandle");
		const snapshot = await ctx.catalog.refresh({ force: true });
		await requireWorkspace(snapshot, ctx.preferences, workspaceHandle, ctx.supervisor.listRuntimes());
		const runtime = runtimeForWorkspace(ctx.supervisor, sessionHandle, workspaceHandle);
		const session = persistedSessionForWorkspace(snapshot, sessionHandle, workspaceHandle);
		if (!session) {
			if (runtime) {
				throw new NativeRouteError(409, "session_not_persisted", "session has no recoverable file yet");
			}
			throw notFound("session_not_found", "session not found");
		}
		const management = managementContext(c.req.raw);
		try {
			await ctx.supervisor.withControlledSessionDeletion(
				workspaceHandle,
				sessionHandle,
				management,
				async () => {
					const current = await ctx.catalog.refresh({ force: true });
					const reservedSession = persistedSessionForWorkspace(current, sessionHandle, workspaceHandle);
					if (!reservedSession) throw notFound("session_not_found", "session not found");
					const children = current.sessions.filter(
						(candidate) => candidate.parentSessionFile === reservedSession.sessionFile,
					);
					if (children.length > 0) {
						throw new NativeRouteError(
							409,
							"session_has_children",
							`session has ${String(children.length)} child session(s)`,
						);
					}
					await assertCurrentFileIdentity(reservedSession);
					await ctx.trashSession({
						sessionHandle: reservedSession.sessionHandle,
						workspaceHandle,
						nativeSessionId: reservedSession.nativeSessionId,
						sessionFile: reservedSession.sessionFile,
					});
				},
			);
		} catch (error) {
			if (error instanceof NativeRouteError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (
				message.includes("session_active") ||
				message.includes("session_busy") ||
				message.includes("session_deleting") ||
				message.includes("session_control_required") ||
				message.includes("session_generation_stale") ||
				message.includes("session_read_only") ||
				message.includes("unpersisted_session_cannot_be_deleted") ||
				message.includes("workspace_identity_transitioning")
			) {
				throw new NativeRouteError(409, messageToken(message), message);
			}
			throw new NativeRouteError(500, "session_trash_failed", message);
		}
		await ctx.catalog.refresh({ force: true });
		return c.json({ ok: true, recoverable: true });
	});

	app.get("/workspaces/:workspaceHandle/sessions/:sessionHandle/process", async (c) => {
		const { workspaceHandle, sessionHandle } = c.req.param();
		const snapshot = await ctx.catalog.refresh();
		await requireSession(snapshot, ctx, workspaceHandle, sessionHandle);
		const runtime = runtimeForWorkspace(ctx.supervisor, sessionHandle, workspaceHandle);
		return c.json(runtime ?? dormantRuntime(snapshot, workspaceHandle, sessionHandle));
	});

	app.onError((error, c) => {
		if (error instanceof RequestInputError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}
		if (error instanceof NativeRouteError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}
		return c.json(
			{
				error: {
					code: "internal_error",
					message: error instanceof Error ? error.message : String(error),
				},
			},
			500,
		);
	});

	return app;
}

function managementContext(request: Request): SessionManagementContext {
	const rawGeneration = request.headers.get("x-pi-session-generation");
	const fencingToken = request.headers.get("x-pi-fencing-token")?.trim();
	const expectedGeneration = rawGeneration === null ? Number.NaN : Number(rawGeneration);
	if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1 || !fencingToken) {
		throw new NativeRouteError(
			409,
			"session_control_required",
			"an exact Session generation and controller fencing token are required",
		);
	}
	return { expectedGeneration, fencingToken };
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
	if (!Object.hasOwn(body, key)) return undefined;
	if (typeof body[key] !== "boolean") {
		throw new NativeRouteError(422, `invalid_${key}`, `body.${key} must be a boolean`);
	}
	return body[key];
}

function optionalDisplayName(body: Record<string, unknown>): { present: boolean; value: string | null } {
	if (!Object.hasOwn(body, "displayName")) return { present: false, value: null };
	const value = body.displayName;
	if (value === null) return { present: true, value: null };
	if (typeof value !== "string") {
		throw new NativeRouteError(422, "invalid_display_name", "body.displayName must be a string or null");
	}
	const trimmed = value.trim();
	if (trimmed.length > 200) {
		throw new NativeRouteError(422, "invalid_display_name", "body.displayName is too long");
	}
	return { present: true, value: trimmed || null };
}

async function validateWorkspacePath(input: string): Promise<string> {
	if (!path.isAbsolute(input)) {
		throw new NativeRouteError(422, "workspace_path_not_absolute", "workspace path must be absolute");
	}
	let canonical: string;
	try {
		canonical = await fs.promises.realpath(input);
		const stat = await fs.promises.stat(canonical);
		if (!stat.isDirectory()) {
			throw new NativeRouteError(422, "workspace_not_directory", "workspace path is not a directory");
		}
		await fs.promises.access(canonical, fs.constants.R_OK | fs.constants.X_OK);
	} catch (error) {
		if (error instanceof NativeRouteError) throw error;
		throw new NativeRouteError(
			422,
			"workspace_unreadable",
			error instanceof Error ? error.message : "workspace directory is not readable",
		);
	}
	return canonicalizePathAllowMissing(canonical);
}

async function projectWorkspaces(
	snapshot: NativeSessionCatalogSnapshot,
	preferences: WorkspacePreferences,
	runtimes: SessionRuntimeSnapshot[],
): Promise<NativeWorkspaceDto[]> {
	const nativeByHandle = new Map(
		snapshot.workspaces.map((workspace) => [workspace.workspaceHandle, workspace]),
	);
	const preferenceByHandle = new Map(
		preferences.list().map((preference) => [preference.workspaceHandle, preference]),
	);
	const runtimesByWorkspace = groupRuntimesByWorkspace(runtimes);
	const handles = new Set([
		...nativeByHandle.keys(),
		...preferenceByHandle.keys(),
		...runtimesByWorkspace.keys(),
	]);
	const projections = await Promise.all(
		[...handles].map((handle) =>
			projectWorkspace(
				nativeByHandle.get(handle),
				preferenceByHandle.get(handle),
				snapshot,
				runtimesByWorkspace.get(handle) ?? [],
			),
		),
	);
	return projections.map((projection) => projection.dto).sort(compareWorkspaces);
}

async function findWorkspaceProjection(
	snapshot: NativeSessionCatalogSnapshot,
	preferences: WorkspacePreferences,
	workspaceHandle: string,
	runtimes: SessionRuntimeSnapshot[] = [],
): Promise<WorkspaceProjection | undefined> {
	const native = snapshot.workspaces.find((workspace) => workspace.workspaceHandle === workspaceHandle);
	const preference = preferences.get(workspaceHandle);
	const workspaceRuntimes = runtimes.filter((runtime) => runtime.workspaceId === workspaceHandle);
	if (!native && !preference && workspaceRuntimes.length === 0) return undefined;
	return projectWorkspace(native, preference, snapshot, workspaceRuntimes);
}

async function requireWorkspace(
	snapshot: NativeSessionCatalogSnapshot,
	preferences: WorkspacePreferences,
	workspaceHandle: string,
	runtimes: SessionRuntimeSnapshot[] = [],
): Promise<WorkspaceProjection> {
	const workspace = await findWorkspaceProjection(snapshot, preferences, workspaceHandle, runtimes);
	if (!workspace) throw notFound("workspace_not_found", "workspace not found");
	return workspace;
}

async function projectWorkspace(
	native: NativeWorkspaceRecord | undefined,
	preference: WorkspacePreference | undefined,
	snapshot: NativeSessionCatalogSnapshot,
	runtimes: SessionRuntimeSnapshot[],
): Promise<WorkspaceProjection> {
	const pathHint = native?.workspacePath ?? preference?.pathHint ?? runtimes[0]?.cwd ?? null;
	const availability = native
		? { available: native.workspaceAvailable, unavailableReason: native.workspaceUnavailableReason }
		: await inspectPreferencePath(pathHint);
	const workspaceHandle = native?.workspaceHandle ?? preference?.workspaceHandle ?? runtimes[0]?.workspaceId;
	if (!workspaceHandle) throw new Error("workspace projection requires an identity");
	const nativeSessions = native
		? snapshot.sessions.filter((session) => session.workspaceHandle === native.workspaceHandle)
		: [];
	const sessionHandles = new Set([
		...nativeSessions.map((session) => session.sessionHandle),
		...runtimes.map((runtime) => runtime.sessionHandle),
	]);
	return {
		native,
		preference,
		dto: {
			workspaceHandle,
			path: pathHint,
			available: availability.available,
			...(availability.unavailableReason ? { unavailableReason: availability.unavailableReason } : {}),
			pinned: preference?.pinned ?? false,
			displayName:
				preference?.displayName ?? (pathHint ? path.basename(pathHint) || pathHint : workspaceHandle),
			lastOpenedAt: preference?.lastOpenedAt ?? null,
			sessionCount: sessionHandles.size,
			hasNativeHistory: nativeSessions.length > 0,
		},
	};
}

function groupRuntimesByWorkspace(runtimes: SessionRuntimeSnapshot[]): Map<string, SessionRuntimeSnapshot[]> {
	const groups = new Map<string, SessionRuntimeSnapshot[]>();
	for (const runtime of runtimes) {
		const group = groups.get(runtime.workspaceId);
		if (group) group.push(runtime);
		else groups.set(runtime.workspaceId, [runtime]);
	}
	return groups;
}

async function inspectPreferencePath(
	workspacePath: string | null,
): Promise<{ available: boolean; unavailableReason?: string }> {
	if (!workspacePath) return { available: false, unavailableReason: "cwd-empty" };
	try {
		const stat = await fs.promises.stat(workspacePath);
		if (!stat.isDirectory()) return { available: false, unavailableReason: "not-directory" };
		await fs.promises.access(workspacePath, fs.constants.R_OK | fs.constants.X_OK);
		return { available: true };
	} catch (error) {
		return { available: false, unavailableReason: isMissing(error) ? "missing" : "unreadable" };
	}
}

function compareWorkspaces(a: NativeWorkspaceDto, b: NativeWorkspaceDto): number {
	return (
		Number(b.pinned) - Number(a.pinned) ||
		(b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) ||
		(a.displayName ?? a.path ?? a.workspaceHandle).localeCompare(b.displayName ?? b.path ?? b.workspaceHandle)
	);
}

function projectSessions(
	snapshot: NativeSessionCatalogSnapshot,
	runtimes: SessionRuntimeSnapshot[],
	workspaceHandle: string,
): NativeSessionDto[] {
	const runtimeByHandle = new Map(
		runtimes
			.filter((runtime) => runtime.workspaceId === workspaceHandle)
			.map((runtime) => [runtime.sessionHandle, runtime]),
	);
	const sessions = snapshot.sessions
		.filter((session) => session.workspaceHandle === workspaceHandle)
		.map((session) => sessionDtoFromNative(session, runtimeByHandle.get(session.sessionHandle)));
	const persistedHandles = new Set(sessions.map((session) => session.sessionHandle));
	for (const runtime of runtimeByHandle.values()) {
		if (!persistedHandles.has(runtime.sessionHandle)) sessions.push(sessionDtoFromRuntime(runtime));
	}
	return sessions.sort(
		(a, b) =>
			Date.parse(b.modifiedAt ?? "") - Date.parse(a.modifiedAt ?? "") ||
			a.sessionHandle.localeCompare(b.sessionHandle),
	);
}

function sessionDtoFromNative(
	session: NativeSessionRecord,
	runtime: SessionRuntimeSnapshot | undefined,
): NativeSessionDto {
	return {
		sessionHandle: session.sessionHandle,
		workspaceHandle: session.workspaceHandle,
		nativeSessionId: session.nativeSessionId,
		sessionFile: session.sessionFile,
		persisted: true,
		...(session.name ? { name: session.name } : {}),
		...(session.parentSessionFile ? { parentSessionFile: session.parentSessionFile } : {}),
		createdAt: session.created.toISOString(),
		modifiedAt: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		runtime: runtime ?? null,
	};
}

function sessionDtoFromRuntime(runtime: SessionRuntimeSnapshot): NativeSessionDto {
	return {
		sessionHandle: runtime.sessionHandle,
		workspaceHandle: runtime.workspaceId,
		nativeSessionId: runtime.nativeSessionId,
		sessionFile: runtime.sessionFile,
		persisted: runtime.recoverable,
		createdAt: null,
		modifiedAt: new Date(runtime.lastActivityAt).toISOString(),
		messageCount: 0,
		firstMessage: "",
		runtime,
	};
}

function persistedSessionForWorkspace(
	snapshot: NativeSessionCatalogSnapshot,
	sessionHandle: string,
	workspaceHandle: string,
): NativeSessionRecord | undefined {
	return snapshot.sessions.find(
		(session) => session.sessionHandle === sessionHandle && session.workspaceHandle === workspaceHandle,
	);
}

function runtimeForWorkspace(
	supervisor: NativeRouteSupervisor,
	sessionHandle: string,
	workspaceHandle: string,
): SessionRuntimeSnapshot | undefined {
	const runtime = supervisor.getRuntime(sessionHandle);
	return runtime?.workspaceId === workspaceHandle ? runtime : undefined;
}

async function requireSession(
	snapshot: NativeSessionCatalogSnapshot,
	ctx: NativeRoutesContext,
	workspaceHandle: string,
	sessionHandle: string,
): Promise<void> {
	await requireWorkspace(snapshot, ctx.preferences, workspaceHandle, ctx.supervisor.listRuntimes());
	if (
		!persistedSessionForWorkspace(snapshot, sessionHandle, workspaceHandle) &&
		!runtimeForWorkspace(ctx.supervisor, sessionHandle, workspaceHandle)
	) {
		throw notFound("session_not_found", "session not found");
	}
}

function dormantRuntime(
	snapshot: NativeSessionCatalogSnapshot,
	workspaceHandle: string,
	sessionHandle: string,
): SessionRuntimeSnapshot {
	const session = persistedSessionForWorkspace(snapshot, sessionHandle, workspaceHandle);
	if (!session) throw notFound("session_not_found", "session not found");
	return {
		sessionHandle,
		workspaceId: workspaceHandle,
		nativeSessionId: session.nativeSessionId,
		sessionFile: session.sessionFile,
		cwd: session.cwd,
		generation: 0,
		lastSeq: 0,
		state: "dormant",
		lastActivityAt: session.modified.getTime(),
		recoverable: true,
	};
}

async function assertCurrentFileIdentity(session: NativeSessionRecord): Promise<void> {
	let canonical: string;
	try {
		canonical = await fs.promises.realpath(session.sessionFile);
	} catch (error) {
		if (isMissing(error)) throw notFound("session_not_found", "session file no longer exists");
		throw error;
	}
	if (
		canonical !== session.sessionFile ||
		sessionHandleForCanonicalFile(canonical) !== session.sessionHandle
	) {
		throw new NativeRouteError(409, "session_identity_changed", "session file identity changed");
	}
}

function supervisorError(error: unknown, fallbackCode: string): NativeRouteError {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof RpcError) {
		const code = messageToken(error.message);
		if (SUPERVISOR_CONFLICT_CODES.has(code)) return new NativeRouteError(409, code, message);
	}
	return new NativeRouteError(502, fallbackCode, message);
}

const SUPERVISOR_CONFLICT_CODES = new Set([
	"canonical_session_already_active",
	"session_runtime_capacity",
	"unpersisted_session_cannot_be_recovered",
	"workspace_creation_in_progress",
	"workspace_identity_transitioning",
	"workspace_session_deleting",
]);

function messageToken(message: string): string {
	const token = message.match(/[a-z][a-z0-9_]{2,}/g)?.at(-1);
	return token ?? "session_conflict";
}

function notFound(code: string, message: string): NativeRouteError {
	return new NativeRouteError(404, code, message);
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
	);
}
