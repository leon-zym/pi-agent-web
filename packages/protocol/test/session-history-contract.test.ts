import { describe, expect, it } from "vitest";
import {
	isInlineSessionWsServerMessage,
	isSessionWsClientMessage,
	sessionHistoryChecksum,
	sessionHistoryMessagesBytes,
} from "../src/index.js";

const identity = {
	serverEpoch: "gateway-epoch-a",
	sessionHandle: "session-a",
	workspaceId: "workspace-a",
	generation: 2,
} as const;

const runtime = {
	...identity,
	nativeSessionId: "native-a",
	sessionFile: "/tmp/session-a.jsonl",
	cwd: "/tmp/workspace-a",
	lastSeq: 4,
	state: "idle" as const,
	lastActivityAt: 123,
	recoverable: true,
};

const messages = [
	{ role: "user" as const, content: "older", timestamp: 1 },
	{
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "newer" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	},
];

function snapshotFrames() {
	const checksum = sessionHistoryChecksum(messages);
	const byteCount = sessionHistoryMessagesBytes(messages);
	return {
		begin: {
			type: "session_snapshot_begin" as const,
			...identity,
			snapshotId: "snapshot-a",
			baseSeq: 1,
			asOfSeq: 4,
			runtime,
			projectionEvents: [
				{
					type: "event" as const,
					...identity,
					seq: 4,
					event: { type: "turn_start" as const },
				},
			],
			queue: { steering: [], followUp: [] },
			pendingExtensionRequests: [],
			stickyExtensionState: [],
			history: {
				totalMessages: 10,
				loadedMessages: messages.length,
				loadedBytes: byteCount,
				totalBytes: byteCount + 100,
				nextCursor: "cursor-a",
			},
		},
		chunk: {
			type: "session_snapshot_chunk" as const,
			...identity,
			snapshotId: "snapshot-a",
			chunkIndex: 0,
			messages,
			itemCount: messages.length,
			byteCount,
			checksum,
		},
		end: {
			type: "session_snapshot_end" as const,
			...identity,
			snapshotId: "snapshot-a",
			chunkCount: 1,
			itemCount: messages.length,
			byteCount,
			checksum: sessionHistoryChecksum([checksum]),
			nextCursor: "cursor-a",
		},
	};
}

describe("chunked Session history protocol", () => {
	it("accepts a fenced snapshot stream and rejects payload corruption", () => {
		const frames = snapshotFrames();
		expect(isInlineSessionWsServerMessage(frames.begin)).toBe(true);
		expect(isInlineSessionWsServerMessage(frames.chunk)).toBe(true);
		expect(isInlineSessionWsServerMessage(frames.end)).toBe(true);
		expect(
			isInlineSessionWsServerMessage({
				...frames.chunk,
				checksum: "00000000",
			}),
		).toBe(false);
		expect(
			isInlineSessionWsServerMessage({
				...frames.chunk,
				itemCount: frames.chunk.itemCount + 1,
			}),
		).toBe(false);
		expect(
			isInlineSessionWsServerMessage({
				...frames.begin,
				history: {
					...frames.begin.history,
					loadedBytes: Number.MAX_SAFE_INTEGER,
					totalBytes: Number.MAX_SAFE_INTEGER,
				},
			}),
		).toBe(false);
	});

	it("requires the snapshot identity on history page requests and cancellation", () => {
		expect(
			isSessionWsClientMessage({
				type: "session_history_page",
				id: "page-a",
				sessionHandle: identity.sessionHandle,
				expectedGeneration: identity.generation,
				snapshotId: "snapshot-a",
				asOfSeq: runtime.lastSeq,
				cursor: "cursor-a",
			}),
		).toBe(true);
		expect(
			isSessionWsClientMessage({
				type: "session_history_cancel",
				id: "page-a",
				sessionHandle: identity.sessionHandle,
				expectedGeneration: identity.generation,
				snapshotId: "snapshot-a",
			}),
		).toBe(true);
		expect(
			isSessionWsClientMessage({
				type: "session_history_page",
				id: "page-a",
				sessionHandle: identity.sessionHandle,
				expectedGeneration: identity.generation,
				snapshotId: "snapshot-a",
				asOfSeq: runtime.lastSeq,
				cursor: "",
			}),
		).toBe(false);
	});
});
