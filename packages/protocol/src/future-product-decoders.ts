import type {
	FutureProductSessionEventDto,
	FutureSessionCommandResponseDto,
	FutureSessionEntryDto,
	FutureSessionMessageDto,
	FutureSessionTreeNodeDto,
} from "./future-product-dto.js";
import {
	type FutureSessionContentRefGuardContext,
	isFutureSessionContentRefGuardContext,
	isProductSessionEventDto,
	isSessionCommandResponseDto,
	isSessionEntryDto,
	isSessionJsonRootDto,
	isSessionMessageDto,
	isSessionTextPayloadDto,
	isSessionTreeDto,
	type SessionAttachmentGuardContext,
} from "./product-decoders.js";

const MAX_ARRAY_ITEMS = 10_000;
const MAX_TREE_DEPTH = 128;
const INVALID = Symbol("invalid future content");
type UnknownRecord = Record<string, unknown>;
type Shadow = unknown | typeof INVALID;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachmentContext(context: FutureSessionContentRefGuardContext): SessionAttachmentGuardContext {
	return { serverEpoch: context.serverEpoch, payloadBudget: context.payloadBudget };
}

function shadowText(value: unknown, context: FutureSessionContentRefGuardContext): Shadow {
	if (!isSessionTextPayloadDto(value, context)) return INVALID;
	return typeof value === "string" ? value : "";
}

function shadowJson(value: unknown, context: FutureSessionContentRefGuardContext): Shadow {
	return isSessionJsonRootDto(value, context) ? null : INVALID;
}

function shadowReviewedBlocks(value: unknown, context: FutureSessionContentRefGuardContext): Shadow {
	if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return INVALID;
	const blocks: unknown[] = [];
	for (const block of value) {
		if (!isRecord(block) || block.type !== "text") {
			blocks.push(block);
			continue;
		}
		const text = shadowText(block.text, context);
		if (text === INVALID) return INVALID;
		blocks.push({ ...block, text });
	}
	return blocks;
}

function shadowToolCall(value: unknown, context: FutureSessionContentRefGuardContext): Shadow {
	if (!isRecord(value) || value.type !== "toolCall") return INVALID;
	const args = shadowJson(value.arguments, context);
	return args === INVALID ? INVALID : { ...value, arguments: args };
}

function shadowMessage(value: unknown, context: FutureSessionContentRefGuardContext): Shadow {
	if (!isRecord(value)) return INVALID;
	switch (value.role) {
		case "assistant": {
			if (!Array.isArray(value.content) || value.content.length > MAX_ARRAY_ITEMS) return INVALID;
			const content: unknown[] = [];
			for (const block of value.content) {
				if (!isRecord(block) || block.type !== "toolCall") {
					content.push(block);
					continue;
				}
				const toolCall = shadowToolCall(block, context);
				if (toolCall === INVALID) return INVALID;
				content.push(toolCall);
			}
			return { ...value, content };
		}
		case "toolResult": {
			const content = shadowReviewedBlocks(value.content, context);
			const details = value.details === undefined ? undefined : shadowJson(value.details, context);
			if (content === INVALID || details === INVALID) return INVALID;
			return { ...value, content, ...(value.details === undefined ? {} : { details }) };
		}
		case "custom": {
			const content = Array.isArray(value.content)
				? shadowReviewedBlocks(value.content, context)
				: value.content;
			const details = value.details === undefined ? undefined : shadowJson(value.details, context);
			if (content === INVALID || details === INVALID) return INVALID;
			return { ...value, content, ...(value.details === undefined ? {} : { details }) };
		}
		case "bashExecution": {
			const output = shadowText(value.output, context);
			return output === INVALID ? INVALID : { ...value, output };
		}
		default:
			return value;
	}
}

export function isFutureSessionMessageDto(
	value: unknown,
	context?: FutureSessionContentRefGuardContext,
): value is FutureSessionMessageDto {
	if (!context || !isFutureSessionContentRefGuardContext(context)) return false;
	const shadow = shadowMessage(value, context);
	return shadow !== INVALID && isSessionMessageDto(shadow, attachmentContext(context));
}

function shadowEntry(value: unknown, context: FutureSessionContentRefGuardContext): Shadow {
	if (!isRecord(value)) return INVALID;
	if (value.type === "message") {
		const message = shadowMessage(value.message, context);
		return message === INVALID ? INVALID : { ...value, message };
	}
	if (value.type === "custom_message") {
		const content = Array.isArray(value.content)
			? shadowReviewedBlocks(value.content, context)
			: value.content;
		const details = value.details === undefined ? undefined : shadowJson(value.details, context);
		if (content === INVALID || details === INVALID) return INVALID;
		return { ...value, content, ...(value.details === undefined ? {} : { details }) };
	}
	return value;
}

export function isFutureSessionEntryDto(
	value: unknown,
	context?: FutureSessionContentRefGuardContext,
): value is FutureSessionEntryDto {
	if (!context || !isFutureSessionContentRefGuardContext(context)) return false;
	const shadow = shadowEntry(value, context);
	return shadow !== INVALID && isSessionEntryDto(shadow, attachmentContext(context));
}

function shadowTree(value: unknown, context: FutureSessionContentRefGuardContext): Shadow {
	if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return INVALID;
	let nodes = 0;
	const visit = (node: unknown, depth: number): Shadow => {
		if (depth > MAX_TREE_DEPTH || ++nodes > MAX_ARRAY_ITEMS || !isRecord(node)) return INVALID;
		const entry = shadowEntry(node.entry, context);
		if (entry === INVALID || !Array.isArray(node.children) || node.children.length > MAX_ARRAY_ITEMS) {
			return INVALID;
		}
		const children: unknown[] = [];
		for (const child of node.children) {
			const shadow = visit(child, depth + 1);
			if (shadow === INVALID) return INVALID;
			children.push(shadow);
		}
		return { ...node, entry, children };
	};
	const roots: unknown[] = [];
	for (const node of value) {
		const shadow = visit(node, 0);
		if (shadow === INVALID) return INVALID;
		roots.push(shadow);
	}
	return roots;
}

export function isFutureSessionTreeDto(
	value: unknown,
	context?: FutureSessionContentRefGuardContext,
): value is FutureSessionTreeNodeDto[] {
	if (!context || !isFutureSessionContentRefGuardContext(context)) return false;
	const shadow = shadowTree(value, context);
	return shadow !== INVALID && isSessionTreeDto(shadow, attachmentContext(context));
}

function shadowEvent(value: unknown, context: FutureSessionContentRefGuardContext): Shadow {
	if (!isRecord(value)) return INVALID;
	switch (value.type) {
		case "agent_end": {
			if (!Array.isArray(value.messages) || value.messages.length > MAX_ARRAY_ITEMS) return INVALID;
			const messages = value.messages.map((message) => shadowMessage(message, context));
			return messages.includes(INVALID) ? INVALID : { ...value, messages };
		}
		case "turn_end": {
			const message = shadowMessage(value.message, context);
			if (!Array.isArray(value.toolResults) || value.toolResults.length > MAX_ARRAY_ITEMS) return INVALID;
			const toolResults = value.toolResults.map((result) => shadowMessage(result, context));
			return message === INVALID || toolResults.includes(INVALID)
				? INVALID
				: { ...value, message, toolResults };
		}
		case "message_start":
		case "message_end": {
			const message = shadowMessage(value.message, context);
			return message === INVALID ? INVALID : { ...value, message };
		}
		case "entry_appended": {
			const entry = shadowEntry(value.entry, context);
			return entry === INVALID ? INVALID : { ...value, entry };
		}
		case "message_update": {
			if (!isRecord(value.assistantMessageEvent) || value.assistantMessageEvent.type !== "toolcall_end") {
				return value;
			}
			const toolCall = shadowToolCall(value.assistantMessageEvent.toolCall, context);
			return toolCall === INVALID
				? INVALID
				: { ...value, assistantMessageEvent: { ...value.assistantMessageEvent, toolCall } };
		}
		case "tool_execution_start": {
			const args = shadowJson(value.args, context);
			return args === INVALID ? INVALID : { ...value, args };
		}
		case "tool_execution_update": {
			const args = shadowJson(value.args, context);
			const partialResult = shadowJson(value.partialResult, context);
			return args === INVALID || partialResult === INVALID ? INVALID : { ...value, args, partialResult };
		}
		case "tool_execution_end": {
			const result = shadowJson(value.result, context);
			return result === INVALID ? INVALID : { ...value, result };
		}
		default:
			return value;
	}
}

export function isFutureProductSessionEventDto(
	value: unknown,
	context?: FutureSessionContentRefGuardContext,
): value is FutureProductSessionEventDto {
	if (!context || !isFutureSessionContentRefGuardContext(context)) return false;
	const shadow = shadowEvent(value, context);
	return shadow !== INVALID && isProductSessionEventDto(shadow, attachmentContext(context));
}

function shadowResponse(value: unknown, context: FutureSessionContentRefGuardContext): Shadow {
	if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return value;
	switch (value.command) {
		case "get_messages": {
			if (!Array.isArray(value.data.messages) || value.data.messages.length > MAX_ARRAY_ITEMS) return INVALID;
			const messages = value.data.messages.map((message) => shadowMessage(message, context));
			return messages.includes(INVALID) ? INVALID : { ...value, data: { ...value.data, messages } };
		}
		case "get_entries": {
			if (!Array.isArray(value.data.entries) || value.data.entries.length > MAX_ARRAY_ITEMS) return INVALID;
			const entries = value.data.entries.map((entry) => shadowEntry(entry, context));
			return entries.includes(INVALID) ? INVALID : { ...value, data: { ...value.data, entries } };
		}
		case "get_tree": {
			const tree = shadowTree(value.data.tree, context);
			return tree === INVALID ? INVALID : { ...value, data: { ...value.data, tree } };
		}
		default:
			return value;
	}
}

export function isFutureSessionCommandResponseDto(
	value: unknown,
	context?: FutureSessionContentRefGuardContext,
): value is FutureSessionCommandResponseDto {
	if (!context || !isFutureSessionContentRefGuardContext(context)) return false;
	const shadow = shadowResponse(value, context);
	return shadow !== INVALID && isSessionCommandResponseDto(shadow, attachmentContext(context));
}
