import {
	type ExtensionUiRequestDto,
	type InlineSessionProjectionEventDto,
	isPiExtensionUiRequestDto,
	isPiProductSessionEventDto,
	isPiSessionMessageDto,
	isSessionAttachmentGuardContext,
	type ProductSessionEventDto,
	SESSION_SNAPSHOT_MAX_BYTES,
	SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS,
	SESSION_SNAPSHOT_MAX_MESSAGES,
	SESSION_SNAPSHOT_MAX_PROJECTION_EVENTS,
	SESSION_SNAPSHOT_MAX_QUEUE_ITEMS,
	type SessionAttachmentGuardContext,
	type SessionMessageDto,
} from "@pi-agent-web/protocol";
import {
	SessionProductSchemaLogicalError,
	type SessionProjectionProductSchema,
} from "./session-product-schema.js";

const BLOCKING_EXTENSION_METHODS = new Set(["select", "confirm", "input", "editor"]);
const SNAPSHOT_RUNTIME_ENVELOPE_RESERVE_BYTES = 2 * 1024 * 1024;

const DEFAULT_LIMITS: SessionLiveProjectionLimits = {
	maxSettledMessageItems: SESSION_SNAPSHOT_MAX_MESSAGES,
	maxSettledMessageBytes: SESSION_SNAPSHOT_MAX_BYTES - SNAPSHOT_RUNTIME_ENVELOPE_RESERVE_BYTES,
	maxLiveEventItems: SESSION_SNAPSHOT_MAX_PROJECTION_EVENTS,
	maxLiveEventBytes: 8 * 1024 * 1024,
	maxQueueItems: SESSION_SNAPSHOT_MAX_QUEUE_ITEMS,
	maxExtensionItems: SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS,
	maxExtensionBytes: 512 * 1024,
	maxSnapshotBytes: SESSION_SNAPSHOT_MAX_BYTES - SNAPSHOT_RUNTIME_ENVELOPE_RESERVE_BYTES,
};

export type SessionLiveRuntimePhase = "starting" | "idle" | "running" | "waiting_ui" | "crashed" | "dormant";

export interface SessionLiveProjectionIdentity {
	serverEpoch: string;
	sessionHandle: string;
	workspaceId: string;
	generation: number;
}

export interface SessionLiveProjectionLimits {
	maxSettledMessageItems: number;
	maxSettledMessageBytes: number;
	maxLiveEventItems: number;
	maxLiveEventBytes: number;
	maxQueueItems: number;
	maxExtensionItems: number;
	maxExtensionBytes: number;
	/** Projection payload budget, leaving room for the wire runtime and snapshot envelope. */
	maxSnapshotBytes: number;
}

export interface SessionLiveProjectionOptions<
	TMessage = SessionMessageDto,
	TEvent = ProductSessionEventDto,
	TExtensionRequest extends { readonly id: string; readonly method: string } = ExtensionUiRequestDto,
> {
	identity: SessionLiveProjectionIdentity;
	settledMessages?: readonly TMessage[];
	baseSeq: number;
	runtimePhase?: SessionLiveRuntimePhase;
	limits?: Partial<SessionLiveProjectionLimits>;
	attachmentGuardContext?: SessionAttachmentGuardContext;
	/** Optional schema seam for focused in-memory tests; production always supplies the product schema. */
	schema?: SessionProjectionProductSchema<TMessage, TEvent, TExtensionRequest>;
}

export type SessionLiveProjectionInput<
	TEvent = ProductSessionEventDto,
	TExtensionRequest = ExtensionUiRequestDto,
> =
	| { type: "event"; event: TEvent }
	| { type: "extension_ui_request"; request: TExtensionRequest }
	| {
			type: "extension_ui_closed";
			requestId: string;
			reason: "answered" | "cancelled" | "expired" | "process_lost" | "replaced";
	  };

export type SessionLiveProjectionEventFrame<TEvent = ProductSessionEventDto> = Omit<
	InlineSessionProjectionEventDto,
	"event"
> & { event: TEvent };

export interface SessionLiveProjectionSnapshot<
	TMessage = SessionMessageDto,
	TEvent = ProductSessionEventDto,
	TExtensionRequest = ExtensionUiRequestDto,
> extends SessionLiveProjectionIdentity {
	baseSeq: number;
	asOfSeq: number;
	runtimePhase: SessionLiveRuntimePhase;
	settledMessages: readonly TMessage[];
	projectionEvents: readonly SessionLiveProjectionEventFrame<TEvent>[];
	queue: {
		readonly steering: readonly string[];
		readonly followUp: readonly string[];
	};
	pendingExtensionRequests: readonly TExtensionRequest[];
	stickyExtensionState: readonly TExtensionRequest[];
}

export interface SessionLiveProjectionCompactionToken extends SessionLiveProjectionIdentity {
	expectedAsOfSeq: number;
}

export interface SessionLiveProjectionTurnBudget {
	maxItems: number;
	maxBytes: number;
}

export interface SessionLiveProjectionPreparedCommit {
	readonly nextSeq: number;
}

export interface SessionLiveProjectionPreparedBatch {
	readonly firstSeq: number;
	readonly lastSeq: number;
	readonly count: number;
}

export interface SessionLiveProjectionPreparedCompaction {
	readonly expectedAsOfSeq: number;
}

interface InternalCompactionToken extends SessionLiveProjectionCompactionToken {
	owner: symbol;
}

interface ProjectionCandidate<TEvent, TExtensionRequest> {
	asOfSeq: number;
	projectionEvents: readonly SessionLiveProjectionEventFrame<TEvent>[];
	projectionEventFrameBytes: readonly number[];
	projectionEventBytes: number;
	queue: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
	pendingExtensionRequests: Map<string, TExtensionRequest>;
	runtimePhase: SessionLiveRuntimePhase;
}

interface PreparedBatchState<TEvent, TExtensionRequest> {
	revision: number;
	firstSeq: number;
	lastSeq: number;
	count: number;
	candidate: ProjectionCandidate<TEvent, TExtensionRequest>;
}

interface PreparedCompactionState<TMessage> {
	revision: number;
	settledMessages: readonly TMessage[];
	settledMessageBytes: number;
	baseSeq: number;
}

export class SessionLiveProjectionIdentityError extends Error {
	constructor() {
		super("session_live_projection_identity_mismatch");
		this.name = "SessionLiveProjectionIdentityError";
	}
}

export class SessionLiveProjectionLimitError extends Error {
	readonly boundary: "settled_messages" | "live_events" | "queue" | "extension_state" | "snapshot";

	constructor(boundary: SessionLiveProjectionLimitError["boundary"]) {
		super(`session_live_projection_${boundary}_limit_exceeded`);
		this.name = "SessionLiveProjectionLimitError";
		this.boundary = boundary;
	}
}

export class SessionLiveProjectionPayloadError extends Error {
	constructor() {
		super("session_live_projection_payload_invalid");
		this.name = "SessionLiveProjectionPayloadError";
	}
}

/**
 * Ephemeral product-domain Session projection.
 *
 * This deliberately stores a settled message base plus the ordered Pi event
 * suffix needed to reconstruct live state. It does not duplicate the UI's
 * ConversationProjection reducer and it never persists a second Session truth.
 */
export class SessionLiveProjection<
	TMessage = SessionMessageDto,
	TEvent = ProductSessionEventDto,
	TExtensionRequest extends { readonly id: string; readonly method: string } = ExtensionUiRequestDto,
> {
	private readonly identity: SessionLiveProjectionIdentity;
	private readonly limits: SessionLiveProjectionLimits;
	private readonly attachmentGuardContext: SessionAttachmentGuardContext | undefined;
	private readonly schema: SessionProjectionProductSchema<TMessage, TEvent, TExtensionRequest> | null;
	private readonly compactionOwner = Symbol("session-live-projection");
	private readonly compactionTokens = new WeakMap<object, { revision: number }>();
	private readonly preparedBatches = new WeakMap<object, PreparedBatchState<TEvent, TExtensionRequest>>();
	private readonly preparedCompactions = new WeakMap<object, PreparedCompactionState<TMessage>>();
	private revision = 0;
	private baseSeq: number;
	private asOfSeq: number;
	private settledMessages: readonly TMessage[];
	private settledMessageBytes: number;
	private projectionEvents: readonly SessionLiveProjectionEventFrame<TEvent>[] = [];
	private projectionEventFrameBytes: readonly number[] = [];
	private projectionEventBytes = 0;
	private queue: { readonly steering: readonly string[]; readonly followUp: readonly string[] } = {
		steering: [],
		followUp: [],
	};
	private pendingExtensionRequests = new Map<string, TExtensionRequest>();
	private runtimePhase: SessionLiveRuntimePhase;

	constructor(options: SessionLiveProjectionOptions<TMessage, TEvent, TExtensionRequest>) {
		assertIdentityShape(options.identity);
		assertSequence(options.baseSeq);
		this.identity = clone(options.identity);
		this.baseSeq = options.baseSeq;
		this.asOfSeq = options.baseSeq;
		this.runtimePhase = options.runtimePhase ?? "dormant";
		this.limits = normalizeLimits(options.limits);
		if (options.schema && options.attachmentGuardContext) {
			throw new SessionLiveProjectionPayloadError();
		}
		if (
			options.attachmentGuardContext !== undefined &&
			(!isSessionAttachmentGuardContext(options.attachmentGuardContext) ||
				options.attachmentGuardContext.serverEpoch !== options.identity.serverEpoch)
		) {
			throw new SessionLiveProjectionPayloadError();
		}
		this.attachmentGuardContext = options.attachmentGuardContext
			? clone(options.attachmentGuardContext)
			: undefined;
		if (
			options.schema?.serverEpoch !== undefined &&
			options.schema.serverEpoch !== options.identity.serverEpoch
		) {
			throw new SessionLiveProjectionPayloadError();
		}
		this.schema = options.schema ?? null;
		const settledMessages = clone(options.settledMessages ?? []);
		this.assertMessagesValid(settledMessages);
		this.assertSettledMessagesFit(settledMessages);
		this.settledMessages = settledMessages;
		this.settledMessageBytes = jsonBytes(settledMessages, "settled_messages");
		this.assertSnapshotFits({ settledMessageBytes: this.settledMessageBytes });
	}

	prepareCommit(
		identity: SessionLiveProjectionIdentity,
		input: SessionLiveProjectionInput<TEvent, TExtensionRequest>,
		runtimePhase?: SessionLiveRuntimePhase,
	): SessionLiveProjectionPreparedCommit {
		this.assertIdentity(identity);
		const nextSeq = this.asOfSeq + 1;
		if (!Number.isSafeInteger(nextSeq)) throw new SessionLiveProjectionLimitError("live_events");
		const token = deepFreeze({ nextSeq });
		this.prepareBatchCore([input], runtimePhase, token);
		return token;
	}

	commitPrepared(token: SessionLiveProjectionPreparedCommit): number | null {
		return this.commitPreparedBatchCore(token);
	}

	prepareBatch(
		identity: SessionLiveProjectionIdentity,
		inputs: readonly SessionLiveProjectionInput<TEvent, TExtensionRequest>[],
		runtimePhase?: SessionLiveRuntimePhase,
	): SessionLiveProjectionPreparedBatch {
		this.assertIdentity(identity);
		if (inputs.length === 0) throw new SessionLiveProjectionPayloadError();
		const firstSeq = this.asOfSeq + 1;
		const lastSeq = this.asOfSeq + inputs.length;
		if (!Number.isSafeInteger(firstSeq) || !Number.isSafeInteger(lastSeq)) {
			throw new SessionLiveProjectionLimitError("live_events");
		}
		const token = deepFreeze({ firstSeq, lastSeq, count: inputs.length });
		this.prepareBatchCore(inputs, runtimePhase, token);
		return token;
	}

	previewPreparedBatch(
		token: SessionLiveProjectionPreparedBatch,
	): SessionLiveProjectionSnapshot<TMessage, TEvent, TExtensionRequest> | null {
		const prepared = this.eligiblePreparedBatch(token);
		if (!prepared) return null;
		return this.snapshotCandidate(prepared.candidate);
	}

	commitPreparedBatch(token: SessionLiveProjectionPreparedBatch): number | null {
		return this.commitPreparedBatchCore(token);
	}

	/** Direct-commit seam for callers that do not transfer externalized payload ownership. */
	commitInlineOnly(
		identity: SessionLiveProjectionIdentity,
		input: SessionLiveProjectionInput<TEvent, TExtensionRequest>,
		runtimePhase?: SessionLiveRuntimePhase,
	): number {
		if (input.type === "event" && !isPiProductSessionEventDto(input.event)) {
			throw new SessionLiveProjectionPayloadError();
		}
		const committed = this.commitPrepared(this.prepareCommit(identity, input, runtimePhase));
		if (committed === null) throw new SessionLiveProjectionIdentityError();
		return committed;
	}

	setRuntimePhase(identity: SessionLiveProjectionIdentity, phase: SessionLiveRuntimePhase): void {
		this.assertIdentity(identity);
		this.assertSnapshotFits({ runtimePhase: phase });
		this.runtimePhase = phase;
		this.revision += 1;
	}

	/** O(1) waterline check for lifecycle fences that must not clone the projection. */
	isAtSeq(seq: number): boolean {
		return Number.isSafeInteger(seq) && seq >= 0 && this.asOfSeq === seq;
	}

	snapshot(): SessionLiveProjectionSnapshot<TMessage, TEvent, TExtensionRequest> {
		const value: SessionLiveProjectionSnapshot<TMessage, TEvent, TExtensionRequest> = {
			...this.identity,
			baseSeq: this.baseSeq,
			asOfSeq: this.asOfSeq,
			runtimePhase: this.snapshotRuntimePhase(),
			settledMessages: this.settledMessages,
			projectionEvents: this.projectionEvents,
			queue: this.queue,
			pendingExtensionRequests: [...this.pendingExtensionRequests.values()],
			stickyExtensionState: [],
		};
		return deepFreeze(clone(value));
	}

	beginIdleBaseCompaction(): SessionLiveProjectionCompactionToken | null {
		if (this.snapshotRuntimePhase() !== "idle") return null;
		const token = deepFreeze({
			...clone(this.identity),
			expectedAsOfSeq: this.asOfSeq,
			owner: this.compactionOwner,
		}) as InternalCompactionToken;
		this.compactionTokens.set(token, { revision: this.revision });
		return token;
	}

	shouldCompactIdleBase(): boolean {
		if (this.snapshotRuntimePhase() !== "idle") return false;
		const itemHighWater = Math.max(1, Math.floor(this.limits.maxLiveEventItems * 0.5));
		const byteHighWater = Math.max(1, Math.floor(this.maxLiveEventWireBytes() * 0.5));
		return this.projectionEvents.length >= itemHighWater || this.projectionEventBytes >= byteHighWater;
	}

	activeTurnBudget(): SessionLiveProjectionTurnBudget {
		return {
			maxItems: Math.max(1, Math.floor(this.limits.maxLiveEventItems * 0.5)),
			maxBytes: Math.max(1, Math.floor(this.maxLiveEventWireBytes() * 0.5)),
		};
	}

	activeTurnEventBytes(event: TEvent): number {
		return jsonBytes(
			{
				type: "event",
				...this.identity,
				seq: this.asOfSeq + 1,
				event,
			},
			"live_events",
		);
	}

	/** Logical contribution of one event; Runtime owns cross-event active-turn accumulation. */
	activeTurnEventLogicalBytes(event: TEvent): number {
		return this.schema?.activeTurnEventLogicalBytes(event) ?? 0;
	}

	/** Logical ceiling for Runtime-owned cross-event active-turn accumulation. */
	maxActiveTurnLogicalBytes(): number {
		return this.schema?.maxActiveTurnLogicalBytes ?? Number.MAX_SAFE_INTEGER;
	}

	needsIdleBaseCompactionBeforeTurn(): boolean {
		return !this.hasActiveTurnReservationCapacity({ pendingReservations: 1 });
	}

	hasActiveTurnReservationCapacity(input: {
		pendingReservations: number;
		activeTurnItems?: number;
		activeTurnBytes?: number;
		reserveActiveTurn?: boolean;
	}): boolean {
		if (!Number.isSafeInteger(input.pendingReservations) || input.pendingReservations < 0) return false;
		const budget = this.activeTurnBudget();
		const activeItems = input.reserveActiveTurn
			? Math.max(0, budget.maxItems - (input.activeTurnItems ?? 0))
			: 0;
		const activeBytes = input.reserveActiveTurn
			? Math.max(0, budget.maxBytes - (input.activeTurnBytes ?? 0))
			: 0;
		return (
			this.projectionEvents.length + input.pendingReservations * budget.maxItems + activeItems <=
				this.limits.maxLiveEventItems &&
			this.projectionEventBytes + input.pendingReservations * budget.maxBytes + activeBytes <=
				this.maxLiveEventWireBytes()
		);
	}

	/** Direct compaction seam for callers that do not transfer externalized payload ownership. */
	commitIdleBaseCompactionInlineOnly(
		token: SessionLiveProjectionCompactionToken,
		settledMessages: readonly TMessage[],
	): boolean {
		if (!settledMessages.every((message) => isPiSessionMessageDto(message))) {
			this.compactionTokens.delete(token);
			throw new SessionLiveProjectionPayloadError();
		}
		const prepared = this.prepareIdleBaseCompaction(token, settledMessages);
		return prepared !== null && this.commitPreparedIdleBaseCompaction(prepared);
	}

	prepareIdleBaseCompaction(
		token: SessionLiveProjectionCompactionToken,
		settledMessages: readonly TMessage[],
	): SessionLiveProjectionPreparedCompaction | null {
		const captured = this.compactionTokens.get(token);
		this.compactionTokens.delete(token);
		if (
			!captured ||
			(token as InternalCompactionToken).owner !== this.compactionOwner ||
			!sameIdentity(this.identity, token) ||
			captured.revision !== this.revision ||
			token.expectedAsOfSeq !== this.asOfSeq ||
			this.snapshotRuntimePhase() !== "idle"
		) {
			return null;
		}
		const candidate = clone(settledMessages);
		this.assertMessagesValid(candidate);
		this.assertSettledMessagesFit(candidate);
		const candidateBytes = jsonBytes(candidate, "settled_messages");
		this.assertSnapshotFits({
			baseSeq: this.asOfSeq,
			settledMessageBytes: candidateBytes,
			projectionEventBytes: 0,
			projectionEventCount: 0,
			runtimePhase: "idle",
		});
		const prepared = deepFreeze({ expectedAsOfSeq: this.asOfSeq });
		this.preparedCompactions.set(prepared, {
			revision: this.revision,
			settledMessages: candidate,
			settledMessageBytes: candidateBytes,
			baseSeq: this.asOfSeq,
		});
		return prepared;
	}

	commitPreparedIdleBaseCompaction(token: SessionLiveProjectionPreparedCompaction): boolean {
		const prepared = this.eligiblePreparedIdleBaseCompaction(token);
		if (!prepared) return false;
		this.preparedCompactions.delete(token);
		this.settledMessages = prepared.settledMessages;
		this.settledMessageBytes = prepared.settledMessageBytes;
		this.baseSeq = prepared.baseSeq;
		this.projectionEvents = [];
		this.projectionEventFrameBytes = [];
		this.projectionEventBytes = 0;
		this.revision += 1;
		return true;
	}

	previewPreparedIdleBaseCompaction(
		token: SessionLiveProjectionPreparedCompaction,
	): SessionLiveProjectionSnapshot<TMessage, TEvent, TExtensionRequest> | null {
		const prepared = this.eligiblePreparedIdleBaseCompaction(token);
		if (!prepared) return null;
		const candidate: SessionLiveProjectionSnapshot<TMessage, TEvent, TExtensionRequest> = {
			...this.identity,
			baseSeq: prepared.baseSeq,
			asOfSeq: this.asOfSeq,
			runtimePhase: this.snapshotRuntimePhase(),
			settledMessages: prepared.settledMessages,
			projectionEvents: [],
			queue: this.queue,
			pendingExtensionRequests: [...this.pendingExtensionRequests.values()],
			stickyExtensionState: [],
		};
		return deepFreeze(clone(candidate));
	}

	private eligiblePreparedIdleBaseCompaction(
		token: SessionLiveProjectionPreparedCompaction,
	): PreparedCompactionState<TMessage> | null {
		if (typeof token !== "object" || token === null) return null;
		const prepared = this.preparedCompactions.get(token);
		if (!prepared) return null;
		if (prepared.revision !== this.revision || prepared.baseSeq !== this.asOfSeq) {
			this.preparedCompactions.delete(token);
			return null;
		}
		return prepared;
	}

	private prepareBatchCore(
		inputs: readonly SessionLiveProjectionInput<TEvent, TExtensionRequest>[],
		runtimePhase: SessionLiveRuntimePhase | undefined,
		token: object,
	): void {
		let candidate: ProjectionCandidate<TEvent, TExtensionRequest> = {
			asOfSeq: this.asOfSeq,
			projectionEvents: this.projectionEvents,
			projectionEventFrameBytes: this.projectionEventFrameBytes,
			projectionEventBytes: this.projectionEventBytes,
			queue: this.queue,
			pendingExtensionRequests: this.pendingExtensionRequests,
			runtimePhase: this.runtimePhase,
		};
		for (const input of inputs) candidate = this.reduceCandidate(candidate, input, runtimePhase);
		this.preparedBatches.set(token, {
			revision: this.revision,
			firstSeq: this.asOfSeq + 1,
			lastSeq: candidate.asOfSeq,
			count: inputs.length,
			candidate,
		});
	}

	private reduceCandidate(
		candidate: ProjectionCandidate<TEvent, TExtensionRequest>,
		input: SessionLiveProjectionInput<TEvent, TExtensionRequest>,
		runtimePhase: SessionLiveRuntimePhase | undefined,
	): ProjectionCandidate<TEvent, TExtensionRequest> {
		const nextSeq = candidate.asOfSeq + 1;
		if (!Number.isSafeInteger(nextSeq)) throw new SessionLiveProjectionLimitError("live_events");
		const nextRuntimePhase = runtimePhase ?? candidate.runtimePhase;
		let projectionEvents = candidate.projectionEvents;
		let projectionEventFrameBytes = candidate.projectionEventFrameBytes;
		let projectionEventBytes = candidate.projectionEventBytes;
		let queue = candidate.queue;
		let pendingExtensionRequests = candidate.pendingExtensionRequests;

		if (input.type === "event") {
			const eventValue = clone(input.event);
			if (!this.guardEvent(eventValue)) throw new SessionLiveProjectionPayloadError();
			const frame: SessionLiveProjectionEventFrame<TEvent> = {
				type: "event",
				...this.identity,
				seq: nextSeq,
				event: eventValue,
			};
			const previousFrame = candidate.projectionEvents.at(-1);
			const mergedEvent =
				previousFrame?.seq === candidate.asOfSeq
					? this.schema
						? this.schema.mergeCompatibleDelta(previousFrame.event, eventValue)
						: mergeCompatibleDelta(previousFrame.event, eventValue, (value) => this.guardEvent(value))
					: null;
			const nextFrame = mergedEvent === null ? frame : { ...frame, event: mergedEvent };
			try {
				this.schema?.activeTurnEventLogicalBytes(nextFrame.event);
			} catch (error) {
				if (error instanceof SessionProductSchemaLogicalError) {
					throw new SessionLiveProjectionLimitError("live_events");
				}
				throw error;
			}
			const frameBytes = jsonBytes(nextFrame, "live_events");
			if (this.schema && frameBytes > this.schema.maxNormalizedEventWireBytes) {
				throw new SessionLiveProjectionLimitError("live_events");
			}
			const merging = mergedEvent !== null;
			const previousFrameBytes = merging ? (candidate.projectionEventFrameBytes.at(-1) ?? 0) : 0;
			const nextEventCount = candidate.projectionEvents.length + (merging ? 0 : 1);
			const nextEventBytes = candidate.projectionEventBytes - previousFrameBytes + frameBytes;
			if (nextEventCount > this.limits.maxLiveEventItems || nextEventBytes > this.maxLiveEventWireBytes()) {
				throw new SessionLiveProjectionLimitError("live_events");
			}
			const queueUpdate = this.schema ? this.schema.queueUpdate(eventValue) : currentQueueUpdate(eventValue);
			queue = queueUpdate
				? { steering: [...queueUpdate.steering], followUp: [...queueUpdate.followUp] }
				: candidate.queue;
			if (
				queue.steering.length > this.limits.maxQueueItems ||
				queue.followUp.length > this.limits.maxQueueItems
			) {
				throw new SessionLiveProjectionLimitError("queue");
			}
			projectionEvents = merging
				? [...candidate.projectionEvents.slice(0, -1), nextFrame]
				: [...candidate.projectionEvents, nextFrame];
			projectionEventFrameBytes = merging
				? [...candidate.projectionEventFrameBytes.slice(0, -1), frameBytes]
				: [...candidate.projectionEventFrameBytes, frameBytes];
			projectionEventBytes = nextEventBytes;
		} else if (input.type === "extension_ui_request") {
			const requestValue = clone(input.request);
			if (!this.guardExtensionRequest(requestValue)) {
				throw new SessionLiveProjectionPayloadError();
			}
			try {
				this.schema?.extensionRequestLogicalBytes(requestValue);
			} catch (error) {
				if (error instanceof SessionProductSchemaLogicalError) {
					throw new SessionLiveProjectionLimitError("extension_state");
				}
				throw error;
			}
			pendingExtensionRequests = new Map(candidate.pendingExtensionRequests);
			if (BLOCKING_EXTENSION_METHODS.has(requestValue.method)) {
				pendingExtensionRequests.delete(requestValue.id);
				pendingExtensionRequests.set(requestValue.id, requestValue);
			}
			this.assertExtensionStateFits(pendingExtensionRequests);
		} else {
			pendingExtensionRequests = new Map(candidate.pendingExtensionRequests);
			pendingExtensionRequests.delete(input.requestId);
		}

		this.assertSnapshotFits({
			asOfSeq: nextSeq,
			projectionEventBytes,
			projectionEventCount: projectionEvents.length,
			queue,
			pendingExtensionRequests,
			runtimePhase: nextRuntimePhase,
		});
		return {
			asOfSeq: nextSeq,
			projectionEvents,
			projectionEventFrameBytes,
			projectionEventBytes,
			queue,
			pendingExtensionRequests,
			runtimePhase: nextRuntimePhase,
		};
	}

	private eligiblePreparedBatch(token: object): PreparedBatchState<TEvent, TExtensionRequest> | null {
		if (typeof token !== "object" || token === null) return null;
		const prepared = this.preparedBatches.get(token);
		if (!prepared) return null;
		if (
			prepared.revision !== this.revision ||
			prepared.firstSeq !== this.asOfSeq + 1 ||
			prepared.lastSeq !== prepared.candidate.asOfSeq ||
			prepared.count !== prepared.lastSeq - prepared.firstSeq + 1
		) {
			this.preparedBatches.delete(token);
			return null;
		}
		return prepared;
	}

	private commitPreparedBatchCore(token: object): number | null {
		const prepared = this.eligiblePreparedBatch(token);
		if (!prepared) return null;
		this.preparedBatches.delete(token);
		const candidate = prepared.candidate;
		this.projectionEvents = candidate.projectionEvents;
		this.projectionEventFrameBytes = candidate.projectionEventFrameBytes;
		this.projectionEventBytes = candidate.projectionEventBytes;
		this.queue = candidate.queue;
		this.pendingExtensionRequests = candidate.pendingExtensionRequests;
		this.runtimePhase = candidate.runtimePhase;
		this.asOfSeq = candidate.asOfSeq;
		this.revision += 1;
		return candidate.asOfSeq;
	}

	private snapshotCandidate(
		candidate: ProjectionCandidate<TEvent, TExtensionRequest>,
	): SessionLiveProjectionSnapshot<TMessage, TEvent, TExtensionRequest> {
		const value: SessionLiveProjectionSnapshot<TMessage, TEvent, TExtensionRequest> = {
			...this.identity,
			baseSeq: this.baseSeq,
			asOfSeq: candidate.asOfSeq,
			runtimePhase: candidate.pendingExtensionRequests.size > 0 ? "waiting_ui" : candidate.runtimePhase,
			settledMessages: this.settledMessages,
			projectionEvents: candidate.projectionEvents,
			queue: candidate.queue,
			pendingExtensionRequests: [...candidate.pendingExtensionRequests.values()],
			stickyExtensionState: [],
		};
		return deepFreeze(clone(value));
	}

	private snapshotRuntimePhase(): SessionLiveRuntimePhase {
		return this.pendingExtensionRequests.size > 0 ? "waiting_ui" : this.runtimePhase;
	}

	private maxLiveEventWireBytes(): number {
		return this.schema
			? Math.min(this.limits.maxLiveEventBytes, this.schema.maxProjectionSuffixWireBytes)
			: this.limits.maxLiveEventBytes;
	}

	private assertIdentity(identity: SessionLiveProjectionIdentity): void {
		if (!sameIdentity(this.identity, identity)) throw new SessionLiveProjectionIdentityError();
	}

	private assertSettledMessagesFit(messages: readonly TMessage[]): void {
		if (
			messages.length > this.limits.maxSettledMessageItems ||
			jsonBytes(messages, "settled_messages") > this.limits.maxSettledMessageBytes
		) {
			throw new SessionLiveProjectionLimitError("settled_messages");
		}
	}

	private assertMessagesValid(messages: readonly TMessage[]): void {
		if (!messages.every((message) => this.guardMessage(message))) {
			throw new SessionLiveProjectionPayloadError();
		}
	}

	private guardMessage(value: unknown): boolean {
		return this.schema
			? this.schema.guardMessage(value)
			: isPiSessionMessageDto(value, this.attachmentGuardContext);
	}

	private guardEvent(value: unknown): value is TEvent {
		if (this.schema) return this.schema.guardEvent(value);
		return isPiProductSessionEventDto(value, this.attachmentGuardContext);
	}

	private guardExtensionRequest(value: unknown): value is TExtensionRequest {
		if (this.schema) return this.schema.guardExtensionRequest(value);
		return isPiExtensionUiRequestDto(value);
	}

	private assertSnapshotFits(
		overrides: {
			baseSeq?: number;
			asOfSeq?: number;
			runtimePhase?: SessionLiveRuntimePhase;
			settledMessageBytes?: number;
			projectionEventBytes?: number;
			projectionEventCount?: number;
			queue?: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
			pendingExtensionRequests?: ReadonlyMap<string, TExtensionRequest>;
		} = {},
	): void {
		const settledMessageBytes = overrides.settledMessageBytes ?? this.settledMessageBytes;
		const projectionEventBytes = overrides.projectionEventBytes ?? this.projectionEventBytes;
		const projectionEventCount = overrides.projectionEventCount ?? this.projectionEvents.length;
		const pending = [...(overrides.pendingExtensionRequests ?? this.pendingExtensionRequests).values()];
		const scaffoldBytes = jsonBytes(
			{
				...this.identity,
				baseSeq: overrides.baseSeq ?? this.baseSeq,
				asOfSeq: overrides.asOfSeq ?? this.asOfSeq,
				runtimePhase: pending.length > 0 ? "waiting_ui" : (overrides.runtimePhase ?? this.runtimePhase),
				settledMessages: [],
				projectionEvents: [],
				queue: overrides.queue ?? this.queue,
				pendingExtensionRequests: [],
				stickyExtensionState: [],
			},
			"snapshot",
		);
		const estimatedBytes =
			scaffoldBytes +
			serializedArrayContentsBytes(settledMessageBytes) +
			serializedItemsArrayContentsBytes(projectionEventBytes, projectionEventCount) +
			serializedArrayContentsBytes(jsonBytes(pending, "extension_state"));
		if (estimatedBytes > this.maxSnapshotWireBytes()) {
			throw new SessionLiveProjectionLimitError("snapshot");
		}
	}

	private maxSnapshotWireBytes(): number {
		return this.schema
			? Math.min(this.limits.maxSnapshotBytes, this.schema.maxSnapshotCanonicalWireBytes)
			: this.limits.maxSnapshotBytes;
	}

	private assertExtensionStateFits(pending: ReadonlyMap<string, TExtensionRequest>): void {
		const requests = [...pending.values()];
		if (
			requests.length > this.limits.maxExtensionItems ||
			jsonBytes(requests, "extension_state") > this.limits.maxExtensionBytes
		) {
			throw new SessionLiveProjectionLimitError("extension_state");
		}
	}
}

function sameIdentity(left: SessionLiveProjectionIdentity, right: SessionLiveProjectionIdentity): boolean {
	return (
		left.serverEpoch === right.serverEpoch &&
		left.sessionHandle === right.sessionHandle &&
		left.workspaceId === right.workspaceId &&
		left.generation === right.generation
	);
}

function assertIdentityShape(identity: SessionLiveProjectionIdentity): void {
	if (
		identity.serverEpoch.length === 0 ||
		identity.sessionHandle.length === 0 ||
		identity.workspaceId.length === 0 ||
		!Number.isSafeInteger(identity.generation) ||
		identity.generation < 0
	) {
		throw new SessionLiveProjectionIdentityError();
	}
}

function assertSequence(seq: number): void {
	if (!Number.isSafeInteger(seq) || seq < 0) throw new SessionLiveProjectionLimitError("live_events");
}

function normalizeLimits(
	overrides: Partial<SessionLiveProjectionLimits> | undefined,
): SessionLiveProjectionLimits {
	const limits = { ...DEFAULT_LIMITS, ...overrides };
	for (const value of Object.values(limits)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new SessionLiveProjectionLimitError("live_events");
		}
	}
	return limits;
}

function mergeCompatibleDelta<TEvent>(
	previous: TEvent,
	next: TEvent,
	guard: (value: unknown) => boolean,
): TEvent | null {
	const previousValue = clone(previous);
	const nextValue = clone(next);
	if (
		!isRecord(previousValue) ||
		!isRecord(nextValue) ||
		previousValue.type !== "message_update" ||
		nextValue.type !== "message_update" ||
		!isRecord(previousValue.assistantMessageEvent) ||
		!isRecord(nextValue.assistantMessageEvent)
	) {
		return null;
	}
	const previousDelta = previousValue.assistantMessageEvent;
	const nextDelta = nextValue.assistantMessageEvent;
	if (
		!isDeltaRecord(previousDelta) ||
		!isDeltaRecord(nextDelta) ||
		previousDelta.type !== nextDelta.type ||
		previousDelta.contentIndex !== nextDelta.contentIndex
	) {
		return null;
	}
	nextDelta.delta = previousDelta.delta + nextDelta.delta;
	return guard(nextValue) ? nextValue : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeltaRecord(
	value: Record<string, unknown>,
): value is Record<string, unknown> & { type: string; contentIndex: number; delta: string } {
	return (
		(value.type === "text_delta" || value.type === "thinking_delta" || value.type === "toolcall_delta") &&
		typeof value.contentIndex === "number" &&
		typeof value.delta === "string"
	);
}

function currentQueueUpdate(
	event: unknown,
): { readonly steering: readonly string[]; readonly followUp: readonly string[] } | null {
	if (!isRecord(event) || event.type !== "queue_update") return null;
	if (
		!Array.isArray(event.steering) ||
		!event.steering.every((item) => typeof item === "string") ||
		!Array.isArray(event.followUp) ||
		!event.followUp.every((item) => typeof item === "string")
	) {
		return null;
	}
	return { steering: event.steering, followUp: event.followUp };
}

function serializedArrayContentsBytes(serializedArrayBytes: number): number {
	return Math.max(0, serializedArrayBytes - 2);
}

function serializedItemsArrayContentsBytes(serializedItemBytes: number, itemCount: number): number {
	return itemCount === 0 ? 0 : serializedItemBytes + itemCount - 1;
}

function jsonBytes(value: unknown, boundary: SessionLiveProjectionLimitError["boundary"]): number {
	try {
		return Buffer.byteLength(JSON.stringify(value));
	} catch {
		throw new SessionLiveProjectionLimitError(boundary);
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value)) deepFreeze(child, seen);
	return Object.freeze(value);
}
