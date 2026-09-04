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
	type InlineSessionReplayFrameDto,
	type InlineSessionSnapshotBeginDto,
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
	isSessionCommandResponseDto,
	isSessionWsServerMessage,
	negotiateGatewayHello,
	type PiSessionCommandResponseDto,
	type PiSessionEntryDto,
	type PiSessionMessageDto,
	type PiSessionTreeNodeDto,
	SESSION_WS_CLIENT_MAX_BYTES,
	SESSION_WS_SERVER_MAX_BYTES,
	type SessionAttachmentGuardContext,
	type SessionCommandDto,
	type SessionCommandResponseDto,
	type SessionContentRefGuardContext,
	type SessionEntryDto,
	type SessionHistoryPageBeginDto,
	type SessionHistoryPageEndDto,
	type SessionMessageDto,
	type SessionReplayCursorDto,
	type SessionResponseFrameDto,
	type SessionRuntimeIdentityDto,
	type SessionSnapshotDto,
	type SessionSnapshotEndDto,
	type SessionTreeNodeDto,
	type SessionWsClientMessage,
	sessionWsClientMessageBytes,
} from "@pi-agent-web/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { getSessionBrowserEffects } from "../lib/session-browser-effects";
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
import type { SessionResyncAttemptContext, SessionResyncCompletion } from "../lib/session-resync";
import {
	createSessionCommandMachine,
	type SessionCommandMachineCompletion,
	type SessionCommandMachineError,
	type SessionCommandMachineEvent,
	type SessionCommandMachineIntent,
	type SessionCommandMachinePending,
	type SessionCommandMachineResolvedResponse,
} from "./command-machine";
import {
	createSessionConnectionMachine,
	type SessionConnectionMachineEvent,
	type SessionConnectionMachineIntent,
} from "./connection-machine";
import { createSessionControlMachine, type SessionControlMachineEvent } from "./control-machine";
import {
	createSessionExtensionMachine,
	extensionIdentityMatches,
	type SessionExtensionMachineEvent,
} from "./extension-machine";
import {
	type BufferedReplayFrame,
	type CompletedHistorySnapshot,
	createSessionRecoveryMachine,
	type HistoryOperation,
	type HistoryPageChunk,
	type HistorySnapshotBegin,
	type HistorySnapshotChunk,
	type LazyIdentityScope,
	type LazyOperation,
	type PageHistoryAssembly,
	type ProjectionTail,
	type RecoverySnapshotFrame,
	type SnapshotHistoryAssembly,
	type SnapshotWaiter,
} from "./recovery-machine";
import {
	createSessionRetentionMachine,
	isRetryableSubscriptionError,
	type RetainedRawEvent,
	retentionCandidate,
	subscriptionAdmissionCode,
} from "./retention-machine";
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
	type SessionCommandCompletion,
	type SessionContentAdapterFactory,
	type SessionContentAdapterInstallation,
	type SessionHistoryState,
	type SessionLazyIdentity,
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
	type SessionCommandCompletion,
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

type TransportSessionSnapshotFrame = RecoverySnapshotFrame;

type TransportExtensionSnapshotFrame =
	| {
			message: Extract<InlineSessionWsServerMessage, { type: "extension_ui_snapshot" }>;
			representation: "wire";
	  }
	| { message: ProjectedExtensionUiSnapshot; representation: "projected" };

type ResponseMessage = Extract<InlineSessionWsServerMessage, { type: "response" }>;

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

function validCursor(channel: SessionChannelState): SessionReplayCursorDto | undefined {
	return channel.generation === null || !channel.runtime || !channel.baselineAuthoritative
		? undefined
		: {
				serverEpoch: channel.runtime.serverEpoch,
				generation: channel.generation,
				seq: channel.lastSeq,
			};
}

function identityKey(identity: SessionRuntimeIdentityDto): string {
	return JSON.stringify([
		identity.serverEpoch,
		identity.workspaceId,
		identity.sessionHandle,
		identity.generation,
	]);
}

function serverEpochForServerMessage(message: InlineSessionWsServerMessage): string | null {
	if (message.type === "runtime_state") return message.runtime.serverEpoch;
	return "serverEpoch" in message ? message.serverEpoch : null;
}

const identitiesMatch = extensionIdentityMatches;

type LeaseStatusMessage = Extract<InlineSessionWsServerMessage, { type: "lease_status" }>;

function lazyAbortError(): DOMException {
	return new DOMException("Session lazy content operation was aborted", "AbortError");
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
	const commandMachine = createSessionCommandMachine();
	const commandTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const extensionMachine = createSessionExtensionMachine();
	const retentionMachine = createSessionRetentionMachine({
		maxActiveSubscriptions,
		rawEventLimit,
		rawEventMaxBytes,
		rawEventGlobalLimit,
		rawEventGlobalMaxBytes,
	});

	let socket: SessionWebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let helloTimer: ReturnType<typeof setTimeout> | null = null;
	let historyRequestCounter = 0;
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
	const recoveryMachine = createSessionRecoveryMachine({
		attemptResync: attemptResync,
		resyncClock: options.resyncClock,
		resyncRandom: options.resyncRandom,
	});
	const resyncCoordinator = recoveryMachine.resync;
	const {
		commandMaterializations,
		snapshotWaiters,
		snapshotHistoryAssemblies,
		pageHistoryAssemblies,
		projectionTails,
		lazyIdentityScopes,
		initialInventoryWaiters,
	} = recoveryMachine.effects;
	const connectionMachine = createSessionConnectionMachine({
		clientHello,
		helloTimeoutMs,
		reconnectBaseMs,
		reconnectMaxMs,
	});
	const controlMachine = createSessionControlMachine();

	function browserEffects() {
		return options.browserEffects ?? getSessionBrowserEffects();
	}

	function syncBrowserEffectIdentity(identity: SessionRuntimeIdentityDto): void {
		const effects = browserEffects();
		const current = effects.currentIdentity(identity.sessionHandle);
		if (
			current &&
			current.serverEpoch === identity.serverEpoch &&
			current.workspaceId === identity.workspaceId &&
			identity.generation < current.generation
		) {
			return;
		}
		if (current && !identitiesMatch(current, identity)) effects.invalidateIdentity(current);
		effects.setCurrentIdentity(identity);
	}

	function invalidateBrowserEffectIdentity(
		identity: SessionRuntimeIdentityDto | null,
		sessionHandle?: string,
	): void {
		const effects = browserEffects();
		if (sessionHandle) {
			const current = effects.currentIdentity(sessionHandle);
			if (current && (!identity || identitiesMatch(current, identity))) effects.invalidateIdentity(current);
		}
		if (identity) effects.invalidateIdentity(identity);
	}

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
		sendCommandWithIdentity,
		sendExtensionUiResponse,
		manualRetryResync,
		retrySessionSubscription,
	}));

	function transitionConnection(event: SessionConnectionMachineEvent): void {
		const transition = connectionMachine.transition(event);
		store.setState({ connectionState: transition.state.observableState });
		for (const intent of transition.intents) applyConnectionIntent(intent);
	}

	function transitionControl(event: SessionControlMachineEvent): {
		transition: ReturnType<typeof controlMachine.transition>;
		sent: boolean;
	} {
		const sessionHandle =
			event.type === "rekey"
				? event.previousSessionHandle
				: "sessionHandle" in event
					? event.sessionHandle
					: event.type === "baseline_committed"
						? event.identity.sessionHandle
						: null;
		if (sessionHandle) {
			const channel = store.getState().sessions[sessionHandle];
			const control = controlMachine.getSession(sessionHandle);
			if (event.type === "subscribe" && !channel && control) {
				controlMachine.transition({ type: "remove", sessionHandle });
			} else if (
				channel &&
				(!control ||
					control.subscribed !== channel.subscribed ||
					control.controllerIntent !== channel.controllerIntent ||
					!(
						(control.freshLeaseBaseline === null && channel.freshLeaseBaseline === null) ||
						identitiesMatch(control.freshLeaseBaseline, channel.freshLeaseBaseline)
					) ||
					control.lease.isController !== channel.lease.isController ||
					control.lease.fencingToken !== channel.lease.fencingToken ||
					control.lease.leaseRevision !== channel.lease.leaseRevision ||
					control.lease.controlState !== channel.lease.controlState ||
					control.lease.transition !== channel.lease.transition ||
					control.lease.conflicted !== channel.lease.conflicted)
			) {
				controlMachine.transition({
					type: "hydrate",
					sessionHandle,
					subscribed: channel.subscribed,
					controllerIntent: channel.controllerIntent,
					freshLeaseBaseline: channel.freshLeaseBaseline,
					lease: channel.lease,
				});
			}
		}
		const transition = controlMachine.transition(event);
		for (const sessionHandle of transition.changedSessionHandles) {
			const control = controlMachine.getSession(sessionHandle);
			if (!control) continue;
			setChannel(sessionHandle, (channel) => ({
				...channel,
				subscribed: control.subscribed,
				controllerIntent: control.controllerIntent,
				freshLeaseBaseline: control.freshLeaseBaseline,
				lease: control.lease,
			}));
		}
		let sent = true;
		for (const intent of transition.intents) {
			if (intent.type === "emit_lease_status") {
				frameBus.emit(intent.message.sessionHandle, intent.message, now());
				continue;
			}
			const delivery = sendWire(intent.message);
			if (delivery === "sent") continue;
			sent = false;
			if (intent.onFailure === "claim") {
				transitionControl({ type: "claim_send_failed", sessionHandle: intent.message.sessionHandle });
			} else if (intent.onFailure === "takeover") {
				transitionControl({ type: "takeover_send_failed", sessionHandle: intent.message.sessionHandle });
			}
		}
		return { transition, sent };
	}

	function transitionCommand(
		event: SessionCommandMachineEvent,
	): ReturnType<typeof commandMachine.transition> {
		const transition = commandMachine.transition(event);
		for (const intent of transition.intents) applyCommandIntent(intent);
		return transition;
	}

	function transitionExtension(event: SessionExtensionMachineEvent): void {
		const transition = extensionMachine.transition(event);
		for (const intent of transition.intents) {
			if (intent.type !== "pending_changed") continue;
			setChannel(intent.sessionHandle, (channel) => ({
				...channel,
				pendingExtensionRequests: [...intent.requests],
			}));
		}
	}

	function transitionRecovery(
		event: Parameters<typeof recoveryMachine.transition>[0],
	): ReturnType<typeof recoveryMachine.transition> {
		return recoveryMachine.transition(event);
	}

	function transitionRetention(
		event: Parameters<typeof retentionMachine.transition>[0],
	): ReturnType<typeof retentionMachine.transition> {
		const transition = retentionMachine.transition(event);
		for (const intent of transition.intents) {
			switch (intent.type) {
				case "evict_subscription":
					unsubscribeSession(intent.sessionHandle);
					break;
				case "mark_protected_overage":
					setChannel(intent.sessionHandle, (channel) =>
						channel.subscriptionAdmission
							? channel
							: {
									...channel,
									subscriptionAdmission: { kind: "protected_overage", retryable: false },
								},
					);
					break;
				case "clear_protected_overage":
					for (const sessionHandle of intent.sessionHandles) {
						setChannel(sessionHandle, (channel) =>
							channel.subscriptionAdmission?.kind === "protected_overage"
								? { ...channel, subscriptionAdmission: null }
								: channel,
						);
					}
					break;
				case "admission_changed":
					setChannel(intent.sessionHandle, (channel) => ({
						...channel,
						subscriptionAdmission: intent.admission,
					}));
					break;
				case "raw_events_evicted":
					for (const entry of intent.entries) {
						setChannel(entry.sessionHandle, (channel) => ({
							...channel,
							rawEvents: channel.rawEvents.filter((record) => record !== entry.record),
						}));
					}
					break;
			}
		}
		return transition;
	}

	function applyCommandIntent(intent: SessionCommandMachineIntent): void {
		switch (intent.type) {
			case "start_timer": {
				const previous = commandTimers.get(intent.id);
				if (previous) clearTimeout(previous);
				let timer: ReturnType<typeof setTimeout>;
				timer = setTimeout(() => {
					if (commandTimers.get(intent.id) !== timer) return;
					commandTimers.delete(intent.id);
					transitionCommand({ type: "timeout", id: intent.id, token: intent.token });
				}, intent.delayMs);
				commandTimers.set(intent.id, timer);
				return;
			}
			case "clear_timer": {
				const timer = commandTimers.get(intent.id);
				if (timer) clearTimeout(timer);
				commandTimers.delete(intent.id);
				return;
			}
			case "send": {
				const delivery = sendWire(intent.message);
				if (delivery === "sent") return;
				const error: SessionCommandMachineError = {
					code: delivery,
					message: delivery,
				};
				transitionCommand({ type: "send_failed", id: intent.id, token: intent.token, error });
				return;
			}
			case "start_materialization":
				startResponseMaterialization(intent.message, intent.id, intent.token, intent.history);
				return;
			case "abort_materialization":
				abortCommandMaterialization(intent.id, intent.token);
				return;
			case "resolve":
				intent.resolve(intent.response);
				if (intent.resolveWithIdentity) {
					const runtime = store.getState().sessions[intent.completion.sessionHandle]?.runtime;
					const completion: SessionCommandMachineCompletion =
						runtime &&
						runtime.serverEpoch === intent.completion.serverEpoch &&
						runtime.sessionHandle === intent.completion.sessionHandle &&
						runtime.generation === intent.completion.generation
							? { ...intent.completion, workspaceId: runtime.workspaceId }
							: intent.completion;
					intent.resolveWithIdentity(completion);
				}
				return;
			case "reject":
				intent.reject(
					intent.error.code === "custom"
						? new Error(intent.error.message)
						: new SessionTransportError(intent.error.code, intent.error.message),
				);
				return;
		}
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
		transitionRecovery({ type: "reset_hot_inventory" });
		return true;
	}

	resyncCoordinator.subscribe((sessionHandle, recovery) => {
		setChannel(sessionHandle, (channel) => {
			if (recovery && !identitiesMatch(channel.runtime, recovery.identity)) return channel;
			return channel.recovery === (recovery ?? null) ? channel : { ...channel, recovery: recovery ?? null };
		});
		const activeExact = recoveryMachine.getState().activeExactHotRecovery;
		if (
			recovery?.phase === "degraded" &&
			activeExact &&
			identitiesMatch(activeExact.identity, recovery.identity)
		) {
			transitionRecovery({ type: "set_active_exact_hot", active: null });
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
		transitionExtension({ type: "clear_acknowledged", identity });
	}

	function acknowledgedExtensionRequestIds(identity: SessionRuntimeIdentityDto): Set<string> {
		const session = extensionMachine.getSession(identity.sessionHandle);
		return session && identitiesMatch(session.identity, identity)
			? new Set(session.acknowledgedRequestIds)
			: new Set();
	}

	function requiredProjectionBarrier(identity: SessionRuntimeIdentityDto, minimum: number): number {
		let barrierSeq = minimum;
		for (const pending of Object.values(commandMachine.getState().pending)) {
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
		transitionRecovery({ type: "clear_identity", key });
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
		for (const [key, frames] of recoveryMachine.getState().resyncBuffers) {
			if (frames[0]?.message.sessionHandle === sessionHandle) {
				transitionRecovery({ type: "clear_identity", key });
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
		transitionExtension({ type: "clear_notify_session", sessionHandle });
	}

	function hasDeliveredNotify(
		identity: SessionRuntimeIdentityDto,
		message: Extract<InlineSessionReplayFrameDto, { type: "extension_ui_request" }>,
	): boolean {
		const session = extensionMachine.getSession(identity.sessionHandle);
		return Boolean(
			session &&
				identitiesMatch(session.identity, identity) &&
				session.deliveredNotifyKeys.includes(`${String(message.seq)}:${message.request.id}`),
		);
	}

	function rememberDeliveredNotify(
		identity: SessionRuntimeIdentityDto,
		message: Extract<InlineSessionReplayFrameDto, { type: "extension_ui_request" }>,
	): void {
		transitionExtension({
			type: "replay",
			identity,
			frame: message,
		});
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

		if (!transitionRecovery({ type: "consume_skip_resubscribe", key }).accepted) {
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
		for (const channel of Object.values(store.getState().sessions)) {
			invalidateBrowserEffectIdentity(channel.runtime, channel.sessionHandle);
		}
		for (const runtime of recoveryMachine.getState().hotRuntimeByHandle.values()) {
			invalidateBrowserEffectIdentity(runtime, runtime.sessionHandle);
		}
		clearHelloTimer();
		negotiatedMaxClientFrameBytes = SESSION_WS_CLIENT_MAX_BYTES;
		negotiatedMaxServerFrameBytes = SESSION_WS_SERVER_MAX_BYTES;
		historyNegotiated = false;
		attachmentGuardContext = null;
		transitionRecovery({ type: "reset_connection" });
		transitionControl({ type: "connection_reset" });
		const sessions: Record<string, SessionChannelState> = {};
		for (const [sessionHandle, channel] of Object.entries(store.getState().sessions)) {
			abortHistoryForSession(sessionHandle);
			sessions[sessionHandle] = {
				...channel,
				history: emptyHistoryState(),
			};
		}
		store.setState({ connectionState, hotRuntimeInventory: null, sessions });
	}

	function touchSubscriptionLru(sessionHandle: string): void {
		transitionRetention({ type: "touch_subscription", sessionHandle });
	}

	function markProtectedSubscriptionOverage(sessionHandle: string): void {
		const subscribedCount = Object.values(store.getState().sessions).filter(
			(channel) => channel.subscribed,
		).length;
		transitionRetention({ type: "mark_protected_overage", sessionHandle, subscribedCount });
	}

	function clearProtectedSubscriptionOverage(): void {
		const subscribedCount = Object.values(store.getState().sessions).filter(
			(channel) => channel.subscribed,
		).length;
		transitionRetention({ type: "clear_protected_overage", subscribedCount });
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
		transitionRetention({ type: "set_admission", sessionHandle, admission });
	}

	function evictSubscriptionLruIfNeeded(incomingSessionHandle: string): boolean {
		const state = store.getState();
		const subscribedCount = Object.values(state.sessions).filter((session) => session.subscribed).length;
		const candidates = Object.values(state.sessions).map((channel) =>
			retentionCandidate(
				channel.sessionHandle,
				channel.runtime,
				channel.pendingExtensionRequests.length > 0,
				recoveryMachine.getState().hotRuntimeByHandle.has(channel.sessionHandle),
				channel.subscribed,
			),
		);
		const transition = transitionRetention({
			type: "admit_subscription",
			sessionHandle: incomingSessionHandle,
			subscribedCount,
			candidates,
		});
		return transition.intents.some((intent) => intent.type === "mark_protected_overage");
	}

	function subscribeSession(sessionHandle: string): void {
		if (!sessionHandle) return;
		if (store.getState().sessions[sessionHandle]?.subscribed) {
			touchSubscriptionLru(sessionHandle);
			return;
		}
		const protectedOverage = evictSubscriptionLruIfNeeded(sessionHandle);
		touchSubscriptionLru(sessionHandle);
		transitionControl({ type: "subscribe", sessionHandle });
		const channel = setChannel(sessionHandle, (current) =>
			current.subscribed ? current : { ...current, subscriptionAdmission: null },
		);
		transitionRetention({ type: "clear_admission", sessionHandle });
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
		transitionRetention({ type: "clear_admission", sessionHandle });
		if (!channel.subscribed) {
			subscribeSession(sessionHandle);
			return Boolean(store.getState().sessions[sessionHandle]?.subscribed);
		}
		transitionRecovery({ type: "clear_connection_observation", sessionHandle });
		const desiredHotRuntime = recoveryMachine.getState().hotRuntimeByHandle.get(sessionHandle);
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
		invalidateBrowserEffectIdentity(channel?.runtime ?? null, sessionHandle);
		if (!channel?.subscribed) {
			transitionRetention({ type: "remove_subscription", sessionHandle });
			clearProtectedSubscriptionOverage();
			return;
		}
		cancelSessionHistory(sessionHandle);
		abortHistoryForSession(sessionHandle);
		abortProjection(sessionHandle);
		abortLazyOperationsForSession(sessionHandle);
		rejectHistoryForSession(sessionHandle, new SessionTransportError("session_not_subscribed"));
		transitionRetention({ type: "remove_subscription", sessionHandle });
		setChannel(sessionHandle, (current) => ({
			...current,
			history: emptyHistoryState(),
			subscriptionAdmission: null,
		}));
		transitionControl({ type: "unsubscribe", sessionHandle });
		transitionRecovery({ type: "clear_session", sessionHandle });
		clearDeliveredNotifyKeys(sessionHandle);
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
		invalidateBrowserEffectIdentity(channel?.runtime ?? null, sessionHandle);
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
		transitionExtension({ type: "reset", sessionHandle });
		clearDeliveredNotifyKeys(sessionHandle);
		transitionControl({ type: "remove", sessionHandle });
		transitionRecovery({ type: "clear_session", sessionHandle });
		discardRawEvents(sessionHandle, false);
		transitionRetention({ type: "remove_subscription", sessionHandle });
		if (channel) setChannel(sessionHandle, () => emptyChannel(sessionHandle));
		return true;
	}

	function claimSession(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		const control = controlMachine.getSession(sessionHandle);
		if (!channel?.subscribed || control?.takeoverAttempt) return false;
		if (!transitionControl({ type: "claim_intent", sessionHandle }).transition.accepted) return false;
		claimSessionIfReady(sessionHandle);
		return true;
	}

	function claimSessionIfReady(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		const transition = transitionControl({
			type: "claim_if_ready",
			sessionHandle,
			online: store.getState().connectionState === "online",
			baselineAuthoritative: channel?.baselineAuthoritative === true,
			currentIdentity: channel?.runtime ?? null,
		});
		return transition.transition.accepted && controlMachine.getSession(sessionHandle)?.claimPending === true;
	}

	function releaseSession(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.subscribed) return false;
		transitionRecovery({ type: "clear_pending_overflow_restart", sessionHandle });
		const online = store.getState().connectionState === "online";
		const transition = transitionControl({ type: "release", sessionHandle, online });
		return online && transition.sent;
	}

	function takeoverSession(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		const transition = transitionControl({
			type: "takeover",
			sessionHandle,
			online: store.getState().connectionState === "online",
			baselineAuthoritative: channel?.baselineAuthoritative === true,
			currentIdentity: channel?.runtime ?? null,
			runtime: channel?.runtime ?? null,
			resync: channel?.resync !== null,
		});
		return transition.transition.accepted && transition.sent;
	}

	function manualRetryResync(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		const recovery = resyncCoordinator.getState(sessionHandle);
		if (
			channel?.runtime?.error === "session_snapshot_overflow" &&
			channel.generation !== null &&
			recovery?.phase === "degraded"
		) {
			transitionControl({ type: "claim_intent", sessionHandle });
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
			transitionRecovery({
				type: "set_pending_overflow_restart",
				sessionHandle,
				identity: channel.runtime,
			});
			if (!channel.baselineAuthoritative || !hasFreshLeaseBaseline(channel) || channel.resync !== null) {
				if (resyncCoordinator.manualRetry(sessionHandle)) return true;
				transitionRecovery({ type: "clear_pending_overflow_restart", sessionHandle });
				transitionControl({ type: "clear_intent", sessionHandle });
				return false;
			}
			if (!claimSessionIfReady(sessionHandle)) {
				transitionRecovery({ type: "clear_pending_overflow_restart", sessionHandle });
				return false;
			}
			return true;
		}
		return resyncCoordinator.manualRetry(sessionHandle);
	}

	function sendCommandWithIdentity(
		sessionHandle: string,
		command: SessionCommandDto,
		timeoutMs = commandTimeoutMs(command.type),
	): Promise<SessionCommandCompletion> {
		const channel = store.getState().sessions[sessionHandle];
		return new Promise<SessionCommandCompletion>((resolve, reject) => {
			const transition = transitionCommand({
				type: "request",
				sessionHandle,
				command,
				timeoutMs,
				now: now(),
				subscribed: channel?.subscribed === true,
				online: store.getState().connectionState === "online",
				socketReady: socket?.readyState === SOCKET_OPEN,
				generation: channel?.generation ?? null,
				currentIdentity: channel?.runtime ?? null,
				baselineAuthoritative: channel?.baselineAuthoritative === true,
				freshLeaseBaseline: channel?.freshLeaseBaseline ?? null,
				isController: channel?.lease.isController === true,
				fencingToken: channel?.lease.fencingToken,
				resolve: () => {},
				resolveWithIdentity: (completion: SessionCommandMachineCompletion) =>
					resolve({
						identity: {
							serverEpoch: completion.serverEpoch,
							workspaceId: completion.workspaceId,
							sessionHandle: completion.sessionHandle,
							generation: completion.generation,
						},
						barrierSeq: completion.barrierSeq,
						response: completion.response,
						...(completion.previousSessionHandle
							? { previousSessionHandle: completion.previousSessionHandle }
							: {}),
					}),
				reject,
			});
			if (!transition.accepted) {
				const error = transition.error ?? { code: "unavailable", message: "unavailable" };
				reject(
					error.code === "custom"
						? new Error(error.message)
						: new SessionTransportError(error.code, error.message),
				);
			}
		});
	}

	function sendCommand(
		sessionHandle: string,
		command: SessionCommandDto,
		timeoutMs = commandTimeoutMs(command.type),
	): Promise<PiSessionCommandResponseDto> {
		return sendCommandWithIdentity(sessionHandle, command, timeoutMs).then(
			(completion) => completion.response,
		);
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
		transitionControl({
			type: "subscription_started",
			sessionHandle,
			expectedIdentity: runtime ? identityKey(runtime) : null,
		});
		const delivered = sendWire({
			type: "session_subscribe",
			sessionHandle,
			...(cursor ? { cursor } : {}),
			...(expectedHotRuntime ? { expectedHotRuntime } : {}),
		});
		if (delivered === "sent") {
			const observation = expectedHotRuntime ?? runtime;
			if (observation)
				transitionRecovery({ type: "set_connection_observation", sessionHandle, identity: observation });
		} else {
			transitionControl({ type: "subscription_send_failed", sessionHandle });
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
		const observation = recoveryMachine.getState().connectionObservations.get(runtime.sessionHandle);
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
			transitionControl({ type: "subscribe", sessionHandle: runtime.sessionHandle });
			transitionRetention({ type: "clear_admission", sessionHandle: runtime.sessionHandle });
		}
		markProtectedSubscriptionOverage(runtime.sessionHandle);
		if (
			hasAuthoritativeHotBaseline(runtime) ||
			hasConnectionObservation(runtime) ||
			isManualOnlyDegraded(runtime)
		) {
			return;
		}
		const active = recoveryMachine.getState().activeExactHotRecovery;
		if (active?.identity.sessionHandle === runtime.sessionHandle) return;
		if (!transitionRecovery({ type: "queue_exact_hot", sessionHandle: runtime.sessionHandle }).accepted) {
			return;
		}
		pumpExactHotRecovery();
	}

	function pumpExactHotRecovery(): void {
		if (recoveryMachine.getState().activeExactHotRecovery || store.getState().connectionState !== "online")
			return;
		for (;;) {
			const sessionHandle = recoveryMachine.getState().exactHotRecoveryQueue[0];
			if (!sessionHandle) return;
			transitionRecovery({ type: "dequeue_exact_hot", sessionHandle });
			const desired = recoveryMachine.getState().hotRuntimeByHandle.get(sessionHandle);
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
			transitionRecovery({
				type: "set_active_exact_hot",
				active: {
					identity,
					baselineReady: channel.baselineAuthoritative && identitiesMatch(channel.runtime, identity),
					leaseReady: false,
					recoveryStarted: false,
				},
			});
			const cursor = validCursor(channel);
			if (sendSubscriptionForRuntime(sessionHandle, cursor, identity)) return;
			transitionRecovery({ type: "set_active_exact_hot", active: null });
		}
	}

	function cancelExactHotRecovery(sessionHandle: string): void {
		transitionRecovery({ type: "cancel_exact_hot", sessionHandle });
		pumpExactHotRecovery();
	}

	function advanceExactHotRecovery(identity: SessionRuntimeIdentityDto, kind: "baseline" | "lease"): void {
		const transition = transitionRecovery({ type: "advance_exact_hot", identity, kind });
		if (!transition.intents.some((intent) => intent.type === "exact_hot_advanced")) return;
		const desired = recoveryMachine.getState().hotRuntimeByHandle.get(identity.sessionHandle);
		if (desired && !identitiesMatch(desired, identity)) queueHotRuntimeRecovery(desired);
		pumpExactHotRecovery();
	}

	function settleExactHotRecoveryError(sessionHandle: string): boolean {
		const active = recoveryMachine.getState().activeExactHotRecovery;
		if (!active || active.identity.sessionHandle !== sessionHandle) return false;
		transitionRecovery({ type: "set_active_exact_hot", active: null });
		const observation = recoveryMachine.getState().connectionObservations.get(sessionHandle);
		if (observation && identitiesMatch(observation, active.identity)) {
			transitionRecovery({ type: "clear_connection_observation", sessionHandle });
		}
		const desired = recoveryMachine.getState().hotRuntimeByHandle.get(sessionHandle);
		const superseded = Boolean(desired && !identitiesMatch(desired, active.identity));
		if (desired && superseded) queueHotRuntimeRecovery(desired);
		pumpExactHotRecovery();
		return true;
	}

	function handleHotRuntimeInventory(message: HotRuntimeInventoryDto, initial = false): void {
		const negotiatedServerEpoch = connectionMachine.getState().serverEpoch;
		if (negotiatedServerEpoch !== null && message.serverEpoch !== negotiatedServerEpoch) return;
		const inventoryTransition = transitionRecovery({
			type: "set_hot_inventory",
			revision: message.revision,
			runtimes: message.runtimes,
		});
		if (!inventoryTransition.accepted) return;
		const previous =
			inventoryTransition.intents.find((intent) => intent.type === "hot_inventory_accepted")?.previous ??
			new Map<string, HotRuntimeInventoryEntryDto>();
		const next = recoveryMachine.getState().hotRuntimeByHandle;
		store.setState({ hotRuntimeInventory: message });
		globalBus.emit(message);

		for (const [sessionHandle] of previous) {
			if (next.has(sessionHandle)) continue;
			invalidateBrowserEffectIdentity(previous.get(sessionHandle) ?? null, sessionHandle);
			transitionRecovery({ type: "clear_connection_observation", sessionHandle });
			cancelExactHotRecovery(sessionHandle);
			unsubscribeSession(sessionHandle);
		}
		if (initial) {
			resyncCoordinator.reconnect();
		}
		for (const runtime of message.runtimes) {
			syncBrowserEffectIdentity(runtime);
			queueHotRuntimeRecovery(runtime);
		}

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
		if (disposed) return;
		// Direct adapters may be used before hello in deterministic tests; once hello
		// establishes an epoch, every epoch-bearing message must match it.
		const negotiatedServerEpoch = connectionMachine.getState().serverEpoch;
		const messageServerEpoch = serverEpochForServerMessage(message);
		if (
			negotiatedServerEpoch !== null &&
			messageServerEpoch !== null &&
			messageServerEpoch !== negotiatedServerEpoch
		) {
			return;
		}
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

	function createResponseMaterialization(
		pending: SessionCommandMachinePending,
		history: boolean,
	): HistoryOperation {
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
			history,
			started: false,
		};
	}

	function currentHistoryPending(operation: HistoryOperation): SessionCommandMachinePending | null {
		const pending = commandMachine.getPending(operation.id);
		if (
			!pending ||
			pending.token !== operation.token ||
			!operation.history ||
			commandMaterializations.get(operation.id) !== operation ||
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

	function abortCommandMaterialization(id: string, token: number): void {
		const operation = commandMaterializations.get(id);
		if (!operation || operation.token !== token) return;
		commandMaterializations.delete(id);
		operation.controller.abort();
	}

	function rejectHistoryForSession(sessionHandle: string, error: Error): void {
		for (const pending of Object.values(commandMachine.getState().pending)) {
			const operation = commandMaterializations.get(pending.id);
			if (
				isHistoryCommand(pending.commandType) &&
				(pending.sessionHandle === sessionHandle || operation?.identity.sessionHandle === sessionHandle)
			) {
				rejectPending(pending.id, error);
			}
		}
	}

	function abortAllHistoryOperations(): void {
		for (const [id, operation] of commandMaterializations) {
			if (!operation.history) continue;
			commandMaterializations.delete(id);
			operation.controller.abort();
		}
	}

	function handleInvalidResponse(value: unknown): boolean {
		const candidate = responseEnvelopeCandidate(value);
		if (!candidate) return false;
		const pending = commandMachine.getPending(candidate.id);
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
		const operation = commandMaterializations.get(pending.id);
		if (operation && currentHistoryPending(operation) === pending) {
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

	function startResponseMaterialization(
		message: SessionResponseFrameDto,
		id: string,
		token: number,
		history: boolean,
	): void {
		const pending = commandMachine.getPending(id);
		if (!pending || pending.token !== token) return;
		let operation = commandMaterializations.get(id);
		if (operation?.token !== token) {
			operation = createResponseMaterialization(pending, history);
			commandMaterializations.set(id, operation);
		}
		if (operation.started) return;
		operation.started = true;
		const adapter = activeContentAdapter;
		if (!adapter) {
			rejectPending(
				id,
				new SessionTransportError(
					"unavailable",
					history ? " history materialization is disabled" : " response materialization is disabled",
				),
			);
			return;
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
				const current = commandMachine.getPending(id);
				if (
					operation.controller.signal.aborted ||
					!current ||
					current.token !== token ||
					(history && currentHistoryPending(operation) !== current)
				) {
					return;
				}
				commandMaterializations.delete(id);
				const materialized = {
					...message,
					response,
				} as unknown as SessionCommandMachineResolvedResponse;
				transitionCommand({ type: "response_materialized", id, token, response: materialized });
				resolvePendingResponsesForSession(message.sessionHandle);
			})
			.catch((error: unknown) => {
				const current = commandMachine.getPending(id);
				if (
					operation.controller.signal.aborted ||
					!current ||
					current.token !== token ||
					(history && currentHistoryPending(operation) !== current)
				) {
					return;
				}
				const failure = error instanceof Error ? error : new Error(String(error));
				commandMaterializations.delete(id);
				if (history) reportProjectionFailure(current.sessionHandle, current.generation, failure);
				rejectPending(id, failure);
			});
	}

	function handleResponse(message: SessionResponseFrameDto): boolean {
		const id = message.response.id;
		if (!id) return true;
		const pending = commandMachine.getPending(id);
		if (!pending) return true;
		transitionCommand({ type: "wire_response", message, history: isHistoryCommand(pending.commandType) });
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
		syncBrowserEffectIdentity(message);
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
		const activeExact = recoveryMachine.getState().activeExactHotRecovery;
		const exactErrorMatches =
			message.operation === "subscribe" &&
			activeExact?.identity.sessionHandle === message.sessionHandle &&
			activeExact.identity.serverEpoch === message.serverEpoch &&
			!activeExact.recoveryStarted;
		if (exactErrorMatches) {
			recordSubscriptionRejection(message.sessionHandle, message.error, message.code, message.retryable);
			settleExactHotRecoveryError(message.sessionHandle);
			frameBus.emit(message.sessionHandle, message, now());
			invalidateBrowserEffectIdentity(
				store.getState().sessions[message.sessionHandle]?.runtime ?? null,
				message.sessionHandle,
			);
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
		let invalidateIdentityAfterDelivery = false;
		if (message.operation === "subscribe") {
			recordSubscriptionRejection(message.sessionHandle, message.error, message.code, message.retryable);
			abortProjection(message.sessionHandle);
			abortLazyOperationsForSession(message.sessionHandle);
			rejectHistoryForSession(
				message.sessionHandle,
				new SessionTransportError("session_not_subscribed", message.error),
			);
			transitionRecovery({ type: "clear_baseline_refresh", sessionHandle: message.sessionHandle });
			const preserveSubscribed = current.resync !== null && current.runtime !== null;
			invalidateIdentityAfterDelivery = !preserveSubscribed;
			transitionControl({
				type: "subscribe_error",
				sessionHandle: message.sessionHandle,
				preserveSubscribed,
				preserveLease: preserveSubscribed,
			});
			if (current.resync && current.runtime) {
				failSnapshot(current.runtime, new SessionTransportError("unavailable", message.error));
				frameBus.emit(message.sessionHandle, message, now());
				return;
			}
			transitionRetention({
				type: "remove_subscription",
				sessionHandle: message.sessionHandle,
				preserveAdmission: true,
			});
			transitionRecovery({ type: "clear_connection_observation", sessionHandle: message.sessionHandle });
			rejectPendingForSession(
				message.sessionHandle,
				new SessionTransportError("session_not_subscribed", message.error),
			);
			setChannel(message.sessionHandle, (channel) => ({
				...channel,
			}));
			clearProtectedSubscriptionOverage();
			if (current.lease.isController || current.lease.fencingToken) {
				sendWire({ type: "session_release", sessionHandle: message.sessionHandle });
			}
		} else if (message.operation === "claim") {
			transitionControl({ type: "claim_error", sessionHandle: message.sessionHandle });
			transitionRecovery({ type: "clear_pending_overflow_restart", sessionHandle: message.sessionHandle });
		} else if (message.operation === "takeover") {
			// Takeover is an explicit one-shot request. A newer lease view may permit a later user action,
			// but transport never turns a retryable error into a queued or automatic retry.
			transitionControl({
				type: "takeover_error",
				sessionHandle: message.sessionHandle,
				currentIdentity: current.runtime,
				currentLeaseRevision: current.lease.leaseRevision,
			});
		}
		frameBus.emit(message.sessionHandle, message, now());
		if (invalidateIdentityAfterDelivery) {
			invalidateBrowserEffectIdentity(current.runtime, message.sessionHandle);
		}
	}

	function handleInlineResponse(message: ResponseMessage): void {
		const id = message.response.id;
		if (!id) return;
		const pending = commandMachine.getPending(id);
		if (!pending) return;
		transitionCommand({ type: "inline_response", message });
		resolvePendingResponsesForSession(message.sessionHandle);
	}

	function resolvePendingResponsesForSession(sessionHandle: string): void {
		const channel = store.getState().sessions[sessionHandle];
		transitionCommand({
			type: "projection_advanced",
			sessionHandle,
			currentIdentity: channel?.runtime ?? null,
			baselineAuthoritative: channel?.baselineAuthoritative === true,
			projectedSeq: channel?.projectedSeq ?? 0,
		});
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
		const recoveryBeforeIdentityChange = identityChanged ? recoveryMachine.getState() : null;
		const activeExactBeforeIdentityChange =
			recoveryBeforeIdentityChange?.activeExactHotRecovery?.identity.sessionHandle === sessionHandle
				? recoveryBeforeIdentityChange.activeExactHotRecovery
				: null;
		const queuedExactBeforeIdentityChange = Boolean(
			recoveryBeforeIdentityChange?.queuedExactHotRecoveries.has(sessionHandle),
		);
		if (identityChanged) {
			invalidateBrowserEffectIdentity(current.runtime, sessionHandle);
			transitionControl({ type: "runtime_reset", sessionHandle });
			abortHistoryForSession(sessionHandle);
			abortProjection(sessionHandle);
			abortLazyOperationsForSession(sessionHandle);
			rejectHistoryForSession(
				sessionHandle,
				new SessionTransportError("response_mismatch", "Session generation changed before response"),
			);
			clearSessionResyncData(sessionHandle);
			resyncCoordinator.unsubscribe(sessionHandle);
			if (current.runtime) clearAcknowledgedExtensionRequests(current.runtime);
			clearDeliveredNotifyKeys(sessionHandle);
			transitionRecovery({ type: "clear_session", sessionHandle });
			transitionExtension({ type: "replace_snapshot", identity: message.runtime, requests: [] });
			discardRawEvents(sessionHandle, false);
			rejectPendingForSession(
				sessionHandle,
				new SessionTransportError("response_mismatch", "Session generation changed before response"),
			);
		}
		syncBrowserEffectIdentity(message.runtime);
		setChannel(sessionHandle, (channel) => ({
			...channel,
			runtime: message.runtime,
			generation: message.runtime.generation,
			baselineAuthoritative: identityChanged ? false : channel.baselineAuthoritative,
			lastSeq: identityChanged ? 0 : channel.lastSeq,
			projectedSeq: identityChanged ? 0 : channel.projectedSeq,
			pendingExtensionRequests: identityChanged ? [] : channel.pendingExtensionRequests,
			resync: identityChanged ? null : channel.resync,
			recovery: identityChanged ? null : channel.recovery,
			history: identityChanged ? emptyHistoryState() : channel.history,
			rawEvents: identityChanged ? [] : channel.rawEvents,
		}));
		transitionRecovery({ type: "set_connection_observation", sessionHandle, identity: message.runtime });
		if (identityChanged) {
			if (activeExactBeforeIdentityChange) {
				transitionRecovery({
					type: "set_active_exact_hot",
					active: {
						...activeExactBeforeIdentityChange,
						identity: message.runtime,
						baselineReady: false,
						leaseReady: false,
						recoveryStarted: false,
					},
				});
			} else if (queuedExactBeforeIdentityChange) {
				transitionRecovery({ type: "queue_exact_hot", sessionHandle });
			}
			pumpExactHotRecovery();
		}
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
		const transition = transitionRetention({ type: "retain_raw", entry: retained });
		if (!transition.accepted) return;
		const evictedRecords = new Map<string, Set<SessionChannelState["rawEvents"][number]>>();
		for (const entry of transition.intents.flatMap((intent) =>
			intent.type === "raw_events_evicted" ? intent.entries : [],
		)) {
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
		transitionRetention({ type: "discard_raw", sessionHandle });
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
		if (
			(message.type === "extension_ui_request" || message.type === "extension_ui_closed") &&
			!(message.type === "extension_ui_request" && ignoredExtensionRequestIds?.has(message.request.id))
		) {
			transitionExtension({
				type: "replay",
				identity: message,
				frame: message,
			});
		}
		setChannel(message.sessionHandle, (channel) => ({
			...channel,
			lastSeq: message.seq,
			projectedSeq:
				projected && channel.projectedSeq + 1 === message.seq ? message.seq : channel.projectedSeq,
		}));
	}

	function bufferReplayFrame(frame: BufferedReplayFrame): "buffered" | "duplicate" | "overflow" {
		const { message } = frame;
		const key = identityKey(message);
		const transition = transitionRecovery({
			type: "buffer_replay",
			key,
			frame,
			maxFrames: MAX_RESYNC_BUFFERED_FRAMES,
			maxBytes: MAX_RESYNC_BUFFERED_BYTES,
		});
		if (transition.result !== "buffered") {
			if (transition.result === "overflow") forceReplayResync(message);
			return transition.result ?? "duplicate";
		}
		const buffer = recoveryMachine.getState().resyncBuffers.get(key) ?? [];
		if (message.type === "extension_ui_request" || message.type === "extension_ui_closed") {
			transitionExtension({ type: "replay", identity: message, frame: message, notifyDelivered: false });
		}
		setChannel(message.sessionHandle, (channel) => ({
			...channel,
			lastSeq: Math.max(channel.lastSeq, message.seq),
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
		clearAcknowledgedExtensionRequests(runtime);
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
		clearAcknowledgedExtensionRequests(channel.runtime);
		transitionRecovery({ type: "clear_baseline_refresh", sessionHandle });
		transitionExtension({ type: "replace_snapshot", identity: channel.runtime, requests: [] });
		transitionControl({ type: "projection_failed", sessionHandle });
		discardRawEvents(sessionHandle);
		setChannel(sessionHandle, (current) => ({
			...current,
			baselineAuthoritative: false,
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

	function handleLease(message: LeaseStatusMessage, expectedBaseline = false): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (
			!current?.subscribed ||
			current.runtime?.serverEpoch !== message.serverEpoch ||
			current.generation !== message.generation
		) {
			return;
		}
		const transition = transitionControl({
			type: "lease_status",
			sessionHandle: message.sessionHandle,
			message,
			currentIdentity: current.runtime,
			baselineAuthoritative: current.baselineAuthoritative,
			expectedBaseline,
		});
		if (transition.transition.leaseConflict) {
			transitionRecovery({ type: "clear_pending_overflow_restart", sessionHandle: message.sessionHandle });
		}
		if (!transition.transition.leaseAccepted) return;
		if (current.subscriptionAdmission?.kind === "rejected") {
			transitionRetention({ type: "clear_admission", sessionHandle: message.sessionHandle });
		}
		if (current.runtime) advanceExactHotRecovery(current.runtime, "lease");
		if (message.isController && message.fencingToken) {
			const pendingRestart = recoveryMachine.getState().pendingOverflowRestarts.get(message.sessionHandle);
			if (
				pendingRestart &&
				identitiesMatch(pendingRestart, current.runtime) &&
				current.runtime?.error === "session_snapshot_overflow"
			) {
				transitionControl({ type: "claim_settled", sessionHandle: message.sessionHandle });
				transitionRecovery({ type: "clear_pending_overflow_restart", sessionHandle: message.sessionHandle });
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
		if (!identitiesMatch(current.runtime, message.runtime)) {
			invalidateBrowserEffectIdentity(current.runtime, message.sessionHandle);
		}
		syncBrowserEffectIdentity(message.runtime);
		abortHistoryForSession(message.sessionHandle);
		abortLazyOperationsForSession(message.sessionHandle);
		transitionRecovery({
			type: "set_connection_observation",
			sessionHandle: message.sessionHandle,
			identity: message.runtime,
		});
		const activeExactHotRecovery = recoveryMachine.getState().activeExactHotRecovery;
		if (activeExactHotRecovery && identitiesMatch(activeExactHotRecovery.identity, message.runtime)) {
			transitionRecovery({
				type: "set_active_exact_hot",
				active: { ...activeExactHotRecovery, recoveryStarted: true },
			});
		}
		const sameIdentity = identitiesMatch(current.runtime, message.runtime);
		transitionControl({
			type: "resync_reset",
			sessionHandle: message.sessionHandle,
			identityChanged: !sameIdentity,
		});
		if (!sameIdentity && current.runtime) {
			abortProjection(message.sessionHandle);
			rejectHistoryForSession(
				message.sessionHandle,
				new SessionTransportError("response_mismatch", "Session generation changed during resync"),
			);
			clearIdentityBuffers(current.runtime);
			resyncCoordinator.unsubscribe(message.sessionHandle);
			transitionRecovery({ type: "clear_baseline_refresh", sessionHandle: message.sessionHandle });
			discardRawEvents(message.sessionHandle, false);
		}
		const key = identityKey(message.runtime);
		const retained = (recoveryMachine.getState().resyncBuffers.get(key) ?? []).filter(
			(frame) =>
				identitiesMatch(frame.message, message.runtime) && frame.message.seq > message.runtime.lastSeq,
		);
		retained.sort((left, right) => left.message.seq - right.message.seq);
		transitionRecovery({ type: "replace_replay_buffer", key, frames: retained });
		transitionExtension({ type: "replace_snapshot", identity: message.runtime, requests: [] });
		if (!sameIdentity) {
			if (current.runtime) clearAcknowledgedExtensionRequests(current.runtime);
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
			lastSeq: Math.max(message.runtime.lastSeq, retainedLastSeq),
			projectedSeq: sameIdentity ? channel.projectedSeq : 0,
			pendingExtensionRequests: [],
			history: emptyHistoryState(),
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
			if (serverInitiated) transitionRecovery({ type: "skip_resubscribe", key });
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
		transitionRecovery({ type: "clear_identity", key });
		clearAcknowledgedExtensionRequests(identity);
		transitionRecovery({ type: "clear_baseline_refresh", sessionHandle: identity.sessionHandle });
		transitionControl({ type: "projection_failed", sessionHandle: identity.sessionHandle });
		discardRawEvents(identity.sessionHandle);
		setChannel(identity.sessionHandle, (current) => ({
			...current,
			baselineAuthoritative: false,
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
		if (channel.subscriptionAdmission?.kind === "rejected") {
			transitionRetention({ type: "clear_admission", sessionHandle: identity.sessionHandle });
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
		transitionRecovery({ type: "clear_baseline_refresh", sessionHandle: identity.sessionHandle });
		transitionRecovery({ type: "clear_identity", key });
		clearAcknowledgedExtensionRequests(identity);
		snapshotWaiters.delete(key);
		waiter.resolve({ identity, snapshotId, asOfSeq: endpointSeq });
		const baselineCommit = transitionControl({ type: "baseline_committed", identity });
		advanceExactHotRecovery(identity, "baseline");
		if (baselineCommit.transition.leaseAccepted) advanceExactHotRecovery(identity, "lease");
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
		syncBrowserEffectIdentity(message);
		const key = identityKey(message);
		const waiter = snapshotWaiters.get(key);
		if (!waiter) return;
		const buffered = (recoveryMachine.getState().resyncBuffers.get(key) ?? [])
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
		transitionExtension({
			type: "replace_snapshot",
			identity: message.runtime,
			requests: [
				...snapshotForProjection.message.pendingExtensionRequests,
				...snapshotForProjection.message.stickyExtensionState,
			],
		});
		setChannel(message.sessionHandle, (current) => ({
			...current,
			runtime: message.runtime,
			generation: message.generation,
			baselineAuthoritative: false,
			lastSeq: message.asOfSeq,
			projectedSeq: message.asOfSeq,
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
		transitionRecovery({ type: "clear_identity", key });
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
		if (current.runtime) {
			transitionExtension({
				type: "replace_extension_snapshot",
				identity: current.runtime,
				requests: message.requests,
			});
		}
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
		if (current.runtime) {
			transitionExtension({
				type: "result",
				identity: current.runtime,
				requestId: message.requestId,
				resyncing: current.resync !== null,
			});
		}
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
		invalidateBrowserEffectIdentity(previous.runtime, previousSessionHandle);
		syncBrowserEffectIdentity(message.runtime);
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
		const exactRekeyInFlight =
			recoveryMachine.getState().activeExactHotRecovery?.identity.sessionHandle === previousSessionHandle;
		if (!exactRekeyInFlight) {
			const previousObservation = recoveryMachine
				.getState()
				.connectionObservations.get(previousSessionHandle);
			transitionRecovery({ type: "clear_connection_observation", sessionHandle: previousSessionHandle });
			if (previousObservation) {
				transitionRecovery({
					type: "set_connection_observation",
					sessionHandle,
					identity: message.runtime,
				});
			}
		}
		transitionRecovery({ type: "dequeue_exact_hot", sessionHandle: previousSessionHandle });
		const previousControl = controlMachine.getSession(previousSessionHandle);
		const previousBaseline = previousControl?.subscriptionBaseline;
		const baselineInFlight =
			previousBaseline !== undefined &&
			(previousBaseline === null ||
				(previous.runtime !== null && previousBaseline === identityKey(previous.runtime)));
		transitionControl({
			type: "rekey",
			previousSessionHandle,
			sessionHandle,
			identity: message.runtime,
			baselineInFlight,
		});
		const dormantControl = controlMachine.getSession(previousSessionHandle);
		const migratedControl = controlMachine.getSession(sessionHandle);
		const dormantLastSeq = previous.resync?.barrierSeq ?? previous.projectedSeq;
		const dormantRuntime = previous.runtime
			? { ...previous.runtime, lastSeq: dormantLastSeq, state: "dormant" as const }
			: null;
		const dormant: SessionChannelState = {
			...previous,
			subscribed: dormantControl?.subscribed ?? false,
			controllerIntent: dormantControl?.controllerIntent ?? false,
			runtime: dormantRuntime,
			lastSeq: dormantLastSeq,
			lease: dormantControl?.lease ?? { isController: false },
			freshLeaseBaseline: dormantControl?.freshLeaseBaseline ?? null,
			pendingExtensionRequests: [],
			resync: previous.resync ? { ...previous.resync, bufferedFrameCount: 0 } : null,
			recovery: null,
			history: emptyHistoryState(),
			subscriptionAdmission: null,
		};
		const migrated: SessionChannelState = {
			...previous,
			sessionHandle,
			subscribed: migratedControl?.subscribed ?? true,
			runtime: message.runtime,
			generation: message.runtime.generation,
			baselineAuthoritative: false,
			freshLeaseBaseline: migratedControl?.freshLeaseBaseline ?? null,
			lastSeq: message.runtime.lastSeq,
			projectedSeq: 0,
			lease: migratedControl?.lease ?? { isController: false },
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
		transitionExtension({ type: "rekey", previousSessionHandle, identity: message.runtime });
		transitionRecovery({ type: "clear_baseline_refresh", sessionHandle: previousSessionHandle });
		transitionRecovery({ type: "clear_baseline_refresh", sessionHandle });
		discardRawEvents(sessionHandle, false);
		transitionRecovery({ type: "clear_pending_overflow_restart", sessionHandle: previousSessionHandle });
		transitionRecovery({ type: "clear_pending_overflow_restart", sessionHandle });
		transitionRetention({ type: "remove_subscription", sessionHandle: previousSessionHandle });
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

	function commandMachineError(error: Error): SessionCommandMachineError {
		if (error instanceof SessionTransportError) {
			return { code: error.code, message: error.message };
		}
		return { code: "custom", message: error.message };
	}

	function rejectPending(id: string, error: Error): void {
		const pending = commandMachine.getPending(id);
		if (!pending) return;
		transitionCommand({
			type: "reject",
			id,
			token: pending.token,
			error: commandMachineError(error),
		});
	}

	function rejectPendingForSession(sessionHandle: string, error: Error): void {
		transitionCommand({
			type: "reject_for_session",
			sessionHandle,
			error: commandMachineError(error),
		});
	}

	function rejectAllPending(error: Error): void {
		transitionCommand({ type: "reject_all", error: commandMachineError(error) });
	}

	function dispose(): void {
		if (disposed) return;
		for (const channel of Object.values(store.getState().sessions)) {
			invalidateBrowserEffectIdentity(channel.runtime, channel.sessionHandle);
		}
		for (const runtime of recoveryMachine.getState().hotRuntimeByHandle.values()) {
			invalidateBrowserEffectIdentity(runtime, runtime.sessionHandle);
		}
		abortAllProjections();
		abortAllLazyOperations();
		disconnect();
		disposed = true;
		rejectInitialInventoryWaiters(new SessionTransportError("unavailable", "Session transport disposed"));
		transitionRecovery({ type: "reset" });
		snapshotWaiters.clear();
		snapshotHistoryAssemblies.clear();
		pageHistoryAssemblies.clear();
		resyncCoordinator.dispose();
		for (const sessionHandle of Object.keys(extensionMachine.getState().sessions)) {
			transitionExtension({ type: "reset", sessionHandle });
		}
		for (const timer of commandTimers.values()) clearTimeout(timer);
		commandTimers.clear();
		commandMaterializations.clear();
		transitionRetention({ type: "reset" });
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
