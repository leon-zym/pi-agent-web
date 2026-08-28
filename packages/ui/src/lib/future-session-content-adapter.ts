import {
	type BlockingExtensionUiRequestDto,
	type ExtensionUiRequestDto,
	type FutureExtensionUiRequestDto,
	type FutureExtensionUiSnapshotDto,
	type FutureSessionContentRefGuardContext,
	type FutureSessionReplayFrameDto,
	type FutureSessionSnapshotDto,
	isExtensionUiRequestDto,
	isFutureSessionContentRefGuardContext,
	isFutureSessionReplayFrameDto,
	isFutureSessionSnapshotDto,
	isFutureSessionWsServerMessage,
	isSessionJsonRootDto,
	isSessionTextPayloadDto,
	type SessionExternalJsonDto,
	type SessionExternalTextDto,
	type SessionJsonValueDto,
	type SessionReplayFrameDto,
	type StickyExtensionUiRequestDto,
} from "@pi-agent-web/protocol";

export type FutureSessionTextPayloadProjection =
	| { kind: "inline"; value: string }
	| { kind: "external"; value: SessionExternalTextDto };

export type FutureSessionJsonRootProjection =
	| { kind: "inline"; value: SessionJsonValueDto }
	| { kind: "external"; value: SessionExternalJsonDto };

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
}

function adapterError(message: string): FutureSessionContentAdapterError {
	return new FutureSessionContentAdapterError(message);
}

function abortError(): DOMException {
	return new DOMException("Future Session content adaptation was aborted", "AbortError");
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
