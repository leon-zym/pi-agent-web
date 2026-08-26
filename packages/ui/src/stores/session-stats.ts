import { expectCommandData, type SessionStatsDto } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { sessionTransport } from "./session-transport";

export interface ContextMeterInfo {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
	totalTokens: number;
	cost: number;
}

export interface LiveSessionUsage {
	input: number;
	output: number;
	totalTokens: number;
}

export interface SessionStatsSnapshot {
	stats: SessionStatsDto | null;
	/** Live usage from message_update (cumulative); converges at message_end. */
	liveUsage: LiveSessionUsage | null;
}

interface SessionStatsState extends SessionStatsSnapshot {
	bySession: Record<string, SessionStatsSnapshot>;
	activeSessionHandle: string | null;
	beginSession: (sessionHandle: string | null) => void;
	forgetSession: (sessionHandle: string) => void;
	refresh: (sessionHandle: string) => Promise<void>;
	applyLiveUsage: (usage: LiveSessionUsage) => void;
	applyLiveUsageForSession: (sessionHandle: string, usage: LiveSessionUsage) => void;
	clear: () => void;
	clearForSession: (sessionHandle: string) => void;
}

const refreshGeneration = new Map<string, number>();
const liveUsageRevision = new Map<string, number>();
let refreshCounter = 0;
let liveUsageCounter = 0;

function nextRefreshGeneration(sessionHandle: string): number {
	refreshCounter += 1;
	refreshGeneration.set(sessionHandle, refreshCounter);
	return refreshCounter;
}

function emptySnapshot(): SessionStatsSnapshot {
	return { stats: null, liveUsage: null };
}

function visible(snapshot: SessionStatsSnapshot): SessionStatsSnapshot {
	return { stats: snapshot.stats, liveUsage: snapshot.liveUsage };
}

export const useSessionStatsStore = create<SessionStatsState>()((set, get) => {
	const updateSession = (
		sessionHandle: string,
		update: (snapshot: SessionStatsSnapshot) => SessionStatsSnapshot,
	): void =>
		set((state) => {
			const snapshot = update(state.bySession[sessionHandle] ?? emptySnapshot());
			return {
				bySession: { ...state.bySession, [sessionHandle]: snapshot },
				...(state.activeSessionHandle === sessionHandle ? visible(snapshot) : {}),
			};
		});

	return {
		...emptySnapshot(),
		bySession: {},
		activeSessionHandle: null,

		beginSession: (activeSessionHandle) =>
			set((state) => ({
				activeSessionHandle,
				...visible(
					activeSessionHandle ? (state.bySession[activeSessionHandle] ?? emptySnapshot()) : emptySnapshot(),
				),
			})),

		forgetSession: (sessionHandle) =>
			set((state) => {
				const bySession = { ...state.bySession };
				delete bySession[sessionHandle];
				refreshGeneration.delete(sessionHandle);
				liveUsageRevision.delete(sessionHandle);
				return {
					bySession,
					...(state.activeSessionHandle === sessionHandle
						? { activeSessionHandle: null, ...visible(emptySnapshot()) }
						: {}),
				};
			}),

		refresh: async (sessionHandle) => {
			const generation = nextRefreshGeneration(sessionHandle);
			const usageRevision = liveUsageRevision.get(sessionHandle) ?? 0;
			try {
				const response = await sessionTransport.store
					.getState()
					.sendCommand(sessionHandle, { type: "get_session_stats" });
				if (refreshGeneration.get(sessionHandle) !== generation) return;
				const stats = expectCommandData(response, "get_session_stats");
				updateSession(sessionHandle, (snapshot) => ({
					stats,
					liveUsage:
						(liveUsageRevision.get(sessionHandle) ?? 0) === usageRevision ? null : snapshot.liveUsage,
				}));
			} catch {
				// The context meter keeps the last value for this Session.
			}
		},

		applyLiveUsage: (liveUsage) => {
			const sessionHandle = get().activeSessionHandle;
			if (sessionHandle) get().applyLiveUsageForSession(sessionHandle, liveUsage);
		},
		applyLiveUsageForSession: (sessionHandle, liveUsage) => {
			liveUsageCounter += 1;
			liveUsageRevision.set(sessionHandle, liveUsageCounter);
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, liveUsage }));
		},

		clear: () => {
			const sessionHandle = get().activeSessionHandle;
			if (sessionHandle) get().clearForSession(sessionHandle);
			else set(visible(emptySnapshot()));
		},
		clearForSession: (sessionHandle) => {
			refreshGeneration.delete(sessionHandle);
			liveUsageRevision.delete(sessionHandle);
			updateSession(sessionHandle, () => emptySnapshot());
		},
	};
});
