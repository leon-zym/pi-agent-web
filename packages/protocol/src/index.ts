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
	| { type: "command"; workspaceId: string; expectedSessionId: string | null; command: RpcCommand }
	| {
			type: "extension_ui_response";
			workspaceId: string;
			expectedSessionId: string | null;
			response: RpcExtensionUIResponse;
	  }
	| { type: "session_listen"; workspaceId: string; sessionId: string | null }
	| { type: "session_claim"; workspaceId: string }
	| { type: "session_release"; workspaceId: string };

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PATH_LENGTH = 8192;
const MAX_TEXT_LENGTH = 1024 * 1024;
const MAX_IMAGES = 16;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isOptionalString(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): boolean {
	return value === undefined || isString(value, maxLength);
}

function isSessionId(value: unknown): value is string | null {
	return value === null || isString(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function hasCommandPrefix(value: UnknownRecord, allowed: readonly string[]): boolean {
	return hasOnlyKeys(value, ["id", "type", ...allowed]) && isOptionalString(value.id);
}

function isImage(value: unknown): boolean {
	if (!isRecord(value) || !hasOnlyKeys(value, ["type", "data", "mimeType"])) return false;
	return value.type === "image" && isString(value.data, MAX_TEXT_LENGTH) && isString(value.mimeType, 256);
}

function isImages(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.length <= MAX_IMAGES && value.every(isImage));
}

function isPromptLikeCommand(value: UnknownRecord, allowStreamingBehavior: boolean): boolean {
	const keys = allowStreamingBehavior ? ["message", "images", "streamingBehavior"] : ["message", "images"];
	if (!hasCommandPrefix(value, keys) || !isString(value.message, MAX_TEXT_LENGTH) || !isImages(value.images))
		return false;
	return (
		!allowStreamingBehavior ||
		value.streamingBehavior === undefined ||
		value.streamingBehavior === "steer" ||
		value.streamingBehavior === "followUp"
	);
}

function isRpcCommand(value: unknown): value is RpcCommand {
	if (!isRecord(value) || !isString(value.type, 64)) return false;

	switch (value.type) {
		case "prompt":
			return isPromptLikeCommand(value, true);
		case "steer":
		case "follow_up":
			return isPromptLikeCommand(value, false);
		case "abort":
		case "cycle_model":
		case "get_available_models":
		case "cycle_thinking_level":
		case "get_available_thinking_levels":
		case "abort_retry":
		case "abort_bash":
		case "get_session_stats":
		case "clone":
		case "get_fork_messages":
		case "get_tree":
		case "get_last_assistant_text":
		case "get_messages":
		case "get_commands":
		case "get_state":
			return hasCommandPrefix(value, []);
		case "new_session":
			return (
				hasCommandPrefix(value, ["parentSession"]) && isOptionalString(value.parentSession, MAX_PATH_LENGTH)
			);
		case "set_model":
			return (
				hasCommandPrefix(value, ["provider", "modelId"]) &&
				isString(value.provider) &&
				isString(value.modelId)
			);
		case "set_thinking_level":
			return hasCommandPrefix(value, ["level"]) && isString(value.level, 64);
		case "set_steering_mode":
		case "set_follow_up_mode":
			return hasCommandPrefix(value, ["mode"]) && (value.mode === "all" || value.mode === "one-at-a-time");
		case "compact":
			return (
				hasCommandPrefix(value, ["customInstructions"]) &&
				isOptionalString(value.customInstructions, MAX_TEXT_LENGTH)
			);
		case "set_auto_compaction":
		case "set_auto_retry":
			return hasCommandPrefix(value, ["enabled"]) && typeof value.enabled === "boolean";
		case "bash":
			return (
				hasCommandPrefix(value, ["command", "excludeFromContext"]) &&
				isString(value.id) &&
				isString(value.command, MAX_TEXT_LENGTH) &&
				(value.excludeFromContext === undefined || typeof value.excludeFromContext === "boolean")
			);
		case "export_html":
			return hasCommandPrefix(value, ["outputPath"]) && isOptionalString(value.outputPath, MAX_PATH_LENGTH);
		case "switch_session":
			return hasCommandPrefix(value, ["sessionPath"]) && isString(value.sessionPath, MAX_PATH_LENGTH);
		case "fork":
			return hasCommandPrefix(value, ["entryId"]) && isString(value.entryId);
		case "get_entries":
			return hasCommandPrefix(value, ["since"]) && isOptionalString(value.since);
		case "set_session_name":
			return hasCommandPrefix(value, ["name"]) && isString(value.name, MAX_IDENTIFIER_LENGTH);
		default:
			return false;
	}
}

function isExtensionUiResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value) || value.type !== "extension_ui_response" || !isString(value.id)) return false;
	const variants = [
		value.value !== undefined &&
			hasOnlyKeys(value, ["type", "id", "value"]) &&
			isString(value.value, MAX_TEXT_LENGTH),
		value.confirmed !== undefined &&
			hasOnlyKeys(value, ["type", "id", "confirmed"]) &&
			typeof value.confirmed === "boolean",
		value.cancelled === true && hasOnlyKeys(value, ["type", "id", "cancelled"]),
	];
	return variants.some(Boolean);
}

/** Validate every browser-to-gateway frame before it reaches Pi. */
export function isWsClientMessage(value: unknown): value is WsClientMessage {
	if (!isRecord(value) || !isString(value.type, 64) || !isString(value.workspaceId)) return false;

	switch (value.type) {
		case "command":
			return (
				hasOnlyKeys(value, ["type", "workspaceId", "expectedSessionId", "command"]) &&
				isSessionId(value.expectedSessionId) &&
				isRpcCommand(value.command)
			);
		case "extension_ui_response":
			return (
				hasOnlyKeys(value, ["type", "workspaceId", "expectedSessionId", "response"]) &&
				isSessionId(value.expectedSessionId) &&
				isExtensionUiResponse(value.response)
			);
		case "session_listen":
			return (
				hasOnlyKeys(value, ["type", "workspaceId", "sessionId"]) &&
				(value.sessionId === null || isString(value.sessionId))
			);
		case "session_claim":
		case "session_release":
			return hasOnlyKeys(value, ["type", "workspaceId"]);
		default:
			return false;
	}
}

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

/**
 * Gateway command deadlines. Pi owns execution; these bounds only prevent an
 * unresponsive process from holding a browser request forever.
 */
export const COMMAND_TIMEOUT_MS = {
	default: 30_000,
	prompt: 120_000,
	steer: 120_000,
	followUp: 120_000,
	abort: 90_000,
	compact: 120_000,
	exportHtml: 120_000,
} as const;

export function commandTimeoutMs(commandType: string): number {
	switch (commandType) {
		case "prompt":
			return COMMAND_TIMEOUT_MS.prompt;
		case "steer":
			return COMMAND_TIMEOUT_MS.steer;
		case "follow_up":
			return COMMAND_TIMEOUT_MS.followUp;
		case "abort":
			return COMMAND_TIMEOUT_MS.abort;
		case "compact":
			return COMMAND_TIMEOUT_MS.compact;
		case "export_html":
			return COMMAND_TIMEOUT_MS.exportHtml;
		default:
			return COMMAND_TIMEOUT_MS.default;
	}
}

export type WsServerMessage =
	| { type: "response"; workspaceId: string; response: RpcResponse }
	| { type: "event"; workspaceId: string; sessionId: string; epoch: number; event: PiWebSessionEvent }
	| {
			type: "extension_ui_request";
			workspaceId: string;
			sessionId: string;
			epoch: number;
			request: RpcExtensionUIRequest;
	  }
	| { type: "process_status"; workspaceId: string; state: "starting" | "running" | "crashed"; error?: string }
	| { type: "lease_status"; workspaceId: string; isController: boolean }
	| {
			type: "session_state";
			workspaceId: string;
			sessionId: string | null;
			sessionFile: string | null;
			epoch: number;
	  }
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
