/** Future-only protocol 1.3 product DTOs. Current 1.2 DTOs remain unchanged. */

import type {
	AssistantMessageDto,
	AssistantMessageStreamEventDto,
	BashExecutionMessageDto,
	CustomMessageDto,
	ExtensionErrorEventDto,
	ExtensionUiRequestDto,
	SessionCommandDataMap,
	SessionCommandResponseDto,
	SessionCommandTypeDto,
	SessionEntryDto,
	SessionEventDto,
	SessionImageContentDto,
	SessionJsonRootDto,
	SessionMessageDto,
	SessionTextPayloadDto,
	SessionTreeNodeDto,
	TextContentDto,
	ToolCallContentDto,
	ToolResultMessageDto,
} from "./product-dto.js";

export type FutureTextContentDto = Omit<TextContentDto, "text"> & { text: SessionTextPayloadDto };
export type FutureToolCallContentDto = Omit<ToolCallContentDto, "arguments"> & {
	arguments: SessionJsonRootDto;
};
export type FutureAssistantMessageDto = Omit<AssistantMessageDto, "content"> & {
	content: Array<
		Exclude<AssistantMessageDto["content"][number], ToolCallContentDto> | FutureToolCallContentDto
	>;
};
export type FutureToolResultMessageDto = Omit<ToolResultMessageDto, "content" | "details"> & {
	content: Array<FutureTextContentDto | SessionImageContentDto>;
	details?: SessionJsonRootDto;
};
export type FutureBashExecutionMessageDto = Omit<BashExecutionMessageDto, "output"> & {
	output: SessionTextPayloadDto;
};
export type FutureCustomMessageDto = Omit<CustomMessageDto, "content" | "details"> & {
	content: string | Array<FutureTextContentDto | SessionImageContentDto>;
	details?: SessionJsonRootDto;
};

export type FutureSessionMessageDto =
	| Exclude<
			SessionMessageDto,
			AssistantMessageDto | ToolResultMessageDto | BashExecutionMessageDto | CustomMessageDto
	  >
	| FutureAssistantMessageDto
	| FutureToolResultMessageDto
	| FutureBashExecutionMessageDto
	| FutureCustomMessageDto;

type FutureEditorExtensionUiRequestDto = Omit<
	Extract<ExtensionUiRequestDto, { method: "editor" }>,
	"prefill"
> & {
	prefill?: SessionTextPayloadDto;
};

type FutureSetEditorTextExtensionUiRequestDto = Omit<
	Extract<ExtensionUiRequestDto, { method: "set_editor_text" }>,
	"text"
> & {
	text: SessionTextPayloadDto;
};

type FutureSetWidgetExtensionUiRequestDto = Omit<
	Extract<ExtensionUiRequestDto, { method: "setWidget" }>,
	"widgetLines"
> & {
	/** The whole string-array root is normalized; individual lines never carry wrappers. */
	widgetLines?: SessionJsonRootDto;
};

export type FutureExtensionUiRequestDto =
	| Exclude<ExtensionUiRequestDto, { method: "editor" | "setWidget" | "set_editor_text" }>
	| FutureEditorExtensionUiRequestDto
	| FutureSetWidgetExtensionUiRequestDto
	| FutureSetEditorTextExtensionUiRequestDto;

export type FutureBlockingExtensionUiRequestDto = Extract<
	FutureExtensionUiRequestDto,
	{ method: "select" | "confirm" | "input" | "editor" }
>;

export type FutureStickyExtensionUiRequestDto = Extract<
	FutureExtensionUiRequestDto,
	{ method: "setStatus" | "setWidget" | "setTitle" | "set_editor_text" }
>;

type FutureMessageEntryDto = Omit<Extract<SessionEntryDto, { type: "message" }>, "message"> & {
	message: FutureSessionMessageDto;
};
type FutureCustomMessageEntryDto = Omit<
	Extract<SessionEntryDto, { type: "custom_message" }>,
	"content" | "details"
> & {
	content: string | Array<FutureTextContentDto | SessionImageContentDto>;
	details?: SessionJsonRootDto;
};

export type FutureSessionEntryDto =
	| Exclude<SessionEntryDto, { type: "message" | "custom_message" }>
	| FutureMessageEntryDto
	| FutureCustomMessageEntryDto;

export interface FutureSessionTreeNodeDto extends Omit<SessionTreeNodeDto, "entry" | "children"> {
	entry: FutureSessionEntryDto;
	children: FutureSessionTreeNodeDto[];
}

export type FutureAssistantMessageStreamEventDto =
	| Exclude<AssistantMessageStreamEventDto, { type: "toolcall_end" }>
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: FutureToolCallContentDto;
	  };

type FutureSessionEventReplacementDto =
	| { type: "agent_end"; messages: FutureSessionMessageDto[]; willRetry: boolean }
	| {
			type: "turn_end";
			message: FutureSessionMessageDto;
			toolResults: FutureToolResultMessageDto[];
	  }
	| { type: "message_start" | "message_end"; message: FutureSessionMessageDto }
	| {
			type: "message_update";
			usage: Extract<SessionEventDto, { type: "message_update" }>["usage"];
			assistantMessageEvent: FutureAssistantMessageStreamEventDto;
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
	| { type: "entry_appended"; entry: FutureSessionEntryDto };

type FutureReplacedSessionEventType = FutureSessionEventReplacementDto["type"];
export type FutureSessionEventDto =
	| Exclude<SessionEventDto, { type: FutureReplacedSessionEventType }>
	| FutureSessionEventReplacementDto;
export type FutureProductSessionEventDto = FutureSessionEventDto | ExtensionErrorEventDto;

export interface FutureSessionCommandDataMap
	extends Omit<SessionCommandDataMap, "get_messages" | "get_entries" | "get_tree"> {
	get_messages: { messages: FutureSessionMessageDto[] };
	get_entries: { entries: FutureSessionEntryDto[]; leafId: string | null };
	get_tree: { tree: FutureSessionTreeNodeDto[]; leafId: string | null };
}

type FutureSuccessResponseDto<K extends SessionCommandTypeDto> = {
	id?: string;
	type: "response";
	command: K;
	success: true;
} & (FutureSessionCommandDataMap[K] extends undefined
	? { data?: undefined }
	: { data: FutureSessionCommandDataMap[K] });

export type FutureSessionCommandResponseDto =
	| Extract<SessionCommandResponseDto, { success: false }>
	| { [K in SessionCommandTypeDto]: FutureSuccessResponseDto<K> }[SessionCommandTypeDto];
