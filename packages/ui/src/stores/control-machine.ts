import type {
	SessionLeaseStatusDto,
	SessionRuntimeDto,
	SessionRuntimeIdentityDto,
	SessionWsClientMessage,
} from "@pi-agent-web/protocol";
import type { SessionLeaseState } from "./session-transport-contract";

type LeaseStatusMessage = SessionLeaseStatusDto;
type ControlWireMessage = Extract<
	SessionWsClientMessage,
	{ type: "session_claim" | "session_release" | "session_takeover" }
>;

export interface SessionControlMachineSessionState {
	subscribed: boolean;
	controllerIntent: boolean;
	freshLeaseBaseline: SessionRuntimeIdentityDto | null;
	lease: SessionLeaseState;
	claimPending: boolean;
	takeoverAttempt: {
		identity: SessionRuntimeIdentityDto;
		leaseRevision: number;
	} | null;
	released: boolean;
	subscriptionBaseline?: string | null;
	pendingLeaseStatus: {
		message: LeaseStatusMessage;
		expectedBaseline: boolean;
	} | null;
}

export interface SessionControlMachineState {
	sessions: Record<string, SessionControlMachineSessionState>;
}

export type SessionControlMachineEvent =
	| {
			type: "hydrate";
			sessionHandle: string;
			subscribed: boolean;
			controllerIntent: boolean;
			freshLeaseBaseline: SessionRuntimeIdentityDto | null;
			lease: SessionLeaseState;
	  }
	| { type: "subscribe"; sessionHandle: string }
	| { type: "unsubscribe"; sessionHandle: string }
	| { type: "remove"; sessionHandle: string }
	| { type: "connection_reset" }
	| { type: "runtime_reset"; sessionHandle: string }
	| { type: "resync_reset"; sessionHandle: string; identityChanged: boolean }
	| { type: "projection_failed"; sessionHandle: string }
	| {
			type: "subscription_started";
			sessionHandle: string;
			expectedIdentity: string | null;
	  }
	| { type: "subscription_send_failed"; sessionHandle: string }
	| { type: "claim_intent"; sessionHandle: string }
	| { type: "clear_intent"; sessionHandle: string }
	| { type: "claim_settled"; sessionHandle: string }
	| {
			type: "claim_if_ready";
			sessionHandle: string;
			online: boolean;
			baselineAuthoritative: boolean;
			currentIdentity: SessionRuntimeIdentityDto | null;
	  }
	| { type: "claim_send_failed"; sessionHandle: string }
	| { type: "release"; sessionHandle: string; online: boolean }
	| {
			type: "takeover";
			sessionHandle: string;
			online: boolean;
			baselineAuthoritative: boolean;
			currentIdentity: SessionRuntimeIdentityDto | null;
			runtime: SessionRuntimeDto | null;
			resync: boolean;
	  }
	| { type: "takeover_send_failed"; sessionHandle: string }
	| {
			type: "lease_status";
			sessionHandle: string;
			message: LeaseStatusMessage;
			currentIdentity: SessionRuntimeIdentityDto | null;
			baselineAuthoritative: boolean;
			expectedBaseline?: boolean;
	  }
	| { type: "baseline_committed"; identity: SessionRuntimeIdentityDto }
	| {
			type: "subscribe_error";
			sessionHandle: string;
			preserveSubscribed: boolean;
			preserveLease: boolean;
	  }
	| { type: "claim_error"; sessionHandle: string }
	| {
			type: "takeover_error";
			sessionHandle: string;
			currentIdentity: SessionRuntimeIdentityDto | null;
			currentLeaseRevision?: number;
	  }
	| {
			type: "rekey";
			previousSessionHandle: string;
			sessionHandle: string;
			identity: SessionRuntimeIdentityDto;
			baselineInFlight: boolean;
	  };

export type SessionControlMachineIntent =
	| {
			type: "send";
			message: ControlWireMessage;
			onFailure: "claim" | "takeover" | null;
	  }
	| { type: "emit_lease_status"; message: LeaseStatusMessage };

export interface SessionControlMachineTransition {
	state: SessionControlMachineState;
	intents: SessionControlMachineIntent[];
	changedSessionHandles: string[];
	accepted: boolean;
	leaseAccepted: boolean;
	leaseConflict: boolean;
}

const initialState: SessionControlMachineState = { sessions: {} };

function emptySession(): SessionControlMachineSessionState {
	return {
		subscribed: false,
		controllerIntent: false,
		freshLeaseBaseline: null,
		lease: { isController: false },
		claimPending: false,
		takeoverAttempt: null,
		released: false,
		pendingLeaseStatus: null,
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

function leaseStateFrom(message: LeaseStatusMessage): SessionLeaseState {
	return {
		isController: message.isController,
		...(message.fencingToken ? { fencingToken: message.fencingToken } : {}),
		leaseRevision: message.leaseRevision,
		controlState: message.controlState,
		transition: message.transition,
	};
}

function leaseStatusSemanticsMatchState(message: LeaseStatusMessage, state: SessionLeaseState): boolean {
	return (
		state.conflicted !== true &&
		state.leaseRevision === message.leaseRevision &&
		state.controlState === message.controlState &&
		state.isController === message.isController &&
		state.fencingToken === message.fencingToken
	);
}

function leaseStatusMatchesState(message: LeaseStatusMessage, state: SessionLeaseState): boolean {
	return leaseStatusSemanticsMatchState(message, state) && state.transition === message.transition;
}

function hasFreshBaseline(
	session: SessionControlMachineSessionState,
	currentIdentity: SessionRuntimeIdentityDto | null,
): boolean {
	return identitiesMatch(session.freshLeaseBaseline, currentIdentity);
}

function clearFenceLease(lease: SessionLeaseState): SessionLeaseState {
	return {
		isController: false,
		...(lease.leaseRevision === undefined ? {} : { leaseRevision: lease.leaseRevision }),
		...(lease.controlState === undefined ? {} : { controlState: lease.controlState }),
		...(lease.transition === undefined ? {} : { transition: lease.transition }),
	};
}

function failClosedLease(message: LeaseStatusMessage): SessionLeaseState {
	return {
		isController: false,
		leaseRevision: message.leaseRevision,
		controlState: message.controlState,
		transition: message.transition,
		conflicted: true,
	};
}

function updateSession(
	state: SessionControlMachineState,
	sessionHandle: string,
	update: (session: SessionControlMachineSessionState) => SessionControlMachineSessionState,
): { state: SessionControlMachineState; changed: string[] } {
	const current = state.sessions[sessionHandle] ?? emptySession();
	const next = update(current);
	if (next === current) return { state, changed: [] };
	return {
		state: { sessions: { ...state.sessions, [sessionHandle]: next } },
		changed: [sessionHandle],
	};
}

function transitionResult(
	state: SessionControlMachineState,
	intents: SessionControlMachineIntent[] = [],
	changedSessionHandles: string[] = [],
	accepted = false,
	leaseAccepted = false,
	leaseConflict = false,
): SessionControlMachineTransition {
	return { state, intents, changedSessionHandles, accepted, leaseAccepted, leaseConflict };
}

function mergeTransitions(
	first: SessionControlMachineTransition,
	second: SessionControlMachineTransition,
): SessionControlMachineTransition {
	return {
		state: second.state,
		intents: [...first.intents, ...second.intents],
		changedSessionHandles: [...new Set([...first.changedSessionHandles, ...second.changedSessionHandles])],
		accepted: first.accepted || second.accepted,
		leaseAccepted: first.leaseAccepted || second.leaseAccepted,
		leaseConflict: first.leaseConflict || second.leaseConflict,
	};
}

function reduceLeaseStatus(
	state: SessionControlMachineState,
	event: Extract<SessionControlMachineEvent, { type: "lease_status" }>,
): SessionControlMachineTransition {
	const session = state.sessions[event.sessionHandle];
	const currentIdentity = event.currentIdentity;
	if (
		!session?.subscribed ||
		!currentIdentity ||
		currentIdentity.serverEpoch !== event.message.serverEpoch ||
		currentIdentity.generation !== event.message.generation
	) {
		return transitionResult(state);
	}

	const expectedFromSubscription = session.subscriptionBaseline;
	const controlledBaseline =
		event.expectedBaseline === true ||
		(event.message.transition === "baseline" &&
			expectedFromSubscription !== undefined &&
			(expectedFromSubscription === null || expectedFromSubscription === identityKey(currentIdentity)));

	if (!event.baselineAuthoritative) {
		const pending = session.pendingLeaseStatus;
		if (!pending || event.message.leaseRevision > pending.message.leaseRevision) {
			const updated = updateSession(state, event.sessionHandle, (current) => ({
				...current,
				pendingLeaseStatus: {
					message: event.message,
					expectedBaseline: controlledBaseline,
				},
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		if (
			event.message.leaseRevision === pending.message.leaseRevision &&
			!leaseStatusMatchesState(event.message, leaseStateFrom(pending.message))
		) {
			const updated = updateSession(state, event.sessionHandle, (current) => ({
				...current,
				pendingLeaseStatus: null,
				freshLeaseBaseline: null,
				claimPending: false,
				takeoverAttempt: null,
				lease: failClosedLease(event.message),
			}));
			return transitionResult(updated.state, [], updated.changed, false, false, true);
		}
		return transitionResult(state);
	}

	if (event.message.isController && session.released) {
		return transitionResult(state, [
			{
				type: "send",
				message: { type: "session_release", sessionHandle: event.sessionHandle },
				onFailure: null,
			},
		]);
	}

	const knownRevision = session.lease.leaseRevision;
	let preserveTransitionProvenance = false;
	if (knownRevision !== undefined) {
		if (event.message.leaseRevision < knownRevision) return transitionResult(state);
		if (event.message.leaseRevision === knownRevision) {
			if (leaseStatusMatchesState(event.message, session.lease)) {
				if (hasFreshBaseline(session, currentIdentity)) return transitionResult(state);
			} else if (controlledBaseline && leaseStatusSemanticsMatchState(event.message, session.lease)) {
				preserveTransitionProvenance = true;
			} else {
				const updated = updateSession(state, event.sessionHandle, (current) => ({
					...current,
					freshLeaseBaseline: null,
					claimPending: false,
					takeoverAttempt: null,
					lease: failClosedLease(event.message),
				}));
				return transitionResult(updated.state, [], updated.changed, false, false, true);
			}
		}
	}

	const updated = updateSession(state, event.sessionHandle, (current) => {
		const baselineMatches =
			current.subscriptionBaseline === null ||
			(current.subscriptionBaseline !== undefined &&
				current.subscriptionBaseline === identityKey(currentIdentity));
		return {
			...current,
			freshLeaseBaseline: currentIdentity,
			released: event.message.isController ? current.released : false,
			takeoverAttempt: null,
			subscriptionBaseline: baselineMatches ? undefined : current.subscriptionBaseline,
			lease: preserveTransitionProvenance ? current.lease : leaseStateFrom(event.message),
			pendingLeaseStatus: null,
		};
	});
	return transitionResult(
		updated.state,
		[{ type: "emit_lease_status", message: event.message }],
		updated.changed,
		true,
		true,
	);
}

export function createInitialSessionControlMachineState(): SessionControlMachineState {
	return { sessions: { ...initialState.sessions } };
}

export function reduceSessionControlMachine(
	state: SessionControlMachineState,
	event: SessionControlMachineEvent,
): SessionControlMachineTransition {
	switch (event.type) {
		case "hydrate": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				subscribed: event.subscribed,
				controllerIntent: event.controllerIntent,
				freshLeaseBaseline: event.freshLeaseBaseline,
				lease: event.lease,
				claimPending: false,
				takeoverAttempt: null,
				released: false,
				subscriptionBaseline: undefined,
				pendingLeaseStatus: null,
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "subscribe": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				subscribed: true,
				freshLeaseBaseline: null,
			}));
			return transitionResult(updated.state, [], updated.changed, true);
		}
		case "unsubscribe": {
			const updated = updateSession(state, event.sessionHandle, () => emptySession());
			return transitionResult(updated.state, [], updated.changed, true);
		}
		case "remove": {
			if (!(event.sessionHandle in state.sessions)) return transitionResult(state);
			const sessions = { ...state.sessions };
			delete sessions[event.sessionHandle];
			return transitionResult({ sessions }, [], [event.sessionHandle], true);
		}
		case "connection_reset": {
			const sessions: Record<string, SessionControlMachineSessionState> = {};
			const changed: string[] = [];
			for (const [sessionHandle, session] of Object.entries(state.sessions)) {
				sessions[sessionHandle] = {
					...session,
					freshLeaseBaseline: null,
					lease: { isController: false },
					claimPending: false,
					takeoverAttempt: null,
					released: false,
					subscriptionBaseline: undefined,
					pendingLeaseStatus: null,
				};
				changed.push(sessionHandle);
			}
			return transitionResult({ sessions }, [], changed);
		}
		case "runtime_reset": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				freshLeaseBaseline: null,
				lease: { isController: false },
				claimPending: false,
				takeoverAttempt: null,
				subscriptionBaseline: undefined,
				pendingLeaseStatus: null,
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "resync_reset": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				freshLeaseBaseline: null,
				...(event.identityChanged
					? {
							lease: { isController: false } as SessionLeaseState,
							claimPending: false,
							takeoverAttempt: null,
							subscriptionBaseline: undefined,
							pendingLeaseStatus: null,
						}
					: {}),
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "projection_failed": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				freshLeaseBaseline: null,
				subscriptionBaseline: undefined,
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "subscription_started": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				freshLeaseBaseline: null,
				subscriptionBaseline: event.expectedIdentity,
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "subscription_send_failed": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				subscriptionBaseline: undefined,
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "claim_intent": {
			const session = state.sessions[event.sessionHandle];
			if (!session?.subscribed || session.takeoverAttempt !== null) return transitionResult(state);
			const updated = updateSession(state, event.sessionHandle, (current) => ({
				...current,
				controllerIntent: true,
				released: false,
			}));
			return transitionResult(updated.state, [], updated.changed, true);
		}
		case "clear_intent": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				controllerIntent: false,
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "claim_settled": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				claimPending: false,
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "claim_if_ready": {
			const session = state.sessions[event.sessionHandle];
			if (
				!session?.subscribed ||
				!event.online ||
				!session.controllerIntent ||
				!event.baselineAuthoritative ||
				!event.currentIdentity ||
				!hasFreshBaseline(session, event.currentIdentity) ||
				session.lease.isController ||
				session.claimPending ||
				session.subscriptionBaseline !== undefined
			) {
				return transitionResult(state);
			}
			const updated = updateSession(state, event.sessionHandle, (current) => ({
				...current,
				claimPending: true,
			}));
			return transitionResult(
				updated.state,
				[
					{
						type: "send",
						message: { type: "session_claim", sessionHandle: event.sessionHandle },
						onFailure: "claim",
					},
				],
				updated.changed,
				true,
			);
		}
		case "claim_send_failed": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				claimPending: false,
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "release": {
			const session = state.sessions[event.sessionHandle];
			if (!session?.subscribed) return transitionResult(state);
			const updated = updateSession(state, event.sessionHandle, (current) => ({
				...current,
				controllerIntent: false,
				freshLeaseBaseline: null,
				lease: clearFenceLease(current.lease),
				claimPending: false,
				takeoverAttempt: null,
				released: true,
			}));
			const intents: SessionControlMachineIntent[] = event.online
				? [
						{
							type: "send",
							message: { type: "session_release", sessionHandle: event.sessionHandle },
							onFailure: null,
						},
					]
				: [];
			return transitionResult(updated.state, intents, updated.changed, true);
		}
		case "takeover": {
			const session = state.sessions[event.sessionHandle];
			const runtime = event.runtime;
			const leaseRevision = session?.lease.leaseRevision;
			if (
				!session?.subscribed ||
				!event.online ||
				!event.baselineAuthoritative ||
				!event.currentIdentity ||
				!runtime ||
				runtime.state === "dormant" ||
				runtime.sessionFile === null ||
				!hasFreshBaseline(session, event.currentIdentity) ||
				event.resync ||
				session.lease.conflicted === true ||
				session.lease.isController ||
				session.lease.controlState !== "held" ||
				typeof leaseRevision !== "number" ||
				!Number.isSafeInteger(leaseRevision) ||
				session.claimPending ||
				session.takeoverAttempt !== null ||
				session.subscriptionBaseline !== undefined
			) {
				return transitionResult(state);
			}
			const updated = updateSession(state, event.sessionHandle, (current) => ({
				...current,
				takeoverAttempt: { identity: event.currentIdentity as SessionRuntimeIdentityDto, leaseRevision },
			}));
			return transitionResult(
				updated.state,
				[
					{
						type: "send",
						message: {
							type: "session_takeover",
							sessionHandle: event.sessionHandle,
							expectedGeneration: event.currentIdentity.generation,
							expectedLeaseRevision: leaseRevision,
						},
						onFailure: "takeover",
					},
				],
				updated.changed,
				true,
			);
		}
		case "takeover_send_failed": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				takeoverAttempt: null,
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "lease_status":
			return reduceLeaseStatus(state, event);
		case "baseline_committed": {
			const session = state.sessions[event.identity.sessionHandle];
			const pending = session?.pendingLeaseStatus;
			if (
				!session ||
				!pending ||
				pending.message.serverEpoch !== event.identity.serverEpoch ||
				pending.message.generation !== event.identity.generation
			) {
				return transitionResult(state);
			}
			const cleared = updateSession(state, event.identity.sessionHandle, (current) => ({
				...current,
				pendingLeaseStatus: null,
			}));
			const replay = reduceLeaseStatus(cleared.state, {
				type: "lease_status",
				sessionHandle: event.identity.sessionHandle,
				message: pending.message,
				currentIdentity: event.identity,
				baselineAuthoritative: true,
				expectedBaseline: pending.expectedBaseline,
			});
			return mergeTransitions(transitionResult(cleared.state, [], cleared.changed), replay);
		}
		case "subscribe_error": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				claimPending: false,
				takeoverAttempt: null,
				subscriptionBaseline: undefined,
				pendingLeaseStatus: null,
				...(event.preserveSubscribed
					? event.preserveLease
						? {}
						: { freshLeaseBaseline: null, lease: { isController: false } as SessionLeaseState }
					: {
							subscribed: false,
							freshLeaseBaseline: null,
							lease: { isController: false } as SessionLeaseState,
						}),
			}));
			return transitionResult(updated.state, [], updated.changed, true);
		}
		case "claim_error": {
			const updated = updateSession(state, event.sessionHandle, (session) => ({
				...session,
				claimPending: false,
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "takeover_error": {
			const session = state.sessions[event.sessionHandle];
			if (!session) return transitionResult(state);
			const attempt = session.takeoverAttempt;
			const stale =
				!attempt ||
				!identitiesMatch(event.currentIdentity, attempt.identity) ||
				(typeof event.currentLeaseRevision === "number" &&
					event.currentLeaseRevision > attempt.leaseRevision);
			const updated = updateSession(state, event.sessionHandle, (current) => ({
				...current,
				takeoverAttempt: null,
				...(stale ? {} : { freshLeaseBaseline: null, lease: clearFenceLease(current.lease) }),
			}));
			return transitionResult(updated.state, [], updated.changed);
		}
		case "rekey": {
			const previous = state.sessions[event.previousSessionHandle];
			if (!previous?.subscribed) return transitionResult(state);
			if (event.previousSessionHandle === event.sessionHandle) {
				const updated = updateSession(state, event.sessionHandle, (session) => ({
					...session,
					subscribed: true,
					freshLeaseBaseline: null,
					lease: { isController: false },
					claimPending: false,
					takeoverAttempt: null,
					subscriptionBaseline: event.baselineInFlight ? identityKey(event.identity) : undefined,
					pendingLeaseStatus: null,
				}));
				return transitionResult(updated.state, [], updated.changed);
			}
			const dormant: SessionControlMachineSessionState = {
				...previous,
				subscribed: false,
				controllerIntent: false,
				freshLeaseBaseline: null,
				lease: { isController: false },
				claimPending: false,
				takeoverAttempt: null,
				released: false,
				subscriptionBaseline: undefined,
				pendingLeaseStatus: null,
			};
			const migrated: SessionControlMachineSessionState = {
				...previous,
				subscribed: true,
				freshLeaseBaseline: null,
				lease: { isController: false },
				claimPending: false,
				takeoverAttempt: null,
				subscriptionBaseline: event.baselineInFlight ? identityKey(event.identity) : undefined,
				pendingLeaseStatus: null,
			};
			const sessions = {
				...state.sessions,
				[event.previousSessionHandle]: dormant,
				[event.sessionHandle]: migrated,
			};
			return transitionResult({ sessions }, [], [event.previousSessionHandle, event.sessionHandle], true);
		}
	}
}

export interface SessionControlMachine {
	getState: () => SessionControlMachineState;
	getSession: (sessionHandle: string) => SessionControlMachineSessionState | undefined;
	transition: (event: SessionControlMachineEvent) => SessionControlMachineTransition;
}

export function createSessionControlMachine(
	initial: SessionControlMachineState = createInitialSessionControlMachineState(),
): SessionControlMachine {
	let state = initial;
	return {
		getState: () => state,
		getSession: (sessionHandle) => state.sessions[sessionHandle],
		transition: (event) => {
			const transition = reduceSessionControlMachine(state, event);
			state = transition.state;
			return transition;
		},
	};
}
