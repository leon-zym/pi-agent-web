import fs from "node:fs";
import { FUTURE_SESSION_CONTENT_REF_BUDGET, SESSION_PAYLOAD_BUDGET } from "@pi-agent-web/protocol";
import { describe, expect, it, vi } from "vitest";
import { EpochContentStoreError, type EpochStoredContentRef } from "../src/epoch-content-store.js";
import {
	createLegacyRpcV1Adapter,
	legacyRpcV1Adapter as outcomeLegacyRpcV1Adapter,
} from "../src/legacy-rpc-v1.js";
import {
	type PiHostDecodeOutcome,
	type PiHostDecodeResult,
	PiHostResponseExternalizationError,
	PiProtocolIncompatibleError,
} from "../src/pi-host-adapter.js";
import { PiPayloadExternalizationError } from "../src/pi-payload-externalizer.js";

function syncOutcome<T, TRef extends EpochStoredContentRef>(
	result: PiHostDecodeResult<T, TRef>,
): PiHostDecodeOutcome<T, TRef> {
	if ("then" in result) throw new Error("expected synchronous adapter outcome");
	return result;
}

const legacyRpcV1Adapter = {
	...outcomeLegacyRpcV1Adapter,
	decodeResponse(...args: Parameters<typeof outcomeLegacyRpcV1Adapter.decodeResponse>) {
		return syncOutcome(outcomeLegacyRpcV1Adapter.decodeResponse(...args)).value;
	},
	decodeOrphanedResponse(...args: Parameters<typeof outcomeLegacyRpcV1Adapter.decodeOrphanedResponse>) {
		return syncOutcome(outcomeLegacyRpcV1Adapter.decodeOrphanedResponse(...args)).value;
	},
	decodeUnsolicited(...args: Parameters<typeof outcomeLegacyRpcV1Adapter.decodeUnsolicited>) {
		return syncOutcome(outcomeLegacyRpcV1Adapter.decodeUnsolicited(...args)).value;
	},
};

const state = {
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	sessionFile: "/tmp/session.jsonl",
	sessionId: "session-1",
	autoCompactionEnabled: true,
	messageCount: 0,
	pendingMessageCount: 0,
};

const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const imageResponse = {
	type: "response",
	id: "image-response",
	command: "get_messages",
	success: true,
	data: {
		messages: [
			{
				role: "user",
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				timestamp: 1,
			},
		],
	},
} as const;

const attachmentContext = { serverEpoch: "epoch", payloadBudget: SESSION_PAYLOAD_BUDGET } as const;
const futureContext = {
	...attachmentContext,
	contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
} as const;

describe("legacy-rpc-v1 adapter", () => {
	it("keeps externalization disabled by default and carries an explicit null lease", () => {
		const decoded = outcomeLegacyRpcV1Adapter.decodeResponse(
			{ type: "response", id: "1", command: "get_state", success: true, data: state },
			"get_state",
		);
		expect(decoded).toMatchObject({ value: { success: true, data: state }, lease: null });
	});

	it("externalizes a raw image event before the trusted product guard and preserves its lease", async () => {
		const release = vi.fn(async () => {});
		const ref = {
			type: "attachment_ref",
			serverEpoch: "epoch",
			sha256: "a".repeat(64),
			mediaType: "image/png",
			byteLength: 5,
		} as const;
		const lease = { refs: [ref], transfer: vi.fn(), release };
		const externalize = vi.fn(async () => ({
			value: {
				type: "message_start",
				message: {
					role: "user",
					content: [{ type: "image", data: ref, mimeType: "image/png" }],
					timestamp: 1,
				},
			},
			lease,
		}));
		const inline = {
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				timestamp: 1,
			},
		};

		const signal = new AbortController().signal;
		const decoded = await outcomeLegacyRpcV1Adapter.decodeUnsolicited(inline, {
			signal,
			externalizer: {
				context: { serverEpoch: "epoch", payloadBudget: SESSION_PAYLOAD_BUDGET },
				externalize,
			},
		});

		expect(externalize).toHaveBeenCalledWith({ kind: "event", value: inline }, signal);
		expect(decoded).toMatchObject({
			value: { kind: "event", event: { type: "message_start" } },
			lease,
		});
		expect(release).not.toHaveBeenCalled();
	});

	it("uses the future raw guard, generic externalizer, and exact future product guard in order", async () => {
		const ref = {
			type: "content_ref",
			serverEpoch: "epoch",
			sha256: "b".repeat(64),
			encoding: "utf-8",
			byteLength: FUTURE_SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes,
		} as const;
		const release = vi.fn(async () => {});
		const lease = { refs: [ref], transfer: vi.fn(), release };
		const raw = {
			type: "message_start",
			message: {
				role: "bashExecution",
				command: "printf x",
				output: "x",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		} as const;
		const externalize = vi.fn(async () => ({
			value: {
				...raw,
				message: { ...raw.message, output: { type: "external_text", ref } },
			},
			lease,
		}));
		const signal = new AbortController().signal;

		const outcome = await outcomeLegacyRpcV1Adapter.decodeFutureUnsolicited(raw, {
			signal,
			externalizer: { mode: "future_content", context: futureContext, externalize },
		});

		expect(externalize).toHaveBeenCalledWith({ kind: "event", value: raw }, signal);
		expect(outcome.value).toEqual({
			kind: "event",
			event: {
				...raw,
				message: { ...raw.message, output: { type: "external_text", ref } },
			},
		});
		expect(outcome.lease?.refs).toEqual([ref]);
		expect(release).not.toHaveBeenCalled();
	});

	it("rejects a future response command mismatch before generic externalization", () => {
		const externalize = vi.fn();
		expect(() =>
			outcomeLegacyRpcV1Adapter.decodeFutureResponse(imageResponse, "prompt", {
				signal: new AbortController().signal,
				externalizer: { mode: "future_content", context: futureContext, externalize },
			}),
		).toThrowError(
			expect.objectContaining({
				name: "PiProtocolIncompatibleError",
				diagnostic: expect.objectContaining({ reason: "response_command_mismatch" }),
			}),
		);
		expect(externalize).not.toHaveBeenCalled();
	});

	it("future-externalizes Extension UI only after raw admission and preserves the exact lease", async () => {
		const ref = {
			type: "content_ref",
			serverEpoch: "epoch",
			sha256: "d".repeat(64),
			encoding: "utf-8",
			byteLength: FUTURE_SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes,
		} as const;
		const release = vi.fn(async () => {});
		const lease = { refs: [ref], transfer: vi.fn(), release };
		const request = {
			type: "extension_ui_request",
			id: "extension-1",
			method: "set_editor_text",
			text: "x".repeat(1024 * 1024 + 1),
		} as const;
		const product = { ...request, text: { type: "external_text" as const, ref } };
		const externalize = vi.fn(async () => ({ value: product, lease }));
		const signal = new AbortController().signal;

		const outcome = await outcomeLegacyRpcV1Adapter.decodeFutureUnsolicited(request, {
			signal,
			externalizer: { mode: "future_content", context: futureContext, externalize },
		});

		expect(externalize).toHaveBeenCalledWith({ kind: "extension_ui_request", value: request }, signal);
		expect(outcome.value).toEqual({ kind: "extension_ui_request", request: product });
		expect(outcome.lease).toBe(lease);
		expect(release).not.toHaveBeenCalled();
	});

	it("releases future Extension leases when post-processing changes provenance or fails the exact guard", async () => {
		const ref = {
			type: "content_ref",
			serverEpoch: "epoch",
			sha256: "e".repeat(64),
			encoding: "utf-8",
			byteLength: FUTURE_SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes,
		} as const;
		const request = {
			type: "extension_ui_request",
			id: "extension-1",
			method: "set_editor_text",
			text: "x".repeat(1024 * 1024 + 1),
		} as const;

		for (const product of [
			{ ...request, id: "changed", text: { type: "external_text", ref } },
			{
				...request,
				text: { type: "external_text", ref: { ...ref, serverEpoch: "wrong" } },
			},
		]) {
			const release = vi.fn(async () => {});
			await expect(
				outcomeLegacyRpcV1Adapter.decodeFutureUnsolicited(request, {
					signal: new AbortController().signal,
					externalizer: {
						mode: "future_content",
						context: futureContext,
						externalize: async () => ({
							value: product,
							lease: { refs: [ref], transfer: vi.fn(), release },
						}),
					},
				}),
			).rejects.toBeInstanceOf(PiProtocolIncompatibleError);
			expect(release).toHaveBeenCalledOnce();
		}
	});

	it.each([
		new EpochContentStoreError("cache_bytes_exhausted", "quota", { limit: 8, actual: 9 }),
		new EpochContentStoreError("cache_items_exhausted", "quota", { limit: 8, actual: 9 }),
		new EpochContentStoreError("blob_too_large", "blob", { limit: 8, actual: 9 }),
		new PiPayloadExternalizationError("decoded_image_too_large", "blob", 8, 9),
	])("classifies only evidenced response delivery failures as response-local: %s", async (failure) => {
		await expect(
			outcomeLegacyRpcV1Adapter.decodeResponse(imageResponse, "get_messages", {
				signal: new AbortController().signal,
				externalizer: {
					context: attachmentContext,
					externalize: async () => Promise.reject(failure),
				},
			}),
		).rejects.toMatchObject({
			name: "PiHostResponseExternalizationError",
			command: "get_messages",
			message: "Gateway failed to deliver the Pi get_messages response",
		});
	});

	it("applies the same evidence-only response-local policy in future content mode", async () => {
		const evidenced = new EpochContentStoreError("blob_too_large", "generic blob", {
			limit: 8,
			actual: 9,
		});
		await expect(
			outcomeLegacyRpcV1Adapter.decodeFutureResponse(imageResponse, "get_messages", {
				signal: new AbortController().signal,
				externalizer: {
					mode: "future_content",
					context: futureContext,
					externalize: async () => Promise.reject(evidenced),
				},
			}),
		).rejects.toMatchObject({
			name: "PiHostResponseExternalizationError",
			command: "get_messages",
			failure: "blob_too_large",
		});

		const malformed = new PiPayloadExternalizationError("invalid_product_payload", "invalid future root");
		await expect(
			outcomeLegacyRpcV1Adapter.decodeFutureResponse(imageResponse, "get_messages", {
				signal: new AbortController().signal,
				externalizer: {
					mode: "future_content",
					context: futureContext,
					externalize: async () => Promise.reject(malformed),
				},
			}),
		).rejects.toBe(malformed);
	});

	it("releases a future union lease when trusted post-processing rejects the product", async () => {
		const ref = {
			type: "content_ref",
			serverEpoch: "epoch",
			sha256: "c".repeat(64),
			encoding: "utf-8",
			byteLength: FUTURE_SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes,
		} as const;
		const release = vi.fn(async () => {});

		await expect(
			outcomeLegacyRpcV1Adapter.decodeFutureResponse(imageResponse, "get_messages", {
				signal: new AbortController().signal,
				externalizer: {
					mode: "future_content",
					context: futureContext,
					externalize: async () => ({
						value: { ...imageResponse, data: { messages: "not-an-array" } },
						lease: { refs: [ref], transfer: vi.fn(), release },
					}),
				},
			}),
		).rejects.toBeInstanceOf(PiProtocolIncompatibleError);
		expect(release).toHaveBeenCalledOnce();
	});

	it.each([
		new EpochContentStoreError("cache_bytes_exhausted", "missing evidence"),
		new EpochContentStoreError("cache_items_exhausted", "bad evidence", { limit: 8, actual: 8 }),
		new EpochContentStoreError("aborted", "store lifecycle aborted"),
		new EpochContentStoreError("manifest_mismatch", "unsafe metadata"),
		new PiPayloadExternalizationError("decoded_image_too_large", "bad evidence", 8, 8),
		new PiPayloadExternalizationError("aborted", "unproven abort provenance"),
		new PiPayloadExternalizationError("invalid_base64", "invalid image"),
		new PiPayloadExternalizationError("invalid_product_payload", "invalid product"),
		new PiPayloadExternalizationError("rollback_failed", "unknown ownership"),
	])("leaves corruption, contract failures, and invalid evidence terminal: %s", async (failure) => {
		try {
			await outcomeLegacyRpcV1Adapter.decodeResponse(imageResponse, "get_messages", {
				signal: new AbortController().signal,
				externalizer: {
					context: attachmentContext,
					externalize: async () => Promise.reject(failure),
				},
			});
			throw new Error("expected externalization failure");
		} catch (error) {
			expect(error).toBe(failure);
			expect(error).not.toBeInstanceOf(PiHostResponseExternalizationError);
		}
	});

	it("keeps every event externalization failure terminal", async () => {
		const failure = new EpochContentStoreError("cache_bytes_exhausted", "quota", {
			limit: 8,
			actual: 9,
		});
		await expect(
			outcomeLegacyRpcV1Adapter.decodeUnsolicited(
				{ type: "agent_start" },
				{
					signal: new AbortController().signal,
					externalizer: {
						context: attachmentContext,
						externalize: async () => Promise.reject(failure),
					},
				},
			),
		).rejects.toBe(failure);
	});

	it("validates and ignores orphaned responses without externalization", () => {
		const externalize = vi.fn();
		const outcome = outcomeLegacyRpcV1Adapter.decodeOrphanedResponse(imageResponse, {
			signal: new AbortController().signal,
			externalizer: { context: attachmentContext, externalize },
		});
		expect(syncOutcome(outcome)).toEqual({ value: undefined, lease: null });
		expect(externalize).not.toHaveBeenCalled();
	});

	it("releases a nonempty lease when trusted-context post-processing fails", async () => {
		const ref = {
			type: "attachment_ref",
			serverEpoch: "epoch",
			sha256: "a".repeat(64),
			mediaType: "image/png",
			byteLength: 1,
		} as const;
		const release = vi.fn(async () => {});
		await expect(
			outcomeLegacyRpcV1Adapter.decodeResponse(imageResponse, "get_messages", {
				signal: new AbortController().signal,
				externalizer: {
					context: attachmentContext,
					externalize: async () => ({
						value: { ...imageResponse, data: { messages: "not-an-array" } },
						lease: { refs: [ref], transfer: vi.fn(), release },
					}),
				},
			}),
		).rejects.toBeInstanceOf(PiProtocolIncompatibleError);
		expect(release).toHaveBeenCalledOnce();
	});
	it("fully decodes command-specific responses", () => {
		expect(
			legacyRpcV1Adapter.decodeResponse(
				{ type: "response", id: "1", command: "get_state", success: true, data: state },
				"get_state",
			),
		).toMatchObject({ success: true, data: state });
	});

	it("validates and strips reviewed legacy Model routing fields at the product boundary", () => {
		const decoded = legacyRpcV1Adapter.decodeResponse(
			{
				type: "response",
				id: "1",
				command: "get_state",
				success: true,
				data: {
					...state,
					model: {
						id: "model-1",
						name: "Model One",
						api: "openai-responses",
						provider: "provider-1",
						baseUrl: "https://provider.invalid/v1",
						reasoning: true,
						thinking: { mode: "effort", effortMap: { high: "high" }, efforts: ["high"] },
						input: ["text", "image"],
						cost: {
							input: 1,
							output: 2,
							cacheRead: 0.1,
							cacheWrite: 0.2,
							tiers: [{ inputTokensAbove: 1_000, input: 2, output: 3 }],
						},
						contextWindow: 128_000,
						maxTokens: 16_000,
						headers: { Authorization: "must-not-cross" },
						compat: { future: true },
					},
				},
			},
			"get_state",
		);
		expect(decoded).toMatchObject({
			success: true,
			data: {
				model: {
					id: "model-1",
					name: "Model One",
					provider: "provider-1",
					reasoning: true,
					contextWindow: 128_000,
					cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
				},
			},
		});
		expect(JSON.stringify(decoded)).not.toContain("must-not-cross");
		expect(JSON.stringify(decoded)).not.toContain("provider.invalid");
	});

	it("validates but does not expose provider-private assistant metadata", () => {
		const assistant = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			responseId: "provider-response-token",
			diagnostics: [
				{
					type: "provider-warning",
					timestamp: 1,
					error: { message: "failed", stack: "/private/workspace/provider.ts:1" },
				},
			],
			usage,
			stopReason: "deferred",
			deferred: {
				provider: "anthropic",
				modelId: "claude",
				api: "anthropic-messages",
				id: "provider-deferred-token",
			},
			timestamp: 1,
		} as const;
		const response = legacyRpcV1Adapter.decodeResponse(
			{
				type: "response",
				id: "1",
				command: "get_messages",
				success: true,
				data: { messages: [assistant] },
			},
			"get_messages",
		);
		const event = legacyRpcV1Adapter.decodeUnsolicited({ type: "message_start", message: assistant });

		for (const decoded of [response, event]) {
			const json = JSON.stringify(decoded);
			expect(json).not.toContain("provider-response-token");
			expect(json).not.toContain("provider-deferred-token");
			expect(json).not.toContain("/private/workspace");
		}
	});

	it("normalizes Pi's credential-free unknown Model sentinel", () => {
		expect(
			legacyRpcV1Adapter.decodeResponse(
				{
					type: "response",
					id: "1",
					command: "get_state",
					success: true,
					data: {
						...state,
						model: {
							id: "unknown",
							name: "unknown",
							api: "unknown",
							provider: "unknown",
							baseUrl: "",
							reasoning: false,
							input: [],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 0,
							maxTokens: 0,
						},
					},
				},
				"get_state",
			),
		).toMatchObject({ data: { model: { id: "unknown", provider: "unknown" } } });
	});

	it("rejects an unreviewed Model field instead of silently normalizing it", () => {
		expect(() =>
			legacyRpcV1Adapter.decodeResponse(
				{
					type: "response",
					id: "1",
					command: "get_state",
					success: true,
					data: {
						...state,
						model: { id: "m", name: "M", provider: "p", futureSecret: "unknown" },
					},
				},
				"get_state",
			),
		).toThrowError(PiProtocolIncompatibleError);
	});

	it("reserves the export URL for Gateway enrichment", () => {
		expect(() =>
			legacyRpcV1Adapter.decodeResponse(
				{
					type: "response",
					id: "1",
					command: "export_html",
					success: true,
					data: { path: "/tmp/export.html", url: "file:///spoofed" },
				},
				"export_html",
			),
		).toThrowError(PiProtocolIncompatibleError);
	});

	it("rejects Gateway-owned admission details on raw Pi failures", () => {
		const frame = {
			type: "response",
			id: "1",
			command: "prompt",
			success: false,
			error: "spoofed payload policy",
			admissionError: {
				type: "payload_admission_error",
				code: "payload_too_large",
				boundary: "command_frame",
				limitBytes: 8,
				actualBytes: 9,
			},
		} as const;

		expect(() => legacyRpcV1Adapter.decodeResponse(frame, "prompt")).toThrowError(
			PiProtocolIncompatibleError,
		);
		expect(() => legacyRpcV1Adapter.decodeOrphanedResponse(frame)).toThrowError(PiProtocolIncompatibleError);
	});

	it("preserves Gateway-shaped lookalikes inside opaque Pi JSON fields", () => {
		const admissionError = {
			type: "payload_admission_error",
			code: "payload_too_large",
			boundary: "command_frame",
			limitBytes: 8,
			actualBytes: 9,
		} as const;
		expect(
			legacyRpcV1Adapter.decodeResponse(
				{
					type: "response",
					id: "1",
					command: "compact",
					success: true,
					data: {
						summary: "summary",
						firstKeptEntryId: "entry-1",
						tokensBefore: 1,
						details: { admissionError },
					},
				},
				"compact",
			),
		).toMatchObject({ success: true, data: { details: { admissionError } } });

		expect(
			legacyRpcV1Adapter.decodeUnsolicited({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "read",
				result: {
					type: "attachment_ref",
					serverEpoch: "spoofed",
					sha256: "a".repeat(64),
					mediaType: "image/png",
					byteLength: 1,
				},
				isError: false,
			}),
		).toMatchObject({ kind: "event", event: { result: { type: "attachment_ref" } } });
	});

	it("keeps wide raw Pi payloads outside the downstream product DTO boundary", () => {
		const frame = {
			type: "message_start",
			message: {
				role: "user",
				content: [
					{
						type: "image",
						data: "x".repeat(2 * 1024 * 1024 + 1),
						mimeType: "image/png",
					},
				],
				timestamp: 1,
			},
		};

		expect(() => legacyRpcV1Adapter.decodeUnsolicited(frame)).toThrowError(PiProtocolIncompatibleError);
	});

	it("owns create/open arguments and the probed version capability set", () => {
		expect(legacyRpcV1Adapter.version).toBe("0.84.2");
		expect(
			legacyRpcV1Adapter.createSessionArguments({ nativeSessionId: "native-1", sessionDir: "/sessions" }),
		).toEqual(["--session-id", "native-1", "--session-dir", "/sessions"]);
		expect(
			legacyRpcV1Adapter.openSessionArguments({
				sessionFile: "/sessions/one.jsonl",
				sessionDir: "/sessions",
			}),
		).toEqual(["--session", "/sessions/one.jsonl", "--session-dir", "/sessions"]);
	});

	it("enforces the captured 0.84.3 toolcall identity addition only for the candidate", () => {
		const candidate = createLegacyRpcV1Adapter("0.84.3", [
			"rpc.commands",
			"rpc.events",
			"rpc.toolcall_identity",
		]);
		const capturedCandidateFrame = JSON.parse(
			fs.readFileSync(
				new URL("./fixtures/pi-compatibility/0.84.3/event-toolcall-start.json", import.meta.url),
				"utf8",
			),
		) as {
			type: "message_update";
			usage: typeof usage;
			assistantMessageEvent: {
				type: "toolcall_start";
				contentIndex: number;
				id: string;
				toolName: string;
			};
		};
		const legacyFrame = {
			...capturedCandidateFrame,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
		};
		expect(legacyRpcV1Adapter.decodeUnsolicited(legacyFrame)).toMatchObject({ kind: "event" });
		expect(() => candidate.decodeUnsolicited(legacyFrame)).toThrowError(PiProtocolIncompatibleError);

		expect(syncOutcome(candidate.decodeUnsolicited(capturedCandidateFrame)).value).toMatchObject({
			kind: "event",
			event: capturedCandidateFrame,
		});
	});

	it.each([
		[
			"malformed command data",
			{ type: "response", id: "1", command: "get_state", success: true, data: { sessionId: "x" } },
			"malformed_response",
		],
		[
			"mismatched command",
			{ type: "response", id: "1", command: "get_messages", success: true, data: { messages: [] } },
			"response_command_mismatch",
		],
	] as const)("fails closed for %s", (_label, frame, reason) => {
		expect(() => legacyRpcV1Adapter.decodeResponse(frame, "get_state")).toThrowError(
			expect.objectContaining({
				name: "PiProtocolIncompatibleError",
				diagnostic: expect.objectContaining({ code: "protocol_incompatible", reason }),
			}),
		);
	});

	it("decodes authoritative events and every Extension UI variant through product guards", () => {
		expect(legacyRpcV1Adapter.decodeUnsolicited({ type: "agent_start" })).toEqual({
			kind: "event",
			event: { type: "agent_start" },
		});
		for (const request of [
			{ type: "extension_ui_request", id: "1", method: "select", title: "Pick", options: ["a"] },
			{ type: "extension_ui_request", id: "2", method: "confirm", title: "Sure?", message: "Go" },
			{ type: "extension_ui_request", id: "3", method: "input", title: "Value" },
			{ type: "extension_ui_request", id: "4", method: "editor", title: "Edit" },
			{ type: "extension_ui_request", id: "5", method: "notify", message: "Done" },
			{ type: "extension_ui_request", id: "6", method: "setStatus", statusKey: "s" },
			{ type: "extension_ui_request", id: "7", method: "setWidget", widgetKey: "w" },
			{ type: "extension_ui_request", id: "8", method: "setTitle", title: "Title" },
			{ type: "extension_ui_request", id: "9", method: "set_editor_text", text: "Text" },
		]) {
			expect(legacyRpcV1Adapter.decodeUnsolicited(request)).toMatchObject({
				kind: "extension_ui_request",
			});
		}
	});

	it("has an explicit ignorable allowlist and rejects unknown or malformed authoritative frames", () => {
		expect(legacyRpcV1Adapter.decodeUnsolicited({ type: "log", message: "side channel" })).toEqual({
			kind: "ignored",
			frameType: "log",
		});
		for (const frame of [
			{ type: "future_state_change", value: true },
			{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta" } },
			{ type: "extension_ui_request", id: "x", method: "select", options: "not-an-array" },
		]) {
			try {
				legacyRpcV1Adapter.decodeUnsolicited(frame);
				throw new Error("expected decode failure");
			} catch (error) {
				expect(error).toBeInstanceOf(PiProtocolIncompatibleError);
				expect((error as PiProtocolIncompatibleError).diagnostic.code).toBe("protocol_incompatible");
			}
		}
	});
});
