import type { SessionAttachmentRefDto, SessionContentRefDto } from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import type { EpochContentHold, EpochStoredContentRef } from "../src/epoch-content-store.js";
import { GenerationContentOwner } from "../src/generation-content-owner.js";
import type { PiPayloadLeaseTransfer } from "../src/pi-payload-externalizer.js";
import { TransitionPayloadLedger, TransitionPayloadLedgerError } from "../src/transition-payload-ledger.js";

const SERVER_EPOCH = "transition-ledger-epoch";

function ref(sha256: string, serverEpoch = SERVER_EPOCH): SessionAttachmentRefDto {
	return Object.freeze({
		type: "attachment_ref",
		serverEpoch,
		sha256,
		mediaType: "image/png",
		byteLength: 4,
	});
}

function contentRef(sha256: string, serverEpoch = SERVER_EPOCH): SessionContentRefDto {
	return Object.freeze({
		type: "content_ref",
		serverEpoch,
		sha256,
		byteLength: 4,
		encoding: "utf-8",
	});
}

function trackedStoredTransfer<TRef extends EpochStoredContentRef>(
	refs: readonly TRef[],
	tracking: { adopted: number; released: number },
): PiPayloadLeaseTransfer<TRef> {
	const holds = Object.freeze(refs.map((candidate) => Object.freeze({ ref: candidate })));
	let state: "pending" | "adopted" | "released" = "pending";
	return Object.freeze({
		refs: Object.freeze([...refs]),
		adopt(accept: Parameters<PiPayloadLeaseTransfer<TRef>["adopt"]>[0]) {
			if (state !== "pending") throw new Error("test transfer is not pending");
			if (accept(holds) !== true) throw new Error("test transfer was rejected");
			state = "adopted";
			tracking.adopted += 1;
		},
		async release() {
			if (state !== "pending") return;
			state = "released";
			tracking.released += 1;
		},
	});
}

function trackedTransfer(
	refs: readonly SessionAttachmentRefDto[],
	tracking: { adopted: number; released: number },
	options: { releaseError?: Error } = {},
): PiPayloadLeaseTransfer {
	const holds = Object.freeze(refs.map((candidate) => Object.freeze({ ref: candidate })));
	let state: "pending" | "adopted" | "releasing" | "released" = "pending";
	let releasePromise: Promise<void> | null = null;
	return Object.freeze({
		refs: Object.freeze([...refs]),
		adopt(accept: Parameters<PiPayloadLeaseTransfer["adopt"]>[0]) {
			if (state !== "pending") throw new Error("test transfer is not pending");
			if (accept(holds) !== true) throw new Error("test transfer was rejected");
			state = "adopted";
			tracking.adopted += 1;
		},
		release() {
			if (state === "adopted" || state === "released") return releasePromise ?? Promise.resolve();
			if (state === "releasing") return releasePromise!;
			state = "releasing";
			tracking.released += 1;
			releasePromise = (
				options.releaseError ? Promise.reject(options.releaseError) : Promise.resolve()
			).finally(() => {
				state = "released";
			});
			return releasePromise;
		},
	});
}

function owner(released: EpochContentHold[] = []): GenerationContentOwner {
	return new GenerationContentOwner({
		serverEpoch: SERVER_EPOCH,
		generation: 2,
		release: async (entry) => {
			released.push(entry);
		},
	});
}

describe("TransitionPayloadLedger", () => {
	it("accounts mixed physical holds and drains namespace-separated refs without coalescing", async () => {
		const digest = "0".repeat(64);
		const firstTracking = { adopted: 0, released: 0 };
		const duplicateTracking = { adopted: 0, released: 0 };
		const mixed = trackedStoredTransfer<EpochStoredContentRef>(
			[ref(digest), contentRef(digest)],
			firstTracking,
		);
		const duplicateUtf8 = trackedStoredTransfer([contentRef(digest)], duplicateTracking);
		const ledger = new TransitionPayloadLedger<EpochStoredContentRef>({ maxBytes: 12, maxHoldItems: 3 });
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const target = new GenerationContentOwner<EpochStoredContentRef>({
			serverEpoch: SERVER_EPOCH,
			generation: 2,
			release: async (entry) => {
				released.push(entry);
			},
		});

		ledger.append({ transfer: mixed, bytes: 8 });
		ledger.append({ transfer: duplicateUtf8, bytes: 4 });
		expect(ledger.bytes).toBe(12);
		expect(ledger.holdItems).toBe(3);

		ledger.drainTo(target);
		expect(target.size).toBe(2);
		expect(new Set(target.refs.map((candidate) => candidate.type))).toEqual(
			new Set(["attachment_ref", "content_ref"]),
		);
		await target.release();
		expect(released).toHaveLength(3);
		expect(firstTracking).toEqual({ adopted: 1, released: 0 });
		expect(duplicateTracking).toEqual({ adopted: 1, released: 0 });
	});

	it("enforces byte and hold-item ceilings before taking transfer custody", async () => {
		const ledger = new TransitionPayloadLedger({ maxBytes: 10, maxHoldItems: 2 });
		const firstTracking = { adopted: 0, released: 0 };
		const byteOverflowTracking = { adopted: 0, released: 0 };
		const itemOverflowTracking = { adopted: 0, released: 0 };
		const first = trackedTransfer([ref("a".repeat(64))], firstTracking);
		const byteOverflow = trackedTransfer([ref("b".repeat(64))], byteOverflowTracking);
		const itemOverflow = trackedTransfer([ref("c".repeat(64)), ref("d".repeat(64))], itemOverflowTracking);

		ledger.append({ transfer: first, bytes: 6 });
		expect(() => ledger.append({ transfer: byteOverflow, bytes: 5 })).toThrow(/byte limit/i);
		expect(() => ledger.append({ transfer: itemOverflow, bytes: 4 })).toThrow(/hold item limit/i);
		expect(ledger.bytes).toBe(6);
		expect(ledger.holdItems).toBe(1);
		expect(ledger.pendingTransfers).toBe(1);

		await ledger.releaseRemaining();
		expect(firstTracking).toEqual({ adopted: 0, released: 1 });
		expect(byteOverflowTracking).toEqual({ adopted: 0, released: 0 });
		expect(itemOverflowTracking).toEqual({ adopted: 0, released: 0 });
		await Promise.all([byteOverflow.release(), itemOverflow.release()]);
	});

	it("rejects duplicate append without consuming the transfer twice", async () => {
		const ledger = new TransitionPayloadLedger({ maxBytes: 100, maxHoldItems: 4 });
		const tracking = { adopted: 0, released: 0 };
		const candidate = trackedTransfer([ref("e".repeat(64))], tracking);

		ledger.append({ transfer: candidate, bytes: 10 });
		expect(() => ledger.append({ transfer: candidate, bytes: 10 })).toThrow(/already appended/i);
		await ledger.releaseRemaining();
		expect(tracking).toEqual({ adopted: 0, released: 1 });
	});

	it("drains every transfer exactly once and delegates digest deduplication to the owner", async () => {
		const ownerReleased: EpochContentHold[] = [];
		const target = owner(ownerReleased);
		const ledger = new TransitionPayloadLedger({ maxBytes: 100, maxHoldItems: 4 });
		const exact = ref("f".repeat(64));
		const firstTracking = { adopted: 0, released: 0 };
		const duplicateTracking = { adopted: 0, released: 0 };
		ledger.append({ transfer: trackedTransfer([exact], firstTracking), bytes: 20 });
		ledger.append({ transfer: trackedTransfer([exact], duplicateTracking), bytes: 20 });

		ledger.drainTo(target);

		expect(ledger.state).toBe("drained");
		expect(ledger.pendingTransfers).toBe(0);
		expect(ledger.adoptedTransfers).toBe(2);
		expect(target.size).toBe(1);
		expect(firstTracking.adopted).toBe(1);
		expect(duplicateTracking.adopted).toBe(1);
		expect(() => ledger.drainTo(target)).toThrow(TransitionPayloadLedgerError);
		expect(() =>
			ledger.append({
				transfer: trackedTransfer([ref("0".repeat(64))], { adopted: 0, released: 0 }),
				bytes: 1,
			}),
		).toThrow(TransitionPayloadLedgerError);
		await expect(ledger.releaseRemaining()).resolves.toBeUndefined();
		await target.release();
		expect(ownerReleased).toHaveLength(2);
	});

	it("exposes a partial drain failure and only releases transfers that were not adopted", async () => {
		const target = owner();
		const ledger = new TransitionPayloadLedger({ maxBytes: 100, maxHoldItems: 4 });
		const firstTracking = { adopted: 0, released: 0 };
		const invalidTracking = { adopted: 0, released: 0 };
		const tailTracking = { adopted: 0, released: 0 };
		ledger.append({ transfer: trackedTransfer([ref("1".repeat(64))], firstTracking), bytes: 10 });
		ledger.append({
			transfer: trackedTransfer([ref("2".repeat(64), "foreign-epoch")], invalidTracking),
			bytes: 10,
		});
		ledger.append({ transfer: trackedTransfer([ref("3".repeat(64))], tailTracking), bytes: 10 });

		expect(() => ledger.drainTo(target)).toThrow(/drain failed/i);
		expect(ledger.state).toBe("drain_failed");
		expect(ledger.adoptedTransfers).toBe(1);
		expect(ledger.pendingTransfers).toBe(2);
		expect(target.size).toBe(1);
		expect(() => ledger.drainTo(target)).toThrow(/already consumed/i);

		const cleanup = ledger.releaseRemaining();
		expect(ledger.releaseRemaining()).toBe(cleanup);
		await cleanup;
		expect(firstTracking).toEqual({ adopted: 1, released: 0 });
		expect(invalidTracking).toEqual({ adopted: 0, released: 1 });
		expect(tailTracking).toEqual({ adopted: 0, released: 1 });
		await target.release();
	});

	it("starts all remaining releases and makes a partial cleanup failure terminal and observable", async () => {
		const ledger = new TransitionPayloadLedger({ maxBytes: 100, maxHoldItems: 4 });
		const failedTracking = { adopted: 0, released: 0 };
		const healthyTracking = { adopted: 0, released: 0 };
		ledger.append({
			transfer: trackedTransfer([ref("4".repeat(64))], failedTracking, {
				releaseError: new Error("fixture release failed"),
			}),
			bytes: 10,
		});
		ledger.append({ transfer: trackedTransfer([ref("5".repeat(64))], healthyTracking), bytes: 10 });

		const cleanup = ledger.releaseRemaining();
		expect(failedTracking.released).toBe(1);
		expect(healthyTracking.released).toBe(1);
		await expect(cleanup).rejects.toThrow(/release failed/i);
		expect(ledger.state).toBe("release_failed");
		expect(ledger.pendingTransfers).toBe(0);
		expect(ledger.releaseRemaining()).toBe(cleanup);
		await expect(ledger.releaseRemaining()).rejects.toThrow(/release failed/i);
		expect(() => ledger.drainTo(owner())).toThrow(/already consumed/i);
	});

	it("validates options and append accounting without mutation", () => {
		expect(() => new TransitionPayloadLedger({ maxBytes: -1, maxHoldItems: 1 })).toThrow(
			TransitionPayloadLedgerError,
		);
		const ledger = new TransitionPayloadLedger({ maxBytes: 10, maxHoldItems: 1 });
		const tracking = { adopted: 0, released: 0 };
		const candidate = trackedTransfer([ref("6".repeat(64))], tracking);

		expect(() => ledger.append({ transfer: candidate, bytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
			TransitionPayloadLedgerError,
		);
		expect(ledger.bytes).toBe(0);
		expect(ledger.holdItems).toBe(0);
		expect(ledger.pendingTransfers).toBe(0);
	});
});
