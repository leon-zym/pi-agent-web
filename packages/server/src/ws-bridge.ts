import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { Supervisor } from "./supervisor.ts";
import type { WsClientMessage, WsServerMessage } from "./wire.ts";
import { RpcError } from "./wire.ts";

/**
 * WebSocket <-> JSONL relay (design spec §4.2).
 *
 * - One full-duplex socket per tab, route /api/v1/ws.
 * - Commands are correlated to the originating connection by command id, so a
 *   response frame is delivered only to the tab that issued the command.
 * - Events are filtered by the connection's declared listen scope
 *   (session_listen), so tabs are isolated from each other's sessions.
 * - Per (workspaceId, sessionId) connection counting drives the disconnect
 *   protection: when the count drops to zero the supervisor cancels pending
 *   extension dialogs for that session (§2.1 rule 6).
 */

export interface WorkspaceInfo {
	cwd: string;
}

interface ConnectionState {
	ws: WebSocket;
	workspaceId?: string;
	listenedSessionId: string | null;
	pendingCommands: Set<string>;
	alive: boolean;
}

export interface WsBridgeOptions {
	supervisor: Supervisor;
	getWorkspace: (workspaceId: string) => WorkspaceInfo | undefined;
	/** Broadcast a frame to every connection of a workspace (supervisor events). */
	heartbeatIntervalMs?: number;
	log?: (level: "info" | "warn" | "error", message: string) => void;
}

const keyOf = (workspaceId: string, sessionId: string): string => `${workspaceId}\u0000${sessionId}`;

export class WsBridge {
	readonly wss: WebSocketServer;
	private supervisor: Supervisor;
	private getWorkspace: (workspaceId: string) => WorkspaceInfo | undefined;
	private connections = new Set<ConnectionState>();
	private listenCounts = new Map<string, number>();
	private heartbeatTimer: NodeJS.Timeout;
	private log: (level: "info" | "warn" | "error", message: string) => void;

	constructor(opts: WsBridgeOptions) {
		this.supervisor = opts.supervisor;
		this.getWorkspace = opts.getWorkspace;
		this.log = opts.log ?? (() => {});
		this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

		this.wss.on("connection", (ws) => this.handleConnection(ws));
		this.wss.on("error", (error) => this.log("error", `ws server error: ${String(error)}`));

		this.heartbeatTimer = setInterval(() => {
			for (const conn of this.connections) {
				if (!conn.alive) {
					conn.ws.terminate();
					continue;
				}
				conn.alive = false;
				try {
					conn.ws.ping();
				} catch {
					// Socket already gone; cleanup happens on close.
				}
			}
		}, opts.heartbeatIntervalMs ?? 30_000);
		this.heartbeatTimer.unref?.();
	}

	close(): void {
		clearInterval(this.heartbeatTimer);
		for (const conn of this.connections) {
			try {
				conn.ws.close();
			} catch {
				// ignore
			}
		}
		this.wss.close();
	}

	/** Supervisor broadcast sink. */
	broadcast(message: WsServerMessage): void {
		const payload = JSON.stringify(message);
		for (const conn of this.connections) {
			if (!this.shouldDeliver(conn, message)) continue;
			if (conn.ws.readyState !== conn.ws.OPEN) continue;
			try {
				conn.ws.send(payload);
			} catch {
				// Best-effort per connection.
			}
		}
	}

	private shouldDeliver(conn: ConnectionState, message: WsServerMessage): boolean {
		if (message.type === "response") return false; // responses use targeted delivery
		if (message.type === "event" || message.type === "extension_ui_request") {
			return conn.workspaceId === message.workspaceId && conn.listenedSessionId === message.sessionId;
		}
		return conn.workspaceId === message.workspaceId;
	}

	private handleConnection(ws: WebSocket): void {
		const conn: ConnectionState = {
			ws,
			listenedSessionId: null,
			pendingCommands: new Set(),
			alive: true,
		};
		this.connections.add(conn);
		this.log("info", `ws connected (${this.connections.size} open)`);

		ws.on("pong", () => {
			conn.alive = true;
		});

		ws.on("message", (raw) => {
			void this.handleClientMessage(conn, raw.toString());
		});

		ws.on("close", () => {
			this.connections.delete(conn);
			this.clearListen(conn);
			this.log("info", `ws disconnected (${this.connections.size} open)`);
		});

		ws.on("error", () => {
			// close handler does the cleanup.
		});
	}

	private async handleClientMessage(conn: ConnectionState, raw: string): Promise<void> {
		let message: WsClientMessage;
		try {
			message = JSON.parse(raw) as WsClientMessage;
		} catch {
			return; // ignore malformed frames
		}
		if (!message || typeof message !== "object" || typeof message.type !== "string") return;

		switch (message.type) {
			case "session_listen": {
				this.setListen(conn, message.workspaceId, message.sessionId);
				return;
			}
			case "command": {
				await this.handleCommand(conn, message.workspaceId, message.command);
				return;
			}
			case "extension_ui_response": {
				this.supervisor.sendExtensionUiResponse(message.workspaceId, message.response);
				return;
			}
			default:
				return;
		}
	}

	private async handleCommand(
		conn: ConnectionState,
		workspaceId: string,
		command: Extract<WsClientMessage, { type: "command" }>["command"],
	): Promise<void> {
		const workspace = this.getWorkspace(workspaceId);
		if (!workspace) {
			this.sendTargeted(conn, {
				type: "response",
				workspaceId,
				response: {
					id: command.id,
					type: "response",
					command: command.type,
					success: false,
					error: `Unknown workspace: ${workspaceId}`,
				},
			});
			return;
		}

		if (command.id) conn.pendingCommands.add(command.id);

		try {
			const response = await this.supervisor.sendCommand(workspaceId, workspace.cwd, command);
			if (command.id) conn.pendingCommands.delete(command.id);
			this.sendTargeted(conn, { type: "response", workspaceId, response });
		} catch (error) {
			if (command.id) conn.pendingCommands.delete(command.id);
			const messageText =
				error instanceof RpcError ? error.message : error instanceof Error ? error.message : String(error);
			this.sendTargeted(conn, {
				type: "response",
				workspaceId,
				response: {
					id: command.id,
					type: "response",
					command: command.type,
					success: false,
					error: messageText,
				},
			});
			// Process-level failures may still be useful in the log.
			this.log("warn", `command ${command.type} failed: ${messageText}`);
		}
	}

	private sendTargeted(conn: ConnectionState, message: WsServerMessage): void {
		if (conn.ws.readyState !== conn.ws.OPEN) return;
		try {
			conn.ws.send(JSON.stringify(message));
		} catch {
			// ignore
		}
	}

	private setListen(conn: ConnectionState, workspaceId: string, sessionId: string | null): void {
		this.clearListen(conn);
		conn.workspaceId = workspaceId;
		conn.listenedSessionId = sessionId;
		if (sessionId !== null) {
			const key = keyOf(workspaceId, sessionId);
			this.listenCounts.set(key, (this.listenCounts.get(key) ?? 0) + 1);
		}
	}

	private clearListen(conn: ConnectionState): void {
		if (conn.workspaceId && conn.listenedSessionId !== null) {
			const key = keyOf(conn.workspaceId, conn.listenedSessionId);
			const next = (this.listenCounts.get(key) ?? 1) - 1;
			if (next <= 0) {
				this.listenCounts.delete(key);
				// Disconnect protection: last listener for this session is gone.
				this.supervisor.cancelDialogsForSession(conn.workspaceId, conn.listenedSessionId);
			} else {
				this.listenCounts.set(key, next);
			}
		}
		conn.listenedSessionId = null;
	}
}
