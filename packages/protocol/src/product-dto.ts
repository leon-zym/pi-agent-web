/** Product-owned Browser/Gateway DTOs. No upstream Pi types may cross this module. */

import type { SessionAttachmentRefDto, SessionPayloadAdmissionErrorDto } from "./payload-budget.js";

export type ThinkingLevelDto = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ImageContentDto {
	type: "image";
	data: string;
	mimeType: string;
}

/** Gateway-to-Browser image content. Browser-to-Gateway commands remain inline-only ImageContentDto. */
export interface SessionImageContentDto {
	type: "image";
	data: string | SessionAttachmentRefDto;
	mimeType: string;
}

export interface TextContentDto {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContentDto {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ToolCallContentDto {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
	thoughtSignature?: string;
	namespace?: string;
}

export interface UsageDto {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface DiagnosticErrorInfoDto {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

export interface AssistantMessageDiagnosticDto {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfoDto;
	details?: Record<string, unknown>;
}

export interface DeferredHandleDto {
	provider: string;
	modelId: string;
	api: string;
	id: string;
	expiresAt?: number;
	pollAfterMs?: number;
	data?: unknown;
}

export interface UserMessageDto {
	role: "user";
	content: string | (TextContentDto | SessionImageContentDto)[];
	timestamp: number;
}

export interface AssistantMessageDto {
	role: "assistant";
	content: (TextContentDto | ThinkingContentDto | ToolCallContentDto)[];
	usage: UsageDto;
	stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
	errorMessage?: string;
	timestamp: number;
	api?: string;
	provider?: string;
	model?: string;
	responseModel?: string;
	responseId?: string;
	diagnostics?: AssistantMessageDiagnosticDto[];
	deferred?: DeferredHandleDto;
	rawStopReason?: string;
	endTurn?: boolean;
}

export interface ToolResultMessageDto {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContentDto | SessionImageContentDto)[];
	details?: unknown;
	usage?: UsageDto;
	addedToolNames?: string[];
	isError: boolean;
	timestamp: number;
}

export interface BashExecutionMessageDto {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode?: number;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
	timestamp: number;
}

export interface CustomMessageDto {
	role: "custom";
	customType: string;
	content: string | (TextContentDto | SessionImageContentDto)[];
	display: boolean;
	details?: unknown;
	timestamp: number;
}

export interface SummaryMessageDto {
	role: "branchSummary" | "compactionSummary";
	summary: string;
	timestamp: number;
	fromId?: string;
	tokensBefore?: number;
}

export type SessionMessageDto =
	| UserMessageDto
	| AssistantMessageDto
	| ToolResultMessageDto
	| BashExecutionMessageDto
	| CustomMessageDto
	| SummaryMessageDto;

export interface ModelDto {
	id: string;
	name: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total?: number;
	};
}

export interface SessionStateDto {
	model?: ModelDto;
	thinkingLevel: ThinkingLevelDto;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export interface SessionStatsDto {
	sessionFile?: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
}

export interface CompactionResultDto {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	usage?: UsageDto;
	details?: unknown;
}

export interface BashResultDto {
	output: string;
	exitCode?: number;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

interface SessionEntryBaseDto {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export type SessionEntryDto =
	| (SessionEntryBaseDto & { type: "message"; message: SessionMessageDto })
	| (SessionEntryBaseDto & { type: "thinking_level_change"; thinkingLevel: string })
	| (SessionEntryBaseDto & { type: "model_change"; provider: string; modelId: string })
	| (SessionEntryBaseDto & {
			type: "compaction";
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
			details?: unknown;
			usage?: UsageDto;
			fromHook?: boolean;
	  })
	| (SessionEntryBaseDto & {
			type: "branch_summary";
			fromId: string;
			summary: string;
			details?: unknown;
			usage?: UsageDto;
			fromHook?: boolean;
	  })
	| (SessionEntryBaseDto & { type: "custom"; customType: string; data?: unknown })
	| (SessionEntryBaseDto & {
			type: "custom_message";
			customType: string;
			content: string | (TextContentDto | SessionImageContentDto)[];
			details?: unknown;
			display: boolean;
	  })
	| (SessionEntryBaseDto & { type: "label"; targetId: string; label?: string })
	| (SessionEntryBaseDto & { type: "session_info"; name?: string });

export interface SessionTreeNodeDto {
	entry: SessionEntryDto;
	children: SessionTreeNodeDto[];
	label?: string;
	labelTimestamp?: string;
}

export interface SlashCommandDto {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: Record<string, unknown>;
}

export type SessionCommandDto =
	| {
			id?: string;
			type: "prompt";
			message: string;
			images?: ImageContentDto[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { id?: string; type: "steer" | "follow_up"; message: string; images?: ImageContentDto[] }
	| { id?: string; type: "abort" | "cycle_model" | "get_available_models" | "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" | "abort_retry" | "abort_bash" }
	| { id?: string; type: "get_session_stats" | "clone" | "get_fork_messages" | "get_tree" }
	| { id?: string; type: "get_last_assistant_text" | "get_messages" | "get_commands" | "get_state" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevelDto }
	| { id?: string; type: "set_steering_mode" | "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction" | "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "set_session_name"; name: string };

export type SessionCommandTypeDto = SessionCommandDto["type"];

export interface SessionCommandDataMap {
	prompt: undefined;
	steer: undefined;
	follow_up: undefined;
	abort: undefined;
	new_session: { cancelled: boolean };
	get_state: SessionStateDto;
	set_model: ModelDto;
	cycle_model: { model: ModelDto; thinkingLevel: ThinkingLevelDto; isScoped: boolean } | null;
	get_available_models: { models: ModelDto[] };
	set_thinking_level: undefined;
	cycle_thinking_level: { level: ThinkingLevelDto } | null;
	get_available_thinking_levels: { levels: ThinkingLevelDto[] };
	set_steering_mode: undefined;
	set_follow_up_mode: undefined;
	compact: CompactionResultDto;
	set_auto_compaction: undefined;
	set_auto_retry: undefined;
	abort_retry: undefined;
	bash: BashResultDto;
	abort_bash: undefined;
	get_session_stats: SessionStatsDto;
	export_html: { path: string; url?: string };
	switch_session: { cancelled: boolean };
	fork: { text: string; cancelled: boolean };
	clone: { cancelled: boolean };
	get_fork_messages: { messages: Array<{ entryId: string; text: string }> };
	get_entries: { entries: SessionEntryDto[]; leafId: string | null };
	get_tree: { tree: SessionTreeNodeDto[]; leafId: string | null };
	get_last_assistant_text: { text: string | null };
	set_session_name: undefined;
	get_messages: { messages: SessionMessageDto[] };
	get_commands: { commands: SlashCommandDto[] };
}

type SuccessResponseDto<K extends SessionCommandTypeDto> = {
	id?: string;
	type: "response";
	command: K;
	success: true;
} & (SessionCommandDataMap[K] extends undefined ? { data?: undefined } : { data: SessionCommandDataMap[K] });

export type SessionCommandResponseDto =
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			admissionError?: SessionPayloadAdmissionErrorDto;
	  }
	| { [K in SessionCommandTypeDto]: SuccessResponseDto<K> }[SessionCommandTypeDto];

export type SessionCommandResponseFor<K extends SessionCommandTypeDto> =
	| SuccessResponseDto<K>
	| {
			id?: string;
			type: "response";
			command: K;
			success: false;
			error: string;
			admissionError?: SessionPayloadAdmissionErrorDto;
	  };

export type ExtensionUiRequestDto =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			title: string;
			options: string[];
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "confirm";
			title: string;
			message: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines?: string[];
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type ExtensionUiResponseDto =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

export type AssistantMessageStreamEventDto =
	| { type: "start" }
	| { type: "text_start" | "thinking_start"; contentIndex: number }
	| { type: "toolcall_start"; contentIndex: number; id?: string; toolName?: string }
	| { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContentDto }
	| { type: "done"; reason: "stop" | "length" | "toolUse" | "deferred"; message?: AssistantMessageDto }
	| { type: "error"; reason: "aborted" | "error"; error?: AssistantMessageDto };

export type SessionEventDto =
	| { type: "agent_start" | "turn_start" | "agent_settled" | "summarization_retry_finished" }
	| { type: "agent_end"; messages: SessionMessageDto[]; willRetry: boolean }
	| { type: "turn_end"; message: SessionMessageDto; toolResults: ToolResultMessageDto[] }
	| { type: "message_start"; message: SessionMessageDto }
	| { type: "message_end"; message: SessionMessageDto }
	| { type: "message_update"; usage: UsageDto; assistantMessageEvent: AssistantMessageStreamEventDto }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: unknown;
	  }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntryDto }
	| { type: "session_info_changed"; name?: string }
	| { type: "thinking_level_changed"; level: ThinkingLevelDto }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result?: unknown;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start" | "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_attempt_start";
			source: "branchSummary" | "compaction";
			reason?: "manual" | "threshold" | "overflow";
	  }
	| { type: "bash_execution_update"; id?: string; delta: string };

export interface ExtensionErrorEventDto {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

export type ProductSessionEventDto = SessionEventDto | ExtensionErrorEventDto;
