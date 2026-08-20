import { expectData, type SessionRuntimeDto, type SessionWsServerMessage } from "@pi-agent-web/protocol";
import { toast } from "sonner";
import { useComposerStore } from "../stores/composer";
import { useExtensionUiStore } from "../stores/extension-ui";
import { useModelDirectoryStore } from "../stores/model-directory";
import { useProjectionStore } from "../stores/projection";
import { useSessionDirectoryStore } from "../stores/session-directory";
import { useSessionStatsStore } from "../stores/session-stats";
import { SESSION_FRAME_DEFERRED, sessionTransport } from "../stores/session-transport";
import { useSlashCommandsStore } from "../stores/slash-commands";
import { displayError, displayLabel, stripAnsi } from "./format";
import { tt } from "./i18n";
import { isCoalescibleMessageUpdate, SessionEventScheduler } from "./session-event-scheduler";

type SessionFrameMessage = Exclude<
	SessionWsServerMessage,
	{ type: "response" } | { type: "session_directory_changed" } | { type: "auth_changed" }
>;

interface ResyncTask {
	generation: number;
	barrierSeq: number;
	promise: Promise<void>;
}

let initialized = false;
const resyncTasks = new Map<string, ResyncTask>();
const resyncRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const directoryReloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeMessageIdentities = new Map<string, { generation: number; identity: string }>();

const projectionEventScheduler = new SessionEventScheduler({
	onFlush: (sessionHandle, generation, events) => {
		const channel = sessionTransport.store.getState().sessions[sessionHandle];
		if (channel?.generation !== generation || channel.resync) return;
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

	sessionTransport.frameBus.subscribeAll((frame) => routeSessionFrame(frame.message));
	sessionTransport.globalBus.subscribe((message) => {
		if (message.type === "session_directory_changed") {
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

function routeSessionFrame(message: SessionFrameMessage): void | typeof SESSION_FRAME_DEFERRED {
	switch (message.type) {
		case "event":
			return routeEvent(message);
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
			return;
		case "resync_required":
			projectionEventScheduler.discardSession(message.sessionHandle);
			activeMessageIdentities.delete(message.sessionHandle);
			requestResync(message);
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

function routeRuntime(runtime: SessionRuntimeDto): void {
	const identity = activeMessageIdentities.get(runtime.sessionHandle);
	if (
		identity &&
		(identity.generation !== runtime.generation ||
			runtime.state === "idle" ||
			runtime.state === "dormant" ||
			runtime.state === "crashed")
	) {
		activeMessageIdentities.delete(runtime.sessionHandle);
	}
	useSessionDirectoryStore.getState().applyRuntime(runtime);
	useExtensionUiStore.getState().resetSessionForGeneration(runtime.sessionHandle, runtime.generation);
	if (runtime.state === "crashed") {
		useProjectionStore.getState().markRuntimeFailure(runtime.sessionHandle, stripAnsi(runtime.error ?? ""));
	}
	if (
		!isCurrentSession(runtime.sessionHandle) &&
		(runtime.state === "idle" || runtime.state === "dormant" || runtime.state === "crashed")
	) {
		const transport = sessionTransport.store.getState();
		transport.releaseSession(runtime.sessionHandle);
		transport.unsubscribeSession(runtime.sessionHandle);
	}
	if (runtime.state === "crashed" && isCurrentSession(runtime.sessionHandle)) {
		toast.error(tt("status.crashed"), { description: stripAnsi(runtime.error ?? "") });
	}
}

function routeEvent(
	message: Extract<SessionWsServerMessage, { type: "event" }>,
): void | typeof SESSION_FRAME_DEFERRED {
	const { event, generation, seq, sessionHandle, workspaceId } = message;
	if (event.type === "message_update" && isCoalescibleMessageUpdate(event)) {
		const enqueueResult = projectionEventScheduler.enqueue(
			sessionHandle,
			generation,
			currentMessageIdentity(sessionHandle, generation),
			event,
		);
		if (enqueueResult === "rejected") throw new Error("Projection scheduler rejected a live event");
		return enqueueResult === "deferred" ? SESSION_FRAME_DEFERRED : undefined;
	}

	// Every structural event is an ordering boundary. Publish preceding deltas
	// synchronously before tools, turn settlement, dialogs, errors, or snapshots.
	projectionEventScheduler.flushSession(sessionHandle, generation);
	if (sessionTransport.store.getState().sessions[sessionHandle]?.resync?.requiresFreshBaseline) {
		return SESSION_FRAME_DEFERRED;
	}
	if (
		(event.type === "message_start" && (event.message as { role?: string }).role === "assistant") ||
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

	useProjectionStore.getState().applyEvent(sessionHandle, event);
	if (
		(event.type === "message_end" && (event.message as { role?: string }).role === "assistant") ||
		(event.type === "message_update" &&
			(event.assistantMessageEvent.type === "done" || event.assistantMessageEvent.type === "error")) ||
		event.type === "turn_end" ||
		event.type === "agent_settled"
	) {
		activeMessageIdentities.delete(sessionHandle);
	}
}

function currentMessageIdentity(sessionHandle: string, generation: number): string {
	const active = activeMessageIdentities.get(sessionHandle);
	return active?.generation === generation ? active.identity : `${String(generation)}:unframed`;
}

function applyLiveUsage(
	sessionHandle: string,
	event: Extract<import("@earendil-works/pi-coding-agent").JsonAgentSessionEvent, { type: "message_update" }>,
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
}

function routeRekey(previousSessionHandle: string, runtime: SessionRuntimeDto): void {
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
	toast.error(stripAnsi(message.error));
}

function requestResync(message: Extract<SessionWsServerMessage, { type: "resync_required" }>): void {
	const existing = resyncTasks.get(message.sessionHandle);
	if (
		existing &&
		existing.generation === message.runtime.generation &&
		existing.barrierSeq >= message.runtime.lastSeq
	) {
		return;
	}
	clearResyncRetry(message.sessionHandle);
	const task: ResyncTask = {
		generation: message.runtime.generation,
		barrierSeq: message.runtime.lastSeq,
		promise: Promise.resolve(),
	};
	task.promise = performResync(message, 0).finally(() => {
		if (resyncTasks.get(message.sessionHandle) === task) resyncTasks.delete(message.sessionHandle);
	});
	resyncTasks.set(message.sessionHandle, task);
}

async function performResync(
	message: Extract<SessionWsServerMessage, { type: "resync_required" }>,
	attempt: number,
): Promise<void> {
	const { sessionHandle } = message;
	try {
		const response = await sessionTransport.store
			.getState()
			.sendCommand(sessionHandle, { type: "get_messages" });
		const { messages } = expectData(response) as { messages: unknown[] };
		const channel = sessionTransport.store.getState().sessions[sessionHandle];
		if (
			!channel?.resync ||
			channel.generation !== message.runtime.generation ||
			channel.resync.generation !== message.runtime.generation
		) {
			return;
		}
		useProjectionStore.getState().rebuildFromMessages(sessionHandle, messages);
		sessionTransport.store.getState().completeResync(sessionHandle);
		void refreshSessionMetadata(sessionHandle);
	} catch (error) {
		const channel = sessionTransport.store.getState().sessions[sessionHandle];
		if (!channel?.subscribed || channel.generation !== message.runtime.generation || !channel.resync) return;
		const delay = Math.min(500 * 2 ** attempt, 10_000);
		if (attempt >= 3 && isCurrentSession(sessionHandle)) {
			toast.error(tt("session.loadFailed"), {
				description: displayError(error),
			});
		}
		clearResyncRetry(sessionHandle);
		const timer = setTimeout(() => {
			resyncRetryTimers.delete(sessionHandle);
			void performResync(message, Math.min(attempt + 1, 5));
		}, delay);
		resyncRetryTimers.set(sessionHandle, timer);
	}
}

async function refreshSessionMetadata(sessionHandle: string): Promise<void> {
	await Promise.allSettled([
		useSlashCommandsStore.getState().refresh(sessionHandle),
		useModelDirectoryStore.getState().refresh(sessionHandle),
		useSessionStatsStore.getState().refresh(sessionHandle),
	]);
}

function clearResyncRetry(sessionHandle: string): void {
	const timer = resyncRetryTimers.get(sessionHandle);
	if (timer) clearTimeout(timer);
	resyncRetryTimers.delete(sessionHandle);
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
