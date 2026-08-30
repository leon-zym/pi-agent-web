import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	isPiProductSessionEventDto,
	isPiSessionCommandResponseDto,
	SESSION_PAYLOAD_BUDGET,
} from "@pi-agent-web/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EpochContentStore, EpochContentStoreError } from "../src/epoch-content-store.js";
import {
	externalizePiPayload,
	type PiPayloadExternalizerContentStore,
} from "../src/pi-payload-externalizer.js";

const EPOCH = "externalizer-epoch";
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
const PNG_IEND = Buffer.from("0000000049454e4400000000", "hex");

function png(byteLength = 48, fill = 0): Buffer {
	if (byteLength < PNG_HEADER.byteLength + PNG_IEND.byteLength) throw new Error("PNG fixture is too small");
	return Buffer.concat([
		PNG_HEADER,
		Buffer.alloc(byteLength - PNG_HEADER.byteLength - PNG_IEND.byteLength, fill),
		PNG_IEND,
	]);
}

function image(bytes = png(), mimeType = "image/png") {
	return { type: "image", data: bytes.toString("base64"), mimeType } as const;
}

function user(images: readonly ReturnType<typeof image>[]) {
	return { role: "user", content: [{ type: "text", text: "kept" }, ...images], timestamp: 1 } as const;
}

function eventWith(images: readonly ReturnType<typeof image>[]) {
	return { type: "message_start", message: user(images) } as const;
}

function refsIn(value: unknown): Array<Record<string, unknown>> {
	const refs: Array<Record<string, unknown>> = [];
	const stack = [value];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || typeof current !== "object") continue;
		if (!Array.isArray(current) && (current as Record<string, unknown>).type === "attachment_ref") {
			refs.push(current as Record<string, unknown>);
			continue;
		}
		stack.push(...(Array.isArray(current) ? current : Object.values(current as Record<string, unknown>)));
	}
	return refs;
}

describe("Pi payload image externalizer", () => {
	let webDataDir: string;
	let storeId = 0;
	const stores: EpochContentStore[] = [];

	beforeEach(async () => {
		webDataDir = await mkdtemp(path.join(tmpdir(), "pi-web-externalizer-"));
		storeId = 0;
	});

	afterEach(async () => {
		await Promise.allSettled(stores.map((store) => store.shutdown()));
		await rm(webDataDir, { recursive: true, force: true });
	});

	async function createStore(limits: ConstructorParameters<typeof EpochContentStore>[0]["limits"] = {}) {
		const store = new EpochContentStore({
			webDataDir: path.join(webDataDir, `store-${++storeId}`),
			serverEpoch: EPOCH,
			limits,
		});
		stores.push(store);
		await store.initialize();
		return store;
	}

	async function externalizeEvent(
		store: PiPayloadExternalizerContentStore,
		value: unknown,
		extra: Partial<Parameters<typeof externalizePiPayload>[1]> = {},
	) {
		return externalizePiPayload(
			{ kind: "event", value },
			{ contentStore: store, serverEpoch: EPOCH, payloadBudget: SESSION_PAYLOAD_BUDGET, ...extra },
		);
	}

	it("externalizes only explicit event image slots and leaves opaque lookalikes untouched", async () => {
		const store = await createStore();
		const bytes = png();
		const inline = image(bytes);
		const opaque = { nested: inline, genericText: inline.data };
		const entry = {
			type: "custom_message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-08-27T00:00:00.000Z",
			customType: "image-note",
			content: [inline],
			details: opaque,
			display: true,
		};
		const cases = [
			{ type: "agent_end", messages: [user([inline])], willRetry: false },
			{
				type: "turn_end",
				message: user([inline]),
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "view",
						content: [inline],
						details: opaque,
						isError: false,
						timestamp: 1,
					},
				],
			},
			{ type: "message_start", message: user([inline]) },
			{
				type: "message_end",
				message: {
					role: "custom",
					customType: "x",
					content: [inline],
					display: true,
					details: opaque,
					timestamp: 1,
				},
			},
			{ type: "entry_appended", entry },
		] as const;

		for (const value of cases) {
			const result = await externalizeEvent(store, value);
			expect(refsIn(result.value)).toHaveLength(value.type === "turn_end" ? 2 : 1);
			expect(
				isPiProductSessionEventDto(result.value, {
					serverEpoch: EPOCH,
					payloadBudget: SESSION_PAYLOAD_BUDGET,
				}),
			).toBe(true);
			if (value.type === "turn_end") {
				expect((result.value as typeof value).toolResults[0]?.details).toBe(opaque);
			}
			if (value.type === "message_end") {
				expect((result.value as typeof value).message.details).toBe(opaque);
			}
			if (value.type === "entry_appended") {
				expect((result.value as typeof value).entry.details).toBe(opaque);
			}
			await result.lease.release();
		}
		const opaqueEvent = {
			type: "tool_execution_end",
			toolCallId: "call-opaque",
			toolName: "opaque",
			result: opaque,
			isError: false,
		};
		const unchanged = await externalizeEvent(store, opaqueEvent);
		expect(unchanged.value).toBe(opaqueEvent);
		expect((unchanged.value as typeof opaqueEvent).result).toBe(opaque);
		await unchanged.lease.release();
	});

	it.each(["get_messages", "get_entries", "get_tree"] as const)(
		"externalizes successful %s history payloads including nested tree entries",
		async (command) => {
			const store = await createStore();
			const message = user([image()]);
			const entry = {
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-08-27T00:00:00.000Z",
				message,
			};
			const data =
				command === "get_messages"
					? { messages: [message] }
					: command === "get_entries"
						? { entries: [entry], leafId: "entry-1" }
						: {
								tree: [
									{
										entry,
										children: [{ entry: { ...entry, id: "entry-2", parentId: "entry-1" }, children: [] }],
									},
								],
								leafId: "entry-2",
							};
			const result = await externalizePiPayload(
				{
					kind: "response",
					expectedCommand: command,
					value: { type: "response", id: "1", command, success: true, data },
				},
				{ contentStore: store, serverEpoch: EPOCH, payloadBudget: SESSION_PAYLOAD_BUDGET },
			);
			expect(refsIn(result.value)).toHaveLength(command === "get_tree" ? 2 : 1);
			expect(
				isPiSessionCommandResponseDto(result.value, {
					serverEpoch: EPOCH,
					payloadBudget: SESSION_PAYLOAD_BUDGET,
				}),
			).toBe(true);
			await result.lease.release();
		},
	);

	it("enforces below, at, and above the decoded byte ceiling before store admission", async () => {
		const store = await createStore();
		const bytes = png(48);
		await expect(
			externalizeEvent(store, eventWith([image(bytes)]), { maxDecodedImageBytes: 47 }),
		).rejects.toMatchObject({
			code: "decoded_image_too_large",
			limit: 47,
			actual: 48,
		});
		for (const limit of [48, 49]) {
			const result = await externalizeEvent(store, eventWith([image(bytes)]), {
				maxDecodedImageBytes: limit,
			});
			await result.lease.release();
		}
	});

	it("preserves the store blob ceiling and per-content product count guard", async () => {
		const bytes = png(48);
		const blobStore = await createStore();
		await expect(
			externalizeEvent(blobStore, eventWith([image(bytes)]), {
				maxDecodedImageBytes: 48,
				payloadBudget: { ...SESSION_PAYLOAD_BUDGET, maxAttachmentBlobBytes: 47 },
			}),
		).rejects.toMatchObject({
			code: "blob_too_large",
		});
		for (const maxAttachmentBlobBytes of [48, 49]) {
			const result = await externalizeEvent(blobStore, eventWith([image(bytes)]), {
				maxDecodedImageBytes: 48,
				payloadBudget: { ...SESSION_PAYLOAD_BUDGET, maxAttachmentBlobBytes },
			});
			await result.lease.release();
		}

		const store = await createStore();
		const maxImageCount = SESSION_PAYLOAD_BUDGET.maxImageCount;
		await expect(
			externalizeEvent(store, eventWith(Array.from({ length: maxImageCount + 1 }, () => image(bytes)))),
		).rejects.toMatchObject({ code: "invalid_product_payload" });
		expect(await store.gc()).toEqual({ bytes: bytes.byteLength, items: 1 });
		for (const count of [maxImageCount - 1, maxImageCount]) {
			const result = await externalizeEvent(
				store,
				eventWith(Array.from({ length: count }, () => image(bytes))),
			);
			await result.lease.release();
		}
	});

	it("allows history above the prompt count when every message content stays within its budget", async () => {
		const store = await createStore();
		const messages = Array.from({ length: SESSION_PAYLOAD_BUDGET.maxImageCount + 1 }, () => user([image()]));
		const result = await externalizeEvent(store, { type: "agent_end", messages, willRetry: false });
		expect(refsIn(result.value)).toHaveLength(messages.length);
		await result.lease.release();
	});

	it.each(["", "Zg", "Zg=", "Zh==", "Zg===", "Z g==", "Zg__"])(
		"rejects non-canonical base64 %j",
		async (data) => {
			const store = await createStore();
			await expect(
				externalizeEvent(store, eventWith([{ type: "image", data, mimeType: "image/png" }])),
			).rejects.toMatchObject({
				code: "invalid_base64",
			});
			expect(store.usage).toEqual({ bytes: 0, items: 0 });
		},
	);

	it("rejects MIME and gross raster mismatches before staging", async () => {
		const stage = vi.fn();
		const store = { stage } as unknown as PiPayloadExternalizerContentStore;
		await expect(externalizeEvent(store, eventWith([image(png(), "image/svg+xml")]))).rejects.toMatchObject({
			code: "unsupported_media_type",
		});
		const broken = png();
		broken[broken.byteLength - 5] = 1;
		await expect(externalizeEvent(store, eventWith([image(broken)]))).rejects.toMatchObject({
			code: "invalid_raster_structure",
		});
		expect(stage).not.toHaveBeenCalled();
	});

	it("deduplicates exact images within one frame while counting every occurrence", async () => {
		const store = await createStore();
		const stage = vi.spyOn(store, "stage");
		const bytes = png();
		const result = await externalizeEvent(store, eventWith([image(bytes), image(bytes)]));
		const refs = refsIn(result.value);
		expect(stage).toHaveBeenCalledTimes(1);
		expect(refs).toHaveLength(2);
		expect(refs[0]).toEqual(refs[1]);
		expect(store.usage).toEqual({ bytes: bytes.byteLength, items: 1 });
		await result.lease.release();
	});

	it("reuses published exact content only after independently decoding and hashing the raw body", async () => {
		const store = await createStore();
		const first = await externalizeEvent(store, eventWith([image()]));
		const stage = vi.spyOn(store, "stage");
		const holdPublished = vi.spyOn(store, "holdPublished");
		const second = await externalizeEvent(store, eventWith([image()]));
		expect(holdPublished).toHaveBeenCalledTimes(1);
		expect(stage).not.toHaveBeenCalled();
		expect(refsIn(second.value)).toEqual(refsIn(first.value));
		await Promise.all([first.lease.release(), second.lease.release()]);
	});

	it("rolls back all unique provisional holds on partial quota failure and final guard failure", async () => {
		const quotaStore = await createStore({ maxBlobBytes: 64, maxCacheBytes: 128, maxCacheItems: 1 });
		await expect(
			externalizeEvent(quotaStore, eventWith([image(png(48, 1)), image(png(48, 2))])),
		).rejects.toBeInstanceOf(EpochContentStoreError);
		expect(await quotaStore.gc()).toEqual({ bytes: 48, items: 1 });

		const guardStore = await createStore();
		await expect(
			externalizeEvent(guardStore, eventWith([image()]), { productGuard: () => false }),
		).rejects.toMatchObject({
			code: "invalid_product_payload",
		});
		expect(await guardStore.gc()).toEqual({ bytes: png().byteLength, items: 1 });
	});

	it("rolls back on abort after publish and never returns a partial value", async () => {
		const realStore = await createStore();
		const abort = new AbortController();
		const store: PiPayloadExternalizerContentStore = {
			stage: (input) => realStore.stage(input),
			holdPublished: (ref) => realStore.holdPublished(ref),
			async publish(hold) {
				await realStore.publish(hold);
				abort.abort();
			},
			release: (hold) => realStore.release(hold),
		};
		await expect(
			externalizeEvent(store, eventWith([image(), image(png(49))]), { signal: abort.signal }),
		).rejects.toMatchObject({
			code: "aborted",
		});
		expect(await realStore.gc()).toEqual({ bytes: png().byteLength, items: 1 });
	});

	it("releases a published hold acquired concurrently with abort", async () => {
		const realStore = await createStore();
		const existing = await externalizeEvent(realStore, eventWith([image()]));
		const abort = new AbortController();
		const store: PiPayloadExternalizerContentStore = {
			stage: (input) => realStore.stage(input),
			publish: (hold) => realStore.publish(hold),
			async holdPublished(ref) {
				const hold = await realStore.holdPublished(ref);
				abort.abort();
				return hold;
			},
			release: (hold) => realStore.release(hold),
		};
		await expect(
			externalizeEvent(store, eventWith([image()]), { signal: abort.signal }),
		).rejects.toMatchObject({ code: "aborted" });
		await existing.lease.release();
		expect(await realStore.gc()).toEqual({ bytes: png().byteLength, items: 1 });
	});

	it("rejects raw pseudo-refs before touching the store", async () => {
		const stage = vi.fn();
		const ref = {
			type: "attachment_ref",
			serverEpoch: EPOCH,
			sha256: "a".repeat(64),
			mediaType: "image/png",
			byteLength: 48,
		};
		await expect(
			externalizeEvent({ stage } as unknown as PiPayloadExternalizerContentStore, {
				type: "message_start",
				message: {
					role: "user",
					content: [{ type: "image", data: ref, mimeType: "image/png" }],
					timestamp: 1,
				},
			}),
		).rejects.toMatchObject({ code: "invalid_raw_payload" });
		await expect(
			externalizeEvent({ stage } as unknown as PiPayloadExternalizerContentStore, {
				type: "message_start",
				message: { role: "user", content: [ref], timestamp: 1 },
			}),
		).rejects.toMatchObject({ code: "invalid_raw_payload" });
		expect(stage).not.toHaveBeenCalled();
	});

	it("streams the unique decoded Buffer into stage without a second full binary copy", async () => {
		const bytes = png();
		let decoded: Buffer | undefined;
		const originalFrom = Buffer.from;
		const from = vi.spyOn(Buffer, "from").mockImplementation(((...args: unknown[]) => {
			const result = Reflect.apply(originalFrom, Buffer, args) as Buffer;
			if (typeof args[0] === "string" && args[1] === "base64") decoded = result;
			return result;
		}) as typeof Buffer.from);
		const hold = {
			ref: {
				type: "attachment_ref" as const,
				serverEpoch: EPOCH,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				mediaType: "image/png",
				byteLength: bytes.byteLength,
			},
		};
		const stage = vi.fn(async (input: Parameters<PiPayloadExternalizerContentStore["stage"]>[0]) => {
			const chunks: unknown[] = [];
			for await (const chunk of input.source) chunks.push(chunk);
			expect(chunks).toHaveLength(1);
			expect(chunks[0]).toBe(decoded);
			return { ref: hold.ref, hold, created: true };
		});
		const store = {
			stage,
			publish: vi.fn(),
			holdPublished: vi.fn(async () => {
				throw new EpochContentStoreError("not_found", "missing");
			}),
			release: vi.fn(),
		} as unknown as PiPayloadExternalizerContentStore;
		try {
			const result = await externalizeEvent(store, eventWith([image(bytes)]));
			const adopted = result.lease.transfer();
			await result.lease.release();
			expect(store.release).not.toHaveBeenCalled();
			await adopted.release();
			await adopted.release();
			expect(store.release).toHaveBeenCalledTimes(1);
		} finally {
			from.mockRestore();
		}
	});

	it("supports explicit one-shot adoption and idempotent late disposal", async () => {
		const store = await createStore();
		const adoptedResult = await externalizeEvent(store, eventWith([image()]));
		const transfer = adoptedResult.lease.transfer();
		expect(() => adoptedResult.lease.transfer()).toThrow();
		let holds: readonly Parameters<PiPayloadExternalizerContentStore["release"]>[0][] = [];
		transfer.adopt((incoming) => {
			expect(() => transfer.adopt(() => true)).toThrow();
			expect(() => transfer.release()).toThrow();
			expect(() => adoptedResult.lease.transfer()).toThrow();
			holds = incoming;
			return true;
		});
		expect(holds).toHaveLength(1);
		expect(() => transfer.adopt(() => true)).toThrow();
		await transfer.release();
		for (const hold of holds) await store.release(hold);

		const disposed = await externalizeEvent(store, eventWith([image()]));
		const firstRelease = disposed.lease.release();
		expect(disposed.lease.release()).toBe(firstRelease);
		await firstRelease;
		await disposed.lease.release();
	});

	it("keeps a transfer releasable when synchronous adoption rejects or throws", async () => {
		const store = await createStore();
		for (const accept of [
			() => false,
			() => {
				throw new Error("owner rejected");
			},
		]) {
			const result = await externalizeEvent(store, eventWith([image()]));
			const transfer = result.lease.transfer();
			expect(() => transfer.adopt(accept as () => true)).toThrow();
			await transfer.release();
		}
		expect(await store.gc()).toEqual({ bytes: png().byteLength, items: 1 });
	});
});
