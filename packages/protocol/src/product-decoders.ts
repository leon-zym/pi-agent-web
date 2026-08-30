import {
	isPiExtensionUiRequestDto,
	isPiProductSessionEventDto,
	isPiSessionCommandResponseDto,
	isPiSessionEntryDto,
	isPiSessionMessageDto,
	isPiSessionTreeDto,
	isSessionContentRefGuardContext,
	isSessionJsonRootDto,
	isSessionTextPayloadDto,
	type SessionAttachmentGuardContext,
	type SessionContentRefGuardContext,
} from "./pi-product-decoders.js";
import type {
	ExtensionUiRequestDto,
	ProductSessionEventDto,
	SessionCommandResponseDto,
	SessionEntryDto,
	SessionMessageDto,
	SessionTreeNodeDto,
} from "./product-dto.js";

const MAX_ARRAY_ITEMS = 10_000;
const MAX_TREE_DEPTH = 128;
const INVALID = Symbol("invalid content-reference payload");
type UnknownRecord = Record<string, unknown>;
type Shadow = unknown | typeof INVALID;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachmentContext(context: SessionContentRefGuardContext): SessionAttachmentGuardContext {
	return { serverEpoch: context.serverEpoch, payloadBudget: context.payloadBudget };
}

function shadowText(value: unknown, context: SessionContentRefGuardContext): Shadow {
	if (!isSessionTextPayloadDto(value, context)) return INVALID;
	return typeof value === "string" ? value : "";
}

function shadowJson(value: unknown, context: SessionContentRefGuardContext): Shadow {
	return isSessionJsonRootDto(value, context) ? null : INVALID;
}

function shadowWidgetLines(value: unknown, context: SessionContentRefGuardContext): Shadow {
	if (!isSessionJsonRootDto(value, context)) return INVALID;
	return isRecord(value) && value.type === "inline_json" ? value.value : [];
}

function shadowExtensionRequest(value: unknown, context: SessionContentRefGuardContext): Shadow {
	if (!isRecord(value)) return INVALID;
	switch (value.method) {
		case "editor": {
			if (value.prefill === undefined) return value;
			const prefill = shadowText(value.prefill, context);
			return prefill === INVALID ? INVALID : { ...value, prefill };
		}
		case "set_editor_text": {
			const text = shadowText(value.text, context);
			return text === INVALID ? INVALID : { ...value, text };
		}
		case "setWidget": {
			if (value.widgetLines === undefined) return value;
			const widgetLines = shadowWidgetLines(value.widgetLines, context);
			return widgetLines === INVALID ? INVALID : { ...value, widgetLines };
		}
		default:
			return value;
	}
}

export function isExtensionUiRequestDto(
	value: unknown,
	context?: SessionContentRefGuardContext,
): value is ExtensionUiRequestDto {
	if (!context || !isSessionContentRefGuardContext(context)) return false;
	const shadow = shadowExtensionRequest(value, context);
	return shadow !== INVALID && isPiExtensionUiRequestDto(shadow);
}

function shadowReviewedBlocks(value: unknown, context: SessionContentRefGuardContext): Shadow {
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

function shadowToolCall(value: unknown, context: SessionContentRefGuardContext): Shadow {
	if (!isRecord(value) || value.type !== "toolCall") return INVALID;
	const args = shadowJson(value.arguments, context);
	return args === INVALID ? INVALID : { ...value, arguments: args };
}

function shadowMessage(value: unknown, context: SessionContentRefGuardContext): Shadow {
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

export function isSessionMessageDto(
	value: unknown,
	context?: SessionContentRefGuardContext,
): value is SessionMessageDto {
	if (!context || !isSessionContentRefGuardContext(context)) return false;
	const shadow = shadowMessage(value, context);
	return shadow !== INVALID && isPiSessionMessageDto(shadow, attachmentContext(context));
}

function shadowEntry(value: unknown, context: SessionContentRefGuardContext): Shadow {
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

export function isSessionEntryDto(
	value: unknown,
	context?: SessionContentRefGuardContext,
): value is SessionEntryDto {
	if (!context || !isSessionContentRefGuardContext(context)) return false;
	const shadow = shadowEntry(value, context);
	return shadow !== INVALID && isPiSessionEntryDto(shadow, attachmentContext(context));
}

function shadowTree(value: unknown, context: SessionContentRefGuardContext): Shadow {
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

export function isSessionTreeDto(
	value: unknown,
	context?: SessionContentRefGuardContext,
): value is SessionTreeNodeDto[] {
	if (!context || !isSessionContentRefGuardContext(context)) return false;
	const shadow = shadowTree(value, context);
	return shadow !== INVALID && isPiSessionTreeDto(shadow, attachmentContext(context));
}

function shadowEvent(value: unknown, context: SessionContentRefGuardContext): Shadow {
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

export function isProductSessionEventDto(
	value: unknown,
	context?: SessionContentRefGuardContext,
): value is ProductSessionEventDto {
	if (!context || !isSessionContentRefGuardContext(context)) return false;
	const shadow = shadowEvent(value, context);
	return shadow !== INVALID && isPiProductSessionEventDto(shadow, attachmentContext(context));
}

function shadowResponse(value: unknown, context: SessionContentRefGuardContext): Shadow {
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

export function isSessionCommandResponseDto(
	value: unknown,
	context?: SessionContentRefGuardContext,
): value is SessionCommandResponseDto {
	if (!context || !isSessionContentRefGuardContext(context)) return false;
	const shadow = shadowResponse(value, context);
	return shadow !== INVALID && isPiSessionCommandResponseDto(shadow, attachmentContext(context));
}
