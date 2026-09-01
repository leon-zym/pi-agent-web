import type {
	InlineSessionReplayFrameDto,
	PiExtensionUiRequestDto,
	SessionRuntimeIdentityDto,
} from "@pi-agent-web/protocol";
import type { ProjectedSessionReplayFrame } from "../lib/session-content-adapter";

const MAX_PENDING_EXTENSION_REQUESTS = 256;
const MAX_DELIVERED_NOTIFY_KEYS = 256;
const MAX_DELIVERED_NOTIFY_IDENTITIES = 64;

export type ExtensionReplayFrame = Extract<
	InlineSessionReplayFrameDto | ProjectedSessionReplayFrame,
	{ type: "extension_ui_request" | "extension_ui_closed" }
>;

export interface SessionExtensionMachineSessionState {
	identity: SessionRuntimeIdentityDto | null;
	pending: readonly PiExtensionUiRequestDto[];
	acknowledgedRequestIds: readonly string[];
	deliveredNotifyKeys: readonly string[];
}

export interface SessionExtensionMachineState {
	sessions: Readonly<Record<string, SessionExtensionMachineSessionState>>;
	deliveredNotifyIdentityOrder: readonly string[];
}

export type SessionExtensionMachineEvent =
	| {
			type: "hydrate";
			identity: SessionRuntimeIdentityDto;
			pending: readonly PiExtensionUiRequestDto[];
	  }
	| {
			type: "replay";
			identity: SessionRuntimeIdentityDto;
			frame: ExtensionReplayFrame;
			notifyDelivered?: boolean;
	  }
	| {
			type: "replace_snapshot" | "replace_extension_snapshot";
			identity: SessionRuntimeIdentityDto;
			requests: readonly PiExtensionUiRequestDto[];
	  }
	| {
			type: "result";
			identity: SessionRuntimeIdentityDto;
			requestId: string;
			resyncing: boolean;
	  }
	| { type: "clear_acknowledged"; identity: SessionRuntimeIdentityDto }
	| { type: "clear_notify"; identity: SessionRuntimeIdentityDto }
	| { type: "clear_notify_session"; sessionHandle: string }
	| { type: "reset"; sessionHandle: string }
	| {
			type: "rekey";
			previousSessionHandle: string;
			identity: SessionRuntimeIdentityDto;
	  };

export type SessionExtensionMachineIntent =
	| {
			type: "pending_changed";
			sessionHandle: string;
			requests: readonly PiExtensionUiRequestDto[];
	  }
	| {
			type: "notify_delivered" | "notify_deduped";
			sessionHandle: string;
			key: string;
	  };

export interface SessionExtensionMachineTransition {
	state: SessionExtensionMachineState;
	intents: SessionExtensionMachineIntent[];
}

const emptySession = (): SessionExtensionMachineSessionState => ({
	identity: null,
	pending: [],
	acknowledgedRequestIds: [],
	deliveredNotifyKeys: [],
});

export function extensionIdentityMatches(
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
	return null;
}

function replaceRequest(
	requests: readonly PiExtensionUiRequestDto[],
	request: PiExtensionUiRequestDto,
): PiExtensionUiRequestDto[] {
	const semanticKey = extensionRequestSemanticKey(request);
	if (semanticKey === null) return [...requests];
	return [
		...requests.filter(
			(candidate) => candidate.id !== request.id && extensionRequestSemanticKey(candidate) !== semanticKey,
		),
		request,
	].slice(-MAX_PENDING_EXTENSION_REQUESTS);
}

export function normalizeExtensionRequests(
	requests: readonly PiExtensionUiRequestDto[],
): PiExtensionUiRequestDto[] {
	let normalized: PiExtensionUiRequestDto[] = [];
	for (const request of requests) normalized = replaceRequest(normalized, request);
	return normalized;
}

function sessionFor(
	state: SessionExtensionMachineState,
	identity: SessionRuntimeIdentityDto,
): SessionExtensionMachineSessionState {
	const current = state.sessions[identity.sessionHandle];
	return current && extensionIdentityMatches(current.identity, identity)
		? current
		: { ...emptySession(), identity };
}

function withSession(
	state: SessionExtensionMachineState,
	sessionHandle: string,
	session: SessionExtensionMachineSessionState | null,
): SessionExtensionMachineState {
	const sessions = { ...state.sessions };
	if (session) sessions[sessionHandle] = session;
	else delete sessions[sessionHandle];
	return { ...state, sessions };
}

function clearNotifyKeys(
	state: SessionExtensionMachineState,
	sessionHandle: string,
): SessionExtensionMachineState {
	const current = state.sessions[sessionHandle];
	return current ? withSession(state, sessionHandle, { ...current, deliveredNotifyKeys: [] }) : state;
}

function withPending(
	state: SessionExtensionMachineState,
	identity: SessionRuntimeIdentityDto,
	pending: readonly PiExtensionUiRequestDto[],
): SessionExtensionMachineState {
	return withSession(state, identity.sessionHandle, {
		...sessionFor(state, identity),
		identity,
		pending: [...pending],
	});
}

export function extensionNotifyKey(frame: ExtensionReplayFrame): string {
	if (frame.type === "extension_ui_request") return `${String(frame.seq)}:${frame.request.id}`;
	return `${String(frame.seq)}:${frame.requestId}`;
}

function rememberNotify(
	state: SessionExtensionMachineState,
	identity: SessionRuntimeIdentityDto,
	key: string,
): { state: SessionExtensionMachineState; duplicate: boolean } {
	const current = sessionFor(state, identity);
	if (current.deliveredNotifyKeys.includes(key)) return { state, duplicate: true };
	let identityOrder = state.deliveredNotifyIdentityOrder.filter(
		(sessionHandle) => sessionHandle !== identity.sessionHandle,
	);
	let sessions = state;
	if (!extensionIdentityMatches(current.identity, identity)) {
		identityOrder = [...identityOrder, identity.sessionHandle];
		sessions = withSession(sessions, identity.sessionHandle, { ...current, identity });
	} else {
		identityOrder = [...identityOrder, identity.sessionHandle];
	}
	const notifyKeys = [...sessionFor(sessions, identity).deliveredNotifyKeys, key].slice(
		-MAX_DELIVERED_NOTIFY_KEYS,
	);
	sessions = withSession(sessions, identity.sessionHandle, {
		...sessionFor(sessions, identity),
		identity,
		deliveredNotifyKeys: notifyKeys,
	});
	while (identityOrder.length > MAX_DELIVERED_NOTIFY_IDENTITIES) {
		const oldest = identityOrder.shift();
		if (oldest && oldest !== identity.sessionHandle) sessions = clearNotifyKeys(sessions, oldest);
	}
	return {
		state: { ...sessions, deliveredNotifyIdentityOrder: identityOrder },
		duplicate: false,
	};
}

const initialState: SessionExtensionMachineState = {
	sessions: {},
	deliveredNotifyIdentityOrder: [],
};

export function reduceSessionExtensionMachine(
	state: SessionExtensionMachineState,
	event: SessionExtensionMachineEvent,
): SessionExtensionMachineTransition {
	const intents: SessionExtensionMachineIntent[] = [];
	switch (event.type) {
		case "hydrate": {
			const current = state.sessions[event.identity.sessionHandle];
			if (current && extensionIdentityMatches(current.identity, event.identity)) return { state, intents };
			const next = withSession(state, event.identity.sessionHandle, {
				...emptySession(),
				identity: event.identity,
				pending: normalizeExtensionRequests(event.pending),
			});
			return {
				state: next,
				intents: [
					{
						type: "pending_changed",
						sessionHandle: event.identity.sessionHandle,
						requests: next.sessions[event.identity.sessionHandle]?.pending ?? [],
					},
				],
			};
		}
		case "replay": {
			const current = sessionFor(state, event.identity);
			if (event.frame.type === "extension_ui_request" && event.frame.request.method === "notify") {
				if (event.notifyDelivered === false) return { state, intents };
				const key = extensionNotifyKey(event.frame);
				const remembered = rememberNotify(state, event.identity, key);
				return {
					state: remembered.state,
					intents: [
						{
							type: remembered.duplicate ? "notify_deduped" : "notify_delivered",
							sessionHandle: event.identity.sessionHandle,
							key,
						},
					],
				};
			}
			const pending =
				event.frame.type === "extension_ui_request"
					? replaceRequest(current.pending, event.frame.request)
					: current.pending.filter(
							(request) =>
								request.id !==
								(event.frame as Extract<ExtensionReplayFrame, { type: "extension_ui_closed" }>).requestId,
						);
			const next = withSession(state, event.identity.sessionHandle, {
				...current,
				identity: event.identity,
				pending,
			});
			return {
				state: next,
				intents: [
					{ type: "pending_changed", sessionHandle: event.identity.sessionHandle, requests: pending },
				],
			};
		}
		case "replace_snapshot":
		case "replace_extension_snapshot": {
			const pending = normalizeExtensionRequests(event.requests);
			const next = withPending(state, event.identity, pending);
			return {
				state: next,
				intents: [
					{ type: "pending_changed", sessionHandle: event.identity.sessionHandle, requests: pending },
				],
			};
		}
		case "result": {
			const current = sessionFor(state, event.identity);
			const acknowledgedRequestIds = event.resyncing
				? [...new Set([...current.acknowledgedRequestIds, event.requestId])]
				: current.acknowledgedRequestIds;
			const pending = current.pending.filter((request) => request.id !== event.requestId);
			const next = withSession(state, event.identity.sessionHandle, {
				...current,
				identity: event.identity,
				pending,
				acknowledgedRequestIds,
			});
			return {
				state: next,
				intents: [
					{ type: "pending_changed", sessionHandle: event.identity.sessionHandle, requests: pending },
				],
			};
		}
		case "clear_acknowledged": {
			const current = state.sessions[event.identity.sessionHandle];
			if (!current || !extensionIdentityMatches(current.identity, event.identity)) return { state, intents };
			const next = withSession(state, event.identity.sessionHandle, {
				...current,
				acknowledgedRequestIds: [],
			});
			return { state: next, intents };
		}
		case "clear_notify": {
			const current = state.sessions[event.identity.sessionHandle];
			if (!current || !extensionIdentityMatches(current.identity, event.identity)) return { state, intents };
			const next = clearNotifyKeys(state, event.identity.sessionHandle);
			return {
				state: {
					...next,
					deliveredNotifyIdentityOrder: next.deliveredNotifyIdentityOrder.filter(
						(handle) => handle !== event.identity.sessionHandle,
					),
				},
				intents,
			};
		}
		case "clear_notify_session": {
			const current = state.sessions[event.sessionHandle];
			if (!current) return { state, intents };
			const next = clearNotifyKeys(state, event.sessionHandle);
			return {
				state: {
					...next,
					deliveredNotifyIdentityOrder: next.deliveredNotifyIdentityOrder.filter(
						(handle) => handle !== event.sessionHandle,
					),
				},
				intents,
			};
		}
		case "reset":
			return {
				state: {
					...withSession(state, event.sessionHandle, null),
					deliveredNotifyIdentityOrder: state.deliveredNotifyIdentityOrder.filter(
						(handle) => handle !== event.sessionHandle,
					),
				},
				intents,
			};
		case "rekey": {
			let next = withSession(state, event.previousSessionHandle, null);
			next = withSession(next, event.identity.sessionHandle, null);
			return {
				state: {
					...next,
					deliveredNotifyIdentityOrder: next.deliveredNotifyIdentityOrder.filter(
						(handle) => handle !== event.previousSessionHandle && handle !== event.identity.sessionHandle,
					),
				},
				intents,
			};
		}
	}
}

export interface SessionExtensionMachine {
	getState: () => SessionExtensionMachineState;
	getSession: (sessionHandle: string) => SessionExtensionMachineSessionState | undefined;
	transition: (event: SessionExtensionMachineEvent) => SessionExtensionMachineTransition;
}

export function createSessionExtensionMachine(
	initial: SessionExtensionMachineState = initialState,
): SessionExtensionMachine {
	let state = initial;
	return {
		getState: () => state,
		getSession: (sessionHandle) => state.sessions[sessionHandle],
		transition: (event) => {
			const transition = reduceSessionExtensionMachine(state, event);
			state = transition.state;
			return transition;
		},
	};
}
