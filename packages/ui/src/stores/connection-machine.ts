import type { GatewayClientHelloDto } from "@pi-agent-web/protocol";

export type SessionConnectionPhase =
	| "closed"
	| "connecting"
	| "awaiting-hello"
	| "ready"
	| "backoff"
	| "terminal";

export type SessionConnectionObservableState = "idle" | "connecting" | "online" | "offline" | "incompatible";

export interface SessionConnectionMachineState {
	phase: SessionConnectionPhase;
	observableState: SessionConnectionObservableState;
	/** Monotonic identity for one socket attempt; stale callbacks cannot affect a newer attempt. */
	socketEpoch: number;
	/** Gateway epoch accepted by the current hello, if any. */
	serverEpoch: string | null;
	reconnectEnabled: boolean;
	reconnectAttempt: number;
}

export interface SessionConnectionMachineOptions {
	clientHello: GatewayClientHelloDto;
	helloTimeoutMs: number;
	reconnectBaseMs: number;
	reconnectMaxMs: number;
}

export type SessionConnectionMachineEvent =
	| { type: "connect" }
	| { type: "socket_open"; socketEpoch: number }
	| { type: "socket_failed"; socketEpoch: number }
	| {
			type: "server_hello";
			socketEpoch: number;
			serverEpoch: string;
			accepted: boolean;
	  }
	| {
			type: "initial_inventory";
			socketEpoch: number;
			serverEpoch: string;
			accepted: boolean;
	  }
	| { type: "socket_closed"; socketEpoch: number }
	| { type: "protocol_failure"; socketEpoch: number }
	| { type: "reconnect_timer"; socketEpoch: number }
	| { type: "disconnect"; socketEpoch: number | null };

export type SessionConnectionMachineIntent =
	| { type: "open_socket"; socketEpoch: number }
	| { type: "send_client_hello"; socketEpoch: number; hello: GatewayClientHelloDto }
	| { type: "start_hello_timeout"; socketEpoch: number; delayMs: number }
	| { type: "clear_hello_timeout"; socketEpoch: number }
	| { type: "schedule_reconnect"; socketEpoch: number; delayMs: number }
	| { type: "clear_reconnect_timer" }
	| { type: "close_socket"; socketEpoch: number };

export interface SessionConnectionMachineTransition {
	state: SessionConnectionMachineState;
	intents: SessionConnectionMachineIntent[];
}

const initialState: SessionConnectionMachineState = {
	phase: "closed",
	observableState: "idle",
	socketEpoch: 0,
	serverEpoch: null,
	reconnectEnabled: false,
	reconnectAttempt: 0,
};

export function createInitialSessionConnectionMachineState(): SessionConnectionMachineState {
	return { ...initialState };
}

function reconnectDelay(options: SessionConnectionMachineOptions, attempt: number): number {
	return Math.min(options.reconnectBaseMs * 2 ** attempt, options.reconnectMaxMs);
}

function stale(state: SessionConnectionMachineState, socketEpoch: number): boolean {
	return state.socketEpoch !== socketEpoch;
}

function backoff(
	state: SessionConnectionMachineState,
	options: SessionConnectionMachineOptions,
	intents: SessionConnectionMachineIntent[],
): SessionConnectionMachineTransition {
	const delayMs = reconnectDelay(options, state.reconnectAttempt);
	const next: SessionConnectionMachineState = {
		...state,
		phase: state.reconnectEnabled ? "backoff" : "closed",
		observableState: "offline",
		serverEpoch: null,
		reconnectAttempt: state.reconnectAttempt + 1,
	};
	if (state.reconnectEnabled) {
		intents.push({ type: "schedule_reconnect", socketEpoch: state.socketEpoch, delayMs });
	}
	return { state: next, intents };
}

function terminal(
	state: SessionConnectionMachineState,
	socketEpoch: number,
): SessionConnectionMachineTransition {
	return {
		state: {
			...state,
			phase: "terminal",
			observableState: "incompatible",
			serverEpoch: null,
			reconnectEnabled: false,
		},
		intents: [
			{ type: "clear_reconnect_timer" },
			{ type: "clear_hello_timeout", socketEpoch },
			{ type: "close_socket", socketEpoch },
		],
	};
}

export function reduceSessionConnectionMachine(
	state: SessionConnectionMachineState,
	event: SessionConnectionMachineEvent,
	options: SessionConnectionMachineOptions,
): SessionConnectionMachineTransition {
	const intents: SessionConnectionMachineIntent[] = [];
	switch (event.type) {
		case "connect": {
			if (state.phase === "terminal" || state.phase === "connecting" || state.phase === "awaiting-hello") {
				return { state, intents };
			}
			if (state.phase === "ready") {
				return state.reconnectEnabled
					? { state, intents }
					: { state: { ...state, reconnectEnabled: true }, intents };
			}
			const socketEpoch = state.socketEpoch + 1;
			return {
				state: {
					...state,
					phase: "connecting",
					observableState: "connecting",
					socketEpoch,
					serverEpoch: null,
					reconnectEnabled: true,
				},
				intents: [{ type: "clear_reconnect_timer" }, { type: "open_socket", socketEpoch }],
			};
		}
		case "socket_open":
			if (stale(state, event.socketEpoch) || state.phase !== "connecting") return { state, intents };
			return {
				state: { ...state, phase: "awaiting-hello" },
				intents: [
					{ type: "send_client_hello", socketEpoch: event.socketEpoch, hello: options.clientHello },
					{ type: "start_hello_timeout", socketEpoch: event.socketEpoch, delayMs: options.helloTimeoutMs },
				],
			};
		case "socket_failed":
			if (
				stale(state, event.socketEpoch) ||
				(state.phase !== "connecting" && state.phase !== "awaiting-hello")
			) {
				return { state, intents };
			}
			return backoff(state, options, [
				{ type: "clear_hello_timeout", socketEpoch: event.socketEpoch },
				{ type: "close_socket", socketEpoch: event.socketEpoch },
			]);
		case "server_hello":
			if (stale(state, event.socketEpoch) || state.phase !== "awaiting-hello") return { state, intents };
			if (!event.accepted) return terminal(state, event.socketEpoch);
			return {
				state: { ...state, serverEpoch: event.serverEpoch },
				intents,
			};
		case "initial_inventory":
			if (stale(state, event.socketEpoch) || state.phase !== "awaiting-hello") return { state, intents };
			if (!event.accepted || state.serverEpoch !== event.serverEpoch)
				return terminal(state, event.socketEpoch);
			return {
				state: {
					...state,
					phase: "ready",
					observableState: "online",
					reconnectAttempt: 0,
				},
				intents: [{ type: "clear_hello_timeout", socketEpoch: event.socketEpoch }],
			};
		case "socket_closed":
			if (stale(state, event.socketEpoch) || state.phase === "terminal" || state.phase === "closed") {
				return { state, intents };
			}
			return backoff(state, options, intents);
		case "protocol_failure":
			if (stale(state, event.socketEpoch) || state.phase === "terminal") return { state, intents };
			return terminal(state, event.socketEpoch);
		case "reconnect_timer":
			if (stale(state, event.socketEpoch) || state.phase !== "backoff" || !state.reconnectEnabled) {
				return { state, intents };
			}
			return reduceSessionConnectionMachine(state, { type: "connect" }, options);
		case "disconnect": {
			const disconnectIntents: SessionConnectionMachineIntent[] = [{ type: "clear_reconnect_timer" }];
			if (event.socketEpoch !== null) {
				disconnectIntents.push(
					{ type: "clear_hello_timeout", socketEpoch: event.socketEpoch },
					{ type: "close_socket", socketEpoch: event.socketEpoch },
				);
			}
			return {
				state: {
					...state,
					phase: "closed",
					observableState: "offline",
					serverEpoch: null,
					reconnectEnabled: false,
				},
				intents: disconnectIntents,
			};
		}
	}
}

export interface SessionConnectionMachine {
	getState(): SessionConnectionMachineState;
	transition(event: SessionConnectionMachineEvent): SessionConnectionMachineTransition;
}

export function createSessionConnectionMachine(
	options: SessionConnectionMachineOptions,
	initial: SessionConnectionMachineState = createInitialSessionConnectionMachineState(),
): SessionConnectionMachine {
	let state = initial;
	return {
		getState: () => state,
		transition: (event) => {
			const transition = reduceSessionConnectionMachine(state, event, options);
			state = transition.state;
			return transition;
		},
	};
}
