import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
	isPiExtensionUiRequestDto,
	isPiProductSessionEventDto,
	isPiSessionCommandResponseDto,
	isSessionAttachmentGuardContext,
	isSessionContentRefGuardContext,
	isSessionJsonRootDto,
	isSessionTextPayloadDto,
	type SessionAttachmentGuardContext,
	type SessionAttachmentRefDto,
	type SessionCommandTypeDto,
	type SessionContentRefBudgetDto,
	type SessionContentRefDto,
	type SessionContentRefGuardContext,
	type SessionPayloadBudgetDto,
	type SessionTextPayloadDto,
} from "@pi-agent-web/protocol";
import {
	BoundedUtf8CodecError,
	type PreparedBoundedUtf8Encoding,
	prepareBoundedUtf8Encoding,
} from "./bounded-utf8-codec.js";
import {
	type EpochContentHold,
	type EpochContentPutInput,
	EpochContentStoreError,
	type EpochStoredContentRef,
	type EpochUtf8ContentPutInput,
	type StagedEpochContent,
} from "./epoch-content-store.js";
import {
	isPiRpcContentRawEvent,
	isPiRpcContentRawExtensionUiRequest,
	isPiRpcContentRawResponse,
} from "./pi-rpc-content-wire.js";
import { isPiRpcRawEvent, isPiRpcRawResponse } from "./pi-rpc-wire.js";
import { createRasterAdmissionValidator, RasterAdmissionError } from "./raster-admission.js";

type UnknownRecord = Record<string, unknown>;

export interface PiPayloadExternalizerContentStore {
	stage(input: EpochContentPutInput): Promise<StagedEpochContent>;
	publish(hold: EpochContentHold<EpochStoredContentRef>): Promise<void>;
	holdPublished(ref: SessionAttachmentRefDto): Promise<EpochContentHold>;
	release(hold: EpochContentHold<EpochStoredContentRef>): Promise<void>;
}

export interface PiGenericPayloadExternalizerContentStore extends PiPayloadExternalizerContentStore {
	stageUtf8(input: EpochUtf8ContentPutInput): Promise<StagedEpochContent<SessionContentRefDto>>;
	holdPublishedUtf8(ref: SessionContentRefDto): Promise<EpochContentHold<SessionContentRefDto>>;
}

export type PiPayloadExternalizerInput =
	| { kind: "event"; value: unknown }
	| { kind: "extension_ui_request"; value: unknown }
	| { kind: "response"; expectedCommand: SessionCommandTypeDto; value: unknown };

export type PiPayloadExternalizationErrorCode =
	| "aborted"
	| "decoded_image_too_large"
	| "digest_metadata_mismatch"
	| "invalid_base64"
	| "invalid_product_payload"
	| "invalid_raw_payload"
	| "rollback_failed";

export class PiPayloadExternalizationError extends Error {
	constructor(
		readonly code: PiPayloadExternalizationErrorCode,
		message: string,
		readonly limit?: number,
		readonly actual?: number,
	) {
		super(message);
		this.name = "PiPayloadExternalizationError";
	}
}

export interface PiPayloadLeaseTransfer<TRef extends EpochStoredContentRef = SessionAttachmentRefDto> {
	readonly refs: readonly TRef[];
	/** Atomically transfers holds through a synchronous, all-or-nothing owner callback. */
	adopt(accept: (holds: readonly EpochContentHold<TRef>[]) => true): void;
	/** Releases ownership instead of adopting it. Repeated calls share one promise. */
	release(): Promise<void>;
}

export interface PiPayloadLease<TRef extends EpochStoredContentRef = SessionAttachmentRefDto> {
	readonly refs: readonly TRef[];
	/** Moves ownership into a one-shot adopt-or-release token. */
	transfer(): PiPayloadLeaseTransfer<TRef>;
	/** Safe disposal for rejected, timed-out, stale, or otherwise unused outcomes. */
	release(): Promise<void>;
}

export interface Externalized<T = unknown, TRef extends EpochStoredContentRef = SessionAttachmentRefDto> {
	readonly value: T;
	readonly lease: PiPayloadLease<TRef>;
}

export type ExternalizedPiPayload<T = unknown> = Externalized<T>;
export type ExternalizedGenericPiPayload<T = unknown> = Externalized<T, EpochStoredContentRef>;

export interface PiPayloadExternalizerOptions {
	contentStore: PiPayloadExternalizerContentStore;
	serverEpoch: string;
	payloadBudget: SessionPayloadBudgetDto;
	signal?: AbortSignal;
	maxDecodedImageBytes?: number;
	/** Deterministic supplemental guard seam; the built-in context guard always runs first. */
	productGuard?: (
		candidate: unknown,
		context: SessionAttachmentGuardContext,
		input: PiPayloadExternalizerInput,
	) => boolean;
}

export interface PiGenericPayloadExternalizerOptions
	extends Omit<PiPayloadExternalizerOptions, "contentStore" | "productGuard"> {
	contentStore: PiGenericPayloadExternalizerContentStore;
	genericContent: Readonly<{ contentRefBudget: SessionContentRefBudgetDto }>;
	/** Deterministic supplemental content-reference guard after built-in provenance validation. */
	productGuard?: (
		candidate: unknown,
		context: SessionContentRefGuardContext,
		input: PiPayloadExternalizerInput,
	) => boolean;
}

type AnyPiPayloadExternalizerOptions = PiPayloadExternalizerOptions | PiGenericPayloadExternalizerOptions;

type ExactContent = {
	ref: SessionAttachmentRefDto;
	hold: EpochContentHold;
};

type ExactUtf8Content = {
	ref: SessionContentRefDto;
	hold: EpochContentHold<SessionContentRefDto>;
};

type FrameState = {
	options: AnyPiPayloadExternalizerOptions;
	maxDecodedImageBytes: number;
	byInlineIdentity: Map<string, Map<string, SessionAttachmentRefDto>>;
	byDigest: Map<string, ExactContent>;
	utf8ByDigest: Map<string, ExactUtf8Content>;
	textByIdentity: Map<string, SessionTextPayloadDto>;
	holds: EpochContentHold<EpochStoredContentRef>[];
};

export function externalizePiPayload<T = unknown>(
	input: PiPayloadExternalizerInput,
	options: PiGenericPayloadExternalizerOptions,
): Promise<ExternalizedGenericPiPayload<T>>;
export function externalizePiPayload<T = unknown>(
	input: PiPayloadExternalizerInput,
	options: PiPayloadExternalizerOptions,
): Promise<ExternalizedPiPayload<T>>;
export async function externalizePiPayload<T = unknown>(
	input: PiPayloadExternalizerInput,
	options: AnyPiPayloadExternalizerOptions,
): Promise<Externalized<T, EpochStoredContentRef>> {
	assertOptions(options);
	const generic = isGenericOptions(options);
	assertRawInput(input, generic);
	const state: FrameState = {
		options,
		maxDecodedImageBytes: options.maxDecodedImageBytes ?? options.payloadBudget.maxAttachmentBlobBytes,
		byInlineIdentity: new Map(),
		byDigest: new Map(),
		utf8ByDigest: new Map(),
		textByIdentity: new Map(),
		holds: [],
	};
	try {
		throwIfAborted(options.signal);
		const transformed = generic
			? await externalizeGenericFrame(input, state)
			: { value: await externalizeFrame(input, state), currentGuardShadow: undefined };
		const value = transformed.value;
		throwIfAborted(options.signal);
		const attachmentContext = { serverEpoch: options.serverEpoch, payloadBudget: options.payloadBudget };
		const context = generic ? contentRefContext(options) : attachmentContext;
		const guardCandidate = generic ? transformed.currentGuardShadow : value;
		const productValid =
			input.kind === "event"
				? isPiProductSessionEventDto(guardCandidate, attachmentContext)
				: input.kind === "extension_ui_request"
					? isPiExtensionUiRequestDto(guardCandidate)
					: isPiSessionCommandResponseDto(guardCandidate, attachmentContext);
		const supplementalGuard = options.productGuard as
			| ((
					candidate: unknown,
					guardContext: typeof context,
					guardInput: PiPayloadExternalizerInput,
			  ) => boolean)
			| undefined;
		const valid = productValid && (!supplementalGuard || supplementalGuard(value, context, input));
		if (!valid) {
			throw new PiPayloadExternalizationError(
				"invalid_product_payload",
				"Externalized Pi payload failed the product guard",
			);
		}
		return Object.freeze({ value: value as T, lease: createLease(options.contentStore, state.holds) });
	} catch (error) {
		try {
			await releaseHolds(options.contentStore, state.holds);
		} catch (rollbackError) {
			throw new PiPayloadExternalizationError(
				"rollback_failed",
				`Pi payload rollback failed after ${error instanceof Error ? error.name : "externalization error"}: ${rollbackError instanceof Error ? rollbackError.name : "release error"}`,
			);
		}
		throw normalizeExternalizationError(error);
	}
}

function isGenericOptions(
	options: AnyPiPayloadExternalizerOptions,
): options is PiGenericPayloadExternalizerOptions {
	return "genericContent" in options;
}

function contentRefContext(options: PiGenericPayloadExternalizerOptions): SessionContentRefGuardContext {
	return {
		serverEpoch: options.serverEpoch,
		payloadBudget: options.payloadBudget,
		contentRefBudget: options.genericContent.contentRefBudget,
	};
}

function assertOptions(options: AnyPiPayloadExternalizerOptions): void {
	const maxDecoded = options.maxDecodedImageBytes ?? options.payloadBudget?.maxAttachmentBlobBytes;
	if (
		!options ||
		typeof options.serverEpoch !== "string" ||
		options.serverEpoch.length === 0 ||
		!isSessionAttachmentGuardContext({
			serverEpoch: options.serverEpoch,
			payloadBudget: options.payloadBudget,
		}) ||
		!Number.isSafeInteger(maxDecoded) ||
		(maxDecoded ?? 0) <= 0
	) {
		throw new TypeError("Pi payload externalizer options are invalid");
	}
	if (
		isGenericOptions(options) &&
		(!isSessionContentRefGuardContext(contentRefContext(options)) ||
			typeof options.contentStore.stageUtf8 !== "function" ||
			typeof options.contentStore.holdPublishedUtf8 !== "function")
	) {
		throw new TypeError("Pi generic payload externalizer options are invalid");
	}
}

function assertRawInput(input: PiPayloadExternalizerInput, generic: boolean): void {
	const valid = generic
		? input.kind === "event"
			? isPiRpcContentRawEvent(input.value)
			: input.kind === "extension_ui_request"
				? isPiRpcContentRawExtensionUiRequest(input.value)
				: isPiRpcContentRawResponse(input.value, input.expectedCommand)
		: input.kind === "event"
			? isPiRpcRawEvent(input.value)
			: input.kind === "response" && isPiRpcRawResponse(input.value, input.expectedCommand);
	if (!valid) {
		throw new PiPayloadExternalizationError("invalid_raw_payload", "Pi payload failed raw provenance guards");
	}
}

async function externalizeFrame(input: PiPayloadExternalizerInput, state: FrameState): Promise<unknown> {
	const value = input.value as UnknownRecord;
	if (input.kind === "response") return externalizeResponse(value, state);
	if (input.kind === "extension_ui_request") return value;
	return externalizeEvent(value, state);
}

async function externalizeResponse(value: UnknownRecord, state: FrameState): Promise<unknown> {
	if (value.success !== true || !isRecord(value.data)) return value;
	switch (value.command) {
		case "get_messages":
			return {
				...value,
				data: {
					...value.data,
					messages: await mapAsync(value.data.messages, (message) => externalizeMessage(message, state)),
				},
			};
		case "get_entries":
			return {
				...value,
				data: {
					...value.data,
					entries: await mapAsync(value.data.entries, (entry) => externalizeEntry(entry, state)),
				},
			};
		case "get_tree":
			return { ...value, data: { ...value.data, tree: await externalizeTree(value.data.tree, state) } };
		default:
			return value;
	}
}

async function externalizeEvent(value: UnknownRecord, state: FrameState): Promise<unknown> {
	switch (value.type) {
		case "agent_end":
			return {
				...value,
				messages: await mapAsync(value.messages, (message) => externalizeMessage(message, state)),
			};
		case "turn_end":
			return {
				...value,
				message: await externalizeMessage(value.message, state),
				toolResults: await mapAsync(value.toolResults, (message) => externalizeMessage(message, state)),
			};
		case "message_start":
		case "message_end":
			return { ...value, message: await externalizeMessage(value.message, state) };
		case "entry_appended":
			return { ...value, entry: await externalizeEntry(value.entry, state) };
		default:
			return value;
	}
}

async function externalizeMessage(value: unknown, state: FrameState): Promise<unknown> {
	const message = value as UnknownRecord;
	if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") return value;
	const content = await externalizeContent(message.content, state);
	return content === message.content ? value : { ...message, content };
}

async function externalizeEntry(value: unknown, state: FrameState): Promise<unknown> {
	const entry = value as UnknownRecord;
	if (entry.type === "message") {
		const message = await externalizeMessage(entry.message, state);
		return message === entry.message ? value : { ...entry, message };
	}
	if (entry.type === "custom_message") {
		const content = await externalizeContent(entry.content, state);
		return content === entry.content ? value : { ...entry, content };
	}
	return value;
}

async function externalizeTree(value: unknown, state: FrameState): Promise<unknown> {
	return mapAsync(value, async (candidate) => {
		const node = candidate as UnknownRecord;
		return {
			...node,
			entry: await externalizeEntry(node.entry, state),
			children: await externalizeTree(node.children, state),
		};
	});
}

async function externalizeContent(value: unknown, state: FrameState): Promise<unknown> {
	if (!Array.isArray(value)) return value;
	let changed = false;
	const content = [];
	for (const block of value) {
		if (!isRecord(block) || block.type !== "image") {
			content.push(block);
			continue;
		}
		changed = true;
		content.push(await externalizeImage(block, state));
	}
	return changed ? content : value;
}

type GenericTraversalResult = {
	value: unknown;
	currentGuardShadow: unknown;
};

function unchangedGeneric(value: unknown): GenericTraversalResult {
	return { value, currentGuardShadow: value };
}

async function externalizeGenericFrame(
	input: PiPayloadExternalizerInput,
	state: FrameState,
): Promise<GenericTraversalResult> {
	const value = input.value as UnknownRecord;
	if (input.kind === "response") return externalizeGenericResponse(value, state);
	if (input.kind === "extension_ui_request") return externalizeGenericExtensionRequest(value, state);
	return externalizeGenericEvent(value, state);
}

async function externalizeGenericExtensionRequest(
	value: UnknownRecord,
	state: FrameState,
): Promise<GenericTraversalResult> {
	switch (value.method) {
		case "editor": {
			if (typeof value.prefill !== "string") return unchangedGeneric(value);
			return pairRecordField(value, "prefill", await externalizeTextRoot(value.prefill, state));
		}
		case "set_editor_text": {
			if (typeof value.text !== "string") return unchangedGeneric(value);
			return pairRecordField(value, "text", await externalizeTextRoot(value.text, state));
		}
		case "setWidget": {
			if (value.widgetLines === undefined) return unchangedGeneric(value);
			const widgetLines = await externalizeJsonRoot(value.widgetLines, state);
			return {
				value: { ...value, widgetLines: widgetLines.value },
				currentGuardShadow: { ...value, widgetLines: [] },
			};
		}
		default:
			return unchangedGeneric(value);
	}
}

async function externalizeGenericResponse(
	value: UnknownRecord,
	state: FrameState,
): Promise<GenericTraversalResult> {
	if (value.success !== true || !isRecord(value.data)) return unchangedGeneric(value);
	let field: "messages" | "entries" | "tree";
	let items: GenericTraversalResult[];
	switch (value.command) {
		case "get_messages":
			field = "messages";
			items = await mapGeneric(value.data.messages, (message) => externalizeGenericMessage(message, state));
			break;
		case "get_entries":
			field = "entries";
			items = await mapGeneric(value.data.entries, (entry) => externalizeGenericEntry(entry, state));
			break;
		case "get_tree":
			field = "tree";
			items = await mapGeneric(value.data.tree, (node) => externalizeGenericTreeNode(node, state));
			break;
		default:
			return unchangedGeneric(value);
	}
	const productItems = items.map((item) => item.value);
	const shadowItems = items.map((item) => item.currentGuardShadow);
	return {
		value: { ...value, data: { ...value.data, [field]: productItems } },
		currentGuardShadow: { ...value, data: { ...value.data, [field]: shadowItems } },
	};
}

async function externalizeGenericEvent(
	value: UnknownRecord,
	state: FrameState,
): Promise<GenericTraversalResult> {
	switch (value.type) {
		case "agent_end": {
			const messages = await mapGeneric(value.messages, (message) =>
				externalizeGenericMessage(message, state),
			);
			return pairRecordArray(value, "messages", messages);
		}
		case "turn_end": {
			const message = await externalizeGenericMessage(value.message, state);
			const toolResults = await mapGeneric(value.toolResults, (candidate) =>
				externalizeGenericMessage(candidate, state),
			);
			return {
				value: {
					...value,
					message: message.value,
					toolResults: toolResults.map((item) => item.value),
				},
				currentGuardShadow: {
					...value,
					message: message.currentGuardShadow,
					toolResults: toolResults.map((item) => item.currentGuardShadow),
				},
			};
		}
		case "message_start":
		case "message_end": {
			const message = await externalizeGenericMessage(value.message, state);
			return pairRecordField(value, "message", message);
		}
		case "entry_appended": {
			const entry = await externalizeGenericEntry(value.entry, state);
			return pairRecordField(value, "entry", entry);
		}
		case "message_update": {
			const streamEvent = value.assistantMessageEvent as UnknownRecord;
			if (streamEvent.type !== "toolcall_end") return unchangedGeneric(value);
			const toolCall = await externalizeGenericToolCall(streamEvent.toolCall, state);
			return {
				value: {
					...value,
					assistantMessageEvent: { ...streamEvent, toolCall: toolCall.value },
				},
				currentGuardShadow: {
					...value,
					assistantMessageEvent: { ...streamEvent, toolCall: toolCall.currentGuardShadow },
				},
			};
		}
		case "tool_execution_start": {
			const args = await externalizeJsonRoot(value.args, state);
			return pairRecordField(value, "args", args);
		}
		case "tool_execution_update": {
			const args = await externalizeJsonRoot(value.args, state);
			const partialResult = await externalizeJsonRoot(value.partialResult, state);
			return {
				value: { ...value, args: args.value, partialResult: partialResult.value },
				currentGuardShadow: {
					...value,
					args: args.currentGuardShadow,
					partialResult: partialResult.currentGuardShadow,
				},
			};
		}
		case "tool_execution_end": {
			const result = await externalizeJsonRoot(value.result, state);
			return pairRecordField(value, "result", result);
		}
		default:
			return unchangedGeneric(value);
	}
}

async function externalizeGenericMessage(value: unknown, state: FrameState): Promise<GenericTraversalResult> {
	const message = value as UnknownRecord;
	switch (message.role) {
		case "user": {
			const content = await externalizeGenericContentBlocks(message.content, state, {
				images: true,
			});
			return pairRecordField(message, "content", content);
		}
		case "assistant": {
			const content = await externalizeGenericContentBlocks(message.content, state, {
				toolCalls: true,
			});
			return pairRecordField(message, "content", content);
		}
		case "toolResult": {
			const content = await externalizeGenericContentBlocks(message.content, state, {
				images: true,
				text: true,
			});
			const details =
				message.details === undefined
					? unchangedGeneric(undefined)
					: await externalizeJsonRoot(message.details, state);
			return pairRecordFields(message, { content, ...(message.details === undefined ? {} : { details }) });
		}
		case "custom": {
			const content = Array.isArray(message.content)
				? await externalizeGenericContentBlocks(message.content, state, { images: true, text: true })
				: unchangedGeneric(message.content);
			const details =
				message.details === undefined
					? unchangedGeneric(undefined)
					: await externalizeJsonRoot(message.details, state);
			return pairRecordFields(message, { content, ...(message.details === undefined ? {} : { details }) });
		}
		case "bashExecution": {
			const output = await externalizeTextRoot(message.output as string, state);
			return pairRecordField(message, "output", output);
		}
		default:
			return unchangedGeneric(value);
	}
}

async function externalizeGenericEntry(value: unknown, state: FrameState): Promise<GenericTraversalResult> {
	const entry = value as UnknownRecord;
	if (entry.type === "message") {
		return pairRecordField(entry, "message", await externalizeGenericMessage(entry.message, state));
	}
	if (entry.type === "custom_message") {
		const content = Array.isArray(entry.content)
			? await externalizeGenericContentBlocks(entry.content, state, { images: true, text: true })
			: unchangedGeneric(entry.content);
		const details =
			entry.details === undefined
				? unchangedGeneric(undefined)
				: await externalizeJsonRoot(entry.details, state);
		return pairRecordFields(entry, { content, ...(entry.details === undefined ? {} : { details }) });
	}
	return unchangedGeneric(value);
}

async function externalizeGenericTreeNode(
	value: unknown,
	state: FrameState,
): Promise<GenericTraversalResult> {
	const node = value as UnknownRecord;
	const entry = await externalizeGenericEntry(node.entry, state);
	const children = await mapGeneric(node.children, (child) => externalizeGenericTreeNode(child, state));
	return {
		value: { ...node, entry: entry.value, children: children.map((item) => item.value) },
		currentGuardShadow: {
			...node,
			entry: entry.currentGuardShadow,
			children: children.map((item) => item.currentGuardShadow),
		},
	};
}

async function externalizeGenericContentBlocks(
	value: unknown,
	state: FrameState,
	options: Readonly<{ images?: boolean; text?: boolean; toolCalls?: boolean }>,
): Promise<GenericTraversalResult> {
	if (!Array.isArray(value)) return unchangedGeneric(value);
	const items: GenericTraversalResult[] = [];
	for (const block of value) {
		if (!isRecord(block)) {
			items.push(unchangedGeneric(block));
			continue;
		}
		if (options.images && block.type === "image") {
			const image = await externalizeImage(block, state);
			items.push({ value: image, currentGuardShadow: image });
			continue;
		}
		if (options.text && block.type === "text") {
			const text = await externalizeTextRoot(block.text as string, state);
			items.push(pairRecordField(block, "text", text));
			continue;
		}
		if (options.toolCalls && block.type === "toolCall") {
			items.push(await externalizeGenericToolCall(block, state));
			continue;
		}
		items.push(unchangedGeneric(block));
	}
	return {
		value: items.map((item) => item.value),
		currentGuardShadow: items.map((item) => item.currentGuardShadow),
	};
}

async function externalizeGenericToolCall(
	value: unknown,
	state: FrameState,
): Promise<GenericTraversalResult> {
	const toolCall = value as UnknownRecord;
	const args = await externalizeJsonRoot(toolCall.arguments, state);
	return pairRecordField(toolCall, "arguments", args);
}

async function externalizeTextRoot(value: string, state: FrameState): Promise<GenericTraversalResult> {
	const cached = state.textByIdentity.get(value);
	if (cached !== undefined) {
		return { value: cached, currentGuardShadow: typeof cached === "string" ? cached : "" };
	}
	const options = requireGenericOptions(state);
	const prepared = await prepareBoundedUtf8Encoding(
		{ kind: "text", value },
		{ signal: options.signal, maxBytes: options.genericContent.contentRefBudget.maxContentBlobBytes },
	);
	let product: SessionTextPayloadDto;
	let shadow: unknown = value;
	if (prepared.byteLength < options.genericContent.contentRefBudget.inlineContentThresholdBytes) {
		product = value;
	} else {
		const exact = await acquireExactUtf8Content(prepared, state);
		product = Object.freeze({ type: "external_text" as const, ref: exact.ref });
		shadow = "";
	}
	if (!isSessionTextPayloadDto(product, contentRefContext(options))) {
		throw new PiPayloadExternalizationError(
			"invalid_product_payload",
			"Externalized Pi text failed its product guard",
		);
	}
	state.textByIdentity.set(value, product);
	return { value: product, currentGuardShadow: shadow };
}

async function externalizeJsonRoot(value: unknown, state: FrameState): Promise<GenericTraversalResult> {
	const options = requireGenericOptions(state);
	const prepared = await prepareBoundedUtf8Encoding(
		{ kind: "json", value },
		{ signal: options.signal, maxBytes: options.genericContent.contentRefBudget.maxContentBlobBytes },
	);
	let product: unknown;
	let shadow: unknown = value;
	if (prepared.byteLength < options.genericContent.contentRefBudget.inlineContentThresholdBytes) {
		product = Object.freeze({ type: "inline_json" as const, value });
	} else {
		const exact = await acquireExactUtf8Content(prepared, state);
		product = Object.freeze({ type: "external_json" as const, ref: exact.ref });
		shadow = null;
	}
	if (!isSessionJsonRootDto(product, contentRefContext(options))) {
		throw new PiPayloadExternalizationError(
			"invalid_product_payload",
			"Externalized Pi JSON failed its product guard",
		);
	}
	return { value: product, currentGuardShadow: shadow };
}

function requireGenericOptions(state: FrameState): PiGenericPayloadExternalizerOptions {
	if (!isGenericOptions(state.options)) throw new Error("Generic payload traversal requires generic options");
	return state.options;
}

async function acquireExactUtf8Content(
	prepared: PreparedBoundedUtf8Encoding,
	state: FrameState,
): Promise<ExactUtf8Content> {
	const options = requireGenericOptions(state);
	const computedRef = Object.freeze({
		type: "content_ref" as const,
		serverEpoch: options.serverEpoch,
		sha256: prepared.sha256,
		byteLength: prepared.byteLength,
		encoding: "utf-8" as const,
	});
	const digestMatch = state.utf8ByDigest.get(computedRef.sha256);
	if (digestMatch) {
		if (!contentRefsEqual(digestMatch.ref, computedRef)) {
			throw new PiPayloadExternalizationError(
				"digest_metadata_mismatch",
				"Equal Pi UTF-8 digests carried different metadata",
			);
		}
		return digestMatch;
	}

	let exact: ExactUtf8Content;
	try {
		const hold = await options.contentStore.holdPublishedUtf8(computedRef);
		state.holds.push(hold);
		throwIfAborted(options.signal);
		if (!contentRefsEqual(hold.ref, computedRef)) {
			throw new PiPayloadExternalizationError(
				"digest_metadata_mismatch",
				"Published Pi UTF-8 metadata differed from computed content",
			);
		}
		exact = { ref: hold.ref, hold };
	} catch (error) {
		if (
			!(error instanceof EpochContentStoreError) ||
			(error.code !== "not_found" && error.code !== "not_published")
		) {
			throw error;
		}
		throwIfAborted(options.signal);
		const staged = await options.contentStore.stageUtf8({
			source: prepared.createReadable({ signal: options.signal }),
			expectedSha256: computedRef.sha256,
			expectedByteLength: computedRef.byteLength,
			signal: options.signal,
		});
		state.holds.push(staged.hold);
		if (!contentRefsEqual(staged.ref, computedRef) || !contentRefsEqual(staged.hold.ref, computedRef)) {
			throw new PiPayloadExternalizationError(
				"digest_metadata_mismatch",
				"Staged Pi UTF-8 metadata differed from computed content",
			);
		}
		throwIfAborted(options.signal);
		await options.contentStore.publish(staged.hold);
		throwIfAborted(options.signal);
		exact = { ref: staged.ref, hold: staged.hold };
	}
	state.utf8ByDigest.set(computedRef.sha256, exact);
	return exact;
}

function pairRecordField(
	record: UnknownRecord,
	key: string,
	pair: GenericTraversalResult,
): GenericTraversalResult {
	return pairRecordFields(record, { [key]: pair });
}

function pairRecordFields(
	record: UnknownRecord,
	fields: Readonly<Record<string, GenericTraversalResult>>,
): GenericTraversalResult {
	const product: UnknownRecord = { ...record };
	const shadow: UnknownRecord = { ...record };
	for (const [key, pair] of Object.entries(fields)) {
		product[key] = pair.value;
		shadow[key] = pair.currentGuardShadow;
	}
	return { value: product, currentGuardShadow: shadow };
}

function pairRecordArray(
	record: UnknownRecord,
	key: string,
	items: readonly GenericTraversalResult[],
): GenericTraversalResult {
	return {
		value: { ...record, [key]: items.map((item) => item.value) },
		currentGuardShadow: { ...record, [key]: items.map((item) => item.currentGuardShadow) },
	};
}

async function mapGeneric(
	value: unknown,
	mapper: (item: unknown) => Promise<GenericTraversalResult>,
): Promise<GenericTraversalResult[]> {
	const result: GenericTraversalResult[] = [];
	for (const item of value as unknown[]) result.push(await mapper(item));
	return result;
}

async function externalizeImage(block: UnknownRecord, state: FrameState): Promise<unknown> {
	throwIfAborted(state.options.signal);
	const data = block.data as string;
	const mediaType = block.mimeType as string;
	const inlineMedia = state.byInlineIdentity.get(mediaType);
	const cached = inlineMedia?.get(data);
	if (cached) return { type: "image", data: cached, mimeType: mediaType };

	const decodedLength = canonicalBase64DecodedLength(data);
	if (decodedLength > state.maxDecodedImageBytes) {
		throw new PiPayloadExternalizationError(
			"decoded_image_too_large",
			"Decoded Pi image exceeded its limit",
			state.maxDecodedImageBytes,
			decodedLength,
		);
	}
	if (decodedLength > state.options.payloadBudget.maxAttachmentBlobBytes) {
		throw new EpochContentStoreError("blob_too_large", "Decoded Pi image exceeded the blob limit", {
			limit: state.options.payloadBudget.maxAttachmentBlobBytes,
			actual: decodedLength,
		});
	}
	const raster = createRasterAdmissionValidator(mediaType, decodedLength);
	const decoded = Buffer.from(data, "base64");
	if (decoded.byteLength !== decodedLength) {
		throw new PiPayloadExternalizationError("invalid_base64", "Pi image base64 is not canonical");
	}
	raster.push(decoded);
	raster.finish();
	const sha256 = createHash("sha256").update(decoded).digest("hex");
	const computedRef = Object.freeze({
		type: "attachment_ref" as const,
		serverEpoch: state.options.serverEpoch,
		sha256,
		mediaType,
		byteLength: decoded.byteLength,
	});
	const digestMatch = state.byDigest.get(sha256);
	if (digestMatch) {
		if (!refsEqual(digestMatch.ref, computedRef)) {
			throw new PiPayloadExternalizationError(
				"digest_metadata_mismatch",
				"Equal Pi image digests carried different metadata",
			);
		}
		cacheInlineRef(state, mediaType, data, digestMatch.ref);
		return { type: "image", data: digestMatch.ref, mimeType: mediaType };
	}

	const exact = await acquireExactContent(decoded, computedRef, state);
	state.byDigest.set(sha256, exact);
	cacheInlineRef(state, mediaType, data, exact.ref);
	return { type: "image", data: exact.ref, mimeType: mediaType };
}

function cacheInlineRef(
	state: FrameState,
	mediaType: string,
	data: string,
	ref: SessionAttachmentRefDto,
): void {
	let media = state.byInlineIdentity.get(mediaType);
	if (!media) {
		media = new Map();
		state.byInlineIdentity.set(mediaType, media);
	}
	media.set(data, ref);
}

async function acquireExactContent(
	decoded: Buffer,
	computedRef: SessionAttachmentRefDto,
	state: FrameState,
): Promise<ExactContent> {
	let hold: EpochContentHold;
	try {
		hold = await state.options.contentStore.holdPublished(computedRef);
		state.holds.push(hold);
		throwIfAborted(state.options.signal);
		if (!refsEqual(hold.ref, computedRef)) {
			throw new PiPayloadExternalizationError(
				"digest_metadata_mismatch",
				"Published Pi image metadata differed from computed content",
			);
		}
		return { ref: hold.ref, hold };
	} catch (error) {
		if (
			!(error instanceof EpochContentStoreError) ||
			(error.code !== "not_found" && error.code !== "not_published")
		) {
			throw error;
		}
	}

	throwIfAborted(state.options.signal);
	const staged = await state.options.contentStore.stage({
		source: Readable.from([decoded]),
		mediaType: computedRef.mediaType,
		expectedSha256: computedRef.sha256,
		expectedByteLength: computedRef.byteLength,
		signal: state.options.signal,
	});
	state.holds.push(staged.hold);
	if (!refsEqual(staged.ref, computedRef) || !refsEqual(staged.hold.ref, computedRef)) {
		throw new PiPayloadExternalizationError(
			"digest_metadata_mismatch",
			"Staged Pi image metadata differed from computed content",
		);
	}
	throwIfAborted(state.options.signal);
	await state.options.contentStore.publish(staged.hold);
	throwIfAborted(state.options.signal);
	return { ref: staged.ref, hold: staged.hold };
}

function canonicalBase64DecodedLength(value: string): number {
	if (
		value.length === 0 ||
		value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
	) {
		throw new PiPayloadExternalizationError("invalid_base64", "Pi image base64 is not canonical");
	}
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const finalDataIndex = value.length - padding - 1;
	const finalSextet = base64Sextet(value.charCodeAt(finalDataIndex));
	if ((padding === 2 && (finalSextet & 0x0f) !== 0) || (padding === 1 && (finalSextet & 0x03) !== 0)) {
		throw new PiPayloadExternalizationError("invalid_base64", "Pi image base64 has non-zero padding bits");
	}
	return (value.length / 4) * 3 - padding;
}

function base64Sextet(code: number): number {
	if (code >= 65 && code <= 90) return code - 65;
	if (code >= 97 && code <= 122) return code - 71;
	if (code >= 48 && code <= 57) return code + 4;
	return code === 43 ? 62 : 63;
}

function createLease<TRef extends EpochStoredContentRef>(
	store: PiPayloadExternalizerContentStore,
	holds: readonly EpochContentHold<TRef>[],
): PiPayloadLease<TRef> {
	const owned = Object.freeze([...holds]);
	const refs = Object.freeze(owned.map((hold) => hold.ref));
	let state: "provisional" | "releasing" | "released" | "transferred" = "provisional";
	let releasePromise: Promise<void> | undefined;
	return Object.freeze({
		refs,
		transfer() {
			if (state !== "provisional") throw new Error("Pi payload lease is no longer transferable");
			state = "transferred";
			return createTransfer(store, owned, refs);
		},
		release() {
			if (state === "transferred" || state === "released") return releasePromise ?? Promise.resolve();
			if (state === "releasing") return releasePromise!;
			state = "releasing";
			releasePromise = releaseHolds(store, owned).finally(() => {
				state = "released";
			});
			return releasePromise;
		},
	});
}

function createTransfer<TRef extends EpochStoredContentRef>(
	store: PiPayloadExternalizerContentStore,
	holds: readonly EpochContentHold<TRef>[],
	refs: readonly TRef[],
): PiPayloadLeaseTransfer<TRef> {
	let state: "pending" | "adopting" | "adopted" | "releasing" | "released" = "pending";
	let releasePromise: Promise<void> | undefined;
	return Object.freeze({
		refs,
		adopt(accept: (holds: readonly EpochContentHold<TRef>[]) => true) {
			if (state !== "pending") throw new Error("Pi payload lease transfer is no longer adoptable");
			state = "adopting";
			try {
				if (accept(holds) !== true) {
					throw new Error("Pi payload lease transfer was not atomically adopted");
				}
				state = "adopted";
			} catch (error) {
				state = "pending";
				throw error;
			}
		},
		release() {
			if (state === "adopting") throw new Error("Pi payload lease transfer is being adopted");
			if (state === "adopted" || state === "released") return releasePromise ?? Promise.resolve();
			if (state === "releasing") return releasePromise!;
			state = "releasing";
			releasePromise = releaseHolds(store, holds).finally(() => {
				state = "released";
			});
			return releasePromise;
		},
	});
}

async function releaseHolds(
	store: PiPayloadExternalizerContentStore,
	holds: readonly EpochContentHold<EpochStoredContentRef>[],
): Promise<void> {
	let failure: unknown;
	for (const hold of [...holds].reverse()) {
		try {
			await store.release(hold);
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure !== undefined) throw failure;
}

function refsEqual(left: SessionAttachmentRefDto, right: SessionAttachmentRefDto): boolean {
	return (
		left.type === right.type &&
		left.serverEpoch === right.serverEpoch &&
		left.sha256 === right.sha256 &&
		left.mediaType === right.mediaType &&
		left.byteLength === right.byteLength
	);
}

function contentRefsEqual(left: SessionContentRefDto, right: SessionContentRefDto): boolean {
	return (
		left.type === right.type &&
		left.serverEpoch === right.serverEpoch &&
		left.sha256 === right.sha256 &&
		left.byteLength === right.byteLength &&
		left.encoding === right.encoding
	);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw new PiPayloadExternalizationError("aborted", "Pi payload externalization was aborted");
}

function normalizeExternalizationError(error: unknown): unknown {
	if (error instanceof RasterAdmissionError) return error;
	if (error instanceof PiPayloadExternalizationError || error instanceof EpochContentStoreError) return error;
	if (error instanceof BoundedUtf8CodecError) {
		if (error.code === "aborted") {
			return new PiPayloadExternalizationError("aborted", "Pi payload externalization was aborted");
		}
		if (
			error.code === "byte_limit_exceeded" &&
			Number.isSafeInteger(error.limit) &&
			(error.limit ?? 0) > 0 &&
			Number.isSafeInteger(error.actual) &&
			(error.actual ?? 0) > (error.limit ?? 0)
		) {
			return new EpochContentStoreError("blob_too_large", "Pi UTF-8 content exceeded the blob limit", {
				limit: error.limit,
				actual: error.actual,
			});
		}
		return error;
	}
	if (error instanceof Error && error.name === "AbortError") {
		return new PiPayloadExternalizationError("aborted", "Pi payload externalization was aborted");
	}
	return error;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mapAsync<T>(value: unknown, mapper: (item: unknown) => Promise<T>): Promise<T[]> {
	const result: T[] = [];
	for (const item of value as unknown[]) result.push(await mapper(item));
	return result;
}
