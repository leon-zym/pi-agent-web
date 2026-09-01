import type {
	InlineSessionWsServerMessage,
	PiSessionEventDto,
	ProductSessionEventDto,
	SessionRuntimeDto,
} from "@pi-agent-web/protocol";
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
import type { SessionBrowserEffect } from "./session-browser-effects";
import { isSoftIdempotentError } from "./session-controller";
import { type CoalescibleMessageUpdate, SessionEventScheduler } from "./session-event-scheduler";
import { sessionLifecycleIdentityForRuntime, sessionStateOwners } from "./session-state-owners";

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
export function initPipeline(): void {
	if (initialized) return;
	sessionStateOwners.assertReady();
	initialized = true;

	sessionTransport.frameBus.subscribeAll((frame) => routeSessionFrame(frame.message, frame.representation));
	sessionTransport.globalBus.subscribe((message) => {
		if (message.type === "hot_runtime_inventory") {
			useSessionDirectoryStore.getState().applyHotRuntimeInventory(message);
		} else if (message.type === "session_directory_changed") {
			dispatchDirectoryRefreshForWorkspace(message.workspaceId);
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
			dispatchVisibleExtensionTitle(message.sessionHandle, runtimeForSessionHandle(message.sessionHandle));
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
		case "session_snapshot": {
			projectionEventScheduler.discardSession(message.sessionHandle);
			activeMessageIdentities.delete(message.sessionHandle);
			const snapshotResult = sessionStateOwners.applySnapshot({
				identity: sessionLifecycleIdentityForRuntime(message.runtime),
				runtime: message.runtime,
				settledMessages: message.settledMessages,
				projectionEvents: message.projectionEvents.map((frame) => frame.event),
				representation,
				queue: {
					steering: [...message.queue.steering],
					followUp: [...message.queue.followUp],
				},
				extensionRequests: [...message.pendingExtensionRequests, ...message.stickyExtensionState],
			});
			if (snapshotResult.status !== "committed") {
				if (snapshotResult.error.code === "commit_failed") return;
				if (
					snapshotResult.error.code === "identity_mismatch" ||
					snapshotResult.error.code === "invalid_identity"
				) {
					return;
				}
				throw snapshotResult.error;
			}
			dispatchRuntimeEffects(message.runtime);
			dispatchVisibleExtensionTitle(message.sessionHandle, message.runtime);
			void refreshSessionMetadata(message.sessionHandle);
			scheduleHiddenLifecycleAfterSnapshot(message.runtime);
			return;
		}
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
			routeRekey(message.previousSessionHandle, message.runtime);
			return;
		case "session_error":
			projectionEventScheduler.flushSession(message.sessionHandle);
			routeSessionError(message);
			return;
	}
}

function routeRuntime(runtime: SessionRuntimeDto, reconcileHidden = true): void {
	const settled = runtimeIsSettled(runtime);
	const identity = activeMessageIdentities.get(runtime.sessionHandle);
	if (identity && (identity.generation !== runtime.generation || settled)) {
		activeMessageIdentities.delete(runtime.sessionHandle);
	}
	sessionStateOwners.applyRuntime(runtime);
	if (reconcileHidden && !isCurrentSession(runtime.sessionHandle) && settled) {
		reconcileHiddenSessionLifecycle(runtime.sessionHandle);
	}
	dispatchRuntimeEffects(runtime);
}

function dispatchRuntimeEffects(runtime: SessionRuntimeDto): void {
	const phase = runtimePhase(runtime);
	const busy = runtimeIsBusy(runtime);
	if (phase === "crashed" && isCurrentSession(runtime.sessionHandle)) {
		dispatchEffect({
			type: "toast",
			identity: sessionLifecycleIdentityForRuntime(runtime),
			dedupeKey: `runtime-crashed:${String(runtime.generation)}`,
			level: "error",
			message: tt("status.crashed"),
			description: stripAnsi(runtime.error ?? ""),
		});
	}
	if (isCurrentSession(runtime.sessionHandle)) {
		if (phase === "waiting_ui") {
			dispatchTabBadge(runtime, "waiting_ui");
		} else if (busy) {
			dispatchTabBadge(runtime, "running");
		} else if (phase === "ready" || phase === "dormant") {
			dispatchTabBadge(runtime, "idle");
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
			dispatchDirectoryRefresh(message, workspaceId);
			return;
		case "message_update":
			applyLiveUsage(sessionHandle, event);
			break;
		case "agent_settled":
			useSessionDirectoryStore.getState().markSessionUnread(sessionHandle);
			void useSessionStatsStore.getState().refresh(sessionHandle);
			dispatchDirectoryRefresh(message, workspaceId);
			dispatchEffect({
				type: "audio",
				identity: sessionIdentityForFrame(message),
				dedupeKey: `completion:${String(generation)}:${String(seq)}`,
				sound: "completion",
			});
			if (isCurrentSession(sessionHandle)) dispatchTabBadgeForFrame(message, "done");
			break;
		case "compaction_end":
			void useSessionStatsStore.getState().refresh(sessionHandle);
			break;
		case "extension_error":
			if (isCurrentSession(sessionHandle)) {
				dispatchEffect({
					type: "toast",
					identity: sessionIdentityForFrame(message),
					dedupeKey: `extension-error:${String(generation)}:${String(seq)}`,
					level: "error",
					message: tt("ext.error"),
					description: `${stripAnsi(event.event)}: ${stripAnsi(event.error)}`,
				});
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
	if (request.method === "notify") {
		const prefix = isCurrentSession(sessionHandle) ? "" : `${sessionLabel(sessionHandle)} · `;
		const text = `${prefix}${stripAnsi(request.message)}`;
		dispatchEffect({
			type: "toast",
			identity: sessionIdentityForFrame(message),
			dedupeKey: `notify:${String(message.generation)}:${request.id}`,
			level: request.notifyType === "error" ? "error" : request.notifyType === "warning" ? "warning" : "info",
			message: text,
		});
		return;
	}
	useExtensionUiStore.getState().applyRequestForSession(sessionHandle, request, generation);
	dispatchVisibleExtensionTitle(sessionHandle, runtimeForSessionHandle(sessionHandle));
	dispatchEffect({
		type: "audio",
		identity: sessionIdentityForFrame(message),
		dedupeKey: `attention:${String(generation)}:${request.id}`,
		sound: "attention",
	});
	if (isCurrentSession(sessionHandle)) {
		dispatchTabBadgeForFrame(message, "waiting_ui");
	}
}

function routeRekey(previousSessionHandle: string, runtime: SessionRuntimeDto): void {
	const previousIdentity =
		sessionStateOwners.registry.currentIdentity(previousSessionHandle) ??
		sessionIdentityForHandle(previousSessionHandle, runtime);
	const result = sessionStateOwners.rekeySession({
		previousIdentity,
		identity: sessionLifecycleIdentityForRuntime(runtime),
		runtime,
		effects: [directoryRefreshEffect(runtime, "rekey")],
	});
	if (result.status !== "committed") {
		if (result.error.code === "identity_mismatch" || result.error.code === "invalid_identity") return;
		throw result.error;
	}
}

function routeSessionError(message: Extract<InlineSessionWsServerMessage, { type: "session_error" }>): void {
	useSessionControlStore.getState().recordSessionError(message);
	if (!isCurrentSession(message.sessionHandle)) return;
	if (message.operation === "claim") {
		dispatchEffect({
			type: "toast",
			identity: sessionIdentityForHandle(message.sessionHandle, message),
			dedupeKey: `lease-observer:${message.operation}:${message.error}`,
			level: "info",
			message: tt("lease.observer"),
			description: stripAnsi(message.error),
		});
		return;
	}
	if (isSoftIdempotentError(message.error)) {
		return;
	}
	dispatchEffect({
		type: "toast",
		identity: sessionIdentityForHandle(message.sessionHandle, message),
		dedupeKey: `session-error:${message.operation}:${message.error}`,
		level: "error",
		message: stripAnsi(message.error),
	});
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
	const deadline = sessionStateOwners.effects.now() + 20_000;
	for (;;) {
		await useModelDirectoryStore.getState().refresh(sessionHandle);
		if (
			useModelDirectoryStore.getState().bySession[sessionHandle]?.models.length ||
			sessionStateOwners.effects.now() >= deadline
		) {
			return;
		}
		await new Promise((resolve) => globalThis.setTimeout(resolve, 2_500));
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

function sessionIdentityForFrame(
	message: Extract<SessionFrameBusMessage, { type: "event" | "extension_ui_request" }>,
): ReturnType<typeof sessionLifecycleIdentityForRuntime> {
	const runtime = sessionTransport.store.getState().sessions[message.sessionHandle]?.runtime;
	return runtime
		? sessionLifecycleIdentityForRuntime(runtime)
		: {
				serverEpoch: message.serverEpoch,
				workspaceId: message.workspaceId,
				sessionHandle: message.sessionHandle,
				generation: message.generation,
			};
}

function sessionIdentityForHandle(
	sessionHandle: string,
	fallback: { serverEpoch: string; workspaceId?: string; generation?: number },
): ReturnType<typeof sessionLifecycleIdentityForRuntime> {
	const runtime = sessionTransport.store.getState().sessions[sessionHandle]?.runtime;
	return runtime
		? sessionLifecycleIdentityForRuntime(runtime)
		: {
				serverEpoch: fallback.serverEpoch,
				workspaceId:
					fallback.workspaceId ??
					useSessionDirectoryStore.getState().currentSession?.workspaceHandle ??
					"unknown-workspace",
				sessionHandle,
				generation: fallback.generation ?? null,
			};
}

function dispatchEffect(effect: SessionBrowserEffect): void {
	if (!sessionStateOwners.effects.isCurrent(effect.identity)) return;
	sessionStateOwners.effects.dispatch(effect);
}

function runtimeForSessionHandle(sessionHandle: string): SessionRuntimeDto | null {
	return sessionTransport.store.getState().sessions[sessionHandle]?.runtime ?? null;
}

function dispatchDirectoryRefreshForWorkspace(workspaceHandle: string): void {
	const identity = {
		serverEpoch: null,
		workspaceId: workspaceHandle,
		sessionHandle: `workspace:${workspaceHandle}`,
		generation: null,
	} as const;
	sessionStateOwners.effects.setCurrentIdentity(identity);
	dispatchEffect({
		type: "directory_refresh",
		identity,
		dedupeKey: `directory:${workspaceHandle}:global`,
		workspaceHandle,
		force: true,
		delayMs: 100,
	});
}

function dispatchDirectoryRefresh(
	message: Extract<SessionFrameBusMessage, { type: "event" }>,
	workspaceHandle: string,
): void {
	dispatchEffect({
		type: "directory_refresh",
		identity: sessionIdentityForFrame(message),
		dedupeKey: `directory:${workspaceHandle}`,
		workspaceHandle,
		force: true,
		delayMs: 100,
	});
}

function directoryRefreshEffect(runtime: SessionRuntimeDto, reason: string): SessionBrowserEffect {
	return {
		type: "directory_refresh",
		identity: sessionLifecycleIdentityForRuntime(runtime),
		dedupeKey: `directory:${runtime.workspaceId}:${reason}`,
		workspaceHandle: runtime.workspaceId,
		force: true,
		delayMs: 100,
	};
}

function dispatchTabBadge(
	runtime: SessionRuntimeDto,
	status: "running" | "waiting_ui" | "idle" | "done",
): void {
	dispatchEffect({
		type: "tab_badge",
		identity: sessionLifecycleIdentityForRuntime(runtime),
		dedupeKey: `tab-badge:${status}:${String(runtime.generation)}:${String(runtime.lastSeq)}:${String(useSessionDirectoryStore.getState().navigationToken)}`,
		status,
		label: sessionLabel(runtime.sessionHandle),
	});
}

function dispatchTabBadgeForFrame(
	message: Extract<SessionFrameBusMessage, { type: "event" | "extension_ui_request" }>,
	status: "running" | "waiting_ui" | "idle" | "done",
): void {
	const runtime = runtimeForSessionHandle(message.sessionHandle);
	if (runtime) dispatchTabBadge(runtime, status);
}

function dispatchVisibleExtensionTitle(sessionHandle: string, runtime: SessionRuntimeDto | null): void {
	if (!runtime || !isCurrentSession(sessionHandle)) return;
	const title = useExtensionUiStore.getState().bySession[sessionHandle]?.title;
	dispatchEffect({
		type: "title",
		identity: sessionLifecycleIdentityForRuntime(runtime),
		dedupeKey: `title:${title ?? "default"}:${String(runtime.generation)}:${String(useSessionDirectoryStore.getState().navigationToken)}:${String(runtime.lastSeq)}`,
		title: title ? `${displayLabel(title)} · Pi Agent Web` : "Pi Agent Web",
	});
}
