import type { ImageContent } from "./pi-types";

/**
 * View models for the conversation projection.
 * The product layer never renders raw protocol events directly.
 */

export type TurnStatus = "running" | "settled" | "aborted" | "error";

export type UiUserMessageSource = "prompt" | "steer" | "follow_up";

export interface UiUserMessage {
	/** Stable key (turnId + ordinal). */
	entryKey: string;
	text: string;
	/** Slash/skill invocation rendered as an atomic tag; expanded skill source is never displayed. */
	command?: string;
	images?: ImageContent[];
	source: UiUserMessageSource;
	/** queued-but-not-injected messages show a badge */
	delivered: boolean;
}

export type ToolCallStatus = "preparing" | "running" | "done" | "error" | "skipped" | "interrupted";

export type ContentBlock =
	| { type: "thinking"; key: string; text: string; isStreaming: boolean; redacted?: boolean }
	| { type: "text"; key: string; markdown: string; isStreaming: boolean }
	| {
			type: "tool_call";
			key: string;
			toolCallId: string;
			toolName: string;
			/** Raw JSON argument text while streaming; parsed object after toolcall_end. */
			argsText: string;
			args: unknown;
			status: ToolCallStatus;
			/** Cumulative partial result snapshot from tool_execution_update. */
			partialOutput?: string;
			/** Final result payload from tool_execution_end. */
			result?: unknown;
	  };

export interface UiToolResult {
	toolCallId: string;
	toolName: string;
	/** Flattened text content shown to the user. */
	content: string;
	isError: boolean;
	details?: unknown;
}

export interface AssistantStep {
	key: string;
	blocks: ContentBlock[];
	toolResults: UiToolResult[];
	isSettled: boolean;
	timing?: { startTime: number; endTime?: number };
	usage?: Partial<{
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: number;
	}>;
}

export interface ProductTurn {
	id: string;
	userMessages: UiUserMessage[];
	steps: AssistantStep[];
	status: TurnStatus;
	errorMessage?: string;
	timing?: { startTime: number; endTime?: number; durationMs?: number };
	usage?: { totalTokens: number; cost: number };
}

/** Transient status rows (compaction / auto-retry) rendered between turns. */
export type StatusRow =
	| { key: string; kind: "compaction"; state: "running" | "done" | "failed"; detail?: string }
	| { key: string; kind: "retry"; state: "waiting" | "done"; detail: string };

export interface ConversationProjection {
	sessionId: string;
	turns: ProductTurn[];
	statusRows: StatusRow[];
	queue: { steering: string[]; followUp: string[] };
	/** Monotonic id generator for turns. */
	turnSeq: number;
	/** Id of the currently running turn, if any. */
	activeTurnId: string | null;
	/** True when a snapshot replay is allowed (no running turns). */
	replayable: boolean;
}

export function createEmptyProjection(sessionId: string): ConversationProjection {
	return {
		sessionId,
		turns: [],
		statusRows: [],
		queue: { steering: [], followUp: [] },
		turnSeq: 0,
		activeTurnId: null,
		replayable: true,
	};
}
