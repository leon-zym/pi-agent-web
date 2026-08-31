import { describe, expect, it, vi } from "vitest";
import {
	GATEWAY_CLIENT_REQUIRED_CAPABILITIES,
	GATEWAY_CONTENT_REF_CAPABILITY,
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	isSessionContentRefBudgetDto,
	isSessionContentRefDto,
	isSessionContentRefForNegotiatedBudget,
	isSessionContentRefGuardContext,
	isSessionExternalTextDto,
	isSessionJsonRootDto,
	isSessionPayloadBudgetDto,
	isSessionTextPayloadDto,
	SESSION_CONTENT_BLOB_MAX_BYTES,
	SESSION_CONTENT_INLINE_THRESHOLD_BYTES,
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
} from "../src/index.js";

describe("protocol 1.4 content references", () => {
	const contentRef = {
		type: "content_ref",
		serverEpoch: "epoch-a",
		sha256: "a".repeat(64),
		byteLength: 48 * 1024 * 1024,
		encoding: "utf-8",
	} as const;
	const context = {
		serverEpoch: "epoch-a",
		payloadBudget: SESSION_PAYLOAD_BUDGET,
		contentRefBudget: SESSION_CONTENT_REF_BUDGET,
	};

	it("publishes the active capability in the production protocol", () => {
		expect(GATEWAY_PROTOCOL_VERSION).toEqual({ major: 1, minor: 4 });
		expect(GATEWAY_CONTENT_REF_CAPABILITY).toBe("payload.epoch_content_refs");
		expect(GATEWAY_CLIENT_REQUIRED_CAPABILITIES).toContain(GATEWAY_CONTENT_REF_CAPABILITY);
		expect(GATEWAY_SERVER_REQUIRED_CAPABILITIES).toContain(GATEWAY_CONTENT_REF_CAPABILITY);
	});

	it("keeps attachment and generic content budgets independently exact", () => {
		expect(SESSION_CONTENT_BLOB_MAX_BYTES).toBe(48 * 1024 * 1024);
		expect(SESSION_CONTENT_REF_BUDGET).toEqual({
			maxContentBlobBytes: SESSION_CONTENT_BLOB_MAX_BYTES,
			inlineContentThresholdBytes: 256 * 1024,
		});
		expect(SESSION_CONTENT_INLINE_THRESHOLD_BYTES).toBe(256 * 1024);
		expect("maxContentBlobBytes" in SESSION_PAYLOAD_BUDGET).toBe(false);
		expect("inlineContentThresholdBytes" in SESSION_PAYLOAD_BUDGET).toBe(false);
		expect(
			isSessionPayloadBudgetDto({
				...SESSION_PAYLOAD_BUDGET,
				maxContentBlobBytes: SESSION_CONTENT_BLOB_MAX_BYTES,
			}),
		).toBe(false);
		expect(SESSION_PAYLOAD_BUDGET.maxAttachmentBlobBytes).toBe(8 * 1024 * 1024);
		expect(SESSION_PAYLOAD_BUDGET.maxAttachmentCacheBytes).toBe(64 * 1024 * 1024);
		expect(isSessionContentRefBudgetDto(SESSION_CONTENT_REF_BUDGET)).toBe(true);
		expect(isSessionContentRefGuardContext(context)).toBe(true);
		expect(isSessionContentRefBudgetDto({ ...SESSION_CONTENT_REF_BUDGET, maxContentBlobBytes: 0 })).toBe(
			false,
		);
		expect(
			isSessionContentRefBudgetDto({
				...SESSION_CONTENT_REF_BUDGET,
				maxContentBlobBytes: SESSION_CONTENT_BLOB_MAX_BYTES + 1,
			}),
		).toBe(false);
		expect(isSessionContentRefBudgetDto({ ...SESSION_CONTENT_REF_BUDGET, unexpected: true })).toBe(false);
		const { payloadBudget: _omittedPayloadBudget, ...contextWithoutPayloadBudget } = context;
		expect(isSessionContentRefGuardContext(contextWithoutPayloadBudget)).toBe(false);
		expect(
			isSessionContentRefBudgetDto({
				...SESSION_CONTENT_REF_BUDGET,
				inlineContentThresholdBytes: SESSION_CONTENT_INLINE_THRESHOLD_BYTES - 1,
			}),
		).toBe(false);
		expect(
			isSessionContentRefBudgetDto({
				...SESSION_CONTENT_REF_BUDGET,
				maxContentBlobBytes: SESSION_CONTENT_INLINE_THRESHOLD_BYTES - 1,
			}),
		).toBe(false);
		expect(
			isSessionContentRefGuardContext({
				...context,
				payloadBudget: {
					...SESSION_PAYLOAD_BUDGET,
					maxAttachmentBlobBytes: SESSION_CONTENT_BLOB_MAX_BYTES - 1,
					maxAttachmentCacheBytes: SESSION_CONTENT_BLOB_MAX_BYTES - 1,
				},
			}),
		).toBe(false);
	});

	it("accepts only an exact epoch-scoped UTF-8 content reference", () => {
		expect(isSessionContentRefDto(contentRef)).toBe(true);
		expect(isSessionContentRefForNegotiatedBudget(contentRef, "epoch-a", SESSION_CONTENT_REF_BUDGET)).toBe(
			true,
		);
		expect(isSessionContentRefForNegotiatedBudget(contentRef, "epoch-b", SESSION_CONTENT_REF_BUDGET)).toBe(
			false,
		);
		expect(isSessionContentRefDto({ ...contentRef, encoding: "utf8" })).toBe(false);
		expect(isSessionContentRefDto({ ...contentRef, sha256: "A".repeat(64) })).toBe(false);
		expect(isSessionContentRefDto({ ...contentRef, byteLength: SESSION_CONTENT_BLOB_MAX_BYTES + 1 })).toBe(
			false,
		);
		expect(isSessionContentRefDto({ ...contentRef, mediaType: "text/plain" })).toBe(false);
		expect(isSessionContentRefDto(Object.create(contentRef))).toBe(false);
		const accessor = { ...contentRef };
		Object.defineProperty(accessor, "byteLength", { enumerable: true, get: () => 1 });
		expect(isSessionContentRefDto(accessor)).toBe(false);
		expect(
			isSessionContentRefForNegotiatedBudget(contentRef, "epoch-a", {
				...SESSION_CONTENT_REF_BUDGET,
				maxContentBlobBytes: contentRef.byteLength - 1,
			}),
		).toBe(false);
	});

	it("admits external text only with the trusted negotiated epoch and budget", () => {
		const externalText = { type: "external_text", ref: contentRef } as const;
		expect(isSessionExternalTextDto(externalText)).toBe(false);
		expect(isSessionExternalTextDto(externalText, context)).toBe(true);
		expect(isSessionExternalTextDto(externalText, { ...context, serverEpoch: "epoch-b" })).toBe(false);
		expect(isSessionExternalTextDto({ ...externalText, unexpected: true }, context)).toBe(false);
		expect(
			isSessionExternalTextDto(
				{
					...externalText,
					ref: { ...contentRef, byteLength: SESSION_CONTENT_INLINE_THRESHOLD_BYTES - 1 },
				},
				context,
			),
		).toBe(false);
		expect(
			isSessionExternalTextDto(
				{
					...externalText,
					ref: { ...contentRef, byteLength: SESSION_CONTENT_INLINE_THRESHOLD_BYTES },
				},
				context,
			),
		).toBe(true);
	});

	it("keeps inline text strictly below the future UTF-8 byte threshold", () => {
		expect(isSessionTextPayloadDto("x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES - 1), context)).toBe(
			true,
		);
		expect(isSessionTextPayloadDto("x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES), context)).toBe(false);
		expect(
			isSessionTextPayloadDto("界".repeat(Math.ceil(SESSION_CONTENT_INLINE_THRESHOLD_BYTES / 3)), context),
		).toBe(false);
	});

	it("requires every JSON root to use an inline or external envelope", () => {
		expect(isSessionJsonRootDto({ answer: 42 }, context)).toBe(false);
		expect(isSessionJsonRootDto({ type: "inline_json", value: { answer: 42 } }, context)).toBe(true);
		expect(isSessionJsonRootDto({ type: "inline_json", value: { answer: 42 } })).toBe(false);
		expect(isSessionJsonRootDto({ type: "external_json", ref: contentRef }, context)).toBe(true);
		expect(isSessionJsonRootDto({ type: "external_json", ref: contentRef })).toBe(false);
		expect(
			isSessionJsonRootDto(
				{
					type: "external_json",
					ref: { ...contentRef, byteLength: SESSION_CONTENT_INLINE_THRESHOLD_BYTES - 1 },
				},
				context,
			),
		).toBe(false);
		expect(
			isSessionJsonRootDto(
				{
					type: "external_json",
					ref: { ...contentRef, byteLength: SESSION_CONTENT_INLINE_THRESHOLD_BYTES },
				},
				context,
			),
		).toBe(true);
		expect(
			isSessionJsonRootDto(
				{ type: "external_json", ref: contentRef },
				{
					...context,
					contentRefBudget: {
						...SESSION_CONTENT_REF_BUDGET,
						maxContentBlobBytes: contentRef.byteLength - 1,
					},
				},
			),
		).toBe(false);
	});

	it("keeps nested reference and wrapper lookalikes as ordinary inline JSON", () => {
		const nestedLookalikes = {
			type: "inline_json",
			value: {
				ref: { ...contentRef },
				wrapper: { type: "external_json", ref: { ...contentRef } },
			},
		} as const;
		expect(isSessionJsonRootDto(nestedLookalikes, context)).toBe(true);
		expect(isSessionJsonRootDto({ ...nestedLookalikes, extra: true }, context)).toBe(false);
	});

	it("bounds inline JSON by its encoded bytes without serializing the candidate", () => {
		const belowThreshold = {
			type: "inline_json",
			value: "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES - 3),
		} as const;
		const atThreshold = {
			type: "inline_json",
			value: "x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES - 2),
		} as const;
		const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
			throw new Error("candidate serialization is forbidden in a guard");
		});
		let belowResult: boolean;
		let atResult: boolean;
		try {
			belowResult = isSessionJsonRootDto(belowThreshold, context);
			atResult = isSessionJsonRootDto(atThreshold, context);
		} finally {
			stringify.mockRestore();
		}
		expect(belowResult).toBe(true);
		expect(atResult).toBe(false);
		expect(
			isSessionJsonRootDto(
				{
					type: "inline_json",
					value: '"'.repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES / 2),
				},
				context,
			),
		).toBe(false);
	});

	it("stops before later values and never allocates a complete encoded copy", () => {
		let laterValueAccessed = false;
		const values = ["x".repeat(SESSION_CONTENT_INLINE_THRESHOLD_BYTES)] as unknown[];
		Object.defineProperty(values, 1, {
			enumerable: true,
			get: () => {
				laterValueAccessed = true;
				throw new Error("guard traversed after crossing the inline threshold");
			},
		});
		const encode = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(() => {
			throw new Error("guard allocated a complete UTF-8 copy");
		});
		let result: boolean;
		try {
			result = isSessionJsonRootDto({ type: "inline_json", value: values }, context);
		} finally {
			encode.mockRestore();
		}
		expect(result).toBe(false);
		expect(laterValueAccessed).toBe(false);
	});

	it.each([null, true, -0, 1e10, { quote: '"\\\n', unicode: "界😀\ud800" }, [1, false, "value"]])(
		"matches standard JSON encoding bytes at the inline boundary for %#",
		(sample) => {
			const serialized = JSON.stringify(sample);
			expect(serialized).toBeTypeOf("string");
			const sampleBytes = new TextEncoder().encode(serialized).byteLength;
			const paddingLength = SESSION_CONTENT_INLINE_THRESHOLD_BYTES - sampleBytes - 5;
			expect(
				isSessionJsonRootDto(
					{ type: "inline_json", value: [sample, "x".repeat(paddingLength - 1)] },
					context,
				),
			).toBe(true);
			expect(
				isSessionJsonRootDto({ type: "inline_json", value: [sample, "x".repeat(paddingLength)] }, context),
			).toBe(false);
		},
	);

	it("preserves bounded JSON depth, item, cycle, finite-number, and plain-object rules", () => {
		let tooDeep: unknown = null;
		for (let depth = 0; depth < 33; depth++) tooDeep = [tooDeep];
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		const tooManyItems = Array.from({ length: 6 }, () => Array.from({ length: 9_000 }, () => 0));

		expect(isSessionJsonRootDto({ type: "inline_json", value: tooDeep }, context)).toBe(false);
		expect(isSessionJsonRootDto({ type: "inline_json", value: tooManyItems }, context)).toBe(false);
		expect(isSessionJsonRootDto({ type: "inline_json", value: cyclic }, context)).toBe(false);
		expect(isSessionJsonRootDto({ type: "inline_json", value: Number.NaN }, context)).toBe(false);
		expect(isSessionJsonRootDto({ type: "inline_json", value: new Date(0) }, context)).toBe(false);
	});
});
