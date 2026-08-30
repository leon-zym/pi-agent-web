import type {
	JsonAgentSessionEvent,
	RpcExtensionUIRequest,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { SessionCommandTypeDto } from "@pi-agent-web/protocol";
import {
	isBoundedJsonValue,
	isExtensionUiRequestDto,
	isSessionEntryDto,
	isSessionMessageDto,
	isUsageDto,
} from "@pi-agent-web/protocol";
import { MAX_JSONL_SNAPSHOT_LINE_BYTES } from "./jsonl.js";
import { isPiRpcRawEvent, isPiRpcRawResponse } from "./pi-rpc-wire.js";

/** Pi-owned JSON before the Gateway wraps or externalizes an approved root. */
export type PiRpcUntrustedJsonRoot =
	| null
	| boolean
	| number
	| string
	| PiRpcUntrustedJsonRoot[]
	| { [key: string]: PiRpcUntrustedJsonRoot };

/** Pi-owned text before the Gateway creates an external_text wrapper. */
export type PiRpcUntrustedTextRoot = string;

/** Content-reference raw frames whose large roots are externalized after validation. */
export type PiRpcContentRawResponse = RpcResponse;
export type PiRpcContentRawEvent = JsonAgentSessionEvent;
export type PiRpcContentRawExtensionUiRequest = RpcExtensionUIRequest;

type UnknownRecord = Record<string, unknown>;

const MAX_IDENTIFIER_CHARS = 256;
const MAX_PATH_CHARS = 8_192;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_TEXT_BYTES = 48 * 1024 * 1024;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_TREE_DEPTH = 128;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ITEMS = 50_000;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isIdentifier(value: unknown, maxChars = MAX_IDENTIFIER_CHARS): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function isCount(value: unknown): value is number {
	return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isTextWithin(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && Buffer.byteLength(value) <= maxBytes;
}

function isOptionalTextWithin(value: unknown, maxBytes: number): value is string | undefined {
	return value === undefined || isTextWithin(value, maxBytes);
}

function isArrayOf(value: unknown, guard: (item: unknown) => boolean, max = MAX_ARRAY_ITEMS): boolean {
	return Array.isArray(value) && value.length <= max && value.every(guard);
}

/**
 * Validate only the JSON data model and resource bounds. Discriminants are deliberately opaque:
 * exact or nested product-wrapper lookalikes remain ordinary Pi JSON at this boundary.
 */
export function isPiRpcUntrustedJsonRoot(value: unknown): value is PiRpcUntrustedJsonRoot {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	const seen = new Set<object>();
	let items = 0;
	let stringBytes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || current.depth > MAX_JSON_DEPTH || ++items > MAX_JSON_ITEMS) return false;
		const candidate = current.value;
		if (candidate === null || typeof candidate === "boolean") continue;
		if (typeof candidate === "number") {
			if (!isFiniteNumber(candidate)) return false;
			continue;
		}
		if (typeof candidate === "string") {
			stringBytes += Buffer.byteLength(candidate);
			if (stringBytes > MAX_JSONL_SNAPSHOT_LINE_BYTES) return false;
			continue;
		}
		if (typeof candidate !== "object" || seen.has(candidate)) return false;
		seen.add(candidate);
		if (Array.isArray(candidate)) {
			if (candidate.length > MAX_ARRAY_ITEMS || Object.keys(candidate).length !== candidate.length)
				return false;
			for (let index = candidate.length - 1; index >= 0; index -= 1) {
				const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
				stack.push({ value: descriptor.value, depth: current.depth + 1 });
			}
			continue;
		}
		if (Object.getPrototypeOf(candidate) !== Object.prototype) return false;
		const ownKeys = Reflect.ownKeys(candidate);
		if (ownKeys.length > MAX_ARRAY_ITEMS || ownKeys.some((key) => typeof key !== "string")) return false;
		for (const key of ownKeys) {
			const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
			stack.push({ value: descriptor.value, depth: current.depth + 1 });
		}
	}
	return true;
}

export function isPiRpcUntrustedTextRoot(value: unknown): value is PiRpcUntrustedTextRoot {
	return isTextWithin(value, MAX_JSONL_SNAPSHOT_LINE_BYTES);
}

export function isPiRpcContentRawExtensionUiRequest(
	value: unknown,
): value is PiRpcContentRawExtensionUiRequest {
	if (!isRecord(value)) return false;
	switch (value.method) {
		case "editor":
			return (
				(value.prefill === undefined || isPiRpcUntrustedTextRoot(value.prefill)) &&
				isExtensionUiRequestDto({ ...value, prefill: value.prefill === undefined ? undefined : "" })
			);
		case "set_editor_text":
			return isPiRpcUntrustedTextRoot(value.text) && isExtensionUiRequestDto({ ...value, text: "" });
		case "setWidget":
			return (
				(value.widgetLines === undefined ||
					(Array.isArray(value.widgetLines) &&
						value.widgetLines.length <= 1_000 &&
						value.widgetLines.every((line) => typeof line === "string") &&
						isPiRpcUntrustedJsonRoot(value.widgetLines))) &&
				isExtensionUiRequestDto({
					...value,
					widgetLines: value.widgetLines === undefined ? undefined : [],
				})
			);
		default:
			return isExtensionUiRequestDto(value);
	}
}

function isRawPiImageContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "data", "mimeType"]) &&
		value.type === "image" &&
		typeof value.data === "string" &&
		isIdentifier(value.mimeType)
	);
}

function isProductTextContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "text", "textSignature"]) &&
		value.type === "text" &&
		isTextWithin(value.text, MAX_SNAPSHOT_TEXT_BYTES) &&
		isOptionalTextWithin(value.textSignature, MAX_TEXT_BYTES)
	);
}

function isFutureRawTextContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "text", "textSignature"]) &&
		value.type === "text" &&
		isPiRpcUntrustedTextRoot(value.text) &&
		isOptionalTextWithin(value.textSignature, MAX_TEXT_BYTES)
	);
}

function isThinkingContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "thinking", "thinkingSignature", "redacted"]) &&
		value.type === "thinking" &&
		isTextWithin(value.thinking, MAX_TEXT_BYTES) &&
		isOptionalTextWithin(value.thinkingSignature, MAX_TEXT_BYTES) &&
		(value.redacted === undefined || typeof value.redacted === "boolean")
	);
}

function isFutureRawToolCallContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "id", "name", "arguments", "thoughtSignature", "namespace"]) &&
		value.type === "toolCall" &&
		isIdentifier(value.id) &&
		isIdentifier(value.name) &&
		isPiRpcUntrustedJsonRoot(value.arguments) &&
		isOptionalTextWithin(value.thoughtSignature, MAX_TEXT_BYTES) &&
		(value.namespace === undefined || isIdentifier(value.namespace))
	);
}

function isDiagnosticError(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["name", "message", "stack", "code"]) &&
		(value.name === undefined || isIdentifier(value.name)) &&
		isTextWithin(value.message, MAX_TEXT_BYTES) &&
		isOptionalTextWithin(value.stack, MAX_TEXT_BYTES) &&
		(value.code === undefined || isIdentifier(value.code) || isFiniteNumber(value.code))
	);
}

function isAssistantDiagnostic(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "timestamp", "error", "details"]) &&
		isIdentifier(value.type) &&
		isCount(value.timestamp) &&
		(value.error === undefined || isDiagnosticError(value.error)) &&
		(value.details === undefined || (isRecord(value.details) && isBoundedJsonValue(value.details)))
	);
}

function isDeferredHandle(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["provider", "modelId", "api", "id", "expiresAt", "pollAfterMs", "data"]) &&
		isIdentifier(value.provider) &&
		isIdentifier(value.modelId) &&
		isIdentifier(value.api) &&
		isIdentifier(value.id) &&
		(value.expiresAt === undefined || isCount(value.expiresAt)) &&
		(value.pollAfterMs === undefined || isCount(value.pollAfterMs)) &&
		(value.data === undefined || isBoundedJsonValue(value.data))
	);
}

function isFutureRawAssistantMessage(value: UnknownRecord): boolean {
	return (
		hasOnlyKeys(value, [
			"role",
			"content",
			"usage",
			"stopReason",
			"errorMessage",
			"timestamp",
			"api",
			"provider",
			"model",
			"responseModel",
			"responseId",
			"diagnostics",
			"deferred",
			"rawStopReason",
			"endTurn",
		]) &&
		isArrayOf(
			value.content,
			(block) => isProductTextContent(block) || isThinkingContent(block) || isFutureRawToolCallContent(block),
		) &&
		isUsageDto(value.usage) &&
		["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(
			value.stopReason as string,
		) &&
		isOptionalTextWithin(value.errorMessage, MAX_TEXT_BYTES) &&
		(value.api === undefined || isIdentifier(value.api)) &&
		(value.provider === undefined || isIdentifier(value.provider)) &&
		(value.model === undefined || isIdentifier(value.model)) &&
		(value.responseModel === undefined || isIdentifier(value.responseModel)) &&
		(value.responseId === undefined || isIdentifier(value.responseId)) &&
		(value.diagnostics === undefined || isArrayOf(value.diagnostics, isAssistantDiagnostic, 1_000)) &&
		(value.deferred === undefined || isDeferredHandle(value.deferred)) &&
		isOptionalTextWithin(value.rawStopReason, MAX_TEXT_BYTES) &&
		(value.endTurn === undefined || typeof value.endTurn === "boolean") &&
		isCount(value.timestamp)
	);
}

function isExistingRawMessageContent(value: unknown): boolean {
	return (
		isTextWithin(value, MAX_TEXT_BYTES) ||
		isArrayOf(value, (block) => isProductTextContent(block) || isRawPiImageContent(block))
	);
}

function isFutureRawContentBlocks(value: unknown): boolean {
	return isArrayOf(value, (block) => isFutureRawTextContent(block) || isRawPiImageContent(block));
}

function isFutureRawMessage(value: unknown): boolean {
	if (!isRecord(value) || typeof value.role !== "string") return false;
	switch (value.role) {
		case "assistant":
			return isFutureRawAssistantMessage(value);
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
				isIdentifier(value.toolCallId) &&
				isIdentifier(value.toolName) &&
				isFutureRawContentBlocks(value.content) &&
				(value.details === undefined || isPiRpcUntrustedJsonRoot(value.details)) &&
				(value.usage === undefined || isUsageDto(value.usage)) &&
				(value.addedToolNames === undefined ||
					isArrayOf(value.addedToolNames, (item) => isIdentifier(item), 1_000)) &&
				typeof value.isError === "boolean" &&
				isCount(value.timestamp)
			);
		case "bashExecution":
			return (
				hasOnlyKeys(value, [
					"role",
					"command",
					"output",
					"exitCode",
					"cancelled",
					"truncated",
					"fullOutputPath",
					"excludeFromContext",
					"timestamp",
				]) &&
				isTextWithin(value.command, MAX_TEXT_BYTES) &&
				isPiRpcUntrustedTextRoot(value.output) &&
				(value.exitCode === undefined ||
					(isFiniteNumber(value.exitCode) && Number.isSafeInteger(value.exitCode))) &&
				typeof value.cancelled === "boolean" &&
				typeof value.truncated === "boolean" &&
				(value.fullOutputPath === undefined || isIdentifier(value.fullOutputPath, MAX_PATH_CHARS)) &&
				(value.excludeFromContext === undefined || typeof value.excludeFromContext === "boolean") &&
				isCount(value.timestamp)
			);
		case "custom":
			return (
				hasOnlyKeys(value, ["role", "customType", "content", "display", "details", "timestamp"]) &&
				isIdentifier(value.customType) &&
				(isTextWithin(value.content, MAX_TEXT_BYTES) || isFutureRawContentBlocks(value.content)) &&
				typeof value.display === "boolean" &&
				(value.details === undefined || isPiRpcUntrustedJsonRoot(value.details)) &&
				isCount(value.timestamp)
			);
		case "user":
			return (
				hasOnlyKeys(value, ["role", "content", "timestamp"]) &&
				isExistingRawMessageContent(value.content) &&
				isCount(value.timestamp)
			);
		default:
			return isSessionMessageDto(value);
	}
}

function isEntryIdentity(value: UnknownRecord): boolean {
	return (
		isIdentifier(value.id) &&
		(value.parentId === null || isIdentifier(value.parentId)) &&
		isIdentifier(value.timestamp, 128)
	);
}

function isFutureRawEntry(value: unknown): boolean {
	if (!isRecord(value) || !isEntryIdentity(value)) return false;
	if (value.type === "message") {
		return (
			hasOnlyKeys(value, ["type", "id", "parentId", "timestamp", "message"]) &&
			isFutureRawMessage(value.message)
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
			isIdentifier(value.customType) &&
			(isTextWithin(value.content, MAX_TEXT_BYTES) || isFutureRawContentBlocks(value.content)) &&
			(value.details === undefined || isPiRpcUntrustedJsonRoot(value.details)) &&
			typeof value.display === "boolean"
		);
	}
	return isSessionEntryDto(value);
}

function isFutureRawTree(value: unknown): boolean {
	if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return false;
	const stack = value.map((node) => ({ node, depth: 0 }));
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || current.depth > MAX_TREE_DEPTH || ++nodes > MAX_ARRAY_ITEMS || !isRecord(current.node))
			return false;
		if (
			!hasOnlyKeys(current.node, ["entry", "children", "label", "labelTimestamp"]) ||
			!isFutureRawEntry(current.node.entry) ||
			!Array.isArray(current.node.children) ||
			current.node.children.length > MAX_ARRAY_ITEMS ||
			(current.node.label !== undefined && !isTextWithin(current.node.label, MAX_TEXT_BYTES)) ||
			(current.node.labelTimestamp !== undefined && !isIdentifier(current.node.labelTimestamp, 128))
		)
			return false;
		for (const child of current.node.children) stack.push({ node: child, depth: current.depth + 1 });
	}
	return true;
}

function isFutureContentHistoryResponse(
	value: UnknownRecord,
	command: "get_messages" | "get_entries" | "get_tree",
): boolean {
	if (
		value.type !== "response" ||
		!isIdentifier(value.id) ||
		value.command !== command ||
		value.success !== true ||
		!isRecord(value.data) ||
		!hasOnlyKeys(value, ["type", "id", "command", "success", "data"])
	)
		return false;
	switch (command) {
		case "get_messages":
			return hasOnlyKeys(value.data, ["messages"]) && isArrayOf(value.data.messages, isFutureRawMessage);
		case "get_entries":
			return (
				hasOnlyKeys(value.data, ["entries", "leafId"]) &&
				isArrayOf(value.data.entries, isFutureRawEntry) &&
				(value.data.leafId === null || isIdentifier(value.data.leafId))
			);
		case "get_tree":
			return (
				hasOnlyKeys(value.data, ["tree", "leafId"]) &&
				isFutureRawTree(value.data.tree) &&
				(value.data.leafId === null || isIdentifier(value.data.leafId))
			);
	}
}

export function isPiRpcContentRawResponse(
	value: unknown,
	expectedCommand: SessionCommandTypeDto,
): value is PiRpcContentRawResponse {
	if (
		isRecord(value) &&
		value.success === true &&
		(expectedCommand === "get_messages" ||
			expectedCommand === "get_entries" ||
			expectedCommand === "get_tree")
	) {
		return isFutureContentHistoryResponse(value, expectedCommand);
	}
	return isPiRpcRawResponse(value, expectedCommand);
}

function isFutureRawMessageEvent(value: UnknownRecord): boolean {
	switch (value.type) {
		case "agent_end":
			return (
				hasOnlyKeys(value, ["type", "messages", "willRetry"]) &&
				isArrayOf(value.messages, isFutureRawMessage) &&
				typeof value.willRetry === "boolean"
			);
		case "turn_end":
			return (
				hasOnlyKeys(value, ["type", "message", "toolResults"]) &&
				isFutureRawMessage(value.message) &&
				isArrayOf(
					value.toolResults,
					(message) => isRecord(message) && message.role === "toolResult" && isFutureRawMessage(message),
				)
			);
		case "message_start":
		case "message_end":
			return hasOnlyKeys(value, ["type", "message"]) && isFutureRawMessage(value.message);
		case "entry_appended":
			return hasOnlyKeys(value, ["type", "entry"]) && isFutureRawEntry(value.entry);
		default:
			return false;
	}
}

function isFutureRawToolCallEndUpdate(value: UnknownRecord): boolean {
	if (
		!hasOnlyKeys(value, ["type", "usage", "assistantMessageEvent"]) ||
		!isUsageDto(value.usage) ||
		!isRecord(value.assistantMessageEvent)
	)
		return false;
	const event = value.assistantMessageEvent;
	return (
		hasOnlyKeys(event, ["type", "contentIndex", "toolCall"]) &&
		event.type === "toolcall_end" &&
		isCount(event.contentIndex) &&
		isFutureRawToolCallContent(event.toolCall)
	);
}

function isFutureRawToolExecutionEvent(value: UnknownRecord): boolean {
	if (!isIdentifier(value.toolCallId) || !isIdentifier(value.toolName)) return false;
	switch (value.type) {
		case "tool_execution_start":
			return (
				hasOnlyKeys(value, ["type", "toolCallId", "toolName", "args"]) && isPiRpcUntrustedJsonRoot(value.args)
			);
		case "tool_execution_update":
			return (
				hasOnlyKeys(value, ["type", "toolCallId", "toolName", "args", "partialResult"]) &&
				isPiRpcUntrustedJsonRoot(value.args) &&
				isPiRpcUntrustedJsonRoot(value.partialResult)
			);
		case "tool_execution_end":
			return (
				hasOnlyKeys(value, ["type", "toolCallId", "toolName", "result", "isError"]) &&
				isPiRpcUntrustedJsonRoot(value.result) &&
				typeof value.isError === "boolean"
			);
		default:
			return false;
	}
}

export function isPiRpcContentRawEvent(value: unknown): value is PiRpcContentRawEvent {
	if (!isRecord(value)) return false;
	if (
		value.type === "agent_end" ||
		value.type === "turn_end" ||
		value.type === "message_start" ||
		value.type === "message_end" ||
		value.type === "entry_appended"
	) {
		return isFutureRawMessageEvent(value);
	}
	if (value.type === "message_update" && isRecord(value.assistantMessageEvent)) {
		return value.assistantMessageEvent.type === "toolcall_end"
			? isFutureRawToolCallEndUpdate(value)
			: isPiRpcRawEvent(value);
	}
	if (
		value.type === "tool_execution_start" ||
		value.type === "tool_execution_update" ||
		value.type === "tool_execution_end"
	) {
		return isFutureRawToolExecutionEvent(value);
	}
	return isPiRpcRawEvent(value);
}
