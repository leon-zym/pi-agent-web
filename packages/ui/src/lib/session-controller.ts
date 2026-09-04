import {
	expectCommandData,
	type NativeSessionDto,
	type PiSessionCommandResponseDto,
	SESSION_IMAGE_MAX_BASE64_CHARS,
	SESSION_IMAGE_MAX_COUNT,
	SESSION_IMAGE_TOTAL_MAX_BASE64_CHARS,
} from "@pi-agent-web/protocol";
import { serializeComposerMessage, useComposerStore, workspaceFileImages } from "../stores/composer";
import { useProjectionStore } from "../stores/projection";
import {
	isSessionBeingAbandoned,
	reconcileHiddenSessionLifecycle,
	resolveHotSessionPersistence,
	useSessionDirectoryStore,
} from "../stores/session-directory";
import { sessionTransport } from "../stores/session-transport";
import type { ImageContent } from "../types/pi-types";
import { api } from "./api";
import { displayCommandResponseError, displayError, stripAnsi } from "./format";
import { tt } from "./i18n";
import { runtimeIsBusy } from "./runtime-state";
import {
	createSessionBrowserIdentity,
	createWorkspaceBrowserIdentity,
	getSessionBrowserEffects,
	type SessionBrowserIdentity,
	type WorkspaceBrowserIdentity,
} from "./session-browser-effects";
import { isSessionControlReady, sessionDeleteCapability } from "./session-capabilities";
import { sendControlCommand, sendControlCommandWithIdentity } from "./session-command";

export {
	sendControlCommand,
	sendControlCommandWithIdentity,
	sendControlExtensionUiResponse,
	sendReadCommand,
} from "./session-command";

function currentWorkspaceHandle(): string {
	const handle = useSessionDirectoryStore.getState().currentWorkspaceHandle;
	if (!handle) throw new Error(tt("session.workspaceRequired"));
	return handle;
}

function currentSession(): NativeSessionDto {
	const session = useSessionDirectoryStore.getState().currentSession;
	if (!session) throw new Error(tt("session.needWorkspace"));
	return session;
}

function currentSessionHandle(): string {
	return currentSession().sessionHandle;
}

let browserEffectSequence = 0;

function nextBrowserEffectKey(prefix: string): string {
	browserEffectSequence += 1;
	return `${prefix}:${String(browserEffectSequence)}`;
}

export function captureSessionBrowserIdentity(sessionHandle: string): SessionBrowserIdentity | null {
	const runtime = sessionTransport.store.getState().sessions[sessionHandle]?.runtime;
	return runtime ? createSessionBrowserIdentity(runtime) : null;
}

function captureWorkspaceBrowserIdentity(
	workspaceHandle: string | null | undefined,
): WorkspaceBrowserIdentity | null {
	if (!workspaceHandle) return null;
	const identity = createWorkspaceBrowserIdentity({ workspaceId: workspaceHandle });
	getSessionBrowserEffects().setCurrentWorkspaceIdentity(identity);
	return identity;
}

function dispatchSessionToast(
	identity: SessionBrowserIdentity,
	level: "info" | "success" | "warning" | "error",
	message: string,
	key: string,
	description?: string,
): boolean {
	return getSessionBrowserEffects().dispatch({
		type: "toast",
		identity,
		dedupeKey: key,
		level,
		message,
		...(description ? { description } : {}),
	});
}

/** Interactive Session feedback also requires the initiating Session to remain visible. */
export function dispatchCurrentSessionBrowserToast(
	identity: SessionBrowserIdentity | null,
	level: "info" | "success" | "warning" | "error",
	message: string,
	keyPrefix: string,
	description?: string,
): boolean {
	if (
		!identity ||
		useSessionDirectoryStore.getState().currentSession?.sessionHandle !== identity.sessionHandle
	) {
		return false;
	}
	return dispatchSessionToast(identity, level, message, nextBrowserEffectKey(keyPrefix), description);
}

function dispatchWorkspaceToast(
	identity: WorkspaceBrowserIdentity,
	level: "info" | "success" | "warning" | "error",
	message: string,
	key: string,
	description?: string,
): boolean {
	const effects = getSessionBrowserEffects();
	return effects.dispatch({
		type: "toast",
		workspaceIdentity: identity,
		dedupeKey: key,
		level,
		message,
		...(description ? { description } : {}),
	});
}

function dispatchCapturedToast(
	identity: SessionBrowserIdentity | null,
	workspaceIdentity: WorkspaceBrowserIdentity | null,
	level: "info" | "success" | "warning" | "error",
	message: string,
	key: string,
	description?: string,
): boolean {
	return identity
		? dispatchSessionToast(identity, level, message, key, description)
		: workspaceIdentity
			? dispatchWorkspaceToast(workspaceIdentity, level, message, key, description)
			: false;
}

const initialSessionByWorkspace = new Map<string, Promise<void>>();

interface SessionCreationFlight {
	promise: Promise<void>;
	creationToken: number | null;
}

const sessionCreationByWorkspace = new Map<string, SessionCreationFlight>();

type InitialHotTransientDecision = "ready" | "pending" | "terminal" | "none";

function initialHotTransientDecision(workspaceHandle: string): InitialHotTransientDecision {
	const directory = useSessionDirectoryStore.getState();
	const transport = sessionTransport.store.getState();
	let pending = false;
	let terminal = false;
	for (const session of directory.hotSessionsByWorkspace[workspaceHandle] ?? []) {
		const identity = directory.hotRuntimeIdentityBySession[session.sessionHandle];
		const persistence = resolveHotSessionPersistence(
			session,
			identity,
			directory.sessionsByWorkspace[workspaceHandle],
		);
		if (persistence.status === "unpersisted") return "ready";
		if (persistence.status !== "unknown") continue;
		const recovery = transport.sessions[session.sessionHandle]?.recovery;
		if (
			identity &&
			recovery?.phase === "degraded" &&
			recovery.identity.serverEpoch === identity.serverEpoch &&
			recovery.identity.workspaceId === identity.workspaceId &&
			recovery.identity.sessionHandle === identity.sessionHandle &&
			recovery.identity.generation === identity.generation
		) {
			terminal = true;
		} else {
			pending = true;
		}
	}
	if (pending) return "pending";
	return terminal ? "terminal" : "none";
}

async function waitForHotTransientDecision(workspaceHandle: string): Promise<boolean> {
	for (;;) {
		const current = useSessionDirectoryStore.getState();
		if (current.currentWorkspaceHandle !== workspaceHandle) return false;
		if (current.currentSession || current.sessionCreation) return false;
		const decision = initialHotTransientDecision(workspaceHandle);
		if (decision === "terminal") return false;
		if (decision !== "pending") return true;
		await new Promise<void>((resolve) => {
			let directoryUnsubscribe = () => {};
			let transportUnsubscribe = () => {};
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				directoryUnsubscribe();
				transportUnsubscribe();
				resolve();
			};
			const inspect = () => {
				const state = useSessionDirectoryStore.getState();
				if (
					state.currentWorkspaceHandle === workspaceHandle &&
					!state.currentSession &&
					!state.sessionCreation &&
					initialHotTransientDecision(workspaceHandle) === "pending"
				) {
					return;
				}
				finish();
			};
			directoryUnsubscribe = useSessionDirectoryStore.subscribe(inspect);
			transportUnsubscribe = sessionTransport.store.subscribe(inspect);
			inspect();
		});
	}
}

function controllerChannel(sessionHandle: string) {
	const channel = sessionTransport.store.getState().sessions[sessionHandle];
	if (
		!channel ||
		!isSessionControlReady(channel) ||
		channel.generation === null ||
		!channel.lease.fencingToken
	) {
		throw new Error(tt("lease.readOnly"));
	}
	return {
		generation: channel.generation,
		fencingToken: channel.lease.fencingToken,
		runtime: channel.runtime,
	};
}

/** Selecting a Session changes only the visible pointer; every subscribed Session keeps ingesting. */
export async function openSession(session: NativeSessionDto): Promise<void> {
	if (isSessionBeingAbandoned(session.sessionHandle)) return;
	const directory = useSessionDirectoryStore.getState();
	directory.selectSession(session);
	const activation = api
		.activateWorkspace(session.workspaceHandle)
		.then((activatedWorkspace) => {
			useSessionDirectoryStore.setState((state) => ({
				workspaces: state.workspaces.map((workspace) =>
					workspace.workspaceHandle === activatedWorkspace.workspaceHandle ? activatedWorkspace : workspace,
				),
			}));
		})
		.catch((error) => {
			if (useSessionDirectoryStore.getState().currentWorkspaceHandle !== session.workspaceHandle) return;
			useSessionDirectoryStore.setState({ error: displayError(error) });
		});
	await Promise.all([activation, directory.reloadSessions(session.workspaceHandle)]);
}

async function performSessionCreation(
	workspaceHandle: string,
	onCreationIntent: (token: number) => void,
): Promise<void> {
	const workspaceIdentity = captureWorkspaceBrowserIdentity(workspaceHandle);
	let creationToken: number | undefined;
	try {
		const directoryBeforeCreation = useSessionDirectoryStore.getState();
		if (directoryBeforeCreation.currentWorkspaceHandle !== workspaceHandle) return;
		if (directoryBeforeCreation.resumeTransientSession(workspaceHandle)) return;
		creationToken = directoryBeforeCreation.beginSessionCreation(workspaceHandle);
		onCreationIntent(creationToken);
		const created = await api.createSession(workspaceHandle);
		const directory = useSessionDirectoryStore.getState();
		directory.completeSessionCreation(creationToken, created.session);
		void directory.reloadSessions(workspaceHandle);
	} catch (error) {
		if (
			creationToken !== undefined &&
			!useSessionDirectoryStore.getState().failSessionCreation(creationToken)
		) {
			return;
		}
		dispatchCapturedToast(
			null,
			workspaceIdentity,
			"error",
			tt("session.newFailed"),
			nextBrowserEffectKey("session-new-failed"),
			displayError(error),
		);
	}
}

/** Create a new Pi-native Session and attach its dedicated runtime. */
export function newSession(): Promise<void> {
	let workspaceHandle: string;
	try {
		workspaceHandle = currentWorkspaceHandle();
	} catch (error) {
		dispatchCapturedToast(
			null,
			captureWorkspaceBrowserIdentity(useSessionDirectoryStore.getState().currentWorkspaceHandle),
			"error",
			tt("session.newFailed"),
			nextBrowserEffectKey("session-new-failed"),
			displayError(error),
		);
		return Promise.resolve();
	}
	const existing = sessionCreationByWorkspace.get(workspaceHandle);
	if (existing) {
		const directory = useSessionDirectoryStore.getState();
		if (
			existing.creationToken === null ||
			(directory.currentWorkspaceHandle === workspaceHandle &&
				directory.navigationToken === existing.creationToken &&
				directory.sessionCreation?.token === existing.creationToken)
		) {
			return existing.promise;
		}
		const requestedNavigationToken = directory.navigationToken;
		return existing.promise.then(() => {
			const current = useSessionDirectoryStore.getState();
			if (
				current.currentWorkspaceHandle !== workspaceHandle ||
				current.navigationToken !== requestedNavigationToken
			) {
				return;
			}
			return newSession();
		});
	}
	let resolveCompletion = () => {};
	const completion = new Promise<void>((resolve) => {
		resolveCompletion = resolve;
	});
	const flight: SessionCreationFlight = { promise: completion, creationToken: null };
	sessionCreationByWorkspace.set(workspaceHandle, flight);
	const settle = () => {
		if (sessionCreationByWorkspace.get(workspaceHandle) === flight) {
			sessionCreationByWorkspace.delete(workspaceHandle);
		}
		resolveCompletion();
	};
	void performSessionCreation(workspaceHandle, (token) => {
		flight.creationToken = token;
	}).then(
		() => {
			settle();
		},
		() => {
			settle();
		},
	);
	return completion;
}

/** Reconcile recovered hot state before the app creates its initial empty Session. */
export function ensureInitialSession(): Promise<void> {
	const workspaceHandle = currentWorkspaceHandle();
	const existing = initialSessionByWorkspace.get(workspaceHandle);
	if (existing) return existing;
	const completion = (async () => {
		const initial = useSessionDirectoryStore.getState();
		if (initial.resumeTransientSession(workspaceHandle)) return;
		if (!(await waitForHotTransientDecision(workspaceHandle))) return;
		const resolved = useSessionDirectoryStore.getState();
		if (resolved.currentWorkspaceHandle !== workspaceHandle) return;
		if (resolved.currentSession || resolved.sessionCreation) return;
		await newSession();
	})().finally(() => {
		if (initialSessionByWorkspace.get(workspaceHandle) === completion) {
			initialSessionByWorkspace.delete(workspaceHandle);
		}
	});
	initialSessionByWorkspace.set(workspaceHandle, completion);
	return completion;
}

export async function deleteSession(session: NativeSessionDto): Promise<void> {
	const sessionIdentity = captureSessionBrowserIdentity(session.sessionHandle);
	const workspaceIdentity = captureWorkspaceBrowserIdentity(session.workspaceHandle);
	try {
		const transport = sessionTransport.store.getState();
		const capability = sessionDeleteCapability(session, transport.sessions[session.sessionHandle]);
		if (!capability.allowed) {
			throw new Error(tt(`sidebar.deleteBlocked.${capability.reason}`));
		}
		const channel = controllerChannel(session.sessionHandle);
		await api.deleteSession(session.workspaceHandle, session.sessionHandle, {
			generation: channel.generation,
			fencingToken: channel.fencingToken,
		});
		dispatchCapturedToast(
			sessionIdentity,
			workspaceIdentity,
			"success",
			tt("session.deleted"),
			nextBrowserEffectKey("session-deleted"),
		);
		transport.releaseSession(session.sessionHandle);
		transport.unsubscribeSession(session.sessionHandle);
		const directory = useSessionDirectoryStore.getState();
		directory.removeSession(session.workspaceHandle, session.sessionHandle);
		void directory.loadWorkspaces();
	} catch (error) {
		dispatchCapturedToast(
			sessionIdentity,
			workspaceIdentity,
			"error",
			tt("session.deleteFailed"),
			nextBrowserEffectKey("session-delete-failed"),
			displayError(error),
		);
	}
}

export async function renameSession(session: NativeSessionDto, name: string): Promise<void> {
	const sessionIdentity = captureSessionBrowserIdentity(session.sessionHandle);
	const workspaceIdentity = captureWorkspaceBrowserIdentity(session.workspaceHandle);
	try {
		if (useSessionDirectoryStore.getState().currentSession?.sessionHandle !== session.sessionHandle) {
			throw new Error(tt("session.renameCurrentOnly"));
		}
		controllerChannel(session.sessionHandle);
		await sendControlCommand(session.sessionHandle, { type: "set_session_name", name });
		await useSessionDirectoryStore.getState().reloadSessions(session.workspaceHandle);
	} catch (error) {
		dispatchCapturedToast(
			sessionIdentity,
			workspaceIdentity,
			"error",
			tt("session.renameFailed"),
			nextBrowserEffectKey("session-rename-failed"),
			displayError(error),
		);
	}
}

export type SubmitKind = "prompt" | "steer" | "follow_up";

function isRunning(sessionHandle: string): boolean {
	const runtime = sessionTransport.store.getState().sessions[sessionHandle]?.runtime;
	if (runtimeIsBusy(runtime)) return true;
	const projection = useProjectionStore.getState().projections[sessionHandle];
	return projection?.activeTurnId !== null && projection?.activeTurnId !== undefined;
}

/** Submit the active Session's draft with exact generation and fencing handled by the transport. */
export async function submitDraft(kind: SubmitKind): Promise<void> {
	const workspaceIdentity = captureWorkspaceBrowserIdentity(
		useSessionDirectoryStore.getState().currentWorkspaceHandle,
	);
	let sessionHandle: string;
	try {
		sessionHandle = currentSessionHandle();
	} catch {
		dispatchCapturedToast(
			null,
			workspaceIdentity,
			"error",
			tt("session.needWorkspace"),
			nextBrowserEffectKey("session-need-workspace"),
		);
		return;
	}
	const sessionIdentity = captureSessionBrowserIdentity(sessionHandle);
	const composer = useComposerStore.getState();
	const initial = composer.bySession[sessionHandle];
	let text: string;
	try {
		text = serializeComposerMessage(
			initial?.command ?? null,
			initial?.draft ?? "",
			initial?.fileReferences ?? [],
		);
	} catch (error) {
		dispatchCapturedToast(
			sessionIdentity,
			workspaceIdentity,
			"error",
			tt("composer.fileReferenceBudgetExceeded"),
			nextBrowserEffectKey("file-reference-budget"),
			displayError(error),
		);
		return;
	}
	if (!text && (initial?.images.length ?? 0) === 0 && (initial?.fileReferences.length ?? 0) === 0) return;
	if (!composer.beginSubmitForSession(sessionHandle)) return;
	const submitted = useComposerStore.getState().bySession[sessionHandle];
	if (!submitted) return;

	const running = isRunning(sessionHandle);
	let resolvedKind: SubmitKind = kind;
	if (running && kind === "prompt") {
		resolvedKind = submitted.deliveryMode === "follow_up" ? "follow_up" : "steer";
	} else if (!running) resolvedKind = "prompt";

	const allImages = [...submitted.images, ...workspaceFileImages(submitted.fileReferences)];
	if (
		allImages.length > SESSION_IMAGE_MAX_COUNT ||
		allImages.some((image) => image.data.length > SESSION_IMAGE_MAX_BASE64_CHARS) ||
		allImages.reduce((total, image) => total + image.data.length, 0) > SESSION_IMAGE_TOTAL_MAX_BASE64_CHARS
	) {
		dispatchCapturedToast(
			sessionIdentity,
			workspaceIdentity,
			"error",
			tt("composer.fileReferenceBudgetExceeded"),
			nextBrowserEffectKey("file-reference-budget"),
		);
		composer.finishSubmitForSession(sessionHandle, submitted.activeSubmitId);
		return;
	}
	const images = allImages.length > 0 ? allImages : undefined;
	try {
		let response: PiSessionCommandResponseDto;
		if (resolvedKind === "steer" || resolvedKind === "follow_up") {
			composer.recordQueuedForSession(sessionHandle, text, resolvedKind);
			response = await sendControlCommand(sessionHandle, {
				type: resolvedKind,
				message: text,
				images,
			});
		} else {
			response = await sendControlCommand(sessionHandle, { type: "prompt", message: text, images });
		}
		if (response.success === false) {
			dispatchCapturedToast(
				sessionIdentity,
				workspaceIdentity,
				"error",
				tt("session.sendFailed"),
				nextBrowserEffectKey("session-send-failed"),
				displayCommandResponseError(response),
			);
		} else {
			useComposerStore
				.getState()
				.clearDraftIfUnchangedForSession(
					sessionHandle,
					submitted.draft,
					submitted.images,
					submitted.command,
					submitted.activeSubmitId,
					submitted.fileReferences,
				);
		}
	} catch (error) {
		dispatchCapturedToast(
			sessionIdentity,
			workspaceIdentity,
			"error",
			tt("session.sendFailed"),
			nextBrowserEffectKey("session-send-failed"),
			displayError(error),
		);
	} finally {
		useComposerStore.getState().finishSubmitForSession(sessionHandle, submitted.activeSubmitId);
		reconcileHiddenSessionLifecycle(sessionHandle);
	}
}

const SOFT_IDEMPOTENT_ERRORS = new Set([
	"no_active_run",
	"dialog_already_closed",
	"invalid_dialog_id",
	"session_idle",
]);

export function isSoftIdempotentError(error: unknown): boolean {
	if (!error) return false;
	const str = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
	const lower = str.toLowerCase();
	for (const code of SOFT_IDEMPOTENT_ERRORS) {
		if (lower.includes(code)) return true;
	}
	return false;
}

export async function abortCurrentRun(): Promise<void> {
	const session = useSessionDirectoryStore.getState().currentSession;
	if (!session) return;
	const sessionIdentity = captureSessionBrowserIdentity(session.sessionHandle);
	const workspaceIdentity = captureWorkspaceBrowserIdentity(session.workspaceHandle);
	try {
		const response = await sendControlCommand(session.sessionHandle, { type: "abort" });
		if (response.success === false && !isSoftIdempotentError(response.error)) {
			dispatchCapturedToast(
				sessionIdentity,
				workspaceIdentity,
				"error",
				tt("session.abortFailed"),
				nextBrowserEffectKey("session-abort-failed"),
				stripAnsi(response.error),
			);
		}
	} catch (error) {
		if (!isSoftIdempotentError(error)) {
			dispatchCapturedToast(
				sessionIdentity,
				workspaceIdentity,
				"error",
				tt("session.abortFailed"),
				nextBrowserEffectKey("session-abort-failed"),
				displayError(error),
			);
		}
	}
}

export async function forkFromEntry(
	entryId: string,
	sessionHandle: string,
	parentIdentity: SessionBrowserIdentity | null = captureSessionBrowserIdentity(sessionHandle),
): Promise<boolean> {
	try {
		const completion = await sendControlCommandWithIdentity(sessionHandle, { type: "fork", entryId });
		const data = expectCommandData(completion.response, "fork");
		const childIdentity = createSessionBrowserIdentity(completion.identity);
		if (data.cancelled) {
			dispatchSessionToast(
				childIdentity,
				"info",
				tt("session.forkCancelled"),
				nextBrowserEffectKey("session-fork-cancelled"),
			);
			return false;
		}
		dispatchSessionToast(
			childIdentity,
			"success",
			tt("session.forked"),
			nextBrowserEffectKey("session-forked"),
		);
		return true;
	} catch (error) {
		if (parentIdentity) {
			dispatchCurrentSessionBrowserToast(
				parentIdentity,
				"error",
				tt("session.forkFailed"),
				nextBrowserEffectKey("session-fork-failed"),
				displayError(error),
			);
		}
		return false;
	}
}

export type { ImageContent };
