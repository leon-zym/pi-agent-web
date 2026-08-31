/** Protocol 1.4 content-reference product DTOs. */

import type {
	ExtensionErrorEventDto,
	PiAssistantMessageDto,
	PiAssistantMessageStreamEventDto,
	PiBashExecutionMessageDto,
	PiCustomMessageDto,
	PiExtensionUiRequestDto,
	PiSessionCommandDataMap,
	PiSessionCommandResponseDto,
	PiSessionEntryDto,
	PiSessionEventDto,
	PiSessionMessageDto,
	PiSessionTreeNodeDto,
	PiTextContentDto,
	PiToolCallContentDto,
	PiToolResultMessageDto,
	SessionCommandTypeDto,
	SessionImageContentDto,
	SessionJsonRootDto,
	SessionTextPayloadDto,
} from "./pi-product-dto.js";

export type TextContentDto = Omit<PiTextContentDto, "text"> & { text: SessionTextPayloadDto };
export type ToolCallContentDto = Omit<PiToolCallContentDto, "arguments"> & {
	arguments: SessionJsonRootDto;
};
export type AssistantMessageDto = Omit<PiAssistantMessageDto, "content"> & {
	content: Array<
		Exclude<PiAssistantMessageDto["content"][number], PiToolCallContentDto> | ToolCallContentDto
	>;
};
export type ToolResultMessageDto = Omit<PiToolResultMessageDto, "content" | "details"> & {
	content: Array<TextContentDto | SessionImageContentDto>;
	details?: SessionJsonRootDto;
};
export type BashExecutionMessageDto = Omit<PiBashExecutionMessageDto, "output"> & {
	output: SessionTextPayloadDto;
};
export type CustomMessageDto = Omit<PiCustomMessageDto, "content" | "details"> & {
	content: string | Array<TextContentDto | SessionImageContentDto>;
	details?: SessionJsonRootDto;
};

export type SessionMessageDto =
	| Exclude<
			PiSessionMessageDto,
			PiAssistantMessageDto | PiToolResultMessageDto | PiBashExecutionMessageDto | PiCustomMessageDto
	  >
	| AssistantMessageDto
	| ToolResultMessageDto
	| BashExecutionMessageDto
	| CustomMessageDto;

type EditorExtensionUiRequestDto = Omit<Extract<PiExtensionUiRequestDto, { method: "editor" }>, "prefill"> & {
	prefill?: SessionTextPayloadDto;
};

type SetEditorTextExtensionUiRequestDto = Omit<
	Extract<PiExtensionUiRequestDto, { method: "set_editor_text" }>,
	"text"
> & {
	text: SessionTextPayloadDto;
};

type SetWidgetExtensionUiRequestDto = Omit<
	Extract<PiExtensionUiRequestDto, { method: "setWidget" }>,
	"widgetLines"
> & {
	/** The whole string-array root is normalized; individual lines never carry wrappers. */
	widgetLines?: SessionJsonRootDto;
};

export type ExtensionUiRequestDto =
	| Exclude<PiExtensionUiRequestDto, { method: "editor" | "setWidget" | "set_editor_text" }>
	| EditorExtensionUiRequestDto
	| SetWidgetExtensionUiRequestDto
	| SetEditorTextExtensionUiRequestDto;

export type BlockingExtensionUiRequestDto = Extract<
	ExtensionUiRequestDto,
	{ method: "select" | "confirm" | "input" | "editor" }
>;

export type StickyExtensionUiRequestDto = Extract<
	ExtensionUiRequestDto,
	{ method: "setStatus" | "setWidget" | "setTitle" | "set_editor_text" }
>;

type MessageEntryDto = Omit<Extract<PiSessionEntryDto, { type: "message" }>, "message"> & {
	message: SessionMessageDto;
};
type CustomMessageEntryDto = Omit<
	Extract<PiSessionEntryDto, { type: "custom_message" }>,
	"content" | "details"
> & {
	content: string | Array<TextContentDto | SessionImageContentDto>;
	details?: SessionJsonRootDto;
};

export type SessionEntryDto =
	| Exclude<PiSessionEntryDto, { type: "message" | "custom_message" }>
	| MessageEntryDto
	| CustomMessageEntryDto;

export interface SessionTreeNodeDto extends Omit<PiSessionTreeNodeDto, "entry" | "children"> {
	entry: SessionEntryDto;
	children: SessionTreeNodeDto[];
}

export type AssistantMessageStreamEventDto =
	| Exclude<PiAssistantMessageStreamEventDto, { type: "toolcall_end" }>
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: ToolCallContentDto;
	  };

type SessionEventReplacementDto =
	| { type: "agent_end"; messages: SessionMessageDto[]; willRetry: boolean }
	| {
			type: "turn_end";
			message: SessionMessageDto;
			toolResults: ToolResultMessageDto[];
	  }
	| { type: "message_start" | "message_end"; message: SessionMessageDto }
	| {
			type: "message_update";
			usage: Extract<PiSessionEventDto, { type: "message_update" }>["usage"];
			assistantMessageEvent: AssistantMessageStreamEventDto;
	  }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: SessionJsonRootDto }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: SessionJsonRootDto;
			partialResult: SessionJsonRootDto;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: SessionJsonRootDto;
			isError: boolean;
	  }
	| { type: "entry_appended"; entry: SessionEntryDto };

type ReplacedSessionEventType = SessionEventReplacementDto["type"];
export type SessionEventDto =
	| Exclude<PiSessionEventDto, { type: ReplacedSessionEventType }>
	| SessionEventReplacementDto;
export type ProductSessionEventDto = SessionEventDto | ExtensionErrorEventDto;

export interface SessionCommandDataMap
	extends Omit<PiSessionCommandDataMap, "get_messages" | "get_entries" | "get_tree"> {
	get_messages: { messages: SessionMessageDto[] };
	get_entries: { entries: SessionEntryDto[]; leafId: string | null };
	get_tree: { tree: SessionTreeNodeDto[]; leafId: string | null };
}

type SuccessResponseDto<K extends SessionCommandTypeDto> = {
	id?: string;
	type: "response";
	command: K;
	success: true;
} & (SessionCommandDataMap[K] extends undefined ? { data?: undefined } : { data: SessionCommandDataMap[K] });

export type SessionCommandResponseDto =
	| Extract<PiSessionCommandResponseDto, { success: false }>
	| { [K in SessionCommandTypeDto]: SuccessResponseDto<K> }[SessionCommandTypeDto];
