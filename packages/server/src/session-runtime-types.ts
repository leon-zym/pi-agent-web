import type { RpcExtensionUIRequest, RpcResponse } from "@earendil-works/pi-coding-agent";
import { type PiWebSessionEvent, READ_ONLY_RPC_COMMAND_TYPES } from "@pi-agent-web/protocol";

export type SessionRuntimeState = "starting" | "idle" | "running" | "waiting_ui" | "crashed" | "dormant";

export interface ExistingSessionTarget {
	kind: "existing";
	sessionHandle: string;
	workspaceId: string;
	cwd: string;
	sessionFile: string;
	nativeSessionId: string;
}

export interface NewSessionTarget {
	kind: "new";
	/** Temporary handle used only until Pi's ready state exposes sessionFile. */
	sessionHandle: string;
	workspaceId: string;
	cwd: string;
	sessionDir: string;
	nativeSessionId: string;
}

export type SessionTarget = ExistingSessionTarget | NewSessionTarget;

export interface SessionRuntimeSnapshot {
	sessionHandle: string;
	workspaceId: string;
	nativeSessionId: string;
	sessionFile: string | null;
	cwd: string;
	generation: number;
	lastSeq: number;
	state: SessionRuntimeState;
	lastActivityAt: number;
	recoverable: boolean;
	error?: string;
}

interface SessionEnvelopeBase {
	sessionHandle: string;
	workspaceId: string;
	generation: number;
	seq: number;
}

export type SessionReplayFrame =
	| (SessionEnvelopeBase & { type: "event"; event: PiWebSessionEvent })
	| (SessionEnvelopeBase & {
			type: "extension_ui_request";
			request: RpcExtensionUIRequest;
	  })
	| (SessionEnvelopeBase & {
			type: "extension_ui_closed";
			requestId: string;
			reason: "answered" | "cancelled" | "expired" | "process_lost" | "replaced";
	  });

export type SessionSupervisorMessage =
	| SessionReplayFrame
	| { type: "runtime_state"; runtime: SessionRuntimeSnapshot }
	| {
			type: "session_rekeyed";
			previousSessionHandle: string;
			runtime: SessionRuntimeSnapshot;
	  }
	| { type: "session_directory_changed"; workspaceId: string }
	| { type: "auth_changed"; workspaceId?: string };

export interface ReplayCursor {
	generation: number;
	seq: number;
}

export type ReplayResult =
	| {
			type: "replay";
			runtime: SessionRuntimeSnapshot;
			frames: SessionReplayFrame[];
			extensionRequests: RpcExtensionUIRequest[];
	  }
	| {
			type: "resync_required";
			runtime: SessionRuntimeSnapshot;
			reason: "initial" | "generation_changed" | "gap" | "invalid_cursor";
			extensionRequests: RpcExtensionUIRequest[];
	  };

export interface SessionCommandResult {
	sessionHandle: string;
	generation: number;
	/** Last event sequence observed when the Pi response was received. */
	barrierSeq: number;
	response: RpcResponse;
	previousSessionHandle?: string;
}

export interface SessionLeaseSnapshot {
	sessionHandle: string;
	isController: boolean;
	/** Present only for the controlling connection. */
	fencingToken?: string;
}

export const READ_ONLY_COMMANDS = READ_ONLY_RPC_COMMAND_TYPES;

export const HOST_MANAGED_COMMANDS = new Set(["new_session", "switch_session"]);
export const IDENTITY_TRANSITION_COMMANDS = new Set(["fork", "clone"]);

export function eventStartsWork(event: PiWebSessionEvent): boolean {
	return (
		event.type === "agent_start" ||
		event.type === "turn_start" ||
		event.type === "tool_execution_start" ||
		event.type === "auto_retry_start"
	);
}

export function eventSettlesWork(event: PiWebSessionEvent): boolean {
	return event.type === "agent_settled";
}
