import type { SessionRuntimeIdentityDto, SessionRuntimePhaseDto } from "@pi-agent-web/protocol";
import type { SessionResyncPhase } from "../../lib/session-resync";

export type SessionLiveAnnouncementKind = "settled" | "waiting_ui" | "degraded" | "takeover_revoked";

export interface SessionLiveSessionObservation {
	identity: SessionRuntimeIdentityDto;
	phase: SessionRuntimePhaseDto;
	lastSeq: number;
	pendingRequestId: string | null;
	recoveryPhase: SessionResyncPhase | null;
	recoveryTerminalKey: string | null;
	revocationKey: string | null;
}

export interface SessionLiveAnnouncement {
	kind: SessionLiveAnnouncementKind;
	key: string;
	terminalKey: string;
	identity: SessionRuntimeIdentityDto;
	sessionHandle: string;
}

export interface SessionLiveAnnouncementController {
	observe: (observations: ReadonlyMap<string, SessionLiveSessionObservation>) => SessionLiveAnnouncement[];
	reset: () => void;
}

const ANNOUNCED_KEY_LIMIT = 256;

function sameIdentity(left: SessionRuntimeIdentityDto, right: SessionRuntimeIdentityDto): boolean {
	return (
		left.serverEpoch === right.serverEpoch &&
		left.workspaceId === right.workspaceId &&
		left.sessionHandle === right.sessionHandle &&
		left.generation === right.generation
	);
}

function identityKey(identity: SessionRuntimeIdentityDto): string {
	return [identity.serverEpoch, identity.workspaceId, identity.sessionHandle, identity.generation]
		.map((value) => encodeURIComponent(String(value)))
		.join(":");
}

function isSettledPhase(phase: SessionRuntimePhaseDto): boolean {
	return phase === "ready" || phase === "crashed" || phase === "dormant";
}

function terminalKey(kind: SessionLiveAnnouncementKind, observation: SessionLiveSessionObservation): string {
	switch (kind) {
		case "settled":
			return `seq:${String(observation.lastSeq)}`;
		case "waiting_ui":
			return observation.pendingRequestId
				? `request:${observation.pendingRequestId}`
				: `seq:${String(observation.lastSeq)}`;
		case "degraded":
			return observation.recoveryTerminalKey ?? `seq:${String(observation.lastSeq)}`;
		case "takeover_revoked":
			return observation.revocationKey ?? "revocation";
	}
}

export function createSessionLiveAnnouncementController(): SessionLiveAnnouncementController {
	let previous = new Map<string, SessionLiveSessionObservation>();
	const announcedKeys = new Set<string>();

	const remember = (key: string): boolean => {
		if (announcedKeys.has(key)) return false;
		announcedKeys.add(key);
		if (announcedKeys.size > ANNOUNCED_KEY_LIMIT) {
			const oldest = announcedKeys.values().next().value;
			if (oldest !== undefined) announcedKeys.delete(oldest);
		}
		return true;
	};

	const create = (
		kind: SessionLiveAnnouncementKind,
		observation: SessionLiveSessionObservation,
	): SessionLiveAnnouncement | null => {
		const terminal = terminalKey(kind, observation);
		const key = `${identityKey(observation.identity)}:${kind}:${terminal}`;
		if (!remember(key)) return null;
		return {
			kind,
			key,
			terminalKey: terminal,
			identity: observation.identity,
			sessionHandle: observation.identity.sessionHandle,
		};
	};

	return {
		observe: (observations) => {
			const next = new Map(observations);
			const announcements: SessionLiveAnnouncement[] = [];
			for (const [sessionHandle, current] of next) {
				const prior = previous.get(sessionHandle);
				if (!prior || !sameIdentity(prior.identity, current.identity)) continue;

				const kinds: SessionLiveAnnouncementKind[] = [];
				if (prior.phase === "busy" && isSettledPhase(current.phase)) {
					kinds.push("settled");
				}
				if (prior.phase !== "waiting_ui" && current.phase === "waiting_ui") {
					kinds.push("waiting_ui");
				}
				if (prior.recoveryPhase !== "degraded" && current.recoveryPhase === "degraded") {
					kinds.push("degraded");
				}
				if (current.revocationKey && current.revocationKey !== prior.revocationKey) {
					kinds.push("takeover_revoked");
				}
				for (const kind of kinds) {
					const announcement = create(kind, current);
					if (announcement) announcements.push(announcement);
				}
			}
			previous = next;
			return announcements;
		},
		reset: () => {
			previous = new Map();
			announcedKeys.clear();
		},
	};
}
