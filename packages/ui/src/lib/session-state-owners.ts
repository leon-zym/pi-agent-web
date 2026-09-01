import type {
	NativeSessionDto,
	PiSessionEventDto,
	ProductSessionEventDto,
	SessionRuntimeDto,
} from "@pi-agent-web/protocol";
import { unstable_batchedUpdates } from "react-dom";
import { migrateComposerHistory } from "../features/composer/use-composer-history";
import { useComposerStore } from "../stores/composer";
import { useExtensionUiStore } from "../stores/extension-ui";
import { useModelDirectoryStore } from "../stores/model-directory";
import { useProjectionStore } from "../stores/projection";
import { useSessionControlStore } from "../stores/session-control";
import {
	installSessionDirectoryLifecycleCoordinator,
	type SessionDirectoryLifecycleOutcome,
	useSessionDirectoryStore,
} from "../stores/session-directory";
import type { SessionFrameRepresentation } from "../stores/session-frame-bus";
import { useSessionStatsStore } from "../stores/session-stats";
import { sessionTransport } from "../stores/session-transport";
import { useSlashCommandsStore } from "../stores/slash-commands";
import { useViewStore } from "../stores/view";
import { displayLabel, stripAnsi } from "./format";
import { runtimePhase } from "./runtime-state";
import {
	createDefaultSessionBrowserEffects,
	createSessionBrowserIdentity,
	type SessionBrowserEffect,
	type SessionBrowserEffects,
} from "./session-browser-effects";
import {
	createSessionLifecycleRegistry,
	SESSION_LIFECYCLE_OWNER_IDS,
	SessionLifecycleError,
	type SessionLifecycleIdentity,
	type SessionLifecycleOwner,
	type SessionLifecycleResult,
	sessionIdentityKey,
} from "./session-lifecycle-registry";

type ProjectionEvent = PiSessionEventDto | ProductSessionEventDto;

export interface SessionSnapshotOwnerPayload {
	kind: "snapshot";
	runtime: SessionRuntimeDto;
	settledMessages: unknown[];
	projectionEvents: ProjectionEvent[];
	representation?: SessionFrameRepresentation;
	queue: { steering: string[]; followUp: string[] };
	extensionRequests: import("@pi-agent-web/protocol").PiExtensionUiRequestDto[];
}

export interface SessionCreateOwnerPayload {
	kind: "create";
	session: NativeSessionDto;
}

export interface SessionRekeyOwnerPayload {
	kind: "rekey";
	previousSessionHandle: string;
	runtime: SessionRuntimeDto;
}

export interface SessionDisposeOwnerPayload {
	kind: "dispose";
	workspaceHandle: string;
}

export interface SessionStateOwnersOptions {
	effects?: SessionBrowserEffects;
	reportProjectionFailure?: (sessionHandle: string, generation: number, error?: unknown) => void;
}

export interface SessionStateOwners {
	readonly registry: ReturnType<typeof createSessionLifecycleRegistry>;
	readonly effects: SessionBrowserEffects;
	readonly assertReady: () => void;
	/** Apply a runtime observation to per-Session UI state without touching transport ownership. */
	readonly applyRuntime: (runtime: SessionRuntimeDto) => void;
	/** Select a visible Session without touching Pi transport ownership. */
	readonly selectSession: (session: NativeSessionDto | null) => boolean;
	readonly createSession: (input: {
		identity: SessionLifecycleIdentity;
		session: NativeSessionDto;
		effects?: readonly SessionBrowserEffect[];
	}) => SessionLifecycleResult;
	readonly applySnapshot: (input: {
		identity: SessionLifecycleIdentity;
		runtime: SessionRuntimeDto;
		settledMessages: unknown[];
		projectionEvents: ProjectionEvent[];
		representation?: SessionFrameRepresentation;
		queue: { steering: string[]; followUp: string[] };
		extensionRequests: import("@pi-agent-web/protocol").PiExtensionUiRequestDto[];
		effects?: readonly SessionBrowserEffect[];
	}) => SessionLifecycleResult;
	readonly rekeySession: (input: {
		previousIdentity: SessionLifecycleIdentity;
		identity: SessionLifecycleIdentity;
		runtime: SessionRuntimeDto;
		effects?: readonly SessionBrowserEffect[];
	}) => SessionLifecycleResult;
	readonly disposeSession: (input: {
		identity: SessionLifecycleIdentity;
		workspaceHandle: string;
		effects?: readonly SessionBrowserEffect[];
	}) => SessionLifecycleResult;
}

export function identityForSession(session: NativeSessionDto): SessionLifecycleIdentity {
	return createSessionBrowserIdentity({
		serverEpoch: session.runtime?.serverEpoch ?? null,
		workspaceId: session.runtime?.workspaceId ?? session.workspaceHandle,
		sessionHandle: session.sessionHandle,
		generation: session.runtime?.generation ?? null,
	});
}

function commitVisibleSessionState(session: NativeSessionDto | null): boolean {
	const beforeDirectory = useSessionDirectoryStore.getState();
	const beforeProjection = useProjectionStore.getState();
	const beforeComposer = useComposerStore.getState();
	const beforeModel = useModelDirectoryStore.getState();
	const beforeSlash = useSlashCommandsStore.getState();
	const beforeStats = useSessionStatsStore.getState();
	const beforeExtension = useExtensionUiStore.getState();
	const beforeView = useViewStore.getState();
	try {
		unstable_batchedUpdates(() => {
			useSessionDirectoryStore.getState().selectSessionState(session);
			useProjectionStore.getState().setCurrentSession(session?.sessionHandle ?? null);
			useComposerStore.getState().beginSession(session?.sessionHandle ?? null);
			useModelDirectoryStore.getState().beginSession(session?.sessionHandle ?? null);
			useSlashCommandsStore.getState().beginSession(session?.sessionHandle ?? null);
			useSessionStatsStore.getState().beginSession(session?.sessionHandle ?? null);
			useExtensionUiStore.getState().beginSession(session?.sessionHandle ?? null);
			useViewStore.getState().clearSession();
		});
		return true;
	} catch {
		const restores = [
			() => useSessionDirectoryStore.setState(beforeDirectory, true),
			() => useProjectionStore.setState(beforeProjection, true),
			() => useComposerStore.setState(beforeComposer, true),
			() => useModelDirectoryStore.setState(beforeModel, true),
			() => useSlashCommandsStore.setState(beforeSlash, true),
			() => useSessionStatsStore.setState(beforeStats, true),
			() => useExtensionUiStore.setState(beforeExtension, true),
			() => useViewStore.setState(beforeView, true),
		];
		unstable_batchedUpdates(() => {
			for (const restore of restores.reverse()) {
				try {
					restore();
				} catch {
					// Keep restoring the remaining visible state owners.
				}
			}
		});
		return false;
	}
}

function titleEffectForSelection(session: NativeSessionDto | null): SessionBrowserEffect {
	if (session) return titleEffectForSession(session);
	const workspaceHandle = useSessionDirectoryStore.getState().currentWorkspaceHandle ?? "unknown-workspace";
	return {
		type: "title",
		identity: createSessionBrowserIdentity({
			serverEpoch: null,
			workspaceId: workspaceHandle,
			sessionHandle: `workspace:${workspaceHandle}`,
			generation: null,
		}),
		dedupeKey: `title:default:${String(useSessionDirectoryStore.getState().navigationToken)}`,
		title: "Pi Agent Web",
	};
}

function titleEffectForSession(session: NativeSessionDto): SessionBrowserEffect {
	const title = useExtensionUiStore.getState().bySession[session.sessionHandle]?.title;
	return {
		type: "title",
		identity: identityForSession(session),
		dedupeKey: `title:${title ?? "default"}:${String(session.runtime?.generation ?? "pending")}:${String(useSessionDirectoryStore.getState().navigationToken)}`,
		title: title ? `${displayLabel(title)} · Pi Agent Web` : "Pi Agent Web",
	};
}

export function sessionLifecycleIdentityForRuntime(runtime: SessionRuntimeDto): SessionLifecycleIdentity {
	return createSessionBrowserIdentity({
		serverEpoch: runtime.serverEpoch,
		workspaceId: runtime.workspaceId,
		sessionHandle: runtime.sessionHandle,
		generation: runtime.generation,
	});
}

function requireRuntimeIdentity(
	identity: SessionLifecycleIdentity,
	runtime: SessionRuntimeDto,
	message: string,
): void {
	if (sessionIdentityKey(identity) !== sessionIdentityKey(sessionLifecycleIdentityForRuntime(runtime))) {
		throw new SessionLifecycleError("invalid_identity", message);
	}
}

function reversible<T extends object>(
	store: {
		getState: () => T;
		setState: (state: T, replace: true) => void;
	},
	commit: () => void,
): { commit: () => void; restore: () => void } {
	const captured = store.getState();
	return {
		commit,
		restore: () => store.setState(captured, true),
	};
}

function payload<T>(value: unknown, kind: T extends { kind: infer K } ? K : never): T {
	if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== kind) {
		throw new SessionLifecycleError("prepare_failed", `Missing ${String(kind)} Session lifecycle payload`);
	}
	return value as T;
}

function prepareDirectoryOwner(): SessionLifecycleOwner {
	return {
		id: "directory",
		policy: { create: "migrate", snapshot: "preserve", rekey: "migrate", dispose: "reset" },
		prepare: (context) => {
			const store = useSessionDirectoryStore;
			const before = store.getState();
			if (context.operation === "create") {
				const input = payload<SessionCreateOwnerPayload>(context.payload, "create");
				if (input.session.runtime) {
					requireRuntimeIdentity(
						context.identity,
						input.session.runtime,
						"Created Session identity is stale",
					);
				}
			}
			if (context.operation === "snapshot") {
				const input = payload<SessionSnapshotOwnerPayload>(context.payload, "snapshot");
				requireRuntimeIdentity(context.identity, input.runtime, "Snapshot runtime identity is stale");
			}
			if (context.operation === "rekey") {
				const input = payload<SessionRekeyOwnerPayload>(context.payload, "rekey");
				requireRuntimeIdentity(context.identity, input.runtime, "Rekey runtime identity is stale");
				const durableTarget =
					before.sessionsByWorkspace[context.identity.workspaceId]?.some(
						(session) => session.sessionHandle === context.identity.sessionHandle,
					) ?? false;
				const hotTarget =
					before.hotSessionsByWorkspace[context.identity.workspaceId]?.some(
						(session) => session.sessionHandle === context.identity.sessionHandle,
					) ?? false;
				const retainedTarget =
					before.retainedTransientByWorkspace[context.identity.workspaceId]?.sessionHandle ===
					context.identity.sessionHandle;
				const visibleTarget = before.currentSession?.sessionHandle === context.identity.sessionHandle;
				if (
					input.previousSessionHandle !== context.identity.sessionHandle &&
					(durableTarget || hotTarget || retainedTarget || visibleTarget)
				) {
					throw new SessionLifecycleError("rekey_collision", "Directory rekey target already exists", {
						sessionHandle: context.identity.sessionHandle,
					});
				}
			}
			if (context.operation === "dispose") {
				const input = payload<SessionDisposeOwnerPayload>(context.payload, "dispose");
				if (input.workspaceHandle !== context.identity.workspaceId) {
					throw new SessionLifecycleError("invalid_identity", "Dispose Workspace identity is stale");
				}
			}
			const commit = () => {
				switch (context.operation) {
					case "create":
						store
							.getState()
							.selectSessionState(payload<SessionCreateOwnerPayload>(context.payload, "create").session);
						return;
					case "snapshot":
						store
							.getState()
							.applyRuntime(payload<SessionSnapshotOwnerPayload>(context.payload, "snapshot").runtime);
						return;
					case "rekey": {
						const input = payload<SessionRekeyOwnerPayload>(context.payload, "rekey");
						store
							.getState()
							.rekeySessionState(input.previousSessionHandle, context.identity.sessionHandle, input.runtime);
						return;
					}
					case "dispose": {
						const input = payload<SessionDisposeOwnerPayload>(context.payload, "dispose");
						store.getState().removeSessionState(input.workspaceHandle, context.identity.sessionHandle);
						return;
					}
				}
			};
			return {
				commit,
				restore: () => store.setState(before, true),
			};
		},
	};
}

function prepareViewOwner(): SessionLifecycleOwner {
	return {
		id: "view",
		policy: { create: "reset", snapshot: "preserve", rekey: "reset", dispose: "reset" },
		prepare: (context) => {
			const store = useViewStore;
			const currentSessionHandle = useSessionDirectoryStore.getState().currentSession?.sessionHandle;
			const shouldClear =
				context.operation === "create" ||
				(context.operation === "rekey" && currentSessionHandle === context.previousIdentity?.sessionHandle) ||
				(context.operation === "dispose" && currentSessionHandle === context.identity.sessionHandle);
			return reversible(store, () => {
				if (shouldClear) store.getState().clearSession();
			});
		},
	};
}

function prepareComposerOwner(): SessionLifecycleOwner {
	return {
		id: "composer",
		policy: { create: "migrate", snapshot: "preserve", rekey: "migrate", dispose: "reset" },
		prepare: (context) => {
			const store = useComposerStore;
			const before = store.getState();
			if (context.operation === "rekey") {
				const input = payload<SessionRekeyOwnerPayload>(context.payload, "rekey");
				if (before.bySession[context.identity.sessionHandle]) {
					throw new SessionLifecycleError("rekey_collision", "Composer child Session state already exists", {
						sessionHandle: context.identity.sessionHandle,
					});
				}
				return {
					commit: () =>
						store.getState().rekeySession(input.previousSessionHandle, context.identity.sessionHandle),
					restore: () => store.setState(before, true),
					intents: [
						{
							type: "custom",
							identity: context.identity,
							dedupeKey: `composer-history:${input.previousSessionHandle}:${context.identity.sessionHandle}`,
							run: () =>
								migrateComposerHistory(
									context.identity.workspaceId,
									input.previousSessionHandle,
									context.identity.sessionHandle,
								),
						},
					],
				};
			}
			return reversible(store, () => {
				if (context.operation === "create") {
					store.getState().beginSession(context.identity.sessionHandle);
				} else if (context.operation === "snapshot") {
					const input = payload<SessionSnapshotOwnerPayload>(context.payload, "snapshot");
					store.getState().setQueueForSession(context.identity.sessionHandle, input.queue);
				} else if (context.operation === "dispose") {
					store.getState().forgetSession(context.identity.sessionHandle);
				}
			});
		},
	};
}

function prepareProjectionOwner(): SessionLifecycleOwner {
	return {
		id: "projection",
		policy: { create: "reset", snapshot: "rebuild", rekey: "rebuild", dispose: "reset" },
		prepare: (context) => {
			const store = useProjectionStore;
			const wasCurrent = store.getState().currentSessionId === context.previousIdentity?.sessionHandle;
			if (
				context.operation === "rekey" &&
				context.previousIdentity?.sessionHandle !== context.identity.sessionHandle &&
				store.getState().projections[context.identity.sessionHandle]
			) {
				throw new SessionLifecycleError("rekey_collision", "Projection child Session state already exists", {
					sessionHandle: context.identity.sessionHandle,
				});
			}
			return reversible(store, () => {
				switch (context.operation) {
					case "create":
						store.getState().setCurrentSession(context.identity.sessionHandle);
						return;
					case "snapshot": {
						const input = payload<SessionSnapshotOwnerPayload>(context.payload, "snapshot");
						store
							.getState()
							.applyAuthoritativeSnapshot(
								context.identity.sessionHandle,
								input.settledMessages,
								input.projectionEvents,
								input.representation,
							);
						if (runtimePhase(input.runtime) === "crashed") {
							store
								.getState()
								.markRuntimeFailure(context.identity.sessionHandle, stripAnsi(input.runtime.error ?? ""));
						}
						return;
					}
					case "rekey":
						store.getState().resetSession(context.identity.sessionHandle);
						if (wasCurrent) store.getState().setCurrentSession(context.identity.sessionHandle);
						return;
					case "dispose":
						store.getState().resetSession(context.identity.sessionHandle);
						if (store.getState().currentSessionId === context.identity.sessionHandle) {
							store.getState().setCurrentSession(null);
						}
						return;
				}
			});
		},
	};
}

function prepareModelOwner(): SessionLifecycleOwner {
	return {
		id: "model",
		policy: { create: "reset", snapshot: "rebuild", rekey: "rebuild", dispose: "reset" },
		prepare: (context) => {
			const store = useModelDirectoryStore;
			if (
				context.operation === "rekey" &&
				context.previousIdentity?.sessionHandle !== context.identity.sessionHandle &&
				store.getState().bySession[context.identity.sessionHandle]
			) {
				throw new SessionLifecycleError("rekey_collision", "Model child Session state already exists", {
					sessionHandle: context.identity.sessionHandle,
				});
			}
			return reversible(store, () => {
				if (context.operation === "create") store.getState().beginSession(context.identity.sessionHandle);
				else if (context.operation === "rekey") {
					store.getState().forgetSession(context.identity.sessionHandle);
					if (
						useSessionDirectoryStore.getState().currentSession?.sessionHandle ===
						context.identity.sessionHandle
					) {
						store.getState().beginSession(context.identity.sessionHandle);
					}
				} else if (context.operation === "dispose")
					store.getState().forgetSession(context.identity.sessionHandle);
			});
		},
	};
}

function prepareSlashOwner(): SessionLifecycleOwner {
	return {
		id: "slash",
		policy: { create: "reset", snapshot: "rebuild", rekey: "rebuild", dispose: "reset" },
		prepare: (context) => {
			const store = useSlashCommandsStore;
			if (
				context.operation === "rekey" &&
				context.previousIdentity?.sessionHandle !== context.identity.sessionHandle &&
				store.getState().bySession[context.identity.sessionHandle]
			) {
				throw new SessionLifecycleError("rekey_collision", "Slash child Session state already exists", {
					sessionHandle: context.identity.sessionHandle,
				});
			}
			return reversible(store, () => {
				if (context.operation === "create") store.getState().beginSession(context.identity.sessionHandle);
				else if (context.operation === "rekey") {
					store.getState().forgetSession(context.identity.sessionHandle);
					if (
						useSessionDirectoryStore.getState().currentSession?.sessionHandle ===
						context.identity.sessionHandle
					) {
						store.getState().beginSession(context.identity.sessionHandle);
					}
				} else if (context.operation === "dispose")
					store.getState().forgetSession(context.identity.sessionHandle);
			});
		},
	};
}

function prepareStatsOwner(): SessionLifecycleOwner {
	return {
		id: "stats",
		policy: { create: "reset", snapshot: "rebuild", rekey: "rebuild", dispose: "reset" },
		prepare: (context) => {
			const store = useSessionStatsStore;
			if (
				context.operation === "rekey" &&
				context.previousIdentity?.sessionHandle !== context.identity.sessionHandle &&
				store.getState().bySession[context.identity.sessionHandle]
			) {
				throw new SessionLifecycleError("rekey_collision", "Stats child Session state already exists", {
					sessionHandle: context.identity.sessionHandle,
				});
			}
			return reversible(store, () => {
				if (context.operation === "create") store.getState().beginSession(context.identity.sessionHandle);
				else if (context.operation === "rekey") {
					store.getState().forgetSession(context.identity.sessionHandle);
					if (
						useSessionDirectoryStore.getState().currentSession?.sessionHandle ===
						context.identity.sessionHandle
					) {
						store.getState().beginSession(context.identity.sessionHandle);
					}
				} else if (context.operation === "dispose")
					store.getState().forgetSession(context.identity.sessionHandle);
			});
		},
	};
}

function prepareExtensionOwner(): SessionLifecycleOwner {
	return {
		id: "extension",
		policy: { create: "reset", snapshot: "rebuild", rekey: "rebuild", dispose: "reset" },
		prepare: (context) => {
			const store = useExtensionUiStore;
			const wasActive = store.getState().activeSessionHandle === context.previousIdentity?.sessionHandle;
			if (
				context.operation === "rekey" &&
				context.previousIdentity?.sessionHandle !== context.identity.sessionHandle &&
				store.getState().bySession[context.identity.sessionHandle]
			) {
				throw new SessionLifecycleError("rekey_collision", "Extension child Session state already exists", {
					sessionHandle: context.identity.sessionHandle,
				});
			}
			return reversible(store, () => {
				switch (context.operation) {
					case "create":
						store.getState().beginSession(context.identity.sessionHandle);
						return;
					case "snapshot": {
						const input = payload<SessionSnapshotOwnerPayload>(context.payload, "snapshot");
						store
							.getState()
							.replaceRequestsForSession(
								context.identity.sessionHandle,
								context.identity.generation ?? 0,
								input.extensionRequests,
							);
						return;
					}
					case "rekey":
						store
							.getState()
							.resetSessionForGeneration(context.identity.sessionHandle, context.identity.generation ?? 0);
						if (wasActive) store.getState().beginSession(context.identity.sessionHandle);
						return;
					case "dispose":
						store.getState().forgetSession(context.identity.sessionHandle);
						return;
				}
			});
		},
	};
}

export function createSessionStateOwners(options: SessionStateOwnersOptions = {}): SessionStateOwners {
	const effects = options.effects ?? createDefaultSessionBrowserEffects();
	const registry = createSessionLifecycleRegistry({
		requiredOwnerIds: SESSION_LIFECYCLE_OWNER_IDS,
		batch: unstable_batchedUpdates,
		onCommitFailure: (failure) => {
			if (failure.identity.generation !== null) {
				if (options.reportProjectionFailure) {
					options.reportProjectionFailure(
						failure.identity.sessionHandle,
						failure.identity.generation,
						failure.error,
					);
				} else {
					sessionTransport.reportProjectionFailure(
						failure.identity.sessionHandle,
						failure.identity.generation,
						failure.error,
					);
				}
			}
		},
	});
	for (const owner of [
		prepareDirectoryOwner(),
		prepareViewOwner(),
		prepareComposerOwner(),
		prepareProjectionOwner(),
		prepareModelOwner(),
		prepareSlashOwner(),
		prepareStatsOwner(),
		prepareExtensionOwner(),
	]) {
		registry.register(owner);
	}

	const dispatchResult = (
		result: SessionLifecycleResult,
		request: {
			operation: "create" | "snapshot" | "rekey" | "dispose";
			identity: SessionLifecycleIdentity;
			previousIdentity?: SessionLifecycleIdentity;
		},
	): SessionLifecycleResult => {
		if (result.status !== "committed") return result;
		if (request.operation === "rekey" && request.previousIdentity) {
			effects.invalidateIdentity(request.previousIdentity);
			useSessionControlStore.getState().resetSession(request.previousIdentity.sessionHandle);
			useSessionControlStore.getState().resetSession(request.identity.sessionHandle);
		}
		if (request.operation === "dispose") {
			effects.invalidateIdentity(request.identity);
			useSessionControlStore.getState().forgetSession(request.identity.sessionHandle);
		} else effects.setCurrentIdentity(request.identity);
		for (const effect of result.effects) effects.dispatch(effect as SessionBrowserEffect);
		return result;
	};

	return {
		registry,
		effects,
		assertReady: () => registry.assertReady(),
		applyRuntime: (runtime) => {
			unstable_batchedUpdates(() => {
				useSessionDirectoryStore.getState().applyRuntime(runtime);
				useExtensionUiStore.getState().resetSessionForGeneration(runtime.sessionHandle, runtime.generation);
				if (runtimePhase(runtime) === "crashed") {
					useProjectionStore
						.getState()
						.markRuntimeFailure(runtime.sessionHandle, stripAnsi(runtime.error ?? ""));
				}
			});
		},
		selectSession: (session) => {
			if (!session) {
				if (!commitVisibleSessionState(null)) return false;
				const title = titleEffectForSelection(null);
				effects.setCurrentIdentity(title.identity);
				effects.dispatch(title);
				return true;
			}
			const identity = identityForSession(session);
			const current = registry.currentIdentity(session.sessionHandle);
			if (!current) {
				const result = registry.createSession({
					identity,
					payload: { kind: "create", session } satisfies SessionCreateOwnerPayload,
				});
				if (result.status !== "committed") return false;
				effects.setCurrentIdentity(identity);
			} else if (sessionIdentityKey(current) !== sessionIdentityKey(identity)) {
				// Selection is only a view pointer. Keep the committed lifecycle identity until a
				// matching snapshot publishes the new incarnation, so stale effects remain fenced.
				if (current.workspaceId !== identity.workspaceId || !commitVisibleSessionState(session)) return false;
				effects.dispatch({
					...titleEffectForSession(session),
					identity: current,
				});
				return true;
			} else if (!commitVisibleSessionState(session)) {
				return false;
			}
			const title = titleEffectForSession(session);
			effects.dispatch(title);
			return true;
		},
		createSession: (input) =>
			dispatchResult(
				registry.createSession({
					identity: input.identity,
					payload: { kind: "create", session: input.session } satisfies SessionCreateOwnerPayload,
					effects: input.effects,
				}),
				{ operation: "create", identity: input.identity },
			),
		applySnapshot: (input) =>
			dispatchResult(
				registry.snapshotSession({
					identity: input.identity,
					previousIdentity: registry.currentIdentity(input.identity.sessionHandle) ?? undefined,
					payload: {
						kind: "snapshot",
						runtime: input.runtime,
						settledMessages: input.settledMessages,
						projectionEvents: input.projectionEvents,
						representation: input.representation,
						queue: input.queue,
						extensionRequests: input.extensionRequests,
					} satisfies SessionSnapshotOwnerPayload,
					effects: input.effects,
				}),
				{ operation: "snapshot", identity: input.identity },
			),
		rekeySession: (input) =>
			dispatchResult(
				registry.rekeySession({
					previousIdentity: input.previousIdentity,
					identity: input.identity,
					payload: {
						kind: "rekey",
						previousSessionHandle: input.previousIdentity.sessionHandle,
						runtime: input.runtime,
					} satisfies SessionRekeyOwnerPayload,
					effects: input.effects,
				}),
				{
					operation: "rekey",
					identity: input.identity,
					previousIdentity: input.previousIdentity,
				},
			),
		disposeSession: (input) =>
			dispatchResult(
				registry.disposeSession({
					identity: input.identity,
					payload: {
						kind: "dispose",
						workspaceHandle: input.workspaceHandle,
					} satisfies SessionDisposeOwnerPayload,
					effects: input.effects,
				}),
				{ operation: "dispose", identity: input.identity },
			),
	};
}

export const sessionStateOwners = createSessionStateOwners();

installSessionDirectoryLifecycleCoordinator({
	selectSession: (session) => sessionStateOwners.selectSession(session),
	activateSessionTransport: (session, previousSessionHandle) =>
		useSessionDirectoryStore.getState().activateSessionTransport(session, previousSessionHandle),
	rekeySession: (previousSessionHandle, _sessionHandle, runtime): SessionDirectoryLifecycleOutcome => {
		const previousIdentity = sessionStateOwners.registry.currentIdentity(previousSessionHandle);
		if (!previousIdentity) return "unavailable";
		const result = sessionStateOwners.rekeySession({
			previousIdentity,
			identity: sessionLifecycleIdentityForRuntime(runtime),
			runtime,
		});
		return result.status === "committed" ? "committed" : "rejected";
	},
	disposeSession: (workspaceHandle, sessionHandle): SessionDirectoryLifecycleOutcome => {
		const identity = sessionStateOwners.registry.currentIdentity(sessionHandle);
		if (!identity) return "unavailable";
		const result = sessionStateOwners.disposeSession({ identity, workspaceHandle });
		return result.status === "committed" ? "committed" : "rejected";
	},
});
