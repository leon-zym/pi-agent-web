import type { RpcCommand, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import { commandTimeoutMs } from "@pi-agent-web/protocol";
import { useSessionControlStore } from "../stores/session-control";
import { useTransportStore } from "../stores/transport";
import { tt } from "./i18n";

function expectedSessionId(workspaceId: string): string | null {
	const control = useSessionControlStore.getState();
	return control.workspaceId === workspaceId ? control.session.id : null;
}

export async function sendReadCommand(
	workspaceId: string,
	command: RpcCommand,
	timeoutMs = commandTimeoutMs(command.type),
): Promise<RpcResponse> {
	return useTransportStore
		.getState()
		.sendCommand(workspaceId, command, timeoutMs, expectedSessionId(workspaceId));
}

export async function sendControlCommand(
	workspaceId: string,
	command: RpcCommand,
	timeoutMs = commandTimeoutMs(command.type),
): Promise<RpcResponse> {
	if (!useSessionControlStore.getState().canControl(workspaceId)) throw new Error(tt("lease.readOnly"));
	const response = await useTransportStore
		.getState()
		.sendCommand(workspaceId, command, timeoutMs, expectedSessionId(workspaceId));
	if (response.success === false && response.error === "session_stale") {
		useSessionControlStore.getState().setReconciling(workspaceId, true);
		if (typeof window !== "undefined") window.dispatchEvent(new Event("piweb:session-stale"));
	}
	return response;
}

export function sendControlExtensionUiResponse(
	workspaceId: string,
	response: RpcExtensionUIResponse,
): boolean {
	if (!useSessionControlStore.getState().canControl(workspaceId)) return false;
	return useTransportStore
		.getState()
		.sendExtensionUiResponse(workspaceId, response, expectedSessionId(workspaceId));
}
