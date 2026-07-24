import { expectData } from "@pi-agent-web/protocol";
import { create } from "zustand";
import type { RpcSlashCommand } from "../types/pi-types";
import { useTransportStore } from "./transport";

interface SlashCommandsState {
	byWorkspace: Record<string, SlashCommandSnapshot>;
	activeWorkspaceId: string | null;
	commands: RpcSlashCommand[];
	loadedAt: number | null;
	loading: boolean;
	beginWorkspace: (workspaceId: string | null) => void;
	refresh: (workspaceId: string) => Promise<void>;
}

interface SlashCommandSnapshot {
	commands: RpcSlashCommand[];
	loadedAt: number;
}

const refreshGeneration = new Map<string, number>();
let refreshCounter = 0;

function nextRefreshGeneration(workspaceId: string): number {
	refreshCounter += 1;
	refreshGeneration.set(workspaceId, refreshCounter);
	return refreshCounter;
}

function isLatestRefresh(workspaceId: string, generation: number): boolean {
	return refreshGeneration.get(workspaceId) === generation;
}

export const useSlashCommandsStore = create<SlashCommandsState>()((set, get) => ({
	byWorkspace: {},
	activeWorkspaceId: null,
	commands: [],
	loadedAt: null,
	loading: false,

	beginWorkspace: (workspaceId) =>
		set({ activeWorkspaceId: workspaceId, commands: [], loadedAt: null, loading: workspaceId !== null }),

	refresh: async (workspaceId) => {
		const generation = nextRefreshGeneration(workspaceId);
		if (get().activeWorkspaceId === workspaceId) set({ loading: true });
		try {
			const response = await useTransportStore.getState().sendCommand(workspaceId, { type: "get_commands" });
			const { commands } = expectData(response) as { commands: RpcSlashCommand[] };
			const snapshot = { commands, loadedAt: Date.now() };
			const current = get();
			const byWorkspace = { ...current.byWorkspace, [workspaceId]: snapshot };
			if (current.activeWorkspaceId === workspaceId && isLatestRefresh(workspaceId, generation)) {
				set({ byWorkspace, commands, loadedAt: snapshot.loadedAt, loading: false });
			} else set({ byWorkspace });
		} catch {
			if (get().activeWorkspaceId === workspaceId && isLatestRefresh(workspaceId, generation)) {
				set({ loading: false });
			}
		}
	},
}));
