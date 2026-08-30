import {
	isPiExtensionUiRequestDto,
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
	type SessionContentRefDto,
	type SessionContentRefGuardContext,
	type SessionExternalJsonDto,
	type SessionExternalTextDto,
	type SessionInlineJsonDto,
	type SessionJsonValueDto,
} from "@pi-agent-web/protocol";
import { describe, expect, it, vi } from "vitest";
import {
	createSessionContentAdapter,
	type SessionContentAdapter,
	type SessionExtensionMaterializer,
} from "../src/lib/session-content-adapter";
import {
	createSessionContentResolver,
	SessionContentResolutionError,
} from "../src/lib/session-content-resolver";

const CONTENT_BYTES = SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes;
const trustedContext: SessionContentRefGuardContext = Object.freeze({
	serverEpoch: "stage6b3-content-epoch",
	payloadBudget: SESSION_PAYLOAD_BUDGET,
	contentRefBudget: SESSION_CONTENT_REF_BUDGET,
});

type Stage6b3ContentAdapter = SessionContentAdapter;

function isStage6b3ContentAdapter(value: SessionContentAdapter): value is Stage6b3ContentAdapter {
	return (
		typeof Reflect.get(value, "materializeTextPayload") === "function" &&
		typeof Reflect.get(value, "materializeJsonRoot") === "function"
	);
}

function stage6b3Adapter(resolver: SessionExtensionMaterializer): Stage6b3ContentAdapter {
	const adapter = createSessionContentAdapter({ trustedContext, resolver });
	if (!isStage6b3ContentAdapter(adapter)) {
		throw new Error("Stage6b3 RED: session-content-adapter must expose text and JSON materializers");
	}
	return adapter;
}

function contentRef(
	digest: string,
	serverEpoch = trustedContext.serverEpoch,
	byteLength = CONTENT_BYTES,
): SessionContentRefDto {
	return {
		type: "content_ref",
		serverEpoch,
		sha256: digest.repeat(64),
		byteLength,
		encoding: "utf-8",
	};
}

function externalText(digest: string, serverEpoch = trustedContext.serverEpoch): SessionExternalTextDto {
	return { type: "external_text", ref: contentRef(digest, serverEpoch) };
}

function externalJson(digest: string, serverEpoch = trustedContext.serverEpoch): SessionExternalJsonDto {
	return { type: "external_json", ref: contentRef(digest, serverEpoch) };
}

function paddedJson(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Test JSON value must be serializable");
	const encodedBytes = new TextEncoder().encode(encoded).byteLength;
	if (encodedBytes > CONTENT_BYTES)
		throw new Error("Test JSON value exceeds the external-content fixture size");
	return `${encoded}${" ".repeat(CONTENT_BYTES - encodedBytes)}`;
}

function paddedText(prefix: string): string {
	const prefixBytes = new TextEncoder().encode(prefix).byteLength;
	if (prefixBytes > CONTENT_BYTES) throw new Error("Test text exceeds the external-content fixture size");
	return `${prefix}${"x".repeat(CONTENT_BYTES - prefixBytes)}`;
}

function contentResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: {
			"Cache-Control": "no-store",
			"Content-Length": String(new TextEncoder().encode(body).byteLength),
			"Content-Type": "application/octet-stream",
			"Cross-Origin-Resource-Policy": "same-origin",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function fetcherForBodies(bodies: ReadonlyMap<string, string>) {
	return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
		const digest = new URL(String(input), "http://127.0.0.1").pathname.split("/").at(-1);
		const body = digest === undefined ? undefined : bodies.get(digest);
		return body === undefined ? new Response(null, { status: 404 }) : contentResponse(body);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface InlineDocument {
	answer: string;
}

function isInlineDocument(value: unknown): value is InlineDocument {
	return isRecord(value) && typeof value.answer === "string";
}

function isCurrentWidgetLines(value: unknown): value is string[] {
	const candidate: unknown = {
		type: "extension_ui_request",
		id: "stage6b3-widget-guard",
		method: "setWidget",
		widgetKey: "stage6b3",
		widgetLines: value,
	};
	if (!isPiExtensionUiRequestDto(candidate)) return false;
	return candidate.method === "setWidget" && candidate.widgetLines !== undefined;
}

interface NestedLookalikeDocument {
	nested: {
		type: "external_json";
		ref: {
			type: "content_ref";
			serverEpoch: string;
			sha256: string;
			byteLength: number;
			encoding: "utf-8";
		};
	};
}

function isNestedLookalikeDocument(value: unknown): value is NestedLookalikeDocument {
	if (!isRecord(value) || !isRecord(value.nested) || value.nested.type !== "external_json") return false;
	const ref = value.nested.ref;
	return (
		isRecord(ref) &&
		ref.type === "content_ref" &&
		typeof ref.serverEpoch === "string" &&
		typeof ref.sha256 === "string" &&
		typeof ref.byteLength === "number" &&
		ref.encoding === "utf-8"
	);
}

describe("Stage6b3 future Session content materialization attacks", () => {
	it("does zero GETs for inline text and inline JSON", async () => {
		const fetcher = vi.fn(async (): Promise<Response> => {
			throw new Error("inline content must not issue a GET");
		});
		const resolver = createSessionContentResolver({ trustedContext, fetcher });

		try {
			const adapter = stage6b3Adapter(resolver);
			const inlineJson: SessionInlineJsonDto = {
				type: "inline_json",
				value: { answer: "inline" },
			};

			await expect(adapter.materializeTextPayload("inline text")).resolves.toBe("inline text");
			await expect(adapter.materializeJsonRoot(inlineJson, isInlineDocument)).resolves.toEqual({
				answer: "inline",
			});
			expect(fetcher).not.toHaveBeenCalled();
		} finally {
			resolver.dispose();
		}
	});

	it("resolves external text and JSON only through the exact trusted context", async () => {
		const text = paddedText("external text");
		const widgetLines = ["first", "second"];
		const fetcher = fetcherForBodies(
			new Map([
				["a".repeat(64), text],
				["b".repeat(64), paddedJson(widgetLines)],
			]),
		);
		const resolver = createSessionContentResolver({ trustedContext, fetcher });

		try {
			const adapter = stage6b3Adapter(resolver);
			await expect(adapter.materializeTextPayload(externalText("a"))).resolves.toBe(text);
			await expect(adapter.materializeJsonRoot(externalJson("b"), isCurrentWidgetLines)).resolves.toEqual(
				widgetLines,
			);
			expect(fetcher).toHaveBeenCalledTimes(2);

			await expect(
				adapter.materializeTextPayload(externalText("c", "attacker-chosen-epoch")),
			).rejects.toThrow();
			await expect(
				adapter.materializeJsonRoot(externalJson("d", "attacker-chosen-epoch"), isCurrentWidgetLines),
			).rejects.toThrow();
			expect(fetcher).toHaveBeenCalledTimes(2);
		} finally {
			resolver.dispose();
		}
	});

	it("reruns the bounded current field guard after materializing JSON", async () => {
		const oversizedWidgetLines = Array.from({ length: 1_001 }, (_, index) => `line-${index}`);
		const fetcher = fetcherForBodies(new Map([["e".repeat(64), paddedJson(oversizedWidgetLines)]]));
		const resolver = createSessionContentResolver({ trustedContext, fetcher });
		let guardCalls = 0;
		const fieldGuard = (value: unknown): value is string[] => {
			guardCalls += 1;
			return isCurrentWidgetLines(value);
		};

		try {
			const adapter = stage6b3Adapter(resolver);
			await expect(adapter.materializeJsonRoot(externalJson("e"), fieldGuard)).rejects.toThrow(
				"Materialized Session JSON failed its field guard",
			);
			expect(guardCalls).toBeGreaterThan(0);
			expect(fetcher).toHaveBeenCalledTimes(1);
		} finally {
			resolver.dispose();
		}
	});

	it("does not recursively GET a nested reference-shaped JSON object", async () => {
		const nestedValue: SessionJsonValueDto = {
			nested: {
				type: "external_json",
				ref: {
					type: "content_ref",
					serverEpoch: trustedContext.serverEpoch,
					sha256: "n".repeat(64),
					byteLength: CONTENT_BYTES,
					encoding: "utf-8",
				},
			},
		};
		const fetcher = fetcherForBodies(new Map([["a".repeat(64), paddedJson(nestedValue)]]));
		const resolver = createSessionContentResolver({ trustedContext, fetcher });

		try {
			const adapter = stage6b3Adapter(resolver);
			await expect(
				adapter.materializeJsonRoot(externalJson("a"), isNestedLookalikeDocument),
			).resolves.toEqual(nestedValue);
			expect(fetcher).toHaveBeenCalledTimes(1);
		} finally {
			resolver.dispose();
		}
	});

	it("preserves a resolver failure instead of returning an empty fallback", async () => {
		const fetcher = vi.fn(async (): Promise<Response> => new Response(null, { status: 410 }));
		const resolver = createSessionContentResolver({ trustedContext, fetcher });

		try {
			const adapter = stage6b3Adapter(resolver);
			await expect(adapter.materializeTextPayload(externalText("f"))).rejects.toBeInstanceOf(
				SessionContentResolutionError,
			);
		} finally {
			resolver.dispose();
		}
	});

	it("passes caller Abort through to the external resolver", async () => {
		let fetchSignal: AbortSignal | undefined;
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			fetchSignal = init?.signal ?? undefined;
			const signal = init?.signal;
			if (signal === undefined || signal === null) {
				throw new Error("caller AbortSignal was not passed to the resolver");
			}
			return new Promise<Response>((_resolve, reject) => {
				if (signal.aborted) {
					reject(new DOMException("The operation was aborted", "AbortError"));
					return;
				}
				signal.addEventListener(
					"abort",
					() => reject(new DOMException("The operation was aborted", "AbortError")),
					{ once: true },
				);
			});
		});
		const resolver = createSessionContentResolver({ trustedContext, fetcher });
		const controller = new AbortController();

		try {
			const adapter = stage6b3Adapter(resolver);
			const pending = adapter.materializeTextPayload(externalText("a"), controller.signal);
			await vi.waitFor(() => expect(fetchSignal).toBeDefined());
			controller.abort();

			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			expect(fetchSignal?.aborted).toBe(true);
		} finally {
			resolver.dispose();
		}
	});
});
