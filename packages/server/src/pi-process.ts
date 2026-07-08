import { type ChildProcess, spawn } from "node:child_process";
import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { attachJsonlLineReader } from "./jsonl.js";
import type { ResolvedPi } from "./resolver.js";
import { RpcError } from "./wire.js";

/**
 * Pi RPC child process wrapper (one process per workspace).
 *
 * Semantics align with the official RpcClient (rpc-client.ts), with
 * Supervisor-oriented additions:
 * - Ready handshake: send get_state{id:"ready-1"} after spawn; the response
 *   means ready (the protocol has no ready frame; the official client blind-
 *   waits 100ms, design spec §2.1 rule 5).
 * - Events / responses / Extension UI frames are routed separately.
 * - Dirty (non-JSON) lines are silently dropped; stderr is collected in a ring.
 * - On exit, reject all pending requests and call onExit (for the Supervisor).
 */

export interface PiProcessOptions {
	cwd: string;
	resolved: ResolvedPi;
	env?: Record<string, string>;
	readyTimeoutMs?: number;
	commandTimeoutMs?: number;
	stderrMaxBytes?: number;
	onEvent?: (event: JsonAgentSessionEvent) => void;
	onExtensionUiRequest?: (request: RpcExtensionUIRequest) => void;
	onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void;
	onReady?: (initialState: RpcSessionState | undefined) => void;
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
	resolve: (r: RpcResponse) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

export class PiProcess {
	readonly cwd: string;
	private child: ChildProcess | null = null;
	private detach: (() => void) | null = null;
	private pending = new Map<string, PendingRequest>();
	private requestCounter = 0;
	private stderrChunks: string[] = [];
	private stderrBytes = 0;
	private stopped = false;
	private ready: Promise<void> | null = null;
	private readyTimer: NodeJS.Timeout | undefined;
	private opts: Required<Pick<PiProcessOptions, "stderrMaxBytes" | "commandTimeoutMs" | "readyTimeoutMs">> &
		PiProcessOptions;

	constructor(opts: PiProcessOptions) {
		this.cwd = opts.cwd;
		this.opts = {
			...opts,
			readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
			commandTimeoutMs: opts.commandTimeoutMs ?? 30_000,
			stderrMaxBytes: opts.stderrMaxBytes ?? 64 * 1024,
		};
	}

	get running(): boolean {
		return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
	}

	get stderrTail(): string {
		return this.stderrChunks.join("");
	}

	/** spawn + ready handshake. Kill and throw on timeout (§2.1 rule 5). */
	start(): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = this.doStart();
		return this.ready;
	}

	private async doStart(): Promise<void> {
		const { command, args } = this.opts.resolved;
		this.stopped = false;

		const child = spawn(command, args, {
			cwd: this.cwd,
			env: { ...process.env, ...this.opts.env },
			stdio: ["pipe", "pipe", "pipe"],
			// Dedicated process group: easier cleanup for abort_bash scenarios.
			detached: process.platform !== "win32",
		});
		this.child = child;

		child.on("error", (error) => {
			const err = new Error(
				`failed to start pi process: ${error.message}${this.stderrTail ? `\n${this.stderrTail}` : ""}`,
			);
			this.rejectAll(err);
			// On spawn failure the exit event may never fire: synthesize one (§2.1 rule 4).
			if (!this.stopped) this.opts.onExit?.({ code: null, signal: null, stderrTail: this.stderrTail });
			this.stopped = true;
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

		this.detach = attachJsonlLineReader(child.stdout!, (line) => this.handleLine(line));

		child.once("exit", (code, signal) => {
			const info = { code, signal, stderrTail: this.stderrTail };
			this.rejectAll(new ProcessExitedError(code, signal, this.stderrTail.slice(-500)));
			this.child = null;
			this.detach?.();
			this.detach = null;
			if (!this.stopped) this.opts.onExit?.(info);
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
			const initialState =
				stateResponse.success === true && stateResponse.command === "get_state"
					? (stateResponse.data as RpcSessionState)
					: undefined;
			this.opts.onReady?.(initialState);
		} catch (error) {
			clearTimeout(this.readyTimer);
			this.ready = null;
			await this.stop();
			throw error;
		}
	}

	/** Send a command and wait for its response frame (auto id, echoed back).
	 * success:false responses resolve normally; callers check via expectData. */
	send(command: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
		const id = command.id ?? this.nextId();
		return this.sendRaw({ ...command, id }, timeoutMs);
	}

	/** Send a no-response protocol frame (extension_ui_response etc.). */
	sendNoResponse(obj: RpcExtensionUIResponse): void {
		this.write(obj);
	}

	private sendRaw(obj: RpcCommand & { id: string }, timeoutMs?: number): Promise<RpcResponse> {
		if (!this.running) {
			return Promise.reject(new Error("pi process is not running"));
		}
		const timeout = timeoutMs ?? this.opts.commandTimeoutMs;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(obj.id);
				reject(new Error(`command timed out (${timeout / 1000}s): ${obj.type}`));
			}, timeout);
			this.pending.set(obj.id, { resolve, reject, timer });
			try {
				this.write(obj);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(obj.id);
				reject(error);
			}
		});
	}

	private write(obj: unknown): void {
		const child = this.child;
		if (!child?.stdin?.writable) {
			throw new Error("pi process stdin is not writable");
		}
		child.stdin.write(`${JSON.stringify(obj)}\n`);
	}

	private handleLine(line: string): void {
		let data: unknown;
		try {
			data = JSON.parse(line);
		} catch {
			// Dirty line: tolerated and dropped (rpc-client.ts:305-311).
			return;
		}
		if (typeof data !== "object" || data === null) return;
		const frame = data as Record<string, unknown>;

		if (frame.type === "response") {
			const id = typeof frame.id === "string" ? frame.id : undefined;
			if (id) {
				const pending = this.pending.get(id);
				if (pending) {
					this.pending.delete(id);
					clearTimeout(pending.timer);
					pending.resolve(data as RpcResponse);
					return;
				}
			}
			// Response with no pending request: drop (never treat as an event).
			return;
		}

		if (frame.type === "extension_ui_request") {
			this.opts.onExtensionUiRequest?.(data as RpcExtensionUIRequest);
			return;
		}

		// Anything else with a type is an AgentSessionEvent frame.
		if (typeof frame.type === "string") {
			this.opts.onEvent?.(data as JsonAgentSessionEvent);
		}
	}

	private rejectAll(error: Error): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private nextId(): string {
		this.requestCounter += 1;
		return `web-${this.requestCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	/** Graceful stop: SIGTERM, then SIGKILL after 1s (matches the official client). */
	async stop(): Promise<void> {
		this.stopped = true;
		const child = this.child;
		if (!child) return;
		this.detach?.();
		this.detach = null;

		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						// already gone
					}
					resolve();
				}, 1000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
				try {
					child.kill("SIGTERM");
				} catch {
					// already gone
				}
			});
			await exited;
		}
		this.child = null;
		this.rejectAll(new RpcError("stop", "pi process stopped"));
		this.ready = null;
	}
}
