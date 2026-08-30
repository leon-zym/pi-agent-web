import type { PiSessionEventDto } from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import {
	type CoalescibleMessageUpdate,
	isCoalescibleMessageUpdate,
	SessionEventScheduler,
} from "../src/lib/session-event-scheduler";
import { reduceProjection } from "../src/stores/projection-reducer";
import { createEmptyProjection } from "../src/types/view-models";

const usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function delta(
	type: "text_delta" | "thinking_delta" | "toolcall_delta",
	contentIndex: number,
	text: string,
	output = 20,
): CoalescibleMessageUpdate {
	return {
		type: "message_update",
		usage: { ...usage, output, totalTokens: usage.input + output },
		assistantMessageEvent: { type, contentIndex, delta: text },
	} as CoalescibleMessageUpdate;
}

function inner(event: CoalescibleMessageUpdate) {
	return event.assistantMessageEvent;
}

function createClock(hiddenInitially = false) {
	let hidden = hiddenInitially;
	let nextHandle = 1;
	const frames = new Map<number, FrameRequestCallback>();
	const timers = new Map<number, { callback: () => void; delayMs: number }>();
	const cancelledFrames: number[] = [];
	const cancelledTimers: number[] = [];

	return {
		isHidden: () => hidden,
		setHidden: (value: boolean) => {
			hidden = value;
		},
		requestFrame: (callback: FrameRequestCallback) => {
			const handle = nextHandle++;
			frames.set(handle, callback);
			return handle;
		},
		cancelFrame: (handle: number) => {
			cancelledFrames.push(handle);
			frames.delete(handle);
		},
		setTimer: (callback: () => void, delayMs: number) => {
			const handle = nextHandle++;
			timers.set(handle, { callback, delayMs });
			return handle as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (handle: ReturnType<typeof setTimeout>) => {
			const numeric = handle as unknown as number;
			cancelledTimers.push(numeric);
			timers.delete(numeric);
		},
		runFrame: () => {
			const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
			if (!entry) throw new Error("No frame is scheduled");
			frames.delete(entry[0]);
			entry[1](16);
		},
		runTimer: () => {
			const entry = timers.entries().next().value as
				| [number, { callback: () => void; delayMs: number }]
				| undefined;
			if (!entry) throw new Error("No timer is scheduled");
			timers.delete(entry[0]);
			entry[1].callback();
		},
		frames,
		timers,
		cancelledFrames,
		cancelledTimers,
	};
}

describe("SessionEventScheduler", () => {
	it("merges high-frequency compatible deltas into one reducer input and one visible-frame commit", () => {
		const clock = createClock();
		const commits: CoalescibleMessageUpdate[][] = [];
		const scheduler = new SessionEventScheduler({
			onFlush: (_sessionHandle, _generation, events) => commits.push(events),
			...clock,
		});

		for (let index = 0; index < 1_000; index++) {
			scheduler.enqueue("session-a", 1, "message-1", delta("text_delta", 0, "x", index));
		}

		expect(commits).toHaveLength(0);
		expect(clock.frames.size).toBe(1);
		expect(scheduler.getPendingSnapshot()).toEqual({
			sessions: 1,
			sourceEvents: 1_000,
			reducerEvents: 1,
			characters: 1_000,
		});

		clock.runFrame();
		expect(commits).toHaveLength(1);
		expect(commits[0]).toHaveLength(1);
		expect(inner(commits[0]?.[0] as CoalescibleMessageUpdate)).toMatchObject({
			type: "text_delta",
			delta: "x".repeat(1_000),
		});
		expect(commits[0]?.[0]?.usage.output).toBe(999);
		expect(scheduler.getMetrics()).toMatchObject({
			sourceEvents: 1_000,
			reducerEvents: 1,
			commits: 1,
			mergedEvents: 999,
		});
	});

	it("preserves order across content indexes, delta types, and message identities", () => {
		const output: CoalescibleMessageUpdate[] = [];
		const scheduler = new SessionEventScheduler({
			onFlush: (_sessionHandle, _generation, events) => output.push(...events),
		});
		scheduler.enqueue("session-a", 1, "message-1", delta("text_delta", 0, "A"));
		scheduler.enqueue("session-a", 1, "message-1", delta("text_delta", 0, "B"));
		scheduler.enqueue("session-a", 1, "message-1", delta("thinking_delta", 0, "C"));
		scheduler.enqueue("session-a", 1, "message-1", delta("text_delta", 0, "D"));
		scheduler.enqueue("session-a", 1, "message-1", delta("text_delta", 1, "E"));
		scheduler.enqueue("session-a", 1, "message-2", delta("text_delta", 1, "F"));
		scheduler.flushAll();

		expect(output.map(inner)).toEqual([
			expect.objectContaining({ type: "text_delta", contentIndex: 0, delta: "AB" }),
			expect.objectContaining({ type: "thinking_delta", contentIndex: 0, delta: "C" }),
			expect.objectContaining({ type: "text_delta", contentIndex: 0, delta: "D" }),
			expect.objectContaining({ type: "text_delta", contentIndex: 1, delta: "E" }),
			expect.objectContaining({ type: "text_delta", contentIndex: 1, delta: "F" }),
		]);
	});

	it("classifies only append deltas as coalescible", () => {
		const boundaries = [
			{
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			},
			{ type: "message_end", message: { role: "assistant", content: [] } },
			{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} },
			{ type: "turn_end", message: {}, toolResults: [] },
			{ type: "agent_settled" },
		] as PiSessionEventDto[];

		expect(isCoalescibleMessageUpdate(delta("text_delta", 0, "x"))).toBe(true);
		expect(isCoalescibleMessageUpdate(delta("thinking_delta", 0, "x"))).toBe(true);
		expect(isCoalescibleMessageUpdate(delta("toolcall_delta", 0, "x"))).toBe(true);
		expect(boundaries.every((event) => !isCoalescibleMessageUpdate(event))).toBe(true);
	});

	it("uses a bounded hidden timer and reschedules when visibility changes", () => {
		const clock = createClock(true);
		const committed: string[] = [];
		const scheduler = new SessionEventScheduler({
			onFlush: (sessionHandle) => committed.push(sessionHandle),
			hiddenFlushMs: 100,
			...clock,
		});
		scheduler.enqueue("hidden", 1, "message-1", delta("text_delta", 0, "a"));
		expect(clock.frames.size).toBe(0);
		expect([...clock.timers.values()][0]?.delayMs).toBe(100);

		clock.setHidden(false);
		scheduler.handleVisibilityChange();
		expect(clock.timers.size).toBe(0);
		expect(clock.cancelledTimers).toHaveLength(1);
		expect(clock.frames.size).toBe(1);
		clock.runFrame();
		expect(committed).toEqual(["hidden"]);

		scheduler.enqueue("background", 1, "message-2", delta("text_delta", 0, "b"));
		clock.setHidden(true);
		scheduler.handleVisibilityChange();
		expect(clock.frames.size).toBe(0);
		expect(clock.cancelledFrames).toHaveLength(1);
		expect([...clock.timers.values()][0]?.delayMs).toBe(100);
		clock.runTimer();
		expect(committed).toEqual(["hidden", "background"]);
	});

	it("flushes every pending Session on the same frame without starvation", () => {
		const clock = createClock();
		const commits: Array<{ sessionHandle: string; events: number }> = [];
		const scheduler = new SessionEventScheduler({
			onFlush: (sessionHandle, _generation, events) => commits.push({ sessionHandle, events: events.length }),
			...clock,
		});
		for (let index = 0; index < 500; index++) {
			scheduler.enqueue("session-a", 1, "message-a", delta("text_delta", 0, "a"));
			scheduler.enqueue("session-b", 2, "message-b", delta("text_delta", 0, "b"));
			scheduler.enqueue("session-c", 3, "message-c", delta("text_delta", 0, "c"));
		}

		clock.runFrame();
		expect(commits).toEqual([
			{ sessionHandle: "session-a", events: 1 },
			{ sessionHandle: "session-b", events: 1 },
			{ sessionHandle: "session-c", events: 1 },
		]);
		expect(scheduler.getMetrics().commits).toBe(3);
	});

	it("flushes synchronously at a structural boundary", () => {
		const order: string[] = [];
		const scheduler = new SessionEventScheduler({
			onFlush: () => order.push("delta"),
		});
		scheduler.enqueue("session-a", 1, "message-1", delta("text_delta", 0, "a"));
		scheduler.flushSession("session-a", 1);
		order.push("tool_start");
		expect(order).toEqual(["delta", "tool_start"]);
	});

	it("discards stale generations rather than replaying them into a replacement runtime", () => {
		const committed: string[] = [];
		const scheduler = new SessionEventScheduler({
			onFlush: (_sessionHandle, _generation, events) =>
				committed.push(inner(events[0] as CoalescibleMessageUpdate).delta),
		});
		scheduler.enqueue("session-a", 1, "message-old", delta("text_delta", 0, "old"));
		scheduler.enqueue("session-a", 2, "message-new", delta("text_delta", 0, "new"));
		scheduler.flushAll();

		expect(committed).toEqual(["new"]);
		expect(scheduler.getMetrics().discardedEvents).toBe(1);
	});

	it("keeps pending memory and reducer runs within configured limits", () => {
		const committed: string[] = [];
		const scheduler = new SessionEventScheduler({
			onFlush: (_sessionHandle, _generation, events) => {
				for (const event of events) committed.push(inner(event).delta);
			},
			maxCharactersPerSession: 8,
			maxCharactersTotal: 12,
			maxReducerEventsPerSession: 2,
			maxReducerEventsTotal: 3,
		});
		scheduler.enqueue("session-a", 1, "m1", delta("text_delta", 0, "12345678"));
		scheduler.enqueue("session-a", 1, "m1", delta("text_delta", 0, "9"));
		scheduler.enqueue("session-b", 1, "m2", delta("text_delta", 0, "abcd"));
		scheduler.enqueue("session-b", 1, "m2", delta("thinking_delta", 0, "e"));
		scheduler.enqueue("session-c", 1, "m3", delta("text_delta", 0, "fghijklmno"));
		scheduler.flushAll();

		const metrics = scheduler.getMetrics();
		expect(metrics.maxPendingCharacters).toBeLessThanOrEqual(12);
		expect(metrics.maxPendingReducerEvents).toBeLessThanOrEqual(3);
		expect(metrics.forcedFlushes).toBeGreaterThan(0);
		expect(scheduler.getPendingSnapshot()).toEqual({
			sessions: 0,
			sourceEvents: 0,
			reducerEvents: 0,
			characters: 0,
		});
		expect(committed.join("")).toContain("fghijklmno");
	});

	it("distinguishes deferred work from a synchronous oversized-delta flush", () => {
		const committed: string[] = [];
		const scheduler = new SessionEventScheduler({
			onFlush: (_sessionHandle, _generation, events) => {
				for (const event of events) committed.push(inner(event).delta);
			},
			maxCharactersPerSession: 4,
		});

		expect(scheduler.enqueue("session-a", 1, "message-1", delta("text_delta", 0, "ok"))).toBe("deferred");
		expect(scheduler.enqueue("session-b", 1, "message-2", delta("text_delta", 0, "oversized"))).toBe(
			"flushed",
		);
		expect(committed).toEqual(["oversized"]);
		scheduler.dispose();
		expect(scheduler.enqueue("session-a", 1, "message-1", delta("text_delta", 0, "late"))).toBe("rejected");
	});

	it("produces the same projection as sequential reduction", () => {
		const events = [
			delta("text_delta", 0, "Hello"),
			delta("text_delta", 0, " world"),
			delta("thinking_delta", 1, "think"),
			delta("thinking_delta", 1, "ing"),
			delta("toolcall_delta", 2, '{"path"'),
			delta("toolcall_delta", 2, ':"x"}'),
		];
		const prefix = [{ type: "agent_start" }, { type: "turn_start" }] as PiSessionEventDto[];
		const context = { now: 1_000 };
		let sequential = createEmptyProjection("session-a");
		for (const event of [...prefix, ...events]) sequential = reduceProjection(sequential, event, context);

		let scheduled = createEmptyProjection("session-a");
		for (const event of prefix) scheduled = reduceProjection(scheduled, event, context);
		const scheduler = new SessionEventScheduler({
			onFlush: (_sessionHandle, _generation, batch) => {
				for (const event of batch) scheduled = reduceProjection(scheduled, event, context);
			},
		});
		for (const event of events) scheduler.enqueue("session-a", 1, "message-1", event);
		scheduler.flushAll();

		expect(scheduled).toEqual(sequential);
		expect(scheduler.getMetrics()).toMatchObject({ sourceEvents: 6, reducerEvents: 3, commits: 1 });
	});

	it("cancels scheduled work and discards queued input after dispose", () => {
		const clock = createClock();
		let commits = 0;
		const scheduler = new SessionEventScheduler({
			onFlush: () => {
				commits += 1;
			},
			...clock,
		});
		scheduler.enqueue("session-a", 1, "message-1", delta("text_delta", 0, "a"));
		scheduler.dispose();
		expect(clock.frames.size).toBe(0);
		expect(clock.cancelledFrames).toHaveLength(1);
		scheduler.enqueue("session-a", 1, "message-1", delta("text_delta", 0, "b"));
		expect(scheduler.getPendingSnapshot().sessions).toBe(0);
		expect(scheduler.getMetrics().discardedEvents).toBe(2);
		expect(commits).toBe(0);
	});
});
