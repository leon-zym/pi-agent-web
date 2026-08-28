import {
	FUTURE_SESSION_CONTENT_REF_BUDGET,
	type FutureSessionContentRefGuardContext,
	SESSION_PAYLOAD_BUDGET,
	type SessionContentRefDto,
	type SessionExternalJsonDto,
	type SessionExternalTextDto,
	type SessionJsonValueDto,
} from "@pi-agent-web/protocol";
import { describe, expect, it, vi } from "vitest";
import {
	createSessionContentResolver,
	SessionContentResolutionError,
} from "../src/lib/session-content-resolver";

const CONTENT_BYTES = FUTURE_SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes;
const trustedContext: FutureSessionContentRefGuardContext = Object.freeze({
	serverEpoch: "content-epoch",
	payloadBudget: SESSION_PAYLOAD_BUDGET,
	contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
});

function ref(digest: string, byteLength = CONTENT_BYTES): SessionContentRefDto {
	return {
		type: "content_ref",
		serverEpoch: trustedContext.serverEpoch,
		sha256: digest.repeat(64),
		byteLength,
		encoding: "utf-8",
	};
}

function externalText(contentRef: SessionContentRefDto): SessionExternalTextDto {
	return { type: "external_text", ref: contentRef };
}

function externalJson(contentRef: SessionContentRefDto): SessionExternalJsonDto {
	return { type: "external_json", ref: contentRef };
}

function contentResponse(
	chunks: readonly Uint8Array[],
	byteLength: number,
	headers: Record<string, string> = {},
): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		}),
		{
			status: 200,
			headers: {
				"Cache-Control": "no-store",
				"Content-Length": String(byteLength),
				"Content-Type": "application/octet-stream",
				"Cross-Origin-Resource-Policy": "same-origin",
				"X-Content-Type-Options": "nosniff",
				...headers,
			},
		},
	);
}

function textBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function paddedText(prefix: string, byteLength = CONTENT_BYTES): string {
	return `${prefix}${"x".repeat(byteLength - prefix.length)}`;
}

const invalidResponses: Array<[string, Response]> = [
	["status", new Response("missing", { status: 404 })],
	[
		"content type",
		contentResponse([textBytes(paddedText("bad-type"))], CONTENT_BYTES, {
			"Content-Type": "text/plain",
		}),
	],
	[
		"content length",
		contentResponse([textBytes(paddedText("bad-length"))], CONTENT_BYTES, {
			"Content-Length": String(CONTENT_BYTES - 1),
		}),
	],
	[
		"cache policy",
		contentResponse([textBytes(paddedText("bad-cache"))], CONTENT_BYTES, {
			"Cache-Control": "public",
		}),
	],
	[
		"nosniff",
		contentResponse([textBytes(paddedText("bad-nosniff"))], CONTENT_BYTES, {
			"X-Content-Type-Options": "",
		}),
	],
	[
		"same-origin policy",
		contentResponse([textBytes(paddedText("bad-corp"))], CONTENT_BYTES, {
			"Cross-Origin-Resource-Policy": "cross-origin",
		}),
	],
];

describe("Session content resolver", () => {
	it("uses the authenticated exact-digest route and streams an exact external text body", async () => {
		const text = paddedText("resolved-text");
		const bytes = textBytes(text);
		const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			contentResponse([bytes.subarray(0, 17), bytes.subarray(17)], bytes.byteLength),
		);
		const resolver = createSessionContentResolver({ trustedContext, fetcher });

		await expect(resolver.resolveText(externalText(ref("a")))).resolves.toBe(text);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher).toHaveBeenCalledWith(
			`/api/v1/content/${trustedContext.serverEpoch}/${"a".repeat(64)}`,
			expect.objectContaining({
				method: "GET",
				credentials: "same-origin",
				redirect: "error",
			}),
		);
		resolver.dispose();
	});

	it.each(invalidResponses)("fails closed on an invalid %s response", async (_label, response) => {
		const resolver = createSessionContentResolver({
			trustedContext,
			fetcher: async () => response,
		});
		await expect(resolver.resolveText(externalText(ref("b")))).rejects.toBeInstanceOf(
			SessionContentResolutionError,
		);
		resolver.dispose();
	});

	it.each([
		["status", { status: 404 }, {}],
		["content type", { status: 200 }, { "Content-Type": "text/plain" }],
		["content length", { status: 200 }, { "Content-Length": String(CONTENT_BYTES - 1) }],
		["cache policy", { status: 200 }, { "Cache-Control": "public" }],
		["nosniff", { status: 200 }, { "X-Content-Type-Options": "" }],
		["same-origin policy", { status: 200 }, { "Cross-Origin-Resource-Policy": "cross-origin" }],
	] as const)("cancels a streaming body after invalid %s metadata", async (_label, init, headers) => {
		let cancellations = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(textBytes("still-streaming"));
			},
			cancel() {
				cancellations += 1;
			},
		});
		const resolver = createSessionContentResolver({
			trustedContext,
			fetcher: async () =>
				new Response(body, {
					...init,
					headers: {
						"Cache-Control": "no-store",
						"Content-Length": String(CONTENT_BYTES),
						"Content-Type": "application/octet-stream",
						"Cross-Origin-Resource-Policy": "same-origin",
						"X-Content-Type-Options": "nosniff",
						...headers,
					},
				}),
		});

		await expect(resolver.resolveText(externalText(ref("9")))).rejects.toBeInstanceOf(
			SessionContentResolutionError,
		);
		expect(cancellations).toBe(1);
		resolver.dispose();
	});

	it("rejects byte overflow, truncation, and malformed UTF-8 without a fallback", async () => {
		const cases: Array<{ body: Uint8Array; declared: number }> = [
			{ body: textBytes(paddedText("overflow", CONTENT_BYTES + 1)), declared: CONTENT_BYTES },
			{ body: textBytes(paddedText("short", CONTENT_BYTES - 1)), declared: CONTENT_BYTES },
			{
				body: new Uint8Array([...new Uint8Array(CONTENT_BYTES - 2).fill(0x61), 0xc3, 0x28]),
				declared: CONTENT_BYTES,
			},
		];
		for (const [index, candidate] of cases.entries()) {
			const resolver = createSessionContentResolver({
				trustedContext,
				fetcher: async () => contentResponse([candidate.body], candidate.declared),
			});
			await expect(resolver.resolveText(externalText(ref(String(index + 3))))).rejects.toBeInstanceOf(
				SessionContentResolutionError,
			);
			resolver.dispose();
		}
	});

	it("cancels a streaming body after a decode failure", async () => {
		let cancellations = 0;
		const resolver = createSessionContentResolver({
			trustedContext,
			fetcher: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(CONTENT_BYTES + 1));
						},
						cancel() {
							cancellations += 1;
						},
					}),
					{
						status: 200,
						headers: {
							"Cache-Control": "no-store",
							"Content-Length": String(CONTENT_BYTES),
							"Content-Type": "application/octet-stream",
							"Cross-Origin-Resource-Policy": "same-origin",
							"X-Content-Type-Options": "nosniff",
						},
					},
				),
		});

		await expect(resolver.resolveText(externalText(ref("8")))).rejects.toBeInstanceOf(
			SessionContentResolutionError,
		);
		expect(cancellations).toBe(1);
		resolver.dispose();
	});

	it("decodes a multi-byte UTF-8 sequence split across stream chunks", async () => {
		const text = `🙂${"x".repeat(CONTENT_BYTES - 4)}`;
		const bytes = textBytes(text);
		const resolver = createSessionContentResolver({
			trustedContext,
			fetcher: async () =>
				contentResponse([bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3)], bytes.byteLength),
		});

		await expect(resolver.resolveText(externalText(ref("7")))).resolves.toBe(text);
		resolver.dispose();
	});

	it("parses JSON only at the selected root and reruns its field guard", async () => {
		const encoded = paddedText('["first","second"]');
		const resolver = createSessionContentResolver({
			trustedContext,
			fetcher: async () => contentResponse([textBytes(encoded)], CONTENT_BYTES),
		});
		await expect(
			resolver.resolveJson(
				externalJson(ref("c")),
				(value): value is string[] =>
					Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === "string"),
			),
		).rejects.toBeInstanceOf(SessionContentResolutionError);

		const compact = '["first","second"]';
		const validResolver = createSessionContentResolver({
			trustedContext,
			fetcher: async () => {
				const body = paddedText(compact).replace(/x+$/, " ".repeat(CONTENT_BYTES - compact.length));
				return contentResponse([textBytes(body)], CONTENT_BYTES);
			},
		});
		await expect(
			validResolver.resolveJson(
				externalJson(ref("d")),
				(value): value is string[] =>
					Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === "string"),
			),
		).resolves.toEqual(["first", "second"]);
		await expect(
			validResolver.resolveJson(externalJson(ref("d")), (_value): _value is string[] => false),
		).rejects.toBeInstanceOf(SessionContentResolutionError);
		resolver.dispose();
		validResolver.dispose();
	});

	it("reconstructs only the closed Extension roots and validates the materialized request", async () => {
		const editorText = paddedText("editor-body");
		const setEditorText = paddedText("set-editor-body");
		const widgetJson = `${JSON.stringify(["alpha", "beta"])}${" ".repeat(
			CONTENT_BYTES - JSON.stringify(["alpha", "beta"]).length,
		)}`;
		const bodies = new Map([
			["e".repeat(64), editorText],
			["f".repeat(64), widgetJson],
			["0".repeat(64), setEditorText],
		]);
		const resolver = createSessionContentResolver({
			trustedContext,
			fetcher: async (input) => {
				const digest = String(input).split("/").at(-1);
				const body = digest ? bodies.get(digest) : undefined;
				if (!body) return new Response(null, { status: 404 });
				return contentResponse([textBytes(body)], CONTENT_BYTES);
			},
		});

		await expect(
			resolver.materializeExtensionRequest({
				type: "extension_ui_request",
				id: "set-editor",
				method: "set_editor_text",
				text: externalText(ref("0")),
			}),
		).resolves.toMatchObject({ method: "set_editor_text", text: setEditorText });
		await expect(
			resolver.materializeExtensionRequest({
				type: "extension_ui_request",
				id: "editor",
				method: "editor",
				title: "Editor",
				prefill: externalText(ref("e")),
			}),
		).resolves.toMatchObject({ method: "editor", prefill: editorText });
		await expect(
			resolver.materializeExtensionRequest({
				type: "extension_ui_request",
				id: "widget",
				method: "setWidget",
				widgetKey: "root",
				widgetLines: externalJson(ref("f")),
			}),
		).resolves.toMatchObject({ method: "setWidget", widgetLines: ["alpha", "beta"] });
		resolver.dispose();
	});

	it("does not interpret a reference-shaped object nested inside an inline JSON root", async () => {
		const fetcher = vi.fn(async () => new Response(null, { status: 500 }));
		const resolver = createSessionContentResolver({ trustedContext, fetcher });
		const nested: SessionJsonValueDto = {
			ordinary: {
				type: "external_json",
				ref: {
					type: "content_ref",
					serverEpoch: trustedContext.serverEpoch,
					sha256: "1".repeat(64),
					byteLength: CONTENT_BYTES,
					encoding: "utf-8",
				},
			},
		};
		await expect(
			resolver.resolveJson(
				{ type: "inline_json", value: nested },
				(value): value is typeof nested => typeof value === "object" && value !== null,
			),
		).resolves.toEqual(nested);
		expect(fetcher).not.toHaveBeenCalled();
		resolver.dispose();
	});

	it("deduplicates an in-flight ref, aborting the fetch only after its last consumer leaves", async () => {
		let release!: () => void;
		let fetchSignal: AbortSignal | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const text = paddedText("shared");
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			fetchSignal = init?.signal ?? undefined;
			await gate;
			return contentResponse([textBytes(text)], CONTENT_BYTES);
		});
		const resolver = createSessionContentResolver({ trustedContext, fetcher });
		const firstAbort = new AbortController();
		const secondAbort = new AbortController();
		const first = resolver.resolveText(externalText(ref("2")), firstAbort.signal);
		const second = resolver.resolveText(externalText(ref("2")), secondAbort.signal);
		firstAbort.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchSignal?.aborted).toBe(false);
		release();
		await expect(second).resolves.toBe(text);
		expect(fetcher).toHaveBeenCalledTimes(1);

		let abandonedSignal: AbortSignal | undefined;
		const abandoned = createSessionContentResolver({
			trustedContext,
			fetcher: async (_input, init) => {
				abandonedSignal = init?.signal ?? undefined;
				return new Promise<Response>(() => {});
			},
		});
		const onlyAbort = new AbortController();
		const pending = abandoned.resolveText(externalText(ref("3")), onlyAbort.signal);
		onlyAbort.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(abandonedSignal?.aborted).toBe(true);
		resolver.dispose();
		abandoned.dispose();
	});

	it("disposes pending work by aborting its fetch and rejects later resolutions", async () => {
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
		const pending = resolver.resolveText(externalText(ref("6")));

		resolver.dispose();

		expect(fetchSignal?.aborted).toBe(true);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await expect(resolver.resolveText(externalText(ref("6")))).rejects.toThrow("disposed");
		resolver.dispose();
	});

	it("fails closed on digest metadata collision and keeps the decoded-string cache bounded by LRU", async () => {
		const bodies = new Map([
			["4".repeat(64), paddedText("four")],
			["5".repeat(64), paddedText("five")],
		]);
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const body = bodies.get(String(input).split("/").at(-1) ?? "");
			if (!body) return new Response(null, { status: 404 });
			return contentResponse([textBytes(body)], CONTENT_BYTES);
		});
		const resolver = createSessionContentResolver({
			trustedContext,
			fetcher,
			cacheLimits: { maxBytes: CONTENT_BYTES, maxItems: 1 },
		});

		await resolver.resolveText(externalText(ref("4")));
		await expect(
			resolver.resolveText(externalText({ ...ref("4"), byteLength: CONTENT_BYTES + 1 })),
		).rejects.toThrow("metadata");
		await resolver.resolveText(externalText(ref("5")));
		await resolver.resolveText(externalText(ref("4")));
		expect(fetcher).toHaveBeenCalledTimes(3);
		resolver.dispose();
	});
});
