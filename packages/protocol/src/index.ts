/**
 * Browser-safe WebSocket and REST DTOs shared by the gateway and UI.
 * This package deliberately depends only on public Pi protocol type exports.
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

/**
 * extension_error is emitted directly on stdout by rpc-mode.ts, not through
 * the session event bus, so it is a wire event of its own kind.
 */
export interface ExtensionErrorEvent {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

export type PiWebSessionEvent = JsonAgentSessionEvent | ExtensionErrorEvent;

export type WsServerMessage =
	| { type: "response"; workspaceId: string; response: RpcResponse }
	| { type: "event"; workspaceId: string; sessionId: string; event: PiWebSessionEvent }
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
	/** File name, timestamp_uuidv7.jsonl. */
	path: string;
	/** Absolute path. */
	absolutePath: string;
	id: string;
	/** Custom name from a session_info entry. */
	name?: string;
	cwd: string;
	messageCount: number;
	/** First user message text snippet, used for empty-session placeholder and list subtitle. */
	firstMessage?: string;
	created: string;
	/** stat.mtime epoch millis, the official sort key. */
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

/** RPC error response, success:false. */
export class RpcError extends Error {
	readonly command: string;
	constructor(command: string, message: string) {
		super(message);
		this.name = "RpcError";
		this.command = command;
	}
}

export function isErrorResponse(response: RpcResponse): response is Extract<RpcResponse, { success: false }> {
	return response.type === "response" && response.success === false;
}

/**
 * Extract data from a success response and throw RpcError on a failed response.
 * Responses without a data payload return undefined.
 */
export function expectData(response: RpcResponse): unknown {
	if (response.type !== "response") throw new RpcError("<no-command>", "not a response frame");
	if (response.success === false) throw new RpcError(response.command, response.error);
	return "data" in response ? (response as { data: unknown }).data : undefined;
}
