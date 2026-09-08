import {
	type PiSessionMessageDto,
	type SessionHistoryPageBeginDto,
	type SessionHistoryPageChunkDto,
	type SessionHistoryPageEndDto,
	type SessionWsClientMessage,
	sessionHistoryChecksum,
	sessionHistoryMessagesBytes,
} from "@pi-agent-web/protocol";
import { describe, expect, it, vi } from "vitest";
import { createSessionHistoryPages, type SessionHistoryPageContext } from "../src/lib/session-history-pages";
import { emptySessionHistoryState } from "../src/stores/session-transport-contract";

type PageRequest = Extract<SessionWsClientMessage, { type: "session_history_page" }>;
const messages: PiSessionMessageDto[] = [{ role: "user", content: "older", timestamp: 0 }];

function frames(
	request: PageRequest,
	context: SessionHistoryPageContext,
): [SessionHistoryPageBeginDto, SessionHistoryPageChunkDto, SessionHistoryPageEndDto] {
	const byteCount = sessionHistoryMessagesBytes(messages);
	const checksum = sessionHistoryChecksum(messages);
	const identity = { ...context.identity, requestId: request.id, snapshotId: context.snapshotId };
	return [
		{
			...identity,
			type: "session_history_page_begin",
			asOfSeq: context.asOfSeq,
			cursor: request.cursor,
			history: {
				totalMessages: 2,
				loadedMessages: 1,
				totalBytes: byteCount * 2,
				loadedBytes: byteCount,
				nextCursor: null,
			},
		},
		{
			...identity,
			type: "session_history_page_chunk",
			chunkIndex: 0,
			messages: messages as SessionHistoryPageChunkDto["messages"],
			itemCount: 1,
			byteCount,
			checksum,
		},
		{
			...identity,
			type: "session_history_page_end",
			chunkCount: 1,
			itemCount: 1,
			byteCount,
			checksum: sessionHistoryChecksum([checksum]),
			nextCursor: null,
		},
	];
}

function harness() {
	const contexts = new Map<string, SessionHistoryPageContext>();
	const histories = new Map<string, ReturnType<typeof emptySessionHistoryState>>();
	function add(handle: string) {
		const context: SessionHistoryPageContext = {
			identity: { serverEpoch: "epoch", workspaceId: "workspace", sessionHandle: handle, generation: 1 },
			snapshotId: "snapshot",
			asOfSeq: 4,
			nextCursor: "older",
			ready: true,
			loading: false,
			online: true,
		};
		contexts.set(handle, context);
		histories.set(handle, {
			...emptySessionHistoryState(),
			snapshotId: "snapshot",
			asOfSeq: 4,
			nextCursor: "older",
			loadedMessages: 1,
		});
		return context;
	}
	add("a");
	add("b");
	const send = vi.fn<Parameters<typeof createSessionHistoryPages>[0]["send"]>(() => "sent");
	const materialize = vi.fn<Parameters<typeof createSessionHistoryPages>[0]["materialize"]>(
		async () => messages,
	);
	const deliver = vi.fn<Parameters<typeof createSessionHistoryPages>[0]["deliver"]>(() => null);
	const owner = createSessionHistoryPages({
		now: () => 42,
		context: (handle) => contexts.get(handle) ?? null,
		send,
		materialize,
		deliver,
		updateHistory: (handle, update) => {
			const history = histories.get(handle);
			const context = contexts.get(handle);
			if (!history || !context) throw new Error("attempted to revive an absent Session");
			const next = update(history);
			histories.set(handle, next);
			context.loading = next.loading;
			context.nextCursor = next.nextCursor;
		},
	});
	function request(handle: string) {
		const wire = send.mock.calls
			.map(([message]) => message)
			.findLast((message) => message.type === "session_history_page" && message.sessionHandle === handle);
		if (wire?.type !== "session_history_page") throw new Error("missing request");
		return wire;
	}
	function accept(handle: string) {
		for (const frame of frames(request(handle), contexts.get(handle)!)) owner.accept(frame, "projected");
	}
	return { owner, contexts, histories, add, send, materialize, deliver, request, accept };
}

function gate() {
	let resolve!: (value: PiSessionMessageDto[]) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<PiSessionMessageDto[]>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function flush() {
	for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("older page ownership", () => {
	it("admits one page per Session and settles another Session independently", async () => {
		const h = harness();
		const slow = gate();
		h.materialize.mockImplementationOnce(() => slow.promise);
		expect(h.owner.start("a")).toBe(true);
		expect(h.owner.start("a")).toBe(false);
		h.accept("a");
		expect(h.owner.start("b")).toBe(true);
		h.accept("b");
		await flush();
		expect(h.deliver.mock.calls.map(([frame]) => frame.sessionHandle)).toEqual(["b"]);
		expect(h.histories.get("a")?.loading).toBe(true);
		slow.resolve(messages);
		await flush();
		expect(h.histories.get("a")).toMatchObject({ loadedMessages: 2, nextCursor: null, loading: false });
		expect(h.owner.cancelSession("a")).toBe(false);
		expect(h.owner.cancelSession("b")).toBe(false);
	});

	it.each(["resolve", "reject"] as const)(
		"cancels materialization and ignores late %s after a new request",
		async (settlement) => {
			const h = harness();
			const slow = gate();
			h.materialize.mockImplementationOnce(() => slow.promise);
			h.owner.start("a");
			h.accept("a");
			const signal = h.materialize.mock.calls[0]![1];
			const oldId = h.request("a").id;
			expect(h.owner.cancelSession("a", true)).toBe(true);
			expect(signal.aborted).toBe(true);
			expect(h.owner.cancelSession("a", true)).toBe(false);
			expect(h.owner.start("a")).toBe(true);
			expect(h.request("a").id).not.toBe(oldId);
			if (settlement === "resolve") slow.resolve(messages);
			else slow.reject(new Error("late failure"));
			await flush();
			expect(h.deliver).not.toHaveBeenCalled();
			expect(h.histories.get("a")).toMatchObject({ loading: true, loadedMessages: 1, error: null });
			h.accept("a");
			await flush();
			expect(h.deliver).toHaveBeenCalledTimes(1);
		},
	);

	it("does not settle into a forgotten Session or replacement during synchronous delivery", async () => {
		const h = harness();
		h.deliver.mockImplementationOnce(() => {
			h.owner.cancelSession("a");
			h.contexts.delete("a");
			h.histories.delete("a");
			return new Error("late delivery failure");
		});
		h.owner.start("a");
		h.accept("a");
		await flush();
		expect(h.contexts.has("a")).toBe(false);
		expect(h.owner.cancelSession("a")).toBe(false);
		h.add("a");
		h.deliver.mockImplementationOnce(() => {
			h.owner.cancelSession("a", true);
			expect(h.owner.start("a")).toBe(true);
			return null;
		});
		h.owner.start("a");
		h.accept("a");
		await flush();
		expect(h.histories.get("a")).toMatchObject({ loading: true, loadedMessages: 1 });
		h.owner.dispose();
	});

	it("rejects send failure and failed delivery without advancing history", async () => {
		const h = harness();
		h.send.mockReturnValueOnce("unavailable");
		expect(h.owner.start("a")).toBe(false);
		expect(h.histories.get("a")).toMatchObject({ loading: false, error: "unavailable" });
		expect(h.owner.cancelSession("a")).toBe(false);
		h.deliver.mockReturnValueOnce(new Error("deferred projection"));
		h.owner.start("a");
		h.accept("a");
		await flush();
		expect(h.histories.get("a")).toMatchObject({
			loadedMessages: 1,
			nextCursor: "older",
			loading: false,
			error: "deferred projection",
		});
		expect(h.owner.cancelSession("a")).toBe(false);
	});

	it("cancels only the exact identity and refuses reentrant start during batch cancellation", async () => {
		const h = harness();
		const slow = gate();
		h.materialize.mockImplementation(() => slow.promise);
		h.owner.start("a");
		h.accept("a");
		h.owner.start("b");
		h.accept("b");
		const [aSignal, bSignal] = h.materialize.mock.calls.map(([, signal]) => signal);
		h.owner.cancelIdentity({ ...h.contexts.get("a")!.identity, generation: 2 });
		expect(aSignal?.aborted).toBe(false);
		h.owner.cancelIdentity(h.contexts.get("a")!.identity);
		expect(aSignal?.aborted).toBe(true);
		expect(bSignal?.aborted).toBe(false);
		h.add("a");
		bSignal!.addEventListener("abort", () => expect(h.owner.start("a")).toBe(false));
		h.owner.cancelAll();
		expect(bSignal?.aborted).toBe(true);
		slow.resolve(messages);
		await flush();
		expect(h.deliver).not.toHaveBeenCalled();
		expect(h.owner.start("a")).toBe(true);
		h.owner.dispose();
		h.add("a");
		expect(h.owner.start("a")).toBe(false);
	});

	it("uses the existing assembler guard and releases resources on malformed input", () => {
		const h = harness();
		h.owner.start("a");
		const [begin, chunk] = frames(h.request("a"), h.contexts.get("a")!);
		h.owner.accept(begin, "wire"); // Production requests own projected frames only.
		h.owner.accept(begin, "projected");
		h.owner.accept({ ...chunk, checksum: "bad" }, "projected");
		expect(h.histories.get("a")).toMatchObject({ loading: false, error: expect.any(String) });
		expect(h.owner.cancelSession("a")).toBe(false);
		expect(h.materialize).not.toHaveBeenCalled();
	});

	it("releases distinct completed operations without a retired identity registry", async () => {
		const h = harness();
		for (let i = 0; i < 30; i += 1) {
			const handle = `page-${i}`;
			h.add(handle);
			expect(h.owner.start(handle)).toBe(true);
			h.accept(handle);
			await flush();
			expect(h.histories.get(handle)?.loadedMessages).toBe(2);
			expect(h.owner.cancelSession(handle)).toBe(false);
			h.contexts.delete(handle);
			h.histories.delete(handle);
		}
		expect(h.deliver).toHaveBeenCalledTimes(30);
	});
});
