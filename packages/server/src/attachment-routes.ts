import { createHash } from "node:crypto";
import { addAbortSignal, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
	SESSION_ATTACHMENT_BLOB_MAX_BYTES,
	type SessionPayloadAdmissionErrorDto,
} from "@pi-agent-web/protocol";
import { Hono } from "hono";
import {
	type EpochContentHold,
	type EpochContentPin,
	type EpochContentPutInput,
	EpochContentStoreError,
	type PinnedEpochContent,
	type StagedEpochContent,
} from "./epoch-content-store.js";

const DIGEST_RE = /^[0-9a-f]{64}$/;

// Gateway admission authenticates the allowlisted container type and rejects gross truncation.
// Codec decodability remains the responsibility of browser preprocessing and the Pi/provider path.
type RasterRule = {
	extension: "gif" | "jpg" | "png" | "webp";
	minimumBytes: number;
	prefixBytes: number;
	matches: (prefix: Uint8Array, byteLength: number) => boolean;
	validator: (prefix: Uint8Array, byteLength: number) => RasterValidator;
};

interface RasterValidator {
	push(chunk: Uint8Array): void;
	finish(): void;
}

const RASTER_RULES = new Map<string, RasterRule>([
	[
		"image/png",
		{
			extension: "png",
			minimumBytes: 24,
			prefixBytes: 24,
			matches: (prefix, byteLength) => {
				const buffer = Buffer.from(prefix);
				return (
					byteLength >= 33 &&
					buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
					buffer.readUInt32BE(8) === 13 &&
					buffer.subarray(12, 16).toString("ascii") === "IHDR" &&
					buffer.readUInt32BE(16) > 0 &&
					buffer.readUInt32BE(20) > 0
				);
			},
			validator: () => tailValidator(Buffer.from("0000000049454e44", "hex"), 12),
		},
	],
	[
		"image/jpeg",
		{
			extension: "jpg",
			minimumBytes: 6,
			prefixBytes: 4,
			matches: matchesJpegPrefix,
			validator: () => tailValidator(Buffer.from([0xff, 0xd9]), 2),
		},
	],
	[
		"image/webp",
		{
			extension: "webp",
			minimumBytes: 20,
			prefixBytes: 20,
			matches: (prefix, byteLength) => {
				const buffer = Buffer.from(prefix);
				const chunkType = buffer.subarray(12, 16).toString("ascii");
				return (
					byteLength >= 20 &&
					buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
					buffer.subarray(8, 12).toString("ascii") === "WEBP" &&
					(chunkType === "VP8 " || chunkType === "VP8L" || chunkType === "VP8X")
				);
			},
			validator: (prefix, byteLength) => new WebpContainerValidator(prefix, byteLength),
		},
	],
	[
		"image/gif",
		{
			extension: "gif",
			minimumBytes: 13,
			prefixBytes: 13,
			matches: (prefix) => {
				const buffer = Buffer.from(prefix);
				const signature = buffer.subarray(0, 6).toString("ascii");
				return (
					(signature === "GIF87a" || signature === "GIF89a") &&
					buffer.readUInt16LE(6) > 0 &&
					buffer.readUInt16LE(8) > 0
				);
			},
			validator: () => tailValidator(Buffer.from([0x3b]), 1),
		},
	],
]);

function invalidRasterStructure(): never {
	throw new AttachmentRouteError(422, "invalid_raster_structure", "Attachment raster structure is invalid");
}

class WebpContainerValidator implements RasterValidator {
	#offset = 0;
	#chunkHeader = Buffer.alloc(8);
	#chunkHeaderOffset = 0;
	#chunkRemaining = 0;
	#chunkNeedsPadding = false;
	#paddingPending = false;
	readonly #byteLength: number;
	readonly #declaredRiffSize: number;

	constructor(prefix: Uint8Array, byteLength: number) {
		this.#byteLength = byteLength;
		this.#declaredRiffSize = Buffer.from(prefix).readUInt32LE(4);
	}

	push(chunk: Uint8Array): void {
		for (const byte of chunk) {
			const position = this.#offset++;
			if (position < 12) continue;
			if (this.#paddingPending) {
				this.#paddingPending = false;
				continue;
			}
			if (this.#chunkRemaining > 0) {
				this.#chunkRemaining--;
				if (this.#chunkRemaining === 0) this.#paddingPending = this.#chunkNeedsPadding;
				continue;
			}
			this.#chunkHeader[this.#chunkHeaderOffset++] = byte;
			if (this.#chunkHeaderOffset !== this.#chunkHeader.byteLength) continue;
			this.#chunkHeaderOffset = 0;
			const chunkSize = this.#chunkHeader.readUInt32LE(4);
			const paddedSize = chunkSize + (chunkSize & 1);
			if (paddedSize > this.#byteLength - this.#offset) invalidRasterStructure();
			this.#chunkRemaining = chunkSize;
			this.#chunkNeedsPadding = (chunkSize & 1) !== 0;
		}
	}

	finish(): void {
		if (
			this.#declaredRiffSize !== this.#byteLength - 8 ||
			this.#offset !== this.#byteLength ||
			this.#chunkHeaderOffset !== 0 ||
			this.#chunkRemaining !== 0 ||
			this.#paddingPending
		) {
			invalidRasterStructure();
		}
	}
}

function matchesJpegPrefix(prefix: Uint8Array, byteLength: number): boolean {
	return (
		byteLength >= 6 &&
		prefix[0] === 0xff &&
		prefix[1] === 0xd8 &&
		prefix[2] === 0xff &&
		prefix[3] !== 0x00 &&
		prefix[3] !== 0xd8 &&
		prefix[3] !== 0xd9
	);
}

function tailValidator(expectedPrefix: Buffer, tailBytes: number): RasterValidator {
	const tail = Buffer.alloc(tailBytes);
	let seen = 0;
	return {
		push(chunk) {
			const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			if (buffer.byteLength >= tailBytes) {
				tail.set(buffer.subarray(buffer.byteLength - tailBytes));
			} else {
				const filled = Math.min(seen, tailBytes);
				const retained = Math.min(filled, tailBytes - buffer.byteLength);
				if (retained > 0) tail.copyWithin(0, filled - retained, filled);
				tail.set(buffer, retained);
			}
			seen += buffer.byteLength;
		},
		finish() {
			if (seen < tailBytes || !tail.subarray(0, expectedPrefix.byteLength).equals(expectedPrefix)) {
				invalidRasterStructure();
			}
		},
	};
}

export interface AttachmentContentStore {
	stage(input: EpochContentPutInput): Promise<StagedEpochContent>;
	publish(hold: EpochContentHold): Promise<void>;
	pinByDigest(digest: string, options?: { signal?: AbortSignal }): Promise<PinnedEpochContent>;
	release(handle: EpochContentHold | EpochContentPin): Promise<void>;
}

export interface AttachmentRoutesContext {
	contentStore: AttachmentContentStore;
	serverEpoch: string;
	maxBlobBytes?: number;
}

type AttachmentErrorStatus = 400 | 404 | 405 | 410 | 411 | 413 | 415 | 416 | 422 | 500 | 503 | 507;

class AttachmentRouteError extends Error {
	constructor(
		readonly status: AttachmentErrorStatus,
		readonly code: string,
		message: string,
		readonly admissionError?: SessionPayloadAdmissionErrorDto,
	) {
		super(message);
		this.name = "AttachmentRouteError";
	}
}

export function createAttachmentRoutes(ctx: AttachmentRoutesContext): Hono {
	const app = new Hono();
	const maxBlobBytes = ctx.maxBlobBytes ?? SESSION_ATTACHMENT_BLOB_MAX_BYTES;
	if (
		!Number.isSafeInteger(maxBlobBytes) ||
		maxBlobBytes <= 0 ||
		maxBlobBytes > SESSION_ATTACHMENT_BLOB_MAX_BYTES
	) {
		throw new Error("attachment route blob limit is invalid");
	}

	app.put("/attachments/:serverEpoch/:sha256", async (c) => {
		let source: Readable | undefined;
		let rasterValidationFailure: (() => AttachmentRouteError | undefined) | undefined;
		let existing: PinnedEpochContent | undefined;
		let staged: StagedEpochContent | undefined;
		let response: Response | undefined;
		let failure: unknown;
		let failed = false;
		try {
			const sha256 = validatedPath(c.req.param("serverEpoch"), c.req.param("sha256"), ctx.serverEpoch);
			const byteLength = requiredContentLength(c.req.raw, maxBlobBytes);
			assertIdentityEncoding(c.req.raw);
			const mediaType = requiredRasterMediaType(c.req.raw);
			existing = await pinExistingContent(ctx.contentStore, sha256, c.req.raw.signal);
			if (existing) assertRepeatMetadata(existing, ctx.serverEpoch, sha256, mediaType, byteLength);
			const validated = await validatedRasterSource(
				c.req.raw,
				RASTER_RULES.get(mediaType)!,
				byteLength,
				sha256,
			);
			source = validated.source;
			rasterValidationFailure = validated.failure;
			if (existing) {
				await validateRepeatBody(source, sha256, byteLength, c.req.raw.signal);
				response = Response.json(
					{ attachment: existing.ref },
					{ status: 200, headers: { "Cache-Control": "no-store" } },
				);
			} else {
				staged = await ctx.contentStore.stage({
					source,
					mediaType,
					expectedSha256: sha256,
					expectedByteLength: byteLength,
					signal: c.req.raw.signal,
				});
				await ctx.contentStore.publish(staged.hold);
				response = Response.json(
					{ attachment: staged.ref },
					{ status: staged.created ? 201 : 200, headers: { "Cache-Control": "no-store" } },
				);
			}
		} catch (error) {
			failure = error instanceof AttachmentRouteError ? error : (rasterValidationFailure?.() ?? error);
			failed = true;
		} finally {
			if (existing) {
				try {
					await ctx.contentStore.release(existing.pin);
				} catch (error) {
					if (!failed) failure = error;
					failed = true;
				}
			}
			if (staged) {
				try {
					await ctx.contentStore.release(staged.hold);
				} catch (error) {
					if (!failed) failure = error;
					failed = true;
				}
			}
			if (source && !source.destroyed) source.destroy();
			if (source) await finished(source).catch(() => undefined);
		}
		return failed ? attachmentErrorResponse(failure) : response!;
	});

	app.on(["GET", "HEAD"], "/attachments/:serverEpoch/:sha256", async (c) => {
		try {
			const sha256 = validatedPath(c.req.param("serverEpoch"), c.req.param("sha256"), ctx.serverEpoch);
			if (c.req.method === "HEAD") {
				return attachmentErrorResponse(
					new AttachmentRouteError(405, "method_not_allowed", "HEAD is not supported for attachments"),
					{ Allow: "GET, PUT" },
				);
			}
			if (c.req.raw.headers.get("range") !== null) {
				throw new AttachmentRouteError(416, "range_not_supported", "Attachment ranges are not supported");
			}
			const pinned = await ctx.contentStore.pinByDigest(sha256, { signal: c.req.raw.signal });
			const rule = RASTER_RULES.get(pinned.ref.mediaType);
			if (!rule || pinned.ref.serverEpoch !== ctx.serverEpoch || pinned.ref.byteLength > maxBlobBytes) {
				await ctx.contentStore.release(pinned.pin).catch(() => undefined);
				throw new AttachmentRouteError(
					422,
					"invalid_attachment_ref",
					"Stored attachment metadata is invalid",
				);
			}
			return new Response(managedDownloadBody(pinned, ctx.contentStore), {
				status: 200,
				headers: {
					"Cache-Control": "no-store",
					"Content-Disposition": `attachment; filename="${pinned.ref.sha256}.${rule.extension}"`,
					"Content-Length": String(pinned.ref.byteLength),
					"Content-Type": pinned.ref.mediaType,
					"Cross-Origin-Resource-Policy": "same-origin",
					"X-Content-Type-Options": "nosniff",
				},
			});
		} catch (error) {
			return attachmentErrorResponse(error);
		}
	});

	return app;
}

function validatedPath(requestedEpoch: string, digest: string, currentEpoch: string): string {
	if (requestedEpoch !== currentEpoch) {
		throw new AttachmentRouteError(410, "attachment_epoch_gone", "Attachment epoch is no longer available", {
			type: "payload_admission_error",
			code: "attachment_ref_epoch_mismatch",
			boundary: "attachment_ref",
		});
	}
	if (!DIGEST_RE.test(digest)) {
		throw new AttachmentRouteError(400, "invalid_attachment_digest", "Attachment digest is invalid", {
			type: "payload_admission_error",
			code: "attachment_ref_invalid",
			boundary: "attachment_ref",
		});
	}
	return digest;
}

function requiredContentLength(request: Request, maxBlobBytes: number): number {
	const raw = request.headers.get("content-length");
	if (raw === null) {
		throw new AttachmentRouteError(411, "content_length_required", "Content-Length is required");
	}
	const normalized = raw.trim();
	if (!/^[0-9]+$/.test(normalized)) {
		throw new AttachmentRouteError(
			400,
			"invalid_content_length",
			"Content-Length must be a positive integer",
		);
	}
	const declared = Number(normalized);
	if (!Number.isSafeInteger(declared) || declared <= 0) {
		throw new AttachmentRouteError(
			400,
			"invalid_content_length",
			"Content-Length must be a positive integer",
		);
	}
	if (declared > maxBlobBytes) {
		throw new AttachmentRouteError(413, "blob_too_large", "Attachment exceeds the upload limit", {
			type: "payload_admission_error",
			code: "payload_too_large",
			boundary: "attachment_blob",
			limitBytes: maxBlobBytes,
			actualBytes: declared,
		});
	}
	return declared;
}

function assertIdentityEncoding(request: Request): void {
	const encoding = request.headers.get("content-encoding");
	if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
		throw new AttachmentRouteError(
			415,
			"unsupported_content_encoding",
			"Compressed attachment uploads are not supported",
		);
	}
}

function requiredRasterMediaType(request: Request): string {
	const mediaType = request.headers.get("content-type")?.trim().toLowerCase();
	if (!mediaType || !RASTER_RULES.has(mediaType)) {
		throw new AttachmentRouteError(415, "unsupported_media_type", "Attachment media type is not supported");
	}
	return mediaType;
}

async function validatedRasterSource(
	request: Request,
	rule: RasterRule,
	byteLength: number,
	expectedSha256: string,
): Promise<{ source: Readable; failure: () => AttachmentRouteError | undefined }> {
	if (!request.body || byteLength < rule.minimumBytes) {
		throw new AttachmentRouteError(422, "truncated_raster_header", "Attachment raster header is truncated");
	}
	const body = request.body;
	const prefix = Buffer.alloc(Math.min(rule.prefixBytes, byteLength));
	let prefixOffset = 0;
	let exhausted = false;
	let validationFailure: AttachmentRouteError | undefined;
	let grossFailure: AttachmentRouteError | undefined;
	let validator: RasterValidator | undefined;
	let streamedBytes = 0;
	const hash = createHash("sha256");
	async function* validateAndStream(): AsyncGenerator<Uint8Array> {
		const reader = body.getReader();
		const cancelReader = (): void => {
			void reader.cancel(request.signal.reason).catch(() => undefined);
		};
		request.signal.addEventListener("abort", cancelReader, { once: true });
		if (request.signal.aborted) cancelReader();
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) {
					exhausted = true;
					request.signal.throwIfAborted();
					if (streamedBytes !== byteLength) {
						throw new AttachmentRouteError(
							422,
							"declared_length_mismatch",
							"Attachment does not match its declared length",
						);
					}
					if (hash.digest("hex") !== expectedSha256) {
						throw new AttachmentRouteError(
							422,
							"declared_digest_mismatch",
							"Attachment does not match its declared digest",
						);
					}
					if (grossFailure) throw grossFailure;
					if (!validator) {
						throw new AttachmentRouteError(
							422,
							"truncated_raster_header",
							"Attachment raster header is truncated",
						);
					}
					validator.finish();
					return;
				}
				if (next.value.byteLength > 0) {
					streamedBytes += next.value.byteLength;
					if (streamedBytes > byteLength) {
						throw new AttachmentRouteError(
							422,
							"declared_length_mismatch",
							"Attachment does not match its declared length",
						);
					}
					hash.update(next.value);
					let remainderOffset = 0;
					if (!validator && !grossFailure) {
						const copied = Math.min(next.value.byteLength, prefix.byteLength - prefixOffset);
						prefix.set(next.value.subarray(0, copied), prefixOffset);
						prefixOffset += copied;
						remainderOffset = copied;
						if (prefixOffset === prefix.byteLength) {
							if (!rule.matches(prefix, byteLength)) {
								grossFailure = new AttachmentRouteError(
									422,
									"invalid_raster_magic",
									"Attachment bytes do not match the media type",
								);
							} else {
								validator = rule.validator(prefix, byteLength);
								try {
									validator.push(prefix);
								} catch (error) {
									if (!(error instanceof AttachmentRouteError)) throw error;
									grossFailure = error;
									validator = undefined;
								}
							}
						}
					}
					if (validator && remainderOffset < next.value.byteLength) {
						try {
							validator.push(next.value.subarray(remainderOffset));
						} catch (error) {
							if (!(error instanceof AttachmentRouteError)) throw error;
							grossFailure = error;
							validator = undefined;
						}
					}
					yield next.value;
				}
			}
		} catch (error) {
			if (error instanceof AttachmentRouteError) validationFailure = error;
			throw error;
		} finally {
			request.signal.removeEventListener("abort", cancelReader);
			if (!exhausted) await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	}

	return { source: Readable.from(validateAndStream()), failure: () => validationFailure };
}

async function pinExistingContent(
	store: AttachmentContentStore,
	digest: string,
	signal: AbortSignal,
): Promise<PinnedEpochContent | undefined> {
	try {
		return await store.pinByDigest(digest, { signal });
	} catch (error) {
		if (
			error instanceof EpochContentStoreError &&
			(error.code === "not_found" || error.code === "not_published")
		) {
			return undefined;
		}
		throw error;
	}
}

function assertRepeatMetadata(
	pinned: PinnedEpochContent,
	serverEpoch: string,
	sha256: string,
	mediaType: string,
	byteLength: number,
): void {
	if (
		pinned.ref.serverEpoch !== serverEpoch ||
		pinned.ref.sha256 !== sha256 ||
		pinned.ref.mediaType !== mediaType ||
		pinned.ref.byteLength !== byteLength
	) {
		throw new AttachmentRouteError(
			422,
			"manifest_mismatch",
			"Existing attachment metadata differs from the upload",
		);
	}
}

async function validateRepeatBody(
	source: Readable,
	expectedSha256: string,
	expectedByteLength: number,
	signal: AbortSignal,
): Promise<void> {
	const hash = createHash("sha256");
	let byteLength = 0;
	signal.throwIfAborted();
	for await (const chunk of addAbortSignal(signal, source)) {
		signal.throwIfAborted();
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		byteLength += buffer.byteLength;
		if (byteLength > expectedByteLength) {
			throw new AttachmentRouteError(
				422,
				"declared_length_mismatch",
				"Attachment does not match its declared length",
			);
		}
		hash.update(buffer);
	}
	if (byteLength !== expectedByteLength) {
		throw new AttachmentRouteError(
			422,
			"declared_length_mismatch",
			"Attachment does not match its declared length",
		);
	}
	if (hash.digest("hex") !== expectedSha256) {
		throw new AttachmentRouteError(
			422,
			"declared_digest_mismatch",
			"Attachment does not match its declared digest",
		);
	}
}

function managedDownloadBody(
	pinned: PinnedEpochContent,
	store: AttachmentContentStore,
): ReadableStream<Uint8Array> {
	const reader = Readable.toWeb(pinned.stream).getReader();
	let settled = false;
	let releasePromise: Promise<void> | undefined;
	const releaseOnce = (): Promise<void> => {
		releasePromise ??= store.release(pinned.pin);
		return releasePromise;
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (settled) return;
			try {
				const next = await reader.read();
				if (!next.done) {
					controller.enqueue(next.value);
					return;
				}
				settled = true;
				await releaseOnce();
				controller.close();
			} catch {
				settled = true;
				await releaseOnce().catch(() => undefined);
				controller.error(new Error("Attachment stream failed"));
			}
		},
		async cancel(reason) {
			if (!settled) {
				settled = true;
				await reader.cancel(reason).catch(() => undefined);
			}
			await releaseOnce();
		},
	});
}

function attachmentErrorResponse(error: unknown, headers?: Record<string, string>): Response {
	const mapped = mappedAttachmentError(error);
	const responseHeaders = { "Cache-Control": "no-store", ...headers };
	if (mapped.admissionError) {
		return Response.json(mapped.admissionError, { status: mapped.status, headers: responseHeaders });
	}
	return Response.json(
		{ error: { code: mapped.code, message: mapped.message } },
		{ status: mapped.status, headers: responseHeaders },
	);
}

function mappedAttachmentError(error: unknown): AttachmentRouteError {
	if (error instanceof AttachmentRouteError) return error;
	if (error instanceof EpochContentStoreError) {
		switch (error.code) {
			case "blob_too_large":
				return admissionErrorWithByteEvidence(error, 413, "payload_too_large", "attachment_blob");
			case "cache_bytes_exhausted":
				return admissionErrorWithByteEvidence(error, 507, "attachment_cache_exhausted", "attachment_cache");
			case "cache_items_exhausted":
				return admissionErrorWithItemEvidence(error);
			case "declared_digest_mismatch":
			case "declared_length_mismatch":
			case "digest_collision":
			case "empty_blob":
			case "manifest_mismatch":
				return new AttachmentRouteError(422, error.code, "Attachment content could not be validated");
			case "epoch_mismatch":
			case "invalid_ref":
				return new AttachmentRouteError(400, error.code, "Attachment reference is invalid", {
					type: "payload_admission_error",
					code: error.code === "epoch_mismatch" ? "attachment_ref_epoch_mismatch" : "attachment_ref_invalid",
					boundary: "attachment_ref",
				});
			case "not_found":
			case "not_published":
				return new AttachmentRouteError(404, "not_found", "Attachment content is unavailable", {
					type: "payload_admission_error",
					code: "attachment_unavailable",
					boundary: "attachment_ref",
				});
			case "closed":
			case "not_initialized":
				return new AttachmentRouteError(
					503,
					"attachment_store_unavailable",
					"Attachment store is unavailable",
				);
			default:
				break;
		}
	}
	return new AttachmentRouteError(500, "attachment_io_failure", "Attachment operation failed");
}

function admissionErrorWithByteEvidence(
	error: EpochContentStoreError,
	status: 413 | 507,
	code: "payload_too_large" | "attachment_cache_exhausted",
	boundary: "attachment_blob" | "attachment_cache",
): AttachmentRouteError {
	if (error.limit === undefined || error.actual === undefined || error.actual <= error.limit) {
		return new AttachmentRouteError(500, "attachment_io_failure", "Attachment operation failed");
	}
	return new AttachmentRouteError(status, error.code, "Attachment capacity was exceeded", {
		type: "payload_admission_error",
		code,
		boundary,
		limitBytes: error.limit,
		actualBytes: error.actual,
	});
}

function admissionErrorWithItemEvidence(error: EpochContentStoreError): AttachmentRouteError {
	if (error.limit === undefined || error.actual === undefined || error.actual <= error.limit) {
		return new AttachmentRouteError(500, "attachment_io_failure", "Attachment operation failed");
	}
	return new AttachmentRouteError(507, error.code, "Attachment item capacity was exceeded", {
		type: "payload_admission_error",
		code: "attachment_cache_item_limit_exceeded",
		boundary: "attachment_cache",
		limitItems: error.limit,
		actualItems: error.actual,
	});
}
