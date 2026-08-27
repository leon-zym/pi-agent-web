import {
	type ExtensionUiRequestDto,
	isProductSessionEventDto,
	type ProductSessionEventDto,
	SESSION_SNAPSHOT_MAX_BYTES,
	SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS,
	SESSION_SNAPSHOT_MAX_MESSAGES,
	SESSION_SNAPSHOT_MAX_PROJECTION_EVENTS,
	SESSION_SNAPSHOT_MAX_QUEUE_ITEMS,
	type SessionMessageDto,
	type SessionProjectionEventDto,
} from "@pi-agent-web/protocol";

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

export interface SessionLiveProjectionOptions {
	identity: SessionLiveProjectionIdentity;
	settledMessages?: readonly SessionMessageDto[];
	baseSeq: number;
	runtimePhase?: SessionLiveRuntimePhase;
	limits?: Partial<SessionLiveProjectionLimits>;
}

export type SessionLiveProjectionInput =
	| { type: "event"; event: ProductSessionEventDto }
	| { type: "extension_ui_request"; request: ExtensionUiRequestDto }
	| {
			type: "extension_ui_closed";
			requestId: string;
			reason: "answered" | "cancelled" | "expired" | "process_lost" | "replaced";
	  };

export type SessionLiveProjectionEventFrame = SessionProjectionEventDto;

export interface SessionLiveProjectionSnapshot extends SessionLiveProjectionIdentity {
	baseSeq: number;
	asOfSeq: number;
	runtimePhase: SessionLiveRuntimePhase;
	settledMessages: readonly SessionMessageDto[];
	projectionEvents: readonly SessionLiveProjectionEventFrame[];
	queue: {
		readonly steering: readonly string[];
		readonly followUp: readonly string[];
	};
	pendingExtensionRequests: readonly ExtensionUiRequestDto[];
	stickyExtensionState: readonly ExtensionUiRequestDto[];
}

export interface SessionLiveProjectionCompactionToken extends SessionLiveProjectionIdentity {
	expectedAsOfSeq: number;
}

export interface SessionLiveProjectionTurnBudget {
	maxItems: number;
	maxBytes: number;
}

interface InternalCompactionToken extends SessionLiveProjectionCompactionToken {
	owner: symbol;
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

/**
 * Ephemeral product-domain Session projection.
 *
 * This deliberately stores a settled message base plus the ordered Pi event
 * suffix needed to reconstruct live state. It does not duplicate the UI's
 * ConversationProjection reducer and it never persists a second Session truth.
 */
export class SessionLiveProjection {
	private readonly identity: SessionLiveProjectionIdentity;
	private readonly limits: SessionLiveProjectionLimits;
	private readonly compactionOwner = Symbol("session-live-projection");
	private baseSeq: number;
	private asOfSeq: number;
	private settledMessages: readonly SessionMessageDto[];
	private settledMessageBytes: number;
	private projectionEvents: readonly SessionLiveProjectionEventFrame[] = [];
	private projectionEventFrameBytes: readonly number[] = [];
	private projectionEventBytes = 0;
	private queue: { readonly steering: readonly string[]; readonly followUp: readonly string[] } = {
		steering: [],
		followUp: [],
	};
	private pendingExtensionRequests = new Map<string, ExtensionUiRequestDto>();
	private runtimePhase: SessionLiveRuntimePhase;

	constructor(options: SessionLiveProjectionOptions) {
		assertIdentityShape(options.identity);
		assertSequence(options.baseSeq);
		this.identity = clone(options.identity);
		this.baseSeq = options.baseSeq;
		this.asOfSeq = options.baseSeq;
		this.runtimePhase = options.runtimePhase ?? "dormant";
		this.limits = normalizeLimits(options.limits);
		const settledMessages = clone(options.settledMessages ?? []);
		this.assertSettledMessagesFit(settledMessages);
		this.settledMessages = settledMessages;
		this.settledMessageBytes = jsonBytes(settledMessages, "settled_messages");
		this.assertSnapshotFits({ settledMessageBytes: this.settledMessageBytes });
	}

	commit(
		identity: SessionLiveProjectionIdentity,
		input: SessionLiveProjectionInput,
		runtimePhase?: SessionLiveRuntimePhase,
	): number {
		this.assertIdentity(identity);
		const nextSeq = this.asOfSeq + 1;
		if (!Number.isSafeInteger(nextSeq)) throw new SessionLiveProjectionLimitError("live_events");

		if (input.type === "event") {
			const eventValue = clone(input.event);
			const frame: SessionLiveProjectionEventFrame = {
				type: "event",
				...this.identity,
				seq: nextSeq,
				event: eventValue,
			};
			const previousFrame = this.projectionEvents.at(-1);
			const mergedEvent =
				previousFrame?.seq === this.asOfSeq ? mergeCompatibleDelta(previousFrame.event, eventValue) : null;
			const nextFrame = mergedEvent === null ? frame : { ...frame, event: mergedEvent };
			const frameBytes = jsonBytes(nextFrame, "live_events");
			const merging = mergedEvent !== null;
			const previousFrameBytes = merging ? (this.projectionEventFrameBytes.at(-1) ?? 0) : 0;
			const nextEventCount = this.projectionEvents.length + (merging ? 0 : 1);
			const nextEventBytes = this.projectionEventBytes - previousFrameBytes + frameBytes;
			if (nextEventCount > this.limits.maxLiveEventItems || nextEventBytes > this.limits.maxLiveEventBytes) {
				throw new SessionLiveProjectionLimitError("live_events");
			}
			const nextQueue =
				eventValue.type === "queue_update"
					? { steering: [...eventValue.steering], followUp: [...eventValue.followUp] }
					: this.queue;
			if (
				nextQueue.steering.length > this.limits.maxQueueItems ||
				nextQueue.followUp.length > this.limits.maxQueueItems
			) {
				throw new SessionLiveProjectionLimitError("queue");
			}
			this.assertSnapshotFits({
				asOfSeq: nextSeq,
				projectionEventBytes: nextEventBytes,
				projectionEventCount: nextEventCount,
				queue: nextQueue,
				runtimePhase: runtimePhase ?? this.runtimePhase,
			});
			this.projectionEvents = merging
				? [...this.projectionEvents.slice(0, -1), nextFrame]
				: [...this.projectionEvents, nextFrame];
			this.projectionEventFrameBytes = merging
				? [...this.projectionEventFrameBytes.slice(0, -1), frameBytes]
				: [...this.projectionEventFrameBytes, frameBytes];
			this.projectionEventBytes = nextEventBytes;
			this.queue = nextQueue;
		} else if (input.type === "extension_ui_request") {
			this.commitExtensionRequest(input.request, nextSeq, runtimePhase);
		} else {
			const pending = new Map(this.pendingExtensionRequests);
			pending.delete(input.requestId);
			this.assertSnapshotFits({
				asOfSeq: nextSeq,
				pendingExtensionRequests: pending,
				runtimePhase: pending.size > 0 ? "waiting_ui" : (runtimePhase ?? this.runtimePhase),
			});
			this.pendingExtensionRequests = pending;
		}

		this.asOfSeq = nextSeq;
		if (runtimePhase !== undefined) this.runtimePhase = runtimePhase;
		return nextSeq;
	}

	setRuntimePhase(identity: SessionLiveProjectionIdentity, phase: SessionLiveRuntimePhase): void {
		this.assertIdentity(identity);
		this.assertSnapshotFits({ runtimePhase: phase });
		this.runtimePhase = phase;
	}

	snapshot(): SessionLiveProjectionSnapshot {
		const value: SessionLiveProjectionSnapshot = {
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
		return deepFreeze({
			...clone(this.identity),
			expectedAsOfSeq: this.asOfSeq,
			owner: this.compactionOwner,
		}) as InternalCompactionToken;
	}

	shouldCompactIdleBase(): boolean {
		if (this.snapshotRuntimePhase() !== "idle") return false;
		const itemHighWater = Math.max(1, Math.floor(this.limits.maxLiveEventItems * 0.5));
		const byteHighWater = Math.max(1, Math.floor(this.limits.maxLiveEventBytes * 0.5));
		return this.projectionEvents.length >= itemHighWater || this.projectionEventBytes >= byteHighWater;
	}

	activeTurnBudget(): SessionLiveProjectionTurnBudget {
		return {
			maxItems: Math.max(1, Math.floor(this.limits.maxLiveEventItems * 0.5)),
			maxBytes: Math.max(1, Math.floor(this.limits.maxLiveEventBytes * 0.5)),
		};
	}

	activeTurnEventBytes(event: ProductSessionEventDto): number {
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
				this.limits.maxLiveEventBytes
		);
	}

	commitIdleBaseCompaction(
		token: SessionLiveProjectionCompactionToken,
		settledMessages: readonly SessionMessageDto[],
	): boolean {
		const internal = token as InternalCompactionToken;
		if (
			internal.owner !== this.compactionOwner ||
			!sameIdentity(this.identity, token) ||
			token.expectedAsOfSeq !== this.asOfSeq ||
			this.snapshotRuntimePhase() !== "idle"
		) {
			return false;
		}
		const candidate = clone(settledMessages);
		this.assertSettledMessagesFit(candidate);
		const candidateBytes = jsonBytes(candidate, "settled_messages");
		this.assertSnapshotFits({
			baseSeq: this.asOfSeq,
			settledMessageBytes: candidateBytes,
			projectionEventBytes: 0,
			projectionEventCount: 0,
			runtimePhase: "idle",
		});
		this.settledMessages = candidate;
		this.settledMessageBytes = candidateBytes;
		this.baseSeq = this.asOfSeq;
		this.projectionEvents = [];
		this.projectionEventFrameBytes = [];
		this.projectionEventBytes = 0;
		return true;
	}

	private commitExtensionRequest(
		request: ExtensionUiRequestDto,
		nextSeq: number,
		runtimePhase: SessionLiveRuntimePhase | undefined,
	): void {
		const requestValue = clone(request);
		const pending = new Map(this.pendingExtensionRequests);
		if (BLOCKING_EXTENSION_METHODS.has(requestValue.method)) {
			pending.delete(requestValue.id);
			pending.set(requestValue.id, requestValue);
		}
		this.assertExtensionStateFits(pending);
		this.assertSnapshotFits({
			asOfSeq: nextSeq,
			pendingExtensionRequests: pending,
			runtimePhase: pending.size > 0 ? "waiting_ui" : (runtimePhase ?? this.runtimePhase),
		});
		this.pendingExtensionRequests = pending;
	}

	private snapshotRuntimePhase(): SessionLiveRuntimePhase {
		return this.pendingExtensionRequests.size > 0 ? "waiting_ui" : this.runtimePhase;
	}

	private assertIdentity(identity: SessionLiveProjectionIdentity): void {
		if (!sameIdentity(this.identity, identity)) throw new SessionLiveProjectionIdentityError();
	}

	private assertSettledMessagesFit(messages: readonly SessionMessageDto[]): void {
		if (
			messages.length > this.limits.maxSettledMessageItems ||
			jsonBytes(messages, "settled_messages") > this.limits.maxSettledMessageBytes
		) {
			throw new SessionLiveProjectionLimitError("settled_messages");
		}
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
			pendingExtensionRequests?: ReadonlyMap<string, ExtensionUiRequestDto>;
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
		if (estimatedBytes > this.limits.maxSnapshotBytes) {
			throw new SessionLiveProjectionLimitError("snapshot");
		}
	}

	private assertExtensionStateFits(pending: ReadonlyMap<string, ExtensionUiRequestDto>): void {
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

function mergeCompatibleDelta(
	previous: ProductSessionEventDto,
	next: ProductSessionEventDto,
): ProductSessionEventDto | null {
	if (previous.type !== "message_update" || next.type !== "message_update") return null;
	const previousDelta = previous.assistantMessageEvent;
	const nextDelta = next.assistantMessageEvent;
	if (
		!isDeltaEvent(previousDelta) ||
		!isDeltaEvent(nextDelta) ||
		previousDelta.type !== nextDelta.type ||
		previousDelta.contentIndex !== nextDelta.contentIndex
	) {
		return null;
	}
	const merged: ProductSessionEventDto = {
		...next,
		assistantMessageEvent: {
			...nextDelta,
			delta: previousDelta.delta + nextDelta.delta,
		},
	};
	return isProductSessionEventDto(merged) ? merged : null;
}

type MessageUpdateEvent = Extract<ProductSessionEventDto, { type: "message_update" }>;
type MessageDeltaEvent = Extract<
	MessageUpdateEvent["assistantMessageEvent"],
	{ type: "text_delta" | "thinking_delta" | "toolcall_delta" }
>;

function isDeltaEvent(event: MessageUpdateEvent["assistantMessageEvent"]): event is MessageDeltaEvent {
	return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta";
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
