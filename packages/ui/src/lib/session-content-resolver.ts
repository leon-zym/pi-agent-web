import {
	type ExtensionUiRequestDto,
	type FutureExtensionUiRequestDto,
	type FutureSessionContentRefGuardContext,
	isExtensionUiRequestDto,
	isFutureExtensionUiRequestDto,
	isFutureSessionContentRefGuardContext,
	isSessionJsonRootDto,
	isSessionTextPayloadDto,
	type SessionContentRefDto,
	type SessionJsonRootDto,
	type SessionTextPayloadDto,
} from "@pi-agent-web/protocol";

const CONTENT_TYPE = "application/octet-stream";

export class SessionContentResolutionError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionContentResolutionError";
	}
}

export interface SessionContentResolverOptions {
	trustedContext: FutureSessionContentRefGuardContext;
	fetcher?: typeof fetch;
	cacheLimits?: {
		maxBytes: number;
		maxItems: number;
	};
}

export interface SessionContentResolver {
	resolveText(value: SessionTextPayloadDto, signal?: AbortSignal): Promise<string>;
	resolveJson<T>(
		value: SessionJsonRootDto,
		guard: (value: unknown) => value is T,
		signal?: AbortSignal,
	): Promise<T>;
	materializeExtensionRequest(
		request: FutureExtensionUiRequestDto,
		signal?: AbortSignal,
	): Promise<ExtensionUiRequestDto>;
	dispose(): void;
}

interface CacheEntry {
	ref: SessionContentRefDto;
	text: string;
}

interface InflightEntry {
	ref: SessionContentRefDto;
	controller: AbortController;
	consumers: Set<symbol>;
	promise: Promise<string>;
}

function resolutionError(message: string, cause?: unknown): SessionContentResolutionError {
	return new SessionContentResolutionError(message, cause === undefined ? undefined : { cause });
}

function abortError(): DOMException {
	return new DOMException("Session content resolution was aborted", "AbortError");
}

function sameRef(left: SessionContentRefDto, right: SessionContentRefDto): boolean {
	return (
		left.type === right.type &&
		left.serverEpoch === right.serverEpoch &&
		left.sha256 === right.sha256 &&
		left.byteLength === right.byteLength &&
		left.encoding === right.encoding
	);
}

function isPositiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function exactHeader(response: Response, name: string, expected: string): boolean {
	return response.headers.get(name)?.trim().toLowerCase() === expected;
}

function assertResponseMetadata(response: Response, ref: SessionContentRefDto): void {
	if (response.status !== 200 || response.body === null) {
		throw resolutionError("Session content response has an invalid status or empty body");
	}
	if (!exactHeader(response, "Content-Type", CONTENT_TYPE)) {
		throw resolutionError("Session content response has an invalid content type");
	}
	const contentLength = response.headers.get("Content-Length");
	if (
		contentLength === null ||
		!/^(0|[1-9]\d*)$/.test(contentLength) ||
		Number(contentLength) !== ref.byteLength
	) {
		throw resolutionError("Session content response has an invalid content length");
	}
	if (!exactHeader(response, "Cache-Control", "no-store")) {
		throw resolutionError("Session content response has an invalid cache policy");
	}
	if (!exactHeader(response, "X-Content-Type-Options", "nosniff")) {
		throw resolutionError("Session content response is missing nosniff");
	}
	if (!exactHeader(response, "Cross-Origin-Resource-Policy", "same-origin")) {
		throw resolutionError("Session content response has an invalid resource policy");
	}
}

async function cancelResponseBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
	if (body === null) return;
	try {
		await body.cancel();
	} catch {
		// Preserve the authoritative resolution failure when cleanup itself fails.
	}
}

async function decodeExactUtf8(response: Response, ref: SessionContentRefDto): Promise<string> {
	try {
		assertResponseMetadata(response, ref);
	} catch (error) {
		await cancelResponseBody(response.body);
		throw error;
	}
	const body = response.body;
	if (body === null) throw resolutionError("Session content response has no body");
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const decoded: string[] = [];
	let receivedBytes = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			receivedBytes += result.value.byteLength;
			if (!Number.isSafeInteger(receivedBytes) || receivedBytes > ref.byteLength) {
				throw resolutionError("Session content response exceeded its exact byte length");
			}
			decoded.push(decoder.decode(result.value, { stream: true }));
		}
		decoded.push(decoder.decode());
		if (receivedBytes !== ref.byteLength) {
			throw resolutionError("Session content response was truncated");
		}
		return decoded.join("");
	} catch (error) {
		try {
			await reader.cancel();
		} catch {
			// Preserve the decode failure when cleanup itself fails.
		}
		if (error instanceof SessionContentResolutionError) throw error;
		throw resolutionError("Session content response is not valid UTF-8", error);
	} finally {
		reader.releaseLock();
	}
}

class DefaultSessionContentResolver implements SessionContentResolver {
	readonly #context: FutureSessionContentRefGuardContext;
	readonly #fetcher: typeof fetch;
	readonly #maxCacheBytes: number;
	readonly #maxCacheItems: number;
	readonly #cache = new Map<string, CacheEntry>();
	readonly #inflight = new Map<string, InflightEntry>();
	#cacheBytes = 0;
	#reservedBytes = 0;
	#reservedItems = 0;
	#disposed = false;

	public constructor(options: SessionContentResolverOptions) {
		if (!isFutureSessionContentRefGuardContext(options.trustedContext)) {
			throw resolutionError("Session content resolver received an invalid trusted context");
		}
		const context = options.trustedContext;
		this.#context = Object.freeze({
			serverEpoch: context.serverEpoch,
			payloadBudget: Object.freeze({ ...context.payloadBudget }),
			contentRefBudget: Object.freeze({ ...context.contentRefBudget }),
		});
		// Keep the native fetch receiver intact. Browsers reject an unbound fetch call
		// even though injected test fetchers are ordinary functions.
		this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
		const maxCacheBytes =
			options.cacheLimits?.maxBytes ?? this.#context.payloadBudget.maxAttachmentCacheBytes;
		const maxCacheItems =
			options.cacheLimits?.maxItems ?? this.#context.payloadBudget.maxAttachmentCacheItems;
		if (
			!isPositiveSafeInteger(maxCacheBytes) ||
			!isPositiveSafeInteger(maxCacheItems) ||
			maxCacheBytes > this.#context.payloadBudget.maxAttachmentCacheBytes ||
			maxCacheItems > this.#context.payloadBudget.maxAttachmentCacheItems
		) {
			throw resolutionError("Session content resolver received invalid cache limits");
		}
		this.#maxCacheBytes = maxCacheBytes;
		this.#maxCacheItems = maxCacheItems;
	}

	public async resolveText(value: SessionTextPayloadDto, signal?: AbortSignal): Promise<string> {
		this.#assertUsable(signal);
		if (!isSessionTextPayloadDto(value, this.#context)) {
			throw resolutionError("Session text payload failed its trusted context guard");
		}
		return typeof value === "string" ? value : this.#resolveRef(value.ref, signal);
	}

	public async resolveJson<T>(
		value: SessionJsonRootDto,
		guard: (value: unknown) => value is T,
		signal?: AbortSignal,
	): Promise<T> {
		this.#assertUsable(signal);
		if (!isSessionJsonRootDto(value, this.#context)) {
			throw resolutionError("Session JSON root failed its trusted context guard");
		}
		let candidate: unknown;
		if (value.type === "inline_json") {
			candidate = value.value;
		} else {
			const text = await this.#resolveRef(value.ref, signal);
			try {
				candidate = JSON.parse(text);
			} catch (error) {
				throw resolutionError("External Session JSON is malformed", error);
			}
		}
		if (!guard(candidate)) {
			throw resolutionError("Materialized Session JSON failed its field guard");
		}
		return candidate;
	}

	public async materializeExtensionRequest(
		request: FutureExtensionUiRequestDto,
		signal?: AbortSignal,
	): Promise<ExtensionUiRequestDto> {
		this.#assertUsable(signal);
		if (!isFutureExtensionUiRequestDto(request, this.#context)) {
			throw resolutionError("Future Extension request failed its trusted context guard");
		}
		let candidate: unknown = request;
		switch (request.method) {
			case "editor":
				if (request.prefill !== undefined) {
					candidate = { ...request, prefill: await this.resolveText(request.prefill, signal) };
				}
				break;
			case "set_editor_text":
				candidate = { ...request, text: await this.resolveText(request.text, signal) };
				break;
			case "setWidget":
				if (request.widgetLines !== undefined) {
					const widgetLines = await this.resolveJson(
						request.widgetLines,
						(value): value is string[] =>
							Array.isArray(value) && value.every((line) => typeof line === "string"),
						signal,
					);
					candidate = { ...request, widgetLines };
				}
				break;
		}
		if (!isExtensionUiRequestDto(candidate)) {
			throw resolutionError("Materialized Extension request failed its current field guard");
		}
		return candidate;
	}

	public dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const entry of this.#inflight.values()) entry.controller.abort();
		this.#inflight.clear();
		this.#cache.clear();
		this.#cacheBytes = 0;
		this.#reservedBytes = 0;
		this.#reservedItems = 0;
	}

	#assertUsable(signal?: AbortSignal): void {
		if (this.#disposed) throw resolutionError("Session content resolver is disposed");
		if (signal?.aborted) throw abortError();
	}

	#key(ref: SessionContentRefDto): string {
		return `${ref.serverEpoch}:${ref.sha256}`;
	}

	#assertSameMetadata(existing: SessionContentRefDto, candidate: SessionContentRefDto): void {
		if (!sameRef(existing, candidate)) {
			throw resolutionError("Session content digest metadata collision");
		}
	}

	#touchCached(key: string, entry: CacheEntry): string {
		this.#cache.delete(key);
		this.#cache.set(key, entry);
		return entry.text;
	}

	#evictFor(byteLength: number): void {
		while (
			this.#cache.size > 0 &&
			(this.#cacheBytes + this.#reservedBytes + byteLength > this.#maxCacheBytes ||
				this.#cache.size + this.#reservedItems + 1 > this.#maxCacheItems)
		) {
			const oldest = this.#cache.entries().next().value;
			if (oldest === undefined) break;
			this.#cache.delete(oldest[0]);
			this.#cacheBytes -= oldest[1].ref.byteLength;
		}
	}

	#reserve(ref: SessionContentRefDto): void {
		this.#evictFor(ref.byteLength);
		if (
			ref.byteLength > this.#maxCacheBytes ||
			this.#cacheBytes + this.#reservedBytes + ref.byteLength > this.#maxCacheBytes ||
			this.#cache.size + this.#reservedItems + 1 > this.#maxCacheItems
		) {
			throw resolutionError("Session content cache budget is exhausted");
		}
		this.#reservedBytes += ref.byteLength;
		this.#reservedItems += 1;
	}

	#startInflight(key: string, ref: SessionContentRefDto): InflightEntry {
		this.#reserve(ref);
		const controller = new AbortController();
		const consumers = new Set<symbol>();
		let reservationActive = true;
		const promise = this.#fetchText(ref, controller.signal)
			.then((text) => {
				this.#reservedBytes -= ref.byteLength;
				this.#reservedItems -= 1;
				reservationActive = false;
				if (!this.#disposed) {
					this.#cache.set(key, { ref, text });
					this.#cacheBytes += ref.byteLength;
				}
				return text;
			})
			.finally(() => {
				if (reservationActive) {
					this.#reservedBytes -= ref.byteLength;
					this.#reservedItems -= 1;
				}
				const current = this.#inflight.get(key);
				if (current?.promise === promise) this.#inflight.delete(key);
			});
		const entry = { ref, controller, consumers, promise };
		this.#inflight.set(key, entry);
		return entry;
	}

	async #fetchText(ref: SessionContentRefDto, signal: AbortSignal): Promise<string> {
		let response: Response;
		try {
			response = await this.#fetcher(`/api/v1/content/${encodeURIComponent(ref.serverEpoch)}/${ref.sha256}`, {
				method: "GET",
				credentials: "same-origin",
				redirect: "error",
				headers: { Accept: CONTENT_TYPE },
				signal,
			});
		} catch (error) {
			if (signal.aborted) throw abortError();
			throw resolutionError("Session content request failed", error);
		}
		try {
			return await decodeExactUtf8(response, ref);
		} catch (error) {
			if (signal.aborted) throw abortError();
			throw error;
		}
	}

	#resolveRef(ref: SessionContentRefDto, signal?: AbortSignal): Promise<string> {
		this.#assertUsable(signal);
		const key = this.#key(ref);
		const cached = this.#cache.get(key);
		if (cached !== undefined) {
			this.#assertSameMetadata(cached.ref, ref);
			return Promise.resolve(this.#touchCached(key, cached));
		}
		const existing = this.#inflight.get(key);
		if (existing !== undefined) {
			this.#assertSameMetadata(existing.ref, ref);
			return this.#consume(existing, signal);
		}
		return this.#consume(this.#startInflight(key, ref), signal);
	}

	#consume(entry: InflightEntry, signal?: AbortSignal): Promise<string> {
		const consumer = Symbol("session-content-consumer");
		entry.consumers.add(consumer);
		return new Promise<string>((resolve, reject) => {
			let settled = false;
			const leave = (): void => {
				entry.consumers.delete(consumer);
				if (entry.consumers.size === 0) entry.controller.abort();
			};
			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				leave();
				reject(abortError());
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			entry.promise.then(
				(text) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					entry.consumers.delete(consumer);
					resolve(text);
				},
				(error: unknown) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					entry.consumers.delete(consumer);
					reject(error);
				},
			);
		});
	}
}

export function createSessionContentResolver(options: SessionContentResolverOptions): SessionContentResolver {
	return new DefaultSessionContentResolver(options);
}
