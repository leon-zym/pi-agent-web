import fs from "node:fs";
import path from "node:path";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { commandTimeoutMs, type PiWebSessionEvent, RpcError } from "@pi-agent-web/protocol";
import { canonicalizeSessionFile, sessionHandleForCanonicalFile } from "./native-session-catalog.js";
import { PiProcess } from "./pi-process.js";
import type { ResolvedPi } from "./resolver.js";
import { canonicalizePathAllowMissing } from "./session-layout-resolver.js";
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
const DEFAULT_EXTENSION_STATE_MAX_ITEMS = 128;
const DEFAULT_PENDING_DIALOG_LIMIT = 32;

type BufferedFrame =
	| { type: "event"; event: PiWebSessionEvent }
	| { type: "extension_ui_request"; request: RpcExtensionUIRequest }
	| {
			type: "extension_ui_closed";
			requestId: string;
			reason: "answered" | "cancelled" | "expired" | "process_lost" | "replaced";
	  };

interface PendingDialog {
	request: RpcExtensionUIRequest;
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
}

export interface SessionRuntimeOptions {
	target: SessionTarget;
	resolved: ResolvedPi;
	env?: Record<string, string>;
	readyTimeoutMs?: number;
	replayLimit?: number;
	replayMaxBytes?: number;
	transientBufferMaxBytes?: number;
	extensionStateMaxBytes?: number;
	extensionStateMaxItems?: number;
	pendingDialogLimit?: number;
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
	private pendingDialogs = new Map<string, PendingDialog>();
	private stickyExtension = new Map<string, RpcExtensionUIRequest>();
	private activeQueueDepth = 0;
	private agentBusy = false;
	private compactionBusy = false;
	private inFlight = 0;
	private reservations = 0;
	private commandTail: Promise<void> = Promise.resolve();
	private awaitingWorkStart = false;
	private workStartTimer: NodeJS.Timeout | null = null;
	private manuallyStopped = true;
	private sessionFileIdentityVerified = false;
	private hasConversationIntent = false;

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
		this.clearReplay();
		this.startupReady = false;
		this.startupFrames = [];
		this.startupFrameBytes = 0;
		this.stickyExtension.clear();
		this.clearWorkStartGrace();
		this.awaitingWorkStart = false;
		this.error = undefined;
		this.setState("starting");

		const proc = new PiProcess({
			cwd: this.cwd,
			resolved: this.opts.resolved,
			args: this.spawnArguments(),
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
		} catch (error) {
			if (this.failedProcessToken !== processToken) {
				this.handleFailure(processToken, {
					code: null,
					signal: null,
					stderrTail: error instanceof Error ? error.message : String(error),
				});
			}
			throw error;
		}
	}

	private spawnArguments(): string[] {
		const target = this.opts.target;
		if (target.kind === "new" && this.sessionFile === null) {
			return ["--session-id", target.nativeSessionId, "--session-dir", target.sessionDir];
		}
		if (!this.sessionFile) throw new RpcError("start", "session target has no file");
		return ["--session", this.sessionFile, "--session-dir", path.dirname(this.sessionFile)];
	}

	private handleReady(processToken: number, state: RpcSessionState | undefined): void {
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
		this.startupReady = true;
		this.setState(this.pendingDialogs.size > 0 ? "waiting_ui" : "idle");
		this.flushFrames(this.startupFrames);
		this.startupFrames = [];
		this.startupFrameBytes = 0;
		this.log("info", `Pi runtime ready for ${this.sessionHandle}`);
	}

	async send(
		command: RpcCommand,
		expectedGeneration: number,
		admit: () => void,
		timeoutMs?: number,
	): Promise<RpcResponse> {
		const admitted = await this.withCommandAdmission(async () => {
			this.assertGeneration(command.type, expectedGeneration);
			admit();
			const proc = this.proc;
			if (!proc?.running) throw new RpcError(command.type, "pi process is not running");
			this.inFlight += 1;
			// Once user content reaches a live Pi process, a timeout or malformed
			// response cannot prove that Pi rejected it. Retain the runtime unless
			// the Session later materializes and becomes independently recoverable.
			if (commandCarriesConversation(command.type)) this.hasConversationIntent = true;
			const expectsWork = commandMayStartWork(command.type);
			if (expectsWork) this.beginWorkStartGrace();
			this.touch();
			return {
				expectsWork,
				response: proc.send(command, timeoutMs ?? this.timeoutFor(command.type)),
			};
		});
		try {
			const response = await admitted.response;
			if (admitted.expectsWork) this.finishWorkCommandResponse(response.success === true);
			return response;
		} catch (error) {
			if (admitted.expectsWork) this.cancelWorkStartGrace();
			throw error;
		} finally {
			this.inFlight -= 1;
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
		command: RpcCommand,
		expectedGeneration: number,
		admit: () => void,
	): Promise<{ response: RpcResponse; previousSessionHandle?: string }> {
		return this.withCommandAdmission(async () => {
			this.assertGeneration(command.type, expectedGeneration);
			admit();
			const blocker = this.identityTransitionBlocker();
			if (blocker) throw new RpcError(command.type, `session_busy:${blocker}`);
			const proc = this.proc;
			if (!proc?.running) throw new RpcError(command.type, "pi process is not running");
			this.transitionStage = { phase: "awaiting_response", frames: [], bytes: 0 };
			this.inFlight += 1;
			const previousSessionHandle = this.sessionHandle;
			let parentIdentityConfirmed = false;
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
					!(stateResponse.data as RpcSessionState).sessionFile
				) {
					throw new RpcError(command.type, "unable to verify forked session identity");
				}

				const transition = this.transitionTarget(stateResponse.data as RpcSessionState);
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

				let applied = false;
				await this.opts.commitIdentityTransition(this, {
					previousSessionHandle,
					nextTarget,
					apply: () => {
						if (applied) throw new RpcError(command.type, "transition identity applied twice");
						if (transition.frozenFile) {
							assertFrozenSessionFile(transition.frozenFile, nextTarget.nativeSessionId, nextTarget.cwd);
						} else {
							assertUnpersistedTransitionTarget(nextTarget);
						}
						applied = true;
						this.adoptTransitionTarget(nextTarget, transition.frozenFile !== null);
					},
				});
				if (!applied) throw new RpcError(command.type, "transition identity was not committed");
				this.flushTransitionFrames();
				return { response, previousSessionHandle };
			} catch (error) {
				if (!parentIdentityConfirmed) {
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
				this.inFlight -= 1;
				this.transitionStage = null;
				this.refreshOperationalState();
				this.touch();
			}
		});
	}

	private timeoutFor(commandType: string): number {
		return this.opts.commandTimeoutFor?.(commandType) ?? commandTimeoutMs(commandType);
	}

	private transitionTarget(state: RpcSessionState): {
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
		this.clearReplay();
		this.stickyExtension.clear();
		this.error = undefined;
		this.state = this.pendingDialogs.size > 0 ? "waiting_ui" : "idle";
		this.touch();
	}

	getReplay(cursor?: ReplayCursor): ReplayResult {
		const runtime = this.snapshot();
		const extensionRequests = this.getPendingExtensionRequests();
		if (!cursor) return { type: "resync_required", runtime, reason: "initial", extensionRequests };
		if (cursor.generation !== this.generation)
			return { type: "resync_required", runtime, reason: "generation_changed", extensionRequests };
		if (cursor.seq < 0 || cursor.seq > this.lastSeq)
			return { type: "resync_required", runtime, reason: "invalid_cursor", extensionRequests };
		if (cursor.seq === this.lastSeq) return { type: "replay", runtime, frames: [], extensionRequests };
		const oldestSeq = this.replay[0]?.seq ?? this.lastSeq + 1;
		if (cursor.seq < oldestSeq - 1)
			return { type: "resync_required", runtime, reason: "gap", extensionRequests };
		return {
			type: "replay",
			runtime,
			frames: this.replay.filter((frame) => frame.seq > cursor.seq),
			extensionRequests,
		};
	}

	getPendingExtensionRequests(): RpcExtensionUIRequest[] {
		const pending = [...this.pendingDialogs.values()].map((entry) => entry.request);
		return [...this.stickyExtension.values(), ...pending];
	}

	sendExtensionUiResponse(response: RpcExtensionUIResponse): "accepted" | "no_dialog" | "not_running" {
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
		this.clearWorkStartGrace();
		this.awaitingWorkStart = false;
		this.closeAllDialogs("process_lost");
		this.clearReplay();
		const proc = this.proc;
		const starting = this.startPromise;
		this.proc = null;
		let stopping!: Promise<void>;
		stopping = (async () => {
			try {
				await proc?.stop();
				if (starting) await Promise.allSettled([starting]);
				this.finishProcessFinalization();
				this.agentBusy = false;
				this.compactionBusy = false;
				this.activeQueueDepth = 0;
				this.transitionStage = null;
				this.setState("dormant");
			} finally {
				if (this.stopPromise === stopping) this.stopPromise = null;
			}
		})();
		this.stopPromise = stopping;
		return stopping;
	}

	private handleEvent(processToken: number, event: PiWebSessionEvent): void {
		if (processToken !== this.processToken) return;
		this.verifyMaterializedSessionFile();
		this.enqueueFrame({ type: "event", event });
	}

	private applyEventState(event: PiWebSessionEvent): void {
		if (event.type === "queue_update") {
			this.activeQueueDepth = event.steering.length + event.followUp.length;
		}
		if (event.type === "compaction_start") {
			this.compactionBusy = true;
			this.setState("running");
		} else if (event.type === "compaction_end") {
			this.compactionBusy = false;
			if (event.willRetry) this.agentBusy = true;
			this.refreshOperationalState();
		} else if (eventStartsWork(event)) {
			this.clearWorkStartGrace();
			this.awaitingWorkStart = false;
			this.agentBusy = true;
			this.setState("running");
		} else if (eventSettlesWork(event)) {
			this.clearWorkStartGrace();
			this.awaitingWorkStart = false;
			this.agentBusy = false;
			this.refreshOperationalState();
		}
		this.touch();
	}

	private handleExtensionRequest(processToken: number, request: RpcExtensionUIRequest): void {
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

	private trackDialog(request: RpcExtensionUIRequest, processToken: number, publishState: boolean): void {
		this.closeDialog(request.id, "replaced");
		const requestBytes = extensionRequestBytes(request);
		this.evictStickyUntilFits(requestBytes, 1);
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

	private rememberStickyRequest(request: RpcExtensionUIRequest): void {
		let key = request.method;
		if (request.method === "setStatus") key += `:${request.statusKey}`;
		if (request.method === "setWidget") key += `:${request.widgetKey}`;
		this.stickyExtension.delete(key);
		if (
			(request.method === "setStatus" && request.statusText === undefined) ||
			(request.method === "setWidget" && request.widgetLines === undefined)
		) {
			return;
		}
		const requestBytes = extensionRequestBytes(request);
		this.evictStickyUntilFits(requestBytes, 1);
		if (!this.extensionStateFits(requestBytes, 1)) {
			this.log("warn", `Dropping oversized sticky extension state for ${this.sessionHandle}`);
			return;
		}
		this.stickyExtension.set(key, request);
	}

	private extensionStateFits(extraBytes: number, extraItems: number): boolean {
		return (
			this.extensionStateBytes() + extraBytes <= this.opts.extensionStateMaxBytes &&
			this.pendingDialogs.size + this.stickyExtension.size + extraItems <= this.opts.extensionStateMaxItems
		);
	}

	private evictStickyUntilFits(extraBytes: number, extraItems: number): void {
		while (this.stickyExtension.size > 0 && !this.extensionStateFits(extraBytes, extraItems)) {
			const oldestKey = this.stickyExtension.keys().next().value as string | undefined;
			if (!oldestKey) break;
			this.stickyExtension.delete(oldestKey);
		}
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
		this.emitFrame(frame);
		this.applyFrameState(frame);
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
			this.emitFrame(frame);
			this.applyFrameState(frame);
		}
	}

	private applyFrameState(frame: BufferedFrame): void {
		if (frame.type === "event") {
			this.applyEventState(frame.event);
			return;
		}
		if (frame.type === "extension_ui_closed") return;
		if (STICKY_EXTENSION_METHODS.has(frame.request.method)) this.rememberStickyRequest(frame.request);
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

	private emitFrame(frame: BufferedFrame): void {
		this.lastSeq += 1;
		const envelope: SessionReplayFrame = {
			...frame,
			sessionHandle: this.sessionHandle,
			workspaceId: this.workspaceId,
			generation: this.generation,
			seq: this.lastSeq,
		} as SessionReplayFrame;
		const bytes = Buffer.byteLength(JSON.stringify(envelope));
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
		this.opts.emit(envelope);
	}

	private handleFailure(
		processToken: number,
		info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string },
	): void {
		if (processToken !== this.processToken || this.failedProcessToken === processToken) return;
		this.failedProcessToken = processToken;
		this.proc = null;
		this.finishProcessFinalization();
		this.startupFrames = [];
		this.startupFrameBytes = 0;
		this.transitionStage = null;
		this.clearWorkStartGrace();
		this.awaitingWorkStart = false;
		this.closeAllDialogs("process_lost");
		this.clearReplay();
		this.agentBusy = false;
		this.compactionBusy = false;
		this.activeQueueDepth = 0;
		this.error = this.describeFailure(info);
		this.setState("crashed");
		this.log("error", `Pi runtime crashed for ${this.sessionHandle}: ${this.error}`);
		if (!this.manuallyStopped) this.opts.onCrash(this);
	}

	private describeFailure(info: {
		code: number | null;
		signal: NodeJS.Signals | null;
		stderrTail: string;
	}): string {
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
	): void {
		const dialog = this.pendingDialogs.get(requestId);
		if (!dialog) return;
		if (dialog.timer) clearTimeout(dialog.timer);
		this.pendingDialogs.delete(requestId);
		if (this.startupReady) this.emitFrame({ type: "extension_ui_closed", requestId, reason });
	}

	private closeAllDialogs(reason: Extract<BufferedFrame, { type: "extension_ui_closed" }>["reason"]): void {
		for (const requestId of [...this.pendingDialogs.keys()]) this.closeDialog(requestId, reason);
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
		this.touch();
		if (!this.startupReady && state !== "starting" && state !== "crashed" && state !== "dormant") return;
		this.opts.emit({ type: "runtime_state", runtime: this.snapshot() });
	}

	private touch(): void {
		this.lastActivityAt = Date.now();
	}

	private identityTransitionBlocker(): string | null {
		if (!this.running) return "process";
		if (this.state !== "idle") return this.state;
		if (this.agentBusy) return "agent";
		if (this.compactionBusy) return "compaction";
		if (this.awaitingWorkStart) return "agent_start";
		if (this.activeQueueDepth > 0) return "queue";
		if (this.inFlight > 0) return "command";
		if (this.pendingDialogs.size > 0) return "dialog";
		if (this.transitioning) return "transition";
		return null;
	}

	private refreshOperationalState(): void {
		if (!this.startupReady || !this.running) return;
		if (this.pendingDialogs.size > 0) this.setState("waiting_ui");
		else if (this.agentBusy || this.compactionBusy || this.awaitingWorkStart) this.setState("running");
		else this.setState("idle");
	}

	private beginWorkStartGrace(): void {
		this.clearWorkStartGrace();
		this.awaitingWorkStart = true;
		this.setState("running");
	}

	private finishWorkCommandResponse(success: boolean): void {
		if (!success) {
			this.cancelWorkStartGrace();
			return;
		}
		if (!this.awaitingWorkStart) return;
		this.workStartTimer = setTimeout(() => {
			this.workStartTimer = null;
			this.awaitingWorkStart = false;
			this.refreshOperationalState();
		}, 500);
		this.workStartTimer.unref?.();
	}

	private cancelWorkStartGrace(): void {
		this.clearWorkStartGrace();
		this.awaitingWorkStart = false;
		this.refreshOperationalState();
	}

	private clearWorkStartGrace(): void {
		if (this.workStartTimer) clearTimeout(this.workStartTimer);
		this.workStartTimer = null;
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
	}

	private assertGeneration(command: string, expectedGeneration: number): void {
		if (expectedGeneration !== this.generation) {
			throw new RpcError(command, "session_generation_stale");
		}
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

function transitionWasCancelled(response: RpcResponse): boolean {
	if (response.success !== true || !("data" in response)) return false;
	const data = response.data;
	return typeof data === "object" && data !== null && (data as { cancelled?: unknown }).cancelled === true;
}

function bufferedFrameBytes(frame: BufferedFrame): number {
	return Buffer.byteLength(JSON.stringify(frame));
}

function extensionRequestBytes(request: RpcExtensionUIRequest): number {
	return Buffer.byteLength(JSON.stringify(request));
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
