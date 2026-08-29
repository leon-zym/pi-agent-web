import type {
	JsonAgentSessionEvent,
	RpcExtensionUIRequest,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { SessionCommandTypeDto } from "@pi-agent-web/protocol";
import {
	isBoundedJsonValue,
	isExtensionUiRequestDto,
	isProductSessionEventDto,
	isSessionCommandResponseDto,
	isSessionEntryDto,
	isSessionMessageDto,
	isUsageDto,
	PI_WIRE_RUNTIME_SCHEMAS,
} from "@pi-agent-web/protocol";

/** Upstream Pi stdout types. These are deliberately not product DTO aliases. */
export type LegacyRpcV1RawResponse = RpcResponse;
export type LegacyRpcV1RawEvent = JsonAgentSessionEvent;
export type LegacyRpcV1RawExtensionUiRequest = RpcExtensionUIRequest;

type UnknownRecord = Record<string, unknown>;

const MAX_ARRAY_ITEMS = 10_000;
const MAX_TREE_DEPTH = 128;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isString(value: unknown, maxChars = 256): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isArrayOf(value: unknown, guard: (item: unknown) => boolean): boolean {
	return Array.isArray(value) && value.length <= MAX_ARRAY_ITEMS && value.every(guard);
}

/** Image bytes remain inline only on the Pi side of the adapter seam. */
function isRawPiImageContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "data", "mimeType"]) &&
		value.type === "image" &&
		typeof value.data === "string" &&
		isString(value.mimeType)
	);
}

function isProductTextContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "text" &&
		isSessionMessageDto({ role: "user", content: [value], timestamp: 0 })
	);
}

function isRawPiMessageContent(value: unknown): boolean {
	return (
		(typeof value === "string" && isSessionMessageDto({ role: "user", content: value, timestamp: 0 })) ||
		isArrayOf(value, (block) => isProductTextContent(block) || isRawPiImageContent(block))
	);
}

/** Only image data receives raw-wire headroom; every other field keeps product limits. */
function isRawPiMessage(value: unknown): boolean {
	if (!isRecord(value) || typeof value.role !== "string") return false;
	switch (value.role) {
		case "user":
			return (
				hasOnlyKeys(value, ["role", "content", "timestamp"]) &&
				isRawPiMessageContent(value.content) &&
				isCount(value.timestamp)
			);
		case "toolResult":
			return (
				hasOnlyKeys(value, [
					"role",
					"toolCallId",
					"toolName",
					"content",
					"details",
					"usage",
					"addedToolNames",
					"isError",
					"timestamp",
				]) &&
				isString(value.toolCallId) &&
				isString(value.toolName) &&
				isArrayOf(value.content, (block) => isProductTextContent(block) || isRawPiImageContent(block)) &&
				(value.details === undefined || isBoundedJsonValue(value.details)) &&
				(value.usage === undefined || isUsageDto(value.usage)) &&
				(value.addedToolNames === undefined ||
					(Array.isArray(value.addedToolNames) &&
						value.addedToolNames.length <= 1_000 &&
						value.addedToolNames.every((item) => isString(item)))) &&
				typeof value.isError === "boolean" &&
				isCount(value.timestamp)
			);
		case "custom":
			return (
				hasOnlyKeys(value, ["role", "customType", "content", "display", "details", "timestamp"]) &&
				isString(value.customType) &&
				isRawPiMessageContent(value.content) &&
				typeof value.display === "boolean" &&
				(value.details === undefined || isBoundedJsonValue(value.details)) &&
				isCount(value.timestamp)
			);
		default:
			return isSessionMessageDto(value);
	}
}

function isRawPiEntry(value: unknown): boolean {
	if (
		!isRecord(value) ||
		!isString(value.id) ||
		!(value.parentId === null || isString(value.parentId)) ||
		!isString(value.timestamp, 128)
	)
		return false;
	if (value.type === "message") {
		return (
			hasOnlyKeys(value, ["type", "id", "parentId", "timestamp", "message"]) && isRawPiMessage(value.message)
		);
	}
	if (value.type === "custom_message") {
		return (
			hasOnlyKeys(value, [
				"type",
				"id",
				"parentId",
				"timestamp",
				"customType",
				"content",
				"details",
				"display",
			]) &&
			isString(value.customType) &&
			isRawPiMessageContent(value.content) &&
			(value.details === undefined || isBoundedJsonValue(value.details)) &&
			typeof value.display === "boolean"
		);
	}
	return isSessionEntryDto(value);
}

function isRawPiTree(value: unknown): boolean {
	if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return false;
	const stack = value.map((node) => ({ node, depth: 0 }));
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || current.depth > MAX_TREE_DEPTH || ++nodes > MAX_ARRAY_ITEMS || !isRecord(current.node))
			return false;
		if (
			!hasOnlyKeys(current.node, ["entry", "children", "label", "labelTimestamp"]) ||
			!isRawPiEntry(current.node.entry) ||
			!Array.isArray(current.node.children) ||
			current.node.children.length > MAX_ARRAY_ITEMS ||
			(current.node.label !== undefined &&
				!(
					typeof current.node.label === "string" &&
					isSessionMessageDto({ role: "user", content: current.node.label, timestamp: 0 })
				)) ||
			(current.node.labelTimestamp !== undefined && !isString(current.node.labelTimestamp, 128))
		)
			return false;
		for (const child of current.node.children) stack.push({ node: child, depth: current.depth + 1 });
	}
	return true;
}

function isWideImageResponse(value: UnknownRecord, command: SessionCommandTypeDto): boolean {
	if (value.command !== command || value.success !== true || !isRecord(value.data)) return false;
	if (!hasOnlyKeys(value, ["type", "id", "command", "success", "data"])) return false;
	switch (command) {
		case "get_messages":
			return hasOnlyKeys(value.data, ["messages"]) && isArrayOf(value.data.messages, isRawPiMessage);
		case "get_entries":
			return (
				hasOnlyKeys(value.data, ["entries", "leafId"]) &&
				isArrayOf(value.data.entries, isRawPiEntry) &&
				(value.data.leafId === null || isString(value.data.leafId))
			);
		case "get_tree":
			return (
				hasOnlyKeys(value.data, ["tree", "leafId"]) &&
				isRawPiTree(value.data.tree) &&
				(value.data.leafId === null || isString(value.data.leafId))
			);
		default:
			return false;
	}
}

export function isLegacyRpcV1RawResponse(
	value: unknown,
	expectedCommand: SessionCommandTypeDto,
	productGuard: (candidate: unknown) => boolean = isSessionCommandResponseDto,
): value is LegacyRpcV1RawResponse {
	if (!PI_WIRE_RUNTIME_SCHEMAS.response.check(value)) return false;
	if (
		!isRecord(value) ||
		value.type !== "response" ||
		typeof value.id !== "string" ||
		Object.hasOwn(value, "admissionError")
	)
		return false;
	if (value.command !== expectedCommand) return false;
	if (
		value.success === true &&
		(expectedCommand === "get_messages" ||
			expectedCommand === "get_entries" ||
			expectedCommand === "get_tree")
	) {
		return isWideImageResponse(value, expectedCommand);
	}
	return productGuard(value);
}

function isWideImageEvent(value: UnknownRecord): boolean {
	switch (value.type) {
		case "agent_end":
			return (
				hasOnlyKeys(value, ["type", "messages", "willRetry"]) &&
				isArrayOf(value.messages, isRawPiMessage) &&
				typeof value.willRetry === "boolean"
			);
		case "turn_end":
			return (
				hasOnlyKeys(value, ["type", "message", "toolResults"]) &&
				isRawPiMessage(value.message) &&
				isArrayOf(
					value.toolResults,
					(message) => isRecord(message) && message.role === "toolResult" && isRawPiMessage(message),
				)
			);
		case "message_start":
		case "message_end":
			return hasOnlyKeys(value, ["type", "message"]) && isRawPiMessage(value.message);
		case "entry_appended":
			return hasOnlyKeys(value, ["type", "entry"]) && isRawPiEntry(value.entry);
		default:
			return false;
	}
}

export function isLegacyRpcV1RawEvent(
	value: unknown,
	productGuard: (candidate: unknown) => boolean = isProductSessionEventDto,
): value is LegacyRpcV1RawEvent {
	if (!PI_WIRE_RUNTIME_SCHEMAS.event.check(value)) return false;
	if (!isRecord(value)) return false;
	if (
		value.type === "agent_end" ||
		value.type === "turn_end" ||
		value.type === "message_start" ||
		value.type === "message_end" ||
		value.type === "entry_appended"
	) {
		return isWideImageEvent(value);
	}
	return productGuard(value);
}

export function isLegacyRpcV1RawExtensionUiRequest(
	value: unknown,
): value is LegacyRpcV1RawExtensionUiRequest {
	return PI_WIRE_RUNTIME_SCHEMAS.extensionUiRequest.check(value) && isExtensionUiRequestDto(value);
}
