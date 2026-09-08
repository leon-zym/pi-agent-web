import type { ModelDto, PiSessionCommandResponseDto, SessionCommandDto } from "@pi-agent-web/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useModelDirectoryStore } from "../src/stores/model-directory";
import { sessionTransport } from "../src/stores/session-transport";

const transport = sessionTransport.store.getState();
const plain: ModelDto = {
	id: "plain",
	name: "Plain",
	provider: "test",
	reasoning: false,
	contextWindow: 100,
};
const reason: ModelDto = { ...plain, id: "reason", name: "Reason", reasoning: true };
const extended: ModelDto = { ...reason, id: "extended", name: "Extended" };
const response = (command: string, data: unknown) =>
	({ type: "response", command, success: true, data }) as PiSessionCommandResponseDto;
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

beforeEach(() => {
	for (const handle of Object.keys(useModelDirectoryStore.getState().bySession)) {
		useModelDirectoryStore.getState().forgetSession(handle);
	}
	useModelDirectoryStore.getState().beginSession("a");
});
afterEach(() => sessionTransport.store.setState(transport, true));

it("reads upstream capabilities and effective thinking after each model switch", async () => {
	let current = plain;
	sessionTransport.store.setState({
		sendCommand: async (_handle: string, command: SessionCommandDto) => {
			if (command.type === "set_model") current = command.modelId === "reason" ? reason : extended;
			if (command.type === "get_available_models")
				return response(command.type, { models: [plain, reason, extended] });
			if (command.type === "get_state")
				return response(command.type, { model: current, thinkingLevel: current === plain ? "off" : "high" });
			if (command.type === "get_available_thinking_levels")
				return response(command.type, {
					levels: current === plain ? ["off"] : current === reason ? ["low", "high"] : ["high", "max"],
				});
			return response(command.type, current);
		},
	});
	const directory = useModelDirectoryStore.getState();
	await directory.refresh("a");
	await directory.selectModel("a", "test", "reason");
	expect(useModelDirectoryStore.getState()).toMatchObject({
		thinkingLevels: ["low", "high"],
		currentThinkingLevel: "high",
	});
	await directory.selectModel("a", "test", "extended");
	expect(useModelDirectoryStore.getState()).toMatchObject({
		thinkingLevels: ["high", "max"],
		currentThinkingLevel: "high",
	});
});

it("keeps fresh directory data while an old refresh cannot overwrite a newer thinking event", async () => {
	const delayed = gate();
	sessionTransport.store.setState({
		sendCommand: async (_handle: string, command: SessionCommandDto) => {
			if (command.type === "get_available_models") {
				await delayed.promise;
				return response(command.type, { models: [reason, extended] });
			}
			if (command.type === "get_state")
				return response(command.type, { model: reason, thinkingLevel: "low" });
			return response(command.type, { levels: ["low", "high"] });
		},
	});
	const directory = useModelDirectoryStore.getState();
	const refresh = directory.refresh("a");
	directory.applyThinkingLevelForSession("a", "high");
	delayed.release();
	await refresh;
	expect(useModelDirectoryStore.getState()).toMatchObject({
		models: [reason, extended],
		thinkingLevels: ["low", "high"],
		currentThinkingLevel: "high",
		loading: false,
	});
});

it("does not let an old refresh replace a completed model selection", async () => {
	const delayed = gate();
	let selected = false;
	sessionTransport.store.setState({
		sendCommand: async (_handle: string, command: SessionCommandDto) => {
			if (command.type === "set_model") {
				selected = true;
				return response(command.type, reason);
			}
			if (command.type === "get_available_models") {
				await delayed.promise;
				return response(command.type, { models: [plain, reason] });
			}
			if (command.type === "get_state")
				return response(command.type, {
					model: selected ? reason : plain,
					thinkingLevel: selected ? "high" : "off",
				});
			return response(command.type, { levels: selected ? ["low", "high"] : ["off"] });
		},
	});
	const directory = useModelDirectoryStore.getState();
	const refresh = directory.refresh("a");
	await directory.selectModel("a", "test", "reason");
	delayed.release();
	await refresh;
	expect(useModelDirectoryStore.getState()).toMatchObject({
		models: [plain, reason],
		currentModel: { provider: "test", modelId: "reason" },
		thinkingLevels: ["low", "high"],
		currentThinkingLevel: "high",
	});
});

it("discards superseded capability reads and completes the newest selection on its background Session", async () => {
	const oldRead = gate();
	let current = reason;
	sessionTransport.store.setState({
		sendCommand: async (_handle: string, command: SessionCommandDto) => {
			if (command.type === "set_model") {
				current = command.modelId === "reason" ? reason : extended;
				return response(command.type, current);
			}
			const captured = current;
			if (captured === reason) await oldRead.promise;
			if (command.type === "get_state")
				return response(command.type, {
					model: captured,
					thinkingLevel: captured === reason ? "low" : "max",
				});
			return response(command.type, { levels: captured === reason ? ["low", "high"] : ["high", "max"] });
		},
	});
	const directory = useModelDirectoryStore.getState();
	const first = directory.selectModel("a", "test", "reason");
	await Promise.resolve();
	const second = directory.selectModel("a", "test", "extended");
	directory.beginSession("b");
	directory.applyStateForSession("b", { model: plain, thinkingLevel: "off" });
	await second;
	oldRead.release();
	await first;
	expect(useModelDirectoryStore.getState().bySession.a).toMatchObject({
		currentModel: { modelId: "extended" },
		thinkingLevels: ["high", "max"],
		currentThinkingLevel: "max",
	});
	expect(useModelDirectoryStore.getState()).toMatchObject({
		activeSessionHandle: "b",
		currentModel: { modelId: "plain" },
		currentThinkingLevel: "off",
	});
});

it("preserves a newer thinking event during capability reads and ignores forgotten completions", async () => {
	const delayed = gate();
	sessionTransport.store.setState({
		sendCommand: async (_handle: string, command: SessionCommandDto) => {
			if (command.type === "set_model") return response(command.type, reason);
			await delayed.promise;
			return response(
				command.type,
				command.type === "get_state" ? { model: reason, thinkingLevel: "low" } : { levels: ["low", "high"] },
			);
		},
	});
	const directory = useModelDirectoryStore.getState();
	const first = directory.selectModel("a", "test", "reason");
	const forgotten = directory.selectModel("forgotten", "test", "reason");
	await Promise.resolve();
	directory.applyThinkingLevelForSession("a", "high");
	directory.forgetSession("forgotten");
	delayed.release();
	await Promise.all([first, forgotten]);
	expect(useModelDirectoryStore.getState()).toMatchObject({
		thinkingLevels: ["low", "high"],
		currentThinkingLevel: "high",
	});
	expect(useModelDirectoryStore.getState().bySession.forgotten).toBeUndefined();
});
