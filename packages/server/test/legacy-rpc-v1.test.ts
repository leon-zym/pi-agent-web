import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createLegacyRpcV1Adapter, legacyRpcV1Adapter } from "../src/legacy-rpc-v1.js";
import { PiProtocolIncompatibleError } from "../src/pi-host-adapter.js";

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

describe("legacy-rpc-v1 adapter", () => {
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
			fs.readFileSync(new URL("./fixtures/pi-0.84.3-toolcall-start.json", import.meta.url), "utf8"),
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

		expect(candidate.decodeUnsolicited(capturedCandidateFrame)).toMatchObject({
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
