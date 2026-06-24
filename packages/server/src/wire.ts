/**
 * WebSocket wire contract and REST DTOs (design spec §4).
 * Types depend only on the public type exports of @earendil-works/pi-coding-agent.
 */
import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";

// ============================================================================
// WebSocket client -> server
// ============================================================================

export type WsClientMessage =
	| { type: "command"; workspaceId: string; command: RpcCommand }
	| { type: "extension_ui_response"; workspaceId: string; response: RpcExtensionUIResponse }
	| { type: "session_listen"; workspaceId: string; sessionId: string | null };

// ============================================================================
// WebSocket server -> client
// ============================================================================

export type WsServerMessage =
	| { type: "response"; workspaceId: string; response: RpcResponse }
	| { type: "event"; workspaceId: string; sessionId: string; event: JsonAgentSessionEvent }
	| { type: "extension_ui_request"; workspaceId: string; sessionId: string; request: RpcExtensionUIRequest }
	| { type: "process_status"; workspaceId: string; state: "starting" | "running" | "crashed"; error?: string }
	| { type: "session_directory_changed"; workspaceId: string }
	| { type: "auth_changed"; workspaceId: string };

// ============================================================================
// REST DTOs
// ============================================================================

export interface WorkspaceSummary {
	id: string;
	path: string;
	displayName: string;
	sessionCount: number;
	lastOpenedAt: number | null;
}

export interface SessionSummary {
	/** File name (timestamp_uuidv7.jsonl) */
	path: string;
	/** Absolute path */
	absolutePath: string;
	id: string;
	/** Custom name from a session_info entry */
	name?: string;
	cwd: string;
	messageCount: number;
	/** First user message text snippet (for empty-session placeholder and list subtitle) */
	firstMessage?: string;
	created: string;
	/** stat.mtime epoch millis (official sort key, not the filename) */
	modified: number;
	parentSessionPath?: string;
}

export interface AuthStatusEntry {
	providerId: string;
	configured: boolean;
	credentialType?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** RPC error response (success:false) */
export class RpcError extends Error {
	readonly command: string;
	constructor(command: string, message: string) {
		super(message);
		this.name = "RpcError";
		this.command = command;
	}
}

export function isErrorResponse(r: RpcResponse): r is Extract<RpcResponse, { success: false }> {
	return r.type === "response" && r.success === false;
}

/**
 * Extract data from a success response; throws RpcError on failure.
 * Returns undefined for success responses that carry no data payload
 * (prompt/steer/abort/...). Callers cast to the expected shape.
 */
export function expectData(response: RpcResponse): unknown {
	if (response.type !== "response") throw new RpcError("<no-command>", "not a response frame");
	if (response.success === false) throw new RpcError(response.command, response.error);
	return "data" in response ? (response as { data: unknown }).data : undefined;
}
