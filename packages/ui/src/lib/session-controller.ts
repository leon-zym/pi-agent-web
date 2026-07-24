import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import { expectData, type SessionSummary } from "@pi-agent-web/protocol";
import { toast } from "sonner";
import { useComposerStore } from "../stores/composer";
import { useModelDirectoryStore } from "../stores/model-directory";
import { useProjectionStore } from "../stores/projection";
import { useSessionControlStore } from "../stores/session-control";
import { useSessionDirectoryStore } from "../stores/session-directory";
import { useSessionStatsStore } from "../stores/session-stats";
import { useSlashCommandsStore } from "../stores/slash-commands";
import { useTransportStore } from "../stores/transport";
import { useViewStore } from "../stores/view";
import type { ImageContent } from "../types/pi-types";
import { api } from "./api";
import { tt } from "./i18n";
import { sendControlCommand, sendReadCommand } from "./session-command";

export { sendControlCommand, sendControlExtensionUiResponse, sendReadCommand } from "./session-command";

/**
 * Session orchestration: switching, creating, deleting, submitting prompts.
 * Kept outside components so the flow survives Composer re-renders.
 */

function workspaceId(): string {
	const id = useSessionDirectoryStore.getState().currentWorkspaceId;
	if (!id) throw new Error(tt("session.workspaceRequired"));
	return id;
}

async function snapshotAfterOpen(wsId: string, sessionId: string): Promise<void> {
	useTransportStore.getState().setListen(wsId, sessionId);
	useProjectionStore.getState().setCurrentSession(sessionId);
	useViewStore.getState().clearSession();
	useSessionStatsStore.getState().clear();
	try {
		const response = await sendReadCommand(wsId, { type: "get_messages" });
		const { messages } = expectData(response) as { messages: never[] };
		useProjectionStore.getState().rebuildFromMessages(sessionId, messages);
	} catch (error) {
		toast.error(tt("session.loadFailed"), {
			description: error instanceof Error ? error.message : String(error),
		});
	}
	void useSlashCommandsStore.getState().refresh(wsId);
	void useModelDirectoryStore.getState().refresh(wsId);
	void useSessionStatsStore.getState().refresh(wsId);
}

/** Open a session file inside the current workspace process (switch_session). */
export async function openSession(summary: SessionSummary): Promise<void> {
	const wsId = workspaceId();
	const directory = useSessionDirectoryStore.getState();
	directory.setCurrentSession(summary);

	try {
		const response = await sendControlCommand(wsId, {
			type: "switch_session",
			sessionPath: summary.absolutePath,
		});
		const data = expectData(response) as { cancelled: boolean };
		if (data.cancelled) {
			directory.setCurrentSession(null);
			toast.info(tt("session.switchCancelled"));
			return;
		}
		await snapshotAfterOpen(wsId, summary.id);
	} catch (error) {
		directory.setCurrentSession(null);
		toast.error(tt("session.openFailed"), {
			description: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Create a brand-new session in the current workspace (new_session). */
export async function newSession(): Promise<void> {
	const wsId = workspaceId();
	try {
		const response = await sendControlCommand(wsId, { type: "new_session" });
		const data = expectData(response) as { cancelled: boolean };
		if (data.cancelled) {
			toast.info(tt("session.newCancelled"));
			return;
		}
		const stateResponse = await sendReadCommand(wsId, { type: "get_state" });
		const state = expectData(stateResponse) as { sessionId: string; sessionFile?: string };
		const directory = useSessionDirectoryStore.getState();
		await directory.reloadSessions();
		const fresh = useSessionDirectoryStore.getState().sessions.find((s) => s.id === state.sessionId);
		if (fresh) {
			useSessionDirectoryStore.getState().setCurrentSession(fresh);
			await snapshotAfterOpen(wsId, fresh.id);
		} else {
			// Session file may take a moment to appear in the scan; retry once.
			await new Promise((resolve) => setTimeout(resolve, 400));
			await directory.reloadSessions();
			const retry = useSessionDirectoryStore.getState().sessions.find((s) => s.id === state.sessionId);
			if (retry) {
				useSessionDirectoryStore.getState().setCurrentSession(retry);
				await snapshotAfterOpen(wsId, retry.id);
			}
		}
	} catch (error) {
		toast.error(tt("session.newFailed"), {
			description: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function deleteSession(summary: SessionSummary): Promise<void> {
	const wsId = workspaceId();
	try {
		if (!useSessionControlStore.getState().canControl(wsId)) throw new Error(tt("lease.readOnly"));
		await api.deleteSession(wsId, summary.path);
		await useSessionDirectoryStore.getState().reloadSessions();
		if (useSessionDirectoryStore.getState().currentSession?.id === summary.id) {
			useSessionDirectoryStore.getState().setCurrentSession(null);
		}
		toast.success(tt("session.deleted"));
	} catch (error) {
		toast.error(tt("session.deleteFailed"), {
			description: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function renameSession(summary: SessionSummary, name: string): Promise<void> {
	const wsId = workspaceId();
	try {
		const currentSession = useSessionDirectoryStore.getState().currentSession;
		const control = useSessionControlStore.getState();
		if (
			currentSession?.id !== summary.id ||
			control.workspaceId !== wsId ||
			control.session.id !== summary.id
		) {
			throw new Error(tt("session.renameCurrentOnly"));
		}
		await sendControlCommand(wsId, { type: "set_session_name", name });
		await useSessionDirectoryStore.getState().reloadSessions();
	} catch (error) {
		toast.error(tt("session.renameFailed"), {
			description: error instanceof Error ? error.message : String(error),
		});
	}
}

export type SubmitKind = "prompt" | "steer" | "follow_up";

function isRunning(): boolean {
	const projection = useProjectionStore.getState();
	if (!projection.currentSessionId) return false;
	const current = projection.projections[projection.currentSessionId];
	return current?.activeTurnId !== null && current?.activeTurnId !== undefined;
}

/**
 * Submit the composer draft. While running, bare prompt is blocked and the
 * delivery mode picks steer (插队) or follow_up (排队).
 */
export async function submitDraft(kind: SubmitKind): Promise<void> {
	const wsId = useSessionDirectoryStore.getState().currentWorkspaceId;
	if (!wsId) {
		toast.error(tt("session.needWorkspace"));
		return;
	}
	const composer = useComposerStore.getState();
	const text = composer.draft.trim();
	if (!text && composer.images.length === 0) return;

	const running = isRunning();
	let resolvedKind: SubmitKind = kind;
	if (running) {
		if (kind === "prompt") resolvedKind = composer.deliveryMode === "follow_up" ? "follow_up" : "steer";
	} else {
		resolvedKind = "prompt";
	}

	const images = composer.images.length > 0 ? composer.images : undefined;
	composer.setSubmitState("submitting");
	try {
		let response: RpcResponse;
		if (resolvedKind === "steer" || resolvedKind === "follow_up") {
			composer.recordQueued(text, resolvedKind);
			response = await sendControlCommand(wsId, { type: resolvedKind, message: text, images });
		} else {
			response = await sendControlCommand(wsId, { type: "prompt", message: text, images });
		}
		if (response.success === false) {
			toast.error(tt("session.sendFailed"), { description: response.error });
		} else {
			composer.clearDraft();
		}
	} catch (error) {
		toast.error(tt("session.sendFailed"), {
			description: error instanceof Error ? error.message : String(error),
		});
	} finally {
		composer.setSubmitState("plain");
	}
}

export async function abortCurrentRun(): Promise<void> {
	const wsId = useSessionDirectoryStore.getState().currentWorkspaceId;
	if (!wsId) return;
	try {
		await sendControlCommand(wsId, { type: "abort" });
	} catch (error) {
		toast.error(tt("session.abortFailed"), {
			description: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Run the /name command through the prompt path (extensions handle it). */
export async function runSlashCommand(wsId: string, fullText: string): Promise<void> {
	const composer = useComposerStore.getState();
	composer.setSubmitState("submitting");
	try {
		const response = await sendControlCommand(wsId, { type: "prompt", message: fullText });
		if (response.success === false) toast.error(tt("session.commandFailed"), { description: response.error });
		else composer.clearDraft();
	} catch (error) {
		toast.error(tt("session.commandFailed"), {
			description: error instanceof Error ? error.message : String(error),
		});
	} finally {
		composer.setSubmitState("plain");
	}
}

export async function forkFromEntry(entryId: string): Promise<void> {
	const wsId = workspaceId();
	try {
		const response = await sendControlCommand(wsId, { type: "fork", entryId });
		const data = expectData(response) as { text: string; cancelled: boolean };
		if (data.cancelled) {
			toast.info(tt("session.forkCancelled"));
			return;
		}
		const stateResponse = await sendReadCommand(wsId, { type: "get_state" });
		const state = expectData(stateResponse) as { sessionId: string };
		await useSessionDirectoryStore.getState().reloadSessions();
		const forked = useSessionDirectoryStore.getState().sessions.find((s) => s.id === state.sessionId);
		if (forked) {
			await openSession(forked);
			toast.success(tt("session.forked"));
		}
	} catch (error) {
		toast.error(tt("session.forkFailed"), {
			description: error instanceof Error ? error.message : String(error),
		});
	}
}

export type { ImageContent };
