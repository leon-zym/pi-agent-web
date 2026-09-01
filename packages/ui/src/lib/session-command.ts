import {
	commandTimeoutMs,
	type ExtensionUiResponseDto,
	type PiSessionCommandResponseDto,
	type SessionCommandDto,
} from "@pi-agent-web/protocol";
import { sessionTransport } from "../stores/session-transport";
import type { SessionCommandCompletion } from "../stores/session-transport-contract";

/** Read commands are Session-addressed and never require a controller lease. */
export async function sendReadCommand(
	sessionHandle: string,
	command: SessionCommandDto,
	timeoutMs = commandTimeoutMs(command.type),
): Promise<PiSessionCommandResponseDto> {
	return sessionTransport.store.getState().sendCommand(sessionHandle, command, timeoutMs);
}

/** Mutations are fenced by the Session transport using the exact generation and lease token. */
export async function sendControlCommand(
	sessionHandle: string,
	command: SessionCommandDto,
	timeoutMs = commandTimeoutMs(command.type),
): Promise<PiSessionCommandResponseDto> {
	return sessionTransport.store.getState().sendCommand(sessionHandle, command, timeoutMs);
}

/** Identity transitions resolve with the authoritative resulting Session identity. */
export async function sendControlCommandWithIdentity(
	sessionHandle: string,
	command: SessionCommandDto,
	timeoutMs = commandTimeoutMs(command.type),
): Promise<SessionCommandCompletion> {
	return sessionTransport.store.getState().sendCommandWithIdentity(sessionHandle, command, timeoutMs);
}

export function sendControlExtensionUiResponse(
	sessionHandle: string,
	response: ExtensionUiResponseDto,
): boolean {
	return sessionTransport.store.getState().sendExtensionUiResponse(sessionHandle, response);
}
