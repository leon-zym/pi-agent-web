import { describe, expect, it } from "vitest";
import type {
	ExtensionUiRequestDto,
	ProductSessionEventDto,
	SessionCommandResponseDto,
	SessionContentRefDto,
	SessionEntryDto,
	SessionExternalTextDto,
	SessionJsonValueDto,
	SessionProjectionEventDto,
	SessionResponseFrameDto,
	SessionRuntimeDto,
	SessionSnapshotDto,
	SessionTreeNodeDto,
	SessionWsServerMessage,
	ToolResultMessageDto,
} from "../src/index.js";
import {
	analyzeExtensionUiRequestLogicalBytes,
	analyzeProductSessionEventLogicalBytes,
	analyzeSessionCommandResponseLogicalBytes,
	analyzeSessionEntryLogicalBytes,
	analyzeSessionMessageLogicalBytes,
	analyzeSessionProjectionEventLogicalBytes,
	analyzeSessionReplayFrameLogicalBytes,
	analyzeSessionResponseFrameLogicalBytes,
	analyzeSessionSnapshotLogicalBytes,
	analyzeSessionTreeLogicalBytes,
	analyzeSessionWsServerMessageLogicalBytes,
	SESSION_CONTENT_BLOB_MAX_BYTES,
	SESSION_NORMALIZED_EVENT_MAX_BYTES,
	SESSION_PAYLOAD_BUDGET,
	SESSION_PI_JSONL_MAX_BYTES,
	SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
	SessionLogicalBytesError,
} from "../src/index.js";

const serverEpoch = "logical-byte-epoch";
const MIB = 1024 * 1024;

function contentRef(byteLength: number, sha = "a"): SessionContentRefDto {
	return {
		type: "content_ref",
		serverEpoch,
		sha256: sha.repeat(64),
		byteLength,
		encoding: "utf-8",
	};
}

function externalText(byteLength: number, sha = "a"): SessionExternalTextDto {
	return { type: "external_text", ref: contentRef(byteLength, sha) };
}

function toolResult(text: string | SessionExternalTextDto): ToolResultMessageDto {
	return {
		role: "toolResult",
		toolCallId: "tool-1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function entry(message = toolResult("ok")): SessionEntryDto {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: "2026-08-28T00:00:00.000Z",
		message,
	};
}

function runtime(lastSeq: number): SessionRuntimeDto {
	return {
		serverEpoch,
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		nativeSessionId: "native-a",
		sessionFile: "/tmp/session-a.jsonl",
		cwd: "/tmp/workspace-a",
		generation: 1,
		lastSeq,
		state: "idle",
		lastActivityAt: 1,
		recoverable: true,
	};
}

function snapshot(firstBytes: number, secondBytes: number): SessionSnapshotDto {
	return {
		type: "session_snapshot",
		snapshotId: "snapshot-a",
		serverEpoch,
		sessionHandle: "session-a",
		workspaceId: "workspace-a",
		generation: 1,
		baseSeq: 0,
		asOfSeq: 1,
		runtime: runtime(1),
		settledMessages: [toolResult(externalText(firstBytes, "a")), toolResult(externalText(secondBytes, "b"))],
		projectionEvents: [],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests: [],
		stickyExtensionState: [],
	};
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

describe("future logical payload byte analysis", () => {
	it("charges identical logical text bytes for inline and external representations", () => {
		const text = "界".repeat(16);
		const bytes = utf8Bytes(text);
		const inline = toolResult(text);
		const external = toolResult(externalText(bytes));
		expect(analyzeSessionMessageLogicalBytes(inline)).toEqual(analyzeSessionMessageLogicalBytes(external));
	});

	it("charges identical inner JSON bytes and ignores wrapper transmission shape", () => {
		const inner = { answer: "界", nested: { ok: true } };
		const innerBytes = utf8Bytes(JSON.stringify(inner));
		const inline = {
			...toolResult("ok"),
			details: { type: "inline_json", value: inner },
		} satisfies ToolResultMessageDto;
		const external = {
			...toolResult("ok"),
			details: { type: "external_json", ref: contentRef(innerBytes) },
		} satisfies ToolResultMessageDto;
		expect(analyzeSessionMessageLogicalBytes(inline)).toEqual(analyzeSessionMessageLogicalBytes(external));
	});

	it("counts metadata canonically and every repeated logical root occurrence", () => {
		const one = toolResult(externalText(MIB));
		const two = {
			...one,
			content: [...one.content, { type: "text", text: externalText(MIB) }],
		} satisfies ToolResultMessageDto;
		const emptyRoot = analyzeSessionMessageLogicalBytes(toolResult("")).byteLength;
		const oneRoot = analyzeSessionMessageLogicalBytes(one).byteLength;
		const twoRoots = analyzeSessionMessageLogicalBytes(two).byteLength;
		expect(oneRoot - emptyRoot).toBe(MIB);
		expect(twoRoots - oneRoot).toBeGreaterThan(MIB);
		expect(twoRoots - oneRoot).toBeLessThan(MIB + 64);
	});

	it("charges Extension text and whole widget JSON roots by logical content for every occurrence", () => {
		const text = "界".repeat(16);
		const textBytes = utf8Bytes(text);
		const inlineEditor = {
			type: "extension_ui_request",
			id: "editor-a",
			method: "editor",
			title: "Edit",
			prefill: text,
		} satisfies ExtensionUiRequestDto;
		const externalEditor = {
			...inlineEditor,
			prefill: externalText(textBytes),
		} satisfies ExtensionUiRequestDto;
		expect(analyzeExtensionUiRequestLogicalBytes(inlineEditor)).toEqual(
			analyzeExtensionUiRequestLogicalBytes(externalEditor),
		);
		const inlineSetEditorText = {
			type: "extension_ui_request",
			id: "set-editor-a",
			method: "set_editor_text",
			text,
		} satisfies ExtensionUiRequestDto;
		const externalSetEditorText = {
			...inlineSetEditorText,
			text: externalText(textBytes),
		} satisfies ExtensionUiRequestDto;
		expect(analyzeExtensionUiRequestLogicalBytes(inlineSetEditorText)).toEqual(
			analyzeExtensionUiRequestLogicalBytes(externalSetEditorText),
		);

		const lines = ["one", "界"];
		const widgetBytes = utf8Bytes(JSON.stringify(lines));
		const inlineWidget = {
			type: "extension_ui_request",
			id: "widget-a",
			method: "setWidget",
			widgetKey: "tests",
			widgetLines: { type: "inline_json", value: lines },
		} satisfies ExtensionUiRequestDto;
		const externalWidget = {
			...inlineWidget,
			widgetLines: { type: "external_json", ref: contentRef(widgetBytes) },
		} satisfies ExtensionUiRequestDto;
		expect(analyzeExtensionUiRequestLogicalBytes(inlineWidget)).toEqual(
			analyzeExtensionUiRequestLogicalBytes(externalWidget),
		);

		const oneOccurrence = analyzeSessionSnapshotLogicalBytes({
			...snapshot(MIB, MIB),
			pendingExtensionRequests: [externalEditor],
		}).byteLength;
		const twoOccurrences = analyzeSessionSnapshotLogicalBytes({
			...snapshot(MIB, MIB),
			pendingExtensionRequests: [externalEditor, { ...externalEditor, id: "editor-b" }],
		}).byteLength;
		expect(twoOccurrences - oneOccurrence).toBeGreaterThanOrEqual(textBytes);
	});

	it("keeps nested wrapper/ref lookalikes ordinary inside inline JSON", () => {
		const inner: SessionJsonValueDto = {
			type: "external_json",
			ref: {
				type: "content_ref",
				serverEpoch,
				sha256: "a".repeat(64),
				byteLength: SESSION_CONTENT_BLOB_MAX_BYTES,
				encoding: "utf-8",
			},
		};
		const message = {
			...toolResult("ok"),
			details: { type: "inline_json", value: inner },
		} satisfies ToolResultMessageDto;
		const withoutDetails = analyzeSessionMessageLogicalBytes(toolResult("ok")).byteLength;
		const withDetails = analyzeSessionMessageLogicalBytes(message).byteLength;
		expect(withDetails - withoutDetails).toBeLessThan(1024);
		expect(withDetails - withoutDetails).toBeGreaterThan(0);
	});

	it("returns an exact safe positive result and stops at limit - 1 / = / + 1", () => {
		const message = toolResult("payload");
		const exact = analyzeSessionMessageLogicalBytes(message).byteLength;
		expect(Number.isSafeInteger(exact)).toBe(true);
		expect(exact).toBeGreaterThan(0);
		expect(analyzeSessionMessageLogicalBytes(message, { maxBytes: exact })).toEqual({
			byteLength: exact,
		});
		expect(() => analyzeSessionMessageLogicalBytes(message, { maxBytes: exact - 1 })).toThrowError(
			expect.objectContaining({
				code: "limit_exceeded",
				limit: exact - 1,
				actual: exact,
			}),
		);
		expect(analyzeSessionMessageLogicalBytes(message, { maxBytes: exact + 1 })).toEqual({
			byteLength: exact,
		});
	});

	it("stops before reading later fields once the limit is exceeded", () => {
		const message = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text", text: externalText(MIB) }],
			get details(): never {
				throw new Error("late field must not be read");
			},
			isError: false,
			timestamp: 1,
		} satisfies ToolResultMessageDto;
		expect(() => analyzeSessionMessageLogicalBytes(message, { maxBytes: 128 })).toThrow(
			SessionLogicalBytesError,
		);
	});

	it("covers the 8 MiB event, 48 MiB history, and 64 MiB aggregate boundaries", () => {
		const event = {
			type: "message_end",
			message: toolResult(externalText(SESSION_PI_JSONL_MAX_BYTES)),
		} satisfies ProductSessionEventDto;
		expect(() =>
			analyzeProductSessionEventLogicalBytes(event, { maxBytes: SESSION_PI_JSONL_MAX_BYTES }),
		).toThrow(SessionLogicalBytesError);
		expect(
			analyzeProductSessionEventLogicalBytes(event, { maxBytes: SESSION_NORMALIZED_EVENT_MAX_BYTES })
				.byteLength,
		).toBeGreaterThan(SESSION_PI_JSONL_MAX_BYTES);

		const history = {
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages: [toolResult(externalText(SESSION_CONTENT_BLOB_MAX_BYTES))] },
		} satisfies SessionCommandResponseDto;
		expect(
			analyzeSessionCommandResponseLogicalBytes(history, {
				maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
			}).byteLength,
		).toBeGreaterThan(SESSION_CONTENT_BLOB_MAX_BYTES);

		const baseline = analyzeSessionSnapshotLogicalBytes(snapshot(MIB, MIB)).byteLength - 2 * MIB;
		const remaining = SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES - baseline;
		const exact = snapshot(Math.floor(remaining / 2), Math.ceil(remaining / 2));
		expect(
			analyzeSessionSnapshotLogicalBytes(exact, { maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES }),
		).toEqual({ byteLength: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES });
		expect(() =>
			analyzeSessionSnapshotLogicalBytes(snapshot(32 * MIB, 32 * MIB), {
				maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
			}),
		).toThrow(SessionLogicalBytesError);
	});

	it("exposes every verified future frame entry point with the same accounting core", () => {
		const message = toolResult(externalText(MIB));
		const historyEntry = entry(message);
		const tree = [{ entry: historyEntry, children: [] }] satisfies SessionTreeNodeDto[];
		const event = { type: "message_end", message } satisfies ProductSessionEventDto;
		const projection = {
			type: "event",
			serverEpoch,
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 1,
			seq: 1,
			event,
		} satisfies SessionProjectionEventDto;
		const ws = { type: "runtime_state", runtime: runtime(1) } satisfies SessionWsServerMessage;
		expect(analyzeSessionWsServerMessageLogicalBytes(ws).byteLength).toBe(utf8Bytes(JSON.stringify(ws)));
		const responseFrame = {
			type: "response",
			serverEpoch,
			sessionHandle: "session-a",
			generation: 1,
			barrierSeq: 1,
			response: {
				type: "response",
				command: "get_messages",
				success: true,
				data: { messages: [message] },
			},
		} satisfies SessionResponseFrameDto;
		for (const result of [
			analyzeSessionEntryLogicalBytes(historyEntry),
			analyzeSessionTreeLogicalBytes(tree),
			analyzeSessionProjectionEventLogicalBytes(projection),
			analyzeSessionReplayFrameLogicalBytes(projection),
			analyzeSessionResponseFrameLogicalBytes(responseFrame),
			analyzeSessionWsServerMessageLogicalBytes(ws),
		]) {
			expect(result.byteLength).toBeGreaterThan(0);
		}
	});

	it("keeps Pi JSONL and Browser content budgets independent", () => {
		expect(SESSION_PAYLOAD_BUDGET.maxPiJsonlFrameBytes).toBe(8 * MIB);
		expect("maxContentBlobBytes" in SESSION_PAYLOAD_BUDGET).toBe(false);
	});
});
