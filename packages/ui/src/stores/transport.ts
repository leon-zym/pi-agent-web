import type { RpcCommand, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import type { WsClientMessage, WsServerMessage } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { tt } from "../lib/i18n";

export type WsState = "connecting" | "online" | "offline";

export interface ProcessStatusInfo {
	state: "starting" | "running" | "crashed";
	error?: string;
	seenAt: number;
}

export interface RawEventRecord {
	at: number;
	workspaceId: string;
	sessionId: string;
	eventType: string;
	payload: unknown;
}

export interface BashConsoleEntry {
	id: string;
	command: string;
	output: string;
	state: "running" | "done";
	startedAt: number;
	exitCode?: number | null;
	fullOutputPath?: string;
	truncated?: boolean;
}

const RAW_EVENT_LIMIT = 200;

interface TransportState {
	wsState: WsState;
	/** Active session listen scope (declared to the server on connect). */
	listen: { workspaceId: string | null; sessionId: string | null };
	processStatus: Record<string, ProcessStatusInfo>;
	rawEvents: RawEventRecord[];
	bashConsole: BashConsoleEntry[];
	connect: () => void;
	disconnect: () => void;
	setListen: (workspaceId: string | null, sessionId: string | null) => void;
	sendCommand: (workspaceId: string, command: RpcCommand, timeoutMs?: number) => Promise<RpcResponse>;
	sendExtensionUiResponse: (workspaceId: string, response: RpcExtensionUIResponse) => void;
}

interface PendingCommand {
	resolve: (r: RpcResponse) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let commandCounter = 0;
const pending = new Map<string, PendingCommand>();

/**
 * Bus for frames the transport does not consume itself (events, extension UI,
 * directory/auth change notifications). The stream pipeline subscribes here
 * and routes them into the domain stores.
 */
export const serverFrameBus = new EventTarget();

export function emitServerFrame(message: WsServerMessage): void {
	serverFrameBus.dispatchEvent(new CustomEvent("frame", { detail: message }));
}

export function nextCommandId(prefix: string): string {
	commandCounter += 1;
	return `ui-${prefix}-${String(commandCounter)}-${Math.random().toString(36).slice(2, 6)}`;
}

function wsUrl(): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/api/v1/ws`;
}

function scheduleReconnect(): void {
	if (reconnectTimer) return;
	const delay = Math.min(500 * 2 ** reconnectAttempt, 8000);
	reconnectAttempt += 1;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connectSocket();
	}, delay);
}

function connectSocket(): void {
	if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
	useTransportStore.setState({ wsState: "connecting" });

	const next = new WebSocket(wsUrl());
	socket = next;

	next.onopen = () => {
		reconnectAttempt = 0;
		useTransportStore.setState({ wsState: "online" });
		// Re-declare the listen scope; the snapshot protocol is driven by
		// the stream pipeline on the wsState change.
		const { listen } = useTransportStore.getState();
		if (listen.workspaceId) {
			next.send(
				JSON.stringify({
					type: "session_listen",
					workspaceId: listen.workspaceId,
					sessionId: listen.sessionId,
				}),
			);
		}
		window.dispatchEvent(new CustomEvent("piweb:ws-online"));
	};

	next.onclose = () => {
		if (socket === next) {
			useTransportStore.setState({ wsState: "offline" });
			socket = null;
			for (const [, p] of pending) {
				clearTimeout(p.timer);
				p.reject(new Error(tt("transport.disconnected")));
			}
			pending.clear();
			scheduleReconnect();
		}
	};

	next.onerror = () => {
		// onclose follows and owns the cleanup.
	};

	next.onmessage = (event) => {
		let message: WsServerMessage;
		try {
			message = JSON.parse(String(event.data)) as WsServerMessage;
		} catch {
			return;
		}
		handleServerMessage(message);
	};
}

function send(message: WsClientMessage): boolean {
	if (!socket || socket.readyState !== WebSocket.OPEN) return false;
	try {
		socket.send(JSON.stringify(message));
		return true;
	} catch {
		return false;
	}
}

function handleServerMessage(message: WsServerMessage): void {
	if (message.type === "response") {
		const id = message.response.id;
		if (id && pending.has(id)) {
			const entry = pending.get(id)!;
			pending.delete(id);
			clearTimeout(entry.timer);
			entry.resolve(message.response);
		}
		return;
	}

	if (message.type === "process_status") {
		const state = useTransportStore.getState();
		useTransportStore.setState({
			processStatus: {
				...state.processStatus,
				[message.workspaceId]: { state: message.state, error: message.error, seenAt: Date.now() },
			},
		});
		return;
	}

	if (message.type === "event") {
		const state = useTransportStore.getState();
		void state;
		const record: RawEventRecord = {
			at: Date.now(),
			workspaceId: message.workspaceId,
			sessionId: message.sessionId,
			eventType: message.event.type,
			payload: message.event,
		};
		useTransportStore.setState({ rawEvents: [...state.rawEvents, record].slice(-RAW_EVENT_LIMIT) });

		if (message.event.type === "bash_execution_update") {
			applyBashDelta(state, message);
		}
		emitServerFrame(message);
		return;
	}

	// Remaining frame types are routed by the stream pipeline.
	emitServerFrame(message);
}

function applyBashDelta(state: TransportState, message: Extract<WsServerMessage, { type: "event" }>): void {
	if (message.event.type !== "bash_execution_update") return;
	const id = message.event.id;
	if (!id) return;
	const delta = message.event.delta;
	const entry = state.bashConsole.find((e) => e.id === id);
	if (entry) {
		useTransportStore.setState({
			bashConsole: state.bashConsole.map((e) => (e.id === id ? { ...e, output: e.output + delta } : e)),
		});
	}
}

export const useTransportStore = create<TransportState>()((set, get) => ({
	wsState: "connecting",
	listen: { workspaceId: null, sessionId: null },
	processStatus: {},
	rawEvents: [],
	bashConsole: [],

	connect: () => {
		connectSocket();
	},

	disconnect: () => {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		reconnectAttempt = 99_999; // stop auto-reconnect
		socket?.close();
		socket = null;
		set({ wsState: "offline" });
	},

	setListen: (workspaceId, sessionId) => {
		set({ listen: { workspaceId, sessionId } });
		if (workspaceId) {
			send({ type: "session_listen", workspaceId, sessionId });
		}
	},

	sendCommand: (workspaceId, command, timeoutMs = 60_000) => {
		if (get().wsState !== "online") {
			return Promise.reject(new Error(tt("transport.reconnecting")));
		}
		const id = command.id ?? nextCommandId("cmd");
		const withId = { ...command, id };
		const delivered = send({ type: "command", workspaceId, command: withId });
		if (!delivered) {
			return Promise.reject(new Error(tt("transport.unavailable")));
		}
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(tt("transport.commandTimeout", { command: command.type })));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
		});
	},

	sendExtensionUiResponse: (workspaceId, response) => {
		send({ type: "extension_ui_response", workspaceId, response });
	},
}));

export { handleServerMessage };
