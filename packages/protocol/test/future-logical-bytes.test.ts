import { describe, expect, it } from "vitest";
import type {
	FutureProductSessionEventDto,
	FutureSessionCommandResponseDto,
	FutureSessionEntryDto,
	FutureSessionProjectionEventDto,
	FutureSessionResponseFrameDto,
	FutureSessionSnapshotDto,
	FutureSessionTreeNodeDto,
	FutureSessionWsServerMessage,
	FutureToolResultMessageDto,
	SessionContentRefDto,
	SessionExternalTextDto,
	SessionJsonValueDto,
	SessionRuntimeDto,
} from "../src/index.js";
import {
	analyzeFutureProductSessionEventLogicalBytes,
	analyzeFutureSessionCommandResponseLogicalBytes,
	analyzeFutureSessionEntryLogicalBytes,
	analyzeFutureSessionMessageLogicalBytes,
	analyzeFutureSessionProjectionEventLogicalBytes,
	analyzeFutureSessionReplayFrameLogicalBytes,
	analyzeFutureSessionResponseFrameLogicalBytes,
	analyzeFutureSessionSnapshotLogicalBytes,
	analyzeFutureSessionTreeLogicalBytes,
	analyzeFutureSessionWsServerMessageLogicalBytes,
	FutureSessionLogicalBytesError,
	SESSION_CONTENT_BLOB_MAX_BYTES,
	SESSION_NORMALIZED_EVENT_MAX_BYTES,
	SESSION_PAYLOAD_BUDGET,
	SESSION_PI_JSONL_MAX_BYTES,
	SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
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

function toolResult(text: string | SessionExternalTextDto): FutureToolResultMessageDto {
	return {
		role: "toolResult",
		toolCallId: "tool-1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function entry(message = toolResult("ok")): FutureSessionEntryDto {
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

function snapshot(firstBytes: number, secondBytes: number): FutureSessionSnapshotDto {
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
		expect(analyzeFutureSessionMessageLogicalBytes(inline)).toEqual(
			analyzeFutureSessionMessageLogicalBytes(external),
		);
	});

	it("charges identical inner JSON bytes and ignores wrapper transmission shape", () => {
		const inner = { answer: "界", nested: { ok: true } };
		const innerBytes = utf8Bytes(JSON.stringify(inner));
		const inline = {
			...toolResult("ok"),
			details: { type: "inline_json", value: inner },
		} satisfies FutureToolResultMessageDto;
		const external = {
			...toolResult("ok"),
			details: { type: "external_json", ref: contentRef(innerBytes) },
		} satisfies FutureToolResultMessageDto;
		expect(analyzeFutureSessionMessageLogicalBytes(inline)).toEqual(
			analyzeFutureSessionMessageLogicalBytes(external),
		);
	});

	it("counts metadata canonically and every repeated logical root occurrence", () => {
		const one = toolResult(externalText(MIB));
		const two = {
			...one,
			content: [...one.content, { type: "text", text: externalText(MIB) }],
		} satisfies FutureToolResultMessageDto;
		const emptyRoot = analyzeFutureSessionMessageLogicalBytes(toolResult("")).byteLength;
		const oneRoot = analyzeFutureSessionMessageLogicalBytes(one).byteLength;
		const twoRoots = analyzeFutureSessionMessageLogicalBytes(two).byteLength;
		expect(oneRoot - emptyRoot).toBe(MIB);
		expect(twoRoots - oneRoot).toBeGreaterThan(MIB);
		expect(twoRoots - oneRoot).toBeLessThan(MIB + 64);
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
		} satisfies FutureToolResultMessageDto;
		const withoutDetails = analyzeFutureSessionMessageLogicalBytes(toolResult("ok")).byteLength;
		const withDetails = analyzeFutureSessionMessageLogicalBytes(message).byteLength;
		expect(withDetails - withoutDetails).toBeLessThan(1024);
		expect(withDetails - withoutDetails).toBeGreaterThan(0);
	});

	it("returns an exact safe positive result and stops at limit - 1 / = / + 1", () => {
		const message = toolResult("payload");
		const exact = analyzeFutureSessionMessageLogicalBytes(message).byteLength;
		expect(Number.isSafeInteger(exact)).toBe(true);
		expect(exact).toBeGreaterThan(0);
		expect(analyzeFutureSessionMessageLogicalBytes(message, { maxBytes: exact })).toEqual({
			byteLength: exact,
		});
		expect(() => analyzeFutureSessionMessageLogicalBytes(message, { maxBytes: exact - 1 })).toThrowError(
			expect.objectContaining({
				code: "limit_exceeded",
				limit: exact - 1,
				actual: exact,
			}),
		);
		expect(analyzeFutureSessionMessageLogicalBytes(message, { maxBytes: exact + 1 })).toEqual({
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
		} satisfies FutureToolResultMessageDto;
		expect(() => analyzeFutureSessionMessageLogicalBytes(message, { maxBytes: 128 })).toThrow(
			FutureSessionLogicalBytesError,
		);
	});

	it("covers the 8 MiB event, 48 MiB history, and 64 MiB aggregate boundaries", () => {
		const event = {
			type: "message_end",
			message: toolResult(externalText(SESSION_PI_JSONL_MAX_BYTES)),
		} satisfies FutureProductSessionEventDto;
		expect(() =>
			analyzeFutureProductSessionEventLogicalBytes(event, { maxBytes: SESSION_PI_JSONL_MAX_BYTES }),
		).toThrow(FutureSessionLogicalBytesError);
		expect(
			analyzeFutureProductSessionEventLogicalBytes(event, { maxBytes: SESSION_NORMALIZED_EVENT_MAX_BYTES })
				.byteLength,
		).toBeGreaterThan(SESSION_PI_JSONL_MAX_BYTES);

		const history = {
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages: [toolResult(externalText(SESSION_CONTENT_BLOB_MAX_BYTES))] },
		} satisfies FutureSessionCommandResponseDto;
		expect(
			analyzeFutureSessionCommandResponseLogicalBytes(history, {
				maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
			}).byteLength,
		).toBeGreaterThan(SESSION_CONTENT_BLOB_MAX_BYTES);

		const baseline = analyzeFutureSessionSnapshotLogicalBytes(snapshot(MIB, MIB)).byteLength - 2 * MIB;
		const remaining = SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES - baseline;
		const exact = snapshot(Math.floor(remaining / 2), Math.ceil(remaining / 2));
		expect(
			analyzeFutureSessionSnapshotLogicalBytes(exact, { maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES }),
		).toEqual({ byteLength: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES });
		expect(() =>
			analyzeFutureSessionSnapshotLogicalBytes(snapshot(32 * MIB, 32 * MIB), {
				maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
			}),
		).toThrow(FutureSessionLogicalBytesError);
	});

	it("exposes every verified future frame entry point with the same accounting core", () => {
		const message = toolResult(externalText(MIB));
		const historyEntry = entry(message);
		const tree = [{ entry: historyEntry, children: [] }] satisfies FutureSessionTreeNodeDto[];
		const event = { type: "message_end", message } satisfies FutureProductSessionEventDto;
		const projection = {
			type: "event",
			serverEpoch,
			sessionHandle: "session-a",
			workspaceId: "workspace-a",
			generation: 1,
			seq: 1,
			event,
		} satisfies FutureSessionProjectionEventDto;
		const ws = { type: "runtime_state", runtime: runtime(1) } satisfies FutureSessionWsServerMessage;
		expect(analyzeFutureSessionWsServerMessageLogicalBytes(ws).byteLength).toBe(
			utf8Bytes(JSON.stringify(ws)),
		);
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
		} satisfies FutureSessionResponseFrameDto;
		for (const result of [
			analyzeFutureSessionEntryLogicalBytes(historyEntry),
			analyzeFutureSessionTreeLogicalBytes(tree),
			analyzeFutureSessionProjectionEventLogicalBytes(projection),
			analyzeFutureSessionReplayFrameLogicalBytes(projection),
			analyzeFutureSessionResponseFrameLogicalBytes(responseFrame),
			analyzeFutureSessionWsServerMessageLogicalBytes(ws),
		]) {
			expect(result.byteLength).toBeGreaterThan(0);
		}
	});

	it("does not mutate the current 1.2 budget or guard surfaces", () => {
		expect(SESSION_PAYLOAD_BUDGET.maxPiJsonlFrameBytes).toBe(8 * MIB);
		expect("maxContentBlobBytes" in SESSION_PAYLOAD_BUDGET).toBe(false);
	});
});
