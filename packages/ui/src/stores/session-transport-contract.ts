import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type {
	SessionReplayCursorDto,
	SessionReplayFrameDto,
	SessionRuntimeDto,
	SessionWsServerMessage,
} from "@pi-agent-web/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { OrderedSessionFrameBus, SessionTransportGlobalBus } from "./session-frame-bus";

export type SessionTransportConnectionState = "idle" | "connecting" | "online" | "offline";

export interface SessionLeaseState {
	isController: boolean;
	fencingToken?: string;
}

export interface SessionResyncState {
	reason: Extract<SessionWsServerMessage, { type: "resync_required" }>["reason"];
	generation: number;
	/** The snapshot must cover at least this sequence before buffered frames can be released. */
	barrierSeq: number;
	bufferedFrameCount: number;
	/** A projection delivery failure discarded local replay, so reconnect must not send a cursor. */
	requiresFreshBaseline: boolean;
}

export interface SessionRawEventRecord {
	receivedAt: number;
	generation: number;
	seq: number;
	eventType: string;
	payload: Extract<SessionReplayFrameDto, { type: "event" }>["event"];
}

export interface SessionChannelState {
	sessionHandle: string;
	subscribed: boolean;
	/** User intent survives a socket reconnect; the generation-scoped lease does not. */
	controllerIntent: boolean;
	runtime: SessionRuntimeDto | null;
	generation: number | null;
	/** Highest sequence retained for replay, or covered by the active resync snapshot barrier. */
	lastSeq: number;
	/** Highest sequence synchronously applied or durably accepted by the projection pipeline. */
	projectedSeq: number;
	lease: SessionLeaseState;
	pendingExtensionRequests: RpcExtensionUIRequest[];
	resync: SessionResyncState | null;
	rawEvents: SessionRawEventRecord[];
}

export class SessionTransportError extends Error {
	constructor(
		readonly code:
			| "disconnected"
			| "duplicate_command_id"
			| "payload_too_large"
			| "response_mismatch"
			| "session_not_ready"
			| "session_not_subscribed"
			| "session_read_only"
			| "stale_resync"
			| "timeout"
			| "unavailable",
		message: string = code,
	) {
		super(message);
		this.name = "SessionTransportError";
	}
}

export interface SessionWebSocket {
	readonly readyState: number;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onerror: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	send(data: string): void;
	close(): void;
}

export interface SessionTransportOptions {
	createSocket?: (url: string) => SessionWebSocket;
	url?: () => string;
	now?: () => number;
	rawEventLimit?: number;
	rawEventMaxBytes?: number;
	rawEventGlobalLimit?: number;
	rawEventGlobalMaxBytes?: number;
	reconnectBaseMs?: number;
	reconnectMaxMs?: number;
	onResyncRequired?: (message: Extract<SessionWsServerMessage, { type: "resync_required" }>) => void;
}

export interface SessionTransportState {
	connectionState: SessionTransportConnectionState;
	sessions: Record<string, SessionChannelState>;
	connect: () => void;
	disconnect: () => void;
	subscribeSession: (sessionHandle: string) => void;
	unsubscribeSession: (sessionHandle: string) => void;
	/** Drop a dormant local baseline so the next subscribe requests an initial snapshot. */
	invalidateSessionSnapshot: (sessionHandle: string) => boolean;
	claimSession: (sessionHandle: string) => boolean;
	releaseSession: (sessionHandle: string) => boolean;
	sendCommand: (sessionHandle: string, command: RpcCommand, timeoutMs?: number) => Promise<RpcResponse>;
	sendExtensionUiResponse: (sessionHandle: string, response: RpcExtensionUIResponse) => boolean;
	completeResync: (sessionHandle: string, cursor?: SessionReplayCursorDto) => void;
}

export interface SessionTransportController {
	store: StoreApi<SessionTransportState>;
	frameBus: OrderedSessionFrameBus;
	globalBus: SessionTransportGlobalBus;
	/** Public for deterministic protocol tests and non-WebSocket adapters. */
	ingestServerMessage: (message: SessionWsServerMessage) => void;
	/** Confirm that deferred projection work has applied every retained frame through lastSeq. */
	confirmProjectionDelivery: (sessionHandle: string, generation: number) => boolean;
	/** Fail closed and request a cursorless baseline after deferred projection work throws. */
	reportProjectionFailure: (sessionHandle: string, generation: number, error?: unknown) => boolean;
	dispose: () => void;
}
