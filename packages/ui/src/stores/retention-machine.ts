import { SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES, type SessionRuntimeDto } from "@pi-agent-web/protocol";
import { runtimePhase } from "../lib/runtime-state";
import type { SessionRawEventRecord, SessionSubscriptionAdmission } from "./session-transport-contract";

export interface RetainedRawEvent {
	identityKey: string;
	sessionHandle: string;
	record: SessionRawEventRecord;
	bytes: number;
}

export interface RetentionCandidate {
	sessionHandle: string;
	canEvict: boolean;
	protected: boolean;
}

export interface SessionRetentionMachineState {
	subscriptionOrder: readonly string[];
	protectedOverage: readonly string[];
	admissions: Readonly<Record<string, SessionSubscriptionAdmission>>;
	rawEvents: readonly RetainedRawEvent[];
	rawEventBytes: number;
}

export interface SessionRetentionMachineOptions {
	maxActiveSubscriptions: number;
	rawEventLimit: number;
	rawEventMaxBytes: number;
	rawEventGlobalLimit: number;
	rawEventGlobalMaxBytes: number;
}

export type SessionRetentionMachineEvent =
	| { type: "touch_subscription"; sessionHandle: string }
	| {
			type: "admit_subscription";
			sessionHandle: string;
			subscribedCount: number;
			candidates: readonly RetentionCandidate[];
	  }
	| { type: "remove_subscription"; sessionHandle: string }
	| { type: "mark_protected_overage"; sessionHandle: string; subscribedCount: number }
	| { type: "clear_protected_overage"; subscribedCount: number }
	| { type: "set_admission"; sessionHandle: string; admission: SessionSubscriptionAdmission }
	| { type: "clear_admission"; sessionHandle: string }
	| { type: "retain_raw"; entry: RetainedRawEvent }
	| { type: "discard_raw"; sessionHandle: string }
	| { type: "reset" };

export type SessionRetentionMachineIntent =
	| { type: "evict_subscription"; sessionHandle: string }
	| { type: "mark_protected_overage"; sessionHandle: string }
	| { type: "clear_protected_overage"; sessionHandles: readonly string[] }
	| { type: "admission_changed"; sessionHandle: string; admission: SessionSubscriptionAdmission | null }
	| { type: "raw_events_evicted"; entries: readonly RetainedRawEvent[] };

export interface SessionRetentionMachineTransition {
	state: SessionRetentionMachineState;
	intents: SessionRetentionMachineIntent[];
	accepted?: boolean;
	removed?: readonly RetainedRawEvent[];
}

const emptyState: SessionRetentionMachineState = {
	subscriptionOrder: [],
	protectedOverage: [],
	admissions: {},
	rawEvents: [],
	rawEventBytes: 0,
};

function removeHandle(handles: readonly string[], sessionHandle: string): string[] {
	return handles.filter((handle) => handle !== sessionHandle);
}

function touch(order: readonly string[], sessionHandle: string): string[] {
	return [...removeHandle(order, sessionHandle), sessionHandle];
}

function canEvict(candidate: RetentionCandidate | undefined): boolean {
	return Boolean(candidate?.canEvict && !candidate.protected);
}

export function subscriptionAdmissionCode(error: string, code?: string): string {
	if (code) return code.slice(0, 128);
	const known = SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES.find((errorCode) => error.includes(errorCode));
	if (known) return known;
	const token = error.match(/[A-Za-z][A-Za-z0-9_-]*/)?.[0];
	return (token ?? "subscription_rejected").slice(0, 128);
}

export function isRetryableSubscriptionError(error: string, retryable?: boolean): boolean {
	if (retryable !== undefined) return retryable;
	return SESSION_SUBSCRIPTION_RETRYABLE_ERROR_CODES.some((code) => error.includes(code));
}

export function reduceSessionRetentionMachine(
	state: SessionRetentionMachineState,
	event: SessionRetentionMachineEvent,
	options: SessionRetentionMachineOptions,
): SessionRetentionMachineTransition {
	const intents: SessionRetentionMachineIntent[] = [];
	switch (event.type) {
		case "touch_subscription":
			return {
				state: { ...state, subscriptionOrder: touch(state.subscriptionOrder, event.sessionHandle) },
				intents,
			};
		case "admit_subscription": {
			if (event.subscribedCount < options.maxActiveSubscriptions) return { state, intents, accepted: false };
			const candidate = state.subscriptionOrder
				.map((sessionHandle) => event.candidates.find((item) => item.sessionHandle === sessionHandle))
				.find((item) => item?.sessionHandle !== event.sessionHandle && canEvict(item));
			if (candidate) {
				intents.push({ type: "evict_subscription", sessionHandle: candidate.sessionHandle });
				return { state, intents, accepted: true };
			}
			intents.push({ type: "mark_protected_overage", sessionHandle: event.sessionHandle });
			return { state, intents, accepted: true };
		}
		case "remove_subscription": {
			const admissions = { ...state.admissions };
			const hadAdmission = event.sessionHandle in admissions;
			delete admissions[event.sessionHandle];
			return {
				state: {
					...state,
					subscriptionOrder: removeHandle(state.subscriptionOrder, event.sessionHandle),
					protectedOverage: removeHandle(state.protectedOverage, event.sessionHandle),
					admissions,
				},
				intents: hadAdmission
					? [{ type: "admission_changed", sessionHandle: event.sessionHandle, admission: null }]
					: intents,
			};
		}
		case "mark_protected_overage": {
			if (event.subscribedCount <= options.maxActiveSubscriptions) return { state, intents };
			if (state.protectedOverage.includes(event.sessionHandle)) return { state, intents };
			return {
				state: { ...state, protectedOverage: [...state.protectedOverage, event.sessionHandle] },
				intents: [{ type: "mark_protected_overage", sessionHandle: event.sessionHandle }],
			};
		}
		case "clear_protected_overage": {
			if (event.subscribedCount > options.maxActiveSubscriptions || state.protectedOverage.length === 0) {
				return { state, intents };
			}
			const sessionHandles = [...state.protectedOverage];
			return {
				state: { ...state, protectedOverage: [] },
				intents: [{ type: "clear_protected_overage", sessionHandles }],
			};
		}
		case "set_admission": {
			const admissions = { ...state.admissions, [event.sessionHandle]: event.admission };
			return {
				state: { ...state, admissions },
				intents: [
					{ type: "admission_changed", sessionHandle: event.sessionHandle, admission: event.admission },
				],
			};
		}
		case "clear_admission": {
			if (!(event.sessionHandle in state.admissions)) return { state, intents };
			const admissions = { ...state.admissions };
			delete admissions[event.sessionHandle];
			return {
				state: { ...state, admissions },
				intents: [{ type: "admission_changed", sessionHandle: event.sessionHandle, admission: null }],
			};
		}
		case "retain_raw": {
			const { entry } = event;
			if (
				!Number.isSafeInteger(entry.bytes) ||
				entry.bytes <= 0 ||
				entry.bytes > options.rawEventMaxBytes ||
				entry.bytes > options.rawEventGlobalMaxBytes ||
				options.rawEventLimit === 0 ||
				options.rawEventGlobalLimit === 0
			) {
				return { state, intents, accepted: false };
			}
			const rawEvents = [...state.rawEvents, entry];
			const evicted = new Set<RetainedRawEvent>();
			const sessionEntries = rawEvents.filter((candidate) => candidate.sessionHandle === entry.sessionHandle);
			let sessionBytes = sessionEntries.reduce((total, candidate) => total + candidate.bytes, 0);
			while (sessionEntries.length > options.rawEventLimit || sessionBytes > options.rawEventMaxBytes) {
				const oldest = sessionEntries.shift();
				if (!oldest) break;
				evicted.add(oldest);
				sessionBytes -= oldest.bytes;
			}
			let nextCount = rawEvents.length - evicted.size;
			let nextBytes = rawEvents.reduce((total, candidate) => total + candidate.bytes, 0);
			for (const candidate of evicted) nextBytes -= candidate.bytes;
			for (const candidate of rawEvents) {
				if (nextCount <= options.rawEventGlobalLimit && nextBytes <= options.rawEventGlobalMaxBytes) break;
				if (evicted.has(candidate)) continue;
				evicted.add(candidate);
				nextCount -= 1;
				nextBytes -= candidate.bytes;
			}
			const retained = rawEvents.filter((candidate) => !evicted.has(candidate));
			if (evicted.size > 0) intents.push({ type: "raw_events_evicted", entries: [...evicted] });
			return {
				state: { ...state, rawEvents: retained, rawEventBytes: nextBytes },
				intents,
				accepted: true,
			};
		}
		case "discard_raw": {
			const removed = state.rawEvents.filter((entry) => entry.sessionHandle === event.sessionHandle);
			if (removed.length === 0) return { state, intents, removed };
			return {
				state: {
					...state,
					rawEvents: state.rawEvents.filter((entry) => entry.sessionHandle !== event.sessionHandle),
					rawEventBytes: state.rawEventBytes - removed.reduce((total, entry) => total + entry.bytes, 0),
				},
				intents,
				removed,
			};
		}
		case "reset":
			return { state: emptyState, intents };
	}
}

export interface SessionRetentionMachine {
	getState: () => SessionRetentionMachineState;
	getAdmission: (sessionHandle: string) => SessionSubscriptionAdmission | undefined;
	getRawEvents: (sessionHandle: string) => readonly RetainedRawEvent[];
	transition: (event: SessionRetentionMachineEvent) => SessionRetentionMachineTransition;
}

export function createSessionRetentionMachine(
	options: SessionRetentionMachineOptions,
	initial: SessionRetentionMachineState = emptyState,
): SessionRetentionMachine {
	let state = initial;
	return {
		getState: () => state,
		getAdmission: (sessionHandle) => state.admissions[sessionHandle],
		getRawEvents: (sessionHandle) => state.rawEvents.filter((entry) => entry.sessionHandle === sessionHandle),
		transition: (event) => {
			const transition = reduceSessionRetentionMachine(state, event, options);
			state = transition.state;
			return transition;
		},
	};
}

export function retentionCandidate(
	sessionHandle: string,
	runtime: SessionRuntimeDto | null | undefined,
	hasPendingExtension: boolean,
	hot: boolean,
): RetentionCandidate {
	const canEvictRuntime = Boolean(
		runtime && (runtimePhase(runtime) === "ready" || runtimePhase(runtime) === "dormant"),
	);
	const persisted = runtime?.sessionFile !== null && runtime?.sessionFile !== undefined;
	return {
		sessionHandle,
		canEvict: canEvictRuntime && persisted && !hasPendingExtension,
		protected: hot,
	};
}
