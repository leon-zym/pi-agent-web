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

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PATH_LENGTH = 8192;
export const SESSION_TEXT_MAX_BYTES = 1024 * 1024;
export const SESSION_WS_CLIENT_MAX_BYTES = 8 * 1024 * 1024;
export const SESSION_IMAGE_MAX_COUNT = 16;
export const SESSION_IMAGE_MAX_BASE64_CHARS = 2 * 1024 * 1024;
export const SESSION_IMAGE_TOTAL_MAX_BASE64_CHARS = 6 * 1024 * 1024;

const UTF8_ENCODER = new TextEncoder();

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

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && UTF8_ENCODER.encode(value).byteLength <= maxLength;
}

/** Exact UTF-8 wire size used by browser WebSocket text frames. */
export function sessionWsClientMessageBytes(value: unknown): number {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string"
			? UTF8_ENCODER.encode(serialized).byteLength
			: Number.POSITIVE_INFINITY;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function hasCommandPrefix(value: UnknownRecord, allowed: readonly string[]): boolean {
	return hasOnlyKeys(value, ["id", "type", ...allowed]) && isOptionalString(value.id);
}

function isImage(value: unknown): boolean {
	if (!isRecord(value) || !hasOnlyKeys(value, ["type", "data", "mimeType"])) return false;
	return (
		value.type === "image" &&
		isString(value.data, SESSION_IMAGE_MAX_BASE64_CHARS) &&
		isString(value.mimeType, 256)
	);
}

function isImages(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.length <= SESSION_IMAGE_MAX_COUNT &&
			value.every(isImage) &&
			value.reduce((total, image) => total + (image as { data: string }).data.length, 0) <=
				SESSION_IMAGE_TOTAL_MAX_BASE64_CHARS)
	);
}

function isPromptLikeCommand(value: UnknownRecord, allowStreamingBehavior: boolean): boolean {
	const keys = allowStreamingBehavior ? ["message", "images", "streamingBehavior"] : ["message", "images"];
	if (
		!hasCommandPrefix(value, keys) ||
		!isBoundedString(value.message, SESSION_TEXT_MAX_BYTES) ||
		!isImages(value.images)
	)
		return false;
	if (value.message.length === 0 && (!Array.isArray(value.images) || value.images.length === 0)) return false;
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
				(value.customInstructions === undefined ||
					(typeof value.customInstructions === "string" &&
						value.customInstructions.length > 0 &&
						isBoundedString(value.customInstructions, SESSION_TEXT_MAX_BYTES)))
			);
		case "set_auto_compaction":
		case "set_auto_retry":
			return hasCommandPrefix(value, ["enabled"]) && typeof value.enabled === "boolean";
		case "bash":
			return (
				hasCommandPrefix(value, ["command", "excludeFromContext"]) &&
				isString(value.id) &&
				typeof value.command === "string" &&
				value.command.length > 0 &&
				isBoundedString(value.command, SESSION_TEXT_MAX_BYTES) &&
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
			isBoundedString(value.value, SESSION_TEXT_MAX_BYTES),
		value.confirmed !== undefined &&
			hasOnlyKeys(value, ["type", "id", "confirmed"]) &&
			typeof value.confirmed === "boolean",
		value.cancelled === true && hasOnlyKeys(value, ["type", "id", "cancelled"]),
	];
	return variants.some(Boolean);
}

// ============================================================================
// Session runtime WebSocket protocol
// ============================================================================

export interface SessionReplayCursorDto {
	generation: number;
	seq: number;
}

export type SessionWsClientMessage =
	| {
			type: "command";
			sessionHandle: string;
			expectedGeneration: number;
			fencingToken?: string;
			command: RpcCommand;
	  }
	| {
			type: "extension_ui_response";
			sessionHandle: string;
			expectedGeneration: number;
			fencingToken: string;
			response: RpcExtensionUIResponse;
	  }
	| { type: "session_subscribe"; sessionHandle: string; cursor?: SessionReplayCursorDto }
	| { type: "session_unsubscribe"; sessionHandle: string }
	| { type: "session_claim"; sessionHandle: string }
	| { type: "session_release"; sessionHandle: string };

function isGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isReplayCursor(value: unknown): value is SessionReplayCursorDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["generation", "seq"]) &&
		isGeneration(value.generation) &&
		isGeneration(value.seq)
	);
}

/** Strictly validate every Session browser frame before it reaches a runtime. */
export function isSessionWsClientMessage(value: unknown): value is SessionWsClientMessage {
	if (!isRecord(value) || !isString(value.type, 64) || !isString(value.sessionHandle)) return false;
	if (sessionWsClientMessageBytes(value) > SESSION_WS_CLIENT_MAX_BYTES) return false;

	switch (value.type) {
		case "command":
			return (
				hasOnlyKeys(value, ["type", "sessionHandle", "expectedGeneration", "fencingToken", "command"]) &&
				isGeneration(value.expectedGeneration) &&
				isOptionalString(value.fencingToken) &&
				isRpcCommand(value.command)
			);
		case "extension_ui_response":
			return (
				hasOnlyKeys(value, ["type", "sessionHandle", "expectedGeneration", "fencingToken", "response"]) &&
				isGeneration(value.expectedGeneration) &&
				isString(value.fencingToken) &&
				isExtensionUiResponse(value.response)
			);
		case "session_subscribe":
			return (
				hasOnlyKeys(value, ["type", "sessionHandle", "cursor"]) &&
				(value.cursor === undefined || isReplayCursor(value.cursor))
			);
		case "session_unsubscribe":
		case "session_claim":
		case "session_release":
			return hasOnlyKeys(value, ["type", "sessionHandle"]);
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

/** RPC reads that never require a controller lease. Keep this policy shared by gateway and browser. */
export const READ_ONLY_RPC_COMMAND_TYPES: ReadonlySet<string> = new Set([
	"get_available_models",
	"get_available_thinking_levels",
	"get_commands",
	"get_entries",
	"get_fork_messages",
	"get_last_assistant_text",
	"get_messages",
	"get_session_stats",
	"get_state",
	"get_tree",
]);

export function isReadOnlyRpcCommand(command: Pick<RpcCommand, "type"> | string): boolean {
	return READ_ONLY_RPC_COMMAND_TYPES.has(typeof command === "string" ? command : command.type);
}

export type SessionRuntimeStateDto = "starting" | "idle" | "running" | "waiting_ui" | "crashed" | "dormant";

export interface SessionRuntimeDto {
	sessionHandle: string;
	workspaceId: string;
	nativeSessionId: string;
	sessionFile: string | null;
	cwd: string;
	generation: number;
	lastSeq: number;
	state: SessionRuntimeStateDto;
	lastActivityAt: number;
	recoverable: boolean;
	error?: string;
}

interface SessionServerEnvelopeBase {
	sessionHandle: string;
	workspaceId: string;
	generation: number;
	seq: number;
}

export type SessionReplayFrameDto =
	| (SessionServerEnvelopeBase & { type: "event"; event: PiWebSessionEvent })
	| (SessionServerEnvelopeBase & {
			type: "extension_ui_request";
			request: RpcExtensionUIRequest;
	  })
	| (SessionServerEnvelopeBase & {
			type: "extension_ui_closed";
			requestId: string;
			reason: "answered" | "cancelled" | "expired" | "process_lost" | "replaced";
	  });

export type SessionWsServerMessage =
	| {
			type: "response";
			sessionHandle: string;
			generation: number;
			barrierSeq: number;
			response: RpcResponse;
			previousSessionHandle?: string;
	  }
	| SessionReplayFrameDto
	| { type: "runtime_state"; runtime: SessionRuntimeDto }
	| {
			type: "lease_status";
			sessionHandle: string;
			isController: boolean;
			fencingToken?: string;
	  }
	| {
			type: "resync_required";
			sessionHandle: string;
			runtime: SessionRuntimeDto;
			reason: "initial" | "generation_changed" | "gap" | "invalid_cursor";
	  }
	| {
			type: "extension_ui_snapshot";
			sessionHandle: string;
			generation: number;
			requests: RpcExtensionUIRequest[];
	  }
	| {
			type: "extension_ui_result";
			sessionHandle: string;
			generation: number;
			requestId: string;
			outcome: "accepted" | "no_dialog" | "not_running";
	  }
	| {
			type: "session_rekeyed";
			previousSessionHandle: string;
			runtime: SessionRuntimeDto;
	  }
	| {
			type: "session_error";
			sessionHandle: string;
			operation: "subscribe" | "claim" | "release" | "extension_ui_response";
			error: string;
	  }
	| { type: "session_directory_changed"; workspaceId: string }
	| { type: "auth_changed"; workspaceId?: string };

function isSessionRuntimeDto(value: unknown): value is SessionRuntimeDto {
	if (!isRecord(value)) return false;
	return (
		isString(value.sessionHandle) &&
		isString(value.workspaceId) &&
		isString(value.nativeSessionId) &&
		(value.sessionFile === null || typeof value.sessionFile === "string") &&
		isString(value.cwd, MAX_PATH_LENGTH) &&
		isGeneration(value.generation) &&
		isGeneration(value.lastSeq) &&
		["starting", "idle", "running", "waiting_ui", "crashed", "dormant"].includes(String(value.state)) &&
		typeof value.lastActivityAt === "number" &&
		Number.isFinite(value.lastActivityAt) &&
		typeof value.recoverable === "boolean" &&
		(value.error === undefined || typeof value.error === "string")
	);
}

function hasSessionEnvelope(value: UnknownRecord): boolean {
	return (
		isString(value.sessionHandle) &&
		isString(value.workspaceId) &&
		isGeneration(value.generation) &&
		isGeneration(value.seq)
	);
}

function isExtensionUiRequestShallow(value: unknown): value is RpcExtensionUIRequest {
	return (
		isRecord(value) &&
		value.type === "extension_ui_request" &&
		isString(value.id) &&
		isString(value.method, 64)
	);
}

/** Validate gateway-to-browser Session frames before they enter UI state. */
export function isSessionWsServerMessage(value: unknown): value is SessionWsServerMessage {
	if (!isRecord(value) || !isString(value.type, 64)) return false;
	switch (value.type) {
		case "runtime_state":
			return isSessionRuntimeDto(value.runtime);
		case "session_rekeyed":
			return isString(value.previousSessionHandle) && isSessionRuntimeDto(value.runtime);
		case "session_directory_changed":
			return isString(value.workspaceId);
		case "auth_changed":
			return value.workspaceId === undefined || isString(value.workspaceId);
		case "event":
			return hasSessionEnvelope(value) && isRecord(value.event) && isString(value.event.type, 64);
		case "extension_ui_request":
			return hasSessionEnvelope(value) && isExtensionUiRequestShallow(value.request);
		case "extension_ui_closed":
			return (
				hasSessionEnvelope(value) &&
				isString(value.requestId) &&
				["answered", "cancelled", "expired", "process_lost", "replaced"].includes(String(value.reason))
			);
		case "response":
			return (
				isString(value.sessionHandle) &&
				isGeneration(value.generation) &&
				isGeneration(value.barrierSeq) &&
				isRecord(value.response) &&
				value.response.type === "response" &&
				(value.response.id === undefined || isString(value.response.id)) &&
				isString(value.response.command, 64) &&
				typeof value.response.success === "boolean"
			);
		case "lease_status":
			return (
				isString(value.sessionHandle) &&
				typeof value.isController === "boolean" &&
				(value.fencingToken === undefined || isString(value.fencingToken))
			);
		case "resync_required":
			return (
				isString(value.sessionHandle) &&
				isSessionRuntimeDto(value.runtime) &&
				["initial", "generation_changed", "gap", "invalid_cursor"].includes(String(value.reason))
			);
		case "extension_ui_snapshot":
			return (
				isString(value.sessionHandle) &&
				isGeneration(value.generation) &&
				Array.isArray(value.requests) &&
				value.requests.every(isExtensionUiRequestShallow)
			);
		case "extension_ui_result":
			return (
				isString(value.sessionHandle) &&
				isGeneration(value.generation) &&
				isString(value.requestId) &&
				["accepted", "no_dialog", "not_running"].includes(String(value.outcome))
			);
		case "session_error":
			return (
				isString(value.sessionHandle) &&
				["subscribe", "claim", "release", "extension_ui_response"].includes(String(value.operation)) &&
				typeof value.error === "string"
			);
		default:
			return false;
	}
}

// ============================================================================
// REST DTOs
// ============================================================================

export interface AuthStatusEntry {
	providerId: string;
	configured: boolean;
	credentialType?: string;
}

/** A Workspace projected from Pi Session headers plus optional presentation preferences. */
export interface NativeWorkspaceDto {
	workspaceHandle: string;
	path: string | null;
	available: boolean;
	unavailableReason?: string;
	pinned: boolean;
	displayName: string;
	lastOpenedAt: number | null;
	sessionCount: number;
	hasNativeHistory: boolean;
}

/** Stable Session directory entry keyed by canonical Pi JSONL identity. */
export interface NativeSessionDto {
	sessionHandle: string;
	workspaceHandle: string;
	nativeSessionId: string;
	sessionFile: string | null;
	persisted: boolean;
	name?: string;
	parentSessionFile?: string;
	createdAt: string | null;
	modifiedAt: string | null;
	messageCount: number;
	firstMessage: string;
	runtime: SessionRuntimeDto | null;
}

export interface NativeSessionListDto {
	sessions: NativeSessionDto[];
	layout: {
		sessionDir: string;
		source: "environment" | "global-settings" | "project-settings" | "default";
	} | null;
}

export interface NativeSessionCreateDto {
	session: NativeSessionDto;
	runtime: SessionRuntimeDto;
	layout: NonNullable<NativeSessionListDto["layout"]>;
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
