import type {
	FutureProductSessionEventDto,
	FutureSessionSnapshotDto,
	FutureToolResultMessageDto,
	ProductSessionEventDto,
	SessionContentRefDto,
	SessionExternalTextDto,
	SessionRuntimeDto,
} from "@pi-agent-web/protocol";
import {
	FUTURE_SESSION_CONTENT_REF_BUDGET,
	SESSION_NORMALIZED_EVENT_MAX_BYTES,
	SESSION_PAYLOAD_BUDGET,
	SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
} from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import {
	createCurrentSessionProductSchema,
	createFutureSessionProductSchema,
	SessionProductSchemaLogicalError,
} from "../src/session-product-schema.js";

const MIB = 1024 * 1024;
const serverEpoch = "schema-test-epoch";
const futureContext = {
	serverEpoch,
	payloadBudget: SESSION_PAYLOAD_BUDGET,
	contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
};

function contentRef(byteLength: number, sha = "a"): SessionContentRefDto {
	return {
		type: "content_ref",
		serverEpoch,
		sha256: sha.repeat(64),
		byteLength,
		encoding: "utf-8",
	};
}

function externalText(byteLength: number, sha = "a"): SessionExternalTextDto {
	return { type: "external_text", ref: contentRef(byteLength, sha) };
}

function toolResult(
	text: string | SessionExternalTextDto,
	details?: FutureToolResultMessageDto["details"],
): FutureToolResultMessageDto {
	return {
		role: "toolResult",
		toolCallId: "tool-1",
		toolName: "read",
		content: [{ type: "text", text }],
		...(details === undefined ? {} : { details }),
		isError: false,
		timestamp: 1,
	};
}

function event(message: FutureToolResultMessageDto): FutureProductSessionEventDto {
	return { type: "message_end", message };
}

function runtime(lastSeq: number): SessionRuntimeDto {
	return {
		serverEpoch,
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		nativeSessionId: "native-a",
		sessionFile: "/tmp/session-a.jsonl",
		cwd: "/tmp/workspace-a",
		generation: 1,
		lastSeq,
		state: "idle",
		lastActivityAt: 1,
		recoverable: true,
	};
}

function snapshot(firstBytes: number, secondBytes: number): FutureSessionSnapshotDto {
	return {
		type: "session_snapshot",
		snapshotId: "snapshot-a",
		serverEpoch,
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		generation: 1,
		baseSeq: 0,
		asOfSeq: 0,
		runtime: runtime(0),
		settledMessages: [toolResult(externalText(firstBytes, "a")), toolResult(externalText(secondBytes, "b"))],
		projectionEvents: [],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests: [],
		stickyExtensionState: [],
	};
}

describe("Session product schema", () => {
	it("snapshots a mutable current context before guards can observe caller changes", () => {
		const mutableContext = {
			serverEpoch,
			payloadBudget: { ...SESSION_PAYLOAD_BUDGET },
		};
		const schema = createCurrentSessionProductSchema(mutableContext);
		const value = {
			type: "message_end",
			message: {
				role: "user",
				content: [
					{
						type: "image",
						data: {
							type: "attachment_ref",
							serverEpoch,
							sha256: "c".repeat(64),
							mediaType: "image/png",
							byteLength: 4,
						},
						mimeType: "image/png",
					},
				],
				timestamp: 1,
			},
		};
		expect(schema.guardEvent(value)).toBe(true);

		mutableContext.serverEpoch = "mutated-epoch";
		mutableContext.payloadBudget.maxAttachmentBlobBytes = 1;

		expect(schema.serverEpoch).toBe(serverEpoch);
		expect(schema.guardEvent(value)).toBe(true);
	});

	it("snapshots a mutable future context for both guards and logical accounting", () => {
		const mutableContext = {
			serverEpoch,
			payloadBudget: { ...SESSION_PAYLOAD_BUDGET },
			contentRefBudget: { ...FUTURE_SESSION_CONTENT_REF_BUDGET },
		};
		const schema = createFutureSessionProductSchema(mutableContext);
		const value = event(toolResult(externalText(48 * MIB)));
		const before = schema.activeTurnEventLogicalBytes(value);

		mutableContext.serverEpoch = "mutated-epoch";
		mutableContext.payloadBudget.maxAttachmentBlobBytes = 1;
		mutableContext.contentRefBudget.maxContentBlobBytes = 1;

		expect(schema.serverEpoch).toBe(serverEpoch);
		expect(schema.guardEvent(value)).toBe(true);
		expect(schema.activeTurnEventLogicalBytes(value)).toBe(before);
	});

	it("reads accessor-backed future context fields once before validation and capture", () => {
		let epochReads = 0;
		const accessorContext = {
			get serverEpoch() {
				epochReads += 1;
				return epochReads === 1 ? serverEpoch : "changed-between-validation-and-capture";
			},
			payloadBudget: { ...SESSION_PAYLOAD_BUDGET },
			contentRefBudget: { ...FUTURE_SESSION_CONTENT_REF_BUDGET },
		};

		const schema = createFutureSessionProductSchema(accessorContext);

		expect(epochReads).toBe(1);
		expect(schema.serverEpoch).toBe(serverEpoch);
		expect(schema.guardEvent(event(toolResult(externalText(MIB))))).toBe(true);
	});

	it("rejects an extra future context key without invoking its getter", () => {
		let extraRead = false;
		const contextWithExtra = Object.defineProperty(
			{
				serverEpoch,
				payloadBudget: { ...SESSION_PAYLOAD_BUDGET },
				contentRefBudget: { ...FUTURE_SESSION_CONTENT_REF_BUDGET },
			},
			"extra",
			{
				enumerable: true,
				get() {
					extraRead = true;
					throw new Error("must not read extra context fields");
				},
			},
		);

		expect(() => createFutureSessionProductSchema(contextWithExtra)).toThrow(TypeError);
		expect(extraRead).toBe(false);
	});

	it("rejects an extra current context key without invoking its getter", () => {
		let extraRead = false;
		const contextWithExtra = Object.defineProperty(
			{ serverEpoch, payloadBudget: { ...SESSION_PAYLOAD_BUDGET } },
			"extra",
			{
				enumerable: true,
				get() {
					extraRead = true;
					throw new Error("must not read extra context fields");
				},
			},
		);

		expect(() => createCurrentSessionProductSchema(contextWithExtra)).toThrow(TypeError);
		expect(extraRead).toBe(false);
	});

	it("keeps the current schema explicit and rejects future wrappers", () => {
		const implicit = createCurrentSessionProductSchema();
		const explicit = createCurrentSessionProductSchema({
			serverEpoch,
			payloadBudget: SESSION_PAYLOAD_BUDGET,
		});
		const currentEvent: ProductSessionEventDto = { type: "agent_start" };
		const futureEvent = event(toolResult(externalText(MIB)));

		expect(implicit.guardEvent(currentEvent)).toBe(true);
		expect(explicit.guardEvent(currentEvent)).toBe(true);
		expect(implicit.guardEvent(futureEvent)).toBe(false);
		expect(explicit.guardEvent(futureEvent)).toBe(false);
		expect(implicit.activeTurnEventLogicalBytes(currentEvent)).toBe(0);
		expect(explicit.activeTurnEventLogicalBytes(currentEvent)).toBe(0);
	});

	it("keeps guard and logical accounting in one exact future-context schema", () => {
		const schema = createFutureSessionProductSchema(futureContext);
		const value = event(toolResult(externalText(48 * MIB)));

		expect(schema.guardEvent(value)).toBe(true);
		expect(
			createFutureSessionProductSchema({ ...futureContext, serverEpoch: "other-epoch" }).guardEvent(value),
		).toBe(false);
		expect(schema.activeTurnEventLogicalBytes(value)).toBeGreaterThan(48 * MIB);
		expect(schema.activeTurnEventLogicalBytes(value)).toBeLessThanOrEqual(64 * MIB);
		expect(schema.maxNormalizedEventWireBytes).toBe(SESSION_NORMALIZED_EVENT_MAX_BYTES);
		expect(schema.maxReplayFrameWireBytes).toBe(SESSION_NORMALIZED_EVENT_MAX_BYTES);
		expect(schema.maxProjectionSuffixWireBytes).toBe(8 * MIB);
		expect(schema.maxSnapshotCanonicalWireBytes).toBe(64 * MIB);
	});

	it("charges every repeated root occurrence without digest deduplication", () => {
		const schema = createFutureSessionProductSchema(futureContext);
		const one = event(toolResult(externalText(20 * MIB)));
		const repeated = event({
			...toolResult(externalText(20 * MIB)),
			content: [
				{ type: "text", text: externalText(20 * MIB) },
				{ type: "text", text: externalText(20 * MIB) },
			],
		});

		const oneBytes = schema.activeTurnEventLogicalBytes(one);
		const repeatedBytes = schema.activeTurnEventLogicalBytes(repeated);
		expect(repeatedBytes - oneBytes).toBeGreaterThanOrEqual(20 * MIB);
		expect(repeatedBytes).toBeGreaterThan(40 * MIB);
	});

	it("keeps nested wrapper lookalikes ordinary inside a closed inline JSON root", () => {
		const schema = createFutureSessionProductSchema(futureContext);
		const plain = event(toolResult("ok", { type: "inline_json", value: {} }));
		const lookalike = event(
			toolResult("ok", {
				type: "inline_json",
				value: {
					type: "external_json",
					ref: {
						type: "content_ref",
						serverEpoch,
						sha256: "a".repeat(64),
						byteLength: 48 * MIB,
						encoding: "utf-8",
					},
				},
			}),
		);

		const delta = schema.activeTurnEventLogicalBytes(lookalike) - schema.activeTurnEventLogicalBytes(plain);
		expect(schema.guardEvent(lookalike)).toBe(true);
		expect(delta).toBeGreaterThan(0);
		expect(delta).toBeLessThan(1024);
	});

	it("admits exactly 64 MiB of active-turn logical bytes and rejects the next byte", () => {
		const schema = createFutureSessionProductSchema(futureContext);
		const baselineValue = event({
			...toolResult(externalText(MIB, "a")),
			content: [
				{ type: "text", text: externalText(MIB, "a") },
				{ type: "text", text: externalText(MIB, "b") },
			],
		});
		const baseline = schema.activeTurnEventLogicalBytes(baselineValue) - 2 * MIB;
		const remaining = 64 * MIB - baseline;
		const firstBytes = Math.floor(remaining / 2);
		const secondBytes = Math.ceil(remaining / 2);
		const exact = event({
			...toolResult(externalText(firstBytes, "a")),
			content: [
				{ type: "text", text: externalText(firstBytes, "a") },
				{ type: "text", text: externalText(secondBytes, "b") },
			],
		});
		const oversized = event({
			...toolResult(externalText(firstBytes, "a")),
			content: [
				{ type: "text", text: externalText(firstBytes, "a") },
				{ type: "text", text: externalText(secondBytes + 1, "b") },
			],
		});

		expect(schema.activeTurnEventLogicalBytes(exact)).toBe(64 * MIB);
		expect(() => schema.activeTurnEventLogicalBytes(oversized)).toThrowError(
			expect.objectContaining({ code: "limit_exceeded", limit: 64 * MIB }),
		);
	});

	it("rejects future wrappers outside the closed reviewed slots", () => {
		const schema = createFutureSessionProductSchema(futureContext);
		const unreviewed = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: externalText(MIB) }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
		};

		expect(schema.guardEvent(unreviewed)).toBe(false);
	});

	it("enforces a separate exact 64 MiB logical snapshot boundary", () => {
		const schema = createFutureSessionProductSchema(futureContext);
		const baseline = schema.snapshotLogicalBytes(snapshot(MIB, MIB)) - 2 * MIB;
		const remaining = SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES - baseline;
		const exact = snapshot(Math.floor(remaining / 2), Math.ceil(remaining / 2));

		expect(schema.snapshotLogicalBytes(exact)).toBe(SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES);
		expect(() => schema.snapshotLogicalBytes(snapshot(32 * MIB, 32 * MIB))).toThrow(
			SessionProductSchemaLogicalError,
		);
	});
});
