import type { AuthStatusEntry, SessionSummary, WorkspaceSummary } from "@pi-agent-web/server";

/** Minimal REST client for the gateway. */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		headers: { "Content-Type": "application/json" },
		...init,
	});
	if (!response.ok) {
		let message = "HTTP " + response.status;
		try {
			const body = (await response.json()) as { error?: string };
			if (body?.error) message = body.error;
		} catch {
			// keep the status message
		}
		throw new Error(message);
	}
	return (await response.json()) as T;
}

export const api = {
	listWorkspaces: () => request<WorkspaceSummary[]>("/api/v1/workspaces"),
	addWorkspace: (path: string) =>
		request<WorkspaceSummary>("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ path }) }),
	removeWorkspace: (workspaceId: string) =>
		request<{ ok: boolean }>(`/api/v1/workspaces/${workspaceId}`, { method: "DELETE" }),

	listSessions: (workspaceId: string) =>
		request<{ sessions: SessionSummary[]; sessionDir: string }>(`/api/v1/workspaces/${workspaceId}/sessions`),
	deleteSession: (workspaceId: string, sessionPath: string) =>
		request<{ ok: boolean }>(
			`/api/v1/workspaces/${workspaceId}/sessions/${encodeURIComponent(sessionPath)}`,
			{
				method: "DELETE",
			},
		),

	authStatus: () => request<{ providers: AuthStatusEntry[] }>("/api/v1/auth/status"),
	saveApiKey: (provider: string, key: string) =>
		request<{ ok: boolean; providers: AuthStatusEntry[] }>("/api/v1/auth/keys", {
			method: "POST",
			body: JSON.stringify({ provider, key }),
		}),

	restartProcess: (workspaceId: string) =>
		request<{ ok: boolean }>(`/api/v1/workspaces/${workspaceId}/process/restart`, { method: "POST" }),
};
