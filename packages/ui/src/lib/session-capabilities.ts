import type { NativeSessionDto } from "@pi-agent-web/protocol";
import type { SessionChannelState } from "../stores/session-transport";

export type SessionDeleteBlockReason =
	| "controller_required"
	| "runtime_active"
	| "runtime_unavailable"
	| "session_unpersisted";

export type SessionDeleteCapability =
	| { allowed: true; reason: null }
	| { allowed: false; reason: SessionDeleteBlockReason };

/** Shared destructive-action admission hint; the gateway remains authoritative. */
export function sessionDeleteCapability(
	session: NativeSessionDto,
	channel: SessionChannelState | undefined,
): SessionDeleteCapability {
	if (
		!channel?.subscribed ||
		channel.generation === null ||
		!channel.lease.isController ||
		!channel.lease.fencingToken
	) {
		return { allowed: false, reason: "controller_required" };
	}
	if (!session.persisted) return { allowed: false, reason: "session_unpersisted" };
	const runtime = channel.runtime ?? session.runtime;
	if (runtime?.recoverable !== true) {
		return { allowed: false, reason: "runtime_unavailable" };
	}
	if (runtime.state !== "idle" && runtime.state !== "crashed" && runtime.state !== "dormant") {
		return { allowed: false, reason: "runtime_active" };
	}
	return { allowed: true, reason: null };
}
