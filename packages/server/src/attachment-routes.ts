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
import { managedDownloadBody } from "./managed-download-body.js";
import {
	createRasterAdmissionValidator,
	isRasterMediaType,
	RasterAdmissionError,
	type RasterAdmissionValidator,
	type RasterMediaType,
	rasterFileExtension,
} from "./raster-admission.js";

const DIGEST_RE = /^[0-9a-f]{64}$/;

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
			const validated = await validatedRasterSource(c.req.raw, mediaType, byteLength, sha256);
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
			if (
				!isRasterMediaType(pinned.ref.mediaType) ||
				pinned.ref.serverEpoch !== ctx.serverEpoch ||
				pinned.ref.byteLength > maxBlobBytes
			) {
				await ctx.contentStore.release(pinned.pin).catch(() => undefined);
				throw new AttachmentRouteError(
					422,
					"invalid_attachment_ref",
					"Stored attachment metadata is invalid",
				);
			}
			return new Response(
				managedDownloadBody({
					stream: pinned.stream,
					release: () => ctx.contentStore.release(pinned.pin),
					failureMessage: "Attachment stream failed",
				}),
				{
					status: 200,
					headers: {
						"Cache-Control": "no-store",
						"Content-Disposition": `attachment; filename="${pinned.ref.sha256}.${rasterFileExtension(pinned.ref.mediaType)}"`,
						"Content-Length": String(pinned.ref.byteLength),
						"Content-Type": pinned.ref.mediaType,
						"Cross-Origin-Resource-Policy": "same-origin",
						"X-Content-Type-Options": "nosniff",
					},
				},
			);
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

function requiredRasterMediaType(request: Request): RasterMediaType {
	const mediaType = request.headers.get("content-type")?.trim().toLowerCase();
	if (!mediaType || !isRasterMediaType(mediaType)) {
		throw new AttachmentRouteError(415, "unsupported_media_type", "Attachment media type is not supported");
	}
	return mediaType;
}

async function validatedRasterSource(
	request: Request,
	mediaType: RasterMediaType,
	byteLength: number,
	expectedSha256: string,
): Promise<{ source: Readable; failure: () => AttachmentRouteError | undefined }> {
	if (!request.body) {
		throw new AttachmentRouteError(422, "truncated_raster_header", "Attachment raster header is truncated");
	}
	let validator: RasterAdmissionValidator;
	try {
		validator = createRasterAdmissionValidator(mediaType, byteLength);
	} catch (error) {
		throw mappedRasterAdmissionError(error);
	}
	const body = request.body;
	let exhausted = false;
	let validationFailure: AttachmentRouteError | undefined;
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
					try {
						validator.finish();
					} catch (error) {
						throw mappedRasterAdmissionError(error);
					}
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
					try {
						validator.push(next.value);
					} catch (error) {
						throw mappedRasterAdmissionError(error);
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

function mappedRasterAdmissionError(error: unknown): AttachmentRouteError {
	if (!(error instanceof RasterAdmissionError)) {
		throw error;
	}
	const status = error.code === "unsupported_media_type" ? 415 : 422;
	return new AttachmentRouteError(status, error.code, error.message);
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
