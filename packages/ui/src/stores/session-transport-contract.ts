import type {
	ExtensionUiRequestDto,
	ExtensionUiResponseDto,
	FutureExtensionUiSnapshotDto,
	FutureSessionContentRefGuardContext,
	FutureSessionHistoryPageChunkDto,
	FutureSessionReplayFrameDto,
	FutureSessionResponseFrameDto,
	FutureSessionSnapshotBeginDto,
	FutureSessionSnapshotChunkDto,
	FutureSessionSnapshotDto,
	GatewayProtocolVersionDto,
	HotRuntimeInventoryDto,
	SessionCommandDto,
	SessionCommandResponseDto,
	SessionHistoryMetadataDto,
	SessionHistoryPageBeginDto,
	SessionHistoryPageEndDto,
	SessionReplayFrameDto,
	SessionRuntimeDto,
	SessionRuntimeIdentityDto,
	SessionSnapshotEndDto,
	SessionWsServerMessage,
} from "@pi-agent-web/protocol";
import type { StoreApi } from "zustand/vanilla";
import type {
	FutureSessionContentAdapter,
	FutureSessionJsonFieldGuard,
	FutureSessionJsonRootProjection,
	FutureSessionTextPayloadProjection,
} from "../lib/future-session-content-adapter";
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

export interface SessionHistoryState extends SessionHistoryMetadataDto {
	snapshotId: string | null;
	asOfSeq: number | null;
	loading: boolean;
	error: string | null;
}

export function emptySessionHistoryState(): SessionHistoryState {
	return {
		snapshotId: null,
		asOfSeq: null,
		totalMessages: 0,
		loadedMessages: 0,
		loadedBytes: 0,
		totalBytes: 0,
		nextCursor: null,
		loading: false,
		error: null,
	};
}

export interface SessionRawEventRecord {
	receivedAt: number;
	serverEpoch: string;
	workspaceId: string;
	generation: number;
	seq: number;
	eventType: string;
	payload:
		| Extract<SessionReplayFrameDto, { type: "event" }>["event"]
		| Extract<FutureSessionReplayFrameDto, { type: "event" }>["event"];
}

export type FutureSessionTransportFrameMessage =
	| FutureSessionResponseFrameDto
	| FutureSessionReplayFrameDto
	| FutureSessionSnapshotDto
	| FutureSessionSnapshotBeginDto
	| FutureSessionSnapshotChunkDto
	| SessionSnapshotEndDto
	| SessionHistoryPageBeginDto
	| FutureSessionHistoryPageChunkDto
	| SessionHistoryPageEndDto
	| FutureExtensionUiSnapshotDto;

export type FutureSessionLazyIdentity = Readonly<
	Pick<SessionRuntimeIdentityDto, "serverEpoch" | "workspaceId" | "sessionHandle" | "generation">
>;

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
	history: SessionHistoryState;
	/** Background monitoring admission; this is disposable UI state, never Session truth. */
	subscriptionAdmission?: SessionSubscriptionAdmission | null;
	rawEvents: SessionRawEventRecord[];
}

export type SessionSubscriptionAdmission =
	| { kind: "protected_overage"; retryable: false }
	| { kind: "rejected"; code: string; retryable: boolean };

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
	/** Protocol 1.3 content adapter; production installs the default from the trusted hello context. */
	futureContentAdapter?: FutureSessionContentAdapter;
	/** Protocol 1.3 hello-scoped adapter install; custom factories are validated before activation. */
	futureContentAdapterFactory?: FutureSessionContentAdapterFactory;
}

export interface FutureSessionContentAdapterInstallation {
	adapter: FutureSessionContentAdapter;
	dispose: () => void;
}

export type FutureSessionContentAdapterFactory = (
	context: Readonly<FutureSessionContentRefGuardContext>,
) => FutureSessionContentAdapterInstallation;

export interface SessionTransportState {
	connectionState: SessionTransportConnectionState;
	/** Latest authoritative full replacement for the negotiated Gateway epoch. */
	hotRuntimeInventory: HotRuntimeInventoryDto | null;
	sessions: Record<string, SessionChannelState>;
	connect: () => void;
	disconnect: () => void;
	subscribeSession: (sessionHandle: string) => void;
	unsubscribeSession: (sessionHandle: string) => void;
	loadOlderSessionHistory: (sessionHandle: string) => boolean;
	cancelSessionHistory: (sessionHandle: string) => boolean;
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
	/** Retry a rejected background subscription without changing the visible Session. */
	retrySessionSubscription?: (sessionHandle: string) => boolean;
}

export interface HotRuntimeInventoryToken {
	serverEpoch: string;
	revision: number;
}

export interface SessionTransportController {
	store: StoreApi<SessionTransportState>;
	frameBus: OrderedSessionFrameBus;
	globalBus: SessionTransportGlobalBus;
	/** Hello-scoped future content facade; its identity is not a React dependency. */
	resolveFutureText: (
		identity: FutureSessionLazyIdentity,
		payload: FutureSessionTextPayloadProjection,
		callerSignal?: AbortSignal,
	) => Promise<string>;
	/** Hello-scoped future content facade with a caller-owned typed JSON guard. */
	resolveFutureJson: <T>(
		identity: FutureSessionLazyIdentity,
		payload: FutureSessionJsonRootProjection,
		fieldGuard: FutureSessionJsonFieldGuard<T>,
		callerSignal?: AbortSignal,
	) => Promise<T>;
	/** Public for deterministic protocol tests and non-WebSocket adapters. */
	ingestServerMessage: (message: SessionWsServerMessage) => void;
	/** Queue one already-guarded private protocol 1.3 frame for exact-identity materialization. */
	ingestFutureFrameMessage: (message: FutureSessionTransportFrameMessage, rawWireBytes: number) => boolean;
	/** Confirm that deferred projection work has applied every retained frame through lastSeq. */
	confirmProjectionDelivery: (sessionHandle: string, generation: number) => boolean;
	/** True only while the matching resync attempt is projecting its guarded snapshot suffix. */
	isSnapshotSuffixProjectionPending: (sessionHandle: string, generation: number) => boolean;
	/** Fail closed and request a cursorless baseline after deferred projection work throws. */
	reportProjectionFailure: (sessionHandle: string, generation: number, error?: unknown) => boolean;
	/** Request the next older bounded history page for a subscribed Session. */
	loadOlderSessionHistory: (sessionHandle: string) => boolean;
	/** Cancel a pending bounded history page request. */
	cancelSessionHistory: (sessionHandle: string) => boolean;
	/** Resolve after the current connection has received its ordered initial hot inventory. */
	waitForInitialHotInventory: () => Promise<HotRuntimeInventoryToken>;
	dispose: () => void;
}
