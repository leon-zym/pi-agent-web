import type {
	AssistantMessageDiagnosticDto,
	AssistantMessageDto,
	AssistantMessageStreamEventDto,
	BashResultDto,
	CompactionResultDto,
	DeferredHandleDto,
	DiagnosticErrorInfoDto,
	ExtensionUiRequestDto,
	ExtensionUiResponseDto,
	ModelDto,
	ProductSessionEventDto,
	SessionCommandDataMap,
	SessionCommandResponseDto,
	SessionCommandTypeDto,
	SessionEntryDto,
	SessionMessageDto,
	SessionStateDto,
	SessionStatsDto,
	SessionTreeNodeDto,
	SlashCommandDto,
	ThinkingLevelDto,
	ToolResultMessageDto,
	UsageDto,
} from "./product-dto.js";

const MAX_IDENTIFIER_CHARS = 256;
const MAX_PATH_CHARS = 8192;
const MAX_TEXT_BYTES = 1024 * 1024;
// get_messages is admitted behind a 64 MiB JSONL snapshot ceiling. A single
// historical assistant block may therefore exceed the ordinary frame budget.
const MAX_SNAPSHOT_TEXT_BYTES = 48 * 1024 * 1024;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_TREE_DEPTH = 128;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ITEMS = 50_000;
const MAX_JSON_STRING_BYTES = 8 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isString(value: unknown, maxChars = MAX_IDENTIFIER_CHARS, allowEmpty = false): value is string {
	return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= maxChars;
}

function isText(value: unknown, maxBytes = MAX_TEXT_BYTES): value is string {
	return typeof value === "string" && UTF8_ENCODER.encode(value).byteLength <= maxBytes;
}

function isOptionalText(value: unknown, maxBytes = MAX_TEXT_BYTES): value is string | undefined {
	return value === undefined || isText(value, maxBytes);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function isCount(value: unknown): value is number {
	return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isNullableCount(value: unknown): value is number | null {
	return value === null || isCount(value);
}

function isArrayOf<T>(
	value: unknown,
	guard: (item: unknown) => item is T,
	max = MAX_ARRAY_ITEMS,
): value is T[] {
	return Array.isArray(value) && value.length <= max && value.every(guard);
}

function isOneOf<T extends string>(value: unknown, variants: readonly T[]): value is T {
	return typeof value === "string" && variants.includes(value as T);
}

export function isBoundedJsonValue(value: unknown): boolean {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let items = 0;
	let stringBytes = 0;
	const seen = new Set<object>();
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
			stringBytes += UTF8_ENCODER.encode(candidate).byteLength;
			if (stringBytes > MAX_JSON_STRING_BYTES) return false;
			continue;
		}
		if (typeof candidate !== "object" || seen.has(candidate)) return false;
		seen.add(candidate);
		const children = Array.isArray(candidate) ? candidate : Object.values(candidate);
		if (children.length > MAX_ARRAY_ITEMS) return false;
		for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
	}
	return true;
}

export function isThinkingLevelDto(value: unknown): value is ThinkingLevelDto {
	return isOneOf(value, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
}

function isImageContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "data", "mimeType"]) &&
		value.type === "image" &&
		isText(value.data, 2 * 1024 * 1024) &&
		isString(value.mimeType, 256)
	);
}

function isTextContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "text", "textSignature"]) &&
		value.type === "text" &&
		isText(value.text, MAX_SNAPSHOT_TEXT_BYTES) &&
		isOptionalText(value.textSignature)
	);
}

function isThinkingContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "thinking", "thinkingSignature", "redacted"]) &&
		value.type === "thinking" &&
		isText(value.thinking) &&
		isOptionalText(value.thinkingSignature) &&
		(value.redacted === undefined || typeof value.redacted === "boolean")
	);
}

function isToolCallContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "id", "name", "arguments", "thoughtSignature", "namespace"]) &&
		value.type === "toolCall" &&
		isString(value.id) &&
		isString(value.name) &&
		isBoundedJsonValue(value.arguments) &&
		isOptionalText(value.thoughtSignature) &&
		(value.namespace === undefined || isString(value.namespace))
	);
}

function isUsageCost(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["input", "output", "cacheRead", "cacheWrite", "total"]) &&
		isFiniteNumber(value.input) &&
		isFiniteNumber(value.output) &&
		isFiniteNumber(value.cacheRead) &&
		isFiniteNumber(value.cacheWrite) &&
		isFiniteNumber(value.total)
	);
}

export function isUsageDto(value: unknown): value is UsageDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"cacheWrite1h",
			"reasoning",
			"totalTokens",
			"cost",
		]) &&
		isCount(value.input) &&
		isCount(value.output) &&
		isCount(value.cacheRead) &&
		isCount(value.cacheWrite) &&
		(value.cacheWrite1h === undefined || isCount(value.cacheWrite1h)) &&
		(value.reasoning === undefined || isCount(value.reasoning)) &&
		isCount(value.totalTokens) &&
		isUsageCost(value.cost)
	);
}

function isDiagnosticError(value: unknown): value is DiagnosticErrorInfoDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["name", "message", "stack", "code"]) &&
		(value.name === undefined || isString(value.name)) &&
		isText(value.message) &&
		isOptionalText(value.stack) &&
		(value.code === undefined || isString(value.code) || isFiniteNumber(value.code))
	);
}

function isAssistantMessageDiagnostic(value: unknown): value is AssistantMessageDiagnosticDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "timestamp", "error", "details"]) &&
		isString(value.type) &&
		isCount(value.timestamp) &&
		(value.error === undefined || isDiagnosticError(value.error)) &&
		(value.details === undefined || (isRecord(value.details) && isBoundedJsonValue(value.details)))
	);
}

function isDeferredHandle(value: unknown): value is DeferredHandleDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["provider", "modelId", "api", "id", "expiresAt", "pollAfterMs", "data"]) &&
		isString(value.provider) &&
		isString(value.modelId) &&
		isString(value.api) &&
		isString(value.id) &&
		(value.expiresAt === undefined || isCount(value.expiresAt)) &&
		(value.pollAfterMs === undefined || isCount(value.pollAfterMs)) &&
		(value.data === undefined || isBoundedJsonValue(value.data))
	);
}

function isMessageContent(value: unknown): boolean {
	return (
		isText(value) ||
		(Array.isArray(value) &&
			value.length <= MAX_ARRAY_ITEMS &&
			value.every((block) => isTextContent(block) || isImageContent(block)))
	);
}

function isAssistantMessage(value: unknown): value is AssistantMessageDto {
	return (
		isRecord(value) &&
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
		value.role === "assistant" &&
		isArrayOf(
			value.content,
			(block): block is never => isTextContent(block) || isThinkingContent(block) || isToolCallContent(block),
		) &&
		isUsageDto(value.usage) &&
		isOneOf(value.stopReason, ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]) &&
		isOptionalText(value.errorMessage) &&
		(value.api === undefined || isString(value.api)) &&
		(value.provider === undefined || isString(value.provider)) &&
		(value.model === undefined || isString(value.model)) &&
		(value.responseModel === undefined || isString(value.responseModel)) &&
		(value.responseId === undefined || isString(value.responseId)) &&
		(value.diagnostics === undefined || isArrayOf(value.diagnostics, isAssistantMessageDiagnostic, 1_000)) &&
		(value.deferred === undefined || isDeferredHandle(value.deferred)) &&
		isOptionalText(value.rawStopReason) &&
		(value.endTurn === undefined || typeof value.endTurn === "boolean") &&
		isCount(value.timestamp)
	);
}

function isToolResultMessage(value: unknown): value is ToolResultMessageDto {
	return (
		isRecord(value) &&
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
		value.role === "toolResult" &&
		isString(value.toolCallId) &&
		isString(value.toolName) &&
		isArrayOf(value.content, (block): block is never => isTextContent(block) || isImageContent(block)) &&
		(value.details === undefined || isBoundedJsonValue(value.details)) &&
		(value.usage === undefined || isUsageDto(value.usage)) &&
		(value.addedToolNames === undefined ||
			isArrayOf(value.addedToolNames, (item): item is string => isString(item), 1_000)) &&
		typeof value.isError === "boolean" &&
		isCount(value.timestamp)
	);
}

export function isSessionMessageDto(value: unknown): value is SessionMessageDto {
	if (!isRecord(value) || !isString(value.role, 64)) return false;
	switch (value.role) {
		case "user":
			return (
				hasOnlyKeys(value, ["role", "content", "timestamp"]) &&
				isMessageContent(value.content) &&
				isCount(value.timestamp)
			);
		case "assistant":
			return isAssistantMessage(value);
		case "toolResult":
			return isToolResultMessage(value);
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
				isText(value.command) &&
				isText(value.output) &&
				(value.exitCode === undefined ||
					(isFiniteNumber(value.exitCode) && Number.isSafeInteger(value.exitCode))) &&
				typeof value.cancelled === "boolean" &&
				typeof value.truncated === "boolean" &&
				(value.fullOutputPath === undefined || isString(value.fullOutputPath, MAX_PATH_CHARS)) &&
				(value.excludeFromContext === undefined || typeof value.excludeFromContext === "boolean") &&
				isCount(value.timestamp)
			);
		case "custom":
			return (
				hasOnlyKeys(value, ["role", "customType", "content", "display", "details", "timestamp"]) &&
				isString(value.customType) &&
				isMessageContent(value.content) &&
				typeof value.display === "boolean" &&
				(value.details === undefined || isBoundedJsonValue(value.details)) &&
				isCount(value.timestamp)
			);
		case "branchSummary":
			return (
				hasOnlyKeys(value, ["role", "summary", "fromId", "timestamp"]) &&
				isText(value.summary) &&
				isString(value.fromId) &&
				isCount(value.timestamp)
			);
		case "compactionSummary":
			return (
				hasOnlyKeys(value, ["role", "summary", "tokensBefore", "timestamp"]) &&
				isText(value.summary) &&
				isCount(value.tokensBefore) &&
				isCount(value.timestamp)
			);
		default:
			return false;
	}
}

export function isModelDto(value: unknown): value is ModelDto {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["id", "name", "provider", "reasoning", "contextWindow", "cost"]) ||
		!isString(value.id) ||
		!isString(value.name) ||
		!isString(value.provider)
	)
		return false;
	if (value.reasoning !== undefined && typeof value.reasoning !== "boolean") return false;
	if (value.contextWindow !== undefined && !isCount(value.contextWindow)) return false;
	if (value.cost === undefined) return true;
	return (
		isRecord(value.cost) &&
		hasOnlyKeys(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"]) &&
		isFiniteNumber(value.cost.input) &&
		isFiniteNumber(value.cost.output) &&
		isFiniteNumber(value.cost.cacheRead) &&
		isFiniteNumber(value.cost.cacheWrite) &&
		(value.cost.total === undefined || isFiniteNumber(value.cost.total))
	);
}

export function isSessionStateDto(value: unknown): value is SessionStateDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			"model",
			"thinkingLevel",
			"isStreaming",
			"isCompacting",
			"steeringMode",
			"followUpMode",
			"sessionFile",
			"sessionId",
			"sessionName",
			"autoCompactionEnabled",
			"messageCount",
			"pendingMessageCount",
		]) &&
		(value.model === undefined || isModelDto(value.model)) &&
		isThinkingLevelDto(value.thinkingLevel) &&
		typeof value.isStreaming === "boolean" &&
		typeof value.isCompacting === "boolean" &&
		isOneOf(value.steeringMode, ["all", "one-at-a-time"]) &&
		isOneOf(value.followUpMode, ["all", "one-at-a-time"]) &&
		(value.sessionFile === undefined || isString(value.sessionFile, MAX_PATH_CHARS)) &&
		isString(value.sessionId) &&
		(value.sessionName === undefined || isText(value.sessionName)) &&
		typeof value.autoCompactionEnabled === "boolean" &&
		isCount(value.messageCount) &&
		isCount(value.pendingMessageCount)
	);
}

export function isSessionStatsDto(value: unknown): value is SessionStatsDto {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"sessionFile",
			"sessionId",
			"userMessages",
			"assistantMessages",
			"toolCalls",
			"toolResults",
			"totalMessages",
			"tokens",
			"cost",
			"contextUsage",
		]) ||
		(value.sessionFile !== undefined && !isString(value.sessionFile, MAX_PATH_CHARS))
	)
		return false;
	if (
		!isString(value.sessionId) ||
		!isCount(value.userMessages) ||
		!isCount(value.assistantMessages) ||
		!isCount(value.toolCalls) ||
		!isCount(value.toolResults) ||
		!isCount(value.totalMessages) ||
		!isFiniteNumber(value.cost) ||
		!isRecord(value.tokens) ||
		!hasOnlyKeys(value.tokens, ["input", "output", "cacheRead", "cacheWrite", "total"]) ||
		![
			value.tokens.input,
			value.tokens.output,
			value.tokens.cacheRead,
			value.tokens.cacheWrite,
			value.tokens.total,
		].every(isCount)
	)
		return false;
	return (
		value.contextUsage === undefined ||
		(isRecord(value.contextUsage) &&
			hasOnlyKeys(value.contextUsage, ["tokens", "contextWindow", "percent"]) &&
			isNullableCount(value.contextUsage.tokens) &&
			isCount(value.contextUsage.contextWindow) &&
			(value.contextUsage.percent === null || isFiniteNumber(value.contextUsage.percent)))
	);
}

export function isSessionEntryDto(value: unknown): value is SessionEntryDto {
	if (
		!isRecord(value) ||
		!isString(value.type, 64) ||
		!isString(value.id) ||
		!(value.parentId === null || isString(value.parentId)) ||
		!isString(value.timestamp, 128)
	)
		return false;
	switch (value.type) {
		case "message":
			return (
				hasOnlyKeys(value, ["type", "id", "parentId", "timestamp", "message"]) &&
				isSessionMessageDto(value.message)
			);
		case "thinking_level_change":
			return (
				hasOnlyKeys(value, ["type", "id", "parentId", "timestamp", "thinkingLevel"]) &&
				isString(value.thinkingLevel, 64)
			);
		case "model_change":
			return (
				hasOnlyKeys(value, ["type", "id", "parentId", "timestamp", "provider", "modelId"]) &&
				isString(value.provider) &&
				isString(value.modelId)
			);
		case "compaction":
			return (
				hasOnlyKeys(value, [
					"type",
					"id",
					"parentId",
					"timestamp",
					"summary",
					"firstKeptEntryId",
					"tokensBefore",
					"details",
					"usage",
					"fromHook",
				]) &&
				isText(value.summary) &&
				isString(value.firstKeptEntryId) &&
				isCount(value.tokensBefore) &&
				(value.details === undefined || isBoundedJsonValue(value.details)) &&
				(value.usage === undefined || isUsageDto(value.usage)) &&
				(value.fromHook === undefined || typeof value.fromHook === "boolean")
			);
		case "branch_summary":
			return (
				hasOnlyKeys(value, [
					"type",
					"id",
					"parentId",
					"timestamp",
					"fromId",
					"summary",
					"details",
					"usage",
					"fromHook",
				]) &&
				isString(value.fromId) &&
				isText(value.summary) &&
				(value.details === undefined || isBoundedJsonValue(value.details)) &&
				(value.usage === undefined || isUsageDto(value.usage)) &&
				(value.fromHook === undefined || typeof value.fromHook === "boolean")
			);
		case "custom":
			return (
				hasOnlyKeys(value, ["type", "id", "parentId", "timestamp", "customType", "data"]) &&
				isString(value.customType) &&
				(value.data === undefined || isBoundedJsonValue(value.data))
			);
		case "custom_message":
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
				isMessageContent(value.content) &&
				(value.details === undefined || isBoundedJsonValue(value.details)) &&
				typeof value.display === "boolean"
			);
		case "label":
			return (
				hasOnlyKeys(value, ["type", "id", "parentId", "timestamp", "targetId", "label"]) &&
				isString(value.targetId) &&
				(value.label === undefined || isText(value.label))
			);
		case "session_info":
			return (
				hasOnlyKeys(value, ["type", "id", "parentId", "timestamp", "name"]) &&
				(value.name === undefined || isText(value.name))
			);
		default:
			return false;
	}
}

export function isSessionTreeDto(value: unknown): value is SessionTreeNodeDto[] {
	if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return false;
	const stack = value.map((node) => ({ node, depth: 0 }));
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || current.depth > MAX_TREE_DEPTH || ++nodes > MAX_ARRAY_ITEMS || !isRecord(current.node))
			return false;
		if (
			!isSessionEntryDto(current.node.entry) ||
			!hasOnlyKeys(current.node, ["entry", "children", "label", "labelTimestamp"]) ||
			!Array.isArray(current.node.children) ||
			current.node.children.length > MAX_ARRAY_ITEMS ||
			(current.node.label !== undefined && !isText(current.node.label)) ||
			(current.node.labelTimestamp !== undefined && !isString(current.node.labelTimestamp, 128))
		)
			return false;
		for (const child of current.node.children) stack.push({ node: child, depth: current.depth + 1 });
	}
	return true;
}

function isSlashCommand(value: unknown): value is SlashCommandDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["name", "description", "source", "sourceInfo"]) &&
		isString(value.name) &&
		isOptionalText(value.description) &&
		isOneOf(value.source, ["extension", "prompt", "skill"]) &&
		isRecord(value.sourceInfo) &&
		isBoundedJsonValue(value.sourceInfo)
	);
}

export function isExtensionUiRequestDto(value: unknown): value is ExtensionUiRequestDto {
	if (
		!isRecord(value) ||
		value.type !== "extension_ui_request" ||
		!isString(value.id) ||
		!isString(value.method, 64)
	)
		return false;
	switch (value.method) {
		case "select":
			return (
				hasOnlyKeys(value, ["type", "id", "method", "title", "options", "timeout"]) &&
				isText(value.title) &&
				isArrayOf(value.options, (item): item is string => isText(item), 1_000) &&
				(value.timeout === undefined || isCount(value.timeout))
			);
		case "confirm":
			return (
				hasOnlyKeys(value, ["type", "id", "method", "title", "message", "timeout"]) &&
				isText(value.title) &&
				isText(value.message) &&
				(value.timeout === undefined || isCount(value.timeout))
			);
		case "input":
			return (
				hasOnlyKeys(value, ["type", "id", "method", "title", "placeholder", "timeout"]) &&
				isText(value.title) &&
				isOptionalText(value.placeholder) &&
				(value.timeout === undefined || isCount(value.timeout))
			);
		case "editor":
			return (
				hasOnlyKeys(value, ["type", "id", "method", "title", "prefill"]) &&
				isText(value.title) &&
				isOptionalText(value.prefill)
			);
		case "notify":
			return (
				hasOnlyKeys(value, ["type", "id", "method", "message", "notifyType"]) &&
				isText(value.message) &&
				(value.notifyType === undefined || isOneOf(value.notifyType, ["info", "warning", "error"]))
			);
		case "setStatus":
			return (
				hasOnlyKeys(value, ["type", "id", "method", "statusKey", "statusText"]) &&
				isString(value.statusKey) &&
				isOptionalText(value.statusText)
			);
		case "setWidget":
			return (
				hasOnlyKeys(value, ["type", "id", "method", "widgetKey", "widgetLines", "widgetPlacement"]) &&
				isString(value.widgetKey) &&
				(value.widgetLines === undefined ||
					isArrayOf(value.widgetLines, (item): item is string => isText(item), 1_000)) &&
				(value.widgetPlacement === undefined ||
					isOneOf(value.widgetPlacement, ["aboveEditor", "belowEditor"]))
			);
		case "setTitle":
			return hasOnlyKeys(value, ["type", "id", "method", "title"]) && isText(value.title);
		case "set_editor_text":
			return hasOnlyKeys(value, ["type", "id", "method", "text"]) && isText(value.text);
		default:
			return false;
	}
}

export function isExtensionUiResponseDto(value: unknown): value is ExtensionUiResponseDto {
	if (!isRecord(value) || value.type !== "extension_ui_response" || !isString(value.id)) return false;
	const valueVariant =
		hasOnlyKeys(value, ["type", "id", "value"]) && Object.hasOwn(value, "value") && isText(value.value);
	const confirmVariant =
		hasOnlyKeys(value, ["type", "id", "confirmed"]) &&
		Object.hasOwn(value, "confirmed") &&
		typeof value.confirmed === "boolean";
	const cancelVariant = hasOnlyKeys(value, ["type", "id", "cancelled"]) && value.cancelled === true;
	return Number(valueVariant) + Number(confirmVariant) + Number(cancelVariant) === 1;
}

function isStreamEvent(value: unknown): value is AssistantMessageStreamEventDto {
	if (!isRecord(value) || !isString(value.type, 64)) return false;
	switch (value.type) {
		case "start":
			return hasOnlyKeys(value, ["type"]);
		case "text_start":
		case "thinking_start":
			return hasOnlyKeys(value, ["type", "contentIndex"]) && isCount(value.contentIndex);
		case "toolcall_start":
			return (
				hasOnlyKeys(value, ["type", "contentIndex", "id", "toolName"]) &&
				isCount(value.contentIndex) &&
				(value.id === undefined || isString(value.id)) &&
				(value.toolName === undefined || isString(value.toolName))
			);
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return (
				hasOnlyKeys(value, ["type", "contentIndex", "delta"]) &&
				isCount(value.contentIndex) &&
				isText(value.delta)
			);
		case "text_end":
		case "thinking_end":
			return (
				hasOnlyKeys(value, ["type", "contentIndex", "content"]) &&
				isCount(value.contentIndex) &&
				isText(value.content)
			);
		case "toolcall_end":
			return (
				hasOnlyKeys(value, ["type", "contentIndex", "toolCall"]) &&
				isCount(value.contentIndex) &&
				isToolCallContent(value.toolCall)
			);
		case "done":
			return (
				hasOnlyKeys(value, ["type", "reason", "message"]) &&
				isOneOf(value.reason, ["stop", "length", "toolUse", "deferred"]) &&
				isAssistantMessage(value.message)
			);
		case "error":
			return (
				hasOnlyKeys(value, ["type", "reason", "error"]) &&
				isOneOf(value.reason, ["aborted", "error"]) &&
				isAssistantMessage(value.error)
			);
		default:
			return false;
	}
}

export function isProductSessionEventDto(value: unknown): value is ProductSessionEventDto {
	if (!isRecord(value) || !isString(value.type, 64)) return false;
	switch (value.type) {
		case "agent_start":
		case "turn_start":
		case "agent_settled":
		case "summarization_retry_finished":
			return hasOnlyKeys(value, ["type"]);
		case "agent_end":
			return (
				hasOnlyKeys(value, ["type", "messages", "willRetry"]) &&
				isArrayOf(value.messages, isSessionMessageDto) &&
				typeof value.willRetry === "boolean"
			);
		case "turn_end":
			return (
				hasOnlyKeys(value, ["type", "message", "toolResults"]) &&
				isSessionMessageDto(value.message) &&
				isArrayOf(value.toolResults, isToolResultMessage)
			);
		case "message_start":
		case "message_end":
			return hasOnlyKeys(value, ["type", "message"]) && isSessionMessageDto(value.message);
		case "message_update":
			return (
				hasOnlyKeys(value, ["type", "usage", "assistantMessageEvent"]) &&
				isUsageDto(value.usage) &&
				isStreamEvent(value.assistantMessageEvent)
			);
		case "tool_execution_start":
			return (
				hasOnlyKeys(value, ["type", "toolCallId", "toolName", "args"]) &&
				isString(value.toolCallId) &&
				isString(value.toolName) &&
				isBoundedJsonValue(value.args)
			);
		case "tool_execution_update":
			return (
				hasOnlyKeys(value, ["type", "toolCallId", "toolName", "args", "partialResult"]) &&
				isString(value.toolCallId) &&
				isString(value.toolName) &&
				isBoundedJsonValue(value.args) &&
				isBoundedJsonValue(value.partialResult)
			);
		case "tool_execution_end":
			return (
				hasOnlyKeys(value, ["type", "toolCallId", "toolName", "result", "isError"]) &&
				isString(value.toolCallId) &&
				isString(value.toolName) &&
				isBoundedJsonValue(value.result) &&
				typeof value.isError === "boolean"
			);
		case "queue_update":
			return (
				hasOnlyKeys(value, ["type", "steering", "followUp"]) &&
				isArrayOf(value.steering, (item): item is string => isText(item)) &&
				isArrayOf(value.followUp, (item): item is string => isText(item))
			);
		case "compaction_start":
			return (
				hasOnlyKeys(value, ["type", "reason"]) && isOneOf(value.reason, ["manual", "threshold", "overflow"])
			);
		case "entry_appended":
			return hasOnlyKeys(value, ["type", "entry"]) && isSessionEntryDto(value.entry);
		case "session_info_changed":
			return hasOnlyKeys(value, ["type", "name"]) && (value.name === undefined || isText(value.name));
		case "thinking_level_changed":
			return hasOnlyKeys(value, ["type", "level"]) && isThinkingLevelDto(value.level);
		case "compaction_end":
			return (
				hasOnlyKeys(value, ["type", "reason", "result", "aborted", "willRetry", "errorMessage"]) &&
				isOneOf(value.reason, ["manual", "threshold", "overflow"]) &&
				(value.result === undefined || isBoundedJsonValue(value.result)) &&
				typeof value.aborted === "boolean" &&
				typeof value.willRetry === "boolean" &&
				isOptionalText(value.errorMessage)
			);
		case "auto_retry_start":
		case "summarization_retry_scheduled":
			return (
				hasOnlyKeys(value, ["type", "attempt", "maxAttempts", "delayMs", "errorMessage"]) &&
				isCount(value.attempt) &&
				isCount(value.maxAttempts) &&
				isCount(value.delayMs) &&
				isText(value.errorMessage)
			);
		case "auto_retry_end":
			return (
				hasOnlyKeys(value, ["type", "success", "attempt", "finalError"]) &&
				typeof value.success === "boolean" &&
				isCount(value.attempt) &&
				isOptionalText(value.finalError)
			);
		case "summarization_retry_attempt_start":
			return (
				hasOnlyKeys(value, ["type", "source", "reason"]) &&
				isOneOf(value.source, ["branchSummary", "compaction"]) &&
				(value.reason === undefined || isOneOf(value.reason, ["manual", "threshold", "overflow"]))
			);
		case "bash_execution_update":
			return (
				hasOnlyKeys(value, ["type", "id", "delta"]) &&
				(value.id === undefined || isString(value.id)) &&
				isText(value.delta)
			);
		case "extension_error":
			return (
				hasOnlyKeys(value, ["type", "extensionPath", "event", "error"]) &&
				isString(value.extensionPath, MAX_PATH_CHARS) &&
				isString(value.event) &&
				isText(value.error)
			);
		default:
			return false;
	}
}

const ACK_COMMANDS = new Set<SessionCommandTypeDto>([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"set_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"abort_bash",
	"set_session_name",
]);

function isCancelled(value: unknown): boolean {
	return isRecord(value) && hasOnlyKeys(value, ["cancelled"]) && typeof value.cancelled === "boolean";
}

function isCompactionResult(value: unknown): value is CompactionResultDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			"summary",
			"firstKeptEntryId",
			"tokensBefore",
			"estimatedTokensAfter",
			"usage",
			"details",
		]) &&
		isText(value.summary) &&
		isString(value.firstKeptEntryId) &&
		isCount(value.tokensBefore) &&
		(value.estimatedTokensAfter === undefined || isCount(value.estimatedTokensAfter)) &&
		(value.usage === undefined || isUsageDto(value.usage)) &&
		(value.details === undefined || isBoundedJsonValue(value.details))
	);
}

function isBashResult(value: unknown): value is BashResultDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["output", "exitCode", "cancelled", "truncated", "fullOutputPath"]) &&
		isText(value.output, MAX_SNAPSHOT_TEXT_BYTES) &&
		(value.exitCode === undefined ||
			(isFiniteNumber(value.exitCode) && Number.isSafeInteger(value.exitCode))) &&
		typeof value.cancelled === "boolean" &&
		typeof value.truncated === "boolean" &&
		(value.fullOutputPath === undefined || isString(value.fullOutputPath, MAX_PATH_CHARS))
	);
}

function isCommandData<K extends SessionCommandTypeDto>(
	command: K,
	value: unknown,
): value is SessionCommandDataMap[K] {
	if (ACK_COMMANDS.has(command)) return value === undefined;
	switch (command) {
		case "new_session":
		case "switch_session":
		case "clone":
			return isCancelled(value);
		case "get_state":
			return isSessionStateDto(value);
		case "set_model":
			return isModelDto(value);
		case "cycle_model":
			return (
				value === null ||
				(isRecord(value) &&
					hasOnlyKeys(value, ["model", "thinkingLevel", "isScoped"]) &&
					isModelDto(value.model) &&
					isThinkingLevelDto(value.thinkingLevel) &&
					typeof value.isScoped === "boolean")
			);
		case "get_available_models":
			return isRecord(value) && hasOnlyKeys(value, ["models"]) && isArrayOf(value.models, isModelDto, 1_000);
		case "cycle_thinking_level":
			return (
				value === null ||
				(isRecord(value) && hasOnlyKeys(value, ["level"]) && isThinkingLevelDto(value.level))
			);
		case "get_available_thinking_levels":
			return (
				isRecord(value) && hasOnlyKeys(value, ["levels"]) && isArrayOf(value.levels, isThinkingLevelDto, 32)
			);
		case "compact":
			return isCompactionResult(value);
		case "bash":
			return isBashResult(value);
		case "get_session_stats":
			return isSessionStatsDto(value);
		case "export_html":
			return (
				isRecord(value) &&
				hasOnlyKeys(value, ["path", "url"]) &&
				isString(value.path, MAX_PATH_CHARS) &&
				(value.url === undefined || isString(value.url, MAX_PATH_CHARS))
			);
		case "fork":
			return (
				isRecord(value) &&
				hasOnlyKeys(value, ["text", "cancelled"]) &&
				isText(value.text) &&
				typeof value.cancelled === "boolean"
			);
		case "get_fork_messages":
			return (
				isRecord(value) &&
				hasOnlyKeys(value, ["messages"]) &&
				isArrayOf(
					value.messages,
					(item): item is { entryId: string; text: string } =>
						isRecord(item) &&
						hasOnlyKeys(item, ["entryId", "text"]) &&
						isString(item.entryId) &&
						isText(item.text),
				)
			);
		case "get_entries":
			return (
				isRecord(value) &&
				hasOnlyKeys(value, ["entries", "leafId"]) &&
				isArrayOf(value.entries, isSessionEntryDto) &&
				(value.leafId === null || isString(value.leafId))
			);
		case "get_tree":
			return (
				isRecord(value) &&
				hasOnlyKeys(value, ["tree", "leafId"]) &&
				isSessionTreeDto(value.tree) &&
				(value.leafId === null || isString(value.leafId))
			);
		case "get_last_assistant_text":
			return isRecord(value) && hasOnlyKeys(value, ["text"]) && (value.text === null || isText(value.text));
		case "get_messages":
			return (
				isRecord(value) && hasOnlyKeys(value, ["messages"]) && isArrayOf(value.messages, isSessionMessageDto)
			);
		case "get_commands":
			return (
				isRecord(value) &&
				hasOnlyKeys(value, ["commands"]) &&
				isArrayOf(value.commands, isSlashCommand, 1_000)
			);
		default:
			return false;
	}
}

const COMMAND_TYPES = new Set<SessionCommandTypeDto>([
	...ACK_COMMANDS,
	"new_session",
	"get_state",
	"set_model",
	"cycle_model",
	"get_available_models",
	"cycle_thinking_level",
	"get_available_thinking_levels",
	"compact",
	"bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"fork",
	"clone",
	"get_fork_messages",
	"get_entries",
	"get_tree",
	"get_last_assistant_text",
	"get_messages",
	"get_commands",
]);

export function isSessionCommandTypeDto(value: unknown): value is SessionCommandTypeDto {
	return typeof value === "string" && COMMAND_TYPES.has(value as SessionCommandTypeDto);
}

export function isSessionCommandResponseDto(value: unknown): value is SessionCommandResponseDto {
	if (
		!isRecord(value) ||
		value.type !== "response" ||
		(value.id !== undefined && !isString(value.id)) ||
		!isString(value.command, 64) ||
		typeof value.success !== "boolean"
	)
		return false;
	if (!isSessionCommandTypeDto(value.command)) return false;
	if (value.success === false) {
		return hasOnlyKeys(value, ["type", "id", "command", "success", "error"]) && isText(value.error);
	}
	if (!hasOnlyKeys(value, ["type", "id", "command", "success", "data"])) return false;
	return isCommandData(value.command, value.data);
}
