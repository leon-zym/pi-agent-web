import type {
	ExtensionUiRequestDto,
	ProductSessionEventDto,
	SessionCommandResponseDto,
	SessionHistoryMetadataDto,
	SessionRuntimeDto,
	SessionSnapshotDto,
} from "@pi-agent-web/protocol";
import { READ_ONLY_RPC_COMMAND_TYPES } from "@pi-agent-web/protocol";

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

export interface SessionRuntimeSnapshot extends SessionRuntimeDto {
	state: SessionRuntimeState;
}

interface SessionEnvelopeBase {
	serverEpoch: string;
	sessionHandle: string;
	workspaceId: string;
	generation: number;
	seq: number;
}

export type SessionReplayFrame<TEvent = ProductSessionEventDto, TExtensionRequest = ExtensionUiRequestDto> =
	| (SessionEnvelopeBase & { type: "event"; event: TEvent })
	| (SessionEnvelopeBase & {
			type: "extension_ui_request";
			request: TExtensionRequest;
	  })
	| (SessionEnvelopeBase & {
			type: "extension_ui_closed";
			requestId: string;
			reason: "answered" | "cancelled" | "expired" | "process_lost" | "replaced";
	  });

export type SessionSupervisorMessage<
	TEvent = ProductSessionEventDto,
	TExtensionRequest = ExtensionUiRequestDto,
> =
	| SessionReplayFrame<TEvent, TExtensionRequest>
	| { type: "runtime_state"; runtime: SessionRuntimeSnapshot }
	| {
			type: "session_rekeyed";
			serverEpoch: string;
			previousSessionHandle: string;
			runtime: SessionRuntimeSnapshot;
	  }
	| { type: "session_directory_changed"; workspaceId: string }
	| { type: "auth_changed"; workspaceId?: string };

export interface ReplayCursor {
	serverEpoch: string;
	generation: number;
	seq: number;
}

export interface SessionHistoryPageResult<TMessage> {
	messages: TMessage[];
	nextCursor: string | null;
	totalMessages: number;
	totalBytes: number;
}

export interface SessionChunkedSnapshot<TMessage> {
	history: SessionHistoryMetadataDto;
	pageTargetBytes: (cursor: string, limit: number | undefined) => number;
	readPage: (
		cursor: string,
		limit: number | undefined,
		signal?: AbortSignal,
	) => Promise<SessionHistoryPageResult<TMessage>>;
}

export type ReplayResult<
	TEvent = ProductSessionEventDto,
	TSnapshot = SessionSnapshotDto,
	TExtensionRequest = ExtensionUiRequestDto,
	TMessage = TSnapshot extends { settledMessages: (infer TSnapshotMessage)[] } ? TSnapshotMessage : never,
> =
	| {
			type: "replay";
			runtime: SessionRuntimeSnapshot;
			frames: SessionReplayFrame<TEvent, TExtensionRequest>[];
	  }
	| {
			type: "resync_required";
			runtime: SessionRuntimeSnapshot;
			reason: "initial" | "server_epoch_changed" | "generation_changed" | "gap" | "invalid_cursor";
			snapshot: TSnapshot;
			chunkedSnapshot?: SessionChunkedSnapshot<TMessage>;
	  };

export interface SessionCommandResult<TResponse = SessionCommandResponseDto> {
	serverEpoch: string;
	sessionHandle: string;
	generation: number;
	/** Last event sequence observed when the Pi response was received. */
	barrierSeq: number;
	response: TResponse;
	previousSessionHandle?: string;
}

export interface SessionLeaseSnapshot {
	serverEpoch: string;
	sessionHandle: string;
	generation: number;
	isController: boolean;
	/** Present only for the controlling connection. */
	fencingToken?: string;
}

export const READ_ONLY_COMMANDS = READ_ONLY_RPC_COMMAND_TYPES;

export const HOST_MANAGED_COMMANDS = new Set(["new_session", "switch_session"]);
export const IDENTITY_TRANSITION_COMMANDS = new Set(["fork", "clone"]);

export function eventStartsWork(event: { readonly type: string }): boolean {
	return (
		event.type === "agent_start" ||
		event.type === "turn_start" ||
		event.type === "tool_execution_start" ||
		event.type === "auto_retry_start"
	);
}

export function eventSettlesWork(event: { readonly type: string }): boolean {
	return event.type === "agent_settled";
}
