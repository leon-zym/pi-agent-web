import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import type {
	ExtensionUiRequestDto,
	ExtensionUiResponseDto,
	ProductSessionEventDto,
	SessionCommandDto,
	SessionCommandResponseDto,
	SessionCommandTypeDto,
	SessionStateDto,
} from "@pi-agent-web/protocol";
import { RpcError } from "@pi-agent-web/protocol";
import {
	attachJsonlLineReader,
	JsonlLineTooLongError,
	MAX_JSONL_LINE_BYTES,
	MAX_JSONL_SNAPSHOT_LINE_BYTES,
} from "./jsonl.js";
import { legacyRpcV1Adapter } from "./legacy-rpc-v1.js";
import {
	type PiHostAdapter,
	PiProtocolIncompatibleError,
	type PiRuntimeDiagnostic,
} from "./pi-host-adapter.js";
import type { ResolvedPi } from "./resolver.js";

/**
 * Pi RPC child process wrapper. The supervisor decides the ownership model;
 * session runtimes append their verified `--session` / `--session-id` target
 * arguments without mutating the shared resolver result.
 *
 * Semantics align with the official RpcClient (rpc-client.ts), with
 * Supervisor-oriented additions:
 * - Ready handshake: send get_state{id:"ready-1"} after spawn; the response
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
	onEvent?: (event: ProductSessionEventDto) => void;
	onExtensionUiRequest?: (request: ExtensionUiRequestDto) => void;
	onExit?: (info: PiProcessExitInfo) => void;
	onReady?: (initialState: SessionStateDto) => void;
}

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

interface PendingRequest {
	command: SessionCommandTypeDto;
	resolve: (r: SessionCommandResponseDto) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

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

export class PiProcess {
	readonly cwd: string;
	private child: ChildProcess | null = null;
	private spawnIdentity: SpawnIdentity | null = null;
	private detach: (() => void) | null = null;
	private pending = new Map<string, PendingRequest>();
	private requestCounter = 0;
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
		this.adapter = opts.adapter ?? legacyRpcV1Adapter;
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
			maxLineBytes: () => this.currentJsonlLineBudget(),
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
	send(command: SessionCommandDto, timeoutMs?: number): Promise<SessionCommandResponseDto> {
		const id = command.id ?? this.nextId();
		return this.sendRaw({ ...command, id }, timeoutMs);
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
	): Promise<SessionCommandResponseDto> {
		if (!this.leaderRunning || this.spawnIdentity?.unexpectedFinalization) {
			return Promise.reject(new Error("pi process is not running"));
		}
		if (this.pending.has(obj.id)) {
			return Promise.reject(new RpcError(obj.type, `duplicate pending command id: ${obj.id}`));
		}
		const timeout = timeoutMs ?? this.opts.commandTimeoutMs;
		return new Promise<SessionCommandResponseDto>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(obj.id);
				reject(new Error(`command timed out (${timeout / 1000}s): ${obj.type}`));
			}, timeout);
			this.pending.set(obj.id, { command: obj.type, resolve, reject, timer });
			void this.write(this.adapter.encodeCommand(obj)).catch((error) => {
				clearTimeout(timer);
				this.pending.delete(obj.id);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
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

	private decodeWithDeadline<T>(identity: SpawnIdentity, decode: () => PromiseLike<T> | T): Promise<T> {
		const { signal } = identity.decodeAbortController;
		const operation = Promise.resolve().then(decode);
		return new Promise<T>((resolve, reject) => {
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
				identity.decodeAbortController.abort(
					new Error(`Pi adapter decode timed out after ${String(this.opts.decodeTimeoutMs)}ms`),
				);
			}, this.opts.decodeTimeoutMs);
			timer.unref?.();
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			operation.then(
				(value) => {
					if (settle()) resolve(value);
				},
				(error: unknown) => {
					if (settle()) reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
		});
	}

	private async handleLine(line: string, identity: SpawnIdentity | null = this.spawnIdentity): Promise<void> {
		const exceedsOrdinaryLimit = Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES;
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
		if (exceedsOrdinaryLimit && !this.isPendingSnapshotResponse(data)) {
			throw new PiProtocolIncompatibleError({
				code: "protocol_incompatible",
				adapterId: this.adapter.id,
				frameKind: "frame",
				reason: "oversized_frame",
			});
		}
		if (!identity) throw new Error("cannot decode a Pi frame without an active spawn");
		if (typeof data !== "object" || data === null) {
			await this.decodeWithDeadline(identity, () =>
				this.adapter.decodeUnsolicited(data, { signal: identity.decodeAbortController.signal }),
			);
			return;
		}
		const frame = data as Record<string, unknown>;

		if (frame.type === "response") {
			const id = typeof frame.id === "string" ? frame.id : undefined;
			if (id) {
				const pending = this.pending.get(id);
				if (pending) {
					const response = await this.decodeWithDeadline(identity, () =>
						this.adapter.decodeResponse(frame, pending.command, {
							signal: identity.decodeAbortController.signal,
						}),
					);
					if (!this.ownsSpawn(identity) || this.pending.get(id) !== pending) return;
					this.pending.delete(id);
					clearTimeout(pending.timer);
					pending.resolve(response);
					return;
				}
			}
			// Late or unknown-id responses are ignorable only after their complete
			// command-specific shape has been validated by the adapter.
			await this.decodeWithDeadline(identity, () =>
				this.adapter.decodeOrphanedResponse(frame, { signal: identity.decodeAbortController.signal }),
			);
			return;
		}

		const decoded = await this.decodeWithDeadline(identity, () =>
			this.adapter.decodeUnsolicited(frame, { signal: identity.decodeAbortController.signal }),
		);
		if (!this.ownsSpawn(identity)) return;
		if (decoded.kind === "event") this.opts.onEvent?.(decoded.event);
		if (decoded.kind === "extension_ui_request") this.opts.onExtensionUiRequest?.(decoded.request);
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

	private rejectAll(error: Error): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private currentJsonlLineBudget(): number {
		for (const pending of this.pending.values()) {
			if (pending.command === "get_messages") return this.opts.snapshotLineMaxBytes;
		}
		return MAX_JSONL_LINE_BYTES;
	}

	private nextId(): string {
		this.requestCounter += 1;
		return `web-${this.requestCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
