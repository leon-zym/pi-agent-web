import { randomUUID } from "node:crypto";
import {
	analyzeSessionMessageLogicalBytes,
	analyzeSessionResponseFrameLogicalBytes,
	COMMAND_RESPONSE_RESERVATION_BYTES,
	commandResponseReservationBytes,
	GATEWAY_CLIENT_REQUIRED_CAPABILITIES,
	GATEWAY_CONTENT_REF_CAPABILITY,
	GATEWAY_FENCED_TAKEOVER_CAPABILITY,
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	GATEWAY_SESSION_HISTORY_CAPABILITY,
	type GatewayProtocolErrorDto,
	type GatewayServerHelloDto,
	type HotRuntimeInventoryDto,
	hasUnsupportedGatewayProtocolMajor,
	isGatewayClientHello,
	isSessionContentRefGuardContext,
	isSessionWsClientMessage,
	isSessionWsServerMessage,
	negotiateGatewayHello,
	RpcError,
	SESSION_CONTENT_REF_BUDGET,
	SESSION_HISTORY_MAX_CHUNK_BYTES,
	SESSION_HISTORY_MAX_CHUNK_MESSAGES,
	SESSION_HISTORY_MAX_STREAM_BYTES,
	SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES,
	SESSION_PAYLOAD_BUDGET,
	SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES,
	SESSION_WS_CLIENT_MAX_BYTES,
	SESSION_WS_SERVER_MAX_BYTES,
	type SessionCommandDto,
	type SessionReplayCursorDto,
	type SessionRuntimeDto,
	type SessionRuntimeIdentityDto,
	type SessionWsClientMessage,
	type SessionWsServerMessage,
	sessionHistoryChecksum,
	sessionHistoryMessagesBytes,
} from "@pi-agent-web/protocol";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { GatewayPayloadActivation } from "./gateway-payload-activation.js";
import type {
	SessionRuntimeProductEvent,
	SessionRuntimeProductExtensionRequest,
	SessionRuntimeProductMode,
	SessionRuntimeProductResponse,
	SessionRuntimeProductSnapshot,
} from "./session-runtime.js";
import type {
	ReplayResult,
	SessionLeaseSnapshot,
	SessionLeaseTransition,
	SessionSupervisorMessage,
} from "./session-runtime-types.js";
import type { HotRuntimeSubscriptionToken, SessionSupervisorCore } from "./session-supervisor.js";

interface ConnectionState<M extends SessionRuntimeProductMode = "content_ref"> {
	connectionId: string;
	ws: WebSocket;
	subscriptions: Set<string>;
	subscriptionAliases: Map<string, string>;
	catchUps: Set<SessionCatchUp<M>>;
	/** Child handles awaiting an authoritative post-rekey baseline. */
	pendingRekeyLeases: Map<string, SessionLeaseTransition | undefined>;
	catchUpSmallBufferedBytes: number;
	catchUpLargeItems: number;
	nextCatchUpOrder: number;
	controlledSessions: Set<string>;
	controlIntents: Map<string, ControlIntent>;
	nextControlIntentRevision: number;
	pendingCommands: Set<string>;
	pendingCommandResponseBytes: number;
	outboundQueue: OutboundPayload[];
	outboundSmallQueuedBytes: number;
	outboundLargeItems: number;
	outboundHistoryQueuedBytes: number;
	outboundSending: boolean;
	outboundActive?: OutboundPayload;
	alive: boolean;
	closed: boolean;
	epoch: number;
	helloComplete: boolean;
	hotInventoryNegotiated: boolean;
	historyNegotiated: boolean;
	historySnapshots: Map<string, HistorySnapshot<M>>;
	historyPages: Map<string, HistoryPageOperation>;
	restartableOverflows: Map<string, number>;
	hotInventoryRevision: number;
	deferredHotInventory?: HotRuntimeInventoryDto;
	admittedExactOperations: number;
	helloTimer?: NodeJS.Timeout;
	negotiatedMaxServerFrameBytes: number;
	/** Resolves only after the supervisor actor has published disconnect releases. */
	disconnectCompletion?: Promise<void>;
}

interface OutboundPayload {
	payload: string;
	bytes: number;
	large: boolean;
	history: boolean;
	release?: () => void;
	retained: boolean;
}

type BridgeEvent<M extends SessionRuntimeProductMode> = SessionRuntimeProductEvent<M>;
type BridgeExtensionRequest<M extends SessionRuntimeProductMode> = SessionRuntimeProductExtensionRequest<M>;
type BridgeResponse<M extends SessionRuntimeProductMode> = SessionRuntimeProductResponse<M>;
type BridgeSnapshot<M extends SessionRuntimeProductMode> = SessionRuntimeProductSnapshot<M>;
type BridgeSupervisorMessage<M extends SessionRuntimeProductMode> = SessionSupervisorMessage<
	BridgeEvent<M>,
	BridgeExtensionRequest<M>
>;
type BridgeReplayResult<M extends SessionRuntimeProductMode> = ReplayResult<
	BridgeEvent<M>,
	BridgeSnapshot<M>,
	BridgeExtensionRequest<M>,
	BridgeSnapshot<M>["settledMessages"][number]
>;
type BridgeServerMessage<M extends SessionRuntimeProductMode> = SessionWsServerMessage;

interface BufferedCatchUpMessage<M extends SessionRuntimeProductMode = "content_ref"> {
	message: BridgeSupervisorMessage<M>;
	payload: string;
	bytes: number;
	retained: boolean;
}

interface SessionCatchUp<M extends SessionRuntimeProductMode = "content_ref"> {
	requestedHandle: string;
	currentHandle: string;
	handles: Set<string>;
	buffered: BufferedCatchUpMessage<M>[];
	bufferedSmallBytes: number;
	bufferedLargeItems: number;
	order: number;
	rekeyVersion: number;
	exactTransactional: boolean;
	pendingLease?: SessionLeaseTransition;
}

type BridgeChunkedSnapshot<M extends SessionRuntimeProductMode> = NonNullable<
	Extract<BridgeReplayResult<M>, { type: "resync_required" }>["chunkedSnapshot"]
>;

interface HistorySnapshot<M extends SessionRuntimeProductMode> {
	snapshotId: string;
	workspaceId: string;
	generation: number;
	asOfSeq: number;
	chunked: BridgeChunkedSnapshot<M>;
}

interface HistoryPageOperation {
	sessionHandle: string;
	requestId: string;
	connectionId: string;
	controller: AbortController;
	retainedBytes: number;
	retained: boolean;
}

interface ControlIntent {
	revision: number;
}

interface BashCommandIdMapping {
	connectionId: string;
	clientId: string;
}

type SessionWsBridgeSupervisor<M extends SessionRuntimeProductMode> = Pick<
	SessionSupervisorCore<M>,
	| "serverEpoch"
	| "getRuntime"
	| "getHotRuntimeInventory"
	| "subscribe"
	| "subscribeHotExact"
	| "revalidateHotExactSubscription"
	| "claimWithTransition"
	| "releaseWithTransition"
	| "releaseExactWithTransition"
	| "releaseConnectionWithTransitions"
	| "takeover"
	| "leaseFor"
	| "restart"
	| "sendCommand"
	| "sendExtensionUiResponse"
>;

interface SessionWsBridgeOptionsBase<M extends SessionRuntimeProductMode> {
	supervisor: SessionWsBridgeSupervisor<M>;
	serverBuild: string;
	runtime: {
		version: string;
		adapterId: string;
		capabilities: readonly string[];
	};
	heartbeatIntervalMs?: number;
	helloTimeoutMs?: number;
	/** Hard cap for sockets admitted by this Gateway instance. */
	maxConnections?: number;
	/** Hard cap for live and in-progress Session channels across all sockets. */
	maxSubscribedChannels?: number;
	/** Hard cap for in-progress replay/snapshot catch-ups across all sockets. */
	maxConcurrentCatchUps?: number;
	/** Hard cap for historical handle aliases retained by one socket. */
	maxSubscriptionAliases?: number;
	/** Weighted cap for command responses retained while their RPC is pending. */
	maxPendingCommandResponseBytes?: number;
	/** Gateway-wide weighted cap for command responses pending across all sockets. */
	maxGatewayPendingCommandResponseBytes?: number;
	/** Gateway-wide cap for serialized payloads retained by active or queued socket sends. */
	maxGatewayOutboundBytes?: number;
	/** Gateway-wide cap for concurrent historical page reads. */
	maxConcurrentHistoryPages?: number;
	log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface SessionWsBridgeOptions extends SessionWsBridgeOptionsBase<"content_ref"> {
	payloadActivation: Pick<GatewayPayloadActivation, "context" | "externalizer" | "supervisorServices">;
}

type BridgeActivation = SessionWsBridgeOptions["payloadActivation"];
type SessionWsBridgeCoreOptions<M extends SessionRuntimeProductMode> = SessionWsBridgeOptionsBase<M> & {
	payloadActivation: BridgeActivation;
};

export const MAX_SESSION_WS_IN_FLIGHT_COMMANDS = 32;
export const MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS = 256;
export const MAX_SESSION_WS_BUFFERED_BYTES = 1024 * 1024;
export const MAX_SESSION_WS_CONNECTIONS = 64;
export const MAX_SESSION_WS_SUBSCRIBED_CHANNELS = 1024;
export const MAX_SESSION_WS_CONCURRENT_CATCHUPS = 256;
export const MAX_SESSION_WS_SUBSCRIPTION_ALIASES = 1024;
export const MAX_SESSION_WS_METADATA_BURST_SESSIONS = 6;
// One Session snapshot refresh starts these five reads together. Six independent
// Sessions retain 105 MiB; one additional 8 MiB ordinary read brings the proven
// per-connection maximum to 113 MiB. A seventh complete burst would exceed it.
export const MAX_SESSION_WS_METADATA_RESPONSE_HEADROOM_BYTES =
	COMMAND_RESPONSE_RESERVATION_BYTES.get_commands +
	COMMAND_RESPONSE_RESERVATION_BYTES.get_available_models +
	COMMAND_RESPONSE_RESERVATION_BYTES.get_state +
	COMMAND_RESPONSE_RESERVATION_BYTES.get_available_thinking_levels +
	COMMAND_RESPONSE_RESERVATION_BYTES.get_session_stats;
export const MAX_SESSION_WS_ORDINARY_READ_RESPONSE_BYTES =
	COMMAND_RESPONSE_RESERVATION_BYTES.get_last_assistant_text;
export const MAX_SESSION_WS_PENDING_COMMAND_RESPONSE_BYTES =
	MAX_SESSION_WS_METADATA_BURST_SESSIONS * MAX_SESSION_WS_METADATA_RESPONSE_HEADROOM_BYTES +
	MAX_SESSION_WS_ORDINARY_READ_RESPONSE_BYTES;
export const MAX_SESSION_WS_GATEWAY_PENDING_COMMAND_RESPONSE_BYTES = SESSION_WS_SERVER_MAX_BYTES * 2;
export const MAX_SESSION_WS_GATEWAY_OUTBOUND_BYTES = SESSION_WS_SERVER_MAX_BYTES * 2;
export const MAX_SESSION_WS_CONCURRENT_HISTORY_PAGES = 16;
const MAX_SESSION_WS_FRAME_BYTES = SESSION_WS_SERVER_MAX_BYTES;
const DEFAULT_SESSION_HISTORY_CHUNK_TARGET_BYTES = 4 * 1024 * 1024;
const RETRYABLE_SESSION_ERROR_CODES = new Set<string>(SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES);
const RETRYABLE_HISTORY_ERROR_CODES = new Set(["session_history_busy", "session_history_capacity"]);

/** Multiplexes one browser socket across any number of independent Sessions. */
class SessionWsBridgeCore<M extends SessionRuntimeProductMode> {
	readonly wss: WebSocketServer;
	private readonly supervisor: SessionWsBridgeSupervisor<M>;
	private readonly connections = new Set<ConnectionState<M>>();
	private readonly heartbeatTimer: NodeJS.Timeout;
	private readonly log: (level: "info" | "warn" | "error", message: string) => void;
	private readonly serverEpoch: string;
	private readonly serverBuild: string;
	private readonly runtime: SessionWsBridgeOptions["runtime"];
	private readonly payloadActivation: BridgeActivation;
	private readonly helloTimeoutMs: number;
	private readonly maxConnections: number;
	private readonly maxSubscribedChannels: number;
	private readonly maxConcurrentCatchUps: number;
	private readonly maxSubscriptionAliases: number;
	private readonly maxPendingCommandResponseBytes: number;
	private readonly maxGatewayPendingCommandResponseBytes: number;
	private readonly maxGatewayOutboundBytes: number;
	private readonly maxConcurrentHistoryPages: number;
	private gatewayPendingCommandResponseBytes = 0;
	private gatewayOutboundBytes = 0;
	private readonly historyPageOperations = new Map<string, HistoryPageOperation>();
	private requestCounter = 0;
	private closePromise: Promise<void> | null = null;
	private readonly bashCommandIds = new Map<string, BashCommandIdMapping>();

	constructor(opts: SessionWsBridgeCoreOptions<M>) {
		this.supervisor = opts.supervisor;
		this.log = opts.log ?? (() => {});
		this.serverEpoch = opts.supervisor.serverEpoch;
		this.serverBuild = opts.serverBuild;
		const activation = opts.payloadActivation;
		assertBridgeActivation(activation, this.serverEpoch);
		this.payloadActivation = activation;
		const capabilities = [...opts.runtime.capabilities];
		if (!capabilities.includes(GATEWAY_PAYLOAD_BUDGET_CAPABILITY)) {
			capabilities.push(GATEWAY_PAYLOAD_BUDGET_CAPABILITY);
		}
		if (!capabilities.includes(GATEWAY_CONTENT_REF_CAPABILITY)) {
			capabilities.push(GATEWAY_CONTENT_REF_CAPABILITY);
		}
		if (!capabilities.includes(GATEWAY_FENCED_TAKEOVER_CAPABILITY)) {
			capabilities.push(GATEWAY_FENCED_TAKEOVER_CAPABILITY);
		}
		this.runtime = {
			...opts.runtime,
			capabilities,
		};
		this.helloTimeoutMs = Math.max(1, opts.helloTimeoutMs ?? 5_000);
		this.maxConnections = positiveLimit(opts.maxConnections, MAX_SESSION_WS_CONNECTIONS);
		this.maxSubscribedChannels = positiveLimit(
			opts.maxSubscribedChannels,
			MAX_SESSION_WS_SUBSCRIBED_CHANNELS,
		);
		this.maxConcurrentCatchUps = positiveLimit(
			opts.maxConcurrentCatchUps,
			MAX_SESSION_WS_CONCURRENT_CATCHUPS,
		);
		this.maxSubscriptionAliases = positiveLimit(
			opts.maxSubscriptionAliases,
			MAX_SESSION_WS_SUBSCRIPTION_ALIASES,
		);
		this.maxPendingCommandResponseBytes = positiveLimit(
			opts.maxPendingCommandResponseBytes,
			MAX_SESSION_WS_PENDING_COMMAND_RESPONSE_BYTES,
		);
		this.maxGatewayPendingCommandResponseBytes = positiveLimit(
			opts.maxGatewayPendingCommandResponseBytes,
			MAX_SESSION_WS_GATEWAY_PENDING_COMMAND_RESPONSE_BYTES,
		);
		this.maxGatewayOutboundBytes = positiveLimit(
			opts.maxGatewayOutboundBytes,
			MAX_SESSION_WS_GATEWAY_OUTBOUND_BYTES,
		);
		this.maxConcurrentHistoryPages = positiveLimit(
			opts.maxConcurrentHistoryPages,
			MAX_SESSION_WS_CONCURRENT_HISTORY_PAGES,
		);
		this.wss = new WebSocketServer({ noServer: true, maxPayload: SESSION_WS_CLIENT_MAX_BYTES });
		this.wss.on("connection", (ws) => this.handleConnection(ws));
		this.wss.on("error", (error) => this.log("error", `ws server error: ${String(error)}`));
		this.heartbeatTimer = setInterval(() => this.heartbeat(), opts.heartbeatIntervalMs ?? 30_000);
		this.heartbeatTimer.unref?.();
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		clearInterval(this.heartbeatTimer);
		for (const connection of [...this.connections]) {
			this.disconnect(connection);
			try {
				connection.ws.close();
			} catch {
				// The socket is already gone.
			}
		}
		this.closePromise = new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(forceTimer);
				if (error) reject(error);
				else resolve();
			};
			const forceTimer = setTimeout(() => {
				for (const client of this.wss.clients) {
					try {
						client.terminate();
					} catch {
						// The peer already closed during the grace period.
					}
				}
				// terminate() destroys every owned transport synchronously. Do not let
				// a missing close callback hold gateway shutdown indefinitely.
				finish();
			}, 250);
			try {
				this.wss.close((error) => finish(error));
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		return this.closePromise;
	}

	/** SessionSupervisor broadcast sink. */
	broadcast(message: BridgeSupervisorMessage<M>): void {
		if (message.type === "lease_transition") {
			this.broadcastLeaseTransition(message.transition);
			return;
		}
		if (message.type === "session_rekeyed") {
			this.broadcastRekey(message);
			return;
		}
		const sharedPayload = this.serializeMessage(message);
		for (const connection of this.connections) {
			if (connection.closed || !connection.helloComplete) continue;
			if (message.type === "runtime_state") {
				const history = connection.historySnapshots.get(message.runtime.sessionHandle);
				if (history && history.generation !== message.runtime.generation) {
					this.clearHistorySnapshot(connection, message.runtime.sessionHandle);
				}
			}
			const payload = this.payloadForConnection(connection, message, sharedPayload);
			const sessionHandle = this.broadcastSessionHandle(message);
			if (!sessionHandle) {
				this.sendPayload(connection, payload, message.type === "event");
				continue;
			}
			const catchUps = this.findCatchUps(connection, sessionHandle);
			if (catchUps.length > 0) {
				for (const catchUp of catchUps) {
					this.bufferCatchUpMessage(connection, catchUp, message, payload);
				}
				continue;
			}
			if (this.isSubscribed(connection, sessionHandle)) {
				this.sendPayload(connection, payload, message.type === "event");
				if (message.type === "runtime_state") {
					this.establishLiveOverflowRecovery(connection, message.runtime);
				}
			}
		}
	}

	private establishLiveOverflowRecovery(connection: ConnectionState<M>, runtime: SessionRuntimeDto): void {
		const current = this.supervisor.getRuntime(runtime.sessionHandle);
		if (
			runtime.error !== "session_snapshot_overflow" ||
			current?.generation !== runtime.generation ||
			current.error !== runtime.error ||
			current.state !== runtime.state ||
			connection.restartableOverflows.get(runtime.sessionHandle) === runtime.generation
		) {
			return;
		}
		connection.restartableOverflows.set(runtime.sessionHandle, runtime.generation);
		this.send(connection, {
			type: "resync_required",
			serverEpoch: this.serverEpoch,
			sessionHandle: runtime.sessionHandle,
			runtime,
			reason: "gap",
		});
		this.sendLease(connection, this.supervisor.leaseFor(runtime.sessionHandle, connection.connectionId));
	}

	broadcastHotRuntimeInventory(inventory: HotRuntimeInventoryDto): void {
		for (const connection of this.connections) {
			this.sendHotRuntimeInventory(connection, inventory);
		}
	}

	private broadcastSessionHandle(message: BridgeSupervisorMessage<M>): string | null {
		switch (message.type) {
			case "event":
			case "extension_ui_request":
			case "extension_ui_closed":
				return message.sessionHandle;
			case "runtime_state":
				return message.runtime.sessionHandle;
			case "session_directory_changed":
			case "auth_changed":
				return null;
			case "lease_transition":
				return message.transition.sessionHandle;
			case "session_rekeyed":
				return message.previousSessionHandle;
		}
	}

	private broadcastLeaseTransition(transition: SessionLeaseTransition): void {
		for (const connection of this.connections) {
			if (connection.closed || !connection.helloComplete) continue;
			const catchUps = this.findCatchUps(connection, transition.sessionHandle);
			if (catchUps.length > 0) {
				for (const catchUp of catchUps) this.deferCatchUpLease(connection, catchUp, transition);
				continue;
			}
			if (connection.pendingRekeyLeases.has(transition.sessionHandle)) {
				this.deferPendingRekeyLease(connection, transition);
				continue;
			}
			if (this.isSubscribed(connection, transition.sessionHandle)) {
				this.sendLeaseTransition(connection, transition);
			}
		}
	}

	private deferPendingRekeyLease(connection: ConnectionState<M>, transition: SessionLeaseTransition): void {
		const previous = connection.pendingRekeyLeases.get(transition.sessionHandle);
		if (!previous || transition.leaseRevision > previous.leaseRevision) {
			connection.pendingRekeyLeases.set(transition.sessionHandle, transition);
			return;
		}
		if (transition.leaseRevision < previous.leaseRevision) return;
		if (!sameLeaseTransition(previous, transition)) {
			this.closeForPolicyViolation(connection, "conflicting Session lease revision");
		}
	}

	private deferCatchUpLease(
		connection: ConnectionState<M>,
		catchUp: SessionCatchUp<M>,
		transition: SessionLeaseTransition,
	): void {
		if (catchUp.currentHandle !== transition.sessionHandle) return;
		const previous = catchUp.pendingLease;
		if (!previous || transition.leaseRevision > previous.leaseRevision) {
			catchUp.pendingLease = transition;
			return;
		}
		if (transition.leaseRevision < previous.leaseRevision) return;
		if (!sameLeaseTransition(previous, transition)) {
			this.closeForPolicyViolation(connection, "conflicting Session lease revision");
		}
	}

	private leaseViewForConnection(
		connection: ConnectionState<M>,
		transition: SessionLeaseTransition,
	): SessionLeaseSnapshot {
		const isController = transition.ownerConnectionId === connection.connectionId;
		return {
			serverEpoch: transition.serverEpoch,
			sessionHandle: transition.sessionHandle,
			generation: transition.generation,
			leaseRevision: transition.leaseRevision,
			controlState: transition.controlState,
			transition: transition.transition,
			isController,
			...(isController && transition.fencingToken ? { fencingToken: transition.fencingToken } : {}),
		};
	}

	private sendLeaseTransition(connection: ConnectionState<M>, transition: SessionLeaseTransition): void {
		this.sendLease(connection, this.leaseViewForConnection(connection, transition));
	}

	private broadcastRekey(message: Extract<BridgeSupervisorMessage<M>, { type: "session_rekeyed" }>): void {
		const payload = this.serializeMessage(message);
		for (const connection of this.connections) {
			if (connection.closed) continue;
			const catchUps = this.findCatchUps(connection, message.previousSessionHandle);
			for (const catchUp of catchUps) {
				catchUp.currentHandle = message.runtime.sessionHandle;
				catchUp.handles.add(message.runtime.sessionHandle);
				catchUp.rekeyVersion += 1;
				catchUp.pendingLease = undefined;
				this.bufferCatchUpMessage(connection, catchUp, message, payload);
			}
			this.clearHistorySnapshot(connection, message.previousSessionHandle);
			const wasSubscribed = this.migrateLiveSubscription(
				connection,
				message.previousSessionHandle,
				message.runtime.sessionHandle,
			);
			if (wasSubscribed) {
				connection.pendingRekeyLeases.delete(message.previousSessionHandle);
				connection.pendingRekeyLeases.set(message.runtime.sessionHandle, undefined);
			}
			if (connection.controlledSessions.delete(message.previousSessionHandle)) {
				connection.controlledSessions.add(message.runtime.sessionHandle);
			}
			const restartGeneration = connection.restartableOverflows.get(message.previousSessionHandle);
			if (restartGeneration !== undefined) {
				connection.restartableOverflows.delete(message.previousSessionHandle);
				connection.restartableOverflows.set(message.runtime.sessionHandle, restartGeneration);
			}
			const controlIntent = connection.controlIntents.get(message.previousSessionHandle);
			if (controlIntent) {
				connection.controlIntents.delete(message.previousSessionHandle);
				connection.controlIntents.set(message.runtime.sessionHandle, controlIntent);
			}
			if (wasSubscribed && catchUps.length === 0) {
				this.sendPayload(connection, payload);
			}
		}
	}

	private handleConnection(ws: WebSocket): void {
		if (this.connections.size >= this.maxConnections) {
			this.log("warn", `rejecting WebSocket connection: gateway capacity (${this.maxConnections})`);
			try {
				ws.close(1013, "gateway capacity");
			} catch {
				try {
					ws.terminate();
				} catch {
					// The peer is already gone.
				}
			}
			return;
		}
		const connection: ConnectionState<M> = {
			connectionId: randomUUID(),
			ws,
			subscriptions: new Set(),
			subscriptionAliases: new Map(),
			catchUps: new Set(),
			pendingRekeyLeases: new Map(),
			catchUpSmallBufferedBytes: 0,
			catchUpLargeItems: 0,
			nextCatchUpOrder: 0,
			controlledSessions: new Set(),
			controlIntents: new Map(),
			nextControlIntentRevision: 0,
			pendingCommands: new Set(),
			pendingCommandResponseBytes: 0,
			outboundQueue: [],
			outboundSmallQueuedBytes: 0,
			outboundLargeItems: 0,
			outboundHistoryQueuedBytes: 0,
			outboundSending: false,
			alive: true,
			closed: false,
			epoch: 0,
			helloComplete: false,
			hotInventoryNegotiated: false,
			historyNegotiated: false,
			historySnapshots: new Map(),
			historyPages: new Map(),
			restartableOverflows: new Map(),
			hotInventoryRevision: -1,
			admittedExactOperations: 0,
			negotiatedMaxServerFrameBytes: MAX_SESSION_WS_FRAME_BYTES,
		};
		this.connections.add(connection);
		connection.helloTimer = setTimeout(() => {
			if (connection.closed || connection.helloComplete) return;
			try {
				connection.ws.close(1008, "client hello timeout");
			} finally {
				this.disconnect(connection);
			}
		}, this.helloTimeoutMs);
		connection.helloTimer.unref?.();
		this.log("info", `ws connected (${this.connections.size} open)`);

		ws.on("pong", () => {
			connection.alive = true;
		});
		ws.on("message", (raw, isBinary) => {
			if (isBinary) {
				this.closeForPolicyViolation(connection, "binary WebSocket frames are not supported");
				return;
			}
			void this.handleClientMessage(connection, raw.toString()).catch((error) => {
				this.log("warn", `ws message handling failed: ${String(error)}`);
				this.closeForPolicyViolation(connection, "invalid WebSocket message");
			});
		});
		ws.on("close", () => {
			this.disconnect(connection);
		});
		ws.on("error", () => {
			// The close handler owns cleanup.
		});
	}

	private async handleClientMessage(connection: ConnectionState<M>, raw: string): Promise<void> {
		if (connection.closed) return;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			this.closeForPolicyViolation(connection, "invalid JSON");
			return;
		}
		if (!connection.helloComplete) {
			this.handleClientHello(connection, value);
			return;
		}
		if (!isSessionWsClientMessage(value)) {
			this.closeForPolicyViolation(connection, "invalid client frame");
			return;
		}
		const message: SessionWsClientMessage = value;

		switch (message.type) {
			case "session_subscribe":
				await this.subscribe(connection, message.sessionHandle, message.cursor, message.expectedHotRuntime);
				return;
			case "session_unsubscribe":
				await this.unsubscribe(connection, message.sessionHandle);
				return;
			case "session_claim":
				await this.claim(connection, message.sessionHandle);
				return;
			case "session_release":
				await this.release(connection, message.sessionHandle);
				return;
			case "session_takeover":
				await this.takeover(connection, message);
				return;
			case "session_restart":
				await this.handleRestart(connection, message);
				return;
			case "command":
				await this.handleCommand(connection, message);
				return;
			case "extension_ui_response":
				await this.handleExtensionUiResponse(connection, message);
				return;
			case "session_history_page":
				await this.handleHistoryPage(connection, message);
				return;
			case "session_history_cancel":
				this.cancelHistoryPage(connection, message);
				return;
		}
	}

	private handleClientHello(connection: ConnectionState<M>, value: unknown): void {
		if (!isGatewayClientHello(value)) {
			const code = hasUnsupportedGatewayProtocolMajor(value)
				? "protocol_major_unsupported"
				: typeof value === "object" && value !== null && "type" in value && value.type === "client_hello"
					? "invalid_hello"
					: "hello_required";
			this.sendProtocolErrorAndClose(connection, code);
			return;
		}

		const requestedCapabilities = new Set(value.capabilities);
		if (
			GATEWAY_CLIENT_REQUIRED_CAPABILITIES.some(
				(capability) =>
					!requestedCapabilities.has(capability) || !this.runtime.capabilities.includes(capability),
			) ||
			GATEWAY_SERVER_REQUIRED_CAPABILITIES.some(
				(capability) => !this.runtime.capabilities.includes(capability),
			)
		) {
			this.sendProtocolErrorAndClose(connection, "capability_unsupported");
			return;
		}
		connection.negotiatedMaxServerFrameBytes = Math.min(
			value.limits.maxServerFrameBytes,
			MAX_SESSION_WS_FRAME_BYTES,
		);
		const negotiatedCapabilities = this.runtime.capabilities.filter((capability) =>
			requestedCapabilities.has(capability),
		);
		const hello: GatewayServerHelloDto = {
			type: "server_hello",
			protocol: GATEWAY_PROTOCOL_VERSION,
			serverBuild: this.serverBuild,
			serverEpoch: this.serverEpoch,
			piVersion: this.runtime.version,
			adapterId: this.runtime.adapterId,
			capabilities: negotiatedCapabilities,
			limits: {
				maxClientFrameBytes: SESSION_WS_CLIENT_MAX_BYTES,
				maxSnapshotFrameBytes: connection.negotiatedMaxServerFrameBytes,
				maxExtensionRequests: 128,
			},
			payloadBudget: this.payloadActivation.context.payloadBudget,
			contentRefBudget: this.payloadActivation.context.contentRefBudget,
		};
		const payloadNegotiation = negotiateGatewayHello(value, hello);
		if (payloadNegotiation.negotiated === false) {
			this.sendProtocolErrorAndClose(connection, "capability_unsupported");
			return;
		}
		const hasInventoryCapability =
			value.capabilities.includes(GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY) &&
			hello.capabilities.includes(GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY);
		const inventoryFrameFits =
			value.limits.maxServerFrameBytes >= SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES &&
			hello.limits.maxSnapshotFrameBytes >= SESSION_HOT_RUNTIME_INVENTORY_MAX_BYTES;
		if (hasInventoryCapability && !inventoryFrameFits) {
			this.sendProtocolErrorAndClose(connection, "capability_unsupported");
			return;
		}

		connection.helloComplete = true;
		connection.hotInventoryNegotiated = hasInventoryCapability;
		connection.historyNegotiated =
			value.capabilities.includes(GATEWAY_SESSION_HISTORY_CAPABILITY) &&
			hello.capabilities.includes(GATEWAY_SESSION_HISTORY_CAPABILITY);
		if (connection.helloTimer) clearTimeout(connection.helloTimer);
		connection.helloTimer = undefined;
		this.sendPayload(connection, JSON.stringify(hello));
		if (hasInventoryCapability) {
			this.sendHotRuntimeInventory(connection, this.supervisor.getHotRuntimeInventory());
		}
	}

	private sendProtocolErrorAndClose(
		connection: ConnectionState<M>,
		code: GatewayProtocolErrorDto["code"],
	): void {
		if (connection.closed) return;
		const message: GatewayProtocolErrorDto = {
			type: "protocol_error",
			code,
			supported: {
				major: GATEWAY_PROTOCOL_VERSION.major,
				minMinor: GATEWAY_PROTOCOL_VERSION.minor,
				maxMinor: GATEWAY_PROTOCOL_VERSION.minor,
			},
		};
		try {
			connection.ws.send(JSON.stringify(message), () => {
				if (connection.closed) return;
				try {
					connection.ws.close(1008, "protocol incompatible");
				} finally {
					this.disconnect(connection);
				}
			});
		} catch {
			this.disconnect(connection);
		}
	}

	private async subscribe(
		connection: ConnectionState<M>,
		sessionHandle: string,
		cursor?: SessionReplayCursorDto,
		expectedHotRuntime?: SessionRuntimeIdentityDto,
	): Promise<void> {
		if (expectedHotRuntime && !connection.hotInventoryNegotiated) {
			this.sendSessionError(connection, sessionHandle, "subscribe", "hot_runtime_inventory_not_negotiated");
			return;
		}
		if (expectedHotRuntime) {
			if (
				this.isSubscribed(connection, sessionHandle) ||
				this.findCatchUps(connection, sessionHandle).length > 0
			) {
				return;
			}
			if (connection.admittedExactOperations >= MAX_SESSION_WS_IN_FLIGHT_EXACT_SUBSCRIPTIONS) {
				this.sendSessionError(
					connection,
					sessionHandle,
					"subscribe",
					"too_many_in_flight_exact_subscriptions",
				);
				return;
			}
			connection.admittedExactOperations += 1;
		}
		const lifecycleEpoch = connection.epoch;
		const admission = this.beginCatchUp(connection, sessionHandle, expectedHotRuntime !== undefined);
		if (!admission.catchUp) {
			if (expectedHotRuntime) connection.admittedExactOperations -= 1;
			if (!connection.closed && admission.reason) {
				this.sendSessionError(connection, sessionHandle, "subscribe", admission.reason);
			}
			return;
		}
		const catchUp = admission.catchUp;
		try {
			let historySnapshot: HistorySnapshot<M> | undefined;
			let observedRekeyVersion = catchUp.rekeyVersion;
			let exactObservationToken: HotRuntimeSubscriptionToken | undefined;
			let result: BridgeReplayResult<M>;
			if (expectedHotRuntime) {
				const exact = await this.supervisor.subscribeHotExact(expectedHotRuntime, cursor);
				exactObservationToken = exact.observationToken;
				result = exact;
			} else {
				result = await this.supervisor.subscribe(sessionHandle, cursor);
			}
			if (!this.isCurrentCatchUp(connection, catchUp, lifecycleEpoch)) return;
			if (
				expectedHotRuntime &&
				(catchUp.rekeyVersion !== observedRekeyVersion ||
					catchUp.currentHandle !== expectedHotRuntime.sessionHandle)
			) {
				throw new RpcError("session_subscribe", "hot_runtime_identity_changed");
			}
			if (expectedHotRuntime) {
				if (
					!exactObservationToken ||
					!this.supervisor.revalidateHotExactSubscription(exactObservationToken)
				) {
					throw new RpcError("session_subscribe", "hot_runtime_identity_changed");
				}
				if (
					!this.adoptCatchUpHandle(connection, catchUp, result.runtime.sessionHandle, observedRekeyVersion)
				) {
					return;
				}
			} else if (
				!this.adoptCatchUpHandle(connection, catchUp, result.runtime.sessionHandle, observedRekeyVersion)
			) {
				return;
			}

			// A concurrent fork/clone can rekey the runtime while activation is
			// awaited. Anchor the catch-up to the newest identity before publishing
			// any baseline; the old cursor cannot describe the child generation.
			while (!expectedHotRuntime && catchUp.currentHandle !== result.runtime.sessionHandle) {
				observedRekeyVersion = catchUp.rekeyVersion;
				result = await this.supervisor.subscribe(catchUp.currentHandle);
				if (!this.isCurrentCatchUp(connection, catchUp, lifecycleEpoch)) return;
				if (
					!this.adoptCatchUpHandle(connection, catchUp, result.runtime.sessionHandle, observedRekeyVersion)
				) {
					return;
				}
			}

			const resolvedHandle = result.runtime.sessionHandle;
			if (catchUp.requestedHandle !== resolvedHandle) {
				this.send(connection, {
					type: "session_rekeyed",
					serverEpoch: this.serverEpoch,
					previousSessionHandle: catchUp.requestedHandle,
					runtime: result.runtime,
				});
			}
			this.send(connection, { type: "runtime_state", runtime: result.runtime });
			if (result.type === "resync_required") {
				if (result.chunkedSnapshot && !connection.historyNegotiated) {
					throw new RpcError("session_subscribe", "session_history_unsupported");
				}
				this.send(connection, {
					type: "resync_required",
					serverEpoch: this.serverEpoch,
					sessionHandle: resolvedHandle,
					runtime: result.runtime,
					reason: result.reason === "server_epoch_changed" ? "epoch_changed" : result.reason,
				});
				if (result.chunkedSnapshot) {
					historySnapshot = {
						snapshotId: result.snapshot.snapshotId,
						workspaceId: result.snapshot.workspaceId,
						generation: result.snapshot.generation,
						asOfSeq: result.snapshot.asOfSeq,
						chunked: result.chunkedSnapshot,
					};
					this.sendChunkedSnapshot(connection, result.snapshot, result.chunkedSnapshot);
				} else {
					this.send(connection, result.snapshot as BridgeServerMessage<M>);
				}
			} else {
				for (const frame of result.frames) this.send(connection, frame as BridgeServerMessage<M>);
			}
			connection.restartableOverflows.delete(resolvedHandle);

			if (!this.isCurrentCatchUp(connection, catchUp, lifecycleEpoch)) return;
			const buffered = [...catchUp.buffered];
			const pendingLease = catchUp.pendingLease;
			const baselineMarker = this.findBaselineMarker(buffered, result.runtime);
			this.establishLiveSubscription(connection, catchUp, resolvedHandle);
			if (historySnapshot) connection.historySnapshots.set(resolvedHandle, historySnapshot);
			if (pendingLease) this.sendLeaseTransition(connection, pendingLease);
			else this.sendLease(connection, this.supervisor.leaseFor(resolvedHandle, connection.connectionId));
			for (const [index, entry] of buffered.entries()) {
				if (
					this.isNonReplayableCatchUpMessage(entry.message) ||
					this.isNewerThanBaseline(entry.message, result.runtime, index, baselineMarker)
				) {
					this.sendPayload(connection, entry.payload, entry.message.type === "event");
					if (entry.message.type === "runtime_state") {
						this.establishLiveOverflowRecovery(connection, entry.message.runtime);
					}
				}
			}
			this.flushDeferredHotInventory(connection);
		} catch (error) {
			if (!this.isCurrentCatchUp(connection, catchUp, lifecycleEpoch)) return;
			const retainedOverflow = this.establishOverflowRecoverySubscription(connection, catchUp, error);
			if (!retainedOverflow && catchUp.exactTransactional) this.rollbackExactCatchUp(connection, catchUp);
			else if (!retainedOverflow) {
				this.enqueueBufferedRekeys(connection, catchUp);
				this.cancelCatchUp(connection, catchUp);
			}
			this.sendSessionError(connection, sessionHandle, "subscribe", error);
			this.flushDeferredHotInventory(connection);
		} finally {
			if (expectedHotRuntime) {
				connection.admittedExactOperations = Math.max(0, connection.admittedExactOperations - 1);
			}
		}
	}

	private establishOverflowRecoverySubscription(
		connection: ConnectionState<M>,
		catchUp: SessionCatchUp<M>,
		error: unknown,
	): boolean {
		if (
			catchUp.exactTransactional ||
			sessionErrorCode(this.errorText(error)) !== "session_snapshot_overflow"
		) {
			return false;
		}
		const runtime = this.supervisor.getRuntime(catchUp.currentHandle);
		if (runtime?.error !== "session_snapshot_overflow") return false;
		if (!this.adoptCatchUpHandle(connection, catchUp, runtime.sessionHandle, catchUp.rekeyVersion)) {
			return false;
		}
		this.send(connection, { type: "runtime_state", runtime });
		this.send(connection, {
			type: "resync_required",
			serverEpoch: this.serverEpoch,
			sessionHandle: runtime.sessionHandle,
			runtime,
			reason: "gap",
		});
		const buffered = [...catchUp.buffered];
		const pendingLease = catchUp.pendingLease;
		const baselineMarker = this.findBaselineMarker(buffered, runtime);
		this.establishLiveSubscription(connection, catchUp, runtime.sessionHandle);
		connection.restartableOverflows.set(runtime.sessionHandle, runtime.generation);
		if (pendingLease) this.sendLeaseTransition(connection, pendingLease);
		else this.sendLease(connection, this.supervisor.leaseFor(runtime.sessionHandle, connection.connectionId));
		for (const [index, entry] of buffered.entries()) {
			if (
				this.isNonReplayableCatchUpMessage(entry.message) ||
				this.isNewerThanBaseline(entry.message, runtime, index, baselineMarker)
			) {
				this.sendPayload(connection, entry.payload, entry.message.type === "event");
				if (entry.message.type === "runtime_state") {
					this.establishLiveOverflowRecovery(connection, entry.message.runtime);
				}
			}
		}
		return true;
	}

	private sendChunkedSnapshot(
		connection: ConnectionState<M>,
		snapshot: BridgeSnapshot<M>,
		chunked: BridgeChunkedSnapshot<M>,
	): void {
		const messages = snapshot.settledMessages;
		const chunks = splitHistoryMessages<BridgeSnapshot<M>["settledMessages"][number]>(
			messages,
			this.maxHistoryChunkBytes(connection),
			this.maxHistorySingleMessageBytes(connection),
		);
		const identity = historyIdentity(snapshot);
		this.send(connection, {
			type: "session_snapshot_begin",
			...identity,
			snapshotId: snapshot.snapshotId,
			baseSeq: snapshot.baseSeq,
			asOfSeq: snapshot.asOfSeq,
			runtime: snapshot.runtime,
			projectionEvents: snapshot.projectionEvents,
			queue: snapshot.queue,
			pendingExtensionRequests: snapshot.pendingExtensionRequests,
			stickyExtensionState: snapshot.stickyExtensionState,
			history: chunked.history,
		} as BridgeServerMessage<M>);
		const chunkChecksums: string[] = [];
		for (const [chunkIndex, chunk] of chunks.entries()) {
			const checksum = sessionHistoryChecksum(chunk);
			chunkChecksums.push(checksum);
			this.send(connection, {
				type: "session_snapshot_chunk",
				...identity,
				snapshotId: snapshot.snapshotId,
				chunkIndex,
				messages: chunk,
				itemCount: chunk.length,
				byteCount: sessionHistoryMessagesBytes(chunk),
				checksum,
			} as BridgeServerMessage<M>);
		}
		this.send(connection, {
			type: "session_snapshot_end",
			...identity,
			snapshotId: snapshot.snapshotId,
			chunkCount: chunks.length,
			itemCount: messages.length,
			byteCount: sessionHistoryMessagesBytes(messages),
			checksum: sessionHistoryChecksum(chunkChecksums),
			nextCursor: chunked.history.nextCursor,
		} as BridgeServerMessage<M>);
	}

	private async handleHistoryPage(
		connection: ConnectionState<M>,
		message: Extract<SessionWsClientMessage, { type: "session_history_page" }>,
	): Promise<void> {
		if (!connection.historyNegotiated) {
			this.sendSessionError(connection, message.sessionHandle, "history_page", "session_history_unsupported");
			return;
		}
		const sessionHandle = this.connectionSessionHandle(connection, message.sessionHandle);
		if (!this.isSubscribed(connection, sessionHandle)) {
			this.sendSessionError(connection, message.sessionHandle, "history_page", "session_not_subscribed");
			return;
		}
		const history = connection.historySnapshots.get(sessionHandle);
		if (
			!history ||
			history.snapshotId !== message.snapshotId ||
			history.generation !== message.expectedGeneration ||
			history.asOfSeq !== message.asOfSeq
		) {
			this.sendSessionError(
				connection,
				message.sessionHandle,
				"history_page",
				"session_history_snapshot_stale",
			);
			return;
		}
		const existing = connection.historyPages.get(message.id);
		if (existing) {
			this.releaseHistoryPage(connection, existing, true);
		}
		const currentSessionOperation = this.historyPageOperations.get(sessionHandle);
		if (currentSessionOperation) {
			if (currentSessionOperation.connectionId === connection.connectionId) {
				this.releaseHistoryPage(connection, currentSessionOperation, true);
			}
			this.sendSessionError(connection, message.sessionHandle, "history_page", "session_history_busy");
			return;
		}
		if (this.historyPageOperations.size >= this.maxConcurrentHistoryPages) {
			this.sendSessionError(connection, message.sessionHandle, "history_page", "session_history_capacity");
			return;
		}
		let targetBytes: number;
		try {
			targetBytes = history.chunked.pageTargetBytes(message.cursor, message.limit);
		} catch (error) {
			this.sendSessionError(connection, message.sessionHandle, "history_page", error);
			return;
		}
		if (
			!Number.isSafeInteger(targetBytes) ||
			targetBytes < 0 ||
			this.gatewayOutboundBytes + targetBytes > this.maxGatewayOutboundBytes
		) {
			this.sendSessionError(connection, message.sessionHandle, "history_page", "session_history_capacity");
			return;
		}
		const operation: HistoryPageOperation = {
			sessionHandle,
			requestId: message.id,
			connectionId: connection.connectionId,
			controller: new AbortController(),
			retainedBytes: targetBytes,
			retained: true,
		};
		this.gatewayOutboundBytes += targetBytes;
		connection.historyPages.set(message.id, operation);
		this.historyPageOperations.set(sessionHandle, operation);
		try {
			const page = await history.chunked
				.readPage(message.cursor, message.limit, operation.controller.signal)
				.finally(() => this.releaseHistoryPageBytes(operation));
			if (!this.isCurrentHistoryPage(connection, operation, history)) return;
			const chunks = splitHistoryMessages(
				page.messages,
				this.maxHistoryChunkBytes(connection),
				this.maxHistorySingleMessageBytes(connection),
			);
			const identity = {
				serverEpoch: this.serverEpoch,
				sessionHandle,
				workspaceId: history.workspaceId,
				generation: history.generation,
			};
			const historyMetadata = {
				totalMessages: page.totalMessages,
				loadedMessages: page.messages.length,
				loadedBytes: sessionHistoryMessagesBytes(page.messages),
				totalBytes: Math.max(page.totalBytes, sessionHistoryMessagesBytes(page.messages)),
				nextCursor: page.nextCursor,
			};
			this.send(connection, {
				type: "session_history_page_begin",
				...identity,
				requestId: message.id,
				snapshotId: history.snapshotId,
				asOfSeq: history.asOfSeq,
				cursor: message.cursor,
				history: historyMetadata,
			} as BridgeServerMessage<M>);
			const chunkChecksums: string[] = [];
			for (const [chunkIndex, chunk] of chunks.entries()) {
				const checksum = sessionHistoryChecksum(chunk);
				chunkChecksums.push(checksum);
				this.send(connection, {
					type: "session_history_page_chunk",
					...identity,
					requestId: message.id,
					snapshotId: history.snapshotId,
					chunkIndex,
					messages: chunk,
					itemCount: chunk.length,
					byteCount: sessionHistoryMessagesBytes(chunk),
					checksum,
				} as BridgeServerMessage<M>);
			}
			this.send(connection, {
				type: "session_history_page_end",
				...identity,
				requestId: message.id,
				snapshotId: history.snapshotId,
				chunkCount: chunks.length,
				itemCount: page.messages.length,
				byteCount: sessionHistoryMessagesBytes(page.messages),
				checksum: sessionHistoryChecksum(chunkChecksums),
				nextCursor: page.nextCursor,
			} as BridgeServerMessage<M>);
		} catch (error) {
			if (this.isCurrentHistoryPage(connection, operation, history) && !operation.controller.signal.aborted) {
				this.sendSessionError(connection, message.sessionHandle, "history_page", error);
			}
		} finally {
			this.settleHistoryPage(connection, operation);
		}
	}

	private cancelHistoryPage(
		connection: ConnectionState<M>,
		message: Extract<SessionWsClientMessage, { type: "session_history_cancel" }>,
	): void {
		const sessionHandle = this.connectionSessionHandle(connection, message.sessionHandle);
		const operation = connection.historyPages.get(message.id);
		const history = connection.historySnapshots.get(sessionHandle);
		if (
			operation &&
			operation.sessionHandle === sessionHandle &&
			history?.snapshotId === message.snapshotId &&
			history.generation === message.expectedGeneration
		) {
			this.releaseHistoryPage(connection, operation, true);
		}
	}

	private isCurrentHistoryPage(
		connection: ConnectionState<M>,
		operation: HistoryPageOperation,
		history: HistorySnapshot<M>,
	): boolean {
		return (
			!connection.closed &&
			this.connections.has(connection) &&
			connection.historyPages.get(operation.requestId) === operation &&
			connection.subscriptions.has(operation.sessionHandle) &&
			connection.historySnapshots.get(operation.sessionHandle) === history
		);
	}

	private clearHistorySnapshot(connection: ConnectionState<M>, sessionHandle: string): void {
		connection.historySnapshots.delete(sessionHandle);
		for (const operation of [...connection.historyPages.values()]) {
			if (operation.sessionHandle !== sessionHandle) continue;
			this.releaseHistoryPage(connection, operation, true);
		}
	}

	private releaseHistoryPage(
		connection: ConnectionState<M>,
		operation: HistoryPageOperation,
		abort: boolean,
	): void {
		if (connection.historyPages.get(operation.requestId) === operation) {
			connection.historyPages.delete(operation.requestId);
		}
		if (abort && !operation.controller.signal.aborted) operation.controller.abort();
	}

	private settleHistoryPage(connection: ConnectionState<M>, operation: HistoryPageOperation): void {
		this.releaseHistoryPageBytes(operation);
		this.releaseHistoryPage(connection, operation, false);
		if (this.historyPageOperations.get(operation.sessionHandle) === operation) {
			this.historyPageOperations.delete(operation.sessionHandle);
		}
	}

	private releaseHistoryPageBytes(operation: HistoryPageOperation): void {
		if (!operation.retained) return;
		operation.retained = false;
		this.gatewayOutboundBytes = Math.max(0, this.gatewayOutboundBytes - operation.retainedBytes);
	}

	private maxHistoryChunkBytes(connection: ConnectionState<M>): number {
		return Math.max(
			1,
			Math.min(
				DEFAULT_SESSION_HISTORY_CHUNK_TARGET_BYTES,
				SESSION_HISTORY_MAX_CHUNK_BYTES,
				connection.negotiatedMaxServerFrameBytes - 256 * 1024,
			),
		);
	}

	private maxHistorySingleMessageBytes(connection: ConnectionState<M>): number {
		return Math.max(
			1,
			Math.min(SESSION_HISTORY_MAX_CHUNK_BYTES, connection.negotiatedMaxServerFrameBytes - 256 * 1024),
		);
	}

	private beginCatchUp(
		connection: ConnectionState<M>,
		requestedHandle: string,
		exactHotRuntime = false,
	): {
		catchUp: SessionCatchUp<M> | null;
		reason?: "session_subscription_capacity" | "session_catchup_capacity";
	} {
		if (connection.closed) return { catchUp: null };
		const activeHandle = exactHotRuntime
			? requestedHandle
			: (this.supervisor.getRuntime(requestedHandle)?.sessionHandle ?? requestedHandle);
		const handles = new Set([requestedHandle, activeHandle]);
		const replacedCatchUps = exactHotRuntime
			? []
			: [...connection.catchUps].filter((existing) =>
					[...handles].some((handle) => existing.handles.has(handle)),
				);
		if (this.totalCatchUps() - replacedCatchUps.length + 1 > this.maxConcurrentCatchUps) {
			return { catchUp: null, reason: "session_catchup_capacity" };
		}
		const replacedLiveSubscription =
			!exactHotRuntime && [...handles].some((handle) => connection.subscriptions.has(handle)) ? 1 : 0;
		if (
			this.totalSubscriptionChannels() - replacedCatchUps.length - replacedLiveSubscription + 1 >
			this.maxSubscribedChannels
		) {
			return { catchUp: null, reason: "session_subscription_capacity" };
		}
		if (exactHotRuntime) {
			const catchUp: SessionCatchUp<M> = {
				requestedHandle,
				currentHandle: requestedHandle,
				handles: new Set([requestedHandle]),
				buffered: [],
				bufferedSmallBytes: 0,
				bufferedLargeItems: 0,
				order: ++connection.nextCatchUpOrder,
				rekeyVersion: 0,
				exactTransactional: true,
			};
			connection.catchUps.add(catchUp);
			this.adoptPendingRekeyLease(connection, catchUp);
			return { catchUp };
		}
		// An explicit subscribe to a fork parent is not a stale reference to the
		// child. Clear only that stale-unsubscribe alias and preserve the child as
		// an independent live subscription.
		connection.subscriptionAliases.delete(requestedHandle);
		const catchUp: SessionCatchUp<M> = {
			requestedHandle,
			currentHandle: activeHandle,
			handles,
			buffered: [],
			bufferedSmallBytes: 0,
			bufferedLargeItems: 0,
			order: ++connection.nextCatchUpOrder,
			rekeyVersion: 0,
			exactTransactional: false,
		};
		connection.catchUps.add(catchUp);
		this.adoptPendingRekeyLease(connection, catchUp);
		for (const existing of [...connection.catchUps]) {
			if (existing === catchUp) continue;
			if ([...handles].some((handle) => existing.handles.has(handle))) {
				this.transferCatchUpJournalAndCancel(connection, existing, catchUp);
			}
		}
		this.removeLiveSubscription(connection, activeHandle);
		return { catchUp };
	}

	private adoptPendingRekeyLease(connection: ConnectionState<M>, catchUp: SessionCatchUp<M>): void {
		if (!connection.pendingRekeyLeases.has(catchUp.currentHandle)) return;
		const pendingLease = connection.pendingRekeyLeases.get(catchUp.currentHandle);
		connection.pendingRekeyLeases.delete(catchUp.currentHandle);
		if (pendingLease) catchUp.pendingLease = pendingLease;
	}

	private totalSubscriptionChannels(): number {
		let total = 0;
		for (const connection of this.connections)
			total += connection.subscriptions.size + connection.catchUps.size;
		return total;
	}

	private totalCatchUps(): number {
		let total = 0;
		for (const connection of this.connections) total += connection.catchUps.size;
		return total;
	}

	private async unsubscribe(connection: ConnectionState<M>, sessionHandle: string): Promise<void> {
		const canonicalHandle = this.connectionSessionHandle(connection, sessionHandle);
		this.invalidateControlIntent(connection, canonicalHandle);
		connection.restartableOverflows.delete(sessionHandle);
		connection.restartableOverflows.delete(canonicalHandle);
		connection.pendingRekeyLeases.delete(sessionHandle);
		connection.pendingRekeyLeases.delete(canonicalHandle);
		for (const catchUp of [...connection.catchUps]) {
			if (
				catchUp.requestedHandle === sessionHandle ||
				catchUp.currentHandle === canonicalHandle ||
				catchUp.handles.has(sessionHandle) ||
				catchUp.handles.has(canonicalHandle)
			) {
				this.enqueueBufferedRekeys(connection, catchUp);
				this.cancelCatchUp(connection, catchUp);
			}
		}
		this.removeLiveSubscription(connection, canonicalHandle);
		const release = await this.supervisor.releaseWithTransition(canonicalHandle, connection.connectionId);
		connection.controlledSessions.delete(canonicalHandle);
		connection.controlledSessions.delete(sessionHandle);
		if (release.transition) this.broadcastLeaseTransition(release.transition);
		this.flushDeferredHotInventory(connection);
	}

	private adoptCatchUpHandle(
		connection: ConnectionState<M>,
		catchUp: SessionCatchUp<M>,
		resolvedHandle: string,
		observedRekeyVersion: number,
	): boolean {
		catchUp.handles.add(resolvedHandle);
		if (catchUp.rekeyVersion === observedRekeyVersion) catchUp.currentHandle = resolvedHandle;
		for (const other of [...connection.catchUps]) {
			if (other === catchUp || !other.handles.has(resolvedHandle)) continue;
			if (other.order > catchUp.order) {
				this.transferCatchUpJournalAndCancel(connection, catchUp, other);
				return false;
			}
			this.transferCatchUpJournalAndCancel(connection, other, catchUp);
		}
		this.removeLiveSubscription(connection, resolvedHandle);
		return connection.catchUps.has(catchUp);
	}

	private isCurrentCatchUp(
		connection: ConnectionState<M>,
		catchUp: SessionCatchUp<M>,
		lifecycleEpoch: number,
	): boolean {
		return (
			!connection.closed &&
			connection.epoch === lifecycleEpoch &&
			this.connections.has(connection) &&
			connection.catchUps.has(catchUp)
		);
	}

	private findCatchUp(connection: ConnectionState<M>, sessionHandle: string): SessionCatchUp<M> | undefined {
		let match: SessionCatchUp<M> | undefined;
		for (const catchUp of connection.catchUps) {
			if (!catchUp.handles.has(sessionHandle)) continue;
			if (!match || catchUp.order > match.order) match = catchUp;
		}
		return match;
	}

	private findCatchUps(connection: ConnectionState<M>, sessionHandle: string): SessionCatchUp<M>[] {
		return [...connection.catchUps]
			.filter((catchUp) => catchUp.handles.has(sessionHandle))
			.sort((left, right) => left.order - right.order);
	}

	private bufferCatchUpMessage(
		connection: ConnectionState<M>,
		catchUp: SessionCatchUp<M>,
		message: BridgeSupervisorMessage<M>,
		payload: string,
	): void {
		if (!connection.catchUps.has(catchUp) || connection.closed) return;
		const bytes = Buffer.byteLength(payload);
		const large = this.classifyPayload(connection, bytes, message.type === "event");
		if (large === undefined) return;
		if (this.gatewayOutboundBytes + bytes > this.maxGatewayOutboundBytes) {
			this.closeForPolicyViolation(connection, "gateway outbound capacity");
			return;
		}
		if (large) {
			if (connection.catchUpLargeItems >= 1) {
				this.closeForPolicyViolation(connection, "Session catch-up buffer exceeded its limit");
				return;
			}
			catchUp.bufferedLargeItems += 1;
			connection.catchUpLargeItems += 1;
		} else {
			if (connection.catchUpSmallBufferedBytes + bytes > MAX_SESSION_WS_BUFFERED_BYTES) {
				this.closeForPolicyViolation(connection, "Session catch-up buffer exceeded its limit");
				return;
			}
			catchUp.bufferedSmallBytes += bytes;
			connection.catchUpSmallBufferedBytes += bytes;
		}
		this.gatewayOutboundBytes += bytes;
		catchUp.buffered.push({ message, payload, bytes, retained: true });
	}

	private cancelCatchUp(connection: ConnectionState<M>, catchUp: SessionCatchUp<M>): void {
		if (!connection.catchUps.delete(catchUp)) return;
		connection.catchUpSmallBufferedBytes = Math.max(
			0,
			connection.catchUpSmallBufferedBytes - catchUp.bufferedSmallBytes,
		);
		connection.catchUpLargeItems = Math.max(0, connection.catchUpLargeItems - catchUp.bufferedLargeItems);
		for (const entry of catchUp.buffered) this.releaseBufferedCatchUpMessage(entry);
		catchUp.buffered = [];
		catchUp.bufferedSmallBytes = 0;
		catchUp.bufferedLargeItems = 0;
	}

	private rollbackExactCatchUp(connection: ConnectionState<M>, catchUp: SessionCatchUp<M>): void {
		this.enqueueBufferedRekeys(connection, catchUp);
		this.cancelCatchUp(connection, catchUp);
	}

	private enqueueBufferedRekeys(connection: ConnectionState<M>, catchUp: SessionCatchUp<M>): void {
		for (const entry of catchUp.buffered) {
			if (entry.message.type !== "session_rekeyed") continue;
			this.releaseBufferedCatchUpMessage(entry);
			this.sendPayload(connection, entry.payload);
		}
	}

	private releaseBufferedCatchUpMessage(entry: BufferedCatchUpMessage<M>): void {
		if (!entry.retained) return;
		entry.retained = false;
		this.gatewayOutboundBytes = Math.max(0, this.gatewayOutboundBytes - entry.bytes);
	}

	private transferCatchUpJournalAndCancel(
		connection: ConnectionState<M>,
		from: SessionCatchUp<M>,
		to: SessionCatchUp<M>,
	): void {
		const retained = from.buffered.filter(
			(entry) =>
				entry.message.type === "session_rekeyed" || this.isNonReplayableCatchUpMessage(entry.message),
		);
		const pendingLease = from.pendingLease;
		this.cancelCatchUp(connection, from);
		for (const entry of retained) {
			if (to.buffered.some((existing) => existing.payload === entry.payload)) continue;
			this.bufferCatchUpMessage(connection, to, entry.message, entry.payload);
		}
		if (pendingLease) this.deferCatchUpLease(connection, to, pendingLease);
	}

	private establishLiveSubscription(
		connection: ConnectionState<M>,
		catchUp: SessionCatchUp<M>,
		resolvedHandle: string,
	): void {
		this.cancelCatchUp(connection, catchUp);
		this.removeLiveSubscription(connection, resolvedHandle);
		connection.subscriptions.add(resolvedHandle);
		for (const alias of catchUp.handles) this.rememberSubscriptionAlias(connection, alias, resolvedHandle);
		this.rememberSubscriptionAlias(connection, resolvedHandle, resolvedHandle);
	}

	private removeLiveSubscription(connection: ConnectionState<M>, sessionHandle: string): boolean {
		this.clearHistorySnapshot(connection, sessionHandle);
		const deleted = connection.subscriptions.delete(sessionHandle);
		for (const [alias, current] of connection.subscriptionAliases) {
			if (current === sessionHandle) connection.subscriptionAliases.delete(alias);
		}
		return deleted;
	}

	private migrateLiveSubscription(
		connection: ConnectionState<M>,
		previousHandle: string,
		nextHandle: string,
	): boolean {
		if (!connection.subscriptions.delete(previousHandle)) return false;
		connection.subscriptions.add(nextHandle);
		for (const [alias, current] of connection.subscriptionAliases) {
			if (current === previousHandle) connection.subscriptionAliases.set(alias, nextHandle);
		}
		this.rememberSubscriptionAlias(connection, previousHandle, nextHandle);
		this.rememberSubscriptionAlias(connection, nextHandle, nextHandle);
		return true;
	}

	private rememberSubscriptionAlias(
		connection: ConnectionState<M>,
		alias: string,
		currentHandle: string,
	): void {
		if (connection.subscriptionAliases.has(alias)) {
			connection.subscriptionAliases.set(alias, currentHandle);
			return;
		}
		while (connection.subscriptionAliases.size >= this.maxSubscriptionAliases) {
			const oldest = connection.subscriptionAliases.keys().next().value;
			if (typeof oldest !== "string") return;
			connection.subscriptionAliases.delete(oldest);
		}
		connection.subscriptionAliases.set(alias, currentHandle);
	}

	private isSubscribed(connection: ConnectionState<M>, sessionHandle: string): boolean {
		return connection.subscriptions.has(sessionHandle);
	}

	private findBaselineMarker(buffered: BufferedCatchUpMessage<M>[], baseline: SessionRuntimeDto): number {
		let marker = -1;
		for (const [index, entry] of buffered.entries()) {
			if (entry.message.type !== "runtime_state") continue;
			const runtime = entry.message.runtime;
			if (
				runtime.sessionHandle === baseline.sessionHandle &&
				runtime.generation === baseline.generation &&
				runtime.lastSeq === baseline.lastSeq &&
				runtime.state === baseline.state &&
				runtime.error === baseline.error
			) {
				marker = index;
			}
		}
		return marker;
	}

	private isNewerThanBaseline(
		message: BridgeSupervisorMessage<M>,
		baseline: SessionRuntimeDto,
		bufferIndex: number,
		baselineMarker: number,
	): boolean {
		if (message.type === "session_rekeyed") return false;
		if (message.type === "lease_transition") return false;
		if (message.type === "session_directory_changed" || message.type === "auth_changed") return false;
		const generation = message.type === "runtime_state" ? message.runtime.generation : message.generation;
		const seq = message.type === "runtime_state" ? message.runtime.lastSeq : message.seq;
		if (generation !== baseline.generation) return generation > baseline.generation;
		if (seq !== baseline.lastSeq) return seq > baseline.lastSeq;
		if (message.type !== "runtime_state") return false;
		if (bufferIndex <= baselineMarker) return false;
		return !(
			message.runtime.sessionHandle === baseline.sessionHandle &&
			message.runtime.state === baseline.state &&
			message.runtime.error === baseline.error
		);
	}

	private isNonReplayableCatchUpMessage(message: BridgeSupervisorMessage<M>): boolean {
		return message.type === "extension_ui_request" && message.request.method === "notify";
	}

	private async claim(connection: ConnectionState<M>, sessionHandle: string): Promise<void> {
		if (connection.pendingRekeyLeases.has(sessionHandle) || !this.isSubscribed(connection, sessionHandle)) {
			this.sendSessionError(connection, sessionHandle, "claim", "session_not_subscribed");
			return;
		}
		const intent = this.recordControlIntent(connection, sessionHandle);
		if (!intent) return;
		const intentRevision = intent.revision;
		const lifecycleEpoch = connection.epoch;
		let leaseHandle = sessionHandle;
		try {
			const claimed = await this.supervisor.claimWithTransition(sessionHandle, connection.connectionId);
			const { lease, transition } = claimed;
			leaseHandle = lease.sessionHandle;
			const currentIntent =
				connection.controlIntents.get(lease.sessionHandle) ?? connection.controlIntents.get(sessionHandle);
			const connectionExpired =
				connection.closed || connection.epoch !== lifecycleEpoch || !this.connections.has(connection);
			const intentExpired = currentIntent !== intent || currentIntent.revision !== intentRevision;
			if (connectionExpired || intentExpired || !this.isSubscribed(connection, lease.sessionHandle)) {
				if (lease.isController && lease.fencingToken) {
					const canonicalHandle =
						connection.subscriptionAliases.get(lease.sessionHandle) ?? lease.sessionHandle;
					const release = await this.supervisor.releaseExactWithTransition(
						canonicalHandle,
						connection.connectionId,
						lease.fencingToken,
					);
					if (release.transition) this.broadcastLeaseTransition(release.transition);
				}
				return;
			}
			if (lease.isController) connection.controlledSessions.add(lease.sessionHandle);
			if (transition) this.broadcastLeaseTransition(transition);
			else this.sendLease(connection, lease);
		} catch (error) {
			if (connection.closed || connection.epoch !== lifecycleEpoch) return;
			this.sendSessionError(connection, sessionHandle, "claim", error);
		} finally {
			this.clearControlIntent(connection, intent, sessionHandle, leaseHandle);
		}
	}

	private async release(connection: ConnectionState<M>, sessionHandle: string): Promise<void> {
		try {
			const canonicalHandle = this.connectionSessionHandle(connection, sessionHandle);
			this.invalidateControlIntent(connection, canonicalHandle);
			const release = await this.supervisor.releaseWithTransition(canonicalHandle, connection.connectionId);
			connection.controlledSessions.delete(sessionHandle);
			connection.controlledSessions.delete(canonicalHandle);
			if (release.transition) this.broadcastLeaseTransition(release.transition);
			else this.sendLease(connection, this.supervisor.leaseFor(canonicalHandle, connection.connectionId));
		} catch (error) {
			this.sendSessionError(connection, sessionHandle, "release", error);
		}
	}

	private async takeover(
		connection: ConnectionState<M>,
		message: Extract<SessionWsClientMessage, { type: "session_takeover" }>,
	): Promise<void> {
		if (
			connection.pendingRekeyLeases.has(message.sessionHandle) ||
			!this.isSubscribed(connection, message.sessionHandle)
		) {
			const runtime = this.supervisor.getRuntime(message.sessionHandle);
			this.sendSessionError(
				connection,
				message.sessionHandle,
				"takeover",
				runtime && runtime.sessionHandle !== message.sessionHandle
					? "session_handle_stale"
					: "session_not_subscribed",
			);
			return;
		}
		const lifecycleEpoch = connection.epoch;
		try {
			const transition = await this.supervisor.takeover(
				message.sessionHandle,
				message.expectedGeneration,
				message.expectedLeaseRevision,
				connection.connectionId,
			);
			if (
				connection.closed ||
				connection.epoch !== lifecycleEpoch ||
				!this.connections.has(connection) ||
				!this.isSubscribed(connection, transition.sessionHandle)
			) {
				if (transition.fencingToken) {
					const release = await this.supervisor.releaseExactWithTransition(
						transition.sessionHandle,
						connection.connectionId,
						transition.fencingToken,
					);
					if (release.transition) this.broadcastLeaseTransition(release.transition);
				}
				return;
			}
			connection.controlledSessions.add(transition.sessionHandle);
			this.broadcastLeaseTransition(transition);
		} catch (error) {
			if (connection.closed || connection.epoch !== lifecycleEpoch) return;
			this.sendSessionError(connection, message.sessionHandle, "takeover", error);
		}
	}

	private recordControlIntent(
		connection: ConnectionState<M>,
		sessionHandle: string,
	): ControlIntent | undefined {
		const canonicalHandle = this.connectionSessionHandle(connection, sessionHandle);
		if (connection.controlIntents.has(canonicalHandle)) return undefined;
		const intent: ControlIntent = {
			revision: ++connection.nextControlIntentRevision,
		};
		connection.controlIntents.set(canonicalHandle, intent);
		if (sessionHandle !== canonicalHandle) connection.controlIntents.delete(sessionHandle);
		return intent;
	}

	private invalidateControlIntent(connection: ConnectionState<M>, sessionHandle: string): void {
		const canonicalHandle = this.connectionSessionHandle(connection, sessionHandle);
		connection.controlIntents.delete(sessionHandle);
		connection.controlIntents.delete(canonicalHandle);
	}

	private clearControlIntent(
		connection: ConnectionState<M>,
		intent: ControlIntent,
		...sessionHandles: string[]
	): void {
		for (const sessionHandle of sessionHandles) {
			const canonicalHandle = this.connectionSessionHandle(connection, sessionHandle);
			if (connection.controlIntents.get(sessionHandle) === intent) {
				connection.controlIntents.delete(sessionHandle);
			}
			if (connection.controlIntents.get(canonicalHandle) === intent) {
				connection.controlIntents.delete(canonicalHandle);
			}
		}
	}

	private async handleRestart(
		connection: ConnectionState<M>,
		message: Extract<SessionWsClientMessage, { type: "session_restart" }>,
	): Promise<void> {
		const runtime = this.supervisor.getRuntime(message.sessionHandle);
		const sessionHandle =
			runtime?.sessionHandle ?? this.connectionSessionHandle(connection, message.sessionHandle);
		if (connection.restartableOverflows.get(sessionHandle) !== message.expectedGeneration) {
			this.sendSessionError(connection, message.sessionHandle, "restart", "session_restart_not_available");
			return;
		}
		const lifecycleEpoch = connection.epoch;
		connection.restartableOverflows.delete(sessionHandle);
		try {
			const restarted = await this.supervisor.restart(sessionHandle, {
				connectionId: connection.connectionId,
				expectedGeneration: message.expectedGeneration,
				fencingToken: message.fencingToken,
			});
			const subscribers = [...this.connections].filter(
				(candidate) => !candidate.closed && this.isSubscribed(candidate, restarted.sessionHandle),
			);
			await Promise.all(subscribers.map((candidate) => this.subscribe(candidate, restarted.sessionHandle)));
		} catch (error) {
			const current = this.supervisor.getRuntime(sessionHandle);
			if (
				!connection.closed &&
				connection.epoch === lifecycleEpoch &&
				this.connections.has(connection) &&
				this.isSubscribed(connection, sessionHandle) &&
				current?.generation === message.expectedGeneration &&
				current.error === "session_snapshot_overflow"
			) {
				connection.restartableOverflows.set(current.sessionHandle, current.generation);
			}
			this.sendSessionError(connection, message.sessionHandle, "restart", error);
		}
	}

	private async handleCommand(
		connection: ConnectionState<M>,
		message: Extract<SessionWsClientMessage, { type: "command" }>,
	): Promise<void> {
		if (!this.isSubscribed(connection, message.sessionHandle)) {
			this.sendCommandError(connection, message, "session_not_subscribed");
			return;
		}
		if (connection.pendingCommands.size >= MAX_SESSION_WS_IN_FLIGHT_COMMANDS) {
			this.sendCommandError(connection, message, "too_many_in_flight_commands");
			return;
		}
		const responseWeight = commandResponseReservationBytes(message.command.type);
		if (connection.pendingCommandResponseBytes + responseWeight > this.maxPendingCommandResponseBytes) {
			this.sendCommandError(connection, message, "pending_command_response_capacity");
			return;
		}
		if (
			this.gatewayPendingCommandResponseBytes + responseWeight >
			this.maxGatewayPendingCommandResponseBytes
		) {
			this.sendCommandError(connection, message, "gateway_pending_command_response_capacity");
			return;
		}

		const internalId = this.nextInternalId(connection);
		const clientId = message.command.id;
		connection.pendingCommands.add(internalId);
		connection.pendingCommandResponseBytes += responseWeight;
		this.gatewayPendingCommandResponseBytes += responseWeight;
		let reservationReleased = false;
		const releaseReservation = () => {
			if (reservationReleased) return;
			reservationReleased = true;
			connection.pendingCommandResponseBytes = Math.max(
				0,
				connection.pendingCommandResponseBytes - responseWeight,
			);
			this.gatewayPendingCommandResponseBytes = Math.max(
				0,
				this.gatewayPendingCommandResponseBytes - responseWeight,
			);
		};
		let reservationTransferred = false;
		const command = { ...message.command, id: internalId } as SessionCommandDto;
		if (command.type === "bash" && clientId) {
			this.bashCommandIds.set(internalId, { connectionId: connection.connectionId, clientId });
		}
		try {
			const result = await this.supervisor.sendCommand(message.sessionHandle, command, {
				connectionId: connection.connectionId,
				expectedGeneration: message.expectedGeneration,
				fencingToken: message.fencingToken,
			});
			const responseFrame = {
				type: "response",
				serverEpoch: result.serverEpoch,
				sessionHandle: result.sessionHandle,
				generation: result.generation,
				barrierSeq: result.barrierSeq,
				response: this.restoreClientId(result.response, clientId),
				...(result.previousSessionHandle ? { previousSessionHandle: result.previousSessionHandle } : {}),
			} as BridgeServerMessage<M>;
			reservationTransferred = this.send(connection, responseFrame, releaseReservation);
		} catch (error) {
			reservationTransferred = this.sendCommandError(connection, message, error, releaseReservation);
			this.log("warn", `command ${message.command.type} failed: ${this.errorText(error)}`);
		} finally {
			this.bashCommandIds.delete(internalId);
			connection.pendingCommands.delete(internalId);
			if (!reservationTransferred) releaseReservation();
		}
	}

	private async handleExtensionUiResponse(
		connection: ConnectionState<M>,
		message: Extract<SessionWsClientMessage, { type: "extension_ui_response" }>,
	): Promise<void> {
		if (!this.isSubscribed(connection, message.sessionHandle)) {
			this.sendSessionError(
				connection,
				message.sessionHandle,
				"extension_ui_response",
				"session_not_subscribed",
			);
			return;
		}
		try {
			const outcome = await this.supervisor.sendExtensionUiResponse(message.sessionHandle, message.response, {
				connectionId: connection.connectionId,
				expectedGeneration: message.expectedGeneration,
				fencingToken: message.fencingToken,
			});
			this.send(connection, {
				type: "extension_ui_result",
				serverEpoch: this.serverEpoch,
				sessionHandle: message.sessionHandle,
				generation: message.expectedGeneration,
				requestId: message.response.id,
				outcome,
			});
		} catch (error) {
			this.sendSessionError(connection, message.sessionHandle, "extension_ui_response", error);
		}
	}

	private sendCommandError(
		connection: ConnectionState<M>,
		message: Extract<SessionWsClientMessage, { type: "command" }>,
		error: unknown,
		release?: () => void,
	): boolean {
		const runtime = this.supervisor.getRuntime(message.sessionHandle);
		const admissionError = error instanceof RpcError ? error.admissionError : undefined;
		return this.send(
			connection,
			{
				type: "response",
				serverEpoch: this.serverEpoch,
				sessionHandle: runtime?.sessionHandle ?? message.sessionHandle,
				generation: runtime?.generation ?? message.expectedGeneration ?? 0,
				barrierSeq: runtime?.lastSeq ?? 0,
				response: {
					...(message.command.id ? { id: message.command.id } : {}),
					type: "response",
					command: message.command.type,
					success: false,
					error: this.errorText(error),
					...(admissionError ? { admissionError } : {}),
				},
			},
			release,
		);
	}

	private sendSessionError(
		connection: ConnectionState<M>,
		sessionHandle: string,
		operation: Extract<BridgeServerMessage<M>, { type: "session_error" }>["operation"],
		error: unknown,
	): void {
		const errorText = this.errorText(error);
		const code = sessionErrorCode(errorText);
		this.send(connection, {
			type: "session_error",
			serverEpoch: this.serverEpoch,
			sessionHandle,
			operation,
			error: errorText,
			code,
			retryable:
				(operation === "subscribe" && RETRYABLE_SESSION_ERROR_CODES.has(code)) ||
				(operation === "history_page" && RETRYABLE_HISTORY_ERROR_CODES.has(code)) ||
				(operation === "takeover" &&
					["session_not_subscribed", "session_generation_stale", "session_lease_revision_stale"].includes(
						code,
					)),
		});
	}

	private nextInternalId(connection: ConnectionState<M>): string {
		this.requestCounter += 1;
		return `bridge-${connection.connectionId}-${this.requestCounter.toString(36)}`;
	}

	private restoreClientId(response: BridgeResponse<M>, clientId: string | undefined): BridgeResponse<M> {
		const { id: _internalId, ...rest } = response;
		return clientId ? ({ ...rest, id: clientId } as BridgeResponse<M>) : (rest as BridgeResponse<M>);
	}

	private disconnect(connection: ConnectionState<M>): Promise<void> {
		if (connection.disconnectCompletion) return connection.disconnectCompletion;
		if (connection.closed) return Promise.resolve();
		connection.closed = true;
		if (connection.helloTimer) clearTimeout(connection.helloTimer);
		connection.helloTimer = undefined;
		connection.hotInventoryNegotiated = false;
		connection.historyNegotiated = false;
		connection.deferredHotInventory = undefined;
		connection.epoch += 1;
		this.connections.delete(connection);
		for (const catchUp of [...connection.catchUps]) this.cancelCatchUp(connection, catchUp);
		for (const operation of [...connection.historyPages.values()]) {
			this.releaseHistoryPage(connection, operation, true);
		}
		connection.historySnapshots.clear();
		connection.restartableOverflows.clear();
		connection.pendingRekeyLeases.clear();
		connection.disconnectCompletion = this.releaseDisconnectedLeases(connection.connectionId);
		connection.subscriptions.clear();
		connection.subscriptionAliases.clear();
		connection.controlledSessions.clear();
		connection.controlIntents.clear();
		connection.pendingCommands.clear();
		connection.pendingCommandResponseBytes = 0;
		if (connection.outboundActive) this.releaseOutboundPayload(connection.outboundActive);
		connection.outboundActive = undefined;
		for (const item of connection.outboundQueue) this.releaseOutboundPayload(item);
		connection.outboundQueue = [];
		connection.outboundSmallQueuedBytes = 0;
		connection.outboundLargeItems = 0;
		connection.outboundHistoryQueuedBytes = 0;
		connection.outboundSending = false;
		this.log("info", `ws disconnected (${this.connections.size} open)`);
		return connection.disconnectCompletion;
	}

	private async releaseDisconnectedLeases(connectionId: string): Promise<void> {
		try {
			const released = await this.supervisor.releaseConnectionWithTransitions(connectionId);
			for (const transition of released.transitions) this.broadcastLeaseTransition(transition);
		} catch (error) {
			this.log("warn", `lease cleanup failed for disconnected socket: ${this.errorText(error)}`);
		}
	}

	private heartbeat(): void {
		for (const connection of this.connections) {
			if (!connection.alive) {
				try {
					connection.ws.terminate();
				} finally {
					this.disconnect(connection);
				}
				continue;
			}
			connection.alive = false;
			try {
				connection.ws.ping();
			} catch {
				// The close handler owns cleanup.
			}
		}
	}

	private closeForPolicyViolation(connection: ConnectionState<M>, reason: string): void {
		if (connection.closed) return;
		this.log("warn", `closing ws ${connection.connectionId}: ${reason}`);
		try {
			if (
				connection.ws.readyState === connection.ws.OPEN ||
				connection.ws.readyState === connection.ws.CONNECTING
			) {
				connection.ws.close(1008, "policy violation");
			}
		} finally {
			this.disconnect(connection);
		}
	}

	private sendLease(connection: ConnectionState<M>, lease: SessionLeaseSnapshot): void {
		if (lease.isController) connection.controlledSessions.add(lease.sessionHandle);
		else connection.controlledSessions.delete(lease.sessionHandle);
		this.send(connection, { type: "lease_status", ...lease });
	}

	private sendHotRuntimeInventory(connection: ConnectionState<M>, inventory: HotRuntimeInventoryDto): void {
		if (
			connection.closed ||
			!connection.helloComplete ||
			!connection.hotInventoryNegotiated ||
			inventory.serverEpoch !== this.serverEpoch ||
			inventory.revision <= connection.hotInventoryRevision
		) {
			return;
		}
		if (connection.deferredHotInventory || this.hasPendingCatchUpRekey(connection)) {
			if (!connection.deferredHotInventory || inventory.revision > connection.deferredHotInventory.revision) {
				connection.deferredHotInventory = inventory;
			}
			return;
		}
		connection.hotInventoryRevision = inventory.revision;
		this.send(connection, inventory);
	}

	private hasPendingCatchUpRekey(connection: ConnectionState<M>): boolean {
		for (const catchUp of connection.catchUps) {
			if (catchUp.buffered.some((entry) => entry.message.type === "session_rekeyed")) return true;
		}
		return false;
	}

	private flushDeferredHotInventory(connection: ConnectionState<M>): void {
		if (this.hasPendingCatchUpRekey(connection)) return;
		const inventory = connection.deferredHotInventory;
		connection.deferredHotInventory = undefined;
		if (inventory) this.sendHotRuntimeInventory(connection, inventory);
	}

	private send(
		connection: ConnectionState<M>,
		message: BridgeServerMessage<M>,
		release?: () => void,
	): boolean {
		const history =
			message.type === "session_snapshot_begin" ||
			message.type === "session_snapshot_chunk" ||
			message.type === "session_snapshot_end" ||
			message.type === "session_history_page_begin" ||
			message.type === "session_history_page_chunk" ||
			message.type === "session_history_page_end";
		return this.sendPayload(
			connection,
			this.payloadForConnection(connection, message),
			message.type === "event" ||
				message.type === "response" ||
				message.type === "session_snapshot" ||
				message.type === "session_snapshot_begin" ||
				message.type === "session_snapshot_chunk" ||
				message.type === "session_history_page_chunk",
			history,
			release,
		);
	}

	private connectionSessionHandle(connection: ConnectionState<M>, sessionHandle: string): string {
		const subscribedHandle = connection.subscriptionAliases.get(sessionHandle);
		if (subscribedHandle) return subscribedHandle;
		return this.findCatchUp(connection, sessionHandle)?.currentHandle ?? sessionHandle;
	}

	private payloadForConnection(
		connection: ConnectionState<M>,
		message: BridgeServerMessage<M> | BridgeSupervisorMessage<M>,
		sharedPayload?: string,
	): string {
		if (message.type !== "event" || message.event.type !== "bash_execution_update" || !message.event.id) {
			return sharedPayload ?? this.serializeMessage(message);
		}
		const mapping = this.bashCommandIds.get(message.event.id);
		if (!mapping || mapping.connectionId !== connection.connectionId) {
			return sharedPayload ?? this.serializeMessage(message);
		}
		return this.serializeMessage({
			...message,
			event: { ...message.event, id: mapping.clientId },
		});
	}

	private serializeMessage(message: BridgeServerMessage<M> | BridgeSupervisorMessage<M>): string {
		return serializeBridgeMessage(message, this.payloadActivation);
	}

	private classifyPayload(
		connection: ConnectionState<M>,
		bytes: number,
		allowLarge: boolean,
	): boolean | undefined {
		if (bytes > MAX_SESSION_WS_FRAME_BYTES) {
			this.closeForPolicyViolation(connection, "oversized WebSocket frame");
			return undefined;
		}
		if (connection.helloComplete && bytes > connection.negotiatedMaxServerFrameBytes) {
			this.closeForPolicyViolation(connection, "frame exceeds negotiated client limit");
			return undefined;
		}
		const large = bytes > MAX_SESSION_WS_BUFFERED_BYTES;
		if (large && !allowLarge) {
			this.closeForPolicyViolation(connection, "oversized WebSocket frame");
			return undefined;
		}
		return large;
	}

	private sendPayload(
		connection: ConnectionState<M>,
		payload: string,
		allowLarge = false,
		history = false,
		release?: () => void,
	): boolean {
		if (connection.closed || connection.ws.readyState !== connection.ws.OPEN) {
			release?.();
			return false;
		}
		const bytes = Buffer.byteLength(payload);
		const large = this.classifyPayload(connection, bytes, allowLarge);
		if (large === undefined) {
			release?.();
			return false;
		}
		if (!history && large && connection.outboundLargeItems >= 1) {
			this.closeForPolicyViolation(connection, "slow WebSocket client");
			release?.();
			return false;
		}
		if (history && connection.outboundHistoryQueuedBytes + bytes > SESSION_HISTORY_MAX_STREAM_BYTES) {
			this.closeForPolicyViolation(connection, "history stream exceeded its outbound limit");
			release?.();
			return false;
		}
		if (connection.outboundSending) {
			if (!history && !large && connection.outboundSmallQueuedBytes + bytes > MAX_SESSION_WS_BUFFERED_BYTES) {
				this.closeForPolicyViolation(connection, "slow WebSocket client");
				release?.();
				return false;
			}
			const item = this.retainOutboundPayload(connection, payload, bytes, large, history, release);
			if (!item) return false;
			if (history) connection.outboundHistoryQueuedBytes += bytes;
			else if (large) connection.outboundLargeItems += 1;
			else connection.outboundSmallQueuedBytes += bytes;
			connection.outboundQueue.push(item);
			return true;
		}
		if (connection.ws.bufferedAmount > MAX_SESSION_WS_BUFFERED_BYTES) {
			this.closeForPolicyViolation(connection, "slow WebSocket client");
			release?.();
			return false;
		}
		const item = this.retainOutboundPayload(connection, payload, bytes, large, history, release);
		if (!item) return false;
		if (history) connection.outboundHistoryQueuedBytes += bytes;
		else if (large) connection.outboundLargeItems += 1;
		this.startPayloadSend(connection, item);
		return true;
	}

	private retainOutboundPayload(
		connection: ConnectionState<M>,
		payload: string,
		bytes: number,
		large: boolean,
		history: boolean,
		release?: () => void,
	): OutboundPayload | undefined {
		if (this.gatewayOutboundBytes + bytes > this.maxGatewayOutboundBytes) {
			this.closeForPolicyViolation(connection, "gateway outbound capacity");
			release?.();
			return undefined;
		}
		this.gatewayOutboundBytes += bytes;
		return { payload, bytes, large, history, release, retained: true };
	}

	private releaseOutboundPayload(item: OutboundPayload): void {
		if (item.retained) {
			item.retained = false;
			this.gatewayOutboundBytes = Math.max(0, this.gatewayOutboundBytes - item.bytes);
		}
		item.release?.();
		item.release = undefined;
	}

	private startPayloadSend(connection: ConnectionState<M>, item: OutboundPayload): void {
		connection.outboundSending = true;
		connection.outboundActive = item;
		try {
			connection.ws.send(item.payload, (error) => {
				this.releaseOutboundPayload(item);
				if (connection.outboundActive === item) connection.outboundActive = undefined;
				if (connection.closed) return;
				connection.outboundSending = false;
				if (item.history) {
					connection.outboundHistoryQueuedBytes = Math.max(
						0,
						connection.outboundHistoryQueuedBytes - item.bytes,
					);
				} else if (item.large) {
					connection.outboundLargeItems = Math.max(0, connection.outboundLargeItems - 1);
				}
				if (error) {
					this.log("warn", `WebSocket send failed: ${this.errorText(error)}`);
					this.disconnect(connection);
					return;
				}
				const next = connection.outboundQueue.shift();
				if (!next) return;
				if (!next.history && !next.large) {
					connection.outboundSmallQueuedBytes = Math.max(0, connection.outboundSmallQueuedBytes - next.bytes);
				}
				if (connection.ws.bufferedAmount > MAX_SESSION_WS_BUFFERED_BYTES) {
					this.releaseOutboundPayload(next);
					this.closeForPolicyViolation(connection, "slow WebSocket client");
					return;
				}
				this.startPayloadSend(connection, next);
			});
		} catch {
			this.releaseOutboundPayload(item);
			if (connection.outboundActive === item) connection.outboundActive = undefined;
			this.disconnect(connection);
		}
	}

	private errorText(error: unknown): string {
		return error instanceof RpcError ? error.message : error instanceof Error ? error.message : String(error);
	}
}

function assertBridgeActivation(value: BridgeActivation, serverEpoch: string): void {
	const { context, externalizer, supervisorServices } = value;
	const canonicalPayloadBudget =
		JSON.stringify(context.payloadBudget) === JSON.stringify(SESSION_PAYLOAD_BUDGET);
	const canonicalContentRefBudget =
		JSON.stringify(context.contentRefBudget) === JSON.stringify(SESSION_CONTENT_REF_BUDGET);
	if (
		!isSessionContentRefGuardContext(context) ||
		context.serverEpoch !== serverEpoch ||
		!canonicalPayloadBudget ||
		!canonicalContentRefBudget ||
		externalizer.mode !== "content_ref" ||
		externalizer.context !== context ||
		supervisorServices.mode !== "content_ref" ||
		supervisorServices.externalizer !== externalizer ||
		supervisorServices.productSchema.mode !== "content_ref" ||
		supervisorServices.productSchema.serverEpoch !== serverEpoch
	) {
		throw new TypeError("Session WebSocket payload activation is invalid");
	}
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) ? Math.min(fallback, Math.max(1, Math.floor(value as number))) : fallback;
}

function sessionErrorCode(errorText: string): string {
	const match = /^([a-z][a-z0-9_]{0,127})(?::|$)/.exec(errorText);
	return match?.[1] ?? "session_error";
}

function sameLeaseTransition(left: SessionLeaseTransition, right: SessionLeaseTransition): boolean {
	return (
		left.serverEpoch === right.serverEpoch &&
		left.sessionHandle === right.sessionHandle &&
		left.generation === right.generation &&
		left.leaseRevision === right.leaseRevision &&
		left.controlState === right.controlState &&
		left.transition === right.transition &&
		left.ownerConnectionId === right.ownerConnectionId &&
		left.fencingToken === right.fencingToken
	);
}

function historyIdentity<M extends SessionRuntimeProductMode>(snapshot: BridgeSnapshot<M>) {
	return {
		serverEpoch: snapshot.serverEpoch,
		sessionHandle: snapshot.sessionHandle,
		workspaceId: snapshot.workspaceId,
		generation: snapshot.generation,
	};
}

function splitHistoryMessages<T>(
	messages: readonly T[],
	maxBytes: number,
	maxSingleMessageBytes = maxBytes,
): T[][] {
	const chunks: T[][] = [];
	let current: T[] = [];
	for (const message of messages) {
		const single = [message];
		const singleBytes = sessionHistoryMessagesBytes(single);
		const candidate = [...current, message];
		if (
			current.length > 0 &&
			(current.length >= SESSION_HISTORY_MAX_CHUNK_MESSAGES ||
				sessionHistoryMessagesBytes(candidate) > maxBytes)
		) {
			chunks.push(current);
			current = [];
		}
		if (current.length === 0 && singleBytes > maxBytes) {
			if (singleBytes > maxSingleMessageBytes) {
				throw new RpcError("session_history", "session_history_message_too_large");
			}
			current = single;
			continue;
		}
		const next = [...current, message];
		if (sessionHistoryMessagesBytes(next) > maxBytes) {
			throw new RpcError("session_history", "session_history_message_too_large");
		}
		current = next;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

function serializeBridgeMessage(message: unknown, activation: BridgeActivation): string {
	if (!isSessionWsServerMessage(message, activation.context)) {
		throw new TypeError("Session WebSocket message failed its exact context guard");
	}
	const schema = activation.supervisorServices.productSchema;
	if (message.type === "event") {
		if (!schema.guardEvent(message.event)) {
			throw new TypeError("Session event failed its product provenance guard");
		}
		assertLogicalBytes(() => schema.activeTurnEventLogicalBytes(message.event), "event");
	}
	if (message.type === "extension_ui_request") {
		if (!schema.guardExtensionRequest(message.request)) {
			throw new TypeError("Session Extension request failed its product provenance guard");
		}
		assertLogicalBytes(() => schema.extensionRequestLogicalBytes(message.request), "Extension request");
	}
	if (message.type === "extension_ui_snapshot") {
		for (const request of message.requests) {
			if (!schema.guardExtensionRequest(request)) {
				throw new TypeError("Session Extension snapshot failed its product provenance guard");
			}
			assertLogicalBytes(() => schema.extensionRequestLogicalBytes(request), "Extension snapshot request");
		}
	}
	if (message.type === "session_snapshot") {
		if (!schema.guardSnapshot(message)) {
			throw new TypeError("Session snapshot failed its product provenance guard");
		}
		assertLogicalBytes(() => schema.snapshotLogicalBytes(message), "snapshot");
	}
	if (message.type === "session_snapshot_chunk" || message.type === "session_history_page_chunk") {
		for (const historyMessage of message.messages) {
			if (!schema.guardMessage(historyMessage)) {
				throw new TypeError("Session history message failed its product provenance guard");
			}
			assertLogicalBytes(
				() =>
					analyzeSessionMessageLogicalBytes(historyMessage, {
						maxBytes: schema.maxSnapshotLogicalBytes,
					}).byteLength,
				"history message",
			);
		}
	}
	if (message.type === "response") {
		assertLogicalBytes(
			() =>
				analyzeSessionResponseFrameLogicalBytes(message, { maxBytes: schema.maxSnapshotLogicalBytes })
					.byteLength,
			"response",
		);
	}
	const payload = JSON.stringify(message);
	if (typeof payload !== "string") throw new TypeError("Session WebSocket message is not serializable");
	const bytes = Buffer.byteLength(payload);
	if (message.type === "event" && bytes > schema.maxNormalizedEventWireBytes) {
		throw new TypeError("Session event exceeded its normalized wire budget");
	}
	if (
		message.type === "event" ||
		message.type === "extension_ui_request" ||
		message.type === "extension_ui_closed"
	) {
		if (bytes > schema.maxReplayFrameWireBytes) {
			throw new TypeError("Session replay frame exceeded its wire budget");
		}
	}
	if (message.type === "session_snapshot" && bytes > schema.maxSnapshotCanonicalWireBytes) {
		throw new TypeError("Session snapshot exceeded its canonical wire budget");
	}
	return payload;
}

function assertLogicalBytes(read: () => number, label: string): void {
	try {
		read();
	} catch (error) {
		throw new TypeError(`Session ${label} exceeded its logical content budget`, { cause: error });
	}
}

export class SessionWsBridge extends SessionWsBridgeCore<"content_ref"> {}
