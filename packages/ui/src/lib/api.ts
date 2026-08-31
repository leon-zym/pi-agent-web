import type {
	AuthStatusEntry,
	NativeSessionCreateDto,
	NativeSessionListDto,
	NativeWorkspaceDto,
	SessionRuntimeDto,
	WorkspaceFileMetadataDto,
	WorkspaceFileReferenceDto,
	WorkspaceFileSearchDto,
} from "@pi-agent-web/protocol";

/** Structured REST failure returned by the local gateway. */
export class GatewayApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "GatewayApiError";
	}
}

interface GatewayErrorBody {
	error?: string | { code?: string; message?: string };
}

/** Minimal same-origin REST client for the gateway. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const headers = new Headers(init?.headers);
	if (init?.body !== undefined && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}
	const response = await fetch(path, {
		...init,
		credentials: "include",
		headers,
	});
	if (!response.ok) {
		let code = `http_${String(response.status)}`;
		let message = `HTTP ${String(response.status)}`;
		try {
			const body = (await response.json()) as GatewayErrorBody;
			if (typeof body.error === "string") message = body.error;
			else if (body.error) {
				code = body.error.code ?? code;
				message = body.error.message ?? message;
			}
		} catch {
			// Keep the stable status-derived fallback.
		}
		throw new GatewayApiError(response.status, code, message);
	}
	return (await response.json()) as T;
}

function workspacePath(workspaceHandle: string, suffix = ""): string {
	return `/api/v1/workspaces/${encodeURIComponent(workspaceHandle)}${suffix}`;
}

function sessionPath(workspaceHandle: string, sessionHandle: string, suffix = ""): string {
	return workspacePath(workspaceHandle, `/sessions/${encodeURIComponent(sessionHandle)}${suffix}`);
}

export const api = {
	bootstrap: () => request<{ ok: true }>("/api/v1/bootstrap"),
	listWorkspaces: () => request<NativeWorkspaceDto[]>("/api/v1/workspaces"),
	pickWorkspaceDirectory: () =>
		request<{ path: string | null }>("/api/v1/workspaces/pick-directory", { method: "POST" }),
	addWorkspace: (path: string) =>
		request<NativeWorkspaceDto>("/api/v1/workspaces", {
			method: "POST",
			body: JSON.stringify({ path }),
		}),
	removeWorkspace: (workspaceHandle: string) =>
		request<{ ok: boolean; nativeHistoryRetained: boolean }>(workspacePath(workspaceHandle), {
			method: "DELETE",
		}),
	activateWorkspace: (workspaceHandle: string) =>
		request<NativeWorkspaceDto>(workspacePath(workspaceHandle, "/activate"), { method: "POST" }),
	searchWorkspaceFiles: (workspaceHandle: string, query = "", signal?: AbortSignal) =>
		request<WorkspaceFileSearchDto>(workspacePath(workspaceHandle, `/files?q=${encodeURIComponent(query)}`), {
			signal,
		}),
	captureWorkspaceFile: (
		workspaceHandle: string,
		file: Pick<WorkspaceFileMetadataDto, "path" | "canonicalIdentity">,
		confirmed: boolean,
		signal?: AbortSignal,
	) => {
		if (!file.canonicalIdentity) throw new Error("Workspace file identity is unavailable");
		return request<WorkspaceFileReferenceDto>(workspacePath(workspaceHandle, "/file-references/capture"), {
			method: "POST",
			body: JSON.stringify({
				path: file.path,
				canonicalIdentity: file.canonicalIdentity,
				confirmed,
			}),
			signal,
		});
	},

	listSessions: (workspaceHandle: string, options: { force?: boolean } = {}) =>
		request<NativeSessionListDto>(
			workspacePath(workspaceHandle, `/sessions${options.force ? "?refresh=1" : ""}`),
		),
	createSession: (workspaceHandle: string) =>
		request<NativeSessionCreateDto>(workspacePath(workspaceHandle, "/sessions"), {
			method: "POST",
			body: "{}",
		}),
	deleteSession: (
		workspaceHandle: string,
		sessionHandle: string,
		management: { generation: number; fencingToken: string },
	) =>
		request<{ ok: boolean; recoverable: boolean }>(sessionPath(workspaceHandle, sessionHandle), {
			method: "DELETE",
			headers: {
				"X-Pi-Session-Generation": String(management.generation),
				"X-Pi-Fencing-Token": management.fencingToken,
			},
		}),
	abandonTransientSession: (
		workspaceHandle: string,
		sessionHandle: string,
		management: { generation: number; fencingToken: string },
	) =>
		request<{ ok: boolean; abandoned: boolean }>(sessionPath(workspaceHandle, sessionHandle, "/transient"), {
			method: "DELETE",
			headers: {
				"X-Pi-Session-Generation": String(management.generation),
				"X-Pi-Fencing-Token": management.fencingToken,
			},
		}),
	getSessionRuntime: (workspaceHandle: string, sessionHandle: string) =>
		request<SessionRuntimeDto>(sessionPath(workspaceHandle, sessionHandle, "/process")),

	authStatus: () => request<{ providers: AuthStatusEntry[] }>("/api/v1/auth/status"),
	saveApiKey: (provider: string, key: string) =>
		request<{ ok: boolean; providers: AuthStatusEntry[] }>("/api/v1/auth/keys", {
			method: "POST",
			body: JSON.stringify({ provider, key }),
		}),
};
