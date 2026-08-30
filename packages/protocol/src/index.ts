/** Browser-safe, product-owned WebSocket and REST DTOs shared by the gateway and UI. */

import { PRODUCT_RUNTIME_SCHEMAS } from "./boundary-schemas.js";
import {
	isFutureExtensionUiRequestDto,
	isFutureProductSessionEventDto,
	isFutureSessionCommandResponseDto,
	isFutureSessionMessageDto,
} from "./future-product-decoders.js";
import type {
	FutureBlockingExtensionUiRequestDto,
	FutureExtensionUiRequestDto,
	FutureProductSessionEventDto,
	FutureSessionCommandResponseDto,
	FutureSessionMessageDto,
	FutureStickyExtensionUiRequestDto,
} from "./future-product-dto.js";
import {
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	GATEWAY_PROTOCOL_VERSION,
	type GatewayClientHelloDto,
	type GatewayServerHelloDto,
} from "./gateway-handshake.js";
import {
	SESSION_IMAGE_MAX_BASE64_CHARS,
	SESSION_IMAGE_MAX_COUNT,
	SESSION_IMAGE_TOTAL_MAX_BASE64_CHARS,
	SESSION_SNAPSHOT_MAX_BYTES,
	SESSION_TEXT_MAX_BYTES,
	SESSION_WS_CLIENT_MAX_BYTES,
	SESSION_WS_SERVER_MAX_BYTES,
	type SessionPayloadAdmissionErrorDto,
} from "./payload-budget.js";
import {
	type FutureSessionContentRefGuardContext,
	isExtensionUiRequestDto,
	isExtensionUiResponseDto,
	isFutureSessionContentRefGuardContext,
	isProductSessionEventDto,
	isSessionAttachmentGuardContext,
	isSessionCommandResponseDto,
	isSessionMessageDto,
	type SessionAttachmentGuardContext,
} from "./product-decoders.js";
import type {
	ExtensionUiRequestDto,
	ExtensionUiResponseDto,
	ProductSessionEventDto,
	SessionCommandDataMap,
	SessionCommandDto,
	SessionCommandResponseDto,
	SessionCommandTypeDto,
	SessionMessageDto,
} from "./product-dto.js";
import {
	isSessionHistoryChecksum,
	SESSION_HISTORY_MAX_CHUNK_BYTES,
	SESSION_HISTORY_MAX_CHUNK_MESSAGES,
	SESSION_HISTORY_MAX_CURSOR_BYTES,
	SESSION_HISTORY_MAX_MESSAGES,
	SESSION_HISTORY_MAX_SNAPSHOT_ID_BYTES,
	SESSION_HISTORY_MAX_STREAM_BYTES,
	SESSION_HISTORY_MAX_TOTAL_BYTES,
	sessionHistoryChecksum,
	sessionHistoryMessagesBytes,
} from "./session-history.js";

export * from "./boundary-schemas.js";
export * from "./future-logical-bytes.js";
export * from "./future-product-decoders.js";
export * from "./future-product-dto.js";
export * from "./gateway-handshake.js";
export * from "./payload-budget.js";
export * from "./product-decoders.js";
export * from "./product-dto.js";
export * from "./session-history.js";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PATH_LENGTH = 8192;
export const SESSION_SNAPSHOT_MAX_MESSAGES = 10_000;
export const SESSION_SNAPSHOT_MAX_PROJECTION_EVENTS = 4_096;
export const SESSION_SNAPSHOT_MAX_QUEUE_ITEMS = 10_000;
export const SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS = 256;
export const SESSION_SNAPSHOT_MAX_DEPTH = 48;
export const SESSION_SNAPSHOT_MAX_ITEMS = 250_000;
export const SESSION_HOT_RUNTIME_INVENTORY_MAX_ITEMS = 256;
export const SESSION_RUNTIME_BUSY_REASON_MAX_ITEMS = 8;
/** Covers the worst canonical JSON envelope for 256 maximum escaped identities. */
export const SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES = 1024 * 1024;

/**
 * Subscribe failures that may succeed after pressure, identity, or workspace
 * state changes. The Gateway publishes this decision with each Session error
 * so clients do not have to infer it from human-readable text.
 */
export const SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES = [
	"session_subscription_capacity",
	"session_catchup_capacity",
	"too_many_in_flight_exact_subscriptions",
	"session_runtime_capacity",
	"session_projection_capacity",
	"session_snapshot_unavailable",
	"session_snapshot_headroom_unavailable",
	"hot_runtime_identity_changed",
	"expected_hot_runtime_rekeyed",
	"generation_changed",
	"server_epoch_changed",
	"workspace_identity_transitioning",
] as const;
export type SessionSubscriptionRetryableErrorCodeDto =
	(typeof SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES)[number];

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

/** Exact UTF-8 wire size used by Gateway-to-browser JSON text frames. */
export function sessionWsServerMessageBytes(value: unknown): number {
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

function hasOwnProperties(value: UnknownRecord, required: readonly string[]): boolean {
	return required.every((key) => Object.hasOwn(value, key));
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

function isRpcCommand(value: unknown): value is SessionCommandDto {
	if (!PRODUCT_RUNTIME_SCHEMAS.command.check(value)) return false;
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
			return (
				hasCommandPrefix(value, ["level"]) &&
				["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.level))
			);
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

// ============================================================================
// Session runtime WebSocket protocol
// ============================================================================

export interface SessionReplayCursorDto {
	serverEpoch: string;
	generation: number;
	seq: number;
}

export type SessionWsClientMessage =
	| {
			type: "command";
			sessionHandle: string;
			expectedGeneration: number;
			fencingToken?: string;
			command: SessionCommandDto;
	  }
	| {
			type: "extension_ui_response";
			sessionHandle: string;
			expectedGeneration: number;
			fencingToken: string;
			response: ExtensionUiResponseDto;
	  }
	| {
			type: "session_subscribe";
			sessionHandle: string;
			cursor?: SessionReplayCursorDto;
			expectedHotRuntime?: SessionRuntimeIdentityDto;
	  }
	| {
			type: "session_history_page";
			id: string;
			sessionHandle: string;
			expectedGeneration: number;
			snapshotId: string;
			asOfSeq: number;
			cursor: string;
			limit?: number;
	  }
	| {
			type: "session_history_cancel";
			id: string;
			sessionHandle: string;
			expectedGeneration: number;
			snapshotId: string;
	  }
	| { type: "session_unsubscribe"; sessionHandle: string }
	| { type: "session_claim"; sessionHandle: string }
	| { type: "session_release"; sessionHandle: string }
	| {
			type: "session_restart";
			sessionHandle: string;
			expectedGeneration: number;
			fencingToken?: string;
	  };

function isGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isSessionReplayCursorDto(value: unknown): value is SessionReplayCursorDto {
	return (
		isRecord(value) &&
		hasOwnProperties(value, ["serverEpoch", "generation", "seq"]) &&
		hasOnlyKeys(value, ["serverEpoch", "generation", "seq"]) &&
		isString(value.serverEpoch, 128) &&
		isGeneration(value.generation) &&
		isGeneration(value.seq)
	);
}

/** Strictly validate every Session browser frame before it reaches a runtime. */
export function isSessionWsClientMessage(value: unknown): value is SessionWsClientMessage {
	if (!PRODUCT_RUNTIME_SCHEMAS.wsClient.check(value)) return false;
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
				isExtensionUiResponseDto(value.response)
			);
		case "session_subscribe":
			if (!isSessionSubscribeMessage(value)) return false;
			if (value.expectedHotRuntime === undefined) return true;
			return isCanonicalSessionSubscribeMessage(value);
		case "session_history_page":
			return (
				hasOnlyKeys(value, [
					"type",
					"id",
					"sessionHandle",
					"expectedGeneration",
					"snapshotId",
					"asOfSeq",
					"cursor",
					"limit",
				]) &&
				isString(value.id) &&
				isGeneration(value.expectedGeneration) &&
				isString(value.snapshotId, SESSION_HISTORY_MAX_SNAPSHOT_ID_BYTES) &&
				isGeneration(value.asOfSeq) &&
				isHistoryCursor(value.cursor) &&
				value.cursor !== null &&
				(value.limit === undefined ||
					(typeof value.limit === "number" &&
						Number.isSafeInteger(value.limit) &&
						value.limit > 0 &&
						value.limit <= SESSION_HISTORY_MAX_CHUNK_MESSAGES))
			);
		case "session_history_cancel":
			return (
				hasOnlyKeys(value, ["type", "id", "sessionHandle", "expectedGeneration", "snapshotId"]) &&
				isString(value.id) &&
				isGeneration(value.expectedGeneration) &&
				isString(value.snapshotId, SESSION_HISTORY_MAX_SNAPSHOT_ID_BYTES)
			);
		case "session_unsubscribe":
		case "session_claim":
		case "session_release":
			return hasOnlyKeys(value, ["type", "sessionHandle"]);
		case "session_restart":
			return (
				hasOnlyKeys(value, ["type", "sessionHandle", "expectedGeneration", "fencingToken"]) &&
				isGeneration(value.expectedGeneration) &&
				isOptionalString(value.fencingToken)
			);
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

export type PiWebSessionEvent = ProductSessionEventDto;

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

export function isReadOnlyRpcCommand(command: Pick<SessionCommandDto, "type"> | string): boolean {
	return READ_ONLY_RPC_COMMAND_TYPES.has(typeof command === "string" ? command : command.type);
}

export type SessionRuntimeStateDto = "starting" | "idle" | "running" | "waiting_ui" | "crashed" | "dormant";

/** Operational phase used for resource admission; unlike state, it cannot hide in-flight work. */
export type SessionRuntimePhaseDto = "starting" | "ready" | "busy" | "waiting_ui" | "crashed" | "dormant";

export type SessionRuntimeBusyReasonDto =
	| "starting"
	| "command"
	| "agent"
	| "compaction"
	| "queue"
	| "dialog"
	| "turn_reservation"
	| "transition";

export type HotRuntimePhaseDto = Extract<
	SessionRuntimePhaseDto,
	"starting" | "ready" | "busy" | "waiting_ui"
>;

export interface SessionRuntimeIdentityDto {
	serverEpoch: string;
	sessionHandle: string;
	workspaceId: string;
	generation: number;
}

export type HotRuntimeStateDto = Extract<
	SessionRuntimeStateDto,
	"starting" | "idle" | "running" | "waiting_ui"
>;

export interface HotRuntimeInventoryEntryDto extends SessionRuntimeIdentityDto {
	state: HotRuntimeStateDto;
	phase?: HotRuntimePhaseDto;
	operationCount?: number;
	busyReasons?: SessionRuntimeBusyReasonDto[];
}

export interface HotRuntimeInventoryDto {
	type: "hot_runtime_inventory";
	serverEpoch: string;
	revision: number;
	runtimes: HotRuntimeInventoryEntryDto[];
}

export type HotRuntimeInventoryNegotiation =
	| { negotiated: true }
	| {
			negotiated: false;
			reason:
				| "protocol_major_unsupported"
				| "protocol_minor_unsupported"
				| "protocol_selection_invalid"
				| "capability_missing"
				| "gateway_capability_missing"
				| "server_frame_selection_invalid"
				| "server_frame_limit_too_small";
	  };

export function negotiateHotRuntimeInventory(
	clientHello: GatewayClientHelloDto,
	serverHello: GatewayServerHelloDto,
): HotRuntimeInventoryNegotiation {
	if (
		clientHello.protocol.major !== GATEWAY_PROTOCOL_VERSION.major ||
		serverHello.protocol.major !== GATEWAY_PROTOCOL_VERSION.major
	) {
		return { negotiated: false, reason: "protocol_major_unsupported" };
	}
	if (clientHello.protocol.minor < 1 || serverHello.protocol.minor < 1) {
		return { negotiated: false, reason: "protocol_minor_unsupported" };
	}
	if (serverHello.protocol.minor !== Math.min(clientHello.protocol.minor, GATEWAY_PROTOCOL_VERSION.minor)) {
		return { negotiated: false, reason: "protocol_selection_invalid" };
	}
	if (!clientHello.capabilities.includes(GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY)) {
		return { negotiated: false, reason: "capability_missing" };
	}
	if (!serverHello.capabilities.includes(GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY)) {
		return { negotiated: false, reason: "gateway_capability_missing" };
	}
	if (serverHello.limits.maxSnapshotFrameBytes > clientHello.limits.maxServerFrameBytes) {
		return { negotiated: false, reason: "server_frame_selection_invalid" };
	}
	if (
		clientHello.limits.maxServerFrameBytes < SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES ||
		serverHello.limits.maxSnapshotFrameBytes < SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES
	) {
		return { negotiated: false, reason: "server_frame_limit_too_small" };
	}
	return { negotiated: true };
}

export interface SessionRuntimeDto extends SessionRuntimeIdentityDto {
	nativeSessionId: string;
	sessionFile: string | null;
	cwd: string;
	lastSeq: number;
	state: SessionRuntimeStateDto;
	phase?: SessionRuntimePhaseDto;
	operationCount?: number;
	busyReasons?: SessionRuntimeBusyReasonDto[];
	lastActivityAt: number;
	recoverable: boolean;
	error?: string;
}

export interface SessionSequencedEnvelopeDto extends SessionRuntimeIdentityDto {
	seq: number;
}

export type SessionReplayFrameDto =
	| (SessionSequencedEnvelopeDto & { type: "event"; event: PiWebSessionEvent })
	| (SessionSequencedEnvelopeDto & {
			type: "extension_ui_request";
			request: ExtensionUiRequestDto;
	  })
	| (SessionSequencedEnvelopeDto & {
			type: "extension_ui_closed";
			requestId: string;
			reason: "answered" | "cancelled" | "expired" | "process_lost" | "replaced";
	  });

export type SessionProjectionEventDto = Extract<SessionReplayFrameDto, { type: "event" }>;

export type BlockingExtensionUiRequestDto = Extract<
	ExtensionUiRequestDto,
	{ method: "select" | "confirm" | "input" | "editor" }
>;

export type StickyExtensionUiRequestDto = Extract<
	ExtensionUiRequestDto,
	{ method: "setStatus" | "setWidget" | "setTitle" | "set_editor_text" }
>;

/**
 * One bounded, atomic live projection at `asOfSeq`.
 *
 * Controller lease/fencing state is connection-local and notifications are
 * ephemeral, so neither is part of this Session snapshot.
 */
export interface SessionSnapshotDto extends SessionRuntimeIdentityDto {
	type: "session_snapshot";
	snapshotId: string;
	baseSeq: number;
	asOfSeq: number;
	runtime: SessionRuntimeDto;
	settledMessages: SessionMessageDto[];
	projectionEvents: SessionProjectionEventDto[];
	queue: {
		steering: string[];
		followUp: string[];
	};
	pendingExtensionRequests: BlockingExtensionUiRequestDto[];
	stickyExtensionState: StickyExtensionUiRequestDto[];
}

export interface SessionHistoryMetadataDto {
	totalMessages: number;
	loadedMessages: number;
	loadedBytes: number;
	totalBytes: number;
	nextCursor: string | null;
}

/** The non-payload portion of a chunked authoritative snapshot. */
export interface SessionSnapshotBeginDto extends Omit<SessionSnapshotDto, "type" | "settledMessages"> {
	type: "session_snapshot_begin";
	history: SessionHistoryMetadataDto;
}

export interface SessionSnapshotChunkDto extends SessionRuntimeIdentityDto {
	type: "session_snapshot_chunk";
	snapshotId: string;
	chunkIndex: number;
	messages: SessionMessageDto[];
	itemCount: number;
	byteCount: number;
	checksum: string;
}

export interface SessionSnapshotEndDto extends SessionRuntimeIdentityDto {
	type: "session_snapshot_end";
	snapshotId: string;
	chunkCount: number;
	itemCount: number;
	byteCount: number;
	checksum: string;
	nextCursor: string | null;
}

export interface SessionHistoryPageBeginDto extends SessionRuntimeIdentityDto {
	type: "session_history_page_begin";
	requestId: string;
	snapshotId: string;
	asOfSeq: number;
	cursor: string;
	history: SessionHistoryMetadataDto;
}

export interface SessionHistoryPageChunkDto extends SessionRuntimeIdentityDto {
	type: "session_history_page_chunk";
	requestId: string;
	snapshotId: string;
	chunkIndex: number;
	messages: SessionMessageDto[];
	itemCount: number;
	byteCount: number;
	checksum: string;
}

export interface SessionHistoryPageEndDto extends SessionRuntimeIdentityDto {
	type: "session_history_page_end";
	requestId: string;
	snapshotId: string;
	chunkCount: number;
	itemCount: number;
	byteCount: number;
	checksum: string;
	nextCursor: string | null;
}

export interface SessionResponseFrameDto {
	type: "response";
	serverEpoch: string;
	sessionHandle: string;
	generation: number;
	barrierSeq: number;
	response: SessionCommandResponseDto;
	previousSessionHandle?: string;
}

export interface SessionLeaseStatusDto {
	type: "lease_status";
	serverEpoch: string;
	sessionHandle: string;
	generation: number;
	isController: boolean;
	fencingToken?: string;
}

export type SessionResyncReasonDto =
	| "initial"
	| "epoch_changed"
	| "generation_changed"
	| "gap"
	| "invalid_cursor";

export interface SessionResyncRequiredDto {
	type: "resync_required";
	serverEpoch: string;
	sessionHandle: string;
	runtime: SessionRuntimeDto;
	reason: SessionResyncReasonDto;
}

export interface SessionRekeyedDto {
	type: "session_rekeyed";
	serverEpoch: string;
	previousSessionHandle: string;
	runtime: SessionRuntimeDto;
}

export interface SessionErrorDto {
	type: "session_error";
	serverEpoch: string;
	sessionHandle: string;
	operation: "subscribe" | "claim" | "release" | "restart" | "extension_ui_response" | "history_page";
	error: string;
	/** Stable machine-readable code; optional for backwards-compatible peers. */
	code?: string;
	/** Whether the operation may be retried after the current resource/state changes. */
	retryable?: boolean;
}

export type SessionWsServerMessage =
	| SessionResponseFrameDto
	| SessionReplayFrameDto
	| { type: "runtime_state"; runtime: SessionRuntimeDto }
	| SessionLeaseStatusDto
	| SessionResyncRequiredDto
	| SessionSnapshotDto
	| SessionSnapshotBeginDto
	| SessionSnapshotChunkDto
	| SessionSnapshotEndDto
	| SessionHistoryPageBeginDto
	| SessionHistoryPageChunkDto
	| SessionHistoryPageEndDto
	| {
			type: "extension_ui_snapshot";
			serverEpoch: string;
			sessionHandle: string;
			generation: number;
			requests: ExtensionUiRequestDto[];
	  }
	| {
			type: "extension_ui_result";
			serverEpoch: string;
			sessionHandle: string;
			generation: number;
			requestId: string;
			outcome: "accepted" | "no_dialog" | "not_running";
	  }
	| SessionRekeyedDto
	| HotRuntimeInventoryDto
	| SessionErrorDto
	| { type: "session_directory_changed"; workspaceId: string }
	| { type: "auth_changed"; workspaceId?: string };

export type FutureSessionReplayFrameDto =
	| (SessionSequencedEnvelopeDto & { type: "event"; event: FutureProductSessionEventDto })
	| (SessionSequencedEnvelopeDto & {
			type: "extension_ui_request";
			request: FutureExtensionUiRequestDto;
	  })
	| Exclude<SessionReplayFrameDto, { type: "event" | "extension_ui_request" }>;

export type FutureSessionProjectionEventDto = Extract<FutureSessionReplayFrameDto, { type: "event" }>;

export interface FutureSessionSnapshotDto
	extends Omit<
		SessionSnapshotDto,
		"settledMessages" | "projectionEvents" | "pendingExtensionRequests" | "stickyExtensionState"
	> {
	settledMessages: FutureSessionMessageDto[];
	projectionEvents: FutureSessionProjectionEventDto[];
	pendingExtensionRequests: FutureBlockingExtensionUiRequestDto[];
	stickyExtensionState: FutureStickyExtensionUiRequestDto[];
}

export interface FutureSessionSnapshotBeginDto
	extends Omit<
		SessionSnapshotBeginDto,
		"projectionEvents" | "pendingExtensionRequests" | "stickyExtensionState"
	> {
	projectionEvents: FutureSessionProjectionEventDto[];
	pendingExtensionRequests: FutureBlockingExtensionUiRequestDto[];
	stickyExtensionState: FutureStickyExtensionUiRequestDto[];
}

export interface FutureSessionSnapshotChunkDto extends Omit<SessionSnapshotChunkDto, "messages"> {
	messages: FutureSessionMessageDto[];
}

export interface FutureSessionHistoryPageChunkDto extends Omit<SessionHistoryPageChunkDto, "messages"> {
	messages: FutureSessionMessageDto[];
}

export interface FutureSessionResponseFrameDto extends Omit<SessionResponseFrameDto, "response"> {
	response: FutureSessionCommandResponseDto;
}

export interface FutureExtensionUiSnapshotDto {
	type: "extension_ui_snapshot";
	serverEpoch: string;
	sessionHandle: string;
	generation: number;
	requests: FutureExtensionUiRequestDto[];
}

export type FutureSessionWsServerMessage =
	| FutureSessionResponseFrameDto
	| FutureSessionReplayFrameDto
	| FutureSessionSnapshotDto
	| FutureSessionSnapshotBeginDto
	| FutureSessionSnapshotChunkDto
	| SessionSnapshotEndDto
	| SessionHistoryPageBeginDto
	| FutureSessionHistoryPageChunkDto
	| SessionHistoryPageEndDto
	| FutureExtensionUiSnapshotDto
	| Exclude<
			SessionWsServerMessage,
			| SessionResponseFrameDto
			| SessionReplayFrameDto
			| SessionSnapshotDto
			| SessionSnapshotBeginDto
			| SessionSnapshotChunkDto
			| SessionSnapshotEndDto
			| SessionHistoryPageBeginDto
			| SessionHistoryPageChunkDto
			| SessionHistoryPageEndDto
			| { type: "extension_ui_snapshot" }
	  >;

export function isSessionRuntimeIdentityDto(value: unknown): value is SessionRuntimeIdentityDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["serverEpoch", "sessionHandle", "workspaceId", "generation"]) &&
		isString(value.serverEpoch, 128) &&
		isString(value.sessionHandle) &&
		isString(value.workspaceId) &&
		isGeneration(value.generation)
	);
}

function isExactHotRuntimeIdentityDto(value: unknown): value is SessionRuntimeIdentityDto {
	return (
		isRecord(value) &&
		hasOwnProperties(value, ["serverEpoch", "sessionHandle", "workspaceId", "generation"]) &&
		isSessionRuntimeIdentityDto(value) &&
		value.generation > 0
	);
}

function isSessionSubscribeMessage(value: UnknownRecord): boolean {
	if (
		!hasOwnProperties(value, ["type", "sessionHandle"]) ||
		!hasOnlyKeys(value, ["type", "sessionHandle", "cursor", "expectedHotRuntime"]) ||
		(value.cursor !== undefined && !Object.hasOwn(value, "cursor")) ||
		(value.cursor !== undefined && !isSessionReplayCursorDto(value.cursor))
	) {
		return false;
	}
	if (value.expectedHotRuntime === undefined) return true;
	if (!Object.hasOwn(value, "expectedHotRuntime")) return false;
	if (!isExactHotRuntimeIdentityDto(value.expectedHotRuntime)) return false;
	if (value.expectedHotRuntime.sessionHandle !== value.sessionHandle) return false;
	return true;
}

function isCanonicalSessionSubscribeMessage(value: unknown): boolean {
	const serialized = boundedCanonicalJson(value, {
		maxBytes: SESSION_WS_CLIENT_MAX_BYTES,
		maxDepth: 4,
		maxItems: 32,
	});
	if (serialized === null) return false;
	try {
		const canonical = JSON.parse(serialized);
		return (
			isRecord(canonical) &&
			canonical.type === "session_subscribe" &&
			isString(canonical.sessionHandle) &&
			isSessionSubscribeMessage(canonical)
		);
	} catch {
		return false;
	}
}

export function isSessionRuntimeDto(value: unknown): value is SessionRuntimeDto {
	if (!isRecord(value)) return false;
	return (
		hasOnlyKeys(value, [
			"serverEpoch",
			"sessionHandle",
			"workspaceId",
			"nativeSessionId",
			"sessionFile",
			"cwd",
			"generation",
			"lastSeq",
			"state",
			"phase",
			"operationCount",
			"busyReasons",
			"lastActivityAt",
			"recoverable",
			"error",
		]) &&
		isString(value.serverEpoch, 128) &&
		isString(value.sessionHandle) &&
		isString(value.workspaceId) &&
		isString(value.nativeSessionId) &&
		(value.sessionFile === null || isString(value.sessionFile, MAX_PATH_LENGTH)) &&
		isString(value.cwd, MAX_PATH_LENGTH) &&
		isGeneration(value.generation) &&
		isGeneration(value.lastSeq) &&
		["starting", "idle", "running", "waiting_ui", "crashed", "dormant"].includes(String(value.state)) &&
		isRuntimeOperationalFacts(value, ["starting", "ready", "busy", "waiting_ui", "crashed", "dormant"]) &&
		isGeneration(value.lastActivityAt) &&
		typeof value.recoverable === "boolean" &&
		(value.error === undefined || isBoundedString(value.error, SESSION_TEXT_MAX_BYTES))
	);
}

function hasSessionEnvelope(value: UnknownRecord): boolean {
	return (
		isString(value.serverEpoch, 128) &&
		isString(value.sessionHandle) &&
		isString(value.workspaceId) &&
		isGeneration(value.generation) &&
		isGeneration(value.seq)
	);
}

function isSameRuntimeIncarnation(
	left: Pick<SessionRuntimeIdentityDto, "serverEpoch" | "sessionHandle" | "workspaceId" | "generation">,
	right: Pick<SessionRuntimeIdentityDto, "serverEpoch" | "sessionHandle" | "workspaceId" | "generation">,
): boolean {
	return (
		left.serverEpoch === right.serverEpoch &&
		left.sessionHandle === right.sessionHandle &&
		left.workspaceId === right.workspaceId &&
		left.generation === right.generation
	);
}

function canonicalJsonChildren(value: object): unknown[] | null {
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype) return null;
		const children: unknown[] = [];
		let indexedItems = 0;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") return null;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined) return null;
			if (!("value" in descriptor)) return null;
			if (key === "length") {
				if (descriptor.enumerable) return null;
				continue;
			}
			const index = Number(key);
			if (
				!descriptor.enumerable ||
				!Number.isSafeInteger(index) ||
				index < 0 ||
				index >= value.length ||
				String(index) !== key
			) {
				return null;
			}
			indexedItems += 1;
			children.push(descriptor.value);
		}
		return indexedItems === value.length ? children : null;
	}

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return null;
	const children: unknown[] = [];
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") return null;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined) return null;
		if (!descriptor.enumerable || !("value" in descriptor)) return null;
		children.push(descriptor.value);
	}
	return children;
}

interface CanonicalJsonLimits {
	maxBytes: number;
	maxDepth: number;
	maxItems: number;
}

function boundedCanonicalJson(value: unknown, limits: CanonicalJsonLimits): string | null {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	const seen = new Set<object>();
	let items = 0;
	let stringBytes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || current.depth > limits.maxDepth || ++items > limits.maxItems) {
			return null;
		}
		const candidate = current.value;
		if (candidate === null || typeof candidate === "boolean") continue;
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate) || Math.abs(candidate) > Number.MAX_SAFE_INTEGER) return null;
			continue;
		}
		if (typeof candidate === "string") {
			stringBytes += UTF8_ENCODER.encode(candidate).byteLength;
			if (stringBytes > limits.maxBytes) return null;
			continue;
		}
		if (typeof candidate !== "object" || seen.has(candidate)) return null;
		seen.add(candidate);
		const children = canonicalJsonChildren(candidate);
		if (children === null) return null;
		for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
	}
	try {
		const serialized = JSON.stringify(value);
		if (typeof serialized !== "string") return null;
		return UTF8_ENCODER.encode(serialized).byteLength <= limits.maxBytes ? serialized : null;
	} catch {
		return null;
	}
}

function boundedCanonicalSnapshotJson(value: unknown): string | null {
	return boundedCanonicalJson(value, {
		maxBytes: SESSION_SNAPSHOT_MAX_BYTES,
		maxDepth: SESSION_SNAPSHOT_MAX_DEPTH,
		maxItems: SESSION_SNAPSHOT_MAX_ITEMS,
	});
}

function isCanonicalHotRuntimeInventoryDto(value: unknown): value is HotRuntimeInventoryDto {
	if (
		!isRecord(value) ||
		!hasOwnProperties(value, ["type", "serverEpoch", "revision", "runtimes"]) ||
		!hasOnlyKeys(value, ["type", "serverEpoch", "revision", "runtimes"]) ||
		value.type !== "hot_runtime_inventory" ||
		!isString(value.serverEpoch, 128) ||
		!isGeneration(value.revision) ||
		!Array.isArray(value.runtimes) ||
		value.runtimes.length > SESSION_HOT_RUNTIME_INVENTORY_MAX_ITEMS
	) {
		return false;
	}
	const handles = new Set<string>();
	for (const runtime of value.runtimes) {
		if (
			!isRecord(runtime) ||
			!hasOwnProperties(runtime, ["serverEpoch", "sessionHandle", "workspaceId", "generation", "state"]) ||
			!hasOnlyKeys(runtime, [
				"serverEpoch",
				"sessionHandle",
				"workspaceId",
				"generation",
				"state",
				"phase",
				"operationCount",
				"busyReasons",
			]) ||
			!isString(runtime.serverEpoch, 128) ||
			runtime.serverEpoch !== value.serverEpoch ||
			!isString(runtime.sessionHandle) ||
			!isString(runtime.workspaceId) ||
			!isGeneration(runtime.generation) ||
			runtime.generation === 0 ||
			!["starting", "idle", "running", "waiting_ui"].includes(String(runtime.state)) ||
			!isRuntimeOperationalFacts(runtime, ["starting", "ready", "busy", "waiting_ui"]) ||
			handles.has(runtime.sessionHandle)
		) {
			return false;
		}
		handles.add(runtime.sessionHandle);
	}
	return true;
}

function isRuntimeOperationalFacts(value: UnknownRecord, allowedPhases: readonly string[]): boolean {
	const keys = ["phase", "operationCount", "busyReasons"] as const;
	const hasAny = keys.some((key) => Object.hasOwn(value, key));
	if (!hasAny) return true;
	if (!keys.every((key) => Object.hasOwn(value, key))) return false;
	if (typeof value.phase !== "string" || !allowedPhases.includes(value.phase)) return false;
	if (!isGeneration(value.operationCount)) return false;
	if (!Array.isArray(value.busyReasons) || value.busyReasons.length > SESSION_RUNTIME_BUSY_REASON_MAX_ITEMS) {
		return false;
	}
	const seen = new Set<string>();
	for (const reason of value.busyReasons) {
		if (
			typeof reason !== "string" ||
			![
				"starting",
				"command",
				"agent",
				"compaction",
				"queue",
				"dialog",
				"turn_reservation",
				"transition",
			].includes(reason) ||
			seen.has(reason)
		) {
			return false;
		}
		seen.add(reason);
	}
	const phase = value.phase;
	const operationCount = value.operationCount;
	const busyReasons = value.busyReasons;
	if (phase === "starting") {
		return operationCount > 0 && busyReasons.includes("starting");
	}
	if (phase === "ready") {
		return operationCount === 0 && busyReasons.length === 0;
	}
	if (phase === "busy") {
		return operationCount > 0 && busyReasons.length > 0;
	}
	if (phase === "waiting_ui") {
		return operationCount > 0 && busyReasons.includes("dialog");
	}
	return operationCount === 0 && busyReasons.length === 0;
}

export function isHotRuntimeInventoryDto(value: unknown): value is HotRuntimeInventoryDto {
	const serialized = boundedCanonicalJson(value, {
		maxBytes: SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES,
		maxDepth: 4,
		maxItems: SESSION_HOT_RUNTIME_INVENTORY_MAX_ITEMS * 8 + 16,
	});
	if (serialized === null) return false;
	try {
		return isCanonicalHotRuntimeInventoryDto(JSON.parse(serialized));
	} catch {
		return false;
	}
}

function isProjectionEventDto(
	value: unknown,
	context?: SessionAttachmentGuardContext,
): value is SessionProjectionEventDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			"type",
			"serverEpoch",
			"sessionHandle",
			"workspaceId",
			"generation",
			"seq",
			"event",
		]) &&
		value.type === "event" &&
		hasSessionEnvelope(value) &&
		isProductSessionEventDto(value.event, context)
	);
}

function isBlockingExtensionRequest(value: unknown): value is BlockingExtensionUiRequestDto {
	return isExtensionUiRequestDto(value) && ["select", "confirm", "input", "editor"].includes(value.method);
}

function isStickyExtensionRequest(value: unknown): value is StickyExtensionUiRequestDto {
	return (
		isExtensionUiRequestDto(value) &&
		["setStatus", "setWidget", "setTitle", "set_editor_text"].includes(value.method)
	);
}

function isCanonicalSessionSnapshotDto(
	value: unknown,
	context?: SessionAttachmentGuardContext,
): value is SessionSnapshotDto {
	if (!PRODUCT_RUNTIME_SCHEMAS.snapshot.check(value)) return false;
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"type",
			"snapshotId",
			"serverEpoch",
			"sessionHandle",
			"workspaceId",
			"generation",
			"baseSeq",
			"asOfSeq",
			"runtime",
			"settledMessages",
			"projectionEvents",
			"queue",
			"pendingExtensionRequests",
			"stickyExtensionState",
		]) ||
		value.type !== "session_snapshot" ||
		!isString(value.snapshotId) ||
		!isString(value.serverEpoch, 128) ||
		(context !== undefined && value.serverEpoch !== context.serverEpoch) ||
		!isString(value.sessionHandle) ||
		!isString(value.workspaceId) ||
		!isGeneration(value.generation) ||
		!isGeneration(value.baseSeq) ||
		!isGeneration(value.asOfSeq) ||
		value.baseSeq > value.asOfSeq ||
		!isSessionRuntimeDto(value.runtime) ||
		!isSameRuntimeIncarnation(value as unknown as SessionRuntimeIdentityDto, value.runtime) ||
		value.runtime.lastSeq !== value.asOfSeq ||
		!Array.isArray(value.settledMessages) ||
		value.settledMessages.length > SESSION_SNAPSHOT_MAX_MESSAGES ||
		!value.settledMessages.every((message) => isSessionMessageDto(message, context)) ||
		!Array.isArray(value.projectionEvents) ||
		value.projectionEvents.length > SESSION_SNAPSHOT_MAX_PROJECTION_EVENTS ||
		!isRecord(value.queue) ||
		!hasOnlyKeys(value.queue, ["steering", "followUp"]) ||
		!Array.isArray(value.queue.steering) ||
		value.queue.steering.length > SESSION_SNAPSHOT_MAX_QUEUE_ITEMS ||
		!value.queue.steering.every((item) => isBoundedString(item, SESSION_TEXT_MAX_BYTES)) ||
		!Array.isArray(value.queue.followUp) ||
		value.queue.followUp.length > SESSION_SNAPSHOT_MAX_QUEUE_ITEMS ||
		!value.queue.followUp.every((item) => isBoundedString(item, SESSION_TEXT_MAX_BYTES)) ||
		!Array.isArray(value.pendingExtensionRequests) ||
		value.pendingExtensionRequests.length > SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS ||
		!value.pendingExtensionRequests.every(isBlockingExtensionRequest) ||
		!Array.isArray(value.stickyExtensionState) ||
		value.stickyExtensionState.length > SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS ||
		!value.stickyExtensionState.every(isStickyExtensionRequest)
	) {
		return false;
	}

	let previousSeq = value.baseSeq;
	for (const event of value.projectionEvents) {
		if (
			!isProjectionEventDto(event, context) ||
			!isSameRuntimeIncarnation(value as unknown as SessionRuntimeIdentityDto, event) ||
			event.seq <= previousSeq ||
			event.seq > value.asOfSeq
		) {
			return false;
		}
		previousSeq = event.seq;
	}
	return true;
}

function isHistoryCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isHistoryCursor(value: unknown): value is string | null {
	return (
		value === null ||
		(typeof value === "string" &&
			value.length > 0 &&
			isBoundedString(value, SESSION_HISTORY_MAX_CURSOR_BYTES))
	);
}

export function isSessionHistoryMetadataDto(value: unknown): value is SessionHistoryMetadataDto {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["totalMessages", "loadedMessages", "loadedBytes", "totalBytes", "nextCursor"]) ||
		!isHistoryCount(value.totalMessages) ||
		value.totalMessages > SESSION_HISTORY_MAX_MESSAGES ||
		!isHistoryCount(value.loadedMessages) ||
		value.loadedMessages > value.totalMessages ||
		!isHistoryCount(value.loadedBytes) ||
		value.loadedBytes > SESSION_HISTORY_MAX_STREAM_BYTES ||
		!isHistoryCount(value.totalBytes) ||
		value.totalBytes > SESSION_HISTORY_MAX_TOTAL_BYTES ||
		value.loadedBytes > value.totalBytes ||
		!isHistoryCursor(value.nextCursor)
	) {
		return false;
	}
	return true;
}

function isHistoryFrameIdentity(value: UnknownRecord, context?: SessionAttachmentGuardContext): boolean {
	return (
		isString(value.serverEpoch, 128) &&
		(context === undefined || value.serverEpoch === context.serverEpoch) &&
		isString(value.sessionHandle) &&
		isString(value.workspaceId) &&
		isGeneration(value.generation)
	);
}

function isHistoryMessages(
	value: unknown,
	context: SessionAttachmentGuardContext | undefined,
): value is SessionMessageDto[] {
	return (
		Array.isArray(value) &&
		value.length <= SESSION_HISTORY_MAX_CHUNK_MESSAGES &&
		isHistoryCount(sessionHistoryMessagesBytes(value)) &&
		value.every((message) => isSessionMessageDto(message, context))
	);
}

function isSessionSnapshotBeginDto(
	value: unknown,
	context?: SessionAttachmentGuardContext,
): value is SessionSnapshotBeginDto {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"type",
			"snapshotId",
			"serverEpoch",
			"sessionHandle",
			"workspaceId",
			"generation",
			"baseSeq",
			"asOfSeq",
			"runtime",
			"projectionEvents",
			"queue",
			"pendingExtensionRequests",
			"stickyExtensionState",
			"history",
		]) ||
		value.type !== "session_snapshot_begin" ||
		!isHistoryFrameIdentity(value, context) ||
		!isString(value.snapshotId, SESSION_HISTORY_MAX_SNAPSHOT_ID_BYTES) ||
		!isGeneration(value.baseSeq) ||
		!isGeneration(value.asOfSeq) ||
		value.baseSeq > value.asOfSeq ||
		!isSessionRuntimeDto(value.runtime) ||
		!isSameRuntimeIncarnation(value as unknown as SessionRuntimeIdentityDto, value.runtime) ||
		value.runtime.lastSeq !== value.asOfSeq ||
		!Array.isArray(value.projectionEvents) ||
		value.projectionEvents.length > SESSION_SNAPSHOT_MAX_PROJECTION_EVENTS ||
		!isRecord(value.queue) ||
		!hasOnlyKeys(value.queue, ["steering", "followUp"]) ||
		!Array.isArray(value.queue.steering) ||
		value.queue.steering.length > SESSION_SNAPSHOT_MAX_QUEUE_ITEMS ||
		!value.queue.steering.every((item) => isBoundedString(item, SESSION_TEXT_MAX_BYTES)) ||
		!Array.isArray(value.queue.followUp) ||
		value.queue.followUp.length > SESSION_SNAPSHOT_MAX_QUEUE_ITEMS ||
		!value.queue.followUp.every((item) => isBoundedString(item, SESSION_TEXT_MAX_BYTES)) ||
		!Array.isArray(value.pendingExtensionRequests) ||
		value.pendingExtensionRequests.length > SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS ||
		!value.pendingExtensionRequests.every(isBlockingExtensionRequest) ||
		!Array.isArray(value.stickyExtensionState) ||
		value.stickyExtensionState.length > SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS ||
		!value.stickyExtensionState.every(isStickyExtensionRequest) ||
		!isSessionHistoryMetadataDto(value.history)
	) {
		return false;
	}

	let previousSeq = value.baseSeq;
	for (const event of value.projectionEvents) {
		if (
			!isProjectionEventDto(event, context) ||
			!isSameRuntimeIncarnation(value as unknown as SessionRuntimeIdentityDto, event) ||
			event.seq <= previousSeq ||
			event.seq > value.asOfSeq
		) {
			return false;
		}
		previousSeq = event.seq;
	}
	return true;
}

function isSessionHistoryChunkDto(
	value: unknown,
	context: SessionAttachmentGuardContext | undefined,
): value is SessionSnapshotChunkDto | SessionHistoryPageChunkDto {
	if (!isRecord(value) || !isHistoryFrameIdentity(value, context)) return false;
	const isSnapshotChunk = value.type === "session_snapshot_chunk";
	const isPageChunk = value.type === "session_history_page_chunk";
	if (!isSnapshotChunk && !isPageChunk) return false;
	if (
		(isSnapshotChunk &&
			!hasOnlyKeys(value, [
				"type",
				"serverEpoch",
				"sessionHandle",
				"workspaceId",
				"generation",
				"snapshotId",
				"chunkIndex",
				"messages",
				"itemCount",
				"byteCount",
				"checksum",
			])) ||
		(isPageChunk &&
			!hasOnlyKeys(value, [
				"type",
				"serverEpoch",
				"sessionHandle",
				"workspaceId",
				"generation",
				"requestId",
				"snapshotId",
				"chunkIndex",
				"messages",
				"itemCount",
				"byteCount",
				"checksum",
			]))
	) {
		return false;
	}
	if (
		(isPageChunk && !isString(value.requestId)) ||
		!isString(value.snapshotId, SESSION_HISTORY_MAX_SNAPSHOT_ID_BYTES) ||
		!isHistoryCount(value.chunkIndex) ||
		value.chunkIndex >= SESSION_HISTORY_MAX_MESSAGES ||
		!isHistoryMessages(value.messages, context) ||
		!isHistoryCount(value.itemCount) ||
		value.itemCount !== value.messages.length ||
		!isHistoryCount(value.byteCount) ||
		value.byteCount !== sessionHistoryMessagesBytes(value.messages) ||
		value.byteCount > SESSION_HISTORY_MAX_CHUNK_BYTES ||
		!isSessionHistoryChecksum(value.checksum) ||
		value.checksum !== sessionHistoryChecksum(value.messages)
	) {
		return false;
	}
	return true;
}

function isSessionSnapshotEndDto(
	value: unknown,
	context?: SessionAttachmentGuardContext,
): value is SessionSnapshotEndDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			"type",
			"serverEpoch",
			"sessionHandle",
			"workspaceId",
			"generation",
			"snapshotId",
			"chunkCount",
			"itemCount",
			"byteCount",
			"checksum",
			"nextCursor",
		]) &&
		value.type === "session_snapshot_end" &&
		isHistoryFrameIdentity(value, context) &&
		isString(value.snapshotId, SESSION_HISTORY_MAX_SNAPSHOT_ID_BYTES) &&
		isHistoryCount(value.chunkCount) &&
		value.chunkCount <= SESSION_HISTORY_MAX_MESSAGES &&
		isHistoryCount(value.itemCount) &&
		value.itemCount <= SESSION_HISTORY_MAX_MESSAGES &&
		isHistoryCount(value.byteCount) &&
		value.byteCount <= SESSION_HISTORY_MAX_STREAM_BYTES &&
		isSessionHistoryChecksum(value.checksum) &&
		isHistoryCursor(value.nextCursor)
	);
}

function isSessionHistoryPageBeginDto(
	value: unknown,
	context?: SessionAttachmentGuardContext,
): value is SessionHistoryPageBeginDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			"type",
			"serverEpoch",
			"sessionHandle",
			"workspaceId",
			"generation",
			"requestId",
			"snapshotId",
			"asOfSeq",
			"cursor",
			"history",
		]) &&
		value.type === "session_history_page_begin" &&
		isHistoryFrameIdentity(value, context) &&
		isString(value.requestId) &&
		isString(value.snapshotId, SESSION_HISTORY_MAX_SNAPSHOT_ID_BYTES) &&
		isGeneration(value.asOfSeq) &&
		isBoundedString(value.cursor, SESSION_HISTORY_MAX_CURSOR_BYTES) &&
		isSessionHistoryMetadataDto(value.history)
	);
}

function isSessionHistoryPageEndDto(
	value: unknown,
	context?: SessionAttachmentGuardContext,
): value is SessionHistoryPageEndDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			"type",
			"serverEpoch",
			"sessionHandle",
			"workspaceId",
			"generation",
			"requestId",
			"snapshotId",
			"chunkCount",
			"itemCount",
			"byteCount",
			"checksum",
			"nextCursor",
		]) &&
		value.type === "session_history_page_end" &&
		isHistoryFrameIdentity(value, context) &&
		isString(value.requestId) &&
		isString(value.snapshotId, SESSION_HISTORY_MAX_SNAPSHOT_ID_BYTES) &&
		isHistoryCount(value.chunkCount) &&
		value.chunkCount <= SESSION_HISTORY_MAX_MESSAGES &&
		isHistoryCount(value.itemCount) &&
		value.itemCount <= SESSION_HISTORY_MAX_MESSAGES &&
		isHistoryCount(value.byteCount) &&
		value.byteCount <= SESSION_HISTORY_MAX_STREAM_BYTES &&
		isSessionHistoryChecksum(value.checksum) &&
		isHistoryCursor(value.nextCursor)
	);
}

export function isSessionSnapshotDto(
	value: unknown,
	context?: SessionAttachmentGuardContext,
): value is SessionSnapshotDto {
	if (context !== undefined && !isSessionAttachmentGuardContext(context)) return false;
	const serialized = boundedCanonicalSnapshotJson(value);
	if (serialized === null) return false;
	try {
		return isCanonicalSessionSnapshotDto(JSON.parse(serialized), context);
	} catch {
		return false;
	}
}

/** Validate gateway-to-browser Session frames before they enter UI state. */
export function isSessionWsServerMessage(
	value: unknown,
	context?: SessionAttachmentGuardContext,
): value is SessionWsServerMessage {
	if (!PRODUCT_RUNTIME_SCHEMAS.wsServer.check(value)) return false;
	if (!isRecord(value) || !isString(value.type, 64)) return false;
	if (context !== undefined && !isSessionAttachmentGuardContext(context)) return false;
	if (
		context &&
		((typeof value.serverEpoch === "string" && value.serverEpoch !== context.serverEpoch) ||
			(value.type === "runtime_state" &&
				isRecord(value.runtime) &&
				value.runtime.serverEpoch !== context.serverEpoch))
	) {
		return false;
	}
	if (value.type === "session_snapshot") return isSessionSnapshotDto(value, context);
	if (
		value.type === "session_snapshot_begin" ||
		value.type === "session_snapshot_chunk" ||
		value.type === "session_snapshot_end" ||
		value.type === "session_history_page_begin" ||
		value.type === "session_history_page_chunk" ||
		value.type === "session_history_page_end"
	) {
		if (sessionWsServerMessageBytes(value) > SESSION_WS_SERVER_MAX_BYTES) return false;
		if (value.type === "session_snapshot_begin") return isSessionSnapshotBeginDto(value, context);
		if (value.type === "session_snapshot_chunk") return isSessionHistoryChunkDto(value, context);
		if (value.type === "session_snapshot_end") return isSessionSnapshotEndDto(value, context);
		if (value.type === "session_history_page_begin") return isSessionHistoryPageBeginDto(value, context);
		if (value.type === "session_history_page_chunk") return isSessionHistoryChunkDto(value, context);
		return isSessionHistoryPageEndDto(value, context);
	}
	if (sessionWsServerMessageBytes(value) > SESSION_WS_SERVER_MAX_BYTES) return false;
	switch (value.type) {
		case "hot_runtime_inventory":
			return isHotRuntimeInventoryDto(value);
		case "runtime_state":
			return hasOnlyKeys(value, ["type", "runtime"]) && isSessionRuntimeDto(value.runtime);
		case "session_rekeyed":
			return (
				hasOnlyKeys(value, ["type", "serverEpoch", "previousSessionHandle", "runtime"]) &&
				isString(value.serverEpoch, 128) &&
				isString(value.previousSessionHandle) &&
				isSessionRuntimeDto(value.runtime) &&
				value.serverEpoch === value.runtime.serverEpoch
			);
		case "session_directory_changed":
			return hasOnlyKeys(value, ["type", "workspaceId"]) && isString(value.workspaceId);
		case "auth_changed":
			return (
				hasOnlyKeys(value, ["type", "workspaceId"]) &&
				(value.workspaceId === undefined || isString(value.workspaceId))
			);
		case "event":
			return isProjectionEventDto(value, context);
		case "extension_ui_request":
			return (
				hasOnlyKeys(value, [
					"type",
					"serverEpoch",
					"sessionHandle",
					"workspaceId",
					"generation",
					"seq",
					"request",
				]) &&
				hasSessionEnvelope(value) &&
				isExtensionUiRequestDto(value.request)
			);
		case "extension_ui_closed":
			return (
				hasOnlyKeys(value, [
					"type",
					"serverEpoch",
					"sessionHandle",
					"workspaceId",
					"generation",
					"seq",
					"requestId",
					"reason",
				]) &&
				hasSessionEnvelope(value) &&
				isString(value.requestId) &&
				["answered", "cancelled", "expired", "process_lost", "replaced"].includes(String(value.reason))
			);
		case "response":
			return (
				hasOnlyKeys(value, [
					"type",
					"serverEpoch",
					"sessionHandle",
					"generation",
					"barrierSeq",
					"response",
					"previousSessionHandle",
				]) &&
				isString(value.serverEpoch, 128) &&
				isString(value.sessionHandle) &&
				isGeneration(value.generation) &&
				isGeneration(value.barrierSeq) &&
				isSessionCommandResponseDto(value.response, context)
			);
		case "lease_status":
			return (
				hasOnlyKeys(value, [
					"type",
					"serverEpoch",
					"sessionHandle",
					"generation",
					"isController",
					"fencingToken",
				]) &&
				isString(value.serverEpoch, 128) &&
				isString(value.sessionHandle) &&
				isGeneration(value.generation) &&
				typeof value.isController === "boolean" &&
				(value.fencingToken === undefined || isString(value.fencingToken))
			);
		case "resync_required":
			return (
				hasOnlyKeys(value, ["type", "serverEpoch", "sessionHandle", "runtime", "reason"]) &&
				isString(value.serverEpoch, 128) &&
				isString(value.sessionHandle) &&
				isSessionRuntimeDto(value.runtime) &&
				value.serverEpoch === value.runtime.serverEpoch &&
				value.sessionHandle === value.runtime.sessionHandle &&
				["initial", "epoch_changed", "generation_changed", "gap", "invalid_cursor"].includes(
					String(value.reason),
				)
			);
		case "extension_ui_snapshot":
			return (
				hasOnlyKeys(value, ["type", "serverEpoch", "sessionHandle", "generation", "requests"]) &&
				isString(value.serverEpoch, 128) &&
				isString(value.sessionHandle) &&
				isGeneration(value.generation) &&
				Array.isArray(value.requests) &&
				value.requests.length <= SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS &&
				value.requests.every(isExtensionUiRequestDto)
			);
		case "extension_ui_result":
			return (
				hasOnlyKeys(value, ["type", "serverEpoch", "sessionHandle", "generation", "requestId", "outcome"]) &&
				isString(value.serverEpoch, 128) &&
				isString(value.sessionHandle) &&
				isGeneration(value.generation) &&
				isString(value.requestId) &&
				["accepted", "no_dialog", "not_running"].includes(String(value.outcome))
			);
		case "session_error": {
			if (
				!hasOnlyKeys(value, [
					"type",
					"serverEpoch",
					"sessionHandle",
					"operation",
					"error",
					"code",
					"retryable",
				]) ||
				!isString(value.serverEpoch, 128) ||
				!isString(value.sessionHandle) ||
				!["subscribe", "claim", "release", "restart", "extension_ui_response", "history_page"].includes(
					String(value.operation),
				) ||
				!isBoundedString(value.error, SESSION_TEXT_MAX_BYTES)
			) {
				return false;
			}
			const hasCode = Object.hasOwn(value, "code");
			const hasRetryable = Object.hasOwn(value, "retryable");
			return (
				(!hasCode && !hasRetryable) ||
				(hasCode && hasRetryable && isString(value.code, 128) && typeof value.retryable === "boolean")
			);
		}
		default:
			return false;
	}
}

function futureAttachmentContext(
	context: FutureSessionContentRefGuardContext,
): SessionAttachmentGuardContext {
	return { serverEpoch: context.serverEpoch, payloadBudget: context.payloadBudget };
}

export function isFutureSessionProjectionEventDto(
	value: unknown,
	context?: FutureSessionContentRefGuardContext,
): value is FutureSessionProjectionEventDto {
	return (
		context !== undefined &&
		isFutureSessionContentRefGuardContext(context) &&
		isRecord(value) &&
		hasOnlyKeys(value, [
			"type",
			"serverEpoch",
			"sessionHandle",
			"workspaceId",
			"generation",
			"seq",
			"event",
		]) &&
		value.type === "event" &&
		hasSessionEnvelope(value) &&
		value.serverEpoch === context.serverEpoch &&
		isFutureProductSessionEventDto(value.event, context)
	);
}

export function isFutureSessionReplayFrameDto(
	value: unknown,
	context?: FutureSessionContentRefGuardContext,
): value is FutureSessionReplayFrameDto {
	if (!context || !isFutureSessionContentRefGuardContext(context) || !isRecord(value)) return false;
	if (value.type === "event") return isFutureSessionProjectionEventDto(value, context);
	if (value.type === "extension_ui_request") {
		return (
			hasOnlyKeys(value, [
				"type",
				"serverEpoch",
				"sessionHandle",
				"workspaceId",
				"generation",
				"seq",
				"request",
			]) &&
			hasSessionEnvelope(value) &&
			value.serverEpoch === context.serverEpoch &&
			isFutureExtensionUiRequestDto(value.request, context)
		);
	}
	if (value.type !== "extension_ui_closed") return false;
	return isSessionWsServerMessage(value, futureAttachmentContext(context));
}

function isFutureBlockingExtensionRequest(
	value: unknown,
	context: FutureSessionContentRefGuardContext,
): value is FutureBlockingExtensionUiRequestDto {
	return (
		isFutureExtensionUiRequestDto(value, context) &&
		["select", "confirm", "input", "editor"].includes(value.method)
	);
}

function isFutureStickyExtensionRequest(
	value: unknown,
	context: FutureSessionContentRefGuardContext,
): value is FutureStickyExtensionUiRequestDto {
	return (
		isFutureExtensionUiRequestDto(value, context) &&
		["setStatus", "setWidget", "setTitle", "set_editor_text"].includes(value.method)
	);
}

function isFutureSessionSnapshotBeginDto(
	value: unknown,
	context: FutureSessionContentRefGuardContext,
): value is FutureSessionSnapshotBeginDto {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"type",
			"snapshotId",
			"serverEpoch",
			"sessionHandle",
			"workspaceId",
			"generation",
			"baseSeq",
			"asOfSeq",
			"runtime",
			"projectionEvents",
			"queue",
			"pendingExtensionRequests",
			"stickyExtensionState",
			"history",
		]) ||
		value.type !== "session_snapshot_begin" ||
		!isHistoryFrameIdentity(value, futureAttachmentContext(context)) ||
		!isString(value.snapshotId, SESSION_HISTORY_MAX_SNAPSHOT_ID_BYTES) ||
		!isGeneration(value.baseSeq) ||
		!isGeneration(value.asOfSeq) ||
		value.baseSeq > value.asOfSeq ||
		!isSessionRuntimeDto(value.runtime) ||
		!isSameRuntimeIncarnation(value as unknown as SessionRuntimeIdentityDto, value.runtime) ||
		value.runtime.lastSeq !== value.asOfSeq ||
		!Array.isArray(value.projectionEvents) ||
		value.projectionEvents.length > SESSION_SNAPSHOT_MAX_PROJECTION_EVENTS ||
		!isRecord(value.queue) ||
		!hasOnlyKeys(value.queue, ["steering", "followUp"]) ||
		!Array.isArray(value.queue.steering) ||
		value.queue.steering.length > SESSION_SNAPSHOT_MAX_QUEUE_ITEMS ||
		!value.queue.steering.every((item) => isBoundedString(item, SESSION_TEXT_MAX_BYTES)) ||
		!Array.isArray(value.queue.followUp) ||
		value.queue.followUp.length > SESSION_SNAPSHOT_MAX_QUEUE_ITEMS ||
		!value.queue.followUp.every((item) => isBoundedString(item, SESSION_TEXT_MAX_BYTES)) ||
		!Array.isArray(value.pendingExtensionRequests) ||
		value.pendingExtensionRequests.length > SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS ||
		!value.pendingExtensionRequests.every((request) => isFutureBlockingExtensionRequest(request, context)) ||
		!Array.isArray(value.stickyExtensionState) ||
		value.stickyExtensionState.length > SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS ||
		!value.stickyExtensionState.every((request) => isFutureStickyExtensionRequest(request, context)) ||
		!isSessionHistoryMetadataDto(value.history)
	) {
		return false;
	}

	let previousSeq = value.baseSeq;
	for (const event of value.projectionEvents) {
		if (
			!isFutureSessionProjectionEventDto(event, context) ||
			!isSameRuntimeIncarnation(value as unknown as SessionRuntimeIdentityDto, event) ||
			event.seq <= previousSeq ||
			event.seq > value.asOfSeq
		) {
			return false;
		}
		previousSeq = event.seq;
	}
	return true;
}

function isFutureSessionHistoryChunkDto(
	value: unknown,
	context: FutureSessionContentRefGuardContext,
): value is FutureSessionSnapshotChunkDto | FutureSessionHistoryPageChunkDto {
	if (!isRecord(value) || !isHistoryFrameIdentity(value, futureAttachmentContext(context))) return false;
	const isSnapshotChunk = value.type === "session_snapshot_chunk";
	const isPageChunk = value.type === "session_history_page_chunk";
	if (!isSnapshotChunk && !isPageChunk) return false;
	if (
		(isSnapshotChunk &&
			!hasOnlyKeys(value, [
				"type",
				"serverEpoch",
				"sessionHandle",
				"workspaceId",
				"generation",
				"snapshotId",
				"chunkIndex",
				"messages",
				"itemCount",
				"byteCount",
				"checksum",
			])) ||
		(isPageChunk &&
			!hasOnlyKeys(value, [
				"type",
				"serverEpoch",
				"sessionHandle",
				"workspaceId",
				"generation",
				"requestId",
				"snapshotId",
				"chunkIndex",
				"messages",
				"itemCount",
				"byteCount",
				"checksum",
			]))
	) {
		return false;
	}
	if (
		(isPageChunk && !isString(value.requestId)) ||
		!isString(value.snapshotId, SESSION_HISTORY_MAX_SNAPSHOT_ID_BYTES) ||
		!isHistoryCount(value.chunkIndex) ||
		value.chunkIndex >= SESSION_HISTORY_MAX_MESSAGES ||
		!Array.isArray(value.messages) ||
		value.messages.length > SESSION_HISTORY_MAX_CHUNK_MESSAGES ||
		!value.messages.every((message) => isFutureSessionMessageDto(message, context)) ||
		!isHistoryCount(value.itemCount) ||
		value.itemCount !== value.messages.length ||
		!isHistoryCount(value.byteCount) ||
		value.byteCount !== sessionHistoryMessagesBytes(value.messages) ||
		value.byteCount > SESSION_HISTORY_MAX_CHUNK_BYTES ||
		!isSessionHistoryChecksum(value.checksum) ||
		value.checksum !== sessionHistoryChecksum(value.messages)
	) {
		return false;
	}
	return true;
}

function isCanonicalFutureSessionSnapshotDto(
	value: unknown,
	context: FutureSessionContentRefGuardContext,
): value is FutureSessionSnapshotDto {
	if (!PRODUCT_RUNTIME_SCHEMAS.snapshot.check(value)) return false;
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"type",
			"snapshotId",
			"serverEpoch",
			"sessionHandle",
			"workspaceId",
			"generation",
			"baseSeq",
			"asOfSeq",
			"runtime",
			"settledMessages",
			"projectionEvents",
			"queue",
			"pendingExtensionRequests",
			"stickyExtensionState",
		]) ||
		value.type !== "session_snapshot" ||
		!isString(value.snapshotId) ||
		!isString(value.serverEpoch, 128) ||
		value.serverEpoch !== context.serverEpoch ||
		!isString(value.sessionHandle) ||
		!isString(value.workspaceId) ||
		!isGeneration(value.generation) ||
		!isGeneration(value.baseSeq) ||
		!isGeneration(value.asOfSeq) ||
		value.baseSeq > value.asOfSeq ||
		!isSessionRuntimeDto(value.runtime) ||
		!isSameRuntimeIncarnation(value as unknown as SessionRuntimeIdentityDto, value.runtime) ||
		value.runtime.lastSeq !== value.asOfSeq ||
		!Array.isArray(value.settledMessages) ||
		value.settledMessages.length > SESSION_SNAPSHOT_MAX_MESSAGES ||
		!value.settledMessages.every((message) => isFutureSessionMessageDto(message, context)) ||
		!Array.isArray(value.projectionEvents) ||
		value.projectionEvents.length > SESSION_SNAPSHOT_MAX_PROJECTION_EVENTS ||
		!isRecord(value.queue) ||
		!hasOnlyKeys(value.queue, ["steering", "followUp"]) ||
		!Array.isArray(value.queue.steering) ||
		value.queue.steering.length > SESSION_SNAPSHOT_MAX_QUEUE_ITEMS ||
		!value.queue.steering.every((item) => isBoundedString(item, SESSION_TEXT_MAX_BYTES)) ||
		!Array.isArray(value.queue.followUp) ||
		value.queue.followUp.length > SESSION_SNAPSHOT_MAX_QUEUE_ITEMS ||
		!value.queue.followUp.every((item) => isBoundedString(item, SESSION_TEXT_MAX_BYTES)) ||
		!Array.isArray(value.pendingExtensionRequests) ||
		value.pendingExtensionRequests.length > SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS ||
		!value.pendingExtensionRequests.every((request) => isFutureBlockingExtensionRequest(request, context)) ||
		!Array.isArray(value.stickyExtensionState) ||
		value.stickyExtensionState.length > SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS ||
		!value.stickyExtensionState.every((request) => isFutureStickyExtensionRequest(request, context))
	) {
		return false;
	}

	let previousSeq = value.baseSeq;
	for (const event of value.projectionEvents) {
		if (
			!isFutureSessionProjectionEventDto(event, context) ||
			!isSameRuntimeIncarnation(value as unknown as SessionRuntimeIdentityDto, event) ||
			event.seq <= previousSeq ||
			event.seq > value.asOfSeq
		) {
			return false;
		}
		previousSeq = event.seq;
	}
	return true;
}

export function isFutureSessionSnapshotDto(
	value: unknown,
	context?: FutureSessionContentRefGuardContext,
): value is FutureSessionSnapshotDto {
	if (!context || !isFutureSessionContentRefGuardContext(context)) return false;
	const serialized = boundedCanonicalSnapshotJson(value);
	if (serialized === null) return false;
	try {
		return isCanonicalFutureSessionSnapshotDto(JSON.parse(serialized), context);
	} catch {
		return false;
	}
}

export function isFutureSessionWsServerMessage(
	value: unknown,
	context?: FutureSessionContentRefGuardContext,
): value is FutureSessionWsServerMessage {
	if (!PRODUCT_RUNTIME_SCHEMAS.wsServer.check(value)) return false;
	if (!context || !isFutureSessionContentRefGuardContext(context) || !isRecord(value)) return false;
	if (value.type === "session_snapshot") return isFutureSessionSnapshotDto(value, context);
	if (
		value.type === "session_snapshot_begin" ||
		value.type === "session_snapshot_chunk" ||
		value.type === "session_snapshot_end" ||
		value.type === "session_history_page_begin" ||
		value.type === "session_history_page_chunk" ||
		value.type === "session_history_page_end"
	) {
		if (sessionWsServerMessageBytes(value) > SESSION_WS_SERVER_MAX_BYTES) return false;
		if (value.type === "session_snapshot_begin") return isFutureSessionSnapshotBeginDto(value, context);
		if (value.type === "session_snapshot_chunk") return isFutureSessionHistoryChunkDto(value, context);
		if (value.type === "session_snapshot_end") {
			return isSessionSnapshotEndDto(value, futureAttachmentContext(context));
		}
		if (value.type === "session_history_page_begin") {
			return isSessionHistoryPageBeginDto(value, futureAttachmentContext(context));
		}
		if (value.type === "session_history_page_chunk") return isFutureSessionHistoryChunkDto(value, context);
		return isSessionHistoryPageEndDto(value, futureAttachmentContext(context));
	}
	if (sessionWsServerMessageBytes(value) > SESSION_WS_SERVER_MAX_BYTES) return false;
	if (value.type === "event") return isFutureSessionProjectionEventDto(value, context);
	if (value.type === "extension_ui_request" || value.type === "extension_ui_closed") {
		return isFutureSessionReplayFrameDto(value, context);
	}
	if (value.type === "extension_ui_snapshot") {
		return (
			hasOnlyKeys(value, ["type", "serverEpoch", "sessionHandle", "generation", "requests"]) &&
			value.serverEpoch === context.serverEpoch &&
			isString(value.sessionHandle) &&
			isGeneration(value.generation) &&
			Array.isArray(value.requests) &&
			value.requests.length <= SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS &&
			value.requests.every((request) => isFutureExtensionUiRequestDto(request, context))
		);
	}
	if (value.type === "response") {
		return (
			hasOnlyKeys(value, [
				"type",
				"serverEpoch",
				"sessionHandle",
				"generation",
				"barrierSeq",
				"response",
				"previousSessionHandle",
			]) &&
			isString(value.serverEpoch, 128) &&
			value.serverEpoch === context.serverEpoch &&
			isString(value.sessionHandle) &&
			isGeneration(value.generation) &&
			isGeneration(value.barrierSeq) &&
			(value.previousSessionHandle === undefined || isString(value.previousSessionHandle)) &&
			isFutureSessionCommandResponseDto(value.response, context)
		);
	}
	return isSessionWsServerMessage(value, futureAttachmentContext(context));
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
	readonly admissionError?: SessionPayloadAdmissionErrorDto;
	constructor(command: string, message: string, admissionError?: SessionPayloadAdmissionErrorDto) {
		super(message);
		this.name = "RpcError";
		this.command = command;
		this.admissionError = admissionError;
	}
}

export function isErrorResponse(
	response: SessionCommandResponseDto,
): response is Extract<SessionCommandResponseDto, { success: false }> {
	return response.type === "response" && response.success === false;
}

/**
 * Extract data from a success response and throw RpcError on a failed response.
 * Responses without a data payload return undefined.
 */
export function expectData(response: SessionCommandResponseDto): unknown {
	if (response.type !== "response") throw new RpcError("<no-command>", "not a response frame");
	if (response.success === false) {
		throw new RpcError(response.command, response.error, response.admissionError);
	}
	return "data" in response ? (response as { data: unknown }).data : undefined;
}

/** Extract the product-owned data shape for an expected command. */
export function expectCommandData<K extends SessionCommandTypeDto>(
	response: SessionCommandResponseDto,
	command: K,
): SessionCommandDataMap[K] {
	if (response.command !== command) {
		throw new RpcError(response.command, `expected ${command} response, received ${response.command}`);
	}
	if (response.success === false) {
		throw new RpcError(response.command, response.error, response.admissionError);
	}
	return ("data" in response ? response.data : undefined) as SessionCommandDataMap[K];
}
