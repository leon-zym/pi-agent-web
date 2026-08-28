import {
	isSessionAttachmentRefDto,
	isSessionContentRefDto,
	type SessionAttachmentRefDto,
} from "@pi-agent-web/protocol";
import type { EpochContentHold, EpochStoredContentRef } from "./epoch-content-store.js";
import type { PiPayloadLeaseTransfer } from "./pi-payload-externalizer.js";

type OwnerState = "active" | "adopting" | "sealed" | "poisoned" | "closing" | "closed";

interface OwnedContent<TRef extends EpochStoredContentRef> {
	ref: TRef;
	hold: EpochContentHold<TRef>;
}

export interface GenerationContentOwnerOptions<TRef extends EpochStoredContentRef = SessionAttachmentRefDto> {
	serverEpoch: string;
	generation: number;
	release: (hold: EpochContentHold<TRef>) => Promise<void>;
}

export class GenerationContentOwnerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GenerationContentOwnerError";
	}
}

/** Owns every exact content hold made reachable by one Session generation. */
export class GenerationContentOwner<TRef extends EpochStoredContentRef = SessionAttachmentRefDto> {
	readonly serverEpoch: string;
	readonly generation: number;
	/** Rejects on the first asynchronous duplicate-cleanup failure. */
	readonly fatalCleanup: Promise<never>;
	private readonly releaseHold: (hold: EpochContentHold<TRef>) => Promise<void>;
	private readonly byContentKey = new Map<string, OwnedContent<TRef>>();
	private readonly primaryHolds: EpochContentHold<TRef>[] = [];
	private readonly duplicateHolds = new Set<EpochContentHold<TRef>>();
	private readonly ownedHolds = new Set<EpochContentHold<TRef>>();
	private readonly duplicateCleanupInFlight = new Map<EpochContentHold<TRef>, Promise<void>>();
	private readonly rejectFatalCleanup: (reason: unknown) => void;
	private state: OwnerState = "active";
	private fatalCleanupSignaled = false;
	private releasePromise: Promise<void> | null = null;
	private closedPromise: Promise<void> | null = null;

	constructor(options: GenerationContentOwnerOptions<TRef>) {
		if (
			typeof options.serverEpoch !== "string" ||
			options.serverEpoch.length === 0 ||
			!Number.isSafeInteger(options.generation) ||
			options.generation < 0 ||
			typeof options.release !== "function"
		) {
			throw new GenerationContentOwnerError("generation content owner options are invalid");
		}
		this.serverEpoch = options.serverEpoch;
		this.generation = options.generation;
		this.releaseHold = options.release;
		let rejectFatalCleanup!: (reason: unknown) => void;
		this.fatalCleanup = new Promise<never>((_resolve, reject) => {
			rejectFatalCleanup = reject;
		});
		this.rejectFatalCleanup = rejectFatalCleanup;
		// The future Runtime integration observes this promise. Avoid process-level
		// unhandled-rejection noise while the owner remains server-private.
		void this.fatalCleanup.catch(() => {});
	}

	get size(): number {
		return this.byContentKey.size;
	}

	get refs(): readonly TRef[] {
		return Object.freeze([...this.byContentKey.values()].map((entry) => entry.ref));
	}

	/** Closes adoption without releasing content that is still reachable. */
	seal(): void {
		if (this.state === "sealed") return;
		if (this.state !== "active") {
			throw new GenerationContentOwnerError("generation content owner cannot be sealed");
		}
		this.state = "sealed";
	}

	/** Atomically adopts a trusted transfer after preflighting every exact hold/reference pair. */
	adopt(transfer: PiPayloadLeaseTransfer<TRef>): void {
		this.assertActive();
		this.state = "adopting";
		let accepted = false;
		try {
			transfer.adopt((holds) => {
				if (this.state !== "adopting") {
					throw new GenerationContentOwnerError("generation content adoption state changed");
				}
				const prepared = this.prepareAdoption(transfer.refs, holds);
				// PiPayloadLeaseTransfer is a trusted server-private token. Its contract
				// requires ownership to be complete before this callback returns true.
				for (const entry of prepared.additions) {
					this.byContentKey.set(contentKey(entry.ref), entry);
					this.primaryHolds.push(entry.hold);
					this.ownedHolds.add(entry.hold);
				}
				for (const duplicate of prepared.duplicates) {
					this.duplicateHolds.add(duplicate);
					this.ownedHolds.add(duplicate);
				}
				accepted = true;
				this.state = "active";
				if (prepared.duplicates.length > 0) this.enqueueDuplicateCleanup(prepared.duplicates);
				return true;
			});
		} catch (error) {
			if (!accepted) this.state = "active";
			throw error;
		}
		if (!accepted) {
			this.state = "active";
			throw new GenerationContentOwnerError("generation content transfer skipped its adoption callback");
		}
	}

	/** Synchronously closes admission and detaches refs before releasing all retained holds. */
	release(): Promise<void> {
		if (this.state === "adopting") {
			throw new GenerationContentOwnerError("generation content adoption is in progress");
		}
		if (this.releasePromise) return this.releasePromise;
		if (this.state === "closed") {
			this.closedPromise ??= Promise.resolve();
			return this.closedPromise;
		}
		this.state = "closing";
		this.byContentKey.clear();
		const attempt = (async () => {
			await Promise.all([...this.duplicateCleanupInFlight.values()]);
			const failures: unknown[] = [];
			const duplicateAttempts = [...this.duplicateHolds].reverse().map(async (entry) => {
				try {
					await this.releaseHold(entry);
					this.duplicateHolds.delete(entry);
					this.ownedHolds.delete(entry);
				} catch (error) {
					failures.push(error);
				}
			});
			await Promise.all(duplicateAttempts);
			for (let index = this.primaryHolds.length - 1; index >= 0; index -= 1) {
				const entry = this.primaryHolds[index];
				if (!entry || !this.ownedHolds.has(entry)) continue;
				try {
					await this.releaseHold(entry);
					this.ownedHolds.delete(entry);
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, "generation content release failed");
			}
			this.primaryHolds.length = 0;
			this.state = "closed";
		})();
		this.releasePromise = attempt.finally(() => {
			this.releasePromise = null;
			if (this.state !== "closed") this.state = "poisoned";
		});
		return this.releasePromise;
	}

	private prepareAdoption(
		refs: readonly TRef[],
		holds: readonly EpochContentHold<TRef>[],
	): { additions: OwnedContent<TRef>[]; duplicates: EpochContentHold<TRef>[] } {
		if (refs.length !== holds.length) {
			throw new GenerationContentOwnerError("generation content refs and holds differ in length");
		}
		const additions: OwnedContent<TRef>[] = [];
		const duplicates: EpochContentHold<TRef>[] = [];
		const stagedByContentKey = new Map<string, OwnedContent<TRef>>();
		const seenHolds = new Set<EpochContentHold<TRef>>();
		for (let index = 0; index < refs.length; index += 1) {
			const candidateRef = refs[index];
			const candidateHold = holds[index];
			if (
				!candidateRef ||
				!candidateHold ||
				!isStoredContentRef(candidateRef) ||
				!isStoredContentRef(candidateHold.ref) ||
				candidateRef.serverEpoch !== this.serverEpoch ||
				!refsEqual(candidateRef, candidateHold.ref)
			) {
				throw new GenerationContentOwnerError("generation content ref and hold are not exact");
			}
			if (seenHolds.has(candidateHold) || this.ownedHolds.has(candidateHold)) {
				throw new GenerationContentOwnerError("generation content hold is already registered");
			}
			seenHolds.add(candidateHold);
			const key = contentKey(candidateRef);
			const existing = this.byContentKey.get(key) ?? stagedByContentKey.get(key);
			if (existing) {
				if (!refsEqual(existing.ref, candidateRef)) {
					throw new GenerationContentOwnerError("generation content digest metadata collision");
				}
				duplicates.push(candidateHold);
				continue;
			}
			const addition = { ref: candidateRef, hold: candidateHold };
			stagedByContentKey.set(key, addition);
			additions.push(addition);
		}
		return { additions, duplicates };
	}

	private enqueueDuplicateCleanup(duplicates: readonly EpochContentHold<TRef>[]): void {
		for (const entry of [...duplicates].reverse()) {
			const cleanup = this.releaseDuplicate(entry);
			this.duplicateCleanupInFlight.set(entry, cleanup);
			void cleanup.finally(() => {
				if (this.duplicateCleanupInFlight.get(entry) === cleanup) {
					this.duplicateCleanupInFlight.delete(entry);
				}
			});
		}
	}

	private async releaseDuplicate(entry: EpochContentHold<TRef>): Promise<void> {
		try {
			await this.releaseHold(entry);
			this.duplicateHolds.delete(entry);
			this.ownedHolds.delete(entry);
		} catch (error) {
			this.poison(error);
		}
	}

	private poison(error: unknown): void {
		if (this.state === "active" || this.state === "sealed") this.state = "poisoned";
		if (!this.fatalCleanupSignaled) {
			this.fatalCleanupSignaled = true;
			this.rejectFatalCleanup(error);
		}
	}

	private assertActive(): void {
		if (this.state !== "active") {
			throw new GenerationContentOwnerError("generation content owner is not active");
		}
	}
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
	return left.type === "attachment_ref"
		? right.type === "attachment_ref" && left.mediaType === right.mediaType
		: right.type === "content_ref" && left.encoding === right.encoding;
}
