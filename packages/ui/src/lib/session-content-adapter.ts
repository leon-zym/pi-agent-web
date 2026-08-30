import {
	type ExtensionUiRequestDto,
	type ExtensionUiSnapshotDto,
	type InlineSessionReplayFrameDto,
	isBoundedJsonValue,
	isPiExtensionUiRequestDto,
	isSessionContentRefGuardContext,
	isSessionJsonRootDto,
	isSessionReplayFrameDto,
	isSessionSnapshotDto,
	isSessionTextPayloadDto,
	isSessionWsServerMessage,
	type PiBlockingExtensionUiRequestDto,
	type PiExtensionUiRequestDto,
	type PiStickyExtensionUiRequestDto,
	type SessionContentRefGuardContext,
	type SessionExternalJsonDto,
	type SessionExternalTextDto,
	type SessionJsonRootDto,
	type SessionJsonValueDto,
	type SessionReplayFrameDto,
	type SessionSnapshotDto,
	type SessionTextPayloadDto,
} from "@pi-agent-web/protocol";

export type SessionTextPayloadProjection =
	| { kind: "inline"; value: string }
	| { kind: "external"; value: SessionExternalTextDto };

export type SessionJsonRootProjection =
	| { kind: "inline"; value: SessionJsonValueDto }
	| { kind: "external"; value: SessionExternalJsonDto };

export type SessionJsonFieldGuard<T> = (value: unknown) => value is T;

export type ProjectedSessionReplayFrame =
	| Exclude<SessionReplayFrameDto, { type: "extension_ui_request" }>
	| Extract<InlineSessionReplayFrameDto, { type: "extension_ui_request" }>;

export interface ProjectedSessionSnapshot
	extends Omit<SessionSnapshotDto, "pendingExtensionRequests" | "stickyExtensionState"> {
	pendingExtensionRequests: PiBlockingExtensionUiRequestDto[];
	stickyExtensionState: PiStickyExtensionUiRequestDto[];
}

export interface ProjectedExtensionUiSnapshot extends Omit<ExtensionUiSnapshotDto, "requests"> {
	requests: PiExtensionUiRequestDto[];
}

export type ProjectedSessionFrameMessage =
	| ProjectedSessionReplayFrame
	| ProjectedSessionSnapshot
	| ProjectedExtensionUiSnapshot;

export class SessionContentAdapterError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionContentAdapterError";
	}
}

export interface SessionContentAdapter {
	projectTextPayload(value: unknown): SessionTextPayloadProjection;
	projectJsonRoot(value: unknown): SessionJsonRootProjection;
	materializeTextPayload(value: unknown, signal?: AbortSignal): Promise<string>;
	materializeJsonRoot(value: unknown, signal?: AbortSignal): Promise<SessionJsonValueDto>;
	materializeJsonRoot(
		value: unknown,
		fieldGuard: undefined,
		signal?: AbortSignal,
	): Promise<SessionJsonValueDto>;
	materializeJsonRoot<T>(
		value: unknown,
		fieldGuard: SessionJsonFieldGuard<T>,
		signal?: AbortSignal,
	): Promise<T>;
	materializeReplayFrame(frame: unknown, signal?: AbortSignal): Promise<ProjectedSessionReplayFrame>;
	materializeReplayFrames(
		frames: readonly unknown[],
		signal?: AbortSignal,
	): Promise<ProjectedSessionReplayFrame[]>;
	materializeSnapshot(snapshot: unknown, signal?: AbortSignal): Promise<ProjectedSessionSnapshot>;
	materializeExtensionSnapshot(
		snapshot: unknown,
		signal?: AbortSignal,
	): Promise<ProjectedExtensionUiSnapshot>;
}

export interface SessionContentAdapterOptions {
	trustedContext: SessionContentRefGuardContext;
	resolver: SessionExtensionMaterializer;
}

export interface SessionExtensionMaterializer {
	materializeExtensionRequest(request: ExtensionUiRequestDto, signal?: AbortSignal): Promise<unknown>;
	/** Optional during the staged rollout; required only for external lazy roots. */
	resolveText?(value: SessionTextPayloadDto, signal?: AbortSignal): Promise<string>;
	resolveJson?<T>(
		value: SessionJsonRootDto,
		guard: SessionJsonFieldGuard<T>,
		signal?: AbortSignal,
	): Promise<T>;
}

function adapterError(message: string): SessionContentAdapterError {
	return new SessionContentAdapterError(message);
}

function abortError(): DOMException {
	return new DOMException("Session content adaptation was aborted", "AbortError");
}

function boundedJsonFieldGuard<T>(fieldGuard: SessionJsonFieldGuard<T>): SessionJsonFieldGuard<T> {
	return (value): value is T => isBoundedJsonValue(value) && fieldGuard(value);
}

function textPayloadRoot(value: unknown, context: SessionContentRefGuardContext): SessionTextPayloadDto {
	if (!isSessionTextPayloadDto(value, context)) {
		throw adapterError("Session text payload failed its exact context guard");
	}
	return value;
}

function jsonRoot(value: unknown, context: SessionContentRefGuardContext): SessionJsonRootDto {
	if (!isSessionJsonRootDto(value, context)) {
		throw adapterError("Session JSON root failed its exact context guard");
	}
	return value;
}

class DefaultSessionContentAdapter implements SessionContentAdapter {
	readonly #context: SessionContentRefGuardContext;
	readonly #resolver: SessionExtensionMaterializer;

	public constructor(options: SessionContentAdapterOptions) {
		if (!isSessionContentRefGuardContext(options.trustedContext)) {
			throw adapterError("Session content adapter received an invalid trusted context");
		}
		this.#context = Object.freeze({
			serverEpoch: options.trustedContext.serverEpoch,
			payloadBudget: Object.freeze({ ...options.trustedContext.payloadBudget }),
			contentRefBudget: Object.freeze({ ...options.trustedContext.contentRefBudget }),
		});
		this.#resolver = options.resolver;
	}

	public projectTextPayload(value: unknown): SessionTextPayloadProjection {
		if (!isSessionTextPayloadDto(value, this.#context)) {
			throw adapterError("Session text payload failed its exact context guard");
		}
		return typeof value === "string" ? { kind: "inline", value } : { kind: "external", value };
	}

	public projectJsonRoot(value: unknown): SessionJsonRootProjection {
		if (!isSessionJsonRootDto(value, this.#context)) {
			throw adapterError("Session JSON root failed its exact context guard");
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
			throw adapterError("Materialized Session text is not a string");
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
		fieldGuard: SessionJsonFieldGuard<T>,
		signal?: AbortSignal,
	): Promise<T>;
	public async materializeJsonRoot<T>(
		value: unknown,
		fieldGuardOrSignal?: SessionJsonFieldGuard<T> | AbortSignal,
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
	): Promise<ProjectedSessionReplayFrame> {
		this.#assertNotAborted(signal);
		if (!isSessionReplayFrameDto(frame, this.#context)) {
			throw adapterError("Session replay frame failed its exact context guard");
		}
		if (frame.type !== "extension_ui_request") return frame;
		const request = this.#assertMaterializedCurrentRequest(
			await this.#resolver.materializeExtensionRequest(frame.request, signal),
		);
		const candidate: ProjectedSessionReplayFrame = { ...frame, request };
		return candidate;
	}

	public async materializeReplayFrames(
		frames: readonly unknown[],
		signal?: AbortSignal,
	): Promise<ProjectedSessionReplayFrame[]> {
		this.#assertNotAborted(signal);
		const projected: ProjectedSessionReplayFrame[] = [];
		for (const frame of frames) projected.push(await this.materializeReplayFrame(frame, signal));
		return projected;
	}

	public async materializeSnapshot(
		snapshot: unknown,
		signal?: AbortSignal,
	): Promise<ProjectedSessionSnapshot> {
		this.#assertNotAborted(signal);
		if (!isSessionSnapshotDto(snapshot, this.#context)) {
			throw adapterError("Session snapshot failed its exact context guard");
		}
		const pendingExtensionRequests: PiBlockingExtensionUiRequestDto[] = [];
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
		const stickyExtensionState: PiStickyExtensionUiRequestDto[] = [];
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
		const candidate: ProjectedSessionSnapshot = {
			...snapshot,
			pendingExtensionRequests,
			stickyExtensionState,
		};
		return candidate;
	}

	public async materializeExtensionSnapshot(
		snapshot: unknown,
		signal?: AbortSignal,
	): Promise<ProjectedExtensionUiSnapshot> {
		this.#assertNotAborted(signal);
		if (!isSessionWsServerMessage(snapshot, this.#context) || snapshot.type !== "extension_ui_snapshot") {
			throw adapterError(" Extension snapshot failed its exact context guard");
		}
		const requests: PiExtensionUiRequestDto[] = [];
		for (const request of snapshot.requests) {
			requests.push(
				this.#assertMaterializedCurrentRequest(
					await this.#resolver.materializeExtensionRequest(request, signal),
				),
			);
		}
		const candidate: ProjectedExtensionUiSnapshot = { ...snapshot, requests };
		return candidate;
	}

	async #materializeJsonRoot<T>(
		root: SessionJsonRootDto,
		fieldGuard: SessionJsonFieldGuard<T>,
		signal?: AbortSignal,
	): Promise<T> {
		if (root.type === "inline_json") {
			if (!fieldGuard(root.value)) {
				throw adapterError("Materialized Session JSON failed its field guard");
			}
			const materialized = structuredClone(root.value);
			this.#assertNotAborted(signal);
			return materialized;
		}
		const materialized = await this.#resolveJson(root, fieldGuard, signal);
		this.#assertNotAborted(signal);
		if (!fieldGuard(materialized)) {
			throw adapterError("Materialized Session JSON failed its field guard");
		}
		return materialized;
	}

	async #resolveText(value: SessionTextPayloadDto, signal?: AbortSignal): Promise<string> {
		const resolver = this.#resolver;
		if (typeof resolver.resolveText !== "function") {
			throw adapterError("Session content resolver cannot materialize external text");
		}
		return resolver.resolveText(value, signal);
	}

	async #resolveJson<T>(
		value: SessionJsonRootDto,
		fieldGuard: SessionJsonFieldGuard<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const resolver = this.#resolver;
		if (typeof resolver.resolveJson !== "function") {
			throw adapterError("Session content resolver cannot materialize external JSON");
		}
		return resolver.resolveJson(value, fieldGuard, signal);
	}

	#assertNotAborted(signal?: AbortSignal): void {
		if (signal?.aborted) throw abortError();
	}

	#assertMaterializedCurrentRequest(value: unknown): PiExtensionUiRequestDto {
		if (!isPiExtensionUiRequestDto(value)) {
			throw adapterError("Materialized Extension request failed its current guard");
		}
		return value;
	}
}

export function createSessionContentAdapter(options: SessionContentAdapterOptions): SessionContentAdapter {
	return new DefaultSessionContentAdapter(options);
}
