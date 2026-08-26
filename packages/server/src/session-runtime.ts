import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
	ExtensionUiRequestDto,
	ExtensionUiResponseDto,
	ProductSessionEventDto,
	SessionCommandDto,
	SessionCommandResponseDto,
	SessionSnapshotDto,
	SessionStateDto,
} from "@pi-agent-web/protocol";
import {
	commandTimeoutMs,
	expectCommandData,
	isSessionSnapshotDto,
	RpcError,
	SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS,
} from "@pi-agent-web/protocol";
import { canonicalizeSessionFile, sessionHandleForCanonicalFile } from "./native-session-catalog.js";
import type { PiProcessExitInfo } from "./pi-process.js";
import { PiProcess } from "./pi-process.js";
import type { ProbedPiRuntime } from "./resolver.js";
import { canonicalizePathAllowMissing } from "./session-layout-resolver.js";
import {
	SessionLiveProjection,
	type SessionLiveProjectionIdentity,
	SessionLiveProjectionLimitError,
	type SessionLiveProjectionLimits,
} from "./session-live-projection.js";
import {
	type ExistingSessionTarget,
	eventSettlesWork,
	eventStartsWork,
	type ReplayCursor,
	type ReplayResult,
	type SessionReplayFrame,
	type SessionRuntimeSnapshot,
	type SessionSupervisorMessage,
	type SessionTarget,
} from "./session-runtime-types.js";

const BLOCKING_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const STICKY_EXTENSION_METHODS = new Set(["setStatus", "setWidget", "setTitle", "set_editor_text"]);
const DEFAULT_REPLAY_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TRANSIENT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_EXTENSION_STATE_MAX_BYTES = 512 * 1024;
const DEFAULT_EXTENSION_STATE_MAX_ITEMS = SESSION_SNAPSHOT_MAX_EXTENSION_ITEMS;
const DEFAULT_PENDING_DIALOG_LIMIT = 32;

type BufferedFrame =
	| { type: "event"; event: ProductSessionEventDto }
	| { type: "extension_ui_request"; request: ExtensionUiRequestDto }
	| {
			type: "extension_ui_closed";
			requestId: string;
			reason: "answered" | "cancelled" | "expired" | "process_lost" | "replaced";
	  };

interface PendingDialog {
	request: ExtensionUiRequestDto;
	timer: NodeJS.Timeout | null;
}

interface PendingTurnReservation {
	id: bigint;
	generation: number;
	processToken: number;
	timer: NodeJS.Timeout | null;
}

interface TransitionStage {
	phase: "awaiting_response" | "verifying";
	frames: BufferedFrame[];
	bytes: number;
}

interface FrozenSessionFileIdentity {
	sessionFile: string;
	dev: bigint;
	ino: bigint;
	nativeSessionId: string;
	cwd: string;
}

export interface SessionIdentityTransitionCommit {
	previousSessionHandle: string;
	nextTarget: ExistingSessionTarget;
	/** Apply the verified identity exactly once while the Supervisor pool lock is held. */
	apply: () => void;
	/** Commit staged child frames to one waterline before the rekey becomes observable. */
	commitStaged: () => SessionSupervisorMessage[];
}

export interface SessionRuntimeOptions {
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
	projectionLimits?: Partial<SessionLiveProjectionLimits>;
	initialGeneration?: number;
	commandTimeoutFor?: (commandType: string) => number;
	emit: (message: SessionSupervisorMessage) => void;
	onCrash: (runtime: SessionRuntime) => void;
	commitIdentityTransition: (
		runtime: SessionRuntime,
		transition: SessionIdentityTransitionCommit,
	) => Promise<void>;
	log?: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * Owns exactly one Pi RPC child process and one native Session identity.
 *
 * The runtime buffers startup frames until `get_state` establishes identity,
 * gives every emitted frame a generation-local sequence, and keeps a bounded
 * replay ring for reconnect. Session navigation is deliberately absent.
 */
export class SessionRuntime {
	private readonly opts: Required<
		Pick<
			SessionRuntimeOptions,
			| "readyTimeoutMs"
			| "replayLimit"
			| "replayMaxBytes"
			| "transientBufferMaxBytes"
			| "extensionStateMaxBytes"
			| "extensionStateMaxItems"
			| "pendingDialogLimit"
		>
	> &
		SessionRuntimeOptions;
	private proc: PiProcess | null = null;
	private startPromise: Promise<void> | null = null;
	private stopPromise: Promise<void> | null = null;
	private processFinalization: Promise<void> | null = null;
	private resolveProcessFinalization: (() => void) | null = null;
	private processToken = 0;
	private failedProcessToken: number | null = null;
	private startupReady = false;
	private startupFrames: BufferedFrame[] = [];
	private startupFrameBytes = 0;
	private transitionStage: TransitionStage | null = null;
	private replay: SessionReplayFrame[] = [];
	private replayFrameBytes: number[] = [];
	private replayBytes = 0;
	private lastTransientSeq = 0;
	private pendingDialogs = new Map<string, PendingDialog>();
	private pendingTurnReservations = new Map<symbol, PendingTurnReservation>();
	private nextTurnReservationId = 0n;
	private queueReservationReleaseCutoff = 0n;
	private stickyExtension = new Map<string, ExtensionUiRequestDto>();
	private activeQueueDepth = 0;
	private activeTurnProjectionItems = 0;
	private activeTurnProjectionBytes = 0;
	private activeTurnHeadroomReserved = false;
	private agentBusy = false;
	private compactionBusy = false;
	private inFlight = 0;
	private reservations = 0;
	private commandTail: Promise<void> = Promise.resolve();
	private manuallyStopped = true;
	private terminalProtocolIncompatible = false;
	private sessionFileIdentityVerified = false;
	private hasConversationIntent = false;
	private liveProjection: SessionLiveProjection | null = null;
	private snapshotOverflow = false;
	private idleBaseCompactionPromise: Promise<void> | null = null;
	private deferredStartupEmits: SessionSupervisorMessage[] | null = null;
	private deferredTransitionEmits: SessionSupervisorMessage[] | null = null;

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

	constructor(opts: SessionRuntimeOptions) {
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
		};
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

	get transitioning(): boolean {
		return this.transitionStage !== null;
	}

	get protocolIncompatible(): boolean {
		return this.terminalProtocolIncompatible;
	}

	get snapshotOverflowed(): boolean {
		return this.snapshotOverflow;
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
			lastActivityAt: this.lastActivityAt,
			recoverable: this.recoverable,
			...(this.error ? { error: this.error } : {}),
		};
	}

	/** Start or reuse this exact Session target. */
	start(): Promise<void> {
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
		this.generation += 1;
		this.lastSeq = 0;
		this.liveProjection = null;
		this.clearReplay();
		this.startupReady = false;
		this.startupFrames = [];
		this.startupFrameBytes = 0;
		this.stickyExtension.clear();
		this.error = undefined;
		this.setState("starting");

		const proc = new PiProcess({
			cwd: this.cwd,
			resolved: this.opts.resolved,
			args: this.spawnArguments(),
			adapter: this.opts.resolved.adapter,
			env: this.opts.env,
			readyTimeoutMs: this.opts.readyTimeoutMs,
			onReady: (state) => this.handleReady(processToken, state),
			onEvent: (event) => this.handleEvent(processToken, event),
			onExtensionUiRequest: (request) => this.handleExtensionRequest(processToken, request),
			onExit: (info) => this.handleFailure(processToken, info),
		});
		this.proc = proc;

		try {
			await proc.start();
			await this.initializeProjectionBase(processToken, proc);
			this.deferredStartupEmits = [];
			this.setState(this.pendingDialogs.size > 0 ? "waiting_ui" : "idle");
			this.flushFrames(this.startupFrames);
			this.startupFrames = [];
			this.startupFrameBytes = 0;
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
		this.liveProjection = await this.loadProjectionBase(processToken, proc, this.projectionIdentity());
	}

	private async loadProjectionBase(
		processToken: number,
		proc: PiProcess,
		identity: SessionLiveProjectionIdentity,
	): Promise<SessionLiveProjection> {
		const response = await proc.send({ type: "get_messages" }, this.timeoutFor("get_messages"));
		if (processToken !== this.processToken || this.proc !== proc) {
			throw new RpcError("get_messages", "session_generation_stale");
		}
		const { messages } = expectCommandData(response, "get_messages");
		return new SessionLiveProjection({
			identity,
			settledMessages: messages,
			baseSeq: 0,
			runtimePhase: this.pendingDialogs.size > 0 ? "waiting_ui" : "idle",
			limits: this.opts.projectionLimits,
		});
	}

	async send(
		command: SessionCommandDto,
		expectedGeneration: number,
		admit: () => void,
		timeoutMs?: number,
	): Promise<SessionCommandResponseDto> {
		const admitted = await this.withCommandAdmission(async () => {
			this.assertGeneration(command.type, expectedGeneration);
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
			if (expectsWork) this.setState("running");
			this.touch();
			let response: Promise<SessionCommandResponseDto>;
			try {
				response = proc.send(command, timeoutMs ?? this.timeoutFor(command.type));
			} catch (error) {
				this.inFlight = Math.max(0, this.inFlight - 1);
				if (turnReservation) this.releasePendingTurn(turnReservation);
				if (expectsWork) this.refreshOperationalState();
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
				this.releasePendingTurnsThrough(admitted.turnReleaseCutoff);
				this.refreshOperationalState();
			}
			return response;
		} catch (error) {
			if (admitted.turnReservation) this.releasePendingTurn(admitted.turnReservation);
			if (admitted.expectsWork) this.refreshOperationalState();
			throw error;
		} finally {
			this.inFlight = Math.max(0, this.inFlight - 1);
			this.refreshOperationalState();
			this.touch();
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
	): Promise<{ response: SessionCommandResponseDto; previousSessionHandle?: string }> {
		return this.withCommandAdmission(async () => {
			this.assertGeneration(command.type, expectedGeneration);
			admit();
			const blocker = this.identityTransitionBlocker();
			if (blocker) throw new RpcError(command.type, `session_busy:${blocker}`);
			const proc = this.proc;
			if (!proc?.running) throw new RpcError(command.type, "pi process is not running");
			const processToken = this.processToken;
			this.transitionStage = { phase: "awaiting_response", frames: [], bytes: 0 };
			this.inFlight += 1;
			const previousSessionHandle = this.sessionHandle;
			let parentIdentityConfirmed = false;
			let identityCommitted = false;
			try {
				const response = await proc.send(command, this.timeoutFor(command.type));
				if (response.success !== true) {
					parentIdentityConfirmed = true;
					this.flushTransitionFrames();
					return { response };
				}
				this.transitionStage.phase = "verifying";
				const stateResponse = await proc.send({ type: "get_state" }, this.timeoutFor("get_state"));
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
					this.flushTransitionFrames();
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
				const childProjection = await this.loadProjectionBase(processToken, proc, childIdentity);

				let applied = false;
				await this.opts.commitIdentityTransition(this, {
					previousSessionHandle,
					nextTarget,
					apply: () => {
						if (applied) throw new RpcError(command.type, "transition identity applied twice");
						if (processToken !== this.processToken || this.proc !== proc || !proc.running) {
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
						applied = true;
						this.adoptTransitionTarget(nextTarget, transition.frozenFile !== null);
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
					this.flushTransitionFrames();
				}
				throw error;
			} finally {
				this.inFlight = Math.max(0, this.inFlight - 1);
				this.transitionStage = null;
				this.refreshOperationalState();
				this.touch();
			}
		});
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
		this.liveProjection = null;
		this.clearReplay();
		this.stickyExtension.clear();
		this.clearPendingTurnReservations();
		this.activeTurnProjectionItems = 0;
		this.activeTurnProjectionBytes = 0;
		this.activeTurnHeadroomReserved = false;
		this.error = undefined;
		this.state = this.pendingDialogs.size > 0 ? "waiting_ui" : "idle";
		this.touch();
	}

	getReplay(requestedHandle: string, cursor?: ReplayCursor): ReplayResult {
		const runtime = this.snapshot();
		const resync = (reason: Extract<ReplayResult, { type: "resync_required" }>["reason"]): ReplayResult => ({
			type: "resync_required",
			runtime,
			reason,
			snapshot: this.sessionSnapshot(),
		});
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

	sessionSnapshot(): SessionSnapshotDto {
		const snapshot = this.buildSessionSnapshot();
		if (!isSessionSnapshotDto(snapshot)) {
			this.terminalizeSnapshotOverflow();
			throw new RpcError("session_snapshot", "session_snapshot_overflow");
		}
		return snapshot;
	}

	private buildSessionSnapshot(): unknown {
		const projection = this.liveProjection?.snapshot();
		if (!projection || projection.asOfSeq !== this.lastSeq) {
			throw new RpcError("session_snapshot", "session_snapshot_unavailable");
		}
		return structuredClone({
			type: "session_snapshot" as const,
			snapshotId: randomUUID(),
			serverEpoch: projection.serverEpoch,
			sessionHandle: projection.sessionHandle,
			workspaceId: projection.workspaceId,
			generation: projection.generation,
			baseSeq: projection.baseSeq,
			asOfSeq: projection.asOfSeq,
			runtime: { ...this.snapshot(), state: projection.runtimePhase },
			settledMessages: projection.settledMessages,
			projectionEvents: projection.projectionEvents,
			queue: projection.queue,
			pendingExtensionRequests: [...this.pendingDialogs.values()].map((entry) => entry.request),
			stickyExtensionState: [...this.stickyExtension.values()],
		});
	}

	private assertWireSnapshotFits(): void {
		if (isSessionSnapshotDto(this.buildSessionSnapshot())) return;
		if (this.startupReady) this.terminalizeSnapshotOverflow();
		else {
			this.snapshotOverflow = true;
			this.error = "session_snapshot_overflow";
		}
		throw new RpcError("session_snapshot", "session_snapshot_overflow");
	}

	getPendingExtensionRequests(): ExtensionUiRequestDto[] {
		const pending = [...this.pendingDialogs.values()].map((entry) => entry.request);
		return [...this.stickyExtension.values(), ...pending];
	}

	sendExtensionUiResponse(response: ExtensionUiResponseDto): "accepted" | "no_dialog" | "not_running" {
		if (!this.pendingDialogs.has(response.id)) return "no_dialog";
		if (!this.proc?.running) {
			this.closeDialog(response.id, "process_lost");
			return "not_running";
		}
		this.closeDialog(
			response.id,
			"cancelled" in response && response.cancelled === true ? "cancelled" : "answered",
		);
		this.proc.sendNoResponse(response);
		// A dialog can belong to an extension command that never starts the
		// agent. Restore state from actual events instead of assuming work began.
		this.refreshOperationalState();
		return "accepted";
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.manuallyStopped = true;
		this.processToken += 1;
		const proc = this.proc;
		const starting = this.startPromise;
		this.proc = null;
		this.clearOwnedOperationalState(!this.snapshotOverflow);
		let stopping!: Promise<void>;
		stopping = (async () => {
			try {
				await proc?.stop();
				if (starting) await Promise.allSettled([starting]);
				this.finishProcessFinalization();
				this.setState("dormant");
			} finally {
				if (this.stopPromise === stopping) this.stopPromise = null;
			}
		})();
		this.stopPromise = stopping;
		return stopping;
	}

	private handleEvent(processToken: number, event: ProductSessionEventDto): void {
		if (processToken !== this.processToken) return;
		this.verifyMaterializedSessionFile();
		this.enqueueFrame({ type: "event", event });
	}

	private applyEventState(event: ProductSessionEventDto): void {
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
			this.activeTurnHeadroomReserved = false;
			if (this.activeQueueDepth === 0 && this.queueReservationReleaseCutoff > 0n) {
				this.releasePendingTurnsThrough(this.queueReservationReleaseCutoff);
				this.queueReservationReleaseCutoff = 0n;
			}
			this.refreshOperationalState();
		}
		this.touch();
		if (this.state === "idle") this.maybeCompactIdleProjectionBase();
	}

	private handleExtensionRequest(processToken: number, request: ExtensionUiRequestDto): void {
		if (processToken !== this.processToken) return;
		this.verifyMaterializedSessionFile();
		if (BLOCKING_DIALOG_METHODS.has(request.method)) {
			const publishImmediately = this.transitionStage?.phase === "awaiting_response";
			this.trackDialog(request, processToken, !this.transitionStage || publishImmediately);
			// A blocking transition veto must be visible so the command can finish.
			if (publishImmediately) {
				this.emitFrame({ type: "extension_ui_request", request });
				return;
			}
		}
		this.enqueueFrame({ type: "extension_ui_request", request });
	}

	private verifyMaterializedSessionFile(): void {
		if (this.sessionFileIdentityVerified || !this.sessionFile || !fs.existsSync(this.sessionFile)) return;
		const frozenFile = inspectFrozenSessionFile(this.sessionFile);
		if (
			frozenFile.nativeSessionId !== this.nativeSessionId ||
			canonicalizePathAllowMissing(frozenFile.cwd) !== this.cwd
		) {
			throw new RpcError("get_state", "materialized Pi Session Header does not match its pending identity");
		}
		this.sessionFileIdentityVerified = true;
	}

	private trackDialog(request: ExtensionUiRequestDto, processToken: number, publishState: boolean): void {
		this.closeDialog(request.id, "replaced");
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
		const timer = timeout ? setTimeout(() => this.expireDialog(processToken, request.id), timeout) : null;
		timer?.unref?.();
		this.pendingDialogs.set(request.id, { request, timer });
		if (publishState) this.setState("waiting_ui");
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

	private enqueueFrame(frame: BufferedFrame): void {
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
		if (this.transitionStage) {
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

	private flushFrames(frames: BufferedFrame[]): void {
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

	private publishFrame(frame: BufferedFrame): void {
		if (frame.type === "extension_ui_request" && STICKY_EXTENSION_METHODS.has(frame.request.method)) {
			this.publishStickyRequest(frame.request);
			return;
		}
		this.emitFrame(frame);
		this.applyFrameState(frame);
	}

	private publishStickyRequest(request: ExtensionUiRequestDto): void {
		const key = stickyRequestKey(request);
		if (stickyRequestClearsState(request)) {
			this.emitFrame({ type: "extension_ui_request", request }, () => {
				this.stickyExtension.delete(key);
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
			this.emitFrame({ type: "extension_ui_request", request: stickyClearRequest(oldest) }, () => {
				this.stickyExtension.delete(oldestKey);
			});
			candidate.delete(oldestKey);
		}
		if (!this.extensionStateCandidateFits(candidate, requestBytes, 1)) {
			this.emitFrame({ type: "extension_ui_request", request: stickyClearRequest(request) }, () => {
				this.stickyExtension.delete(key);
			});
			this.log("warn", `Dropping oversized sticky extension state for ${this.sessionHandle}`);
			return;
		}
		this.emitFrame({ type: "extension_ui_request", request }, () => {
			this.stickyExtension.delete(key);
			this.stickyExtension.set(key, request);
		});
	}

	private extensionStateCandidateFits(
		sticky: ReadonlyMap<string, ExtensionUiRequestDto>,
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

	private applyFrameState(frame: BufferedFrame): void {
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

	private commitTransitionFrames(): SessionSupervisorMessage[] {
		if (this.deferredTransitionEmits) {
			throw new RpcError("session_transition", "transition_frame_commit_reentered");
		}
		this.deferredTransitionEmits = [];
		try {
			this.flushTransitionFrames();
			return this.deferredTransitionEmits;
		} finally {
			this.deferredTransitionEmits = null;
		}
	}

	private emitFrame(frame: BufferedFrame, afterProjectionCommit?: () => void): void {
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
			seq = projection.commit(this.projectionIdentity(), frame, this.state);
		} catch (error) {
			throw this.normalizeProjectionError(error);
		}
		if (turnBudget) {
			this.activeTurnProjectionItems = turnBudget.items;
			this.activeTurnProjectionBytes = turnBudget.bytes;
		}
		afterProjectionCommit?.();
		const envelope: SessionReplayFrame = {
			...frame,
			serverEpoch: this.opts.serverEpoch,
			sessionHandle: this.sessionHandle,
			workspaceId: this.workspaceId,
			generation: this.generation,
			seq,
		} as SessionReplayFrame;
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
		this.proc = null;
		this.finishProcessFinalization();
		this.clearOwnedOperationalState(!this.snapshotOverflow);
		this.terminalProtocolIncompatible = info.reason === "protocol_incompatible";
		this.error = this.snapshotOverflow
			? "session_snapshot_overflow"
			: this.terminalProtocolIncompatible
				? "protocol_incompatible"
				: this.describeFailure(info);
		this.setState("crashed");
		this.log("error", `Pi runtime crashed for ${this.sessionHandle}: ${this.error}`);
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
		reason: Extract<BufferedFrame, { type: "extension_ui_closed" }>["reason"],
		emit = true,
	): void {
		const dialog = this.pendingDialogs.get(requestId);
		if (!dialog) return;
		const commitClose = () => {
			if (dialog.timer) clearTimeout(dialog.timer);
			this.pendingDialogs.delete(requestId);
		};
		if (emit && this.startupReady) {
			this.emitFrame({ type: "extension_ui_closed", requestId, reason }, commitClose);
		} else {
			commitClose();
		}
	}

	private closeAllDialogs(
		reason: Extract<BufferedFrame, { type: "extension_ui_closed" }>["reason"],
		emit = true,
	): void {
		for (const requestId of [...this.pendingDialogs.keys()]) this.closeDialog(requestId, reason, emit);
	}

	private expireDialog(processToken: number, requestId: string): void {
		if (processToken !== this.processToken || !this.pendingDialogs.has(requestId)) return;
		this.closeDialog(requestId, "expired");
		if (this.proc?.running) {
			this.proc.sendNoResponse({ type: "extension_ui_response", id: requestId, cancelled: true });
		}
		this.refreshOperationalState();
		this.log("info", `Extension dialog ${requestId} expired for ${this.sessionHandle}`);
	}

	private setState(state: SessionRuntimeSnapshot["state"]): void {
		if (this.state === state && state !== "starting") return;
		this.state = state;
		this.liveProjection?.setRuntimePhase(this.projectionIdentity(), state);
		this.touch();
		if (!this.startupReady && state !== "starting" && state !== "crashed" && state !== "dormant") return;
		this.emitSupervisorMessage({ type: "runtime_state", runtime: this.snapshot() });
	}

	private touch(): void {
		this.lastActivityAt = Date.now();
	}

	private identityTransitionBlocker(): string | null {
		if (!this.running) return "process";
		if (this.state !== "idle") return this.state;
		if (this.agentBusy) return "agent";
		if (this.compactionBusy) return "compaction";
		if (this.activeQueueDepth > 0) return "queue";
		if (this.inFlight > 0) return "command";
		if (this.pendingDialogs.size > 0) return "dialog";
		if (this.pendingTurnReservations.size > 0) return "turn_reservation";
		if (this.transitioning) return "transition";
		return null;
	}

	private refreshOperationalState(): void {
		if (!this.startupReady || !this.running) return;
		if (this.pendingDialogs.size > 0) this.setState("waiting_ui");
		else if (this.agentBusy || this.compactionBusy || this.pendingTurnReservations.size > 0)
			this.setState("running");
		else {
			this.setState("idle");
			this.maybeCompactIdleProjectionBase();
		}
	}

	private maybeCompactIdleProjectionBase(): void {
		if (this.idleBaseCompactionPromise || this.identityTransitionBlocker() !== null) return;
		const projection = this.liveProjection;
		const proc = this.proc;
		if (!projection || !proc?.running || !projection.shouldCompactIdleBase()) return;
		const token = projection.beginIdleBaseCompaction();
		if (!token || token.expectedAsOfSeq === projection.snapshot().baseSeq) return;
		const processToken = this.processToken;
		let compaction!: Promise<void>;
		compaction = (async () => {
			const response = await proc.send({ type: "get_messages" }, this.timeoutFor("get_messages"));
			if (processToken !== this.processToken || this.proc !== proc || this.liveProjection !== projection)
				return;
			const { messages } = expectCommandData(response, "get_messages");
			if (projection.commitIdleBaseCompaction(token, messages)) this.assertWireSnapshotFits();
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
				if (this.idleBaseCompactionPromise === compaction) this.idleBaseCompactionPromise = null;
			});
		this.idleBaseCompactionPromise = compaction;
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
			this.releasePendingTurn(reservation);
			this.refreshOperationalState();
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
				this.releasePendingTurn(token);
				this.refreshOperationalState();
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
		const starting = this.startPromise;
		this.proc = null;
		this.clearOwnedOperationalState(false);
		this.startupReady = false;
		this.state = "crashed";
		this.liveProjection = null;
		this.touch();
		if (proc && !this.stopPromise) {
			let stopping!: Promise<void>;
			stopping = (async () => {
				try {
					await proc.stop();
					if (starting) await Promise.allSettled([starting]);
					this.finishProcessFinalization();
				} catch (error) {
					this.log("warn", `Unable to stop overflowed Session ${this.sessionHandle}: ${String(error)}`);
				} finally {
					if (this.stopPromise === stopping) this.stopPromise = null;
				}
			})();
			this.stopPromise = stopping;
		}
		this.emitSupervisorMessage({ type: "runtime_state", runtime: this.snapshot() });
	}

	private clearOwnedOperationalState(emitDialogCloses: boolean): void {
		this.startupFrames = [];
		this.startupFrameBytes = 0;
		this.transitionStage = null;
		this.closeAllDialogs("process_lost", emitDialogCloses);
		this.pendingDialogs.clear();
		this.clearPendingTurnReservations();
		this.stickyExtension.clear();
		this.clearReplay();
		this.agentBusy = false;
		this.compactionBusy = false;
		this.activeQueueDepth = 0;
		this.activeTurnProjectionItems = 0;
		this.activeTurnProjectionBytes = 0;
		this.activeTurnHeadroomReserved = false;
		this.inFlight = 0;
	}

	private emitSupervisorMessage(message: SessionSupervisorMessage): void {
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

function commandMayStartWork(commandType: string): boolean {
	return commandType === "prompt" || commandType === "steer" || commandType === "follow_up";
}

/** Commands whose successful admission represents user content that may still exist only in Pi memory. */
function commandCarriesConversation(commandType: string): boolean {
	return commandMayStartWork(commandType) || commandType === "bash";
}

function commandReleasesQueuedWork(commandType: string): boolean {
	return commandType === "abort" || commandType === "abort_retry";
}

function transitionWasCancelled(response: SessionCommandResponseDto): boolean {
	if (response.success !== true || !("data" in response)) return false;
	const data = response.data;
	return typeof data === "object" && data !== null && (data as { cancelled?: unknown }).cancelled === true;
}

function bufferedFrameBytes(frame: BufferedFrame): number {
	return Buffer.byteLength(JSON.stringify(frame));
}

function isReplayableFrame(frame: BufferedFrame): boolean {
	return !(frame.type === "extension_ui_request" && frame.request.method === "notify");
}

function extensionRequestBytes(request: ExtensionUiRequestDto): number {
	return Buffer.byteLength(JSON.stringify(request));
}

function stickyRequestKey(request: ExtensionUiRequestDto): string {
	if (request.method === "setStatus") return `setStatus:${request.statusKey}`;
	if (request.method === "setWidget") return `setWidget:${request.widgetKey}`;
	return request.method;
}

function stickyRequestClearsState(request: ExtensionUiRequestDto): boolean {
	return (
		(request.method === "setStatus" && request.statusText === undefined) ||
		(request.method === "setWidget" && request.widgetLines === undefined)
	);
}

function stickyClearRequest(request: ExtensionUiRequestDto): ExtensionUiRequestDto {
	const id = `evicted:${randomUUID()}`;
	if (request.method === "setStatus") return { ...request, id, statusText: undefined };
	if (request.method === "setWidget") return { ...request, id, widgetLines: undefined };
	if (request.method === "setTitle") return { ...request, id, title: "" };
	if (request.method === "set_editor_text") return { ...request, id, text: "" };
	throw new RpcError("extension_ui_request", "invalid_sticky_extension_method");
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
