import type { RpcCommand, RpcResponse, SessionStats } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useComposerStore } from "../src/stores/composer";
import { useModelDirectoryStore } from "../src/stores/model-directory";
import { useSessionStatsStore } from "../src/stores/session-stats";
import { sessionTransport } from "../src/stores/session-transport";
import { useSlashCommandsStore } from "../src/stores/slash-commands";

const originalTransport = sessionTransport.store.getState();

function response(command: string, data: unknown): RpcResponse {
	return { type: "response", command, success: true, data } as RpcResponse;
}

function model(sessionHandle: string) {
	return {
		id: `${sessionHandle}-model`,
		name: `${sessionHandle} model`,
		provider: sessionHandle,
		reasoning: false,
		contextWindow: 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function resetStores(): void {
	useComposerStore.setState({
		bySession: {},
		activeSessionHandle: null,
		draft: "",
		images: [],
		trigger: null,
		submitState: "plain",
		deliveryMode: "auto",
		queue: { steering: [], followUp: [] },
		recentQueued: [],
	});
	useModelDirectoryStore.setState({
		bySession: {},
		activeSessionHandle: null,
		models: [],
		byProvider: {},
		currentModel: null,
		thinkingLevels: [],
		currentThinkingLevel: null,
		loadedAt: null,
		loading: false,
		error: undefined,
	});
	useSlashCommandsStore.setState({
		bySession: {},
		activeSessionHandle: null,
		commands: [],
		loadedAt: null,
		loading: false,
	});
	useSessionStatsStore.setState({
		bySession: {},
		activeSessionHandle: null,
		stats: null,
		liveUsage: null,
	});
}

describe("Session-scoped UI stores", () => {
	beforeEach(resetStores);
	afterEach(() => sessionTransport.store.setState(originalTransport, true));

	it("keeps composer submit, queue, images, and recent injections independent across Sessions", () => {
		const composer = useComposerStore.getState();
		composer.beginSession("session-a");
		composer.setDraft("draft-a");
		composer.setImages([{ type: "image", mimeType: "image/png", data: "a" }]);
		expect(composer.beginSubmit()).toBe(true);
		composer.recordQueued("queued-a", "steer");

		composer.beginSession("session-b");
		composer.setDraft("draft-b");
		composer.setQueue({ steering: [], followUp: ["queued-b"] });
		expect(useComposerStore.getState()).toMatchObject({
			activeSessionHandle: "session-b",
			draft: "draft-b",
			images: [],
			submitState: "plain",
			queue: { steering: [], followUp: ["queued-b"] },
		});

		composer.setQueueForSession("session-a", { steering: ["queued-a"], followUp: [] });
		composer.beginSession("session-a");
		expect(useComposerStore.getState()).toMatchObject({
			draft: "draft-a",
			submitState: "submitting",
			queue: { steering: ["queued-a"], followUp: [] },
		});
		expect(useComposerStore.getState().images[0]?.data).toBe("a");
		expect(useComposerStore.getState().consumeInjectionSource("queued-a")).toBe("steer");
	});

	it("caches delayed model and slash snapshots without contaminating the visible Session", async () => {
		let releaseA: (() => void) | undefined;
		const aGate = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		sessionTransport.store.setState({
			sendCommand: async (sessionHandle: string, command: RpcCommand) => {
				if (sessionHandle === "session-a") await aGate;
				const currentModel = model(sessionHandle);
				if (command.type === "get_available_models") {
					return response(command.type, { models: [currentModel] });
				}
				if (command.type === "get_state") {
					return response(command.type, { model: currentModel, thinkingLevel: "off" });
				}
				if (command.type === "get_available_thinking_levels") {
					return response(command.type, { levels: ["off"] });
				}
				return response(command.type, {
					commands: [{ name: sessionHandle, source: "prompt", sourceInfo: {} }],
				});
			},
		});

		useModelDirectoryStore.getState().beginSession("session-a");
		useSlashCommandsStore.getState().beginSession("session-a");
		const modelsA = useModelDirectoryStore.getState().refresh("session-a");
		const commandsA = useSlashCommandsStore.getState().refresh("session-a");

		useModelDirectoryStore.getState().beginSession("session-b");
		useSlashCommandsStore.getState().beginSession("session-b");
		await Promise.all([
			useModelDirectoryStore.getState().refresh("session-b"),
			useSlashCommandsStore.getState().refresh("session-b"),
		]);
		releaseA?.();
		await Promise.all([modelsA, commandsA]);

		expect(useModelDirectoryStore.getState()).toMatchObject({
			activeSessionHandle: "session-b",
			models: [{ id: "session-b-model" }],
			currentModel: { provider: "session-b", modelId: "session-b-model" },
		});
		expect(useSlashCommandsStore.getState()).toMatchObject({
			activeSessionHandle: "session-b",
			commands: [{ name: "session-b" }],
		});

		useModelDirectoryStore.getState().beginSession("session-a");
		useSlashCommandsStore.getState().beginSession("session-a");
		expect(useModelDirectoryStore.getState().models[0]?.id).toBe("session-a-model");
		expect(useSlashCommandsStore.getState().commands[0]?.name).toBe("session-a");
	});

	it("routes delayed model mutations through the target Session transport", async () => {
		let releaseA: (() => void) | undefined;
		const aGate = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const calls: Array<{ sessionHandle: string; command: RpcCommand }> = [];
		sessionTransport.store.setState({
			sendCommand: async (sessionHandle: string, command: RpcCommand) => {
				calls.push({ sessionHandle, command });
				if (sessionHandle === "session-a" && command.type === "set_model") await aGate;
				return response(command.type, model(sessionHandle));
			},
		});

		const directory = useModelDirectoryStore.getState();
		directory.beginSession("session-a");
		const selectA = directory.selectModel("session-a", "provider-a", "model-a");
		directory.beginSession("session-b");
		directory.applyStateForSession("session-b", {
			model: model("session-b"),
			thinkingLevel: "high",
		});
		releaseA?.();
		await selectA;

		expect(useModelDirectoryStore.getState()).toMatchObject({
			activeSessionHandle: "session-b",
			currentModel: { provider: "session-b", modelId: "session-b-model" },
			currentThinkingLevel: "high",
		});
		await directory.selectThinkingLevel("session-b", "low");
		expect(calls.map(({ sessionHandle, command }) => [sessionHandle, command.type])).toEqual([
			["session-a", "set_model"],
			["session-b", "set_thinking_level"],
		]);

		directory.beginSession("session-a");
		expect(useModelDirectoryStore.getState().currentModel).toEqual({
			provider: "session-a",
			modelId: "session-a-model",
		});
	});

	it("keeps delayed stats and live background usage on their target Sessions", async () => {
		let releaseA: (() => void) | undefined;
		const aGate = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		sessionTransport.store.setState({
			sendCommand: async (sessionHandle: string, command: RpcCommand) => {
				if (sessionHandle === "session-a") await aGate;
				return response(command.type, { sessionHandle } as unknown as SessionStats);
			},
		});

		const stats = useSessionStatsStore.getState();
		stats.beginSession("session-a");
		const refreshA = stats.refresh("session-a");
		stats.beginSession("session-b");
		await stats.refresh("session-b");
		stats.applyLiveUsageForSession("session-a", { input: 2, output: 3, totalTokens: 5 });
		expect(useSessionStatsStore.getState().liveUsage).toBeNull();
		expect(useSessionStatsStore.getState().bySession["session-a"]?.liveUsage?.totalTokens).toBe(5);
		releaseA?.();
		await refreshA;

		expect(useSessionStatsStore.getState()).toMatchObject({
			activeSessionHandle: "session-b",
			stats: { sessionHandle: "session-b" },
			liveUsage: null,
		});
		stats.beginSession("session-a");
		expect(useSessionStatsStore.getState()).toMatchObject({
			stats: { sessionHandle: "session-a" },
			liveUsage: { input: 2, output: 3, totalTokens: 5 },
		});
		expect(useSessionStatsStore.getState().liveUsage?.totalTokens).toBe(5);
	});
});
