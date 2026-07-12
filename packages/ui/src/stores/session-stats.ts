import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { expectData } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { useTransportStore } from "./transport";

export interface ContextMeterInfo {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
	totalTokens: number;
	cost: number;
}

interface SessionStatsState {
	stats: SessionStats | null;
	/** Live usage from message_update (cumulative); converges at message_end. */
	liveUsage: { input: number; output: number; totalTokens: number } | null;
	refresh: (workspaceId: string) => Promise<void>;
	applyLiveUsage: (usage: { input: number; output: number; totalTokens: number }) => void;
	clear: () => void;
}

export const useSessionStatsStore = create<SessionStatsState>()((set) => ({
	stats: null,
	liveUsage: null,

	refresh: async (workspaceId) => {
		try {
			const response = await useTransportStore
				.getState()
				.sendCommand(workspaceId, { type: "get_session_stats" });
			const stats = expectData(response) as SessionStats;
			set({ stats, liveUsage: null });
		} catch {
			// context meter keeps its last value
		}
	},

	applyLiveUsage: (liveUsage) => set({ liveUsage }),
	clear: () => set({ stats: null, liveUsage: null }),
}));
