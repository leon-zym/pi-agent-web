import type { RpcCommand, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import { commandTimeoutMs } from "@pi-agent-web/protocol";
import { sessionTransport } from "../stores/session-transport";

/** Read commands are Session-addressed and never require a controller lease. */
export async function sendReadCommand(
	sessionHandle: string,
	command: RpcCommand,
	timeoutMs = commandTimeoutMs(command.type),
): Promise<RpcResponse> {
	return sessionTransport.store.getState().sendCommand(sessionHandle, command, timeoutMs);
}

/** Mutations are fenced by the Session transport using the exact generation and lease token. */
export async function sendControlCommand(
	sessionHandle: string,
	command: RpcCommand,
	timeoutMs = commandTimeoutMs(command.type),
): Promise<RpcResponse> {
	return sessionTransport.store.getState().sendCommand(sessionHandle, command, timeoutMs);
}

export function sendControlExtensionUiResponse(
	sessionHandle: string,
	response: RpcExtensionUIResponse,
): boolean {
	return sessionTransport.store.getState().sendExtensionUiResponse(sessionHandle, response);
}
