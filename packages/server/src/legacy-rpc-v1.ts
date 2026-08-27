import {
	type AssistantMessageDto,
	isBoundedJsonValue,
	isExtensionUiRequestDto,
	isExtensionUiResponseDto,
	isModelDto,
	isProductSessionEventDto,
	isSessionCommandResponseDto,
	isSessionCommandTypeDto,
	type ProductSessionEventDto,
	type SessionCommandDto,
	type SessionCommandResponseDto,
	type SessionCommandTypeDto,
	type SessionEntryDto,
	type SessionMessageDto,
	type SessionTreeNodeDto,
} from "@pi-agent-web/protocol";
import {
	type PiCapability,
	type PiHostAdapter,
	type PiHostUnsolicitedFrame,
	PiProtocolIncompatibleError,
	probeExactPiVersion,
} from "./pi-host-adapter.js";

export const LEGACY_RPC_V1_ADAPTER_ID = "legacy-rpc-v1";

/**
 * Only these side-channel JSON frames are intentionally non-authoritative.
 * Every other unknown discriminant fails closed instead of being silently lost.
 */
export const LEGACY_RPC_V1_IGNORABLE_FRAME_TYPES: ReadonlySet<string> = new Set(["log"]);

const AUTHORITATIVE_EVENT_TYPES: ReadonlySet<string> = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"agent_settled",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"summarization_retry_scheduled",
	"summarization_retry_attempt_start",
	"summarization_retry_finished",
	"bash_execution_update",
	"entry_appended",
	"session_info_changed",
	"thinking_level_changed",
	"extension_error",
]);

type UnknownRecord = Record<string, unknown>;

const LEGACY_MODEL_KEYS = new Set([
	"id",
	"name",
	"api",
	"provider",
	"baseUrl",
	"reasoning",
	"thinkingLevelMap",
	"thinking",
	"input",
	"cost",
	"contextWindow",
	"maxTokens",
	"samplingParams",
	"headers",
	"compat",
]);

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function incompatible(
	frameKind: PiProtocolIncompatibleError["diagnostic"]["frameKind"],
	reason: PiProtocolIncompatibleError["diagnostic"]["reason"],
	frameType?: string,
): never {
	throw new PiProtocolIncompatibleError({
		code: "protocol_incompatible",
		adapterId: LEGACY_RPC_V1_ADAPTER_ID,
		frameKind,
		reason,
		...(frameType ? { frameType } : {}),
	});
}

function boundedFrameType(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[a-z0-9_]+$/u.test(value)
		? value
		: undefined;
}

function isBoundedString(value: unknown, maxChars = 8_192): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Pi's reviewed Model wire has provider-routing fields the Browser does not
 * consume. Validate that exact legacy shape, then copy only product fields so
 * headers/base URLs and future unknown keys never cross the adapter boundary.
 */
function normalizeLegacyModel(value: unknown): unknown {
	if (!isRecord(value) || !Object.keys(value).every((key) => LEGACY_MODEL_KEYS.has(key))) return value;
	if (
		(value.api !== undefined && !isBoundedString(value.api, 256)) ||
		(value.baseUrl !== undefined && (typeof value.baseUrl !== "string" || value.baseUrl.length > 8_192)) ||
		(value.input !== undefined &&
			(!Array.isArray(value.input) ||
				value.input.length > 2 ||
				!value.input.every((input) => input === "text" || input === "image"))) ||
		(value.maxTokens !== undefined && !isCount(value.maxTokens)) ||
		(value.thinkingLevelMap !== undefined && !isBoundedJsonValue(value.thinkingLevelMap)) ||
		(value.thinking !== undefined && !isBoundedJsonValue(value.thinking)) ||
		(value.samplingParams !== undefined && !isBoundedJsonValue(value.samplingParams)) ||
		(value.headers !== undefined && !isBoundedJsonValue(value.headers)) ||
		(value.compat !== undefined && !isBoundedJsonValue(value.compat))
	) {
		return value;
	}

	let cost = value.cost;
	if (isRecord(cost)) {
		if (
			!Object.keys(cost).every((key) =>
				["input", "output", "cacheRead", "cacheWrite", "total", "tiers"].includes(key),
			) ||
			(cost.tiers !== undefined && !isBoundedJsonValue(cost.tiers))
		) {
			return value;
		}
		cost = {
			input: cost.input,
			output: cost.output,
			cacheRead: cost.cacheRead,
			cacheWrite: cost.cacheWrite,
			...(cost.total === undefined ? {} : { total: cost.total }),
		};
	}

	const normalized = {
		id: value.id,
		name: value.name,
		provider: value.provider,
		...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
		...(value.contextWindow === undefined ? {} : { contextWindow: value.contextWindow }),
		...(cost === undefined ? {} : { cost }),
	};
	return isModelDto(normalized) ? normalized : value;
}

function normalizeLegacyResponse(value: unknown): unknown {
	if (!isRecord(value) || value.type !== "response" || value.success !== true || !isRecord(value.data)) {
		return value;
	}
	let data: unknown = value.data;
	switch (value.command) {
		case "get_state": {
			if (value.data.model === undefined) return value;
			const model = normalizeLegacyModel(value.data.model);
			if (model === value.data.model) return value;
			data = { ...value.data, model };
			break;
		}
		case "set_model":
			data = normalizeLegacyModel(value.data);
			break;
		case "cycle_model": {
			if (value.data.model === undefined) return value;
			const model = normalizeLegacyModel(value.data.model);
			if (model === value.data.model) return value;
			data = { ...value.data, model };
			break;
		}
		case "get_available_models":
			if (!Array.isArray(value.data.models)) return value;
			data = { ...value.data, models: value.data.models.map(normalizeLegacyModel) };
			break;
		default:
			return value;
	}
	return { ...value, data };
}

function hasGatewayOnlyResponseFields(value: UnknownRecord): boolean {
	return (
		value.admissionError !== undefined ||
		(value.command === "export_html" &&
			value.success === true &&
			isRecord(value.data) &&
			value.data.url !== undefined)
	);
}

function redactAssistantMetadata(message: AssistantMessageDto): AssistantMessageDto;
function redactAssistantMetadata(message: SessionMessageDto): SessionMessageDto;
function redactAssistantMetadata(message: SessionMessageDto): SessionMessageDto {
	if (message.role !== "assistant") return message;
	const {
		responseId: _responseId,
		diagnostics: _diagnostics,
		deferred: _deferred,
		...productMessage
	} = message;
	return productMessage;
}

function redactEntry(entry: SessionEntryDto): SessionEntryDto {
	return entry.type === "message" ? { ...entry, message: redactAssistantMetadata(entry.message) } : entry;
}

function redactTree(tree: SessionTreeNodeDto[]): SessionTreeNodeDto[] {
	return tree.map((node) => ({
		...node,
		entry: redactEntry(node.entry),
		children: redactTree(node.children),
	}));
}

function redactResponse(
	response: SessionCommandResponseDto & { id: string },
): SessionCommandResponseDto & { id: string } {
	if (!response.success) return response;
	switch (response.command) {
		case "get_messages":
			return {
				...response,
				data: { messages: response.data.messages.map(redactAssistantMetadata) },
			};
		case "get_entries":
			return {
				...response,
				data: { ...response.data, entries: response.data.entries.map(redactEntry) },
			};
		case "get_tree":
			return { ...response, data: { ...response.data, tree: redactTree(response.data.tree) } };
		default:
			return response;
	}
}

function redactEvent(event: ProductSessionEventDto): ProductSessionEventDto {
	switch (event.type) {
		case "agent_end":
			return { ...event, messages: event.messages.map(redactAssistantMetadata) };
		case "turn_end":
			return { ...event, message: redactAssistantMetadata(event.message) };
		case "message_start":
		case "message_end":
			return { ...event, message: redactAssistantMetadata(event.message) };
		case "entry_appended":
			return { ...event, entry: redactEntry(event.entry) };
		case "message_update": {
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "done" && streamEvent.message) {
				return {
					...event,
					assistantMessageEvent: {
						...streamEvent,
						message: redactAssistantMetadata(streamEvent.message),
					},
				};
			}
			if (streamEvent.type === "error" && streamEvent.error) {
				return {
					...event,
					assistantMessageEvent: {
						...streamEvent,
						error: redactAssistantMetadata(streamEvent.error),
					},
				};
			}
			return event;
		}
		default:
			return event;
	}
}

export function createLegacyRpcV1Adapter(
	version: string,
	capabilities: readonly PiCapability[],
): PiHostAdapter {
	const requiresToolcallIdentity = capabilities.includes("rpc.toolcall_identity");
	return {
		id: LEGACY_RPC_V1_ADAPTER_ID,
		version,
		capabilities,
		probeVersion: probeExactPiVersion,

		createSessionArguments(target) {
			return ["--session-id", target.nativeSessionId, "--session-dir", target.sessionDir];
		},

		openSessionArguments(target) {
			return ["--session", target.sessionFile, "--session-dir", target.sessionDir];
		},

		encodeCommand(command) {
			return command;
		},

		encodeExtensionUiResponse(response) {
			if (!isExtensionUiResponseDto(response)) {
				throw new TypeError("invalid product Extension UI response");
			}
			return response;
		},

		decodeResponse(value, expectedCommand) {
			const normalized = normalizeLegacyResponse(value);
			const frameType = isRecord(normalized) ? boundedFrameType(normalized.command) : undefined;
			if (!isRecord(normalized) || normalized.type !== "response" || typeof normalized.id !== "string") {
				return incompatible("response", "malformed_response", frameType);
			}
			if (normalized.command !== expectedCommand) {
				return incompatible("response", "response_command_mismatch", frameType);
			}
			if (hasGatewayOnlyResponseFields(normalized)) {
				return incompatible("response", "malformed_response", frameType);
			}
			if (!isSessionCommandResponseDto(normalized)) {
				return incompatible("response", "malformed_response", frameType);
			}
			return redactResponse(normalized as SessionCommandResponseDto & { id: string });
		},

		decodeOrphanedResponse(value) {
			const normalized = normalizeLegacyResponse(value);
			const frameType = isRecord(normalized) ? boundedFrameType(normalized.command) : undefined;
			if (
				!isRecord(normalized) ||
				normalized.type !== "response" ||
				typeof normalized.id !== "string" ||
				hasGatewayOnlyResponseFields(normalized) ||
				!isSessionCommandTypeDto(normalized.command) ||
				!isSessionCommandResponseDto(normalized)
			) {
				return incompatible("response", "malformed_response", frameType);
			}
		},

		decodeUnsolicited(value): PiHostUnsolicitedFrame {
			if (!isRecord(value) || typeof value.type !== "string") {
				return incompatible("frame", "malformed_frame");
			}
			if (value.type === "extension_ui_request") {
				if (!isExtensionUiRequestDto(value)) {
					return incompatible(
						"extension_ui_request",
						"malformed_extension_ui_request",
						"extension_ui_request",
					);
				}
				return { kind: "extension_ui_request", request: value };
			}
			if (isProductSessionEventDto(value)) {
				const event = redactEvent(value);
				if (
					requiresToolcallIdentity &&
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "toolcall_start" &&
					(typeof event.assistantMessageEvent.id !== "string" ||
						typeof event.assistantMessageEvent.toolName !== "string")
				) {
					return incompatible("event", "malformed_event", "toolcall_start");
				}
				return { kind: "event", event };
			}
			if (AUTHORITATIVE_EVENT_TYPES.has(value.type)) {
				return incompatible("event", "malformed_event", boundedFrameType(value.type));
			}
			if (LEGACY_RPC_V1_IGNORABLE_FRAME_TYPES.has(value.type)) {
				return { kind: "ignored", frameType: value.type };
			}
			return incompatible("event", "unknown_authoritative_event", boundedFrameType(value.type));
		},
	};
}

const LEGACY_CURRENT_CAPABILITIES = [
	"session.create",
	"session.open",
	"session.fork",
	"session.clone",
	"rpc.commands",
	"rpc.events",
	"rpc.extension_ui",
] as const satisfies readonly PiCapability[];

export const legacyRpcV1Adapter = createLegacyRpcV1Adapter("0.84.2", LEGACY_CURRENT_CAPABILITIES);

export function encodeLegacyRpcV1Command(command: SessionCommandDto & { id: string }): unknown {
	return legacyRpcV1Adapter.encodeCommand(command);
}

export function decodeLegacyRpcV1Response(value: unknown, command: SessionCommandTypeDto) {
	return legacyRpcV1Adapter.decodeResponse(value, command);
}
