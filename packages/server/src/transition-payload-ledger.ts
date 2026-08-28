import {
	isSessionAttachmentRefDto,
	isSessionContentRefDto,
	type SessionAttachmentRefDto,
} from "@pi-agent-web/protocol";
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
	readonly serverEpoch: string;
	readonly maxPhysicalBytes: number;
	readonly maxPhysicalItems: number;
	readonly maxHeldItems: number;
	readonly maxLogicalBytes: number;
}

export interface TransitionPayloadLedgerAdmission<
	TRef extends EpochStoredContentRef = SessionAttachmentRefDto,
> {
	readonly transfer: PiPayloadLeaseTransfer<TRef> | null;
	readonly logicalBytes: number;
}

type EntryState = "pending" | "adopted" | "released";

interface LedgerEntry<TRef extends EpochStoredContentRef> {
	readonly transfer: PiPayloadLeaseTransfer<TRef>;
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
 * Physical refs deduplicate for cache accounting, while every admitted transfer
 * remains under exact cleanup custody and every logical occurrence is charged.
 */
export class TransitionPayloadLedger<TRef extends EpochStoredContentRef = SessionAttachmentRefDto> {
	private readonly serverEpoch: string;
	private readonly maxPhysicalBytes: number;
	private readonly maxPhysicalItems: number;
	private readonly maxHeldItems: number;
	private readonly maxLogicalBytes: number;
	private readonly entries: LedgerEntry<TRef>[] = [];
	private readonly seenTransfers = new Set<PiPayloadLeaseTransfer<TRef>>();
	private readonly physicalRefs = new Map<string, EpochStoredContentRef>();
	private currentState: TransitionPayloadLedgerState = "open";
	private currentPhysicalBytes = 0;
	private currentPhysicalItems = 0;
	private currentHeldItems = 0;
	private currentLogicalBytes = 0;
	private adoptedCount = 0;
	private releasePromise: Promise<void> | null = null;

	constructor(options: TransitionPayloadLedgerOptions) {
		if (
			!options ||
			typeof options.serverEpoch !== "string" ||
			options.serverEpoch.length === 0 ||
			!isLimit(options.maxPhysicalBytes) ||
			!isLimit(options.maxPhysicalItems) ||
			!isLimit(options.maxHeldItems) ||
			!isLimit(options.maxLogicalBytes)
		) {
			throw new TransitionPayloadLedgerError("transition payload ledger options are invalid");
		}
		this.serverEpoch = options.serverEpoch;
		this.maxPhysicalBytes = options.maxPhysicalBytes;
		this.maxPhysicalItems = options.maxPhysicalItems;
		this.maxHeldItems = options.maxHeldItems;
		this.maxLogicalBytes = options.maxLogicalBytes;
	}

	get state(): TransitionPayloadLedgerState {
		return this.currentState;
	}

	get physicalBytes(): number {
		return this.currentPhysicalBytes;
	}

	get physicalItems(): number {
		return this.currentPhysicalItems;
	}

	get heldItems(): number {
		return this.currentHeldItems;
	}

	get logicalBytes(): number {
		return this.currentLogicalBytes;
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

	/** Takes exclusive cleanup responsibility only after every independent preflight passes. */
	admit(input: TransitionPayloadLedgerAdmission<TRef>): void {
		if (this.currentState !== "open") {
			throw new TransitionPayloadLedgerError("transition payload ledger is already consumed");
		}
		if (!input || !isLimit(input.logicalBytes) || (input.transfer !== null && !isTransfer(input.transfer))) {
			throw new TransitionPayloadLedgerError("transition payload ledger admission is invalid");
		}
		const { transfer, logicalBytes } = input;
		if (transfer && this.seenTransfers.has(transfer)) {
			throw new TransitionPayloadLedgerError("transition payload transfer was already admitted");
		}
		const nextLogicalBytes = safeAdd(this.currentLogicalBytes, logicalBytes);
		if (nextLogicalBytes > this.maxLogicalBytes) {
			throw new TransitionPayloadLedgerError("transition payload ledger logical byte limit exceeded");
		}
		if (!transfer) {
			this.currentLogicalBytes = nextLogicalBytes;
			return;
		}

		const stagedPhysicalRefs = new Map<string, EpochStoredContentRef>();
		let addedPhysicalBytes = 0;
		let addedPhysicalItems = 0;
		for (const candidate of transfer.refs) {
			if (!isStoredContentRef(candidate)) {
				throw new TransitionPayloadLedgerError("transition payload reference is invalid");
			}
			if (candidate.serverEpoch !== this.serverEpoch) {
				throw new TransitionPayloadLedgerError("transition payload reference epoch is invalid");
			}
			const key = contentKey(candidate);
			const existing = this.physicalRefs.get(key) ?? stagedPhysicalRefs.get(key);
			if (existing) {
				if (!refsEqual(existing, candidate)) {
					throw new TransitionPayloadLedgerError("transition payload digest metadata collision");
				}
				continue;
			}
			stagedPhysicalRefs.set(key, candidate);
			addedPhysicalBytes = safeAdd(addedPhysicalBytes, candidate.byteLength);
			addedPhysicalItems = safeAdd(addedPhysicalItems, 1);
		}

		const nextPhysicalBytes = safeAdd(this.currentPhysicalBytes, addedPhysicalBytes);
		const nextPhysicalItems = safeAdd(this.currentPhysicalItems, addedPhysicalItems);
		const nextHeldItems = safeAdd(this.currentHeldItems, transfer.refs.length);
		if (nextPhysicalBytes > this.maxPhysicalBytes) {
			throw new TransitionPayloadLedgerError("transition payload ledger physical byte limit exceeded");
		}
		if (nextPhysicalItems > this.maxPhysicalItems) {
			throw new TransitionPayloadLedgerError("transition payload ledger physical item limit exceeded");
		}
		if (nextHeldItems > this.maxHeldItems) {
			throw new TransitionPayloadLedgerError("transition payload ledger held item limit exceeded");
		}

		this.entries.push({ transfer, state: "pending" });
		this.seenTransfers.add(transfer);
		for (const [key, ref] of stagedPhysicalRefs) this.physicalRefs.set(key, ref);
		this.currentPhysicalBytes = nextPhysicalBytes;
		this.currentPhysicalItems = nextPhysicalItems;
		this.currentHeldItems = nextHeldItems;
		this.currentLogicalBytes = nextLogicalBytes;
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

function safeAdd(left: number, right: number): number {
	const value = left + right;
	if (!Number.isSafeInteger(value)) {
		throw new TransitionPayloadLedgerError("transition payload ledger accounting overflowed");
	}
	return value;
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

function isStoredContentRef(value: unknown): value is EpochStoredContentRef {
	return isSessionAttachmentRefDto(value) || isSessionContentRefDto(value);
}

function contentKey(ref: EpochStoredContentRef): string {
	const namespace = ref.type === "attachment_ref" ? "attachment" : "utf8";
	return `${namespace}:${ref.sha256}`;
}

function refsEqual(left: EpochStoredContentRef, right: EpochStoredContentRef): boolean {
	if (
		left.type !== right.type ||
		left.serverEpoch !== right.serverEpoch ||
		left.sha256 !== right.sha256 ||
		left.byteLength !== right.byteLength
	) {
		return false;
	}
	if (left.type === "attachment_ref" && right.type === "attachment_ref") {
		return left.mediaType === right.mediaType;
	}
	return left.type === "content_ref" && right.type === "content_ref" && left.encoding === right.encoding;
}
