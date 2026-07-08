import type { WsServerMessage } from "@pi-agent-web/server/wire";
import { expectData } from "@pi-agent-web/server/wire";
import { tt } from "./i18n";
import { toast } from "sonner";
import { useComposerStore } from "../stores/composer";
import { useExtensionUiStore } from "../stores/extension-ui";
import { useModelDirectoryStore } from "../stores/model-directory";
import { useProjectionStore } from "../stores/projection";
import { useSessionDirectoryStore } from "../stores/session-directory";
import { useSessionStatsStore } from "../stores/session-stats";
import { useSlashCommandsStore } from "../stores/slash-commands";
import { emitServerFrame, serverFrameBus, useTransportStore } from "../stores/transport";

let initialized = false;

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
}

function routeFrame(message: WsServerMessage): void {
	switch (message.type) {
		case "event":
			routeEvent(message);
			return;
		case "extension_ui_request":
			routeExtensionUiRequest(message);
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

function routeEvent(message: Extract<WsServerMessage, { type: "event" }>): void {
	const { event, sessionId } = message;

	switch (event.type) {
		case "queue_update":
			useComposerStore.getState().setQueue({ steering: [...event.steering], followUp: [...event.followUp] });
			return;
		case "thinking_level_changed":
			useModelDirectoryStore.getState().applyThinkingLevel(event.level);
			return;
		case "session_info_changed":
			if (useSessionDirectoryStore.getState().currentWorkspaceId === message.workspaceId) {
				void useSessionDirectoryStore.getState().reloadSessions();
			}
			return;
		case "message_update":
			useSessionStatsStore.getState().applyLiveUsage({
				input: event.usage.input,
				output: event.usage.output,
				totalTokens: event.usage.totalTokens,
			});
			break;
		case "extension_error":
			toast.error(tt("ext.error"), { description: event.event + ": " + event.error });
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
	const { request, workspaceId, sessionId } = message;
	const extensionUi = useExtensionUiStore.getState();

	switch (request.method) {
		case "select":
		case "confirm":
		case "input":
		case "editor":
			extensionUi.pushDialog({ request, workspaceId, sessionId, receivedAt: Date.now() });
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
			document.title = request.title + " · Pi Agent Web";
			return;
		case "set_editor_text":
			useComposerStore.getState().setDraft(request.text);
			return;
		default:
			return;
	}
}

/**
 * Reconnect snapshot protocol: get_state -> get_messages
 * -> get_commands -> model directory -> stats. Live events keep applying.
 */
async function runReconnectSnapshot(): Promise<void> {
	const directory = useSessionDirectoryStore.getState();
	const workspaceId = directory.currentWorkspaceId;
	if (!workspaceId) return;

	const transport = useTransportStore.getState();
	try {
		const stateResponse = await transport.sendCommand(workspaceId, { type: "get_state" }, 15_000);
		const state = expectData(stateResponse) as { sessionId: string; sessionFile?: string };
		const projectionStore = useProjectionStore.getState();
		const session = directory.currentSession;

		if (session && state.sessionId !== session.id) {
			// The server switched sessions while we were away: drop the stale projection.
			projectionStore.resetSession(session.id);
		}

		if (session) {
			useTransportStore.getState().setListen(workspaceId, state.sessionId);
			const messagesResponse = await transport.sendCommand(workspaceId, { type: "get_messages" }, 20_000);
			const { messages } = expectData(messagesResponse) as {
				messages: Parameters<typeof projectionStore.rebuildFromMessages>[1];
			};
			projectionStore.rebuildFromMessages(state.sessionId, messages);
		}

		void useSlashCommandsStore.getState().refresh(workspaceId);
		void useModelDirectoryStore.getState().refresh(workspaceId);
		void useSessionStatsStore.getState().refresh(workspaceId);
	} catch {
		// Process may be starting; the next online event retries.
	}
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
