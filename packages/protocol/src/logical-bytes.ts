import type {
	SessionProjectionEventDto,
	SessionReplayFrameDto,
	SessionResponseFrameDto,
	SessionSnapshotDto,
	SessionWsServerMessage,
} from "./index.js";
import type {
	ExtensionUiRequestDto,
	ProductSessionEventDto,
	SessionCommandResponseDto,
	SessionEntryDto,
	SessionMessageDto,
	SessionTreeNodeDto,
} from "./product-dto.js";

const MAX_ANALYZED_BYTES = Number.MAX_SAFE_INTEGER - 1;

type Schema =
	| "ordinary"
	| "text_root"
	| "json_root"
	| "message"
	| "messages"
	| "reviewed_blocks"
	| "reviewed_block"
	| "assistant_blocks"
	| "assistant_block"
	| "tool_call"
	| "entry"
	| "entries"
	| "tree"
	| "tree_node"
	| "event"
	| "extension_request"
	| "extension_requests"
	| "stream_event"
	| "response"
	| "response_messages_data"
	| "response_entries_data"
	| "response_tree_data"
	| "projection"
	| "projection_events"
	| "replay"
	| "snapshot"
	| "response_frame"
	| "ws";

type UnknownRecord = Record<string, unknown>;

export interface SessionLogicalBytesOptions {
	maxBytes?: number;
}

export interface SessionLogicalBytesResult {
	byteLength: number;
}

export type SessionLogicalBytesErrorCode = "invalid_limit" | "invalid_value" | "limit_exceeded";

export class SessionLogicalBytesError extends Error {
	constructor(
		readonly code: SessionLogicalBytesErrorCode,
		message: string,
		readonly limit?: number,
		readonly actual?: number,
	) {
		super(message);
		this.name = "SessionLogicalBytesError";
	}
}

class LogicalByteCounter {
	bytes = 0;
	readonly activeObjects = new Set<object>();

	constructor(readonly limit: number) {}

	add(amount: number): void {
		if (!Number.isSafeInteger(amount) || amount < 0) {
			throw new SessionLogicalBytesError("invalid_value", "future logical byte amount is invalid");
		}
		if (amount > this.limit - this.bytes) {
			throw new SessionLogicalBytesError(
				"limit_exceeded",
				"future logical payload exceeded its byte limit",
				this.limit,
				this.limit + 1,
			);
		}
		this.bytes += amount;
	}
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countRawUtf8(value: string, counter: LogicalByteCounter): void {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) counter.add(1);
		else if (codeUnit <= 0x7ff) counter.add(2);
		else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				counter.add(4);
				index += 1;
			} else counter.add(3);
		} else counter.add(3);
	}
}

function countJsonString(value: string, counter: LogicalByteCounter): void {
	counter.add(2);
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit === 0x22 || codeUnit === 0x5c) {
			counter.add(2);
			continue;
		}
		if (codeUnit <= 0x1f) {
			counter.add(
				codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d
					? 2
					: 6,
			);
			continue;
		}
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				counter.add(4);
				index += 1;
			} else counter.add(6);
			continue;
		}
		counter.add(
			codeUnit >= 0xdc00 && codeUnit <= 0xdfff ? 6 : codeUnit <= 0x7f ? 1 : codeUnit <= 0x7ff ? 2 : 3,
		);
	}
}

function countTextRoot(value: unknown, counter: LogicalByteCounter): void {
	if (typeof value === "string") {
		countRawUtf8(value, counter);
		return;
	}
	if (
		!isRecord(value) ||
		value.type !== "external_text" ||
		!isRecord(value.ref) ||
		!Number.isSafeInteger(value.ref.byteLength) ||
		Number(value.ref.byteLength) <= 0
	) {
		throw new SessionLogicalBytesError("invalid_value", "future logical text root is invalid");
	}
	counter.add(Number(value.ref.byteLength));
}

function countJsonRoot(value: unknown, counter: LogicalByteCounter): void {
	if (!isRecord(value)) {
		throw new SessionLogicalBytesError("invalid_value", "future logical JSON root is invalid");
	}
	if (value.type === "inline_json" && Object.hasOwn(value, "value")) {
		countCanonical(value.value, "ordinary", counter);
		return;
	}
	if (
		value.type !== "external_json" ||
		!isRecord(value.ref) ||
		!Number.isSafeInteger(value.ref.byteLength) ||
		Number(value.ref.byteLength) <= 0
	) {
		throw new SessionLogicalBytesError("invalid_value", "future logical JSON root is invalid");
	}
	counter.add(Number(value.ref.byteLength));
}

function arrayItemSchema(schema: Schema): Schema {
	switch (schema) {
		case "messages":
			return "message";
		case "reviewed_blocks":
			return "reviewed_block";
		case "assistant_blocks":
			return "assistant_block";
		case "entries":
			return "entry";
		case "tree":
			return "tree_node";
		case "projection_events":
			return "projection";
		case "extension_requests":
			return "extension_request";
		default:
			return "ordinary";
	}
}

function reviewedBlockChildSchema(value: UnknownRecord, key: string): Schema {
	return value.type === "text" && key === "text" ? "text_root" : "ordinary";
}

function objectChildSchema(schema: Schema, value: UnknownRecord, key: string): Schema {
	switch (schema) {
		case "message":
			switch (value.role) {
				case "assistant":
					return key === "content" ? "assistant_blocks" : "ordinary";
				case "toolResult":
					if (key === "content") return "reviewed_blocks";
					return key === "details" ? "json_root" : "ordinary";
				case "custom":
					if (key === "content" && Array.isArray(value.content)) return "reviewed_blocks";
					return key === "details" ? "json_root" : "ordinary";
				case "bashExecution":
					return key === "output" ? "text_root" : "ordinary";
				default:
					return "ordinary";
			}
		case "assistant_block":
			return value.type === "toolCall" && key === "arguments" ? "json_root" : "ordinary";
		case "tool_call":
			return key === "arguments" ? "json_root" : "ordinary";
		case "entry":
			if (value.type === "message" && key === "message") return "message";
			if (value.type === "custom_message") {
				if (key === "content" && Array.isArray(value.content)) return "reviewed_blocks";
				if (key === "details") return "json_root";
			}
			return "ordinary";
		case "tree_node":
			if (key === "entry") return "entry";
			return key === "children" ? "tree" : "ordinary";
		case "event":
			switch (value.type) {
				case "agent_end":
					return key === "messages" ? "messages" : "ordinary";
				case "turn_end":
					if (key === "message") return "message";
					return key === "toolResults" ? "messages" : "ordinary";
				case "message_start":
				case "message_end":
					return key === "message" ? "message" : "ordinary";
				case "entry_appended":
					return key === "entry" ? "entry" : "ordinary";
				case "message_update":
					return key === "assistantMessageEvent" ? "stream_event" : "ordinary";
				case "tool_execution_start":
					return key === "args" ? "json_root" : "ordinary";
				case "tool_execution_update":
					return key === "args" || key === "partialResult" ? "json_root" : "ordinary";
				case "tool_execution_end":
					return key === "result" ? "json_root" : "ordinary";
				default:
					return "ordinary";
			}
		case "extension_request":
			switch (value.method) {
				case "editor":
					return key === "prefill" ? "text_root" : "ordinary";
				case "set_editor_text":
					return key === "text" ? "text_root" : "ordinary";
				case "setWidget":
					return key === "widgetLines" ? "json_root" : "ordinary";
				default:
					return "ordinary";
			}
		case "stream_event":
			return value.type === "toolcall_end" && key === "toolCall" ? "tool_call" : "ordinary";
		case "response":
			if (key !== "data") return "ordinary";
			if (value.command === "get_messages") return "response_messages_data";
			if (value.command === "get_entries") return "response_entries_data";
			return value.command === "get_tree" ? "response_tree_data" : "ordinary";
		case "response_messages_data":
			return key === "messages" ? "messages" : "ordinary";
		case "response_entries_data":
			return key === "entries" ? "entries" : "ordinary";
		case "response_tree_data":
			return key === "tree" ? "tree" : "ordinary";
		case "projection":
		case "replay":
			if (value.type === "event" && key === "event") return "event";
			return value.type === "extension_ui_request" && key === "request" ? "extension_request" : "ordinary";
		case "snapshot":
			if (key === "settledMessages") return "messages";
			if (key === "projectionEvents") return "projection_events";
			return key === "pendingExtensionRequests" || key === "stickyExtensionState"
				? "extension_requests"
				: "ordinary";
		case "response_frame":
			return key === "response" ? "response" : "ordinary";
		case "ws":
			if (value.type === "event" && key === "event") return "event";
			if (value.type === "extension_ui_request" && key === "request") return "extension_request";
			if (value.type === "extension_ui_snapshot" && key === "requests") return "extension_requests";
			if (value.type === "response" && key === "response") return "response";
			if (value.type === "session_snapshot") return objectChildSchema("snapshot", value, key);
			return "ordinary";
		case "reviewed_block":
			return reviewedBlockChildSchema(value, key);
		default:
			return "ordinary";
	}
}

function countCanonical(value: unknown, schema: Schema, counter: LogicalByteCounter): void {
	if (schema === "text_root") {
		countTextRoot(value, counter);
		return;
	}
	if (schema === "json_root") {
		countJsonRoot(value, counter);
		return;
	}
	if (value === null) {
		counter.add(4);
		return;
	}
	if (typeof value === "string") {
		countJsonString(value, counter);
		return;
	}
	if (typeof value === "boolean") {
		counter.add(value ? 4 : 5);
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
			throw new SessionLogicalBytesError("invalid_value", "future logical number is invalid");
		}
		counter.add((Object.is(value, -0) ? "0" : String(value)).length);
		return;
	}
	if (typeof value !== "object" || value === null || counter.activeObjects.has(value)) {
		throw new SessionLogicalBytesError("invalid_value", "future logical value is not canonical JSON");
	}
	counter.activeObjects.add(value);
	try {
		if (Array.isArray(value)) {
			counter.add(1);
			for (let index = 0; index < value.length; index += 1) {
				if (index > 0) counter.add(1);
				countCanonical(value[index], arrayItemSchema(schema), counter);
			}
			counter.add(1);
			return;
		}
		if (!isRecord(value)) {
			throw new SessionLogicalBytesError("invalid_value", "future logical object is invalid");
		}
		const record = value;
		counter.add(1);
		let included = 0;
		for (const key of Object.keys(record)) {
			const child = record[key];
			if (child === undefined) continue;
			if (included++ > 0) counter.add(1);
			countJsonString(key, counter);
			counter.add(1);
			const childSchema = objectChildSchema(schema, record, key);
			countCanonical(child, childSchema, counter);
		}
		counter.add(1);
	} finally {
		counter.activeObjects.delete(value);
	}
}

function analyze(
	value: unknown,
	schema: Schema,
	options: SessionLogicalBytesOptions = {},
): SessionLogicalBytesResult {
	const maxBytes = options.maxBytes ?? MAX_ANALYZED_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ANALYZED_BYTES) {
		throw new SessionLogicalBytesError("invalid_limit", "future logical byte limit is invalid");
	}
	const counter = new LogicalByteCounter(maxBytes);
	countCanonical(value, schema, counter);
	if (!Number.isSafeInteger(counter.bytes) || counter.bytes <= 0) {
		throw new SessionLogicalBytesError("invalid_value", "future logical byte result is invalid");
	}
	return Object.freeze({ byteLength: counter.bytes });
}

export function analyzeSessionMessageLogicalBytes(
	value: SessionMessageDto,
	options?: SessionLogicalBytesOptions,
): SessionLogicalBytesResult {
	return analyze(value, "message", options);
}

export function analyzeSessionEntryLogicalBytes(
	value: SessionEntryDto,
	options?: SessionLogicalBytesOptions,
): SessionLogicalBytesResult {
	return analyze(value, "entry", options);
}

export function analyzeSessionTreeLogicalBytes(
	value: SessionTreeNodeDto[],
	options?: SessionLogicalBytesOptions,
): SessionLogicalBytesResult {
	return analyze(value, "tree", options);
}

export function analyzeProductSessionEventLogicalBytes(
	value: ProductSessionEventDto,
	options?: SessionLogicalBytesOptions,
): SessionLogicalBytesResult {
	return analyze(value, "event", options);
}

export function analyzeExtensionUiRequestLogicalBytes(
	value: ExtensionUiRequestDto,
	options?: SessionLogicalBytesOptions,
): SessionLogicalBytesResult {
	return analyze(value, "extension_request", options);
}

export function analyzeSessionCommandResponseLogicalBytes(
	value: SessionCommandResponseDto,
	options?: SessionLogicalBytesOptions,
): SessionLogicalBytesResult {
	return analyze(value, "response", options);
}

export function analyzeSessionProjectionEventLogicalBytes(
	value: SessionProjectionEventDto,
	options?: SessionLogicalBytesOptions,
): SessionLogicalBytesResult {
	return analyze(value, "projection", options);
}

export function analyzeSessionReplayFrameLogicalBytes(
	value: SessionReplayFrameDto,
	options?: SessionLogicalBytesOptions,
): SessionLogicalBytesResult {
	return analyze(value, "replay", options);
}

export function analyzeSessionSnapshotLogicalBytes(
	value: SessionSnapshotDto,
	options?: SessionLogicalBytesOptions,
): SessionLogicalBytesResult {
	return analyze(value, "snapshot", options);
}

export function analyzeSessionResponseFrameLogicalBytes(
	value: SessionResponseFrameDto,
	options?: SessionLogicalBytesOptions,
): SessionLogicalBytesResult {
	return analyze(value, "response_frame", options);
}

export function analyzeSessionWsServerMessageLogicalBytes(
	value: SessionWsServerMessage,
	options?: SessionLogicalBytesOptions,
): SessionLogicalBytesResult {
	return analyze(value, "ws", options);
}
