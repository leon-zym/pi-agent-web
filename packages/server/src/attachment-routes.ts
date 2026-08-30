import {
	SESSION_ATTACHMENT_BLOB_MAX_BYTES,
	type SessionPayloadAdmissionErrorDto,
} from "@pi-agent-web/protocol";
import { Hono } from "hono";
import {
	type EpochContentPin,
	EpochContentStoreError,
	type PinnedEpochContent,
} from "./epoch-content-store.js";
import { managedDownloadBody } from "./managed-download-body.js";
import { isRasterMediaType, rasterFileExtension } from "./raster-admission.js";

const DIGEST_RE = /^[0-9a-f]{64}$/;

export interface AttachmentContentStore {
	pinByDigest(digest: string, options?: { signal?: AbortSignal }): Promise<PinnedEpochContent>;
	release(pin: EpochContentPin): Promise<void>;
}

export interface AttachmentRoutesContext {
	contentStore: AttachmentContentStore;
	serverEpoch: string;
	maxBlobBytes?: number;
}

type AttachmentErrorStatus = 400 | 404 | 405 | 410 | 416 | 422 | 500 | 503;

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

	app.on(["GET", "HEAD"], "/attachments/:serverEpoch/:sha256", async (c) => {
		try {
			const sha256 = validatedPath(c.req.param("serverEpoch"), c.req.param("sha256"), ctx.serverEpoch);
			if (c.req.method === "HEAD") {
				return attachmentErrorResponse(
					new AttachmentRouteError(405, "method_not_allowed", "HEAD is not supported for attachments"),
					{ Allow: "GET" },
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
