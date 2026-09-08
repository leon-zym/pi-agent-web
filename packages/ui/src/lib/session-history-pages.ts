import type {
	InlineSessionHistoryPageChunkDto,
	PiSessionMessageDto,
	SessionHistoryPageBeginDto,
	SessionHistoryPageChunkDto,
	SessionHistoryPageEndDto,
	SessionMessageDto,
	SessionRuntimeIdentityDto,
	SessionWsClientMessage,
} from "@pi-agent-web/protocol";
import type { SessionHistoryPageLoadedFrame } from "../stores/session-frame-bus";
import type { SessionHistoryState } from "../stores/session-transport-contract";
import { SessionHistoryStreamAssembler } from "./session-history-stream";

type PageChunk = InlineSessionHistoryPageChunkDto | SessionHistoryPageChunkDto;
type PageFrame = SessionHistoryPageBeginDto | PageChunk | SessionHistoryPageEndDto;
type Representation = "wire" | "projected";
type PageRequest = Extract<
	SessionWsClientMessage,
	{ type: "session_history_page" | "session_history_cancel" }
>;

export interface SessionHistoryPageContext {
	identity: SessionRuntimeIdentityDto;
	snapshotId: string;
	asOfSeq: number;
	nextCursor: string | null;
	ready: boolean;
	loading: boolean;
	online: boolean;
}

interface PageOperation {
	context: SessionHistoryPageContext;
	requestId: string;
	controller: AbortController;
	assembler: SessionHistoryStreamAssembler<
		unknown,
		SessionHistoryPageBeginDto,
		PageChunk,
		SessionHistoryPageEndDto
	>;
	finishing: boolean;
}

interface SessionHistoryPagesOptions {
	context: (sessionHandle: string) => SessionHistoryPageContext | null;
	send: (message: PageRequest) => "sent" | "payload_too_large" | "unavailable";
	materialize: (messages: SessionMessageDto[], signal: AbortSignal) => Promise<PiSessionMessageDto[]>;
	deliver: (frame: SessionHistoryPageLoadedFrame) => Error | null;
	updateHistory: (
		sessionHandle: string,
		update: (history: SessionHistoryState) => SessionHistoryState,
	) => void;
	now: () => number;
}

function sameIdentity(left: SessionRuntimeIdentityDto, right: SessionRuntimeIdentityDto): boolean {
	return (
		left.serverEpoch === right.serverEpoch &&
		left.workspaceId === right.workspaceId &&
		left.sessionHandle === right.sessionHandle &&
		left.generation === right.generation
	);
}

/** Owns one bounded older-page operation per Session, including asynchronous settlement. */
export function createSessionHistoryPages(options: SessionHistoryPagesOptions) {
	const operations = new Map<string, PageOperation>();
	let requestCounter = 0;
	let disposed = false;
	let cancellingAll = false;

	function owned(operation: PageOperation): boolean {
		return (
			!disposed &&
			!operation.controller.signal.aborted &&
			operations.get(operation.context.identity.sessionHandle) === operation
		);
	}

	function matchingContext(operation: PageOperation): SessionHistoryPageContext | null {
		const current = options.context(operation.context.identity.sessionHandle);
		return current &&
			sameIdentity(current.identity, operation.context.identity) &&
			current.snapshotId === operation.context.snapshotId &&
			current.asOfSeq === operation.context.asOfSeq
			? current
			: null;
	}

	function remove(operation: PageOperation): void {
		const handle = operation.context.identity.sessionHandle;
		if (operations.get(handle) === operation) operations.delete(handle);
		operation.controller.abort();
	}

	function fail(operation: PageOperation, error: Error): void {
		if (!owned(operation)) return;
		remove(operation);
		const handle = operation.context.identity.sessionHandle;
		if (operations.has(handle) || !matchingContext(operation)) return;
		options.updateHistory(handle, (history) => ({ ...history, loading: false, error: error.message }));
	}

	function complete(
		operation: PageOperation,
		messages: PiSessionMessageDto[],
		begin: SessionHistoryPageBeginDto,
		end: SessionHistoryPageEndDto,
	): void {
		if (!owned(operation)) return;
		if (!matchingContext(operation)?.ready) {
			remove(operation);
			return;
		}
		const error = options.deliver({
			...operation.context.identity,
			type: "session_history_page_loaded",
			requestId: operation.requestId,
			snapshotId: begin.snapshotId,
			asOfSeq: begin.asOfSeq,
			messages,
		});
		// Delivery is synchronous but can re-enter cancellation, rekey or terminal forget.
		if (!owned(operation)) return;
		if (!matchingContext(operation)?.ready) {
			remove(operation);
			return;
		}
		if (error) {
			fail(operation, error);
			return;
		}
		// Revoke the operation before notifying state observers; they may start the next page.
		remove(operation);
		const handle = operation.context.identity.sessionHandle;
		if (operations.has(handle) || !matchingContext(operation)?.ready) return;
		options.updateHistory(handle, (history) => ({
			...history,
			totalMessages: begin.history.totalMessages,
			totalBytes: begin.history.totalBytes,
			loadedMessages: history.loadedMessages + end.itemCount,
			loadedBytes: history.loadedBytes + end.byteCount,
			nextCursor: end.nextCursor,
			loading: false,
			error: null,
		}));
	}

	async function finish(
		operation: PageOperation,
		completed: ReturnType<PageOperation["assembler"]["end"]>,
	): Promise<void> {
		try {
			const messages = await options.materialize(
				completed.messages as SessionMessageDto[],
				operation.controller.signal,
			);
			complete(operation, messages, completed.begin, completed.end);
		} catch (error) {
			fail(operation, error instanceof Error ? error : new Error(String(error)));
		}
	}

	function cancelSession(sessionHandle: string, notifyGateway = false): boolean {
		const operation = operations.get(sessionHandle);
		if (!operation) return false;
		remove(operation);
		if (!notifyGateway || operations.has(sessionHandle)) return true;
		const current = matchingContext(operation);
		if (!current) return true;
		if (current.online)
			options.send({
				type: "session_history_cancel",
				id: operation.requestId,
				sessionHandle,
				expectedGeneration: current.identity.generation,
				snapshotId: current.snapshotId,
			});
		if (!operations.has(sessionHandle) && matchingContext(operation)) {
			options.updateHistory(sessionHandle, (history) => ({ ...history, loading: false, error: null }));
		}
		return true;
	}

	function cancelAll(): void {
		if (cancellingAll) return;
		cancellingAll = true;
		try {
			const previous = [...operations.values()];
			operations.clear();
			for (const operation of previous) operation.controller.abort();
		} finally {
			cancellingAll = false;
		}
	}

	return {
		start(sessionHandle: string): boolean {
			const context = options.context(sessionHandle);
			if (
				disposed ||
				cancellingAll ||
				!context?.ready ||
				context.loading ||
				context.nextCursor === null ||
				operations.has(sessionHandle)
			)
				return false;
			const requestId = `history-page-${String(++requestCounter)}-${options.now().toString(36)}`;
			const operation: PageOperation = {
				context: { ...context, identity: { ...context.identity } },
				requestId,
				controller: new AbortController(),
				assembler: new SessionHistoryStreamAssembler("page"),
				finishing: false,
			};
			operations.set(sessionHandle, operation);
			options.updateHistory(sessionHandle, (history) => ({ ...history, loading: true, error: null }));
			if (!owned(operation)) return false;
			if (!matchingContext(operation)?.ready) {
				remove(operation);
				return false;
			}
			const delivery = options.send({
				type: "session_history_page",
				id: requestId,
				sessionHandle,
				expectedGeneration: context.identity.generation,
				snapshotId: context.snapshotId,
				asOfSeq: context.asOfSeq,
				cursor: context.nextCursor,
				limit: 128,
			});
			if (delivery !== "sent") {
				fail(operation, new Error(delivery));
				return false;
			}
			return true;
		},
		accept(message: PageFrame, representation: Representation): void {
			const operation = operations.get(message.sessionHandle);
			if (
				!operation ||
				operation.requestId !== message.requestId ||
				representation !== "projected" ||
				operation.finishing
			)
				return;
			try {
				switch (message.type) {
					case "session_history_page_begin":
						if (
							!matchingContext(operation)?.ready ||
							!sameIdentity(operation.context.identity, message) ||
							operation.context.snapshotId !== message.snapshotId ||
							operation.context.asOfSeq !== message.asOfSeq
						) {
							throw new Error("History page crossed an identity fence");
						}
						operation.assembler.begin(message);
						break;
					case "session_history_page_chunk":
						operation.assembler.chunk(message);
						break;
					case "session_history_page_end": {
						const completed = operation.assembler.end(message);
						operation.finishing = true;
						void finish(operation, completed);
						break;
					}
				}
			} catch (error) {
				fail(operation, error instanceof Error ? error : new Error(String(error)));
			}
		},
		cancelSession,
		cancelIdentity(identity: SessionRuntimeIdentityDto): void {
			const operation = operations.get(identity.sessionHandle);
			if (operation && sameIdentity(operation.context.identity, identity)) remove(operation);
		},
		failSession(sessionHandle: string, error: Error): boolean {
			const operation = operations.get(sessionHandle);
			if (!operation) return false;
			fail(operation, error);
			return true;
		},
		cancelAll,
		dispose(): void {
			disposed = true;
			cancelAll();
		},
	};
}
