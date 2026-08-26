import { expectCommandData, type ModelDto, type ThinkingLevelDto } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { sessionTransport } from "./session-transport";

export interface ModelSnapshot {
	models: ModelDto[];
	byProvider: Record<string, ModelDto[]>;
	currentModel: { provider: string; modelId: string } | null;
	thinkingLevels: ThinkingLevelDto[];
	currentThinkingLevel: ThinkingLevelDto | null;
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
	applyState: (state: { model?: ModelDto; thinkingLevel: ThinkingLevelDto }) => void;
	applyStateForSession: (
		sessionHandle: string,
		state: { model?: ModelDto; thinkingLevel: ThinkingLevelDto },
	) => void;
	applyThinkingLevel: (sessionHandle: string, level: ThinkingLevelDto) => void;
	applyThinkingLevelForSession: (sessionHandle: string, level: ThinkingLevelDto) => void;
	refresh: (sessionHandle: string) => Promise<void>;
	selectModel: (sessionHandle: string, provider: string, modelId: string) => Promise<void>;
	selectThinkingLevel: (sessionHandle: string, level: ThinkingLevelDto) => Promise<void>;
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
				const { models } = expectCommandData(modelsResponse, "get_available_models");
				const state = expectCommandData(stateResponse, "get_state");
				const { levels } = expectCommandData(levelsResponse, "get_available_thinking_levels");
				const byProvider: Record<string, ModelDto[]> = {};
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
			const model = expectCommandData(response, "set_model");
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
