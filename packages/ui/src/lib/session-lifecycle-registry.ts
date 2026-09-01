/**
 * Synchronous coordination for Session-scoped Browser state.
 *
 * This module deliberately knows nothing about Zustand, React, Pi, or Browser APIs. Owners
 * capture and prepare their own state, while the registry only orders the transaction and returns
 * typed intents for the composition layer to execute after a successful commit.
 */

export const SESSION_LIFECYCLE_OPERATIONS = ["create", "snapshot", "rekey", "dispose"] as const;
export type SessionLifecycleOperation = (typeof SESSION_LIFECYCLE_OPERATIONS)[number];

/** Product-owned state domains that must be registered before transport connect. */
export const SESSION_LIFECYCLE_OWNER_IDS = [
	"directory",
	"view",
	"composer",
	"projection",
	"model",
	"slash",
	"stats",
	"extension",
] as const;
export type SessionLifecycleOwnerId = (typeof SESSION_LIFECYCLE_OWNER_IDS)[number];

export const SESSION_LIFECYCLE_POLICIES = ["migrate", "preserve", "reset", "rebuild"] as const;
export type SessionLifecyclePolicy = (typeof SESSION_LIFECYCLE_POLICIES)[number];

/** A complete identity is retained even while a Session is still unverified. */
export interface SessionLifecycleIdentity {
	readonly serverEpoch: string | null;
	readonly workspaceId: string;
	readonly sessionHandle: string;
	readonly generation: number | null;
}

/** Effect intents are opaque to the coordinator but must carry identity and dedupe metadata. */
export interface SessionLifecycleIntent {
	readonly type: string;
	readonly identity: SessionLifecycleIdentity;
	readonly dedupeKey: string;
	readonly [key: string]: unknown;
}

export interface SessionLifecycleRequest {
	readonly operation: SessionLifecycleOperation;
	readonly identity: SessionLifecycleIdentity;
	readonly previousIdentity?: SessionLifecycleIdentity;
	readonly payload?: unknown;
	readonly effects?: readonly SessionLifecycleIntent[];
}

export interface SessionLifecycleOwnerContext extends SessionLifecycleRequest {
	readonly epoch: number;
	/** The epoch that will become visible only if every owner commits successfully. */
	readonly transactionEpoch: number;
	readonly policy: SessionLifecyclePolicy;
}

export interface SessionLifecyclePreparation {
	/** Commit only synchronous, reversible state. Irreversible effects run after the transaction. */
	readonly commit: () => void;
	/** Restore state captured during prepare. This must be safe to call after a partial commit. */
	readonly restore: () => void;
	readonly intents?: readonly SessionLifecycleIntent[];
}

export interface SessionLifecycleOwner {
	readonly id: string;
	readonly policy: Readonly<Record<SessionLifecycleOperation, SessionLifecyclePolicy>>;
	readonly prepare: (context: SessionLifecycleOwnerContext) => SessionLifecyclePreparation;
}

export type SessionLifecycleCommitFailure = {
	readonly operation: SessionLifecycleOperation;
	readonly identity: SessionLifecycleIdentity;
	readonly previousIdentity?: SessionLifecycleIdentity;
	readonly epoch: number;
	readonly transactionEpoch: number;
	readonly error: unknown;
	readonly restoredOwnerIds: readonly string[];
};

export type SessionLifecycleRejectedReason =
	| "not_ready"
	| "invalid_identity"
	| "identity_mismatch"
	| "rekey_collision"
	| "prepare_failed"
	| "commit_failed";

export class SessionLifecycleError extends Error {
	override readonly name = "SessionLifecycleError";

	constructor(
		readonly code: SessionLifecycleRejectedReason,
		message: string,
		readonly details?: Readonly<Record<string, unknown>>,
	) {
		super(message);
	}
}

export type SessionLifecycleResult =
	| {
			readonly status: "committed";
			readonly epoch: number;
			readonly effects: readonly SessionLifecycleIntent[];
	  }
	| {
			readonly status: "rejected";
			readonly epoch: number;
			readonly effects: readonly [];
			readonly error: SessionLifecycleError;
	  };

export interface SessionLifecycleRegistryOptions {
	readonly requiredOwnerIds?: readonly string[];
	readonly owners?: readonly SessionLifecycleOwner[];
	readonly batch?: (run: () => void) => void;
	readonly onCommitFailure?: (failure: SessionLifecycleCommitFailure) => void;
}

export interface SessionLifecycleRegistry {
	readonly epoch: number;
	readonly owners: readonly string[];
	readonly register: (owner: SessionLifecycleOwner) => void;
	readonly unregister: (ownerId: string) => void;
	readonly assertReady: () => void;
	readonly currentIdentity: (sessionHandle: string) => SessionLifecycleIdentity | null;
	readonly isCurrent: (identity: SessionLifecycleIdentity) => boolean;
	readonly transition: (request: SessionLifecycleRequest) => SessionLifecycleResult;
	readonly createSession: (request: Omit<SessionLifecycleRequest, "operation">) => SessionLifecycleResult;
	readonly snapshotSession: (request: Omit<SessionLifecycleRequest, "operation">) => SessionLifecycleResult;
	readonly rekeySession: (
		request: Omit<SessionLifecycleRequest, "operation"> & {
			readonly previousIdentity: SessionLifecycleIdentity;
		},
	) => SessionLifecycleResult;
	readonly disposeSession: (request: Omit<SessionLifecycleRequest, "operation">) => SessionLifecycleResult;
}

function identityKey(identity: SessionLifecycleIdentity): string {
	return JSON.stringify([
		identity.serverEpoch,
		identity.workspaceId,
		identity.sessionHandle,
		identity.generation,
	]);
}

function freezeIdentity(identity: SessionLifecycleIdentity): SessionLifecycleIdentity {
	return Object.freeze({ ...identity });
}

function sameIdentity(left: SessionLifecycleIdentity, right: SessionLifecycleIdentity): boolean {
	return identityKey(left) === identityKey(right);
}

function validIdentity(identity: SessionLifecycleIdentity): boolean {
	return (
		typeof identity === "object" &&
		identity !== null &&
		typeof identity.workspaceId === "string" &&
		identity.workspaceId.length > 0 &&
		typeof identity.sessionHandle === "string" &&
		identity.sessionHandle.length > 0 &&
		(identity.serverEpoch === null || typeof identity.serverEpoch === "string") &&
		(identity.serverEpoch === null || identity.serverEpoch.length > 0) &&
		(identity.generation === null || Number.isSafeInteger(identity.generation))
	);
}

function validPolicy(policy: unknown): policy is SessionLifecyclePolicy {
	return typeof policy === "string" && (SESSION_LIFECYCLE_POLICIES as readonly string[]).includes(policy);
}

function validIntent(intent: SessionLifecycleIntent): boolean {
	return (
		typeof intent === "object" &&
		intent !== null &&
		typeof intent.type === "string" &&
		intent.type.length > 0 &&
		typeof intent.dedupeKey === "string" &&
		intent.dedupeKey.length > 0 &&
		validIdentity(intent.identity)
	);
}

function normalizeRequest(
	operation: SessionLifecycleOperation,
	request: Omit<SessionLifecycleRequest, "operation">,
): SessionLifecycleRequest {
	return { ...request, operation };
}

export function createSessionLifecycleRegistry(
	options: SessionLifecycleRegistryOptions = {},
): SessionLifecycleRegistry {
	const requiredOwnerIds = [...(options.requiredOwnerIds ?? [])];
	const ownerById = new Map<string, SessionLifecycleOwner>();
	const identities = new Map<string, SessionLifecycleIdentity>();
	const batch = options.batch ?? ((run: () => void) => run());
	let epoch = 0;

	const registry: SessionLifecycleRegistry = {
		get epoch() {
			return epoch;
		},
		get owners() {
			return [...ownerById.keys()];
		},
		register: (owner) => {
			if (!owner || typeof owner.id !== "string" || owner.id.length === 0) {
				throw new SessionLifecycleError("not_ready", "Session lifecycle owner id is required");
			}
			if (ownerById.has(owner.id)) {
				throw new SessionLifecycleError("not_ready", `Duplicate Session lifecycle owner: ${owner.id}`, {
					ownerId: owner.id,
				});
			}
			for (const operation of SESSION_LIFECYCLE_OPERATIONS) {
				if (!validPolicy(owner.policy?.[operation])) {
					throw new SessionLifecycleError(
						"not_ready",
						`Session lifecycle owner ${owner.id} has no valid ${operation} policy`,
						{ ownerId: owner.id, operation },
					);
				}
			}
			if (typeof owner.prepare !== "function") {
				throw new SessionLifecycleError("not_ready", `Session lifecycle owner ${owner.id} cannot prepare`, {
					ownerId: owner.id,
				});
			}
			ownerById.set(owner.id, owner);
		},
		unregister: (ownerId) => {
			ownerById.delete(ownerId);
		},
		assertReady: () => {
			const missing = requiredOwnerIds.filter((ownerId) => !ownerById.has(ownerId));
			if (missing.length > 0) {
				throw new SessionLifecycleError(
					"not_ready",
					`Session lifecycle registry is missing owners: ${missing.join(", ")}`,
					{ missingOwnerIds: missing },
				);
			}
		},
		currentIdentity: (sessionHandle) => identities.get(sessionHandle) ?? null,
		isCurrent: (identity) => {
			const current = identities.get(identity.sessionHandle);
			return current ? sameIdentity(current, identity) : false;
		},
		transition: (request) => {
			try {
				registry.assertReady();
				if (!validIdentity(request.identity)) {
					throw new SessionLifecycleError("invalid_identity", "Session lifecycle identity is invalid");
				}
				if (request.previousIdentity && !validIdentity(request.previousIdentity)) {
					throw new SessionLifecycleError(
						"invalid_identity",
						"Previous Session lifecycle identity is invalid",
					);
				}
				if (
					request.operation !== "snapshot" &&
					request.operation !== "rekey" &&
					request.previousIdentity !== undefined
				) {
					throw new SessionLifecycleError(
						"invalid_identity",
						`Previous identity is only valid for snapshot or rekey, received ${request.operation}`,
					);
				}
				const current = identities.get(request.identity.sessionHandle);
				if (request.operation === "create" && current) {
					throw new SessionLifecycleError(
						"rekey_collision",
						`Session ${request.identity.sessionHandle} already has a lifecycle identity`,
						{ sessionHandle: request.identity.sessionHandle },
					);
				}
				if (
					request.operation !== "create" &&
					request.operation !== "snapshot" &&
					request.operation !== "rekey" &&
					current &&
					!sameIdentity(current, request.identity)
				) {
					throw new SessionLifecycleError(
						"identity_mismatch",
						`Session ${request.identity.sessionHandle} lifecycle identity is stale`,
						{ currentIdentity: current, receivedIdentity: request.identity },
					);
				}
				if (request.operation === "snapshot" && request.previousIdentity) {
					if (request.previousIdentity.sessionHandle !== request.identity.sessionHandle) {
						throw new SessionLifecycleError(
							"invalid_identity",
							"Snapshot identity cannot change its Session handle",
						);
					}
					if (request.previousIdentity.workspaceId !== request.identity.workspaceId) {
						throw new SessionLifecycleError(
							"invalid_identity",
							"Snapshot identity cannot change its Workspace",
						);
					}
					if (!current || !sameIdentity(current, request.previousIdentity)) {
						throw new SessionLifecycleError(
							"identity_mismatch",
							`Previous snapshot identity is stale: ${request.identity.sessionHandle}`,
							{ currentIdentity: current, previousIdentity: request.previousIdentity },
						);
					}
				}
				if (
					request.operation === "snapshot" &&
					current &&
					!request.previousIdentity &&
					!sameIdentity(current, request.identity)
				) {
					throw new SessionLifecycleError(
						"identity_mismatch",
						`Session ${request.identity.sessionHandle} snapshot identity is stale`,
						{ currentIdentity: current, receivedIdentity: request.identity },
					);
				}
				if (request.operation === "rekey") {
					const previous = request.previousIdentity;
					if (!previous) {
						throw new SessionLifecycleError("invalid_identity", "Rekey requires a previous identity");
					}
					if (previous.workspaceId !== request.identity.workspaceId) {
						throw new SessionLifecycleError(
							"invalid_identity",
							"Rekey cannot move a Session between Workspaces",
						);
					}
					const previousCurrent = identities.get(previous.sessionHandle);
					if (!previousCurrent || !sameIdentity(previousCurrent, previous)) {
						throw new SessionLifecycleError(
							"identity_mismatch",
							`Previous Session identity is stale: ${previous.sessionHandle}`,
						);
					}
					if (previous.sessionHandle !== request.identity.sessionHandle && current) {
						throw new SessionLifecycleError(
							"rekey_collision",
							`Rekey target already exists: ${request.identity.sessionHandle}`,
							{ sessionHandle: request.identity.sessionHandle },
						);
					}
				}
				if (request.operation === "dispose" && (!current || !sameIdentity(current, request.identity))) {
					throw new SessionLifecycleError(
						"identity_mismatch",
						`Session ${request.identity.sessionHandle} cannot be disposed with a stale identity`,
						{ currentIdentity: current, receivedIdentity: request.identity },
					);
				}

				const requestEffects = [...(request.effects ?? [])];
				for (const effect of requestEffects) {
					if (!validIntent(effect)) {
						throw new SessionLifecycleError("invalid_identity", "Session lifecycle effect intent is invalid");
					}
				}

				const transactionEpoch = epoch + 1;
				const prepared: Array<{ owner: SessionLifecycleOwner; preparation: SessionLifecyclePreparation }> =
					[];
				try {
					for (const owner of ownerById.values()) {
						const preparation = owner.prepare({
							...request,
							epoch,
							transactionEpoch,
							policy: owner.policy[request.operation],
						});
						if (typeof preparation?.commit !== "function" || typeof preparation.restore !== "function") {
							throw new Error(`Owner ${owner.id} returned an incomplete lifecycle preparation`);
						}
						for (const effect of preparation.intents ?? []) {
							if (!validIntent(effect)) {
								throw new Error(`Owner ${owner.id} returned an invalid lifecycle effect intent`);
							}
						}
						prepared.push({ owner, preparation });
					}
				} catch (error) {
					const lifecycleError =
						error instanceof SessionLifecycleError
							? error
							: new SessionLifecycleError("prepare_failed", "Session lifecycle preparation failed", {
									error,
								});
					return { status: "rejected", epoch, effects: [], error: lifecycleError };
				}

				const committed: Array<{ owner: SessionLifecycleOwner; preparation: SessionLifecyclePreparation }> =
					[];
				try {
					batch(() => {
						for (const entry of prepared) {
							// Include the owner before calling commit so a partially-mutating commit can be restored.
							committed.push(entry);
							entry.preparation.commit();
						}
					});
				} catch (error) {
					const restoredOwnerIds: string[] = [];
					batch(() => {
						for (const entry of [...committed].reverse()) {
							try {
								entry.preparation.restore();
								restoredOwnerIds.push(entry.owner.id);
							} catch {
								// Continue restoring the remaining owners; the recovery callback receives the failure.
							}
						}
					});
					const failure: SessionLifecycleCommitFailure = {
						operation: request.operation,
						identity: request.identity,
						previousIdentity: request.previousIdentity,
						epoch,
						transactionEpoch,
						error,
						restoredOwnerIds,
					};
					try {
						options.onCommitFailure?.(failure);
					} catch {
						// Recovery reporting must not hide the original synchronous commit failure.
					}
					return {
						status: "rejected",
						epoch,
						effects: [],
						error: new SessionLifecycleError("commit_failed", "Session lifecycle commit failed", {
							error,
							restoredOwnerIds,
						}),
					};
				}

				epoch = transactionEpoch;
				if (request.operation === "dispose") {
					identities.delete(request.identity.sessionHandle);
				} else if (request.operation === "rekey" && request.previousIdentity) {
					identities.delete(request.previousIdentity.sessionHandle);
					identities.set(request.identity.sessionHandle, freezeIdentity(request.identity));
				} else {
					identities.set(request.identity.sessionHandle, freezeIdentity(request.identity));
				}
				const effects = [
					...requestEffects,
					...prepared.flatMap((entry) => [...(entry.preparation.intents ?? [])]),
				];
				return { status: "committed", epoch, effects };
			} catch (error) {
				const lifecycleError =
					error instanceof SessionLifecycleError
						? error
						: new SessionLifecycleError("not_ready", "Session lifecycle transition failed", { error });
				return { status: "rejected", epoch, effects: [], error: lifecycleError };
			}
		},
		createSession: (request) => registry.transition(normalizeRequest("create", request)),
		snapshotSession: (request) => registry.transition(normalizeRequest("snapshot", request)),
		rekeySession: (request) => registry.transition(normalizeRequest("rekey", request)),
		disposeSession: (request) => registry.transition(normalizeRequest("dispose", request)),
	};

	for (const owner of options.owners ?? []) registry.register(owner);
	return registry;
}

export function sessionIdentityKey(identity: SessionLifecycleIdentity): string {
	return identityKey(identity);
}
