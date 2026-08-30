import {
	type ExtensionUiSnapshotDto,
	isExtensionUiRequestDto,
	isPiExtensionUiRequestDto,
	isSessionMessageDto,
	isSessionProjectionEventDto,
	isSessionReplayFrameDto,
	isSessionRuntimeDto,
	isSessionSnapshotDto,
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
	type SessionContentRefDto,
	type SessionContentRefGuardContext,
	type SessionExternalJsonDto,
	type SessionExternalTextDto,
	type SessionMessageDto,
	type SessionReplayFrameDto,
	type SessionSnapshotDto,
} from "@pi-agent-web/protocol";
import { describe, expect, it, vi } from "vitest";
import {
	createSessionContentAdapter,
	SessionContentAdapterError,
	type SessionExtensionMaterializer,
} from "../src/lib/session-content-adapter";
import { createSessionContentResolver } from "../src/lib/session-content-resolver";

const CONTENT_BYTES = SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes;
const trustedContext: SessionContentRefGuardContext = Object.freeze({
	serverEpoch: "projected-content-epoch",
	payloadBudget: SESSION_PAYLOAD_BUDGET,
	contentRefBudget: SESSION_CONTENT_REF_BUDGET,
});
const identity = Object.freeze({
	serverEpoch: trustedContext.serverEpoch,
	sessionHandle: "session-projected-content",
	workspaceId: "workspace-projected-content",
	generation: 2,
});

function contentRef(digest: string): SessionContentRefDto {
	return {
		type: "content_ref",
		serverEpoch: trustedContext.serverEpoch,
		sha256: digest.repeat(64),
		byteLength: CONTENT_BYTES,
		encoding: "utf-8",
	};
}

function externalText(digest: string): SessionExternalTextDto {
	return { type: "external_text", ref: contentRef(digest) };
}

function externalJson(digest: string): SessionExternalJsonDto {
	return { type: "external_json", ref: contentRef(digest) };
}

function paddedText(prefix: string): string {
	return `${prefix}${"x".repeat(CONTENT_BYTES - prefix.length)}`;
}

function jsonText(value: unknown): string {
	const encoded = JSON.stringify(value);
	return `${encoded}${" ".repeat(CONTENT_BYTES - encoded.length)}`;
}

function response(text: string): Response {
	return new Response(text, {
		status: 200,
		headers: {
			"Cache-Control": "no-store",
			"Content-Length": String(new TextEncoder().encode(text).byteLength),
			"Content-Type": "application/octet-stream",
			"Cross-Origin-Resource-Policy": "same-origin",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function projectedToolResult(id: string, details: SessionExternalJsonDto): SessionMessageDto {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "fixture",
		content: [{ type: "text", text: "done" }],
		details,
		isError: false,
		timestamp: 1,
	};
}

function extensionFrame(request: SessionReplayFrameDto & { type: "extension_ui_request" }) {
	return request;
}

function fakeMaterializer(value: unknown): SessionExtensionMaterializer {
	return {
		async materializeExtensionRequest() {
			return value;
		},
	};
}

function minimalSnapshot(): SessionSnapshotDto {
	return {
		...identity,
		type: "session_snapshot",
		snapshotId: "minimal-projected-content",
		baseSeq: 0,
		asOfSeq: 0,
		runtime: {
			...identity,
			nativeSessionId: "minimal-native",
			sessionFile: "/tmp/minimal-projected-content.jsonl",
			cwd: "/tmp",
			lastSeq: 0,
			state: "waiting_ui",
			lastActivityAt: 1,
			recoverable: true,
		},
		settledMessages: [],
		projectionEvents: [],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests: [
			{
				type: "extension_ui_request",
				id: "minimal-editor",
				method: "editor",
				title: "Editor",
			},
		],
		stickyExtensionState: [],
	};
}

describe("projected Session content adapter", () => {
	it("eagerly materializes an ordered live/replay Extension frame and reruns the current guard", async () => {
		const text = paddedText("editor-prefill");
		const fetcher = vi.fn(async () => response(text));
		const resolver = createSessionContentResolver({ trustedContext, fetcher });
		const adapter = createSessionContentAdapter({ trustedContext, resolver });
		const frame = extensionFrame({
			...identity,
			type: "extension_ui_request",
			seq: 4,
			request: {
				type: "extension_ui_request",
				id: "editor-live",
				method: "editor",
				title: "Editor",
				prefill: externalText("a"),
			},
		});

		const projected = await adapter.materializeReplayFrame(frame);

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(projected).toMatchObject({
			...identity,
			type: "extension_ui_request",
			seq: 4,
			request: { id: "editor-live", method: "editor", prefill: text },
		});
		if (projected.type !== "extension_ui_request") throw new Error("Extension frame was not retained");
		expect(isPiExtensionUiRequestDto(projected.request)).toBe(true);
		expect(isSessionReplayFrameDto(projected, trustedContext)).toBe(false);
		resolver.dispose();
	});

	it("keeps non-Extension tool refs lazy while projecting inline JSON only at its selected root", async () => {
		const fetcher = vi.fn(async () => new Response(null, { status: 500 }));
		const resolver = createSessionContentResolver({ trustedContext, fetcher });
		const adapter = createSessionContentAdapter({ trustedContext, resolver });
		const args = externalJson("b");
		const frame: SessionReplayFrameDto = {
			...identity,
			type: "event",
			seq: 5,
			event: {
				type: "tool_execution_start",
				toolCallId: "tool-call",
				toolName: "fixture",
				args,
			},
		};
		const nested = {
			type: "inline_json",
			value: {
				nested: {
					type: "external_json",
					ref: {
						type: "content_ref",
						serverEpoch: trustedContext.serverEpoch,
						sha256: "c".repeat(64),
						byteLength: CONTENT_BYTES,
						encoding: "utf-8",
					},
				},
			},
		};

		await expect(adapter.materializeReplayFrame(frame)).resolves.toBe(frame);
		expect(adapter.projectJsonRoot(nested)).toEqual({ kind: "inline", value: nested.value });
		expect(adapter.projectJsonRoot(args)).toEqual({ kind: "external", value: args });
		expect(fetcher).not.toHaveBeenCalled();
		resolver.dispose();
	});

	it("projects inline text synchronously and retains an external text wrapper for lazy consumers", () => {
		const resolver = createSessionContentResolver({ trustedContext, fetcher: async () => response("") });
		const adapter = createSessionContentAdapter({ trustedContext, resolver });
		const deferred = externalText("d");

		expect(adapter.projectTextPayload("inline")).toEqual({ kind: "inline", value: "inline" });
		expect(adapter.projectTextPayload(deferred)).toEqual({ kind: "external", value: deferred });
		resolver.dispose();
	});

	it("materializes Extension state in a projected snapshot without touching message or event refs", async () => {
		const editor = paddedText("snapshot-editor");
		const widget = ["alpha", "beta"];
		const bodies = new Map([
			["e".repeat(64), editor],
			["f".repeat(64), jsonText(widget)],
		]);
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const body = bodies.get(String(input).split("/").at(-1) ?? "");
			return body === undefined ? new Response(null, { status: 404 }) : response(body);
		});
		const resolver = createSessionContentResolver({ trustedContext, fetcher });
		const adapter = createSessionContentAdapter({ trustedContext, resolver });
		const lazyDetails = externalJson("1");
		const toolResult = projectedToolResult("snapshot-tool", lazyDetails);
		const snapshot: SessionSnapshotDto = {
			...identity,
			type: "session_snapshot",
			snapshotId: "snapshot-projected-content",
			baseSeq: 1,
			asOfSeq: 2,
			runtime: {
				...identity,
				nativeSessionId: "native-projected-content",
				sessionFile: "/tmp/projected-content.jsonl",
				cwd: "/tmp",
				lastSeq: 2,
				state: "idle",
				lastActivityAt: 1,
				recoverable: true,
			},
			settledMessages: [toolResult],
			projectionEvents: [
				{
					...identity,
					type: "event",
					seq: 2,
					event: {
						type: "message_end",
						message: projectedToolResult("snapshot-event-tool", externalJson("8")),
					},
				},
			],
			queue: { steering: [], followUp: [] },
			pendingExtensionRequests: [
				{
					type: "extension_ui_request",
					id: "snapshot-editor",
					method: "editor",
					title: "Snapshot editor",
					prefill: externalText("e"),
				},
			],
			stickyExtensionState: [
				{
					type: "extension_ui_request",
					id: "snapshot-widget",
					method: "setWidget",
					widgetKey: "root",
					widgetLines: externalJson("f"),
				},
			],
		};

		expect(isSessionProjectionEventDto(snapshot.projectionEvents[0], trustedContext)).toBe(true);
		expect(isSessionMessageDto(toolResult, trustedContext)).toBe(true);
		expect(isSessionRuntimeDto(snapshot.runtime)).toBe(true);
		expect(isExtensionUiRequestDto(snapshot.pendingExtensionRequests[0], trustedContext)).toBe(true);
		expect(isExtensionUiRequestDto(snapshot.stickyExtensionState[0], trustedContext)).toBe(true);
		expect(isSessionSnapshotDto(snapshot, trustedContext)).toBe(true);
		const projected = await adapter.materializeSnapshot(snapshot);

		expect(projected.pendingExtensionRequests).toEqual([
			expect.objectContaining({ id: "snapshot-editor", prefill: editor }),
		]);
		expect(projected.stickyExtensionState).toEqual([
			expect.objectContaining({ id: "snapshot-widget", widgetLines: widget }),
		]);
		expect(projected.settledMessages).toBe(snapshot.settledMessages);
		expect(projected.projectionEvents).toBe(snapshot.projectionEvents);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(isSessionSnapshotDto(projected, trustedContext)).toBe(false);
		resolver.dispose();
	});

	it("materializes every request in an Extension snapshot in source order", async () => {
		const first = paddedText("first-editor");
		const second = paddedText("second-editor");
		const bodies = [first, second];
		const fetcher = vi.fn(async () => response(bodies.shift() ?? ""));
		const resolver = createSessionContentResolver({ trustedContext, fetcher });
		const adapter = createSessionContentAdapter({ trustedContext, resolver });
		const snapshot: ExtensionUiSnapshotDto = {
			type: "extension_ui_snapshot",
			serverEpoch: trustedContext.serverEpoch,
			sessionHandle: identity.sessionHandle,
			generation: identity.generation,
			requests: [
				{
					type: "extension_ui_request",
					id: "first",
					method: "set_editor_text",
					text: externalText("2"),
				},
				{
					type: "extension_ui_request",
					id: "second",
					method: "set_editor_text",
					text: externalText("3"),
				},
			],
		};

		await expect(adapter.materializeExtensionSnapshot(snapshot)).resolves.toMatchObject({
			requests: [
				{ id: "first", text: first },
				{ id: "second", text: second },
			],
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		resolver.dispose();
	});

	it("materializes replay batches sequentially without changing envelope order", async () => {
		const first = paddedText("first-replay");
		const second = paddedText("second-replay");
		const bodies = [first, second];
		const fetcher = vi.fn(async () => response(bodies.shift() ?? ""));
		const resolver = createSessionContentResolver({ trustedContext, fetcher });
		const adapter = createSessionContentAdapter({ trustedContext, resolver });
		const frames: SessionReplayFrameDto[] = [
			extensionFrame({
				...identity,
				type: "extension_ui_request",
				seq: 8,
				request: {
					type: "extension_ui_request",
					id: "first-replay",
					method: "set_editor_text",
					text: externalText("5"),
				},
			}),
			extensionFrame({
				...identity,
				type: "extension_ui_request",
				seq: 9,
				request: {
					type: "extension_ui_request",
					id: "second-replay",
					method: "set_editor_text",
					text: externalText("6"),
				},
			}),
		];

		await expect(adapter.materializeReplayFrames(frames)).resolves.toMatchObject([
			{ seq: 8, request: { id: "first-replay", text: first } },
			{ seq: 9, request: { id: "second-replay", text: second } },
		]);
		expect(fetcher).toHaveBeenCalledTimes(2);
		resolver.dispose();
	});

	it("forwards caller abort to an eager Extension materialization", async () => {
		let fetchSignal: AbortSignal | undefined;
		const resolver = createSessionContentResolver({
			trustedContext,
			fetcher: async (_input, init) => {
				fetchSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					fetchSignal?.addEventListener(
						"abort",
						() => reject(new DOMException("The operation was aborted", "AbortError")),
						{ once: true },
					);
				});
			},
		});
		const adapter = createSessionContentAdapter({ trustedContext, resolver });
		const controller = new AbortController();
		const pending = adapter.materializeReplayFrame(
			extensionFrame({
				...identity,
				type: "extension_ui_request",
				seq: 10,
				request: {
					type: "extension_ui_request",
					id: "aborted-replay",
					method: "set_editor_text",
					text: externalText("7"),
				},
			}),
			controller.signal,
		);

		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchSignal?.aborted).toBe(true);
		resolver.dispose();
	});

	it("fails closed against the exact trusted context before materialization", async () => {
		const fetcher = vi.fn(async () => response(paddedText("unreachable")));
		const resolver = createSessionContentResolver({ trustedContext, fetcher });
		const adapter = createSessionContentAdapter({ trustedContext, resolver });
		const wrongEpoch: unknown = {
			...identity,
			serverEpoch: "other-epoch",
			type: "extension_ui_request",
			seq: 1,
			request: {
				type: "extension_ui_request",
				id: "wrong-epoch",
				method: "set_editor_text",
				text: externalText("4"),
			},
		};

		await expect(adapter.materializeReplayFrame(wrongEpoch)).rejects.toBeInstanceOf(
			SessionContentAdapterError,
		);
		expect(fetcher).not.toHaveBeenCalled();
		resolver.dispose();
	});

	it("rejects a malformed current request returned while materializing a Session snapshot", async () => {
		const adapter = createSessionContentAdapter({
			trustedContext,
			resolver: fakeMaterializer({
				type: "extension_ui_request",
				id: "malformed-editor",
				method: "editor",
			}),
		});

		await expect(adapter.materializeSnapshot(minimalSnapshot())).rejects.toBeInstanceOf(
			SessionContentAdapterError,
		);
	});

	it("rejects a malformed current request returned while materializing an Extension snapshot", async () => {
		const snapshot: ExtensionUiSnapshotDto = {
			type: "extension_ui_snapshot",
			serverEpoch: trustedContext.serverEpoch,
			sessionHandle: identity.sessionHandle,
			generation: identity.generation,
			requests: [
				{
					type: "extension_ui_request",
					id: "valid-source",
					method: "set_editor_text",
					text: "valid",
				},
			],
		};
		const adapter = createSessionContentAdapter({
			trustedContext,
			resolver: fakeMaterializer({
				type: "extension_ui_request",
				id: "malformed-set-editor",
				method: "set_editor_text",
			}),
		});

		await expect(adapter.materializeExtensionSnapshot(snapshot)).rejects.toBeInstanceOf(
			SessionContentAdapterError,
		);
	});
});
