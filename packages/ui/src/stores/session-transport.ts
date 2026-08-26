import {
	commandTimeoutMs,
	type ExtensionUiRequestDto,
	type ExtensionUiResponseDto,
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_REQUIRED_CAPABILITIES,
	type GatewayClientHelloDto,
	isGatewayProtocolError,
	isGatewayServerHello,
	isReadOnlyRpcCommand,
	isSessionSnapshotDto,
	isSessionWsServerMessage,
	SESSION_WS_CLIENT_MAX_BYTES,
	SESSION_WS_SERVER_MAX_BYTES,
	type SessionCommandDto,
	type SessionCommandResponseDto,
	type SessionReplayCursorDto,
	type SessionReplayFrameDto,
	type SessionRuntimeIdentityDto,
	type SessionSnapshotDto,
	type SessionWsClientMessage,
	type SessionWsServerMessage,
	sessionWsClientMessageBytes,
} from "@pi-agent-web/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
	createSessionResyncCoordinator,
	type SessionResyncAttemptContext,
	type SessionResyncCompletion,
} from "../lib/session-resync";
import { OrderedSessionFrameBus, SessionTransportGlobalBus } from "./session-frame-bus";
import {
	hasFreshLeaseBaseline,
	type SessionChannelState,
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
	hasFreshLeaseBaseline,
	type SessionChannelState,
	type SessionLeaseState,
	type SessionRawEventRecord,
	type SessionResyncState,
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
const CLIENT_BUILD = "0.1.0";
const CLIENT_CAPABILITIES = [...GATEWAY_REQUIRED_CAPABILITIES];

type WireSendResult = "sent" | "payload_too_large" | "unavailable";

type ResponseMessage = Extract<SessionWsServerMessage, { type: "response" }>;

interface PendingCommand {
	id: string;
	serverEpoch: string;
	workspaceId: string;
	sessionHandle: string;
	generation: number;
	commandType: SessionCommandDto["type"];
	response?: ResponseMessage;
	resolve: (response: SessionCommandResponseDto) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface RetainedRawEvent {
	identityKey: string;
	sessionHandle: string;
	record: SessionChannelState["rawEvents"][number];
	bytes: number;
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
	message: SessionReplayFrameDto,
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

function serializedBytes(value: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function replayFrameBytes(message: SessionReplayFrameDto): number {
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
	const protocolVersion = options.protocolVersion ?? GATEWAY_PROTOCOL_VERSION;
	const clientHello: GatewayClientHelloDto = {
		type: "client_hello",
		protocol: protocolVersion,
		clientBuild: options.clientBuild ?? CLIENT_BUILD,
		capabilities: CLIENT_CAPABILITIES,
		limits: { maxServerFrameBytes: SESSION_WS_SERVER_MAX_BYTES },
	};
	const frameBus = new OrderedSessionFrameBus();
	const globalBus = new SessionTransportGlobalBus();
	const pendingCommands = new Map<string, PendingCommand>();
	const resyncBuffers = new Map<string, SessionReplayFrameDto[]>();
	const resyncBufferBytes = new Map<string, number>();
	const snapshotWaiters = new Map<string, SnapshotWaiter>();
	const skipNextResubscribe = new Set<string>();
	const acknowledgedExtensionRequests = new Map<string, AcknowledgedExtensionRequests>();
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
	let nextSnapshotWaiterToken = 1;
	let disposed = false;
	let negotiatedMaxClientFrameBytes = SESSION_WS_CLIENT_MAX_BYTES;
	let negotiatedMaxServerFrameBytes = SESSION_WS_SERVER_MAX_BYTES;

	const resyncCoordinator = createSessionResyncCoordinator({
		attempt: attemptResync,
		clock: options.resyncClock,
		random: options.resyncRandom,
	});

	const store = createStore<SessionTransportState>()(() => ({
		connectionState: "idle",
		sessions: {},
		connect,
		disconnect,
		subscribeSession,
		unsubscribeSession,
		invalidateSessionSnapshot,
		claimSession,
		releaseSession,
		sendCommand,
		sendExtensionUiResponse,
		manualRetryResync: (sessionHandle) => resyncCoordinator.manualRetry(sessionHandle),
	}));

	resyncCoordinator.subscribe((sessionHandle, recovery) => {
		setChannel(sessionHandle, (channel) => {
			if (recovery && !identitiesMatch(channel.runtime, recovery.identity)) return channel;
			return channel.recovery === (recovery ?? null) ? channel : { ...channel, recovery: recovery ?? null };
		});
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
				!response ||
				pending.serverEpoch !== identity.serverEpoch ||
				pending.workspaceId !== identity.workspaceId ||
				response.serverEpoch !== identity.serverEpoch ||
				response.sessionHandle !== identity.sessionHandle ||
				response.generation !== identity.generation
			) {
				continue;
			}
			barrierSeq = Math.max(barrierSeq, response.barrierSeq);
		}
		return barrierSeq;
	}

	function clearIdentityBuffers(identity: SessionRuntimeIdentityDto): void {
		const key = identityKey(identity);
		resyncBuffers.delete(key);
		resyncBufferBytes.delete(key);
		skipNextResubscribe.delete(key);
		const waiter = snapshotWaiters.get(key);
		if (waiter) {
			snapshotWaiters.delete(key);
			waiter.reject(new SessionTransportError("stale_resync"));
		}
	}

	function clearSessionResyncData(sessionHandle: string): void {
		for (const [key, waiter] of snapshotWaiters) {
			if (waiter.identity.sessionHandle !== sessionHandle) continue;
			snapshotWaiters.delete(key);
			waiter.reject(new SessionTransportError("stale_resync"));
		}
		for (const [key, frames] of resyncBuffers) {
			if (frames[0]?.sessionHandle === sessionHandle) {
				resyncBuffers.delete(key);
				resyncBufferBytes.delete(key);
				skipNextResubscribe.delete(key);
			}
		}
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
			if (new TextEncoder().encode(raw).byteLength > negotiatedMaxServerFrameBytes) {
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
			if (isGatewayServerHello(value)) {
				if (
					value.protocol.major !== protocolVersion.major ||
					value.protocol.minor > protocolVersion.minor ||
					value.limits.maxSnapshotFrameBytes > clientHello.limits.maxServerFrameBytes ||
					GATEWAY_REQUIRED_CAPABILITIES.some((capability) => !value.capabilities.includes(capability))
				) {
					enterIncompatible(next);
					return;
				}
				if (store.getState().connectionState !== "connecting") {
					enterIncompatible(next);
					return;
				}
				clearHelloTimer();
				negotiatedMaxClientFrameBytes = Math.min(
					SESSION_WS_CLIENT_MAX_BYTES,
					value.limits.maxClientFrameBytes,
				);
				negotiatedMaxServerFrameBytes = value.limits.maxSnapshotFrameBytes;
				reconnectAttempt = 0;
				store.setState({ connectionState: "online" });
				resyncCoordinator.reconnect();
				for (const channel of Object.values(store.getState().sessions)) {
					if (!channel.subscribed) continue;
					const recovery = resyncCoordinator.getState(channel.sessionHandle);
					if (recovery?.phase === "degraded" && identitiesMatch(recovery.identity, channel.runtime)) {
						continue;
					}
					const cursor = validCursor(channel);
					sendSubscription(channel.sessionHandle, cursor);
				}
				return;
			}
			if (store.getState().connectionState !== "online" || !isSessionWsServerMessage(value)) {
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
		rejectAllPending(new SessionTransportError("unavailable", "Gateway protocol is incompatible"));
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
		clearHelloTimer();
		negotiatedMaxClientFrameBytes = SESSION_WS_CLIENT_MAX_BYTES;
		negotiatedMaxServerFrameBytes = SESSION_WS_SERVER_MAX_BYTES;
		claimAttempts.clear();
		baselineRefreshes.clear();
		subscriptionBaselines.clear();
		const receivedAt = now();
		const sessions: Record<string, SessionChannelState> = {};
		const lostLeases: string[] = [];
		for (const [sessionHandle, channel] of Object.entries(store.getState().sessions)) {
			sessions[sessionHandle] = {
				...channel,
				freshLeaseBaseline: null,
				lease: { isController: false },
			};
			if (channel.lease.isController || channel.lease.fencingToken) lostLeases.push(sessionHandle);
		}
		store.setState({ connectionState, sessions });
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

	function evictSubscriptionLruIfNeeded(incomingSessionHandle: string): void {
		const state = store.getState();
		const subscribedSessions = Object.values(state.sessions).filter((s) => s.subscribed);
		if (subscribedSessions.length < maxActiveSubscriptions) return;

		for (const candidateHandle of [...subscribedLruOrder]) {
			if (candidateHandle === incomingSessionHandle) continue;
			const candidate = state.sessions[candidateHandle];
			if (!candidate?.subscribed) continue;

			const isIdle = candidate.runtime?.state === "idle" || candidate.runtime?.state === "dormant";
			const isPersisted =
				candidate.runtime?.sessionFile !== null && candidate.runtime?.sessionFile !== undefined;
			const hasNoPendingExt = candidate.pendingExtensionRequests.length === 0;

			if (isIdle && isPersisted && hasNoPendingExt) {
				unsubscribeSession(candidateHandle);
				break;
			}
		}
	}

	function subscribeSession(sessionHandle: string): void {
		if (!sessionHandle) return;
		if (store.getState().sessions[sessionHandle]?.subscribed) {
			touchSubscriptionLru(sessionHandle);
			return;
		}
		evictSubscriptionLruIfNeeded(sessionHandle);
		touchSubscriptionLru(sessionHandle);
		const channel = setChannel(sessionHandle, (current) =>
			current.subscribed ? current : { ...current, subscribed: true, freshLeaseBaseline: null },
		);
		if (store.getState().connectionState !== "online") return;
		const cursor = validCursor(channel);
		sendSubscription(sessionHandle, cursor);
	}

	function unsubscribeSession(sessionHandle: string): void {
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.subscribed) return;
		const lruIdx = subscribedLruOrder.indexOf(sessionHandle);
		if (lruIdx !== -1) subscribedLruOrder.splice(lruIdx, 1);
		setChannel(sessionHandle, (current) => ({
			...current,
			subscribed: false,
			controllerIntent: false,
			freshLeaseBaseline: null,
			lease: { isController: false },
		}));
		claimAttempts.delete(sessionHandle);
		baselineRefreshes.delete(sessionHandle);
		subscriptionBaselines.delete(sessionHandle);
		resyncCoordinator.unsubscribe(sessionHandle);
		clearSessionResyncData(sessionHandle);
		rejectPendingForSession(sessionHandle, new SessionTransportError("session_not_subscribed"));
		if (store.getState().connectionState === "online") {
			sendWire({ type: "session_unsubscribe", sessionHandle });
		}
	}

	function invalidateSessionSnapshot(sessionHandle: string): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (channel?.subscribed) return false;
		rejectPendingForSession(
			sessionHandle,
			new SessionTransportError("session_not_ready", "Dormant Session snapshot was invalidated"),
		);
		clearSessionResyncData(sessionHandle);
		acknowledgedExtensionRequests.delete(sessionHandle);
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
		if (store.getState().connectionState !== "online" || subscriptionBaselines.has(sessionHandle)) {
			return true;
		}
		const delivered = sendWire({ type: "session_claim", sessionHandle }) === "sent";
		if (delivered) claimAttempts.add(sessionHandle);
		return true;
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

	function requireSubscribedOnline(sessionHandle: string): boolean {
		return (
			store.getState().connectionState === "online" &&
			store.getState().sessions[sessionHandle]?.subscribed === true
		);
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
					pendingCommands.delete(id);
					reject(new SessionTransportError("timeout", `Command ${command.type} timed out`));
				},
				Math.max(0, timeoutMs),
			);
			pendingCommands.set(id, {
				id,
				serverEpoch: channel.runtime?.serverEpoch ?? "",
				workspaceId: channel.runtime?.workspaceId ?? "",
				sessionHandle,
				generation,
				commandType: command.type,
				resolve,
				reject,
				timer,
			});
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
		const runtime = store.getState().sessions[sessionHandle]?.runtime;
		setChannel(sessionHandle, (channel) =>
			channel.freshLeaseBaseline === null ? channel : { ...channel, freshLeaseBaseline: null },
		);
		subscriptionBaselines.set(sessionHandle, runtime ? identityKey(runtime) : null);
		const delivered = sendWire({
			type: "session_subscribe",
			sessionHandle,
			...(cursor ? { cursor } : {}),
		});
		if (delivered !== "sent") subscriptionBaselines.delete(sessionHandle);
		return delivered === "sent";
	}

	function ingestServerMessage(message: SessionWsServerMessage): void {
		switch (message.type) {
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

	function handleSessionError(message: Extract<SessionWsServerMessage, { type: "session_error" }>): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (
			!current?.subscribed ||
			(current.runtime !== null && current.runtime.serverEpoch !== message.serverEpoch)
		) {
			return;
		}
		if (message.operation === "subscribe") {
			subscriptionBaselines.delete(message.sessionHandle);
			baselineRefreshes.delete(message.sessionHandle);
			claimAttempts.delete(message.sessionHandle);
			if (current.resync && current.runtime) {
				failSnapshot(current.runtime, new SessionTransportError("unavailable", message.error));
				frameBus.emit(message.sessionHandle, message, now());
				return;
			}
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
		pending.response = message;
		resolvePendingResponse(pending);
	}

	function resolvePendingResponse(pending: PendingCommand): void {
		const message = pending.response;
		if (!message) return;
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
			clearSessionResyncData(sessionHandle);
			resyncCoordinator.unsubscribe(sessionHandle);
			acknowledgedExtensionRequests.delete(sessionHandle);
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
			lease: identityChanged ? { isController: false } : channel.lease,
			rawEvents: identityChanged ? [] : channel.rawEvents,
		}));
		const delivery = frameBus.emit(sessionHandle, message, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(sessionHandle, message.runtime.generation, delivery.errors[0]);
		}
		resolvePendingResponsesForSession(sessionHandle);
	}

	function handleReplayFrame(message: SessionReplayFrameDto): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (!current?.subscribed || current.generation === null || !identitiesMatch(current.runtime, message)) {
			return;
		}
		const receivedAt = now();

		if (current.resync) {
			if (message.seq <= current.resync.barrierSeq) return;
			const result = bufferReplayFrame(message);
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
			const result = bufferReplayFrame(message);
			if (result === "overflow") return;
			if (result === "buffered" && message.type === "event") {
				appendRawEvent(message.sessionHandle, message, receivedAt);
			}
			handleResyncRequired(synthetic, false);
			return;
		}

		const delivery = frameBus.emit(message.sessionHandle, message, receivedAt);
		if (delivery.errors.length > 0) {
			reportProjectionFailure(message.sessionHandle, message.generation, delivery.errors[0]);
			return;
		}
		const deliveredChannel = store.getState().sessions[message.sessionHandle];
		if (deliveredChannel?.resync?.requiresFreshBaseline) return;
		if (message.type === "event") appendRawEvent(message.sessionHandle, message, receivedAt);
		applyReplayFrameState(message, !delivery.deferred);
		resolvePendingResponsesForSession(message.sessionHandle);
	}

	function appendRawEvent(
		sessionHandle: string,
		message: Extract<SessionReplayFrameDto, { type: "event" }>,
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
		message: SessionReplayFrameDto,
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

	function bufferReplayFrame(message: SessionReplayFrameDto): "buffered" | "duplicate" | "overflow" {
		const key = identityKey(message);
		const buffer = resyncBuffers.get(key) ?? [];
		if (
			buffer.some((candidate) => candidate.generation === message.generation && candidate.seq === message.seq)
		) {
			return "duplicate";
		}
		const bytes = replayFrameBytes(message);
		const nextBytes = (resyncBufferBytes.get(key) ?? 0) + bytes;
		if (buffer.length >= MAX_RESYNC_BUFFERED_FRAMES || nextBytes > MAX_RESYNC_BUFFERED_BYTES) {
			forceReplayResync(message);
			return "overflow";
		}
		buffer.push(message);
		buffer.sort((left, right) => left.seq - right.seq);
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

	function forceReplayResync(message: SessionReplayFrameDto): void {
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
		void error;
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.subscribed || channel.generation !== generation) return false;
		if (!channel.runtime) return false;
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
		const channel = setChannel(message.sessionHandle, (channel) => ({
			...channel,
			freshLeaseBaseline: channel.runtime,
			lease: message.isController
				? {
						isController: true,
						...(message.fencingToken ? { fencingToken: message.fencingToken } : {}),
					}
				: { isController: false },
		}));
		frameBus.emit(message.sessionHandle, message, now());
		if (
			!message.isController &&
			channel.controllerIntent &&
			!claimAttempts.has(message.sessionHandle) &&
			requireSubscribedOnline(message.sessionHandle)
		) {
			claimAttempts.add(message.sessionHandle);
			if (sendWire({ type: "session_claim", sessionHandle: message.sessionHandle }) !== "sent") {
				claimAttempts.delete(message.sessionHandle);
			}
		}
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
		const sameIdentity = identitiesMatch(current.runtime, message.runtime);
		if (!sameIdentity && current.runtime) {
			clearIdentityBuffers(current.runtime);
			resyncCoordinator.unsubscribe(message.sessionHandle);
			claimAttempts.delete(message.sessionHandle);
			baselineRefreshes.delete(message.sessionHandle);
			subscriptionBaselines.delete(message.sessionHandle);
			discardRawEvents(message.sessionHandle, false);
		}
		const key = identityKey(message.runtime);
		const retained = (resyncBuffers.get(key) ?? []).filter(
			(frame) => identitiesMatch(frame, message.runtime) && frame.seq > message.runtime.lastSeq,
		);
		retained.sort((left, right) => left.seq - right.seq);
		if (retained.length > 0) {
			resyncBuffers.set(key, retained);
			resyncBufferBytes.set(
				key,
				retained.reduce((total, frame) => total + replayFrameBytes(frame), 0),
			);
		} else {
			resyncBuffers.delete(key);
			resyncBufferBytes.delete(key);
		}
		if (!sameIdentity) {
			acknowledgedExtensionRequests.delete(message.sessionHandle);
			rejectPendingForSession(
				message.sessionHandle,
				new SessionTransportError("response_mismatch", "Session generation changed during resync"),
			);
		}
		const retainedLastSeq = retained.at(-1)?.seq ?? message.runtime.lastSeq;
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
		}));
		subscriptionBaselines.delete(identity.sessionHandle);
		baselineRefreshes.delete(identity.sessionHandle);
		resyncBuffers.delete(key);
		resyncBufferBytes.delete(key);
		clearAcknowledgedExtensionRequests(identity);
		snapshotWaiters.delete(key);
		waiter.resolve({ identity, snapshotId, asOfSeq: endpointSeq });
		resolvePendingResponsesForSession(identity.sessionHandle);
		return true;
	}

	function handleSessionSnapshot(message: SessionSnapshotDto): void {
		if (!isSessionSnapshotDto(message)) return;
		const channel = store.getState().sessions[message.sessionHandle];
		if (!channel?.subscribed || !channel.resync || !identitiesMatch(channel.runtime, message)) return;
		const key = identityKey(message);
		const waiter = snapshotWaiters.get(key);
		if (!waiter) return;
		const buffered = (resyncBuffers.get(key) ?? [])
			.filter((frame) => identitiesMatch(frame, message) && frame.seq > message.asOfSeq)
			.sort((left, right) => left.seq - right.seq);
		let contiguousSeq = message.asOfSeq;
		for (const frame of buffered) {
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
		const snapshotForProjection: SessionSnapshotDto =
			acknowledged.size === 0
				? message
				: {
						...message,
						pendingExtensionRequests: message.pendingExtensionRequests.filter(
							(request) => !acknowledged.has(request.id),
						),
						stickyExtensionState: message.stickyExtensionState.filter(
							(request) => !acknowledged.has(request.id),
						),
					};
		const snapshotDelivery = frameBus.emit(message.sessionHandle, snapshotForProjection, now());
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
				...snapshotForProjection.pendingExtensionRequests,
				...snapshotForProjection.stickyExtensionState,
			]),
		}));

		let suffixDeferred = false;
		for (const frame of buffered) {
			const skipAcknowledgedRequest =
				frame.type === "extension_ui_request" && acknowledged.has(frame.request.id);
			if (skipAcknowledgedRequest) {
				applyReplayFrameState(frame, !suffixDeferred, acknowledged);
				continue;
			}
			const delivery = frameBus.emit(message.sessionHandle, frame, now());
			if (delivery.errors.length > 0) {
				failSnapshot(message, new SessionTransportError("stale_resync", "Snapshot suffix failed"), waiter);
				reportProjectionFailure(message.sessionHandle, message.generation, delivery.errors[0]);
				return;
			}
			if (snapshotWaiters.get(key)?.token !== waiter.token) return;
			suffixDeferred ||= delivery.deferred;
			applyReplayFrameState(frame, !delivery.deferred, acknowledged);
		}
		resyncBuffers.delete(key);
		resyncBufferBytes.delete(key);
		const projectedSeq = store.getState().sessions[message.sessionHandle]?.projectedSeq;
		if (suffixDeferred && (projectedSeq === undefined || projectedSeq < contiguousSeq)) return;
		finishSnapshot(message, waiter, message.snapshotId, contiguousSeq);
	}

	function handleExtensionSnapshot(
		message: Extract<SessionWsServerMessage, { type: "extension_ui_snapshot" }>,
	): void {
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
		const delivery = frameBus.emit(message.sessionHandle, message, now());
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
		disconnect();
		disposed = true;
		resyncBuffers.clear();
		resyncBufferBytes.clear();
		snapshotWaiters.clear();
		skipNextResubscribe.clear();
		resyncCoordinator.dispose();
		acknowledgedExtensionRequests.clear();
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
		ingestServerMessage,
		confirmProjectionDelivery,
		isSnapshotSuffixProjectionPending,
		reportProjectionFailure,
		dispose,
	};
}

/** Default store/controller. Importing this module never opens a socket. */
export const sessionTransport = createSessionTransport();
export const sessionTransportStore = sessionTransport.store;

export function useSessionTransportStore<T>(selector: (state: SessionTransportState) => T): T {
	return useStore(sessionTransportStore, selector);
}
