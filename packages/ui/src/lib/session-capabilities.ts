import type { NativeSessionDto } from "@pi-agent-web/protocol";
import { hasFreshLeaseBaseline, type SessionChannelState } from "../stores/session-transport-contract";
import { runtimeIsSettled } from "./runtime-state";

export type SessionDeleteBlockReason =
	| "controller_required"
	| "runtime_active"
	| "runtime_unavailable"
	| "session_unpersisted";

export type SessionDeleteCapability =
	| { allowed: true; reason: null }
	| { allowed: false; reason: SessionDeleteBlockReason };

export function isSessionControlReady(channel: SessionChannelState | undefined): boolean {
	return Boolean(
		channel?.subscribed &&
			channel.baselineAuthoritative &&
			hasFreshLeaseBaseline(channel) &&
			channel.generation !== null &&
			channel.lease.isController &&
			channel.lease.fencingToken,
	);
}

/** Shared destructive-action admission hint; the gateway remains authoritative. */
export function sessionDeleteCapability(
	session: NativeSessionDto,
	channel: SessionChannelState | undefined,
): SessionDeleteCapability {
	if (!channel || !isSessionControlReady(channel)) {
		return { allowed: false, reason: "controller_required" };
	}
	if (!session.persisted) return { allowed: false, reason: "session_unpersisted" };
	const runtime = channel.runtime ?? session.runtime;
	if (runtime?.recoverable !== true) {
		return { allowed: false, reason: "runtime_unavailable" };
	}
	if (!runtimeIsSettled(runtime)) {
		return { allowed: false, reason: "runtime_active" };
	}
	return { allowed: true, reason: null };
}
