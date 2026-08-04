import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import type { SessionSummary } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import { renameSession } from "../src/lib/session-controller";
import { useModelDirectoryStore } from "../src/stores/model-directory";
import { useSessionControlStore } from "../src/stores/session-control";
import { useSessionDirectoryStore } from "../src/stores/session-directory";
import { useSlashCommandsStore } from "../src/stores/slash-commands";
import { useTransportStore } from "../src/stores/transport";

const model = (workspaceId: string) => ({
	id: `${workspaceId}-model`,
	name: `${workspaceId} model`,
	provider: workspaceId,
	reasoning: false,
	contextWindow: 1,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function response(command: string, data: unknown): RpcResponse {
	return { type: "response", command, success: true, data } as RpcResponse;
}

function session(id: string): SessionSummary {
	return {
		id,
		path: `${id}.jsonl`,
		absolutePath: `/tmp/${id}.jsonl`,
		cwd: "/tmp/workspace",
		messageCount: 1,
		created: "2026-01-01T00:00:00.000Z",
		modified: 0,
	};
}

const originalTransport = useTransportStore.getState();
const originalDirectory = useSessionDirectoryStore.getState();
const originalControl = useSessionControlStore.getState();

afterEach(() => {
	useTransportStore.setState(originalTransport, true);
	useSessionDirectoryStore.setState(originalDirectory, true);
	useSessionControlStore.setState(originalControl, true);
	useModelDirectoryStore.setState({
		byWorkspace: {},
		activeWorkspaceId: null,
		models: [],
		byProvider: {},
		currentModel: null,
		thinkingLevels: [],
		currentThinkingLevel: null,
		loading: false,
		error: undefined,
	});
	useSlashCommandsStore.setState({
		byWorkspace: {},
		activeWorkspaceId: null,
		commands: [],
		loadedAt: null,
		loading: false,
	});
});

describe("workspace-scoped controls", () => {
	it("keeps an active Host session selectable before its empty JSONL file is materialized", async () => {
		const listSessions = vi
			.spyOn(api, "listSessions")
			.mockResolvedValue({ sessions: [], sessionDir: "/tmp/sessions" });
		useSessionDirectoryStore.setState({
			workspaces: [
				{
					id: "workspace-a",
					path: "/tmp/workspace-a",
					displayName: "workspace-a",
					sessionCount: 0,
					lastOpenedAt: null,
				},
			],
			currentWorkspaceId: "workspace-a",
			sessions: [],
			currentSession: null,
		});
		useSessionControlStore.setState({
			workspaceId: "workspace-a",
			lease: "controller",
			reconciling: false,
			session: { id: "session-next", file: "/tmp/session-next.jsonl", epoch: 2 },
		});

		const sessions = await useSessionDirectoryStore.getState().reloadSessions();

		expect(sessions).toEqual([
			expect.objectContaining({
				id: "session-next",
				path: "session-next.jsonl",
				absolutePath: "/tmp/session-next.jsonl",
				cwd: "/tmp/workspace-a",
				messageCount: 0,
			}),
		]);
		listSessions.mockRestore();
	});

	it("does not let a delayed model snapshot overwrite the newly selected workspace", async () => {
		let releaseA: (() => void) | undefined;
		const aGate = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		useTransportStore.setState({
			sendCommand: async (workspaceId, command: RpcCommand) => {
				if (workspaceId === "workspace-a") await aGate;
				const current = model(workspaceId);
				if (command.type === "get_available_models") return response(command.type, { models: [current] });
				if (command.type === "get_state")
					return response(command.type, { model: current, thinkingLevel: "off" });
				return response(command.type, { levels: ["off"] });
			},
		});

		useModelDirectoryStore.getState().beginWorkspace("workspace-a");
		const refreshA = useModelDirectoryStore.getState().refresh("workspace-a");
		useModelDirectoryStore.getState().beginWorkspace("workspace-b");
		await useModelDirectoryStore.getState().refresh("workspace-b");
		releaseA?.();
		await refreshA;

		expect(useModelDirectoryStore.getState()).toMatchObject({
			activeWorkspaceId: "workspace-b",
			models: [{ id: "workspace-b-model" }],
			currentModel: { provider: "workspace-b", modelId: "workspace-b-model" },
		});
	});

	it("does not let delayed slash commands appear in another workspace", async () => {
		let releaseA: (() => void) | undefined;
		const aGate = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		useTransportStore.setState({
			sendCommand: async (workspaceId, command: RpcCommand) => {
				if (workspaceId === "workspace-a") await aGate;
				return response(command.type, {
					commands: [{ name: workspaceId, source: "prompt", sourceInfo: {} }],
				});
			},
		});

		useSlashCommandsStore.getState().beginWorkspace("workspace-a");
		const refreshA = useSlashCommandsStore.getState().refresh("workspace-a");
		useSlashCommandsStore.getState().beginWorkspace("workspace-b");
		await useSlashCommandsStore.getState().refresh("workspace-b");
		releaseA?.();
		await refreshA;

		expect(useSlashCommandsStore.getState()).toMatchObject({
			activeWorkspaceId: "workspace-b",
			commands: [{ name: "workspace-b" }],
		});
	});

	it("does not send a rename command for a non-current session", async () => {
		const sendCommand = vi.fn<() => Promise<RpcResponse>>();
		useTransportStore.setState({ wsState: "online", sendCommand });
		useSessionDirectoryStore.setState({
			currentWorkspaceId: "workspace-a",
			currentSession: session("session-b"),
		});
		useSessionControlStore.setState({
			workspaceId: "workspace-a",
			lease: "controller",
			reconciling: false,
			session: { id: "session-b", file: "/tmp/session-b.jsonl", epoch: 1 },
		});

		await renameSession(session("session-a"), "must not apply");

		expect(sendCommand).not.toHaveBeenCalled();
	});
});
