import type { SessionAttachmentRefDto, SessionContentRefDto } from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import type { EpochContentHold, EpochStoredContentRef } from "../src/epoch-content-store.js";
import { GenerationContentOwner } from "../src/generation-content-owner.js";
import type { PiPayloadLeaseTransfer } from "../src/pi-payload-externalizer.js";
import { TransitionPayloadLedger, TransitionPayloadLedgerError } from "../src/transition-payload-ledger.js";

const SERVER_EPOCH = "transition-ledger-epoch";

const ledgerLimits = {
	serverEpoch: SERVER_EPOCH,
	maxPhysicalBytes: 100,
	maxPhysicalItems: 4,
	maxHeldItems: 4,
	maxLogicalBytes: 100,
};

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
	options: { adoptError?: Error; releaseError?: Error } = {},
): PiPayloadLeaseTransfer {
	const holds = Object.freeze(refs.map((candidate) => Object.freeze({ ref: candidate })));
	let state: "pending" | "adopted" | "releasing" | "released" = "pending";
	let releasePromise: Promise<void> | null = null;
	return Object.freeze({
		refs: Object.freeze([...refs]),
		adopt(accept: Parameters<PiPayloadLeaseTransfer["adopt"]>[0]) {
			if (state !== "pending") throw new Error("test transfer is not pending");
			if (options.adoptError) throw options.adoptError;
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
	it("deduplicates physical bytes by namespace and digest while retaining every hold", async () => {
		const digest = "0".repeat(64);
		const firstTracking = { adopted: 0, released: 0 };
		const duplicateTracking = { adopted: 0, released: 0 };
		const mixed = trackedStoredTransfer<EpochStoredContentRef>(
			[ref(digest), contentRef(digest)],
			firstTracking,
		);
		const duplicateUtf8 = trackedStoredTransfer([contentRef(digest)], duplicateTracking);
		const ledger = new TransitionPayloadLedger<EpochStoredContentRef>({
			...ledgerLimits,
			maxPhysicalBytes: 8,
			maxPhysicalItems: 2,
			maxHeldItems: 3,
		});
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const target = new GenerationContentOwner<EpochStoredContentRef>({
			serverEpoch: SERVER_EPOCH,
			generation: 2,
			release: async (entry) => {
				released.push(entry);
			},
		});

		ledger.admit({ transfer: mixed, logicalBytes: 20 });
		ledger.admit({ transfer: duplicateUtf8, logicalBytes: 30 });
		expect(ledger.physicalBytes).toBe(8);
		expect(ledger.physicalItems).toBe(2);
		expect(ledger.heldItems).toBe(3);
		expect(ledger.logicalBytes).toBe(50);

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

	it("enforces independent physical-byte and held-item ceilings before taking custody", async () => {
		const ledger = new TransitionPayloadLedger({
			...ledgerLimits,
			maxPhysicalBytes: 7,
			maxHeldItems: 2,
		});
		const firstTracking = { adopted: 0, released: 0 };
		const byteOverflowTracking = { adopted: 0, released: 0 };
		const itemOverflowTracking = { adopted: 0, released: 0 };
		const first = trackedTransfer([ref("a".repeat(64))], firstTracking);
		const byteOverflow = trackedTransfer([ref("b".repeat(64))], byteOverflowTracking);
		const itemOverflow = trackedTransfer([ref("a".repeat(64)), ref("a".repeat(64))], itemOverflowTracking);

		ledger.admit({ transfer: first, logicalBytes: 6 });
		expect(() => ledger.admit({ transfer: byteOverflow, logicalBytes: 5 })).toThrow(/physical byte/i);
		expect(() => ledger.admit({ transfer: itemOverflow, logicalBytes: 4 })).toThrow(/held item/i);
		expect(ledger.physicalBytes).toBe(4);
		expect(ledger.physicalItems).toBe(1);
		expect(ledger.heldItems).toBe(1);
		expect(ledger.logicalBytes).toBe(6);
		expect(ledger.pendingTransfers).toBe(1);

		await ledger.releaseRemaining();
		expect(firstTracking).toEqual({ adopted: 0, released: 1 });
		expect(byteOverflowTracking).toEqual({ adopted: 0, released: 0 });
		expect(itemOverflowTracking).toEqual({ adopted: 0, released: 0 });
		await Promise.all([byteOverflow.release(), itemOverflow.release()]);
	});

	it("rejects duplicate admission without consuming the transfer twice", async () => {
		const ledger = new TransitionPayloadLedger(ledgerLimits);
		const tracking = { adopted: 0, released: 0 };
		const candidate = trackedTransfer([ref("e".repeat(64))], tracking);

		ledger.admit({ transfer: candidate, logicalBytes: 10 });
		expect(() => ledger.admit({ transfer: candidate, logicalBytes: 10 })).toThrow(/already admitted/i);
		expect(ledger.logicalBytes).toBe(10);
		await ledger.releaseRemaining();
		expect(tracking).toEqual({ adopted: 0, released: 1 });
	});

	it("drains every transfer exactly once and delegates digest deduplication to the owner", async () => {
		const ownerReleased: EpochContentHold[] = [];
		const target = owner(ownerReleased);
		const ledger = new TransitionPayloadLedger(ledgerLimits);
		const exact = ref("f".repeat(64));
		const firstTracking = { adopted: 0, released: 0 };
		const duplicateTracking = { adopted: 0, released: 0 };
		ledger.admit({ transfer: trackedTransfer([exact], firstTracking), logicalBytes: 20 });
		ledger.admit({ transfer: trackedTransfer([exact], duplicateTracking), logicalBytes: 20 });
		expect(ledger.physicalBytes).toBe(4);
		expect(ledger.physicalItems).toBe(1);
		expect(ledger.heldItems).toBe(2);
		expect(ledger.logicalBytes).toBe(40);

		ledger.drainTo(target);

		expect(ledger.state).toBe("drained");
		expect(ledger.pendingTransfers).toBe(0);
		expect(ledger.adoptedTransfers).toBe(2);
		expect(target.size).toBe(1);
		expect(firstTracking.adopted).toBe(1);
		expect(duplicateTracking.adopted).toBe(1);
		expect(() => ledger.drainTo(target)).toThrow(TransitionPayloadLedgerError);
		expect(() =>
			ledger.admit({
				transfer: trackedTransfer([ref("0".repeat(64))], { adopted: 0, released: 0 }),
				logicalBytes: 1,
			}),
		).toThrow(TransitionPayloadLedgerError);
		await expect(ledger.releaseRemaining()).resolves.toBeUndefined();
		await target.release();
		expect(ownerReleased).toHaveLength(2);
	});

	it("exposes a partial drain failure and only releases transfers that were not adopted", async () => {
		const target = owner();
		const ledger = new TransitionPayloadLedger(ledgerLimits);
		const firstTracking = { adopted: 0, released: 0 };
		const invalidTracking = { adopted: 0, released: 0 };
		const tailTracking = { adopted: 0, released: 0 };
		ledger.admit({ transfer: trackedTransfer([ref("1".repeat(64))], firstTracking), logicalBytes: 10 });
		ledger.admit({
			transfer: trackedTransfer([ref("2".repeat(64))], invalidTracking, {
				adoptError: new Error("fixture adoption failed"),
			}),
			logicalBytes: 10,
		});
		ledger.admit({ transfer: trackedTransfer([ref("3".repeat(64))], tailTracking), logicalBytes: 10 });

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
		const ledger = new TransitionPayloadLedger(ledgerLimits);
		const failedTracking = { adopted: 0, released: 0 };
		const healthyTracking = { adopted: 0, released: 0 };
		ledger.admit({
			transfer: trackedTransfer([ref("4".repeat(64))], failedTracking, {
				releaseError: new Error("fixture release failed"),
			}),
			logicalBytes: 10,
		});
		ledger.admit({ transfer: trackedTransfer([ref("5".repeat(64))], healthyTracking), logicalBytes: 10 });

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

	it("validates options and admission accounting without mutation", () => {
		expect(() => new TransitionPayloadLedger({ ...ledgerLimits, maxPhysicalBytes: -1 })).toThrow(
			TransitionPayloadLedgerError,
		);
		const ledger = new TransitionPayloadLedger({ ...ledgerLimits, maxHeldItems: 1 });
		const tracking = { adopted: 0, released: 0 };
		const candidate = trackedTransfer([ref("6".repeat(64))], tracking);

		expect(() => ledger.admit({ transfer: candidate, logicalBytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
			TransitionPayloadLedgerError,
		);
		expect(ledger.physicalBytes).toBe(0);
		expect(ledger.physicalItems).toBe(0);
		expect(ledger.heldItems).toBe(0);
		expect(ledger.logicalBytes).toBe(0);
		expect(ledger.pendingTransfers).toBe(0);
	});

	it("accounts inline logical payloads without requiring a transfer", () => {
		const ledger = new TransitionPayloadLedger({ ...ledgerLimits, maxLogicalBytes: 10 });

		ledger.admit({ transfer: null, logicalBytes: 6 });
		expect(ledger.logicalBytes).toBe(6);
		expect(ledger.physicalBytes).toBe(0);
		expect(ledger.physicalItems).toBe(0);
		expect(ledger.heldItems).toBe(0);
		expect(ledger.pendingTransfers).toBe(0);
		expect(() => ledger.admit({ transfer: null, logicalBytes: 5 })).toThrow(/logical byte/i);
		expect(ledger.logicalBytes).toBe(6);
	});

	it("rejects physical-item overflow even when byte and hold limits have room", async () => {
		const ledger = new TransitionPayloadLedger({ ...ledgerLimits, maxPhysicalItems: 1 });
		const firstTracking = { adopted: 0, released: 0 };
		const overflowTracking = { adopted: 0, released: 0 };
		const first = trackedTransfer([ref("7".repeat(64))], firstTracking);
		const overflow = trackedTransfer([ref("8".repeat(64))], overflowTracking);

		ledger.admit({ transfer: first, logicalBytes: 1 });
		expect(() => ledger.admit({ transfer: overflow, logicalBytes: 1 })).toThrow(/physical item/i);
		expect(ledger.physicalItems).toBe(1);
		expect(ledger.heldItems).toBe(1);
		expect(ledger.logicalBytes).toBe(1);
		await ledger.releaseRemaining();
		await overflow.release();
		expect(firstTracking.released).toBe(1);
		expect(overflowTracking.released).toBe(1);
	});

	it("rejects foreign epochs and digest metadata collisions without taking custody", async () => {
		const ledger = new TransitionPayloadLedger(ledgerLimits);
		const firstTracking = { adopted: 0, released: 0 };
		const collisionTracking = { adopted: 0, released: 0 };
		const foreignTracking = { adopted: 0, released: 0 };
		const digest = "9".repeat(64);
		const first = trackedTransfer([ref(digest)], firstTracking);
		const collisionRef: SessionAttachmentRefDto = Object.freeze({
			...ref(digest),
			mediaType: "image/jpeg",
		});
		const collision = trackedTransfer([collisionRef], collisionTracking);
		const foreign = trackedTransfer([ref("a".repeat(64), "foreign-epoch")], foreignTracking);

		ledger.admit({ transfer: first, logicalBytes: 10 });
		expect(() => ledger.admit({ transfer: collision, logicalBytes: 10 })).toThrow(/metadata collision/i);
		expect(() => ledger.admit({ transfer: foreign, logicalBytes: 10 })).toThrow(/epoch/i);
		expect(ledger.physicalBytes).toBe(4);
		expect(ledger.physicalItems).toBe(1);
		expect(ledger.heldItems).toBe(1);
		expect(ledger.logicalBytes).toBe(10);
		expect(ledger.pendingTransfers).toBe(1);

		await ledger.releaseRemaining();
		await Promise.all([collision.release(), foreign.release()]);
		expect(firstTracking.released).toBe(1);
		expect(collisionTracking.released).toBe(1);
		expect(foreignTracking.released).toBe(1);
	});
});
