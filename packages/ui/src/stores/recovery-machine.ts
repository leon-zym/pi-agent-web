import type {
	HotRuntimeInventoryEntryDto,
	InlineSessionHistoryPageChunkDto,
	InlineSessionReplayFrameDto,
	InlineSessionSnapshotBeginDto,
	InlineSessionSnapshotChunkDto,
	InlineSessionSnapshotDto,
	SessionHistoryPageBeginDto,
	SessionHistoryPageChunkDto,
	SessionHistoryPageEndDto,
	SessionRuntimeIdentityDto,
	SessionSnapshotBeginDto,
	SessionSnapshotChunkDto,
	SessionSnapshotEndDto,
} from "@pi-agent-web/protocol";
import type { ProjectedSessionReplayFrame, ProjectedSessionSnapshot } from "../lib/session-content-adapter";
import type { SessionHistoryStreamAssembler } from "../lib/session-history-stream";
import {
	createSessionResyncCoordinator,
	type SessionResyncAttemptContext,
	type SessionResyncClock,
	type SessionResyncCompletion,
	type SessionResyncCoordinator,
} from "../lib/session-resync";
import type { HotRuntimeInventoryToken, SessionLazyIdentity } from "./session-transport-contract";

export type RecoveryReplayFrame =
	| { message: InlineSessionReplayFrameDto; representation: "wire" }
	| { message: ProjectedSessionReplayFrame; representation: "projected" };
export type BufferedReplayFrame = RecoveryReplayFrame;

export type RecoverySnapshotFrame =
	| { message: InlineSessionSnapshotDto; representation: "wire" }
	| { message: ProjectedSessionSnapshot; representation: "projected" };

export type HistorySnapshotBegin = InlineSessionSnapshotBeginDto | SessionSnapshotBeginDto;
export type HistorySnapshotChunk = InlineSessionSnapshotChunkDto | SessionSnapshotChunkDto;
export type HistoryPageChunk = InlineSessionHistoryPageChunkDto | SessionHistoryPageChunkDto;
export type CompletedHistorySnapshot = ReturnType<
	SessionHistoryStreamAssembler<
		unknown,
		HistorySnapshotBegin,
		HistorySnapshotChunk,
		SessionSnapshotEndDto
	>["end"]
>;

export interface SnapshotWaiter {
	token: number;
	identity: SessionRuntimeIdentityDto;
	resolve: (completion: SessionResyncCompletion) => void;
	reject: (error: Error) => void;
	promise: Promise<SessionResyncCompletion>;
	pendingCompletion?: {
		snapshotId: string;
		endpointSeq: number;
	};
}

export interface SnapshotHistoryAssembly {
	identity: SessionRuntimeIdentityDto;
	snapshotId: string;
	representation: "wire" | "projected";
	controller: AbortController;
	assembler: SessionHistoryStreamAssembler<
		unknown,
		HistorySnapshotBegin,
		HistorySnapshotChunk,
		SessionSnapshotEndDto
	>;
	waiterToken: number;
	finishing: boolean;
	completed: CompletedHistorySnapshot | null;
	completion?: Promise<CompletedHistorySnapshot>;
	resolveCompletion?: (completed: CompletedHistorySnapshot) => void;
	rejectCompletion?: (error: Error) => void;
}

export interface PageHistoryAssembly {
	identity: SessionRuntimeIdentityDto;
	requestId: string;
	representation: "wire" | "projected";
	controller: AbortController;
	assembler: SessionHistoryStreamAssembler<
		unknown,
		SessionHistoryPageBeginDto,
		HistoryPageChunk,
		SessionHistoryPageEndDto
	>;
	finishing: boolean;
}

export interface ProjectionTail {
	identity: SessionRuntimeIdentityDto;
	controller: AbortController;
	promise: Promise<void>;
	pendingReplayFrames: number;
	pendingReplayBytes: number;
	snapshotPending: boolean;
	snapshotWaiter: SnapshotWaiter | null;
}

export interface LazyIdentityScope {
	identity: SessionLazyIdentity;
	controller: AbortController;
	operations: Set<LazyOperation>;
}

export interface LazyOperation {
	scope: LazyIdentityScope;
	controller: AbortController;
	onIdentityAbort: () => void;
	callerSignal: AbortSignal | null;
	onCallerAbort: (() => void) | null;
}

export interface HistoryOperation {
	id: string;
	token: number;
	identity: SessionRuntimeIdentityDto;
	controller: AbortController;
	history: boolean;
	started: boolean;
}

export interface InitialInventoryWaiter {
	resolve: (token: HotRuntimeInventoryToken) => void;
	reject: (error: Error) => void;
}

export interface ActiveExactHotRecovery {
	identity: SessionRuntimeIdentityDto;
	baselineReady: boolean;
	leaseReady: boolean;
	recoveryStarted: boolean;
}

export interface SessionRecoveryEffects {
	commandMaterializations: Map<string, HistoryOperation>;
	snapshotWaiters: Map<string, SnapshotWaiter>;
	snapshotHistoryAssemblies: Map<string, SnapshotHistoryAssembly>;
	pageHistoryAssemblies: Map<string, PageHistoryAssembly>;
	projectionTails: Map<string, ProjectionTail>;
	lazyIdentityScopes: Map<string, LazyIdentityScope>;
	initialInventoryWaiters: Set<InitialInventoryWaiter>;
}

export function createSessionRecoveryEffects(): SessionRecoveryEffects {
	return {
		commandMaterializations: new Map(),
		snapshotWaiters: new Map(),
		snapshotHistoryAssemblies: new Map(),
		pageHistoryAssemblies: new Map(),
		projectionTails: new Map(),
		lazyIdentityScopes: new Map(),
		initialInventoryWaiters: new Set(),
	};
}

export interface SessionRecoveryMachineState {
	resyncBuffers: ReadonlyMap<string, readonly RecoveryReplayFrame[]>;
	resyncBufferBytes: ReadonlyMap<string, number>;
	skipNextResubscribe: ReadonlySet<string>;
	pendingOverflowRestarts: ReadonlyMap<string, SessionRuntimeIdentityDto>;
	baselineRefreshes: ReadonlySet<string>;
	connectionObservations: ReadonlyMap<string, SessionRuntimeIdentityDto>;
	hotRuntimeRevision: number;
	hotRuntimeByHandle: ReadonlyMap<string, HotRuntimeInventoryEntryDto>;
	exactHotRecoveryQueue: readonly string[];
	queuedExactHotRecoveries: ReadonlySet<string>;
	activeExactHotRecovery: ActiveExactHotRecovery | null;
}

interface MutableSessionRecoveryMachineState {
	resyncBuffers: Map<string, readonly RecoveryReplayFrame[]>;
	resyncBufferBytes: Map<string, number>;
	skipNextResubscribe: Set<string>;
	pendingOverflowRestarts: Map<string, SessionRuntimeIdentityDto>;
	baselineRefreshes: Set<string>;
	connectionObservations: Map<string, SessionRuntimeIdentityDto>;
	hotRuntimeRevision: number;
	hotRuntimeByHandle: Map<string, HotRuntimeInventoryEntryDto>;
	exactHotRecoveryQueue: string[];
	queuedExactHotRecoveries: Set<string>;
	activeExactHotRecovery: ActiveExactHotRecovery | null;
}

export type SessionRecoveryMachineEvent =
	| {
			type: "buffer_replay";
			key: string;
			frame: RecoveryReplayFrame;
			maxFrames: number;
			maxBytes: number;
	  }
	| { type: "replace_replay_buffer"; key: string; frames: readonly RecoveryReplayFrame[] }
	| { type: "clear_identity"; key: string }
	| { type: "clear_session"; sessionHandle: string }
	| { type: "skip_resubscribe"; key: string }
	| { type: "consume_skip_resubscribe"; key: string }
	| { type: "set_pending_overflow_restart"; sessionHandle: string; identity: SessionRuntimeIdentityDto }
	| { type: "clear_pending_overflow_restart"; sessionHandle: string }
	| { type: "set_baseline_refresh"; sessionHandle: string }
	| { type: "clear_baseline_refresh"; sessionHandle: string }
	| { type: "set_connection_observation"; sessionHandle: string; identity: SessionRuntimeIdentityDto }
	| { type: "clear_connection_observation"; sessionHandle: string }
	| { type: "set_hot_inventory"; revision: number; runtimes: readonly HotRuntimeInventoryEntryDto[] }
	| { type: "reset_hot_inventory" }
	| { type: "queue_exact_hot"; sessionHandle: string }
	| { type: "dequeue_exact_hot"; sessionHandle: string }
	| { type: "set_active_exact_hot"; active: ActiveExactHotRecovery | null }
	| { type: "advance_exact_hot"; identity: SessionRuntimeIdentityDto; kind: "baseline" | "lease" }
	| { type: "cancel_exact_hot"; sessionHandle: string }
	| { type: "rekey"; previousSessionHandle: string; sessionHandle: string }
	| { type: "reset_connection" }
	| { type: "reset" };

export type SessionRecoveryMachineIntent =
	| { type: "replay_buffered"; key: string; frames: readonly RecoveryReplayFrame[] }
	| { type: "replay_overflow"; frame: RecoveryReplayFrame }
	| { type: "hot_inventory_accepted"; previous: ReadonlyMap<string, HotRuntimeInventoryEntryDto> }
	| { type: "exact_hot_advanced"; identity: SessionRuntimeIdentityDto }
	| { type: "exact_hot_cancelled"; sessionHandle: string };

export interface SessionRecoveryMachineTransition {
	state: SessionRecoveryMachineState;
	intents: SessionRecoveryMachineIntent[];
	accepted?: boolean;
	result?: "buffered" | "duplicate" | "overflow";
}

const initialState: SessionRecoveryMachineState = {
	resyncBuffers: new Map(),
	resyncBufferBytes: new Map(),
	skipNextResubscribe: new Set(),
	pendingOverflowRestarts: new Map(),
	baselineRefreshes: new Set(),
	connectionObservations: new Map(),
	hotRuntimeRevision: -1,
	hotRuntimeByHandle: new Map(),
	exactHotRecoveryQueue: [],
	queuedExactHotRecoveries: new Set(),
	activeExactHotRecovery: null,
};

function identityMatches(left: SessionRuntimeIdentityDto, right: SessionRuntimeIdentityDto): boolean {
	return (
		left.serverEpoch === right.serverEpoch &&
		left.workspaceId === right.workspaceId &&
		left.sessionHandle === right.sessionHandle &&
		left.generation === right.generation
	);
}

function removeSessionHandle(handles: readonly string[], sessionHandle: string): string[] {
	return handles.filter((candidate) => candidate !== sessionHandle);
}

function cloneState(state: SessionRecoveryMachineState): MutableSessionRecoveryMachineState {
	return {
		...state,
		resyncBuffers: new Map(state.resyncBuffers),
		resyncBufferBytes: new Map(state.resyncBufferBytes),
		skipNextResubscribe: new Set(state.skipNextResubscribe),
		pendingOverflowRestarts: new Map(state.pendingOverflowRestarts),
		baselineRefreshes: new Set(state.baselineRefreshes),
		connectionObservations: new Map(state.connectionObservations),
		hotRuntimeByHandle: new Map(state.hotRuntimeByHandle),
		exactHotRecoveryQueue: [...state.exactHotRecoveryQueue],
		queuedExactHotRecoveries: new Set(state.queuedExactHotRecoveries),
		activeExactHotRecovery: state.activeExactHotRecovery
			? { ...state.activeExactHotRecovery, identity: { ...state.activeExactHotRecovery.identity } }
			: null,
	};
}

export function reduceSessionRecoveryMachine(
	state: SessionRecoveryMachineState,
	event: SessionRecoveryMachineEvent,
): SessionRecoveryMachineTransition {
	const next = cloneState(state);
	const intents: SessionRecoveryMachineIntent[] = [];
	switch (event.type) {
		case "buffer_replay": {
			const current = next.resyncBuffers.get(event.key) ?? [];
			if (
				current.some(
					(candidate) =>
						candidate.message.generation === event.frame.message.generation &&
						candidate.message.seq === event.frame.message.seq,
				)
			) {
				return { state, intents, result: "duplicate", accepted: false };
			}
			const bytes = serializedBytes(event.frame.message);
			const nextBytes = (next.resyncBufferBytes.get(event.key) ?? 0) + bytes;
			if (current.length >= event.maxFrames || nextBytes > event.maxBytes) {
				intents.push({ type: "replay_overflow", frame: event.frame });
				return { state, intents, result: "overflow", accepted: false };
			}
			const frames = [...current, event.frame].sort((left, right) => left.message.seq - right.message.seq);
			next.resyncBuffers.set(event.key, frames);
			next.resyncBufferBytes.set(event.key, nextBytes);
			intents.push({ type: "replay_buffered", key: event.key, frames });
			return { state: next, intents, result: "buffered", accepted: true };
		}
		case "replace_replay_buffer": {
			const frames = [...event.frames].sort((left, right) => left.message.seq - right.message.seq);
			if (frames.length === 0) {
				next.resyncBuffers.delete(event.key);
				next.resyncBufferBytes.delete(event.key);
			} else {
				next.resyncBuffers.set(event.key, frames);
				next.resyncBufferBytes.set(
					event.key,
					frames.reduce((total, frame) => total + serializedBytes(frame.message), 0),
				);
			}
			return { state: next, intents };
		}
		case "clear_identity":
			next.resyncBuffers.delete(event.key);
			next.resyncBufferBytes.delete(event.key);
			next.skipNextResubscribe.delete(event.key);
			return { state: next, intents };
		case "clear_session":
			for (const [key, frames] of next.resyncBuffers) {
				if (frames[0]?.message.sessionHandle !== event.sessionHandle) continue;
				next.resyncBuffers.delete(key);
				next.resyncBufferBytes.delete(key);
				next.skipNextResubscribe.delete(key);
			}
			next.pendingOverflowRestarts.delete(event.sessionHandle);
			next.baselineRefreshes.delete(event.sessionHandle);
			next.connectionObservations.delete(event.sessionHandle);
			next.exactHotRecoveryQueue = removeSessionHandle(next.exactHotRecoveryQueue, event.sessionHandle);
			next.queuedExactHotRecoveries.delete(event.sessionHandle);
			if (next.activeExactHotRecovery?.identity.sessionHandle === event.sessionHandle) {
				next.activeExactHotRecovery = null;
			}
			return { state: next, intents };
		case "skip_resubscribe":
			next.skipNextResubscribe.add(event.key);
			return { state: next, intents };
		case "consume_skip_resubscribe": {
			const accepted = next.skipNextResubscribe.delete(event.key);
			return { state: next, intents, accepted };
		}
		case "set_pending_overflow_restart":
			next.pendingOverflowRestarts.set(event.sessionHandle, event.identity);
			return { state: next, intents };
		case "clear_pending_overflow_restart":
			next.pendingOverflowRestarts.delete(event.sessionHandle);
			return { state: next, intents };
		case "set_baseline_refresh":
			next.baselineRefreshes.add(event.sessionHandle);
			return { state: next, intents };
		case "clear_baseline_refresh":
			next.baselineRefreshes.delete(event.sessionHandle);
			return { state: next, intents };
		case "set_connection_observation":
			next.connectionObservations.set(event.sessionHandle, event.identity);
			return { state: next, intents };
		case "clear_connection_observation":
			next.connectionObservations.delete(event.sessionHandle);
			return { state: next, intents };
		case "set_hot_inventory": {
			if (event.revision <= state.hotRuntimeRevision) return { state, intents, accepted: false };
			const previous = state.hotRuntimeByHandle;
			next.hotRuntimeRevision = event.revision;
			next.hotRuntimeByHandle = new Map(event.runtimes.map((runtime) => [runtime.sessionHandle, runtime]));
			intents.push({ type: "hot_inventory_accepted", previous });
			return { state: next, intents, accepted: true };
		}
		case "reset_hot_inventory":
			next.hotRuntimeRevision = -1;
			next.hotRuntimeByHandle = new Map();
			return { state: next, intents };
		case "queue_exact_hot":
			if (next.queuedExactHotRecoveries.has(event.sessionHandle)) return { state, intents, accepted: false };
			next.queuedExactHotRecoveries.add(event.sessionHandle);
			next.exactHotRecoveryQueue.push(event.sessionHandle);
			return { state: next, intents, accepted: true };
		case "dequeue_exact_hot":
			next.queuedExactHotRecoveries.delete(event.sessionHandle);
			next.exactHotRecoveryQueue = removeSessionHandle(next.exactHotRecoveryQueue, event.sessionHandle);
			return { state: next, intents };
		case "set_active_exact_hot":
			next.activeExactHotRecovery = event.active
				? { ...event.active, identity: { ...event.active.identity } }
				: null;
			return { state: next, intents };
		case "advance_exact_hot": {
			const active = next.activeExactHotRecovery;
			if (!active || !identityMatches(active.identity, event.identity))
				return { state, intents, accepted: false };
			const updated = { ...active, [event.kind === "baseline" ? "baselineReady" : "leaseReady"]: true };
			if (!updated.baselineReady || !updated.leaseReady) {
				next.activeExactHotRecovery = updated;
				return { state: next, intents, accepted: true };
			}
			next.activeExactHotRecovery = null;
			intents.push({ type: "exact_hot_advanced", identity: event.identity });
			return { state: next, intents, accepted: true };
		}
		case "cancel_exact_hot": {
			const wasActive = next.activeExactHotRecovery?.identity.sessionHandle === event.sessionHandle;
			next.exactHotRecoveryQueue = removeSessionHandle(next.exactHotRecoveryQueue, event.sessionHandle);
			next.queuedExactHotRecoveries.delete(event.sessionHandle);
			if (wasActive) next.activeExactHotRecovery = null;
			if (wasActive || state.queuedExactHotRecoveries.has(event.sessionHandle)) {
				intents.push({ type: "exact_hot_cancelled", sessionHandle: event.sessionHandle });
			}
			return {
				state: next,
				intents,
				accepted: wasActive || state.queuedExactHotRecoveries.has(event.sessionHandle),
			};
		}
		case "rekey": {
			const previous = reduceSessionRecoveryMachine(state, {
				type: "clear_session",
				sessionHandle: event.previousSessionHandle,
			});
			const current = reduceSessionRecoveryMachine(previous.state, {
				type: "clear_session",
				sessionHandle: event.sessionHandle,
			});
			return {
				state: current.state,
				intents: [...previous.intents, ...current.intents],
			};
		}
		case "reset_connection":
			next.pendingOverflowRestarts = new Map();
			next.baselineRefreshes = new Set();
			next.connectionObservations = new Map();
			next.hotRuntimeRevision = -1;
			next.hotRuntimeByHandle = new Map();
			next.exactHotRecoveryQueue = [];
			next.queuedExactHotRecoveries = new Set();
			next.activeExactHotRecovery = null;
			return { state: next, intents };
		case "reset":
			return { state: initialState, intents };
	}
}

function serializedBytes(value: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

export interface SessionRecoveryMachineOptions {
	attemptResync: (
		context: SessionResyncAttemptContext,
	) => Promise<SessionResyncCompletion> | SessionResyncCompletion;
	resyncClock?: SessionResyncClock;
	resyncRandom?: () => number;
	onRecovered?: (completion: SessionResyncCompletion) => void;
}

export interface SessionRecoveryMachine {
	effects: SessionRecoveryEffects;
	resync: SessionResyncCoordinator;
	getState: () => SessionRecoveryMachineState;
	transition: (event: SessionRecoveryMachineEvent) => SessionRecoveryMachineTransition;
}

export function createSessionRecoveryMachine(
	options: SessionRecoveryMachineOptions,
	initial: SessionRecoveryMachineState = initialState,
): SessionRecoveryMachine {
	let state = initial;
	const effects = createSessionRecoveryEffects();
	const resync = createSessionResyncCoordinator({
		attempt: options.attemptResync,
		clock: options.resyncClock,
		random: options.resyncRandom,
		onRecovered: options.onRecovered,
	});
	return {
		effects,
		resync,
		getState: () => state,
		transition: (event) => {
			const transition = reduceSessionRecoveryMachine(state, event);
			state = transition.state;
			return transition;
		},
	};
}
