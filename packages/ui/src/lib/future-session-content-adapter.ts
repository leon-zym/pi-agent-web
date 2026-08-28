import {
	type BlockingExtensionUiRequestDto,
	type ExtensionUiRequestDto,
	type FutureExtensionUiRequestDto,
	type FutureExtensionUiSnapshotDto,
	type FutureSessionContentRefGuardContext,
	type FutureSessionReplayFrameDto,
	type FutureSessionSnapshotDto,
	isBoundedJsonValue,
	isExtensionUiRequestDto,
	isFutureSessionContentRefGuardContext,
	isFutureSessionReplayFrameDto,
	isFutureSessionSnapshotDto,
	isFutureSessionWsServerMessage,
	isSessionJsonRootDto,
	isSessionTextPayloadDto,
	type SessionExternalJsonDto,
	type SessionExternalTextDto,
	type SessionJsonRootDto,
	type SessionJsonValueDto,
	type SessionReplayFrameDto,
	type SessionTextPayloadDto,
	type StickyExtensionUiRequestDto,
} from "@pi-agent-web/protocol";

export type FutureSessionTextPayloadProjection =
	| { kind: "inline"; value: string }
	| { kind: "external"; value: SessionExternalTextDto };

export type FutureSessionJsonRootProjection =
	| { kind: "inline"; value: SessionJsonValueDto }
	| { kind: "external"; value: SessionExternalJsonDto };

export type FutureSessionJsonFieldGuard<T> = (value: unknown) => value is T;

export type ProjectedFutureSessionReplayFrame =
	| Exclude<FutureSessionReplayFrameDto, { type: "extension_ui_request" }>
	| Extract<SessionReplayFrameDto, { type: "extension_ui_request" }>;

export interface ProjectedFutureSessionSnapshot
	extends Omit<FutureSessionSnapshotDto, "pendingExtensionRequests" | "stickyExtensionState"> {
	pendingExtensionRequests: BlockingExtensionUiRequestDto[];
	stickyExtensionState: StickyExtensionUiRequestDto[];
}

export interface ProjectedFutureExtensionUiSnapshot extends Omit<FutureExtensionUiSnapshotDto, "requests"> {
	requests: ExtensionUiRequestDto[];
}

export type ProjectedFutureSessionFrameMessage =
	| ProjectedFutureSessionReplayFrame
	| ProjectedFutureSessionSnapshot
	| ProjectedFutureExtensionUiSnapshot;

export class FutureSessionContentAdapterError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "FutureSessionContentAdapterError";
	}
}

export interface FutureSessionContentAdapter {
	projectTextPayload(value: unknown): FutureSessionTextPayloadProjection;
	projectJsonRoot(value: unknown): FutureSessionJsonRootProjection;
	materializeTextPayload(value: unknown, signal?: AbortSignal): Promise<string>;
	materializeJsonRoot(value: unknown, signal?: AbortSignal): Promise<SessionJsonValueDto>;
	materializeJsonRoot(
		value: unknown,
		fieldGuard: undefined,
		signal?: AbortSignal,
	): Promise<SessionJsonValueDto>;
	materializeJsonRoot<T>(
		value: unknown,
		fieldGuard: FutureSessionJsonFieldGuard<T>,
		signal?: AbortSignal,
	): Promise<T>;
	materializeReplayFrame(frame: unknown, signal?: AbortSignal): Promise<ProjectedFutureSessionReplayFrame>;
	materializeReplayFrames(
		frames: readonly unknown[],
		signal?: AbortSignal,
	): Promise<ProjectedFutureSessionReplayFrame[]>;
	materializeSnapshot(snapshot: unknown, signal?: AbortSignal): Promise<ProjectedFutureSessionSnapshot>;
	materializeExtensionSnapshot(
		snapshot: unknown,
		signal?: AbortSignal,
	): Promise<ProjectedFutureExtensionUiSnapshot>;
}

export interface FutureSessionContentAdapterOptions {
	trustedContext: FutureSessionContentRefGuardContext;
	resolver: FutureSessionExtensionMaterializer;
}

export interface FutureSessionExtensionMaterializer {
	materializeExtensionRequest(request: FutureExtensionUiRequestDto, signal?: AbortSignal): Promise<unknown>;
	/** Optional during the staged rollout; required only for external lazy roots. */
	resolveText?(value: SessionTextPayloadDto, signal?: AbortSignal): Promise<string>;
	resolveJson?<T>(
		value: SessionJsonRootDto,
		guard: FutureSessionJsonFieldGuard<T>,
		signal?: AbortSignal,
	): Promise<T>;
}

function adapterError(message: string): FutureSessionContentAdapterError {
	return new FutureSessionContentAdapterError(message);
}

function abortError(): DOMException {
	return new DOMException("Future Session content adaptation was aborted", "AbortError");
}

function boundedJsonFieldGuard<T>(
	fieldGuard: FutureSessionJsonFieldGuard<T>,
): FutureSessionJsonFieldGuard<T> {
	return (value): value is T => isBoundedJsonValue(value) && fieldGuard(value);
}

function textPayloadRoot(
	value: unknown,
	context: FutureSessionContentRefGuardContext,
): SessionTextPayloadDto {
	if (!isSessionTextPayloadDto(value, context)) {
		throw adapterError("Future Session text payload failed its exact context guard");
	}
	return value;
}

function jsonRoot(value: unknown, context: FutureSessionContentRefGuardContext): SessionJsonRootDto {
	if (!isSessionJsonRootDto(value, context)) {
		throw adapterError("Future Session JSON root failed its exact context guard");
	}
	return value;
}

class DefaultFutureSessionContentAdapter implements FutureSessionContentAdapter {
	readonly #context: FutureSessionContentRefGuardContext;
	readonly #resolver: FutureSessionExtensionMaterializer;

	public constructor(options: FutureSessionContentAdapterOptions) {
		if (!isFutureSessionContentRefGuardContext(options.trustedContext)) {
			throw adapterError("Future Session content adapter received an invalid trusted context");
		}
		this.#context = Object.freeze({
			serverEpoch: options.trustedContext.serverEpoch,
			payloadBudget: Object.freeze({ ...options.trustedContext.payloadBudget }),
			contentRefBudget: Object.freeze({ ...options.trustedContext.contentRefBudget }),
		});
		this.#resolver = options.resolver;
	}

	public projectTextPayload(value: unknown): FutureSessionTextPayloadProjection {
		if (!isSessionTextPayloadDto(value, this.#context)) {
			throw adapterError("Future Session text payload failed its exact context guard");
		}
		return typeof value === "string" ? { kind: "inline", value } : { kind: "external", value };
	}

	public projectJsonRoot(value: unknown): FutureSessionJsonRootProjection {
		if (!isSessionJsonRootDto(value, this.#context)) {
			throw adapterError("Future Session JSON root failed its exact context guard");
		}
		return value.type === "inline_json"
			? { kind: "inline", value: value.value }
			: { kind: "external", value };
	}

	public async materializeTextPayload(value: unknown, signal?: AbortSignal): Promise<string> {
		this.#assertNotAborted(signal);
		const root = textPayloadRoot(value, this.#context);
		if (typeof root === "string") {
			this.#assertNotAborted(signal);
			return root;
		}
		const materialized = await this.#resolveText(root, signal);
		this.#assertNotAborted(signal);
		if (typeof materialized !== "string") {
			throw adapterError("Materialized Future Session text is not a string");
		}
		return materialized;
	}

	public materializeJsonRoot(value: unknown, signal?: AbortSignal): Promise<SessionJsonValueDto>;
	public materializeJsonRoot(
		value: unknown,
		fieldGuard: undefined,
		signal?: AbortSignal,
	): Promise<SessionJsonValueDto>;
	public materializeJsonRoot<T>(
		value: unknown,
		fieldGuard: FutureSessionJsonFieldGuard<T>,
		signal?: AbortSignal,
	): Promise<T>;
	public async materializeJsonRoot<T>(
		value: unknown,
		fieldGuardOrSignal?: FutureSessionJsonFieldGuard<T> | AbortSignal,
		signal?: AbortSignal,
	): Promise<SessionJsonValueDto | T> {
		const resolvedSignal =
			typeof fieldGuardOrSignal === "function"
				? signal
				: fieldGuardOrSignal === undefined
					? signal
					: fieldGuardOrSignal;
		this.#assertNotAborted(resolvedSignal);
		const root = jsonRoot(value, this.#context);
		if (typeof fieldGuardOrSignal === "function") {
			return this.#materializeJsonRoot(root, boundedJsonFieldGuard(fieldGuardOrSignal), resolvedSignal);
		}
		return this.#materializeJsonRoot(root, isBoundedJsonValue, resolvedSignal);
	}

	public async materializeReplayFrame(
		frame: unknown,
		signal?: AbortSignal,
	): Promise<ProjectedFutureSessionReplayFrame> {
		this.#assertNotAborted(signal);
		if (!isFutureSessionReplayFrameDto(frame, this.#context)) {
			throw adapterError("Future Session replay frame failed its exact context guard");
		}
		if (frame.type !== "extension_ui_request") return frame;
		const request = this.#assertMaterializedCurrentRequest(
			await this.#resolver.materializeExtensionRequest(frame.request, signal),
		);
		const candidate: ProjectedFutureSessionReplayFrame = { ...frame, request };
		return candidate;
	}

	public async materializeReplayFrames(
		frames: readonly unknown[],
		signal?: AbortSignal,
	): Promise<ProjectedFutureSessionReplayFrame[]> {
		this.#assertNotAborted(signal);
		const projected: ProjectedFutureSessionReplayFrame[] = [];
		for (const frame of frames) projected.push(await this.materializeReplayFrame(frame, signal));
		return projected;
	}

	public async materializeSnapshot(
		snapshot: unknown,
		signal?: AbortSignal,
	): Promise<ProjectedFutureSessionSnapshot> {
		this.#assertNotAborted(signal);
		if (!isFutureSessionSnapshotDto(snapshot, this.#context)) {
			throw adapterError("Future Session snapshot failed its exact context guard");
		}
		const pendingExtensionRequests: BlockingExtensionUiRequestDto[] = [];
		for (const request of snapshot.pendingExtensionRequests) {
			const materialized = this.#assertMaterializedCurrentRequest(
				await this.#resolver.materializeExtensionRequest(request, signal),
			);
			if (
				materialized.method !== "select" &&
				materialized.method !== "confirm" &&
				materialized.method !== "input" &&
				materialized.method !== "editor"
			) {
				throw adapterError("Materialized pending Extension request is not blocking");
			}
			pendingExtensionRequests.push(materialized);
		}
		const stickyExtensionState: StickyExtensionUiRequestDto[] = [];
		for (const request of snapshot.stickyExtensionState) {
			const materialized = this.#assertMaterializedCurrentRequest(
				await this.#resolver.materializeExtensionRequest(request, signal),
			);
			if (
				materialized.method !== "setStatus" &&
				materialized.method !== "setWidget" &&
				materialized.method !== "setTitle" &&
				materialized.method !== "set_editor_text"
			) {
				throw adapterError("Materialized sticky Extension request is not semantic state");
			}
			stickyExtensionState.push(materialized);
		}
		const candidate: ProjectedFutureSessionSnapshot = {
			...snapshot,
			pendingExtensionRequests,
			stickyExtensionState,
		};
		return candidate;
	}

	public async materializeExtensionSnapshot(
		snapshot: unknown,
		signal?: AbortSignal,
	): Promise<ProjectedFutureExtensionUiSnapshot> {
		this.#assertNotAborted(signal);
		if (
			!isFutureSessionWsServerMessage(snapshot, this.#context) ||
			snapshot.type !== "extension_ui_snapshot"
		) {
			throw adapterError("Future Extension snapshot failed its exact context guard");
		}
		const requests: ExtensionUiRequestDto[] = [];
		for (const request of snapshot.requests) {
			requests.push(
				this.#assertMaterializedCurrentRequest(
					await this.#resolver.materializeExtensionRequest(request, signal),
				),
			);
		}
		const candidate: ProjectedFutureExtensionUiSnapshot = { ...snapshot, requests };
		return candidate;
	}

	async #materializeJsonRoot<T>(
		root: SessionJsonRootDto,
		fieldGuard: FutureSessionJsonFieldGuard<T>,
		signal?: AbortSignal,
	): Promise<T> {
		if (root.type === "inline_json") {
			if (!fieldGuard(root.value)) {
				throw adapterError("Materialized Future Session JSON failed its field guard");
			}
			const materialized = structuredClone(root.value);
			this.#assertNotAborted(signal);
			return materialized;
		}
		const materialized = await this.#resolveJson(root, fieldGuard, signal);
		this.#assertNotAborted(signal);
		if (!fieldGuard(materialized)) {
			throw adapterError("Materialized Future Session JSON failed its field guard");
		}
		return materialized;
	}

	async #resolveText(value: SessionTextPayloadDto, signal?: AbortSignal): Promise<string> {
		const resolver = this.#resolver;
		if (typeof resolver.resolveText !== "function") {
			throw adapterError("Future Session content resolver cannot materialize external text");
		}
		return resolver.resolveText(value, signal);
	}

	async #resolveJson<T>(
		value: SessionJsonRootDto,
		fieldGuard: FutureSessionJsonFieldGuard<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const resolver = this.#resolver;
		if (typeof resolver.resolveJson !== "function") {
			throw adapterError("Future Session content resolver cannot materialize external JSON");
		}
		return resolver.resolveJson(value, fieldGuard, signal);
	}

	#assertNotAborted(signal?: AbortSignal): void {
		if (signal?.aborted) throw abortError();
	}

	#assertMaterializedCurrentRequest(value: unknown): ExtensionUiRequestDto {
		if (!isExtensionUiRequestDto(value)) {
			throw adapterError("Materialized Extension request failed its current guard");
		}
		return value;
	}
}

export function createFutureSessionContentAdapter(
	options: FutureSessionContentAdapterOptions,
): FutureSessionContentAdapter {
	return new DefaultFutureSessionContentAdapter(options);
}
