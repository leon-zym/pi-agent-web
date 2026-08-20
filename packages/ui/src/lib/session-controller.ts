import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import { expectData, type NativeSessionDto } from "@pi-agent-web/protocol";
import { toast } from "sonner";
import { useComposerStore } from "../stores/composer";
import { useProjectionStore } from "../stores/projection";
import { useSessionDirectoryStore } from "../stores/session-directory";
import { sessionTransport } from "../stores/session-transport";
import type { ImageContent } from "../types/pi-types";
import { api } from "./api";
import { displayError, stripAnsi } from "./format";
import { tt } from "./i18n";
import { sessionDeleteCapability } from "./session-capabilities";
import { sendControlCommand } from "./session-command";

export { sendControlCommand, sendControlExtensionUiResponse, sendReadCommand } from "./session-command";

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

function controllerChannel(sessionHandle: string) {
	const channel = sessionTransport.store.getState().sessions[sessionHandle];
	if (
		!channel?.subscribed ||
		channel.generation === null ||
		!channel.lease.isController ||
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
	const directory = useSessionDirectoryStore.getState();
	if (directory.currentWorkspaceHandle !== session.workspaceHandle) {
		await directory.selectWorkspace(session.workspaceHandle);
	}
	useSessionDirectoryStore.getState().selectSession(session);
}

/** Create a new Pi-native Session and attach its dedicated runtime. */
export async function newSession(): Promise<void> {
	let workspaceHandle: string;
	try {
		workspaceHandle = currentWorkspaceHandle();
		const created = await api.createSession(workspaceHandle);
		const directory = useSessionDirectoryStore.getState();
		directory.upsertSession(created.session);
		directory.selectSession(created.session);
		void directory.reloadSessions(workspaceHandle);
	} catch (error) {
		toast.error(tt("session.newFailed"), {
			description: displayError(error),
		});
	}
}

export async function deleteSession(session: NativeSessionDto): Promise<void> {
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
		transport.releaseSession(session.sessionHandle);
		transport.unsubscribeSession(session.sessionHandle);
		const directory = useSessionDirectoryStore.getState();
		directory.removeSession(session.workspaceHandle, session.sessionHandle);
		void directory.loadWorkspaces();
		toast.success(tt("session.deleted"));
	} catch (error) {
		toast.error(tt("session.deleteFailed"), {
			description: displayError(error),
		});
	}
}

export async function renameSession(session: NativeSessionDto, name: string): Promise<void> {
	try {
		if (useSessionDirectoryStore.getState().currentSession?.sessionHandle !== session.sessionHandle) {
			throw new Error(tt("session.renameCurrentOnly"));
		}
		controllerChannel(session.sessionHandle);
		await sendControlCommand(session.sessionHandle, { type: "set_session_name", name });
		await useSessionDirectoryStore.getState().reloadSessions(session.workspaceHandle);
	} catch (error) {
		toast.error(tt("session.renameFailed"), {
			description: displayError(error),
		});
	}
}

export type SubmitKind = "prompt" | "steer" | "follow_up";

function isRunning(sessionHandle: string): boolean {
	const runtime = sessionTransport.store.getState().sessions[sessionHandle]?.runtime;
	if (runtime?.state === "running" || runtime?.state === "waiting_ui") return true;
	const projection = useProjectionStore.getState().projections[sessionHandle];
	return projection?.activeTurnId !== null && projection?.activeTurnId !== undefined;
}

/** Submit the active Session's draft with exact generation and fencing handled by the transport. */
export async function submitDraft(kind: SubmitKind): Promise<void> {
	let sessionHandle: string;
	try {
		sessionHandle = currentSessionHandle();
	} catch {
		toast.error(tt("session.needWorkspace"));
		return;
	}
	const composer = useComposerStore.getState();
	const text = composer.draft.trim();
	if (!text && composer.images.length === 0) return;
	if (!composer.beginSubmitForSession(sessionHandle)) return;

	const running = isRunning(sessionHandle);
	let resolvedKind: SubmitKind = kind;
	if (running && kind === "prompt") {
		resolvedKind = composer.deliveryMode === "follow_up" ? "follow_up" : "steer";
	} else if (!running) resolvedKind = "prompt";

	const images = composer.images.length > 0 ? composer.images : undefined;
	try {
		let response: RpcResponse;
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
			toast.error(tt("session.sendFailed"), { description: stripAnsi(response.error) });
		} else {
			useComposerStore
				.getState()
				.clearDraftIfUnchangedForSession(sessionHandle, composer.draft, composer.images);
		}
	} catch (error) {
		toast.error(tt("session.sendFailed"), {
			description: displayError(error),
		});
	} finally {
		useComposerStore.getState().setSubmitStateForSession(sessionHandle, "plain");
	}
}

export async function abortCurrentRun(): Promise<void> {
	const session = useSessionDirectoryStore.getState().currentSession;
	if (!session) return;
	try {
		await sendControlCommand(session.sessionHandle, { type: "abort" });
	} catch (error) {
		toast.error(tt("session.abortFailed"), {
			description: displayError(error),
		});
	}
}

/** Run a slash command through Pi's prompt path for the addressed Session. */
export async function runSlashCommand(sessionHandle: string, fullText: string): Promise<void> {
	const composer = useComposerStore.getState();
	if (!composer.beginSubmitForSession(sessionHandle)) return;
	try {
		const response = await sendControlCommand(sessionHandle, { type: "prompt", message: fullText });
		if (response.success === false) {
			toast.error(tt("session.commandFailed"), { description: stripAnsi(response.error) });
		} else {
			useComposerStore
				.getState()
				.clearDraftIfUnchangedForSession(sessionHandle, composer.draft, composer.images);
		}
	} catch (error) {
		toast.error(tt("session.commandFailed"), {
			description: displayError(error),
		});
	} finally {
		useComposerStore.getState().setSubmitStateForSession(sessionHandle, "plain");
	}
}

export async function forkFromEntry(entryId: string): Promise<void> {
	try {
		const sessionHandle = currentSessionHandle();
		const response = await sendControlCommand(sessionHandle, { type: "fork", entryId });
		const data = expectData(response) as { cancelled?: boolean } | undefined;
		if (data?.cancelled) {
			toast.info(tt("session.forkCancelled"));
			return;
		}
		toast.success(tt("session.forked"));
	} catch (error) {
		toast.error(tt("session.forkFailed"), {
			description: displayError(error),
		});
	}
}

export type { ImageContent };
