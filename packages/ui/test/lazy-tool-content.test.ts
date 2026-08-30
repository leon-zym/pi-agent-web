import type {
	SessionExternalJsonDto,
	SessionExternalTextDto,
	SessionJsonValueDto,
	SessionRuntimeDto,
	SessionRuntimeIdentityDto,
} from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import {
	type ContentTransportFacade,
	createSessionRuntimeIdentity,
	materializeLazyToolContent,
	type ToolCallBlock,
} from "../src/features/conversation/use-lazy-tool-content";
import type {
	SessionJsonRootProjection,
	SessionTextPayloadProjection,
} from "../src/lib/session-content-adapter";
import type { UiToolResult } from "../src/types/view-models";

const runtime: SessionRuntimeDto = {
	serverEpoch: "lazy-content-epoch",
	workspaceId: "workspace-a",
	sessionHandle: "session-a",
	generation: 7,
	nativeSessionId: "native-a",
	sessionFile: null,
	cwd: "/workspace",
	lastSeq: 4,
	state: "idle",
	lastActivityAt: 1,
	recoverable: true,
};

const identity = createSessionRuntimeIdentity(runtime, runtime.sessionHandle);

function externalText(key: string): SessionExternalTextDto {
	return {
		type: "external_text",
		ref: {
			type: "content_ref",
			serverEpoch: runtime.serverEpoch,
			sha256: key.repeat(64),
			byteLength: 4_096,
			encoding: "utf-8",
		},
	};
}

function externalJson(key: string): SessionExternalJsonDto {
	return {
		type: "external_json",
		ref: {
			type: "content_ref",
			serverEpoch: runtime.serverEpoch,
			sha256: key.repeat(64),
			byteLength: 4_096,
			encoding: "utf-8",
		},
	};
}

function toolBlock(overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
	return {
		type: "tool_call",
		key: "tool-1",
		toolCallId: "call-1",
		toolName: "fixture",
		argsText: "",
		args: undefined,
		status: "done",
		...overrides,
	};
}

function fakeTransport(textRequests: string[], jsonRequests: string[]): ContentTransportFacade {
	const jsonValues = new Map<string, SessionJsonValueDto>([
		["a", { command: "echo materialized" }],
		["b", { partial: "partial materialized" }],
		["c", { output: "result materialized" }],
		["d", { details: "details materialized" }],
	]);

	return {
		resolveText: async (
			_identity: SessionRuntimeIdentityDto,
			payload: SessionTextPayloadProjection,
			_signal?: AbortSignal,
		): Promise<string> => {
			if (payload.kind !== "external") throw new Error("text fixture was unexpectedly inline");
			textRequests.push(payload.value.ref.sha256[0] ?? "missing");
			return `text-${payload.value.ref.sha256[0] ?? "missing"}`;
		},
		resolveJson: async <T>(
			_identity: SessionRuntimeIdentityDto,
			payload: SessionJsonRootProjection,
			guard: (value: unknown) => value is T,
			_signal?: AbortSignal,
		): Promise<T> => {
			if (payload.kind !== "external") throw new Error("JSON fixture was unexpectedly inline");
			jsonRequests.push(payload.value.ref.sha256[0] ?? "missing");
			const value = jsonValues.get(payload.value.ref.sha256[0] ?? "") ?? null;
			if (!guard(value)) throw new Error("JSON guard rejected the fixture");
			return value;
		},
	};
}

describe("lazy tool content consumers", () => {
	it("materializes every root into an isolated clone and keeps text order", async () => {
		const textRequests: string[] = [];
		const jsonRequests: string[] = [];
		const transport = fakeTransport(textRequests, jsonRequests);
		const inlineArgs = { inline: { value: "clone me" } };
		const block = toolBlock({
			args: undefined,
			argsPayload: { kind: "external", value: externalJson("a") },
			partialResultPayload: { kind: "external", value: externalJson("b") },
			resultPayload: { kind: "external", value: externalJson("c") },
		});
		const result: UiToolResult = {
			toolCallId: block.toolCallId,
			toolName: block.toolName,
			content: "",
			textPayloads: [
				{ kind: "inline", value: "first" },
				{ kind: "external", value: externalText("e") },
				{ kind: "inline", value: "third" },
			],
			isError: false,
			details: undefined,
			detailsPayload: { kind: "inline", value: inlineArgs },
		};
		const controller = new AbortController();

		const materialized = await materializeLazyToolContent({
			identity,
			block,
			results: [result],
			transport,
			signal: controller.signal,
		});

		expect(Object.keys(materialized.block)).toEqual(expect.arrayContaining(Object.keys(block)));
		expect(materialized.block).not.toBe(block);
		expect(materialized.block.args).toEqual({ command: "echo materialized" });
		expect(materialized.block.partialOutput).toBe("result materialized");
		expect(materialized.block.result).toEqual({ output: "result materialized" });
		expect(materialized.results[0]?.content).toBe("first\ntext-e\nthird");
		expect(materialized.results[0]?.details).toEqual(inlineArgs);
		expect(materialized.results[0]?.details).not.toBe(inlineArgs);
		expect(materialized.results[0]).not.toBe(result);
		expect(textRequests).toEqual(["e"]);
		expect(jsonRequests).toEqual(["a", "b", "c"]);
	});

	it("aborts sibling roots when one parallel materialization fails", async () => {
		let siblingSignal: AbortSignal | undefined;
		const transport: ContentTransportFacade = {
			resolveText: async () => "unused",
			resolveJson: async <T>(
				_identity: SessionRuntimeIdentityDto,
				payload: SessionJsonRootProjection,
				guard: (value: unknown) => value is T,
				signal?: AbortSignal,
			): Promise<T> => {
				if (payload.kind !== "external") throw new Error("JSON fixture was unexpectedly inline");
				if (payload.value.ref.sha256.startsWith("a")) throw new Error("args failed");
				if (!signal) throw new Error("fixture signal was not provided");
				siblingSignal = signal;
				return new Promise<T>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new DOMException("sibling aborted", "AbortError")), {
						once: true,
					});
					const pending: SessionJsonValueDto = { pending: true };
					if (!guard(pending)) reject(new Error("fixture guard rejected"));
				});
			},
		};
		const controller = new AbortController();
		const block = toolBlock({
			argsPayload: { kind: "external", value: externalJson("a") },
			resultPayload: { kind: "external", value: externalJson("b") },
		});

		await expect(
			materializeLazyToolContent({
				identity,
				block,
				results: [],
				transport,
				signal: controller.signal,
				abortSiblings: () => controller.abort(),
			}),
		).rejects.toThrow("args failed");
		expect(siblingSignal?.aborted).toBe(true);
	});

	it("creates a frozen four-field identity without leaking runtime metadata", () => {
		if (!identity) throw new Error("fixture identity was not created");
		expect(identity).toEqual({
			serverEpoch: runtime.serverEpoch,
			workspaceId: runtime.workspaceId,
			sessionHandle: runtime.sessionHandle,
			generation: runtime.generation,
		});
		expect(Object.keys(identity)).toHaveLength(4);
		expect(Object.isFrozen(identity)).toBe(true);
		expect(createSessionRuntimeIdentity(null, runtime.sessionHandle)).toBeNull();
	});
});
