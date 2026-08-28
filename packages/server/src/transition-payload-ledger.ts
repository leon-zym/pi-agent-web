import type { SessionAttachmentRefDto } from "@pi-agent-web/protocol";
import type { EpochStoredContentRef } from "./epoch-content-store.js";
import { GenerationContentOwner } from "./generation-content-owner.js";
import type { PiPayloadLeaseTransfer } from "./pi-payload-externalizer.js";

export type TransitionPayloadLedgerState =
	| "open"
	| "draining"
	| "drained"
	| "drain_failed"
	| "releasing"
	| "released"
	| "release_failed";

export interface TransitionPayloadLedgerOptions {
	maxBytes: number;
	maxHoldItems: number;
}

export interface TransitionPayloadLedgerAppend<TRef extends EpochStoredContentRef = SessionAttachmentRefDto> {
	transfer: PiPayloadLeaseTransfer<TRef>;
	bytes: number;
}

type EntryState = "pending" | "adopted" | "released";

interface LedgerEntry<TRef extends EpochStoredContentRef> {
	readonly transfer: PiPayloadLeaseTransfer<TRef>;
	readonly bytes: number;
	readonly holdItems: number;
	state: EntryState;
}

export class TransitionPayloadLedgerError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "TransitionPayloadLedgerError";
	}
}

/**
 * Owns undecided Pi payload transfers until one transition outcome routes them
 * into an exact generation owner or releases every still-unassigned transfer.
 */
export class TransitionPayloadLedger<TRef extends EpochStoredContentRef = SessionAttachmentRefDto> {
	private readonly maxBytes: number;
	private readonly maxHoldItems: number;
	private readonly entries: LedgerEntry<TRef>[] = [];
	private readonly seenTransfers = new Set<PiPayloadLeaseTransfer<TRef>>();
	private currentState: TransitionPayloadLedgerState = "open";
	private currentBytes = 0;
	private currentHoldItems = 0;
	private adoptedCount = 0;
	private releasePromise: Promise<void> | null = null;

	constructor(options: TransitionPayloadLedgerOptions) {
		if (!options || !isLimit(options.maxBytes) || !isLimit(options.maxHoldItems)) {
			throw new TransitionPayloadLedgerError("transition payload ledger options are invalid");
		}
		this.maxBytes = options.maxBytes;
		this.maxHoldItems = options.maxHoldItems;
	}

	get state(): TransitionPayloadLedgerState {
		return this.currentState;
	}

	get bytes(): number {
		return this.currentBytes;
	}

	get holdItems(): number {
		return this.currentHoldItems;
	}

	get pendingTransfers(): number {
		let pending = 0;
		for (const entry of this.entries) {
			if (entry.state === "pending") pending += 1;
		}
		return pending;
	}

	get adoptedTransfers(): number {
		return this.adoptedCount;
	}

	/** Takes exclusive cleanup responsibility only after all accounting preflights pass. */
	append(input: TransitionPayloadLedgerAppend<TRef>): void {
		if (this.currentState !== "open") {
			throw new TransitionPayloadLedgerError("transition payload ledger is already consumed");
		}
		const { transfer, bytes } = input ?? {};
		if (!isTransfer(transfer) || !isLimit(bytes)) {
			throw new TransitionPayloadLedgerError("transition payload ledger append is invalid");
		}
		if (this.seenTransfers.has(transfer)) {
			throw new TransitionPayloadLedgerError("transition payload transfer was already appended");
		}
		const holdItems = transfer.refs.length;
		const nextBytes = this.currentBytes + bytes;
		const nextHoldItems = this.currentHoldItems + holdItems;
		if (!Number.isSafeInteger(nextBytes) || nextBytes > this.maxBytes) {
			throw new TransitionPayloadLedgerError("transition payload ledger byte limit exceeded");
		}
		if (!Number.isSafeInteger(nextHoldItems) || nextHoldItems > this.maxHoldItems) {
			throw new TransitionPayloadLedgerError("transition payload ledger hold item limit exceeded");
		}

		this.entries.push({ transfer, bytes, holdItems, state: "pending" });
		this.seenTransfers.add(transfer);
		this.currentBytes = nextBytes;
		this.currentHoldItems = nextHoldItems;
	}

	/** One-shot synchronous routing. A failed suffix remains owned only for releaseRemaining(). */
	drainTo(owner: GenerationContentOwner<TRef>): void {
		if (this.currentState !== "open") {
			throw new TransitionPayloadLedgerError("transition payload ledger is already consumed");
		}
		if (!(owner instanceof GenerationContentOwner)) {
			throw new TransitionPayloadLedgerError("transition payload ledger owner is invalid");
		}
		this.currentState = "draining";
		for (const entry of this.entries) {
			if (entry.state !== "pending") continue;
			try {
				owner.adopt(entry.transfer);
				entry.state = "adopted";
				this.adoptedCount += 1;
			} catch (error) {
				this.currentState = "drain_failed";
				throw new TransitionPayloadLedgerError("transition payload ledger drain failed", { cause: error });
			}
		}
		this.currentState = "drained";
	}

	/**
	 * One-shot terminal cleanup. Every pending release starts immediately; failures
	 * are aggregated because a transfer cannot be submitted or released again.
	 */
	releaseRemaining(): Promise<void> {
		if (this.releasePromise) return this.releasePromise;
		if (this.currentState === "drained" || this.currentState === "released") {
			this.releasePromise = Promise.resolve();
			return this.releasePromise;
		}
		if (this.currentState !== "open" && this.currentState !== "drain_failed") {
			throw new TransitionPayloadLedgerError("transition payload ledger is already consumed");
		}

		this.currentState = "releasing";
		const attempts: Promise<void>[] = [];
		for (const entry of this.entries) {
			if (entry.state !== "pending") continue;
			entry.state = "released";
			try {
				attempts.push(Promise.resolve(entry.transfer.release()));
			} catch (error) {
				attempts.push(Promise.reject(error));
			}
		}
		const cleanup = Promise.allSettled(attempts).then((results) => {
			const failures = results
				.filter((result): result is PromiseRejectedResult => result.status === "rejected")
				.map((result) => result.reason);
			if (failures.length > 0) {
				this.currentState = "release_failed";
				throw new TransitionPayloadLedgerError("transition payload ledger release failed", {
					cause: new AggregateError(failures),
				});
			}
			this.currentState = "released";
		});
		this.releasePromise = cleanup;
		return cleanup;
	}
}

function isLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTransfer(value: unknown): value is PiPayloadLeaseTransfer<EpochStoredContentRef> {
	return (
		typeof value === "object" &&
		value !== null &&
		"refs" in value &&
		Array.isArray(value.refs) &&
		"adopt" in value &&
		typeof value.adopt === "function" &&
		"release" in value &&
		typeof value.release === "function"
	);
}
