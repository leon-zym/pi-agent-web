import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { getSessionDirForCwd, isSessionInDir } from "./config";
import { PiProcess } from "./pi-process";
import type { ResolvedPi } from "./resolver";
import type { WsServerMessage } from "./wire";
import { RpcError } from "./wire";

/**
 * Workspace-granularity process supervisor (design spec §2.1).
 *
 * - 1 workspace = 1 "pi --mode rpc" child process (cwd = workspace).
 * - In-workspace session switches reuse the process; cross-workspace switches
 *   must restart the process (validated in sendCommand).
 * - Ready handshake + initial get_commands warm-up (§2.1 rule 5).
 * - Crash detection: supervisor synthesizes process_status "crashed" (the dead
 *   process cannot report itself). Auto-restart up to 3 times within a 30s
 *   window with exponential backoff, then manual restart only (§2.1 rule 4).
 * - Tracks the active sessionId from get_state responses (no ready frame in
 *   the protocol; session boundaries are inferred, Appendix A note).
 * - Keeps pending extension dialogs per (workspaceId, sessionId) so the WS
 *   bridge can cancel them when the last listener disconnects (§2.1 rule 6).
 */

export type ProcessState = "starting" | "running" | "crashed";

export interface SupervisorOptions {
	resolved: ResolvedPi;
	sessionRootDir: string;
	env?: Record<string, string>;
	broadcast: (message: WsServerMessage) => void;
	log?: (level: "info" | "warn" | "error", message: string) => void;
	/** 30s sliding window for auto-restart counting */
	restartWindowMs?: number;
	maxAutoRestarts?: number;
	readyTimeoutMs?: number;
}

interface WorkspaceRuntime {
	workspaceId: string;
	cwd: string;
	proc: PiProcess | null;
	status: ProcessState;
	currentSessionId: string | null;
	lastError?: string;
	crashTimes: number[];
	restartTimer: NodeJS.Timeout | null;
	manuallyStopped: boolean;
	startPromise: Promise<void> | null;
	generation: number;
	pendingDialogs: Map<string, string>;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const SESSION_SWITCH_COMMANDS = new Set(["switch_session", "new_session", "fork", "clone"]);

export class Supervisor {
	private runtimes = new Map<string, WorkspaceRuntime>();
	private opts: Required<Pick<SupervisorOptions, "restartWindowMs" | "maxAutoRestarts" | "readyTimeoutMs">> &
		SupervisorOptions;
	private resolveSessionDir: (cwd: string) => string;

	constructor(opts: SupervisorOptions) {
		this.opts = {
			...opts,
			restartWindowMs: opts.restartWindowMs ?? 30_000,
			maxAutoRestarts: opts.maxAutoRestarts ?? 3,
			readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
		};
		this.resolveSessionDir = (cwd) => getSessionDirForCwd(cwd, this.opts.sessionRootDir);
	}

	private log(level: "info" | "warn" | "error", message: string): void {
		this.opts.log?.(level, message);
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	registerWorkspace(workspaceId: string, cwd: string): void {
		const existing = this.runtimes.get(workspaceId);
		if (existing && existing.cwd === cwd) return;
		// cwd changed (e.g. re-registration): replace runtime state.
		this.runtimes.set(workspaceId, this.createRuntime(workspaceId, cwd));
	}

	private createRuntime(workspaceId: string, cwd: string): WorkspaceRuntime {
		return {
			workspaceId,
			cwd,
			proc: null,
			status: "crashed",
			currentSessionId: null,
			crashTimes: [],
			restartTimer: null,
			manuallyStopped: true,
			startPromise: null,
			generation: 0,
			pendingDialogs: new Map(),
		};
	}

	getStatus(workspaceId: string): { state: ProcessState; error?: string; sessionId: string | null } | null {
		const rt = this.runtimes.get(workspaceId);
		if (!rt) return null;
		return { state: rt.status, error: rt.lastError, sessionId: rt.currentSessionId };
	}

	/**
	 * Ensure a running process for the workspace. Dedupes concurrent calls via
	 * startPromise. Resolves when ready (or throws after the ready timeout).
	 */
	async ensureProcess(workspaceId: string, cwd: string): Promise<void> {
		let rt = this.runtimes.get(workspaceId);
		if (!rt || rt.cwd !== cwd) {
			this.registerWorkspace(workspaceId, cwd);
			rt = this.runtimes.get(workspaceId)!;
		}
		if (rt.proc?.running) return;
		if (rt.startPromise) return rt.startPromise;
		rt.manuallyStopped = false;
		rt.startPromise = this.spawnProcess(rt)
			.catch((error) => {
				// Crash path already broadcast by onExit; surface as start failure.
				throw error;
			})
			.finally(() => {
				rt.startPromise = null;
			});
		return rt.startPromise;
	}

	private spawnProcess(rt: WorkspaceRuntime): Promise<void> {
		rt.generation += 1;
		const generation = rt.generation;
		rt.status = "starting";
		rt.lastError = undefined;
		this.broadcastStatus(rt, "starting");

		const proc = new PiProcess({
			cwd: rt.cwd,
			resolved: this.opts.resolved,
			env: this.opts.env,
			readyTimeoutMs: this.opts.readyTimeoutMs,
			onReady: (initialState) => {
				if (rt.generation !== generation) return;
				rt.currentSessionId = initialState?.sessionId ?? null;
				rt.status = "running";
				rt.crashTimes = [];
				this.broadcastStatus(rt, "running");
				this.log("info", `pi process ready for ${rt.cwd} (session ${rt.currentSessionId})`);
				this.warmUpCommands(rt);
			},
			onEvent: (event) => this.handleEvent(rt, generation, event),
			onExtensionUiRequest: (request) => this.handleExtensionUiRequest(rt, generation, request),
			onExit: (info) => this.handleExit(rt, generation, info),
		});
		rt.proc = proc;

		return proc.start().catch((error) => {
			if (rt.generation === generation) {
				rt.lastError = error instanceof Error ? error.message : String(error);
				rt.status = "crashed";
				this.broadcastStatus(rt, "crashed");
			}
			throw error;
		});
	}

	/** Send get_commands right after ready so the slash menu has warm candidates (§2.1 rule 5). */
	private warmUpCommands(rt: WorkspaceRuntime): void {
		const proc = rt.proc;
		if (!proc?.running) return;
		void proc.send({ id: "ready-commands-1", type: "get_commands" }).catch(() => {
			// Warm-up is best-effort; clients fetch their own snapshot on demand.
		});
	}

	private handleExit(
		rt: WorkspaceRuntime,
		generation: number,
		info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string },
	): void {
		if (rt.generation !== generation) return;
		rt.proc = null;
		rt.status = "crashed";
		rt.lastError =
			(info.code !== null
				? `exit code ${String(info.code)}`
				: info.signal
					? `signal ${info.signal}`
					: "spawn failed") + (info.stderrTail ? ` — ${info.stderrTail.slice(-300).trim()}` : "");
		this.log("error", `pi process crashed for ${rt.cwd}: ${rt.lastError}`);
		this.broadcastStatus(rt, "crashed");

		if (rt.manuallyStopped) return;

		// Auto-restart: at most maxAutoRestarts within the sliding window (§2.1 rule 4).
		const now = Date.now();
		rt.crashTimes = rt.crashTimes.filter((t) => now - t < this.opts.restartWindowMs);
		rt.crashTimes.push(now);
		if (rt.crashTimes.length > this.opts.maxAutoRestarts) {
			this.log("warn", `auto-restart budget exhausted for ${rt.cwd}; manual restart required`);
			return;
		}
		const backoffMs = 500 * 2 ** (rt.crashTimes.length - 1);
		this.log("info", `scheduling auto-restart for ${rt.cwd} in ${backoffMs}ms`);
		rt.restartTimer = setTimeout(() => {
			rt.restartTimer = null;
			if (rt.manuallyStopped) return;
			this.spawnProcess(rt).catch(() => {
				// Failure handled by the crash path.
			});
		}, backoffMs);
	}

	/** Manual restart (REST endpoint / UI button). Resets the crash window. */
	async restart(workspaceId: string): Promise<void> {
		const rt = this.runtimes.get(workspaceId);
		if (!rt) throw new RpcError("restart", `Workspace not registered: ${workspaceId}`);
		rt.manuallyStopped = false;
		rt.crashTimes = [];
		if (rt.restartTimer) {
			clearTimeout(rt.restartTimer);
			rt.restartTimer = null;
		}
		await rt.proc?.stop();
		rt.proc = null;
		await this.spawnProcess(rt);
	}

	/** Stop the workspace process (e.g. workspace removal). No auto-restart. */
	async stop(workspaceId: string): Promise<void> {
		const rt = this.runtimes.get(workspaceId);
		if (!rt) return;
		rt.manuallyStopped = true;
		if (rt.restartTimer) {
			clearTimeout(rt.restartTimer);
			rt.restartTimer = null;
		}
		await rt.proc?.stop();
		rt.proc = null;
		rt.status = "crashed";
		rt.pendingDialogs.clear();
	}

	/** Stop every workspace process (server shutdown). */
	async stopAll(): Promise<void> {
		await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
	}

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------

	/**
	 * Send a command to the workspace process.
	 *
	 * - Cross-workspace switch_session is rejected up front (§2.1 rule 3): the
	 *   target session file must live in this process's session dir.
	 * - After successful session-switching commands, refresh the tracked
	 *   sessionId (the switch response carries only {cancelled}).
	 */
	async sendCommand(
		workspaceId: string,
		cwd: string,
		command: RpcCommand,
		timeoutMs?: number,
	): Promise<RpcResponse> {
		const rt = this.runtimes.get(workspaceId);
		if (!rt) throw new RpcError(command.type, `Workspace not registered: ${workspaceId}`);
		await this.ensureProcess(workspaceId, cwd);
		const proc = rt.proc;
		if (!proc?.running) throw new RpcError(command.type, "pi process is not running");

		if (command.type === "switch_session") {
			const sessionDir = this.resolveSessionDir(rt.cwd);
			if (!isSessionInDir(command.sessionPath, sessionDir)) {
				throw new RpcError(
					"switch_session",
					"Cross-workspace session switch is not allowed: " +
						command.sessionPath +
						" does not belong to " +
						sessionDir,
				);
			}
		}

		const response = await proc.send(command, timeoutMs);
		if (
			response.type === "response" &&
			response.success === true &&
			SESSION_SWITCH_COMMANDS.has(response.command)
		) {
			void this.refreshSessionId(rt);
		}
		return response;
	}

	private async refreshSessionId(rt: WorkspaceRuntime): Promise<void> {
		const proc = rt.proc;
		if (!proc?.running) return;
		try {
			const response = await proc.send({ id: "session-track-1", type: "get_state" });
			if (response.type === "response" && response.success === true && response.command === "get_state") {
				const state = response.data as RpcSessionState;
				if (state.sessionId !== rt.currentSessionId) {
					rt.currentSessionId = state.sessionId;
					this.log("info", `active session changed to ${state.sessionId}`);
				}
			}
		} catch {
			// Tracking is best-effort; the next get_state will fix it.
		}
	}

	/** Forward an extension UI response to the process (fire-and-forget). */
	sendExtensionUiResponse(workspaceId: string, response: RpcExtensionUIResponse): void {
		const rt = this.runtimes.get(workspaceId);
		if (!rt) return;
		rt.pendingDialogs.delete(response.id);
		if (rt.proc?.running) rt.proc.sendNoResponse(response);
	}

	/**
	 * Cancel every pending dialog that was opened under the given session
	 * (WS disconnect protection, §2.1 rule 6). Idempotent: the agent ignores
	 * responses for requests that already timed out locally.
	 */
	cancelDialogsForSession(workspaceId: string, sessionId: string): number {
		const rt = this.runtimes.get(workspaceId);
		if (!rt) return 0;
		let cancelled = 0;
		for (const [requestId, openedSessionId] of rt.pendingDialogs) {
			if (openedSessionId === sessionId) {
				rt.pendingDialogs.delete(requestId);
				if (rt.proc?.running) {
					rt.proc.sendNoResponse({ type: "extension_ui_response", id: requestId, cancelled: true });
				}
				cancelled += 1;
			}
		}
		if (cancelled > 0) this.log("info", `cancelled ${cancelled} dialogs for session ${sessionId}`);
		return cancelled;
	}

	// -------------------------------------------------------------------------
	// Event routing
	// -------------------------------------------------------------------------

	private handleEvent(rt: WorkspaceRuntime, generation: number, event: JsonAgentSessionEvent): void {
		if (rt.generation !== generation) return;
		const sessionId = rt.currentSessionId ?? "";
		this.opts.broadcast({ type: "event", workspaceId: rt.workspaceId, sessionId, event });
	}

	private handleExtensionUiRequest(
		rt: WorkspaceRuntime,
		generation: number,
		request: RpcExtensionUIRequest,
	): void {
		if (rt.generation !== generation) return;
		const sessionId = rt.currentSessionId ?? "";
		if (DIALOG_METHODS.has(request.method)) {
			rt.pendingDialogs.set(request.id, sessionId);
		}
		this.opts.broadcast({ type: "extension_ui_request", workspaceId: rt.workspaceId, sessionId, request });
	}

	private broadcastStatus(rt: WorkspaceRuntime, state: ProcessState): void {
		this.opts.broadcast({
			type: "process_status",
			workspaceId: rt.workspaceId,
			state,
			...(state === "crashed" && rt.lastError ? { error: rt.lastError } : {}),
		});
	}

	/** Broadcast helpers used by REST routes. */
	notifySessionDirectoryChanged(workspaceId: string): void {
		this.opts.broadcast({ type: "session_directory_changed", workspaceId });
	}

	notifyAuthChanged(workspaceId?: string): void {
		if (workspaceId) {
			this.opts.broadcast({ type: "auth_changed", workspaceId });
			return;
		}
		for (const id of this.runtimes.keys()) {
			this.opts.broadcast({ type: "auth_changed", workspaceId: id });
		}
	}
}
