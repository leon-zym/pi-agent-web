import { expectData, type WsServerMessage } from "@pi-agent-web/protocol";
import { toast } from "sonner";
import { useComposerStore } from "../stores/composer";
import { useExtensionUiStore } from "../stores/extension-ui";
import { useModelDirectoryStore } from "../stores/model-directory";
import { useProjectionStore } from "../stores/projection";
import { useSessionControlStore } from "../stores/session-control";
import { useSessionDirectoryStore } from "../stores/session-directory";
import { useSessionStatsStore } from "../stores/session-stats";
import { useSlashCommandsStore } from "../stores/slash-commands";
import { emitServerFrame, serverFrameBus, useTransportStore } from "../stores/transport";
import { useViewStore } from "../stores/view";
import { tt } from "./i18n";

let initialized = false;
let reconcileGeneration = 0;
let unrecoverableSession: { workspaceId: string; sessionId: string | null; epoch: number } | null = null;

/**
 * Wire message -> domain store routing (single pipeline, no components
 * subscribe to the socket directly).
 */
export function initPipeline(): void {
	if (initialized) return;
	initialized = true;

	useTransportStore.getState().connect();

	serverFrameBus.addEventListener("frame", ((event: CustomEvent<WsServerMessage>) => {
		routeFrame(event.detail);
	}) as EventListener);

	window.addEventListener("piweb:ws-online", () => {
		void runReconnectSnapshot();
	});
	window.addEventListener("piweb:session-stale", () => {
		void runReconnectSnapshot();
	});
}

function routeFrame(message: WsServerMessage): void {
	switch (message.type) {
		case "event":
			routeEvent(message);
			return;
		case "extension_ui_request":
			routeExtensionUiRequest(message);
			return;
		case "session_state":
			routeSessionState(message);
			return;
		case "session_directory_changed":
			if (useSessionDirectoryStore.getState().currentWorkspaceId === message.workspaceId) {
				void useSessionDirectoryStore.getState().reloadSessions();
			}
			return;
		case "auth_changed":
			void refreshModelsAfterAuthChange(message.workspaceId);
			return;
		default:
			return;
	}
}

function isCurrentScope(workspaceId: string, sessionId: string, epoch: number): boolean {
	const directory = useSessionDirectoryStore.getState();
	const control = useSessionControlStore.getState();
	return (
		directory.currentWorkspaceId === workspaceId &&
		directory.currentSession?.id === sessionId &&
		control.workspaceId === workspaceId &&
		control.session.id === sessionId &&
		control.session.epoch === epoch &&
		!control.reconciling
	);
}

function routeSessionState(message: Extract<WsServerMessage, { type: "session_state" }>): void {
	const directory = useSessionDirectoryStore.getState();
	if (directory.currentWorkspaceId !== message.workspaceId) return;
	useExtensionUiStore.getState().clearDialogsOutside(message.workspaceId, message.sessionId, message.epoch);
	if (
		unrecoverableSession?.workspaceId === message.workspaceId &&
		unrecoverableSession.sessionId === message.sessionId &&
		unrecoverableSession.epoch === message.epoch
	)
		return;
	unrecoverableSession = null;
	if (directory.currentSession?.id !== message.sessionId) void reconcileHostSession(message.workspaceId);
}

function routeEvent(message: Extract<WsServerMessage, { type: "event" }>): void {
	const { event, sessionId, workspaceId, epoch } = message;
	if (!isCurrentScope(workspaceId, sessionId, epoch)) return;

	switch (event.type) {
		case "queue_update":
			useComposerStore.getState().setQueue({ steering: [...event.steering], followUp: [...event.followUp] });
			return;
		case "thinking_level_changed":
			useModelDirectoryStore.getState().applyThinkingLevel(event.level);
			return;
		case "session_info_changed":
			void useSessionDirectoryStore.getState().reloadSessions();
			return;
		case "message_update":
			useSessionStatsStore.getState().applyLiveUsage({
				input: event.usage.input,
				output: event.usage.output,
				totalTokens: event.usage.totalTokens,
			});
			break;
		case "extension_error":
			toast.error(tt("ext.error"), { description: `${event.event}: ${event.error}` });
			return;
		case "bash_execution_update":
			// Consumed by the transport store (bash console); nothing else.
			return;
		default:
			break;
	}

	useProjectionStore.getState().applyEvent(sessionId, event);
}

function routeExtensionUiRequest(message: Extract<WsServerMessage, { type: "extension_ui_request" }>): void {
	const { request, workspaceId, sessionId, epoch } = message;
	if (!isCurrentScope(workspaceId, sessionId, epoch)) return;
	const extensionUi = useExtensionUiStore.getState();

	switch (request.method) {
		case "select":
		case "confirm":
		case "input":
		case "editor":
			extensionUi.pushDialog({ request, workspaceId, sessionId, epoch, receivedAt: Date.now() });
			return;
		case "notify":
			if (request.notifyType === "error") toast.error(request.message);
			else if (request.notifyType === "warning") toast.warning(request.message);
			else toast.info(request.message);
			return;
		case "setStatus":
			extensionUi.applyStatus(request.statusKey, request.statusText);
			return;
		case "setWidget":
			extensionUi.applyWidget(request.widgetKey, request.widgetLines, request.widgetPlacement);
			return;
		case "setTitle":
			document.title = `${request.title} · Pi Agent Web`;
			return;
		case "set_editor_text":
			useComposerStore.getState().setDraft(request.text);
			return;
		default:
			return;
	}
}

/**
 * Reconnect snapshot protocol is Host-authoritative. It first identifies the
 * active Host session, then updates all selection stores before rebuilding.
 */
async function runReconnectSnapshot(): Promise<void> {
	const directory = useSessionDirectoryStore.getState();
	const workspaceId = directory.currentWorkspaceId;
	if (!workspaceId) return;
	await reconcileHostSession(workspaceId);
}

async function reconcileHostSession(workspaceId: string): Promise<void> {
	const generation = ++reconcileGeneration;
	useSessionControlStore.getState().setReconciling(workspaceId, true);

	const transport = useTransportStore.getState();
	try {
		const stateResponse = await transport.sendCommand(workspaceId, { type: "get_state" }, 30_000);
		const state = expectData(stateResponse) as { sessionId: string; sessionFile?: string };
		if (!isCurrentWorkspace(workspaceId, generation)) return;

		const sessions = await useSessionDirectoryStore.getState().reloadSessions();
		if (!isCurrentWorkspace(workspaceId, generation)) return;
		const session = sessions.find((summary) => summary.id === state.sessionId);
		if (!session) {
			clearRecoveredSession(workspaceId, state.sessionId);
			toast.error(tt("session.recoveryFailed"));
			return;
		}

		useSessionDirectoryStore.getState().setCurrentSession(session);
		unrecoverableSession = null;
		useProjectionStore.getState().setCurrentSession(session.id);
		useViewStore.getState().clearSession();
		useTransportStore.getState().setListen(workspaceId, session.id);

		const control = useSessionControlStore.getState();
		const epoch = control.workspaceId === workspaceId ? control.session.epoch : 0;
		const messagesResponse = await transport.sendCommand(workspaceId, { type: "get_messages" }, 30_000);
		const { messages } = expectData(messagesResponse) as {
			messages: Parameters<ReturnType<typeof useProjectionStore.getState>["rebuildFromMessages"]>[1];
		};
		if (!isCurrentScope(workspaceId, session.id, epoch) || generation !== reconcileGeneration) return;
		useProjectionStore.getState().rebuildFromMessages(session.id, messages);

		void useSlashCommandsStore.getState().refresh(workspaceId);
		void useModelDirectoryStore.getState().refresh(workspaceId);
		void useSessionStatsStore.getState().refresh(workspaceId);
	} catch {
		// Process may be starting; the next online event retries.
	} finally {
		if (generation === reconcileGeneration)
			useSessionControlStore.getState().setReconciling(workspaceId, false);
	}
}

function isCurrentWorkspace(workspaceId: string, generation: number): boolean {
	return (
		generation === reconcileGeneration &&
		useSessionDirectoryStore.getState().currentWorkspaceId === workspaceId
	);
}

function clearRecoveredSession(workspaceId: string, sessionId: string): void {
	const control = useSessionControlStore.getState();
	unrecoverableSession = {
		workspaceId,
		sessionId,
		epoch: control.workspaceId === workspaceId ? control.session.epoch : 0,
	};
	useSessionDirectoryStore.getState().setCurrentSession(null);
	useProjectionStore.getState().setCurrentSession(null);
	useViewStore.getState().clearSession();
	useSessionStatsStore.getState().clear();
	useComposerStore.getState().setQueue({ steering: [], followUp: [] });
	useExtensionUiStore.getState().clearDialogsOutside(workspaceId, null, 0);
	useTransportStore.getState().setListen(workspaceId, null);
}

/**
 * After auth changes the model snapshot refreshes in the background (15s in
 * pi). Poll the model directory until it stops being empty, with a cap.
 */
async function refreshModelsAfterAuthChange(workspaceId: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const modelDirectory = useModelDirectoryStore.getState();
		try {
			await modelDirectory.refresh(workspaceId);
		} catch {
			// retry below
		}
		if (useModelDirectoryStore.getState().models.length > 0 || Date.now() >= deadline) return;
		await new Promise((resolve) => setTimeout(resolve, 2500));
	}
}

// Re-export for convenience in tests.
export { emitServerFrame };
