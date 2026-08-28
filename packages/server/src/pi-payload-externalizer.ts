import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
	isProductSessionEventDto,
	isSessionAttachmentGuardContext,
	isSessionCommandResponseDto,
	type SessionAttachmentGuardContext,
	type SessionAttachmentRefDto,
	type SessionCommandTypeDto,
	type SessionPayloadBudgetDto,
} from "@pi-agent-web/protocol";
import {
	type EpochContentHold,
	type EpochContentPutInput,
	EpochContentStoreError,
	type StagedEpochContent,
} from "./epoch-content-store.js";
import { isLegacyRpcV1RawEvent, isLegacyRpcV1RawResponse } from "./legacy-rpc-v1-wire.js";
import { createRasterAdmissionValidator, RasterAdmissionError } from "./raster-admission.js";

type UnknownRecord = Record<string, unknown>;

export interface PiPayloadExternalizerContentStore {
	stage(input: EpochContentPutInput): Promise<StagedEpochContent>;
	publish(hold: EpochContentHold): Promise<void>;
	holdPublished(ref: SessionAttachmentRefDto): Promise<EpochContentHold>;
	release(hold: EpochContentHold): Promise<void>;
}

export type PiPayloadExternalizerInput =
	| { kind: "event"; value: unknown }
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

export interface PiPayloadLeaseTransfer {
	readonly refs: readonly SessionAttachmentRefDto[];
	/** Atomically transfers holds through a synchronous, all-or-nothing owner callback. */
	adopt(accept: (holds: readonly EpochContentHold[]) => true): void;
	/** Releases ownership instead of adopting it. Repeated calls share one promise. */
	release(): Promise<void>;
}

export interface PiPayloadLease {
	readonly refs: readonly SessionAttachmentRefDto[];
	/** Moves ownership into a one-shot adopt-or-release token. */
	transfer(): PiPayloadLeaseTransfer;
	/** Safe disposal for rejected, timed-out, stale, or otherwise unused outcomes. */
	release(): Promise<void>;
}

export interface Externalized<T = unknown> {
	readonly value: T;
	readonly lease: PiPayloadLease;
}

export type ExternalizedPiPayload<T = unknown> = Externalized<T>;

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

type ExactContent = {
	ref: SessionAttachmentRefDto;
	hold: EpochContentHold;
};

type FrameState = {
	options: PiPayloadExternalizerOptions;
	maxDecodedImageBytes: number;
	byInlineIdentity: Map<string, Map<string, SessionAttachmentRefDto>>;
	byDigest: Map<string, ExactContent>;
	holds: EpochContentHold[];
};

export async function externalizePiPayload<T = unknown>(
	input: PiPayloadExternalizerInput,
	options: PiPayloadExternalizerOptions,
): Promise<ExternalizedPiPayload<T>> {
	assertOptions(options);
	assertRawInput(input);
	const state: FrameState = {
		options,
		maxDecodedImageBytes: options.maxDecodedImageBytes ?? options.payloadBudget.maxAttachmentBlobBytes,
		byInlineIdentity: new Map(),
		byDigest: new Map(),
		holds: [],
	};
	try {
		throwIfAborted(options.signal);
		const value = await externalizeFrame(input, state);
		throwIfAborted(options.signal);
		const context = { serverEpoch: options.serverEpoch, payloadBudget: options.payloadBudget };
		const productValid =
			input.kind === "event"
				? isProductSessionEventDto(value, context)
				: isSessionCommandResponseDto(value, context);
		const valid = productValid && (!options.productGuard || options.productGuard(value, context, input));
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

function assertOptions(options: PiPayloadExternalizerOptions): void {
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
}

function assertRawInput(input: PiPayloadExternalizerInput): void {
	const valid =
		input.kind === "event"
			? isLegacyRpcV1RawEvent(input.value)
			: isLegacyRpcV1RawResponse(input.value, input.expectedCommand);
	if (!valid) {
		throw new PiPayloadExternalizationError("invalid_raw_payload", "Pi payload failed raw provenance guards");
	}
}

async function externalizeFrame(input: PiPayloadExternalizerInput, state: FrameState): Promise<unknown> {
	const value = input.value as UnknownRecord;
	if (input.kind === "response") return externalizeResponse(value, state);
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

function createLease(
	store: PiPayloadExternalizerContentStore,
	holds: readonly EpochContentHold[],
): PiPayloadLease {
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

function createTransfer(
	store: PiPayloadExternalizerContentStore,
	holds: readonly EpochContentHold[],
	refs: readonly SessionAttachmentRefDto[],
): PiPayloadLeaseTransfer {
	let state: "pending" | "adopting" | "adopted" | "releasing" | "released" = "pending";
	let releasePromise: Promise<void> | undefined;
	return Object.freeze({
		refs,
		adopt(accept: (holds: readonly EpochContentHold[]) => true) {
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
	holds: readonly EpochContentHold[],
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

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw new PiPayloadExternalizationError("aborted", "Pi payload externalization was aborted");
}

function normalizeExternalizationError(error: unknown): unknown {
	if (error instanceof RasterAdmissionError) return error;
	if (error instanceof PiPayloadExternalizationError || error instanceof EpochContentStoreError) return error;
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
