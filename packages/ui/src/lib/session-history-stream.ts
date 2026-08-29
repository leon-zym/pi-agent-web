import {
	SESSION_HISTORY_MAX_MESSAGES,
	SESSION_HISTORY_MAX_STREAM_BYTES,
	SESSION_HISTORY_MAX_TOTAL_BYTES,
	type SessionHistoryMetadataDto,
	sessionHistoryChecksum,
	sessionHistoryMessagesBytes,
} from "@pi-agent-web/protocol";

export interface SessionHistoryStreamIdentity {
	serverEpoch: string;
	sessionHandle: string;
	workspaceId: string;
	generation: number;
}

export interface SessionHistoryStreamBeginBase extends SessionHistoryStreamIdentity {
	type: "session_snapshot_begin" | "session_history_page_begin";
	snapshotId: string;
	asOfSeq: number;
	history: SessionHistoryMetadataDto;
	requestId?: string;
}

export interface SessionSnapshotStreamBegin extends SessionHistoryStreamBeginBase {
	type: "session_snapshot_begin";
	baseSeq: number;
	runtime: unknown;
	projectionEvents: unknown[];
	queue: { steering: string[]; followUp: string[] };
	pendingExtensionRequests: unknown[];
	stickyExtensionState: unknown[];
}

export interface SessionHistoryPageStreamBegin extends SessionHistoryStreamBeginBase {
	type: "session_history_page_begin";
	cursor: string;
}

export interface SessionHistoryStreamChunk<TMessage> extends SessionHistoryStreamIdentity {
	type: "session_snapshot_chunk" | "session_history_page_chunk";
	snapshotId: string;
	chunkIndex: number;
	messages: TMessage[];
	itemCount: number;
	byteCount: number;
	checksum: string;
	requestId?: string;
}

export interface SessionHistoryStreamEnd extends SessionHistoryStreamIdentity {
	type: "session_snapshot_end" | "session_history_page_end";
	snapshotId: string;
	chunkCount: number;
	itemCount: number;
	byteCount: number;
	checksum: string;
	nextCursor: string | null;
	requestId?: string;
}

export interface CompletedSessionHistoryStream<TMessage, TBegin, TEnd> {
	begin: TBegin;
	end: TEnd;
	messages: TMessage[];
}

export type SessionHistoryStreamKind = "snapshot" | "page";

export class SessionHistoryStreamError extends Error {
	constructor(
		readonly code:
			| "invalid_begin"
			| "invalid_identity"
			| "chunk_order"
			| "chunk_integrity"
			| "stream_limits"
			| "end_mismatch",
		message: string,
	) {
		super(message);
		this.name = "SessionHistoryStreamError";
	}
}

export class SessionHistoryStreamAssembler<
	TMessage,
	TBegin extends SessionHistoryStreamBeginBase,
	TChunk extends SessionHistoryStreamChunk<TMessage>,
	TEnd extends SessionHistoryStreamEnd,
> {
	private beginFrame: TBegin | null = null;
	private nextChunkIndex = 0;
	private itemCount = 0;
	private chunkByteCount = 0;
	private readonly checksums: string[] = [];
	private readonly messages: TMessage[] = [];

	constructor(private readonly kind: SessionHistoryStreamKind) {}

	begin(frame: TBegin): void {
		if (this.beginFrame !== null) {
			throw new SessionHistoryStreamError("invalid_begin", "history stream received a duplicate begin frame");
		}
		if (
			(this.kind === "snapshot" && frame.type !== "session_snapshot_begin") ||
			(this.kind === "page" && frame.type !== "session_history_page_begin")
		) {
			throw new SessionHistoryStreamError(
				"invalid_begin",
				"history stream begin type does not match its stream",
			);
		}
		assertMetadata(frame.history);
		if (this.kind === "page" && (!frame.requestId || frame.requestId.length === 0)) {
			throw new SessionHistoryStreamError("invalid_begin", "history page begin has no request id");
		}
		if (this.kind === "snapshot" && frame.requestId !== undefined) {
			throw new SessionHistoryStreamError("invalid_begin", "snapshot begin unexpectedly has a request id");
		}
		this.beginFrame = frame;
	}

	chunk(frame: TChunk): void {
		const begin = this.requireBegin();
		this.assertIdentity(frame);
		if (frame.chunkIndex !== this.nextChunkIndex) {
			throw new SessionHistoryStreamError(
				"chunk_order",
				`history stream expected chunk ${String(this.nextChunkIndex)} but received ${String(frame.chunkIndex)}`,
			);
		}
		if (frame.itemCount !== frame.messages.length) {
			throw new SessionHistoryStreamError(
				"chunk_integrity",
				"history chunk item count does not match its payload",
			);
		}
		const byteCount = sessionHistoryMessagesBytes(frame.messages);
		if (frame.byteCount !== byteCount || frame.checksum !== sessionHistoryChecksum(frame.messages)) {
			throw new SessionHistoryStreamError("chunk_integrity", "history chunk integrity check failed");
		}
		if (
			!Number.isSafeInteger(byteCount) ||
			byteCount < 0 ||
			byteCount > SESSION_HISTORY_MAX_STREAM_BYTES ||
			this.itemCount + frame.itemCount > begin.history.loadedMessages ||
			this.chunkByteCount + byteCount > SESSION_HISTORY_MAX_STREAM_BYTES
		) {
			throw new SessionHistoryStreamError("stream_limits", "history stream exceeded its declared bounds");
		}
		if (this.nextChunkIndex >= SESSION_HISTORY_MAX_MESSAGES) {
			throw new SessionHistoryStreamError("stream_limits", "history stream has too many chunks");
		}
		this.messages.push(...frame.messages);
		this.checksums.push(frame.checksum);
		this.itemCount += frame.itemCount;
		this.chunkByteCount += byteCount;
		this.nextChunkIndex += 1;
	}

	end(frame: TEnd): CompletedSessionHistoryStream<TMessage, TBegin, TEnd> {
		const begin = this.requireBegin();
		this.assertIdentity(frame);
		if (
			(this.kind === "snapshot" && frame.type !== "session_snapshot_end") ||
			(this.kind === "page" && frame.type !== "session_history_page_end")
		) {
			throw new SessionHistoryStreamError(
				"end_mismatch",
				"history stream end type does not match its stream",
			);
		}
		const assembledByteCount = sessionHistoryMessagesBytes(this.messages);
		if (
			frame.chunkCount !== this.nextChunkIndex ||
			frame.itemCount !== this.itemCount ||
			frame.byteCount !== assembledByteCount ||
			frame.byteCount !== begin.history.loadedBytes ||
			frame.checksum !== sessionHistoryChecksum(this.checksums) ||
			frame.nextCursor !== begin.history.nextCursor
		) {
			throw new SessionHistoryStreamError("end_mismatch", "history stream end does not match its chunks");
		}
		return { begin, end: frame, messages: [...this.messages] };
	}

	private requireBegin(): TBegin {
		if (!this.beginFrame) {
			throw new SessionHistoryStreamError("invalid_begin", "history stream frame arrived before begin");
		}
		return this.beginFrame;
	}

	private assertIdentity(
		frame: SessionHistoryStreamIdentity & { snapshotId: string; requestId?: string },
	): void {
		const begin = this.requireBegin();
		if (
			frame.serverEpoch !== begin.serverEpoch ||
			frame.sessionHandle !== begin.sessionHandle ||
			frame.workspaceId !== begin.workspaceId ||
			frame.generation !== begin.generation ||
			frame.snapshotId !== begin.snapshotId ||
			frame.requestId !== begin.requestId
		) {
			throw new SessionHistoryStreamError(
				"invalid_identity",
				"history stream frame crossed an identity fence",
			);
		}
	}
}

function assertMetadata(metadata: SessionHistoryMetadataDto): void {
	if (
		!Number.isSafeInteger(metadata.totalMessages) ||
		metadata.totalMessages < 0 ||
		metadata.totalMessages > SESSION_HISTORY_MAX_MESSAGES ||
		!Number.isSafeInteger(metadata.loadedMessages) ||
		metadata.loadedMessages < 0 ||
		metadata.loadedMessages > metadata.totalMessages ||
		!Number.isSafeInteger(metadata.loadedBytes) ||
		metadata.loadedBytes < 0 ||
		metadata.loadedBytes > SESSION_HISTORY_MAX_STREAM_BYTES ||
		!Number.isSafeInteger(metadata.totalBytes) ||
		metadata.totalBytes < metadata.loadedBytes ||
		metadata.totalBytes > SESSION_HISTORY_MAX_TOTAL_BYTES
	) {
		throw new SessionHistoryStreamError("invalid_begin", "history metadata is outside the stream bounds");
	}
}
