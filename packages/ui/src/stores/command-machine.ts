import type {
	InlineSessionResponseFrameDto,
	PiSessionCommandResponseDto,
	SessionCommandDto,
	SessionResponseFrameDto,
	SessionRuntimeIdentityDto,
	SessionWsClientMessage,
} from "@pi-agent-web/protocol";
import { isReadOnlyRpcCommand } from "@pi-agent-web/protocol";

type CommandWireMessage = Extract<SessionWsClientMessage, { type: "command" }>;

export type SessionCommandMachineErrorCode =
	| "disconnected"
	| "duplicate_command_id"
	| "payload_too_large"
	| "response_mismatch"
	| "session_not_ready"
	| "session_not_subscribed"
	| "session_read_only"
	| "stale_resync"
	| "timeout"
	| "unavailable"
	| "custom";

export interface SessionCommandMachineError {
	code: SessionCommandMachineErrorCode;
	message: string;
}

export interface SessionCommandMachineResolvedResponse {
	type: "response";
	serverEpoch: string;
	sessionHandle: string;
	generation: number;
	barrierSeq: number;
	response: PiSessionCommandResponseDto;
	previousSessionHandle?: string;
}

export interface SessionCommandMachineCompletion extends SessionCommandMachineResolvedResponse {
	workspaceId: string;
}

export interface SessionCommandMachinePending {
	id: string;
	token: number;
	serverEpoch: string;
	workspaceId: string;
	sessionHandle: string;
	generation: number;
	commandType: SessionCommandDto["type"];
	response?: SessionCommandMachineResolvedResponse;
	historyBarrierSeq?: number;
	responseKey?: string;
	materializing: boolean;
	resolve: (response: PiSessionCommandResponseDto) => void;
	resolveWithIdentity?: (completion: SessionCommandMachineCompletion) => void;
	reject: (error: Error) => void;
}

export interface SessionCommandMachineState {
	pending: Record<string, SessionCommandMachinePending>;
	nextCommandNumber: number;
	nextPendingToken: number;
}

export type SessionCommandMachineEvent =
	| {
			type: "request";
			sessionHandle: string;
			command: SessionCommandDto;
			timeoutMs: number;
			now: number;
			subscribed: boolean;
			online: boolean;
			socketReady: boolean;
			generation: number | null;
			currentIdentity: SessionRuntimeIdentityDto | null;
			baselineAuthoritative: boolean;
			freshLeaseBaseline: SessionRuntimeIdentityDto | null;
			isController: boolean;
			fencingToken?: string;
			resolve: (response: PiSessionCommandResponseDto) => void;
			resolveWithIdentity?: (completion: SessionCommandMachineCompletion) => void;
			reject: (error: Error) => void;
	  }
	| { type: "send_failed"; id: string; token: number; error: SessionCommandMachineError }
	| { type: "timeout"; id: string; token: number }
	| { type: "reject"; id: string; token?: number; error: SessionCommandMachineError }
	| { type: "reject_for_session"; sessionHandle: string; error: SessionCommandMachineError }
	| { type: "reject_all"; error: SessionCommandMachineError }
	| { type: "wire_response"; message: SessionResponseFrameDto; history: boolean }
	| { type: "inline_response"; message: InlineSessionResponseFrameDto }
	| {
			type: "response_materialized";
			id: string;
			token: number;
			response: SessionCommandMachineResolvedResponse;
	  }
	| {
			type: "projection_advanced";
			sessionHandle: string;
			currentIdentity: SessionRuntimeIdentityDto | null;
			baselineAuthoritative: boolean;
			projectedSeq: number;
	  };

export type SessionCommandMachineIntent =
	| { type: "start_timer"; id: string; token: number; delayMs: number }
	| { type: "clear_timer"; id: string; token: number }
	| { type: "send"; message: CommandWireMessage; id: string; token: number }
	| {
			type: "start_materialization";
			id: string;
			token: number;
			message: SessionResponseFrameDto;
			history: boolean;
	  }
	| { type: "abort_materialization"; id: string; token: number }
	| {
			type: "resolve";
			id: string;
			token: number;
			resolve: (response: PiSessionCommandResponseDto) => void;
			response: PiSessionCommandResponseDto;
			resolveWithIdentity?: (completion: SessionCommandMachineCompletion) => void;
			completion: SessionCommandMachineCompletion;
	  }
	| {
			type: "reject";
			id: string;
			token: number;
			reject: (error: Error) => void;
			error: SessionCommandMachineError;
	  };

export interface SessionCommandMachineTransition {
	state: SessionCommandMachineState;
	intents: SessionCommandMachineIntent[];
	accepted: boolean;
	error?: SessionCommandMachineError;
}

const initialState: SessionCommandMachineState = {
	pending: {},
	nextCommandNumber: 0,
	nextPendingToken: 1,
};

function identityMatches(
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

function isMutation(command: SessionCommandDto): boolean {
	return !isReadOnlyRpcCommand(command);
}

function isIdentityTransitionCommand(commandType: SessionCommandDto["type"]): boolean {
	return commandType === "fork" || commandType === "clone";
}

function isResponseIdentityMatch(
	pending: SessionCommandMachinePending,
	message: SessionResponseFrameDto | InlineSessionResponseFrameDto,
): boolean {
	const originalTargetMatches =
		pending.serverEpoch === message.serverEpoch &&
		pending.sessionHandle === message.sessionHandle &&
		pending.generation === message.generation;
	const transitionTargetMatches =
		isIdentityTransitionCommand(pending.commandType) &&
		message.previousSessionHandle === pending.sessionHandle;
	return originalTargetMatches || transitionTargetMatches;
}

function responseKey(message: SessionResponseFrameDto): string {
	return JSON.stringify(message);
}

function transition(
	state: SessionCommandMachineState,
	intents: SessionCommandMachineIntent[] = [],
	accepted = false,
	error?: SessionCommandMachineError,
): SessionCommandMachineTransition {
	return { state, intents, accepted, ...(error ? { error } : {}) };
}

function rejectIntents(
	pending: SessionCommandMachinePending,
	error: SessionCommandMachineError,
): SessionCommandMachineIntent[] {
	return [
		...(pending.materializing
			? [{ type: "abort_materialization" as const, id: pending.id, token: pending.token }]
			: []),
		{ type: "clear_timer", id: pending.id, token: pending.token },
		{ type: "reject", id: pending.id, token: pending.token, reject: pending.reject, error },
	];
}

function resolveIntents(
	pending: SessionCommandMachinePending,
	completion: SessionCommandMachineCompletion,
): SessionCommandMachineIntent[] {
	return [
		{ type: "clear_timer", id: pending.id, token: pending.token },
		{
			type: "resolve",
			id: pending.id,
			token: pending.token,
			resolve: pending.resolve,
			resolveWithIdentity: pending.resolveWithIdentity,
			response: completion.response,
			completion,
		},
	];
}

function settleReject(
	state: SessionCommandMachineState,
	pending: SessionCommandMachinePending,
	error: SessionCommandMachineError,
): SessionCommandMachineTransition {
	const pendingState = { ...state.pending };
	delete pendingState[pending.id];
	return transition({ ...state, pending: pendingState }, rejectIntents(pending, error));
}

function settleResolve(
	state: SessionCommandMachineState,
	pending: SessionCommandMachinePending,
): SessionCommandMachineTransition {
	if (!pending.response) return transition(state);
	const pendingState = { ...state.pending };
	delete pendingState[pending.id];
	return transition(
		{ ...state, pending: pendingState },
		resolveIntents(pending, { ...pending.response, workspaceId: pending.workspaceId }),
	);
}

function gateError(code: SessionCommandMachineErrorCode, message?: string): SessionCommandMachineError {
	return { code, message: message ?? code };
}

export function createInitialSessionCommandMachineState(): SessionCommandMachineState {
	return {
		pending: { ...initialState.pending },
		nextCommandNumber: initialState.nextCommandNumber,
		nextPendingToken: initialState.nextPendingToken,
	};
}

export function reduceSessionCommandMachine(
	state: SessionCommandMachineState,
	event: SessionCommandMachineEvent,
): SessionCommandMachineTransition {
	switch (event.type) {
		case "request": {
			const mutation = isMutation(event.command);
			if (!event.subscribed) return transition(state, [], false, gateError("session_not_subscribed"));
			if (!event.online || !event.socketReady) return transition(state, [], false, gateError("unavailable"));
			if (event.generation === null) return transition(state, [], false, gateError("session_not_ready"));
			if (mutation && !event.baselineAuthoritative) {
				return transition(state, [], false, gateError("session_not_ready"));
			}
			if (mutation && (!event.isController || !event.fencingToken)) {
				return transition(state, [], false, gateError("session_read_only"));
			}
			if (mutation && !identityMatches(event.currentIdentity, event.freshLeaseBaseline)) {
				return transition(state, [], false, gateError("session_not_ready"));
			}
			const nextCommandNumber = state.nextCommandNumber + 1;
			const id = event.command.id ?? `session-ui-${String(nextCommandNumber)}-${event.now.toString(36)}`;
			const nextState = { ...state, nextCommandNumber };
			if (nextState.pending[id]) {
				return transition(nextState, [], false, gateError("duplicate_command_id"));
			}
			const currentIdentity = event.currentIdentity;
			const token = state.nextPendingToken;
			const pending: SessionCommandMachinePending = {
				id,
				token,
				serverEpoch: currentIdentity?.serverEpoch ?? "",
				workspaceId: currentIdentity?.workspaceId ?? "",
				sessionHandle: event.sessionHandle,
				generation: event.generation,
				commandType: event.command.type,
				materializing: false,
				resolve: event.resolve,
				resolveWithIdentity: event.resolveWithIdentity,
				reject: event.reject,
			};
			const nextPending = { ...nextState.pending, [id]: pending };
			const message: CommandWireMessage = {
				type: "command",
				sessionHandle: event.sessionHandle,
				expectedGeneration: event.generation,
				...(mutation ? { fencingToken: event.fencingToken } : {}),
				command: { ...event.command, id } as SessionCommandDto,
			};
			return transition(
				{ ...nextState, nextPendingToken: token + 1, pending: nextPending },
				[
					{
						type: "start_timer",
						id,
						token,
						delayMs: Math.max(0, event.timeoutMs),
					},
					{ type: "send", message, id, token },
				],
				true,
			);
		}
		case "send_failed": {
			const pending = state.pending[event.id];
			if (!pending || pending.token !== event.token) return transition(state);
			return settleReject(state, pending, event.error);
		}
		case "timeout": {
			const pending = state.pending[event.id];
			if (!pending || pending.token !== event.token) return transition(state);
			return settleReject(state, pending, gateError("timeout", `Command ${pending.commandType} timed out`));
		}
		case "reject": {
			const pending = state.pending[event.id];
			if (!pending || (event.token !== undefined && pending.token !== event.token)) return transition(state);
			return settleReject(state, pending, event.error);
		}
		case "reject_for_session": {
			let current = transition(state);
			for (const pending of Object.values(state.pending)) {
				if (
					pending.sessionHandle !== event.sessionHandle &&
					pending.response?.sessionHandle !== event.sessionHandle
				) {
					continue;
				}
				const result = settleReject(current.state, current.state.pending[pending.id] ?? pending, event.error);
				current = {
					state: result.state,
					intents: [...current.intents, ...result.intents],
					accepted: true,
				};
			}
			return current;
		}
		case "reject_all": {
			let current = transition(state);
			for (const pending of Object.values(state.pending)) {
				const result = settleReject(current.state, current.state.pending[pending.id] ?? pending, event.error);
				current = {
					state: result.state,
					intents: [...current.intents, ...result.intents],
					accepted: true,
				};
			}
			return current;
		}
		case "wire_response": {
			const id = event.message.response.id;
			if (!id) return transition(state);
			const pending = state.pending[id];
			if (!pending) return transition(state, [], true);
			if (
				pending.commandType !== event.message.response.command ||
				!isResponseIdentityMatch(pending, event.message)
			) {
				return {
					...settleReject(
						state,
						pending,
						gateError(
							"response_mismatch",
							`Response ${id} targeted ${event.message.sessionHandle}@${String(event.message.generation)}`,
						),
					),
					accepted: true,
				};
			}
			if (event.history) {
				const key = responseKey(event.message);
				if (pending.responseKey !== undefined) {
					if (pending.responseKey === key) return transition(state, [], true);
					return {
						...settleReject(
							state,
							pending,
							gateError(
								"response_mismatch",
								`Response ${id} changed while content history was materializing`,
							),
						),
						accepted: true,
					};
				}
				const nextPending = {
					...pending,
					responseKey: key,
					historyBarrierSeq: event.message.barrierSeq,
					materializing: true,
				};
				return transition(
					{ ...state, pending: { ...state.pending, [id]: nextPending } },
					[
						{
							type: "start_materialization",
							id,
							token: pending.token,
							message: event.message,
							history: true,
						},
					],
					true,
				);
			}
			const nextPending = { ...pending, materializing: true };
			return transition(
				{ ...state, pending: { ...state.pending, [id]: nextPending } },
				[{ type: "start_materialization", id, token: pending.token, message: event.message, history: false }],
				true,
			);
		}
		case "inline_response": {
			const id = event.message.response.id;
			if (!id) return transition(state);
			const pending = state.pending[id];
			if (!pending) return transition(state, [], true);
			if (
				pending.commandType !== event.message.response.command ||
				!isResponseIdentityMatch(pending, event.message)
			) {
				return {
					...settleReject(
						state,
						pending,
						gateError(
							"response_mismatch",
							`Response ${id} targeted ${event.message.sessionHandle}@${String(event.message.generation)}`,
						),
					),
					accepted: true,
				};
			}
			const response: SessionCommandMachineResolvedResponse = {
				...event.message,
			};
			const nextPending: SessionCommandMachinePending = {
				...pending,
				response,
				materializing: false,
				historyBarrierSeq: undefined,
				responseKey: undefined,
			};
			return transition(
				{ ...state, pending: { ...state.pending, [id]: nextPending } },
				[{ type: "abort_materialization", id, token: pending.token }],
				true,
			);
		}
		case "response_materialized": {
			const pending = state.pending[event.id];
			if (!pending || pending.token !== event.token) return transition(state);
			const nextPending = {
				...pending,
				response: event.response,
				materializing: false,
			};
			return transition({ ...state, pending: { ...state.pending, [event.id]: nextPending } }, [], true);
		}
		case "projection_advanced": {
			if (!event.baselineAuthoritative || !event.currentIdentity) return transition(state);
			let current = transition(state);
			for (const pending of Object.values(state.pending)) {
				const candidate = current.state.pending[pending.id];
				const response = candidate?.response;
				if (
					!candidate ||
					!response ||
					candidate.materializing ||
					response.serverEpoch !== event.currentIdentity.serverEpoch ||
					response.sessionHandle !== event.currentIdentity.sessionHandle ||
					response.generation !== event.currentIdentity.generation ||
					event.currentIdentity.workspaceId !== candidate.workspaceId ||
					event.projectedSeq < response.barrierSeq
				) {
					continue;
				}
				const result = settleResolve(current.state, candidate);
				current = {
					state: result.state,
					intents: [...current.intents, ...result.intents],
					accepted: true,
				};
			}
			return current;
		}
	}
}

export interface SessionCommandMachine {
	getState: () => SessionCommandMachineState;
	getPending: (id: string) => SessionCommandMachinePending | undefined;
	transition: (event: SessionCommandMachineEvent) => SessionCommandMachineTransition;
}

export function createSessionCommandMachine(
	initial: SessionCommandMachineState = createInitialSessionCommandMachineState(),
): SessionCommandMachine {
	let state = initial;
	return {
		getState: () => state,
		getPending: (id) => state.pending[id],
		transition: (event) => {
			const next = reduceSessionCommandMachine(state, event);
			state = next.state;
			return next;
		},
	};
}
