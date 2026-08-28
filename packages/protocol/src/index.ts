/** Browser-safe, product-owned WebSocket and REST DTOs shared by the gateway and UI. */

import {
	isFutureProductSessionEventDto,
	isFutureSessionCommandResponseDto,
	isFutureSessionMessageDto,
} from "./future-product-decoders.js";
import type {
	FutureProductSessionEventDto,
	FutureSessionCommandResponseDto,
	FutureSessionMessageDto,
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

export * from "./future-product-decoders.js";
export * from "./future-product-dto.js";
export * from "./gateway-handshake.js";
export * from "./payload-budget.js";
export * from "./product-decoders.js";
export * from "./product-dto.js";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PATH_LENGTH = 8192;
export const SESSION_SNAPSHOT_MAX_MESSAGES = 10_000;
export const SESSION_SNAPSHOT_MAX_PROJECTION_EVENTS = 4_096;
export const SESSION_SNAPSHOT_MAX_QUEUE_ITEMS = 10_000;
export const SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS = 256;
export const SESSION_SNAPSHOT_MAX_DEPTH = 48;
export const SESSION_SNAPSHOT_MAX_ITEMS = 250_000;
export const SESSION_HOT_RUNTIME_INVENTORY_MAX_ITEMS = 256;
/** Covers the worst canonical JSON envelope for 256 maximum escaped identities. */
export const SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES = 1024 * 1024;

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
	| { type: "session_unsubscribe"; sessionHandle: string }
	| { type: "session_claim"; sessionHandle: string }
	| { type: "session_release"; sessionHandle: string };

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

export type SessionWsServerMessage =
	| SessionResponseFrameDto
	| SessionReplayFrameDto
	| { type: "runtime_state"; runtime: SessionRuntimeDto }
	| SessionLeaseStatusDto
	| SessionResyncRequiredDto
	| SessionSnapshotDto
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
	| {
			type: "session_error";
			serverEpoch: string;
			sessionHandle: string;
			operation: "subscribe" | "claim" | "release" | "extension_ui_response";
			error: string;
	  }
	| { type: "session_directory_changed"; workspaceId: string }
	| { type: "auth_changed"; workspaceId?: string };

export type FutureSessionReplayFrameDto =
	| (SessionSequencedEnvelopeDto & { type: "event"; event: FutureProductSessionEventDto })
	| Exclude<SessionReplayFrameDto, { type: "event" }>;

export type FutureSessionProjectionEventDto = Extract<FutureSessionReplayFrameDto, { type: "event" }>;

export interface FutureSessionSnapshotDto
	extends Omit<SessionSnapshotDto, "settledMessages" | "projectionEvents"> {
	settledMessages: FutureSessionMessageDto[];
	projectionEvents: FutureSessionProjectionEventDto[];
}

export interface FutureSessionResponseFrameDto extends Omit<SessionResponseFrameDto, "response"> {
	response: FutureSessionCommandResponseDto;
}

export type FutureSessionWsServerMessage =
	| FutureSessionResponseFrameDto
	| FutureSessionReplayFrameDto
	| FutureSessionSnapshotDto
	| Exclude<SessionWsServerMessage, SessionResponseFrameDto | SessionReplayFrameDto | SessionSnapshotDto>;

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
			!hasOnlyKeys(runtime, ["serverEpoch", "sessionHandle", "workspaceId", "generation", "state"]) ||
			!isString(runtime.serverEpoch, 128) ||
			runtime.serverEpoch !== value.serverEpoch ||
			!isString(runtime.sessionHandle) ||
			!isString(runtime.workspaceId) ||
			!isGeneration(runtime.generation) ||
			runtime.generation === 0 ||
			!["starting", "idle", "running", "waiting_ui"].includes(String(runtime.state)) ||
			handles.has(runtime.sessionHandle)
		) {
			return false;
		}
		handles.add(runtime.sessionHandle);
	}
	return true;
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
		case "session_error":
			return (
				hasOnlyKeys(value, ["type", "serverEpoch", "sessionHandle", "operation", "error"]) &&
				isString(value.serverEpoch, 128) &&
				isString(value.sessionHandle) &&
				["subscribe", "claim", "release", "extension_ui_response"].includes(String(value.operation)) &&
				isBoundedString(value.error, SESSION_TEXT_MAX_BYTES)
			);
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
	if (value.type !== "extension_ui_request" && value.type !== "extension_ui_closed") return false;
	return isSessionWsServerMessage(value, futureAttachmentContext(context));
}

function isCanonicalFutureSessionSnapshotDto(
	value: unknown,
	context: FutureSessionContentRefGuardContext,
): value is FutureSessionSnapshotDto {
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
	if (!context || !isFutureSessionContentRefGuardContext(context) || !isRecord(value)) return false;
	if (value.type === "session_snapshot") return isFutureSessionSnapshotDto(value, context);
	if (sessionWsServerMessageBytes(value) > SESSION_WS_SERVER_MAX_BYTES) return false;
	if (value.type === "event") return isFutureSessionProjectionEventDto(value, context);
	if (value.type === "extension_ui_request" || value.type === "extension_ui_closed") {
		return isFutureSessionReplayFrameDto(value, context);
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
