import type {
	ExtensionUiRequestDto,
	ExtensionUiResponseDto,
	GatewayProtocolVersionDto,
	SessionCommandDto,
	SessionCommandResponseDto,
	SessionReplayFrameDto,
	SessionRuntimeDto,
	SessionRuntimeIdentityDto,
	SessionWsServerMessage,
} from "@pi-agent-web/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { SessionResyncState as SessionRecoveryState, SessionResyncClock } from "../lib/session-resync";
import type { OrderedSessionFrameBus, SessionTransportGlobalBus } from "./session-frame-bus";

export type SessionTransportConnectionState = "idle" | "connecting" | "online" | "offline" | "incompatible";

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
	serverEpoch: string;
	workspaceId: string;
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
	/** Mutations fail closed until one guarded Session snapshot has committed. */
	baselineAuthoritative: boolean;
	/** Exact runtime incarnation whose latest subscribe/catch-up lease_status has committed. */
	freshLeaseBaseline: SessionRuntimeIdentityDto | null;
	/** Highest sequence retained for replay, or covered by the active resync snapshot barrier. */
	lastSeq: number;
	/** Highest sequence synchronously applied or durably accepted by the projection pipeline. */
	projectedSeq: number;
	lease: SessionLeaseState;
	pendingExtensionRequests: ExtensionUiRequestDto[];
	resync: SessionResyncState | null;
	recovery: SessionRecoveryState | null;
	rawEvents: SessionRawEventRecord[];
}

export function hasFreshLeaseBaseline(channel: SessionChannelState | undefined): boolean {
	const runtime = channel?.runtime;
	const baseline = channel?.freshLeaseBaseline;
	return Boolean(
		runtime &&
			baseline &&
			runtime.serverEpoch === baseline.serverEpoch &&
			runtime.workspaceId === baseline.workspaceId &&
			runtime.sessionHandle === baseline.sessionHandle &&
			runtime.generation === baseline.generation,
	);
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
	helloTimeoutMs?: number;
	maxActiveSubscriptions?: number;
	/** UI build identity is diagnostic only; compatibility is negotiated by protocolVersion. */
	clientBuild?: string;
	protocolVersion?: GatewayProtocolVersionDto;
	onResyncRequired?: (message: Extract<SessionWsServerMessage, { type: "resync_required" }>) => void;
	resyncClock?: SessionResyncClock;
	resyncRandom?: () => number;
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
	sendCommand: (
		sessionHandle: string,
		command: SessionCommandDto,
		timeoutMs?: number,
	) => Promise<SessionCommandResponseDto>;
	sendExtensionUiResponse: (sessionHandle: string, response: ExtensionUiResponseDto) => boolean;
	manualRetryResync: (sessionHandle: string) => boolean;
}

export interface SessionTransportController {
	store: StoreApi<SessionTransportState>;
	frameBus: OrderedSessionFrameBus;
	globalBus: SessionTransportGlobalBus;
	/** Public for deterministic protocol tests and non-WebSocket adapters. */
	ingestServerMessage: (message: SessionWsServerMessage) => void;
	/** Confirm that deferred projection work has applied every retained frame through lastSeq. */
	confirmProjectionDelivery: (sessionHandle: string, generation: number) => boolean;
	/** True only while the matching resync attempt is projecting its guarded snapshot suffix. */
	isSnapshotSuffixProjectionPending: (sessionHandle: string, generation: number) => boolean;
	/** Fail closed and request a cursorless baseline after deferred projection work throws. */
	reportProjectionFailure: (sessionHandle: string, generation: number, error?: unknown) => boolean;
	dispose: () => void;
}
