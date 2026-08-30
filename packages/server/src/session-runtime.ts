import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionUiRequestDto,
	ExtensionUiResponseDto,
	HotRuntimeInventoryEntryDto,
	PiExtensionUiRequestDto,
	PiSessionCommandResponseDto,
	ProductSessionEventDto,
	SessionCommandDto,
	SessionCommandResponseDto,
	SessionMessageDto,
	SessionRuntimeBusyReasonDto,
	SessionRuntimePhaseDto,
	SessionSnapshotDto,
	SessionStateDto,
} from "@pi-agent-web/protocol";
import {
	analyzeSessionCommandResponseLogicalBytes,
	commandTimeoutMs,
	RpcError,
	SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS,
	sessionHistoryMessagesBytes,
} from "@pi-agent-web/protocol";
import type { EpochContentHold, EpochStoredContentRef } from "./epoch-content-store.js";
import { GenerationContentOwner } from "./generation-content-owner.js";
import { canonicalizeSessionFile, sessionHandleForCanonicalFile } from "./native-session-catalog.js";
import type { PiHostPayloadExternalizer } from "./pi-host-adapter.js";
import type { PiPayloadLease, PiPayloadLeaseTransfer } from "./pi-payload-externalizer.js";
import type {
	PiDecodedDelivery,
	PiDecodedDeliveryConsumer,
	PiDecodedDeliveryPlan,
	PiProcessExitInfo,
	PiProcessOptions,
} from "./pi-process.js";
import { PiProcess } from "./pi-process.js";
import type { ProbedPiRuntime } from "./resolver.js";
import {
	type NativeSessionHistoryPlan,
	SessionHistoryError,
	scanNativeSessionHistory,
} from "./session-history-reader.js";
import { canonicalizePathAllowMissing } from "./session-layout-resolver.js";
import {
	SessionLiveProjection,
	type SessionLiveProjectionIdentity,
	SessionLiveProjectionLimitError,
	type SessionLiveProjectionLimits,
	type SessionLiveProjectionPreparedBatch,
	type SessionLiveProjectionPreparedCommit,
	type SessionLiveProjectionSnapshot,
} from "./session-live-projection.js";
import { type SessionProductSchema, SessionProductSchemaLogicalError } from "./session-product-schema.js";
import {
	type ExistingSessionTarget,
	eventSettlesWork,
	eventStartsWork,
	type ReplayCursor,
	type ReplayResult,
	type SessionChunkedSnapshot,
	type SessionHistoryPageResult,
	type SessionReplayFrame,
	type SessionRuntimeSnapshot,
	type SessionSupervisorMessage,
	type SessionTarget,
} from "./session-runtime-types.js";
import { TransitionPayloadLedger } from "./transition-payload-ledger.js";

const BLOCKING_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const STICKY_EXTENSION_METHODS = new Set(["setStatus", "setWidget", "setTitle", "set_editor_text"]);
const DEFAULT_REPLAY_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TRANSIENT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_EXTENSION_STATE_MAX_BYTES = 512 * 1024;
const DEFAULT_EXTENSION_STATE_MAX_ITEMS = SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS;
const DEFAULT_PENDING_DIALOG_LIMIT = 32;
const DEFAULT_MAX_PENDING_COMMANDS = 32;

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

type BufferedFrame<TEvent = ProductSessionEventDto, TExtensionRequest = ExtensionUiRequestDto> =
	| { type: "event"; event: TEvent }
	| { type: "extension_ui_request"; request: TExtensionRequest }
	| {
			type: "extension_ui_closed";
			requestId: string;
			reason: "answered" | "cancelled" | "expired" | "process_lost" | "replaced";
	  };

interface PendingDialog<TExtensionRequest = ExtensionUiRequestDto> {
	request: TExtensionRequest;
	timer: NodeJS.Timeout | null;
}

interface PendingTurnReservation {
	id: bigint;
	generation: number;
	processToken: number;
	timer: NodeJS.Timeout | null;
}

interface TransitionStage<
	TEvent = ProductSessionEventDto,
	TExtensionRequest = ExtensionUiRequestDto,
	TRef extends EpochStoredContentRef = EpochStoredContentRef,
> {
	phase: "awaiting_response" | "verifying" | "applying";
	frames: BufferedFrame<TEvent, TExtensionRequest>[];
	bytes: number;
	processToken: number;
	parentGeneration: number;
	parentOwner: GenerationContentOwner<TRef> | null;
	payloadLedger: TransitionPayloadLedger<TRef> | null;
	candidateOwner: GenerationContentOwner<TRef> | null;
	candidateOwnerFailure: unknown;
}

interface FrozenSessionFileIdentity {
	sessionFile: string;
	dev: bigint;
	ino: bigint;
	nativeSessionId: string;
	cwd: string;
}

interface PreparedActiveEventPublication<
	TMessage,
	TEvent,
	TExtensionRequest extends { readonly id: string; readonly method: string },
> {
	projection: SessionLiveProjection<TMessage, TEvent, TExtensionRequest>;
	token: SessionLiveProjectionPreparedCommit;
	frame: Extract<BufferedFrame<TEvent, TExtensionRequest>, { type: "event" }>;
	envelope: SessionReplayFrame<TEvent, TExtensionRequest>;
	turnBudget: { items: number; bytes: number; logicalBytes: number };
	replay: SessionReplayFrame<TEvent, TExtensionRequest>[];
	replayFrameBytes: number[];
	replayBytes: number;
}

interface PreparedExtensionSemanticOperation<
	TMessage,
	TEvent,
	TExtensionRequest extends { readonly id: string; readonly method: string },
> {
	projection: SessionLiveProjection<TMessage, TEvent, TExtensionRequest>;
	token: SessionLiveProjectionPreparedBatch;
	semanticRevision: number;
	envelopes: readonly SessionReplayFrame<TEvent, TExtensionRequest>[];
	replay: SessionReplayFrame<TEvent, TExtensionRequest>[];
	replayFrameBytes: number[];
	replayBytes: number;
	lastTransientSeq: number;
	pendingDialogs: Map<string, PendingDialog<TExtensionRequest>>;
	stickyExtension: Map<string, TExtensionRequest>;
	timersToClear: readonly PendingDialog<TExtensionRequest>[];
	timersToArm: readonly PendingDialog<TExtensionRequest>[];
	processToken: number;
	warnOversizedSticky: boolean;
}

interface ExtensionSemanticPlan<TEvent, TExtensionRequest> {
	frames: readonly BufferedFrame<TEvent, TExtensionRequest>[];
	pendingDialogs: Map<string, PendingDialog<TExtensionRequest>>;
	stickyExtension: Map<string, TExtensionRequest>;
	timersToClear: readonly PendingDialog<TExtensionRequest>[];
	timersToArm: readonly PendingDialog<TExtensionRequest>[];
	warnOversizedSticky: boolean;
}

interface PreparedStartupExtensionOperation<TEvent, TExtensionRequest>
	extends ExtensionSemanticPlan<TEvent, TExtensionRequest> {
	processToken: number;
	semanticRevision: number;
	startupFrameCount: number;
	startupFrameBytesBefore: number;
	startupFrames: BufferedFrame<TEvent, TExtensionRequest>[];
	startupFrameBytes: number;
}

export interface SessionIdentityTransitionCommit<
	TEvent = ProductSessionEventDto,
	TExtensionRequest = ExtensionUiRequestDto,
> {
	previousSessionHandle: string;
	nextTarget: ExistingSessionTarget;
	/** Apply the verified identity exactly once while the Supervisor pool lock is held. */
	apply: () => void;
	/** Commit staged child frames to one waterline before the rekey becomes observable. */
	commitStaged: () => SessionSupervisorMessage<TEvent, TExtensionRequest>[];
}

export interface SessionHotRuntimeObservation {
	entry: HotRuntimeInventoryEntryDto;
	processToken: number;
}

type SessionRuntimePiProcessOptions = Omit<
	PiProcessOptions,
	| "payloadExternalizer"
	| "onDecodedEvent"
	| "onDecodedExtensionUiRequest"
	| "onEvent"
	| "onExtensionUiRequest"
>;

export interface RuntimeProductMap {
	content_ref: {
		message: SessionMessageDto;
		event: ProductSessionEventDto;
		response: SessionCommandResponseDto;
		snapshot: SessionSnapshotDto;
		ref: EpochStoredContentRef;
		externalizer: PiHostPayloadExternalizer;
		extensionRequest: ExtensionUiRequestDto;
	};
}

export type SessionRuntimeProductMode = keyof RuntimeProductMap;
type RuntimeMessage<M extends SessionRuntimeProductMode> = RuntimeProductMap[M]["message"];
type RuntimeEvent<M extends SessionRuntimeProductMode> = RuntimeProductMap[M]["event"];
type RuntimeResponse<M extends SessionRuntimeProductMode> = RuntimeProductMap[M]["response"];
type RuntimeSnapshot<M extends SessionRuntimeProductMode> = RuntimeProductMap[M]["snapshot"];
type RuntimeRef<M extends SessionRuntimeProductMode> = RuntimeProductMap[M]["ref"];
type RuntimeExternalizer<M extends SessionRuntimeProductMode> = RuntimeProductMap[M]["externalizer"];
type RuntimeExtensionRequest<M extends SessionRuntimeProductMode> = RuntimeProductMap[M]["extensionRequest"];

export interface SessionRuntimePayloadCustody<M extends SessionRuntimeProductMode> {
	readonly externalizer: RuntimeExternalizer<M>;
	readonly releaseHold: (hold: EpochContentHold<RuntimeRef<M>>) => Promise<void>;
}

export interface SessionRuntimePiPayloadServices<M extends SessionRuntimeProductMode = "content_ref">
	extends SessionRuntimePayloadCustody<M> {
	readonly mode: M;
	readonly productSchema: SessionProductSchema<
		RuntimeMessage<M>,
		RuntimeEvent<M>,
		RuntimeSnapshot<M>,
		RuntimeExtensionRequest<M>
	>;
}

export type SessionRuntimeProductEvent<M extends SessionRuntimeProductMode> = RuntimeEvent<M>;
export type SessionRuntimeProductExtensionRequest<M extends SessionRuntimeProductMode> =
	RuntimeExtensionRequest<M>;
export type SessionRuntimeProductResponse<M extends SessionRuntimeProductMode> = RuntimeResponse<M>;
export type SessionRuntimeProductSnapshot<M extends SessionRuntimeProductMode> = RuntimeSnapshot<M>;

export interface SessionRuntimeCoreOptions<M extends SessionRuntimeProductMode = "content_ref"> {
	serverEpoch: string;
	target: SessionTarget;
	resolved: ProbedPiRuntime;
	env?: Record<string, string>;
	readyTimeoutMs?: number;
	replayLimit?: number;
	replayMaxBytes?: number;
	transientBufferMaxBytes?: number;
	extensionStateMaxBytes?: number;
	extensionStateMaxItems?: number;
	pendingDialogLimit?: number;
	/** Hard cap for RPC command responses pending on this canonical Session. */
	maxPendingCommands?: number;
	projectionLimits?: Partial<SessionLiveProjectionLimits>;
	productAdapter: SessionRuntimeProductAdapter<M>;
	payloadCustody?: SessionRuntimePayloadCustody<M>;
	initialGeneration?: number;
	commandTimeoutFor?: (commandType: string) => number;
	emit: (message: SessionSupervisorMessage<RuntimeEvent<M>, RuntimeExtensionRequest<M>>) => void;
	onHotSetChanged?: (runtime: SessionRuntimeCore<M>) => void;
	onCrash: (runtime: SessionRuntimeCore<M>) => void;
	commitIdentityTransition: (
		runtime: SessionRuntimeCore<M>,
		transition: SessionIdentityTransitionCommit<RuntimeEvent<M>, RuntimeExtensionRequest<M>>,
	) => Promise<void>;
	log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface SessionRuntimeOptions
	extends Omit<SessionRuntimeCoreOptions<"content_ref">, "productAdapter" | "payloadCustody"> {
	piPayloadServices: SessionRuntimePiPayloadServices;
}

export function createSessionRuntimePiPayloadServices(input: {
	externalizer: PiHostPayloadExternalizer;
	productSchema: SessionProductSchema;
	releaseHold: (hold: EpochContentHold<EpochStoredContentRef>) => Promise<void>;
}): SessionRuntimePiPayloadServices {
	const services: SessionRuntimePiPayloadServices = {
		mode: "content_ref",
		...input,
	};
	return Object.freeze(services);
}

export interface SessionRuntimeProductAdapter<M extends SessionRuntimeProductMode> {
	readonly mode: M;
	readonly productSchema: SessionProductSchema<
		RuntimeMessage<M>,
		RuntimeEvent<M>,
		RuntimeSnapshot<M>,
		RuntimeExtensionRequest<M>
	>;
	createProcess(
		options: SessionRuntimePiProcessOptions,
		payloadCustody: SessionRuntimePayloadCustody<M> | null,
		consumeEvent: (
			proc: PiProcess,
			delivery: PiDecodedDelivery<RuntimeEvent<M>, RuntimeRef<M>>,
		) => PiDecodedDeliveryPlan,
		consumeExtensionRequest: (
			proc: PiProcess,
			delivery: PiDecodedDelivery<RuntimeExtensionRequest<M>, RuntimeRef<M>>,
		) => PiDecodedDeliveryPlan,
	): PiProcess;
	sendDecoded(
		proc: PiProcess,
		command: SessionCommandDto,
		consume: PiDecodedDeliveryConsumer<RuntimeResponse<M>, RuntimeRef<M>>,
		timeoutMs: number,
	): Promise<RuntimeResponse<M>>;
	messagesFrom(response: RuntimeResponse<M>): readonly RuntimeMessage<M>[];
	transitionResponseLogicalBytes(response: RuntimeResponse<M>): number;
}

function createProductAdapter(
	productSchema: SessionProductSchema,
): SessionRuntimeProductAdapter<"content_ref"> {
	const adapter: SessionRuntimeProductAdapter<"content_ref"> = {
		mode: "content_ref",
		productSchema,
		createProcess: (options, payloadCustody, consumeEvent, consumeExtensionRequest) => {
			if (!payloadCustody) throw new TypeError("Session Runtime requires payload custody");
			let owner: PiProcess | undefined;
			const proc = new PiProcess({
				...options,
				payloadExternalizer: payloadCustody.externalizer,
				onDecodedEvent: (delivery) => {
					if (!owner) throw new RpcError("event", "session_process_not_installed");
					return consumeEvent(owner, delivery);
				},
				onDecodedExtensionUiRequest: (delivery) => {
					if (!owner) throw new RpcError("extension_ui_request", "session_process_not_installed");
					return consumeExtensionRequest(owner, delivery);
				},
			});
			owner = proc;
			return proc;
		},
		sendDecoded: (proc, command, consume, timeoutMs) => proc.sendDecoded(command, consume, timeoutMs),
		messagesFrom: (response) => {
			if (response.success !== true || response.command !== "get_messages") {
				throw new RpcError("get_messages", "unexpected Pi response");
			}
			return response.data.messages;
		},
		transitionResponseLogicalBytes: (response) =>
			analyzeSessionCommandResponseLogicalBytes(response, {
				maxBytes: productSchema.maxActiveTurnLogicalBytes,
			}).byteLength,
	};
	return Object.freeze(adapter);
}

/**
 * Owns exactly one Pi RPC child process and one native Session identity.
 *
 * The runtime buffers startup frames until `get_state` establishes identity,
 * gives every emitted frame a generation-local sequence, and keeps a bounded
 * replay ring for reconnect. Session navigation is deliberately absent.
 */
export class SessionRuntimeCore<M extends SessionRuntimeProductMode = "content_ref"> {
	private readonly productAdapter: SessionRuntimeProductAdapter<M>;
	private readonly payloadCustody: SessionRuntimePayloadCustody<M> | null;
	private readonly opts: Required<
		Pick<
			SessionRuntimeCoreOptions<M>,
			| "readyTimeoutMs"
			| "replayLimit"
			| "replayMaxBytes"
			| "transientBufferMaxBytes"
			| "extensionStateMaxBytes"
			| "extensionStateMaxItems"
			| "pendingDialogLimit"
			| "maxPendingCommands"
		>
	> &
		SessionRuntimeCoreOptions<M>;
	private proc: PiProcess | null = null;
	private startPromise: Promise<void> | null = null;
	private stopPromise: Promise<void> | null = null;
	private processFinalization: Promise<void> | null = null;
	private resolveProcessFinalization: (() => void) | null = null;
	private processToken = 0;
	private failedProcessToken: number | null = null;
	private startupReady = false;
	private startupFrames: BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[] = [];
	private startupFrameBytes = 0;
	private transitionStage: TransitionStage<
		RuntimeEvent<M>,
		RuntimeExtensionRequest<M>,
		RuntimeRef<M>
	> | null = null;
	private replay: SessionReplayFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[] = [];
	private replayFrameBytes: number[] = [];
	private replayBytes = 0;
	private lastTransientSeq = 0;
	private pendingDialogs = new Map<string, PendingDialog<RuntimeExtensionRequest<M>>>();
	private extensionSemanticRevision = 0;
	private pendingTurnReservations = new Map<symbol, PendingTurnReservation>();
	private nextTurnReservationId = 0n;
	private queueReservationReleaseCutoff = 0n;
	private stickyExtension = new Map<string, RuntimeExtensionRequest<M>>();
	private activeQueueDepth = 0;
	private activeTurnProjectionItems = 0;
	private activeTurnProjectionBytes = 0;
	private activeTurnProjectionLogicalBytes = 0;
	private activeTurnHeadroomReserved = false;
	private agentBusy = false;
	private compactionBusy = false;
	private idleBaseCompactionBusy = false;
	private inFlight = 0;
	private reservations = 0;
	private commandTail: Promise<void> = Promise.resolve();
	private manuallyStopped = true;
	private terminalProtocolIncompatible = false;
	private sessionFileIdentityVerified = false;
	private hasConversationIntent = false;
	private liveProjection: SessionLiveProjection<
		RuntimeMessage<M>,
		RuntimeEvent<M>,
		RuntimeExtensionRequest<M>
	> | null = null;
	private nativeHistoryPlan: NativeSessionHistoryPlan | null = null;
	private nativeHistorySnapshotId: string | null = null;
	private generationContentOwner: GenerationContentOwner<RuntimeRef<M>> | null = null;
	private retainedCrashedContentOwner: {
		processToken: number;
		generation: number;
		owner: GenerationContentOwner<RuntimeRef<M>>;
	} | null = null;
	private crashedRecoverable: boolean | null = null;
	private snapshotOverflow = false;
	private idleBaseCompactionPromise: Promise<void> | null = null;
	private discardedCompactionTransferCleanup: Promise<void> | null = null;
	private retiredGenerationContentCleanup: Promise<void> | null = null;
	private generationContentCleanupFailure: Error | null = null;
	private snapshotVersion = 0;
	private snapshotCache: {
		version: number;
		snapshot: SessionRuntimeProductSnapshot<M>;
	} | null = null;
	private deferredStartupEmits:
		| SessionSupervisorMessage<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[]
		| null = null;
	private deferredTransitionEmits:
		| SessionSupervisorMessage<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[]
		| null = null;

	sessionHandle: string;
	readonly workspaceId: string;
	readonly cwd: string;
	nativeSessionId: string;
	sessionFile: string | null;
	generation = 0;
	lastSeq = 0;
	state: SessionRuntimeSnapshot["state"] = "dormant";
	lastActivityAt = Date.now();
	error: string | undefined;

	constructor(opts: SessionRuntimeCoreOptions<M>) {
		this.productAdapter = opts.productAdapter;
		this.payloadCustody = opts.payloadCustody ?? null;
		const target: SessionTarget = {
			...opts.target,
			cwd: canonicalizePathAllowMissing(opts.target.cwd),
			...(opts.target.kind === "new"
				? { sessionDir: canonicalizePathAllowMissing(opts.target.sessionDir) }
				: {}),
		};
		this.opts = {
			...opts,
			target,
			readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
			replayLimit: opts.replayLimit ?? 1_024,
			replayMaxBytes: Math.max(0, opts.replayMaxBytes ?? DEFAULT_REPLAY_MAX_BYTES),
			transientBufferMaxBytes: Math.max(
				0,
				opts.transientBufferMaxBytes ?? DEFAULT_TRANSIENT_BUFFER_MAX_BYTES,
			),
			extensionStateMaxBytes: Math.max(0, opts.extensionStateMaxBytes ?? DEFAULT_EXTENSION_STATE_MAX_BYTES),
			extensionStateMaxItems: Math.max(0, opts.extensionStateMaxItems ?? DEFAULT_EXTENSION_STATE_MAX_ITEMS),
			pendingDialogLimit: Math.max(0, opts.pendingDialogLimit ?? DEFAULT_PENDING_DIALOG_LIMIT),
			maxPendingCommands: Math.max(1, Math.floor(opts.maxPendingCommands ?? DEFAULT_MAX_PENDING_COMMANDS)),
		};
		if (
			opts.productAdapter.productSchema.serverEpoch !== undefined &&
			opts.productAdapter.productSchema.serverEpoch !== opts.serverEpoch
		) {
			throw new TypeError("Session Runtime product adapter epoch does not match");
		}
		this.sessionHandle = target.sessionHandle;
		this.workspaceId = target.workspaceId;
		this.cwd = target.cwd;
		this.nativeSessionId = target.nativeSessionId;
		this.sessionFile = target.kind === "existing" ? target.sessionFile : null;
		this.generation = opts.initialGeneration ?? 0;
		// Catalog-resolved existing targets are frozen again during ready. This
		// initial trust only keeps a failed startup tracked for bounded recovery;
		// unpersisted new/fork targets explicitly reset it until Header validation.
		this.sessionFileIdentityVerified = target.kind === "existing";
	}

	get running(): boolean {
		return this.stopPromise !== null || this.proc?.running === true;
	}

	/** Capture exact live Pi ownership without treating stop cleanup as hot. */
	captureHotRuntimeObservation(): SessionHotRuntimeObservation | null {
		if (
			this.manuallyStopped ||
			this.stopPromise !== null ||
			this.proc?.running !== true ||
			this.state === "crashed" ||
			this.state === "dormant"
		) {
			return null;
		}
		if (
			this.state !== "starting" &&
			this.state !== "idle" &&
			this.state !== "running" &&
			this.state !== "waiting_ui"
		) {
			return null;
		}
		const phase = this.runtimePhase();
		if (phase === "crashed" || phase === "dormant") return null;
		return {
			entry: {
				serverEpoch: this.opts.serverEpoch,
				sessionHandle: this.sessionHandle,
				workspaceId: this.workspaceId,
				generation: this.generation,
				state: this.state,
				phase,
				operationCount: this.operationCount(),
				busyReasons: this.busyReasons(),
			},
			processToken: this.processToken,
		};
	}

	isHotRuntimeObservationCurrent(observation: SessionHotRuntimeObservation): boolean {
		const current = this.captureHotRuntimeObservation();
		return (
			current !== null &&
			current.processToken === observation.processToken &&
			current.entry.serverEpoch === observation.entry.serverEpoch &&
			current.entry.sessionHandle === observation.entry.sessionHandle &&
			current.entry.workspaceId === observation.entry.workspaceId &&
			current.entry.generation === observation.entry.generation
		);
	}

	get transitioning(): boolean {
		return this.transitionStage !== null;
	}

	get protocolIncompatible(): boolean {
		return this.terminalProtocolIncompatible;
	}

	get snapshotOverflowed(): boolean {
		return this.snapshotOverflow;
	}

	/** True while this Runtime still owns its bounded in-memory projection. */
	get retainsProjectionReservation(): boolean {
		return this.state === "crashed" && this.liveProjection !== null;
	}

	rebuildTarget(): ExistingSessionTarget | null {
		if (!this.sessionFile || !this.recoverable) return null;
		return {
			kind: "existing",
			sessionHandle: this.sessionHandle,
			workspaceId: this.workspaceId,
			cwd: this.cwd,
			sessionFile: this.sessionFile,
			nativeSessionId: this.nativeSessionId,
		};
	}

	get recoverable(): boolean {
		if (this.state === "crashed" && this.crashedRecoverable !== null) {
			return this.crashedRecoverable;
		}
		if (!this.sessionFile || !fs.existsSync(this.sessionFile)) return false;
		if (this.sessionFileIdentityVerified) return true;
		try {
			this.verifyMaterializedSessionFile();
			return true;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	get canEvict(): boolean {
		// Pi does not persist a new Session until its first durable entry. Stopping
		// that process would make the in-memory identity impossible to recover.
		return (
			this.stopPromise === null &&
			this.recoverable &&
			this.reservations === 0 &&
			this.identityTransitionBlocker() === null
		);
	}

	/** True only when no accepted conversation could be lost by forgetting this unpersisted runtime. */
	get canAbandon(): boolean {
		return (
			!this.hasConversationIntent &&
			!this.recoverable &&
			this.reservations === 0 &&
			this.identityTransitionBlocker() === null
		);
	}

	/** Pin the runtime against idle/capacity eviction for one Supervisor operation. */
	reserve(): () => void {
		this.reservations += 1;
		this.touch();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.reservations = Math.max(0, this.reservations - 1);
			this.touch();
		};
	}

	snapshot(): SessionRuntimeSnapshot {
		return {
			serverEpoch: this.opts.serverEpoch,
			sessionHandle: this.sessionHandle,
			workspaceId: this.workspaceId,
			nativeSessionId: this.nativeSessionId,
			sessionFile: this.sessionFile,
			cwd: this.cwd,
			generation: this.generation,
			lastSeq: this.lastSeq,
			state: this.state,
			phase: this.runtimePhase(),
			operationCount: this.operationCount(),
			busyReasons: this.busyReasons(),
			lastActivityAt: this.lastActivityAt,
			recoverable: this.recoverable,
			...(this.error ? { error: this.error } : {}),
		};
	}

	private runtimePhase(): SessionRuntimePhaseDto {
		if (this.state === "starting") return "starting";
		if (this.state === "crashed") return "crashed";
		if (this.state === "dormant") return "dormant";
		if (this.state === "waiting_ui" || this.pendingDialogs.size > 0) return "waiting_ui";
		if (this.state === "running" || this.busyReasons().length > 0) return "busy";
		return "ready";
	}

	private busyReasons(): SessionRuntimeBusyReasonDto[] {
		const reasons: SessionRuntimeBusyReasonDto[] = [];
		if (this.state === "starting") reasons.push("starting");
		if (this.inFlight > 0) reasons.push("command");
		if (this.agentBusy) reasons.push("agent");
		if (this.compactionBusy || this.idleBaseCompactionBusy) reasons.push("compaction");
		if (this.activeQueueDepth > 0) reasons.push("queue");
		if (this.pendingDialogs.size > 0) reasons.push("dialog");
		if (this.pendingTurnReservations.size > 0) reasons.push("turn_reservation");
		if (this.transitioning) reasons.push("transition");
		return reasons;
	}

	private operationCount(): number {
		return (
			this.inFlight +
			this.activeQueueDepth +
			this.pendingDialogs.size +
			this.pendingTurnReservations.size +
			(this.agentBusy ? 1 : 0) +
			(this.compactionBusy || this.idleBaseCompactionBusy ? 1 : 0) +
			(this.transitioning ? 1 : 0) +
			(this.state === "starting" ? 1 : 0)
		);
	}

	/** Start or reuse this exact Session target. */
	start(): Promise<void> {
		if (this.retainedCrashedContentOwner) {
			return Promise.reject(new RpcError("session_start", "nonrecoverable_crash_retained"));
		}
		if (this.generationContentCleanupFailure) {
			return Promise.reject(new RpcError("session_start", "generation_content_cleanup_failed"));
		}
		if (this.snapshotOverflow) {
			return Promise.reject(new RpcError("session_start", "session_snapshot_overflow"));
		}
		if (this.terminalProtocolIncompatible) {
			return Promise.reject(new RpcError("session_start", "protocol_incompatible"));
		}
		if (this.stopPromise) {
			const stopping = this.stopPromise;
			return stopping.then(() => this.start());
		}
		if (this.startPromise) return this.startPromise;
		if (this.running) return Promise.resolve();
		if (this.proc) {
			// The leader has exited but PiProcess is still cleaning its detached
			// descendants. Wait for onExit before a replacement can spawn.
			this.processFinalization ??= new Promise<void>((resolve) => {
				this.resolveProcessFinalization = resolve;
			});
			return this.processFinalization.then(() => this.start());
		}
		this.manuallyStopped = false;
		this.startPromise = this.spawn().finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	private async spawn(): Promise<void> {
		this.finishProcessFinalization();
		this.processToken += 1;
		const processToken = this.processToken;
		this.failedProcessToken = null;
		this.crashedRecoverable = null;
		this.retainedCrashedContentOwner = null;
		this.generation += 1;
		const contentOwnership = this.payloadCustody;
		const contentOwner = contentOwnership
			? new GenerationContentOwner({
					serverEpoch: this.opts.serverEpoch,
					generation: this.generation,
					release: contentOwnership.releaseHold,
				})
			: null;
		this.generationContentOwner = contentOwner;
		this.lastSeq = 0;
		this.liveProjection = null;
		this.nativeHistoryPlan = null;
		this.nativeHistorySnapshotId = null;
		this.clearReplay();
		this.startupReady = false;
		this.startupFrames = [];
		this.startupFrameBytes = 0;
		this.activeTurnProjectionLogicalBytes = 0;
		this.stickyExtension.clear();
		this.extensionSemanticRevision = 0;
		this.error = undefined;
		this.setState("starting");

		const processOptions: SessionRuntimePiProcessOptions = {
			cwd: this.cwd,
			resolved: this.opts.resolved,
			args: this.spawnArguments(),
			adapter: this.opts.resolved.adapter,
			env: this.opts.env,
			readyTimeoutMs: this.opts.readyTimeoutMs,
			onReady: (state) => this.handleReady(processToken, state),
			onExit: (info) => this.handleFailure(processToken, info),
		};
		const proc = this.productAdapter.createProcess(
			processOptions,
			this.payloadCustody,
			(owner, delivery) => this.prepareDecodedEvent(processToken, owner, delivery),
			(owner, delivery) => this.prepareDecodedExtensionRequest(processToken, owner, delivery),
		);
		this.proc = proc;
		if (contentOwner) this.observeGenerationContentFailure(processToken, proc, contentOwner);

		try {
			const ready = proc.start();
			this.opts.onHotSetChanged?.(this);
			await ready;
			await this.initializeProjectionBase(processToken, proc);
			this.deferredStartupEmits = [];
			this.setState(this.pendingDialogs.size > 0 ? "waiting_ui" : "idle");
			this.flushPreparedContentRefStartupFrames(this.startupFrames);
			this.startupFrames = [];
			this.startupFrameBytes = 0;
			this.setState(
				this.pendingDialogs.size > 0
					? "waiting_ui"
					: this.agentBusy ||
							this.compactionBusy ||
							this.idleBaseCompactionBusy ||
							this.pendingTurnReservations.size > 0
						? "running"
						: "idle",
			);
			this.assertWireSnapshotFits();
			this.startupReady = true;
			const startupEmits = this.deferredStartupEmits ?? [];
			this.deferredStartupEmits = null;
			for (const message of startupEmits) this.opts.emit(message);
			this.opts.emit({ type: "runtime_state", runtime: this.snapshot() });
			this.log("info", `Pi runtime ready for ${this.sessionHandle}`);
		} catch (error) {
			this.deferredStartupEmits = null;
			const normalized = this.normalizeProjectionError(error);
			if (proc.running) await proc.stop().catch(() => {});
			if (this.failedProcessToken !== processToken) {
				this.handleFailure(processToken, {
					code: null,
					signal: null,
					stderrTail: normalized instanceof Error ? normalized.message : String(normalized),
				});
			}
			// Manual stop increments processToken and already waits for this spawn.
			// Only a same-generation failure may await the independent owner cleanup fence.
			if (processToken === this.processToken && this.stopPromise) await this.stopPromise;
			throw normalized;
		}
	}

	private spawnArguments(): string[] {
		const target = this.opts.target;
		const adapter = this.opts.resolved.adapter;
		if (target.kind === "new" && this.sessionFile === null) {
			return adapter.createSessionArguments({
				nativeSessionId: target.nativeSessionId,
				sessionDir: target.sessionDir,
			});
		}
		if (!this.sessionFile) throw new RpcError("start", "session target has no file");
		return adapter.openSessionArguments({
			sessionFile: this.sessionFile,
			sessionDir: path.dirname(this.sessionFile),
		});
	}

	private handleReady(processToken: number, state: SessionStateDto): void {
		if (processToken !== this.processToken) return;
		if (!state?.sessionFile) throw new RpcError("get_state", "Pi did not expose a persisted session target");
		const canonicalFile = canonicalizeSessionFile(state.sessionFile);
		const target = this.opts.target;
		if (target.kind === "existing") {
			const frozenFile = inspectFrozenSessionFile(canonicalFile);
			// target.sessionFile/handle were frozen by the native catalog. Re-
			// canonicalizing them here would let a symlink replacement change the
			// requested identity between discovery and ready validation.
			if (
				canonicalFile !== target.sessionFile ||
				sessionHandleForCanonicalFile(canonicalFile) !== target.sessionHandle
			) {
				throw new RpcError("get_state", "Pi opened a different session file than requested");
			}
			if (state.sessionId !== target.nativeSessionId) {
				throw new RpcError("get_state", "Pi session id does not match the native JSONL header");
			}
			if (
				frozenFile.nativeSessionId !== target.nativeSessionId ||
				canonicalizePathAllowMissing(frozenFile.cwd) !== target.cwd
			) {
				throw new RpcError("get_state", "Pi Session header identity changed after native discovery");
			}
			this.sessionFileIdentityVerified = true;
		} else {
			if (state.sessionId !== target.nativeSessionId) {
				throw new RpcError("get_state", "Pi opened an existing session instead of the requested new id");
			}
			if (path.dirname(canonicalFile) !== target.sessionDir) {
				throw new RpcError("get_state", "Pi created the new session outside the resolved session directory");
			}
			// Pi keeps a brand-new empty Session only in memory. Once the first
			// durable entry appears, bind its Header before accepting the runtime.
			if (fs.existsSync(canonicalFile)) {
				const frozenFile = inspectFrozenSessionFile(canonicalFile);
				if (
					frozenFile.nativeSessionId !== target.nativeSessionId ||
					canonicalizePathAllowMissing(frozenFile.cwd) !== target.cwd
				) {
					throw new RpcError("get_state", "new Pi Session header identity does not match its request");
				}
				this.sessionFileIdentityVerified = true;
			}
		}

		this.sessionFile = canonicalFile;
		this.sessionHandle = sessionHandleForCanonicalFile(canonicalFile);
		this.nativeSessionId = state.sessionId;
		this.opts.target = {
			kind: "existing",
			sessionHandle: this.sessionHandle,
			workspaceId: this.workspaceId,
			cwd: this.cwd,
			sessionFile: canonicalFile,
			nativeSessionId: state.sessionId,
		};
	}

	private async initializeProjectionBase(processToken: number, proc: PiProcess): Promise<void> {
		const nativeHistory = await this.loadNativeHistoryBase(processToken, proc);
		this.liveProjection = nativeHistory
			? await this.loadProjectionBaseFromMessages(
					processToken,
					proc,
					this.projectionIdentity(),
					nativeHistory,
				)
			: await this.loadProjectionBase(processToken, proc, this.projectionIdentity());
	}

	private async loadProjectionBase(
		processToken: number,
		proc: PiProcess,
		identity: SessionLiveProjectionIdentity,
		candidateRuntime?: SessionRuntimeSnapshot,
		candidateOwnership?: {
			owner: GenerationContentOwner<RuntimeRef<M>>;
			isCurrent: () => boolean;
		},
	): Promise<SessionLiveProjection<RuntimeMessage<M>, RuntimeEvent<M>, RuntimeExtensionRequest<M>>> {
		let preparedProjection: SessionLiveProjection<
			RuntimeMessage<M>,
			RuntimeEvent<M>,
			RuntimeExtensionRequest<M>
		> | null = null;
		const contentOwner = candidateOwnership?.owner ?? this.generationContentOwner;
		const ownerIsCurrent =
			candidateOwnership?.isCurrent ??
			(() =>
				this.payloadCustody
					? contentOwner !== null && this.isCurrentGenerationContentOwner(processToken, proc, contentOwner)
					: processToken === this.processToken && this.proc === proc);
		const consume: PiDecodedDeliveryConsumer<RuntimeResponse<M>, RuntimeRef<M>> = (delivery) => {
			const messages = this.productAdapter.messagesFrom(delivery.value);
			const startupCandidate =
				this.productAdapter.mode === "content_ref" &&
				!this.startupReady &&
				this.transitionStage === null &&
				candidateOwnership === undefined;
			const semanticRevision = this.extensionSemanticRevision;
			const startupFrameCount = this.startupFrames.length;
			const startupFrameBytes = this.startupFrameBytes;
			const startupFrames = startupCandidate
				? this.authoritativeContentRefStartupFrames(this.startupFrames)
				: [];
			const extensionState = {
				pendingDialogs: new Map(this.pendingDialogs),
				stickyExtension: new Map(this.stickyExtension),
			};
			const candidate = new SessionLiveProjection<
				RuntimeMessage<M>,
				RuntimeEvent<M>,
				RuntimeExtensionRequest<M>
			>({
				identity,
				settledMessages: messages,
				baseSeq: 0,
				runtimePhase: extensionState.pendingDialogs.size > 0 ? "waiting_ui" : "idle",
				limits: this.opts.projectionLimits,
				schema: this.productAdapter.productSchema,
			});
			const projectionSnapshot =
				startupFrames.length > 0
					? candidate.previewPreparedBatch(candidate.prepareBatch(identity, startupFrames, this.state))
					: candidate.snapshot();
			if (!projectionSnapshot) {
				throw new RpcError("get_messages", "startup_projection_preview_stale");
			}
			const runtimeSnapshot: SessionRuntimeSnapshot = {
				...(candidateRuntime ?? this.snapshot()),
				lastSeq: projectionSnapshot.asOfSeq,
			};
			const candidateSnapshot = this.buildSessionSnapshotFromProjection(
				projectionSnapshot,
				runtimeSnapshot,
				extensionState,
			);
			this.assertProductSnapshotCandidateFits(candidateSnapshot);
			return delivery.prepare((transfer) => {
				if (!ownerIsCurrent()) {
					throw new RpcError("get_messages", "session_generation_stale");
				}
				if (
					startupCandidate &&
					(semanticRevision !== this.extensionSemanticRevision ||
						startupFrameCount !== this.startupFrames.length ||
						startupFrameBytes !== this.startupFrameBytes)
				) {
					throw new RpcError("get_messages", "startup_extension_state_changed_before_base_commit");
				}
				if (transfer) {
					if (!contentOwner) throw new RpcError("get_messages", "unexpected_payload_transfer");
					contentOwner.adopt(transfer);
				}
				preparedProjection = candidate;
				return true;
			});
		};
		await this.productAdapter.sendDecoded(
			proc,
			{ type: "get_messages" },
			consume,
			this.timeoutFor("get_messages"),
		);
		if (processToken !== this.processToken || this.proc !== proc || !ownerIsCurrent()) {
			throw new RpcError("get_messages", "session_generation_stale");
		}
		if (!preparedProjection) throw new RpcError("get_messages", "decoded_projection_not_committed");
		return preparedProjection;
	}

	private async loadNativeHistoryBase(
		processToken: number,
		proc: PiProcess,
	): Promise<readonly RuntimeMessage<M>[] | null> {
		const sessionFile = this.sessionFile;
		if (!sessionFile || !this.shouldUseNativeHistory()) return null;
		const signal = AbortSignal.timeout(this.timeoutFor("get_messages"));
		try {
			const plan = await scanNativeSessionHistory(
				sessionFile,
				{
					expectedNativeSessionId: this.nativeSessionId,
					expectedCwd: this.cwd,
				},
				signal,
			);
			if (plan.totalMessages === 0) {
				if (!this.isCurrentNativeHistoryRead(processToken, proc)) {
					throw new RpcError("get_messages", "session_generation_stale");
				}
				// A materialized Header does not prove that Pi has no in-memory
				// context. Keep the empty plan only as a source fingerprint and ask
				// Pi for the authoritative base until durable messages appear.
				this.nativeHistoryPlan = plan;
				this.nativeHistorySnapshotId = null;
				return null;
			}
			const initial = await plan.readInitial(signal);
			const messages = await this.normalizeNativeHistoryEntries(processToken, proc, initial.entries, signal);
			if (!this.isCurrentNativeHistoryRead(processToken, proc)) {
				throw new RpcError("get_messages", "session_generation_stale");
			}
			this.nativeHistoryPlan = plan;
			this.nativeHistorySnapshotId = randomUUID();
			return messages;
		} catch (error) {
			if (error instanceof SessionHistoryError) {
				throw new RpcError("get_messages", error.code);
			}
			throw error;
		}
	}

	private async compactIdleNativeHistoryBase(
		token: ReturnType<
			SessionLiveProjection<
				RuntimeMessage<M>,
				RuntimeEvent<M>,
				RuntimeExtensionRequest<M>
			>["beginIdleBaseCompaction"]
		>,
		projection: SessionLiveProjection<RuntimeMessage<M>, RuntimeEvent<M>, RuntimeExtensionRequest<M>>,
		processToken: number,
		proc: PiProcess,
		contentOwner: GenerationContentOwner<RuntimeRef<M>> | null,
	): Promise<boolean | null> {
		if (!token || !this.sessionFile) return false;
		const signal = AbortSignal.timeout(this.timeoutFor("get_messages"));
		let lease: PiPayloadLease<RuntimeRef<M>> | null = null;
		try {
			const previousPlan = this.nativeHistoryPlan;
			const plan = await scanNativeSessionHistory(
				this.sessionFile,
				{
					expectedNativeSessionId: this.nativeSessionId,
					expectedCwd: this.cwd,
				},
				signal,
			);
			if (previousPlan && !plan.hasSameSourceFile(previousPlan)) {
				throw new SessionHistoryError(
					"session_history_changed",
					"native Session history file identity changed",
				);
			}
			if (plan.totalMessages === 0) {
				const ownershipCurrent = contentOwner
					? this.isCurrentGenerationContentOwner(processToken, proc, contentOwner)
					: !this.payloadCustody && processToken === this.processToken && this.proc === proc;
				if (!ownershipCurrent || this.liveProjection !== projection) return false;
				this.nativeHistoryPlan = plan;
				this.nativeHistorySnapshotId = null;
				return null;
			}
			const initial = await plan.readInitial(signal);
			const normalized = await this.normalizeNativeHistoryEntriesWithLease(
				processToken,
				proc,
				initial.entries,
				signal,
			);
			lease = normalized.lease;
			const ownershipCurrent = contentOwner
				? this.isCurrentGenerationContentOwner(processToken, proc, contentOwner)
				: !this.payloadCustody && processToken === this.processToken && this.proc === proc;
			if (!ownershipCurrent || this.liveProjection !== projection) return false;
			const prepared = projection.prepareIdleBaseCompaction(token, normalized.messages);
			if (!prepared) return false;
			if (this.productAdapter.mode === "content_ref") {
				const candidateProjection = projection.previewPreparedIdleBaseCompaction(prepared);
				if (!candidateProjection) return false;
				this.assertProductSnapshotCandidateFits(this.buildSessionSnapshotFromProjection(candidateProjection));
			}
			if (lease) {
				if (!contentOwner) throw new RpcError("get_messages", "unexpected_payload_transfer");
				const transfer = lease.transfer();
				try {
					contentOwner.adopt(transfer);
				} catch (error) {
					await transfer.release().catch(() => {});
					throw error;
				}
				lease = null;
			}
			if (!projection.commitPreparedIdleBaseCompaction(prepared)) {
				throw new RpcError("get_messages", "session_compaction_commit_invariant_failed");
			}
			this.nativeHistoryPlan = plan;
			this.nativeHistorySnapshotId = randomUUID();
			if (this.productAdapter.mode !== "content_ref") this.assertWireSnapshotFits();
			return true;
		} catch (error) {
			if (error instanceof SessionHistoryError) {
				throw new RpcError("get_messages", error.code);
			}
			throw error;
		} finally {
			if (lease) await lease.release().catch(() => {});
		}
	}

	private shouldUseNativeHistory(): boolean {
		return this.sessionFileIdentityVerified;
	}

	private async normalizeNativeHistoryEntries(
		processToken: number,
		proc: PiProcess,
		entries: readonly SessionEntry[],
		signal: AbortSignal,
	): Promise<RuntimeMessage<M>[]> {
		const normalized = await this.normalizeNativeHistoryEntriesWithLease(processToken, proc, entries, signal);
		if (!normalized.lease) return normalized.messages;
		const owner = this.generationContentOwner;
		if (!owner || !this.isCurrentGenerationContentOwner(processToken, proc, owner)) {
			await normalized.lease.release().catch(() => {});
			throw new RpcError("get_messages", "session_generation_stale");
		}
		const transfer = normalized.lease.transfer();
		try {
			owner.adopt(transfer);
		} catch (error) {
			await transfer.release().catch(() => {});
			throw error;
		}
		return normalized.messages;
	}

	private async normalizeNativeHistoryEntriesWithLease(
		processToken: number,
		proc: PiProcess,
		entries: readonly SessionEntry[],
		signal: AbortSignal,
	): Promise<{ messages: RuntimeMessage<M>[]; lease: PiPayloadLease<RuntimeRef<M>> | null }> {
		const rawMessages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
		if (rawMessages.length === 0) return { messages: [], lease: null };
		const productSchema = this.productAdapter.productSchema;
		if (!this.payloadCustody) {
			const messages: RuntimeMessage<M>[] = [];
			for (const message of rawMessages) {
				if (!productSchema.guardMessage(message)) {
					throw new RpcError("get_messages", "native_history_message_invalid");
				}
				messages.push(message as RuntimeMessage<M>);
			}
			return { messages, lease: null };
		}

		const owner = this.generationContentOwner;
		if (!owner || !this.isCurrentGenerationContentOwner(processToken, proc, owner)) {
			throw new RpcError("get_messages", "session_generation_stale");
		}
		let lease: PiPayloadLease<RuntimeRef<M>> | null = null;
		try {
			const externalized = await this.payloadCustody.externalizer.externalize(
				{
					kind: "response",
					expectedCommand: "get_messages",
					value: {
						type: "response",
						id: randomUUID(),
						command: "get_messages",
						success: true,
						data: { messages: rawMessages },
					},
				},
				signal,
			);
			lease = externalized.lease as unknown as PiPayloadLease<RuntimeRef<M>>;
			const value = externalized.value;
			if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.messages)) {
				throw new RpcError("get_messages", "native_history_response_invalid");
			}
			const messages: RuntimeMessage<M>[] = [];
			for (const message of value.data.messages) {
				if (!productSchema.guardMessage(message)) {
					throw new RpcError("get_messages", "native_history_message_invalid");
				}
				messages.push(message as RuntimeMessage<M>);
			}
			if (!this.isCurrentGenerationContentOwner(processToken, proc, owner)) {
				throw new RpcError("get_messages", "session_generation_stale");
			}
			return { messages, lease };
		} catch (error) {
			if (lease) await lease.release().catch(() => {});
			throw error;
		}
	}

	private isCurrentNativeHistoryRead(processToken: number, proc: PiProcess): boolean {
		if (processToken !== this.processToken || this.proc !== proc || !proc.running) return false;
		if (!this.payloadCustody) return true;
		const owner = this.generationContentOwner;
		return owner !== null && this.isCurrentGenerationContentOwner(processToken, proc, owner);
	}

	private loadProjectionBaseFromMessages(
		processToken: number,
		proc: PiProcess,
		identity: SessionLiveProjectionIdentity,
		messages: readonly RuntimeMessage<M>[],
	): SessionLiveProjection<RuntimeMessage<M>, RuntimeEvent<M>, RuntimeExtensionRequest<M>> {
		const ownerIsCurrent = () => this.isCurrentNativeHistoryRead(processToken, proc);
		const startupCandidate =
			this.productAdapter.mode === "content_ref" && !this.startupReady && this.transitionStage === null;
		const startupFrames = startupCandidate
			? this.authoritativeContentRefStartupFrames(this.startupFrames)
			: [];
		const extensionState = {
			pendingDialogs: new Map(this.pendingDialogs),
			stickyExtension: new Map(this.stickyExtension),
		};
		const candidate = new SessionLiveProjection<
			RuntimeMessage<M>,
			RuntimeEvent<M>,
			RuntimeExtensionRequest<M>
		>({
			identity,
			settledMessages: messages,
			baseSeq: 0,
			runtimePhase: extensionState.pendingDialogs.size > 0 ? "waiting_ui" : "idle",
			limits: this.opts.projectionLimits,
			schema: this.productAdapter.productSchema,
		});
		const projectionSnapshot =
			startupFrames.length > 0
				? candidate.previewPreparedBatch(candidate.prepareBatch(identity, startupFrames, this.state))
				: candidate.snapshot();
		if (!projectionSnapshot) throw new RpcError("get_messages", "startup_projection_preview_stale");
		const runtimeSnapshot: SessionRuntimeSnapshot = {
			...this.snapshot(),
			lastSeq: projectionSnapshot.asOfSeq,
		};
		const candidateSnapshot = this.buildSessionSnapshotFromProjection(
			projectionSnapshot,
			runtimeSnapshot,
			extensionState,
		);
		this.assertProductSnapshotCandidateFits(candidateSnapshot);
		if (!ownerIsCurrent()) throw new RpcError("get_messages", "session_generation_stale");
		return candidate;
	}

	private isCurrentGenerationContentOwner(
		processToken: number,
		proc: PiProcess,
		owner: GenerationContentOwner<RuntimeRef<M>>,
	): boolean {
		return (
			processToken === this.processToken &&
			this.proc === proc &&
			this.generationContentOwner === owner &&
			owner.serverEpoch === this.opts.serverEpoch &&
			owner.generation === this.generation
		);
	}

	private isCurrentPayloadTransition(
		processToken: number,
		proc: PiProcess,
		stage: TransitionStage<RuntimeEvent<M>, RuntimeExtensionRequest<M>, RuntimeRef<M>>,
	): boolean {
		return (
			this.transitionStage === stage &&
			stage.processToken === processToken &&
			stage.parentGeneration === this.generation &&
			processToken === this.processToken &&
			this.proc === proc &&
			proc.running &&
			stage.parentOwner !== null &&
			this.generationContentOwner === stage.parentOwner &&
			stage.parentOwner.serverEpoch === this.opts.serverEpoch &&
			stage.parentOwner.generation === stage.parentGeneration
		);
	}

	private prepareTransitionPayloadDelivery(
		proc: PiProcess,
		stage: TransitionStage<RuntimeEvent<M>, RuntimeExtensionRequest<M>, RuntimeRef<M>>,
		delivery: PiDecodedDelivery<RuntimeResponse<M>, RuntimeRef<M>>,
		commandType: string,
	): PiDecodedDeliveryPlan {
		if (!stage.payloadLedger || !this.isCurrentPayloadTransition(stage.processToken, proc, stage)) {
			throw new RpcError(commandType, "session_generation_stale");
		}
		const logicalBytes = this.productAdapter.transitionResponseLogicalBytes(delivery.value);
		return delivery.prepare((transfer) => {
			if (!stage.payloadLedger || !this.isCurrentPayloadTransition(stage.processToken, proc, stage)) {
				throw new RpcError(commandType, "session_generation_stale");
			}
			stage.payloadLedger.admit({ transfer, logicalBytes });
			return true;
		});
	}

	private beginRetiredGenerationContentCleanup(
		processToken: number,
		proc: PiProcess,
		currentOwner: GenerationContentOwner<RuntimeRef<M>>,
		retiredOwner: GenerationContentOwner<RuntimeRef<M>>,
	): Promise<void> {
		if (this.retiredGenerationContentCleanup) {
			throw new RpcError("session_transition", "retired_generation_content_cleanup_busy");
		}
		let cleanup: Promise<void>;
		try {
			cleanup = Promise.resolve(retiredOwner.release());
		} catch (error) {
			cleanup = Promise.reject(error);
		}
		this.retiredGenerationContentCleanup = cleanup;
		void cleanup.then(
			() => {
				if (this.retiredGenerationContentCleanup === cleanup) {
					this.retiredGenerationContentCleanup = null;
				}
			},
			(error) => {
				if (
					this.retiredGenerationContentCleanup === cleanup &&
					this.isCurrentGenerationContentOwner(processToken, proc, currentOwner)
				) {
					this.terminalizeGenerationContentFailure(processToken, proc, currentOwner, error);
				}
			},
		);
		return cleanup;
	}

	private observeGenerationContentFailure(
		processToken: number,
		proc: PiProcess,
		owner: GenerationContentOwner<RuntimeRef<M>>,
	): void {
		void owner.fatalCleanup.catch((error) => {
			if (!this.isCurrentGenerationContentOwner(processToken, proc, owner)) return;
			this.terminalizeGenerationContentFailure(processToken, proc, owner, error);
		});
	}

	private observeRetainedGenerationContentFailure(
		processToken: number,
		generation: number,
		owner: GenerationContentOwner<RuntimeRef<M>>,
	): void {
		void owner.fatalCleanup.catch((error) => {
			const retained = this.retainedCrashedContentOwner;
			if (
				!retained ||
				retained.processToken !== processToken ||
				retained.generation !== generation ||
				retained.owner !== owner ||
				this.generation !== generation ||
				this.generationContentOwner !== owner ||
				this.proc !== null ||
				this.state !== "crashed"
			) {
				return;
			}
			this.retainedCrashedContentOwner = null;
			this.generationContentOwner = null;
			this.liveProjection = null;
			this.clearOwnedOperationalState(false);
			this.error = `generation content failure: ${error instanceof Error ? error.message : String(error)}`;
			this.touch();
			this.emitSupervisorMessage({ type: "runtime_state", runtime: this.snapshot() });
			let release: Promise<void>;
			try {
				release = owner.release();
			} catch (releaseError) {
				release = Promise.reject(releaseError);
			}
			this.beginTerminalGenerationCleanup("Retained generation content cleanup", [
				Promise.reject(error),
				release,
			]);
		});
	}

	async send(
		command: SessionCommandDto,
		expectedGeneration: number,
		admit: () => void,
		timeoutMs?: number,
	): Promise<RuntimeResponse<M>> {
		const admitted = await this.withCommandAdmission(async () => {
			this.assertGeneration(command.type, expectedGeneration);
			this.assertPendingCommandCapacity(command.type);
			admit();
			const expectsWork = commandMayStartWork(command.type);
			const turnReleaseCutoff = commandReleasesQueuedWork(command.type)
				? this.nextTurnReservationId
				: undefined;
			let turnReservation: symbol | undefined;
			if (expectsWork) {
				await this.ensureProjectionHeadroomForWork(command.type);
				this.assertGeneration(command.type, expectedGeneration);
				admit();
				turnReservation = this.reservePendingTurn();
			}
			const proc = this.proc;
			if (!proc?.running) {
				if (turnReservation) this.releasePendingTurn(turnReservation);
				throw new RpcError(command.type, "pi process is not running");
			}
			this.inFlight += 1;
			// Once user content reaches a live Pi process, a timeout or malformed
			// response cannot prove that Pi rejected it. Retain the runtime unless
			// the Session later materializes and becomes independently recoverable.
			if (commandCarriesConversation(command.type)) this.hasConversationIntent = true;
			this.touch();
			const stateBeforeCommand = this.state;
			if (expectsWork) this.setState("running");
			if (!expectsWork || stateBeforeCommand === this.state) this.publishOperationalState();
			let response: Promise<RuntimeResponse<M>>;
			try {
				const processToken = this.processToken;
				const contentOwner = this.generationContentOwner;
				response = this.productAdapter.sendDecoded(
					proc,
					command,
					(delivery) =>
						delivery.prepare((transfer) => {
							if (processToken !== this.processToken || this.proc !== proc) {
								throw new RpcError(command.type, "session_generation_stale");
							}
							if (transfer) {
								if (
									!contentOwner ||
									!this.isCurrentGenerationContentOwner(processToken, proc, contentOwner)
								) {
									throw new RpcError(command.type, "session_generation_stale");
								}
								contentOwner.adopt(transfer);
							}
							return true;
						}),
					timeoutMs ?? this.timeoutFor(command.type),
				);
			} catch (error) {
				const previousOperationalState = this.operationalStateKey();
				this.inFlight = Math.max(0, this.inFlight - 1);
				if (turnReservation) this.releasePendingTurn(turnReservation);
				this.touch();
				if (expectsWork) this.refreshOperationalStateAndPublish(previousOperationalState);
				else this.publishOperationalState();
				throw error;
			}
			return {
				expectsWork,
				turnReservation,
				turnReleaseCutoff,
				response,
			};
		});
		try {
			const response = await admitted.response;
			if (admitted.expectsWork && admitted.turnReservation) {
				this.finishWorkCommandResponse(response.success === true, admitted.turnReservation);
			}
			if (response.success === true && admitted.turnReleaseCutoff !== undefined) {
				const previousOperationalState = this.operationalStateKey();
				this.releasePendingTurnsThrough(admitted.turnReleaseCutoff);
				this.refreshOperationalStateAndPublish(previousOperationalState);
			}
			return response;
		} catch (error) {
			if (admitted.turnReservation) {
				const previousOperationalState = this.operationalStateKey();
				this.releasePendingTurn(admitted.turnReservation);
				this.refreshOperationalStateAndPublish(previousOperationalState);
			}
			throw error;
		} finally {
			const previousOperationalState = this.operationalStateKey();
			this.inFlight = Math.max(0, this.inFlight - 1);
			this.touch();
			this.refreshOperationalStateAndPublish(previousOperationalState);
		}
	}

	/**
	 * Fork/clone are the only allowed in-process identity transitions. Events
	 * emitted before the response are buffered and attributed to the child after
	 * `get_state` verifies it. Blocking veto dialogs remain deliverable.
	 */
	async sendIdentityTransition(
		command: SessionCommandDto,
		expectedGeneration: number,
		admit: () => void,
	): Promise<{ response: RuntimeResponse<M>; previousSessionHandle?: string }> {
		return this.withCommandAdmission(async () => {
			this.assertGeneration(command.type, expectedGeneration);
			this.assertPendingCommandCapacity(command.type);
			admit();
			const blocker = this.identityTransitionBlocker();
			if (blocker) throw new RpcError(command.type, `session_busy:${blocker}`);
			const proc = this.proc;
			if (!proc?.running) throw new RpcError(command.type, "pi process is not running");
			const processToken = this.processToken;
			const parentOwner = this.generationContentOwner;
			if (
				this.payloadCustody &&
				(!parentOwner || !this.isCurrentGenerationContentOwner(processToken, proc, parentOwner))
			) {
				throw new RpcError(command.type, "session_generation_stale");
			}
			const payloadBudget = this.payloadCustody?.externalizer.context.payloadBudget;
			const stage: TransitionStage<RuntimeEvent<M>, RuntimeExtensionRequest<M>, RuntimeRef<M>> = {
				phase: "awaiting_response",
				frames: [],
				bytes: 0,
				processToken,
				parentGeneration: this.generation,
				parentOwner,
				payloadLedger: payloadBudget
					? new TransitionPayloadLedger({
							serverEpoch: this.opts.serverEpoch,
							maxPhysicalBytes: payloadBudget.maxAttachmentCacheBytes,
							maxPhysicalItems: payloadBudget.maxAttachmentCacheItems,
							maxHeldItems: payloadBudget.maxAttachmentCacheItems,
							maxLogicalBytes: this.productAdapter.productSchema.maxActiveTurnLogicalBytes,
						})
					: null,
				candidateOwner: null,
				candidateOwnerFailure: undefined,
			};
			this.transitionStage = stage;
			this.inFlight += 1;
			this.touch();
			this.publishOperationalState();
			const previousSessionHandle = this.sessionHandle;
			let parentIdentityConfirmed = false;
			let identityCommitted = false;
			let retiredParentCleanup: Promise<void> | null = null;
			try {
				const response = await this.productAdapter.sendDecoded(
					proc,
					command,
					(delivery) =>
						this.payloadCustody
							? this.prepareTransitionPayloadDelivery(proc, stage, delivery, command.type)
							: delivery.prepare((transfer) => {
									if (transfer || processToken !== this.processToken || this.proc !== proc) {
										throw new RpcError(command.type, "session_generation_stale");
									}
									return true;
								}),
					this.timeoutFor(command.type),
				);
				if (response.success !== true) {
					parentIdentityConfirmed = true;
					this.commitParentConfirmedTransition(proc, stage);
					return { response };
				}
				stage.phase = "verifying";
				const stateResponse = await this.productAdapter.sendDecoded(
					proc,
					{ type: "get_state" },
					(delivery) =>
						this.payloadCustody
							? this.prepareTransitionPayloadDelivery(proc, stage, delivery, "get_state")
							: delivery.prepare((transfer) => {
									if (transfer || processToken !== this.processToken || this.proc !== proc) {
										throw new RpcError("get_state", "session_generation_stale");
									}
									return true;
								}),
					this.timeoutFor("get_state"),
				);
				if (
					stateResponse.success !== true ||
					stateResponse.command !== "get_state" ||
					!(stateResponse.data as SessionStateDto).sessionFile
				) {
					throw new RpcError(command.type, "unable to verify forked session identity");
				}

				const transition = this.transitionTarget(stateResponse.data as SessionStateDto);
				const nextTarget = transition.target;
				const cancelled = transitionWasCancelled(response);
				if (nextTarget.sessionHandle === previousSessionHandle) {
					if (nextTarget.nativeSessionId !== this.nativeSessionId) {
						throw new RpcError(command.type, "transition changed native id without changing file");
					}
					parentIdentityConfirmed = true;
					this.commitParentConfirmedTransition(proc, stage);
					return { response };
				}
				if (cancelled) {
					throw new RpcError(command.type, "cancelled transition changed session identity");
				}
				const childIdentity: SessionLiveProjectionIdentity = {
					serverEpoch: this.opts.serverEpoch,
					sessionHandle: nextTarget.sessionHandle,
					workspaceId: nextTarget.workspaceId,
					generation: this.generation + 1,
				};
				const childOwner = this.payloadCustody
					? new GenerationContentOwner({
							serverEpoch: this.opts.serverEpoch,
							generation: childIdentity.generation,
							release: this.payloadCustody.releaseHold,
						})
					: null;
				stage.candidateOwner = childOwner;
				if (childOwner) {
					void childOwner.fatalCleanup.catch((error) => {
						if (this.transitionStage === stage && stage.candidateOwner === childOwner) {
							stage.candidateOwnerFailure = error;
						}
					});
				}
				const childProjection = await this.loadProjectionBase(
					processToken,
					proc,
					childIdentity,
					this.transitionRuntimeSnapshot(nextTarget, childIdentity, transition.frozenFile !== null),
					childOwner
						? {
								owner: childOwner,
								isCurrent: () =>
									this.isCurrentPayloadTransition(processToken, proc, stage) &&
									stage.candidateOwner === childOwner &&
									stage.candidateOwnerFailure === undefined,
							}
						: undefined,
				);

				let applied = false;
				await this.opts.commitIdentityTransition(this, {
					previousSessionHandle,
					nextTarget,
					apply: () => {
						if (applied) throw new RpcError(command.type, "transition identity applied twice");
						if (
							processToken !== this.processToken ||
							this.proc !== proc ||
							!proc.running ||
							(this.payloadCustody &&
								(!childOwner ||
									stage.candidateOwner !== childOwner ||
									stage.candidateOwnerFailure !== undefined ||
									!this.isCurrentPayloadTransition(processToken, proc, stage)))
						) {
							throw new RpcError(command.type, "session_generation_stale");
						}
						if (transition.frozenFile) {
							assertFrozenSessionFile(transition.frozenFile, nextTarget.nativeSessionId, nextTarget.cwd);
						} else {
							assertUnpersistedTransitionTarget(nextTarget);
						}
						childProjection.setRuntimePhase(
							childIdentity,
							this.pendingDialogs.size > 0 ? "waiting_ui" : "idle",
						);
						if (childOwner && stage.payloadLedger) stage.payloadLedger.drainTo(childOwner);
						stage.phase = "applying";
						applied = true;
						this.adoptTransitionTarget(nextTarget, transition.frozenFile !== null);
						if (childOwner && parentOwner) {
							this.generationContentOwner = childOwner;
							this.observeGenerationContentFailure(processToken, proc, childOwner);
							retiredParentCleanup = this.beginRetiredGenerationContentCleanup(
								processToken,
								proc,
								childOwner,
								parentOwner,
							);
						}
						this.liveProjection = childProjection;
						identityCommitted = true;
					},
					commitStaged: () => {
						if (!applied || processToken !== this.processToken || this.proc !== proc || !proc.running) {
							throw new RpcError(command.type, "session_generation_stale");
						}
						return this.commitTransitionFrames();
					},
				});
				if (!applied) throw new RpcError(command.type, "transition identity was not committed");
				if (retiredParentCleanup) await retiredParentCleanup;
				return { response, previousSessionHandle };
			} catch (error) {
				if (identityCommitted) {
					if (this.transitionStage) {
						this.transitionStage.frames = [];
						this.transitionStage.bytes = 0;
					}
					await this.stop();
				} else if (!parentIdentityConfirmed) {
					// Pi may already own the child identity. Never attribute buffered child
					// frames to the parent when verification/commit failed.
					if (this.transitionStage) {
						this.transitionStage.frames = [];
						this.transitionStage.bytes = 0;
					}
					this.error = "session identity transition could not be verified";
					await this.stop();
				} else {
					if (this.transitionStage) {
						this.transitionStage.frames = [];
						this.transitionStage.bytes = 0;
					}
					await this.stop();
				}
				throw error;
			} finally {
				const previousOperationalState = this.operationalStateKey();
				this.inFlight = Math.max(0, this.inFlight - 1);
				this.transitionStage = null;
				this.touch();
				this.refreshOperationalStateAndPublish(previousOperationalState);
			}
		});
	}

	private assertPendingCommandCapacity(commandType: string): void {
		if (this.inFlight >= this.opts.maxPendingCommands) {
			throw new RpcError(commandType, "session_runtime_command_capacity");
		}
	}

	private timeoutFor(commandType: string): number {
		return this.opts.commandTimeoutFor?.(commandType) ?? commandTimeoutMs(commandType);
	}

	private transitionTarget(state: SessionStateDto): {
		target: ExistingSessionTarget;
		frozenFile: FrozenSessionFileIdentity | null;
	} {
		if (!state.sessionFile || !this.sessionFile)
			throw new RpcError("get_state", "forked session has no file");
		const sessionFile = canonicalizeSessionFile(state.sessionFile);
		if (path.dirname(sessionFile) !== path.dirname(this.sessionFile)) {
			throw new RpcError("get_state", "forked session escaped the parent session directory");
		}
		const frozenFile = fs.existsSync(sessionFile) ? inspectFrozenSessionFile(sessionFile) : null;
		if (frozenFile) {
			if (
				frozenFile.nativeSessionId !== state.sessionId ||
				canonicalizePathAllowMissing(frozenFile.cwd) !== this.cwd
			) {
				throw new RpcError("get_state", "forked Session Header does not match its verified Pi state");
			}
		} else if (!sessionFileBasenameMatchesId(sessionFile, state.sessionId)) {
			throw new RpcError("get_state", "unpersisted fork path does not match its Pi session id");
		}
		return {
			frozenFile,
			target: {
				kind: "existing",
				sessionHandle: sessionHandleForCanonicalFile(sessionFile),
				workspaceId: this.workspaceId,
				cwd: this.cwd,
				sessionFile,
				nativeSessionId: state.sessionId,
			},
		};
	}

	private adoptTransitionTarget(target: ExistingSessionTarget, identityVerified: boolean): void {
		this.sessionFile = target.sessionFile;
		this.sessionFileIdentityVerified = identityVerified;
		this.sessionHandle = target.sessionHandle;
		this.nativeSessionId = target.nativeSessionId;
		this.opts.target = target;
		this.generation += 1;
		this.lastSeq = 0;
		this.nativeHistoryPlan = null;
		this.nativeHistorySnapshotId = null;
		this.liveProjection = null;
		this.clearReplay();
		this.stickyExtension.clear();
		this.clearPendingTurnReservations();
		this.activeTurnProjectionItems = 0;
		this.activeTurnProjectionBytes = 0;
		this.activeTurnProjectionLogicalBytes = 0;
		this.activeTurnHeadroomReserved = false;
		this.error = undefined;
		this.state = this.pendingDialogs.size > 0 ? "waiting_ui" : "idle";
		this.touch();
	}

	private transitionRuntimeSnapshot(
		target: ExistingSessionTarget,
		identity: SessionLiveProjectionIdentity,
		recoverable: boolean,
	): SessionRuntimeSnapshot {
		return {
			serverEpoch: identity.serverEpoch,
			sessionHandle: identity.sessionHandle,
			workspaceId: identity.workspaceId,
			nativeSessionId: target.nativeSessionId,
			sessionFile: target.sessionFile,
			cwd: target.cwd,
			generation: identity.generation,
			lastSeq: 0,
			state: this.pendingDialogs.size > 0 ? "waiting_ui" : "idle",
			lastActivityAt: this.lastActivityAt,
			recoverable,
		};
	}

	getReplay(
		requestedHandle: string,
		cursor?: ReplayCursor,
	): ReplayResult<
		RuntimeEvent<M>,
		SessionRuntimeProductSnapshot<M>,
		RuntimeExtensionRequest<M>,
		RuntimeMessage<M>
	> {
		const runtime = this.snapshot();
		const resync = (
			reason: Extract<
				ReplayResult<
					RuntimeEvent<M>,
					SessionRuntimeProductSnapshot<M>,
					RuntimeExtensionRequest<M>,
					RuntimeMessage<M>
				>,
				{ type: "resync_required" }
			>["reason"],
		): ReplayResult<
			RuntimeEvent<M>,
			SessionRuntimeProductSnapshot<M>,
			RuntimeExtensionRequest<M>,
			RuntimeMessage<M>
		> => {
			const snapshot = this.sessionSnapshot();
			const chunkedSnapshot = this.chunkedHistoryForSnapshot(snapshot);
			return {
				type: "resync_required",
				runtime,
				reason,
				snapshot,
				...(chunkedSnapshot ? { chunkedSnapshot } : {}),
			};
		};
		if (!cursor) return resync("initial");
		if (cursor.serverEpoch !== this.opts.serverEpoch) return resync("server_epoch_changed");
		if (requestedHandle !== this.sessionHandle) return resync("generation_changed");
		if (cursor.generation !== this.generation) return resync("generation_changed");
		if (cursor.seq < 0 || cursor.seq > this.lastSeq) return resync("invalid_cursor");
		if (cursor.seq === this.lastSeq) return { type: "replay", runtime, frames: [] };
		if (cursor.seq < this.lastTransientSeq) return resync("gap");
		const oldestSeq = this.replay[0]?.seq ?? this.lastSeq + 1;
		if (cursor.seq < oldestSeq - 1) return resync("gap");
		return {
			type: "replay",
			runtime,
			frames: this.replay.filter((frame) => frame.seq > cursor.seq),
		};
	}

	private chunkedHistoryForSnapshot(
		snapshot: SessionRuntimeProductSnapshot<M>,
	): SessionChunkedSnapshot<RuntimeMessage<M>> | undefined {
		const plan = this.nativeHistoryPlan;
		const snapshotId = this.nativeHistorySnapshotId;
		const proc = this.proc;
		if (!plan || !snapshotId || !proc) return undefined;
		const processToken = this.processToken;
		const generation = snapshot.generation;
		const loadedBytes = sessionHistoryMessagesBytes(snapshot.settledMessages);
		return {
			history: {
				totalMessages: plan.totalMessages,
				loadedMessages: snapshot.settledMessages.length,
				loadedBytes,
				totalBytes: Math.max(plan.totalBytes, loadedBytes),
				nextCursor: plan.initialCursor,
			},
			pageTargetBytes: (cursor, limit) => plan.pageTargetBytes(cursor, limit),
			readPage: (cursor, limit, signal) =>
				this.readNativeHistoryPage(processToken, proc, generation, snapshotId, cursor, limit, signal),
		};
	}

	private async readNativeHistoryPage(
		processToken: number,
		proc: PiProcess,
		generation: number,
		snapshotId: string,
		cursor: string,
		limit: number | undefined,
		signal?: AbortSignal,
	): Promise<SessionHistoryPageResult<RuntimeMessage<M>>> {
		const plan = this.nativeHistoryPlan;
		if (
			!plan ||
			this.nativeHistorySnapshotId !== snapshotId ||
			this.generation !== generation ||
			!this.isCurrentNativeHistoryRead(processToken, proc)
		) {
			throw new RpcError("history_page", "session_history_snapshot_stale");
		}
		const timeoutSignal = AbortSignal.timeout(this.timeoutFor("get_messages"));
		const readSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			const slice = await plan.readPage(cursor, limit, readSignal);
			const messages = await this.normalizeNativeHistoryEntries(
				processToken,
				proc,
				slice.entries,
				readSignal,
			);
			if (
				this.nativeHistoryPlan !== plan ||
				this.nativeHistorySnapshotId !== snapshotId ||
				this.generation !== generation ||
				!this.isCurrentNativeHistoryRead(processToken, proc)
			) {
				throw new RpcError("history_page", "session_history_snapshot_stale");
			}
			return {
				messages,
				nextCursor: slice.nextCursor,
				totalMessages: plan.totalMessages,
				totalBytes: Math.max(plan.totalBytes, sessionHistoryMessagesBytes(messages)),
			};
		} catch (error) {
			if (signal?.aborted) {
				throw new SessionHistoryError(
					"session_history_cancelled",
					"native Session history read was cancelled",
				);
			}
			if (timeoutSignal.aborted) {
				throw new RpcError("history_page", "session_history_timeout");
			}
			if (error instanceof SessionHistoryError) {
				throw new RpcError("history_page", error.code);
			}
			throw error;
		}
	}

	sessionSnapshot(): SessionRuntimeProductSnapshot<M> {
		if (this.snapshotCache?.version === this.snapshotVersion) return this.snapshotCache.snapshot;
		const snapshot = this.buildSessionSnapshot();
		if (!this.isProductSnapshot(snapshot)) {
			this.terminalizeSnapshotOverflow();
			throw new RpcError("session_snapshot", "session_snapshot_overflow");
		}
		try {
			this.productAdapter.productSchema.snapshotLogicalBytes(snapshot);
		} catch {
			this.terminalizeSnapshotOverflow();
			throw new RpcError("session_snapshot", "session_snapshot_overflow");
		}
		const version = this.snapshotVersion;
		const frozenSnapshot = deepFreeze(snapshot);
		this.snapshotCache = { version, snapshot: frozenSnapshot };
		return frozenSnapshot;
	}

	private buildSessionSnapshot(
		source: SessionLiveProjection<
			RuntimeMessage<M>,
			RuntimeEvent<M>,
			RuntimeExtensionRequest<M>
		> | null = this.liveProjection,
		runtime: SessionRuntimeSnapshot = this.snapshot(),
		extensionState: {
			pendingDialogs: ReadonlyMap<string, PendingDialog<RuntimeExtensionRequest<M>>>;
			stickyExtension: ReadonlyMap<string, RuntimeExtensionRequest<M>>;
		} = { pendingDialogs: this.pendingDialogs, stickyExtension: this.stickyExtension },
	): unknown {
		const projection = source?.snapshot();
		if (!projection || projection.asOfSeq !== this.lastSeq) {
			throw new RpcError("session_snapshot", "session_snapshot_unavailable");
		}
		return this.buildSessionSnapshotFromProjection(projection, runtime, extensionState);
	}

	private buildSessionSnapshotFromProjection(
		projection: SessionLiveProjectionSnapshot<RuntimeMessage<M>, RuntimeEvent<M>, RuntimeExtensionRequest<M>>,
		runtime: SessionRuntimeSnapshot = this.snapshot(),
		extensionState: {
			pendingDialogs: ReadonlyMap<string, PendingDialog<RuntimeExtensionRequest<M>>>;
			stickyExtension: ReadonlyMap<string, RuntimeExtensionRequest<M>>;
		} = { pendingDialogs: this.pendingDialogs, stickyExtension: this.stickyExtension },
	): unknown {
		return structuredClone({
			type: "session_snapshot" as const,
			snapshotId: this.nativeHistorySnapshotId ?? randomUUID(),
			serverEpoch: projection.serverEpoch,
			sessionHandle: projection.sessionHandle,
			workspaceId: projection.workspaceId,
			generation: projection.generation,
			baseSeq: projection.baseSeq,
			asOfSeq: projection.asOfSeq,
			runtime: { ...runtime, state: projection.runtimePhase },
			settledMessages: projection.settledMessages,
			projectionEvents: projection.projectionEvents,
			queue: projection.queue,
			pendingExtensionRequests: [...extensionState.pendingDialogs.values()].map((entry) => entry.request),
			stickyExtensionState: [...extensionState.stickyExtension.values()],
		});
	}

	private assertProductSnapshotCandidateFits(candidateSnapshot: unknown): void {
		if (!this.productAdapter.productSchema.guardSnapshot(candidateSnapshot)) {
			throw new SessionLiveProjectionLimitError("snapshot");
		}
		try {
			this.productAdapter.productSchema.snapshotLogicalBytes(candidateSnapshot);
		} catch {
			throw new SessionLiveProjectionLimitError("snapshot");
		}
	}

	private assertWireSnapshotFits(): void {
		const snapshot = this.buildSessionSnapshot();
		if (this.isProductSnapshot(snapshot)) {
			try {
				this.productAdapter.productSchema.snapshotLogicalBytes(snapshot);
				return;
			} catch {
				// Fall through to the existing terminal overflow path.
			}
		}
		if (this.startupReady) this.terminalizeSnapshotOverflow();
		else {
			this.snapshotOverflow = true;
			this.error = "session_snapshot_overflow";
		}
		throw new RpcError("session_snapshot", "session_snapshot_overflow");
	}

	private isProductSnapshot(value: unknown): value is SessionRuntimeProductSnapshot<M> {
		return this.productAdapter.productSchema.guardSnapshot(value);
	}

	getPendingExtensionRequests(): RuntimeExtensionRequest<M>[] {
		const pending = [...this.pendingDialogs.values()].map((entry) => entry.request);
		return [...this.stickyExtension.values(), ...pending];
	}

	sendExtensionUiResponse(response: ExtensionUiResponseDto): "accepted" | "no_dialog" | "not_running" {
		if (!this.pendingDialogs.has(response.id)) return "no_dialog";
		if (!this.proc?.running) {
			this.closeDialog(response.id, "process_lost");
			return "not_running";
		}
		const previousOperationalState = this.operationalStateKey();
		const publishedOperationalState = this.closeDialog(
			response.id,
			"cancelled" in response && response.cancelled === true ? "cancelled" : "answered",
		);
		this.proc.sendNoResponse(response);
		// A dialog can belong to an extension command that never starts the
		// agent. Restore state from actual events instead of assuming work began.
		const stateChanged = this.refreshOperationalState();
		if (
			!stateChanged &&
			!publishedOperationalState &&
			this.operationalStateKey() !== previousOperationalState
		) {
			this.publishOperationalState();
		}
		return "accepted";
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.manuallyStopped = true;
		this.processToken += 1;
		const proc = this.proc;
		const contentOwner = this.generationContentOwner;
		const discardedCleanup = this.discardedCompactionTransferCleanup;
		const retiredCleanup = this.retiredGenerationContentCleanup;
		const transitionCleanup = this.releaseTransitionStagePayloads(this.transitionStage, contentOwner);
		const starting = this.startPromise;
		this.proc = null;
		this.generationContentOwner = null;
		this.retainedCrashedContentOwner = null;
		this.retiredGenerationContentCleanup = null;
		this.opts.onHotSetChanged?.(this);
		this.clearOwnedOperationalState(!this.snapshotOverflow);
		if (this.payloadCustody) this.liveProjection = null;
		let stopping!: Promise<void>;
		stopping = (async () => {
			try {
				const results = await Promise.allSettled([
					proc?.stop(),
					contentOwner?.release(),
					discardedCleanup,
					retiredCleanup,
					transitionCleanup,
					starting ? Promise.allSettled([starting]) : undefined,
				]);
				const failures = results
					.filter((result): result is PromiseRejectedResult => result.status === "rejected")
					.map((result) => result.reason);
				if (failures.length > 0) {
					const failure = new AggregateError(failures, "Session generation cleanup failed");
					this.generationContentCleanupFailure = failure;
					this.error = "generation_content_cleanup_failed";
					this.state = "crashed";
					throw failure;
				}
				this.finishProcessFinalization();
				this.crashedRecoverable = null;
				this.setState("dormant");
			} finally {
				if (this.stopPromise === stopping) this.stopPromise = null;
			}
		})();
		this.stopPromise = stopping;
		return stopping;
	}

	private prepareDecodedEvent(
		processToken: number,
		proc: PiProcess,
		delivery: PiDecodedDelivery<RuntimeEvent<M>, RuntimeRef<M>>,
	): PiDecodedDeliveryPlan {
		const transition = this.transitionStage;
		const commitMaterializedIdentity = this.inspectMaterializedSessionFile();
		const frame: BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>> = {
			type: "event",
			event: delivery.value,
		};
		if (!this.payloadCustody) {
			return delivery.prepare((transfer) => {
				if (transfer || processToken !== this.processToken || this.proc !== proc) {
					throw new RpcError("event", "session_generation_stale");
				}
				if (commitMaterializedIdentity) this.sessionFileIdentityVerified = true;
				this.enqueueFrame(frame);
				return true;
			});
		}
		if (transition?.payloadLedger && transition.phase !== "applying") {
			if (!this.isCurrentPayloadTransition(processToken, proc, transition)) {
				throw new RpcError("event", "session_generation_stale");
			}
			const bytes = bufferedFrameBytes(frame);
			const nextBytes = transition.bytes + bytes;
			if (nextBytes > this.opts.transientBufferMaxBytes) {
				throw new RpcError("session_transition", "transition_frame_buffer_limit_exceeded");
			}
			const nextFrames = [...transition.frames, frame];
			const logicalBytes = this.productAdapter.productSchema.activeTurnEventLogicalBytes(frame.event);
			return delivery.prepare((transfer) => {
				if (!this.isCurrentPayloadTransition(processToken, proc, transition)) {
					throw new RpcError("event", "session_generation_stale");
				}
				transition.payloadLedger!.admit({ transfer, logicalBytes });
				if (commitMaterializedIdentity) this.sessionFileIdentityVerified = true;
				transition.frames = nextFrames;
				transition.bytes = nextBytes;
				this.touch();
				return true;
			});
		}

		const owner = this.generationContentOwner;
		if (!owner) throw new RpcError("event", "session_generation_stale");
		if (!this.isCurrentGenerationContentOwner(processToken, proc, owner)) {
			throw new RpcError("event", "session_generation_stale");
		}
		if (!this.startupReady) {
			const bytes = bufferedFrameBytes(frame);
			const nextBytes = this.startupFrameBytes + bytes;
			if (nextBytes > this.opts.transientBufferMaxBytes) {
				throw new RpcError("session_start", "startup_frame_buffer_limit_exceeded");
			}
			const nextFrames = [...this.startupFrames, frame];
			return delivery.prepare((transfer) => {
				if (!this.isCurrentGenerationContentOwner(processToken, proc, owner)) {
					throw new RpcError("event", "session_generation_stale");
				}
				if (transfer) owner.adopt(transfer);
				if (commitMaterializedIdentity) this.sessionFileIdentityVerified = true;
				this.startupFrames = nextFrames;
				this.startupFrameBytes = nextBytes;
				this.touch();
				return true;
			});
		}

		const prepared = this.prepareActiveEventPublication(frame);
		return delivery.prepare((transfer) => {
			if (!this.isCurrentGenerationContentOwner(processToken, proc, owner)) {
				throw new RpcError("event", "session_generation_stale");
			}
			if (transfer) owner.adopt(transfer);
			try {
				if (commitMaterializedIdentity) this.sessionFileIdentityVerified = true;
				this.commitActiveEventPublication(prepared);
			} catch (error) {
				this.terminalizeGenerationContentFailure(processToken, proc, owner, error);
			}
			return true;
		});
	}

	private prepareActiveEventPublication(
		frame: Extract<BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>, { type: "event" }>,
	): PreparedActiveEventPublication<RuntimeMessage<M>, RuntimeEvent<M>, RuntimeExtensionRequest<M>> {
		const projection = this.liveProjection;
		if (!projection) throw new RpcError("session_snapshot", "session_snapshot_unavailable");
		const reset = !this.agentBusy && eventStartsWork(frame.event);
		const items = (reset ? 0 : this.activeTurnProjectionItems) + 1;
		const bytes = (reset ? 0 : this.activeTurnProjectionBytes) + projection.activeTurnEventBytes(frame.event);
		const limit = projection.activeTurnBudget();
		if (items > limit.maxItems || bytes > limit.maxBytes) {
			throw this.normalizeProjectionError(new SessionLiveProjectionLimitError("live_events"));
		}
		let token: SessionLiveProjectionPreparedCommit;
		try {
			token = projection.prepareCommit(this.projectionIdentity(), frame, this.state);
		} catch (error) {
			throw this.normalizeProjectionError(error);
		}
		const logicalContribution = projection.activeTurnEventLogicalBytes(frame.event);
		const logicalBase = reset ? 0 : this.activeTurnProjectionLogicalBytes;
		const maxLogicalBytes = projection.maxActiveTurnLogicalBytes();
		if (logicalContribution > maxLogicalBytes - logicalBase) {
			throw this.normalizeProjectionError(new SessionLiveProjectionLimitError("live_events"));
		}
		const logicalBytes = logicalBase + logicalContribution;
		const envelope: SessionReplayFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>> = {
			...frame,
			serverEpoch: this.opts.serverEpoch,
			sessionHandle: this.sessionHandle,
			workspaceId: this.workspaceId,
			generation: this.generation,
			seq: token.nextSeq,
		};
		const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope));
		if (
			this.productAdapter.mode === "content_ref" &&
			envelopeBytes > this.productAdapter.productSchema.maxReplayFrameWireBytes
		) {
			throw this.normalizeProjectionError(new SessionLiveProjectionLimitError("live_events"));
		}
		const replay = [...this.replay, envelope];
		const replayFrameBytes = [...this.replayFrameBytes, envelopeBytes];
		let replayBytes = this.replayBytes + envelopeBytes;
		let removeCount = 0;
		while (replay.length - removeCount > this.opts.replayLimit || replayBytes > this.opts.replayMaxBytes) {
			replayBytes -= replayFrameBytes[removeCount] ?? 0;
			removeCount += 1;
		}
		if (removeCount > 0) {
			replay.splice(0, removeCount);
			replayFrameBytes.splice(0, removeCount);
		}
		return {
			projection,
			token,
			frame,
			envelope,
			turnBudget: { items, bytes, logicalBytes },
			replay,
			replayFrameBytes,
			replayBytes,
		};
	}

	private commitActiveEventPublication(
		prepared: PreparedActiveEventPublication<RuntimeMessage<M>, RuntimeEvent<M>, RuntimeExtensionRequest<M>>,
	): void {
		if (this.liveProjection !== prepared.projection) {
			throw new RpcError("event", "session_projection_changed_before_commit");
		}
		const seq = prepared.projection.commitPrepared(prepared.token);
		if (seq === null || seq !== prepared.envelope.seq) {
			throw new RpcError("event", "session_projection_commit_invariant_failed");
		}
		this.activeTurnProjectionItems = prepared.turnBudget.items;
		this.activeTurnProjectionBytes = prepared.turnBudget.bytes;
		this.activeTurnProjectionLogicalBytes = prepared.turnBudget.logicalBytes;
		this.replay = prepared.replay;
		this.replayFrameBytes = prepared.replayFrameBytes;
		this.replayBytes = prepared.replayBytes;
		this.lastSeq = seq;
		this.touch();
		this.emitSupervisorMessage(prepared.envelope);
		this.applyFrameState(prepared.frame);
	}

	private terminalizeGenerationContentFailure(
		processToken: number,
		proc: PiProcess,
		owner: GenerationContentOwner<RuntimeRef<M>>,
		error: unknown,
	): void {
		if (!this.isCurrentGenerationContentOwner(processToken, proc, owner)) return;
		this.manuallyStopped = true;
		this.failedProcessToken = processToken;
		this.processToken += 1;
		const discardedCleanup = this.discardedCompactionTransferCleanup;
		const retiredCleanup = this.retiredGenerationContentCleanup;
		const transitionCleanup = this.releaseTransitionStagePayloads(this.transitionStage, owner);
		this.discardedCompactionTransferCleanup = null;
		this.retiredGenerationContentCleanup = null;
		this.proc = null;
		this.generationContentOwner = null;
		this.retainedCrashedContentOwner = null;
		this.opts.onHotSetChanged?.(this);
		this.clearOwnedOperationalState(false);
		this.startupReady = false;
		this.liveProjection = null;
		this.error = `generation content failure: ${error instanceof Error ? error.message : String(error)}`;
		this.state = "crashed";
		this.touch();
		this.emitSupervisorMessage({ type: "runtime_state", runtime: this.snapshot() });
		this.beginTerminalGenerationCleanup("Generation content terminal cleanup", [
			owner.release(),
			proc.stop(),
			discardedCleanup,
			retiredCleanup,
			transitionCleanup,
		]);
	}

	private beginTerminalGenerationCleanup(
		label: string,
		tasks: readonly (Promise<unknown> | null | undefined)[],
	): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		let cleanup!: Promise<void>;
		cleanup = Promise.allSettled(tasks)
			.then((results) => {
				const failures = results
					.filter((result): result is PromiseRejectedResult => result.status === "rejected")
					.map((result) => result.reason);
				if (failures.length === 0) return;
				const failure = new AggregateError(failures, `${label} failed`);
				this.generationContentCleanupFailure = failure;
				this.error = "generation_content_cleanup_failed";
				throw failure;
			})
			.finally(() => {
				if (this.stopPromise === cleanup) this.stopPromise = null;
			});
		this.stopPromise = cleanup;
		void cleanup.catch((error) => {
			this.log("error", `${label} failed for ${this.sessionHandle}: ${String(error)}`);
		});
		return cleanup;
	}

	private applyEventState(event: RuntimeEvent<M>): void {
		const previousState = this.state;
		const previousOperationalState = this.operationalStateKey();
		if (event.type === "queue_update") {
			const previousQueueDepth = this.activeQueueDepth;
			this.activeQueueDepth = event.steering.length + event.followUp.length;
			if (this.activeQueueDepth > 0 && this.nextTurnReservationId > this.queueReservationReleaseCutoff) {
				this.queueReservationReleaseCutoff = this.nextTurnReservationId;
			}
			if (previousQueueDepth > 0 && this.activeQueueDepth === 0 && !this.agentBusy) {
				this.releasePendingTurnsThrough(this.queueReservationReleaseCutoff);
				this.queueReservationReleaseCutoff = 0n;
				this.refreshOperationalState();
			}
		}
		if (event.type === "compaction_start") {
			this.compactionBusy = true;
			this.setState("running");
		} else if (event.type === "compaction_end") {
			this.compactionBusy = false;
			if (event.willRetry) this.agentBusy = true;
			this.refreshOperationalState();
		} else if (eventStartsWork(event)) {
			if (!this.agentBusy) {
				this.consumePendingTurn();
				this.activeTurnHeadroomReserved = true;
			}
			this.agentBusy = true;
			this.setState("running");
		} else if (eventSettlesWork(event)) {
			this.agentBusy = false;
			this.activeTurnProjectionItems = 0;
			this.activeTurnProjectionBytes = 0;
			this.activeTurnProjectionLogicalBytes = 0;
			this.activeTurnHeadroomReserved = false;
			if (this.activeQueueDepth === 0 && this.queueReservationReleaseCutoff > 0n) {
				this.releasePendingTurnsThrough(this.queueReservationReleaseCutoff);
				this.queueReservationReleaseCutoff = 0n;
			}
			this.refreshOperationalState();
		}
		this.touch();
		if (this.state === "idle") this.maybeCompactIdleProjectionBase(false);
		if (this.state === previousState && this.operationalStateKey() !== previousOperationalState) {
			this.publishOperationalState();
		}
	}

	private handleExtensionRequest(processToken: number, request: RuntimeExtensionRequest<M>): void {
		if (processToken !== this.processToken) return;
		this.verifyMaterializedSessionFile();
		if (BLOCKING_DIALOG_METHODS.has(request.method)) {
			const publishImmediately =
				this.transitionStage?.phase === "awaiting_response" || this.transitionStage?.phase === "applying";
			this.trackDialog(request, processToken, !this.transitionStage || publishImmediately);
			// A blocking transition veto must be visible so the command can finish.
			if (publishImmediately) {
				this.emitFrame({ type: "extension_ui_request", request });
				return;
			}
		}
		this.enqueueFrame({ type: "extension_ui_request", request });
	}

	private prepareDecodedExtensionRequest(
		processToken: number,
		proc: PiProcess,
		delivery: PiDecodedDelivery<ExtensionUiRequestDto, EpochStoredContentRef>,
	): PiDecodedDeliveryPlan {
		const owner = this.generationContentOwner;
		if (this.productAdapter.mode !== "content_ref" || !owner) {
			return delivery.prepare((_transfer) => {
				throw new RpcError("extension_ui_request", "content_ref_extension_generation_owner_unavailable");
			});
		}
		if (!this.startupReady && this.transitionStage === null) {
			const prepared = this.prepareStartupExtensionOperation(processToken, delivery.value);
			return delivery.prepare((transfer) => {
				if (!this.isCurrentGenerationContentOwner(processToken, proc, owner)) {
					throw new RpcError("extension_ui_request", "session_generation_stale");
				}
				if (!contentRefExtensionTransferMatches(delivery.value, transfer)) {
					this.manuallyStopped = true;
					throw new RpcError("extension_ui_request", "content_ref_extension_payload_ref_mismatch");
				}
				if (!this.startupExtensionOperationEligible(prepared)) {
					this.manuallyStopped = true;
					throw new RpcError("extension_ui_request", "extension_semantic_operation_stale");
				}
				if (transfer) owner.adopt(transfer);
				this.commitStartupExtensionOperation(prepared);
				return true;
			});
		}
		if (this.transitionStage !== null) {
			const transitionStage = this.transitionStage;
			if (
				transitionStage.phase !== "applying" &&
				contentRefExtensionStagesDuringTransition(delivery.value, transitionStage.phase)
			) {
				if (
					!transitionStage.payloadLedger ||
					!this.isCurrentPayloadTransition(processToken, proc, transitionStage)
				) {
					throw new RpcError("extension_ui_request", "session_generation_stale");
				}
				const frame: BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>> = {
					type: "extension_ui_request",
					request: delivery.value,
				};
				const frameBytes = bufferedFrameBytes(frame);
				const nextBytes = transitionStage.bytes + frameBytes;
				if (nextBytes > this.opts.transientBufferMaxBytes) {
					throw new RpcError("session_transition", "transition_frame_buffer_limit_exceeded");
				}
				const nextFrames = [...transitionStage.frames, frame];
				const logicalBytes = this.productAdapter.productSchema.extensionRequestLogicalBytes(delivery.value);
				return delivery.prepare((transfer) => {
					if (
						this.transitionStage !== transitionStage ||
						transitionStage.phase === "applying" ||
						!transitionStage.payloadLedger ||
						!this.isCurrentPayloadTransition(processToken, proc, transitionStage)
					) {
						throw new RpcError("extension_ui_request", "session_generation_stale");
					}
					if (!contentRefExtensionTransferMatches(delivery.value, transfer)) {
						this.manuallyStopped = true;
						throw new RpcError("extension_ui_request", "content_ref_extension_payload_ref_mismatch");
					}
					transitionStage.payloadLedger.admit({ transfer, logicalBytes });
					if (BLOCKING_DIALOG_METHODS.has(delivery.value.method)) {
						this.trackDialog(delivery.value, processToken, false);
					}
					transitionStage.frames = nextFrames;
					transitionStage.bytes = nextBytes;
					this.touch();
					return true;
				});
			}
			if (transitionStage.phase === "applying") {
				// The verified child generation is already authoritative. Reuse the
				// normal owner/admission path instead of creating a second transition store.
			} else {
				return delivery.prepare((transfer) => {
					if (!this.isCurrentGenerationContentOwner(processToken, proc, owner)) {
						throw new RpcError("extension_ui_request", "session_generation_stale");
					}
					if (
						this.startupReady &&
						this.transitionStage === transitionStage &&
						transitionStage?.phase === "awaiting_response" &&
						BLOCKING_DIALOG_METHODS.has(delivery.value.method) &&
						contentRefExtensionTransferMatches(delivery.value, transfer)
					) {
						if (transfer) owner.adopt(transfer);
						this.handleExtensionRequest(processToken, delivery.value);
						return true;
					}
					this.manuallyStopped = true;
					throw new RpcError("extension_ui_request", "content_ref_extension_delivery_phase_unsupported");
				});
			}
		}
		this.verifyMaterializedSessionFile();
		const prepared = this.prepareExtensionRequestSemanticOperation(processToken, delivery.value);
		return delivery.prepare((transfer) => {
			if (!this.isCurrentGenerationContentOwner(processToken, proc, owner)) {
				throw new RpcError("extension_ui_request", "session_generation_stale");
			}
			if (!contentRefExtensionTransferMatches(delivery.value, transfer)) {
				this.manuallyStopped = true;
				throw new RpcError("extension_ui_request", "content_ref_extension_payload_ref_mismatch");
			}
			if (!this.extensionSemanticOperationEligible(prepared)) {
				this.manuallyStopped = true;
				throw new RpcError("extension_ui_request", "extension_semantic_operation_stale");
			}
			if (transfer) owner.adopt(transfer);
			try {
				this.commitExtensionSemanticOperation(prepared);
			} catch (error) {
				this.terminalizeGenerationContentFailure(processToken, proc, owner, error);
			}
			return true;
		});
	}

	private prepareStartupExtensionOperation(
		processToken: number,
		request: RuntimeExtensionRequest<M>,
	): PreparedStartupExtensionOperation<RuntimeEvent<M>, RuntimeExtensionRequest<M>> {
		const replaced = BLOCKING_DIALOG_METHODS.has(request.method)
			? this.pendingDialogs.get(request.id)
			: undefined;
		const plan = this.planExtensionRequestSemanticMutation(request, false);
		const retainedStartupFrames = replaced
			? this.startupFrames.filter(
					(frame) => frame.type !== "extension_ui_request" || frame.request !== replaced.request,
				)
			: this.startupFrames;
		let startupFrameBytes = 0;
		try {
			let extensionLogicalBytes = 0;
			for (const entry of plan.pendingDialogs.values()) {
				const logicalBytes = this.productAdapter.productSchema.extensionRequestLogicalBytes(entry.request);
				if (
					logicalBytes >
					this.productAdapter.productSchema.maxSnapshotLogicalBytes - extensionLogicalBytes
				) {
					throw new SessionLiveProjectionLimitError("extension_state");
				}
				extensionLogicalBytes += logicalBytes;
			}
			for (const stickyRequest of plan.stickyExtension.values()) {
				const logicalBytes = this.productAdapter.productSchema.extensionRequestLogicalBytes(stickyRequest);
				if (
					logicalBytes >
					this.productAdapter.productSchema.maxSnapshotLogicalBytes - extensionLogicalBytes
				) {
					throw new SessionLiveProjectionLimitError("extension_state");
				}
				extensionLogicalBytes += logicalBytes;
			}
			for (const frame of [...retainedStartupFrames, ...plan.frames]) {
				if (frame.type === "extension_ui_request") {
					this.productAdapter.productSchema.extensionRequestLogicalBytes(frame.request);
				}
				const frameBytes = bufferedFrameBytes(frame);
				if (frameBytes > this.opts.transientBufferMaxBytes - startupFrameBytes) {
					throw new RpcError("session_start", "startup_frame_buffer_limit_exceeded");
				}
				startupFrameBytes += frameBytes;
			}
		} catch (error) {
			if (
				error instanceof SessionProductSchemaLogicalError ||
				error instanceof SessionLiveProjectionLimitError
			) {
				throw this.normalizeProjectionError(new SessionLiveProjectionLimitError("extension_state"));
			}
			throw error;
		}
		return {
			...plan,
			processToken,
			semanticRevision: this.extensionSemanticRevision,
			startupFrameCount: this.startupFrames.length,
			startupFrameBytesBefore: this.startupFrameBytes,
			startupFrames: [...retainedStartupFrames, ...plan.frames],
			startupFrameBytes,
		};
	}

	private startupExtensionOperationEligible(
		prepared: PreparedStartupExtensionOperation<RuntimeEvent<M>, RuntimeExtensionRequest<M>>,
	): boolean {
		return (
			prepared.processToken === this.processToken &&
			!this.startupReady &&
			this.transitionStage === null &&
			this.liveProjection === null &&
			prepared.semanticRevision === this.extensionSemanticRevision &&
			prepared.startupFrameCount === this.startupFrames.length &&
			prepared.startupFrameBytesBefore === this.startupFrameBytes
		);
	}

	private commitStartupExtensionOperation(
		prepared: PreparedStartupExtensionOperation<RuntimeEvent<M>, RuntimeExtensionRequest<M>>,
	): void {
		this.pendingDialogs = prepared.pendingDialogs;
		this.stickyExtension = prepared.stickyExtension;
		this.startupFrames = prepared.startupFrames;
		this.startupFrameBytes = prepared.startupFrameBytes;
		this.extensionSemanticRevision += 1;
		this.touch();
		for (const entry of prepared.timersToClear) {
			this.runCommittedExtensionEffect("clear startup dialog timer", () => {
				if (entry.timer) clearTimeout(entry.timer);
			});
		}
		for (const entry of prepared.timersToArm) {
			this.runCommittedExtensionEffect("arm startup dialog timer", () =>
				this.armDialogTimer(prepared.processToken, entry),
			);
		}
		if (prepared.warnOversizedSticky) {
			this.runCommittedExtensionEffect("log oversized startup sticky Extension state", () =>
				this.log("warn", `Dropping oversized sticky extension state for ${this.sessionHandle}`),
			);
		}
	}

	private verifyMaterializedSessionFile(): void {
		if (this.inspectMaterializedSessionFile()) this.sessionFileIdentityVerified = true;
	}

	/** Pure carrier phase-one validation; returns whether phase two must freeze the identity. */
	private inspectMaterializedSessionFile(): boolean {
		if (this.sessionFileIdentityVerified || !this.sessionFile || !fs.existsSync(this.sessionFile))
			return false;
		const frozenFile = inspectFrozenSessionFile(this.sessionFile);
		if (
			frozenFile.nativeSessionId !== this.nativeSessionId ||
			canonicalizePathAllowMissing(frozenFile.cwd) !== this.cwd
		) {
			throw new RpcError("get_state", "materialized Pi Session Header does not match its pending identity");
		}
		return true;
	}

	private prepareExtensionRequestSemanticOperation(
		processToken: number,
		request: RuntimeExtensionRequest<M>,
	): PreparedExtensionSemanticOperation<RuntimeMessage<M>, RuntimeEvent<M>, RuntimeExtensionRequest<M>> {
		return this.prepareExtensionSemanticOperation({
			processToken,
			...this.planExtensionRequestSemanticMutation(request),
		});
	}

	private planExtensionRequestSemanticMutation(
		request: RuntimeExtensionRequest<M>,
		publishReplacedClose = true,
		extensionState: {
			pendingDialogs: ReadonlyMap<string, PendingDialog<RuntimeExtensionRequest<M>>>;
			stickyExtension: ReadonlyMap<string, RuntimeExtensionRequest<M>>;
		} = { pendingDialogs: this.pendingDialogs, stickyExtension: this.stickyExtension },
	): ExtensionSemanticPlan<RuntimeEvent<M>, RuntimeExtensionRequest<M>> {
		const pendingDialogs = new Map(extensionState.pendingDialogs);
		const stickyExtension = new Map(extensionState.stickyExtension);
		const frames: BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[] = [];
		const timersToClear: PendingDialog<RuntimeExtensionRequest<M>>[] = [];
		const timersToArm: PendingDialog<RuntimeExtensionRequest<M>>[] = [];
		let warnOversizedSticky = false;

		if (BLOCKING_DIALOG_METHODS.has(request.method)) {
			const replaced = pendingDialogs.get(request.id);
			if (replaced) {
				pendingDialogs.delete(request.id);
				timersToClear.push(replaced);
				if (publishReplacedClose) {
					frames.push({ type: "extension_ui_closed", requestId: request.id, reason: "replaced" });
				}
			}
			const entry: PendingDialog<RuntimeExtensionRequest<M>> = { request, timer: null };
			pendingDialogs.set(request.id, entry);
			if (
				pendingDialogs.size > this.opts.pendingDialogLimit ||
				!this.extensionStateMapsFit(pendingDialogs, stickyExtension)
			) {
				throw new RpcError("extension_ui_request", "pending_dialog_state_limit_exceeded");
			}
			timersToArm.push(entry);
			frames.push({ type: "extension_ui_request", request });
		} else if (STICKY_EXTENSION_METHODS.has(request.method)) {
			const key = stickyRequestKey(request);
			if (stickyRequestClearsState(request)) {
				stickyExtension.delete(key);
				frames.push({ type: "extension_ui_request", request });
			} else {
				stickyExtension.delete(key);
				while (stickyExtension.size > 0) {
					stickyExtension.set(key, request);
					if (this.extensionStateMapsFit(pendingDialogs, stickyExtension)) break;
					stickyExtension.delete(key);
					const oldestKey = stickyExtension.keys().next().value;
					if (typeof oldestKey !== "string") break;
					const oldest = stickyExtension.get(oldestKey);
					if (!oldest) break;
					stickyExtension.delete(oldestKey);
					frames.push({ type: "extension_ui_request", request: this.stickyClearRequest(oldest) });
				}
				stickyExtension.set(key, request);
				if (!this.extensionStateMapsFit(pendingDialogs, stickyExtension)) {
					stickyExtension.delete(key);
					frames.push({ type: "extension_ui_request", request: this.stickyClearRequest(request) });
					warnOversizedSticky = true;
				} else {
					frames.push({ type: "extension_ui_request", request });
				}
			}
		} else {
			frames.push({ type: "extension_ui_request", request });
		}

		return {
			frames,
			pendingDialogs,
			stickyExtension,
			timersToClear,
			timersToArm,
			warnOversizedSticky,
		};
	}

	private prepareExtensionSemanticOperation(input: {
		processToken: number;
		frames: readonly BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[];
		pendingDialogs: Map<string, PendingDialog<RuntimeExtensionRequest<M>>>;
		stickyExtension: Map<string, RuntimeExtensionRequest<M>>;
		timersToClear: readonly PendingDialog<RuntimeExtensionRequest<M>>[];
		timersToArm: readonly PendingDialog<RuntimeExtensionRequest<M>>[];
		warnOversizedSticky: boolean;
	}): PreparedExtensionSemanticOperation<RuntimeMessage<M>, RuntimeEvent<M>, RuntimeExtensionRequest<M>> {
		const projection = this.liveProjection;
		if (!projection) throw new RpcError("session_snapshot", "session_snapshot_unavailable");
		try {
			const token = projection.prepareBatch(this.projectionIdentity(), input.frames, this.state);
			const candidateProjection = projection.previewPreparedBatch(token);
			if (!candidateProjection) {
				throw new RpcError("extension_ui_request", "extension_projection_prepare_stale");
			}
			const candidateRuntime: SessionRuntimeSnapshot = {
				...this.snapshot(),
				lastSeq: token.lastSeq,
			};
			this.assertProductSnapshotCandidateFits(
				this.buildSessionSnapshotFromProjection(candidateProjection, candidateRuntime, {
					pendingDialogs: input.pendingDialogs,
					stickyExtension: input.stickyExtension,
				}),
			);
			const envelopes: SessionReplayFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[] = [];
			for (const [index, frame] of input.frames.entries()) {
				envelopes.push({
					...frame,
					serverEpoch: this.opts.serverEpoch,
					sessionHandle: this.sessionHandle,
					workspaceId: this.workspaceId,
					generation: this.generation,
					seq: token.firstSeq + index,
				});
			}
			const replay = [...this.replay];
			const replayFrameBytes = [...this.replayFrameBytes];
			let replayBytes = this.replayBytes;
			let lastTransientSeq = this.lastTransientSeq;
			for (const [index, frame] of input.frames.entries()) {
				const envelope = envelopes[index];
				if (!envelope) throw new RpcError("extension_ui_request", "extension_envelope_missing");
				const bytes = Buffer.byteLength(JSON.stringify(envelope));
				if (isReplayableFrame(frame)) {
					replay.push(envelope);
					replayFrameBytes.push(bytes);
					replayBytes += bytes;
				} else {
					lastTransientSeq = envelope.seq;
				}
			}
			let removeCount = 0;
			while (replay.length - removeCount > this.opts.replayLimit || replayBytes > this.opts.replayMaxBytes) {
				replayBytes -= replayFrameBytes[removeCount] ?? 0;
				removeCount += 1;
			}
			if (removeCount > 0) {
				replay.splice(0, removeCount);
				replayFrameBytes.splice(0, removeCount);
			}
			return {
				projection,
				token,
				semanticRevision: this.extensionSemanticRevision,
				envelopes,
				replay,
				replayFrameBytes,
				replayBytes,
				lastTransientSeq,
				pendingDialogs: input.pendingDialogs,
				stickyExtension: input.stickyExtension,
				timersToClear: input.timersToClear,
				timersToArm: input.timersToArm,
				processToken: input.processToken,
				warnOversizedSticky: input.warnOversizedSticky,
			};
		} catch (error) {
			if (error instanceof SessionLiveProjectionLimitError) {
				throw this.normalizeProjectionError(error);
			}
			throw error;
		}
	}

	private commitExtensionSemanticOperation(
		prepared: PreparedExtensionSemanticOperation<
			RuntimeMessage<M>,
			RuntimeEvent<M>,
			RuntimeExtensionRequest<M>
		>,
	): void {
		if (!this.extensionSemanticOperationEligible(prepared)) {
			throw new RpcError("extension_ui_request", "extension_semantic_operation_stale");
		}
		const previousOperationalState = this.operationalStateKey();
		const committed = prepared.projection.commitPreparedBatch(prepared.token);
		if (committed === null || committed !== prepared.token.lastSeq) {
			throw new RpcError("extension_ui_request", "extension_projection_commit_invariant_failed");
		}
		this.pendingDialogs = prepared.pendingDialogs;
		this.stickyExtension = prepared.stickyExtension;
		this.extensionSemanticRevision += 1;
		this.replay = prepared.replay;
		this.replayFrameBytes = prepared.replayFrameBytes;
		this.replayBytes = prepared.replayBytes;
		this.lastTransientSeq = prepared.lastTransientSeq;
		this.lastSeq = prepared.token.lastSeq;
		const stateChanged = prepared.pendingDialogs.size > 0 && this.state !== "waiting_ui";
		if (stateChanged) this.state = "waiting_ui";
		this.touch();
		const operationalStateChanged = this.operationalStateKey() !== previousOperationalState;

		for (const entry of prepared.timersToClear) {
			this.runCommittedExtensionEffect("clear dialog timer", () => {
				if (entry.timer) clearTimeout(entry.timer);
			});
		}
		for (const entry of prepared.timersToArm) {
			this.runCommittedExtensionEffect("arm dialog timer", () =>
				this.armDialogTimer(prepared.processToken, entry),
			);
		}
		if (stateChanged || operationalStateChanged) {
			this.runCommittedExtensionEffect("refresh hot Runtime inventory", () =>
				this.opts.onHotSetChanged?.(this),
			);
			this.runCommittedExtensionEffect("publish waiting Extension state", () =>
				this.emitSupervisorMessage({ type: "runtime_state", runtime: this.snapshot() }),
			);
		}
		for (const envelope of prepared.envelopes) {
			this.runCommittedExtensionEffect("publish Extension frame", () => this.emitSupervisorMessage(envelope));
		}
		if (prepared.warnOversizedSticky) {
			this.runCommittedExtensionEffect("log oversized sticky Extension state", () =>
				this.log("warn", `Dropping oversized sticky extension state for ${this.sessionHandle}`),
			);
		}
	}

	private extensionSemanticOperationEligible(
		prepared: PreparedExtensionSemanticOperation<
			RuntimeMessage<M>,
			RuntimeEvent<M>,
			RuntimeExtensionRequest<M>
		>,
	): boolean {
		return (
			prepared.processToken === this.processToken &&
			this.liveProjection === prepared.projection &&
			prepared.semanticRevision === this.extensionSemanticRevision &&
			prepared.projection.previewPreparedBatch(prepared.token) !== null
		);
	}

	private runCommittedExtensionEffect(label: string, effect: () => void): void {
		try {
			effect();
		} catch {
			try {
				this.log("error", `Committed Extension effect failed: ${label}`);
			} catch {
				// A committed projection cannot be rolled back because an observer failed.
			}
		}
	}

	private armDialogTimer(processToken: number, entry: PendingDialog<RuntimeExtensionRequest<M>>): void {
		const request = entry.request;
		const timeout =
			"timeout" in request && typeof request.timeout === "number" && request.timeout > 0
				? request.timeout
				: undefined;
		if (!timeout) return;
		entry.timer = setTimeout(() => this.expireDialog(processToken, request.id, entry), timeout);
		entry.timer.unref?.();
	}

	private extensionStateMapsFit(
		pendingDialogs: ReadonlyMap<string, PendingDialog<RuntimeExtensionRequest<M>>>,
		stickyExtension: ReadonlyMap<string, RuntimeExtensionRequest<M>>,
	): boolean {
		let bytes = 0;
		for (const request of stickyExtension.values()) bytes += extensionRequestBytes(request);
		for (const { request } of pendingDialogs.values()) bytes += extensionRequestBytes(request);
		return (
			bytes <= this.opts.extensionStateMaxBytes &&
			pendingDialogs.size + stickyExtension.size <= this.opts.extensionStateMaxItems
		);
	}

	private trackDialog(
		request: RuntimeExtensionRequest<M>,
		processToken: number,
		publishState: boolean,
	): void {
		this.closeDialog(request.id, "replaced");
		const previousOperationalState = this.operationalStateKey();
		const requestBytes = extensionRequestBytes(request);
		if (
			this.pendingDialogs.size >= this.opts.pendingDialogLimit ||
			!this.extensionStateFits(requestBytes, 1)
		) {
			throw new RpcError("extension_ui_request", "pending_dialog_state_limit_exceeded");
		}
		const timeout =
			"timeout" in request && typeof request.timeout === "number" && request.timeout > 0
				? request.timeout
				: undefined;
		const entry: PendingDialog<RuntimeExtensionRequest<M>> = { request, timer: null };
		if (timeout) {
			entry.timer = setTimeout(() => this.expireDialog(processToken, request.id, entry), timeout);
			entry.timer.unref?.();
		}
		this.pendingDialogs.set(request.id, entry);
		this.extensionSemanticRevision += 1;
		this.touch();
		if (publishState) {
			const stateChanged = this.state !== "waiting_ui";
			this.setState("waiting_ui");
			if (!stateChanged && this.operationalStateKey() !== previousOperationalState) {
				this.publishOperationalState();
			}
		}
	}

	private extensionStateFits(extraBytes: number, extraItems: number): boolean {
		return (
			this.extensionStateBytes() + extraBytes <= this.opts.extensionStateMaxBytes &&
			this.pendingDialogs.size + this.stickyExtension.size + extraItems <= this.opts.extensionStateMaxItems
		);
	}

	private extensionStateBytes(): number {
		let bytes = 0;
		for (const request of this.stickyExtension.values()) bytes += extensionRequestBytes(request);
		for (const { request } of this.pendingDialogs.values()) bytes += extensionRequestBytes(request);
		return bytes;
	}

	private enqueueFrame(frame: BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>): void {
		this.touch();
		const bytes = bufferedFrameBytes(frame);
		if (!this.startupReady) {
			this.startupFrameBytes += bytes;
			if (this.startupFrameBytes > this.opts.transientBufferMaxBytes) {
				throw new RpcError("session_start", "startup_frame_buffer_limit_exceeded");
			}
			this.startupFrames.push(frame);
			return;
		}
		if (this.transitionStage && this.transitionStage.phase !== "applying") {
			this.transitionStage.bytes += bytes;
			if (this.transitionStage.bytes > this.opts.transientBufferMaxBytes) {
				throw new RpcError("session_transition", "transition_frame_buffer_limit_exceeded");
			}
			this.transitionStage.frames.push(frame);
			return;
		}
		// Deliver the authoritative replayable frame before publishing any
		// runtime state derived from it. A background client may unsubscribe as
		// soon as it observes `idle`; publishing `idle` first would therefore
		// discard the `agent_settled` frame that made the runtime idle.
		this.publishFrame(frame);
	}

	private flushFrames(frames: BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[]): void {
		for (const frame of frames) {
			if (
				frame.type === "extension_ui_request" &&
				BLOCKING_DIALOG_METHODS.has(frame.request.method) &&
				!this.pendingDialogs.has(frame.request.id)
			) {
				continue;
			}
			this.publishFrame(frame);
		}
	}

	private flushPreparedContentRefStartupFrames(
		frames: BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[],
	): void {
		for (const frame of this.authoritativeContentRefStartupFrames(frames)) {
			if (frame.type === "event") {
				this.publishFrame(frame);
			} else {
				this.emitFrame(frame);
			}
		}
	}

	private authoritativeContentRefStartupFrames(
		frames: readonly BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[],
	): BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[] {
		return frames.filter(
			(frame) =>
				frame.type !== "extension_ui_request" ||
				!BLOCKING_DIALOG_METHODS.has(frame.request.method) ||
				this.pendingDialogs.get(frame.request.id)?.request === frame.request,
		);
	}

	private publishFrame(frame: BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>): void {
		if (frame.type === "event") {
			this.commitActiveEventPublication(this.prepareActiveEventPublication(frame));
			return;
		}
		if (frame.type === "extension_ui_request" && STICKY_EXTENSION_METHODS.has(frame.request.method)) {
			this.publishStickyRequest(frame.request);
			return;
		}
		this.emitFrame(frame);
		this.applyFrameState(frame);
	}

	private publishStickyRequest(request: RuntimeExtensionRequest<M>): void {
		const key = stickyRequestKey(request);
		if (stickyRequestClearsState(request)) {
			this.emitFrame({ type: "extension_ui_request", request }, () => {
				this.stickyExtension.delete(key);
				this.extensionSemanticRevision += 1;
			});
			return;
		}

		const requestBytes = extensionRequestBytes(request);
		const candidate = new Map(this.stickyExtension);
		candidate.delete(key);
		while (candidate.size > 0 && !this.extensionStateCandidateFits(candidate, requestBytes, 1)) {
			const oldestKey = candidate.keys().next().value as string | undefined;
			if (!oldestKey) break;
			const oldest = candidate.get(oldestKey);
			if (!oldest) break;
			this.emitFrame({ type: "extension_ui_request", request: this.stickyClearRequest(oldest) }, () => {
				this.stickyExtension.delete(oldestKey);
				this.extensionSemanticRevision += 1;
			});
			candidate.delete(oldestKey);
		}
		if (!this.extensionStateCandidateFits(candidate, requestBytes, 1)) {
			this.emitFrame({ type: "extension_ui_request", request: this.stickyClearRequest(request) }, () => {
				this.stickyExtension.delete(key);
				this.extensionSemanticRevision += 1;
			});
			this.log("warn", `Dropping oversized sticky extension state for ${this.sessionHandle}`);
			return;
		}
		this.emitFrame({ type: "extension_ui_request", request }, () => {
			this.stickyExtension.delete(key);
			this.stickyExtension.set(key, request);
			this.extensionSemanticRevision += 1;
		});
	}

	private stickyClearRequest(request: RuntimeExtensionRequest<M>): RuntimeExtensionRequest<M> {
		const id = `evicted:${randomUUID()}`;
		let candidate: unknown;
		if (request.method === "setStatus") candidate = { ...request, id, statusText: undefined };
		else if (request.method === "setWidget") candidate = { ...request, id, widgetLines: undefined };
		else if (request.method === "setTitle") candidate = { ...request, id, title: "" };
		else if (request.method === "set_editor_text") candidate = { ...request, id, text: "" };
		else throw new RpcError("extension_ui_request", "invalid_sticky_extension_method");
		if (!this.productAdapter.productSchema.guardExtensionRequest(candidate)) {
			throw new RpcError("extension_ui_request", "invalid_sticky_extension_clear");
		}
		return candidate;
	}

	private extensionStateCandidateFits(
		sticky: ReadonlyMap<string, RuntimeExtensionRequest<M>>,
		extraBytes: number,
		extraItems: number,
	): boolean {
		let bytes = extraBytes;
		for (const request of sticky.values()) bytes += extensionRequestBytes(request);
		for (const { request } of this.pendingDialogs.values()) bytes += extensionRequestBytes(request);
		return (
			bytes <= this.opts.extensionStateMaxBytes &&
			this.pendingDialogs.size + sticky.size + extraItems <= this.opts.extensionStateMaxItems
		);
	}

	private applyFrameState(frame: BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>): void {
		if (frame.type === "event") {
			this.applyEventState(frame.event);
			return;
		}
		if (frame.type === "extension_ui_closed") return;
		if (BLOCKING_DIALOG_METHODS.has(frame.request.method) && this.pendingDialogs.has(frame.request.id)) {
			this.setState("waiting_ui");
		}
	}

	private flushTransitionFrames(): void {
		if (!this.transitionStage) return;
		this.flushFrames(this.transitionStage.frames);
		this.transitionStage.frames = [];
		this.transitionStage.bytes = 0;
	}

	private commitParentConfirmedTransition(
		proc: PiProcess,
		stage: TransitionStage<RuntimeEvent<M>, RuntimeExtensionRequest<M>, RuntimeRef<M>>,
	): void {
		if (stage.payloadLedger) {
			if (!stage.parentOwner || !this.isCurrentPayloadTransition(stage.processToken, proc, stage)) {
				throw new RpcError("session_transition", "session_generation_stale");
			}
			stage.payloadLedger.drainTo(stage.parentOwner);
		}
		if (this.productAdapter.mode === "content_ref") {
			for (const message of this.commitTransitionFrames()) this.emitSupervisorMessage(message);
		} else {
			this.flushTransitionFrames();
		}
	}

	private releaseTransitionStagePayloads(
		stage: TransitionStage<RuntimeEvent<M>, RuntimeExtensionRequest<M>, RuntimeRef<M>> | null,
		currentOwner: GenerationContentOwner<RuntimeRef<M>> | null,
	): Promise<void> | undefined {
		if (!stage) return undefined;
		const attempts: Promise<void>[] = [];
		if (stage.payloadLedger) {
			try {
				attempts.push(stage.payloadLedger.releaseRemaining());
			} catch (error) {
				attempts.push(Promise.reject(error));
			}
		}
		if (stage.candidateOwner && stage.candidateOwner !== currentOwner) {
			try {
				attempts.push(stage.candidateOwner.release());
			} catch (error) {
				attempts.push(Promise.reject(error));
			}
		}
		if (attempts.length === 0) return undefined;
		return Promise.allSettled(attempts).then((results) => {
			const failures = results
				.filter((result): result is PromiseRejectedResult => result.status === "rejected")
				.map((result) => result.reason);
			if (failures.length > 0) {
				throw new AggregateError(failures, "Transition payload cleanup failed");
			}
		});
	}

	private commitTransitionFrames(): SessionSupervisorMessage<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[] {
		if (this.deferredTransitionEmits) {
			throw new RpcError("session_transition", "transition_frame_commit_reentered");
		}
		this.deferredTransitionEmits = [];
		try {
			if (this.productAdapter.mode === "content_ref") {
				try {
					const stage = this.transitionStage;
					if (!stage) throw new RpcError("session_transition", "session_generation_stale");
					if (stage.frames.length === 0) return this.deferredTransitionEmits;
					const plan = this.expandContentRefTransitionSemanticPlan(stage);
					if (plan.frames.length === 0) {
						stage.frames = [];
						stage.bytes = 0;
						return this.deferredTransitionEmits;
					}
					const turnBudget = this.prepareTransitionTurnBudget(plan.frames);
					const prepared = this.prepareExtensionSemanticOperation({
						processToken: stage.processToken,
						...plan,
					});
					this.commitExtensionSemanticOperation(prepared);
					for (const frame of plan.frames) {
						if (frame.type === "event") this.applyFrameState(frame);
					}
					this.activeTurnProjectionItems = turnBudget.items;
					this.activeTurnProjectionBytes = turnBudget.bytes;
					this.activeTurnProjectionLogicalBytes = turnBudget.logicalBytes;
					stage.frames = [];
					stage.bytes = 0;
				} catch (error) {
					throw this.normalizeProjectionError(error);
				}
			} else {
				this.flushTransitionFrames();
			}
			return this.deferredTransitionEmits;
		} finally {
			this.deferredTransitionEmits = null;
		}
	}

	private expandContentRefTransitionSemanticPlan(
		stage: TransitionStage<RuntimeEvent<M>, RuntimeExtensionRequest<M>, RuntimeRef<M>>,
	): ExtensionSemanticPlan<RuntimeEvent<M>, RuntimeExtensionRequest<M>> {
		let pendingDialogs = new Map(this.pendingDialogs);
		let stickyExtension = new Map(this.stickyExtension);
		const frames: BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[] = [];
		const timersToClear: PendingDialog<RuntimeExtensionRequest<M>>[] = [];
		const timersToArm: PendingDialog<RuntimeExtensionRequest<M>>[] = [];
		let warnOversizedSticky = false;
		let bytes = 0;
		for (const frame of stage.frames) {
			if (frame.type === "extension_ui_request") {
				if (BLOCKING_DIALOG_METHODS.has(frame.request.method)) {
					if (this.pendingDialogs.get(frame.request.id)?.request === frame.request) {
						const frameBytes = bufferedFrameBytes(frame);
						if (frameBytes > this.opts.transientBufferMaxBytes - bytes) {
							throw new RpcError("session_transition", "transition_frame_buffer_limit_exceeded");
						}
						bytes += frameBytes;
						frames.push(frame);
					}
					continue;
				}
				const plan = this.planExtensionRequestSemanticMutation(frame.request, true, {
					pendingDialogs,
					stickyExtension,
				});
				pendingDialogs = plan.pendingDialogs;
				stickyExtension = plan.stickyExtension;
				timersToClear.push(...plan.timersToClear);
				timersToArm.push(...plan.timersToArm);
				warnOversizedSticky ||= plan.warnOversizedSticky;
				for (const expanded of plan.frames) {
					const frameBytes = bufferedFrameBytes(expanded);
					if (frameBytes > this.opts.transientBufferMaxBytes - bytes) {
						throw new RpcError("session_transition", "transition_frame_buffer_limit_exceeded");
					}
					bytes += frameBytes;
					frames.push(expanded);
				}
				continue;
			}
			const frameBytes = bufferedFrameBytes(frame);
			if (frameBytes > this.opts.transientBufferMaxBytes - bytes) {
				throw new RpcError("session_transition", "transition_frame_buffer_limit_exceeded");
			}
			bytes += frameBytes;
			frames.push(frame);
		}
		return {
			frames,
			pendingDialogs,
			stickyExtension,
			timersToClear,
			timersToArm,
			warnOversizedSticky,
		};
	}

	private prepareTransitionTurnBudget(
		frames: readonly BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>[],
	): { items: number; bytes: number; logicalBytes: number } {
		const projection = this.liveProjection;
		if (!projection) throw new RpcError("session_transition", "session_snapshot_unavailable");
		let items = this.activeTurnProjectionItems;
		let bytes = this.activeTurnProjectionBytes;
		let logicalBytes = this.activeTurnProjectionLogicalBytes;
		let agentBusy = this.agentBusy;
		const limit = projection.activeTurnBudget();
		const maxLogicalBytes = projection.maxActiveTurnLogicalBytes();
		for (const frame of frames) {
			if (frame.type !== "event") continue;
			const reset = !agentBusy && eventStartsWork(frame.event);
			items = (reset ? 0 : items) + 1;
			bytes = (reset ? 0 : bytes) + projection.activeTurnEventBytes(frame.event);
			const logicalContribution = projection.activeTurnEventLogicalBytes(frame.event);
			const logicalBase = reset ? 0 : logicalBytes;
			if (
				items > limit.maxItems ||
				bytes > limit.maxBytes ||
				logicalContribution > maxLogicalBytes - logicalBase
			) {
				throw new SessionLiveProjectionLimitError("live_events");
			}
			logicalBytes = logicalBase + logicalContribution;
			if (eventStartsWork(frame.event)) agentBusy = true;
			if (eventSettlesWork(frame.event)) {
				agentBusy = false;
				items = 0;
				bytes = 0;
				logicalBytes = 0;
			} else if (frame.event.type === "compaction_end" && frame.event.willRetry) {
				agentBusy = true;
			}
		}
		return { items, bytes, logicalBytes };
	}

	private emitFrame(
		frame: BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>,
		afterProjectionCommit?: () => void,
	): void {
		const projection = this.liveProjection;
		if (!projection) throw new RpcError("session_snapshot", "session_snapshot_unavailable");
		let seq: number;
		let turnBudget: { items: number; bytes: number } | undefined;
		try {
			if (frame.type === "event") {
				const reset = !this.agentBusy && eventStartsWork(frame.event);
				const items = (reset ? 0 : this.activeTurnProjectionItems) + 1;
				const bytes =
					(reset ? 0 : this.activeTurnProjectionBytes) + projection.activeTurnEventBytes(frame.event);
				const limit = projection.activeTurnBudget();
				if (items > limit.maxItems || bytes > limit.maxBytes) {
					throw new SessionLiveProjectionLimitError("live_events");
				}
				turnBudget = { items, bytes };
			}
			const committed = projection.commitPrepared(
				projection.prepareCommit(this.projectionIdentity(), frame, this.state),
			);
			if (committed === null) throw new SessionLiveProjectionLimitError("snapshot");
			seq = committed;
		} catch (error) {
			throw this.normalizeProjectionError(error);
		}
		if (turnBudget) {
			this.activeTurnProjectionItems = turnBudget.items;
			this.activeTurnProjectionBytes = turnBudget.bytes;
		}
		afterProjectionCommit?.();
		this.touch();
		const envelope: SessionReplayFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>> = {
			...frame,
			serverEpoch: this.opts.serverEpoch,
			sessionHandle: this.sessionHandle,
			workspaceId: this.workspaceId,
			generation: this.generation,
			seq,
		};
		const bytes = Buffer.byteLength(JSON.stringify(envelope));
		if (isReplayableFrame(frame)) {
			this.replay.push(envelope);
			this.replayFrameBytes.push(bytes);
			this.replayBytes += bytes;
			let removeCount = 0;
			while (
				this.replay.length - removeCount > this.opts.replayLimit ||
				this.replayBytes > this.opts.replayMaxBytes
			) {
				this.replayBytes -= this.replayFrameBytes[removeCount] ?? 0;
				removeCount += 1;
			}
			if (removeCount > 0) {
				this.replay.splice(0, removeCount);
				this.replayFrameBytes.splice(0, removeCount);
			}
		} else {
			this.lastTransientSeq = seq;
		}
		this.lastSeq = seq;
		this.emitSupervisorMessage(envelope);
	}

	private handleFailure(processToken: number, info: PiProcessExitInfo): void {
		if (processToken !== this.processToken || this.failedProcessToken === processToken) return;
		this.failedProcessToken = processToken;
		const contentOwner = this.generationContentOwner;
		const discardedCleanup = this.discardedCompactionTransferCleanup;
		const recoveryTarget = this.rebuildTarget();
		const recoverableCrash = recoveryTarget !== null;
		const unexpectedLeaderCrash = info.reason === undefined && (info.code !== null || info.signal !== null);
		this.crashedRecoverable = this.payloadCustody ? recoverableCrash : null;
		let retainContent =
			this.payloadCustody !== null &&
			contentOwner !== null &&
			unexpectedLeaderCrash &&
			!recoverableCrash &&
			this.startupReady &&
			this.transitionStage === null &&
			this.retiredGenerationContentCleanup === null &&
			this.discardedCompactionTransferCleanup === null &&
			this.liveProjection?.isAtSeq(this.lastSeq) === true;
		if (retainContent) {
			try {
				this.liveProjection!.setRuntimePhase(this.projectionIdentity(), "crashed");
				contentOwner!.seal();
			} catch {
				retainContent = false;
			}
		}
		const retiredCleanup = retainContent ? null : this.retiredGenerationContentCleanup;
		const transitionCleanup = retainContent
			? undefined
			: this.releaseTransitionStagePayloads(this.transitionStage, contentOwner);
		this.proc = null;
		if (!retainContent) this.generationContentOwner = null;
		this.retiredGenerationContentCleanup = null;
		this.opts.onHotSetChanged?.(this);
		this.finishProcessFinalization();
		this.clearOwnedOperationalState(retainContent ? false : !this.snapshotOverflow);
		if (this.payloadCustody && !retainContent) this.liveProjection = null;
		this.terminalProtocolIncompatible = info.reason === "protocol_incompatible";
		this.error = this.snapshotOverflow
			? "session_snapshot_overflow"
			: this.terminalProtocolIncompatible
				? "protocol_incompatible"
				: this.describeFailure(info);
		this.setState("crashed", retainContent);
		this.log("error", `Pi runtime crashed for ${this.sessionHandle}: ${this.error}`);
		if (retainContent && contentOwner) {
			this.retainedCrashedContentOwner = {
				processToken,
				generation: this.generation,
				owner: contentOwner,
			};
			this.observeRetainedGenerationContentFailure(processToken, this.generation, contentOwner);
		} else if (
			(contentOwner || discardedCleanup || retiredCleanup || transitionCleanup) &&
			!this.stopPromise
		) {
			this.beginTerminalGenerationCleanup("Crashed generation content cleanup", [
				contentOwner?.release(),
				discardedCleanup,
				retiredCleanup,
				transitionCleanup,
			]);
		}
		if (!this.manuallyStopped && !this.snapshotOverflow) this.opts.onCrash(this);
	}

	private describeFailure(info: PiProcessExitInfo): string {
		const cause =
			info.code !== null
				? `exit code ${String(info.code)}`
				: info.signal
					? `signal ${info.signal}`
					: "spawn failed";
		const detail = info.stderrTail.trim().slice(-300);
		return detail ? `${cause}: ${detail}` : cause;
	}

	private closeDialog(
		requestId: string,
		reason: Extract<
			BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>,
			{ type: "extension_ui_closed" }
		>["reason"],
		emit = true,
	): boolean {
		const dialog = this.pendingDialogs.get(requestId);
		if (!dialog) return false;
		const commitClose = () => {
			if (dialog.timer) clearTimeout(dialog.timer);
			if (this.pendingDialogs.get(requestId) === dialog) {
				this.pendingDialogs.delete(requestId);
				this.extensionSemanticRevision += 1;
			}
		};
		if (emit && this.startupReady) {
			this.emitFrame({ type: "extension_ui_closed", requestId, reason }, commitClose);
		} else {
			commitClose();
		}
		return false;
	}

	private closeAllDialogs(
		reason: Extract<
			BufferedFrame<RuntimeEvent<M>, RuntimeExtensionRequest<M>>,
			{ type: "extension_ui_closed" }
		>["reason"],
		emit = true,
	): void {
		for (const requestId of [...this.pendingDialogs.keys()]) this.closeDialog(requestId, reason, emit);
	}

	private expireDialog(
		processToken: number,
		requestId: string,
		expectedEntry?: PendingDialog<RuntimeExtensionRequest<M>>,
	): void {
		if (
			processToken !== this.processToken ||
			!this.pendingDialogs.has(requestId) ||
			(expectedEntry !== undefined && this.pendingDialogs.get(requestId) !== expectedEntry)
		)
			return;
		const previousOperationalState = this.operationalStateKey();
		const publishedOperationalState = this.closeDialog(requestId, "expired");
		if (this.proc?.running) {
			this.proc.sendNoResponse({ type: "extension_ui_response", id: requestId, cancelled: true });
		}
		const stateChanged = this.refreshOperationalState();
		if (
			!stateChanged &&
			!publishedOperationalState &&
			this.operationalStateKey() !== previousOperationalState
		) {
			this.publishOperationalState();
		}
		this.log("info", `Extension dialog ${requestId} expired for ${this.sessionHandle}`);
	}

	private setState(state: SessionRuntimeSnapshot["state"], projectionPhasePrepared = false): void {
		if (this.state === state && state !== "starting") return;
		this.state = state;
		// Invalidate the cached snapshot before callbacks can observe the new state.
		this.touch();
		this.opts.onHotSetChanged?.(this);
		if (!projectionPhasePrepared) this.liveProjection?.setRuntimePhase(this.projectionIdentity(), state);
		if (!this.startupReady && state !== "starting" && state !== "crashed" && state !== "dormant") return;
		this.emitSupervisorMessage({ type: "runtime_state", runtime: this.snapshot() });
	}

	private touch(): void {
		this.lastActivityAt = Date.now();
		this.snapshotVersion += 1;
		this.snapshotCache = null;
	}

	private identityTransitionBlocker(): string | null {
		if (!this.running) return "process";
		if (this.state !== "idle") return this.state;
		if (this.agentBusy) return "agent";
		if (this.compactionBusy || this.idleBaseCompactionBusy) return "compaction";
		if (this.activeQueueDepth > 0) return "queue";
		if (this.inFlight > 0) return "command";
		if (this.pendingDialogs.size > 0) return "dialog";
		if (this.pendingTurnReservations.size > 0) return "turn_reservation";
		if (this.transitioning) return "transition";
		return null;
	}

	private refreshOperationalState(): boolean {
		if (!this.startupReady || !this.running) return false;
		const previousState = this.state;
		if (this.pendingDialogs.size > 0) this.setState("waiting_ui");
		else if (
			this.agentBusy ||
			this.compactionBusy ||
			this.idleBaseCompactionBusy ||
			this.pendingTurnReservations.size > 0
		)
			this.setState("running");
		else {
			this.setState("idle");
			this.maybeCompactIdleProjectionBase();
		}
		return previousState !== this.state;
	}

	private refreshOperationalStateAndPublish(previousOperationalState: string): void {
		const stateChanged = this.refreshOperationalState();
		if (!stateChanged && this.operationalStateKey() !== previousOperationalState) {
			this.publishOperationalState();
		}
	}

	private operationalStateKey(): string {
		return `${this.runtimePhase()}\0${this.operationCount()}\0${this.busyReasons().join(",")}`;
	}

	private publishOperationalState(): void {
		if (!this.startupReady || !this.running) return;
		this.opts.onHotSetChanged?.(this);
		this.emitSupervisorMessage({ type: "runtime_state", runtime: this.snapshot() });
	}

	private maybeCompactIdleProjectionBase(publishOperationalState = true): void {
		if (
			this.idleBaseCompactionPromise ||
			this.discardedCompactionTransferCleanup ||
			this.identityTransitionBlocker() !== null
		)
			return;
		const projection = this.liveProjection;
		const proc = this.proc;
		const projectionNeedsCompaction = projection?.shouldCompactIdleBase() ?? false;
		const nativeHistoryNeedsRefresh = this.nativeHistoryPlanNeedsRefresh(projectionNeedsCompaction);
		if (!projection || !proc?.running || (!projectionNeedsCompaction && !nativeHistoryNeedsRefresh)) return;
		const token = projection.beginIdleBaseCompaction();
		if (!token || (token.expectedAsOfSeq === projection.snapshot().baseSeq && !nativeHistoryNeedsRefresh))
			return;
		const previousOperationalState = this.operationalStateKey();
		this.idleBaseCompactionBusy = true;
		this.touch();
		if (publishOperationalState && this.operationalStateKey() !== previousOperationalState) {
			this.publishOperationalState();
		}
		const processToken = this.processToken;
		const contentOwner = this.generationContentOwner;
		let compaction!: Promise<void>;
		compaction = (async () => {
			let committed = false;
			let compactFromPi = !nativeHistoryNeedsRefresh;
			if (nativeHistoryNeedsRefresh) {
				const nativeResult = await this.compactIdleNativeHistoryBase(
					token,
					projection,
					processToken,
					proc,
					contentOwner,
				);
				if (nativeResult === null) compactFromPi = true;
				else committed = nativeResult;
			}
			if (compactFromPi) {
				await this.productAdapter.sendDecoded(
					proc,
					{ type: "get_messages" },
					(delivery) => {
						const messages = this.productAdapter.messagesFrom(delivery.value);
						const ownershipCurrent = contentOwner
							? this.isCurrentGenerationContentOwner(processToken, proc, contentOwner)
							: !this.payloadCustody && processToken === this.processToken && this.proc === proc;
						const prepared =
							ownershipCurrent && this.liveProjection === projection
								? projection.prepareIdleBaseCompaction(token, messages)
								: null;
						return delivery.prepare((transfer) => {
							const stillCurrent = contentOwner
								? this.isCurrentGenerationContentOwner(processToken, proc, contentOwner)
								: !this.payloadCustody && processToken === this.processToken && this.proc === proc;
							if (!prepared || !stillCurrent || this.liveProjection !== projection) {
								this.trackDiscardedCompactionTransfer(processToken, proc, contentOwner, transfer);
								return true;
							}
							if (this.productAdapter.mode === "content_ref") {
								const candidateProjection = projection.previewPreparedIdleBaseCompaction(prepared);
								if (!candidateProjection) {
									this.trackDiscardedCompactionTransfer(processToken, proc, contentOwner, transfer);
									return true;
								}
								this.assertProductSnapshotCandidateFits(
									this.buildSessionSnapshotFromProjection(candidateProjection),
								);
							}
							if (transfer) {
								if (!contentOwner) throw new RpcError("get_messages", "unexpected_payload_transfer");
								contentOwner.adopt(transfer);
							}
							try {
								if (!projection.commitPreparedIdleBaseCompaction(prepared)) {
									throw new RpcError("get_messages", "session_compaction_commit_invariant_failed");
								}
								if (this.productAdapter.mode !== "content_ref") this.assertWireSnapshotFits();
								committed = true;
							} catch (error) {
								if (contentOwner) {
									this.terminalizeGenerationContentFailure(processToken, proc, contentOwner, error);
								} else {
									throw error;
								}
							}
							return true;
						});
					},
					this.timeoutFor("get_messages"),
				);
			}
			if (!committed) return;
		})()
			.catch((error) => {
				const normalized = this.normalizeProjectionError(error);
				if (normalized instanceof RpcError && normalized.message.includes("session_snapshot_overflow")) {
					return;
				}
				this.log(
					"warn",
					`Unable to compact Session snapshot base for ${this.sessionHandle}: ${String(error)}`,
				);
			})
			.finally(() => {
				const previousOperationalState = this.operationalStateKey();
				this.idleBaseCompactionBusy = false;
				this.touch();
				// Keep the completed promise installed while state is reconciled so the
				// idle transition cannot immediately start the same compaction again.
				this.refreshOperationalStateAndPublish(previousOperationalState);
				if (this.idleBaseCompactionPromise === compaction) this.idleBaseCompactionPromise = null;
			});
		this.idleBaseCompactionPromise = compaction;
	}

	private nativeHistoryPlanNeedsRefresh(initializeIfMissing: boolean): boolean {
		if (this.nativeHistoryPlan) return !this.nativeHistoryPlan.isSourceCurrent();
		return initializeIfMissing && this.sessionFile !== null && this.shouldUseNativeHistory();
	}

	private trackDiscardedCompactionTransfer(
		processToken: number,
		proc: PiProcess,
		owner: GenerationContentOwner<RuntimeRef<M>> | null,
		transfer: PiPayloadLeaseTransfer<RuntimeRef<M>> | null,
	): void {
		if (!transfer) return;
		if (this.discardedCompactionTransferCleanup) {
			throw new RpcError("get_messages", "session_compaction_cleanup_busy");
		}
		const cleanup = transfer.release();
		this.discardedCompactionTransferCleanup = cleanup;
		void cleanup.then(
			() => {
				if (this.discardedCompactionTransferCleanup === cleanup) {
					this.discardedCompactionTransferCleanup = null;
				}
			},
			(error) => {
				if (owner && this.isCurrentGenerationContentOwner(processToken, proc, owner)) {
					this.terminalizeGenerationContentFailure(processToken, proc, owner, error);
				} else if (this.discardedCompactionTransferCleanup === cleanup) {
					this.discardedCompactionTransferCleanup = null;
				}
			},
		);
	}

	private async ensureProjectionHeadroomForWork(commandType: string): Promise<void> {
		if (this.idleBaseCompactionPromise) await this.idleBaseCompactionPromise;
		const capacity = () =>
			this.liveProjection?.hasActiveTurnReservationCapacity({
				pendingReservations: this.pendingTurnReservations.size + 1,
				activeTurnItems: this.activeTurnProjectionItems,
				activeTurnBytes: this.activeTurnProjectionBytes,
				reserveActiveTurn: this.activeTurnHeadroomReserved,
			}) === true;
		if (capacity()) return;
		this.maybeCompactIdleProjectionBase();
		if (this.idleBaseCompactionPromise) await this.idleBaseCompactionPromise;
		if (!capacity()) {
			throw new RpcError(commandType, "session_snapshot_headroom_unavailable");
		}
	}

	private finishWorkCommandResponse(success: boolean, reservation: symbol): void {
		if (!success) {
			const previousOperationalState = this.operationalStateKey();
			this.releasePendingTurn(reservation);
			this.refreshOperationalStateAndPublish(previousOperationalState);
			return;
		}
		const pending = this.pendingTurnReservations.get(reservation);
		if (pending && !pending.timer) this.schedulePendingTurnExpiry(reservation);
	}

	private reservePendingTurn(): symbol {
		const token = Symbol("pending-turn");
		this.nextTurnReservationId += 1n;
		this.pendingTurnReservations.set(token, {
			id: this.nextTurnReservationId,
			generation: this.generation,
			processToken: this.processToken,
			timer: null,
		});
		this.touch();
		return token;
	}

	private consumePendingTurn(): void {
		const token = this.pendingTurnReservations.keys().next().value as symbol | undefined;
		if (token) this.releasePendingTurn(token);
	}

	private releasePendingTurn(token: symbol): void {
		const reservation = this.pendingTurnReservations.get(token);
		if (!reservation) return;
		if (reservation.timer) clearTimeout(reservation.timer);
		this.pendingTurnReservations.delete(token);
		this.touch();
	}

	private schedulePendingTurnExpiry(token: symbol): void {
		const reservation = this.pendingTurnReservations.get(token);
		if (!reservation) return;
		reservation.timer = setTimeout(() => {
			if (
				this.pendingTurnReservations.get(token) !== reservation ||
				reservation.generation !== this.generation ||
				reservation.processToken !== this.processToken ||
				!this.running
			) {
				return;
			}
			reservation.timer = null;
			if (!this.agentBusy && this.activeQueueDepth === 0) {
				const previousOperationalState = this.operationalStateKey();
				this.releasePendingTurn(token);
				this.refreshOperationalStateAndPublish(previousOperationalState);
				return;
			}
			this.schedulePendingTurnExpiry(token);
		}, 500);
		reservation.timer.unref?.();
	}

	private clearPendingTurnReservations(): void {
		for (const token of [...this.pendingTurnReservations.keys()]) this.releasePendingTurn(token);
		this.queueReservationReleaseCutoff = 0n;
	}

	private releasePendingTurnsThrough(cutoff: bigint): void {
		for (const [token, reservation] of this.pendingTurnReservations) {
			if (reservation.id <= cutoff) this.releasePendingTurn(token);
		}
	}

	private finishProcessFinalization(): void {
		this.resolveProcessFinalization?.();
		this.resolveProcessFinalization = null;
		this.processFinalization = null;
	}

	private clearReplay(): void {
		this.replay = [];
		this.replayFrameBytes = [];
		this.replayBytes = 0;
		this.lastTransientSeq = 0;
	}

	private assertGeneration(command: string, expectedGeneration: number): void {
		if (expectedGeneration !== this.generation) {
			throw new RpcError(command, "session_generation_stale");
		}
	}

	private projectionIdentity(): SessionLiveProjectionIdentity {
		return {
			serverEpoch: this.opts.serverEpoch,
			sessionHandle: this.sessionHandle,
			workspaceId: this.workspaceId,
			generation: this.generation,
		};
	}

	private normalizeProjectionError(error: unknown): unknown {
		if (!(error instanceof SessionLiveProjectionLimitError)) return error;
		if (this.startupReady) this.terminalizeSnapshotOverflow();
		else {
			this.snapshotOverflow = true;
			this.error = "session_snapshot_overflow";
		}
		return new RpcError("session_snapshot", "session_snapshot_overflow");
	}

	private terminalizeSnapshotOverflow(): void {
		if (this.snapshotOverflow && this.state === "crashed") return;
		this.snapshotOverflow = true;
		this.error = "session_snapshot_overflow";
		this.manuallyStopped = true;
		this.processToken += 1;
		const proc = this.proc;
		const contentOwner = this.generationContentOwner;
		const discardedCleanup = this.discardedCompactionTransferCleanup;
		const retiredCleanup = this.retiredGenerationContentCleanup;
		const transitionCleanup = this.releaseTransitionStagePayloads(this.transitionStage, contentOwner);
		const starting = this.startPromise;
		this.proc = null;
		this.generationContentOwner = null;
		this.retainedCrashedContentOwner = null;
		this.retiredGenerationContentCleanup = null;
		this.opts.onHotSetChanged?.(this);
		this.clearOwnedOperationalState(false);
		this.startupReady = false;
		this.state = "crashed";
		this.liveProjection = null;
		this.touch();
		if (
			(proc || contentOwner || discardedCleanup || retiredCleanup || transitionCleanup) &&
			!this.stopPromise
		) {
			const cleanup = this.beginTerminalGenerationCleanup("Overflowed generation cleanup", [
				proc?.stop(),
				contentOwner?.release(),
				discardedCleanup,
				retiredCleanup,
				transitionCleanup,
				starting ? Promise.allSettled([starting]) : undefined,
			]);
			void cleanup.then(
				() => this.finishProcessFinalization(),
				() => {},
			);
		}
		this.emitSupervisorMessage({ type: "runtime_state", runtime: this.snapshot() });
	}

	private clearOwnedOperationalState(emitDialogCloses: boolean): void {
		this.startupFrames = [];
		this.startupFrameBytes = 0;
		this.transitionStage = null;
		this.nativeHistoryPlan = null;
		this.nativeHistorySnapshotId = null;
		this.closeAllDialogs("process_lost", emitDialogCloses);
		this.pendingDialogs.clear();
		this.clearPendingTurnReservations();
		this.stickyExtension.clear();
		this.extensionSemanticRevision += 1;
		this.clearReplay();
		this.agentBusy = false;
		this.compactionBusy = false;
		this.idleBaseCompactionBusy = false;
		this.activeQueueDepth = 0;
		this.activeTurnProjectionItems = 0;
		this.activeTurnProjectionBytes = 0;
		this.activeTurnProjectionLogicalBytes = 0;
		this.activeTurnHeadroomReserved = false;
		this.inFlight = 0;
		this.touch();
	}

	private emitSupervisorMessage(
		message: SessionSupervisorMessage<RuntimeEvent<M>, RuntimeExtensionRequest<M>>,
	): void {
		if (this.deferredStartupEmits) {
			this.deferredStartupEmits.push(message);
			return;
		}
		if (this.deferredTransitionEmits) {
			this.deferredTransitionEmits.push(message);
			return;
		}
		this.opts.emit(message);
	}

	private async withCommandAdmission<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.commandTail;
		let release: () => void;
		this.commandTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release!();
		}
	}

	private log(level: "info" | "warn" | "error", message: string): void {
		this.opts.log?.(level, message);
	}
}

/** Canonical Browser protocol Runtime API. */
export class SessionRuntime extends SessionRuntimeCore<"content_ref"> {
	constructor(opts: SessionRuntimeOptions) {
		const { piPayloadServices, ...coreOptions } = opts;
		super({
			...coreOptions,
			productAdapter: createProductAdapter(piPayloadServices.productSchema),
			payloadCustody: piPayloadServices,
		});
	}
}

function commandMayStartWork(commandType: string): boolean {
	return commandType === "prompt" || commandType === "steer" || commandType === "follow_up";
}

/** Commands whose successful admission represents user content that may still exist only in Pi memory. */
function commandCarriesConversation(commandType: string): boolean {
	return commandMayStartWork(commandType) || commandType === "bash";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandReleasesQueuedWork(commandType: string): boolean {
	return commandType === "abort" || commandType === "abort_retry";
}

function transitionWasCancelled(response: PiSessionCommandResponseDto | SessionCommandResponseDto): boolean {
	if (response.success !== true || !("data" in response)) return false;
	const data = response.data;
	return typeof data === "object" && data !== null && "cancelled" in data && data.cancelled === true;
}

function bufferedFrameBytes<TEvent, TExtensionRequest>(
	frame: BufferedFrame<TEvent, TExtensionRequest>,
): number {
	return Buffer.byteLength(JSON.stringify(frame));
}

function isReplayableFrame<TEvent, TExtensionRequest extends { readonly method: string }>(
	frame: BufferedFrame<TEvent, TExtensionRequest>,
): boolean {
	return !(frame.type === "extension_ui_request" && frame.request.method === "notify");
}

function extensionRequestBytes(request: PiExtensionUiRequestDto | ExtensionUiRequestDto): number {
	return Buffer.byteLength(JSON.stringify(request));
}

function stickyRequestKey(request: PiExtensionUiRequestDto | ExtensionUiRequestDto): string {
	if (request.method === "setStatus") return `setStatus:${request.statusKey}`;
	if (request.method === "setWidget") return `setWidget:${request.widgetKey}`;
	return request.method;
}

function stickyRequestClearsState(request: PiExtensionUiRequestDto | ExtensionUiRequestDto): boolean {
	return (
		(request.method === "setStatus" && request.statusText === undefined) ||
		(request.method === "setWidget" && request.widgetLines === undefined)
	);
}

function contentRefExtensionRequestRefs(request: ExtensionUiRequestDto): readonly EpochStoredContentRef[] {
	if (
		request.method === "editor" &&
		typeof request.prefill === "object" &&
		request.prefill !== null &&
		request.prefill.type === "external_text"
	) {
		return [request.prefill.ref];
	}
	if (
		request.method === "set_editor_text" &&
		typeof request.text === "object" &&
		request.text !== null &&
		request.text.type === "external_text"
	) {
		return [request.text.ref];
	}
	if (
		request.method === "setWidget" &&
		request.widgetLines !== undefined &&
		!Array.isArray(request.widgetLines) &&
		request.widgetLines.type === "external_json"
	) {
		return [request.widgetLines.ref];
	}
	return [];
}

function contentRefExtensionStagesDuringTransition(
	request: ExtensionUiRequestDto,
	phase: TransitionStage["phase"],
): boolean {
	return !BLOCKING_DIALOG_METHODS.has(request.method) || phase === "verifying";
}

function contentRefExtensionTransferMatches(
	request: ExtensionUiRequestDto,
	transfer: PiPayloadLeaseTransfer<EpochStoredContentRef> | null,
): boolean {
	const expected = contentRefExtensionRequestRefs(request);
	const actual = transfer?.refs ?? [];
	return (
		expected.length === actual.length &&
		expected.every((ref, index) => {
			const candidate = actual[index];
			return candidate !== undefined && storedContentRefsEqual(ref, candidate);
		})
	);
}

function storedContentRefsEqual(left: EpochStoredContentRef, right: EpochStoredContentRef): boolean {
	if (
		left.type !== right.type ||
		left.serverEpoch !== right.serverEpoch ||
		left.sha256 !== right.sha256 ||
		left.byteLength !== right.byteLength
	) {
		return false;
	}
	return left.type === "attachment_ref"
		? right.type === "attachment_ref" && left.mediaType === right.mediaType
		: right.type === "content_ref" && left.encoding === right.encoding;
}

function inspectFrozenSessionFile(sessionFile: string): FrozenSessionFileIdentity {
	let canonical: string;
	try {
		canonical = fs.realpathSync(sessionFile);
	} catch (error) {
		throw new RpcError("get_state", `Pi Session file is unavailable: ${String(error)}`);
	}
	if (canonical !== sessionFile) {
		throw new RpcError("get_state", "Pi Session file is not a canonical regular file");
	}
	const pathStat = fs.lstatSync(sessionFile, { bigint: true });
	if (!pathStat.isFile()) throw new RpcError("get_state", "Pi Session file is not a regular file");
	const descriptor = fs.openSync(sessionFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
		if (
			!descriptorStat.isFile() ||
			descriptorStat.dev !== pathStat.dev ||
			descriptorStat.ino !== pathStat.ino
		) {
			throw new RpcError("get_state", "Pi Session file identity changed while it was opened");
		}
		return {
			sessionFile,
			dev: descriptorStat.dev,
			ino: descriptorStat.ino,
			...readFrozenSessionHeader(descriptor),
		};
	} finally {
		fs.closeSync(descriptor);
	}
}

function assertFrozenSessionFile(
	frozen: FrozenSessionFileIdentity,
	nativeSessionId: string,
	cwd: string,
): void {
	const current = inspectFrozenSessionFile(frozen.sessionFile);
	if (
		current.dev !== frozen.dev ||
		current.ino !== frozen.ino ||
		current.nativeSessionId !== nativeSessionId ||
		canonicalizePathAllowMissing(current.cwd) !== cwd
	) {
		throw new RpcError("get_state", "Pi Session file identity changed before commit");
	}
}

function assertUnpersistedTransitionTarget(target: ExistingSessionTarget): void {
	const canonical = canonicalizeSessionFile(target.sessionFile);
	if (
		canonical !== target.sessionFile ||
		sessionHandleForCanonicalFile(canonical) !== target.sessionHandle ||
		!sessionFileBasenameMatchesId(canonical, target.nativeSessionId)
	) {
		throw new RpcError("get_state", "unpersisted fork identity changed before commit");
	}
	if (!fs.existsSync(canonical)) return;
	const materialized = inspectFrozenSessionFile(canonical);
	if (
		materialized.nativeSessionId !== target.nativeSessionId ||
		canonicalizePathAllowMissing(materialized.cwd) !== target.cwd
	) {
		throw new RpcError("get_state", "materialized fork Session Header does not match its pending identity");
	}
}

function sessionFileBasenameMatchesId(sessionFile: string, nativeSessionId: string): boolean {
	const basename = path.basename(sessionFile);
	return basename.length > nativeSessionId.length + 7 && basename.endsWith(`_${nativeSessionId}.jsonl`);
}

function readFrozenSessionHeader(descriptor: number): { nativeSessionId: string; cwd: string } {
	const chunks: Buffer[] = [];
	let total = 0;
	for (;;) {
		const chunk = Buffer.allocUnsafe(Math.min(4_096, 1024 * 1024 - total));
		const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, total);
		if (bytesRead === 0) break;
		const value = chunk.subarray(0, bytesRead);
		const newline = value.indexOf(0x0a);
		if (newline >= 0) {
			chunks.push(value.subarray(0, newline));
			break;
		}
		chunks.push(value);
		total += bytesRead;
		if (total >= 1024 * 1024) {
			throw new RpcError("get_state", "Pi Session header exceeds the 1 MiB identity limit");
		}
	}

	let header: unknown;
	try {
		header = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new RpcError("get_state", "Pi Session header is not valid JSON");
	}
	if (
		typeof header !== "object" ||
		header === null ||
		(header as { type?: unknown }).type !== "session" ||
		typeof (header as { id?: unknown }).id !== "string" ||
		typeof (header as { cwd?: unknown }).cwd !== "string" ||
		!(header as { cwd: string }).cwd
	) {
		throw new RpcError("get_state", "Pi Session header lacks a stable id and cwd");
	}
	return {
		nativeSessionId: (header as { id: string }).id,
		cwd: (header as { cwd: string }).cwd,
	};
}
