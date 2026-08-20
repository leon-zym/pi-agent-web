export const MAX_REST_JSON_BODY_BYTES = 64 * 1024;
export const MAX_AUTH_PROVIDER_ID_LENGTH = 256;
export const MAX_AUTH_API_KEY_LENGTH = 16 * 1024;
export const MAX_WORKSPACE_PATH_LENGTH = 8192;

type RequestInputStatus = 400 | 413 | 422;

/** Stable, non-reflective client error for bounded REST request parsing. */
export class RequestInputError extends Error {
	constructor(
		readonly status: RequestInputStatus,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RequestInputError";
	}
}

function bodyTooLarge(maxBytes: number): RequestInputError {
	return new RequestInputError(
		413,
		"request_body_too_large",
		`request body exceeds ${String(maxBytes)} bytes`,
	);
}

function invalidFieldCode(field: string): string {
	return `invalid_${field.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`;
}

function assertBoundedContentLength(request: Request, maxBytes: number): void {
	const raw = request.headers.get("content-length");
	if (raw === null) return;
	const normalized = raw.trim();
	if (!/^\d+$/.test(normalized)) {
		throw new RequestInputError(
			400,
			"invalid_content_length",
			"Content-Length must be a non-negative integer",
		);
	}
	const declared = Number(normalized);
	if (!Number.isSafeInteger(declared) || declared > maxBytes) throw bodyTooLarge(maxBytes);
}

async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel("request body limit exceeded").catch(() => undefined);
				throw bodyTooLarge(maxBytes);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

/** Parse exactly one bounded JSON object without buffering an unbounded request first. */
export async function readBoundedJsonObject(
	request: Request,
	maxBytes = MAX_REST_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
	assertBoundedContentLength(request, maxBytes);
	let text: string;
	try {
		const bytes = await readBoundedBytes(request, maxBytes);
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		if (error instanceof RequestInputError) throw error;
		throw new RequestInputError(400, "invalid_json", "request body must be valid UTF-8 JSON");
	}

	try {
		const value = JSON.parse(text) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("request body must be a JSON object");
		}
		return value as Record<string, unknown>;
	} catch {
		throw new RequestInputError(400, "invalid_json", "request body must be a JSON object");
	}
}

export function requiredBoundedStringField(
	body: Record<string, unknown>,
	field: string,
	maxLength: number,
): string {
	const value = body[field];
	if (typeof value !== "string" || !value.trim()) {
		throw new RequestInputError(400, invalidFieldCode(field), `body.${field} is required`);
	}
	const trimmed = value.trim();
	if (trimmed.length > maxLength) {
		throw new RequestInputError(
			422,
			invalidFieldCode(field),
			`body.${field} must be at most ${String(maxLength)} characters`,
		);
	}
	return trimmed;
}

export function optionalBoundedStringField(
	body: Record<string, unknown>,
	field: string,
	maxLength: number,
): string | undefined {
	const value = body[field];
	if (typeof value !== "string" || !value.trim()) return undefined;
	const trimmed = value.trim();
	if (trimmed.length > maxLength) {
		throw new RequestInputError(
			422,
			invalidFieldCode(field),
			`body.${field} must be at most ${String(maxLength)} characters`,
		);
	}
	return trimmed;
}
