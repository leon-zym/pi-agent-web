import { describe, expect, it } from "vitest";
import {
	attachmentRefMatchesServerEpoch,
	expectCommandData,
	isProductSessionEventDto,
	isSessionAttachmentRefDto,
	isSessionAttachmentRefForNegotiatedBudget,
	isSessionCommandResponseDto,
	isSessionPayloadAdmissionErrorDto,
	isSessionPayloadBudgetDto,
	isSessionWsServerMessage,
	SESSION_ATTACHMENT_BLOB_MAX_BYTES,
	SESSION_EVENT_ENVELOPE_HEADROOM_BYTES,
	SESSION_PAYLOAD_BUDGET,
} from "../src/index.js";

describe("Session payload budget", () => {
	it("publishes every cross-layer byte and item boundary in one canonical table", () => {
		expect(SESSION_PAYLOAD_BUDGET).toEqual({
			maxCommandFrameBytes: 8 * 1024 * 1024,
			maxCommandTextBytes: 1024 * 1024,
			maxInlineImageBase64Bytes: 2 * 1024 * 1024,
			maxInlineImagesBase64Bytes: 6 * 1024 * 1024,
			maxImageCount: 16,
			maxPiJsonlFrameBytes: 8 * 1024 * 1024,
			maxPiSnapshotJsonlFrameBytes: 64 * 1024 * 1024,
			maxNormalizedEventFrameBytes: 8 * 1024 * 1024 + 4 * 1024,
			maxReplayFrameBytes: 8 * 1024 * 1024 + 4 * 1024,
			maxReplayBytes: 16 * 1024 * 1024,
			maxSnapshotCanonicalBytes: 64 * 1024 * 1024,
			maxServerFrameBytes: 65 * 1024 * 1024,
			maxQueuedBacklogBytes: 1024 * 1024,
			maxCatchUpBacklogBytes: 1024 * 1024,
			maxAttachmentBlobBytes: 8 * 1024 * 1024,
			maxAttachmentCacheBytes: 64 * 1024 * 1024,
			maxAttachmentCacheItems: 256,
		});
		expect(isSessionPayloadBudgetDto(SESSION_PAYLOAD_BUDGET)).toBe(true);
		expect(isSessionPayloadBudgetDto({ ...SESSION_PAYLOAD_BUDGET, unexpected: 1 })).toBe(false);
		expect(
			isSessionPayloadBudgetDto({
				...SESSION_PAYLOAD_BUDGET,
				maxReplayFrameBytes: SESSION_PAYLOAD_BUDGET.maxReplayBytes + 1,
			}),
		).toBe(false);
	});

	it("reserves the complete maximum-identity replay envelope above one legal Pi frame", () => {
		const eventPrefix = {
			type: "tool_execution_update",
			toolCallId: "tool-call",
			toolName: "tool",
			args: {},
			partialResult: "",
		} as const;
		const fixedEventBytes = Buffer.byteLength(JSON.stringify(eventPrefix));
		const event = {
			...eventPrefix,
			partialResult: "x".repeat(SESSION_PAYLOAD_BUDGET.maxPiJsonlFrameBytes - fixedEventBytes),
		};
		const replayFrame = {
			type: "event",
			serverEpoch: "\0".repeat(128),
			sessionHandle: "\0".repeat(256),
			workspaceId: "\0".repeat(256),
			generation: Number.MAX_SAFE_INTEGER,
			seq: Number.MAX_SAFE_INTEGER,
			event,
		} as const;
		const rawBytes = Buffer.byteLength(JSON.stringify(event));
		const replayBytes = Buffer.byteLength(JSON.stringify(replayFrame));

		expect(isProductSessionEventDto(event)).toBe(true);
		expect(isSessionWsServerMessage(replayFrame)).toBe(true);
		expect(rawBytes).toBe(SESSION_PAYLOAD_BUDGET.maxPiJsonlFrameBytes);
		expect(replayBytes - rawBytes).toBeLessThanOrEqual(SESSION_EVENT_ENVELOPE_HEADROOM_BYTES);
		expect(replayBytes).toBeLessThanOrEqual(SESSION_PAYLOAD_BUDGET.maxNormalizedEventFrameBytes);
		expect(replayBytes).toBeLessThanOrEqual(SESSION_PAYLOAD_BUDGET.maxReplayFrameBytes);
	});

	it("rejects a normalized event ceiling one byte short of canonical envelope headroom", () => {
		expect(
			isSessionPayloadBudgetDto({
				...SESSION_PAYLOAD_BUDGET,
				maxNormalizedEventFrameBytes:
					SESSION_PAYLOAD_BUDGET.maxPiJsonlFrameBytes + SESSION_EVENT_ENVELOPE_HEADROOM_BYTES - 1,
			}),
		).toBe(false);
	});

	it("admits a worst-case quoted one MiB text payload through event and replay envelopes", () => {
		const text = '\\"'.repeat(SESSION_PAYLOAD_BUDGET.maxCommandTextBytes / 2);
		const replayFrame = {
			type: "event",
			serverEpoch: "epoch-a",
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 1,
			seq: 1,
			event: {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
			},
		};
		const serializedBytes = Buffer.byteLength(JSON.stringify(replayFrame));

		expect(Buffer.byteLength(text)).toBe(SESSION_PAYLOAD_BUDGET.maxCommandTextBytes);
		expect(serializedBytes).toBeLessThanOrEqual(SESSION_PAYLOAD_BUDGET.maxNormalizedEventFrameBytes);
		expect(serializedBytes).toBeLessThanOrEqual(SESSION_PAYLOAD_BUDGET.maxReplayFrameBytes);
		expect(serializedBytes).toBeLessThanOrEqual(SESSION_PAYLOAD_BUDGET.maxServerFrameBytes);
	});

	it.each([
		[
			"command text to browser command frame",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxCommandTextBytes: SESSION_PAYLOAD_BUDGET.maxCommandFrameBytes + 1,
			},
		],
		[
			"inline image to inline image aggregate",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxInlineImageBase64Bytes: SESSION_PAYLOAD_BUDGET.maxInlineImagesBase64Bytes + 1,
			},
		],
		[
			"inline image aggregate to browser command frame",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxInlineImagesBase64Bytes: SESSION_PAYLOAD_BUDGET.maxCommandFrameBytes + 1,
			},
		],
		[
			"browser command frame to Pi line",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxCommandFrameBytes: SESSION_PAYLOAD_BUDGET.maxPiJsonlFrameBytes + 1,
			},
		],
		[
			"Pi line to Pi snapshot line",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxPiSnapshotJsonlFrameBytes: SESSION_PAYLOAD_BUDGET.maxPiJsonlFrameBytes - 1,
			},
		],
		[
			"Pi line to normalized event",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxPiJsonlFrameBytes: SESSION_PAYLOAD_BUDGET.maxNormalizedEventFrameBytes + 1,
			},
		],
		[
			"replay frame to replay aggregate",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxReplayFrameBytes: SESSION_PAYLOAD_BUDGET.maxReplayBytes + 1,
			},
		],
		[
			"normalized event to replay frame",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxNormalizedEventFrameBytes: SESSION_PAYLOAD_BUDGET.maxReplayFrameBytes + 1,
			},
		],
		[
			"replay frame to server frame",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxReplayFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes + 1,
				maxReplayBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes + 1,
			},
		],
		[
			"Pi snapshot line to canonical snapshot",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxPiSnapshotJsonlFrameBytes: SESSION_PAYLOAD_BUDGET.maxSnapshotCanonicalBytes + 1,
			},
		],
		[
			"canonical snapshot to server frame",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxSnapshotCanonicalBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes + 1,
			},
		],
		[
			"queued backlog to server frame",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxQueuedBacklogBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes + 1,
			},
		],
		[
			"catch-up backlog to server frame",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxCatchUpBacklogBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes + 1,
			},
		],
		[
			"attachment blob to attachment cache",
			{
				...SESSION_PAYLOAD_BUDGET,
				maxAttachmentBlobBytes: SESSION_PAYLOAD_BUDGET.maxAttachmentCacheBytes + 1,
			},
		],
	] as const)("rejects an inverted %s budget", (_label, budget) => {
		expect(isSessionPayloadBudgetDto(budget)).toBe(false);
	});
});

describe("epoch-scoped attachment references", () => {
	const attachmentRef = {
		type: "attachment_ref",
		serverEpoch: "epoch-a",
		sha256: "a".repeat(64),
		mediaType: "image/webp",
		byteLength: 1_500_000,
	} as const;

	it("accepts one bounded content address only in its Gateway epoch", () => {
		expect(isSessionAttachmentRefDto(attachmentRef)).toBe(true);
		expect(
			isSessionAttachmentRefDto({
				...attachmentRef,
				byteLength: SESSION_ATTACHMENT_BLOB_MAX_BYTES,
			}),
		).toBe(true);
		expect(attachmentRefMatchesServerEpoch(attachmentRef, "epoch-a")).toBe(true);
		expect(attachmentRefMatchesServerEpoch(attachmentRef, "epoch-b")).toBe(false);
	});

	it("rejects malformed digests, media types, sizes, and non-canonical records", () => {
		expect(isSessionAttachmentRefDto({ ...attachmentRef, sha256: "A".repeat(64) })).toBe(false);
		expect(isSessionAttachmentRefDto({ ...attachmentRef, mediaType: "image/webp\nunsafe" })).toBe(false);
		expect(
			isSessionAttachmentRefDto({
				...attachmentRef,
				byteLength: SESSION_ATTACHMENT_BLOB_MAX_BYTES + 1,
			}),
		).toBe(false);
		expect(isSessionAttachmentRefDto({ ...attachmentRef, byteLength: 0 })).toBe(false);
		expect(isSessionAttachmentRefDto({ ...attachmentRef, unexpected: true })).toBe(false);
		expect(isSessionAttachmentRefDto(Object.create(attachmentRef))).toBe(false);
		const accessor = { ...attachmentRef };
		Object.defineProperty(accessor, "byteLength", { enumerable: true, get: () => 1 });
		expect(isSessionAttachmentRefDto(accessor)).toBe(false);
	});

	it("combines structural, negotiated blob, and exact epoch admission", () => {
		const negotiatedBudget = {
			...SESSION_PAYLOAD_BUDGET,
			maxAttachmentBlobBytes: 1_500_000,
		};
		expect(isSessionAttachmentRefForNegotiatedBudget(attachmentRef, "epoch-a", negotiatedBudget)).toBe(true);
		expect(
			isSessionAttachmentRefForNegotiatedBudget(
				{ ...attachmentRef, byteLength: negotiatedBudget.maxAttachmentBlobBytes + 1 },
				"epoch-a",
				negotiatedBudget,
			),
		).toBe(false);
		expect(isSessionAttachmentRefForNegotiatedBudget(attachmentRef, "epoch-b", negotiatedBudget)).toBe(false);
		expect(
			isSessionAttachmentRefForNegotiatedBudget(attachmentRef, "epoch-a", {
				...negotiatedBudget,
				maxReplayFrameBytes: negotiatedBudget.maxReplayBytes + 1,
			}),
		).toBe(false);
	});
});

describe("structured payload admission errors", () => {
	const admissionError = {
		type: "payload_admission_error",
		code: "payload_too_large",
		boundary: "command_frame",
		limitBytes: SESSION_PAYLOAD_BUDGET.maxCommandFrameBytes,
		actualBytes: SESSION_PAYLOAD_BUDGET.maxCommandFrameBytes + 1,
	} as const;

	it("validates stable localization fields and carries them on failed command responses", () => {
		expect(isSessionPayloadAdmissionErrorDto(admissionError)).toBe(true);
		expect(
			isSessionCommandResponseDto({
				type: "response",
				id: "prompt-1",
				command: "prompt",
				success: false,
				error: "payload rejected",
				admissionError,
			}),
		).toBe(true);
		try {
			expectCommandData(
				{
					type: "response",
					id: "prompt-1",
					command: "prompt",
					success: false,
					error: "payload rejected",
					admissionError,
				},
				"prompt",
			);
			throw new Error("expected command failure");
		} catch (error) {
			expect(error).toMatchObject({ admissionError });
		}
	});

	it("rejects inconsistent byte evidence and unknown error fields", () => {
		expect(
			isSessionPayloadAdmissionErrorDto({ ...admissionError, actualBytes: admissionError.limitBytes }),
		).toBe(false);
		expect(isSessionPayloadAdmissionErrorDto({ ...admissionError, extra: true })).toBe(false);
		expect(
			isSessionPayloadAdmissionErrorDto({
				...admissionError,
				code: "attachment_cache_exhausted",
				boundary: "command_frame",
			}),
		).toBe(false);
		expect(
			isSessionPayloadAdmissionErrorDto({
				type: "payload_admission_error",
				code: "attachment_ref_epoch_mismatch",
				boundary: "attachment_ref",
				limitBytes: 1,
			}),
		).toBe(false);
	});
});
