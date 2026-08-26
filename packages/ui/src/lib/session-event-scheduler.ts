import type { SessionEventDto } from "@pi-agent-web/protocol";

export const HIDDEN_SESSION_FLUSH_MS = 100;
export const MAX_PENDING_CHARACTERS_PER_SESSION = 256 * 1024;
export const MAX_PENDING_CHARACTERS_TOTAL = 1024 * 1024;
export const MAX_PENDING_REDUCER_EVENTS_PER_SESSION = 64;
export const MAX_PENDING_REDUCER_EVENTS_TOTAL = 512;

export type StreamMessageUpdate = Extract<SessionEventDto, { type: "message_update" }>;
type AssistantMessageDelta = Extract<
	StreamMessageUpdate["assistantMessageEvent"],
	{ type: "text_delta" | "thinking_delta" | "toolcall_delta" }
>;
export type CoalescibleMessageUpdate = Omit<StreamMessageUpdate, "assistantMessageEvent"> & {
	assistantMessageEvent: AssistantMessageDelta;
};
export type SessionEventEnqueueResult = "deferred" | "flushed" | "rejected";

interface DeltaDescriptor {
	type: "text_delta" | "thinking_delta" | "toolcall_delta";
	contentIndex: number;
	delta: string;
}

interface PendingRun {
	messageIdentity: string;
	event: CoalescibleMessageUpdate;
	sourceEvents: number;
	characters: number;
}

interface PendingSession {
	generation: number;
	runs: PendingRun[];
	sourceEvents: number;
	characters: number;
}

export interface SessionEventSchedulerMetrics {
	sourceEvents: number;
	reducerEvents: number;
	commits: number;
	mergedEvents: number;
	discardedEvents: number;
	forcedFlushes: number;
	maxPendingSessions: number;
	maxPendingSourceEvents: number;
	maxPendingReducerEvents: number;
	maxPendingCharacters: number;
}

export interface SessionEventSchedulerPendingSnapshot {
	sessions: number;
	sourceEvents: number;
	reducerEvents: number;
	characters: number;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface SessionEventSchedulerOptions {
	onFlush: (sessionHandle: string, generation: number, events: CoalescibleMessageUpdate[]) => void;
	isHidden?: () => boolean;
	requestFrame?: (callback: FrameRequestCallback) => number;
	cancelFrame?: (handle: number) => void;
	setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
	hiddenFlushMs?: number;
	maxCharactersPerSession?: number;
	maxCharactersTotal?: number;
	maxReducerEventsPerSession?: number;
	maxReducerEventsTotal?: number;
}

function describeDelta(event: StreamMessageUpdate): DeltaDescriptor | null {
	const inner = event.assistantMessageEvent;
	switch (inner.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return {
				type: inner.type,
				contentIndex: inner.contentIndex,
				delta: inner.delta,
			};
		default:
			return null;
	}
}

export function isCoalescibleMessageUpdate(event: SessionEventDto): event is CoalescibleMessageUpdate {
	return event.type === "message_update" && describeDelta(event) !== null;
}

function canMerge(
	run: PendingRun | undefined,
	messageIdentity: string,
	event: CoalescibleMessageUpdate,
): boolean {
	if (!run || run.messageIdentity !== messageIdentity) return false;
	const previous = describeDelta(run.event);
	const next = describeDelta(event);
	return (
		previous !== null &&
		next !== null &&
		previous.type === next.type &&
		previous.contentIndex === next.contentIndex
	);
}

function mergeRun(run: PendingRun, event: CoalescibleMessageUpdate, characters: number): void {
	const previous = describeDelta(run.event);
	const next = describeDelta(event);
	if (!previous || !next) return;
	run.event = {
		...event,
		assistantMessageEvent: {
			...event.assistantMessageEvent,
			delta: previous.delta + next.delta,
		},
	} as CoalescibleMessageUpdate;
	run.sourceEvents += 1;
	run.characters += characters;
}

function defaultRequestFrame(callback: FrameRequestCallback): number {
	if (typeof globalThis.requestAnimationFrame === "function") {
		return globalThis.requestAnimationFrame(callback);
	}
	return globalThis.setTimeout(() => callback(performance.now()), 16) as unknown as number;
}

function defaultCancelFrame(handle: number): void {
	if (typeof globalThis.cancelAnimationFrame === "function") {
		globalThis.cancelAnimationFrame(handle);
		return;
	}
	globalThis.clearTimeout(handle as unknown as TimerHandle);
}

/**
 * Coalesces only append-only assistant deltas. Structural events remain in the
 * caller's ordered path and must flush the matching Session before applying.
 * A visible page publishes on animation frames; a hidden page uses a bounded
 * timer so background Sessions cannot stall behind throttled rAF callbacks.
 */
export class SessionEventScheduler {
	private readonly onFlush: SessionEventSchedulerOptions["onFlush"];
	private readonly isHidden: () => boolean;
	private readonly requestFrame: (callback: FrameRequestCallback) => number;
	private readonly cancelFrame: (handle: number) => void;
	private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
	private readonly clearTimer: (handle: TimerHandle) => void;
	private readonly hiddenFlushMs: number;
	private readonly maxCharactersPerSession: number;
	private readonly maxCharactersTotal: number;
	private readonly maxReducerEventsPerSession: number;
	private readonly maxReducerEventsTotal: number;

	private readonly pending = new Map<string, PendingSession>();
	private pendingSourceEvents = 0;
	private pendingReducerEvents = 0;
	private pendingCharacters = 0;
	private frameHandle: number | null = null;
	private timerHandle: TimerHandle | null = null;
	private disposed = false;
	private readonly metrics: SessionEventSchedulerMetrics = {
		sourceEvents: 0,
		reducerEvents: 0,
		commits: 0,
		mergedEvents: 0,
		discardedEvents: 0,
		forcedFlushes: 0,
		maxPendingSessions: 0,
		maxPendingSourceEvents: 0,
		maxPendingReducerEvents: 0,
		maxPendingCharacters: 0,
	};

	constructor(options: SessionEventSchedulerOptions) {
		this.onFlush = options.onFlush;
		this.isHidden = options.isHidden ?? (() => typeof document !== "undefined" && document.hidden);
		this.requestFrame = options.requestFrame ?? defaultRequestFrame;
		this.cancelFrame = options.cancelFrame ?? defaultCancelFrame;
		this.setTimer = options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
		this.clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle));
		this.hiddenFlushMs = options.hiddenFlushMs ?? HIDDEN_SESSION_FLUSH_MS;
		this.maxCharactersPerSession = options.maxCharactersPerSession ?? MAX_PENDING_CHARACTERS_PER_SESSION;
		this.maxCharactersTotal = options.maxCharactersTotal ?? MAX_PENDING_CHARACTERS_TOTAL;
		this.maxReducerEventsPerSession =
			options.maxReducerEventsPerSession ?? MAX_PENDING_REDUCER_EVENTS_PER_SESSION;
		this.maxReducerEventsTotal = options.maxReducerEventsTotal ?? MAX_PENDING_REDUCER_EVENTS_TOTAL;
	}

	enqueue(
		sessionHandle: string,
		generation: number,
		messageIdentity: string,
		event: CoalescibleMessageUpdate,
	): SessionEventEnqueueResult {
		const delta = describeDelta(event);
		if (!delta) throw new Error("SessionEventScheduler accepts delta message_update events only");
		this.metrics.sourceEvents += 1;
		if (this.disposed) {
			this.metrics.discardedEvents += 1;
			return "rejected";
		}

		const stale = this.pending.get(sessionHandle);
		if (stale && stale.generation !== generation) this.discardSession(sessionHandle);

		const characters = delta.delta.length;
		if (
			characters > this.maxCharactersPerSession ||
			characters > this.maxCharactersTotal ||
			this.maxReducerEventsPerSession < 1 ||
			this.maxReducerEventsTotal < 1
		) {
			this.flushSession(sessionHandle, generation);
			this.metrics.forcedFlushes += 1;
			this.emitBatch(sessionHandle, generation, [event], 1);
			return "flushed";
		}

		let current = this.pending.get(sessionHandle);
		let mergeable = canMerge(current?.runs.at(-1), messageIdentity, event);
		if (current && current.characters + characters > this.maxCharactersPerSession) {
			this.metrics.forcedFlushes += 1;
			this.flushSession(sessionHandle, generation);
			current = undefined;
			mergeable = false;
		}
		if (this.pendingCharacters + characters > this.maxCharactersTotal) {
			this.metrics.forcedFlushes += 1;
			this.flushAll();
			current = undefined;
			mergeable = false;
		}
		if (current && !mergeable && current.runs.length >= this.maxReducerEventsPerSession) {
			this.metrics.forcedFlushes += 1;
			this.flushSession(sessionHandle, generation);
			current = undefined;
		}
		if (!mergeable && this.pendingReducerEvents >= this.maxReducerEventsTotal) {
			this.metrics.forcedFlushes += 1;
			this.flushAll();
			current = undefined;
		}

		const pending =
			current ?? ({ generation, runs: [], sourceEvents: 0, characters: 0 } satisfies PendingSession);
		if (!current) this.pending.set(sessionHandle, pending);
		const last = pending.runs.at(-1);
		if (canMerge(last, messageIdentity, event) && last) {
			mergeRun(last, event, characters);
		} else {
			pending.runs.push({ messageIdentity, event, sourceEvents: 1, characters });
			this.pendingReducerEvents += 1;
		}
		pending.sourceEvents += 1;
		pending.characters += characters;
		this.pendingSourceEvents += 1;
		this.pendingCharacters += characters;
		this.captureHighWaterMarks();
		this.schedule();
		return "deferred";
	}

	/** Flush one Session before any ordering-sensitive boundary. */
	flushSession(sessionHandle: string, generation?: number): void {
		const pending = this.pending.get(sessionHandle);
		if (!pending) return;
		if (generation !== undefined && pending.generation !== generation) {
			this.discardSession(sessionHandle);
			return;
		}
		this.removePending(sessionHandle, pending);
		this.emitBatch(
			sessionHandle,
			pending.generation,
			pending.runs.map((run) => run.event),
			pending.sourceEvents,
		);
	}

	/** Flush every Session once, preserving insertion order between Sessions. */
	flushAll(): void {
		if (this.pending.size === 0) {
			this.cancelSchedule();
			return;
		}
		const batches = [...this.pending.entries()];
		this.pending.clear();
		this.pendingSourceEvents = 0;
		this.pendingReducerEvents = 0;
		this.pendingCharacters = 0;
		this.cancelSchedule();

		let firstError: unknown;
		let failed = false;
		for (const [sessionHandle, pending] of batches) {
			try {
				this.emitBatch(
					sessionHandle,
					pending.generation,
					pending.runs.map((run) => run.event),
					pending.sourceEvents,
				);
			} catch (error) {
				if (!failed) firstError = error;
				failed = true;
			}
		}
		if (failed) throw firstError;
	}

	/** Drop stale data when a snapshot/generation transition becomes authoritative. */
	discardSession(sessionHandle: string): void {
		const pending = this.pending.get(sessionHandle);
		if (!pending) return;
		this.metrics.discardedEvents += pending.sourceEvents;
		this.removePending(sessionHandle, pending);
	}

	/** Re-select rAF vs timer when the document crosses a visibility boundary. */
	handleVisibilityChange(): void {
		if (this.disposed || this.pending.size === 0) return;
		this.cancelSchedule();
		this.schedule();
	}

	getMetrics(): SessionEventSchedulerMetrics {
		return { ...this.metrics };
	}

	getPendingSnapshot(): SessionEventSchedulerPendingSnapshot {
		return {
			sessions: this.pending.size,
			sourceEvents: this.pendingSourceEvents,
			reducerEvents: this.pendingReducerEvents,
			characters: this.pendingCharacters,
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelSchedule();
		for (const pending of this.pending.values()) {
			this.metrics.discardedEvents += pending.sourceEvents;
		}
		this.pending.clear();
		this.pendingSourceEvents = 0;
		this.pendingReducerEvents = 0;
		this.pendingCharacters = 0;
	}

	private schedule(): void {
		if (this.disposed || this.pending.size === 0 || this.frameHandle !== null || this.timerHandle !== null) {
			return;
		}
		if (this.isHidden()) {
			this.timerHandle = this.setTimer(() => {
				this.timerHandle = null;
				this.flushAll();
			}, this.hiddenFlushMs);
			return;
		}
		this.frameHandle = this.requestFrame(() => {
			this.frameHandle = null;
			this.flushAll();
		});
	}

	private cancelSchedule(): void {
		if (this.frameHandle !== null) {
			this.cancelFrame(this.frameHandle);
			this.frameHandle = null;
		}
		if (this.timerHandle !== null) {
			this.clearTimer(this.timerHandle);
			this.timerHandle = null;
		}
	}

	private removePending(sessionHandle: string, pending: PendingSession): void {
		this.pending.delete(sessionHandle);
		this.pendingSourceEvents -= pending.sourceEvents;
		this.pendingReducerEvents -= pending.runs.length;
		this.pendingCharacters -= pending.characters;
		if (this.pending.size === 0) this.cancelSchedule();
	}

	private emitBatch(
		sessionHandle: string,
		generation: number,
		events: CoalescibleMessageUpdate[],
		sourceEventCount: number,
	): void {
		if (events.length === 0) return;
		this.metrics.reducerEvents += events.length;
		this.metrics.commits += 1;
		this.metrics.mergedEvents += sourceEventCount - events.length;
		this.onFlush(sessionHandle, generation, events);
	}

	private captureHighWaterMarks(): void {
		this.metrics.maxPendingSessions = Math.max(this.metrics.maxPendingSessions, this.pending.size);
		this.metrics.maxPendingSourceEvents = Math.max(
			this.metrics.maxPendingSourceEvents,
			this.pendingSourceEvents,
		);
		this.metrics.maxPendingReducerEvents = Math.max(
			this.metrics.maxPendingReducerEvents,
			this.pendingReducerEvents,
		);
		this.metrics.maxPendingCharacters = Math.max(this.metrics.maxPendingCharacters, this.pendingCharacters);
	}
}
