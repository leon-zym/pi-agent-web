import { describe, expect, it, vi } from "vitest";
import {
	createSessionResyncCoordinator,
	type SessionResyncAttemptContext,
	type SessionResyncClock,
	type SessionResyncCompletion,
	type SessionResyncCoordinator,
	type SessionResyncIdentity,
} from "../src/lib/session-resync";

interface ScheduledTimer {
	at: number;
	callback: () => void;
}

class FakeClock implements SessionResyncClock {
	#now = 0;
	#nextTimer = 1;
	#timers = new Map<number, ScheduledTimer>();

	now() {
		return this.#now;
	}

	setTimeout(callback: () => void, delayMs: number) {
		const timer = this.#nextTimer++;
		this.#timers.set(timer, { at: this.#now + delayMs, callback });
		return timer;
	}

	clearTimeout(timer: unknown) {
		this.#timers.delete(timer as number);
	}

	advanceBy(delayMs: number) {
		const target = this.#now + delayMs;
		while (true) {
			const due = [...this.#timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
			if (!due) break;
			this.#now = due[1].at;
			this.#timers.delete(due[0]);
			due[1].callback();
		}
		this.#now = target;
	}

	get timerCount() {
		return this.#timers.size;
	}
}

function identity(
	sessionHandle: string,
	overrides: Partial<SessionResyncIdentity> = {},
): SessionResyncIdentity {
	return {
		serverEpoch: "epoch-a",
		workspaceId: "workspace-a",
		sessionHandle,
		generation: 1,
		...overrides,
	};
}

function completion(
	resyncIdentity: SessionResyncIdentity,
	overrides: Partial<SessionResyncCompletion> = {},
): SessionResyncCompletion {
	return {
		identity: resyncIdentity,
		snapshotId: `snapshot-${resyncIdentity.sessionHandle}`,
		asOfSeq: 7,
		...overrides,
	};
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
}

describe("session resync coordinator", () => {
	it("runs one initial attempt plus three jittered retries, then stays degraded", async () => {
		const clock = new FakeClock();
		const randomValues = [0, 0.5, 1];
		const attempt = vi.fn(async () => {
			throw new Error("snapshot unavailable");
		});
		const coordinator = createSessionResyncCoordinator({
			attempt,
			clock,
			random: () => randomValues.shift() ?? 0.5,
		});

		coordinator.start(identity("session-a"));
		await flushPromises();
		expect(attempt).toHaveBeenCalledTimes(1);
		expect(coordinator.getState("session-a")).toMatchObject({
			phase: "retry_wait",
			attempt: 1,
			retryAt: 400,
		});

		clock.advanceBy(400);
		await flushPromises();
		expect(attempt).toHaveBeenCalledTimes(2);
		expect(coordinator.getState("session-a")?.retryAt).toBe(1_400);

		clock.advanceBy(1_000);
		await flushPromises();
		expect(attempt).toHaveBeenCalledTimes(3);
		expect(coordinator.getState("session-a")?.retryAt).toBe(3_800);

		clock.advanceBy(2_400);
		await flushPromises();
		expect(attempt).toHaveBeenCalledTimes(4);
		expect(coordinator.getState("session-a")).toMatchObject({
			phase: "degraded",
			attempt: 4,
			retryAt: null,
			lastError: "snapshot unavailable",
		});
		expect(clock.timerCount).toBe(0);

		clock.advanceBy(60_000);
		await flushPromises();
		expect(attempt).toHaveBeenCalledTimes(4);
	});

	it("manual retry resets the budget and requests a cursorless snapshot", async () => {
		const clock = new FakeClock();
		let shouldFail = true;
		const contexts: SessionResyncAttemptContext[] = [];
		const recovered = vi.fn();
		const coordinator = createSessionResyncCoordinator({
			clock,
			random: () => 0.5,
			onRecovered: recovered,
			attempt: async (context) => {
				contexts.push(context);
				if (shouldFail) throw new Error("no snapshot");
				return completion(context.identity);
			},
		});

		coordinator.start(identity("session-a"));
		for (const delay of [500, 1_000, 2_000]) {
			await flushPromises();
			clock.advanceBy(delay);
		}
		await flushPromises();
		expect(coordinator.getState("session-a")?.phase).toBe("degraded");

		shouldFail = false;
		expect(coordinator.manualRetry("session-a")).toBe(true);
		expect(coordinator.getState("session-a")).toMatchObject({
			phase: "syncing",
			attempt: 1,
			cursorless: true,
		});
		await flushPromises();

		expect(contexts.at(-1)).toMatchObject({ attempt: 1, cursorless: true });
		expect(coordinator.getState("session-a")).toBeUndefined();
		expect(recovered).toHaveBeenCalledWith(completion(identity("session-a")));
	});

	it("disconnect aborts work but reconnect preserves the same identity budget", async () => {
		const clock = new FakeClock();
		const work = [deferred<SessionResyncCompletion>(), deferred<SessionResyncCompletion>()];
		const contexts: SessionResyncAttemptContext[] = [];
		const coordinator = createSessionResyncCoordinator({
			clock,
			random: () => 0.5,
			attempt: (context) => {
				contexts.push(context);
				return work[contexts.length - 1]?.promise ?? Promise.resolve(completion(context.identity));
			},
		});

		coordinator.start(identity("session-a"));
		await flushPromises();
		coordinator.disconnect();
		expect(contexts[0]?.signal.aborted).toBe(true);
		expect(coordinator.getState("session-a")?.attempt).toBe(1);

		coordinator.reconnect();
		await flushPromises();
		expect(contexts.map(({ attempt }) => attempt)).toEqual([1, 1]);

		work[0]?.reject(new Error("late disconnect failure"));
		await flushPromises();
		expect(coordinator.getState("session-a")?.phase).toBe("syncing");
		work[1]?.resolve(completion(contexts[1]?.identity ?? identity("session-a")));
		await flushPromises();
		expect(coordinator.getState("session-a")).toBeUndefined();
	});

	it("deduplicates the same identity and clears its retry timer when identity changes", async () => {
		const clock = new FakeClock();
		const attempt = vi.fn((context: SessionResyncAttemptContext) => {
			if (context.identity.generation === 1) return Promise.reject(new Error("gap"));
			return new Promise<SessionResyncCompletion>(() => undefined);
		});
		const coordinator = createSessionResyncCoordinator({
			clock,
			random: () => 0.5,
			attempt,
		});
		const originalIdentity = identity("session-a");

		coordinator.start(originalIdentity);
		await flushPromises();
		expect(clock.timerCount).toBe(1);
		const retryAt = coordinator.getState("session-a")?.retryAt;

		coordinator.start(originalIdentity);
		expect(attempt).toHaveBeenCalledTimes(1);
		expect(clock.timerCount).toBe(1);
		expect(coordinator.getState("session-a")?.retryAt).toBe(retryAt);

		coordinator.start(identity("session-a", { generation: 2 }));
		expect(clock.timerCount).toBe(0);
		expect(attempt).toHaveBeenCalledTimes(2);
		expect(coordinator.getState("session-a")).toMatchObject({
			identity: { generation: 2 },
			attempt: 1,
			cursorless: true,
		});
	});

	it("cancels stale work on generation, epoch, rekey, unsubscribe, and dispose boundaries", async () => {
		const clock = new FakeClock();
		const contexts: SessionResyncAttemptContext[] = [];
		const coordinator = createSessionResyncCoordinator({
			clock,
			random: () => 0.5,
			attempt: (context) => {
				contexts.push(context);
				return new Promise<SessionResyncCompletion>(() => undefined);
			},
		});

		coordinator.start(identity("session-a"));
		await flushPromises();
		coordinator.start(identity("session-a", { generation: 2 }));
		await flushPromises();
		expect(contexts[0]?.signal.aborted).toBe(true);
		expect(coordinator.getState("session-a")?.identity.generation).toBe(2);

		coordinator.start(identity("session-a", { generation: 2, serverEpoch: "epoch-b" }));
		await flushPromises();
		expect(contexts[1]?.signal.aborted).toBe(true);
		expect(coordinator.getState("session-a")?.identity.serverEpoch).toBe("epoch-b");

		coordinator.rekey("session-a", identity("session-b", { serverEpoch: "epoch-b" }));
		await flushPromises();
		expect(contexts[2]?.signal.aborted).toBe(true);
		expect(coordinator.getState("session-a")).toBeUndefined();
		expect(coordinator.getState("session-b")?.cursorless).toBe(true);

		coordinator.unsubscribe("session-b");
		expect(contexts[3]?.signal.aborted).toBe(true);
		expect(coordinator.getState("session-b")).toBeUndefined();

		coordinator.start(identity("session-c"));
		coordinator.start(identity("session-d"));
		await flushPromises();
		coordinator.dispose();
		expect(contexts[4]?.signal.aborted).toBe(true);
		expect(contexts[5]?.signal.aborted).toBe(true);
		expect(coordinator.getState("session-c")).toBeUndefined();
		expect(coordinator.getState("session-d")).toBeUndefined();
	});

	it("isolates retry state across foreground and background Sessions", async () => {
		const clock = new FakeClock();
		const backgroundWork = deferred<SessionResyncCompletion>();
		const calls: Array<{ sessionHandle: string; attempt: number }> = [];
		const coordinator = createSessionResyncCoordinator({
			clock,
			random: () => 0.5,
			attempt: async (context) => {
				calls.push({ sessionHandle: context.identity.sessionHandle, attempt: context.attempt });
				if (context.identity.sessionHandle === "session-a") throw new Error("gap");
				return backgroundWork.promise;
			},
		});

		coordinator.start(identity("session-a"));
		coordinator.start(identity("session-b"));
		await flushPromises();
		expect(coordinator.getState("session-a")?.phase).toBe("retry_wait");
		expect(coordinator.getState("session-b")).toMatchObject({ phase: "syncing", attempt: 1 });

		clock.advanceBy(500);
		await flushPromises();
		expect(calls).toContainEqual({ sessionHandle: "session-a", attempt: 2 });
		expect(calls.filter((call) => call.sessionHandle === "session-b")).toHaveLength(1);
		expect(coordinator.getState("session-b")?.attempt).toBe(1);

		backgroundWork.resolve(completion(identity("session-b")));
		await flushPromises();
		expect(coordinator.getState("session-b")).toBeUndefined();
	});

	it.each(["server_epoch_changed", "epoch_changed", "generation_changed", "invalid_cursor"] as const)(
		"starts cursorless for %s even while the coordinator is idle",
		(reason) => {
			const contexts: SessionResyncAttemptContext[] = [];
			const coordinator = createSessionResyncCoordinator({
				attempt: (context) => {
					contexts.push(context);
					return new Promise<SessionResyncCompletion>(() => undefined);
				},
			});

			coordinator.start(identity(`session-${reason}`), { reason });

			expect(contexts).toHaveLength(1);
			expect(contexts[0]?.cursorless).toBe(true);
			coordinator.dispose();
		},
	);

	it("honors an explicit cursorless start without requiring a reason", () => {
		const contexts: SessionResyncAttemptContext[] = [];
		const coordinator = createSessionResyncCoordinator({
			attempt: (context) => {
				contexts.push(context);
				return new Promise<SessionResyncCompletion>(() => undefined);
			},
		});

		coordinator.start(identity("session-a"), { cursorless: true });

		expect(contexts[0]?.cursorless).toBe(true);
		coordinator.dispose();
	});

	it("recovers only after an exact typed snapshot completion ack", async () => {
		const clock = new FakeClock();
		const recovered = vi.fn();
		let calls = 0;
		const coordinator = createSessionResyncCoordinator({
			clock,
			random: () => 0.5,
			onRecovered: recovered,
			attempt: async (context) => {
				calls += 1;
				if (calls === 1) {
					return completion({ ...context.identity, workspaceId: "wrong-workspace" });
				}
				return completion(context.identity, { snapshotId: "snapshot-exact", asOfSeq: 23 });
			},
		});

		coordinator.start(identity("session-a"));
		await flushPromises();
		expect(recovered).not.toHaveBeenCalled();
		expect(coordinator.getState("session-a")).toMatchObject({
			phase: "retry_wait",
			lastError: "Session resync completion identity mismatch",
		});

		clock.advanceBy(500);
		await flushPromises();
		const expected = completion(identity("session-a"), {
			snapshotId: "snapshot-exact",
			asOfSeq: 23,
		});
		expect(recovered).toHaveBeenCalledOnce();
		expect(recovered).toHaveBeenCalledWith(expected);
		expect(coordinator.getState("session-a")).toBeUndefined();
	});

	it("fails closed when an attempt returns a malformed completion ack", async () => {
		const clock = new FakeClock();
		const recovered = vi.fn();
		const coordinator = createSessionResyncCoordinator({
			clock,
			random: () => 0.5,
			onRecovered: recovered,
			attempt: async () => undefined as unknown as SessionResyncCompletion,
		});

		coordinator.start(identity("session-a"));
		await flushPromises();

		expect(recovered).not.toHaveBeenCalled();
		expect(coordinator.getState("session-a")).toMatchObject({
			phase: "retry_wait",
			lastError: "Session resync completion is invalid",
		});
		expect(clock.timerCount).toBe(1);
	});

	it.each(["unsubscribe", "dispose"] as const)(
		"does not launch orphan work when a listener calls %s during the initial publish",
		(action) => {
			const clock = new FakeClock();
			const attempt = vi.fn(() => new Promise<SessionResyncCompletion>(() => undefined));
			let coordinator!: SessionResyncCoordinator;
			coordinator = createSessionResyncCoordinator({ attempt, clock });
			coordinator.subscribe((sessionHandle, state) => {
				if (!state) return;
				if (action === "unsubscribe") coordinator.unsubscribe(sessionHandle);
				else coordinator.dispose();
			});

			coordinator.start(identity("session-a"));

			expect(attempt).not.toHaveBeenCalled();
			expect(clock.timerCount).toBe(0);
			expect(coordinator.getState("session-a")).toBeUndefined();
		},
	);

	it("does not schedule an orphan retry when a listener unsubscribes during retry publish", async () => {
		const clock = new FakeClock();
		const attempt = vi.fn(async () => {
			throw new Error("gap");
		});
		const coordinator = createSessionResyncCoordinator({
			attempt,
			clock,
			random: () => 0.5,
		});
		coordinator.subscribe((sessionHandle, state) => {
			if (state?.phase === "retry_wait") coordinator.unsubscribe(sessionHandle);
		});

		coordinator.start(identity("session-a"));
		await flushPromises();

		expect(attempt).toHaveBeenCalledOnce();
		expect(clock.timerCount).toBe(0);
		expect(coordinator.getState("session-a")).toBeUndefined();
	});
});
