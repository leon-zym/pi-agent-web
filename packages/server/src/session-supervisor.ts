import { randomUUID } from "node:crypto";
import type { RpcCommand, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { RpcError } from "@pi-agent-web/protocol";
import type { ResolvedPi } from "./resolver.js";
import { canonicalizePathAllowMissing } from "./session-layout-resolver.js";
import { type SessionIdentityTransitionCommit, SessionRuntime } from "./session-runtime.js";
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
	type SessionRuntimeSnapshot,
	type SessionSupervisorMessage,
} from "./session-runtime-types.js";

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

export interface SessionSupervisorOptions {
	resolved: ResolvedPi;
	env?: Record<string, string>;
	envForWorkspace?: (cwd: string) => Record<string, string>;
	resolveSession: (sessionHandle: string) => Promise<ExistingSessionTarget | undefined>;
	broadcast: (message: SessionSupervisorMessage) => void;
	log?: (level: "info" | "warn" | "error", message: string) => void;
	readyTimeoutMs?: number;
	replayLimit?: number;
	replayMaxBytes?: number;
	transientBufferMaxBytes?: number;
	extensionStateMaxBytes?: number;
	extensionStateMaxItems?: number;
	pendingDialogLimit?: number;
	commandTimeoutFor?: (commandType: string) => number;
	maxHotRuntimes?: number;
	idleTtlMs?: number;
	restartWindowMs?: number;
	maxAutoRestarts?: number;
	restartBaseDelayMs?: number;
}

interface Lease {
	connectionId: string;
	fencingToken: string;
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
export class SessionSupervisor {
	private readonly opts: Required<
		Pick<
			SessionSupervisorOptions,
			| "readyTimeoutMs"
			| "replayLimit"
			| "maxHotRuntimes"
			| "idleTtlMs"
			| "restartWindowMs"
			| "maxAutoRestarts"
			| "restartBaseDelayMs"
		>
	> &
		SessionSupervisorOptions;
	private runtimes = new Map<string, SessionRuntime>();
	private activationPromises = new Map<string, Promise<SessionRuntime>>();
	private leases = new Map<string, Lease>();
	private aliases = new Map<string, Alias>();
	private crashTimes = new Map<string, number[]>();
	private restartTimers = new Map<string, NodeJS.Timeout>();
	private deletionReservations = new Map<string, string>();
	private deletionOperations = new Set<Promise<unknown>>();
	private workspaceTransitions = new Set<string>();
	private workspaceCreations = new Map<string, number>();
	private reaper: NodeJS.Timeout;
	private poolTail: Promise<void> = Promise.resolve();
	private closed = false;
	private closePromise: Promise<void> | null = null;

	constructor(opts: SessionSupervisorOptions) {
		this.opts = {
			...opts,
			readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
			replayLimit: opts.replayLimit ?? 1_024,
			maxHotRuntimes: Math.max(1, opts.maxHotRuntimes ?? 8),
			idleTtlMs: opts.idleTtlMs ?? 10 * 60_000,
			restartWindowMs: opts.restartWindowMs ?? 30_000,
			maxAutoRestarts: opts.maxAutoRestarts ?? 3,
			restartBaseDelayMs: opts.restartBaseDelayMs ?? 500,
		};
		this.reaper = setInterval(
			() =>
				void this.reapIdle().catch((error) => {
					if (!this.closed) this.log("warn", `Idle Session reaper failed: ${String(error)}`);
				}),
			Math.max(1_000, Math.min(30_000, this.opts.idleTtlMs)),
		);
		this.reaper.unref?.();
	}

	listRuntimes(): SessionRuntimeSnapshot[] {
		return [...new Set(this.runtimes.values())].map((runtime) => runtime.snapshot());
	}

	getRuntime(sessionHandle: string): SessionRuntimeSnapshot | undefined {
		return this.runtimes.get(this.resolveAlias(sessionHandle))?.snapshot();
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
			void runtime.start();
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
				this.rekeyRuntime(temporaryHandle, runtime, true);
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
		return runtime.snapshot();
	}

	async subscribe(sessionHandle: string, cursor?: ReplayCursor): Promise<ReplayResult> {
		const runtime = await this.ensureRuntime(sessionHandle);
		return runtime.getReplay(cursor);
	}

	async claim(sessionHandle: string, connectionId: string): Promise<SessionLeaseSnapshot> {
		const runtime = await this.ensureRuntime(sessionHandle);
		const handle = runtime.sessionHandle;
		const existing = this.leases.get(handle);
		if (existing && existing.connectionId !== connectionId) {
			return { sessionHandle: handle, isController: false };
		}
		const lease = existing ?? { connectionId, fencingToken: randomUUID() };
		this.leases.set(handle, lease);
		return { sessionHandle: handle, isController: true, fencingToken: lease.fencingToken };
	}

	release(sessionHandle: string, connectionId: string): boolean {
		const handle = this.resolveAlias(sessionHandle);
		const lease = this.leases.get(handle);
		if (!lease || lease.connectionId !== connectionId) return false;
		this.leases.delete(handle);
		return true;
	}

	releaseConnection(connectionId: string): string[] {
		const released: string[] = [];
		for (const [handle, lease] of this.leases) {
			if (lease.connectionId !== connectionId) continue;
			this.leases.delete(handle);
			released.push(handle);
		}
		return released;
	}

	leaseFor(sessionHandle: string, connectionId: string): SessionLeaseSnapshot {
		const handle = this.resolveAlias(sessionHandle);
		const lease = this.leases.get(handle);
		return lease?.connectionId === connectionId
			? { sessionHandle: handle, isController: true, fencingToken: lease.fencingToken }
			: { sessionHandle: handle, isController: false };
	}

	async sendCommand(
		sessionHandle: string,
		command: RpcCommand,
		context: SessionCommandContext,
	): Promise<SessionCommandResult> {
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
			return {
				sessionHandle: runtime.sessionHandle,
				generation: runtime.generation,
				barrierSeq: runtime.lastSeq,
				response,
			};
		} finally {
			release();
		}
	}

	async sendExtensionUiResponse(
		sessionHandle: string,
		response: RpcExtensionUIResponse,
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

	async restart(sessionHandle: string): Promise<SessionRuntimeSnapshot> {
		this.assertOpen();
		const handle = this.resolveAlias(sessionHandle);
		const existing = this.runtimes.get(handle);
		if (!existing) return this.activate(handle);

		let release: (() => void) | undefined;
		await this.withPoolLock(async () => {
			this.assertOpen();
			if (this.deletionReservations.has(handle)) throw new RpcError("restart", "session_deleting");
			if (!existing.recoverable) {
				throw new RpcError("restart", "unpersisted_session_cannot_be_recovered");
			}
			if (existing.state !== "crashed" && existing.state !== "dormant") {
				throw new RpcError("restart", "session_restart_requires_inactive_runtime");
			}
			this.clearRestart(existing.sessionHandle);
			this.crashTimes.delete(existing.sessionHandle);
			await this.ensureCapacity();
			this.assertOpen();
			release = existing.reserve();
			void existing.start();
		});
		try {
			await existing.start();
			return existing.snapshot();
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

	private async performControlledSessionDeletion<T>(
		workspaceId: string,
		sessionHandle: string,
		context: SessionManagementContext,
		operation: () => Promise<T>,
	): Promise<T> {
		this.assertOpen();
		const handle = this.resolveAlias(sessionHandle);
		let runtime: SessionRuntime | undefined;
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
			const lease = this.leases.get(handle);
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
				this.leases.delete(handle);
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
				this.leases.delete(handle);
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
		this.leases.clear();
		this.aliases.clear();
		this.deletionReservations.clear();
		this.workspaceTransitions.clear();
		this.workspaceCreations.clear();
		this.runtimes.clear();
	}

	notifyAuthChanged(workspaceId?: string): void {
		this.safeBroadcast({ type: "auth_changed", ...(workspaceId ? { workspaceId } : {}) });
	}

	notifySessionDirectoryChanged(workspaceId: string): void {
		this.safeBroadcast({ type: "session_directory_changed", workspaceId });
	}

	private async ensureRuntime(sessionHandle: string): Promise<SessionRuntime> {
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
				void runtime.start();
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
	): Promise<{ runtime: SessionRuntime; release: () => void }> {
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
				void runtime.start();
			}
			release = runtime.reserve();
		});
		try {
			if (!(runtime.state === "crashed" && !runtime.recoverable)) await runtime.start();
			return { runtime, release: release! };
		} catch (error) {
			release?.();
			throw error;
		}
	}

	private async startRuntimeWithCapacity(runtime: SessionRuntime): Promise<void> {
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
				void runtime.start();
			}
			release = runtime.reserve();
		});
		try {
			await runtime.start();
		} finally {
			release?.();
		}
	}

	private createRuntime(target: ExistingSessionTarget | NewSessionTarget): SessionRuntime {
		return new SessionRuntime({
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
			commandTimeoutFor: this.opts.commandTimeoutFor,
			emit: (message) => this.safeBroadcast(message),
			onCrash: (runtime) => this.handleCrash(runtime),
			commitIdentityTransition: (runtime, transition) => this.commitIdentityTransition(runtime, transition),
			log: this.opts.log,
		});
	}

	private async commitIdentityTransition(
		runtime: SessionRuntime,
		transition: SessionIdentityTransitionCommit,
	): Promise<void> {
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
			this.rekeyRuntime(previousSessionHandle, runtime, false);
			this.safeBroadcast({
				type: "session_rekeyed",
				previousSessionHandle,
				runtime: runtime.snapshot(),
			});
			this.safeBroadcast({ type: "session_directory_changed", workspaceId: runtime.workspaceId });
		});
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

	private rekeyRuntime(previousHandle: string, runtime: SessionRuntime, keepAlias: boolean): void {
		const nextHandle = runtime.sessionHandle;
		const collision = this.runtimes.get(nextHandle);
		if (collision && collision !== runtime) {
			throw new RpcError("session_transition", "canonical_session_already_active");
		}
		this.runtimes.delete(previousHandle);
		this.runtimes.set(nextHandle, runtime);
		if (keepAlias) this.aliases.set(previousHandle, { next: nextHandle, expiresAt: Date.now() + 5 * 60_000 });
		const lease = this.leases.get(previousHandle);
		if (lease) {
			this.leases.delete(previousHandle);
			this.leases.set(nextHandle, lease);
		}
		const crashes = this.crashTimes.get(previousHandle);
		if (crashes) {
			this.crashTimes.delete(previousHandle);
			this.crashTimes.set(nextHandle, crashes);
		}
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

	private assertGeneration(runtime: SessionRuntime, command: string, expected: number): void {
		if (expected !== runtime.generation) {
			throw new RpcError(command, "session_generation_stale");
		}
	}

	private assertLease(runtime: SessionRuntime, command: string, context: SessionCommandContext): void {
		const lease = this.leases.get(runtime.sessionHandle);
		if (
			!lease ||
			lease.connectionId !== context.connectionId ||
			lease.fencingToken !== context.fencingToken
		) {
			throw new RpcError(command, "session_read_only");
		}
	}

	private handleCrash(runtime: SessionRuntime): void {
		if (this.closed) return;
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
			if (hot.length < this.opts.maxHotRuntimes) return;
			const candidate = hot
				.filter((runtime) => runtime.canEvict)
				.sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
			if (!candidate) throw new RpcError("activate", "session_runtime_capacity");
			await candidate.stop();
			this.assertOpen();
		}
	}

	private async reapIdle(): Promise<void> {
		if (this.closed) return;
		await this.withPoolLock(async () => {
			if (this.closed) return;
			const cutoff = Date.now() - this.opts.idleTtlMs;
			const candidates = [...new Set(this.runtimes.values())].filter(
				(runtime) => runtime.canEvict && runtime.lastActivityAt <= cutoff,
			);
			for (const runtime of candidates) {
				if (runtime.canEvict && runtime.lastActivityAt <= cutoff) await runtime.stop();
			}
		});
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

	private log(level: "info" | "warn" | "error", message: string): void {
		this.opts.log?.(level, message);
	}

	private safeBroadcast(message: SessionSupervisorMessage): void {
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
