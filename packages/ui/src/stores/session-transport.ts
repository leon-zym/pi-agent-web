import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import {
	commandTimeoutMs,
	isReadOnlyRpcCommand,
	isSessionWsServerMessage,
	SESSION_WS_CLIENT_MAX_BYTES,
	type SessionReplayCursorDto,
	type SessionReplayFrameDto,
	type SessionWsClientMessage,
	type SessionWsServerMessage,
	sessionWsClientMessageBytes,
} from "@pi-agent-web/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { OrderedSessionFrameBus, SessionTransportGlobalBus } from "./session-frame-bus";
import {
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
const MAX_RESYNC_BUFFERED_FRAMES = 1_024;
const MAX_RESYNC_BUFFERED_BYTES = 1024 * 1024;
export const MAX_ACTIVE_SUBSCRIPTIONS = 6;
const MAX_PENDING_EXTENSION_REQUESTS = 256;

type WireSendResult = "sent" | "payload_too_large" | "unavailable";

type ResponseMessage = Extract<SessionWsServerMessage, { type: "response" }>;

interface PendingCommand {
	id: string;
	sessionHandle: string;
	generation: number;
	commandType: RpcCommand["type"];
	response?: ResponseMessage;
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface RetainedRawEvent {
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
		lastSeq: 0,
		projectedSeq: 0,
		lease: { isController: false },
		pendingExtensionRequests: [],
		resync: null,
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

function commandWithId(command: RpcCommand, id: string): RpcCommand {
	return { ...command, id } as RpcCommand;
}

function isMutation(command: RpcCommand): boolean {
	return !isReadOnlyRpcCommand(command);
}

function replaceExtensionRequest(
	requests: RpcExtensionUIRequest[],
	request: RpcExtensionUIRequest,
): RpcExtensionUIRequest[] {
	const semanticKey = extensionRequestSemanticKey(request);
	if (semanticKey === null) return requests;
	return [
		...requests.filter(
			(candidate) => candidate.id !== request.id && extensionRequestSemanticKey(candidate) !== semanticKey,
		),
		request,
	].slice(-MAX_PENDING_EXTENSION_REQUESTS);
}

function extensionRequestSemanticKey(request: RpcExtensionUIRequest): string | null {
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

function normalizeExtensionRequests(requests: RpcExtensionUIRequest[]): RpcExtensionUIRequest[] {
	let normalized: RpcExtensionUIRequest[] = [];
	for (const request of requests) normalized = replaceExtensionRequest(normalized, request);
	return normalized;
}

function applyReplayExtensionState(
	requests: RpcExtensionUIRequest[],
	message: SessionReplayFrameDto,
): RpcExtensionUIRequest[] {
	if (message.type === "extension_ui_request") return replaceExtensionRequest(requests, message.request);
	if (message.type === "extension_ui_closed") {
		return requests.filter((request) => request.id !== message.requestId);
	}
	return requests;
}

function isIdentityTransitionCommand(commandType: RpcCommand["type"]): boolean {
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
	return channel.generation === null || channel.resync?.requiresFreshBaseline
		? undefined
		: { generation: channel.generation, seq: channel.lastSeq };
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
	const maxActiveSubscriptions = Math.max(1, options.maxActiveSubscriptions ?? MAX_ACTIVE_SUBSCRIPTIONS);
	const frameBus = new OrderedSessionFrameBus();
	const globalBus = new SessionTransportGlobalBus();
	const pendingCommands = new Map<string, PendingCommand>();
	const resyncBuffers = new Map<string, SessionReplayFrameDto[]>();
	const resyncBufferBytes = new Map<string, number>();
	const acknowledgedExtensionRequests = new Map<string, Set<string>>();
	const claimAttempts = new Set<string>();
	const baselineRefreshes = new Set<string>();
	const subscriptionBaselines = new Set<string>();
	let subscribedLruOrder: string[] = [];
	let retainedRawEvents: RetainedRawEvent[] = [];
	let retainedRawEventBytes = 0;

	let socket: SessionWebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectAttempt = 0;
	let reconnectEnabled = false;
	let commandCounter = 0;
	let disposed = false;

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
		completeResync,
	}));

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

	function connect(): void {
		if (disposed) return;
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
			reconnectAttempt = 0;
			store.setState({ connectionState: "online" });
			for (const channel of Object.values(store.getState().sessions)) {
				if (!channel.subscribed) continue;
				const cursor = validCursor(channel);
				sendSubscription(channel.sessionHandle, cursor);
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
			let value: unknown;
			try {
				value = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (!isSessionWsServerMessage(value)) return;
			ingestServerMessage(value);
		};
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

	function handleDisconnected(): void {
		rejectAllPending(new SessionTransportError("disconnected"));
		claimAttempts.clear();
		baselineRefreshes.clear();
		subscriptionBaselines.clear();
		const receivedAt = now();
		const sessions: Record<string, SessionChannelState> = {};
		const lostLeases: string[] = [];
		for (const [sessionHandle, channel] of Object.entries(store.getState().sessions)) {
			sessions[sessionHandle] = { ...channel, lease: { isController: false } };
			if (channel.lease.isController || channel.lease.fencingToken) lostLeases.push(sessionHandle);
		}
		store.setState({ connectionState: "offline", sessions });
		for (const sessionHandle of lostLeases) {
			frameBus.emit(sessionHandle, { type: "lease_status", sessionHandle, isController: false }, receivedAt);
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

			const isIdle =
				candidate.runtime?.state === "idle" || candidate.runtime?.state === "dormant";
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
			current.subscribed ? current : { ...current, subscribed: true },
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
			lease: { isController: false },
		}));
		claimAttempts.delete(sessionHandle);
		baselineRefreshes.delete(sessionHandle);
		subscriptionBaselines.delete(sessionHandle);
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
		resyncBuffers.delete(sessionHandle);
		resyncBufferBytes.delete(sessionHandle);
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
			lease: { isController: false },
		}));
		frameBus.emit(sessionHandle, { type: "lease_status", sessionHandle, isController: false }, now());
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
		command: RpcCommand,
		timeoutMs = commandTimeoutMs(command.type),
	): Promise<RpcResponse> {
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
		if (mutation && (!channel.lease.isController || !channel.lease.fencingToken)) {
			return Promise.reject(new SessionTransportError("session_read_only"));
		}
		commandCounter += 1;
		const id = command.id ?? `session-ui-${String(commandCounter)}-${now().toString(36)}`;
		if (pendingCommands.has(id)) {
			return Promise.reject(new SessionTransportError("duplicate_command_id"));
		}
		const generation = channel.generation;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(
				() => {
					pendingCommands.delete(id);
					reject(new SessionTransportError("timeout", `Command ${command.type} timed out`));
				},
				Math.max(0, timeoutMs),
			);
			pendingCommands.set(id, {
				id,
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

	function sendExtensionUiResponse(sessionHandle: string, response: RpcExtensionUIResponse): boolean {
		const channel = store.getState().sessions[sessionHandle];
		if (
			!channel?.subscribed ||
			channel.generation === null ||
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
		if (sessionWsClientMessageBytes(message) > SESSION_WS_CLIENT_MAX_BYTES) {
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
		subscriptionBaselines.add(sessionHandle);
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
		if (!current?.subscribed) return;
		if (message.operation === "subscribe") {
			subscriptionBaselines.delete(message.sessionHandle);
			baselineRefreshes.delete(message.sessionHandle);
			claimAttempts.delete(message.sessionHandle);
			rejectPendingForSession(
				message.sessionHandle,
				new SessionTransportError("session_not_subscribed", message.error),
			);
			setChannel(message.sessionHandle, (channel) => ({
				...channel,
				subscribed: false,
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
			pending.sessionHandle === message.sessionHandle && pending.generation === message.generation;
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
		if (!channel || channel.generation !== message.generation) return;
		if (channel.resync) {
			if (pending.commandType !== "get_messages") return;
			if (message.response.success === false) {
				settlePendingResponse(pending, message);
				return;
			}
			if (message.barrierSeq < channel.resync.barrierSeq) {
				rejectPending(
					pending.id,
					new SessionTransportError(
						"stale_resync",
						`Snapshot response covered ${String(message.barrierSeq)}, before resync barrier ${String(channel.resync.barrierSeq)}`,
					),
				);
				return;
			}
			if (channel.lastSeq < message.barrierSeq) return;
			advanceSnapshotBarrier(message.sessionHandle, message.generation, message.barrierSeq);
			settlePendingResponse(pending, message);
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

	function advanceSnapshotBarrier(sessionHandle: string, generation: number, barrierSeq: number): void {
		const buffered = (resyncBuffers.get(sessionHandle) ?? []).filter(
			(frame) => frame.generation === generation && frame.seq > barrierSeq,
		);
		if (buffered.length > 0) {
			resyncBuffers.set(sessionHandle, buffered);
			resyncBufferBytes.set(
				sessionHandle,
				buffered.reduce((total, frame) => total + replayFrameBytes(frame), 0),
			);
		} else {
			resyncBuffers.delete(sessionHandle);
			resyncBufferBytes.delete(sessionHandle);
		}
		setChannel(sessionHandle, (channel) => {
			if (!channel.resync || channel.generation !== generation) return channel;
			return {
				...channel,
				resync: {
					...channel.resync,
					barrierSeq,
					bufferedFrameCount: buffered.length,
				},
			};
		});
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
		if (current.generation !== null && message.runtime.generation < current.generation) return;
		const generationChanged =
			current.generation !== null && current.generation !== message.runtime.generation;
		if (generationChanged) {
			resyncBuffers.delete(sessionHandle);
			resyncBufferBytes.delete(sessionHandle);
			acknowledgedExtensionRequests.delete(sessionHandle);
			rejectPendingForSession(
				sessionHandle,
				new SessionTransportError("response_mismatch", "Session generation changed before response"),
			);
		}
		setChannel(sessionHandle, (channel) => ({
			...channel,
			runtime: message.runtime,
			generation: message.runtime.generation,
			lastSeq: generationChanged ? 0 : channel.lastSeq,
			projectedSeq: generationChanged ? 0 : channel.projectedSeq,
			pendingExtensionRequests: generationChanged ? [] : channel.pendingExtensionRequests,
			resync: generationChanged ? null : channel.resync,
		}));
		const delivery = frameBus.emit(sessionHandle, message, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(sessionHandle, message.runtime.generation, delivery.errors[0]);
		}
		resolvePendingResponsesForSession(sessionHandle);
	}

	function handleReplayFrame(message: SessionReplayFrameDto): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (!current?.subscribed || current.generation === null) return;
		const receivedAt = now();
		if (message.generation !== current.generation) return;

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
				sessionHandle: message.sessionHandle,
				runtime,
				reason: "gap",
			} satisfies Extract<SessionWsServerMessage, { type: "resync_required" }>;
			const result = bufferReplayFrame(message);
			if (result === "overflow") return;
			if (result === "buffered" && message.type === "event") {
				appendRawEvent(message.sessionHandle, message, receivedAt);
			}
			handleResyncRequired(synthetic);
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

		const retained = { sessionHandle, record, bytes } satisfies RetainedRawEvent;
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

	function applyReplayFrameState(message: SessionReplayFrameDto, projected: boolean): void {
		setChannel(message.sessionHandle, (channel) => ({
			...channel,
			lastSeq: message.seq,
			projectedSeq: projected ? message.seq : channel.projectedSeq,
			pendingExtensionRequests: applyReplayExtensionState(channel.pendingExtensionRequests, message),
		}));
	}

	function bufferReplayFrame(message: SessionReplayFrameDto): "buffered" | "duplicate" | "overflow" {
		const buffer = resyncBuffers.get(message.sessionHandle) ?? [];
		if (
			buffer.some((candidate) => candidate.generation === message.generation && candidate.seq === message.seq)
		) {
			return "duplicate";
		}
		const bytes = replayFrameBytes(message);
		const nextBytes = (resyncBufferBytes.get(message.sessionHandle) ?? 0) + bytes;
		if (buffer.length >= MAX_RESYNC_BUFFERED_FRAMES || nextBytes > MAX_RESYNC_BUFFERED_BYTES) {
			forceReplayResync(message);
			return "overflow";
		}
		buffer.push(message);
		buffer.sort((left, right) => left.seq - right.seq);
		resyncBuffers.set(message.sessionHandle, buffer);
		resyncBufferBytes.set(message.sessionHandle, nextBytes);
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
		const barrierSeq = Math.max(current.lastSeq, current.resync?.barrierSeq ?? 0, message.seq);
		const runtime = {
			...current.runtime,
			generation: message.generation,
			lastSeq: barrierSeq,
		};
		resyncBuffers.delete(message.sessionHandle);
		resyncBufferBytes.delete(message.sessionHandle);
		acknowledgedExtensionRequests.delete(message.sessionHandle);
		const required = {
			type: "resync_required",
			sessionHandle: message.sessionHandle,
			runtime,
			reason: "gap",
		} satisfies Extract<SessionWsServerMessage, { type: "resync_required" }>;
		setChannel(message.sessionHandle, (channel) => ({
			...channel,
			runtime,
			generation: message.generation,
			lastSeq: barrierSeq,
			pendingExtensionRequests: [],
			resync: {
				reason: "gap",
				generation: message.generation,
				barrierSeq,
				bufferedFrameCount: 0,
				requiresFreshBaseline: true,
			},
		}));
		if (requestFreshBaseline(message.sessionHandle)) return;
		const delivery = frameBus.emit(message.sessionHandle, required, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(message.sessionHandle, message.generation, delivery.errors[0]);
		}
		options.onResyncRequired?.(required);
	}

	function requestFreshBaseline(sessionHandle: string): boolean {
		if (baselineRefreshes.has(sessionHandle)) return true;
		if (!requireSubscribedOnline(sessionHandle)) return false;
		baselineRefreshes.add(sessionHandle);
		if (sendSubscription(sessionHandle)) return true;
		baselineRefreshes.delete(sessionHandle);
		return false;
	}

	function confirmProjectionDelivery(sessionHandle: string, generation: number): boolean {
		const channel = store.getState().sessions[sessionHandle];
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

	function reportProjectionFailure(sessionHandle: string, generation: number, error?: unknown): boolean {
		void error;
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.subscribed || channel.generation !== generation) return false;
		if (channel.resync?.requiresFreshBaseline) {
			baselineRefreshes.delete(sessionHandle);
			subscriptionBaselines.delete(sessionHandle);
			requestFreshBaseline(sessionHandle);
			return true;
		}

		resyncBuffers.delete(sessionHandle);
		resyncBufferBytes.delete(sessionHandle);
		acknowledgedExtensionRequests.delete(sessionHandle);
		baselineRefreshes.delete(sessionHandle);
		subscriptionBaselines.delete(sessionHandle);
		discardRawEvents(sessionHandle);
		setChannel(sessionHandle, (current) => ({
			...current,
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
		requestFreshBaseline(sessionHandle);
		return true;
	}

	function handleLease(message: Extract<SessionWsServerMessage, { type: "lease_status" }>): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (!current?.subscribed) return;
		const channel = setChannel(message.sessionHandle, (channel) => ({
			...channel,
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

	function handleResyncRequired(message: Extract<SessionWsServerMessage, { type: "resync_required" }>): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (!current?.subscribed) return;
		if (current.generation !== null && message.runtime.generation < current.generation) return;
		const sameGeneration = current.generation === message.runtime.generation;
		const retained = sameGeneration
			? (resyncBuffers.get(message.sessionHandle) ?? []).filter(
					(frame) => frame.generation === message.runtime.generation && frame.seq > message.runtime.lastSeq,
				)
			: [];
		retained.sort((left, right) => left.seq - right.seq);
		if (retained.length > 0) {
			resyncBuffers.set(message.sessionHandle, retained);
			resyncBufferBytes.set(
				message.sessionHandle,
				retained.reduce((total, frame) => total + replayFrameBytes(frame), 0),
			);
		} else {
			resyncBuffers.delete(message.sessionHandle);
			resyncBufferBytes.delete(message.sessionHandle);
		}
		if (!sameGeneration) {
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
			lastSeq: Math.max(message.runtime.lastSeq, retainedLastSeq),
			projectedSeq: sameGeneration ? channel.projectedSeq : 0,
			pendingExtensionRequests: sameGeneration ? channel.pendingExtensionRequests : [],
			resync: {
				reason: message.reason,
				generation: message.runtime.generation,
				barrierSeq: message.runtime.lastSeq,
				bufferedFrameCount: retained.length,
				requiresFreshBaseline,
			},
		}));
		if (subscriptionBaselines.has(message.sessionHandle)) return;
		const delivery = frameBus.emit(message.sessionHandle, message, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(message.sessionHandle, message.runtime.generation, delivery.errors[0]);
		}
		options.onResyncRequired?.(message);
	}

	function notifyResyncRequired(channel: SessionChannelState): void {
		if (!channel.resync || !channel.runtime) return;
		const message = resyncMessageFor(channel);
		const delivery = frameBus.emit(channel.sessionHandle, message, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(
				channel.sessionHandle,
				channel.generation ?? message.runtime.generation,
				delivery.errors[0],
			);
		}
		options.onResyncRequired?.(message);
	}

	function resyncMessageFor(
		channel: SessionChannelState,
	): Extract<SessionWsServerMessage, { type: "resync_required" }> {
		if (!channel.resync || !channel.runtime) throw new SessionTransportError("stale_resync");
		return {
			type: "resync_required",
			sessionHandle: channel.sessionHandle,
			runtime: channel.runtime,
			reason: channel.resync.reason,
		};
	}

	function completeResync(sessionHandle: string, cursor?: SessionReplayCursorDto): void {
		const channel = store.getState().sessions[sessionHandle];
		if (!channel?.resync || channel.generation === null) {
			throw new SessionTransportError("stale_resync");
		}
		const completedCursor = cursor ?? {
			generation: channel.resync.generation,
			seq: channel.resync.barrierSeq,
		};
		if (
			completedCursor.generation !== channel.generation ||
			completedCursor.seq < channel.resync.barrierSeq ||
			completedCursor.seq > channel.lastSeq
		) {
			throw new SessionTransportError("stale_resync");
		}

		const buffered = (resyncBuffers.get(sessionHandle) ?? []).filter(
			(frame) => frame.generation === completedCursor.generation && frame.seq > completedCursor.seq,
		);
		let contiguousSeq = completedCursor.seq;
		for (const frame of buffered) {
			if (frame.seq === contiguousSeq + 1) {
				contiguousSeq = frame.seq;
				continue;
			}
			const runtime = channel.runtime;
			if (runtime) {
				resyncBuffers.set(sessionHandle, buffered);
				resyncBufferBytes.set(
					sessionHandle,
					buffered.reduce((total, frame) => total + replayFrameBytes(frame), 0),
				);
				handleResyncRequired({
					type: "resync_required",
					sessionHandle,
					runtime,
					reason: "gap",
				});
			}
			return;
		}
		resyncBuffers.delete(sessionHandle);
		resyncBufferBytes.delete(sessionHandle);
		setChannel(sessionHandle, (current) => ({
			...current,
			lastSeq: completedCursor.seq,
			projectedSeq: completedCursor.seq,
			resync: null,
		}));
		const acknowledged = acknowledgedExtensionRequests.get(sessionHandle);
		for (const frame of buffered) {
			if (frame.type === "extension_ui_request" && acknowledged?.has(frame.request.id)) {
				setChannel(sessionHandle, (current) => ({
					...current,
					lastSeq: frame.seq,
					projectedSeq: frame.seq,
				}));
				continue;
			}
			const delivery = frameBus.emit(sessionHandle, frame, now());
			if (delivery.errors.length > 0) {
				reportProjectionFailure(sessionHandle, frame.generation, delivery.errors[0]);
				return;
			}
			if (store.getState().sessions[sessionHandle]?.resync?.requiresFreshBaseline) return;
			applyReplayFrameState(frame, !delivery.deferred);
		}
		acknowledgedExtensionRequests.delete(sessionHandle);
		resolvePendingResponsesForSession(sessionHandle);
	}

	function handleExtensionSnapshot(
		message: Extract<SessionWsServerMessage, { type: "extension_ui_snapshot" }>,
	): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (!current?.subscribed || current.generation !== message.generation) return;
		const completedBaseline = subscriptionBaselines.delete(message.sessionHandle);
		baselineRefreshes.delete(message.sessionHandle);
		const channel = setChannel(message.sessionHandle, (channel) => ({
			...channel,
			pendingExtensionRequests: normalizeExtensionRequests(message.requests),
		}));
		const delivery = frameBus.emit(message.sessionHandle, message, now());
		if (delivery.errors.length > 0) {
			reportProjectionFailure(message.sessionHandle, message.generation, delivery.errors[0]);
			return;
		}
		if (completedBaseline && channel.resync) notifyResyncRequired(channel);
	}

	function handleExtensionResult(
		message: Extract<SessionWsServerMessage, { type: "extension_ui_result" }>,
	): void {
		const current = store.getState().sessions[message.sessionHandle];
		if (!current?.subscribed || current.generation !== message.generation) return;
		const bufferedRequest = (resyncBuffers.get(message.sessionHandle) ?? []).some(
			(frame) => frame.type === "extension_ui_request" && frame.request.id === message.requestId,
		);
		if (current.resync && bufferedRequest) {
			const acknowledged = acknowledgedExtensionRequests.get(message.sessionHandle) ?? new Set<string>();
			acknowledged.add(message.requestId);
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
			pendingExtensionRequests: [],
			resync: previous.resync ? { ...previous.resync, bufferedFrameCount: 0 } : null,
		};
		const migrated: SessionChannelState = {
			...previous,
			sessionHandle,
			subscribed: true,
			runtime: message.runtime,
			generation: message.runtime.generation,
			lastSeq: message.runtime.lastSeq,
			projectedSeq: 0,
			lease: previous.lease,
			pendingExtensionRequests: [],
			resync: {
				reason: "generation_changed",
				generation: message.runtime.generation,
				barrierSeq: message.runtime.lastSeq,
				bufferedFrameCount: 0,
				requiresFreshBaseline: true,
			},
			rawEvents: [],
		};
		const sessions = {
			...state.sessions,
			[previousSessionHandle]: dormant,
			[sessionHandle]: migrated,
		};
		resyncBuffers.delete(previousSessionHandle);
		resyncBuffers.delete(sessionHandle);
		resyncBufferBytes.delete(previousSessionHandle);
		resyncBufferBytes.delete(sessionHandle);
		acknowledgedExtensionRequests.delete(previousSessionHandle);
		acknowledgedExtensionRequests.delete(sessionHandle);
		baselineRefreshes.delete(previousSessionHandle);
		baselineRefreshes.delete(sessionHandle);
		if (subscriptionBaselines.delete(previousSessionHandle)) subscriptionBaselines.add(sessionHandle);
		discardRawEvents(sessionHandle, false);
		if (claimAttempts.delete(previousSessionHandle)) claimAttempts.add(sessionHandle);
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
		if (!subscriptionBaselines.has(sessionHandle)) notifyResyncRequired(migrated);
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
