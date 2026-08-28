import { isSessionContentRefDto, type SessionContentRefDto } from "@pi-agent-web/protocol";
import { Hono } from "hono";
import {
	type EpochContentPin,
	EpochContentStoreError,
	type PinnedEpochContent,
} from "./epoch-content-store.js";
import { managedDownloadBody } from "./managed-download-body.js";

const DIGEST_RE = /^[0-9a-f]{64}$/;

export interface Utf8ContentReadStore {
	pinUtf8ByDigest(
		digest: string,
		options?: { signal?: AbortSignal },
	): Promise<PinnedEpochContent<SessionContentRefDto>>;
	release(pin: EpochContentPin<SessionContentRefDto>): Promise<void>;
}

export interface ContentRoutesContext {
	contentStore: Utf8ContentReadStore;
	serverEpoch: string;
}

type ContentErrorStatus = 400 | 404 | 405 | 410 | 416 | 500 | 503;

class ContentRouteError extends Error {
	constructor(
		readonly status: ContentErrorStatus,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ContentRouteError";
	}
}

export function createContentRoutes(ctx: ContentRoutesContext): Hono {
	const app = new Hono();

	app.all("/content/:serverEpoch/:sha256", async (c) => {
		let pinned: PinnedEpochContent<SessionContentRefDto> | undefined;
		let transferred = false;
		let failure: unknown;
		try {
			const sha256 = validatedContentPath(c.req.param("serverEpoch"), c.req.param("sha256"), ctx.serverEpoch);
			if (c.req.method !== "GET") {
				throw new ContentRouteError(405, "method_not_allowed", "Only GET is supported for content");
			}
			if (c.req.raw.headers.get("range") !== null) {
				throw new ContentRouteError(416, "range_not_supported", "Content ranges are not supported");
			}
			pinned = await ctx.contentStore.pinUtf8ByDigest(sha256, { signal: c.req.raw.signal });
			if (
				!isSessionContentRefDto(pinned.ref) ||
				pinned.ref.serverEpoch !== ctx.serverEpoch ||
				pinned.ref.sha256 !== sha256
			) {
				throw new ContentRouteError(500, "content_io_failure", "Content operation failed");
			}
			const response = new Response(
				managedDownloadBody({
					stream: pinned.stream,
					release: () => ctx.contentStore.release(pinned!.pin),
					failureMessage: "Content stream failed",
				}),
				{
					status: 200,
					headers: {
						"Cache-Control": "no-store",
						"Content-Length": String(pinned.ref.byteLength),
						"Content-Type": "application/octet-stream",
						"Cross-Origin-Resource-Policy": "same-origin",
						"X-Content-Type-Options": "nosniff",
					},
				},
			);
			transferred = true;
			return response;
		} catch (error) {
			failure = error;
		} finally {
			if (pinned && !transferred) {
				try {
					await ctx.contentStore.release(pinned.pin);
				} catch (error) {
					failure = error;
				}
			}
		}
		return contentErrorResponse(failure, failure instanceof ContentRouteError && failure.status === 405);
	});

	return app;
}

function validatedContentPath(requestedEpoch: string, digest: string, currentEpoch: string): string {
	if (requestedEpoch !== currentEpoch) {
		throw new ContentRouteError(410, "content_epoch_gone", "Content epoch is no longer available");
	}
	if (!DIGEST_RE.test(digest)) {
		throw new ContentRouteError(400, "invalid_content_digest", "Content digest is invalid");
	}
	return digest;
}

function contentErrorResponse(error: unknown, methodNotAllowed = false): Response {
	const mapped = mappedContentError(error);
	return Response.json(
		{ error: { code: mapped.code, message: mapped.message } },
		{
			status: mapped.status,
			headers: {
				"Cache-Control": "no-store",
				...(methodNotAllowed ? { Allow: "GET" } : {}),
			},
		},
	);
}

function mappedContentError(error: unknown): ContentRouteError {
	if (error instanceof ContentRouteError) return error;
	if (error instanceof EpochContentStoreError) {
		switch (error.code) {
			case "not_found":
			case "not_published":
				return new ContentRouteError(404, "content_unavailable", "Content is unavailable");
			case "closed":
			case "not_initialized":
				return new ContentRouteError(503, "content_store_unavailable", "Content store is unavailable");
			default:
				break;
		}
	}
	return new ContentRouteError(500, "content_io_failure", "Content operation failed");
}
