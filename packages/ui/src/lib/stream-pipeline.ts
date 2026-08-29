import type {
	FutureProductSessionEventDto,
	SessionEventDto,
	SessionRuntimeDto,
	SessionWsServerMessage,
} from "@pi-agent-web/protocol";
import { toast } from "sonner";
import { migrateComposerHistory } from "../features/composer/use-composer-history";
import { useComposerStore } from "../stores/composer";
import { useExtensionUiStore } from "../stores/extension-ui";
import { useModelDirectoryStore } from "../stores/model-directory";
import { useProjectionStore } from "../stores/projection";
import { reconcileHiddenSessionLifecycle, useSessionDirectoryStore } from "../stores/session-directory";
import type { SessionFrameBusMessage, SessionFrameProductMode } from "../stores/session-frame-bus";
import { useSessionStatsStore } from "../stores/session-stats";
import { hasFreshLeaseBaseline, SESSION_FRAME_DEFERRED, sessionTransport } from "../stores/session-transport";
import { useSlashCommandsStore } from "../stores/slash-commands";
import { playAttentionChime, playCompletionChime } from "./audio-feedback";
import { displayLabel, stripAnsi } from "./format";
import { tt } from "./i18n";
import { runtimeIsBusy, runtimeIsSettled, runtimePhase } from "./runtime-state";
import { isSoftIdempotentError } from "./session-controller";
import { type CoalescibleMessageUpdate, SessionEventScheduler } from "./session-event-scheduler";
import { updateTabBadge } from "./tab-badge";

type ProjectionSessionEvent = SessionEventDto | FutureProductSessionEventDto;

let initialized = false;
const directoryReloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeMessageIdentities = new Map<string, { generation: number; identity: string }>();

const projectionEventScheduler = new SessionEventScheduler({
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
export function initPipeline(): void {
	if (initialized) return;
	initialized = true;

	sessionTransport.frameBus.subscribeAll((frame) => routeSessionFrame(frame.message, frame.productMode));
	sessionTransport.globalBus.subscribe((message) => {
		if (message.type === "hot_runtime_inventory") {
			useSessionDirectoryStore.getState().applyHotRuntimeInventory(message);
		} else if (message.type === "session_directory_changed") {
			scheduleDirectoryReload(message.workspaceId);
		} else {
			void refreshModelsAfterAuthChange();
		}
	});
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", () => projectionEventScheduler.handleVisibilityChange());
	}
	sessionTransport.store.getState().connect();
}

function routeSessionFrame(
	message: SessionFrameBusMessage,
	productMode: SessionFrameProductMode,
): void | typeof SESSION_FRAME_DEFERRED {
	switch (message.type) {
		case "event":
			return routeEvent(message, productMode);
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
				productMode,
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
			applyVisibleExtensionTitle(message.sessionHandle);
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
				.prependHistoricalMessages(message.sessionHandle, message.messages, productMode);
			return;
		case "session_rekeyed":
			projectionEventScheduler.discardSession(message.previousSessionHandle);
			projectionEventScheduler.discardSession(message.runtime.sessionHandle);
			activeMessageIdentities.delete(message.previousSessionHandle);
			activeMessageIdentities.delete(message.runtime.sessionHandle);
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
		toast.error(tt("status.crashed"), { description: stripAnsi(runtime.error ?? "") });
	}
	if (isCurrentSession(runtime.sessionHandle)) {
		if (phase === "waiting_ui") {
			updateTabBadge("waiting_ui", sessionLabel(runtime.sessionHandle));
		} else if (busy) {
			updateTabBadge("running", sessionLabel(runtime.sessionHandle));
		} else if (phase === "ready" || phase === "dormant") {
			updateTabBadge("idle", sessionLabel(runtime.sessionHandle));
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
	message: Extract<SessionWsServerMessage, { type: "lease_status" }>,
): void {
	const channel = sessionTransport.store.getState().sessions[message.sessionHandle];
	const runtime = channel?.runtime;
	if (!runtime || !hasFreshLeaseBaseline(channel)) return;
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
			current.runtime.generation !== runtime.generation
		) {
			return;
		}
		reconcileHiddenSessionLifecycle(runtime.sessionHandle);
	});
}

function routeEvent(
	message: Extract<SessionFrameBusMessage, { type: "event" }>,
	productMode: SessionFrameProductMode,
): void | typeof SESSION_FRAME_DEFERRED {
	const { event, generation, seq, sessionHandle, workspaceId } = message;
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
			scheduleDirectoryReload(workspaceId);
			return;
		case "message_update":
			applyLiveUsage(sessionHandle, event);
			break;
		case "agent_settled":
			useSessionDirectoryStore.getState().markSessionUnread(sessionHandle);
			void useSessionStatsStore.getState().refresh(sessionHandle);
			scheduleDirectoryReload(workspaceId);
			void playCompletionChime();
			if (isCurrentSession(sessionHandle)) {
				updateTabBadge("done", sessionLabel(sessionHandle));
			}
			break;
		case "compaction_end":
			void useSessionStatsStore.getState().refresh(sessionHandle);
			break;
		case "extension_error":
			if (isCurrentSession(sessionHandle)) {
				toast.error(tt("ext.error"), {
					description: `${stripAnsi(event.event)}: ${stripAnsi(event.error)}`,
				});
			}
			return;
		case "bash_execution_update":
			return;
		default:
			break;
	}

	useProjectionStore.getState().applyEvent(sessionHandle, event, productMode);
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
	message: Extract<SessionWsServerMessage, { type: "extension_ui_request" }>,
): void {
	const { request, sessionHandle, generation } = message;
	if (request.method === "notify") {
		const prefix = isCurrentSession(sessionHandle) ? "" : `${sessionLabel(sessionHandle)} · `;
		const text = `${prefix}${stripAnsi(request.message)}`;
		if (request.notifyType === "error") toast.error(text);
		else if (request.notifyType === "warning") toast.warning(text);
		else toast.info(text);
		return;
	}
	useExtensionUiStore.getState().applyRequestForSession(sessionHandle, request, generation);
	applyVisibleExtensionTitle(sessionHandle);
	void playAttentionChime();
	if (isCurrentSession(sessionHandle)) {
		updateTabBadge("waiting_ui", sessionLabel(sessionHandle));
	}
}

function routeRekey(previousSessionHandle: string, runtime: SessionRuntimeDto): void {
	useComposerStore.getState().rekeySession(previousSessionHandle, runtime.sessionHandle);
	migrateComposerHistory(runtime.workspaceId, previousSessionHandle, runtime.sessionHandle);
	useSessionDirectoryStore.getState().rekeySession(previousSessionHandle, runtime.sessionHandle, runtime);
	useExtensionUiStore.getState().resetSessionForGeneration(runtime.sessionHandle, runtime.generation);
	scheduleDirectoryReload(runtime.workspaceId);
}

function routeSessionError(message: Extract<SessionWsServerMessage, { type: "session_error" }>): void {
	if (!isCurrentSession(message.sessionHandle)) return;
	if (message.operation === "claim") {
		toast.info(tt("lease.observer"), { description: stripAnsi(message.error) });
		return;
	}
	if (isSoftIdempotentError(message.error)) {
		return;
	}
	toast.error(stripAnsi(message.error));
}

async function refreshSessionMetadata(sessionHandle: string): Promise<void> {
	await Promise.allSettled([
		useSlashCommandsStore.getState().refresh(sessionHandle),
		useModelDirectoryStore.getState().refresh(sessionHandle),
		useSessionStatsStore.getState().refresh(sessionHandle),
	]);
}

function scheduleDirectoryReload(workspaceHandle: string): void {
	if (directoryReloadTimers.has(workspaceHandle)) return;
	const timer = setTimeout(() => {
		directoryReloadTimers.delete(workspaceHandle);
		const directory = useSessionDirectoryStore.getState();
		void directory.loadWorkspaces();
		if (
			directory.currentWorkspaceHandle === workspaceHandle ||
			directory.sessionsByWorkspace[workspaceHandle]
		) {
			void directory.reloadSessions(workspaceHandle, { force: true });
		}
	}, 100);
	directoryReloadTimers.set(workspaceHandle, timer);
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

function applyVisibleExtensionTitle(sessionHandle: string): void {
	if (typeof document === "undefined" || !isCurrentSession(sessionHandle)) return;
	const title = useExtensionUiStore.getState().bySession[sessionHandle]?.title;
	document.title = title ? `${displayLabel(title)} · Pi Agent Web` : "Pi Agent Web";
}
