import type { SessionAttachmentRefDto } from "@pi-agent-web/protocol";
import { describe, expect, it, vi } from "vitest";
import type { EpochContentHold } from "../src/epoch-content-store.js";
import { GenerationContentOwner, GenerationContentOwnerError } from "../src/generation-content-owner.js";
import type { PiPayloadLeaseTransfer } from "../src/pi-payload-externalizer.js";

const SERVER_EPOCH = "epoch-a";

function ref(sha256: string, overrides: Partial<SessionAttachmentRefDto> = {}): SessionAttachmentRefDto {
	return Object.freeze({
		type: "attachment_ref",
		serverEpoch: SERVER_EPOCH,
		sha256,
		mediaType: "image/png",
		byteLength: 4,
		...overrides,
	});
}

function hold(value: SessionAttachmentRefDto): EpochContentHold {
	return Object.freeze({ ref: value });
}

function transfer(
	holds: readonly EpochContentHold[],
	options: {
		refs?: readonly SessionAttachmentRefDto[];
		beforeAccept?: () => void;
		onAccepted?: () => void;
		skipAccept?: boolean;
	} = {},
): PiPayloadLeaseTransfer {
	let state: "pending" | "adopted" | "released" = "pending";
	return Object.freeze({
		refs: Object.freeze([...(options.refs ?? holds.map((entry) => entry.ref))]),
		adopt(accept: Parameters<PiPayloadLeaseTransfer["adopt"]>[0]) {
			if (state !== "pending") throw new Error("not pending");
			options.beforeAccept?.();
			if (options.skipAccept) return;
			if (accept(holds) !== true) throw new Error("callback returned false");
			options.onAccepted?.();
			state = "adopted";
		},
		async release() {
			if (state === "adopted") return;
			state = "released";
		},
	});
}

describe("GenerationContentOwner", () => {
	it("atomically adopts exact unique holds and releases them in reverse order", async () => {
		const released: EpochContentHold[] = [];
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 7,
			release: async (entry) => {
				released.push(entry);
			},
		});
		const first = hold(ref("a".repeat(64)));
		const second = hold(ref("b".repeat(64)));

		owner.adopt(transfer([first, second]));
		expect(owner.refs).toEqual([first.ref, second.ref]);
		expect(owner.size).toBe(2);

		const releasing = owner.release();
		expect(owner.release()).toBe(releasing);
		expect(owner.size).toBe(0);
		expect(owner.refs).toEqual([]);
		await releasing;
		expect(released).toEqual([second, first]);
		await expect(owner.release()).resolves.toBeUndefined();
		expect(released).toEqual([second, first]);
	});

	it("deduplicates exact refs within and across transfers while awaiting duplicate cleanup", async () => {
		let releaseGateResolve!: () => void;
		const releaseGate = new Promise<void>((resolve) => {
			releaseGateResolve = resolve;
		});
		const released: EpochContentHold[] = [];
		const release = vi.fn(async (entry: EpochContentHold) => {
			released.push(entry);
			if (released.length === 1) await releaseGate;
		});
		const owner = new GenerationContentOwner({ serverEpoch: SERVER_EPOCH, generation: 2, release });
		const exact = ref("c".repeat(64));
		const retained = hold(exact);
		const sameTransferDuplicate = hold(exact);
		const crossTransferDuplicate = hold(exact);

		owner.adopt(transfer([retained, sameTransferDuplicate]));
		owner.adopt(transfer([crossTransferDuplicate]));
		expect(owner.size).toBe(1);
		expect(owner.refs).toEqual([exact]);

		const releasing = owner.release();
		await Promise.resolve();
		expect(release).toHaveBeenCalledWith(sameTransferDuplicate);
		expect(releasing).not.toBe(releaseGate);
		releaseGateResolve();
		await releasing;
		expect(released).toEqual([sameTransferDuplicate, crossTransferDuplicate, retained]);
	});

	it("starts later duplicate releases without waiting for an unrelated pending cleanup", async () => {
		let unblockFirst!: () => void;
		const firstPending = new Promise<void>((resolve) => {
			unblockFirst = resolve;
		});
		const released: EpochContentHold[] = [];
		let firstDuplicate: EpochContentHold | undefined;
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 2,
			release: async (entry) => {
				released.push(entry);
				if (entry === firstDuplicate) await firstPending;
			},
		});
		const firstRef = ref("d".repeat(64));
		const secondRef = ref("e".repeat(64));
		const thirdRef = ref("f".repeat(64));
		const firstPrimary = hold(firstRef);
		firstDuplicate = hold(firstRef);
		const secondPrimary = hold(secondRef);
		const secondDuplicate = hold(secondRef);
		const thirdPrimary = hold(thirdRef);
		const thirdDuplicate = hold(thirdRef);

		owner.adopt(transfer([firstPrimary, firstDuplicate]));
		await Promise.resolve();
		owner.adopt(transfer([secondPrimary, secondDuplicate]));
		owner.adopt(transfer([thirdPrimary, thirdDuplicate]));
		await Promise.resolve();

		expect(released).toContain(firstDuplicate);
		expect(released).toContain(secondDuplicate);
		expect(released).toContain(thirdDuplicate);
		unblockFirst();
		await owner.release();
		expect(released).toEqual(expect.arrayContaining([firstPrimary, secondPrimary, thirdPrimary]));
	});

	it("registers ownership before the trusted transfer observes literal acceptance", () => {
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 1,
			release: async () => {},
		});
		const candidate = hold(ref("d".repeat(64)));

		owner.adopt(
			transfer([candidate], {
				onAccepted: () => {
					expect(owner.refs).toEqual([candidate.ref]);
				},
			}),
		);
		expect(owner.size).toBe(1);
	});

	it("rejects a transfer that skips its callback without mutating ownership", () => {
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 1,
			release: async () => {},
		});
		expect(() => owner.adopt(transfer([hold(ref("9".repeat(64)))], { skipAccept: true }))).toThrow(
			GenerationContentOwnerError,
		);
		expect(owner.size).toBe(0);
	});

	it.each([
		{
			name: "foreign epoch",
			holds: [hold(ref("e".repeat(64), { serverEpoch: "epoch-b" }))],
		},
		{
			name: "ref and hold mismatch",
			holds: [hold(ref("f".repeat(64)))],
			refs: [ref("0".repeat(64))],
		},
	])("rejects $name without partial registration", ({ holds, refs }) => {
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 4,
			release: async () => {},
		});
		expect(() => owner.adopt(transfer(holds, { refs }))).toThrow(GenerationContentOwnerError);
		expect(owner.size).toBe(0);
	});

	it("rejects digest metadata collisions without disturbing the retained exact hold", async () => {
		const release = vi.fn(async () => {});
		const owner = new GenerationContentOwner({ serverEpoch: SERVER_EPOCH, generation: 5, release });
		const digest = "1".repeat(64);
		const retained = hold(ref(digest));
		owner.adopt(transfer([retained]));

		expect(() =>
			owner.adopt(transfer([hold(ref(digest, { mediaType: "image/jpeg", byteLength: 5 }))])),
		).toThrow(GenerationContentOwnerError);
		expect(owner.refs).toEqual([retained.ref]);
		await owner.release();
		expect(release).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledWith(retained);
	});

	it("preflights a mixed transfer without registering its valid prefix", () => {
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 5,
			release: async () => {},
		});
		const valid = hold(ref("6".repeat(64)));
		const mismatched = hold(ref("7".repeat(64)));
		expect(() =>
			owner.adopt(transfer([valid, mismatched], { refs: [valid.ref, ref("8".repeat(64))] })),
		).toThrow(GenerationContentOwnerError);
		expect(owner.size).toBe(0);
	});

	it("rejects reentrant adoption and release while a transfer callback is active", async () => {
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 6,
			release: async () => {},
		});
		const nested = transfer([hold(ref("2".repeat(64)))]);
		let releaseError: unknown;
		owner.adopt(
			transfer([hold(ref("3".repeat(64)))], {
				beforeAccept: () => {
					expect(() => owner.adopt(nested)).toThrow(GenerationContentOwnerError);
					try {
						void owner.release();
					} catch (error) {
						releaseError = error;
					}
				},
			}),
		);
		expect(releaseError).toBeInstanceOf(GenerationContentOwnerError);
		await owner.release();
	});

	it("poisons on duplicate cleanup failure and retains the hold for release retry", async () => {
		const exact = ref("4".repeat(64));
		const retained = hold(exact);
		const duplicate = hold(exact);
		const released: EpochContentHold[] = [];
		let duplicateAttempts = 0;
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 8,
			release: async (entry) => {
				released.push(entry);
				if (entry === duplicate && duplicateAttempts++ === 0) {
					throw new Error("duplicate release failed");
				}
			},
		});
		owner.adopt(transfer([retained, duplicate]));
		await expect(owner.fatalCleanup).rejects.toThrow("duplicate release failed");
		expect(() => owner.adopt(transfer([hold(ref("5".repeat(64)))]))).toThrow(GenerationContentOwnerError);

		const releasing = owner.release();
		expect(() => owner.adopt(transfer([hold(ref("0".repeat(64)))]))).toThrow(GenerationContentOwnerError);
		await releasing;
		expect(released).toEqual([duplicate, duplicate, retained]);
		await expect(owner.release()).resolves.toBeUndefined();
	});

	it("retains primary release failures and retries them on a later release call", async () => {
		const retained = hold(ref("a".repeat(64)));
		let attempts = 0;
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 9,
			release: async () => {
				if (attempts++ === 0) throw new Error("primary release failed");
			},
		});
		owner.adopt(transfer([retained]));
		await expect(owner.release()).rejects.toThrow("generation content release failed");
		expect(() => owner.adopt(transfer([]))).toThrow(GenerationContentOwnerError);
		await expect(owner.release()).resolves.toBeUndefined();
		expect(attempts).toBe(2);
	});

	it("accepts an empty trusted transfer as a no-op", async () => {
		const release = vi.fn(async () => {});
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 10,
			release,
		});
		owner.adopt(transfer([]));
		expect(owner.size).toBe(0);
		await owner.release();
		expect(release).not.toHaveBeenCalled();
	});

	it("seals adoption idempotently while retaining existing holds until release", async () => {
		const released: EpochContentHold[] = [];
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 11,
			release: async (entry) => {
				released.push(entry);
			},
		});
		const retained = hold(ref("b".repeat(64)));
		owner.adopt(transfer([retained]));

		owner.seal();
		owner.seal();

		expect(owner.refs).toEqual([retained.ref]);
		expect(owner.size).toBe(1);
		expect(() => owner.adopt(transfer([hold(ref("c".repeat(64)))]))).toThrow(GenerationContentOwnerError);
		expect(released).toEqual([]);

		await owner.release();
		expect(released).toEqual([retained]);
	});

	it("rejects sealing while an adoption callback is active", async () => {
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 12,
			release: async () => {},
		});
		let sealError: unknown;
		owner.adopt(
			transfer([hold(ref("d".repeat(64)))], {
				beforeAccept: () => {
					try {
						owner.seal();
					} catch (error) {
						sealError = error;
					}
				},
			}),
		);

		expect(sealError).toBeInstanceOf(GenerationContentOwnerError);
		owner.seal();
		await owner.release();
	});

	it("rejects sealing an owner that duplicate cleanup already poisoned", async () => {
		const exact = ref("e".repeat(64));
		const retained = hold(exact);
		const duplicate = hold(exact);
		let attempts = 0;
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 13,
			release: async (entry) => {
				if (entry === duplicate && attempts++ === 0) throw new Error("fixture duplicate cleanup failed");
			},
		});
		owner.adopt(transfer([retained, duplicate]));
		await expect(owner.fatalCleanup).rejects.toThrow("fixture duplicate cleanup failed");

		expect(() => owner.seal()).toThrow(GenerationContentOwnerError);
		await owner.release();
	});

	it("rejects sealing while release is pending or after the owner closed", async () => {
		let finishRelease!: () => void;
		const releaseGate = new Promise<void>((resolve) => {
			finishRelease = resolve;
		});
		const owner = new GenerationContentOwner({
			serverEpoch: SERVER_EPOCH,
			generation: 14,
			release: async () => releaseGate,
		});
		owner.adopt(transfer([hold(ref("f".repeat(64)))]));

		const releasing = owner.release();
		expect(() => owner.seal()).toThrow(GenerationContentOwnerError);
		finishRelease();
		await releasing;
		expect(() => owner.seal()).toThrow(GenerationContentOwnerError);
	});
});
