import { expectData } from "@pi-agent-web/protocol";
import { create } from "zustand";
import type { ModelLite, ThinkingLevel } from "../types/pi-types";
import { sessionTransport } from "./session-transport";

export interface ModelSnapshot {
	models: ModelLite[];
	byProvider: Record<string, ModelLite[]>;
	currentModel: { provider: string; modelId: string } | null;
	thinkingLevels: ThinkingLevel[];
	currentThinkingLevel: ThinkingLevel | null;
	loadedAt: number | null;
	loading: boolean;
	error?: string;
}

interface ModelDirectoryState extends ModelSnapshot {
	bySession: Record<string, ModelSnapshot>;
	activeSessionHandle: string | null;
	beginSession: (sessionHandle: string | null) => void;
	forgetSession: (sessionHandle: string) => void;
	/** Host-reported state is the only truth (get_state), never a stale cross-Session response. */
	applyState: (state: { model?: ModelLite; thinkingLevel: ThinkingLevel }) => void;
	applyStateForSession: (
		sessionHandle: string,
		state: { model?: ModelLite; thinkingLevel: ThinkingLevel },
	) => void;
	applyThinkingLevel: (sessionHandle: string, level: ThinkingLevel) => void;
	applyThinkingLevelForSession: (sessionHandle: string, level: ThinkingLevel) => void;
	refresh: (sessionHandle: string) => Promise<void>;
	selectModel: (sessionHandle: string, provider: string, modelId: string) => Promise<void>;
	selectThinkingLevel: (sessionHandle: string, level: ThinkingLevel) => Promise<void>;
}

const refreshGeneration = new Map<string, number>();
const modelSelectionGeneration = new Map<string, number>();
let operationCounter = 0;

function nextGeneration(target: Map<string, number>, sessionHandle: string): number {
	operationCounter += 1;
	target.set(sessionHandle, operationCounter);
	return operationCounter;
}

function isLatest(target: Map<string, number>, sessionHandle: string, generation: number): boolean {
	return target.get(sessionHandle) === generation;
}

function emptySnapshot(loading = false): ModelSnapshot {
	return {
		models: [],
		byProvider: {},
		currentModel: null,
		thinkingLevels: [],
		currentThinkingLevel: null,
		loadedAt: null,
		loading,
		error: undefined,
	};
}

function visible(snapshot: ModelSnapshot): ModelSnapshot {
	return {
		models: snapshot.models,
		byProvider: snapshot.byProvider,
		currentModel: snapshot.currentModel,
		thinkingLevels: snapshot.thinkingLevels,
		currentThinkingLevel: snapshot.currentThinkingLevel,
		loadedAt: snapshot.loadedAt,
		loading: snapshot.loading,
		error: snapshot.error,
	};
}

export const useModelDirectoryStore = create<ModelDirectoryState>()((set, get) => {
	const updateSession = (sessionHandle: string, update: (snapshot: ModelSnapshot) => ModelSnapshot): void =>
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
				modelSelectionGeneration.delete(sessionHandle);
				return {
					bySession,
					...(state.activeSessionHandle === sessionHandle
						? { activeSessionHandle: null, ...visible(emptySnapshot()) }
						: {}),
				};
			}),

		applyState: (state) => {
			const sessionHandle = get().activeSessionHandle;
			if (sessionHandle) get().applyStateForSession(sessionHandle, state);
		},

		applyStateForSession: (sessionHandle, state) =>
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				currentModel: state.model
					? { provider: state.model.provider, modelId: state.model.id }
					: snapshot.currentModel,
				currentThinkingLevel: state.thinkingLevel,
			})),

		applyThinkingLevel: (sessionHandle, level) => get().applyThinkingLevelForSession(sessionHandle, level),

		applyThinkingLevelForSession: (sessionHandle, level) =>
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, currentThinkingLevel: level })),

		refresh: async (sessionHandle) => {
			const generation = nextGeneration(refreshGeneration, sessionHandle);
			updateSession(sessionHandle, (snapshot) => ({ ...snapshot, loading: true, error: undefined }));
			try {
				const transport = sessionTransport.store.getState();
				const [modelsResponse, stateResponse, levelsResponse] = await Promise.all([
					transport.sendCommand(sessionHandle, { type: "get_available_models" }),
					transport.sendCommand(sessionHandle, { type: "get_state" }),
					transport.sendCommand(sessionHandle, { type: "get_available_thinking_levels" }),
				]);
				if (!isLatest(refreshGeneration, sessionHandle, generation)) return;
				const { models } = expectData(modelsResponse) as { models: ModelLite[] };
				const state = expectData(stateResponse) as { model?: ModelLite; thinkingLevel: ThinkingLevel };
				const { levels } = expectData(levelsResponse) as { levels: ThinkingLevel[] };
				const byProvider: Record<string, ModelLite[]> = {};
				for (const model of models) {
					const group = byProvider[model.provider] ?? [];
					group.push(model);
					byProvider[model.provider] = group;
				}
				updateSession(sessionHandle, () => ({
					models,
					byProvider,
					currentModel: state.model ? { provider: state.model.provider, modelId: state.model.id } : null,
					thinkingLevels: levels,
					currentThinkingLevel: state.thinkingLevel,
					loadedAt: Date.now(),
					loading: false,
					error: undefined,
				}));
			} catch (error) {
				if (!isLatest(refreshGeneration, sessionHandle, generation)) return;
				updateSession(sessionHandle, (snapshot) => ({
					...snapshot,
					loading: false,
					error: error instanceof Error ? error.message : String(error),
				}));
			}
		},

		selectModel: async (sessionHandle, provider, modelId) => {
			const generation = nextGeneration(modelSelectionGeneration, sessionHandle);
			const response = await sessionTransport.store
				.getState()
				.sendCommand(sessionHandle, { type: "set_model", provider, modelId });
			const model = expectData(response) as ModelLite;
			if (!isLatest(modelSelectionGeneration, sessionHandle, generation)) return;
			updateSession(sessionHandle, (snapshot) => ({
				...snapshot,
				currentModel: { provider: model.provider, modelId: model.id },
			}));
		},

		selectThinkingLevel: async (sessionHandle, level) => {
			await sessionTransport.store
				.getState()
				.sendCommand(sessionHandle, { type: "set_thinking_level", level });
			// The effective (possibly clamped) value arrives via thinking_level_changed.
		},
	};
});
