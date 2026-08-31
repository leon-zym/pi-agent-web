import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
	ExtensionUiResponseDto,
	HotRuntimeInventoryDto,
	HotRuntimeInventoryEntryDto,
	SessionCommandDto,
	SessionRuntimeIdentityDto,
} from "@pi-agent-web/protocol";
import {
	RpcError,
	SESSION_HOT_RUNTIME_INVENTORY_MAX_ITEMS,
	SESSION_SNAPSHOT_MAX_BYTES,
} from "@pi-agent-web/protocol";
import type { ProbedPiRuntime } from "./resolver.js";
import { canonicalizePathAllowMissing } from "./session-layout-resolver.js";
import type { SessionLiveProjectionLimits } from "./session-live-projection.js";
import {
	type SessionHotRuntimeObservation,
	type SessionIdentityTransitionCommit,
	SessionRuntime,
	type SessionRuntimeCore,
	type SessionRuntimeCoreOptions,
	type SessionRuntimePiPayloadServices,
	type SessionRuntimeProductEvent,
	type SessionRuntimeProductExtensionRequest,
	type SessionRuntimeProductMode,
	type SessionRuntimeProductResponse,
	type SessionRuntimeProductSnapshot,
} from "./session-runtime.js";
import {
	type ExistingSessionTarget,
	HOST_MANAGED_COMMANDS,
	IDENTITY_TRANSITION_COMMANDS,
	type NewSessionTarget,
	READ_ONLY_COMMANDS,
	type ReplayCursor,
	type ReplayResult,
	type SessionCommandResult,
	type SessionLeaseSnapshot,
	type SessionLeaseTransition,
	type SessionRuntimeSnapshot,
	type SessionSupervisorMessage,
} from "./session-runtime-types.js";

const DEFAULT_TRANSIENT_IDLE_TTL_MS = 30_000;
const MAX_TRANSIENT_IDLE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_RETAINED_PROJECTION_BYTES = 512 * 1024 * 1024;

export interface SessionCommandContext {
	connectionId: string;
	expectedGeneration: number;
	fencingToken?: string;
}

export interface SessionManagementContext {
	expectedGeneration: number;
	fencingToken: string;
}

export interface CreateSessionRequest {
	workspaceId: string;
	cwd: string;
	sessionDir: string;
	requestedNativeSessionId?: string;
}

export interface HotRuntimeSubscriptionToken {
	readonly kind: "hot_runtime_subscription";
}

export type HotRuntimeSubscriptionResult<M extends SessionRuntimeProductMode = "content_ref"> = ReplayResult<
	SessionRuntimeProductEvent<M>,
	SessionRuntimeProductSnapshot<M>,
	SessionRuntimeProductExtensionRequest<M>,
	SessionRuntimeProductSnapshot<M>["settledMessages"][number]
> & {
	observationToken: HotRuntimeSubscriptionToken;
};

interface HotRuntimeSubscriptionObservation<M extends SessionRuntimeProductMode = "content_ref"> {
	runtime: SessionRuntimeCore<M>;
	expected: SessionRuntimeIdentityDto;
	observation: SessionHotRuntimeObservation;
}

/** Shared constructor seam for the canonical Browser protocol. */
export interface SessionSupervisorBaseOptions<M extends SessionRuntimeProductMode = "content_ref"> {
	serverEpoch?: string;
	resolved: ProbedPiRuntime;
	env?: Record<string, string>;
	envForWorkspace?: (cwd: string) => Record<string, string>;
	resolveSession: (sessionHandle: string) => Promise<ExistingSessionTarget | undefined>;
	broadcast: (
		message: SessionSupervisorMessage<
			SessionRuntimeProductEvent<M>,
			SessionRuntimeProductExtensionRequest<M>
		>,
	) => void;
	onHotRuntimeInventory?: (inventory: HotRuntimeInventoryDto) => void;
	log?: (level: "info" | "warn" | "error", message: string) => void;
	readyTimeoutMs?: number;
	replayLimit?: number;
	replayMaxBytes?: number;
	transientBufferMaxBytes?: number;
	extensionStateMaxBytes?: number;
	extensionStateMaxItems?: number;
	pendingDialogLimit?: number;
	/** Per-canonical-Session cap for pending Pi command responses. */
	maxPendingCommands?: number;
	projectionLimits?: Partial<SessionLiveProjectionLimits>;
	commandTimeoutFor?: (commandType: string) => number;
	/** Hard cap for concurrently owned Pi processes. */
	maxHotProcesses?: number;
	/** @deprecated Use maxHotProcesses. Kept for current embedders during the contract transition. */
	maxHotRuntimes?: number;
	/** Aggregate upper bound reserved for retained per-runtime projection state. */
	maxRetainedProjectionBytes?: number;
	idleTtlMs?: number;
	/** Untouched, unclaimed, unpersisted Sessions are forgotten after this bounded grace period. */
	transientIdleTtlMs?: number;
	restartWindowMs?: number;
	maxAutoRestarts?: number;
	restartBaseDelayMs?: number;
}

export interface SessionSupervisorOptions extends SessionSupervisorBaseOptions<"content_ref"> {
	piPayloadServices: SessionRuntimePiPayloadServices<"content_ref">;
}

type SupervisorRuntimeOptions<M extends SessionRuntimeProductMode> = Omit<
	SessionRuntimeCoreOptions<M>,
	"productAdapter" | "payloadCustody"
>;

interface LeaseOwner {
	connectionId: string;
	fencingToken: string;
}

interface LeaseState {
	generation: number;
	revision: number;
	owner?: LeaseOwner;
	terminal: boolean;
}

interface LeaseClaimResult {
	lease: SessionLeaseSnapshot;
	transition?: SessionLeaseTransition;
}

interface LeaseReleaseResult {
	released: boolean;
	transition?: SessionLeaseTransition;
}

interface Alias {
	next: string;
	expiresAt: number;
}

/**
 * Session-granularity Pi process pool.
 *
 * A persisted Session is resolved lazily from the native catalog and owns at
 * most one hot runtime. Historical Sessions remain dormant. Control leases,
 * crash budgets, replay, and capacity are isolated per Session handle.
 */
export class SessionSupervisorCore<M extends SessionRuntimeProductMode = "content_ref"> {
	private readonly hotRuntimeSubscriptionObservations = new WeakMap<
		HotRuntimeSubscriptionToken,
		HotRuntimeSubscriptionObservation<M>
	>();
	readonly serverEpoch: string;
	private readonly opts: Required<
		Pick<
			SessionSupervisorBaseOptions<M>,
			| "readyTimeoutMs"
			| "replayLimit"
			| "maxHotProcesses"
			| "maxHotRuntimes"
			| "maxRetainedProjectionBytes"
			| "idleTtlMs"
			| "transientIdleTtlMs"
			| "restartWindowMs"
			| "maxAutoRestarts"
			| "restartBaseDelayMs"
		>
	> &
		SessionSupervisorBaseOptions<M>;
	private readonly runtimeFactory: (options: SupervisorRuntimeOptions<M>) => SessionRuntimeCore<M>;
	private runtimes = new Map<string, SessionRuntimeCore<M>>();
	private activationPromises = new Map<string, Promise<SessionRuntimeCore<M>>>();
	private leases = new Map<string, LeaseState>();
	private aliases = new Map<string, Alias>();
	private crashTimes = new Map<string, number[]>();
	private restartTimers = new Map<string, NodeJS.Timeout>();
	private deletionReservations = new Map<string, string>();
	private deletionOperations = new Set<Promise<unknown>>();
	private workspaceTransitions = new Set<string>();
	private workspaceCreations = new Map<string, number>();
	private reaper: NodeJS.Timeout;
	private poolTail: Promise<void> = Promise.resolve();
	private leaseTail: Promise<void> = Promise.resolve();
	private hotInventoryRevision = 0;
	private hotInventoryEntries: HotRuntimeInventoryEntryDto[] = [];
	private hotInventorySignature = "[]";
	private hotInventoryRefreshScheduled = false;
	private closed = false;
	private closePromise: Promise<void> | null = null;

	constructor(
		opts: SessionSupervisorBaseOptions<M>,
		runtimeFactory: (options: SupervisorRuntimeOptions<M>) => SessionRuntimeCore<M>,
	) {
		this.runtimeFactory = runtimeFactory;
		this.serverEpoch = opts.serverEpoch ?? randomUUID();
		const configuredMaxHotProcesses = Number.isFinite(opts.maxHotProcesses)
			? Math.floor(opts.maxHotProcesses ?? 8)
			: Number.isFinite(opts.maxHotRuntimes)
				? Math.floor(opts.maxHotRuntimes ?? 8)
				: 8;
		const maxHotProcesses = Math.min(
			SESSION_HOT_RUNTIME_INVENTORY_MAX_ITEMS,
			Math.max(1, configuredMaxHotProcesses),
		);
		const projectionReservationBytes = Math.max(
			1,
			Math.floor(opts.projectionLimits?.maxSnapshotBytes ?? SESSION_SNAPSHOT_MAX_BYTES),
		);
		const maxRetainedProjectionBytes = Math.max(
			projectionReservationBytes,
			Number.isFinite(opts.maxRetainedProjectionBytes)
				? Math.floor(opts.maxRetainedProjectionBytes ?? DEFAULT_MAX_RETAINED_PROJECTION_BYTES)
				: DEFAULT_MAX_RETAINED_PROJECTION_BYTES,
		);
		this.opts = {
			...opts,
			readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
			replayLimit: opts.replayLimit ?? 1_024,
			maxHotProcesses,
			maxHotRuntimes: maxHotProcesses,
			maxRetainedProjectionBytes,
			idleTtlMs: opts.idleTtlMs ?? 10 * 60_000,
			transientIdleTtlMs: Math.max(
				0,
				Math.min(opts.transientIdleTtlMs ?? DEFAULT_TRANSIENT_IDLE_TTL_MS, MAX_TRANSIENT_IDLE_TTL_MS),
			),
			restartWindowMs: opts.restartWindowMs ?? 30_000,
			maxAutoRestarts: opts.maxAutoRestarts ?? 3,
			restartBaseDelayMs: opts.restartBaseDelayMs ?? 500,
		};
		this.reaper = setInterval(
			() =>
				void this.reapIdle().catch((error) => {
					if (!this.closed) this.log("warn", `Idle Session reaper failed: ${String(error)}`);
				}),
			Math.max(1_000, Math.min(30_000, this.opts.idleTtlMs, this.opts.transientIdleTtlMs)),
		);
		this.reaper.unref?.();
	}

	listRuntimes(): SessionRuntimeSnapshot[] {
		return [...new Set(this.runtimes.values())].map((runtime) => runtime.snapshot());
	}

	getRuntime(sessionHandle: string): SessionRuntimeSnapshot | undefined {
		return this.runtimes.get(this.resolveAlias(sessionHandle))?.snapshot();
	}

	getHotRuntimeInventory(): HotRuntimeInventoryDto {
		return {
			type: "hot_runtime_inventory",
			serverEpoch: this.serverEpoch,
			revision: this.hotInventoryRevision,
			runtimes: this.hotInventoryEntries.map((entry) => ({ ...entry })),
		};
	}

	async activate(sessionHandle: string): Promise<SessionRuntimeSnapshot> {
		return (await this.ensureRuntime(sessionHandle)).snapshot();
	}

	async createSession(request: CreateSessionRequest): Promise<SessionRuntimeSnapshot> {
		this.assertOpen();
		const releaseCreation = await this.reserveWorkspaceCreation(request.workspaceId);
		try {
			return await this.createSessionWithReservation(request);
		} finally {
			await releaseCreation();
		}
	}

	private async createSessionWithReservation(request: CreateSessionRequest): Promise<SessionRuntimeSnapshot> {
		const temporaryHandle = `pending_${randomUUID()}`;
		const target: NewSessionTarget = {
			kind: "new",
			sessionHandle: temporaryHandle,
			workspaceId: request.workspaceId,
			cwd: canonicalizePathAllowMissing(request.cwd),
			sessionDir: canonicalizePathAllowMissing(request.sessionDir),
			nativeSessionId: request.requestedNativeSessionId ?? randomUUID(),
		};
		const runtime = this.createRuntime(target);
		await this.withPoolLock(async () => {
			this.assertOpen();
			await this.ensureCapacity();
			this.assertOpen();
			this.runtimes.set(temporaryHandle, runtime);
			void runtime.start().catch(() => {
				// The awaited call below owns the startup error.
			});
		});
		try {
			await runtime.start();
		} catch (error) {
			await this.withPoolLock(async () => {
				if (this.runtimes.get(temporaryHandle) === runtime) this.runtimes.delete(temporaryHandle);
				this.clearRestart(runtime.sessionHandle);
			});
			throw error;
		}
		let leaseTransition: SessionLeaseTransition | undefined;
		try {
			await this.withPoolLock(async () => {
				this.assertOpen();
				if (this.runtimes.get(temporaryHandle) !== runtime) {
					throw new RpcError("new_session", "new session runtime lost before identity commit");
				}
				const collision = this.runtimes.get(runtime.sessionHandle);
				if (collision && collision !== runtime) {
					throw new RpcError("new_session", "canonical_session_already_active");
				}
				leaseTransition = await this.rekeyRuntime(temporaryHandle, runtime, true);
				this.commitHotRuntimeInventoryIfChanged();
				this.safeBroadcast({ type: "session_directory_changed", workspaceId: request.workspaceId });
			});
		} catch (error) {
			await runtime.stop();
			await this.withPoolLock(async () => {
				if (this.runtimes.get(temporaryHandle) === runtime) this.runtimes.delete(temporaryHandle);
				if (this.runtimes.get(runtime.sessionHandle) === runtime) this.runtimes.delete(runtime.sessionHandle);
			});
			throw error;
		}
		if (leaseTransition) this.safeBroadcast({ type: "lease_transition", transition: leaseTransition });
		return runtime.snapshot();
	}

	async subscribe(
		sessionHandle: string,
		cursor?: ReplayCursor,
	): Promise<
		ReplayResult<
			SessionRuntimeProductEvent<M>,
			SessionRuntimeProductSnapshot<M>,
			SessionRuntimeProductExtensionRequest<M>,
			SessionRuntimeProductSnapshot<M>["settledMessages"][number]
		>
	> {
		const runtime = await this.ensureRuntime(sessionHandle);
		return runtime.getReplay(sessionHandle, cursor);
	}

	async subscribeHotExact(
		expected: SessionRuntimeIdentityDto,
		cursor?: ReplayCursor,
	): Promise<HotRuntimeSubscriptionResult<M>> {
		return this.withPoolLock(async () => {
			this.assertOpen();
			const runtime = this.runtimes.get(expected.sessionHandle);
			if (!runtime) throw new RpcError("session_subscribe", "hot_runtime_not_found");
			const observation = runtime.captureHotRuntimeObservation();
			if (!observation) throw new RpcError("session_subscribe", "hot_runtime_not_found");
			if (!this.matchesHotRuntimeIdentity(observation, expected)) {
				throw new RpcError("session_subscribe", "hot_runtime_identity_changed");
			}
			const baseline = runtime.getReplay(expected.sessionHandle, cursor);
			if (
				this.runtimes.get(expected.sessionHandle) !== runtime ||
				!runtime.isHotRuntimeObservationCurrent(observation)
			) {
				throw new RpcError("session_subscribe", "hot_runtime_identity_changed");
			}
			const observationToken = Object.freeze({
				kind: "hot_runtime_subscription" as const,
			});
			this.hotRuntimeSubscriptionObservations.set(observationToken, {
				runtime,
				expected: { ...expected },
				observation,
			});
			return { ...baseline, observationToken };
		});
	}

	/** Consume an exact-hot observation immediately before its baseline becomes visible. */
	revalidateHotExactSubscription(token: HotRuntimeSubscriptionToken): boolean {
		const captured = this.hotRuntimeSubscriptionObservations.get(token);
		this.hotRuntimeSubscriptionObservations.delete(token);
		if (!captured) return false;
		const current = this.runtimes.get(captured.expected.sessionHandle);
		return (
			current === captured.runtime &&
			this.matchesHotRuntimeIdentity(captured.observation, captured.expected) &&
			current.isHotRuntimeObservationCurrent(captured.observation)
		);
	}

	async claim(sessionHandle: string, connectionId: string): Promise<SessionLeaseSnapshot> {
		return (await this.claimWithTransition(sessionHandle, connectionId)).lease;
	}

	async claimWithTransition(sessionHandle: string, connectionId: string): Promise<LeaseClaimResult> {
		const handle = this.resolveAlias(sessionHandle);
		const tracked = this.runtimes.get(handle);
		const runtime =
			tracked?.snapshotOverflowed && tracked.state === "crashed" && tracked.recoverable
				? tracked
				: await this.ensureRuntime(handle);
		return this.withPoolLock(async () => {
			this.assertOpen();
			const canonicalHandle = runtime.sessionHandle;
			if (this.deletionReservations.has(canonicalHandle)) throw new RpcError("claim", "session_deleting");
			if (this.runtimes.get(canonicalHandle) !== runtime) {
				throw new RpcError("claim", "session_runtime_not_tracked");
			}
			return this.withLeaseActor(() => {
				const state = this.leaseStateFor(canonicalHandle, runtime.generation);
				if (state.terminal) throw new RpcError("claim", "session_lease_revision_exhausted");
				if (state.owner && state.owner.connectionId !== connectionId) {
					return { lease: this.leaseSnapshot(canonicalHandle, runtime.generation, state, connectionId) };
				}
				if (state.owner) {
					return { lease: this.leaseSnapshot(canonicalHandle, runtime.generation, state, connectionId) };
				}
				const transition = this.commitLeaseTransition(canonicalHandle, runtime.generation, state, "claim", {
					connectionId,
					fencingToken: randomUUID(),
				});
				return {
					lease: this.leaseSnapshot(
						canonicalHandle,
						runtime.generation,
						this.leases.get(canonicalHandle),
						connectionId,
						"claim",
					),
					transition,
				};
			});
		});
	}

	async release(sessionHandle: string, connectionId: string): Promise<boolean> {
		return (await this.releaseWithTransition(sessionHandle, connectionId)).released;
	}

	async releaseWithTransition(sessionHandle: string, connectionId: string): Promise<LeaseReleaseResult> {
		const handle = this.resolveAlias(sessionHandle);
		return this.withLeaseActor(() => {
			const runtime = this.runtimes.get(handle);
			const generation = runtime?.generation ?? this.leases.get(handle)?.generation;
			if (generation === undefined) return { released: false };
			const state = this.leaseStateFor(handle, generation);
			if (state.terminal || !state.owner || state.owner.connectionId !== connectionId) {
				return { released: false };
			}
			const transition = this.commitLeaseTransition(handle, generation, state, "release");
			return { released: true, transition };
		});
	}

	async releaseExact(sessionHandle: string, connectionId: string, fencingToken: string): Promise<boolean> {
		return (await this.releaseExactWithTransition(sessionHandle, connectionId, fencingToken)).released;
	}

	async releaseExactWithTransition(
		sessionHandle: string,
		connectionId: string,
		fencingToken: string,
	): Promise<LeaseReleaseResult> {
		const handle = this.resolveAlias(sessionHandle);
		return this.withLeaseActor(() => {
			const runtime = this.runtimes.get(handle);
			const generation = runtime?.generation ?? this.leases.get(handle)?.generation;
			if (generation === undefined) return { released: false };
			const state = this.leaseStateFor(handle, generation);
			if (
				state.terminal ||
				!state.owner ||
				state.owner.connectionId !== connectionId ||
				state.owner.fencingToken !== fencingToken
			) {
				return { released: false };
			}
			const transition = this.commitLeaseTransition(handle, generation, state, "release");
			return { released: true, transition };
		});
	}

	async releaseConnection(connectionId: string): Promise<string[]> {
		return (await this.releaseConnectionWithTransitions(connectionId)).released;
	}

	async releaseConnectionWithTransitions(
		connectionId: string,
	): Promise<{ released: string[]; transitions: SessionLeaseTransition[] }> {
		return this.withLeaseActor(() => {
			const released: string[] = [];
			const transitions: SessionLeaseTransition[] = [];
			for (const [handle, state] of this.leases) {
				if (state.terminal || state.owner?.connectionId !== connectionId) continue;
				transitions.push(this.commitLeaseTransition(handle, state.generation, state, "disconnect"));
				released.push(handle);
			}
			return { released, transitions };
		});
	}

	async takeover(
		sessionHandle: string,
		expectedGeneration: number,
		expectedLeaseRevision: number,
		connectionId: string,
	): Promise<SessionLeaseTransition> {
		return this.withPoolLock(async () => {
			this.assertOpen();
			if (this.aliases.has(sessionHandle) || this.resolveAlias(sessionHandle) !== sessionHandle) {
				throw new RpcError("takeover", "session_handle_stale");
			}
			const runtime = this.runtimes.get(sessionHandle);
			if (!runtime || runtime.sessionHandle !== sessionHandle || runtime.state === "dormant") {
				throw new RpcError("takeover", "session_takeover_not_available");
			}
			if (this.deletionReservations.has(sessionHandle)) throw new RpcError("takeover", "session_deleting");
			if (
				runtime.transitioning ||
				this.workspaceHasPendingIdentity(runtime.workspaceId) ||
				!runtime.recoverable ||
				!runtime.sessionFile ||
				sessionHandle.startsWith("pending_")
			) {
				throw new RpcError("takeover", "session_identity_uncertain");
			}
			this.assertGeneration(runtime, "takeover", expectedGeneration);
			return this.withLeaseActor(() => {
				const state = this.leaseStateFor(sessionHandle, runtime.generation);
				if (state.terminal) throw new RpcError("takeover", "session_takeover_not_available");
				if (state.revision !== expectedLeaseRevision) {
					throw new RpcError("takeover", "session_lease_revision_stale");
				}
				if (!state.owner || state.owner.connectionId === connectionId) {
					throw new RpcError("takeover", "session_takeover_not_available");
				}
				return this.commitLeaseTransition(sessionHandle, runtime.generation, state, "takeover", {
					connectionId,
					fencingToken: randomUUID(),
				});
			});
		});
	}

	leaseFor(sessionHandle: string, connectionId: string): SessionLeaseSnapshot {
		const handle = this.resolveAlias(sessionHandle);
		const runtime = this.runtimes.get(handle);
		const state = this.leases.get(handle);
		const generation = runtime?.generation ?? state?.generation ?? 0;
		const activeState = state?.generation === generation ? state : undefined;
		return this.leaseSnapshot(handle, generation, activeState, connectionId);
	}

	async sendCommand(
		sessionHandle: string,
		command: SessionCommandDto,
		context: SessionCommandContext,
	): Promise<SessionCommandResult<SessionRuntimeProductResponse<M>>> {
		if (HOST_MANAGED_COMMANDS.has(command.type)) {
			throw new RpcError(command.type, "host_managed_session_lifecycle");
		}
		const { runtime, release } = await this.acquireRuntime(sessionHandle);
		try {
			if (runtime.state === "crashed" && !runtime.recoverable) {
				throw new RpcError(command.type, "unpersisted_session_lost");
			}
			const admit = () => {
				this.assertOpen();
				if (!READ_ONLY_COMMANDS.has(command.type)) this.assertLease(runtime, command.type, context);
			};

			if (IDENTITY_TRANSITION_COMMANDS.has(command.type)) {
				const releaseTransition = await this.reserveWorkspaceTransition(runtime.workspaceId);
				try {
					const result = await runtime.sendIdentityTransition(command, context.expectedGeneration, admit);
					return {
						serverEpoch: this.serverEpoch,
						sessionHandle: runtime.sessionHandle,
						generation: runtime.generation,
						barrierSeq: runtime.lastSeq,
						response: result.response,
						...(result.previousSessionHandle ? { previousSessionHandle: result.previousSessionHandle } : {}),
					};
				} finally {
					await releaseTransition();
				}
			}

			const response = await runtime.send(command, context.expectedGeneration, admit);
			const verifiedResponse = await attachExportHtmlUrl(command, response, runtime.cwd);
			return {
				serverEpoch: this.serverEpoch,
				sessionHandle: runtime.sessionHandle,
				generation: runtime.generation,
				barrierSeq: runtime.lastSeq,
				response: verifiedResponse,
			};
		} finally {
			release();
		}
	}

	async sendExtensionUiResponse(
		sessionHandle: string,
		response: ExtensionUiResponseDto,
		context: SessionCommandContext,
	): Promise<"accepted" | "no_dialog" | "not_running"> {
		this.assertOpen();
		const runtime = this.runtimes.get(this.resolveAlias(sessionHandle));
		if (!runtime) return "not_running";
		this.assertGeneration(runtime, "extension_ui_response", context.expectedGeneration);
		this.assertLease(runtime, "extension_ui_response", context);
		return runtime.sendExtensionUiResponse(response);
	}

	getPendingExtensionRequests(sessionHandle: string) {
		return this.runtimes.get(this.resolveAlias(sessionHandle))?.getPendingExtensionRequests();
	}

	async restart(sessionHandle: string, context?: SessionCommandContext): Promise<SessionRuntimeSnapshot> {
		this.assertOpen();
		const handle = this.resolveAlias(sessionHandle);
		const existing = this.runtimes.get(handle);
		if (!existing) {
			if (context) throw new RpcError("restart", "session_runtime_not_tracked");
			return this.activate(handle);
		}

		let runtime = existing;
		let release: (() => void) | undefined;
		let starting: Promise<void> | undefined;
		await this.withPoolLock(async () => {
			this.assertOpen();
			if (this.runtimes.get(handle) !== existing) {
				throw new RpcError("restart", "session_runtime_not_tracked");
			}
			if (context) this.assertGeneration(existing, "restart", context.expectedGeneration);
			if (this.deletionReservations.has(handle)) throw new RpcError("restart", "session_deleting");
			if (!existing.recoverable) {
				throw new RpcError("restart", "unpersisted_session_cannot_be_recovered");
			}
			if (existing.protocolIncompatible) {
				throw new RpcError("restart", "protocol_incompatible");
			}
			if (existing.state !== "crashed" && existing.state !== "dormant") {
				throw new RpcError("restart", "session_restart_requires_inactive_runtime");
			}
			if (context) {
				const lease = this.leaseOwnerFor(handle, existing.generation);
				if (
					!lease ||
					lease.connectionId !== context.connectionId ||
					lease.fencingToken !== context.fencingToken
				) {
					throw new RpcError("restart", "session_read_only");
				}
			}
			this.clearRestart(existing.sessionHandle);
			this.crashTimes.delete(existing.sessionHandle);
			if (existing.snapshotOverflowed) {
				const target = existing.rebuildTarget();
				if (!target) throw new RpcError("restart", "unpersisted_session_cannot_be_recovered");
				await existing.stop();
				if (this.runtimes.get(handle) !== existing) {
					throw new RpcError("restart", "session_runtime_not_tracked");
				}
				runtime = this.createRuntime(target, existing.generation);
				this.runtimes.set(handle, runtime);
			}
			await this.ensureCapacity();
			this.assertOpen();
			release = runtime.reserve();
			starting = runtime.start();
			void starting.catch(() => {
				// The awaited call below owns the startup error. Attaching the handler
				// here keeps capacity reservation and rejection observation atomic.
			});
		});
		try {
			if (!starting) throw new RpcError("restart", "session_restart_not_started");
			await starting;
			await this.withLeaseActor(() => this.reconcileLeaseGeneration(runtime));
			return runtime.snapshot();
		} finally {
			release?.();
		}
	}

	async stop(sessionHandle: string): Promise<void> {
		const handle = this.resolveAlias(sessionHandle);
		this.clearRestart(handle);
		await this.runtimes.get(handle)?.stop();
	}

	isActive(sessionHandle: string): boolean {
		const runtime = this.runtimes.get(this.resolveAlias(sessionHandle));
		return runtime?.running === true || runtime?.state === "starting";
	}

	/**
	 * Reserve an inactive canonical Session identity while a recoverable delete
	 * operation runs. Activation and fork commits share the same pool lock, so
	 * no process can open the file between the safety check and the move.
	 */
	async withSessionDeletion<T>(
		workspaceId: string,
		sessionHandle: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const pending = this.performSessionDeletion(workspaceId, sessionHandle, operation);
		this.deletionOperations.add(pending);
		try {
			return await pending;
		} finally {
			this.deletionOperations.delete(pending);
		}
	}

	/**
	 * Delete admission for the HTTP management surface. The fencing token is a
	 * capability issued only to the current WebSocket controller; coupling it
	 * with an exact runtime generation prevents observer and stale-tab writes.
	 */
	async withControlledSessionDeletion<T>(
		workspaceId: string,
		sessionHandle: string,
		context: SessionManagementContext,
		operation: () => Promise<T>,
	): Promise<T> {
		const pending = this.performControlledSessionDeletion(workspaceId, sessionHandle, context, operation);
		this.deletionOperations.add(pending);
		try {
			return await pending;
		} finally {
			this.deletionOperations.delete(pending);
		}
	}

	/**
	 * Stop and forget an untouched Pi Session that has never materialized a
	 * JSONL file. This is deliberately separate from recoverable deletion: it
	 * never removes a filesystem entry and requires the current controller's
	 * exact generation and fencing capability.
	 */
	async abandonTransient(
		workspaceId: string,
		sessionHandle: string,
		context: SessionManagementContext,
	): Promise<void> {
		const pending = this.performTransientAbandon(workspaceId, sessionHandle, context);
		this.deletionOperations.add(pending);
		try {
			await pending;
		} finally {
			this.deletionOperations.delete(pending);
		}
	}

	private async performTransientAbandon(
		workspaceId: string,
		sessionHandle: string,
		context: SessionManagementContext,
	): Promise<void> {
		this.assertOpen();
		const handle = this.resolveAlias(sessionHandle);
		let runtime: SessionRuntimeCore<M> | undefined;
		let sessionFile: string | null = null;
		await this.withPoolLock(async () => {
			this.assertOpen();
			if (this.deletionReservations.has(handle)) throw new RpcError("abandon", "session_deleting");
			if (this.workspaceHasPendingIdentity(workspaceId)) {
				throw new RpcError("abandon", "workspace_identity_transitioning");
			}
			runtime = this.runtimes.get(handle);
			if (!runtime || runtime.workspaceId !== workspaceId) {
				throw new RpcError("abandon", "session_control_required");
			}
			this.assertGeneration(runtime, "abandon", context.expectedGeneration);
			const lease = this.leaseOwnerFor(handle, runtime.generation);
			if (!lease || lease.fencingToken !== context.fencingToken) {
				throw new RpcError("abandon", "session_read_only");
			}
			if (!runtime.canAbandon || !runtime.sessionFile) {
				throw new RpcError("abandon", "session_not_abandonable");
			}
			sessionFile = runtime.sessionFile;
			this.deletionReservations.set(handle, workspaceId);
		});

		let succeeded = false;
		try {
			await runtime!.stop();
			await this.withPoolLock(async () => {
				if (this.runtimes.get(handle) !== runtime || this.deletionReservations.get(handle) !== workspaceId) {
					throw new RpcError("abandon", "session_abandon_reservation_lost");
				}
				if (sessionPathEntryExists(sessionFile!)) {
					throw new RpcError("abandon", "session_materialized");
				}
				this.clearRestart(handle);
				this.runtimes.delete(handle);
				await this.withLeaseActor(() => {
					this.leases.delete(handle);
				});
				this.crashTimes.delete(handle);
				for (const [alias, entry] of this.aliases) {
					if (alias === handle || entry.next === handle) this.aliases.delete(alias);
				}
				succeeded = true;
			});
		} finally {
			await this.withPoolLock(async () => {
				if (this.deletionReservations.get(handle) === workspaceId) {
					this.deletionReservations.delete(handle);
				}
			});
		}
		if (succeeded) this.safeBroadcast({ type: "session_directory_changed", workspaceId });
	}

	private async performControlledSessionDeletion<T>(
		workspaceId: string,
		sessionHandle: string,
		context: SessionManagementContext,
		operation: () => Promise<T>,
	): Promise<T> {
		this.assertOpen();
		const handle = this.resolveAlias(sessionHandle);
		let runtime: SessionRuntimeCore<M> | undefined;
		await this.withPoolLock(async () => {
			this.assertOpen();
			if (this.deletionReservations.has(handle)) throw new RpcError("delete", "session_deleting");
			if (this.workspaceHasPendingIdentity(workspaceId)) {
				throw new RpcError("delete", "workspace_identity_transitioning");
			}
			runtime = this.runtimes.get(handle);
			if (!runtime || runtime.workspaceId !== workspaceId) {
				throw new RpcError("delete", "session_control_required");
			}
			this.assertGeneration(runtime, "delete", context.expectedGeneration);
			const lease = this.leaseOwnerFor(handle, runtime.generation);
			if (!lease || lease.fencingToken !== context.fencingToken) {
				throw new RpcError("delete", "session_read_only");
			}
			if (!runtime.recoverable) {
				throw new RpcError("delete", "unpersisted_session_cannot_be_deleted");
			}
			if (
				(runtime.state !== "idle" && runtime.state !== "crashed" && runtime.state !== "dormant") ||
				(runtime.state === "idle" && !runtime.canEvict)
			) {
				throw new RpcError("delete", "session_busy");
			}
			this.deletionReservations.set(handle, workspaceId);
		});

		let succeeded = false;
		try {
			await runtime!.stop();
			const result = await operation();
			succeeded = true;
			return result;
		} finally {
			await this.withPoolLock(async () => {
				this.deletionReservations.delete(handle);
				if (!succeeded) return;
				this.clearRestart(handle);
				this.runtimes.delete(handle);
				await this.withLeaseActor(() => {
					this.leases.delete(handle);
				});
				for (const [alias, entry] of this.aliases) {
					if (alias === handle || entry.next === handle) this.aliases.delete(alias);
				}
			});
		}
	}

	private async performSessionDeletion<T>(
		workspaceId: string,
		sessionHandle: string,
		operation: () => Promise<T>,
	): Promise<T> {
		this.assertOpen();
		const handle = this.resolveAlias(sessionHandle);
		await this.withPoolLock(async () => {
			this.assertOpen();
			if (this.deletionReservations.has(handle)) throw new RpcError("delete", "session_deleting");
			if (this.workspaceHasPendingIdentity(workspaceId)) {
				throw new RpcError("delete", "workspace_identity_transitioning");
			}
			const runtime = this.runtimes.get(handle);
			if (runtime && runtime.workspaceId !== workspaceId) {
				throw new RpcError("delete", "session_workspace_mismatch");
			}
			if (runtime?.running || runtime?.state === "starting") {
				throw new RpcError("delete", "session_active");
			}
			this.deletionReservations.set(handle, workspaceId);
		});

		let succeeded = false;
		try {
			const result = await operation();
			succeeded = true;
			return result;
		} finally {
			await this.withPoolLock(async () => {
				this.deletionReservations.delete(handle);
				if (!succeeded) return;
				this.clearRestart(handle);
				this.runtimes.delete(handle);
				await this.withLeaseActor(() => {
					this.leases.delete(handle);
				});
				for (const [alias, entry] of this.aliases) {
					if (alias === handle || entry.next === handle) this.aliases.delete(alias);
				}
			});
		}
	}

	stopAll(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = this.finishStopAll();
		return this.closePromise;
	}

	private async finishStopAll(): Promise<void> {
		clearInterval(this.reaper);
		for (const timer of this.restartTimers.values()) clearTimeout(timer);
		this.restartTimers.clear();
		await Promise.allSettled([...this.activationPromises.values()]);
		await Promise.allSettled([...this.deletionOperations]);
		await this.withPoolLock(async () => {});
		await Promise.all([...new Set(this.runtimes.values())].map((runtime) => runtime.stop()));
		await this.withPoolLock(async () => {
			await this.withLeaseActor(() => {
				this.leases.clear();
			});
			this.aliases.clear();
			this.deletionReservations.clear();
			this.workspaceTransitions.clear();
			this.workspaceCreations.clear();
			this.runtimes.clear();
			this.commitHotRuntimeInventoryIfChanged();
		});
	}

	notifyAuthChanged(workspaceId?: string): void {
		this.safeBroadcast({ type: "auth_changed", ...(workspaceId ? { workspaceId } : {}) });
	}

	notifySessionDirectoryChanged(workspaceId: string): void {
		this.safeBroadcast({ type: "session_directory_changed", workspaceId });
	}

	private async ensureRuntime(sessionHandle: string): Promise<SessionRuntimeCore<M>> {
		this.assertOpen();
		const handle = this.resolveAlias(sessionHandle);
		if (this.deletionReservations.has(handle)) throw new RpcError("activate", "session_deleting");
		const existing = this.runtimes.get(handle);
		if (existing) {
			if (existing.state === "crashed" && !existing.recoverable) return existing;
			if (existing.running || existing.state === "starting") {
				await existing.start();
				return existing;
			}
			if (this.workspaceHasPendingIdentity(existing.workspaceId)) {
				throw new RpcError("activate", "workspace_identity_transitioning");
			}
			await this.startRuntimeWithCapacity(existing);
			return existing;
		}
		const activating = this.activationPromises.get(handle);
		if (activating) return activating;

		const promise = (async () => {
			const target = await this.opts.resolveSession(handle);
			this.assertOpen();
			if (!target) throw new RpcError("activate", `unknown_session: ${handle}`);
			const runtime = this.createRuntime(target);
			await this.withPoolLock(async () => {
				this.assertOpen();
				if (this.deletionReservations.has(handle)) throw new RpcError("activate", "session_deleting");
				if (this.workspaceHasPendingIdentity(target.workspaceId)) {
					throw new RpcError("activate", "workspace_identity_transitioning");
				}
				const raced = this.runtimes.get(handle);
				if (raced) return;
				await this.ensureCapacity();
				this.assertOpen();
				this.runtimes.set(handle, runtime);
				void runtime.start().catch(() => {
					// The awaited call below owns the activation error. This eager call only
					// starts work while the capacity reservation is still held.
				});
			});
			const selected = this.runtimes.get(handle) ?? runtime;
			try {
				await this.startRuntimeWithCapacity(selected);
				return selected;
			} catch (error) {
				// Keep recoverable failures tracked so crash retries cannot become
				// orphan processes. Missing/unpersisted targets have no retry path.
				if (!selected.recoverable && this.runtimes.get(handle) === selected) {
					this.runtimes.delete(handle);
					this.clearRestart(selected.sessionHandle);
				}
				throw error;
			}
		})();
		this.activationPromises.set(handle, promise);
		try {
			return await promise;
		} finally {
			this.activationPromises.delete(handle);
		}
	}

	private async acquireRuntime(
		sessionHandle: string,
	): Promise<{ runtime: SessionRuntimeCore<M>; release: () => void }> {
		const runtime = await this.ensureRuntime(sessionHandle);
		let release: (() => void) | undefined;
		await this.withPoolLock(async () => {
			this.assertOpen();
			const handle = this.resolveAlias(sessionHandle);
			if (this.deletionReservations.has(handle)) throw new RpcError("command", "session_deleting");
			if (!runtime.running && runtime.state !== "starting") {
				if (this.workspaceHasPendingIdentity(runtime.workspaceId)) {
					throw new RpcError("command", "workspace_identity_transitioning");
				}
				if (runtime.state === "crashed" && !runtime.recoverable) {
					release = runtime.reserve();
					return;
				}
				await this.ensureCapacity();
				this.assertOpen();
				void runtime.start().catch(() => {
					// The awaited call below owns the activation error.
				});
			}
			release = runtime.reserve();
		});
		try {
			if (!(runtime.state === "crashed" && !runtime.recoverable)) await runtime.start();
			await this.withLeaseActor(() => this.reconcileLeaseGeneration(runtime));
			return { runtime, release: release! };
		} catch (error) {
			release?.();
			throw error;
		}
	}

	private async startRuntimeWithCapacity(runtime: SessionRuntimeCore<M>): Promise<void> {
		let release: (() => void) | undefined;
		await this.withPoolLock(async () => {
			this.assertOpen();
			if (![...this.runtimes.values()].includes(runtime)) {
				throw new RpcError("activate", "session_runtime_not_tracked");
			}
			if (this.deletionReservations.has(runtime.sessionHandle)) {
				throw new RpcError("activate", "session_deleting");
			}
			if (!runtime.running && runtime.state !== "starting") {
				if (this.workspaceHasPendingIdentity(runtime.workspaceId)) {
					throw new RpcError("activate", "workspace_identity_transitioning");
				}
				await this.ensureCapacity();
				this.assertOpen();
				void runtime.start().catch(() => {
					// The awaited call below owns the activation error.
				});
			}
			release = runtime.reserve();
		});
		try {
			await runtime.start();
			await this.withLeaseActor(() => this.reconcileLeaseGeneration(runtime));
		} finally {
			release?.();
		}
	}

	private createRuntime(
		target: ExistingSessionTarget | NewSessionTarget,
		initialGeneration?: number,
	): SessionRuntimeCore<M> {
		return this.runtimeFactory({
			serverEpoch: this.serverEpoch,
			target,
			resolved: this.opts.resolved,
			env: {
				...this.opts.env,
				...this.opts.envForWorkspace?.(target.cwd),
			},
			readyTimeoutMs: this.opts.readyTimeoutMs,
			replayLimit: this.opts.replayLimit,
			replayMaxBytes: this.opts.replayMaxBytes,
			transientBufferMaxBytes: this.opts.transientBufferMaxBytes,
			extensionStateMaxBytes: this.opts.extensionStateMaxBytes,
			extensionStateMaxItems: this.opts.extensionStateMaxItems,
			pendingDialogLimit: this.opts.pendingDialogLimit,
			maxPendingCommands: this.opts.maxPendingCommands,
			projectionLimits: this.opts.projectionLimits,
			initialGeneration,
			commandTimeoutFor: this.opts.commandTimeoutFor,
			emit: (message) => this.safeBroadcast(message),
			onHotSetChanged: () => this.scheduleHotRuntimeInventoryRefresh(),
			onCrash: (runtime) => this.handleCrash(runtime),
			commitIdentityTransition: (runtime, transition) => this.commitIdentityTransition(runtime, transition),
			log: this.opts.log,
		});
	}

	private async commitIdentityTransition(
		runtime: SessionRuntimeCore<M>,
		transition: SessionIdentityTransitionCommit<
			SessionRuntimeProductEvent<M>,
			SessionRuntimeProductExtensionRequest<M>
		>,
	): Promise<void> {
		let leaseTransition: SessionLeaseTransition | undefined;
		try {
			await this.withPoolLock(async () => {
				this.assertOpen();
				const { previousSessionHandle, nextTarget } = transition;
				if (!this.workspaceTransitions.has(runtime.workspaceId)) {
					throw new RpcError("session_transition", "workspace_transition_reservation_lost");
				}
				if (this.runtimes.get(previousSessionHandle) !== runtime) {
					throw new RpcError("session_transition", "parent_runtime_ownership_changed");
				}
				if (
					this.deletionReservations.has(previousSessionHandle) ||
					this.deletionReservations.has(nextTarget.sessionHandle)
				) {
					throw new RpcError("session_transition", "session_deleting");
				}
				const collision = this.runtimes.get(nextTarget.sessionHandle);
				if (collision && collision !== runtime) {
					throw new RpcError("session_transition", "canonical_session_already_active");
				}

				transition.apply();
				leaseTransition = await this.rekeyRuntime(previousSessionHandle, runtime, false);
				const committedRuntime = runtime.snapshot();
				let stagedMessages: SessionSupervisorMessage<
					SessionRuntimeProductEvent<M>,
					SessionRuntimeProductExtensionRequest<M>
				>[];
				try {
					stagedMessages = transition.commitStaged();
				} catch (error) {
					this.safeBroadcast({
						type: "session_rekeyed",
						serverEpoch: this.serverEpoch,
						previousSessionHandle,
						runtime: committedRuntime,
					});
					this.commitHotRuntimeInventoryIfChanged();
					this.safeBroadcast({ type: "runtime_state", runtime: runtime.snapshot() });
					this.safeBroadcast({ type: "session_directory_changed", workspaceId: runtime.workspaceId });
					throw error;
				}
				this.safeBroadcast({
					type: "session_rekeyed",
					serverEpoch: this.serverEpoch,
					previousSessionHandle,
					runtime: runtime.snapshot(),
				});
				this.commitHotRuntimeInventoryIfChanged();
				for (const message of stagedMessages) this.safeBroadcast(message);
				this.safeBroadcast({ type: "session_directory_changed", workspaceId: runtime.workspaceId });
			});
		} finally {
			if (leaseTransition) this.safeBroadcast({ type: "lease_transition", transition: leaseTransition });
		}
	}

	private async reserveWorkspaceTransition(workspaceId: string): Promise<() => Promise<void>> {
		await this.withPoolLock(async () => {
			this.assertOpen();
			if (this.workspaceHasDeletion(workspaceId)) {
				throw new RpcError("session_transition", "workspace_session_deleting");
			}
			if (this.workspaceTransitions.has(workspaceId)) {
				throw new RpcError("session_transition", "workspace_identity_transitioning");
			}
			if ((this.workspaceCreations.get(workspaceId) ?? 0) > 0) {
				throw new RpcError("session_transition", "workspace_creation_in_progress");
			}
			if (
				[...new Set(this.runtimes.values())].some(
					(runtime) => runtime.workspaceId === workspaceId && runtime.state === "starting",
				)
			) {
				throw new RpcError("session_transition", "workspace_activation_in_progress");
			}
			this.workspaceTransitions.add(workspaceId);
		});
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			await this.withPoolLock(async () => {
				this.workspaceTransitions.delete(workspaceId);
			});
		};
	}

	private async reserveWorkspaceCreation(workspaceId: string): Promise<() => Promise<void>> {
		await this.withPoolLock(async () => {
			this.assertOpen();
			if (this.workspaceHasDeletion(workspaceId)) {
				throw new RpcError("new_session", "workspace_session_deleting");
			}
			if (this.workspaceTransitions.has(workspaceId)) {
				throw new RpcError("new_session", "workspace_identity_transitioning");
			}
			this.workspaceCreations.set(workspaceId, (this.workspaceCreations.get(workspaceId) ?? 0) + 1);
		});
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			await this.withPoolLock(async () => {
				const remaining = (this.workspaceCreations.get(workspaceId) ?? 1) - 1;
				if (remaining > 0) this.workspaceCreations.set(workspaceId, remaining);
				else this.workspaceCreations.delete(workspaceId);
			});
		};
	}

	private workspaceHasPendingIdentity(workspaceId: string): boolean {
		return this.workspaceTransitions.has(workspaceId) || (this.workspaceCreations.get(workspaceId) ?? 0) > 0;
	}

	private workspaceHasDeletion(workspaceId: string): boolean {
		return [...this.deletionReservations.values()].some(
			(reservedWorkspace) => reservedWorkspace === workspaceId,
		);
	}

	private leaseStateFor(sessionHandle: string, generation: number): LeaseState {
		const existing = this.leases.get(sessionHandle);
		if (existing && existing.generation === generation) return existing;
		// A generation is an identity fence, not a continuation of the previous
		// process. Never carry an owner or its fence across this boundary: a
		// restarted, forked, or cloned runtime starts free at revision zero.
		const state: LeaseState = {
			generation,
			revision: 0,
			terminal: false,
		};
		this.leases.set(sessionHandle, state);
		return state;
	}

	private reconcileLeaseGeneration(runtime: SessionRuntimeCore<M>): void {
		this.leaseStateFor(runtime.sessionHandle, runtime.generation);
	}

	private leaseOwnerFor(sessionHandle: string, generation?: number): LeaseOwner | undefined {
		const state = this.leases.get(sessionHandle);
		if (!state || state.terminal || (generation !== undefined && state.generation !== generation))
			return undefined;
		return state.owner;
	}

	private hasLease(sessionHandle: string, generation?: number): boolean {
		return this.leaseOwnerFor(sessionHandle, generation) !== undefined;
	}

	private leaseSnapshot(
		sessionHandle: string,
		generation: number,
		state: LeaseState | undefined,
		connectionId: string,
		transition: SessionLeaseSnapshot["transition"] = "baseline",
	): SessionLeaseSnapshot {
		const owner = state?.terminal ? undefined : state?.owner;
		const isController = owner?.connectionId === connectionId;
		return {
			serverEpoch: this.serverEpoch,
			sessionHandle,
			generation,
			leaseRevision: state?.generation === generation ? state.revision : 0,
			controlState: owner ? "held" : "free",
			transition,
			isController,
			...(isController ? { fencingToken: owner.fencingToken } : {}),
		};
	}

	private commitLeaseTransition(
		sessionHandle: string,
		generation: number,
		state: LeaseState,
		transition: SessionLeaseTransition["transition"],
		owner?: LeaseOwner,
	): SessionLeaseTransition {
		if (state.terminal || state.generation !== generation) {
			throw new RpcError(transition, "session_lease_revision_exhausted");
		}
		if (state.revision >= Number.MAX_SAFE_INTEGER) {
			this.leases.set(sessionHandle, {
				generation,
				revision: state.revision,
				terminal: true,
			});
			throw new RpcError(transition, "session_lease_revision_exhausted");
		}
		const next: LeaseState = {
			generation,
			revision: state.revision + 1,
			...(owner ? { owner } : {}),
			terminal: false,
		};
		// Replacing the map entry is the ownership CAS linearization point. No
		// observer can see the old owner after this synchronous actor operation.
		this.leases.set(sessionHandle, next);
		return Object.freeze({
			serverEpoch: this.serverEpoch,
			sessionHandle,
			generation,
			leaseRevision: next.revision,
			controlState: owner ? "held" : "free",
			transition,
			...(owner ? { ownerConnectionId: owner.connectionId, fencingToken: owner.fencingToken } : {}),
		});
	}

	private leaseTransitionForState(
		sessionHandle: string,
		state: LeaseState,
		transition: "rekey",
	): SessionLeaseTransition {
		const owner = state.terminal ? undefined : state.owner;
		return Object.freeze({
			serverEpoch: this.serverEpoch,
			sessionHandle,
			generation: state.generation,
			leaseRevision: state.revision,
			controlState: owner ? "held" : "free",
			transition,
			...(owner ? { ownerConnectionId: owner.connectionId, fencingToken: owner.fencingToken } : {}),
		});
	}

	private async rekeyRuntime(
		previousHandle: string,
		runtime: SessionRuntimeCore<M>,
		keepAlias: boolean,
	): Promise<SessionLeaseTransition> {
		const nextHandle = runtime.sessionHandle;
		const collision = this.runtimes.get(nextHandle);
		if (collision && collision !== runtime) {
			throw new RpcError("session_transition", "canonical_session_already_active");
		}
		this.runtimes.delete(previousHandle);
		this.runtimes.set(nextHandle, runtime);
		if (keepAlias) this.aliases.set(previousHandle, { next: nextHandle, expiresAt: Date.now() + 5 * 60_000 });
		const leaseTransition = await this.withLeaseActor(() => {
			const previous = this.leases.get(previousHandle);
			this.leases.delete(previousHandle);
			this.leases.delete(nextHandle);
			if (!previous || previous.generation !== runtime.generation) {
				// The child/restarted runtime has a distinct generation. Its lease
				// domain begins ownerless, so a prior controller cannot reuse either
				// a connection identity or a fencing token on the new process.
				const next: LeaseState = {
					generation: runtime.generation,
					revision: 0,
					terminal: false,
				};
				this.leases.set(nextHandle, next);
				return this.leaseTransitionForState(nextHandle, next, "rekey");
			}
			this.leases.set(nextHandle, previous);
			if (!previous.owner) return this.leaseTransitionForState(nextHandle, previous, "rekey");
			return this.commitLeaseTransition(nextHandle, runtime.generation, previous, "rekey", previous.owner);
		});
		const crashes = this.crashTimes.get(previousHandle);
		if (crashes) {
			this.crashTimes.delete(previousHandle);
			this.crashTimes.set(nextHandle, crashes);
		}
		return leaseTransition;
	}

	private resolveAlias(sessionHandle: string): string {
		let handle = sessionHandle;
		const seen = new Set<string>();
		while (!seen.has(handle)) {
			seen.add(handle);
			const alias = this.aliases.get(handle);
			if (!alias) break;
			if (alias.expiresAt <= Date.now()) {
				this.aliases.delete(handle);
				break;
			}
			handle = alias.next;
		}
		return handle;
	}

	private assertGeneration(runtime: SessionRuntimeCore<M>, command: string, expected: number): void {
		if (expected !== runtime.generation) {
			throw new RpcError(command, "session_generation_stale");
		}
	}

	private assertLease(runtime: SessionRuntimeCore<M>, command: string, context: SessionCommandContext): void {
		const lease = this.leaseOwnerFor(runtime.sessionHandle, runtime.generation);
		if (
			!lease ||
			lease.connectionId !== context.connectionId ||
			lease.fencingToken !== context.fencingToken
		) {
			throw new RpcError(command, "session_read_only");
		}
	}

	private handleCrash(runtime: SessionRuntimeCore<M>): void {
		if (this.closed) return;
		if (runtime.protocolIncompatible) {
			this.log("warn", `Not restarting protocol-incompatible Session ${runtime.sessionHandle}`);
			return;
		}
		if (!runtime.recoverable) {
			this.log("warn", `Not restarting unpersisted Session ${runtime.sessionHandle}`);
			return;
		}
		const handle = runtime.sessionHandle;
		const now = Date.now();
		const recent = (this.crashTimes.get(handle) ?? []).filter(
			(time) => now - time < this.opts.restartWindowMs,
		);
		recent.push(now);
		this.crashTimes.set(handle, recent);
		if (recent.length > this.opts.maxAutoRestarts) {
			this.log("warn", `Auto-restart budget exhausted for ${handle}`);
			return;
		}
		const delay = this.opts.restartBaseDelayMs * 2 ** (recent.length - 1);
		this.clearRestart(handle);
		const timer = setTimeout(() => {
			this.restartTimers.delete(handle);
			if (this.closed || ![...this.runtimes.values()].includes(runtime)) return;
			void this.startRuntimeWithCapacity(runtime).catch((error) => {
				this.log("warn", `Unable to auto-restart ${handle}: ${String(error)}`);
			});
		}, delay);
		timer.unref?.();
		this.restartTimers.set(handle, timer);
	}

	private clearRestart(sessionHandle: string): void {
		const timer = this.restartTimers.get(sessionHandle);
		if (timer) clearTimeout(timer);
		this.restartTimers.delete(sessionHandle);
	}

	private async ensureCapacity(): Promise<void> {
		for (;;) {
			this.assertOpen();
			const hot = [...new Set(this.runtimes.values())].filter(
				(runtime) => runtime.running || runtime.state === "starting",
			);
			const projectionOwners = [...new Set(this.runtimes.values())].filter(
				(runtime) => runtime.running || runtime.state === "starting" || runtime.retainsProjectionReservation,
			);
			const processCapacityReached = hot.length >= this.opts.maxHotProcesses;
			const projectionCapacityReached =
				projectionOwners.length * this.projectionReservationBytes() + this.projectionReservationBytes() >
				this.opts.maxRetainedProjectionBytes;
			if (!processCapacityReached && !projectionCapacityReached) return;
			const candidate = hot
				.filter((runtime) => this.isEvictable(runtime))
				.sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
			if (!candidate) {
				throw new RpcError(
					"activate",
					projectionCapacityReached && !processCapacityReached
						? "session_projection_capacity"
						: "session_runtime_capacity",
				);
			}
			await candidate.stop();
			this.assertOpen();
		}
	}

	private projectionReservationBytes(): number {
		return Math.max(
			1,
			Math.floor(this.opts.projectionLimits?.maxSnapshotBytes ?? SESSION_SNAPSHOT_MAX_BYTES),
		);
	}

	private async reapIdle(): Promise<void> {
		if (this.closed) return;
		await this.withPoolLock(async () => {
			if (this.closed) return;
			const now = Date.now();
			const transientCutoff = now - this.opts.transientIdleTtlMs;
			const transientCandidates = [...new Set(this.runtimes.values())].filter(
				(runtime) =>
					runtime.lastActivityAt <= transientCutoff &&
					runtime.canAbandon &&
					!this.hasLease(runtime.sessionHandle, runtime.generation) &&
					!this.deletionReservations.has(runtime.sessionHandle) &&
					!this.workspaceHasPendingIdentity(runtime.workspaceId),
			);
			for (const runtime of transientCandidates) {
				const handle = runtime.sessionHandle;
				if (
					this.runtimes.get(handle) !== runtime ||
					this.hasLease(handle, runtime.generation) ||
					this.deletionReservations.has(handle) ||
					this.workspaceHasPendingIdentity(runtime.workspaceId) ||
					!runtime.canAbandon ||
					runtime.lastActivityAt > transientCutoff
				) {
					continue;
				}
				this.deletionReservations.set(handle, runtime.workspaceId);
				try {
					await runtime.stop();
					if (!runtime.sessionFile || sessionPathEntryExists(runtime.sessionFile)) {
						this.safeBroadcast({
							type: "session_directory_changed",
							workspaceId: runtime.workspaceId,
						});
						continue;
					}
					this.clearRestart(handle);
					this.runtimes.delete(handle);
					await this.withLeaseActor(() => {
						this.leases.delete(handle);
					});
					this.crashTimes.delete(handle);
					for (const [alias, entry] of this.aliases) {
						if (alias === handle || entry.next === handle) this.aliases.delete(alias);
					}
					this.safeBroadcast({
						type: "session_directory_changed",
						workspaceId: runtime.workspaceId,
					});
				} finally {
					if (this.deletionReservations.get(handle) === runtime.workspaceId) {
						this.deletionReservations.delete(handle);
					}
				}
			}

			const cutoff = now - this.opts.idleTtlMs;
			const candidates = [...new Set(this.runtimes.values())].filter(
				(runtime) => this.isEvictable(runtime) && runtime.lastActivityAt <= cutoff,
			);
			for (const runtime of candidates) {
				if (this.isEvictable(runtime) && runtime.lastActivityAt <= cutoff) await runtime.stop();
			}
		});
	}

	private isEvictable(runtime: SessionRuntimeCore<M>): boolean {
		return runtime.canEvict && !this.hasLease(runtime.sessionHandle, runtime.generation);
	}

	private matchesHotRuntimeIdentity(
		observation: SessionHotRuntimeObservation,
		expected: SessionRuntimeIdentityDto,
	): boolean {
		const entry = observation.entry;
		return (
			expected.serverEpoch === this.serverEpoch &&
			entry.serverEpoch === expected.serverEpoch &&
			entry.sessionHandle === expected.sessionHandle &&
			entry.workspaceId === expected.workspaceId &&
			entry.generation === expected.generation
		);
	}

	private scheduleHotRuntimeInventoryRefresh(): void {
		if (this.hotInventoryRefreshScheduled) return;
		this.hotInventoryRefreshScheduled = true;
		void this.withPoolLock(async () => {
			this.hotInventoryRefreshScheduled = false;
			// Identity transitions publish their rekey fence synchronously from
			// commitIdentityTransition. An operational update queued before that
			// fence must not publish the old handle after the transition began.
			if ([...new Set(this.runtimes.values())].some((runtime) => runtime.transitioning)) return;
			this.commitHotRuntimeInventoryIfChanged();
		}).catch((error) => {
			this.hotInventoryRefreshScheduled = false;
			this.log("error", `Hot Runtime inventory refresh failed: ${String(error)}`);
		});
	}

	private commitHotRuntimeInventoryIfChanged(): void {
		const entries: HotRuntimeInventoryEntryDto[] = [];
		const seen = new Set<SessionRuntimeCore<M>>();
		for (const [trackedHandle, runtime] of this.runtimes) {
			if (seen.has(runtime)) continue;
			seen.add(runtime);
			if (trackedHandle.startsWith("pending_")) continue;
			const observation = runtime.captureHotRuntimeObservation();
			if (!observation) continue;
			if (observation.entry.sessionHandle === trackedHandle) {
				entries.push({ ...observation.entry });
				continue;
			}
			const previous = this.hotInventoryEntries.find((entry) => entry.sessionHandle === trackedHandle);
			if (previous) entries.push({ ...previous });
		}
		entries.sort((left, right) => {
			if (left.sessionHandle !== right.sessionHandle) {
				return left.sessionHandle < right.sessionHandle ? -1 : 1;
			}
			if (left.workspaceId === right.workspaceId) return 0;
			return left.workspaceId < right.workspaceId ? -1 : 1;
		});
		const signature = JSON.stringify(entries);
		if (signature === this.hotInventorySignature) return;
		if (this.hotInventoryRevision >= Number.MAX_SAFE_INTEGER) {
			throw new RpcError("hot_runtime_inventory", "hot_runtime_inventory_revision_exhausted");
		}
		this.hotInventorySignature = signature;
		this.hotInventoryEntries = entries;
		this.hotInventoryRevision += 1;
		const inventory = this.getHotRuntimeInventory();
		try {
			this.opts.onHotRuntimeInventory?.(inventory);
		} catch (error) {
			this.log("error", `Hot Runtime inventory publish failed: ${String(error)}`);
		}
	}

	private async withPoolLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.poolTail;
		let release: () => void;
		this.poolTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release!();
		}
	}

	/**
	 * The sole linearization domain for Session lease ownership. Pool callers
	 * always enter this actor after the pool lock; actor work never awaits the
	 * pool lock, so the ordering cannot deadlock.
	 */
	private async withLeaseActor<T>(operation: () => T | Promise<T>): Promise<T> {
		const previous = this.leaseTail;
		let release: () => void;
		this.leaseTail = new Promise<void>((resolve) => {
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

	private safeBroadcast(
		message: SessionSupervisorMessage<
			SessionRuntimeProductEvent<M>,
			SessionRuntimeProductExtensionRequest<M>
		>,
	): void {
		try {
			this.opts.broadcast(message);
		} catch (error) {
			this.log("error", `Session broadcast failed: ${String(error)}`);
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new RpcError("supervisor", "session_supervisor_closed");
	}
}

/** Canonical Browser protocol Supervisor API. */
export class SessionSupervisor extends SessionSupervisorCore<"content_ref"> {
	constructor(opts: SessionSupervisorOptions) {
		const { piPayloadServices, ...coreOptions } = opts;
		super(coreOptions, (runtimeOptions) => new SessionRuntime({ ...runtimeOptions, piPayloadServices }));
	}
}

function sessionPathEntryExists(sessionFile: string): boolean {
	try {
		fs.lstatSync(sessionFile);
		return true;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "ENOENT"
		) {
			return false;
		}
		throw new RpcError("abandon", `session_materialization_check_failed: ${String(error)}`);
	}
}

async function attachExportHtmlUrl<TResponse extends { readonly command: string; readonly success: boolean }>(
	command: SessionCommandDto,
	response: TResponse,
	cwd: string,
): Promise<TResponse> {
	if (command.type !== "export_html" || response.success !== true || response.command !== "export_html") {
		return response;
	}
	if (!("data" in response)) {
		throw new RpcError("export_html", "Pi returned an invalid exported HTML path");
	}
	const data = response.data;
	if (typeof data !== "object" || data === null || !("path" in data) || typeof data.path !== "string") {
		throw new RpcError("export_html", "Pi returned an invalid exported HTML path");
	}
	const piPath = data.path;
	if (!piPath) throw new RpcError("export_html", "Pi returned an invalid exported HTML path");

	let exportedPath: string;
	try {
		exportedPath = await fs.promises.realpath(path.resolve(cwd, piPath));
	} catch (error) {
		throw new RpcError("export_html", `exported HTML file is unavailable: ${String(error)}`);
	}
	let stat: fs.Stats;
	try {
		stat = await fs.promises.lstat(exportedPath);
	} catch (error) {
		throw new RpcError("export_html", `exported HTML file is unavailable: ${String(error)}`);
	}
	if (!stat.isFile()) throw new RpcError("export_html", "exported HTML path is not a regular file");

	return Object.assign({}, response, {
		data: Object.assign({}, data, {
			path: exportedPath,
			url: pathToFileURL(exportedPath).href,
		}),
	});
}
