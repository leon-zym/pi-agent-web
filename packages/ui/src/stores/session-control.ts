import type { SessionErrorDto, SessionLeaseStatusDto } from "@pi-agent-web/protocol";
import { create } from "zustand";
import {
	hasFreshLeaseBaseline,
	type SessionChannelState,
	type SessionTransportConnectionState,
	sessionTransport,
	useSessionTransportStore,
} from "./session-transport";

export type SessionControlMode = "controller" | "view_only" | "reconnecting";

export interface SessionControlError extends Omit<SessionErrorDto, "type"> {
	receivedAt: number;
}

export interface SessionControlNotice {
	key: string;
	receivedAt: number;
}

export interface SessionControlRecord {
	takeoverPending: boolean;
	lastLease: SessionLeaseStatusDto | null;
	error: SessionControlError | null;
	notice: SessionControlNotice | null;
}

export interface SessionControlStatus {
	sessionHandle: string | null;
	mode: SessionControlMode;
	canControl: boolean;
	canTakeOver: boolean;
	takeoverPending: boolean;
	error: SessionControlError | null;
	notice: SessionControlNotice | null;
}

export function emptySessionControlRecord(): SessionControlRecord {
	return {
		takeoverPending: false,
		lastLease: null,
		error: null,
		notice: null,
	};
}

function hasAuthoritativeBaseline(
	connectionState: SessionTransportConnectionState,
	channel: SessionChannelState | undefined,
): boolean {
	return Boolean(
		connectionState === "online" &&
			channel?.subscribed &&
			channel.baselineAuthoritative &&
			hasFreshLeaseBaseline(channel) &&
			channel.generation !== null,
	);
}

function canTakeOver(channel: SessionChannelState | undefined, baseline: boolean, pending: boolean): boolean {
	const runtime = channel?.runtime;
	const leaseRevision = channel?.lease.leaseRevision;
	return Boolean(
		baseline &&
			!pending &&
			runtime &&
			runtime.state !== "dormant" &&
			runtime.sessionFile !== null &&
			channel.lease.isController === false &&
			channel.lease.controlState === "held" &&
			channel.lease.conflicted !== true &&
			channel.resync === null &&
			channel.recovery === null &&
			typeof leaseRevision === "number" &&
			Number.isSafeInteger(leaseRevision),
	);
}

export function selectSessionControlStatus({
	connectionState,
	channel,
	record,
	sessionHandle,
}: {
	connectionState: SessionTransportConnectionState;
	channel: SessionChannelState | undefined;
	record?: SessionControlRecord;
	sessionHandle: string | null;
}): SessionControlStatus {
	const controlRecord = record ?? emptySessionControlRecord();
	const baseline = hasAuthoritativeBaseline(connectionState, channel);
	const recovering = Boolean(channel?.resync || channel?.recovery);
	const controlReady = Boolean(
		baseline &&
			!recovering &&
			channel?.lease.conflicted !== true &&
			channel?.lease.isController &&
			channel?.lease.fencingToken,
	);
	const observerReady = Boolean(
		baseline && !recovering && channel?.lease.conflicted !== true && !channel?.lease.isController,
	);
	const mode: SessionControlMode = controlReady ? "controller" : observerReady ? "view_only" : "reconnecting";

	return {
		sessionHandle,
		mode,
		canControl: controlReady,
		canTakeOver: canTakeOver(channel, baseline, controlRecord.takeoverPending),
		takeoverPending: controlRecord.takeoverPending,
		error: controlRecord.error,
		notice: controlRecord.notice,
	};
}

function leaseEventKey(message: SessionLeaseStatusDto): string {
	return [
		message.serverEpoch,
		message.sessionHandle,
		message.generation,
		message.leaseRevision,
		message.transition,
		message.isController ? "controller" : "observer",
	].join(":");
}

function sameLeaseIdentity(left: SessionLeaseStatusDto, right: SessionLeaseStatusDto): boolean {
	return (
		left.serverEpoch === right.serverEpoch &&
		left.sessionHandle === right.sessionHandle &&
		left.generation === right.generation
	);
}

interface SessionControlState {
	bySession: Record<string, SessionControlRecord>;
	requestTakeover: (sessionHandle: string) => boolean;
	observeLeaseStatus: (message: SessionLeaseStatusDto, receivedAt?: number) => void;
	recordSessionError: (message: SessionErrorDto, receivedAt?: number) => void;
	resetSession: (sessionHandle: string) => void;
	forgetSession: (sessionHandle: string) => void;
}

export const useSessionControlStore = create<SessionControlState>()((set, get) => ({
	bySession: {},

	requestTakeover: (sessionHandle) => {
		const sent = sessionTransport.store.getState().takeoverSession(sessionHandle);
		if (!sent) return false;
		set((state) => ({
			bySession: {
				...state.bySession,
				[sessionHandle]: {
					...(state.bySession[sessionHandle] ?? emptySessionControlRecord()),
					takeoverPending: true,
					error: null,
				},
			},
		}));
		return true;
	},

	observeLeaseStatus: (message, receivedAt = Date.now()) => {
		set((state) => {
			const previous = state.bySession[message.sessionHandle] ?? emptySessionControlRecord();
			const previousLease = previous.lastLease;
			const revoked =
				previousLease?.isController === true && !message.isController && message.transition === "takeover";
			const isNewIncarnation = previousLease ? !sameLeaseIdentity(previousLease, message) : true;
			const newerRevision =
				previousLease &&
				sameLeaseIdentity(previousLease, message) &&
				message.leaseRevision > previousLease.leaseRevision;
			const shouldClearError =
				previous.error !== null &&
				(message.transition === "baseline" || isNewIncarnation || newerRevision === true);
			const nextNotice = message.isController
				? null
				: revoked
					? {
							key: leaseEventKey(message),
							receivedAt,
						}
					: previous.notice;
			return {
				bySession: {
					...state.bySession,
					[message.sessionHandle]: {
						...previous,
						lastLease: message,
						takeoverPending: false,
						error: shouldClearError ? null : previous.error,
						notice: nextNotice,
					},
				},
			};
		});
	},

	recordSessionError: (message, receivedAt = Date.now()) => {
		set((state) => ({
			bySession: {
				...state.bySession,
				[message.sessionHandle]: {
					...(state.bySession[message.sessionHandle] ?? emptySessionControlRecord()),
					takeoverPending:
						message.operation === "takeover"
							? false
							: (state.bySession[message.sessionHandle]?.takeoverPending ?? false),
					error: { ...message, receivedAt },
				},
			},
		}));
	},

	resetSession: (sessionHandle) =>
		set((state) => {
			const bySession = { ...state.bySession };
			delete bySession[sessionHandle];
			return { bySession };
		}),

	forgetSession: (sessionHandle) => get().resetSession(sessionHandle),
}));

export function useSessionControlStatus(sessionHandle: string | null): SessionControlStatus {
	const connectionState = useSessionTransportStore((state) => state.connectionState);
	const channel = useSessionTransportStore((state) =>
		sessionHandle ? state.sessions[sessionHandle] : undefined,
	);
	const record = useSessionControlStore((state) =>
		sessionHandle ? state.bySession[sessionHandle] : undefined,
	);
	return selectSessionControlStatus({ connectionState, channel, record, sessionHandle });
}
