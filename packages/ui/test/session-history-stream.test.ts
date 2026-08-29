import {
	SESSION_HISTORY_MAX_STREAM_BYTES,
	type SessionHistoryMetadataDto,
	sessionHistoryChecksum,
	sessionHistoryMessagesBytes,
} from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import {
	type SessionHistoryPageStreamBegin,
	SessionHistoryStreamAssembler,
	type SessionHistoryStreamChunk,
	type SessionHistoryStreamEnd,
	SessionHistoryStreamError,
	type SessionSnapshotStreamBegin,
} from "../src/lib/session-history-stream";

const identity = {
	serverEpoch: "epoch",
	sessionHandle: "session",
	workspaceId: "workspace",
	generation: 3,
};

const messages = [
	{ role: "user", content: "older" },
	{ role: "assistant", content: [{ type: "text", text: "newer" }] },
];

function metadata(nextCursor: string | null = "cursor-1"): SessionHistoryMetadataDto {
	return {
		totalMessages: messages.length,
		loadedMessages: messages.length,
		loadedBytes: sessionHistoryMessagesBytes(messages),
		totalBytes: sessionHistoryMessagesBytes(messages),
		nextCursor,
	};
}

function snapshotBegin(): SessionSnapshotStreamBegin {
	return {
		...identity,
		type: "session_snapshot_begin",
		snapshotId: "snapshot",
		baseSeq: 0,
		asOfSeq: 4,
		runtime: {},
		projectionEvents: [],
		queue: { steering: [], followUp: [] },
		pendingExtensionRequests: [],
		stickyExtensionState: [],
		history: metadata(),
	};
}

function chunk(
	chunkIndex: number,
	chunkMessages: typeof messages = messages,
	requestId?: string,
): SessionHistoryStreamChunk<(typeof messages)[number]> {
	return {
		...identity,
		...(requestId ? { requestId } : {}),
		type: requestId ? "session_history_page_chunk" : "session_snapshot_chunk",
		snapshotId: "snapshot",
		chunkIndex,
		messages: chunkMessages,
		itemCount: chunkMessages.length,
		byteCount: sessionHistoryMessagesBytes(chunkMessages),
		checksum: sessionHistoryChecksum(chunkMessages),
	};
}

function end(
	chunkCount: number,
	requestId?: string,
	checksums = [sessionHistoryChecksum(messages)],
): SessionHistoryStreamEnd {
	return {
		...identity,
		...(requestId ? { requestId } : {}),
		type: requestId ? "session_history_page_end" : "session_snapshot_end",
		snapshotId: "snapshot",
		chunkCount,
		itemCount: messages.length,
		byteCount: sessionHistoryMessagesBytes(messages),
		checksum: sessionHistoryChecksum(checksums),
		nextCursor: "cursor-1",
	};
}

describe("SessionHistoryStreamAssembler", () => {
	it("commits a complete snapshot only after ordered chunks and matching end metadata", () => {
		const assembler = new SessionHistoryStreamAssembler<
			(typeof messages)[number],
			SessionSnapshotStreamBegin,
			SessionHistoryStreamChunk<(typeof messages)[number]>,
			SessionHistoryStreamEnd
		>("snapshot");
		assembler.begin(snapshotBegin());
		assembler.chunk(chunk(0, [messages[0]!]));
		assembler.chunk(chunk(1, [messages[1]!]));

		expect(
			assembler.end(
				end(2, undefined, [sessionHistoryChecksum([messages[0]!]), sessionHistoryChecksum([messages[1]!])]),
			),
		).toMatchObject({ messages });
	});

	it("rejects duplicate, reordered, corrupted, and cross-identity chunks", () => {
		const makeAssembler = () => {
			const assembler = new SessionHistoryStreamAssembler<
				(typeof messages)[number],
				SessionSnapshotStreamBegin,
				SessionHistoryStreamChunk<(typeof messages)[number]>,
				SessionHistoryStreamEnd
			>("snapshot");
			assembler.begin(snapshotBegin());
			return assembler;
		};

		expect(() => makeAssembler().chunk(chunk(1))).toThrowError(SessionHistoryStreamError);
		const duplicate = makeAssembler();
		duplicate.chunk(chunk(0, [messages[0]!], undefined));
		expect(() => duplicate.chunk(chunk(0, [messages[1]!]))).toThrowError(/expected chunk 1/);

		const corrupted = makeAssembler();
		const invalid = chunk(0, [messages[0]!]);
		invalid.checksum = "00000000";
		expect(() => corrupted.chunk(invalid)).toThrowError(/integrity/);

		const crossIdentity = makeAssembler();
		const foreign = chunk(0, [messages[0]!]);
		foreign.generation += 1;
		expect(() => crossIdentity.chunk(foreign)).toThrowError(/identity fence/);
	});

	it("uses the request fence for history pages and rejects an incomplete end", () => {
		const pageBegin: SessionHistoryPageStreamBegin = {
			...identity,
			type: "session_history_page_begin",
			requestId: "request",
			snapshotId: "snapshot",
			asOfSeq: 4,
			cursor: "cursor-1",
			history: metadata(null),
		};
		const assembler = new SessionHistoryStreamAssembler<
			(typeof messages)[number],
			SessionHistoryPageStreamBegin,
			SessionHistoryStreamChunk<(typeof messages)[number]>,
			SessionHistoryStreamEnd
		>("page");
		assembler.begin(pageBegin);
		assembler.chunk(chunk(0, messages, "request"));
		const invalidEnd = end(1, "other-request");
		expect(() => assembler.end(invalidEnd)).toThrowError(/identity fence/);
	});

	it("rejects a stream whose declared assembled payload exceeds the stream budget", () => {
		const assembler = new SessionHistoryStreamAssembler<
			(typeof messages)[number],
			SessionSnapshotStreamBegin,
			SessionHistoryStreamChunk<(typeof messages)[number]>,
			SessionHistoryStreamEnd
		>("snapshot");
		expect(() =>
			assembler.begin({
				...snapshotBegin(),
				history: {
					...metadata(),
					loadedBytes: SESSION_HISTORY_MAX_STREAM_BYTES + 1,
					totalBytes: SESSION_HISTORY_MAX_STREAM_BYTES + 1,
				},
			}),
		).toThrowError(/stream bounds/);
	});
});
