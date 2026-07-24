import { expectData } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { sendControlCommand } from "../lib/session-command";
import type { ModelLite, ThinkingLevel } from "../types/pi-types";
import { useSessionControlStore } from "./session-control";
import { useTransportStore } from "./transport";

interface ModelDirectoryState {
	byWorkspace: Record<string, ModelSnapshot>;
	activeWorkspaceId: string | null;
	models: ModelLite[];
	byProvider: Record<string, ModelLite[]>;
	currentModel: { provider: string; modelId: string } | null;
	thinkingLevels: ThinkingLevel[];
	currentThinkingLevel: ThinkingLevel | null;
	loading: boolean;
	error?: string;
	beginWorkspace: (workspaceId: string | null) => void;
	/** Host-reported state is the only truth (get_state), never stale responses. */
	applyState: (state: { model?: ModelLite; thinkingLevel: ThinkingLevel }) => void;
	applyThinkingLevel: (workspaceId: string, level: ThinkingLevel) => void;
	refresh: (workspaceId: string) => Promise<void>;
	selectModel: (workspaceId: string, provider: string, modelId: string) => Promise<void>;
	selectThinkingLevel: (workspaceId: string, level: ThinkingLevel) => Promise<void>;
}

interface ModelSnapshot {
	models: ModelLite[];
	byProvider: Record<string, ModelLite[]>;
	currentModel: { provider: string; modelId: string } | null;
	thinkingLevels: ThinkingLevel[];
	currentThinkingLevel: ThinkingLevel | null;
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

function emptyVisibleState(workspaceId: string | null) {
	return {
		activeWorkspaceId: workspaceId,
		models: [],
		byProvider: {},
		currentModel: null,
		thinkingLevels: [],
		currentThinkingLevel: null,
		loading: workspaceId !== null,
		error: undefined,
	};
}

export const useModelDirectoryStore = create<ModelDirectoryState>()((set, get) => ({
	byWorkspace: {},
	activeWorkspaceId: null,
	models: [],
	byProvider: {},
	currentModel: null,
	thinkingLevels: [],
	currentThinkingLevel: null,
	loading: false,

	beginWorkspace: (workspaceId) => set(emptyVisibleState(workspaceId)),

	applyState: ({ model, thinkingLevel }) => {
		const workspaceId = get().activeWorkspaceId;
		if (!workspaceId) return;
		const snapshot = get().byWorkspace[workspaceId];
		const currentModel = model ? { provider: model.provider, modelId: model.id } : get().currentModel;
		const currentThinkingLevel = thinkingLevel ?? get().currentThinkingLevel;
		set({
			currentModel,
			currentThinkingLevel,
			byWorkspace: snapshot
				? { ...get().byWorkspace, [workspaceId]: { ...snapshot, currentModel, currentThinkingLevel } }
				: get().byWorkspace,
		});
	},

	applyThinkingLevel: (workspaceId, level) => {
		const snapshot = get().byWorkspace[workspaceId];
		const byWorkspace = snapshot
			? { ...get().byWorkspace, [workspaceId]: { ...snapshot, currentThinkingLevel: level } }
			: get().byWorkspace;
		if (get().activeWorkspaceId === workspaceId) set({ currentThinkingLevel: level, byWorkspace });
		else set({ byWorkspace });
	},

	refresh: async (workspaceId) => {
		const generation = nextRefreshGeneration(workspaceId);
		if (get().activeWorkspaceId === workspaceId) set({ loading: true, error: undefined });
		try {
			const transport = useTransportStore.getState();
			const [modelsResponse, stateResponse, levelsResponse] = await Promise.all([
				transport.sendCommand(workspaceId, { type: "get_available_models" }),
				transport.sendCommand(workspaceId, { type: "get_state" }),
				transport.sendCommand(workspaceId, { type: "get_available_thinking_levels" }),
			]);
			const { models } = expectData(modelsResponse) as { models: ModelLite[] };
			const state = expectData(stateResponse) as { model?: ModelLite; thinkingLevel: ThinkingLevel };
			const { levels } = expectData(levelsResponse) as { levels: ThinkingLevel[] };
			const byProvider: Record<string, ModelLite[]> = {};
			for (const model of models) {
				const group = byProvider[model.provider] ?? [];
				group.push(model);
				byProvider[model.provider] = group;
			}
			const snapshot: ModelSnapshot = {
				models,
				byProvider,
				currentModel: state.model ? { provider: state.model.provider, modelId: state.model.id } : null,
				currentThinkingLevel: state.thinkingLevel,
				thinkingLevels: levels,
				loadedAt: Date.now(),
			};
			const current = get();
			const byWorkspace = { ...current.byWorkspace, [workspaceId]: snapshot };
			if (current.activeWorkspaceId === workspaceId && isLatestRefresh(workspaceId, generation)) {
				set({ ...snapshot, byWorkspace, loading: false, error: undefined });
			} else set({ byWorkspace });
		} catch (error) {
			if (get().activeWorkspaceId === workspaceId && isLatestRefresh(workspaceId, generation)) {
				set({ loading: false, error: error instanceof Error ? error.message : String(error) });
			}
		}
	},

	selectModel: async (workspaceId, provider, modelId) => {
		if (!useSessionControlStore.getState().canControl(workspaceId)) throw new Error("workspace_read_only");
		const response = await sendControlCommand(workspaceId, { type: "set_model", provider, modelId });
		const model = expectData(response) as ModelLite;
		const current = get();
		const snapshot = current.byWorkspace[workspaceId];
		const currentModel = { provider: model.provider, modelId: model.id };
		const byWorkspace = snapshot
			? { ...current.byWorkspace, [workspaceId]: { ...snapshot, currentModel } }
			: current.byWorkspace;
		if (current.activeWorkspaceId === workspaceId) set({ currentModel, byWorkspace });
		else set({ byWorkspace });
	},

	selectThinkingLevel: async (workspaceId, level) => {
		if (!useSessionControlStore.getState().canControl(workspaceId)) throw new Error("workspace_read_only");
		await sendControlCommand(workspaceId, { type: "set_thinking_level", level });
		// The effective (possibly clamped) value arrives via thinking_level_changed.
	},
}));
