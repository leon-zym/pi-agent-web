import { expectData } from "@pi-agent-web/protocol";
import { create } from "zustand";
import type { RpcSlashCommand } from "../types/pi-types";
import { useTransportStore } from "./transport";

interface SlashCommandsState {
	commands: RpcSlashCommand[];
	loadedAt: number | null;
	refresh: (workspaceId: string) => Promise<void>;
}

export const useSlashCommandsStore = create<SlashCommandsState>()((set) => ({
	commands: [],
	loadedAt: null,

	refresh: async (workspaceId) => {
		try {
			const response = await useTransportStore.getState().sendCommand(workspaceId, { type: "get_commands" });
			const { commands } = expectData(response) as { commands: RpcSlashCommand[] };
			set({ commands, loadedAt: Date.now() });
		} catch {
			// Keep the last snapshot; the slash menu degrades gracefully.
		}
	},
}));
