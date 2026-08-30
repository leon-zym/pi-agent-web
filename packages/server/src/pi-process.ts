import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	type ExtensionUiRequestDto,
	type ExtensionUiResponseDto,
	type PiExtensionUiRequestDto,
	type PiProductSessionEventDto,
	type PiSessionCommandResponseDto,
	type ProductSessionEventDto,
	RpcError,
	type SessionCommandDto,
	type SessionCommandResponseDto,
	type SessionCommandTypeDto,
	type SessionStateDto,
} from "@pi-agent-web/protocol";
import type { EpochStoredContentRef } from "./epoch-content-store.js";
import {
	attachJsonlLineReader,
	JsonlLineTooLongError,
	MAX_JSONL_CONTENT_REF_LINE_BYTES,
	MAX_JSONL_LINE_BYTES,
	MAX_JSONL_SNAPSHOT_LINE_BYTES,
} from "./jsonl.js";
import {
	type PiHostAdapter,
	type PiHostDecodeOutcome,
	type PiHostDecodeResult,
	type PiHostPayloadExternalizer,
	type PiHostRawUnsolicitedFrame,
	PiHostResponseExternalizationError,
	type PiHostUnsolicitedFrame,
	PiProtocolIncompatibleError,
	type PiRuntimeDiagnostic,
} from "./pi-host-adapter.js";
import type { PiPayloadLeaseTransfer } from "./pi-payload-externalizer.js";
import { piRpcAdapter } from "./pi-rpc-adapter.js";
import { isPiRpcContentRawExtensionUiRequest } from "./pi-rpc-content-wire.js";
import type { ResolvedPi } from "./resolver.js";

/**
 * Pi RPC child process wrapper. The supervisor decides the ownership model;
 * session runtimes append their verified `--session` / `--session-id` target
 * arguments without mutating the shared resolver result.
 *
 * Semantics align with the official RpcClient (rpc-client.ts), with
 * Supervisor-oriented additions:
 * - Ready handshake: send get_state after spawn; the response
 *   means ready (the protocol has no ready frame; the official client blind-
 *   waits 100ms).
 * - Events / responses / Extension UI frames are routed separately.
 * - Ordinary dirty (non-JSON) lines are dropped; oversized lines fail closed.
 *   stderr is collected in a ring.
 * - On exit, reject all pending requests and call onExit (for the Supervisor).
 */

export interface PiProcessOptions {
	cwd: string;
	resolved: ResolvedPi;
	/** Arguments appended after the resolver's RPC entry arguments. */
	args?: string[];
	env?: Record<string, string>;
	readyTimeoutMs?: number;
	commandTimeoutMs?: number;
	/** Maximum duration of one adapter normalization/externalization operation. */
	decodeTimeoutMs?: number;
	stderrMaxBytes?: number;
	/** Bounded allowance for Pi's single-line get_messages response. */
	snapshotLineMaxBytes?: number;
	adapter?: PiHostAdapter;
	/** Generation-owned Browser content externalizer. */
	payloadExternalizer?: PiHostPayloadExternalizer;
	/** Synchronize exact event ownership before making the decoded frame observable. */
	onDecodedEvent?: PiDecodedDeliveryConsumer<ProductSessionEventDto, EpochStoredContentRef>;
	onDecodedExtensionUiRequest?: PiDecodedDeliveryConsumer<ExtensionUiRequestDto, EpochStoredContentRef>;
	onEvent?: (event: PiProductSessionEventDto) => void;
	onExtensionUiRequest?: (request: PiExtensionUiRequestDto) => void;
	onExit?: (info: PiProcessExitInfo) => void;
	onReady?: (initialState: SessionStateDto) => void;
}

export interface PiDecodedDelivery<T, TRef extends EpochStoredContentRef = EpochStoredContentRef> {
	readonly value: T;
	/**
	 * Prepare a one-shot synchronous handoff after PiProcess rechecks spawn/pending identity.
	 * Before returning literal true, commit must place the transfer in a bounded cleanup ledger
	 * or atomically adopt it into the exact generation owner. PiProcess never releases after true.
	 */
	prepare(commit: (transfer: PiPayloadLeaseTransfer<TRef> | null) => true): PiDecodedDeliveryPlan;
}

export interface PiDecodedDeliveryPlan {
	readonly kind: "pi_decoded_delivery_plan";
}

export type PiDecodedDeliveryConsumer<T, TRef extends EpochStoredContentRef = EpochStoredContentRef> = (
	delivery: PiDecodedDelivery<T, TRef>,
) => PiDecodedDeliveryPlan;

export interface PiProcessExitInfo {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderrTail: string;
	reason?: "protocol_incompatible";
	diagnostic?: PiRuntimeDiagnostic;
}

export class ProcessExitedError extends Error {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	constructor(code: number | null, signal: NodeJS.Signals | null, detail?: string) {
		super(
			"pi process exited" +
				(code !== null ? ` (exit code ${String(code)})` : signal ? ` (signal ${signal})` : "") +
				(detail ? `: ${detail}` : ""),
		);
		this.name = "ProcessExitedError";
		this.code = code;
		this.signal = signal;
	}
}

class PiDecodeDeadlineError extends Error {
	constructor(timeoutMs: number) {
		super(`Pi adapter decode timed out after ${String(timeoutMs)}ms`);
		this.name = "PiDecodeDeadlineError";
	}
}

interface PendingRequestBase {
	command: SessionCommandTypeDto;
	publicId: string;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

interface RawPendingRequest extends PendingRequestBase {
	kind: "raw";
	resolve: (r: PiSessionCommandResponseDto) => void;
}

interface DecodedPendingRequest extends PendingRequestBase {
	kind: "decoded";
	consumeDecoded: PiDecodedDeliveryConsumer<SessionCommandResponseDto, EpochStoredContentRef>;
	resolve: (r: SessionCommandResponseDto) => void;
}

type PendingRequest = RawPendingRequest | DecodedPendingRequest;

interface SpawnIdentity {
	child: ChildProcess;
	leaderPid: number | null;
	processGroupId: number | null;
	leaderExitObserved: boolean;
	unexpectedFinalization: Promise<void> | null;
	decodeAbortController: AbortController;
	activeLine: Promise<void> | null;
}

const UNEXPECTED_GROUP_TERM_GRACE_MS = 250;
const UNEXPECTED_GROUP_KILL_GRACE_MS = 100;

type UnknownFrame = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownFrame {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContentHistoryCommand(command: unknown): command is "get_messages" | "get_entries" | "get_tree" {
	return command === "get_messages" || command === "get_entries" || command === "get_tree";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	try {
		return (
			typeof value === "object" &&
			value !== null &&
			"then" in value &&
			typeof (value as { then?: unknown }).then === "function"
		);
	} catch {
		return false;
	}
}

class PreparedDecodedDelivery<T, TRef extends EpochStoredContentRef = EpochStoredContentRef>
	implements PiDecodedDelivery<T, TRef>, PiDecodedDeliveryPlan
{
	readonly kind = "pi_decoded_delivery_plan" as const;
	readonly value: T;
	private state: "pending" | "prepared" | "committing" | "committed" | "failed" = "pending";
	private commitPrepared: ((transfer: PiPayloadLeaseTransfer<TRef> | null) => true) | null = null;

	constructor(value: T) {
		this.value = value;
	}

	prepare(commit: (transfer: PiPayloadLeaseTransfer<TRef> | null) => true): PiDecodedDeliveryPlan {
		if (this.state !== "pending" || typeof commit !== "function") {
			throw new Error("Pi decoded delivery is already prepared");
		}
		this.commitPrepared = commit;
		this.state = "prepared";
		return this;
	}

	isExactPlan(plan: unknown): boolean {
		return plan === this && this.state === "prepared";
	}

	commit(transfer: PiPayloadLeaseTransfer<TRef> | null): void {
		if (this.state !== "prepared" || !this.commitPrepared) {
			throw new Error("Pi decoded delivery plan is not prepared");
		}
		this.state = "committing";
		try {
			const result: unknown = this.commitPrepared(transfer);
			if (isPromiseLike(result)) {
				void Promise.resolve(result).catch(() => {
					// Delivery commits are synchronous. Observe a forged thenable rejection.
				});
				throw new Error("Pi decoded delivery plan commit must return synchronous literal true");
			}
			if (result !== true) {
				throw new Error("Pi decoded delivery plan did not return literal true");
			}
			this.state = "committed";
		} catch (error) {
			this.state = "failed";
			throw error;
		}
	}
}

export class PiProcess {
	readonly cwd: string;
	private child: ChildProcess | null = null;
	private spawnIdentity: SpawnIdentity | null = null;
	private detach: (() => void) | null = null;
	private pending = new Map<string, PendingRequest>();
	private pendingPublicIds = new Map<string, string>();
	private publicRequestCounter = 0n;
	private wireRequestCounter = 0n;
	private stderrChunks: string[] = [];
	private stderrBytes = 0;
	private stopped = false;
	private ready: Promise<void> | null = null;
	private readyTimer: NodeJS.Timeout | undefined;
	private writeTail: Promise<void> = Promise.resolve();
	private readonly adapter: PiHostAdapter;
	private opts: Required<
		Pick<
			PiProcessOptions,
			"stderrMaxBytes" | "commandTimeoutMs" | "readyTimeoutMs" | "snapshotLineMaxBytes" | "decodeTimeoutMs"
		>
	> &
		PiProcessOptions;

	constructor(opts: PiProcessOptions) {
		this.cwd = opts.cwd;
		this.adapter = opts.adapter ?? piRpcAdapter;
		this.opts = {
			...opts,
			readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
			commandTimeoutMs: opts.commandTimeoutMs ?? 30_000,
			decodeTimeoutMs: Math.max(1, opts.decodeTimeoutMs ?? 30_000),
			stderrMaxBytes: opts.stderrMaxBytes ?? 64 * 1024,
			snapshotLineMaxBytes: Math.max(0, opts.snapshotLineMaxBytes ?? MAX_JSONL_SNAPSHOT_LINE_BYTES),
		};
	}

	/** Leader is usable, or its unexpected-exit cleanup still owns the lifecycle. */
	get running(): boolean {
		return (
			this.leaderRunning || (this.spawnIdentity?.unexpectedFinalization != null && this.stopped === false)
		);
	}

	private get leaderRunning(): boolean {
		return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
	}

	get stderrTail(): string {
		return this.stderrChunks.join("");
	}

	/** spawn + ready handshake. Kill and throw on timeout. */
	start(): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = this.doStart();
		return this.ready;
	}

	private async doStart(): Promise<void> {
		const { command, args } = this.opts.resolved;
		this.stopped = false;

		const child = spawn(command, [...args, ...(this.opts.args ?? [])], {
			cwd: this.cwd,
			env: { ...process.env, ...this.opts.env },
			stdio: ["pipe", "pipe", "pipe"],
			// Dedicated process group: easier cleanup for abort_bash scenarios.
			detached: process.platform !== "win32",
		});
		this.child = child;
		const leaderPid = child.pid ?? null;
		const identity: SpawnIdentity = {
			child,
			leaderPid,
			processGroupId: process.platform !== "win32" ? leaderPid : null,
			leaderExitObserved: false,
			unexpectedFinalization: null,
			decodeAbortController: new AbortController(),
			activeLine: null,
		};
		this.spawnIdentity = identity;

		child.on("error", (error) => {
			const err = new Error(
				`failed to start pi process: ${error.message}${this.stderrTail ? `\n${this.stderrTail}` : ""}`,
			);
			// On spawn failure the exit event may never fire: synthesize one.
			if (!this.stopped) {
				this.beginUnexpectedFinalization(identity, err, {
					code: null,
					signal: null,
					stderrTail: this.stderrTail,
				});
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			this.stderrChunks.push(text);
			this.stderrBytes += text.length;
			while (this.stderrBytes > this.opts.stderrMaxBytes && this.stderrChunks.length > 0) {
				const dropped = this.stderrChunks.shift() ?? "";
				this.stderrBytes -= dropped.length;
			}
		});

		this.detach = attachJsonlLineReader(child.stdout!, (line) => this.consumeLine(line, identity), {
			maxLineBytes: () => this.jsonlLineBudget(),
			onError: (error) => this.handleProtocolFailure(identity, this.normalizeFramingError(error)),
		});

		child.once("exit", (code, signal) => {
			identity.leaderExitObserved = true;
			const info = { code, signal, stderrTail: this.stderrTail };
			const error = new ProcessExitedError(code, signal, this.stderrTail.slice(-500));
			if (this.stopped) {
				this.rejectAll(error);
				this.clearSpawn(identity);
				return;
			}
			this.arbitrateUnexpectedExit(identity, error, info);
		});

		// Ready handshake: no ready frame in the protocol, probe with get_state.
		const readyTimeout = new Promise<never>((_, reject) => {
			const timer = setTimeout(() => {
				reject(
					new Error(
						"pi process ready timeout (" +
							this.opts.readyTimeoutMs / 1000 +
							"s). stderr: " +
							this.stderrTail.slice(-800),
					),
				);
			}, this.opts.readyTimeoutMs);
			timer.unref?.();
			this.readyTimer = timer;
		});

		try {
			const stateResponse = await Promise.race([
				this.sendRaw({ id: "ready-1", type: "get_state" }, this.opts.readyTimeoutMs),
				readyTimeout,
			]);
			clearTimeout(this.readyTimer);
			if (stateResponse.success === false) throw new RpcError("get_state", stateResponse.error);
			if (stateResponse.command !== "get_state") throw new RpcError("get_state", "unexpected ready response");
			this.opts.onReady?.(stateResponse.data);
		} catch (error) {
			clearTimeout(this.readyTimer);
			this.ready = null;
			if (identity.unexpectedFinalization) {
				await identity.unexpectedFinalization.catch(() => {});
			} else {
				await this.stop();
			}
			throw error;
		}
	}

	/** Send a command and wait for its response frame (auto id, echoed back).
	 * success:false responses resolve normally; callers check via expectData. */
	send(command: SessionCommandDto, timeoutMs?: number): Promise<PiSessionCommandResponseDto> {
		const id = command.id ?? this.nextPublicId();
		return this.sendRaw({ ...command, id }, timeoutMs);
	}

	/** Plan exact content ownership before a Browser response can resolve. */
	sendDecoded(
		command: SessionCommandDto,
		consume: PiDecodedDeliveryConsumer<SessionCommandResponseDto, EpochStoredContentRef>,
		timeoutMs?: number,
	): Promise<SessionCommandResponseDto> {
		if (!this.opts.payloadExternalizer) {
			return Promise.reject(new Error("Pi response content externalization is not active"));
		}
		const id = command.id ?? this.nextPublicId();
		return this.sendDecodedRaw({ ...command, id }, consume, timeoutMs);
	}

	/** Send a no-response protocol frame (extension_ui_response etc.). */
	sendNoResponse(obj: ExtensionUiResponseDto): void {
		const identity = this.spawnIdentity;
		void this.write(this.adapter.encodeExtensionUiResponse(obj)).catch((error) => {
			if (identity) {
				this.handleProtocolFailure(identity, error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private sendRaw(
		obj: SessionCommandDto & { id: string },
		timeoutMs?: number,
	): Promise<PiSessionCommandResponseDto> {
		const identity = this.spawnIdentity;
		if (!this.leaderRunning || !identity || identity.unexpectedFinalization) {
			return Promise.reject(new Error("pi process is not running"));
		}
		if (this.pendingPublicIds.has(obj.id)) {
			return Promise.reject(new RpcError(obj.type, `duplicate pending command id: ${obj.id}`));
		}
		const wireId = this.nextWireId();
		const encoded = { ...obj, id: wireId };
		const timeout = timeoutMs ?? this.opts.commandTimeoutMs;
		return new Promise<PiSessionCommandResponseDto>((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = this.pending.get(wireId);
				if (pending) this.deletePending(wireId, pending);
				reject(new Error(`command timed out (${timeout / 1000}s): ${obj.type}`));
			}, timeout);
			const pending: RawPendingRequest = {
				kind: "raw",
				command: obj.type,
				publicId: obj.id,
				resolve,
				reject,
				timer,
			};
			this.pending.set(wireId, pending);
			this.pendingPublicIds.set(obj.id, wireId);
			void this.write(this.adapter.encodeCommand(encoded)).catch((error) => {
				clearTimeout(timer);
				this.deletePending(wireId, pending);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	private sendDecodedRaw(
		obj: SessionCommandDto & { id: string },
		consumeDecoded: PiDecodedDeliveryConsumer<SessionCommandResponseDto, EpochStoredContentRef>,
		timeoutMs?: number,
	): Promise<SessionCommandResponseDto> {
		const identity = this.spawnIdentity;
		if (!this.leaderRunning || !identity || identity.unexpectedFinalization) {
			return Promise.reject(new Error("pi process is not running"));
		}
		if (this.pendingPublicIds.has(obj.id)) {
			return Promise.reject(new RpcError(obj.type, `duplicate pending command id: ${obj.id}`));
		}
		const wireId = this.nextWireId();
		const encoded = { ...obj, id: wireId };
		const timeout = timeoutMs ?? this.opts.commandTimeoutMs;
		return new Promise<SessionCommandResponseDto>((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = this.pending.get(wireId);
				if (pending) this.deletePending(wireId, pending);
				reject(new Error(`command timed out (${timeout / 1000}s): ${obj.type}`));
			}, timeout);
			const pending: DecodedPendingRequest = {
				kind: "decoded",
				command: obj.type,
				publicId: obj.id,
				consumeDecoded,
				resolve,
				reject,
				timer,
			};
			this.pending.set(wireId, pending);
			this.pendingPublicIds.set(obj.id, wireId);
			void this.write(this.adapter.encodeCommand(encoded)).catch((error) => {
				clearTimeout(timer);
				this.deletePending(wireId, pending);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	private deletePending(wireId: string, pending: PendingRequest): void {
		if (this.pending.get(wireId) === pending) this.pending.delete(wireId);
		if (this.pendingPublicIds.get(pending.publicId) === wireId) {
			this.pendingPublicIds.delete(pending.publicId);
		}
	}

	private async write(obj: unknown): Promise<void> {
		const next = this.writeTail.then(() => this.writeNow(obj));
		this.writeTail = next.catch(() => {});
		return next;
	}

	private async writeNow(obj: unknown): Promise<void> {
		const child = this.child;
		if (!child?.stdin?.writable) {
			throw new Error("pi process stdin is not writable");
		}
		if (!child.stdin.write(`${JSON.stringify(obj)}\n`)) await once(child.stdin, "drain");
	}

	private handleProtocolFailure(identity: SpawnIdentity, error: Error): void {
		if (this.stopped || this.spawnIdentity !== identity) return;
		const protocol = error instanceof PiProtocolIncompatibleError ? error.diagnostic : undefined;
		this.beginUnexpectedFinalization(identity, error, {
			code: null,
			signal: null,
			stderrTail: `${this.stderrTail}\n${error.message}`,
			...(protocol ? { reason: "protocol_incompatible" as const, diagnostic: protocol } : {}),
		});
	}

	private normalizeFramingError(error: Error): Error {
		if (!(error instanceof JsonlLineTooLongError)) return error;
		return new PiProtocolIncompatibleError({
			code: "protocol_incompatible",
			adapterId: this.adapter.id,
			frameKind: "frame",
			reason: "oversized_frame",
		});
	}

	private beginUnexpectedFinalization(identity: SpawnIdentity, error: Error, info: PiProcessExitInfo): void {
		if (this.spawnIdentity !== identity || identity.unexpectedFinalization) return;
		identity.decodeAbortController.abort(error);
		const finalization = this.finalizeUnexpectedExit(identity, error, info);
		identity.unexpectedFinalization = finalization;
		// EventEmitter callbacks cannot await cleanup. Keep the promise observed;
		// finalizeUnexpectedExit still delivers onExit from its finally block.
		void finalization.catch(() => {});
	}

	private async finalizeUnexpectedExit(
		identity: SpawnIdentity,
		error: Error,
		info: PiProcessExitInfo,
	): Promise<void> {
		if (this.spawnIdentity === identity) {
			this.rejectAll(error);
			this.detach?.();
			this.detach = null;
		}

		try {
			await this.cleanupUnexpectedProcessGroup(identity);
		} finally {
			const isActiveSpawn = this.spawnIdentity === identity;
			if (isActiveSpawn) {
				this.clearSpawn(identity);
				this.ready = null;
			}
			if (isActiveSpawn && !this.stopped) this.opts.onExit?.(info);
		}
	}

	/**
	 * Clean only the process group tied to this spawn. After observing leader
	 * exit, a live process with the old leader PID proves that the OS has reused
	 * the PGID, so cleanup retires the identity without signalling it. Cleanup is
	 * deliberately short and stops permanently as soon as the group disappears.
	 */
	private async cleanupUnexpectedProcessGroup(identity: SpawnIdentity): Promise<void> {
		const { child, leaderPid, processGroupId } = identity;
		if (process.platform === "win32") {
			if (child.exitCode === null && child.signalCode === null) await this.stopChild(child);
			return;
		}
		if (leaderPid === null || processGroupId === null || leaderPid !== processGroupId) return;
		if (!this.processGroupExists(processGroupId)) return;
		if (identity.leaderExitObserved && this.processExists(leaderPid)) return;

		if (!this.signalSavedProcessGroup(identity, "SIGTERM")) return;
		const stopped = await this.waitForSavedProcessGroupExit(identity, UNEXPECTED_GROUP_TERM_GRACE_MS);
		if (stopped) return;

		if (!this.signalSavedProcessGroup(identity, "SIGKILL")) return;
		await this.waitForSavedProcessGroupExit(identity, UNEXPECTED_GROUP_KILL_GRACE_MS);
	}

	private signalSavedProcessGroup(identity: SpawnIdentity, signal: NodeJS.Signals): boolean {
		const groupId = identity.processGroupId;
		const leaderPid = identity.leaderPid;
		if (groupId === null || leaderPid === null || groupId !== leaderPid) return false;
		if (!this.processGroupExists(groupId)) return false;
		if (identity.leaderExitObserved && this.processExists(leaderPid)) return false;
		try {
			process.kill(-groupId, signal);
			return true;
		} catch {
			// Never fall back to signalling a saved positive PID after unexpected
			// exit: that PID may already identify an unrelated process.
			return false;
		}
	}

	private async waitForSavedProcessGroupExit(identity: SpawnIdentity, timeoutMs: number): Promise<boolean> {
		const groupId = identity.processGroupId;
		const leaderPid = identity.leaderPid;
		if (groupId === null || leaderPid === null) return true;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!this.processGroupExists(groupId)) return true;
			// A new leader with the saved PID means the old group identity is gone.
			if (identity.leaderExitObserved && this.processExists(leaderPid)) return true;
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
		return (
			!this.processGroupExists(groupId) || (identity.leaderExitObserved && this.processExists(leaderPid))
		);
	}

	private processExists(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	private clearSpawn(identity: SpawnIdentity): void {
		if (this.spawnIdentity !== identity) return;
		identity.decodeAbortController.abort(new Error("Pi adapter decode scope closed"));
		this.child = null;
		this.spawnIdentity = null;
		this.detach?.();
		this.detach = null;
	}

	private consumeLine(line: string, identity: SpawnIdentity): Promise<void> {
		let task: Promise<void>;
		task = this.handleLine(line, identity)
			.catch((error: unknown) => {
				const normalized = error instanceof Error ? error : new Error(String(error));
				this.handleProtocolFailure(identity, normalized);
				throw normalized;
			})
			.finally(() => {
				if (identity.activeLine === task) identity.activeLine = null;
			});
		identity.activeLine = task;
		return task;
	}

	private arbitrateUnexpectedExit(
		identity: SpawnIdentity,
		error: ProcessExitedError,
		info: PiProcessExitInfo,
	): void {
		const activeLine = identity.activeLine;
		if (!activeLine) {
			this.beginUnexpectedFinalization(identity, error, info);
			return;
		}
		// An in-flight adapter operation is spawn-bounded. Let its success or
		// protocol failure settle first so a concrete incompatibility is not
		// downgraded to the concurrent generic process exit.
		void activeLine.then(
			() => this.beginUnexpectedFinalization(identity, error, info),
			() => this.beginUnexpectedFinalization(identity, error, info),
		);
	}

	private decodeWithDeadline<T, TRef extends EpochStoredContentRef = EpochStoredContentRef>(
		identity: SpawnIdentity,
		decode: (signal: AbortSignal) => PiHostDecodeResult<T, TRef>,
	): Promise<PiHostDecodeOutcome<T, TRef>> {
		const deadline = new AbortController();
		const signal = AbortSignal.any([identity.decodeAbortController.signal, deadline.signal]);
		const operation = Promise.resolve().then(() => decode(signal));
		return new Promise<PiHostDecodeOutcome<T, TRef>>((resolve, reject) => {
			let settled = false;
			const settle = (): boolean => {
				if (settled) return false;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				return true;
			};
			const onAbort = (): void => {
				const reason = signal.reason;
				if (settle()) reject(reason instanceof Error ? reason : new Error("Pi adapter decode aborted"));
			};
			const timer = setTimeout(() => {
				deadline.abort(new PiDecodeDeadlineError(this.opts.decodeTimeoutMs));
			}, this.opts.decodeTimeoutMs);
			timer.unref?.();
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			operation.then(
				(outcome) => {
					if (settle()) resolve(outcome);
					else this.observeDiscardedOutcome(outcome);
				},
				(error: unknown) => {
					if (settle()) reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
		});
	}

	private observeDiscardedOutcome<TRef extends EpochStoredContentRef>(
		outcome: PiHostDecodeOutcome<unknown, TRef>,
	): void {
		if (!outcome.lease) return;
		void outcome.lease.release().catch(() => {
			// The owning spawn already timed out or stopped. Observe cleanup failure
			// without allowing it to target a replacement spawn.
		});
	}

	private async releaseOutcome<TRef extends EpochStoredContentRef>(
		outcome: PiHostDecodeOutcome<unknown, TRef>,
	): Promise<void> {
		await outcome.lease?.release();
	}

	private async releaseOutcomeAfterFailure<TRef extends EpochStoredContentRef>(
		outcome: PiHostDecodeOutcome<unknown, TRef>,
		error: unknown,
		message: string,
	): Promise<never> {
		try {
			await this.releaseOutcome(outcome);
		} catch (releaseError) {
			throw new AggregateError([error, releaseError], message);
		}
		throw error;
	}

	private async transferOutcome<TRef extends EpochStoredContentRef>(
		outcome: PiHostDecodeOutcome<unknown, TRef>,
	): Promise<PiPayloadLeaseTransfer<TRef> | null> {
		const lease = outcome.lease;
		if (!lease) return null;
		try {
			return lease.transfer();
		} catch (error) {
			try {
				await lease.release();
			} catch (releaseError) {
				throw new AggregateError([error, releaseError], "Pi decoded payload transfer cleanup failed");
			}
			throw error;
		}
	}

	private async releaseTransferAfterFailure<TRef extends EpochStoredContentRef>(
		transfer: PiPayloadLeaseTransfer<TRef> | null,
		error: unknown,
		message: string,
	): Promise<never> {
		try {
			await transfer?.release();
		} catch (releaseError) {
			throw new AggregateError([error, releaseError], message);
		}
		throw error;
	}

	private async consumeDecodedOutcome<T, TRef extends EpochStoredContentRef = EpochStoredContentRef>(
		outcome: PiHostDecodeOutcome<T, TRef>,
		consume: PiDecodedDeliveryConsumer<T, TRef>,
		isCurrent: () => boolean,
	): Promise<boolean> {
		const delivery = new PreparedDecodedDelivery<T, TRef>(outcome.value);
		let plan: unknown;
		try {
			plan = consume(delivery);
		} catch (error) {
			return this.releaseOutcomeAfterFailure(outcome, error, "Pi decoded consumer cleanup failed");
		}
		if (isPromiseLike(plan)) {
			void Promise.resolve(plan).catch(() => {
				// The callback contract is synchronous. Observe a forged thenable rejection.
			});
			return this.releaseOutcomeAfterFailure(
				outcome,
				new Error("Pi decoded delivery consumer must return a synchronous plan"),
				"Pi decoded consumer cleanup failed",
			);
		}
		if (!delivery.isExactPlan(plan)) {
			return this.releaseOutcomeAfterFailure(
				outcome,
				new Error("Pi decoded delivery consumer did not prepare its exact delivery"),
				"Pi decoded consumer cleanup failed",
			);
		}
		if (!isCurrent()) {
			await this.releaseOutcome(outcome);
			return false;
		}
		const transfer = await this.transferOutcome(outcome);
		if (!isCurrent()) {
			await transfer?.release();
			return false;
		}
		try {
			delivery.commit(transfer);
		} catch (error) {
			return this.releaseTransferAfterFailure(transfer, error, "Pi decoded plan cleanup failed");
		}
		return true;
	}

	private async handleDecodedPendingResponse(
		frame: Record<string, unknown>,
		id: string,
		pending: PendingRequest,
		identity: SpawnIdentity,
		externalizer: PiHostPayloadExternalizer,
	): Promise<void> {
		let outcome: PiHostDecodeOutcome<SessionCommandResponseDto & { id: string }, EpochStoredContentRef>;
		try {
			outcome = await this.decodeWithDeadline(identity, (signal) =>
				this.adapter.decodeResponse(frame, pending.command, { signal, externalizer }),
			);
		} catch (error) {
			const responseError =
				error instanceof PiDecodeDeadlineError
					? new PiHostResponseExternalizationError(pending.command, "deadline", { cause: error })
					: error;
			if (
				responseError instanceof PiHostResponseExternalizationError &&
				!identity.decodeAbortController.signal.aborted &&
				this.ownsSpawn(identity) &&
				this.pending.get(id) === pending
			) {
				this.deletePending(id, pending);
				clearTimeout(pending.timer);
				pending.reject(responseError);
				return;
			}
			if (
				responseError instanceof PiHostResponseExternalizationError &&
				(!this.ownsSpawn(identity) || this.pending.get(id) !== pending)
			) {
				return;
			}
			throw responseError;
		}
		if (!this.ownsSpawn(identity) || this.pending.get(id) !== pending) {
			await this.releaseOutcome(outcome);
			return;
		}
		const response = { ...outcome.value, id: pending.publicId };
		if (pending.kind === "decoded") {
			const accepted = await this.consumeDecodedOutcome(
				{ value: response, lease: outcome.lease },
				pending.consumeDecoded,
				() => this.ownsSpawn(identity) && this.pending.get(id) === pending,
			);
			if (!accepted) return;
			if (!this.ownsSpawn(identity) || this.pending.get(id) !== pending) return;
			this.deletePending(id, pending);
			clearTimeout(pending.timer);
			pending.resolve(response);
			return;
		}
		return this.releaseOutcomeAfterFailure(
			outcome,
			new Error("decoded Pi response reached a raw pending request"),
			"Pi decoded response cleanup failed",
		);
	}

	private async deliverUnsolicited(
		outcome: PiHostDecodeOutcome<PiHostUnsolicitedFrame, EpochStoredContentRef>,
		identity: SpawnIdentity,
	): Promise<void> {
		if (!this.ownsSpawn(identity)) {
			await this.releaseOutcome(outcome);
			return;
		}
		if (outcome.value.kind === "ignored") {
			await this.releaseOutcome(outcome);
			return;
		}
		if (outcome.value.kind === "event") {
			const consume = this.opts.onDecodedEvent;
			if (!consume) {
				return this.releaseOutcomeAfterFailure(
					outcome,
					new Error("Pi event delivery requires a decoded consumer"),
					"Pi event cleanup failed",
				);
			}
			await this.consumeDecodedOutcome({ value: outcome.value.event, lease: outcome.lease }, consume, () =>
				this.ownsSpawn(identity),
			);
			return;
		}
		const consume = this.opts.onDecodedExtensionUiRequest;
		if (!consume) {
			return this.releaseOutcomeAfterFailure(
				outcome,
				new Error("Pi Extension UI delivery requires a decoded consumer"),
				"Pi Extension UI cleanup failed",
			);
		}
		await this.consumeDecodedOutcome({ value: outcome.value.request, lease: outcome.lease }, consume, () =>
			this.ownsSpawn(identity),
		);
	}

	private async handleLine(line: string, identity: SpawnIdentity | null = this.spawnIdentity): Promise<void> {
		const lineBytes = Buffer.byteLength(line);
		const exceedsOrdinaryLimit = lineBytes > MAX_JSONL_LINE_BYTES;
		let data: unknown;
		try {
			data = JSON.parse(line);
		} catch {
			if (exceedsOrdinaryLimit) {
				throw new PiProtocolIncompatibleError({
					code: "protocol_incompatible",
					adapterId: this.adapter.id,
					frameKind: "frame",
					reason: "oversized_frame",
				});
			}
			// Dirty line: tolerated and dropped (rpc-client.ts:305-311).
			return;
		}
		if (
			lineBytes > this.jsonlLineBudget() ||
			(exceedsOrdinaryLimit && !this.isAdmittedOversizedFrame(data))
		) {
			throw new PiProtocolIncompatibleError({
				code: "protocol_incompatible",
				adapterId: this.adapter.id,
				frameKind: "frame",
				reason: "oversized_frame",
			});
		}
		if (!identity) throw new Error("cannot decode a Pi frame without an active spawn");
		if (typeof data !== "object" || data === null) {
			const externalizer = this.opts.payloadExternalizer;
			const outcome = externalizer
				? await this.decodeWithDeadline(identity, (signal) =>
						this.adapter.decodeUnsolicited(data, { signal, externalizer }),
					)
				: await this.decodeWithDeadline(identity, () => this.adapter.decodePiUnsolicited(data));
			await this.releaseOutcome(outcome);
			return;
		}
		const frame = data as Record<string, unknown>;

		if (frame.type === "response") {
			const id = typeof frame.id === "string" ? frame.id : undefined;
			if (id) {
				const pending = this.pending.get(id);
				if (pending) {
					if (pending.kind === "decoded") {
						const externalizer = this.opts.payloadExternalizer;
						if (!externalizer) throw new Error("Pi response content externalization is not active");
						await this.handleDecodedPendingResponse(frame, id, pending, identity, externalizer);
						return;
					}
					let outcome: PiHostDecodeOutcome<PiSessionCommandResponseDto & { id: string }>;
					try {
						outcome = await this.decodeWithDeadline(identity, () =>
							this.adapter.decodePiResponse(frame, pending.command),
						);
					} catch (error) {
						const responseError =
							error instanceof PiDecodeDeadlineError
								? new PiHostResponseExternalizationError(pending.command, "deadline", {
										cause: error,
									})
								: error;
						if (
							responseError instanceof PiHostResponseExternalizationError &&
							!identity.decodeAbortController.signal.aborted &&
							this.ownsSpawn(identity) &&
							this.pending.get(id) === pending
						) {
							this.deletePending(id, pending);
							clearTimeout(pending.timer);
							pending.reject(responseError);
							return;
						}
						if (
							responseError instanceof PiHostResponseExternalizationError &&
							(!this.ownsSpawn(identity) || this.pending.get(id) !== pending)
						) {
							return;
						}
						throw responseError;
					}
					if (!this.ownsSpawn(identity) || this.pending.get(id) !== pending) {
						await this.releaseOutcome(outcome);
						return;
					}
					const response: PiSessionCommandResponseDto = { ...outcome.value, id: pending.publicId };
					if (outcome.lease) {
						return this.releaseOutcomeAfterFailure(
							outcome,
							new Error("raw Pi response delivery cannot carry content holds"),
							"Pi raw response cleanup failed",
						);
					}
					if (!this.ownsSpawn(identity) || this.pending.get(id) !== pending) return;
					this.deletePending(id, pending);
					clearTimeout(pending.timer);
					pending.resolve(response);
					return;
				}
			}
			// Late or unknown-id responses are ignorable only after their complete
			// command-specific shape has been validated by the adapter.
			const orphaned = await this.decodeWithDeadline(identity, (signal) =>
				this.adapter.decodeOrphanedResponse(frame, { signal }),
			);
			await this.releaseOutcome(orphaned);
			return;
		}

		const payloadExternalizer = this.opts.payloadExternalizer;
		if (payloadExternalizer) {
			const decodedOutcome = await this.decodeWithDeadline(identity, (signal) =>
				this.adapter.decodeUnsolicited(frame, { signal, externalizer: payloadExternalizer }),
			);
			await this.deliverUnsolicited(decodedOutcome, identity);
			return;
		}
		const outcome: PiHostDecodeOutcome<PiHostRawUnsolicitedFrame> = await this.decodeWithDeadline(
			identity,
			() => this.adapter.decodePiUnsolicited(frame),
		);
		if (!this.ownsSpawn(identity)) {
			await this.releaseOutcome(outcome);
			return;
		}
		if (outcome.value.kind === "ignored") {
			await this.releaseOutcome(outcome);
			return;
		}
		if (outcome.value.kind === "event") {
			if (!this.opts.onEvent) {
				await this.releaseOutcome(outcome);
				return;
			}
			if (outcome.lease) {
				return this.releaseOutcomeAfterFailure(
					outcome,
					new Error("raw Pi event delivery cannot carry content holds"),
					"Pi raw event cleanup failed",
				);
			}
			this.opts.onEvent(outcome.value.event);
			return;
		}
		if (!this.opts.onExtensionUiRequest) {
			await this.releaseOutcome(outcome);
			return;
		}
		if (outcome.lease) {
			return this.releaseOutcomeAfterFailure(
				outcome,
				new Error("raw Pi Extension UI delivery cannot carry content holds"),
				"Pi raw Extension UI cleanup failed",
			);
		}
		this.opts.onExtensionUiRequest(outcome.value.request);
	}

	private ownsSpawn(identity: SpawnIdentity | null): identity is SpawnIdentity {
		return (
			identity !== null &&
			!this.stopped &&
			!identity.leaderExitObserved &&
			this.spawnIdentity === identity &&
			this.child === identity.child &&
			identity.unexpectedFinalization === null
		);
	}

	private isPendingSnapshotResponse(data: unknown): data is UnknownFrame {
		if (!isRecord(data) || data.type !== "response" || data.command !== "get_messages") return false;
		return typeof data.id === "string" && this.pending.get(data.id)?.command === "get_messages";
	}

	private isAdmittedOversizedFrame(data: unknown): data is UnknownFrame {
		if (!this.opts.payloadExternalizer) {
			return this.isPendingSnapshotResponse(data);
		}
		if (!isRecord(data)) return false;
		if (data.type === "extension_ui_request") {
			return isPiRpcContentRawExtensionUiRequest(data);
		}
		if (data.type === "response") {
			if (data.success !== true || typeof data.id !== "string") return false;
			return isContentHistoryCommand(data.command);
		}
		if (data.type === "message_update") {
			return isRecord(data.assistantMessageEvent) && data.assistantMessageEvent.type === "toolcall_end";
		}
		return (
			data.type === "agent_end" ||
			data.type === "turn_end" ||
			data.type === "message_start" ||
			data.type === "message_end" ||
			data.type === "entry_appended" ||
			data.type === "tool_execution_start" ||
			data.type === "tool_execution_update" ||
			data.type === "tool_execution_end"
		);
	}

	private rejectAll(error: Error): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.pendingPublicIds.clear();
	}

	private jsonlLineBudget(): number {
		if (this.opts.payloadExternalizer) return MAX_JSONL_CONTENT_REF_LINE_BYTES;
		for (const pending of this.pending.values()) {
			if (pending.command === "get_messages") return this.opts.snapshotLineMaxBytes;
		}
		return MAX_JSONL_LINE_BYTES;
	}

	private nextPublicId(): string {
		let id: string;
		do {
			this.publicRequestCounter += 1n;
			id = `web-${this.publicRequestCounter.toString(36)}`;
		} while (this.pendingPublicIds.has(id));
		return id;
	}

	private nextWireId(): string {
		this.wireRequestCounter += 1n;
		return `pi-web-wire-${this.wireRequestCounter.toString(36)}`;
	}

	/** Graceful stop: terminate the complete detached process group before cleanup. */
	async stop(): Promise<void> {
		this.stopped = true;
		const identity = this.spawnIdentity;
		identity?.decodeAbortController.abort(new RpcError("stop", "pi process stopped"));
		const child = identity?.child ?? this.child;
		if (!child) return;
		this.detach?.();
		this.detach = null;

		if (identity?.unexpectedFinalization) {
			await identity.unexpectedFinalization.catch(() => {});
		} else if (process.platform !== "win32" && identity?.processGroupId) {
			await this.stopProcessGroup(child, identity.processGroupId);
		} else if (process.platform !== "win32" && child.pid) await this.stopProcessGroup(child, child.pid);
		else if (child.exitCode === null && child.signalCode === null) await this.stopChild(child);
		if (identity) this.clearSpawn(identity);
		else this.child = null;
		this.rejectAll(new RpcError("stop", "pi process stopped"));
		this.ready = null;
	}

	private async stopProcessGroup(child: ChildProcess, groupId: number): Promise<void> {
		this.signalProcessGroup(child, groupId, "SIGTERM");
		const stopped = await this.waitForProcessGroupExit(groupId, 1_000);
		if (!stopped) {
			this.signalProcessGroup(child, groupId, "SIGKILL");
			await this.waitForProcessGroupExit(groupId, 100);
		}
	}

	private signalProcessGroup(child: ChildProcess, groupId: number, signal: NodeJS.Signals): void {
		try {
			process.kill(-groupId, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// The process is already gone.
			}
		}
	}

	private async waitForProcessGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!this.processGroupExists(groupId)) return true;
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
		return !this.processGroupExists(groupId);
	}

	private processGroupExists(groupId: number): boolean {
		try {
			process.kill(-groupId, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	private async stopChild(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// The process is already gone.
				}
				resolve();
			}, 1_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			try {
				child.kill("SIGTERM");
			} catch {
				// The process is already gone.
			}
		});
	}
}
