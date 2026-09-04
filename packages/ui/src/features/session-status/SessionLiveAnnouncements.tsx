import { useEffect, useRef, useState } from "react";
import { displayLabel } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { runtimePhase } from "../../lib/runtime-state";
import { useExtensionUiStore } from "../../stores/extension-ui";
import { useSessionControlStore } from "../../stores/session-control";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { sessionTransport } from "../../stores/session-transport";
import {
	createSessionLiveAnnouncementController,
	type SessionLiveAnnouncement,
	type SessionLiveAnnouncementController,
	type SessionLiveSessionObservation,
} from "./session-live-announcement";

interface RenderedAnnouncement {
	key: string;
	text: string;
}

type SessionChannel = ReturnType<typeof sessionTransport.store.getState>["sessions"][string];

function recoveryTerminalKey(channel: SessionChannel): string | null {
	const recovery = channel.recovery;
	if (!recovery) return null;
	const barrierSeq = channel.resync?.barrierSeq ?? channel.lastSeq;
	return JSON.stringify(["seq", barrierSeq, "attempt", recovery.attempt, recovery.lastError]);
}

function readObservations(): ReadonlyMap<string, SessionLiveSessionObservation> {
	const transport = sessionTransport.store.getState();
	const controls = useSessionControlStore.getState();
	const observations = new Map<string, SessionLiveSessionObservation>();

	for (const [sessionHandle, channel] of Object.entries(transport.sessions)) {
		const runtime = channel.runtime;
		if (!runtime) continue;
		const phase = runtimePhase(runtime);
		if (!phase) continue;
		const pendingRequestId =
			channel.pendingExtensionRequests.find((request) =>
				["select", "confirm", "input", "editor"].includes(request.method),
			)?.id ?? null;
		observations.set(sessionHandle, {
			identity: {
				serverEpoch: runtime.serverEpoch,
				workspaceId: runtime.workspaceId,
				sessionHandle: runtime.sessionHandle,
				generation: runtime.generation,
			},
			phase,
			lastSeq: runtime.lastSeq,
			pendingRequestId,
			recoveryPhase: channel.recovery?.phase ?? null,
			recoveryTerminalKey: recoveryTerminalKey(channel),
			revocationKey: controls.bySession[sessionHandle]?.notice?.key ?? null,
		});
	}
	return observations;
}

function sessionLabel(sessionHandle: string): string {
	const directory = useSessionDirectoryStore.getState();
	const sessions = [
		directory.currentSession,
		...Object.values(directory.sessionsByWorkspace).flat(),
		...Object.values(directory.hotSessionsByWorkspace).flat(),
	];
	const session = sessions.find((candidate) => candidate?.sessionHandle === sessionHandle);
	const rawLabel =
		session?.name ||
		session?.firstMessage ||
		useExtensionUiStore.getState().bySession[sessionHandle]?.title ||
		tt("header.unnamed");
	return displayLabel(rawLabel).slice(0, 80) || tt("header.unnamed");
}

export function formatSessionLiveAnnouncement(
	announcement: Pick<SessionLiveAnnouncement, "kind">,
	session: string,
): string {
	switch (announcement.kind) {
		case "settled":
			return tt("live.sessionSettled", { session });
		case "waiting_ui":
			return tt("live.sessionWaiting", { session });
		case "degraded":
			return tt("live.sessionDegraded", { session });
		case "takeover_revoked":
			return tt("live.sessionRevoked", { session });
	}
}

function formatAnnouncement(announcement: SessionLiveAnnouncement): string {
	return formatSessionLiveAnnouncement(announcement, sessionLabel(announcement.sessionHandle));
}

export function SessionLiveAnnouncements() {
	const controllerRef = useRef<SessionLiveAnnouncementController | null>(null);
	if (!controllerRef.current) controllerRef.current = createSessionLiveAnnouncementController();
	const [announcement, setAnnouncement] = useState<RenderedAnnouncement | null>(null);

	useEffect(() => {
		let disposed = false;
		let scheduled = false;
		const controller = controllerRef.current!;

		const observe = () => {
			scheduled = false;
			if (disposed) return;
			const next = controller.observe(readObservations());
			if (next.length === 0) return;
			setAnnouncement({
				key: next.map((candidate) => candidate.key).join("|"),
				text: next.map(formatAnnouncement).join(" "),
			});
		};

		observe();
		const schedule = () => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(observe);
		};
		const unsubscribeTransport = sessionTransport.store.subscribe(schedule);
		const unsubscribeControl = useSessionControlStore.subscribe(schedule);
		const unsubscribeDirectory = useSessionDirectoryStore.subscribe(schedule);
		return () => {
			disposed = true;
			unsubscribeTransport();
			unsubscribeControl();
			unsubscribeDirectory();
		};
	}, []);

	return (
		<div
			role="status"
			aria-live="polite"
			aria-atomic="true"
			data-testid="session-live-announcements"
			className="sr-only"
		>
			{announcement && <span key={announcement.key}>{announcement.text}</span>}
		</div>
	);
}
