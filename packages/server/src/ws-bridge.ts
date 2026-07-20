import { randomUUID } from "node:crypto";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import {
	isWsClientMessage,
	RpcError,
	type WsClientMessage,
	type WsServerMessage,
} from "@pi-agent-web/protocol";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { Supervisor } from "./supervisor.js";

/**
 * WebSocket <-> JSONL relay (wire contract lives in @pi-agent-web/protocol).
 *
 * - One full-duplex socket per tab, route /api/v1/ws.
 * - Commands are correlated to the originating connection by command id, so a
 *   response frame is delivered only to the tab that issued the command.
 * - Events are filtered by the connection's declared listen scope
 *   (session_listen), so tabs are isolated from each other's sessions.
 * - Per (workspaceId, sessionId) connection counting drives the disconnect
 *   protection: when the count drops to zero the supervisor cancels pending
 *   extension dialogs for that session (disconnect protection).
 */

export interface WorkspaceInfo {
	cwd: string;
}

interface ConnectionState {
	connectionId: string;
	ws: WebSocket;
	workspaceId?: string;
	listenedSessionId: string | null;
	controlledWorkspaces: Set<string>;
	pendingCommands: Set<string>;
	alive: boolean;
}

interface RequestMapping {
	connectionId: string;
	clientId: string | undefined;
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
	private requestMappings = new Map<string, RequestMapping>();
	private requestCounter = 0;
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
			connectionId: randomUUID(),
			ws,
			listenedSessionId: null,
			controlledWorkspaces: new Set(),
			pendingCommands: new Set(),
			alive: true,
		};
		this.connections.add(conn);
		this.log("info", `ws connected (${this.connections.size} open)`);

		ws.on("pong", () => {
			conn.alive = true;
		});

		ws.on("message", (raw, isBinary) => {
			if (isBinary) {
				this.closeForPolicyViolation(conn, "binary WebSocket frames are not supported");
				return;
			}
			void this.handleClientMessage(conn, raw.toString()).catch((error) => {
				this.log("warn", `ws message handling failed: ${String(error)}`);
				this.closeForPolicyViolation(conn, "invalid WebSocket message");
			});
		});

		ws.on("close", () => {
			this.connections.delete(conn);
			this.clearRequestMappings(conn);
			this.clearListen(conn);
			for (const workspaceId of conn.controlledWorkspaces) {
				if (this.supervisor.releaseController(workspaceId, conn.connectionId)) {
					this.broadcastLeaseStatus(workspaceId);
				}
			}
			conn.controlledWorkspaces.clear();
			this.log("info", `ws disconnected (${this.connections.size} open)`);
		});

		ws.on("error", () => {
			// close handler does the cleanup.
		});
	}

	private async handleClientMessage(conn: ConnectionState, raw: string): Promise<void> {
		let rawMessage: unknown;
		try {
			rawMessage = JSON.parse(raw);
		} catch {
			this.closeForPolicyViolation(conn, "invalid JSON");
			return;
		}
		if (!isWsClientMessage(rawMessage)) {
			this.closeForPolicyViolation(conn, "invalid client frame");
			return;
		}
		const message: WsClientMessage = rawMessage;

		switch (message.type) {
			case "session_listen": {
				this.setListen(conn, message.workspaceId, message.sessionId);
				return;
			}
			case "command": {
				await this.handleCommand(conn, message.workspaceId, message.expectedSessionId, message.command);
				return;
			}
			case "session_claim": {
				if (this.supervisor.claimController(message.workspaceId, conn.connectionId)) {
					conn.controlledWorkspaces.add(message.workspaceId);
				}
				this.broadcastLeaseStatus(message.workspaceId);
				this.sendSessionState(conn, message.workspaceId);
				return;
			}
			case "session_release": {
				if (this.supervisor.releaseController(message.workspaceId, conn.connectionId)) {
					conn.controlledWorkspaces.delete(message.workspaceId);
					this.broadcastLeaseStatus(message.workspaceId);
				} else {
					this.sendLeaseStatus(conn, message.workspaceId);
				}
				return;
			}
			case "extension_ui_response": {
				if (conn.workspaceId !== message.workspaceId || conn.listenedSessionId === null) {
					this.closeForPolicyViolation(conn, "extension response does not match the listen scope");
					return;
				}
				const outcome = this.supervisor.sendExtensionUiResponse(
					message.workspaceId,
					message.response,
					{ connectionId: conn.connectionId, expectedSessionId: message.expectedSessionId },
					conn.listenedSessionId,
				);
				if (outcome !== "accepted") this.sendLeaseStatus(conn, message.workspaceId);
				return;
			}
			default:
				return;
		}
	}

	private async handleCommand(
		conn: ConnectionState,
		workspaceId: string,
		expectedSessionId: string | null,
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

		const internalId = this.nextInternalId(conn);
		const mapping: RequestMapping = { connectionId: conn.connectionId, clientId: command.id };
		this.requestMappings.set(internalId, mapping);
		conn.pendingCommands.add(internalId);
		const internalCommand = { ...command, id: internalId } as RpcCommand;

		try {
			const response = await this.supervisor.sendCommand(workspaceId, workspace.cwd, internalCommand, {
				connectionId: conn.connectionId,
				expectedSessionId,
			});
			this.sendTargeted(conn, {
				type: "response",
				workspaceId,
				response: this.restoreClientId(response, mapping),
			});
		} catch (error) {
			const messageText =
				error instanceof RpcError ? error.message : error instanceof Error ? error.message : String(error);
			this.sendTargeted(conn, {
				type: "response",
				workspaceId,
				response: {
					...(mapping.clientId ? { id: mapping.clientId } : {}),
					type: "response",
					command: command.type,
					success: false,
					error: messageText,
				},
			});
			// Process-level failures may still be useful in the log.
			this.log("warn", `command ${command.type} failed: ${messageText}`);
		} finally {
			conn.pendingCommands.delete(internalId);
			this.requestMappings.delete(internalId);
		}
	}

	private nextInternalId(conn: ConnectionState): string {
		this.requestCounter += 1;
		return `bridge-${conn.connectionId}-${this.requestCounter.toString(36)}`;
	}

	private restoreClientId(response: RpcResponse, mapping: RequestMapping): RpcResponse {
		const { id: _internalId, ...withoutInternalId } = response;
		return mapping.clientId
			? ({ ...withoutInternalId, id: mapping.clientId } as RpcResponse)
			: (withoutInternalId as RpcResponse);
	}

	private clearRequestMappings(conn: ConnectionState): void {
		for (const internalId of conn.pendingCommands) {
			this.requestMappings.delete(internalId);
		}
		conn.pendingCommands.clear();
	}

	private closeForPolicyViolation(conn: ConnectionState, reason: string): void {
		this.log("warn", `closing ws ${conn.connectionId}: ${reason}`);
		if (conn.ws.readyState === conn.ws.OPEN || conn.ws.readyState === conn.ws.CONNECTING) {
			conn.ws.close(1008, "policy violation");
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
		if (sessionId !== null && this.supervisor.claimController(workspaceId, conn.connectionId)) {
			conn.controlledWorkspaces.add(workspaceId);
		}
		this.broadcastLeaseStatus(workspaceId);
		this.sendSessionState(conn, workspaceId);
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

	private broadcastLeaseStatus(workspaceId: string): void {
		for (const conn of this.connections) {
			if (conn.workspaceId !== workspaceId) continue;
			this.sendLeaseStatus(conn, workspaceId);
		}
	}

	private sendLeaseStatus(conn: ConnectionState, workspaceId: string): void {
		this.sendTargeted(conn, {
			type: "lease_status",
			workspaceId,
			isController: this.supervisor.isController(workspaceId, conn.connectionId),
		});
	}

	private sendSessionState(conn: ConnectionState, workspaceId: string): void {
		const status = this.supervisor.getStatus(workspaceId);
		if (!status) return;
		this.sendTargeted(conn, {
			type: "session_state",
			workspaceId,
			sessionId: status.sessionId,
			sessionFile: status.sessionFile,
			epoch: status.epoch,
		});
	}
}
