import path from "node:path";
import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { RpcError, type WsServerMessage } from "@pi-agent-web/protocol";
import { getSessionDirForCwd, isSessionInDir } from "./config.js";
import { PiProcess } from "./pi-process.js";
import type { ResolvedPi } from "./resolver.js";
import { scanSessionFile } from "./session-scan.js";

/**
 * Workspace-granularity process supervisor (see docs/architecture.md).
 *
 * - 1 workspace = 1 "pi --mode rpc" child process (cwd = workspace).
 * - In-workspace session switches reuse the process; cross-workspace switches
 *   must restart the process (validated in sendCommand).
 * - Ready handshake + initial get_commands warm-up (no ready frame in the protocol).
 * - Crash detection: supervisor synthesizes process_status "crashed" (the dead
 *   process cannot report itself). Auto-restart up to 3 times within a 30s
 *   window with exponential backoff, then manual restart only.
 * - Tracks the active sessionId from get_state responses (no ready frame in
 *   the protocol; session boundaries are inferred, Appendix A note).
 * - Keeps pending extension dialogs per (workspaceId, sessionId) so the WS
 *   bridge can cancel them when the last listener disconnects.
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
	cwdRealpath: string;
	proc: PiProcess | null;
	status: ProcessState;
	currentSessionId: string | null;
	/** Only updated by a successful get_state response. */
	currentSessionFile: string | null;
	lastError?: string;
	crashTimes: number[];
	restartTimer: NodeJS.Timeout | null;
	manuallyStopped: boolean;
	startPromise: Promise<void> | null;
	generation: number;
	pendingDialogs: Map<string, string>;
	transitionTail: Promise<void>;
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

	registerWorkspace(workspaceId: string, cwdRealpath: string): void {
		const existing = this.runtimes.get(workspaceId);
		if (existing && existing.cwdRealpath === cwdRealpath) return;
		// cwd changed (e.g. re-registration): replace runtime state.
		this.runtimes.set(workspaceId, this.createRuntime(workspaceId, cwdRealpath));
	}

	private createRuntime(workspaceId: string, cwdRealpath: string): WorkspaceRuntime {
		return {
			workspaceId,
			cwdRealpath,
			proc: null,
			status: "crashed",
			currentSessionId: null,
			currentSessionFile: null,
			crashTimes: [],
			restartTimer: null,
			manuallyStopped: true,
			startPromise: null,
			generation: 0,
			pendingDialogs: new Map(),
			transitionTail: Promise.resolve(),
		};
	}

	getStatus(
		workspaceId: string,
	): { state: ProcessState; error?: string; sessionId: string | null; sessionFile: string | null } | null {
		const rt = this.runtimes.get(workspaceId);
		if (!rt) return null;
		return {
			state: rt.status,
			error: rt.lastError,
			sessionId: rt.currentSessionId,
			sessionFile: rt.currentSessionFile,
		};
	}

	/**
	 * Ensure a running process for the workspace. Dedupes concurrent calls via
	 * startPromise. Resolves when ready (or throws after the ready timeout).
	 */
	async ensureProcess(workspaceId: string, cwdRealpath: string): Promise<void> {
		let rt = this.runtimes.get(workspaceId);
		if (!rt || rt.cwdRealpath !== cwdRealpath) {
			this.registerWorkspace(workspaceId, cwdRealpath);
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
			cwd: rt.cwdRealpath,
			resolved: this.opts.resolved,
			env: this.opts.env,
			readyTimeoutMs: this.opts.readyTimeoutMs,
			onReady: (initialState) => {
				if (rt.generation !== generation) return;
				if (initialState) this.applySessionState(rt, initialState);
				rt.status = "running";
				rt.crashTimes = [];
				this.broadcastStatus(rt, "running");
				this.log("info", `pi process ready for ${rt.cwdRealpath} (session ${rt.currentSessionId})`);
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

	/** Send get_commands right after ready so the slash menu has warm candidates. */
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
		this.log("error", `pi process crashed for ${rt.cwdRealpath}: ${rt.lastError}`);
		this.broadcastStatus(rt, "crashed");

		if (rt.manuallyStopped) return;

		// Auto-restart: at most maxAutoRestarts within the sliding window.
		const now = Date.now();
		rt.crashTimes = rt.crashTimes.filter((t) => now - t < this.opts.restartWindowMs);
		rt.crashTimes.push(now);
		if (rt.crashTimes.length > this.opts.maxAutoRestarts) {
			this.log("warn", `auto-restart budget exhausted for ${rt.cwdRealpath}; manual restart required`);
			return;
		}
		const backoffMs = 500 * 2 ** (rt.crashTimes.length - 1);
		this.log("info", `scheduling auto-restart for ${rt.cwdRealpath} in ${backoffMs}ms`);
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
	 * - Cross-workspace switch_session is rejected up front (the process cwd and
	 *   target session file must live in this process's session dir.
	 * - After successful session-switching commands, refresh the tracked
	 *   sessionId (the switch response carries only {cancelled}).
	 */
	async sendCommand(
		workspaceId: string,
		cwdRealpath: string,
		command: RpcCommand,
		timeoutMs?: number,
	): Promise<RpcResponse> {
		const rt = this.runtimes.get(workspaceId);
		if (!rt) throw new RpcError(command.type, `Workspace not registered: ${workspaceId}`);
		const execute = async (): Promise<RpcResponse> => {
			await this.ensureProcess(workspaceId, cwdRealpath);
			const proc = rt.proc;
			if (!proc?.running) throw new RpcError(command.type, "pi process is not running");

			if (command.type === "switch_session")
				await this.assertSessionBelongsToWorkspace(rt, command.sessionPath);

			const response = await proc.send(command, timeoutMs);
			if (response.type === "response" && response.success === true && response.command === "get_state") {
				this.applySessionState(rt, response.data as RpcSessionState);
			}
			if (
				response.type === "response" &&
				response.success === true &&
				SESSION_SWITCH_COMMANDS.has(response.command)
			) {
				await this.refreshSessionState(rt);
			}
			return response;
		};

		return SESSION_SWITCH_COMMANDS.has(command.type) || command.type === "get_state"
			? this.runSessionTransition(rt, execute)
			: execute();
	}

	/** Serialize session-changing commands and REST session file mutations. */
	async withSessionTransition<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
		const rt = this.runtimes.get(workspaceId);
		if (!rt) throw new RpcError("session_transition", `Workspace not registered: ${workspaceId}`);
		return this.runSessionTransition(rt, operation);
	}

	private async runSessionTransition<T>(rt: WorkspaceRuntime, operation: () => Promise<T>): Promise<T> {
		const previous = rt.transitionTail;
		let release: () => void;
		rt.transitionTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release!();
		}
	}

	private async assertSessionBelongsToWorkspace(rt: WorkspaceRuntime, sessionPath: string): Promise<void> {
		const sessionDir = this.resolveSessionDir(rt.cwdRealpath);
		if (!isSessionInDir(sessionPath, sessionDir)) {
			throw new RpcError(
				"switch_session",
				`Cross-workspace session switch is not allowed: ${sessionPath} does not belong to ${sessionDir}`,
			);
		}
		if (!(await scanSessionFile(sessionPath, rt.cwdRealpath))) {
			throw new RpcError("switch_session", "Session header does not belong to this workspace");
		}
	}

	private async refreshSessionState(rt: WorkspaceRuntime): Promise<void> {
		const proc = rt.proc;
		if (!proc?.running) throw new RpcError("get_state", "pi process is not running after session transition");
		const response = await proc.send({ type: "get_state" });
		if (response.type !== "response" || response.success !== true || response.command !== "get_state") {
			throw new RpcError("get_state", "Unable to verify active session after session transition");
		}
		this.applySessionState(rt, response.data as RpcSessionState);
	}

	private applySessionState(rt: WorkspaceRuntime, state: RpcSessionState): void {
		const previousId = rt.currentSessionId;
		rt.currentSessionId = state.sessionId;
		rt.currentSessionFile = state.sessionFile ? path.resolve(state.sessionFile) : null;
		if (previousId !== state.sessionId) this.log("info", `active session changed to ${state.sessionId}`);
	}

	/** Forward an extension UI response to the process (fire-and-forget). */
	sendExtensionUiResponse(
		workspaceId: string,
		response: RpcExtensionUIResponse,
		sessionId?: string,
	): boolean {
		const rt = this.runtimes.get(workspaceId);
		if (!rt) return false;
		const dialogSessionId = rt.pendingDialogs.get(response.id);
		if (!dialogSessionId || (sessionId !== undefined && sessionId !== dialogSessionId)) return false;
		rt.pendingDialogs.delete(response.id);
		if (!rt.proc?.running) return false;
		rt.proc.sendNoResponse(response);
		return true;
	}

	/**
	 * Cancel every pending dialog that was opened under the given session
	 * (WS disconnect protection). Idempotent: the agent ignores
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
