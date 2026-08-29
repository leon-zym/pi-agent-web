import {
	commandTimeoutMs,
	type ExtensionUiRequestDto,
	type ExtensionUiResponseDto,
	type FutureSessionCommandResponseDto,
	type FutureSessionContentRefGuardContext,
	type FutureSessionEntryDto,
	type FutureSessionHistoryPageChunkDto,
	type FutureSessionMessageDto,
	type FutureSessionResponseFrameDto,
	type FutureSessionSnapshotBeginDto,
	type FutureSessionSnapshotChunkDto,
	type FutureSessionSnapshotDto,
	type FutureSessionTreeNodeDto,
	GATEWAY_CONTENT_REF_PROTOCOL_MINOR,
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	GATEWAY_SESSION_HISTORY_CAPABILITY,
	type GatewayClientHelloDto,
	type GatewayContentRefClientHelloDto,
	type GatewayContentRefServerHelloDto,
	type HotRuntimeInventoryDto,
	type HotRuntimeInventoryEntryDto,
	isBoundedJsonValue,
	isFutureSessionCommandResponseDto,
	isFutureSessionWsServerMessage,
	isGatewayContentRefServerHello,
	isGatewayProtocolError,
	isGatewayServerHello,
	isReadOnlyRpcCommand,
	isSessionCommandResponseDto,
	isSessionEntryDto,
	isSessionMessageDto,
	isSessionSnapshotDto,
	isSessionTreeDto,
	isSessionWsServerMessage,
	negotiateGatewayContentRef,
	negotiateGatewayPayloadBudget,
	negotiateHotRuntimeInventory,
	SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES,
	SESSION_WS_CLIENT_MAX_BYTES,
	SESSION_WS_SERVER_MAX_BYTES,
	type SessionAttachmentGuardContext,
	type SessionCommandDto,
	type SessionCommandResponseDto,
	type SessionEntryDto,
	type SessionHistoryPageBeginDto,
	type SessionHistoryPageChunkDto,
	type SessionHistoryPageEndDto,
	type SessionMessageDto,
	type SessionReplayCursorDto,
	type SessionReplayFrameDto,
	type SessionRuntimeDto,
	type SessionRuntimeIdentityDto,
	type SessionSnapshotBeginDto,
	type SessionSnapshotChunkDto,
	type SessionSnapshotDto,
	type SessionSnapshotEndDto,
	type SessionTreeNodeDto,
	type SessionWsClientMessage,
	type SessionWsServerMessage,
	sessionWsClientMessageBytes,
} from "@pi-agent-web/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
	createFutureSessionContentAdapter,
	type FutureSessionContentAdapter,
	type FutureSessionJsonFieldGuard,
	type FutureSessionJsonRootProjection,
	type FutureSessionTextPayloadProjection,
	type ProjectedFutureExtensionUiSnapshot,
	type ProjectedFutureSessionReplayFrame,
	type ProjectedFutureSessionSnapshot,
} from "../lib/future-session-content-adapter";
import { runtimeIsReady, runtimePhase } from "../lib/runtime-state";
import { createSessionContentResolver } from "../lib/session-content-resolver";
import { SessionHistoryStreamAssembler } from "../lib/session-history-stream";
import {
	createSessionResyncCoordinator,
	type SessionResyncAttemptContext,
	type SessionResyncCompletion,
} from "../lib/session-resync";
import {
	OrderedSessionFrameBus,
	type SessionHistoryPageLoadedFrame,
	SessionTransportGlobalBus,
} from "./session-frame-bus";
import {
	emptySessionHistoryState,
	type FutureSessionContentAdapterFactory,
	type FutureSessionContentAdapterInstallation,
	type FutureSessionLazyIdentity,
	type FutureSessionTransportFrameMessage,
	type HotRuntimeInventoryToken,
	hasFreshLeaseBaseline,
	type SessionChannelState,
	type SessionHistoryState,
	type SessionSubscriptionAdmission,
	type SessionTransportController,
	SessionTransportError,
	type SessionTransportOptions,
	type SessionTransportState,
	type SessionWebSocket,
} from "./session-transport-contract";

export {
	type GlobalSessionTransportMessage,
	type OrderedSessionFrame,
	OrderedSessionFrameBus,
	SESSION_FRAME_DEFERRED,
	type SessionFrameBusMessage,
	type SessionFrameDeliveryResult,
	type SessionFrameListener,
	SessionTransportGlobalBus,
} from "./session-frame-bus";
export {
	emptySessionHistoryState,
	type FutureSessionContentAdapterFactory,
	type FutureSessionContentAdapterInstallation,
	type FutureSessionLazyIdentity,
	type HotRuntimeInventoryToken,
	hasFreshLeaseBaseline,
	type SessionChannelState,
	type SessionHistoryState,
	type SessionLeaseState,
	type SessionRawEventRecord,
	type SessionResyncState,
	type SessionSubscriptionAdmission,
	type SessionTransportConnectionState,
	type SessionTransportController,
	SessionTransportError,
	type SessionTransportOptions,
	type SessionTransportState,
	type SessionWebSocket,
} from "./session-transport-contract";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const DEFAULT_RAW_EVENT_LIMIT = 200;
const DEFAULT_RAW_EVENT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_RAW_EVENT_GLOBAL_LIMIT = 1_000;
const DEFAULT_RAW_EVENT_GLOBAL_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 8_000;
const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const MAX_RESYNC_BUFFERED_FRAMES = 1_024;
const MAX_RESYNC_BUFFERED_BYTES = 1024 * 1024;
export const MAX_ACTIVE_SUBSCRIPTIONS = 6;
const LEGACY_RETRYABLE_SUBSCRIPTION_ERROR_CODES = ["snapshot_unavailable"] as const;
const MAX_PENDING_EXTENSION_REQUESTS = 256;
const MAX_DELIVERED_NOTIFY_KEYS = 256;
const MAX_DELIVERED_NOTIFY_IDENTITIES = 64;
const SESSION_HISTORY_PAGE_LIMIT = 128;
const CLIENT_BUILD = "0.1.0";
const CLIENT_CAPABILITIES = [...GATEWAY_SERVER_REQUIRED_CAPABILITIES, GATEWAY_SESSION_HISTORY_CAPABILITY];
const LEGACY_CLIENT_CAPABILITIES = [
	"rpc.commands",
	"rpc.events",
	"rpc.extension_ui",
	"session.multiplex",
	"session.hot_runtime_inventory",
	"payload.epoch_attachment_refs",
] as const;
const LEGACY_CLIENT_ADVERTISED_CAPABILITIES = [
	...LEGACY_CLIENT_CAPABILITIES,
	GATEWAY_SESSION_HISTORY_CAPABILITY,
] as const;

const FUTURE_CONTENT_ADAPTER_METHODS = [
	"projectTextPayload",
	"projectJsonRoot",
	"materializeTextPayload",
	"materializeJsonRoot",
	"materializeReplayFrame",
	"materializeReplayFrames",
	"materializeSnapshot",
	"materializeExtensionSnapshot",
] as const;

function isFutureSessionContentAdapterInstallation(
	value: unknown,
): value is FutureSessionContentAdapterInstallation {
	if (typeof value !== "object" || value === null) return false;
	const installation = value as { adapter?: unknown; dispose?: unknown };
	if (typeof installation.dispose !== "function") return false;
	if (typeof installation.adapter !== "object" || installation.adapter === null) return false;
	const adapter = installation.adapter as Record<string, unknown>;
	return FUTURE_CONTENT_ADAPTER_METHODS.every((method) => typeof adapter[method] === "function");
}

const defaultFutureSessionContentAdapterFactory: FutureSessionContentAdapterFactory = (trustedContext) => {
	const resolver = createSessionContentResolver({ trustedContext });
	try {
		return {
			adapter: createFutureSessionContentAdapter({ trustedContext, resolver }),
			dispose: () => resolver.dispose(),
		};
	} catch (error) {
		resolver.dispose();
		throw error;
	}
};

type WireSendResult = "sent" | "payload_too_large" | "unavailable";
type TransportClientHello = GatewayClientHelloDto | GatewayContentRefClientHelloDto;
type NegotiatedProductMode = "current" | "future";
type TransportReplayFrame = SessionReplayFrameDto | ProjectedFutureSessionReplayFrame;

type BufferedReplayFrame =
	| { message: SessionReplayFrameDto; productMode: "current" }
	| { message: ProjectedFutureSessionReplayFrame; productMode: "future" };

type TransportSessionSnapshotFrame =
	| { message: SessionSnapshotDto; productMode: "current" }
	| { message: ProjectedFutureSessionSnapshot; productMode: "future" };

type HistorySnapshotBegin = SessionSnapshotBeginDto | FutureSessionSnapshotBeginDto;
type HistorySnapshotChunk = SessionSnapshotChunkDto | FutureSessionSnapshotChunkDto;
type HistoryPageChunk = SessionHistoryPageChunkDto | FutureSessionHistoryPageChunkDto;

interface SnapshotHistoryAssembly {
	identity: SessionRuntimeIdentityDto;
	snapshotId: string;
	productMode: "current" | "future";
	controller: AbortController;
	assembler: SessionHistoryStreamAssembler<
		unknown,
		HistorySnapshotBegin,
		HistorySnapshotChunk,
		SessionSnapshotEndDto
	>;
	waiterToken: number;
	finishing: boolean;
}

interface PageHistoryAssembly {
	identity: SessionRuntimeIdentityDto;
	requestId: string;
	productMode: "current" | "future";
	controller: AbortController;
	assembler: SessionHistoryStreamAssembler<
		unknown,
		SessionHistoryPageBeginDto,
		HistoryPageChunk,
		SessionHistoryPageEndDto
	>;
	finishing: boolean;
}

type TransportExtensionSnapshotFrame =
	| {
			message: Extract<SessionWsServerMessage, { type: "extension_ui_snapshot" }>;
			productMode: "current";
	  }
	| { message: ProjectedFutureExtensionUiSnapshot; productMode: "future" };

interface FutureProjectionTail {
	identity: SessionRuntimeIdentityDto;
	controller: AbortController;
	promise: Promise<void>;
	pendingReplayFrames: number;
	pendingReplayBytes: number;
	snapshotPending: boolean;
	snapshotWaiter: SnapshotWaiter | null;
}

interface FutureLazyIdentityScope {
	identity: FutureSessionLazyIdentity;
	controller: AbortController;
	operations: Set<FutureLazyOperation>;
}

interface FutureLazyOperation {
	scope: FutureLazyIdentityScope;
	controller: AbortController;
	onIdentityAbort: () => void;
	callerSignal: AbortSignal | null;
	onCallerAbort: (() => void) | null;
}

type ResponseMessage = Extract<SessionWsServerMessage, { type: "response" }>;

interface PendingCommand {
	id: string;
	token: number;
	serverEpoch: string;
	workspaceId: string;
	sessionHandle: string;
	generation: number;
	commandType: SessionCommandDto["type"];
	futureHistory?: FutureHistoryOperation;
	futureHistoryBarrierSeq?: number;
	futureHistoryResponseKey?: string;
	response?: ResponseMessage;
	resolve: (response: SessionCommandResponseDto) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface FutureHistoryOperation {
	id: string;
	token: number;
	identity: SessionRuntimeIdentityDto;
	controller: AbortController;
	started: boolean;
}

interface InitialInventoryWaiter {
	resolve: (token: HotRuntimeInventoryToken) => void;
	reject: (error: Error) => void;
}

interface ActiveExactHotRecovery {
	identity: SessionRuntimeIdentityDto;
	baselineReady: boolean;
	leaseReady: boolean;
	recoveryStarted: boolean;
}

interface RetainedRawEvent {
	identityKey: string;
	sessionHandle: string;
	record: SessionChannelState["rawEvents"][number];
	bytes: number;
}

function emptyHistoryState(): SessionHistoryState {
	return emptySessionHistoryState();
}

function emptyChannel(sessionHandle: string): SessionChannelState {
	return {
		sessionHandle,
		subscribed: false,
		controllerIntent: false,
		runtime: null,
		generation: null,
		baselineAuthoritative: false,
		freshLeaseBaseline: null,
		lastSeq: 0,
		projectedSeq: 0,
		lease: { isController: false },
		pendingExtensionRequests: [],
		resync: null,
		recovery: null,
		history: emptyHistoryState(),
		subscriptionAdmission: null,
		rawEvents: [],
	};
}

function defaultSocketUrl(): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/api/v1/ws`;
}

function defaultSocketFactory(url: string): SessionWebSocket {
	return new WebSocket(url) as unknown as SessionWebSocket;
}

function commandWithId(command: SessionCommandDto, id: string): SessionCommandDto {
	return { ...command, id } as SessionCommandDto;
}

function isMutation(command: SessionCommandDto): boolean {
	return !isReadOnlyRpcCommand(command);
}

function replaceExtensionRequest(
	requests: ExtensionUiRequestDto[],
	request: ExtensionUiRequestDto,
): ExtensionUiRequestDto[] {
	const semanticKey = extensionRequestSemanticKey(request);
	if (semanticKey === null) return requests;
	return [
		...requests.filter(
			(candidate) => candidate.id !== request.id && extensionRequestSemanticKey(candidate) !== semanticKey,
		),
		request,
	].slice(-MAX_PENDING_EXTENSION_REQUESTS);
}

function extensionRequestSemanticKey(request: ExtensionUiRequestDto): string | null {
	switch (request.method) {
		case "select":
		case "confirm":
		case "input":
		case "editor":
			return `dialog:${request.id}`;
		case "notify":
			return null;
		case "setStatus":
			return `status:${request.statusKey}`;
		case "setWidget":
			return `widget:${request.widgetKey}`;
		case "setTitle":
			return "title";
		case "set_editor_text":
			return "editor_text";
	}
}

function normalizeExtensionRequests(requests: ExtensionUiRequestDto[]): ExtensionUiRequestDto[] {
	let normalized: ExtensionUiRequestDto[] = [];
	for (const request of requests) normalized = replaceExtensionRequest(normalized, request);
	return normalized;
}

function applyReplayExtensionState(
	requests: ExtensionUiRequestDto[],
	message: TransportReplayFrame,
): ExtensionUiRequestDto[] {
	if (message.type === "extension_ui_request") return replaceExtensionRequest(requests, message.request);
	if (message.type === "extension_ui_closed") {
		return requests.filter((request) => request.id !== message.requestId);
	}
	return requests;
}

function isIdentityTransitionCommand(commandType: SessionCommandDto["type"]): boolean {
	return commandType === "fork" || commandType === "clone";
}

function isFutureHistoryCommand(commandType: SessionCommandDto["type"]): boolean {
	return commandType === "get_messages" || commandType === "get_entries" || commandType === "get_tree";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface FutureResponseEnvelopeCandidate {
	id: string;
	command: string;
	serverEpoch: string;
	sessionHandle: string;
	generation: number;
}

function futureResponseEnvelopeCandidate(value: unknown): FutureResponseEnvelopeCandidate | null {
	if (!isRecord(value) || value.type !== "response" || !isRecord(value.response)) return null;
	if (
		typeof value.serverEpoch !== "string" ||
		typeof value.sessionHandle !== "string" ||
		typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) ||
		typeof value.response.id !== "string" ||
		typeof value.response.command !== "string"
	) {
		return null;
	}
	return {
		id: value.response.id,
		command: value.response.command,
		serverEpoch: value.serverEpoch,
		sessionHandle: value.sessionHandle,
		generation: value.generation,
	};
}

function serializedBytes(value: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function replayFrameBytes(message: TransportReplayFrame): number {
	return serializedBytes(message);
}

function validCursor(channel: SessionChannelState): SessionReplayCursorDto | undefined {
	return channel.generation === null || !channel.runtime || !channel.baselineAuthoritative
		? undefined
		: {
				serverEpoch: channel.runtime.serverEpoch,
				generation: channel.generation,
				seq: channel.lastSeq,
			};
}

function subscriptionAdmissionCode(error: string, code?: string): string {
	if (code) return code.slice(0, 128);
	const known = [
		...SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES,
		...LEGACY_RETRYABLE_SUBSCRIPTION_ERROR_CODES,
	].find((errorCode) => error.includes(errorCode));
	if (known) return known;
	const token = error.match(/[A-Za-z][A-Za-z0-9_-]*/)?.[0];
	return (token ?? "subscription_rejected").slice(0, 128);
}

function isRetryableSubscriptionError(error: string, retryable?: boolean): boolean {
	if (retryable !== undefined) return retryable;
	return [...SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES, ...LEGACY_RETRYABLE_SUBSCRIPTION_ERROR_CODES].some(
		(code) => error.includes(code),
	);
}

function identityKey(identity: SessionRuntimeIdentityDto): string {
	return JSON.stringify([
		identity.serverEpoch,
		identity.workspaceId,
		identity.sessionHandle,
		identity.generation,
	]);
}

function identitiesMatch(
	left: SessionRuntimeIdentityDto | null | undefined,
	right: SessionRuntimeIdentityDto | null | undefined,
): boolean {
	return Boolean(
		left &&
			right &&
			left.serverEpoch === right.serverEpoch &&
			left.workspaceId === right.workspaceId &&
			left.sessionHandle === right.sessionHandle &&
			left.generation === right.generation,
	);
}

function futureLazyAbortError(): DOMException {
	return new DOMException("Future Session lazy content operation was aborted", "AbortError");
}

interface SnapshotWaiter {
	token: number;
	identity: SessionRuntimeIdentityDto;
	resolve: (completion: SessionResyncCompletion) => void;
	reject: (error: Error) => void;
	promise: Promise<SessionResyncCompletion>;
	pendingCompletion?: {
		snapshotId: string;
		endpointSeq: number;
	};
}

interface AcknowledgedExtensionRequests {
	identity: SessionRuntimeIdentityDto;
	requestIds: Set<string>;
}

interface DeliveredNotifyKeys {
	identity: SessionRuntimeIdentityDto;
	keys: string[];
	keySet: Set<string>;
}

export function createSessionTransport(options: SessionTransportOptions = {}): SessionTransportController {
	const createSocket = options.createSocket ?? defaultSocketFactory;
	const socketUrl = options.url ?? defaultSocketUrl;
	const now = options.now ?? Date.now;
	const rawEventLimit = Math.max(0, options.rawEventLimit ?? DEFAULT_RAW_EVENT_LIMIT);
	const rawEventMaxBytes = Math.max(0, options.rawEventMaxBytes ?? DEFAULT_RAW_EVENT_MAX_BYTES);
	const rawEventGlobalLimit = Math.max(0, options.rawEventGlobalLimit ?? DEFAULT_RAW_EVENT_GLOBAL_LIMIT);
	const rawEventGlobalMaxBytes = Math.max(
		0,
		options.rawEventGlobalMaxBytes ?? DEFAULT_RAW_EVENT_GLOBAL_MAX_BYTES,
	);
	const reconnectBaseMs = Math.max(0, options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS);
	const reconnectMaxMs = Math.max(reconnectBaseMs, options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS);
	const helloTimeoutMs = Math.max(1, options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);
	const maxActiveSubscriptions = Math.max(1, options.maxActiveSubscriptions ?? MAX_ACTIVE_SUBSCRIPTIONS);
	const configuredProtocolVersion = options.protocolVersion ?? GATEWAY_PROTOCOL_VERSION;
	const configuredFutureContentAdapter = options.futureContentAdapter;
	const futureModeRequested =
		options.futureContentAdapterFactory !== undefined ||
		(configuredProtocolVersion.major === GATEWAY_PROTOCOL_VERSION.major &&
			configuredProtocolVersion.minor === GATEWAY_CONTENT_REF_PROTOCOL_MINOR);
	const futureContentAdapterFactory =
		options.futureContentAdapterFactory ??
		(configuredFutureContentAdapter
			? () => ({ adapter: configuredFutureContentAdapter, dispose: () => {} })
			: futureModeRequested
				? defaultFutureSessionContentAdapterFactory
				: undefined);
	const clientHelloProtocol = futureModeRequested
		? { major: GATEWAY_PROTOCOL_VERSION.major, minor: GATEWAY_CONTENT_REF_PROTOCOL_MINOR }
		: configuredProtocolVersion;
	const clientHelloCapabilities = futureModeRequested
		? [...CLIENT_CAPABILITIES]
		: [...LEGACY_CLIENT_ADVERTISED_CAPABILITIES];
	const clientHello: TransportClientHello = {
		type: "client_hello",
		protocol: clientHelloProtocol,
		clientBuild: options.clientBuild ?? CLIENT_BUILD,
		capabilities: clientHelloCapabilities,
		limits: { maxServerFrameBytes: SESSION_WS_SERVER_MAX_BYTES },
	};
	const frameBus = new OrderedSessionFrameBus();
	const globalBus = new SessionTransportGlobalBus();
	const pendingCommands = new Map<string, PendingCommand>();
	const resyncBuffers = new Map<string, BufferedReplayFrame[]>();
	const resyncBufferBytes = new Map<string, number>();
	const snapshotWaiters = new Map<string, SnapshotWaiter>();
	const snapshotHistoryAssemblies = new Map<string, SnapshotHistoryAssembly>();
	const pageHistoryAssemblies = new Map<string, PageHistoryAssembly>();
	const skipNextResubscribe = new Set<string>();
	const acknowledgedExtensionRequests = new Map<string, AcknowledgedExtensionRequests>();
	const deliveredNotifyKeys = new Map<string, DeliveredNotifyKeys>();
	let deliveredNotifyIdentityOrder: string[] = [];
	const claimAttempts = new Set<string>();
	const baselineRefreshes = new Set<string>();
	const subscriptionBaselines = new Map<string, string | null>();
	let subscribedLruOrder: string[] = [];
	let retainedRawEvents: RetainedRawEvent[] = [];
	let retainedRawEventBytes = 0;

	let socket: SessionWebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let helloTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectAttempt = 0;
	let reconnectEnabled = false;
	let commandCounter = 0;
	let historyRequestCounter = 0;
	let nextPendingToken = 1;
	let nextSnapshotWaiterToken = 1;
	let disposed = false;
	let negotiatedMaxClientFrameBytes = SESSION_WS_CLIENT_MAX_BYTES;
	let negotiatedMaxServerFrameBytes = SESSION_WS_SERVER_MAX_BYTES;
	let negotiatedServerEpoch: string | null = null;
	let historyNegotiated = false;
	let attachmentGuardContext: Readonly<SessionAttachmentGuardContext> | null = null;
	let futureContentRefGuardContext: Readonly<FutureSessionContentRefGuardContext> | null = null;
	let negotiatedProductMode: NegotiatedProductMode | null = null;
	let activeFutureContentAdapter = options.futureContentAdapter;
	let installedFutureContent: FutureSessionContentAdapterInstallation | null = null;
	const wireTextEncoder = new TextEncoder();
	let hotRuntimeRevision = -1;
	let hotRuntimeByHandle = new Map<string, HotRuntimeInventoryEntryDto>();
	const connectionObservations = new Map<string, SessionRuntimeIdentityDto>();
	const futureProjectionTails = new Map<string, FutureProjectionTail>();
	const futureLazyIdentityScopes = new Map<string, FutureLazyIdentityScope>();
	const initialInventoryWaiters = new Set<InitialInventoryWaiter>();
	const exactHotRecoveryQueue: string[] = [];
	const queuedExactHotRecoveries = new Set<string>();
	let activeExactHotRecovery: ActiveExactHotRecovery | null = null;

	const resyncCoordinator = createSessionResyncCoordinator({
		attempt: attemptResync,
		clock: options.resyncClock,
		random: options.resyncRandom,
	});

	const store = createStore<SessionTransportState>()(() => ({
		connectionState: "idle",
		hotRuntimeInventory: null,
		sessions: {},
		connect,
		disconnect,
		subscribeSession,
		unsubscribeSession,
		loadOlderSessionHistory,
		cancelSessionHistory,
		invalidateSessionSnapshot,
		claimSession,
		releaseSession,
		sendCommand,
		sendExtensionUiResponse,
		manualRetryResync: (sessionHandle) => resyncCoordinator.manualRetry(sessionHandle),
		retrySessionSubscription,
	}));

	function waitForInitialHotInventory(): Promise<HotRuntimeInventoryToken> {
		if (disposed || store.getState().connectionState === "incompatible") {
			return Promise.reject(new SessionTransportError("unavailable", "Gateway inventory is unavailable"));
		}
		const inventory = store.getState().hotRuntimeInventory;
		if (inventory !== null && store.getState().connectionState === "online") {
			return Promise.resolve({ serverEpoch: inventory.serverEpoch, revision: inventory.revision });
		}
		return new Promise((resolve, reject) => initialInventoryWaiters.add({ resolve, reject }));
	}

	function rejectInitialInventoryWaiters(error: Error): void {
		for (const waiter of initialInventoryWaiters) waiter.reject(error);
		initialInventoryWaiters.clear();
	}

	function disposeInstalledFutureContent(): void {
		const installed = installedFutureContent;
		installedFutureContent = null;
		futureContentRefGuardContext = null;
		negotiatedProductMode = null;
		activeFutureContentAdapter = configuredFutureContentAdapter;
		if (!installed) return;
		try {
			installed.dispose();
		} catch {
			// Adapter disposal is best effort after the transport fence is closed.
		}
	}

	function installFutureContentForHello(message: GatewayContentRefServerHelloDto): boolean {
		if (!futureContentAdapterFactory || negotiatedProductMode !== null) return false;
		const negotiation = negotiateGatewayContentRef(clientHello, message);
		if (!negotiation.negotiated) return false;
		const context: Readonly<FutureSessionContentRefGuardContext> = Object.freeze({
			serverEpoch: message.serverEpoch,
			payloadBudget: Object.freeze({ ...negotiation.payloadBudget }),
			contentRefBudget: Object.freeze({ ...negotiation.contentRefBudget }),
		});
		let installation: FutureSessionContentAdapterInstallation;
		try {
			const candidate = futureContentAdapterFactory(context);
			if (!isFutureSessionContentAdapterInstallation(candidate)) return false;
			installation = candidate;
		} catch {
			return false;
		}
		futureContentRefGuardContext = context;
		attachmentGuardContext = Object.freeze({
			serverEpoch: context.serverEpoch,
			payloadBudget: context.payloadBudget,
		});
		activeFutureContentAdapter = installation.adapter;
		installedFutureContent = installation;
		negotiatedProductMode = "future";
		historyNegotiated =
			message.capabilities.includes(GATEWAY_SESSION_HISTORY_CAPABILITY) &&
			clientHello.capabilities.includes(GATEWAY_SESSION_HISTORY_CAPABILITY);
		negotiatedServerEpoch = message.serverEpoch;
		negotiatedMaxClientFrameBytes = Math.min(SESSION_WS_CLIENT_MAX_BYTES, message.limits.maxClientFrameBytes);
		negotiatedMaxServerFrameBytes = message.limits.maxSnapshotFrameBytes;
		hotRuntimeRevision = -1;
		return true;
	}

	resyncCoordinator.subscribe((sessionHandle, recovery) => {
		setChannel(sessionHandle, (channel) => {
			if (recovery && !identitiesMatch(channel.runtime, recovery.identity)) return channel;
			return channel.recovery === (recovery ?? null) ? channel : { ...channel, recovery: recovery ?? null };
		});
		if (
			recovery?.phase === "degraded" &&
			activeExactHotRecovery &&
			identitiesMatch(activeExactHotRecovery.identity, recovery.identity)
		) {
			activeExactHotRecovery = null;
			pumpExactHotRecovery();
		}
	});

	function setChannel(
		sessionHandle: string,
		update: (channel: SessionChannelState) => SessionChannelState,
	): SessionChannelState {
		let result = emptyChannel(sessionHandle);
		store.setState((state) => {
			const current = state.sessions[sessionHandle] ?? result;
			result = update(current);
			if (result === current) return state;
			return { sessions: { ...state.sessions, [sessionHandle]: result } };
		});
		return result;
	}

	function clearAcknowledgedExtensionRequests(identity: SessionRuntimeIdentityDto): void {
		const acknowledged = acknowledgedExtensionRequests.get(identity.sessionHandle);
		if (acknowledged && identitiesMatch(acknowledged.identity, identity)) {
			acknowledgedExtensionRequests.delete(identity.sessionHandle);
		}
	}

	function acknowledgedExtensionRequestIds(identity: SessionRuntimeIdentityDto): Set<string> {
		const acknowledged = acknowledgedExtensionRequests.get(identity.sessionHandle);
		return acknowledged && identitiesMatch(acknowledged.identity, identity)
			? acknowledged.requestIds
			: new Set<string>();
	}

	function requiredProjectionBarrier(identity: SessionRuntimeIdentityDto, minimum: number): number {
		let barrierSeq = minimum;
		for (const pending of pendingCommands.values()) {
			const response = pending.response;
			if (
				pending.serverEpoch !== identity.serverEpoch ||
				pending.workspaceId !== identity.workspaceId ||
				pending.sessionHandle !== identity.sessionHandle ||
				pending.generation !== identity.generation
			) {
				continue;
			}
			if (response) {
				if (
					response.serverEpoch !== identity.serverEpoch ||
					response.sessionHandle !== identity.sessionHandle ||
					response.generation !== identity.generation
				) {
					continue;
				}
				barrierSeq = Math.max(barrierSeq, response.barrierSeq);
			}
			if (pending.futureHistoryBarrierSeq !== undefined) {
				barrierSeq = Math.max(barrierSeq, pending.futureHistoryBarrierSeq);
			}
		}
		return barrierSeq;
	}

	function clearIdentityBuffers(identity: SessionRuntimeIdentityDto): void {
		const key = identityKey(identity);
		resyncBuffers.delete(key);
		resyncBufferBytes.delete(key);
		skipNextResubscribe.delete(key);
		const snapshotAssembly = snapshotHistoryAssemblies.get(key);
		if (snapshotAssembly) {
			snapshotHistoryAssemblies.delete(key);
			snapshotAssembly.controller.abort();
		}
		const waiter = snapshotWaiters.get(key);
		if (waiter) {
			snapshotWaiters.delete(key);
			waiter.reject(new SessionTransportError("stale_resync"));
		}
		for (const [requestId, assembly] of pageHistoryAssemblies) {
			if (!identitiesMatch(assembly.identity, identity)) continue;
			pageHistoryAssemblies.delete(requestId);
			assembly.controller.abort();
		}
	}

	function clearSessionResyncData(sessionHandle: string): void {
		for (const [key, assembly] of snapshotHistoryAssemblies) {
			if (assembly.identity.sessionHandle !== sessionHandle) continue;
			snapshotHistoryAssemblies.delete(key);
			assembly.controller.abort();
		}
		for (const [key, waiter] of snapshotWaiters) {
			if (waiter.identity.sessionHandle !== sessionHandle) continue;
			snapshotWaiters.delete(key);
			waiter.reject(new SessionTransportError("stale_resync"));
		}
		for (const [key, frames] of resyncBuffers) {
			if (frames[0]?.message.sessionHandle === sessionHandle) {
				resyncBuffers.delete(key);
				resyncBufferBytes.delete(key);
				skipNextResubscribe.delete(key);
			}
		}
		abortHistoryForSession(sessionHandle);
	}

	function abortHistoryForSession(sessionHandle: string): void {
		for (const [key, assembly] of snapshotHistoryAssemblies) {
			if (assembly.identity.sessionHandle !== sessionHandle) continue;
			snapshotHistoryAssemblies.delete(key);
			assembly.controller.abort();
		}
		for (const [candidateId, assembly] of pageHistoryAssemblies) {
			if (assembly.identity.sessionHandle !== sessionHandle) continue;
			pageHistoryAssemblies.delete(candidateId);
			assembly.controller.abort();
		}
	}

	function clearDeliveredNotifyKeys(sessionHandle: string): void {
		deliveredNotifyKeys.delete(sessionHandle);
		deliveredNotifyIdentityOrder = deliveredNotifyIdentityOrder.filter(
			(candidate) => candidate !== sessionHandle,
		);
	}

	function hasDeliveredNotify(
		identity: SessionRuntimeIdentityDto,
		message: Extract<SessionReplayFrameDto, { type: "extension_ui_request" }>,
	): boolean {
		const retained = deliveredNotifyKeys.get(identity.sessionHandle);
		if (!retained || !identitiesMatch(retained.identity, identity)) return false;
		return retained.keySet.has(`${String(message.seq)}:${message.request.id}`);
	}

	function rememberDeliveredNotify(
		identity: SessionRuntimeIdentityDto,
		message: Extract<SessionReplayFrameDto, { type: "extension_ui_request" }>,
	): void {
		const existing = deliveredNotifyKeys.get(identity.sessionHandle);
		let retained = existing && identitiesMatch(existing.identity, identity) ? existing : undefined;
		if (!retained) {
			clearDeliveredNotifyKeys(identity.sessionHandle);
			retained = { identity, keys: [], keySet: new Set<string>() };
			deliveredNotifyIdentityOrder.push(identity.sessionHandle);
			while (deliveredNotifyIdentityOrder.length > MAX_DELIVERED_NOTIFY_IDENTITIES) {
				const oldest = deliveredNotifyIdentityOrder.shift();
				if (oldest) deliveredNotifyKeys.delete(oldest);
			}
		}
		const key = `${String(message.seq)}:${message.request.id}`;
		if (retained.keySet.has(key)) return;
		retained.keys.push(key);
		retained.keySet.add(key);
		while (retained.keys.length > MAX_DELIVERED_NOTIFY_KEYS) {
			const oldest = retained.keys.shift();
			if (oldest) retained.keySet.delete(oldest);
		}
		deliveredNotifyKeys.set(identity.sessionHandle, retained);
	}

	function attemptResync(context: SessionResyncAttemptContext): Promise<SessionResyncCompletion> {
		const channel = store.getState().sessions[context.identity.sessionHandle];
		if (!channel?.subscribed || !identitiesMatch(channel.runtime, context.identity)) {
			return Promise.reject(new SessionTransportError("stale_resync"));
		}
		const key = identityKey(context.identity);
		const previous = snapshotWaiters.get(key);
		if (previous) {
			snapshotWaiters.delete(key);
			previous.reject(new SessionTransportError("stale_resync"));
		}
		let resolve!: SnapshotWaiter["resolve"];
		let reject!: SnapshotWaiter["reject"];
		const promise = new Promise<SessionResyncCompletion>((onResolve, onReject) => {
			resolve = onResolve;
			reject = onReject;
		});
		const waiter: SnapshotWaiter = {
			token: nextSnapshotWaiterToken++,
			identity: context.identity,
			resolve,
			reject,
			promise,
		};
		snapshotWaiters.set(key, waiter);
		context.signal.addEventListener(
			"abort",
			() => {
				if (snapshotWaiters.get(key) === waiter) snapshotWaiters.delete(key);
			},
			{ once: true },
		);

		if (!skipNextResubscribe.delete(key)) {
			const cursor = context.cursorless ? undefined : validCursor(channel);
			if (!sendSubscription(context.identity.sessionHandle, cursor)) {
				if (snapshotWaiters.get(key)?.token === waiter.token) snapshotWaiters.delete(key);
				reject(new SessionTransportError("unavailable"));
			}
		}
		return promise;
	}

	function connect(): void {
		if (disposed || store.getState().connectionState === "incompatible") return;
		reconnectEnabled = true;
		openSocket();
	}

	function openSocket(): void {
		if (disposed || !reconnectEnabled) return;
		if (socket && (socket.readyState === SOCKET_OPEN || socket.readyState === SOCKET_CONNECTING)) return;
		store.setState({ connectionState: "connecting" });
		let next: SessionWebSocket;
		try {
			next = createSocket(socketUrl());
		} catch {
			store.setState({ connectionState: "offline" });
			scheduleReconnect();
			return;
		}
		socket = next;
		next.onopen = () => {
			if (socket !== next || disposed) return;
			try {
				next.send(JSON.stringify(clientHello));
				helloTimer = setTimeout(() => enterIncompatible(next), helloTimeoutMs);
			} catch {
				socket = null;
				try {
					next.close();
				} finally {
					handleDisconnected();
					if (reconnectEnabled) scheduleReconnect();
				}
			}
		};
		next.onclose = () => {
			if (socket !== next) return;
			socket = null;
			handleDisconnected();
			if (reconnectEnabled) scheduleReconnect();
		};
		next.onerror = () => {
			// The close event owns connection cleanup and retry.
		};
		next.onmessage = (event) => {
			if (socket !== next) return;
			const raw = String(event.data);
			const rawWireBytes = wireTextEncoder.encode(raw).byteLength;
			if (rawWireBytes > negotiatedMaxServerFrameBytes) {
				enterIncompatible(next);
				return;
			}
			let value: unknown;
			try {
				value = JSON.parse(raw);
			} catch {
				enterIncompatible(next);
				return;
			}
			if (isGatewayProtocolError(value)) {
				enterIncompatible(next);
				return;
			}
			if (futureModeRequested && negotiatedProductMode === null) {
				if (
					!isGatewayContentRefServerHello(value) ||
					store.getState().connectionState !== "connecting" ||
					!installFutureContentForHello(value)
				) {
					enterIncompatible(next);
					return;
				}
				return;
			}
			if (isGatewayServerHello(value)) {
				if (!LEGACY_CLIENT_CAPABILITIES.every((capability) => value.capabilities.includes(capability))) {
					enterIncompatible(next);
					return;
				}
				const inventoryNegotiation = negotiateHotRuntimeInventory(clientHello, value);
				const payloadNegotiation = negotiateGatewayPayloadBudget(clientHello, value);
				if (!inventoryNegotiation.negotiated || !payloadNegotiation.negotiated) {
					enterIncompatible(next);
					return;
				}
				if (store.getState().connectionState !== "connecting") {
					enterIncompatible(next);
					return;
				}
				negotiatedMaxClientFrameBytes = Math.min(
					SESSION_WS_CLIENT_MAX_BYTES,
					value.limits.maxClientFrameBytes,
				);
				negotiatedMaxServerFrameBytes = value.limits.maxSnapshotFrameBytes;
				negotiatedServerEpoch = value.serverEpoch;
				historyNegotiated =
					value.capabilities.includes(GATEWAY_SESSION_HISTORY_CAPABILITY) &&
					clientHello.capabilities.includes(GATEWAY_SESSION_HISTORY_CAPABILITY);
				attachmentGuardContext = Object.freeze({
					serverEpoch: value.serverEpoch,
					payloadBudget: Object.freeze({ ...payloadNegotiation.budget }),
				});
				negotiatedProductMode = "current";
				hotRuntimeRevision = -1;
				return;
			}
			const currentGuardContext = attachmentGuardContext;
			const futureGuardContext = futureContentRefGuardContext;
			if (currentGuardContext === null || negotiatedProductMode === null) {
				enterIncompatible(next);
				return;
			}
			if (store.getState().connectionState === "connecting" && negotiatedServerEpoch !== null) {
				if (negotiatedProductMode === "future") {
					if (
						futureGuardContext === null ||
						!isFutureSessionWsServerMessage(value, futureGuardContext) ||
						value.type !== "hot_runtime_inventory" ||
						value.serverEpoch !== negotiatedServerEpoch
					) {
						enterIncompatible(next);
						return;
					}
					handleHotRuntimeInventory(value, true);
					return;
				}
				if (
					!isSessionWsServerMessage(value, currentGuardContext) ||
					value.type !== "hot_runtime_inventory" ||
					value.serverEpoch !== negotiatedServerEpoch
				) {
					enterIncompatible(next);
					return;
				}
				handleHotRuntimeInventory(value, true);
				return;
			}
			if (store.getState().connectionState !== "online") {
				enterIncompatible(next);
				return;
			}
			if (negotiatedProductMode === "future") {
				if (futureGuardContext === null || !isFutureSessionWsServerMessage(value, futureGuardContext)) {
					if (!handleInvalidFutureResponse(value)) enterIncompatible(next);
					return;
				}
				switch (value.type) {
					case "response":
					case "event":
					case "extension_ui_request":
					case "extension_ui_closed":
					case "session_snapshot":
					case "extension_ui_snapshot":
						if (!ingestFutureFrameMessage(value, rawWireBytes)) return;
						return;
					case "session_snapshot_begin":
					case "session_snapshot_chunk":
					case "session_snapshot_end":
					case "session_history_page_begin":
					case "session_history_page_chunk":
					case "session_history_page_end":
						if (!ingestFutureFrameMessage(value, rawWireBytes)) return;
						return;
					case "hot_runtime_inventory":
						handleHotRuntimeInventory(value);
						return;
					case "runtime_state":
						handleRuntimeState(value);
						return;
					case "lease_status":
						handleLease(value);
						return;
					case "resync_required":
						handleResyncRequired(value);
						return;
					case "extension_ui_result":
						handleExtensionResult(value);
						return;
					case "session_rekeyed":
						handleRekey(value);
						return;
					case "session_error":
						handleSessionError(value);
						return;
					case "session_directory_changed":
					case "auth_changed":
						globalBus.emit(value);
						return;
				}
			}
			if (!isSessionWsServerMessage(value, currentGuardContext)) {
				enterIncompatible(next);
				return;
			}
			ingestServerMessage(value);
		};
	}

	function enterIncompatible(current: SessionWebSocket): void {
		reconnectEnabled = false;
		clearReconnectTimer();
		clearHelloTimer();
		if (socket === current) socket = null;
		current.onopen = null;
		current.onclose = null;
		current.onerror = null;
		current.onmessage = null;
		const error = new SessionTransportError("unavailable", "Gateway protocol is incompatible");
		rejectAllPending(error);
		rejectInitialInventoryWaiters(error);
		resetDisconnectedState("incompatible");
		try {
			current.close();
		} catch {
			// The terminal state is already recorded.
		}
	}

	function scheduleReconnect(): void {
		if (disposed || !reconnectEnabled || reconnectTimer) return;
		const delay = Math.min(reconnectBaseMs * 2 ** reconnectAttempt, reconnectMaxMs);
		reconnectAttempt += 1;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			openSocket();
		}, delay);
	}

	function disconnect(): void {
		reconnectEnabled = false;
		clearReconnectTimer();
		clearHelloTimer();
		const current = socket;
		socket = null;
		if (current) {
			current.onopen = null;
			current.onclose = null;
			current.onerror = null;
			current.onmessage = null;
			try {
				current.close();
			} catch {
				// The socket may already be closed.
			}
		}
		handleDisconnected();
	}

	function clearReconnectTimer(): void {
		if (!reconnectTimer) return;
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}

	function clearHelloTimer(): void {
		if (!helloTimer) return;
		clearTimeout(helloTimer);
		helloTimer = null;
	}

	function handleDisconnected(): void {
		resyncCoordinator.disconnect();
		rejectAllPending(new SessionTransportError("disconnected"));
		resetDisconnectedState("offline");
	}

	function resetDisconnectedState(connectionState: "offline" | "incompatible"): void {
		abortAllFutureProjections();
		abortAllFutureLazyOperations();
		abortAllFutureHistoryOperations();
		disposeInstalledFutureContent();
		clearHelloTimer();
		negotiatedMaxClientFrameBytes = SESSION_WS_CLIENT_MAX_BYTES;
		negotiatedMaxServerFrameBytes = SESSION_WS_SERVER_MAX_BYTES;
		negotiatedServerEpoch = null;
		historyNegotiated = false;
		attachmentGuardContext = null;
		hotRuntimeRevision = -1;
		claimAttempts.clear();
		baselineRefreshes.clear();
		subscriptionBaselines.clear();
		activeExactHotRecovery = null;
		exactHotRecoveryQueue.length = 0;
		queuedExactHotRecoveries.clear();
		connectionObservations.clear();
		const receivedAt = now();
		const sessions: Record<string, SessionChannelState> = {};
		const lostLeases: string[] = [];
		for (const [sessionHandle, channel] of Object.entries(store.getState().sessions)) {
			abortHistoryForSession(sessionHandle);
			sessions[sessionHandle] = {
				...channel,
				freshLeaseBaseline: null,
				lease: { isController: false },
				history: emptyHistoryState(),
			};
			if (channel.lease.isController || channel.lease.fencingToken) lostLeases.push(sessionHandle);
		}
		store.setState({ connectionState, hotRuntimeInventory: null, sessions });
		for (const sessionHandle of lostLeases) {
			const channel = sessions[sessionHandle];
			if (!channel?.runtime || channel.generation === null) continue;
			frameBus.emit(
				sessionHandle,
				{
					type: "lease_status",
					serverEpoch: channel.runtime.serverEpoch,
					sessionHandle,
					generation: channel.generation,
					isController: false,
				},
				receivedAt,
			);
		}
	}

	function touchSubscriptionLru(sessionHandle: string): void {
		const index = subscribedLruOrder.indexOf(sessionHandle);
		if (index !== -1) {
			subscribedLruOrder.splice(index, 1);
		}
		subscribedLruOrder.push(sessionHandle);
	}

	function markProtectedSubscriptionOverage(sessionHandle: string): void {
		const subscribedCount = Object.values(store.getState().sessions).filter(
			(channel) => channel.subscribed,
		).length;
		if (subscribedCount <= maxActiveSubscriptions) return;
		setChannel(sessionHandle, (channel) => {
			if (channel.subscriptionAdmission) return channel;
			const admission: SessionSubscriptionAdmission = {
				kind: "protected_overage",
				retryable: false,
			};
			return { ...channel, subscriptionAdmission: admission };
		});
	}

	function clearProtectedSubscriptionOverage(): void {
		const subscribedCount = Object.values(store.getState().sessions).filter(
			(channel) => channel.subscribed,
		).length;
		if (subscribedCount > maxActiveSubscriptions) return;
		for (const sessionHandle of Object.keys(store.getState().sessions)) {
			setChannel(sessionHandle, (channel) =>
				channel.subscriptionAdmission?.kind === "protected_overage"
					? { ...channel, subscriptionAdmission: null }
					: channel,
			);
		}
	}

	function recordSubscriptionRejection(
		sessionHandle: string,
		error: string,
		code?: string,
		retryable?: boolean,
	): void {
		const admission: SessionSubscriptionAdmission = {
			kind: "rejected",
			code: subscriptionAdmissionCode(error, code),
			retryable: isRetryableSubscriptionError(error, retryable),
		};
		setChannel(sessionHandle, (channel) => ({ ...channel, subscriptionAdmission: admission }));
	}

	function evictSubscriptionLruIfNeeded(incomingSessionHandle: string): boolean {
		const state = store.getState();
		const subscribedSessions = Object.values(state.sessions).filter((s) => s.subscribed);
		if (subscribedSessions.length < maxActiveSubscriptions) return false;

		for (const candidateHandle of [...subscribedLruOrder]) {
			if (candidateHandle === incomingSessionHandle) continue;
			if (hotRuntimeByHandle.has(candidateHandle)) continue;
			const candidate = state.sessions[candidateHandle];
			if (!candidate?.subscribed) continue;

			const isIdle = canEvictRuntime(candidate.runtime);
			const isPersisted =
				candidate.runtime?.sessionFile !== null && candidate.runtime?.sessionFile !== undefined;
			const hasNoPendingExt = candidate.pendingExtensionRequests.length === 0;

			if (isIdle && isPersisted && hasNoPendingExt) {
				unsubscribeSession(candidateHandle);
				return false;
			}
		}
		return true;
	}

	function canEvictRuntime(runtime: SessionRuntimeDto | null | undefined): boolean {
		if (!runtime) return false;
		return runtimeIsReady(runtime) || runtimePhase(runtime) === "dormant";
	}

	function subscribeSession(sessionHandle: string): void {
		if (!sessionHandle) return;
		if (store.getState().sessions[sessionHandle]?.subscribed) {
			touchSubscriptionLru(sessionHandle);
			return;
		}
		const protectedOverage = evictSubscriptionLruIfNeeded(sessionHandle);
		touchSubscriptionLru(sessionHandle);
		const channel = setChannel(sessionHandle, (current) =>
			current.subscribed
				? current
				: { ...current, subscribed: true, freshLeaseBaseline: null, subscriptionAdmission: null },
		);
		if (protectedOverage) markProtectedSubscriptionOverage(sessionHandle);
		if (store.getState().connectionState !== "online" || negotiatedProductMode === null) return;
		const cursor = validCursor(channel);
		sendSubscription(sessionHandle, cursor);
	}

	function retrySessionSubscription(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (channel?.subscriptionAdmission?.kind !== "rejected") return false;
		if (!channel.subscriptionAdmission.retryable) return false;
		if (store.getState().connectionState !== "online" || negotiatedProductMode === null) return false;
		setChannel(sessionHandle, (current) => ({ ...current, subscriptionAdmission: null }));
		if (!channel.subscribed) {
			subscribeSession(sessionHandle);
			return Boolean(store.getState().sessions[sessionHandle]?.subscribed);
		}
		connectionObservations.delete(sessionHandle);
		const desiredHotRuntime = hotRuntimeByHandle.get(sessionHandle);
		if (desiredHotRuntime) {
			queueHotRuntimeRecovery(desiredHotRuntime);
		} else {
			sendSubscription(sessionHandle, validCursor(channel));
		}
		return true;
	}

	function loadOlderSessionHistory(sessionHandle: string): boolean {
		if (!historyNegotiated) return false;
		const channel = store.getState().sessions[sessionHandle];
		if (
			!channel?.subscribed ||
			!channel.baselineAuthoritative ||
			channel.resync !== null ||
			channel.generation === null ||
			!channel.runtime ||
			channel.history.snapshotId === null ||
			channel.history.asOfSeq === null ||
			channel.history.nextCursor === null ||
			channel.history.loading ||
			[...pageHistoryAssemblies.values()].some(
				(assembly) => assembly.identity.sessionHandle === sessionHandle,
			)
		) {
			return false;
		}
		const requestId = `history-page-${String(++historyRequestCounter)}-${now().toString(36)}`;
		const operation: PageHistoryAssembly = {
			identity: channel.runtime,
			requestId,
			productMode: negotiatedProductMode ?? "current",
			controller: new AbortController(),
			assembler: new SessionHistoryStreamAssembler<
				unknown,
				SessionHistoryPageBeginDto,
				HistoryPageChunk,
				SessionHistoryPageEndDto
			>("page"),
			finishing: false,
		};
		pageHistoryAssemblies.set(requestId, operation);
		setChannel(sessionHandle, (current) => ({
			...current,
			history: { ...current.history, loading: true, error: null },
		}));
		const delivered = sendWire({
			type: "session_history_page",
			id: requestId,
			sessionHandle,
			expectedGeneration: channel.generation,
			snapshotId: channel.history.snapshotId,
			asOfSeq: channel.history.asOfSeq,
			cursor: channel.history.nextCursor,
			limit: SESSION_HISTORY_PAGE_LIMIT,
		});
		if (delivered !== "sent") {
			pageHistoryAssemblies.delete(requestId);
			operation.controller.abort();
			setChannel(sessionHandle, (current) => ({
				...current,
				history: { ...current.history, loading: false, error: delivered },
			}));
			return false;
		}
		return true;
	}

	function cancelSessionHistory(sessionHandle: string): boolean {
		const operation = [...pageHistoryAssemblies.values()].find(
			(candidate) => candidate.identity.sessionHandle === sessionHandle,
		);
		if (!operation) return false;
		pageHistoryAssemblies.delete(operation.requestId);
		operation.controller.abort();
		const channel = store.getState().sessions[sessionHandle];
		if (
			channel?.runtime &&
			channel.generation !== null &&
			channel.history.snapshotId !== null &&
			channel.history.asOfSeq !== null &&
			store.getState().connectionState === "online"
		) {
			sendWire({
				type: "session_history_cancel",
				id: operation.requestId,
				sessionHandle,
				expectedGeneration: channel.generation,
				snapshotId: channel.history.snapshotId,
			});
		}
		setChannel(sessionHandle, (current) => ({
			...current,
			history: { ...current.history, loading: false, error: null },
		}));
		return true;
	}

	function unsubscribeSession(sessionHandle: string): void {
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.subscribed) return;
		cancelSessionHistory(sessionHandle);
		abortHistoryForSession(sessionHandle);
		abortFutureProjection(sessionHandle);
		abortFutureLazyOperationsForSession(sessionHandle);
		rejectFutureHistoryForSession(sessionHandle, new SessionTransportError("session_not_subscribed"));
		const lruIdx = subscribedLruOrder.indexOf(sessionHandle);
		if (lruIdx !== -1) subscribedLruOrder.splice(lruIdx, 1);
		setChannel(sessionHandle, (current) => ({
			...current,
			subscribed: false,
			controllerIntent: false,
			freshLeaseBaseline: null,
			lease: { isController: false },
			history: emptyHistoryState(),
			subscriptionAdmission: null,
		}));
		claimAttempts.delete(sessionHandle);
		baselineRefreshes.delete(sessionHandle);
		subscriptionBaselines.delete(sessionHandle);
		connectionObservations.delete(sessionHandle);
		cancelExactHotRecovery(sessionHandle);
		resyncCoordinator.unsubscribe(sessionHandle);
		clearSessionResyncData(sessionHandle);
		rejectPendingForSession(sessionHandle, new SessionTransportError("session_not_subscribed"));
		if (store.getState().connectionState === "online") {
			sendWire({ type: "session_unsubscribe", sessionHandle });
		}
		clearProtectedSubscriptionOverage();
	}

	function invalidateSessionSnapshot(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (channel?.subscribed) return false;
		abortFutureProjection(sessionHandle);
		abortFutureLazyOperationsForSession(sessionHandle);
		rejectFutureHistoryForSession(
			sessionHandle,
			new SessionTransportError("session_not_ready", "Dormant Session snapshot was invalidated"),
		);
		rejectPendingForSession(
			sessionHandle,
			new SessionTransportError("session_not_ready", "Dormant Session snapshot was invalidated"),
		);
		clearSessionResyncData(sessionHandle);
		acknowledgedExtensionRequests.delete(sessionHandle);
		clearDeliveredNotifyKeys(sessionHandle);
		claimAttempts.delete(sessionHandle);
		baselineRefreshes.delete(sessionHandle);
		subscriptionBaselines.delete(sessionHandle);
		discardRawEvents(sessionHandle, false);
		if (channel) setChannel(sessionHandle, () => emptyChannel(sessionHandle));
		return true;
	}

	function claimSession(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.subscribed) return false;
		setChannel(sessionHandle, (channel) => ({ ...channel, controllerIntent: true }));
		claimSessionIfReady(sessionHandle);
		return true;
	}

	function claimSessionIfReady(sessionHandle: string): void {
		const channel = store.getState().sessions[sessionHandle];
		if (
			store.getState().connectionState !== "online" ||
			!channel?.subscribed ||
			!channel.controllerIntent ||
			!channel.baselineAuthoritative ||
			!hasFreshLeaseBaseline(channel) ||
			channel.lease.isController ||
			claimAttempts.has(sessionHandle) ||
			subscriptionBaselines.has(sessionHandle)
		) {
			return;
		}
		claimAttempts.add(sessionHandle);
		if (sendWire({ type: "session_claim", sessionHandle }) !== "sent") {
			claimAttempts.delete(sessionHandle);
		}
	}

	function releaseSession(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.subscribed) return false;
		claimAttempts.delete(sessionHandle);
		setChannel(sessionHandle, (current) => ({
			...current,
			controllerIntent: false,
			freshLeaseBaseline: null,
			lease: { isController: false },
		}));
		if (channel.runtime && channel.generation !== null) {
			frameBus.emit(
				sessionHandle,
				{
					type: "lease_status",
					serverEpoch: channel.runtime.serverEpoch,
					sessionHandle,
					generation: channel.generation,
					isController: false,
				},
				now(),
			);
		}
		if (store.getState().connectionState !== "online") return false;
		return sendWire({ type: "session_release", sessionHandle }) === "sent";
	}

	function sendCommand(
		sessionHandle: string,
		command: SessionCommandDto,
		timeoutMs = commandTimeoutMs(command.type),
	): Promise<SessionCommandResponseDto> {
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.subscribed) {
			return Promise.reject(new SessionTransportError("session_not_subscribed"));
		}
		if (store.getState().connectionState !== "online" || !socket || socket.readyState !== SOCKET_OPEN) {
			return Promise.reject(new SessionTransportError("unavailable"));
		}
		if (channel.generation === null) {
			return Promise.reject(new SessionTransportError("session_not_ready"));
		}
		const mutation = isMutation(command);
		if (mutation && !channel.baselineAuthoritative) {
			return Promise.reject(new SessionTransportError("session_not_ready"));
		}
		if (mutation && (!channel.lease.isController || !channel.lease.fencingToken)) {
			return Promise.reject(new SessionTransportError("session_read_only"));
		}
		if (mutation && !hasFreshLeaseBaseline(channel)) {
			return Promise.reject(new SessionTransportError("session_not_ready"));
		}
		commandCounter += 1;
		const id = command.id ?? `session-ui-${String(commandCounter)}-${now().toString(36)}`;
		if (pendingCommands.has(id)) {
			return Promise.reject(new SessionTransportError("duplicate_command_id"));
		}
		const generation = channel.generation;
		return new Promise<SessionCommandResponseDto>((resolve, reject) => {
			const timer = setTimeout(
				() => {
					rejectPending(id, new SessionTransportError("timeout", `Command ${command.type} timed out`));
				},
				Math.max(0, timeoutMs),
			);
			const pending: PendingCommand = {
				id,
				token: nextPendingToken++,
				serverEpoch: channel.runtime?.serverEpoch ?? "",
				workspaceId: channel.runtime?.workspaceId ?? "",
				sessionHandle,
				generation,
				commandType: command.type,
				resolve,
				reject,
				timer,
			};
			if (isFutureHistoryCommand(command.type) && activeFutureContentAdapter) {
				pending.futureHistory = createFutureHistoryOperation(pending);
			}
			pendingCommands.set(id, pending);
			const delivery = sendWire({
				type: "command",
				sessionHandle,
				expectedGeneration: generation,
				...(mutation ? { fencingToken: channel.lease.fencingToken } : {}),
				command: commandWithId(command, id),
			});
			if (delivery !== "sent") rejectPending(id, new SessionTransportError(delivery));
		});
	}

	function sendExtensionUiResponse(sessionHandle: string, response: ExtensionUiResponseDto): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (
			!channel?.subscribed ||
			channel.generation === null ||
			!channel.baselineAuthoritative ||
			!hasFreshLeaseBaseline(channel) ||
			!channel.lease.isController ||
			!channel.lease.fencingToken
		) {
			return false;
		}
		const delivered = sendWire({
			type: "extension_ui_response",
			sessionHandle,
			expectedGeneration: channel.generation,
			fencingToken: channel.lease.fencingToken,
			response,
		});
		return delivered === "sent";
	}

	function sendWire(message: SessionWsClientMessage): WireSendResult {
		if (!socket || socket.readyState !== SOCKET_OPEN) return "unavailable";
		if (sessionWsClientMessageBytes(message) > negotiatedMaxClientFrameBytes) {
			return "payload_too_large";
		}
		try {
			socket.send(JSON.stringify(message));
			return "sent";
		} catch {
			return "unavailable";
		}
	}

	function sendSubscription(sessionHandle: string, cursor?: SessionReplayCursorDto): boolean {
		return sendSubscriptionForRuntime(sessionHandle, cursor);
	}

	function sendSubscriptionForRuntime(
		sessionHandle: string,
		cursor?: SessionReplayCursorDto,
		expectedHotRuntime?: SessionRuntimeIdentityDto,
	): boolean {
		const runtime = store.getState().sessions[sessionHandle]?.runtime;
		setChannel(sessionHandle, (channel) =>
			channel.freshLeaseBaseline === null ? channel : { ...channel, freshLeaseBaseline: null },
		);
		subscriptionBaselines.set(sessionHandle, runtime ? identityKey(runtime) : null);
		const delivered = sendWire({
			type: "session_subscribe",
			sessionHandle,
			...(cursor ? { cursor } : {}),
			...(expectedHotRuntime ? { expectedHotRuntime } : {}),
		});
		if (delivered === "sent") {
			const observation = expectedHotRuntime ?? runtime;
			if (observation) connectionObservations.set(sessionHandle, observation);
		} else {
			subscriptionBaselines.delete(sessionHandle);
		}
		return delivered === "sent";
	}

	function hotRuntimeIdentity(runtime: HotRuntimeInventoryEntryDto): SessionRuntimeIdentityDto {
		return {
			serverEpoch: runtime.serverEpoch,
			sessionHandle: runtime.sessionHandle,
			workspaceId: runtime.workspaceId,
			generation: runtime.generation,
		};
	}

	function hasAuthoritativeHotBaseline(runtime: HotRuntimeInventoryEntryDto): boolean {
		const channel = store.getState().sessions[runtime.sessionHandle];
		return Boolean(
			channel?.subscribed &&
				channel.baselineAuthoritative &&
				hasFreshLeaseBaseline(channel) &&
				identitiesMatch(channel.runtime, runtime),
		);
	}

	function hasConnectionObservation(runtime: HotRuntimeInventoryEntryDto): boolean {
		const observation = connectionObservations.get(runtime.sessionHandle);
		return Boolean(observation && identitiesMatch(observation, runtime));
	}

	function isManualOnlyDegraded(runtime: HotRuntimeInventoryEntryDto): boolean {
		const recovery = resyncCoordinator.getState(runtime.sessionHandle);
		return Boolean(recovery?.phase === "degraded" && identitiesMatch(recovery.identity, runtime));
	}

	function queueHotRuntimeRecovery(runtime: HotRuntimeInventoryEntryDto): void {
		const existing = store.getState().sessions[runtime.sessionHandle];
		if (!existing?.subscribed) {
			touchSubscriptionLru(runtime.sessionHandle);
			setChannel(runtime.sessionHandle, (channel) => ({
				...channel,
				subscribed: true,
				freshLeaseBaseline: null,
				subscriptionAdmission: null,
			}));
		}
		markProtectedSubscriptionOverage(runtime.sessionHandle);
		if (
			hasAuthoritativeHotBaseline(runtime) ||
			hasConnectionObservation(runtime) ||
			isManualOnlyDegraded(runtime)
		) {
			return;
		}
		if (activeExactHotRecovery?.identity.sessionHandle === runtime.sessionHandle) return;
		if (queuedExactHotRecoveries.has(runtime.sessionHandle)) return;
		queuedExactHotRecoveries.add(runtime.sessionHandle);
		exactHotRecoveryQueue.push(runtime.sessionHandle);
		pumpExactHotRecovery();
	}

	function pumpExactHotRecovery(): void {
		if (activeExactHotRecovery || store.getState().connectionState !== "online") return;
		for (;;) {
			const sessionHandle = exactHotRecoveryQueue.shift();
			if (!sessionHandle) return;
			queuedExactHotRecoveries.delete(sessionHandle);
			const desired = hotRuntimeByHandle.get(sessionHandle);
			if (
				!desired ||
				hasAuthoritativeHotBaseline(desired) ||
				hasConnectionObservation(desired) ||
				isManualOnlyDegraded(desired)
			) {
				continue;
			}
			const channel = store.getState().sessions[sessionHandle];
			if (!channel?.subscribed) continue;
			const identity = hotRuntimeIdentity(desired);
			activeExactHotRecovery = {
				identity,
				baselineReady: channel.baselineAuthoritative && identitiesMatch(channel.runtime, identity),
				leaseReady: false,
				recoveryStarted: false,
			};
			const cursor = validCursor(channel);
			if (sendSubscriptionForRuntime(sessionHandle, cursor, identity)) return;
			activeExactHotRecovery = null;
		}
	}

	function cancelExactHotRecovery(sessionHandle: string): void {
		if (queuedExactHotRecoveries.delete(sessionHandle)) {
			const index = exactHotRecoveryQueue.indexOf(sessionHandle);
			if (index !== -1) exactHotRecoveryQueue.splice(index, 1);
		}
		if (activeExactHotRecovery?.identity.sessionHandle === sessionHandle) {
			activeExactHotRecovery = null;
		}
		pumpExactHotRecovery();
	}

	function advanceExactHotRecovery(identity: SessionRuntimeIdentityDto, kind: "baseline" | "lease"): void {
		const active = activeExactHotRecovery;
		if (!active || !identitiesMatch(active.identity, identity)) return;
		if (kind === "baseline") active.baselineReady = true;
		else active.leaseReady = true;
		if (!active.baselineReady || !active.leaseReady) return;
		activeExactHotRecovery = null;
		const desired = hotRuntimeByHandle.get(identity.sessionHandle);
		if (desired && !identitiesMatch(desired, identity)) queueHotRuntimeRecovery(desired);
		pumpExactHotRecovery();
	}

	function settleExactHotRecoveryError(sessionHandle: string): boolean {
		const active = activeExactHotRecovery;
		if (!active || active.identity.sessionHandle !== sessionHandle) return false;
		activeExactHotRecovery = null;
		const observation = connectionObservations.get(sessionHandle);
		if (observation && identitiesMatch(observation, active.identity)) {
			connectionObservations.delete(sessionHandle);
		}
		const desired = hotRuntimeByHandle.get(sessionHandle);
		const superseded = Boolean(desired && !identitiesMatch(desired, active.identity));
		if (desired && superseded) queueHotRuntimeRecovery(desired);
		pumpExactHotRecovery();
		return true;
	}

	function handleHotRuntimeInventory(message: HotRuntimeInventoryDto, initial = false): void {
		if (negotiatedServerEpoch !== null && message.serverEpoch !== negotiatedServerEpoch) return;
		if (message.revision <= hotRuntimeRevision) return;
		const previous = hotRuntimeByHandle;
		const next = new Map(message.runtimes.map((runtime) => [runtime.sessionHandle, runtime]));
		hotRuntimeRevision = message.revision;
		hotRuntimeByHandle = next;
		store.setState({ hotRuntimeInventory: message });
		globalBus.emit(message);

		for (const [sessionHandle] of previous) {
			if (next.has(sessionHandle)) continue;
			connectionObservations.delete(sessionHandle);
			cancelExactHotRecovery(sessionHandle);
			const channel = store.getState().sessions[sessionHandle];
			if (channel?.subscribed) unsubscribeSession(sessionHandle);
		}
		if (initial) {
			clearHelloTimer();
			reconnectAttempt = 0;
			store.setState({ connectionState: "online" });
			resyncCoordinator.reconnect();
		}
		for (const runtime of message.runtimes) queueHotRuntimeRecovery(runtime);

		if (initial) {
			for (const channel of Object.values(store.getState().sessions)) {
				if (!channel.subscribed || next.has(channel.sessionHandle)) continue;
				const recovery = resyncCoordinator.getState(channel.sessionHandle);
				if (recovery?.phase === "degraded" && identitiesMatch(recovery.identity, channel.runtime)) continue;
				sendSubscription(channel.sessionHandle, validCursor(channel));
			}
			const token = { serverEpoch: message.serverEpoch, revision: message.revision };
			for (const waiter of initialInventoryWaiters) waiter.resolve(token);
			initialInventoryWaiters.clear();
		}
	}

	function ingestServerMessage(message: SessionWsServerMessage): void {
		switch (message.type) {
			case "hot_runtime_inventory":
				handleHotRuntimeInventory(message);
				return;
			case "response":
				handleResponse(message);
				return;
			case "runtime_state":
				handleRuntimeState(message);
				return;
			case "event":
			case "extension_ui_request":
			case "extension_ui_closed":
				handleReplayFrame(message);
				return;
			case "lease_status":
				handleLease(message);
				return;
			case "resync_required":
				handleResyncRequired(message);
				return;
			case "session_snapshot":
				handleSessionSnapshot(message);
				return;
			case "session_snapshot_begin":
				handleSessionSnapshotBegin(message, "current");
				return;
			case "session_snapshot_chunk":
				handleSessionSnapshotChunk(message, "current");
				return;
			case "session_snapshot_end":
				handleSessionSnapshotEnd(message, "current");
				return;
			case "session_history_page_begin":
				handleSessionHistoryPageBegin(message, "current");
				return;
			case "session_history_page_chunk":
				handleSessionHistoryPageChunk(message, "current");
				return;
			case "session_history_page_end":
				handleSessionHistoryPageEnd(message, "current");
				return;
			case "extension_ui_snapshot":
				handleExtensionSnapshot(message);
				return;
			case "extension_ui_result":
				handleExtensionResult(message);
				return;
			case "session_rekeyed":
				handleRekey(message);
				return;
			case "session_error":
				handleSessionError(message);
				return;
			case "session_directory_changed":
			case "auth_changed":
				globalBus.emit(message);
				return;
		}
	}

	function assertCurrentMessage(
		value: unknown,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): SessionMessageDto {
		if (!isSessionMessageDto(value, guardContext ?? undefined)) {
			throw new Error("Future Session history message failed its current product guard");
		}
		return value;
	}

	function assertCurrentEntry(
		value: unknown,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): SessionEntryDto {
		if (!isSessionEntryDto(value, guardContext ?? undefined)) {
			throw new Error("Future Session history entry failed its current product guard");
		}
		return value;
	}

	function assertCurrentTree(
		value: unknown,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): SessionTreeNodeDto[] {
		if (!isSessionTreeDto(value, guardContext ?? undefined)) {
			throw new Error("Future Session history tree failed its current product guard");
		}
		return value;
	}

	function assertCurrentResponse(
		value: unknown,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): SessionCommandResponseDto {
		if (!isSessionCommandResponseDto(value, guardContext ?? undefined)) {
			throw new Error("Future Session command response failed its current product guard");
		}
		return value;
	}

	async function materializeFutureMessage(
		message: FutureSessionMessageDto,
		adapter: FutureSessionContentAdapter,
		signal: AbortSignal,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): Promise<SessionMessageDto> {
		let candidate: unknown;
		switch (message.role) {
			case "assistant": {
				const content: Extract<SessionMessageDto, { role: "assistant" }>["content"] = [];
				for (const block of message.content) {
					if (block.type !== "toolCall") {
						content.push(block);
						continue;
					}
					const argumentsValue = await adapter.materializeJsonRoot(
						block.arguments,
						isBoundedJsonValue,
						signal,
					);
					content.push({ ...block, arguments: argumentsValue });
				}
				candidate = { ...message, content };
				break;
			}
			case "toolResult": {
				const content: Extract<SessionMessageDto, { role: "toolResult" }>["content"] = [];
				for (const block of message.content) {
					if (block.type !== "text") {
						content.push(block);
						continue;
					}
					const text = await adapter.materializeTextPayload(block.text, signal);
					content.push({ ...block, text });
				}
				if (message.details === undefined) {
					candidate = { ...message, content };
				} else {
					const details = await adapter.materializeJsonRoot(message.details, isBoundedJsonValue, signal);
					candidate = { ...message, content, details };
				}
				break;
			}
			case "bashExecution": {
				const output = await adapter.materializeTextPayload(message.output, signal);
				candidate = { ...message, output };
				break;
			}
			case "custom": {
				let content: Extract<SessionMessageDto, { role: "custom" }>["content"];
				if (Array.isArray(message.content)) {
					content = [];
					for (const block of message.content) {
						if (block.type !== "text") {
							content.push(block);
							continue;
						}
						const text = await adapter.materializeTextPayload(block.text, signal);
						content.push({ ...block, text });
					}
				} else {
					content = message.content;
				}
				if (message.details === undefined) {
					candidate = { ...message, content };
				} else {
					const details = await adapter.materializeJsonRoot(message.details, isBoundedJsonValue, signal);
					candidate = { ...message, content, details };
				}
				break;
			}
			default:
				candidate = message;
		}
		return assertCurrentMessage(candidate, guardContext);
	}

	async function materializeFutureEntry(
		entry: FutureSessionEntryDto,
		adapter: FutureSessionContentAdapter,
		signal: AbortSignal,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): Promise<SessionEntryDto> {
		let candidate: unknown;
		if (entry.type === "message") {
			candidate = {
				...entry,
				message: await materializeFutureMessage(entry.message, adapter, signal, guardContext),
			};
		} else if (entry.type === "custom_message") {
			let content: Extract<SessionEntryDto, { type: "custom_message" }>["content"];
			if (Array.isArray(entry.content)) {
				content = [];
				for (const block of entry.content) {
					if (block.type !== "text") {
						content.push(block);
						continue;
					}
					const text = await adapter.materializeTextPayload(block.text, signal);
					content.push({ ...block, text });
				}
			} else {
				content = entry.content;
			}
			if (entry.details === undefined) {
				candidate = { ...entry, content };
			} else {
				const details = await adapter.materializeJsonRoot(entry.details, isBoundedJsonValue, signal);
				candidate = { ...entry, content, details };
			}
		} else {
			candidate = entry;
		}
		return assertCurrentEntry(candidate, guardContext);
	}

	async function materializeFutureTreeNode(
		node: FutureSessionTreeNodeDto,
		adapter: FutureSessionContentAdapter,
		signal: AbortSignal,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): Promise<SessionTreeNodeDto> {
		const children: SessionTreeNodeDto[] = [];
		for (const child of node.children) {
			children.push(await materializeFutureTreeNode(child, adapter, signal, guardContext));
		}
		const candidate: unknown = {
			...node,
			entry: await materializeFutureEntry(node.entry, adapter, signal, guardContext),
			children,
		};
		const checked = assertCurrentTree([candidate], guardContext);
		const first = checked[0];
		if (!first) throw new Error("Future Session history tree root disappeared during materialization");
		return first;
	}

	async function materializeFutureResponse(
		response: FutureSessionCommandResponseDto,
		adapter: FutureSessionContentAdapter,
		signal: AbortSignal,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
		futureGuardContext: Readonly<FutureSessionContentRefGuardContext> | null,
	): Promise<SessionCommandResponseDto> {
		if (futureGuardContext && !isFutureSessionCommandResponseDto(response, futureGuardContext)) {
			throw new Error("Future Session command response failed its negotiated future guard");
		}
		if (response.success === false) return assertCurrentResponse(response, guardContext);
		switch (response.command) {
			case "get_messages": {
				const messages: SessionMessageDto[] = [];
				for (const message of response.data.messages) {
					messages.push(await materializeFutureMessage(message, adapter, signal, guardContext));
				}
				return assertCurrentResponse({ ...response, data: { ...response.data, messages } }, guardContext);
			}
			case "get_entries": {
				const entries: SessionEntryDto[] = [];
				for (const entry of response.data.entries) {
					entries.push(await materializeFutureEntry(entry, adapter, signal, guardContext));
				}
				return assertCurrentResponse({ ...response, data: { ...response.data, entries } }, guardContext);
			}
			case "get_tree": {
				const tree: SessionTreeNodeDto[] = [];
				for (const node of response.data.tree) {
					tree.push(await materializeFutureTreeNode(node, adapter, signal, guardContext));
				}
				return assertCurrentResponse({ ...response, data: { ...response.data, tree } }, guardContext);
			}
			default:
				return assertCurrentResponse(response, guardContext);
		}
	}

	function createFutureHistoryOperation(pending: PendingCommand): FutureHistoryOperation {
		return {
			id: pending.id,
			token: pending.token,
			identity: {
				serverEpoch: pending.serverEpoch,
				workspaceId: pending.workspaceId,
				sessionHandle: pending.sessionHandle,
				generation: pending.generation,
			},
			controller: new AbortController(),
			started: false,
		};
	}

	function currentFutureHistoryPending(operation: FutureHistoryOperation): PendingCommand | null {
		const pending = pendingCommands.get(operation.id);
		if (
			!pending ||
			pending.token !== operation.token ||
			pending.futureHistory !== operation ||
			!isFutureHistoryCommand(pending.commandType) ||
			pending.serverEpoch !== operation.identity.serverEpoch ||
			pending.workspaceId !== operation.identity.workspaceId ||
			pending.sessionHandle !== operation.identity.sessionHandle ||
			pending.generation !== operation.identity.generation
		) {
			return null;
		}
		const channel = store.getState().sessions[operation.identity.sessionHandle];
		return channel?.subscribed && identitiesMatch(channel.runtime, operation.identity) ? pending : null;
	}

	function abortFutureHistoryOperation(pending: PendingCommand): void {
		const operation = pending.futureHistory;
		if (!operation) return;
		pending.futureHistory = undefined;
		operation.controller.abort();
	}

	function rejectFutureHistoryForSession(sessionHandle: string, error: Error): void {
		for (const pending of [...pendingCommands.values()]) {
			if (
				isFutureHistoryCommand(pending.commandType) &&
				(pending.sessionHandle === sessionHandle ||
					pending.futureHistory?.identity.sessionHandle === sessionHandle)
			) {
				rejectPending(pending.id, error);
			}
		}
	}

	function abortAllFutureHistoryOperations(): void {
		for (const pending of pendingCommands.values()) {
			if (pending.futureHistory) abortFutureHistoryOperation(pending);
		}
	}

	function handleInvalidFutureResponse(value: unknown): boolean {
		const candidate = futureResponseEnvelopeCandidate(value);
		if (!candidate) return false;
		const pending = pendingCommands.get(candidate.id);
		if (!pending || !isFutureHistoryCommand(pending.commandType)) return false;
		const exactIdentity =
			pending.commandType === candidate.command &&
			pending.serverEpoch === candidate.serverEpoch &&
			pending.sessionHandle === candidate.sessionHandle &&
			pending.generation === candidate.generation;
		if (!exactIdentity) {
			rejectPending(
				pending.id,
				new SessionTransportError(
					"response_mismatch",
					`Response ${pending.id} failed its Session identity fence`,
				),
			);
			return true;
		}
		const error = new Error("Future Session command response failed its negotiated guard");
		const channel = store.getState().sessions[candidate.sessionHandle];
		if (pending.futureHistory && currentFutureHistoryPending(pending.futureHistory) === pending) {
			reportProjectionFailure(candidate.sessionHandle, candidate.generation, error);
		} else if (
			channel?.subscribed &&
			identitiesMatch(channel.runtime, {
				serverEpoch: candidate.serverEpoch,
				workspaceId: pending.workspaceId,
				sessionHandle: candidate.sessionHandle,
				generation: candidate.generation,
			})
		) {
			reportProjectionFailure(candidate.sessionHandle, candidate.generation, error);
		}
		rejectPending(pending.id, error);
		return true;
	}

	function startFutureHistoryMaterialization(
		message: FutureSessionResponseFrameDto,
		pending: PendingCommand,
	): boolean {
		const responseKey = JSON.stringify(message);
		if (pending.futureHistoryResponseKey !== undefined) {
			if (pending.futureHistoryResponseKey === responseKey) return true;
			rejectPending(
				pending.id,
				new SessionTransportError(
					"response_mismatch",
					`Response ${pending.id} changed while future history was materializing`,
				),
			);
			return true;
		}
		const operation = pending.futureHistory ?? createFutureHistoryOperation(pending);
		if (operation.started) return true;
		operation.started = true;
		pending.futureHistory = operation;
		pending.futureHistoryBarrierSeq = message.barrierSeq;
		pending.futureHistoryResponseKey = responseKey;
		const adapter = activeFutureContentAdapter;
		if (!adapter) {
			rejectPending(
				pending.id,
				new SessionTransportError("unavailable", "Future history materialization is disabled"),
			);
			return true;
		}
		const guardContext = attachmentGuardContext;
		const futureGuardContext = futureContentRefGuardContext;
		void materializeFutureResponse(
			message.response,
			adapter,
			operation.controller.signal,
			guardContext,
			futureGuardContext,
		)
			.then((response) => {
				if (operation.controller.signal.aborted || currentFutureHistoryPending(operation) !== pending) return;
				pending.futureHistory = undefined;
				pending.response = { ...message, response };
				resolvePendingResponse(pending);
			})
			.catch((error: unknown) => {
				if (operation.controller.signal.aborted || currentFutureHistoryPending(operation) !== pending) return;
				const failure = error instanceof Error ? error : new Error(String(error));
				reportProjectionFailure(pending.sessionHandle, pending.generation, failure);
				rejectPending(pending.id, failure);
			});
		return true;
	}

	function handleFutureResponse(message: FutureSessionResponseFrameDto): boolean {
		const id = message.response.id;
		if (!id) return true;
		const pending = pendingCommands.get(id);
		if (!pending) return true;
		const commandMatches = pending.commandType === message.response.command;
		const originalTargetMatches =
			pending.serverEpoch === message.serverEpoch &&
			pending.sessionHandle === message.sessionHandle &&
			pending.generation === message.generation;
		const transitionTargetMatches =
			isIdentityTransitionCommand(pending.commandType) &&
			message.previousSessionHandle === pending.sessionHandle;
		if (!commandMatches || (!originalTargetMatches && !transitionTargetMatches)) {
			rejectPending(
				id,
				new SessionTransportError(
					"response_mismatch",
					`Response ${id} targeted ${message.sessionHandle}@${String(message.generation)}`,
				),
			);
			return true;
		}
		if (isFutureHistoryCommand(pending.commandType)) {
			return startFutureHistoryMaterialization(message, pending);
		}
		const adapter = activeFutureContentAdapter;
		if (!adapter) {
			rejectPending(
				id,
				new SessionTransportError("unavailable", "Future response materialization is disabled"),
			);
			return true;
		}
		const controller = new AbortController();
		void materializeFutureResponse(
			message.response,
			adapter,
			controller.signal,
			attachmentGuardContext,
			futureContentRefGuardContext,
		)
			.then((response) => {
				if (controller.signal.aborted || pendingCommands.get(id) !== pending) return;
				pending.response = { ...message, response };
				resolvePendingResponse(pending);
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted || pendingCommands.get(id) !== pending) return;
				rejectPending(id, error instanceof Error ? error : new Error(String(error)));
			});
		return true;
	}

	function ingestFutureFrameMessage(
		message: FutureSessionTransportFrameMessage,
		rawWireBytes: number,
	): boolean {
		const adapter = activeFutureContentAdapter;
		if (!adapter || disposed) return false;
		if (
			!Number.isSafeInteger(rawWireBytes) ||
			rawWireBytes <= 0 ||
			rawWireBytes > negotiatedMaxServerFrameBytes
		) {
			return false;
		}
		if (message.type === "response") return handleFutureResponse(message);
		const identity = futureFrameIdentity(message);
		if (!identity || !isCurrentFutureProjectionIdentity(identity)) return false;
		switch (message.type) {
			case "event":
			case "extension_ui_request":
			case "extension_ui_closed":
				return enqueueFutureProjection(identity, rawWireBytes, null, async (signal) => {
					const projected = await adapter.materializeReplayFrame(message, signal);
					return () => handleReplayFrame(projected, "future");
				});
			case "session_snapshot": {
				const key = identityKey(identity);
				const waiter = snapshotWaiters.get(key);
				if (!waiter) return false;
				return enqueueFutureProjection(identity, rawWireBytes, waiter, async (signal) => {
					const projected = await adapter.materializeSnapshot(message, signal);
					return () => {
						if (snapshotWaiters.get(key)?.token !== waiter.token) return;
						commitSessionSnapshot(projected, "future");
					};
				});
			}
			case "session_snapshot_begin":
				handleSessionSnapshotBegin(message, "future");
				return true;
			case "session_snapshot_chunk":
				handleSessionSnapshotChunk(message, "future");
				return true;
			case "session_snapshot_end":
				handleSessionSnapshotEnd(message, "future");
				return true;
			case "session_history_page_begin":
				handleSessionHistoryPageBegin(message, "future");
				return true;
			case "session_history_page_chunk":
				handleSessionHistoryPageChunk(message, "future");
				return true;
			case "session_history_page_end":
				handleSessionHistoryPageEnd(message, "future");
				return true;
			case "extension_ui_snapshot":
				return enqueueFutureProjection(identity, rawWireBytes, null, async (signal) => {
					const projected = await adapter.materializeExtensionSnapshot(message, signal);
					return () => handleExtensionSnapshot(projected, "future");
				});
		}
	}

	function handleSessionSnapshotBegin(
		message: HistorySnapshotBegin,
		productMode: "current" | "future",
	): void {
		const channel = store.getState().sessions[message.sessionHandle];
		if (!channel?.subscribed || !channel.resync || !identitiesMatch(channel.runtime, message)) return;
		const key = identityKey(message);
		const waiter = snapshotWaiters.get(key);
		if (!waiter) return;
		const previous = snapshotHistoryAssemblies.get(key);
		if (previous) {
			snapshotHistoryAssemblies.delete(key);
			previous.controller.abort();
		}
		const assembler = new SessionHistoryStreamAssembler<
			unknown,
			HistorySnapshotBegin,
			HistorySnapshotChunk,
			SessionSnapshotEndDto
		>("snapshot");
		try {
			assembler.begin(message);
		} catch (error) {
			failChunkedSnapshot(message, error instanceof Error ? error : new Error(String(error)), waiter);
			return;
		}
		const assembly: SnapshotHistoryAssembly = {
			identity: message,
			snapshotId: message.snapshotId,
			productMode,
			controller: new AbortController(),
			assembler,
			waiterToken: waiter.token,
			finishing: false,
		};
		snapshotHistoryAssemblies.set(key, assembly);
		setChannel(message.sessionHandle, (current) => ({
			...current,
			history: {
				...message.history,
				snapshotId: message.snapshotId,
				asOfSeq: message.asOfSeq,
				loading: true,
				error: null,
			},
		}));
	}

	function handleSessionSnapshotChunk(
		message: HistorySnapshotChunk,
		productMode: "current" | "future",
	): void {
		const assembly = snapshotHistoryAssemblies.get(identityKey(message));
		if (!assembly || assembly.productMode !== productMode || assembly.finishing) return;
		try {
			assembly.assembler.chunk(message);
		} catch (error) {
			failChunkedSnapshot(
				message,
				error instanceof Error ? error : new Error(String(error)),
				currentSnapshotWaiter(assembly),
			);
		}
	}

	function handleSessionSnapshotEnd(message: SessionSnapshotEndDto, productMode: "current" | "future"): void {
		const key = identityKey(message);
		const assembly = snapshotHistoryAssemblies.get(key);
		if (!assembly || assembly.productMode !== productMode || assembly.finishing) return;
		let completed: ReturnType<typeof assembly.assembler.end>;
		try {
			completed = assembly.assembler.end(message);
		} catch (error) {
			failChunkedSnapshot(
				message,
				error instanceof Error ? error : new Error(String(error)),
				currentSnapshotWaiter(assembly),
			);
			return;
		}
		assembly.finishing = true;
		if (productMode === "current") {
			snapshotHistoryAssemblies.delete(key);
			commitSessionSnapshot(
				currentSnapshotFromHistory(completed.begin as SessionSnapshotBeginDto, completed.messages),
			);
			return;
		}
		void finishFutureChunkedSnapshot(assembly, completed);
	}

	function currentSnapshotWaiter(assembly: SnapshotHistoryAssembly): SnapshotWaiter | undefined {
		const waiter = snapshotWaiters.get(identityKey(assembly.identity));
		return waiter?.token === assembly.waiterToken ? waiter : undefined;
	}

	function currentSnapshotFromHistory(
		begin: SessionSnapshotBeginDto,
		messages: unknown[],
	): SessionSnapshotDto {
		const { type: _type, history: _history, ...header } = begin;
		return {
			...header,
			type: "session_snapshot",
			settledMessages: messages as SessionMessageDto[],
		};
	}

	async function finishFutureChunkedSnapshot(
		assembly: SnapshotHistoryAssembly,
		completed: ReturnType<typeof assembly.assembler.end>,
	): Promise<void> {
		const adapter = activeFutureContentAdapter;
		const begin = completed.begin;
		try {
			if (!adapter || begin.type !== "session_snapshot_begin") {
				throw new Error("Future history snapshot materialization is unavailable");
			}
			const { type: _type, history: _history, ...header } = begin;
			const projected = await adapter.materializeSnapshot(
				{
					...header,
					type: "session_snapshot",
					settledMessages: completed.messages as FutureSessionMessageDto[],
				} as FutureSessionSnapshotDto,
				assembly.controller.signal,
			);
			if (!isCurrentSnapshotAssembly(assembly)) return;
			snapshotHistoryAssemblies.delete(identityKey(assembly.identity));
			commitSessionSnapshot(projected, "future");
		} catch (error) {
			if (assembly.controller.signal.aborted) return;
			failChunkedSnapshot(
				assembly.identity,
				error instanceof Error ? error : new Error(String(error)),
				currentSnapshotWaiter(assembly),
			);
		}
	}

	function isCurrentSnapshotAssembly(assembly: SnapshotHistoryAssembly): boolean {
		const channel = store.getState().sessions[assembly.identity.sessionHandle];
		return Boolean(
			snapshotHistoryAssemblies.get(identityKey(assembly.identity)) === assembly &&
				currentSnapshotWaiter(assembly) &&
				channel?.subscribed &&
				channel.resync &&
				identitiesMatch(channel.runtime, assembly.identity),
		);
	}

	function failChunkedSnapshot(
		identity: SessionRuntimeIdentityDto,
		error: Error,
		waiter?: SnapshotWaiter,
	): void {
		const key = identityKey(identity);
		const assembly = snapshotHistoryAssemblies.get(key);
		if (assembly) {
			snapshotHistoryAssemblies.delete(key);
			assembly.controller.abort();
		}
		if (waiter && snapshotWaiters.get(key)?.token === waiter.token) {
			snapshotWaiters.delete(key);
			waiter.reject(error);
		}
		setChannel(identity.sessionHandle, (channel) =>
			channel.history.snapshotId === (assembly?.snapshotId ?? "")
				? { ...channel, history: { ...channel.history, loading: false, error: error.message } }
				: channel,
		);
		reportProjectionFailure(identity.sessionHandle, identity.generation, error);
	}

	function handleSessionHistoryPageBegin(
		message: SessionHistoryPageBeginDto,
		productMode: "current" | "future",
	): void {
		const operation = pageHistoryAssemblies.get(message.requestId);
		const channel = store.getState().sessions[message.sessionHandle];
		if (!operation || operation.productMode !== productMode) return;
		if (
			!channel?.subscribed ||
			!channel.baselineAuthoritative ||
			!identitiesMatch(channel.runtime, operation.identity) ||
			!identitiesMatch(operation.identity, message) ||
			channel.history.snapshotId !== message.snapshotId ||
			channel.history.asOfSeq !== message.asOfSeq
		) {
			failHistoryPage(operation, new Error("History page crossed an identity fence"));
			return;
		}
		try {
			operation.assembler.begin(message);
		} catch (error) {
			failHistoryPage(operation, error instanceof Error ? error : new Error(String(error)));
		}
	}

	function handleSessionHistoryPageChunk(message: HistoryPageChunk, productMode: "current" | "future"): void {
		const operation = pageHistoryAssemblies.get(message.requestId);
		if (!operation || operation.productMode !== productMode || operation.finishing) return;
		try {
			operation.assembler.chunk(message);
		} catch (error) {
			failHistoryPage(operation, error instanceof Error ? error : new Error(String(error)));
		}
	}

	function handleSessionHistoryPageEnd(
		message: SessionHistoryPageEndDto,
		productMode: "current" | "future",
	): void {
		const operation = pageHistoryAssemblies.get(message.requestId);
		if (!operation || operation.productMode !== productMode || operation.finishing) return;
		let completed: ReturnType<typeof operation.assembler.end>;
		try {
			completed = operation.assembler.end(message);
		} catch (error) {
			failHistoryPage(operation, error instanceof Error ? error : new Error(String(error)));
			return;
		}
		operation.finishing = true;
		if (productMode === "current") {
			pageHistoryAssemblies.delete(operation.requestId);
			completeHistoryPage(
				operation,
				completed.messages as SessionMessageDto[],
				completed.begin,
				completed.end,
			);
			return;
		}
		void finishFutureHistoryPage(operation, completed);
	}

	function completeHistoryPage(
		operation: PageHistoryAssembly,
		messages: SessionMessageDto[],
		begin: SessionHistoryPageBeginDto,
		end: SessionHistoryPageEndDto,
	): void {
		const channel = store.getState().sessions[operation.identity.sessionHandle];
		if (
			!channel?.subscribed ||
			!channel.baselineAuthoritative ||
			!identitiesMatch(channel.runtime, operation.identity) ||
			channel.history.snapshotId !== begin.snapshotId ||
			channel.history.asOfSeq !== begin.asOfSeq
		) {
			return;
		}
		const frame: SessionHistoryPageLoadedFrame = {
			...operation.identity,
			type: "session_history_page_loaded",
			requestId: operation.requestId,
			snapshotId: begin.snapshotId,
			asOfSeq: begin.asOfSeq,
			messages,
		};
		const delivery = frameBus.emit(operation.identity.sessionHandle, frame, now());
		if (delivery.errors.length > 0 || delivery.deferred) {
			failHistoryPage(
				operation,
				delivery.errors[0] instanceof Error
					? delivery.errors[0]
					: new Error("History page projection failed"),
			);
			return;
		}
		setChannel(operation.identity.sessionHandle, (current) => ({
			...current,
			history: {
				...current.history,
				totalMessages: begin.history.totalMessages,
				totalBytes: begin.history.totalBytes,
				loadedMessages: current.history.loadedMessages + end.itemCount,
				loadedBytes: current.history.loadedBytes + end.byteCount,
				nextCursor: end.nextCursor,
				loading: false,
				error: null,
			},
		}));
	}

	async function finishFutureHistoryPage(
		operation: PageHistoryAssembly,
		completed: ReturnType<typeof operation.assembler.end>,
	): Promise<void> {
		try {
			const adapter = activeFutureContentAdapter;
			if (!adapter) throw new Error("Future history page materialization is unavailable");
			const messages: SessionMessageDto[] = [];
			for (const message of completed.messages as FutureSessionMessageDto[]) {
				messages.push(
					await materializeFutureMessage(
						message,
						adapter,
						operation.controller.signal,
						attachmentGuardContext,
					),
				);
			}
			if (!isCurrentPageAssembly(operation)) return;
			pageHistoryAssemblies.delete(operation.requestId);
			completeHistoryPage(operation, messages, completed.begin, completed.end);
		} catch (error) {
			if (operation.controller.signal.aborted) return;
			failHistoryPage(operation, error instanceof Error ? error : new Error(String(error)));
		}
	}

	function isCurrentPageAssembly(operation: PageHistoryAssembly): boolean {
		const channel = store.getState().sessions[operation.identity.sessionHandle];
		return Boolean(
			pageHistoryAssemblies.get(operation.requestId) === operation &&
				channel?.subscribed &&
				channel.baselineAuthoritative &&
				identitiesMatch(channel.runtime, operation.identity),
		);
	}

	function failHistoryPage(operation: PageHistoryAssembly, error: Error): void {
		if (operation.controller.signal.aborted) return;
		if (pageHistoryAssemblies.get(operation.requestId) === operation) {
			pageHistoryAssemblies.delete(operation.requestId);
		}
		operation.controller.abort();
		setChannel(operation.identity.sessionHandle, (channel) => ({
			...channel,
			history: { ...channel.history, loading: false, error: error.message },
		}));
	}

	function futureFrameIdentity(
		message: FutureSessionTransportFrameMessage,
	): SessionRuntimeIdentityDto | null {
		if (message.type === "response") return null;
		if (message.type === "extension_ui_snapshot") {
			const runtime = store.getState().sessions[message.sessionHandle]?.runtime;
			if (
				!runtime ||
				runtime.serverEpoch !== message.serverEpoch ||
				runtime.generation !== message.generation
			) {
				return null;
			}
			return runtime;
		}
		return {
			serverEpoch: message.serverEpoch,
			workspaceId: message.workspaceId,
			sessionHandle: message.sessionHandle,
			generation: message.generation,
		};
	}

	function isCurrentFutureProjectionIdentity(identity: SessionRuntimeIdentityDto): boolean {
		const channel = store.getState().sessions[identity.sessionHandle];
		return Boolean(channel?.subscribed && identitiesMatch(channel.runtime, identity));
	}

	function captureFutureLazyIdentity(identity: FutureSessionLazyIdentity): FutureSessionLazyIdentity {
		return Object.freeze({
			serverEpoch: identity.serverEpoch,
			workspaceId: identity.workspaceId,
			sessionHandle: identity.sessionHandle,
			generation: identity.generation,
		});
	}

	function isCurrentFutureLazyIdentity(identity: FutureSessionLazyIdentity): boolean {
		const channel = store.getState().sessions[identity.sessionHandle];
		return Boolean(
			channel?.subscribed &&
				channel.baselineAuthoritative &&
				channel.recovery === null &&
				identitiesMatch(channel.runtime, identity),
		);
	}

	function futureLazyIdentityScope(identity: FutureSessionLazyIdentity): FutureLazyIdentityScope {
		const key = identityKey(identity);
		const existing = futureLazyIdentityScopes.get(key);
		if (existing && !existing.controller.signal.aborted) return existing;
		if (existing) futureLazyIdentityScopes.delete(key);
		const scope: FutureLazyIdentityScope = {
			identity,
			controller: new AbortController(),
			operations: new Set<FutureLazyOperation>(),
		};
		futureLazyIdentityScopes.set(key, scope);
		return scope;
	}

	function registerFutureLazyOperation(
		identity: FutureSessionLazyIdentity,
		callerSignal: AbortSignal | undefined,
	): FutureLazyOperation {
		const scope = futureLazyIdentityScope(identity);
		const controller = new AbortController();
		const onIdentityAbort = (): void => controller.abort();
		const onCallerAbort = (): void => controller.abort();
		scope.controller.signal.addEventListener("abort", onIdentityAbort, { once: true });
		callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
		if (scope.controller.signal.aborted || callerSignal?.aborted) controller.abort();
		const operation: FutureLazyOperation = {
			scope,
			controller,
			onIdentityAbort,
			callerSignal: callerSignal ?? null,
			onCallerAbort: callerSignal ? onCallerAbort : null,
		};
		scope.operations.add(operation);
		return operation;
	}

	function releaseFutureLazyOperation(operation: FutureLazyOperation): void {
		operation.scope.controller.signal.removeEventListener("abort", operation.onIdentityAbort);
		if (operation.callerSignal && operation.onCallerAbort) {
			operation.callerSignal.removeEventListener("abort", operation.onCallerAbort);
		}
		operation.scope.operations.delete(operation);
		const key = identityKey(operation.scope.identity);
		if (futureLazyIdentityScopes.get(key) === operation.scope && operation.scope.operations.size === 0) {
			futureLazyIdentityScopes.delete(key);
		}
	}

	function abortFutureLazyIdentity(identity: FutureSessionLazyIdentity): void {
		const key = identityKey(identity);
		const scope = futureLazyIdentityScopes.get(key);
		if (!scope) return;
		futureLazyIdentityScopes.delete(key);
		scope.controller.abort();
	}

	function abortFutureLazyOperationsForSession(sessionHandle: string): void {
		for (const [key, scope] of [...futureLazyIdentityScopes]) {
			if (scope.identity.sessionHandle !== sessionHandle) continue;
			futureLazyIdentityScopes.delete(key);
			scope.controller.abort();
		}
	}

	function abortAllFutureLazyOperations(): void {
		for (const scope of futureLazyIdentityScopes.values()) scope.controller.abort();
		futureLazyIdentityScopes.clear();
	}

	async function resolveFutureText(
		identity: FutureSessionLazyIdentity,
		payload: FutureSessionTextPayloadProjection,
		callerSignal?: AbortSignal,
	): Promise<string> {
		const captured = captureFutureLazyIdentity(identity);
		if (disposed || callerSignal?.aborted || !isCurrentFutureLazyIdentity(captured)) {
			throw futureLazyAbortError();
		}
		const adapter = activeFutureContentAdapter;
		if (!adapter) {
			throw new SessionTransportError("unavailable", "Future Session lazy content is disabled");
		}
		const operation = registerFutureLazyOperation(captured, callerSignal);
		try {
			const value = await adapter.materializeTextPayload(payload.value, operation.controller.signal);
			if (operation.controller.signal.aborted || !isCurrentFutureLazyIdentity(captured)) {
				throw futureLazyAbortError();
			}
			return value;
		} catch (error: unknown) {
			if (operation.controller.signal.aborted || !isCurrentFutureLazyIdentity(captured)) {
				throw futureLazyAbortError();
			}
			if (reportProjectionFailure(captured.sessionHandle, captured.generation, error)) {
				abortFutureLazyIdentity(captured);
			}
			throw error;
		} finally {
			releaseFutureLazyOperation(operation);
		}
	}

	async function resolveFutureJson<T>(
		identity: FutureSessionLazyIdentity,
		payload: FutureSessionJsonRootProjection,
		fieldGuard: FutureSessionJsonFieldGuard<T>,
		callerSignal?: AbortSignal,
	): Promise<T> {
		const captured = captureFutureLazyIdentity(identity);
		if (disposed || callerSignal?.aborted || !isCurrentFutureLazyIdentity(captured)) {
			throw futureLazyAbortError();
		}
		const adapter = activeFutureContentAdapter;
		if (!adapter) {
			throw new SessionTransportError("unavailable", "Future Session lazy content is disabled");
		}
		const operation = registerFutureLazyOperation(captured, callerSignal);
		try {
			const value = await adapter.materializeJsonRoot(payload.value, fieldGuard, operation.controller.signal);
			if (operation.controller.signal.aborted || !isCurrentFutureLazyIdentity(captured)) {
				throw futureLazyAbortError();
			}
			return value;
		} catch (error: unknown) {
			if (operation.controller.signal.aborted || !isCurrentFutureLazyIdentity(captured)) {
				throw futureLazyAbortError();
			}
			if (reportProjectionFailure(captured.sessionHandle, captured.generation, error)) {
				abortFutureLazyIdentity(captured);
			}
			throw error;
		} finally {
			releaseFutureLazyOperation(operation);
		}
	}

	function enqueueFutureProjection(
		identity: SessionRuntimeIdentityDto,
		rawWireBytes: number,
		snapshotWaiter: SnapshotWaiter | null,
		prepare: (signal: AbortSignal) => Promise<() => void>,
	): boolean {
		const isSnapshot = snapshotWaiter !== null;
		const existing = futureProjectionTails.get(identity.sessionHandle);
		if (existing && !identitiesMatch(existing.identity, identity)) {
			discardFutureProjectionTail(identity.sessionHandle, existing);
		}
		let current = futureProjectionTails.get(identity.sessionHandle);
		if (!current) {
			current = {
				identity,
				controller: new AbortController(),
				promise: Promise.resolve(),
				pendingReplayFrames: 0,
				pendingReplayBytes: 0,
				snapshotPending: false,
				snapshotWaiter: null,
			};
			futureProjectionTails.set(identity.sessionHandle, current);
		}
		const replayOverflow =
			!isSnapshot &&
			(current.pendingReplayFrames >= MAX_RESYNC_BUFFERED_FRAMES ||
				current.pendingReplayBytes + rawWireBytes > MAX_RESYNC_BUFFERED_BYTES);
		if ((isSnapshot && current.snapshotPending) || replayOverflow) {
			const failure = new SessionTransportError(
				"payload_too_large",
				"Pending future Session projection exceeded its bounded admission",
			);
			const pendingSnapshotWaiter = current.snapshotWaiter;
			discardFutureProjectionTail(identity.sessionHandle, current);
			if (pendingSnapshotWaiter) {
				failFutureSnapshotProjection(identity, failure, pendingSnapshotWaiter);
			} else reportProjectionFailure(identity.sessionHandle, identity.generation, failure);
			return true;
		}
		if (isSnapshot) {
			current.snapshotPending = true;
			current.snapshotWaiter = snapshotWaiter;
		} else {
			current.pendingReplayFrames += 1;
			current.pendingReplayBytes += rawWireBytes;
		}
		const controller = current.controller;
		const previous = current.promise;
		let promise: Promise<void>;
		promise = previous
			.then(async () => {
				if (controller.signal.aborted || !isCurrentFutureProjectionIdentity(identity)) return;
				const commit = await prepare(controller.signal);
				if (controller.signal.aborted || !isCurrentFutureProjectionIdentity(identity)) return;
				commit();
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted || !isCurrentFutureProjectionIdentity(identity)) return;
				const pendingSnapshotWaiter = current.snapshotWaiter;
				discardFutureProjectionTail(identity.sessionHandle, current);
				if (pendingSnapshotWaiter) {
					const failure = error instanceof Error ? error : new Error(String(error));
					failFutureSnapshotProjection(identity, failure, pendingSnapshotWaiter);
				} else reportProjectionFailure(identity.sessionHandle, identity.generation, error);
			})
			.finally(() => {
				if (futureProjectionTails.get(identity.sessionHandle) !== current) return;
				if (isSnapshot) {
					current.snapshotPending = false;
					current.snapshotWaiter = null;
				} else {
					current.pendingReplayFrames -= 1;
					current.pendingReplayBytes -= rawWireBytes;
				}
				if (current.promise === promise && current.pendingReplayFrames === 0 && !current.snapshotPending) {
					futureProjectionTails.delete(identity.sessionHandle);
				}
			});
		current.promise = promise;
		return true;
	}

	function discardFutureProjectionTail(sessionHandle: string, entry: FutureProjectionTail): void {
		if (futureProjectionTails.get(sessionHandle) === entry) {
			futureProjectionTails.delete(sessionHandle);
		}
		entry.pendingReplayFrames = 0;
		entry.pendingReplayBytes = 0;
		entry.snapshotPending = false;
		entry.snapshotWaiter = null;
		entry.controller.abort();
	}

	function abortFutureProjection(sessionHandle: string): void {
		const entry = futureProjectionTails.get(sessionHandle);
		if (!entry) return;
		discardFutureProjectionTail(sessionHandle, entry);
	}

	function abortAllFutureProjections(): void {
		for (const [sessionHandle, entry] of futureProjectionTails) {
			discardFutureProjectionTail(sessionHandle, entry);
		}
	}

	function handleSessionError(message: Extract<SessionWsServerMessage, { type: "session_error" }>): void {
		const activeExact = activeExactHotRecovery;
		const exactErrorMatches =
			message.operation === "subscribe" &&
			activeExact?.identity.sessionHandle === message.sessionHandle &&
			activeExact.identity.serverEpoch === message.serverEpoch &&
			!activeExact.recoveryStarted;
		if (exactErrorMatches) {
			recordSubscriptionRejection(message.sessionHandle, message.error, message.code, message.retryable);
			settleExactHotRecoveryError(message.sessionHandle);
			frameBus.emit(message.sessionHandle, message, now());
			return;
		}
		const current = store.getState().sessions[message.sessionHandle];
		if (
			!current?.subscribed ||
			(current.runtime !== null && current.runtime.serverEpoch !== message.serverEpoch)
		) {
			return;
		}
		if (message.operation === "history_page") {
			const operation = [...pageHistoryAssemblies.values()].find(
				(candidate) => candidate.identity.sessionHandle === message.sessionHandle,
			);
			const error = new Error(message.code ?? message.error);
			const requiresFreshBaseline =
				operation !== undefined &&
				(message.code === "session_history_snapshot_stale" ||
					message.code === "session_history_changed" ||
					message.code === "session_history_invalid_cursor");
			if (operation) failHistoryPage(operation, error);
			else {
				setChannel(message.sessionHandle, (channel) => ({
					...channel,
					history: { ...channel.history, loading: false, error: message.code ?? message.error },
				}));
			}
			if (requiresFreshBaseline) {
				const currentGeneration = store.getState().sessions[message.sessionHandle]?.generation;
				if (currentGeneration !== null && currentGeneration !== undefined) {
					reportProjectionFailure(message.sessionHandle, currentGeneration, error);
				}
			}
			frameBus.emit(message.sessionHandle, message, now());
			return;
		}
		if (message.operation === "subscribe") {
			recordSubscriptionRejection(message.sessionHandle, message.error, message.code, message.retryable);
			abortFutureProjection(message.sessionHandle);
			abortFutureLazyOperationsForSession(message.sessionHandle);
			rejectFutureHistoryForSession(
				message.sessionHandle,
				new SessionTransportError("session_not_subscribed", message.error),
			);
			subscriptionBaselines.delete(message.sessionHandle);
			baselineRefreshes.delete(message.sessionHandle);
			claimAttempts.delete(message.sessionHandle);
			if (current.resync && current.runtime) {
				failSnapshot(current.runtime, new SessionTransportError("unavailable", message.error));
				frameBus.emit(message.sessionHandle, message, now());
				return;
			}
			connectionObservations.delete(message.sessionHandle);
			rejectPendingForSession(
				message.sessionHandle,
				new SessionTransportError("session_not_subscribed", message.error),
			);
			setChannel(message.sessionHandle, (channel) => ({
				...channel,
				subscribed: false,
				freshLeaseBaseline: null,
				lease: { isController: false },
			}));
			clearProtectedSubscriptionOverage();
			if (current.lease.isController || current.lease.fencingToken) {
				sendWire({ type: "session_release", sessionHandle: message.sessionHandle });
			}
		} else if (message.operation === "claim") {
			claimAttempts.delete(message.sessionHandle);
		}
		frameBus.emit(message.sessionHandle, message, now());
	}

	function handleResponse(message: ResponseMessage): void {
		const id = message.response.id;
		if (!id) return;
		const pending = pendingCommands.get(id);
		if (!pending) return;
		const commandMatches = pending.commandType === message.response.command;
		const originalTargetMatches =
			pending.sessionHandle === message.sessionHandle &&
			pending.generation === message.generation &&
			pending.serverEpoch === message.serverEpoch;
		const transitionTargetMatches =
			isIdentityTransitionCommand(pending.commandType) &&
			message.previousSessionHandle === pending.sessionHandle;
		if (!commandMatches || (!originalTargetMatches && !transitionTargetMatches)) {
			rejectPending(
				id,
				new SessionTransportError(
					"response_mismatch",
					`Response ${id} targeted ${message.sessionHandle}@${String(message.generation)}`,
				),
			);
			return;
		}
		abortFutureHistoryOperation(pending);
		pending.futureHistoryBarrierSeq = undefined;
		pending.response = message;
		resolvePendingResponse(pending);
	}

	function resolvePendingResponse(pending: PendingCommand): void {
		const message = pending.response;
		if (!message || pending.futureHistory) return;
		const channel = store.getState().sessions[message.sessionHandle];
		if (
			!channel?.baselineAuthoritative ||
			channel.generation !== message.generation ||
			channel.runtime?.serverEpoch !== message.serverEpoch ||
			channel.runtime.workspaceId !== pending.workspaceId
		) {
			return;
		}
		if (channel.projectedSeq < message.barrierSeq) return;
		settlePendingResponse(pending, message);
	}

	function settlePendingResponse(pending: PendingCommand, message: ResponseMessage): void {
		pendingCommands.delete(pending.id);
		clearTimeout(pending.timer);
		pending.resolve(message.response);
	}

	function resolvePendingResponsesForSession(sessionHandle: string): void {
		for (const pending of [...pendingCommands.values()]) {
			if (pending.response?.sessionHandle === sessionHandle) resolvePendingResponse(pending);
		}
	}

	function handleRuntimeState(message: Extract<SessionWsServerMessage, { type: "runtime_state" }>): void {
		const sessionHandle = message.runtime.sessionHandle;
		const current = store.getState().sessions[sessionHandle];
		if (!current?.subscribed) return;
		if (
			current.runtime?.serverEpoch === message.runtime.serverEpoch &&
			current.generation !== null &&
			message.runtime.generation < current.generation
		) {
			return;
		}
		const identityChanged = current.runtime !== null && !identitiesMatch(current.runtime, message.runtime);
		if (identityChanged) {
			abortHistoryForSession(sessionHandle);
			abortFutureProjection(sessionHandle);
			abortFutureLazyOperationsForSession(sessionHandle);
			rejectFutureHistoryForSession(
				sessionHandle,
				new SessionTransportError("response_mismatch", "Session generation changed before response"),
			);
			clearSessionResyncData(sessionHandle);
			resyncCoordinator.unsubscribe(sessionHandle);
			acknowledgedExtensionRequests.delete(sessionHandle);
			clearDeliveredNotifyKeys(sessionHandle);
			claimAttempts.delete(sessionHandle);
			baselineRefreshes.delete(sessionHandle);
			subscriptionBaselines.delete(sessionHandle);
			discardRawEvents(sessionHandle, false);
			rejectPendingForSession(
				sessionHandle,
				new SessionTransportError("response_mismatch", "Session generation changed before response"),
			);
		}
		setChannel(sessionHandle, (channel) => ({
			...channel,
			runtime: message.runtime,
			generation: message.runtime.generation,
			baselineAuthoritative: identityChanged ? false : channel.baselineAuthoritative,
			freshLeaseBaseline: identityChanged ? null : channel.freshLeaseBaseline,
			lastSeq: identityChanged ? 0 : channel.lastSeq,
			projectedSeq: identityChanged ? 0 : channel.projectedSeq,
			pendingExtensionRequests: identityChanged ? [] : channel.pendingExtensionRequests,
			resync: identityChanged ? null : channel.resync,
			recovery: identityChanged ? null : channel.recovery,
			history: identityChanged ? emptyHistoryState() : channel.history,
			lease: identityChanged ? { isController: false } : channel.lease,
			rawEvents: identityChanged ? [] : channel.rawEvents,
		}));
		connectionObservations.set(sessionHandle, message.runtime);
		const delivery = frameBus.emit(sessionHandle, message, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(sessionHandle, message.runtime.generation, delivery.errors[0]);
		}
		resolvePendingResponsesForSession(sessionHandle);
	}

	function handleReplayFrame(message: SessionReplayFrameDto): void;
	function handleReplayFrame(message: ProjectedFutureSessionReplayFrame, productMode: "future"): void;
	function handleReplayFrame(
		...input:
			| [message: SessionReplayFrameDto]
			| [message: ProjectedFutureSessionReplayFrame, productMode: "future"]
	): void {
		const frame: BufferedReplayFrame =
			input.length === 1
				? { message: input[0], productMode: "current" }
				: { message: input[0], productMode: "future" };
		const { message } = frame;
		const current = store.getState().sessions[message.sessionHandle];
		const currentRuntime = current?.runtime;
		if (
			!current?.subscribed ||
			current.generation === null ||
			!currentRuntime ||
			!identitiesMatch(currentRuntime, message)
		) {
			return;
		}
		const receivedAt = now();
		const journaledNotify =
			message.type === "extension_ui_request" && message.request.method === "notify" ? message : null;
		if (journaledNotify && hasDeliveredNotify(currentRuntime, journaledNotify)) return;
		if (journaledNotify && message.seq <= current.lastSeq) {
			const delivery = emitReplayFrame(frame, receivedAt);
			if (delivery.errors.length === 0) rememberDeliveredNotify(currentRuntime, journaledNotify);
			return;
		}

		if (current.resync) {
			if (message.seq <= current.resync.barrierSeq) return;
			const result = bufferReplayFrame(frame);
			if (result === "buffered" && message.type === "event") {
				appendRawEvent(message.sessionHandle, message, receivedAt);
			}
			return;
		}
		if (message.seq <= current.lastSeq) return;

		if (message.seq !== current.lastSeq + 1) {
			const runtime = current.runtime;
			if (!runtime) return;
			const synthetic = {
				type: "resync_required",
				serverEpoch: message.serverEpoch,
				sessionHandle: message.sessionHandle,
				runtime,
				reason: "gap",
			} satisfies Extract<SessionWsServerMessage, { type: "resync_required" }>;
			const result = bufferReplayFrame(frame);
			if (result === "overflow") return;
			if (result === "buffered" && message.type === "event") {
				appendRawEvent(message.sessionHandle, message, receivedAt);
			}
			handleResyncRequired(synthetic, false);
			return;
		}

		const delivery = emitReplayFrame(frame, receivedAt);
		if (delivery.errors.length > 0) {
			reportProjectionFailure(message.sessionHandle, message.generation, delivery.errors[0]);
			return;
		}
		const deliveredChannel = store.getState().sessions[message.sessionHandle];
		if (deliveredChannel?.resync?.requiresFreshBaseline) return;
		if (message.type === "event") appendRawEvent(message.sessionHandle, message, receivedAt);
		if (journaledNotify) rememberDeliveredNotify(currentRuntime, journaledNotify);
		applyReplayFrameState(message, !delivery.deferred);
		resolvePendingResponsesForSession(message.sessionHandle);
	}

	function emitReplayFrame(frame: BufferedReplayFrame, receivedAt: number) {
		return frame.productMode === "future"
			? frameBus.emit(frame.message.sessionHandle, frame.message, receivedAt, "future")
			: frameBus.emit(frame.message.sessionHandle, frame.message, receivedAt);
	}

	function appendRawEvent(
		sessionHandle: string,
		message: Extract<TransportReplayFrame, { type: "event" }>,
		receivedAt: number,
	): void {
		const record = {
			receivedAt,
			serverEpoch: message.serverEpoch,
			workspaceId: message.workspaceId,
			generation: message.generation,
			seq: message.seq,
			eventType: message.event.type,
			payload: message.event,
		} satisfies SessionChannelState["rawEvents"][number];
		const bytes = serializedBytes(record);
		if (
			bytes > rawEventMaxBytes ||
			bytes > rawEventGlobalMaxBytes ||
			rawEventLimit === 0 ||
			rawEventGlobalLimit === 0
		) {
			return;
		}

		const retained = {
			identityKey: identityKey(message),
			sessionHandle,
			record,
			bytes,
		} satisfies RetainedRawEvent;
		retainedRawEvents.push(retained);
		retainedRawEventBytes += bytes;
		const evicted = new Set<RetainedRawEvent>();
		const sessionEntries = retainedRawEvents.filter((entry) => entry.sessionHandle === sessionHandle);
		let sessionBytes = sessionEntries.reduce((total, entry) => total + entry.bytes, 0);
		while (sessionEntries.length > rawEventLimit || sessionBytes > rawEventMaxBytes) {
			const oldest = sessionEntries.shift();
			if (!oldest) break;
			evicted.add(oldest);
			sessionBytes -= oldest.bytes;
		}
		let nextGlobalCount = retainedRawEvents.length - evicted.size;
		let nextGlobalBytes =
			retainedRawEventBytes - [...evicted].reduce((total, entry) => total + entry.bytes, 0);
		for (const entry of retainedRawEvents) {
			if (nextGlobalCount <= rawEventGlobalLimit && nextGlobalBytes <= rawEventGlobalMaxBytes) {
				break;
			}
			if (evicted.has(entry)) continue;
			evicted.add(entry);
			nextGlobalCount -= 1;
			nextGlobalBytes -= entry.bytes;
		}
		retainedRawEvents = retainedRawEvents.filter((entry) => !evicted.has(entry));
		retainedRawEventBytes = nextGlobalBytes;
		const evictedRecords = new Map<string, Set<SessionChannelState["rawEvents"][number]>>();
		for (const entry of evicted) {
			const records = evictedRecords.get(entry.sessionHandle) ?? new Set();
			records.add(entry.record);
			evictedRecords.set(entry.sessionHandle, records);
		}
		store.setState((state) => {
			const sessions = { ...state.sessions };
			const affected = new Set([...evictedRecords.keys(), sessionHandle]);
			for (const handle of affected) {
				const channel = sessions[handle];
				if (!channel) continue;
				const records = handle === sessionHandle ? [...channel.rawEvents, record] : channel.rawEvents;
				const removed = evictedRecords.get(handle);
				sessions[handle] = {
					...channel,
					rawEvents: removed ? records.filter((candidate) => !removed.has(candidate)) : records,
				};
			}
			return { sessions };
		});
	}

	function discardRawEvents(sessionHandle: string, updateChannel = true): void {
		let discardedBytes = 0;
		retainedRawEvents = retainedRawEvents.filter((entry) => {
			if (entry.sessionHandle !== sessionHandle) return true;
			discardedBytes += entry.bytes;
			return false;
		});
		retainedRawEventBytes = Math.max(0, retainedRawEventBytes - discardedBytes);
		if (updateChannel) {
			setChannel(sessionHandle, (channel) =>
				channel.rawEvents.length === 0 ? channel : { ...channel, rawEvents: [] },
			);
		}
	}

	function applyReplayFrameState(
		message: TransportReplayFrame,
		projected: boolean,
		ignoredExtensionRequestIds?: ReadonlySet<string>,
	): void {
		setChannel(message.sessionHandle, (channel) => ({
			...channel,
			lastSeq: message.seq,
			projectedSeq:
				projected && channel.projectedSeq + 1 === message.seq ? message.seq : channel.projectedSeq,
			pendingExtensionRequests:
				message.type === "extension_ui_request" && ignoredExtensionRequestIds?.has(message.request.id)
					? channel.pendingExtensionRequests
					: applyReplayExtensionState(channel.pendingExtensionRequests, message),
		}));
	}

	function bufferReplayFrame(frame: BufferedReplayFrame): "buffered" | "duplicate" | "overflow" {
		const { message } = frame;
		const key = identityKey(message);
		const buffer = resyncBuffers.get(key) ?? [];
		if (
			buffer.some(
				(candidate) =>
					candidate.message.generation === message.generation && candidate.message.seq === message.seq,
			)
		) {
			return "duplicate";
		}
		const bytes = replayFrameBytes(message);
		const nextBytes = (resyncBufferBytes.get(key) ?? 0) + bytes;
		if (buffer.length >= MAX_RESYNC_BUFFERED_FRAMES || nextBytes > MAX_RESYNC_BUFFERED_BYTES) {
			forceReplayResync(message);
			return "overflow";
		}
		buffer.push(frame);
		buffer.sort((left, right) => left.message.seq - right.message.seq);
		resyncBuffers.set(key, buffer);
		resyncBufferBytes.set(key, nextBytes);
		setChannel(message.sessionHandle, (channel) => ({
			...channel,
			lastSeq: Math.max(channel.lastSeq, message.seq),
			pendingExtensionRequests: applyReplayExtensionState(channel.pendingExtensionRequests, message),
			resync: channel.resync ? { ...channel.resync, bufferedFrameCount: buffer.length } : channel.resync,
		}));
		return "buffered";
	}

	function forceReplayResync(message: TransportReplayFrame): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (!current?.subscribed || !current.runtime) return;
		const barrierSeq = current.resync?.barrierSeq ?? current.runtime.lastSeq;
		const runtime = {
			...current.runtime,
			generation: message.generation,
			lastSeq: barrierSeq,
		};
		clearIdentityBuffers(message);
		acknowledgedExtensionRequests.delete(message.sessionHandle);
		const required = {
			type: "resync_required",
			serverEpoch: message.serverEpoch,
			sessionHandle: message.sessionHandle,
			runtime,
			reason: "gap",
		} satisfies Extract<SessionWsServerMessage, { type: "resync_required" }>;
		handleResyncRequired(required, false);
	}

	function confirmProjectionDelivery(sessionHandle: string, generation: number): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (channel?.subscribed && channel.generation === generation && channel.resync && channel.runtime) {
			const key = identityKey(channel.runtime);
			const waiter = snapshotWaiters.get(key);
			const pendingCompletion = waiter?.pendingCompletion;
			if (!waiter || !pendingCompletion) return false;
			if (channel.lastSeq > pendingCompletion.endpointSeq) {
				failSnapshot(
					channel.runtime,
					new SessionTransportError(
						"stale_resync",
						"Deferred snapshot endpoint changed before projection confirmation",
					),
					waiter,
				);
				reportProjectionFailure(sessionHandle, generation);
				return false;
			}
			if (channel.projectedSeq < channel.lastSeq) {
				setChannel(sessionHandle, (current) => ({ ...current, projectedSeq: current.lastSeq }));
			}
			if (channel.lastSeq < pendingCompletion.endpointSeq) return true;
			return finishSnapshot(
				channel.runtime,
				waiter,
				pendingCompletion.snapshotId,
				pendingCompletion.endpointSeq,
			);
		}
		if (
			!channel?.subscribed ||
			channel.generation !== generation ||
			channel.resync ||
			channel.projectedSeq > channel.lastSeq
		) {
			return false;
		}
		if (channel.projectedSeq < channel.lastSeq) {
			setChannel(sessionHandle, (current) => ({ ...current, projectedSeq: current.lastSeq }));
		}
		resolvePendingResponsesForSession(sessionHandle);
		return true;
	}

	function isSnapshotSuffixProjectionPending(sessionHandle: string, generation: number): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.subscribed || channel.generation !== generation || !channel.resync || !channel.runtime) {
			return false;
		}
		const waiter = snapshotWaiters.get(identityKey(channel.runtime));
		return Boolean(waiter?.pendingCompletion);
	}

	function reportProjectionFailure(sessionHandle: string, generation: number, error?: unknown): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.subscribed || channel.generation !== generation) return false;
		if (!channel.runtime) return false;
		if (channel.resync?.requiresFreshBaseline) return false;
		abortFutureLazyOperationsForSession(sessionHandle);
		const failure = error instanceof Error ? error : new Error(String(error ?? "Future projection failed"));
		rejectFutureHistoryForSession(sessionHandle, failure);
		clearIdentityBuffers(channel.runtime);
		acknowledgedExtensionRequests.delete(sessionHandle);
		baselineRefreshes.delete(sessionHandle);
		subscriptionBaselines.delete(sessionHandle);
		discardRawEvents(sessionHandle);
		setChannel(sessionHandle, (current) => ({
			...current,
			baselineAuthoritative: false,
			freshLeaseBaseline: null,
			lastSeq: current.projectedSeq,
			pendingExtensionRequests: [],
			resync: {
				reason: "gap",
				generation,
				barrierSeq: current.projectedSeq,
				bufferedFrameCount: 0,
				requiresFreshBaseline: true,
			},
		}));
		const runtime = { ...channel.runtime, lastSeq: channel.projectedSeq };
		handleResyncRequired(
			{
				type: "resync_required",
				serverEpoch: runtime.serverEpoch,
				sessionHandle,
				runtime,
				reason: "gap",
			},
			false,
		);
		return true;
	}

	function handleLease(message: Extract<SessionWsServerMessage, { type: "lease_status" }>): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (
			!current?.subscribed ||
			current.runtime?.serverEpoch !== message.serverEpoch ||
			current.generation !== message.generation
		) {
			return;
		}
		if (subscriptionBaselines.get(message.sessionHandle) === identityKey(current.runtime)) {
			subscriptionBaselines.delete(message.sessionHandle);
		}
		setChannel(message.sessionHandle, (channel) => ({
			...channel,
			freshLeaseBaseline: channel.runtime,
			subscriptionAdmission:
				channel.subscriptionAdmission?.kind === "rejected" ? null : channel.subscriptionAdmission,
			lease: message.isController
				? {
						isController: true,
						...(message.fencingToken ? { fencingToken: message.fencingToken } : {}),
					}
				: { isController: false },
		}));
		frameBus.emit(message.sessionHandle, message, now());
		if (current.runtime) advanceExactHotRecovery(current.runtime, "lease");
		if (!message.isController) claimSessionIfReady(message.sessionHandle);
	}

	function handleResyncRequired(
		message: Extract<SessionWsServerMessage, { type: "resync_required" }>,
		serverInitiated = true,
	): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (!current?.subscribed) return;
		if (
			message.serverEpoch !== message.runtime.serverEpoch ||
			message.sessionHandle !== message.runtime.sessionHandle
		) {
			return;
		}
		if (
			current.runtime?.serverEpoch === message.runtime.serverEpoch &&
			current.generation !== null &&
			message.runtime.generation < current.generation
		) {
			return;
		}
		abortHistoryForSession(message.sessionHandle);
		abortFutureLazyOperationsForSession(message.sessionHandle);
		connectionObservations.set(message.sessionHandle, message.runtime);
		if (activeExactHotRecovery && identitiesMatch(activeExactHotRecovery.identity, message.runtime)) {
			activeExactHotRecovery.recoveryStarted = true;
		}
		const sameIdentity = identitiesMatch(current.runtime, message.runtime);
		if (!sameIdentity && current.runtime) {
			abortFutureProjection(message.sessionHandle);
			rejectFutureHistoryForSession(
				message.sessionHandle,
				new SessionTransportError("response_mismatch", "Session generation changed during resync"),
			);
			clearIdentityBuffers(current.runtime);
			resyncCoordinator.unsubscribe(message.sessionHandle);
			claimAttempts.delete(message.sessionHandle);
			baselineRefreshes.delete(message.sessionHandle);
			subscriptionBaselines.delete(message.sessionHandle);
			discardRawEvents(message.sessionHandle, false);
		}
		const key = identityKey(message.runtime);
		const retained = (resyncBuffers.get(key) ?? []).filter(
			(frame) =>
				identitiesMatch(frame.message, message.runtime) && frame.message.seq > message.runtime.lastSeq,
		);
		retained.sort((left, right) => left.message.seq - right.message.seq);
		if (retained.length > 0) {
			resyncBuffers.set(key, retained);
			resyncBufferBytes.set(
				key,
				retained.reduce((total, frame) => total + replayFrameBytes(frame.message), 0),
			);
		} else {
			resyncBuffers.delete(key);
			resyncBufferBytes.delete(key);
		}
		if (!sameIdentity) {
			acknowledgedExtensionRequests.delete(message.sessionHandle);
			clearDeliveredNotifyKeys(message.sessionHandle);
			rejectPendingForSession(
				message.sessionHandle,
				new SessionTransportError("response_mismatch", "Session generation changed during resync"),
			);
		}
		const retainedLastSeq = retained.at(-1)?.message.seq ?? message.runtime.lastSeq;
		const requiresFreshBaseline = current.resync?.requiresFreshBaseline === true || message.reason !== "gap";
		setChannel(message.sessionHandle, (channel) => ({
			...channel,
			runtime: message.runtime,
			generation: message.runtime.generation,
			baselineAuthoritative: false,
			freshLeaseBaseline: null,
			lastSeq: Math.max(message.runtime.lastSeq, retainedLastSeq),
			projectedSeq: sameIdentity ? channel.projectedSeq : 0,
			pendingExtensionRequests: [],
			history: emptyHistoryState(),
			lease: sameIdentity ? channel.lease : { isController: false },
			rawEvents: sameIdentity ? channel.rawEvents : [],
			resync: {
				reason: message.reason,
				generation: message.runtime.generation,
				barrierSeq: message.runtime.lastSeq,
				bufferedFrameCount: retained.length,
				requiresFreshBaseline,
			},
		}));
		const delivery = frameBus.emit(message.sessionHandle, message, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(message.sessionHandle, message.runtime.generation, delivery.errors[0]);
		}
		options.onResyncRequired?.(message);
		const activeRecovery = resyncCoordinator.getState(message.sessionHandle);
		const activeIdentityMatches = identitiesMatch(activeRecovery?.identity, message.runtime);
		if (
			!activeRecovery ||
			!activeIdentityMatches ||
			(!snapshotWaiters.has(key) && activeRecovery.phase !== "degraded")
		) {
			if (activeRecovery) resyncCoordinator.unsubscribe(message.sessionHandle);
			if (serverInitiated) skipNextResubscribe.add(key);
			resyncCoordinator.start(message.runtime, { reason: message.reason });
		}
	}

	function failSnapshot(
		identity: SessionRuntimeIdentityDto,
		error: Error,
		expectedWaiter?: SnapshotWaiter,
	): void {
		const key = identityKey(identity);
		const waiter = snapshotWaiters.get(key);
		if (!waiter || (expectedWaiter && waiter.token !== expectedWaiter.token)) return;
		snapshotWaiters.delete(key);
		waiter.reject(error);
	}

	function failFutureSnapshotProjection(
		identity: SessionRuntimeIdentityDto,
		error: Error,
		waiter: SnapshotWaiter,
	): void {
		const key = identityKey(identity);
		const channel = store.getState().sessions[identity.sessionHandle];
		if (
			snapshotWaiters.get(key)?.token !== waiter.token ||
			!channel?.subscribed ||
			!channel.resync ||
			!identitiesMatch(channel.runtime, identity)
		) {
			return;
		}
		resyncBuffers.delete(key);
		resyncBufferBytes.delete(key);
		acknowledgedExtensionRequests.delete(identity.sessionHandle);
		baselineRefreshes.delete(identity.sessionHandle);
		subscriptionBaselines.delete(identity.sessionHandle);
		discardRawEvents(identity.sessionHandle);
		setChannel(identity.sessionHandle, (current) => ({
			...current,
			baselineAuthoritative: false,
			freshLeaseBaseline: null,
			lastSeq: current.projectedSeq,
			pendingExtensionRequests: [],
			resync: {
				reason: "gap",
				generation: identity.generation,
				barrierSeq: current.projectedSeq,
				bufferedFrameCount: 0,
				requiresFreshBaseline: true,
			},
		}));
		failSnapshot(identity, error, waiter);
	}

	function finishSnapshot(
		identity: SessionRuntimeIdentityDto,
		waiter: SnapshotWaiter,
		snapshotId: string,
		endpointSeq: number,
	): boolean {
		const key = identityKey(identity);
		if (snapshotWaiters.get(key)?.token !== waiter.token) return false;
		const channel = store.getState().sessions[identity.sessionHandle];
		if (
			!channel?.subscribed ||
			!channel.resync ||
			!identitiesMatch(channel.runtime, identity) ||
			channel.lastSeq !== endpointSeq
		) {
			return false;
		}
		const requiredBarrier = requiredProjectionBarrier(identity, channel.resync.barrierSeq);
		if (endpointSeq < requiredBarrier) {
			failSnapshot(
				identity,
				new SessionTransportError(
					"stale_resync",
					"Snapshot suffix did not reach the current response barrier",
				),
				waiter,
			);
			return false;
		}
		setChannel(identity.sessionHandle, (current) => ({
			...current,
			baselineAuthoritative: true,
			lastSeq: endpointSeq,
			projectedSeq: endpointSeq,
			resync: null,
			history:
				current.history.snapshotId === snapshotId
					? { ...current.history, loading: false, error: null }
					: emptyHistoryState(),
			subscriptionAdmission:
				current.subscriptionAdmission?.kind === "rejected" ? null : current.subscriptionAdmission,
		}));
		subscriptionBaselines.delete(identity.sessionHandle);
		baselineRefreshes.delete(identity.sessionHandle);
		resyncBuffers.delete(key);
		resyncBufferBytes.delete(key);
		clearAcknowledgedExtensionRequests(identity);
		snapshotWaiters.delete(key);
		waiter.resolve({ identity, snapshotId, asOfSeq: endpointSeq });
		advanceExactHotRecovery(identity, "baseline");
		resolvePendingResponsesForSession(identity.sessionHandle);
		claimSessionIfReady(identity.sessionHandle);
		return true;
	}

	function handleSessionSnapshot(message: SessionSnapshotDto): void {
		const guardContext = attachmentGuardContext;
		if (guardContext === null || !isSessionSnapshotDto(message, guardContext)) return;
		commitSessionSnapshot(message);
	}

	function commitSessionSnapshot(message: SessionSnapshotDto): void;
	function commitSessionSnapshot(message: ProjectedFutureSessionSnapshot, productMode: "future"): void;
	function commitSessionSnapshot(
		...input: [message: SessionSnapshotDto] | [message: ProjectedFutureSessionSnapshot, productMode: "future"]
	): void {
		const snapshotFrame: TransportSessionSnapshotFrame =
			input.length === 1
				? { message: input[0], productMode: "current" }
				: { message: input[0], productMode: "future" };
		const { message } = snapshotFrame;
		const channel = store.getState().sessions[message.sessionHandle];
		if (!channel?.subscribed || !channel.resync || !identitiesMatch(channel.runtime, message)) return;
		const key = identityKey(message);
		const waiter = snapshotWaiters.get(key);
		if (!waiter) return;
		const buffered = (resyncBuffers.get(key) ?? [])
			.filter((frame) => identitiesMatch(frame.message, message) && frame.message.seq > message.asOfSeq)
			.sort((left, right) => left.message.seq - right.message.seq);
		let contiguousSeq = message.asOfSeq;
		for (const { message: frame } of buffered) {
			if (frame.seq !== contiguousSeq + 1) {
				failSnapshot(message, new SessionTransportError("stale_resync", "Snapshot suffix has a gap"), waiter);
				return;
			}
			contiguousSeq = frame.seq;
		}
		const requiredBarrier = requiredProjectionBarrier(message, channel.resync.barrierSeq);
		if (contiguousSeq < requiredBarrier) {
			failSnapshot(
				message,
				new SessionTransportError(
					"stale_resync",
					"Snapshot suffix did not reach the current response barrier",
				),
				waiter,
			);
			return;
		}
		waiter.pendingCompletion = { snapshotId: message.snapshotId, endpointSeq: contiguousSeq };

		const acknowledged = acknowledgedExtensionRequestIds(message);
		const snapshotForProjection: TransportSessionSnapshotFrame =
			acknowledged.size === 0
				? snapshotFrame
				: snapshotFrame.productMode === "future"
					? {
							productMode: "future",
							message: {
								...snapshotFrame.message,
								pendingExtensionRequests: snapshotFrame.message.pendingExtensionRequests.filter(
									(request) => !acknowledged.has(request.id),
								),
								stickyExtensionState: snapshotFrame.message.stickyExtensionState.filter(
									(request) => !acknowledged.has(request.id),
								),
							},
						}
					: {
							productMode: "current",
							message: {
								...snapshotFrame.message,
								pendingExtensionRequests: snapshotFrame.message.pendingExtensionRequests.filter(
									(request) => !acknowledged.has(request.id),
								),
								stickyExtensionState: snapshotFrame.message.stickyExtensionState.filter(
									(request) => !acknowledged.has(request.id),
								),
							},
						};
		const snapshotDelivery = emitSessionSnapshot(snapshotForProjection);
		if (snapshotDelivery.errors.length > 0 || snapshotDelivery.deferred) {
			failSnapshot(
				message,
				new SessionTransportError("stale_resync", "Session snapshot projection did not commit atomically"),
				waiter,
			);
			return;
		}
		if (snapshotWaiters.get(key)?.token !== waiter.token) return;
		setChannel(message.sessionHandle, (current) => ({
			...current,
			runtime: message.runtime,
			generation: message.generation,
			baselineAuthoritative: false,
			lastSeq: message.asOfSeq,
			projectedSeq: message.asOfSeq,
			pendingExtensionRequests: normalizeExtensionRequests([
				...snapshotForProjection.message.pendingExtensionRequests,
				...snapshotForProjection.message.stickyExtensionState,
			]),
		}));

		let suffixDeferred = false;
		for (const bufferedFrame of buffered) {
			const { message: frame } = bufferedFrame;
			const skipAcknowledgedRequest =
				frame.type === "extension_ui_request" && acknowledged.has(frame.request.id);
			if (skipAcknowledgedRequest) {
				applyReplayFrameState(frame, !suffixDeferred, acknowledged);
				continue;
			}
			const delivery = emitReplayFrame(bufferedFrame, now());
			if (delivery.errors.length > 0) {
				failSnapshot(message, new SessionTransportError("stale_resync", "Snapshot suffix failed"), waiter);
				reportProjectionFailure(message.sessionHandle, message.generation, delivery.errors[0]);
				return;
			}
			if (snapshotWaiters.get(key)?.token !== waiter.token) return;
			suffixDeferred ||= delivery.deferred;
			if (frame.type === "extension_ui_request" && frame.request.method === "notify") {
				rememberDeliveredNotify(message, frame);
			}
			applyReplayFrameState(frame, !delivery.deferred, acknowledged);
		}
		resyncBuffers.delete(key);
		resyncBufferBytes.delete(key);
		const projectedSeq = store.getState().sessions[message.sessionHandle]?.projectedSeq;
		if (suffixDeferred && (projectedSeq === undefined || projectedSeq < contiguousSeq)) return;
		finishSnapshot(message, waiter, message.snapshotId, contiguousSeq);
	}

	function emitSessionSnapshot(frame: TransportSessionSnapshotFrame) {
		return frame.productMode === "future"
			? frameBus.emit(frame.message.sessionHandle, frame.message, now(), "future")
			: frameBus.emit(frame.message.sessionHandle, frame.message, now());
	}

	function handleExtensionSnapshot(
		message: Extract<SessionWsServerMessage, { type: "extension_ui_snapshot" }>,
	): void;
	function handleExtensionSnapshot(message: ProjectedFutureExtensionUiSnapshot, productMode: "future"): void;
	function handleExtensionSnapshot(
		...input:
			| [message: Extract<SessionWsServerMessage, { type: "extension_ui_snapshot" }>]
			| [message: ProjectedFutureExtensionUiSnapshot, productMode: "future"]
	): void {
		const frame: TransportExtensionSnapshotFrame =
			input.length === 1
				? { message: input[0], productMode: "current" }
				: { message: input[0], productMode: "future" };
		const { message } = frame;
		const current = store.getState().sessions[message.sessionHandle];
		if (
			!current?.subscribed ||
			!current.baselineAuthoritative ||
			current.runtime?.serverEpoch !== message.serverEpoch ||
			current.generation !== message.generation
		) {
			return;
		}
		setChannel(message.sessionHandle, (channel) => ({
			...channel,
			pendingExtensionRequests: normalizeExtensionRequests(message.requests),
		}));
		const delivery =
			frame.productMode === "future"
				? frameBus.emit(message.sessionHandle, frame.message, now(), "future")
				: frameBus.emit(message.sessionHandle, frame.message, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(message.sessionHandle, message.generation, delivery.errors[0]);
			return;
		}
	}

	function handleExtensionResult(
		message: Extract<SessionWsServerMessage, { type: "extension_ui_result" }>,
	): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (
			!current?.subscribed ||
			current.runtime?.serverEpoch !== message.serverEpoch ||
			current.generation !== message.generation
		) {
			return;
		}
		if (current.resync && current.runtime) {
			const existing = acknowledgedExtensionRequests.get(message.sessionHandle);
			const acknowledged =
				existing && identitiesMatch(existing.identity, current.runtime)
					? existing
					: { identity: current.runtime, requestIds: new Set<string>() };
			acknowledged.requestIds.add(message.requestId);
			acknowledgedExtensionRequests.set(message.sessionHandle, acknowledged);
		}
		setChannel(message.sessionHandle, (channel) => ({
			...channel,
			pendingExtensionRequests: channel.pendingExtensionRequests.filter(
				(request) => request.id !== message.requestId,
			),
		}));
		const delivery = frameBus.emit(message.sessionHandle, message, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(message.sessionHandle, message.generation, delivery.errors[0]);
		}
	}

	function handleRekey(message: Extract<SessionWsServerMessage, { type: "session_rekeyed" }>): void {
		if (message.serverEpoch !== message.runtime.serverEpoch) return;
		const previousSessionHandle = message.previousSessionHandle;
		const sessionHandle = message.runtime.sessionHandle;
		const state = store.getState();
		const previous = state.sessions[previousSessionHandle];
		if (!previous?.subscribed) return;
		abortFutureProjection(previousSessionHandle);
		abortHistoryForSession(previousSessionHandle);
		abortFutureLazyOperationsForSession(previousSessionHandle);
		rejectFutureHistoryForSession(
			previousSessionHandle,
			new SessionTransportError("response_mismatch", "Session rekeyed before future history completed"),
		);
		abortFutureProjection(sessionHandle);
		abortHistoryForSession(sessionHandle);
		abortFutureLazyOperationsForSession(sessionHandle);
		if (sessionHandle !== previousSessionHandle) {
			rejectFutureHistoryForSession(
				sessionHandle,
				new SessionTransportError("response_mismatch", "Session rekeyed before future history completed"),
			);
		}
		const exactRekeyInFlight = activeExactHotRecovery?.identity.sessionHandle === previousSessionHandle;
		if (!exactRekeyInFlight) {
			const previousObservation = connectionObservations.get(previousSessionHandle);
			connectionObservations.delete(previousSessionHandle);
			if (previousObservation) connectionObservations.set(sessionHandle, message.runtime);
		}
		if (queuedExactHotRecoveries.delete(previousSessionHandle)) {
			const queuedIndex = exactHotRecoveryQueue.indexOf(previousSessionHandle);
			if (queuedIndex !== -1) exactHotRecoveryQueue.splice(queuedIndex, 1);
		}
		const dormantLastSeq = previous.resync?.barrierSeq ?? previous.projectedSeq;
		const dormantRuntime = previous.runtime
			? { ...previous.runtime, lastSeq: dormantLastSeq, state: "dormant" as const }
			: null;
		const dormant: SessionChannelState = {
			...previous,
			subscribed: false,
			controllerIntent: false,
			runtime: dormantRuntime,
			lastSeq: dormantLastSeq,
			lease: { isController: false },
			freshLeaseBaseline: null,
			pendingExtensionRequests: [],
			resync: previous.resync ? { ...previous.resync, bufferedFrameCount: 0 } : null,
			recovery: null,
			history: emptyHistoryState(),
			subscriptionAdmission: null,
		};
		const migrated: SessionChannelState = {
			...previous,
			sessionHandle,
			subscribed: true,
			runtime: message.runtime,
			generation: message.runtime.generation,
			baselineAuthoritative: false,
			freshLeaseBaseline: null,
			lastSeq: message.runtime.lastSeq,
			projectedSeq: 0,
			lease: { isController: false },
			pendingExtensionRequests: [],
			resync: null,
			recovery: null,
			history: emptyHistoryState(),
			subscriptionAdmission: null,
			rawEvents: [],
		};
		const sessions = {
			...state.sessions,
			[previousSessionHandle]: dormant,
			[sessionHandle]: migrated,
		};
		resyncCoordinator.unsubscribe(previousSessionHandle);
		if (sessionHandle !== previousSessionHandle) resyncCoordinator.unsubscribe(sessionHandle);
		clearSessionResyncData(previousSessionHandle);
		clearSessionResyncData(sessionHandle);
		acknowledgedExtensionRequests.delete(previousSessionHandle);
		acknowledgedExtensionRequests.delete(sessionHandle);
		clearDeliveredNotifyKeys(previousSessionHandle);
		clearDeliveredNotifyKeys(sessionHandle);
		baselineRefreshes.delete(previousSessionHandle);
		baselineRefreshes.delete(sessionHandle);
		const previousBaseline = subscriptionBaselines.get(previousSessionHandle);
		const baselineInFlight =
			subscriptionBaselines.delete(previousSessionHandle) &&
			(previousBaseline === null ||
				(previous.runtime !== null && previousBaseline === identityKey(previous.runtime)));
		subscriptionBaselines.delete(sessionHandle);
		if (baselineInFlight) subscriptionBaselines.set(sessionHandle, identityKey(message.runtime));
		discardRawEvents(sessionHandle, false);
		claimAttempts.delete(previousSessionHandle);
		claimAttempts.delete(sessionHandle);
		const prevIdx = subscribedLruOrder.indexOf(previousSessionHandle);
		if (prevIdx !== -1) subscribedLruOrder.splice(prevIdx, 1);
		touchSubscriptionLru(sessionHandle);
		frameBus.rekey(previousSessionHandle, sessionHandle);
		store.setState({ sessions });
		const delivery = frameBus.emit(sessionHandle, message, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(sessionHandle, message.runtime.generation, delivery.errors[0]);
			return;
		}
		if (!baselineInFlight && store.getState().connectionState === "online") {
			sendSubscription(sessionHandle);
		}
		resolvePendingResponsesForSession(previousSessionHandle);
		resolvePendingResponsesForSession(sessionHandle);
	}

	function rejectPending(id: string, error: Error): void {
		const pending = pendingCommands.get(id);
		if (!pending) return;
		abortFutureHistoryOperation(pending);
		pendingCommands.delete(id);
		clearTimeout(pending.timer);
		pending.reject(error);
	}

	function rejectPendingForSession(sessionHandle: string, error: Error): void {
		for (const pending of [...pendingCommands.values()]) {
			if (pending.sessionHandle === sessionHandle || pending.response?.sessionHandle === sessionHandle) {
				rejectPending(pending.id, error);
			}
		}
	}

	function rejectAllPending(error: Error): void {
		for (const pending of [...pendingCommands.values()]) rejectPending(pending.id, error);
	}

	function dispose(): void {
		if (disposed) return;
		abortAllFutureProjections();
		abortAllFutureLazyOperations();
		disconnect();
		disposed = true;
		rejectInitialInventoryWaiters(new SessionTransportError("unavailable", "Session transport disposed"));
		resyncBuffers.clear();
		resyncBufferBytes.clear();
		snapshotWaiters.clear();
		snapshotHistoryAssemblies.clear();
		pageHistoryAssemblies.clear();
		skipNextResubscribe.clear();
		resyncCoordinator.dispose();
		acknowledgedExtensionRequests.clear();
		deliveredNotifyKeys.clear();
		deliveredNotifyIdentityOrder = [];
		claimAttempts.clear();
		baselineRefreshes.clear();
		subscriptionBaselines.clear();
		subscribedLruOrder = [];
		retainedRawEvents = [];
		retainedRawEventBytes = 0;
		frameBus.clear();
		globalBus.clear();
	}

	return {
		store,
		frameBus,
		globalBus,
		resolveFutureText,
		resolveFutureJson,
		ingestServerMessage,
		ingestFutureFrameMessage,
		confirmProjectionDelivery,
		isSnapshotSuffixProjectionPending,
		reportProjectionFailure,
		loadOlderSessionHistory,
		cancelSessionHistory,
		waitForInitialHotInventory,
		dispose,
	};
}

/** Default store/controller. Importing this module never opens a socket. */
export const sessionTransport = createSessionTransport();
export const sessionTransportStore = sessionTransport.store;

export function useSessionTransportStore<T>(selector: (state: SessionTransportState) => T): T {
	return useStore(sessionTransportStore, selector);
}
