import {
	commandTimeoutMs,
	type ExtensionUiResponseDto,
	type SessionCommandDto,
	type SessionCommandResponseDto,
} from "@pi-agent-web/protocol";
import { sessionTransport } from "../stores/session-transport";

/** Read commands are Session-addressed and never require a controller lease. */
export async function sendReadCommand(
	sessionHandle: string,
	command: SessionCommandDto,
	timeoutMs = commandTimeoutMs(command.type),
): Promise<SessionCommandResponseDto> {
	return sessionTransport.store.getState().sendCommand(sessionHandle, command, timeoutMs);
}

/** Mutations are fenced by the Session transport using the exact generation and lease token. */
export async function sendControlCommand(
	sessionHandle: string,
	command: SessionCommandDto,
	timeoutMs = commandTimeoutMs(command.type),
): Promise<SessionCommandResponseDto> {
	return sessionTransport.store.getState().sendCommand(sessionHandle, command, timeoutMs);
}

export function sendControlExtensionUiResponse(
	sessionHandle: string,
	response: ExtensionUiResponseDto,
): boolean {
	return sessionTransport.store.getState().sendExtensionUiResponse(sessionHandle, response);
}
