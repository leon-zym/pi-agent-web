import {
	commandTimeoutMs,
	type ExtensionUiResponseDto,
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	GATEWAY_SESSION_HISTORY_CAPABILITY,
	type GatewayClientHelloDto,
	type GatewayServerHelloDto,
	type HotRuntimeInventoryDto,
	type HotRuntimeInventoryEntryDto,
	type InlineSessionHistoryPageChunkDto,
	type InlineSessionReplayFrameDto,
	type InlineSessionSnapshotBeginDto,
	type InlineSessionSnapshotChunkDto,
	type InlineSessionSnapshotDto,
	type InlineSessionWsServerMessage,
	isBoundedJsonValue,
	isGatewayProtocolError,
	isGatewayServerHello,
	isInlineSessionSnapshotDto,
	isPiSessionCommandResponseDto,
	isPiSessionEntryDto,
	isPiSessionMessageDto,
	isPiSessionTreeDto,
	isReadOnlyRpcCommand,
	isSessionCommandResponseDto,
	isSessionWsServerMessage,
	negotiateGatewayHello,
	type PiExtensionUiRequestDto,
	type PiSessionCommandResponseDto,
	type PiSessionEntryDto,
	type PiSessionMessageDto,
	type PiSessionTreeNodeDto,
	SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES,
	SESSION_WS_CLIENT_MAX_BYTES,
	SESSION_WS_SERVER_MAX_BYTES,
	type SessionAttachmentGuardContext,
	type SessionCommandDto,
	type SessionCommandResponseDto,
	type SessionContentRefGuardContext,
	type SessionEntryDto,
	type SessionHistoryPageBeginDto,
	type SessionHistoryPageChunkDto,
	type SessionHistoryPageEndDto,
	type SessionMessageDto,
	type SessionReplayCursorDto,
	type SessionResponseFrameDto,
	type SessionRuntimeDto,
	type SessionRuntimeIdentityDto,
	type SessionSnapshotBeginDto,
	type SessionSnapshotChunkDto,
	type SessionSnapshotDto,
	type SessionSnapshotEndDto,
	type SessionTreeNodeDto,
	type SessionWsClientMessage,
	sessionWsClientMessageBytes,
} from "@pi-agent-web/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { runtimeIsReady, runtimePhase } from "../lib/runtime-state";
import {
	createSessionContentAdapter,
	type ProjectedExtensionUiSnapshot,
	type ProjectedSessionReplayFrame,
	type ProjectedSessionSnapshot,
	type SessionContentAdapter,
	type SessionJsonFieldGuard,
	type SessionJsonRootProjection,
	type SessionTextPayloadProjection,
} from "../lib/session-content-adapter";
import { createSessionContentResolver } from "../lib/session-content-resolver";
import { SessionHistoryStreamAssembler } from "../lib/session-history-stream";
import {
	createSessionResyncCoordinator,
	type SessionResyncAttemptContext,
	type SessionResyncCompletion,
} from "../lib/session-resync";
import {
	createSessionConnectionMachine,
	type SessionConnectionMachineEvent,
	type SessionConnectionMachineIntent,
} from "./connection-machine";
import {
	OrderedSessionFrameBus,
	type SessionHistoryPageLoadedFrame,
	SessionTransportGlobalBus,
} from "./session-frame-bus";
import {
	emptySessionHistoryState,
	type HotRuntimeInventoryToken,
	hasFreshLeaseBaseline,
	type SessionChannelState,
	type SessionContentAdapterFactory,
	type SessionContentAdapterInstallation,
	type SessionHistoryState,
	type SessionLazyIdentity,
	type SessionLeaseState,
	type SessionSubscriptionAdmission,
	type SessionTransportController,
	SessionTransportError,
	type SessionTransportFrameMessage,
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
	type HotRuntimeInventoryToken,
	hasFreshLeaseBaseline,
	type SessionChannelState,
	type SessionContentAdapterFactory,
	type SessionContentAdapterInstallation,
	type SessionHistoryState,
	type SessionLazyIdentity,
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
const MAX_PENDING_EXTENSION_REQUESTS = 256;
const MAX_DELIVERED_NOTIFY_KEYS = 256;
const MAX_DELIVERED_NOTIFY_IDENTITIES = 64;
const SESSION_HISTORY_PAGE_LIMIT = 128;
const CLIENT_BUILD = "0.1.0";
const CLIENT_CAPABILITIES = [...GATEWAY_SERVER_REQUIRED_CAPABILITIES, GATEWAY_SESSION_HISTORY_CAPABILITY];
const CONTENT_ADAPTER_METHODS = [
	"projectTextPayload",
	"projectJsonRoot",
	"materializeTextPayload",
	"materializeJsonRoot",
	"materializeReplayFrame",
	"materializeReplayFrames",
	"materializeSnapshot",
	"materializeExtensionSnapshot",
] as const;

function isSessionContentAdapterInstallation(value: unknown): value is SessionContentAdapterInstallation {
	if (typeof value !== "object" || value === null) return false;
	const installation = value as { adapter?: unknown; dispose?: unknown };
	if (typeof installation.dispose !== "function") return false;
	if (typeof installation.adapter !== "object" || installation.adapter === null) return false;
	const adapter = installation.adapter as Record<string, unknown>;
	return CONTENT_ADAPTER_METHODS.every((method) => typeof adapter[method] === "function");
}

const defaultSessionContentAdapterFactory: SessionContentAdapterFactory = (trustedContext) => {
	const resolver = createSessionContentResolver({ trustedContext });
	try {
		return {
			adapter: createSessionContentAdapter({ trustedContext, resolver }),
			dispose: () => resolver.dispose(),
		};
	} catch (error) {
		resolver.dispose();
		throw error;
	}
};

type WireSendResult = "sent" | "payload_too_large" | "unavailable";
type TransportClientHello = GatewayClientHelloDto;
type TransportReplayFrame = InlineSessionReplayFrameDto | ProjectedSessionReplayFrame;

type BufferedReplayFrame =
	| { message: InlineSessionReplayFrameDto; representation: "wire" }
	| { message: ProjectedSessionReplayFrame; representation: "projected" };

type TransportSessionSnapshotFrame =
	| { message: InlineSessionSnapshotDto; representation: "wire" }
	| { message: ProjectedSessionSnapshot; representation: "projected" };

type HistorySnapshotBegin = InlineSessionSnapshotBeginDto | SessionSnapshotBeginDto;
type HistorySnapshotChunk = InlineSessionSnapshotChunkDto | SessionSnapshotChunkDto;
type HistoryPageChunk = InlineSessionHistoryPageChunkDto | SessionHistoryPageChunkDto;
type CompletedHistorySnapshot = ReturnType<
	SessionHistoryStreamAssembler<
		unknown,
		HistorySnapshotBegin,
		HistorySnapshotChunk,
		SessionSnapshotEndDto
	>["end"]
>;

interface SnapshotHistoryAssembly {
	identity: SessionRuntimeIdentityDto;
	snapshotId: string;
	representation: "wire" | "projected";
	controller: AbortController;
	assembler: SessionHistoryStreamAssembler<
		unknown,
		HistorySnapshotBegin,
		HistorySnapshotChunk,
		SessionSnapshotEndDto
	>;
	waiterToken: number;
	finishing: boolean;
	completed: CompletedHistorySnapshot | null;
	completion?: Promise<CompletedHistorySnapshot>;
	resolveCompletion?: (completed: CompletedHistorySnapshot) => void;
	rejectCompletion?: (error: Error) => void;
}

interface PageHistoryAssembly {
	identity: SessionRuntimeIdentityDto;
	requestId: string;
	representation: "wire" | "projected";
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
			message: Extract<InlineSessionWsServerMessage, { type: "extension_ui_snapshot" }>;
			representation: "wire";
	  }
	| { message: ProjectedExtensionUiSnapshot; representation: "projected" };

interface ProjectionTail {
	identity: SessionRuntimeIdentityDto;
	controller: AbortController;
	promise: Promise<void>;
	pendingReplayFrames: number;
	pendingReplayBytes: number;
	snapshotPending: boolean;
	snapshotWaiter: SnapshotWaiter | null;
}

interface LazyIdentityScope {
	identity: SessionLazyIdentity;
	controller: AbortController;
	operations: Set<LazyOperation>;
}

interface LazyOperation {
	scope: LazyIdentityScope;
	controller: AbortController;
	onIdentityAbort: () => void;
	callerSignal: AbortSignal | null;
	onCallerAbort: (() => void) | null;
}

type ResponseMessage = Extract<InlineSessionWsServerMessage, { type: "response" }>;

interface PendingCommand {
	id: string;
	token: number;
	serverEpoch: string;
	workspaceId: string;
	sessionHandle: string;
	generation: number;
	commandType: SessionCommandDto["type"];
	historyOperation?: HistoryOperation;
	historyBarrierSeq?: number;
	historyResponseKey?: string;
	response?: ResponseMessage;
	resolve: (response: PiSessionCommandResponseDto) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface HistoryOperation {
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
	requests: PiExtensionUiRequestDto[],
	request: PiExtensionUiRequestDto,
): PiExtensionUiRequestDto[] {
	const semanticKey = extensionRequestSemanticKey(request);
	if (semanticKey === null) return requests;
	return [
		...requests.filter(
			(candidate) => candidate.id !== request.id && extensionRequestSemanticKey(candidate) !== semanticKey,
		),
		request,
	].slice(-MAX_PENDING_EXTENSION_REQUESTS);
}

function extensionRequestSemanticKey(request: PiExtensionUiRequestDto): string | null {
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

function normalizeExtensionRequests(requests: PiExtensionUiRequestDto[]): PiExtensionUiRequestDto[] {
	let normalized: PiExtensionUiRequestDto[] = [];
	for (const request of requests) normalized = replaceExtensionRequest(normalized, request);
	return normalized;
}

function applyReplayExtensionState(
	requests: PiExtensionUiRequestDto[],
	message: TransportReplayFrame,
): PiExtensionUiRequestDto[] {
	if (message.type === "extension_ui_request") return replaceExtensionRequest(requests, message.request);
	if (message.type === "extension_ui_closed") {
		return requests.filter((request) => request.id !== message.requestId);
	}
	return requests;
}

function isIdentityTransitionCommand(commandType: SessionCommandDto["type"]): boolean {
	return commandType === "fork" || commandType === "clone";
}

function isHistoryCommand(commandType: SessionCommandDto["type"]): boolean {
	return commandType === "get_messages" || commandType === "get_entries" || commandType === "get_tree";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ResponseEnvelopeCandidate {
	id: string;
	command: string;
	serverEpoch: string;
	sessionHandle: string;
	generation: number;
}

function responseEnvelopeCandidate(value: unknown): ResponseEnvelopeCandidate | null {
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
	const known = SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES.find((errorCode) => error.includes(errorCode));
	if (known) return known;
	const token = error.match(/[A-Za-z][A-Za-z0-9_-]*/)?.[0];
	return (token ?? "subscription_rejected").slice(0, 128);
}

function isRetryableSubscriptionError(error: string, retryable?: boolean): boolean {
	if (retryable !== undefined) return retryable;
	return SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES.some((code) => error.includes(code));
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

type LeaseStatusMessage = Extract<InlineSessionWsServerMessage, { type: "lease_status" }>;

interface PendingLeaseStatus {
	message: LeaseStatusMessage;
	expectedBaseline: boolean;
}

interface TakeoverAttempt {
	identity: SessionRuntimeIdentityDto;
	leaseRevision: number;
}

function leaseStateFrom(message: LeaseStatusMessage): SessionLeaseState {
	return {
		isController: message.isController,
		...(message.fencingToken ? { fencingToken: message.fencingToken } : {}),
		leaseRevision: message.leaseRevision,
		controlState: message.controlState,
		transition: message.transition,
	};
}

function leaseStatusMatchesState(message: LeaseStatusMessage, state: SessionLeaseState): boolean {
	return leaseStatusSemanticsMatchState(message, state) && state.transition === message.transition;
}

/**
 * A cursorless re-subscribe may deliver the current lease as `baseline` at the
 * same revision as the locally recorded owner transition. The delivery is
 * authoritative, but it is not a second transition. Keep the transition
 * provenance separate from the recipient-local lease semantics.
 */
function leaseStatusSemanticsMatchState(message: LeaseStatusMessage, state: SessionLeaseState): boolean {
	return (
		state.conflicted !== true &&
		state.leaseRevision === message.leaseRevision &&
		state.controlState === message.controlState &&
		state.isController === message.isController &&
		state.fencingToken === message.fencingToken
	);
}

function lazyAbortError(): DOMException {
	return new DOMException("Session lazy content operation was aborted", "AbortError");
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
	const configuredContentAdapter = options.contentAdapter;
	const contentAdapterFactory =
		options.contentAdapterFactory ??
		(configuredContentAdapter
			? () => ({ adapter: configuredContentAdapter, dispose: () => {} })
			: defaultSessionContentAdapterFactory);
	const clientHello: TransportClientHello = {
		type: "client_hello",
		protocol: GATEWAY_PROTOCOL_VERSION,
		clientBuild: options.clientBuild ?? CLIENT_BUILD,
		capabilities: [...CLIENT_CAPABILITIES],
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
	const takeoverAttempts = new Map<string, TakeoverAttempt>();
	const releasedControlIntents = new Set<string>();
	const pendingLeaseStatuses = new Map<string, PendingLeaseStatus>();
	const pendingOverflowRestarts = new Map<string, SessionRuntimeIdentityDto>();
	const baselineRefreshes = new Set<string>();
	const subscriptionBaselines = new Map<string, string | null>();
	let subscribedLruOrder: string[] = [];
	let retainedRawEvents: RetainedRawEvent[] = [];
	let retainedRawEventBytes = 0;

	let socket: SessionWebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let helloTimer: ReturnType<typeof setTimeout> | null = null;
	let commandCounter = 0;
	let historyRequestCounter = 0;
	let nextPendingToken = 1;
	let nextSnapshotWaiterToken = 1;
	let disposed = false;
	let negotiatedMaxClientFrameBytes = SESSION_WS_CLIENT_MAX_BYTES;
	let negotiatedMaxServerFrameBytes = SESSION_WS_SERVER_MAX_BYTES;
	let historyNegotiated = false;
	let attachmentGuardContext: Readonly<SessionAttachmentGuardContext> | null = null;
	let contentRefGuardContext: Readonly<SessionContentRefGuardContext> | null = null;
	let activeContentAdapter = options.contentAdapter;
	let installedContent: SessionContentAdapterInstallation | null = null;
	const wireTextEncoder = new TextEncoder();
	let hotRuntimeRevision = -1;
	let hotRuntimeByHandle = new Map<string, HotRuntimeInventoryEntryDto>();
	const connectionObservations = new Map<string, SessionRuntimeIdentityDto>();
	const projectionTails = new Map<string, ProjectionTail>();
	const lazyIdentityScopes = new Map<string, LazyIdentityScope>();
	const initialInventoryWaiters = new Set<InitialInventoryWaiter>();
	const exactHotRecoveryQueue: string[] = [];
	const queuedExactHotRecoveries = new Set<string>();
	let activeExactHotRecovery: ActiveExactHotRecovery | null = null;
	const connectionMachine = createSessionConnectionMachine({
		clientHello,
		helloTimeoutMs,
		reconnectBaseMs,
		reconnectMaxMs,
	});

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
		takeoverSession,
		sendCommand,
		sendExtensionUiResponse,
		manualRetryResync,
		retrySessionSubscription,
	}));

	function transitionConnection(event: SessionConnectionMachineEvent): void {
		const transition = connectionMachine.transition(event);
		store.setState({ connectionState: transition.state.observableState });
		for (const intent of transition.intents) applyConnectionIntent(intent);
	}

	function applyConnectionIntent(intent: SessionConnectionMachineIntent): void {
		switch (intent.type) {
			case "open_socket":
				openSocket(intent.socketEpoch);
				return;
			case "send_client_hello": {
				const current = socket;
				if (
					!current ||
					connectionMachine.getState().socketEpoch !== intent.socketEpoch ||
					current.readyState !== SOCKET_OPEN
				) {
					return;
				}
				try {
					current.send(JSON.stringify(intent.hello));
				} catch {
					transitionConnection({ type: "socket_failed", socketEpoch: intent.socketEpoch });
					handleDisconnected();
				}
				return;
			}
			case "start_hello_timeout":
				clearHelloTimer();
				helloTimer = setTimeout(() => {
					if (socket && socket === socketForEpoch(intent.socketEpoch)) {
						enterIncompatible(socket);
					}
				}, intent.delayMs);
				return;
			case "clear_hello_timeout":
				clearHelloTimer();
				return;
			case "schedule_reconnect":
				scheduleReconnect(intent.socketEpoch, intent.delayMs);
				return;
			case "clear_reconnect_timer":
				clearReconnectTimer();
				return;
			case "close_socket":
				closeSocket(intent.socketEpoch);
				return;
		}
	}

	function socketForEpoch(socketEpoch: number): SessionWebSocket | null {
		return connectionMachine.getState().socketEpoch === socketEpoch ? socket : null;
	}

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

	function disposeInstalledContent(): void {
		const installed = installedContent;
		installedContent = null;
		contentRefGuardContext = null;
		activeContentAdapter = configuredContentAdapter;
		if (!installed) return;
		try {
			installed.dispose();
		} catch {
			// Adapter disposal is best effort after the transport fence is closed.
		}
	}

	function installContentForHello(message: GatewayServerHelloDto): boolean {
		if (!contentAdapterFactory || contentRefGuardContext !== null) return false;
		const negotiation = negotiateGatewayHello(clientHello, message);
		if (!negotiation.negotiated) return false;
		const context: Readonly<SessionContentRefGuardContext> = Object.freeze({
			serverEpoch: message.serverEpoch,
			payloadBudget: Object.freeze({ ...negotiation.payloadBudget }),
			contentRefBudget: Object.freeze({ ...negotiation.contentRefBudget }),
		});
		let installation: SessionContentAdapterInstallation;
		try {
			const candidate = contentAdapterFactory(context);
			if (!isSessionContentAdapterInstallation(candidate)) return false;
			installation = candidate;
		} catch {
			return false;
		}
		contentRefGuardContext = context;
		attachmentGuardContext = Object.freeze({
			serverEpoch: context.serverEpoch,
			payloadBudget: context.payloadBudget,
		});
		activeContentAdapter = installation.adapter;
		installedContent = installation;
		historyNegotiated =
			message.capabilities.includes(GATEWAY_SESSION_HISTORY_CAPABILITY) &&
			clientHello.capabilities.includes(GATEWAY_SESSION_HISTORY_CAPABILITY);
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
			if (pending.historyBarrierSeq !== undefined) {
				barrierSeq = Math.max(barrierSeq, pending.historyBarrierSeq);
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
			abortSnapshotHistoryAssembly(snapshotAssembly);
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
			abortSnapshotHistoryAssembly(assembly);
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
			abortSnapshotHistoryAssembly(assembly);
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
		message: Extract<InlineSessionReplayFrameDto, { type: "extension_ui_request" }>,
	): boolean {
		const retained = deliveredNotifyKeys.get(identity.sessionHandle);
		if (!retained || !identitiesMatch(retained.identity, identity)) return false;
		return retained.keySet.has(`${String(message.seq)}:${message.request.id}`);
	}

	function rememberDeliveredNotify(
		identity: SessionRuntimeIdentityDto,
		message: Extract<InlineSessionReplayFrameDto, { type: "extension_ui_request" }>,
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
		if (disposed || connectionMachine.getState().phase === "terminal") return;
		transitionConnection({ type: "connect" });
	}

	function openSocket(socketEpoch: number): void {
		if (
			disposed ||
			!connectionMachine.getState().reconnectEnabled ||
			connectionMachine.getState().socketEpoch !== socketEpoch
		) {
			return;
		}
		if (socket && (socket.readyState === SOCKET_OPEN || socket.readyState === SOCKET_CONNECTING)) return;
		let next: SessionWebSocket;
		try {
			next = createSocket(socketUrl());
		} catch {
			transitionConnection({ type: "socket_failed", socketEpoch });
			handleDisconnected();
			return;
		}
		socket = next;
		next.onopen = () => {
			if (socket !== next || disposed) return;
			transitionConnection({ type: "socket_open", socketEpoch });
		};
		next.onclose = () => {
			if (socket !== next) return;
			socket = null;
			transitionConnection({ type: "socket_closed", socketEpoch });
			handleDisconnected();
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
			if (contentRefGuardContext === null) {
				if (
					!isGatewayServerHello(value) ||
					connectionMachine.getState().phase !== "awaiting-hello" ||
					!installContentForHello(value)
				) {
					enterIncompatible(next);
					return;
				}
				transitionConnection({
					type: "server_hello",
					socketEpoch,
					serverEpoch: value.serverEpoch,
					accepted: true,
				});
				return;
			}
			const negotiatedContentRefContext = contentRefGuardContext;
			if (negotiatedContentRefContext === null) {
				enterIncompatible(next);
				return;
			}
			if (
				connectionMachine.getState().phase === "awaiting-hello" &&
				connectionMachine.getState().serverEpoch !== null
			) {
				if (
					!isSessionWsServerMessage(value, negotiatedContentRefContext) ||
					value.type !== "hot_runtime_inventory" ||
					value.serverEpoch !== connectionMachine.getState().serverEpoch
				) {
					enterIncompatible(next);
					return;
				}
				transitionConnection({
					type: "initial_inventory",
					socketEpoch,
					serverEpoch: value.serverEpoch,
					accepted: true,
				});
				handleHotRuntimeInventory(value, true);
				return;
			}
			if (connectionMachine.getState().phase !== "ready") {
				enterIncompatible(next);
				return;
			}
			if (!isSessionWsServerMessage(value, negotiatedContentRefContext)) {
				if (!handleInvalidResponse(value)) enterIncompatible(next);
				return;
			}
			switch (value.type) {
				case "response":
				case "event":
				case "extension_ui_request":
				case "extension_ui_closed":
				case "session_snapshot":
				case "extension_ui_snapshot":
				case "session_snapshot_begin":
				case "session_snapshot_chunk":
				case "session_snapshot_end":
				case "session_history_page_begin":
				case "session_history_page_chunk":
				case "session_history_page_end":
					ingestFrameMessage(value, rawWireBytes);
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
		};
	}

	function enterIncompatible(current: SessionWebSocket): void {
		if (socket !== current) return;
		const socketEpoch = connectionMachine.getState().socketEpoch;
		transitionConnection({ type: "protocol_failure", socketEpoch });
		const error = new SessionTransportError("unavailable", "Gateway protocol is incompatible");
		rejectAllPending(error);
		rejectInitialInventoryWaiters(error);
		resetDisconnectedState("incompatible");
	}

	function scheduleReconnect(socketEpoch: number, delay: number): void {
		if (disposed || !connectionMachine.getState().reconnectEnabled || reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			transitionConnection({ type: "reconnect_timer", socketEpoch });
		}, delay);
	}

	function closeSocket(socketEpoch: number): void {
		const current = socketForEpoch(socketEpoch);
		if (!current) return;
		socket = null;
		current.onopen = null;
		current.onclose = null;
		current.onerror = null;
		current.onmessage = null;
		try {
			current.close();
		} catch {
			// The connection fence is already recorded.
		}
	}

	function disconnect(): void {
		const socketEpoch = socket ? connectionMachine.getState().socketEpoch : null;
		transitionConnection({ type: "disconnect", socketEpoch });
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
		abortAllProjections();
		abortAllLazyOperations();
		abortAllHistoryOperations();
		disposeInstalledContent();
		clearHelloTimer();
		negotiatedMaxClientFrameBytes = SESSION_WS_CLIENT_MAX_BYTES;
		negotiatedMaxServerFrameBytes = SESSION_WS_SERVER_MAX_BYTES;
		historyNegotiated = false;
		attachmentGuardContext = null;
		hotRuntimeRevision = -1;
		claimAttempts.clear();
		takeoverAttempts.clear();
		releasedControlIntents.clear();
		pendingLeaseStatuses.clear();
		pendingOverflowRestarts.clear();
		baselineRefreshes.clear();
		subscriptionBaselines.clear();
		activeExactHotRecovery = null;
		exactHotRecoveryQueue.length = 0;
		queuedExactHotRecoveries.clear();
		connectionObservations.clear();
		const sessions: Record<string, SessionChannelState> = {};
		for (const [sessionHandle, channel] of Object.entries(store.getState().sessions)) {
			abortHistoryForSession(sessionHandle);
			sessions[sessionHandle] = {
				...channel,
				freshLeaseBaseline: null,
				lease: { isController: false },
				history: emptyHistoryState(),
			};
		}
		store.setState({ connectionState, hotRuntimeInventory: null, sessions });
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
		if (store.getState().connectionState !== "online" || contentRefGuardContext === null) return;
		const cursor = validCursor(channel);
		sendSubscription(sessionHandle, cursor);
	}

	function retrySessionSubscription(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (channel?.subscriptionAdmission?.kind !== "rejected") return false;
		if (!channel.subscriptionAdmission.retryable) return false;
		if (store.getState().connectionState !== "online" || contentRefGuardContext === null) return false;
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
			representation: "projected",
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
		abortProjection(sessionHandle);
		abortLazyOperationsForSession(sessionHandle);
		rejectHistoryForSession(sessionHandle, new SessionTransportError("session_not_subscribed"));
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
		takeoverAttempts.delete(sessionHandle);
		releasedControlIntents.delete(sessionHandle);
		pendingLeaseStatuses.delete(sessionHandle);
		pendingOverflowRestarts.delete(sessionHandle);
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
		abortProjection(sessionHandle);
		abortLazyOperationsForSession(sessionHandle);
		rejectHistoryForSession(
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
		takeoverAttempts.delete(sessionHandle);
		pendingOverflowRestarts.delete(sessionHandle);
		pendingLeaseStatuses.delete(sessionHandle);
		baselineRefreshes.delete(sessionHandle);
		subscriptionBaselines.delete(sessionHandle);
		discardRawEvents(sessionHandle, false);
		if (channel) setChannel(sessionHandle, () => emptyChannel(sessionHandle));
		return true;
	}

	function claimSession(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.subscribed || takeoverAttempts.has(sessionHandle)) return false;
		releasedControlIntents.delete(sessionHandle);
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
		takeoverAttempts.delete(sessionHandle);
		releasedControlIntents.add(sessionHandle);
		pendingOverflowRestarts.delete(sessionHandle);
		setChannel(sessionHandle, (current) => ({
			...current,
			controllerIntent: false,
			freshLeaseBaseline: null,
			lease: {
				isController: false,
				...(current.lease.leaseRevision === undefined ? {} : { leaseRevision: current.lease.leaseRevision }),
				...(current.lease.controlState === undefined ? {} : { controlState: current.lease.controlState }),
				...(current.lease.transition === undefined ? {} : { transition: current.lease.transition }),
			},
		}));
		if (store.getState().connectionState !== "online") return false;
		return sendWire({ type: "session_release", sessionHandle }) === "sent";
	}

	function takeoverSession(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		const runtime = channel?.runtime;
		const leaseRevision = channel?.lease.leaseRevision;
		if (
			store.getState().connectionState !== "online" ||
			!channel?.subscribed ||
			!runtime ||
			runtime.state === "dormant" ||
			runtime.sessionFile === null ||
			channel.generation === null ||
			!channel.baselineAuthoritative ||
			!hasFreshLeaseBaseline(channel) ||
			channel.resync !== null ||
			channel.lease.conflicted === true ||
			channel.lease.isController ||
			channel.lease.controlState !== "held" ||
			typeof leaseRevision !== "number" ||
			!Number.isSafeInteger(leaseRevision) ||
			claimAttempts.has(sessionHandle) ||
			takeoverAttempts.has(sessionHandle) ||
			subscriptionBaselines.has(sessionHandle)
		) {
			return false;
		}
		takeoverAttempts.set(sessionHandle, {
			identity: runtime,
			leaseRevision,
		});
		if (
			sendWire({
				type: "session_takeover",
				sessionHandle,
				expectedGeneration: channel.generation,
				expectedLeaseRevision: leaseRevision,
			}) !== "sent"
		) {
			takeoverAttempts.delete(sessionHandle);
			return false;
		}
		return true;
	}

	function manualRetryResync(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		const recovery = resyncCoordinator.getState(sessionHandle);
		if (
			channel?.runtime?.error === "session_snapshot_overflow" &&
			channel.generation !== null &&
			recovery?.phase === "degraded"
		) {
			releasedControlIntents.delete(sessionHandle);
			setChannel(sessionHandle, (current) => ({ ...current, controllerIntent: true }));
			if (
				channel.baselineAuthoritative &&
				hasFreshLeaseBaseline(channel) &&
				channel.resync === null &&
				channel.lease.fencingToken
			) {
				return (
					sendWire({
						type: "session_restart",
						sessionHandle,
						expectedGeneration: channel.generation,
						fencingToken: channel.lease.fencingToken,
					}) === "sent"
				);
			}
			pendingOverflowRestarts.set(sessionHandle, channel.runtime);
			if (!channel.baselineAuthoritative || !hasFreshLeaseBaseline(channel) || channel.resync !== null) {
				if (resyncCoordinator.manualRetry(sessionHandle)) return true;
				pendingOverflowRestarts.delete(sessionHandle);
				setChannel(sessionHandle, (current) => ({ ...current, controllerIntent: false }));
				return false;
			}
			claimAttempts.add(sessionHandle);
			if (sendWire({ type: "session_claim", sessionHandle }) !== "sent") {
				claimAttempts.delete(sessionHandle);
				pendingOverflowRestarts.delete(sessionHandle);
				return false;
			}
			return true;
		}
		return resyncCoordinator.manualRetry(sessionHandle);
	}

	function sendCommand(
		sessionHandle: string,
		command: SessionCommandDto,
		timeoutMs = commandTimeoutMs(command.type),
	): Promise<PiSessionCommandResponseDto> {
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
		return new Promise<PiSessionCommandResponseDto>((resolve, reject) => {
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
			if (isHistoryCommand(command.type) && activeContentAdapter) {
				pending.historyOperation = createHistoryOperation(pending);
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
		const negotiatedServerEpoch = connectionMachine.getState().serverEpoch;
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

	function ingestServerMessage(message: InlineSessionWsServerMessage): void {
		switch (message.type) {
			case "hot_runtime_inventory":
				handleHotRuntimeInventory(message);
				return;
			case "response":
				handleInlineResponse(message);
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
				handleSessionSnapshotBegin(message, "wire");
				return;
			case "session_snapshot_chunk":
				handleSessionSnapshotChunk(message, "wire");
				return;
			case "session_snapshot_end":
				handleSessionSnapshotEnd(message, "wire");
				return;
			case "session_history_page_begin":
				handleSessionHistoryPageBegin(message, "wire");
				return;
			case "session_history_page_chunk":
				handleSessionHistoryPageChunk(message, "wire");
				return;
			case "session_history_page_end":
				handleSessionHistoryPageEnd(message, "wire");
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
	): PiSessionMessageDto {
		if (!isPiSessionMessageDto(value, guardContext ?? undefined)) {
			throw new Error("Session history message failed its current product guard");
		}
		return value;
	}

	function assertCurrentEntry(
		value: unknown,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): PiSessionEntryDto {
		if (!isPiSessionEntryDto(value, guardContext ?? undefined)) {
			throw new Error("Session history entry failed its current product guard");
		}
		return value;
	}

	function assertCurrentTree(
		value: unknown,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): PiSessionTreeNodeDto[] {
		if (!isPiSessionTreeDto(value, guardContext ?? undefined)) {
			throw new Error("Session history tree failed its current product guard");
		}
		return value;
	}

	function assertCurrentResponse(
		value: unknown,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): PiSessionCommandResponseDto {
		if (!isPiSessionCommandResponseDto(value, guardContext ?? undefined)) {
			throw new Error("Session command response failed its current product guard");
		}
		return value;
	}

	async function materializeMessage(
		message: SessionMessageDto,
		adapter: SessionContentAdapter,
		signal: AbortSignal,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): Promise<PiSessionMessageDto> {
		let candidate: unknown;
		switch (message.role) {
			case "assistant": {
				const content: Extract<PiSessionMessageDto, { role: "assistant" }>["content"] = [];
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
				const content: Extract<PiSessionMessageDto, { role: "toolResult" }>["content"] = [];
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
				let content: Extract<PiSessionMessageDto, { role: "custom" }>["content"];
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

	async function materializeEntry(
		entry: SessionEntryDto,
		adapter: SessionContentAdapter,
		signal: AbortSignal,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): Promise<PiSessionEntryDto> {
		let candidate: unknown;
		if (entry.type === "message") {
			candidate = {
				...entry,
				message: await materializeMessage(entry.message, adapter, signal, guardContext),
			};
		} else if (entry.type === "custom_message") {
			let content: Extract<PiSessionEntryDto, { type: "custom_message" }>["content"];
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

	async function materializeTreeNode(
		node: SessionTreeNodeDto,
		adapter: SessionContentAdapter,
		signal: AbortSignal,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
	): Promise<PiSessionTreeNodeDto> {
		const children: PiSessionTreeNodeDto[] = [];
		for (const child of node.children) {
			children.push(await materializeTreeNode(child, adapter, signal, guardContext));
		}
		const candidate: unknown = {
			...node,
			entry: await materializeEntry(node.entry, adapter, signal, guardContext),
			children,
		};
		const checked = assertCurrentTree([candidate], guardContext);
		const first = checked[0];
		if (!first) throw new Error("Session history tree root disappeared during materialization");
		return first;
	}

	async function materializeResponse(
		response: SessionCommandResponseDto,
		adapter: SessionContentAdapter,
		signal: AbortSignal,
		guardContext: Readonly<SessionAttachmentGuardContext> | null,
		contentRefContext: Readonly<SessionContentRefGuardContext> | null,
	): Promise<PiSessionCommandResponseDto> {
		if (contentRefContext && !isSessionCommandResponseDto(response, contentRefContext)) {
			throw new Error("Session command response failed its negotiated content-reference guard");
		}
		if (response.success === false) return assertCurrentResponse(response, guardContext);
		switch (response.command) {
			case "get_messages": {
				const messages: PiSessionMessageDto[] = [];
				for (const message of response.data.messages) {
					messages.push(await materializeMessage(message, adapter, signal, guardContext));
				}
				return assertCurrentResponse({ ...response, data: { ...response.data, messages } }, guardContext);
			}
			case "get_entries": {
				const entries: PiSessionEntryDto[] = [];
				for (const entry of response.data.entries) {
					entries.push(await materializeEntry(entry, adapter, signal, guardContext));
				}
				return assertCurrentResponse({ ...response, data: { ...response.data, entries } }, guardContext);
			}
			case "get_tree": {
				const tree: PiSessionTreeNodeDto[] = [];
				for (const node of response.data.tree) {
					tree.push(await materializeTreeNode(node, adapter, signal, guardContext));
				}
				return assertCurrentResponse({ ...response, data: { ...response.data, tree } }, guardContext);
			}
			default:
				return assertCurrentResponse(response, guardContext);
		}
	}

	function createHistoryOperation(pending: PendingCommand): HistoryOperation {
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

	function currentHistoryPending(operation: HistoryOperation): PendingCommand | null {
		const pending = pendingCommands.get(operation.id);
		if (
			!pending ||
			pending.token !== operation.token ||
			pending.historyOperation !== operation ||
			!isHistoryCommand(pending.commandType) ||
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

	function abortHistoryOperation(pending: PendingCommand): void {
		const operation = pending.historyOperation;
		if (!operation) return;
		pending.historyOperation = undefined;
		operation.controller.abort();
	}

	function rejectHistoryForSession(sessionHandle: string, error: Error): void {
		for (const pending of [...pendingCommands.values()]) {
			if (
				isHistoryCommand(pending.commandType) &&
				(pending.sessionHandle === sessionHandle ||
					pending.historyOperation?.identity.sessionHandle === sessionHandle)
			) {
				rejectPending(pending.id, error);
			}
		}
	}

	function abortAllHistoryOperations(): void {
		for (const pending of pendingCommands.values()) {
			if (pending.historyOperation) abortHistoryOperation(pending);
		}
	}

	function handleInvalidResponse(value: unknown): boolean {
		const candidate = responseEnvelopeCandidate(value);
		if (!candidate) return false;
		const pending = pendingCommands.get(candidate.id);
		if (!pending || !isHistoryCommand(pending.commandType)) return false;
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
		const error = new Error("Session command response failed its negotiated guard");
		const channel = store.getState().sessions[candidate.sessionHandle];
		if (pending.historyOperation && currentHistoryPending(pending.historyOperation) === pending) {
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

	function startHistoryMaterialization(message: SessionResponseFrameDto, pending: PendingCommand): boolean {
		const responseKey = JSON.stringify(message);
		if (pending.historyResponseKey !== undefined) {
			if (pending.historyResponseKey === responseKey) return true;
			rejectPending(
				pending.id,
				new SessionTransportError(
					"response_mismatch",
					`Response ${pending.id} changed while content history was materializing`,
				),
			);
			return true;
		}
		const operation = pending.historyOperation ?? createHistoryOperation(pending);
		if (operation.started) return true;
		operation.started = true;
		pending.historyOperation = operation;
		pending.historyBarrierSeq = message.barrierSeq;
		pending.historyResponseKey = responseKey;
		const adapter = activeContentAdapter;
		if (!adapter) {
			rejectPending(
				pending.id,
				new SessionTransportError("unavailable", " history materialization is disabled"),
			);
			return true;
		}
		const guardContext = attachmentGuardContext;
		const negotiatedContentRefContext = contentRefGuardContext;
		void materializeResponse(
			message.response,
			adapter,
			operation.controller.signal,
			guardContext,
			negotiatedContentRefContext,
		)
			.then((response) => {
				if (operation.controller.signal.aborted || currentHistoryPending(operation) !== pending) return;
				pending.historyOperation = undefined;
				pending.response = { ...message, response };
				resolvePendingResponse(pending);
			})
			.catch((error: unknown) => {
				if (operation.controller.signal.aborted || currentHistoryPending(operation) !== pending) return;
				const failure = error instanceof Error ? error : new Error(String(error));
				reportProjectionFailure(pending.sessionHandle, pending.generation, failure);
				rejectPending(pending.id, failure);
			});
		return true;
	}

	function handleResponse(message: SessionResponseFrameDto): boolean {
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
		if (isHistoryCommand(pending.commandType)) {
			return startHistoryMaterialization(message, pending);
		}
		const adapter = activeContentAdapter;
		if (!adapter) {
			rejectPending(id, new SessionTransportError("unavailable", " response materialization is disabled"));
			return true;
		}
		const controller = new AbortController();
		void materializeResponse(
			message.response,
			adapter,
			controller.signal,
			attachmentGuardContext,
			contentRefGuardContext,
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

	function ingestFrameMessage(message: SessionTransportFrameMessage, rawWireBytes: number): boolean {
		const adapter = activeContentAdapter;
		if (!adapter || disposed) return false;
		if (
			!Number.isSafeInteger(rawWireBytes) ||
			rawWireBytes <= 0 ||
			rawWireBytes > negotiatedMaxServerFrameBytes
		) {
			return false;
		}
		if (message.type === "response") return handleResponse(message);
		const identity = frameIdentity(message);
		if (!identity || !isCurrentProjectionIdentity(identity)) return false;
		switch (message.type) {
			case "event":
			case "extension_ui_request":
			case "extension_ui_closed":
				return enqueueProjection(identity, rawWireBytes, null, async (signal) => {
					const projected = await adapter.materializeReplayFrame(message, signal);
					return () => handleReplayFrame(projected, "projected");
				});
			case "session_snapshot": {
				const key = identityKey(identity);
				const waiter = snapshotWaiters.get(key);
				if (!waiter) return false;
				return enqueueProjection(identity, rawWireBytes, waiter, async (signal) => {
					const projected = await adapter.materializeSnapshot(message, signal);
					return () => {
						if (snapshotWaiters.get(key)?.token !== waiter.token) return;
						commitSessionSnapshot(projected, "projected");
					};
				});
			}
			case "session_snapshot_begin":
				handleSessionSnapshotBegin(message, "projected", rawWireBytes);
				return true;
			case "session_snapshot_chunk":
				handleSessionSnapshotChunk(message, "projected");
				return true;
			case "session_snapshot_end":
				handleSessionSnapshotEnd(message, "projected");
				return true;
			case "session_history_page_begin":
				handleSessionHistoryPageBegin(message, "projected");
				return true;
			case "session_history_page_chunk":
				handleSessionHistoryPageChunk(message, "projected");
				return true;
			case "session_history_page_end":
				handleSessionHistoryPageEnd(message, "projected");
				return true;
			case "extension_ui_snapshot":
				return enqueueProjection(identity, rawWireBytes, null, async (signal) => {
					const projected = await adapter.materializeExtensionSnapshot(message, signal);
					return () => handleExtensionSnapshot(projected, "projected");
				});
		}
	}

	function handleSessionSnapshotBegin(
		message: HistorySnapshotBegin,
		representation: "wire" | "projected",
		rawWireBytes = 0,
	): void {
		const channel = store.getState().sessions[message.sessionHandle];
		if (!channel?.subscribed || !channel.resync || !identitiesMatch(channel.runtime, message)) return;
		const key = identityKey(message);
		const waiter = snapshotWaiters.get(key);
		if (!waiter) return;
		const previous = snapshotHistoryAssemblies.get(key);
		if (previous) {
			snapshotHistoryAssemblies.delete(key);
			abortSnapshotHistoryAssembly(previous);
		}
		if (representation === "projected") {
			const pendingTail = projectionTails.get(message.sessionHandle);
			if (pendingTail?.snapshotPending) {
				discardProjectionTail(message.sessionHandle, pendingTail);
			}
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
			representation,
			controller: new AbortController(),
			assembler,
			waiterToken: waiter.token,
			finishing: false,
			completed: null,
		};
		if (representation === "projected") {
			const completion = new Promise<CompletedHistorySnapshot>((resolve, reject) => {
				assembly.resolveCompletion = resolve;
				assembly.rejectCompletion = (error) => reject(error);
			});
			assembly.completion = completion;
			completion.catch(() => undefined);
		}
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
		if (representation === "projected") {
			const accepted = enqueueProjection(message, rawWireBytes, waiter, async (signal) => {
				const completed = await assembly.completion;
				if (!completed || signal.aborted || assembly.controller.signal.aborted) {
					throw new DOMException("Session snapshot was aborted", "AbortError");
				}
				const adapter = activeContentAdapter;
				if (!adapter || completed.begin.type !== "session_snapshot_begin") {
					throw new Error(" history snapshot materialization is unavailable");
				}
				const { type: _type, history: _history, ...header } = completed.begin;
				const projected = await adapter.materializeSnapshot(
					{
						...header,
						type: "session_snapshot",
						settledMessages: completed.messages as SessionMessageDto[],
					} as SessionSnapshotDto,
					AbortSignal.any([signal, assembly.controller.signal]),
				);
				return () => {
					if (!isCurrentSnapshotAssembly(assembly)) return;
					snapshotHistoryAssemblies.delete(key);
					commitSessionSnapshot(projected, "projected");
				};
			});
			if (!accepted) {
				failChunkedSnapshot(message, new Error(" history snapshot could not be queued"), waiter);
			}
		}
	}

	function handleSessionSnapshotChunk(
		message: HistorySnapshotChunk,
		representation: "wire" | "projected",
	): void {
		const assembly = snapshotHistoryAssemblies.get(identityKey(message));
		if (!assembly || assembly.representation !== representation || assembly.finishing) return;
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

	function handleSessionSnapshotEnd(
		message: SessionSnapshotEndDto,
		representation: "wire" | "projected",
	): void {
		const key = identityKey(message);
		const assembly = snapshotHistoryAssemblies.get(key);
		if (!assembly || assembly.representation !== representation || assembly.finishing) return;
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
		if (representation === "wire") {
			snapshotHistoryAssemblies.delete(key);
			commitSessionSnapshot(
				currentSnapshotFromHistory(completed.begin as InlineSessionSnapshotBeginDto, completed.messages),
			);
			return;
		}
		assembly.completed = completed;
		assembly.resolveCompletion?.(completed);
	}

	function currentSnapshotWaiter(assembly: SnapshotHistoryAssembly): SnapshotWaiter | undefined {
		const waiter = snapshotWaiters.get(identityKey(assembly.identity));
		return waiter?.token === assembly.waiterToken ? waiter : undefined;
	}

	function currentSnapshotFromHistory(
		begin: InlineSessionSnapshotBeginDto,
		messages: unknown[],
	): InlineSessionSnapshotDto {
		const { type: _type, history: _history, ...header } = begin;
		return {
			...header,
			type: "session_snapshot",
			settledMessages: messages as PiSessionMessageDto[],
		};
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
			assembly.rejectCompletion?.(error);
			abortSnapshotHistoryAssembly(assembly);
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

	function abortSnapshotHistoryAssembly(assembly: SnapshotHistoryAssembly): void {
		if (!assembly.completed) {
			assembly.rejectCompletion?.(
				new SessionTransportError("stale_resync", "Session history stream was aborted"),
			);
		}
		assembly.controller.abort();
		if (assembly.representation === "projected") {
			const tail = projectionTails.get(assembly.identity.sessionHandle);
			if (tail?.snapshotPending && tail.snapshotWaiter?.token === assembly.waiterToken) {
				discardProjectionTail(assembly.identity.sessionHandle, tail);
			}
		}
	}

	function handleSessionHistoryPageBegin(
		message: SessionHistoryPageBeginDto,
		representation: "wire" | "projected",
	): void {
		const operation = pageHistoryAssemblies.get(message.requestId);
		const channel = store.getState().sessions[message.sessionHandle];
		if (!operation || operation.representation !== representation) return;
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

	function handleSessionHistoryPageChunk(
		message: HistoryPageChunk,
		representation: "wire" | "projected",
	): void {
		const operation = pageHistoryAssemblies.get(message.requestId);
		if (!operation || operation.representation !== representation || operation.finishing) return;
		try {
			operation.assembler.chunk(message);
		} catch (error) {
			failHistoryPage(operation, error instanceof Error ? error : new Error(String(error)));
		}
	}

	function handleSessionHistoryPageEnd(
		message: SessionHistoryPageEndDto,
		representation: "wire" | "projected",
	): void {
		const operation = pageHistoryAssemblies.get(message.requestId);
		if (!operation || operation.representation !== representation || operation.finishing) return;
		let completed: ReturnType<typeof operation.assembler.end>;
		try {
			completed = operation.assembler.end(message);
		} catch (error) {
			failHistoryPage(operation, error instanceof Error ? error : new Error(String(error)));
			return;
		}
		operation.finishing = true;
		if (representation === "wire") {
			pageHistoryAssemblies.delete(operation.requestId);
			completeHistoryPage(
				operation,
				completed.messages as PiSessionMessageDto[],
				completed.begin,
				completed.end,
			);
			return;
		}
		void finishHistoryPage(operation, completed);
	}

	function completeHistoryPage(
		operation: PageHistoryAssembly,
		messages: PiSessionMessageDto[],
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

	async function finishHistoryPage(
		operation: PageHistoryAssembly,
		completed: ReturnType<typeof operation.assembler.end>,
	): Promise<void> {
		try {
			const adapter = activeContentAdapter;
			if (!adapter) throw new Error(" history page materialization is unavailable");
			const messages: PiSessionMessageDto[] = [];
			for (const message of completed.messages as SessionMessageDto[]) {
				messages.push(
					await materializeMessage(message, adapter, operation.controller.signal, attachmentGuardContext),
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

	function frameIdentity(message: SessionTransportFrameMessage): SessionRuntimeIdentityDto | null {
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

	function isCurrentProjectionIdentity(identity: SessionRuntimeIdentityDto): boolean {
		const channel = store.getState().sessions[identity.sessionHandle];
		return Boolean(channel?.subscribed && identitiesMatch(channel.runtime, identity));
	}

	function captureLazyIdentity(identity: SessionLazyIdentity): SessionLazyIdentity {
		return Object.freeze({
			serverEpoch: identity.serverEpoch,
			workspaceId: identity.workspaceId,
			sessionHandle: identity.sessionHandle,
			generation: identity.generation,
		});
	}

	function isCurrentLazyIdentity(identity: SessionLazyIdentity): boolean {
		const channel = store.getState().sessions[identity.sessionHandle];
		return Boolean(
			channel?.subscribed &&
				channel.baselineAuthoritative &&
				channel.recovery === null &&
				identitiesMatch(channel.runtime, identity),
		);
	}

	function lazyIdentityScope(identity: SessionLazyIdentity): LazyIdentityScope {
		const key = identityKey(identity);
		const existing = lazyIdentityScopes.get(key);
		if (existing && !existing.controller.signal.aborted) return existing;
		if (existing) lazyIdentityScopes.delete(key);
		const scope: LazyIdentityScope = {
			identity,
			controller: new AbortController(),
			operations: new Set<LazyOperation>(),
		};
		lazyIdentityScopes.set(key, scope);
		return scope;
	}

	function registerLazyOperation(
		identity: SessionLazyIdentity,
		callerSignal: AbortSignal | undefined,
	): LazyOperation {
		const scope = lazyIdentityScope(identity);
		const controller = new AbortController();
		const onIdentityAbort = (): void => controller.abort();
		const onCallerAbort = (): void => controller.abort();
		scope.controller.signal.addEventListener("abort", onIdentityAbort, { once: true });
		callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
		if (scope.controller.signal.aborted || callerSignal?.aborted) controller.abort();
		const operation: LazyOperation = {
			scope,
			controller,
			onIdentityAbort,
			callerSignal: callerSignal ?? null,
			onCallerAbort: callerSignal ? onCallerAbort : null,
		};
		scope.operations.add(operation);
		return operation;
	}

	function releaseLazyOperation(operation: LazyOperation): void {
		operation.scope.controller.signal.removeEventListener("abort", operation.onIdentityAbort);
		if (operation.callerSignal && operation.onCallerAbort) {
			operation.callerSignal.removeEventListener("abort", operation.onCallerAbort);
		}
		operation.scope.operations.delete(operation);
		const key = identityKey(operation.scope.identity);
		if (lazyIdentityScopes.get(key) === operation.scope && operation.scope.operations.size === 0) {
			lazyIdentityScopes.delete(key);
		}
	}

	function abortLazyIdentity(identity: SessionLazyIdentity): void {
		const key = identityKey(identity);
		const scope = lazyIdentityScopes.get(key);
		if (!scope) return;
		lazyIdentityScopes.delete(key);
		scope.controller.abort();
	}

	function abortLazyOperationsForSession(sessionHandle: string): void {
		for (const [key, scope] of [...lazyIdentityScopes]) {
			if (scope.identity.sessionHandle !== sessionHandle) continue;
			lazyIdentityScopes.delete(key);
			scope.controller.abort();
		}
	}

	function abortAllLazyOperations(): void {
		for (const scope of lazyIdentityScopes.values()) scope.controller.abort();
		lazyIdentityScopes.clear();
	}

	async function resolveText(
		identity: SessionLazyIdentity,
		payload: SessionTextPayloadProjection,
		callerSignal?: AbortSignal,
	): Promise<string> {
		const captured = captureLazyIdentity(identity);
		if (disposed || callerSignal?.aborted || !isCurrentLazyIdentity(captured)) {
			throw lazyAbortError();
		}
		const adapter = activeContentAdapter;
		if (!adapter) {
			throw new SessionTransportError("unavailable", "Session lazy content is disabled");
		}
		const operation = registerLazyOperation(captured, callerSignal);
		try {
			const value = await adapter.materializeTextPayload(payload.value, operation.controller.signal);
			if (operation.controller.signal.aborted || !isCurrentLazyIdentity(captured)) {
				throw lazyAbortError();
			}
			return value;
		} catch (error: unknown) {
			if (operation.controller.signal.aborted || !isCurrentLazyIdentity(captured)) {
				throw lazyAbortError();
			}
			if (reportProjectionFailure(captured.sessionHandle, captured.generation, error)) {
				abortLazyIdentity(captured);
			}
			throw error;
		} finally {
			releaseLazyOperation(operation);
		}
	}

	async function resolveJson<T>(
		identity: SessionLazyIdentity,
		payload: SessionJsonRootProjection,
		fieldGuard: SessionJsonFieldGuard<T>,
		callerSignal?: AbortSignal,
	): Promise<T> {
		const captured = captureLazyIdentity(identity);
		if (disposed || callerSignal?.aborted || !isCurrentLazyIdentity(captured)) {
			throw lazyAbortError();
		}
		const adapter = activeContentAdapter;
		if (!adapter) {
			throw new SessionTransportError("unavailable", "Session lazy content is disabled");
		}
		const operation = registerLazyOperation(captured, callerSignal);
		try {
			const value = await adapter.materializeJsonRoot(payload.value, fieldGuard, operation.controller.signal);
			if (operation.controller.signal.aborted || !isCurrentLazyIdentity(captured)) {
				throw lazyAbortError();
			}
			return value;
		} catch (error: unknown) {
			if (operation.controller.signal.aborted || !isCurrentLazyIdentity(captured)) {
				throw lazyAbortError();
			}
			if (reportProjectionFailure(captured.sessionHandle, captured.generation, error)) {
				abortLazyIdentity(captured);
			}
			throw error;
		} finally {
			releaseLazyOperation(operation);
		}
	}

	function enqueueProjection(
		identity: SessionRuntimeIdentityDto,
		rawWireBytes: number,
		snapshotWaiter: SnapshotWaiter | null,
		prepare: (signal: AbortSignal) => Promise<() => void>,
	): boolean {
		const isSnapshot = snapshotWaiter !== null;
		const existing = projectionTails.get(identity.sessionHandle);
		if (existing && !identitiesMatch(existing.identity, identity)) {
			discardProjectionTail(identity.sessionHandle, existing);
		}
		let current = projectionTails.get(identity.sessionHandle);
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
			projectionTails.set(identity.sessionHandle, current);
		}
		const replayOverflow =
			!isSnapshot &&
			(current.pendingReplayFrames >= MAX_RESYNC_BUFFERED_FRAMES ||
				current.pendingReplayBytes + rawWireBytes > MAX_RESYNC_BUFFERED_BYTES);
		if ((isSnapshot && current.snapshotPending) || replayOverflow) {
			const failure = new SessionTransportError(
				"payload_too_large",
				"Pending projected Session frame work exceeded its bounded admission",
			);
			const pendingSnapshotWaiter = current.snapshotWaiter;
			discardProjectionTail(identity.sessionHandle, current);
			if (pendingSnapshotWaiter) {
				failSnapshotProjection(identity, failure, pendingSnapshotWaiter);
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
				if (controller.signal.aborted || !isCurrentProjectionIdentity(identity)) return;
				const commit = await prepare(controller.signal);
				if (controller.signal.aborted || !isCurrentProjectionIdentity(identity)) return;
				commit();
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted || !isCurrentProjectionIdentity(identity)) return;
				const pendingSnapshotWaiter = current.snapshotWaiter;
				discardProjectionTail(identity.sessionHandle, current);
				if (pendingSnapshotWaiter) {
					const failure = error instanceof Error ? error : new Error(String(error));
					failSnapshotProjection(identity, failure, pendingSnapshotWaiter);
				} else reportProjectionFailure(identity.sessionHandle, identity.generation, error);
			})
			.finally(() => {
				if (projectionTails.get(identity.sessionHandle) !== current) return;
				if (isSnapshot) {
					current.snapshotPending = false;
					current.snapshotWaiter = null;
				} else {
					current.pendingReplayFrames -= 1;
					current.pendingReplayBytes -= rawWireBytes;
				}
				if (current.promise === promise && current.pendingReplayFrames === 0 && !current.snapshotPending) {
					projectionTails.delete(identity.sessionHandle);
				}
			});
		current.promise = promise;
		return true;
	}

	function discardProjectionTail(sessionHandle: string, entry: ProjectionTail): void {
		if (projectionTails.get(sessionHandle) === entry) {
			projectionTails.delete(sessionHandle);
		}
		entry.pendingReplayFrames = 0;
		entry.pendingReplayBytes = 0;
		entry.snapshotPending = false;
		entry.snapshotWaiter = null;
		entry.controller.abort();
	}

	function abortProjection(sessionHandle: string): void {
		const entry = projectionTails.get(sessionHandle);
		if (!entry) return;
		discardProjectionTail(sessionHandle, entry);
	}

	function abortAllProjections(): void {
		for (const [sessionHandle, entry] of projectionTails) {
			discardProjectionTail(sessionHandle, entry);
		}
	}

	function handleSessionError(
		message: Extract<InlineSessionWsServerMessage, { type: "session_error" }>,
	): void {
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
			abortProjection(message.sessionHandle);
			abortLazyOperationsForSession(message.sessionHandle);
			rejectHistoryForSession(
				message.sessionHandle,
				new SessionTransportError("session_not_subscribed", message.error),
			);
			subscriptionBaselines.delete(message.sessionHandle);
			baselineRefreshes.delete(message.sessionHandle);
			claimAttempts.delete(message.sessionHandle);
			takeoverAttempts.delete(message.sessionHandle);
			pendingLeaseStatuses.delete(message.sessionHandle);
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
			pendingOverflowRestarts.delete(message.sessionHandle);
		} else if (message.operation === "takeover") {
			// Takeover is an explicit one-shot request. A newer lease view may permit a later user action,
			// but transport never turns a retryable error into a queued or automatic retry.
			const attempt = takeoverAttempts.get(message.sessionHandle);
			takeoverAttempts.delete(message.sessionHandle);
			const errorIsStaleAgainstCurrentLease =
				!attempt ||
				!identitiesMatch(current.runtime, attempt.identity) ||
				(typeof current.lease.leaseRevision === "number" &&
					current.lease.leaseRevision > attempt.leaseRevision);
			if (errorIsStaleAgainstCurrentLease) {
				// A loser can receive its CAS error after a newer recipient-local
				// lease_status. Do not erase that newer authoritative baseline.
				frameBus.emit(message.sessionHandle, message, now());
				return;
			}
			// The rejected CAS proves that the local observation is no longer an action-safe
			// lease baseline. Keep the diagnostic global state, but fence any repeat until
			// the Gateway supplies a fresh recipient-local lease_status.
			setChannel(message.sessionHandle, (channel) => ({
				...channel,
				freshLeaseBaseline: null,
				lease: {
					isController: false,
					...(channel.lease.leaseRevision === undefined
						? {}
						: { leaseRevision: channel.lease.leaseRevision }),
					...(channel.lease.controlState === undefined ? {} : { controlState: channel.lease.controlState }),
					...(channel.lease.transition === undefined ? {} : { transition: channel.lease.transition }),
				},
			}));
		}
		frameBus.emit(message.sessionHandle, message, now());
	}

	function handleInlineResponse(message: ResponseMessage): void {
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
		abortHistoryOperation(pending);
		pending.historyBarrierSeq = undefined;
		pending.response = message;
		resolvePendingResponse(pending);
	}

	function resolvePendingResponse(pending: PendingCommand): void {
		const message = pending.response;
		if (!message || pending.historyOperation) return;
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

	function handleRuntimeState(
		message: Extract<InlineSessionWsServerMessage, { type: "runtime_state" }>,
	): void {
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
			abortProjection(sessionHandle);
			abortLazyOperationsForSession(sessionHandle);
			rejectHistoryForSession(
				sessionHandle,
				new SessionTransportError("response_mismatch", "Session generation changed before response"),
			);
			clearSessionResyncData(sessionHandle);
			resyncCoordinator.unsubscribe(sessionHandle);
			acknowledgedExtensionRequests.delete(sessionHandle);
			clearDeliveredNotifyKeys(sessionHandle);
			claimAttempts.delete(sessionHandle);
			takeoverAttempts.delete(sessionHandle);
			pendingLeaseStatuses.delete(sessionHandle);
			pendingOverflowRestarts.delete(sessionHandle);
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

	function handleReplayFrame(message: InlineSessionReplayFrameDto): void;
	function handleReplayFrame(message: ProjectedSessionReplayFrame, representation: "projected"): void;
	function handleReplayFrame(
		...input:
			| [message: InlineSessionReplayFrameDto]
			| [message: ProjectedSessionReplayFrame, representation: "projected"]
	): void {
		const frame: BufferedReplayFrame =
			input.length === 1
				? { message: input[0], representation: "wire" }
				: { message: input[0], representation: "projected" };
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
			} satisfies Extract<InlineSessionWsServerMessage, { type: "resync_required" }>;
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
		return frame.representation === "projected"
			? frameBus.emit(frame.message.sessionHandle, frame.message, receivedAt, "projected")
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
		} satisfies Extract<InlineSessionWsServerMessage, { type: "resync_required" }>;
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
		abortLazyOperationsForSession(sessionHandle);
		const failure = error instanceof Error ? error : new Error(String(error ?? " projection failed"));
		rejectHistoryForSession(sessionHandle, failure);
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

	function failClosedLeaseView(sessionHandle: string, message: LeaseStatusMessage): void {
		claimAttempts.delete(sessionHandle);
		takeoverAttempts.delete(sessionHandle);
		pendingOverflowRestarts.delete(sessionHandle);
		pendingLeaseStatuses.delete(sessionHandle);
		setChannel(sessionHandle, (channel) => ({
			...channel,
			freshLeaseBaseline: null,
			lease: {
				isController: false,
				leaseRevision: message.leaseRevision,
				controlState: message.controlState,
				transition: message.transition,
				conflicted: true,
			},
		}));
	}

	function isExpectedLeaseBaseline(message: LeaseStatusMessage, current: SessionChannelState): boolean {
		const expectedIdentity = subscriptionBaselines.get(message.sessionHandle);
		return (
			message.transition === "baseline" &&
			current.runtime !== null &&
			subscriptionBaselines.has(message.sessionHandle) &&
			(expectedIdentity === null || expectedIdentity === identityKey(current.runtime))
		);
	}

	function consumeSubscriptionBaseline(
		sessionHandle: string,
		runtime: SessionRuntimeIdentityDto | null,
	): void {
		if (runtime === null || !subscriptionBaselines.has(sessionHandle)) return;
		const expectedIdentity = subscriptionBaselines.get(sessionHandle);
		if (expectedIdentity === null || expectedIdentity === identityKey(runtime)) {
			subscriptionBaselines.delete(sessionHandle);
		}
	}

	function deferLeaseUntilBaseline(message: LeaseStatusMessage, expectedBaseline: boolean): void {
		const pending = pendingLeaseStatuses.get(message.sessionHandle);
		if (!pending || message.leaseRevision > pending.message.leaseRevision) {
			pendingLeaseStatuses.set(message.sessionHandle, { message, expectedBaseline });
			return;
		}
		if (
			message.leaseRevision === pending.message.leaseRevision &&
			!leaseStatusMatchesState(message, leaseStateFrom(pending.message))
		) {
			failClosedLeaseView(message.sessionHandle, message);
		}
	}

	function flushDeferredLease(identity: SessionRuntimeIdentityDto): void {
		const pending = pendingLeaseStatuses.get(identity.sessionHandle);
		if (
			!pending ||
			pending.message.serverEpoch !== identity.serverEpoch ||
			pending.message.generation !== identity.generation
		) {
			return;
		}
		pendingLeaseStatuses.delete(identity.sessionHandle);
		handleLease(pending.message, pending.expectedBaseline);
	}

	function handleLease(message: LeaseStatusMessage, expectedBaseline = false): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (
			!current?.subscribed ||
			current.runtime?.serverEpoch !== message.serverEpoch ||
			current.generation !== message.generation
		) {
			return;
		}
		if (!current.baselineAuthoritative) {
			deferLeaseUntilBaseline(message, isExpectedLeaseBaseline(message, current));
			return;
		}
		if (message.isController && releasedControlIntents.has(message.sessionHandle)) {
			// Never synthesize a local observer view or retain a token after an explicit release.
			// The server will serialize the release and send the next authoritative revision.
			sendWire({ type: "session_release", sessionHandle: message.sessionHandle });
			return;
		}
		const knownRevision = current.lease.leaseRevision;
		const controlledBaseline = expectedBaseline || isExpectedLeaseBaseline(message, current);
		let preserveTransitionProvenance = false;
		if (knownRevision !== undefined) {
			if (message.leaseRevision < knownRevision) return;
			if (message.leaseRevision === knownRevision) {
				if (leaseStatusMatchesState(message, current.lease)) {
					if (hasFreshLeaseBaseline(current)) return;
				} else if (controlledBaseline && leaseStatusSemanticsMatchState(message, current.lease)) {
					preserveTransitionProvenance = true;
				} else {
					failClosedLeaseView(message.sessionHandle, message);
					return;
				}
			}
		}
		consumeSubscriptionBaseline(message.sessionHandle, current.runtime);
		if (!message.isController) releasedControlIntents.delete(message.sessionHandle);
		takeoverAttempts.delete(message.sessionHandle);
		setChannel(message.sessionHandle, (channel) => ({
			...channel,
			freshLeaseBaseline: channel.runtime,
			subscriptionAdmission:
				channel.subscriptionAdmission?.kind === "rejected" ? null : channel.subscriptionAdmission,
			lease: preserveTransitionProvenance ? channel.lease : leaseStateFrom(message),
		}));
		frameBus.emit(message.sessionHandle, message, now());
		if (current.runtime) advanceExactHotRecovery(current.runtime, "lease");
		if (message.isController && message.fencingToken) {
			const pendingRestart = pendingOverflowRestarts.get(message.sessionHandle);
			if (
				pendingRestart &&
				identitiesMatch(pendingRestart, current.runtime) &&
				current.runtime?.error === "session_snapshot_overflow"
			) {
				pendingOverflowRestarts.delete(message.sessionHandle);
				claimAttempts.delete(message.sessionHandle);
				sendWire({
					type: "session_restart",
					sessionHandle: message.sessionHandle,
					expectedGeneration: message.generation,
					fencingToken: message.fencingToken,
				});
			}
		} else {
			claimSessionIfReady(message.sessionHandle);
		}
	}

	function handleResyncRequired(
		message: Extract<InlineSessionWsServerMessage, { type: "resync_required" }>,
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
		abortLazyOperationsForSession(message.sessionHandle);
		connectionObservations.set(message.sessionHandle, message.runtime);
		if (activeExactHotRecovery && identitiesMatch(activeExactHotRecovery.identity, message.runtime)) {
			activeExactHotRecovery.recoveryStarted = true;
		}
		const sameIdentity = identitiesMatch(current.runtime, message.runtime);
		if (!sameIdentity && current.runtime) {
			abortProjection(message.sessionHandle);
			rejectHistoryForSession(
				message.sessionHandle,
				new SessionTransportError("response_mismatch", "Session generation changed during resync"),
			);
			clearIdentityBuffers(current.runtime);
			resyncCoordinator.unsubscribe(message.sessionHandle);
			claimAttempts.delete(message.sessionHandle);
			takeoverAttempts.delete(message.sessionHandle);
			pendingLeaseStatuses.delete(message.sessionHandle);
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

	function failSnapshotProjection(
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
		baselineRefreshes.delete(identity.sessionHandle);
		resyncBuffers.delete(key);
		resyncBufferBytes.delete(key);
		clearAcknowledgedExtensionRequests(identity);
		snapshotWaiters.delete(key);
		waiter.resolve({ identity, snapshotId, asOfSeq: endpointSeq });
		flushDeferredLease(identity);
		advanceExactHotRecovery(identity, "baseline");
		resolvePendingResponsesForSession(identity.sessionHandle);
		claimSessionIfReady(identity.sessionHandle);
		return true;
	}

	function handleSessionSnapshot(message: InlineSessionSnapshotDto): void {
		const guardContext = attachmentGuardContext;
		if (guardContext === null || !isInlineSessionSnapshotDto(message, guardContext)) return;
		commitSessionSnapshot(message);
	}

	function commitSessionSnapshot(message: InlineSessionSnapshotDto): void;
	function commitSessionSnapshot(message: ProjectedSessionSnapshot, representation: "projected"): void;
	function commitSessionSnapshot(
		...input:
			| [message: InlineSessionSnapshotDto]
			| [message: ProjectedSessionSnapshot, representation: "projected"]
	): void {
		const snapshotFrame: TransportSessionSnapshotFrame =
			input.length === 1
				? { message: input[0], representation: "wire" }
				: { message: input[0], representation: "projected" };
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
				: snapshotFrame.representation === "projected"
					? {
							representation: "projected",
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
							representation: "wire",
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
		return frame.representation === "projected"
			? frameBus.emit(frame.message.sessionHandle, frame.message, now(), "projected")
			: frameBus.emit(frame.message.sessionHandle, frame.message, now());
	}

	function handleExtensionSnapshot(
		message: Extract<InlineSessionWsServerMessage, { type: "extension_ui_snapshot" }>,
	): void;
	function handleExtensionSnapshot(message: ProjectedExtensionUiSnapshot, representation: "projected"): void;
	function handleExtensionSnapshot(
		...input:
			| [message: Extract<InlineSessionWsServerMessage, { type: "extension_ui_snapshot" }>]
			| [message: ProjectedExtensionUiSnapshot, representation: "projected"]
	): void {
		const frame: TransportExtensionSnapshotFrame =
			input.length === 1
				? { message: input[0], representation: "wire" }
				: { message: input[0], representation: "projected" };
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
			frame.representation === "projected"
				? frameBus.emit(message.sessionHandle, frame.message, now(), "projected")
				: frameBus.emit(message.sessionHandle, frame.message, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(message.sessionHandle, message.generation, delivery.errors[0]);
			return;
		}
	}

	function handleExtensionResult(
		message: Extract<InlineSessionWsServerMessage, { type: "extension_ui_result" }>,
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

	function handleRekey(message: Extract<InlineSessionWsServerMessage, { type: "session_rekeyed" }>): void {
		if (message.serverEpoch !== message.runtime.serverEpoch) return;
		const previousSessionHandle = message.previousSessionHandle;
		const sessionHandle = message.runtime.sessionHandle;
		const state = store.getState();
		const previous = state.sessions[previousSessionHandle];
		if (!previous?.subscribed) return;
		abortProjection(previousSessionHandle);
		abortHistoryForSession(previousSessionHandle);
		abortLazyOperationsForSession(previousSessionHandle);
		rejectHistoryForSession(
			previousSessionHandle,
			new SessionTransportError("response_mismatch", "Session rekeyed before content history completed"),
		);
		abortProjection(sessionHandle);
		abortHistoryForSession(sessionHandle);
		abortLazyOperationsForSession(sessionHandle);
		if (sessionHandle !== previousSessionHandle) {
			rejectHistoryForSession(
				sessionHandle,
				new SessionTransportError("response_mismatch", "Session rekeyed before content history completed"),
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
		takeoverAttempts.delete(previousSessionHandle);
		takeoverAttempts.delete(sessionHandle);
		pendingLeaseStatuses.delete(previousSessionHandle);
		pendingLeaseStatuses.delete(sessionHandle);
		pendingOverflowRestarts.delete(previousSessionHandle);
		pendingOverflowRestarts.delete(sessionHandle);
		if (releasedControlIntents.delete(previousSessionHandle)) {
			releasedControlIntents.add(sessionHandle);
		}
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
		abortHistoryOperation(pending);
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
		abortAllProjections();
		abortAllLazyOperations();
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
		takeoverAttempts.clear();
		releasedControlIntents.clear();
		pendingLeaseStatuses.clear();
		pendingOverflowRestarts.clear();
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
		resolveText,
		resolveJson,
		ingestServerMessage,
		ingestFrameMessage,
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
