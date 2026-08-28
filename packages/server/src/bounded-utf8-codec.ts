import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const MIB = 1024 * 1024;
const DEFAULT_MAX_BYTES = 48 * MIB;
const MAX_CHUNK_BYTES = 64 * 1024;
const RAW_TOKEN_CODE_UNITS = Math.floor(MAX_CHUNK_BYTES / 4);
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ITEMS = 50_000;
const MAX_JSON_CONTAINER_ITEMS = 10_000;
const MAX_JSON_STRING_BYTES = 48 * MIB;

export type BoundedUtf8CodecErrorCode =
	| "aborted"
	| "byte_limit_exceeded"
	| "invalid_input"
	| "invalid_json"
	| "invalid_options"
	| "json_depth_exceeded"
	| "json_items_exceeded"
	| "json_string_limit_exceeded";

export class BoundedUtf8CodecError extends Error {
	readonly code: BoundedUtf8CodecErrorCode;
	readonly limit?: number;
	readonly actual?: number;

	constructor(
		code: BoundedUtf8CodecErrorCode,
		message: string,
		details: { limit?: number; actual?: number } = {},
	) {
		super(message);
		this.name = "BoundedUtf8CodecError";
		this.code = code;
		this.limit = details.limit;
		this.actual = details.actual;
	}
}

export type BoundedUtf8EncodingInput = { kind: "text"; value: string } | { kind: "json"; value: unknown };

export interface PrepareBoundedUtf8EncodingOptions {
	maxBytes?: number;
	signal?: AbortSignal;
}

export interface CreateBoundedUtf8ReadableOptions {
	signal?: AbortSignal;
}

export interface PreparedBoundedUtf8Encoding {
	readonly kind: BoundedUtf8EncodingInput["kind"];
	readonly byteLength: number;
	readonly sha256: string;
	createReadable(options?: CreateBoundedUtf8ReadableOptions): Readable;
}

type JsonTraversalState = {
	active: Set<object>;
	items: number;
	stringBytes: number;
	signal?: AbortSignal;
};

function fail(
	code: BoundedUtf8CodecErrorCode,
	message: string,
	details?: { limit?: number; actual?: number },
): never {
	throw new BoundedUtf8CodecError(code, message, details);
}

function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) fail("aborted", "UTF-8 encoding was aborted");
}

function normalizeError(error: unknown): BoundedUtf8CodecError {
	return error instanceof BoundedUtf8CodecError
		? error
		: new BoundedUtf8CodecError("invalid_json", "Value is not a safe JSON data-model root");
}

function codePointUtf8Bytes(value: string, index: number): { bytes: number; nextIndex: number } {
	const codeUnit = value.charCodeAt(index);
	if (codeUnit <= 0x7f) return { bytes: 1, nextIndex: index };
	if (codeUnit <= 0x7ff) return { bytes: 2, nextIndex: index };
	if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
		const next = value.charCodeAt(index + 1);
		if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, nextIndex: index + 1 };
	}
	return { bytes: 3, nextIndex: index };
}

/** Yield bounded source slices while keeping a valid UTF-16 surrogate pair in the same slice. */
function* rawUtf8Tokens(
	value: string,
	signal?: AbortSignal,
	startIndex = 0,
	endIndex = value.length,
): Generator<string> {
	let start = startIndex;
	let tokenBytes = 0;
	for (let index = startIndex; index < endIndex; index += 1) {
		assertNotAborted(signal);
		const encoded = codePointUtf8Bytes(value, index);
		if (
			tokenBytes > 0 &&
			(tokenBytes + encoded.bytes > MAX_CHUNK_BYTES || index - start >= RAW_TOKEN_CODE_UNITS)
		) {
			yield value.slice(start, index);
			start = index;
			tokenBytes = 0;
		}
		tokenBytes += encoded.bytes;
		index = Math.min(encoded.nextIndex, endIndex - 1);
	}
	if (start < endIndex) yield value.slice(start, endIndex);
}

function addJsonStringBytes(state: JsonTraversalState, bytes: number): void {
	state.stringBytes += bytes;
	if (state.stringBytes > MAX_JSON_STRING_BYTES) {
		fail("json_string_limit_exceeded", "JSON strings exceed the UTF-8 byte ceiling", {
			limit: MAX_JSON_STRING_BYTES,
			actual: state.stringBytes,
		});
	}
}

function shortEscape(codeUnit: number): string | undefined {
	switch (codeUnit) {
		case 0x08:
			return "\\b";
		case 0x09:
			return "\\t";
		case 0x0a:
			return "\\n";
		case 0x0c:
			return "\\f";
		case 0x0d:
			return "\\r";
		default:
			return undefined;
	}
}

function unicodeEscape(codeUnit: number): string {
	return `\\u${codeUnit.toString(16).padStart(4, "0")}`;
}

function* jsonStringTokens(
	value: string,
	state: JsonTraversalState,
	countTowardStringLimit: boolean,
): Generator<string> {
	yield '"';
	let runStart = 0;
	let runBytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		assertNotAborted(state.signal);
		const codeUnit = value.charCodeAt(index);
		const encoded = codePointUtf8Bytes(value, index);
		if (countTowardStringLimit) addJsonStringBytes(state, encoded.bytes);
		let escapedToken: string | undefined;
		if (codeUnit === 0x22) escapedToken = '\\"';
		else if (codeUnit === 0x5c) escapedToken = "\\\\";
		else if (codeUnit <= 0x1f) escapedToken = shortEscape(codeUnit) ?? unicodeEscape(codeUnit);
		else if (codeUnit >= 0xd800 && codeUnit <= 0xdfff && encoded.nextIndex === index) {
			escapedToken = unicodeEscape(codeUnit);
		}
		if (escapedToken !== undefined) {
			if (runStart < index) yield value.slice(runStart, index);
			yield escapedToken;
			runStart = index + 1;
			runBytes = 0;
		} else {
			if (
				runBytes > 0 &&
				(runBytes + encoded.bytes > MAX_CHUNK_BYTES || index - runStart >= RAW_TOKEN_CODE_UNITS)
			) {
				yield value.slice(runStart, index);
				runStart = index;
				runBytes = 0;
			}
			runBytes += encoded.bytes;
			if (encoded.nextIndex !== index) index = encoded.nextIndex;
		}
	}
	if (runStart < value.length) yield value.slice(runStart);
	yield '"';
}

function enterJsonValue(state: JsonTraversalState, depth: number): void {
	assertNotAborted(state.signal);
	if (depth > MAX_JSON_DEPTH) {
		fail("json_depth_exceeded", "JSON exceeds the nesting depth ceiling", {
			limit: MAX_JSON_DEPTH,
			actual: depth,
		});
	}
	state.items += 1;
	if (state.items > MAX_JSON_ITEMS) {
		fail("json_items_exceeded", "JSON exceeds the item ceiling", {
			limit: MAX_JSON_ITEMS,
			actual: state.items,
		});
	}
}

function ownDataDescriptor(object: object, key: PropertyKey): PropertyDescriptor {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
		fail("invalid_json", "JSON objects and arrays may contain only enumerable data properties");
	}
	return descriptor;
}

function assertPlainArray(value: unknown[]): void {
	if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_JSON_CONTAINER_ITEMS) {
		fail("invalid_json", "JSON arrays must be plain, dense, and within the item ceiling");
	}
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== value.length + 1 || ownKeys[ownKeys.length - 1] !== "length") {
		fail("invalid_json", "JSON arrays must be plain and dense");
	}
	for (let index = 0; index < value.length; index += 1) {
		if (ownKeys[index] !== String(index)) fail("invalid_json", "JSON arrays must be plain and dense");
	}
}

function plainObjectKeys(value: object): string[] {
	if (Object.getPrototypeOf(value) !== Object.prototype) {
		fail("invalid_json", "JSON objects must have the ordinary Object prototype");
	}
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length > MAX_JSON_CONTAINER_ITEMS || ownKeys.some((key) => typeof key !== "string")) {
		fail("invalid_json", "JSON objects may contain only enumerable string-keyed properties");
	}
	return ownKeys as string[];
}

function* jsonValueTokens(value: unknown, state: JsonTraversalState, depth: number): Generator<string> {
	enterJsonValue(state, depth);
	if (value === null) {
		yield "null";
		return;
	}
	if (typeof value === "boolean") {
		yield value ? "true" : "false";
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
			fail("invalid_json", "JSON numbers must be finite and within the safe numeric range");
		}
		yield Object.is(value, -0) ? "0" : String(value);
		return;
	}
	if (typeof value === "string") {
		yield* jsonStringTokens(value, state, true);
		return;
	}
	if (typeof value !== "object") fail("invalid_json", "JSON contains an unsupported value type");
	if (state.active.has(value)) fail("invalid_json", "JSON must not contain a cycle");
	state.active.add(value);
	try {
		if (Array.isArray(value)) {
			assertPlainArray(value);
			yield "[";
			for (let index = 0; index < value.length; index += 1) {
				if (index > 0) yield ",";
				const descriptor = ownDataDescriptor(value, String(index));
				yield* jsonValueTokens(descriptor.value, state, depth + 1);
			}
			yield "]";
			return;
		}
		const keys = plainObjectKeys(value);
		yield "{";
		for (let index = 0; index < keys.length; index += 1) {
			if (index > 0) yield ",";
			const key = keys[index] as string;
			yield* jsonStringTokens(key, state, false);
			yield ":";
			const descriptor = ownDataDescriptor(value, key);
			yield* jsonValueTokens(descriptor.value, state, depth + 1);
		}
		yield "}";
	} finally {
		state.active.delete(value);
	}
}

function inputTokens(input: BoundedUtf8EncodingInput, signal?: AbortSignal): Generator<string> {
	assertNotAborted(signal);
	if (input.kind === "text") return rawUtf8Tokens(input.value, signal);
	return jsonValueTokens(input.value, { active: new Set<object>(), items: 0, stringBytes: 0, signal }, 0);
}

function normalizedInput(input: BoundedUtf8EncodingInput): BoundedUtf8EncodingInput {
	if (typeof input !== "object" || input === null) {
		fail("invalid_input", "UTF-8 encoding input must be a typed root");
	}
	if (input.kind === "text" && typeof input.value === "string") {
		return Object.freeze({ kind: "text", value: input.value });
	}
	if (input.kind === "json" && Object.hasOwn(input, "value")) {
		return Object.freeze({ kind: "json", value: input.value });
	}
	fail("invalid_input", "UTF-8 encoding input has the wrong typed root shape");
}

async function immediate(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function* encodedChunks(
	input: BoundedUtf8EncodingInput,
	maxBytes: number,
	signal?: AbortSignal,
): AsyncGenerator<Buffer> {
	let chunk = Buffer.allocUnsafe(MAX_CHUNK_BYTES);
	let chunkBytes = 0;
	let totalBytes = 0;
	try {
		for (const token of inputTokens(input, signal)) {
			assertNotAborted(signal);
			const encoded = Buffer.from(token, "utf8");
			const actual = totalBytes + encoded.byteLength;
			if (actual > maxBytes) {
				fail("byte_limit_exceeded", "Encoded UTF-8 exceeds the byte ceiling", {
					limit: maxBytes,
					actual,
				});
			}
			totalBytes = actual;
			if (chunkBytes > 0 && chunkBytes + encoded.byteLength > MAX_CHUNK_BYTES) {
				yield chunk.subarray(0, chunkBytes);
				await immediate();
				assertNotAborted(signal);
				chunk = Buffer.allocUnsafe(MAX_CHUNK_BYTES);
				chunkBytes = 0;
			}
			encoded.copy(chunk, chunkBytes);
			chunkBytes += encoded.byteLength;
		}
		if (chunkBytes > 0) yield chunk.subarray(0, chunkBytes);
	} catch (error) {
		throw normalizeError(error);
	}
}

function validatedMaxBytes(value: number | undefined): number {
	const maxBytes = value ?? DEFAULT_MAX_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_BYTES) {
		fail("invalid_options", "maxBytes must be a positive integer within the generic content ceiling", {
			limit: DEFAULT_MAX_BYTES,
			actual: maxBytes,
		});
	}
	return maxBytes;
}

export async function prepareBoundedUtf8Encoding(
	input: BoundedUtf8EncodingInput,
	options: PrepareBoundedUtf8EncodingOptions = {},
): Promise<PreparedBoundedUtf8Encoding> {
	const source = normalizedInput(input);
	const maxBytes = validatedMaxBytes(options.maxBytes);
	assertNotAborted(options.signal);
	const hash = createHash("sha256");
	let byteLength = 0;
	for await (const chunk of encodedChunks(source, maxBytes, options.signal)) {
		hash.update(chunk);
		byteLength += chunk.byteLength;
	}
	const sha256 = hash.digest("hex");
	return Object.freeze({
		kind: source.kind,
		byteLength,
		sha256,
		createReadable(readOptions: CreateBoundedUtf8ReadableOptions = {}): Readable {
			return Readable.from(encodedChunks(source, maxBytes, readOptions.signal));
		},
	});
}
