import type {
	InlineSessionWsServerMessage,
	PiSessionEventDto,
	ProductSessionEventDto,
	SessionRuntimeDto,
	SessionRuntimeIdentityDto,
} from "@pi-agent-web/protocol";
import { migrateComposerHistory } from "../features/composer/use-composer-history";
import { useComposerStore } from "../stores/composer";
import { useExtensionUiStore } from "../stores/extension-ui";
import { useModelDirectoryStore } from "../stores/model-directory";
import { useProjectionStore } from "../stores/projection";
import { useSessionControlStore } from "../stores/session-control";
import { reconcileHiddenSessionLifecycle, useSessionDirectoryStore } from "../stores/session-directory";
import type { SessionFrameBusMessage, SessionFrameRepresentation } from "../stores/session-frame-bus";
import { useSessionStatsStore } from "../stores/session-stats";
import { hasFreshLeaseBaseline, SESSION_FRAME_DEFERRED, sessionTransport } from "../stores/session-transport";
import { useSlashCommandsStore } from "../stores/slash-commands";
import { displayLabel, stripAnsi } from "./format";
import { tt } from "./i18n";
import { runtimeIsBusy, runtimeIsSettled, runtimePhase } from "./runtime-state";
import {
	createSessionBrowserIdentity,
	createWorkspaceBrowserIdentity,
	getSessionBrowserEffects,
	type SessionBrowserEffects,
	type SessionBrowserIdentity,
	setSessionBrowserEffects,
} from "./session-browser-effects";
import { isSoftIdempotentError } from "./session-controller";
import { type CoalescibleMessageUpdate, SessionEventScheduler } from "./session-event-scheduler";
import type { TabStatus } from "./tab-badge";

type ProjectionSessionEvent = PiSessionEventDto | ProductSessionEventDto;

let initialized = false;
const activeMessageIdentities = new Map<string, { generation: number; identity: string }>();
const publicationMode =
	import.meta.env.VITE_PI_WEB_BENCHMARK_BUILD === "1" &&
	import.meta.env.VITE_PI_WEB_BENCHMARK_VARIANT === "sequential"
		? "sequential"
		: "coalesced";

const projectionEventScheduler = new SessionEventScheduler({
	publicationMode,
	onFlush: (sessionHandle, generation, events) => {
		const channel = sessionTransport.store.getState().sessions[sessionHandle];
		if (
			channel?.generation !== generation ||
			(channel.resync && !sessionTransport.isSnapshotSuffixProjectionPending(sessionHandle, generation))
		) {
			return;
		}
		try {
			const latest = events.at(-1);
			if (latest) applyLiveUsage(sessionHandle, latest);
			useProjectionStore.getState().applyEvents(sessionHandle, events);
		} catch (error) {
			activeMessageIdentities.delete(sessionHandle);
			sessionTransport.reportProjectionFailure(sessionHandle, generation, error);
			return;
		}
		sessionTransport.confirmProjectionDelivery(sessionHandle, generation);
	},
});

/**
 * Route the multiplexed Session stream into Session-keyed domain stores.
 * Selection is only a display pointer; background Sessions never depend on it
 * for event ingestion.
 */
export function initPipeline(options: { effects?: SessionBrowserEffects } = {}): void {
	if (options.effects) setSessionBrowserEffects(options.effects);
	if (initialized) return;
	initialized = true;

	sessionTransport.frameBus.subscribeAll((frame) => routeSessionFrame(frame.message, frame.representation));
	sessionTransport.globalBus.subscribe((message) => {
		if (message.type === "hot_runtime_inventory") {
			useSessionDirectoryStore.getState().applyHotRuntimeInventory(message);
		} else if (message.type === "session_directory_changed") {
			scheduleWorkspaceDirectoryReload(message.workspaceId);
		} else {
			void refreshModelsAfterAuthChange();
		}
	});
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", () => projectionEventScheduler.handleVisibilityChange());
	}
	sessionTransport.store.getState().connect();
}

function sameBrowserIdentity(left: SessionBrowserIdentity, right: SessionBrowserIdentity): boolean {
	return (
		left.serverEpoch === right.serverEpoch &&
		left.workspaceId === right.workspaceId &&
		left.sessionHandle === right.sessionHandle &&
		left.generation === right.generation
	);
}

function syncBrowserEffectIdentity(identity: SessionRuntimeIdentityDto): SessionBrowserIdentity {
	const effects = getSessionBrowserEffects();
	const next = createSessionBrowserIdentity(identity);
	const current = effects.currentIdentity(next.sessionHandle);
	if (
		current &&
		current.serverEpoch === next.serverEpoch &&
		current.workspaceId === next.workspaceId &&
		next.generation < current.generation
	) {
		return current;
	}
	if (current && !sameBrowserIdentity(current, next)) effects.invalidateIdentity(current);
	effects.setCurrentIdentity(next);
	return next;
}

function sessionBrowserIdentityForHandle(sessionHandle: string): SessionBrowserIdentity | null {
	const runtime = sessionTransport.store.getState().sessions[sessionHandle]?.runtime;
	return runtime ? createSessionBrowserIdentity(runtime) : null;
}

function dispatchSessionToast(
	identity: SessionBrowserIdentity,
	level: "info" | "success" | "warning" | "error",
	message: string,
	dedupeKey: string,
	description?: string,
): void {
	getSessionBrowserEffects().dispatch({
		type: "toast",
		identity,
		level,
		message,
		dedupeKey,
		...(description ? { description } : {}),
	});
}

function dispatchSessionAudio(
	identity: SessionBrowserIdentity,
	sound: "attention" | "completion",
	dedupeKey: string,
): void {
	getSessionBrowserEffects().dispatch({ type: "audio", identity, sound, dedupeKey });
}

function dispatchSessionTabBadge(identity: SessionBrowserIdentity, status: TabStatus, label: string): void {
	getSessionBrowserEffects().dispatch({
		type: "tab_badge",
		identity,
		status,
		label,
		dedupeKey: `tab-badge:${status}:${label}`,
	});
}

function dispatchSessionDirectoryRefresh(identity: SessionBrowserIdentity, workspaceHandle: string): void {
	getSessionBrowserEffects().dispatch({
		type: "directory_refresh",
		identity,
		workspaceHandle,
		force: true,
		delayMs: 100,
		dedupeKey: "directory-refresh",
	});
}

function scheduleWorkspaceDirectoryReload(workspaceHandle: string): void {
	const identity = createWorkspaceBrowserIdentity({ workspaceId: workspaceHandle });
	const effects = getSessionBrowserEffects();
	effects.setCurrentWorkspaceIdentity(identity);
	effects.dispatch({
		type: "directory_refresh",
		workspaceIdentity: identity,
		workspaceHandle,
		force: true,
		delayMs: 100,
		dedupeKey: "directory-refresh",
	});
}

function routeSessionFrame(
	message: SessionFrameBusMessage,
	representation: SessionFrameRepresentation,
): void | typeof SESSION_FRAME_DEFERRED {
	switch (message.type) {
		case "event":
			return routeEvent(message, representation);
		case "extension_ui_request":
			projectionEventScheduler.flushSession(message.sessionHandle, message.generation);
			routeExtensionRequest(message);
			return;
		case "extension_ui_closed":
			projectionEventScheduler.flushSession(message.sessionHandle, message.generation);
			useExtensionUiStore.getState().closeRequestForSession(message.sessionHandle, message.requestId);
			return;
		case "extension_ui_snapshot":
			projectionEventScheduler.flushSession(message.sessionHandle, message.generation);
			useExtensionUiStore
				.getState()
				.replaceRequestsForSession(message.sessionHandle, message.generation, message.requests);
			applyVisibleExtensionTitle(message.sessionHandle);
			return;
		case "extension_ui_result":
			projectionEventScheduler.flushSession(message.sessionHandle, message.generation);
			if (message.outcome !== "accepted") {
				useExtensionUiStore.getState().closeRequestForSession(message.sessionHandle, message.requestId);
			}
			return;
		case "runtime_state":
			projectionEventScheduler.flushSession(message.runtime.sessionHandle, message.runtime.generation);
			routeRuntime(message.runtime);
			return;
		case "lease_status":
			projectionEventScheduler.flushSession(message.sessionHandle);
			useSessionControlStore.getState().observeLeaseStatus(message);
			scheduleHiddenLifecycleAfterLease(message);
			return;
		case "resync_required":
			projectionEventScheduler.discardSession(message.sessionHandle);
			activeMessageIdentities.delete(message.sessionHandle);
			return;
		case "session_snapshot":
			projectionEventScheduler.discardSession(message.sessionHandle);
			activeMessageIdentities.delete(message.sessionHandle);
			routeRuntime(message.runtime, false);
			useProjectionStore.getState().applyAuthoritativeSnapshot(
				message.sessionHandle,
				message.settledMessages,
				message.projectionEvents.map((frame) => frame.event),
				representation,
			);
			useComposerStore.getState().setQueueForSession(message.sessionHandle, {
				steering: [...message.queue.steering],
				followUp: [...message.queue.followUp],
			});
			useExtensionUiStore
				.getState()
				.replaceRequestsForSession(message.sessionHandle, message.generation, [
					...message.pendingExtensionRequests,
					...message.stickyExtensionState,
				]);
			applyVisibleExtensionTitle(message.sessionHandle, message);
			void refreshSessionMetadata(message.sessionHandle);
			scheduleHiddenLifecycleAfterSnapshot(message.runtime);
			return;
		case "session_snapshot_begin":
		case "session_snapshot_chunk":
		case "session_snapshot_end":
		case "session_history_page_begin":
		case "session_history_page_chunk":
		case "session_history_page_end":
			// The transport assembles these frames and emits one atomic product snapshot/page.
			return;
		case "session_history_page_loaded":
			projectionEventScheduler.flushSession(message.sessionHandle, message.generation);
			useProjectionStore
				.getState()
				.prependHistoricalMessages(message.sessionHandle, message.messages, representation);
			return;
		case "session_rekeyed":
			projectionEventScheduler.discardSession(message.previousSessionHandle);
			projectionEventScheduler.discardSession(message.runtime.sessionHandle);
			activeMessageIdentities.delete(message.previousSessionHandle);
			activeMessageIdentities.delete(message.runtime.sessionHandle);
			useSessionControlStore.getState().resetSession(message.previousSessionHandle);
			useSessionControlStore.getState().resetSession(message.runtime.sessionHandle);
			routeRekey(message.previousSessionHandle, message.runtime);
			return;
		case "session_error":
			projectionEventScheduler.flushSession(message.sessionHandle);
			routeSessionError(message);
			return;
	}
}

function routeRuntime(runtime: SessionRuntimeDto, reconcileHidden = true): void {
	const phase = runtimePhase(runtime);
	const settled = runtimeIsSettled(runtime);
	const busy = runtimeIsBusy(runtime);
	const browserIdentity = syncBrowserEffectIdentity(runtime);
	const identity = activeMessageIdentities.get(runtime.sessionHandle);
	if (identity && (identity.generation !== runtime.generation || settled)) {
		activeMessageIdentities.delete(runtime.sessionHandle);
	}
	useSessionDirectoryStore.getState().applyRuntime(runtime);
	useExtensionUiStore.getState().resetSessionForGeneration(runtime.sessionHandle, runtime.generation);
	if (phase === "crashed") {
		useProjectionStore.getState().markRuntimeFailure(runtime.sessionHandle, stripAnsi(runtime.error ?? ""));
	}
	if (reconcileHidden && !isCurrentSession(runtime.sessionHandle) && settled) {
		reconcileHiddenSessionLifecycle(runtime.sessionHandle);
	}
	if (phase === "crashed" && isCurrentSession(runtime.sessionHandle)) {
		dispatchSessionToast(
			browserIdentity,
			"error",
			tt("status.crashed"),
			"runtime-crashed",
			stripAnsi(runtime.error ?? ""),
		);
	}
	if (isCurrentSession(runtime.sessionHandle)) {
		if (phase === "waiting_ui") {
			dispatchSessionTabBadge(browserIdentity, "waiting_ui", sessionLabel(runtime.sessionHandle));
		} else if (busy) {
			dispatchSessionTabBadge(browserIdentity, "running", sessionLabel(runtime.sessionHandle));
		} else if (phase === "ready" || phase === "dormant") {
			dispatchSessionTabBadge(browserIdentity, "idle", sessionLabel(runtime.sessionHandle));
		}
	}
}

function scheduleHiddenLifecycleAfterSnapshot(runtime: SessionRuntimeDto): void {
	if (!runtimeIsSettled(runtime)) return;
	// The transport marks the baseline authoritative only after every synchronous
	// snapshot listener commits. Reconcile on the next microtask and fence the
	// captured incarnation so a visible switch or rekey cancels stale cleanup.
	queueMicrotask(() => {
		const channel = sessionTransport.store.getState().sessions[runtime.sessionHandle];
		if (
			!channel?.subscribed ||
			!channel.baselineAuthoritative ||
			!hasFreshLeaseBaseline(channel) ||
			channel.resync !== null ||
			channel.runtime?.serverEpoch !== runtime.serverEpoch ||
			channel.runtime.workspaceId !== runtime.workspaceId ||
			channel.runtime.sessionHandle !== runtime.sessionHandle ||
			channel.runtime.generation !== runtime.generation
		) {
			return;
		}
		reconcileHiddenSessionLifecycle(runtime.sessionHandle);
	});
}

function scheduleHiddenLifecycleAfterLease(
	message: Extract<InlineSessionWsServerMessage, { type: "lease_status" }>,
): void {
	// A recipient-local observer status is not lifecycle authority. In particular, a remote
	// controller transition must never cause this Browser to release or unsubscribe a hidden Session.
	if (!message.isController) return;
	const channel = sessionTransport.store.getState().sessions[message.sessionHandle];
	const runtime = channel?.runtime;
	if (
		!runtime ||
		!hasFreshLeaseBaseline(channel) ||
		channel.lease.conflicted === true ||
		channel.lease.leaseRevision !== message.leaseRevision ||
		channel.lease.controlState !== message.controlState ||
		channel.lease.transition !== message.transition ||
		channel.lease.fencingToken !== message.fencingToken
	) {
		return;
	}
	queueMicrotask(() => {
		const current = sessionTransport.store.getState().sessions[message.sessionHandle];
		if (
			!current?.subscribed ||
			!current.baselineAuthoritative ||
			!hasFreshLeaseBaseline(current) ||
			current.resync !== null ||
			current.runtime?.serverEpoch !== runtime.serverEpoch ||
			current.runtime.workspaceId !== runtime.workspaceId ||
			current.runtime.sessionHandle !== runtime.sessionHandle ||
			current.runtime.generation !== runtime.generation ||
			!current.lease.isController ||
			current.lease.conflicted === true ||
			current.lease.leaseRevision !== message.leaseRevision ||
			current.lease.controlState !== message.controlState ||
			current.lease.transition !== message.transition ||
			current.lease.fencingToken !== message.fencingToken
		) {
			return;
		}
		reconcileHiddenSessionLifecycle(runtime.sessionHandle);
	});
}

function routeEvent(
	message: Extract<SessionFrameBusMessage, { type: "event" }>,
	representation: SessionFrameRepresentation,
): void | typeof SESSION_FRAME_DEFERRED {
	const { event, generation, seq, sessionHandle, workspaceId } = message;
	const browserIdentity = createSessionBrowserIdentity(message);
	const coalescible = coalescibleMessageUpdate(event);
	if (coalescible) {
		const enqueueResult = projectionEventScheduler.enqueue(
			sessionHandle,
			generation,
			currentMessageIdentity(sessionHandle, generation),
			coalescible,
		);
		if (enqueueResult === "rejected") throw new Error("Projection scheduler rejected a live event");
		return enqueueResult === "deferred" ? SESSION_FRAME_DEFERRED : undefined;
	}

	// Every structural event is an ordering boundary. Publish preceding deltas
	// synchronously before tools, turn settlement, dialogs, errors, or snapshots.
	projectionEventScheduler.flushSession(sessionHandle, generation);
	if (
		sessionTransport.store.getState().sessions[sessionHandle]?.resync?.requiresFreshBaseline &&
		!sessionTransport.isSnapshotSuffixProjectionPending(sessionHandle, generation)
	) {
		return SESSION_FRAME_DEFERRED;
	}
	if (
		(event.type === "message_start" && event.message.role === "assistant") ||
		(event.type === "message_update" && event.assistantMessageEvent.type === "start")
	) {
		activeMessageIdentities.set(sessionHandle, {
			generation,
			identity: `${String(generation)}:${String(seq)}`,
		});
	}
	switch (event.type) {
		case "queue_update":
			useComposerStore.getState().setQueueForSession(sessionHandle, {
				steering: [...event.steering],
				followUp: [...event.followUp],
			});
			return;
		case "thinking_level_changed":
			useModelDirectoryStore.getState().applyThinkingLevelForSession(sessionHandle, event.level);
			return;
		case "session_info_changed":
			dispatchSessionDirectoryRefresh(browserIdentity, workspaceId);
			return;
		case "message_update":
			applyLiveUsage(sessionHandle, event);
			break;
		case "agent_settled":
			useSessionDirectoryStore.getState().markSessionUnread(sessionHandle);
			void useSessionStatsStore.getState().refresh(sessionHandle);
			dispatchSessionDirectoryRefresh(browserIdentity, workspaceId);
			dispatchSessionAudio(browserIdentity, "completion", "agent-settled");
			if (isCurrentSession(sessionHandle)) {
				dispatchSessionTabBadge(browserIdentity, "done", sessionLabel(sessionHandle));
			}
			break;
		case "compaction_end":
			void useSessionStatsStore.getState().refresh(sessionHandle);
			break;
		case "extension_error":
			if (isCurrentSession(sessionHandle)) {
				dispatchSessionToast(
					browserIdentity,
					"error",
					tt("ext.error"),
					`extension-error:${String(seq)}`,
					`${stripAnsi(event.event)}: ${stripAnsi(event.error)}`,
				);
			}
			return;
		case "bash_execution_update":
			return;
		default:
			break;
	}

	useProjectionStore.getState().applyEvent(sessionHandle, event, representation);
	if (
		(event.type === "message_end" && event.message.role === "assistant") ||
		(event.type === "message_update" &&
			(event.assistantMessageEvent.type === "done" || event.assistantMessageEvent.type === "error")) ||
		event.type === "turn_end" ||
		event.type === "agent_settled"
	) {
		activeMessageIdentities.delete(sessionHandle);
	}
}

function coalescibleMessageUpdate(event: ProjectionSessionEvent): CoalescibleMessageUpdate | null {
	if (event.type !== "message_update") return null;
	const inner = event.assistantMessageEvent;
	if (inner.type !== "text_delta" && inner.type !== "thinking_delta" && inner.type !== "toolcall_delta") {
		return null;
	}
	return {
		type: "message_update",
		usage: event.usage,
		assistantMessageEvent: inner,
	};
}

function currentMessageIdentity(sessionHandle: string, generation: number): string {
	const active = activeMessageIdentities.get(sessionHandle);
	return active?.generation === generation ? active.identity : `${String(generation)}:unframed`;
}

function applyLiveUsage(
	sessionHandle: string,
	event: Extract<ProjectionSessionEvent, { type: "message_update" }>,
): void {
	useSessionStatsStore.getState().applyLiveUsageForSession(sessionHandle, {
		input: event.usage.input,
		output: event.usage.output,
		totalTokens: event.usage.totalTokens,
	});
}

function routeExtensionRequest(
	message: Extract<InlineSessionWsServerMessage, { type: "extension_ui_request" }>,
): void {
	const { request, sessionHandle, generation } = message;
	const browserIdentity = createSessionBrowserIdentity(message);
	if (request.method === "notify") {
		const prefix = isCurrentSession(sessionHandle) ? "" : `${sessionLabel(sessionHandle)} · `;
		const text = `${prefix}${stripAnsi(request.message)}`;
		const level = request.notifyType ?? "info";
		dispatchSessionToast(browserIdentity, level, text, `extension-notify:${request.id}`);
		return;
	}
	useExtensionUiStore.getState().applyRequestForSession(sessionHandle, request, generation);
	applyVisibleExtensionTitle(sessionHandle, browserIdentity);
	dispatchSessionAudio(browserIdentity, "attention", `extension-attention:${request.id}`);
	if (isCurrentSession(sessionHandle)) {
		dispatchSessionTabBadge(browserIdentity, "waiting_ui", sessionLabel(sessionHandle));
	}
}

function routeRekey(previousSessionHandle: string, runtime: SessionRuntimeDto): void {
	const browserIdentity = syncBrowserEffectIdentity(runtime);
	useComposerStore.getState().rekeySession(previousSessionHandle, runtime.sessionHandle);
	migrateComposerHistory(runtime.workspaceId, previousSessionHandle, runtime.sessionHandle);
	useSessionDirectoryStore.getState().rekeySession(previousSessionHandle, runtime.sessionHandle, runtime);
	useExtensionUiStore.getState().resetSessionForGeneration(runtime.sessionHandle, runtime.generation);
	dispatchSessionDirectoryRefresh(browserIdentity, runtime.workspaceId);
}

function routeSessionError(message: Extract<InlineSessionWsServerMessage, { type: "session_error" }>): void {
	useSessionControlStore.getState().recordSessionError(message);
	if (!isCurrentSession(message.sessionHandle)) return;
	const browserIdentity = sessionBrowserIdentityForHandle(message.sessionHandle);
	if (!browserIdentity) return;
	if (message.operation === "claim") {
		dispatchSessionToast(
			browserIdentity,
			"info",
			tt("lease.observer"),
			`session-error:claim:${message.code ?? message.error}`,
			stripAnsi(message.error),
		);
		return;
	}
	if (isSoftIdempotentError(message.error)) {
		return;
	}
	dispatchSessionToast(
		browserIdentity,
		"error",
		stripAnsi(message.error),
		`session-error:${message.operation}:${message.code ?? message.error}`,
	);
}

async function refreshSessionMetadata(sessionHandle: string): Promise<void> {
	await Promise.allSettled([
		useSlashCommandsStore.getState().refresh(sessionHandle),
		useModelDirectoryStore.getState().refresh(sessionHandle),
		useSessionStatsStore.getState().refresh(sessionHandle),
	]);
}

async function refreshModelsAfterAuthChange(): Promise<void> {
	const sessionHandle = useSessionDirectoryStore.getState().currentSession?.sessionHandle;
	if (!sessionHandle) return;
	const deadline = Date.now() + 20_000;
	for (;;) {
		await useModelDirectoryStore.getState().refresh(sessionHandle);
		if (useModelDirectoryStore.getState().bySession[sessionHandle]?.models.length || Date.now() >= deadline) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 2_500));
	}
}

function isCurrentSession(sessionHandle: string): boolean {
	return useSessionDirectoryStore.getState().currentSession?.sessionHandle === sessionHandle;
}

function sessionLabel(sessionHandle: string): string {
	const directory = useSessionDirectoryStore.getState();
	for (const sessions of Object.values(directory.sessionsByWorkspace)) {
		const session = sessions.find((candidate) => candidate.sessionHandle === sessionHandle);
		if (session) return displayLabel(session.name || session.firstMessage || tt("header.unnamed"));
	}
	return tt("header.unnamed");
}

function applyVisibleExtensionTitle(sessionHandle: string, identity?: SessionBrowserIdentity): void {
	if (!isCurrentSession(sessionHandle)) return;
	const browserIdentity = identity ?? sessionBrowserIdentityForHandle(sessionHandle);
	if (!browserIdentity) return;
	const title = useExtensionUiStore.getState().bySession[sessionHandle]?.title;
	getSessionBrowserEffects().dispatch({
		type: "title",
		identity: browserIdentity,
		dedupeKey: `extension-title:${title ?? ""}`,
		title: title ? `${displayLabel(title)} · Pi Agent Web` : "Pi Agent Web",
	});
}
