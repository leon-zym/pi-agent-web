import { expectData } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { sendControlCommand } from "../lib/session-controller";
import type { ModelLite, ThinkingLevel } from "../types/pi-types";
import { useSessionControlStore } from "./session-control";
import { useTransportStore } from "./transport";

interface ModelDirectoryState {
	models: ModelLite[];
	byProvider: Record<string, ModelLite[]>;
	currentModel: { provider: string; modelId: string } | null;
	thinkingLevels: ThinkingLevel[];
	currentThinkingLevel: ThinkingLevel | null;
	loading: boolean;
	error?: string;
	/** Host-reported state is the only truth (get_state), never stale responses. */
	applyState: (state: { model?: ModelLite; thinkingLevel: ThinkingLevel }) => void;
	applyThinkingLevel: (level: ThinkingLevel) => void;
	refresh: (workspaceId: string) => Promise<void>;
	selectModel: (workspaceId: string, provider: string, modelId: string) => Promise<void>;
	selectThinkingLevel: (workspaceId: string, level: ThinkingLevel) => Promise<void>;
}

export const useModelDirectoryStore = create<ModelDirectoryState>()((set, get) => ({
	models: [],
	byProvider: {},
	currentModel: null,
	thinkingLevels: [],
	currentThinkingLevel: null,
	loading: false,

	applyState: ({ model, thinkingLevel }) => {
		set({
			currentModel: model ? { provider: model.provider, modelId: model.id } : get().currentModel,
			currentThinkingLevel: thinkingLevel ?? get().currentThinkingLevel,
		});
	},

	applyThinkingLevel: (level) => set({ currentThinkingLevel: level }),

	refresh: async (workspaceId) => {
		set({ loading: true, error: undefined });
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
			set({
				models,
				byProvider,
				currentModel: state.model
					? { provider: state.model.provider, modelId: state.model.id }
					: get().currentModel,
				currentThinkingLevel: state.thinkingLevel,
				thinkingLevels: levels,
			});
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			set({ loading: false });
		}
	},

	selectModel: async (workspaceId, provider, modelId) => {
		if (!useSessionControlStore.getState().canControl(workspaceId)) throw new Error("workspace_read_only");
		const previous = get().currentModel;
		const response = await sendControlCommand(workspaceId, { type: "set_model", provider, modelId });
		const model = expectData(response) as ModelLite;
		set({ currentModel: { provider: model.provider, modelId: model.id } });
		// Failure leaves the previous selection untouched (toast at the call site).
		if (previous && previous.modelId !== modelId) {
			// keep previous on failure handled by caller; nothing else to do
		}
	},

	selectThinkingLevel: async (workspaceId, level) => {
		if (!useSessionControlStore.getState().canControl(workspaceId)) throw new Error("workspace_read_only");
		await sendControlCommand(workspaceId, { type: "set_thinking_level", level });
		// The effective (possibly clamped) value arrives via thinking_level_changed.
	},
}));
