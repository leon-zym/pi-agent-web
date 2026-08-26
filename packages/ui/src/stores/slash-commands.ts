import { expectCommandData, type SlashCommandDto } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { sessionTransport } from "./session-transport";

export interface SlashCommandSnapshot {
	commands: SlashCommandDto[];
	loadedAt: number | null;
	loading: boolean;
}

interface SlashCommandsState extends SlashCommandSnapshot {
	bySession: Record<string, SlashCommandSnapshot>;
	activeSessionHandle: string | null;
	beginSession: (sessionHandle: string | null) => void;
	forgetSession: (sessionHandle: string) => void;
	refresh: (sessionHandle: string) => Promise<void>;
}

const refreshGeneration = new Map<string, number>();
let refreshCounter = 0;

function nextRefreshGeneration(sessionHandle: string): number {
	refreshCounter += 1;
	refreshGeneration.set(sessionHandle, refreshCounter);
	return refreshCounter;
}

function isLatestRefresh(sessionHandle: string, generation: number): boolean {
	return refreshGeneration.get(sessionHandle) === generation;
}

function emptySnapshot(loading = false): SlashCommandSnapshot {
	return { commands: [], loadedAt: null, loading };
}

function visible(snapshot: SlashCommandSnapshot): SlashCommandSnapshot {
	return { commands: snapshot.commands, loadedAt: snapshot.loadedAt, loading: snapshot.loading };
}

export const useSlashCommandsStore = create<SlashCommandsState>()((set) => {
	const updateSession = (
		sessionHandle: string,
		update: (snapshot: SlashCommandSnapshot) => SlashCommandSnapshot,
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
					activeSessionHandle
						? (state.bySession[activeSessionHandle] ?? emptySnapshot(true))
						: emptySnapshot(),
				),
			})),

		forgetSession: (sessionHandle) =>
			set((state) => {
				const bySession = { ...state.bySession };
				delete bySession[sessionHandle];
				refreshGeneration.delete(sessionHandle);
				return {
					bySession,
					...(state.activeSessionHandle === sessionHandle
						? { activeSessionHandle: null, ...visible(emptySnapshot()) }
						: {}),
				};
			}),

		refresh: async (sessionHandle) => {
			const generation = nextRefreshGeneration(sessionHandle);
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, loading: true }));
			try {
				const response = await sessionTransport.store
					.getState()
					.sendCommand(sessionHandle, { type: "get_commands" });
				if (!isLatestRefresh(sessionHandle, generation)) return;
				const { commands } = expectCommandData(response, "get_commands");
				updateSession(sessionHandle, () => ({ commands, loadedAt: Date.now(), loading: false }));
			} catch {
				if (!isLatestRefresh(sessionHandle, generation)) return;
				updateSession(sessionHandle, (snapshot) => ({ ...snapshot, loading: false }));
			}
		},
	};
});
