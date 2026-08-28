import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	FUTURE_SESSION_CONTENT_REF_BUDGET,
	SESSION_CONTENT_INLINE_THRESHOLD_BYTES,
	SESSION_PAYLOAD_BUDGET,
	type SessionContentRefDto,
} from "@pi-agent-web/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EpochContentStore, EpochContentStoreError } from "../src/epoch-content-store.js";
import { isLegacyRpcV1FutureContentRawExtensionUiRequest } from "../src/legacy-rpc-v1-content-wire.js";
import {
	externalizePiPayload,
	type PiGenericPayloadExternalizerContentStore,
} from "../src/pi-payload-externalizer.js";

const EPOCH = "generic-externalizer-epoch";
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
const PNG_IEND = Buffer.from("0000000049454e4400000000", "hex");
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function options(store: EpochContentStore) {
	return {
		contentStore: store,
		serverEpoch: EPOCH,
		payloadBudget: SESSION_PAYLOAD_BUDGET,
		genericContent: { contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET },
	};
}

function toolResult(content: unknown, details?: unknown) {
	return {
		role: "toolResult",
		toolCallId: "tool-1",
		toolName: "read",
		content,
		...(details === undefined ? {} : { details }),
		isError: false,
		timestamp: 1,
	};
}

function event(message: unknown) {
	return { type: "message_start", message };
}

function image() {
	const bytes = Buffer.concat([PNG_HEADER, Buffer.alloc(8), PNG_IEND]);
	return { bytes, block: { type: "image", data: bytes.toString("base64"), mimeType: "image/png" } };
}

function contentRefs(value: unknown): SessionContentRefDto[] {
	const refs: SessionContentRefDto[] = [];
	const stack = [value];
	while (stack.length > 0) {
		const candidate = stack.pop();
		if (!candidate || typeof candidate !== "object") continue;
		if (!Array.isArray(candidate) && (candidate as Record<string, unknown>).type === "content_ref") {
			refs.push(candidate as SessionContentRefDto);
			continue;
		}
		stack.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate)));
	}
	return refs;
}

describe("Pi payload generic content externalizer", () => {
	let webDataDir: string;
	let store: EpochContentStore;

	beforeEach(async () => {
		webDataDir = await mkdtemp(path.join(tmpdir(), "pi-web-generic-externalizer-"));
		store = new EpochContentStore({ webDataDir, serverEpoch: EPOCH });
		await store.initialize();
	});

	afterEach(async () => {
		await store.shutdown();
		await rm(webDataDir, { recursive: true, force: true });
	});

	it("keeps generic content hard-off when the option is absent", async () => {
		const wide = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		const stageUtf8 = vi.spyOn(store, "stageUtf8");
		const holdPublishedUtf8 = vi.spyOn(store, "holdPublishedUtf8");
		const value = {
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			args: { wide },
		};
		const result = await externalizePiPayload(
			{ kind: "event", value },
			{ contentStore: store, serverEpoch: EPOCH, payloadBudget: SESSION_PAYLOAD_BUDGET },
		);
		expect(result.value).toBe(value);
		expect(result.lease.refs).toEqual([]);
		expect(stageUtf8).not.toHaveBeenCalled();
		expect(holdPublishedUtf8).not.toHaveBeenCalled();
		await result.lease.release();
	});

	it("externalizes only the three future Extension roots and normalizes the whole widget array", async () => {
		const wide = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		const editor = await externalizePiPayload(
			{
				kind: "extension_ui_request",
				value: {
					type: "extension_ui_request",
					id: "editor-a",
					method: "editor",
					title: "Edit",
					prefill: wide,
				},
			},
			options(store),
		);
		expect(editor.value).toEqual(
			expect.objectContaining({
				prefill: { type: "external_text", ref: expect.objectContaining({ type: "content_ref" }) },
			}),
		);
		expect(editor.lease.refs).toHaveLength(1);

		const setEditorText = await externalizePiPayload(
			{
				kind: "extension_ui_request",
				value: {
					type: "extension_ui_request",
					id: "set-editor-a",
					method: "set_editor_text",
					text: wide,
				},
			},
			options(store),
		);
		expect(setEditorText.value).toEqual(
			expect.objectContaining({
				text: { type: "external_text", ref: expect.objectContaining({ type: "content_ref" }) },
			}),
		);
		expect(setEditorText.lease.refs).toHaveLength(1);

		const widgetLines = ["one", wide];
		const widget = await externalizePiPayload(
			{
				kind: "extension_ui_request",
				value: {
					type: "extension_ui_request",
					id: "widget-a",
					method: "setWidget",
					widgetKey: "tests",
					widgetLines,
				},
			},
			options(store),
		);
		expect(widget.value).toEqual(
			expect.objectContaining({
				widgetLines: { type: "external_json", ref: expect.objectContaining({ type: "content_ref" }) },
			}),
		);
		expect(widget.lease.refs).toHaveLength(1);

		await Promise.all([editor.lease.release(), setEditorText.lease.release(), widget.lease.release()]);
	});

	it("externalizes a whole widget root whose single line exceeds the current text limit", async () => {
		const wideLine = "x".repeat(1024 * 1024 + 1);
		const request = {
			type: "extension_ui_request",
			id: "widget-wide-line",
			method: "setWidget",
			widgetKey: "tests",
			widgetPlacement: "belowEditor",
			widgetLines: [wideLine],
		} as const;
		expect(Buffer.byteLength(JSON.stringify(request.widgetLines))).toBeLessThan(
			FUTURE_SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes,
		);
		expect(Buffer.byteLength(JSON.stringify(request.widgetLines))).toBeGreaterThanOrEqual(
			SESSION_CONTENT_INLINE_THRESHOLD_BYTES,
		);
		expect(isLegacyRpcV1FutureContentRawExtensionUiRequest(request)).toBe(true);

		const result = await externalizePiPayload(
			{ kind: "extension_ui_request", value: request },
			options(store),
		);
		expect(result.value).toEqual({
			...request,
			widgetLines: { type: "external_json", ref: expect.objectContaining({ type: "content_ref" }) },
		});
		expect(result.lease.refs).toHaveLength(1);
		await result.lease.release();

		const stageUtf8 = vi.spyOn(store, "stageUtf8");
		await expect(
			externalizePiPayload(
				{ kind: "extension_ui_request", value: { ...request, unexpected: true } },
				options(store),
			),
		).rejects.toMatchObject({ code: "invalid_raw_payload" });
		expect(stageUtf8).not.toHaveBeenCalled();
	});

	it("keeps small Extension text inline, wraps small widget JSON, and rejects excluded wide fields", async () => {
		const editor = await externalizePiPayload(
			{
				kind: "extension_ui_request",
				value: {
					type: "extension_ui_request",
					id: "editor-inline",
					method: "editor",
					title: "Edit",
					prefill: "inline",
				},
			},
			options(store),
		);
		expect(editor.value).toEqual(expect.objectContaining({ prefill: "inline" }));
		expect(editor.lease.refs).toEqual([]);
		await editor.lease.release();

		const widget = await externalizePiPayload(
			{
				kind: "extension_ui_request",
				value: {
					type: "extension_ui_request",
					id: "widget-inline",
					method: "setWidget",
					widgetKey: "tests",
					widgetLines: ["one", "two"],
				},
			},
			options(store),
		);
		expect(widget.value).toEqual(
			expect.objectContaining({ widgetLines: { type: "inline_json", value: ["one", "two"] } }),
		);
		expect(widget.lease.refs).toEqual([]);
		await widget.lease.release();

		await expect(
			externalizePiPayload(
				{
					kind: "extension_ui_request",
					value: {
						type: "extension_ui_request",
						id: "status-wide",
						method: "setStatus",
						statusKey: "status",
						statusText: "x".repeat(1024 * 1024 + 1),
					},
				},
				options(store),
			),
		).rejects.toMatchObject({ code: "invalid_raw_payload" });
	});

	it("rolls back a whole-widget hold when the supplemental product guard rejects", async () => {
		const widgetLines = ["y".repeat(1024 * 1024 + 1)];
		await expect(
			externalizePiPayload(
				{
					kind: "extension_ui_request",
					value: {
						type: "extension_ui_request",
						id: "widget-rejected",
						method: "setWidget",
						widgetKey: "tests",
						widgetLines,
					},
				},
				{ ...options(store), productGuard: () => false },
			),
		).rejects.toMatchObject({ code: "invalid_product_payload" });
		expect(await store.gc()).toEqual({ bytes: Buffer.byteLength(JSON.stringify(widgetLines)), items: 1 });
	});

	it("rejects an invalid generic budget before raw admission or store access", async () => {
		const stageUtf8 = vi.spyOn(store, "stageUtf8");
		await expect(
			externalizePiPayload(
				{ kind: "event", value: null },
				{
					...options(store),
					genericContent: {
						contentRefBudget: {
							...FUTURE_SESSION_CONTENT_REF_BUDGET,
							inlineContentThresholdBytes: SESSION_CONTENT_INLINE_THRESHOLD_BYTES - 1,
						},
					},
				},
			),
		).rejects.toThrow(TypeError);
		expect(stageUtf8).not.toHaveBeenCalled();
	});

	it("externalizes approved text at the exact threshold and wraps every JSON root", async () => {
		const text = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		const details = { nested: { type: "external_json", ref: { forged: true } } };
		const result = await externalizePiPayload(
			{ kind: "event", value: event(toolResult([{ type: "text", text }], details)) },
			options(store),
		);
		const message = (result.value as { message: { content: unknown[]; details: unknown } }).message;
		expect(message.content[0]).toEqual({
			type: "text",
			text: { type: "external_text", ref: expect.objectContaining({ type: "content_ref" }) },
		});
		expect(message.details).toEqual({ type: "inline_json", value: details });
		expect(contentRefs(result.value)).toHaveLength(1);
		expect(result.lease.refs).toEqual(contentRefs(result.value));
		await result.lease.release();
	});

	it("keeps approved text below threshold inline and JSON enveloped", async () => {
		const text = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES - 1);
		const details = {
			type: "external_json",
			ref: { type: "content_ref", forged: true },
			nested: { type: "inline_json", value: "opaque" },
		};
		const result = await externalizePiPayload(
			{ kind: "event", value: event(toolResult([{ type: "text", text }], details)) },
			options(store),
		);
		const message = (result.value as { message: { content: unknown[]; details: unknown } }).message;
		expect(message.content[0]).toEqual({ type: "text", text });
		expect(message.details).toEqual({ type: "inline_json", value: details });
		expect(result.lease.refs).toEqual([]);
		await result.lease.release();
	});

	it("externalizes the closed message and tool event roots without touching excluded strings", async () => {
		const wide = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		const assistant = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { wide } }],
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const cases = [
			{ value: event({ role: "user", content: wide, timestamp: 1 }), refs: 0 },
			{
				value: event({ role: "custom", customType: "bare", content: wide, display: true, timestamp: 1 }),
				refs: 0,
			},
			{
				value: event({
					role: "assistant",
					content: [{ type: "text", text: wide }],
					usage,
					stopReason: "stop",
					timestamp: 1,
				}),
				refs: 0,
			},
			{
				value: {
					type: "message_update",
					usage,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "kept inline" },
				},
				refs: 0,
			},
			{
				value: event({
					role: "custom",
					customType: "blocks",
					content: [{ type: "text", text: wide }],
					display: true,
					details: { wide },
					timestamp: 1,
				}),
				refs: 2,
			},
			{
				value: event({
					role: "bashExecution",
					command: "printf x",
					output: wide,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				}),
				refs: 1,
			},
			{ value: event(assistant), refs: 1 },
			{
				value: {
					type: "message_update",
					usage,
					assistantMessageEvent: {
						type: "toolcall_end",
						contentIndex: 0,
						toolCall: { type: "toolCall", id: "tool-1", name: "read", arguments: { wide } },
					},
				},
				refs: 1,
			},
			{
				value: { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { wide } },
				refs: 1,
			},
			{
				value: {
					type: "tool_execution_update",
					toolCallId: "tool-1",
					toolName: "read",
					args: { wide },
					partialResult: { wide },
				},
				refs: 2,
			},
			{
				value: {
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "read",
					result: { wide },
					isError: false,
				},
				refs: 1,
			},
		];

		for (const { value, refs } of cases) {
			const result = await externalizePiPayload({ kind: "event", value }, options(store));
			if (refs === 0) {
				expect(result.value).toStrictEqual(value);
				expect(result.lease.refs).toEqual([]);
			} else {
				expect(contentRefs(result.value)).toHaveLength(refs);
			}
			await result.lease.release();
		}
	});

	it("deduplicates identical UTF-8 bytes across text and JSON in one frame", async () => {
		const jsonValue = { payload: "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES) };
		const raw = JSON.stringify(jsonValue);
		const stageUtf8 = vi.spyOn(store, "stageUtf8");
		const result = await externalizePiPayload(
			{
				kind: "event",
				value: event(
					toolResult(
						[
							{ type: "text", text: raw },
							{ type: "text", text: raw },
						],
						jsonValue,
					),
				),
			},
			options(store),
		);
		expect(stageUtf8).toHaveBeenCalledTimes(1);
		expect(result.lease.refs).toHaveLength(1);
		expect(contentRefs(result.value)).toHaveLength(3);
		expect(new Set(contentRefs(result.value).map((ref) => ref.sha256))).toEqual(
			new Set([createHash("sha256").update(raw).digest("hex")]),
		);
		await result.lease.release();
	});

	it.each(["get_messages", "get_entries", "get_tree"] as const)(
		"externalizes the closed roots in successful %s history",
		async (command) => {
			const wide = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
			const message = toolResult([{ type: "text", text: wide }], { wide });
			const entry = {
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-08-28T00:00:00.000Z",
				message,
			};
			const data =
				command === "get_messages"
					? { messages: [message] }
					: command === "get_entries"
						? { entries: [entry], leafId: "entry-1" }
						: { tree: [{ entry, children: [] }], leafId: "entry-1" };
			const result = await externalizePiPayload(
				{
					kind: "response",
					expectedCommand: command,
					value: { type: "response", id: command, command, success: true, data },
				},
				options(store),
			);
			expect(contentRefs(result.value)).toHaveLength(2);
			expect(result.lease.refs).toHaveLength(2);
			await result.lease.release();
		},
	);

	it("externalizes custom-message entry text and details but not its bare string form", async () => {
		const wide = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		const base = {
			type: "custom_message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-08-28T00:00:00.000Z",
			customType: "fixture",
			display: true,
		};
		const external = await externalizePiPayload(
			{
				kind: "event",
				value: {
					type: "entry_appended",
					entry: { ...base, content: [{ type: "text", text: wide }], details: { wide } },
				},
			},
			options(store),
		);
		expect(contentRefs(external.value)).toHaveLength(2);
		await external.lease.release();

		const inline = await externalizePiPayload(
			{ kind: "event", value: { type: "entry_appended", entry: { ...base, content: wide } } },
			options(store),
		);
		expect((inline.value as { entry: { content: unknown } }).entry.content).toBe(wide);
		expect(inline.lease.refs).toEqual([]);
		await inline.lease.release();
	});

	it("maps the negotiated UTF-8 blob ceiling to evidenced store admission failure", async () => {
		const limit = SESSION_CONTENT_INLINE_THRESHOLD_BYTES;
		await expect(
			externalizePiPayload(
				{ kind: "event", value: event(toolResult([{ type: "text", text: "x".repeat(limit + 1) }])) },
				{
					...options(store),
					genericContent: {
						contentRefBudget: {
							...FUTURE_SESSION_CONTENT_REF_BUDGET,
							maxContentBlobBytes: limit,
						},
					},
				},
			),
		).rejects.toMatchObject({ code: "blob_too_large", limit, actual: limit + 1 });
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
	});

	it("rejects raw forged text wrappers before touching the UTF-8 store", async () => {
		const stageUtf8 = vi.spyOn(store, "stageUtf8");
		await expect(
			externalizePiPayload(
				{
					kind: "event",
					value: event(
						toolResult([
							{
								type: "text",
								text: {
									type: "external_text",
									ref: {
										type: "content_ref",
										serverEpoch: EPOCH,
										sha256: "a".repeat(64),
										byteLength: SESSION_CONTENT_INLINE_THRESHOLD_BYTES,
										encoding: "utf-8",
									},
								},
							},
						]),
					),
				},
				options(store),
			),
		).rejects.toMatchObject({ code: "invalid_raw_payload" });
		expect(stageUtf8).not.toHaveBeenCalled();
	});

	it("passes exact UTF-8 metadata to the replayable staging stream", async () => {
		const wide = "界".repeat(Math.ceil(SESSION_CONTENT_INLINE_THRESHOLD_BYTES / 3));
		const stageUtf8 = vi.spyOn(store, "stageUtf8");
		const result = await externalizePiPayload(
			{ kind: "event", value: event(toolResult([{ type: "text", text: wide }])) },
			options(store),
		);
		const expected = Buffer.from(wide);
		expect(stageUtf8).toHaveBeenCalledTimes(1);
		expect(stageUtf8.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				expectedByteLength: expected.byteLength,
				expectedSha256: createHash("sha256").update(expected).digest("hex"),
			}),
		);
		await result.lease.release();
	});

	it("reuses published UTF-8 content only after recomputing exact bytes", async () => {
		const wide = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		const first = await externalizePiPayload(
			{ kind: "event", value: event(toolResult([{ type: "text", text: wide }])) },
			options(store),
		);
		const stageUtf8 = vi.spyOn(store, "stageUtf8");
		const holdPublishedUtf8 = vi.spyOn(store, "holdPublishedUtf8");
		const second = await externalizePiPayload(
			{ kind: "event", value: event(toolResult([{ type: "text", text: wide }])) },
			options(store),
		);
		expect(holdPublishedUtf8).toHaveBeenCalledTimes(1);
		expect(stageUtf8).not.toHaveBeenCalled();
		expect(second.lease.refs).toEqual(first.lease.refs);
		await Promise.all([first.lease.release(), second.lease.release()]);
	});

	it("rolls back the first UTF-8 hold when shared cache item admission rejects the second", async () => {
		await store.shutdown();
		store = new EpochContentStore({
			webDataDir,
			serverEpoch: EPOCH,
			limits: { maxCacheItems: 1 },
		});
		await store.initialize();
		const first = "a".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		const second = "b".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		await expect(
			externalizePiPayload(
				{
					kind: "event",
					value: event(
						toolResult([
							{ type: "text", text: first },
							{ type: "text", text: second },
						]),
					),
				},
				options(store),
			),
		).rejects.toMatchObject({ code: "cache_items_exhausted" });
		expect(await store.gc()).toEqual({ bytes: first.length, items: 1 });
	});

	it("fails closed when JSON changes between prepare and the staged encoding pass", async () => {
		const details = { payload: "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES) };
		const proxy: PiGenericPayloadExternalizerContentStore = {
			stage: (input) => store.stage(input),
			stageUtf8: (input) => store.stageUtf8(input),
			publish: (hold) => store.publish(hold),
			holdPublished: (ref) => store.holdPublished(ref),
			async holdPublishedUtf8() {
				details.payload = "mutated";
				throw new EpochContentStoreError("not_found", "missing");
			},
			release: (hold) => store.release(hold),
		};
		await expect(
			externalizePiPayload(
				{ kind: "event", value: event(toolResult([{ type: "text", text: "ok" }], details)) },
				{ ...options(store), contentStore: proxy },
			),
		).rejects.toMatchObject({ code: "declared_length_mismatch" });
		expect(store.usage).toEqual({ bytes: 0, items: 0 });
	});

	it("runs the current full guard on the shadow and the supplemental guard on future wrappers", async () => {
		const raster = image();
		const productGuard = vi.fn(() => true);
		await expect(
			externalizePiPayload(
				{
					kind: "event",
					value: event(
						toolResult(
							Array.from({ length: SESSION_PAYLOAD_BUDGET.maxImageCount + 1 }, () => raster.block),
							{ ok: true },
						),
					),
				},
				{ ...options(store), productGuard },
			),
		).rejects.toMatchObject({ code: "invalid_product_payload" });
		expect(productGuard).not.toHaveBeenCalled();

		const wide = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		const accepted = await externalizePiPayload(
			{ kind: "event", value: event(toolResult([{ type: "text", text: wide }], { ok: true })) },
			{ ...options(store), productGuard },
		);
		expect(productGuard).toHaveBeenCalledWith(
			accepted.value,
			expect.objectContaining({ contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET }),
			expect.objectContaining({ kind: "event" }),
		);
		await accepted.lease.release();
	});

	it("rolls back mixed generic holds when the supplemental product guard rejects", async () => {
		const wide = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		const raster = image();
		await expect(
			externalizePiPayload(
				{
					kind: "event",
					value: event(toolResult([raster.block, { type: "text", text: wide }], { wide })),
				},
				{ ...options(store), productGuard: () => false },
			),
		).rejects.toMatchObject({ code: "invalid_product_payload" });
		expect(await store.gc()).toEqual({
			bytes: raster.bytes.byteLength + wide.length + Buffer.byteLength(JSON.stringify({ wide })),
			items: 3,
		});
	});

	it("returns one union lease for mixed image and UTF-8 holds", async () => {
		const wide = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		const raster = image();
		const result = await externalizePiPayload(
			{ kind: "event", value: event(toolResult([raster.block, { type: "text", text: wide }])) },
			options(store),
		);
		expect(new Set(result.lease.refs.map((ref) => ref.type))).toEqual(
			new Set(["attachment_ref", "content_ref"]),
		);
		const transfer = result.lease.transfer();
		let adopted: readonly { ref: { type: string } }[] = [];
		transfer.adopt((holds) => {
			adopted = holds;
			return true;
		});
		expect(new Set(adopted.map((hold) => hold.ref.type))).toEqual(new Set(["attachment_ref", "content_ref"]));
		await transfer.release();
		for (const hold of adopted) {
			await store.release(hold as Parameters<EpochContentStore["release"]>[0]);
		}
	});

	it("rolls back a published UTF-8 hold when abort wins after publish", async () => {
		const abort = new AbortController();
		const proxy: PiGenericPayloadExternalizerContentStore = {
			stage: (input) => store.stage(input),
			stageUtf8: (input) => store.stageUtf8(input),
			async publish(hold) {
				await store.publish(hold);
				abort.abort();
			},
			holdPublished: (ref) => store.holdPublished(ref),
			holdPublishedUtf8: (ref) => store.holdPublishedUtf8(ref),
			release: (hold) => store.release(hold),
		};
		await expect(
			externalizePiPayload(
				{
					kind: "event",
					value: event(
						toolResult([{ type: "text", text: "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES) }]),
					),
				},
				{ ...options(store), contentStore: proxy, signal: abort.signal },
			),
		).rejects.toMatchObject({ code: "aborted" });
		expect(await store.gc()).toEqual({ bytes: SESSION_CONTENT_INLINE_THRESHOLD_BYTES, items: 1 });
	});

	it("reports rollback failure after observing every mixed hold release", async () => {
		const wide = "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES);
		const raster = image();
		const released: string[] = [];
		const proxy: PiGenericPayloadExternalizerContentStore = {
			stage: (input) => store.stage(input),
			stageUtf8: (input) => store.stageUtf8(input),
			publish: (hold) => store.publish(hold),
			holdPublished: (ref) => store.holdPublished(ref),
			holdPublishedUtf8: (ref) => store.holdPublishedUtf8(ref),
			async release(hold) {
				released.push(hold.ref.type);
				await store.release(hold);
				throw new Error("release failed");
			},
		};
		await expect(
			externalizePiPayload(
				{ kind: "event", value: event(toolResult([raster.block, { type: "text", text: wide }])) },
				{ ...options(store), contentStore: proxy, productGuard: () => false },
			),
		).rejects.toMatchObject({ code: "rollback_failed" });
		expect(new Set(released)).toEqual(new Set(["attachment_ref", "content_ref"]));
		expect(await store.gc()).toEqual({
			bytes: raster.bytes.byteLength + wide.length,
			items: 2,
		});
	});
});
