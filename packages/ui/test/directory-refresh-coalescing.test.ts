import type { NativeSessionDto, NativeSessionListDto, NativeWorkspaceDto } from "@pi-agent-web/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import {
	createDefaultSessionBrowserEffects,
	createRecordingSessionBrowserEffects,
	createSessionBrowserEffects,
	createSessionBrowserIdentity,
	SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT,
	SESSION_BROWSER_DIRECTORY_REFRESH_HOLD_MS,
	SESSION_BROWSER_EFFECT_JOURNAL_LIMIT,
	type SessionBrowserEffects,
	type SessionBrowserIdentity,
} from "../src/lib/session-browser-effects";
import { useSessionDirectoryStore as directory } from "../src/stores/session-directory";

const WORKSPACE_HANDLE = "workspace-a";
const identity = createSessionBrowserIdentity({
	serverEpoch: "epoch-a",
	workspaceId: WORKSPACE_HANDLE,
	sessionHandle: "session-a",
	generation: 1,
});
const refresh = {
	type: "directory_refresh",
	identity,
	workspaceHandle: WORKSPACE_HANDLE,
	dedupeKey: "directory-refresh",
} as const;
const workspace: NativeWorkspaceDto = {
	workspaceHandle: WORKSPACE_HANDLE,
	path: "/tmp",
	available: true,
	pinned: false,
	displayName: WORKSPACE_HANDLE,
	lastOpenedAt: null,
	sessionCount: 1,
	hasNativeHistory: true,
};
const session: NativeSessionDto = {
	workspaceHandle: WORKSPACE_HANDLE,
	sessionHandle: "session-a",
	nativeSessionId: "native",
	sessionFile: "/tmp/test.jsonl",
	persisted: true,
	createdAt: null,
	modifiedAt: null,
	messageCount: 1,
	firstMessage: "Test",
	runtime: null,
};
const sessions: NativeSessionListDto = {
	sessions: [session],
	layout: { sessionDir: "/tmp", source: "default" },
};

const initial = directory.getState();
let effects: SessionBrowserEffects | null = null;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

/** Serves one queued deferred per read so each refresh pair can settle independently. */
function deferReads<T>(count: number) {
	const queue = Array.from({ length: count }, () => deferred<T>());
	let index = 0;
	return {
		next: () => {
			const current = queue[index];
			if (!current) throw new Error("unexpected extra directory read");
			index += 1;
			return current.promise;
		},
		resolveAt: (position: number, value: T) => queue[position]?.resolve(value),
	};
}

afterEach(() => {
	effects?.dispose();
	effects = null;
	vi.useRealTimers();
	directory.getState().invalidateDirectoryRequests();
	directory.setState(initial, true);
	vi.restoreAllMocks();
});

// Two intents in one settled-turn burst must not start two concurrent pairs, and the
// second must not be lost: the scheduled pair has not read yet, so it covers both.
it("absorbs an intent that arrives before the scheduled pair reads", () => {
	const onDirectoryRefresh = vi.fn();
	const recording = createRecordingSessionBrowserEffects({ onDirectoryRefresh });
	effects = recording;
	effects.setCurrentIdentity(identity);

	expect(effects.dispatch({ ...refresh, delayMs: 100 })).toBe(true);
	expect(effects.dispatch({ ...refresh })).toBe(false);
	recording.runTimers();

	expect(onDirectoryRefresh).toHaveBeenCalledTimes(1);
	expect(onDirectoryRefresh).toHaveBeenCalledWith(WORKSPACE_HANDLE, false);
	expect(effects.journalSize()).toBe(0);
});

// A read that started before the intent cannot have observed it, so the pair is replayed
// once instead of dropped. Dropping it leaves the Sidebar catalog stale behind the Session
// that just settled, and nothing newer fences the stale result.
it("replays one refresh after an in-flight pair settles and keeps the catalog fresh", async () => {
	const workspaceReads = deferReads<NativeWorkspaceDto[]>(3);
	const sessionReads = deferReads<NativeSessionListDto>(3);
	const listWorkspaces = vi.spyOn(api, "listWorkspaces").mockImplementation(() => workspaceReads.next());
	const listSessions = vi.spyOn(api, "listSessions").mockImplementation(() => sessionReads.next());
	directory.setState({
		workspaces: [workspace],
		currentWorkspaceHandle: WORKSPACE_HANDLE,
		sessionsByWorkspace: { [WORKSPACE_HANDLE]: [session] },
	});
	effects = createDefaultSessionBrowserEffects();
	effects.setCurrentIdentity(identity);

	expect(effects.dispatch(refresh)).toBe(true);
	await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));

	// The turn settles while the first pair is still reading.
	expect(effects.dispatch(refresh)).toBe(true);
	// Give a concurrent second pair every chance to start before asserting it did not.
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(listSessions).toHaveBeenCalledTimes(1);
	expect(listWorkspaces).toHaveBeenCalledTimes(1);

	workspaceReads.resolveAt(0, [workspace]);
	sessionReads.resolveAt(0, sessions);

	// The trailing intent runs after the in-flight pair settles, as its own pair.
	await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
	workspaceReads.resolveAt(1, [workspace]);
	sessionReads.resolveAt(1, { ...sessions, sessions: [{ ...session, messageCount: 2 }] });

	await vi.waitFor(() =>
		expect(directory.getState().sessionsByWorkspace[WORKSPACE_HANDLE]?.[0]?.messageCount).toBe(2),
	);
	await vi.waitFor(() => expect(effects?.journalSize()).toBe(0));
});

// The bound is the backstop for a read that ignores its signal: the key is released so later
// refreshes proceed instead of wedging behind it, and the retained intent still runs.
it("releases the key when a read outlives the hold", async () => {
	vi.useFakeTimers();
	const onDirectoryRefresh = vi.fn(() => new Promise<void>(() => {}));
	effects = createSessionBrowserEffects({ onDirectoryRefresh });
	effects.setCurrentIdentity(identity);

	expect(effects.dispatch(refresh)).toBe(true);
	expect(effects.dispatch(refresh)).toBe(true);
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(1);

	await vi.advanceTimersByTimeAsync(SESSION_BROWSER_DIRECTORY_REFRESH_HOLD_MS - 1);
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(1);

	await vi.advanceTimersByTimeAsync(1);
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(2);
	expect(effects.journalSize()).toBe(1);
});

// Eviction frees dedupe bookkeeping, but it must not discard a refresh the reading pair
// already accepted: the pair that is mid-read still owes that trailing refresh.
it("does not drop an accepted trailing refresh when the journal evicts entries", async () => {
	const onDirectoryRefresh = vi.fn(() => Promise.resolve());
	const recording = createRecordingSessionBrowserEffects({ onDirectoryRefresh });
	effects = recording;
	effects.setCurrentIdentity(identity);

	expect(effects.dispatch(refresh)).toBe(true);
	// A trailing intent is accepted while that pair reads.
	expect(effects.dispatch({ ...refresh })).toBe(true);
	// Overflow the journal with unrelated keys while the pair is still reading.
	for (let index = 0; index < SESSION_BROWSER_EFFECT_JOURNAL_LIMIT * 2; index += 1) {
		effects.dispatch({
			type: "toast",
			identity,
			dedupeKey: `toast-${String(index)}`,
			level: "info",
			message: String(index),
		});
	}

	await vi.waitFor(() => expect(onDirectoryRefresh).toHaveBeenCalledTimes(2));
	expect(effects.journalSize()).toBeLessThanOrEqual(SESSION_BROWSER_EFFECT_JOURNAL_LIMIT);
});

// Every distinct identity may be reading at once. When the concurrency limit is reached, a
// refresh accepted in that state must still read once a slot frees: eviction must not select
// the key it was just given, or dispatch reports success for work that never ran.
it("runs a refresh accepted while the concurrency limit is saturated", async () => {
	const reads: Array<() => void> = [];
	const onDirectoryRefresh = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				reads.push(resolve);
			}),
	);
	effects = createSessionBrowserEffects({ onDirectoryRefresh });
	const identityFor = (index: number): SessionBrowserIdentity =>
		createSessionBrowserIdentity({
			serverEpoch: "epoch-a",
			workspaceId: WORKSPACE_HANDLE,
			sessionHandle: `session-${String(index)}`,
			generation: 1,
		});
	const bounded = SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT;
	for (let index = 0; index < bounded; index += 1) {
		const sessionIdentity = identityFor(index);
		effects.setCurrentIdentity(sessionIdentity);
		expect(
			effects.dispatch({
				type: "directory_refresh",
				identity: sessionIdentity,
				workspaceHandle: WORKSPACE_HANDLE,
				dedupeKey: "directory-refresh",
			}),
		).toBe(true);
	}
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(bounded);

	const workspaceIdentity = { workspaceId: WORKSPACE_HANDLE };
	effects.setCurrentWorkspaceIdentity(workspaceIdentity);
	expect(
		effects.dispatch({
			type: "directory_refresh",
			workspaceIdentity,
			workspaceHandle: WORKSPACE_HANDLE,
			dedupeKey: "directory-refresh",
		}),
	).toBe(true);
	// It waited in the overflow slot, then read once a slot freed.
	reads[0]?.();
	await vi.waitFor(() => expect(onDirectoryRefresh).toHaveBeenCalledTimes(bounded + 1));
});

// Distinguishing identities share one directory resource, so concurrent pairs are capped.
// Intents beyond the cap must not grow state with the arrival rate, and the newest one must
// still read once a slot frees.
it("bounds concurrent pairs and admits the newest unadmitted refresh", async () => {
	vi.useFakeTimers();
	const reads: Array<() => void> = [];
	const onDirectoryRefresh = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				reads.push(resolve);
			}),
	);
	effects = createSessionBrowserEffects({ onDirectoryRefresh });
	const dispatchFor = (index: number) => {
		const sessionIdentity = createSessionBrowserIdentity({
			serverEpoch: "epoch-a",
			workspaceId: WORKSPACE_HANDLE,
			sessionHandle: `session-${String(index)}`,
			generation: 1,
		});
		effects?.setCurrentIdentity(sessionIdentity);
		return effects?.dispatch({
			type: "directory_refresh",
			identity: sessionIdentity,
			workspaceHandle: WORKSPACE_HANDLE,
			dedupeKey: "directory-refresh",
		});
	};

	const arrivals = SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT * 4;
	for (let index = 0; index < arrivals; index += 1) {
		expect(dispatchFor(index)).toBe(true);
	}
	// Only the cap reads; the rest collapse into one slot rather than queueing.
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT);
	expect(effects.journalSize()).toBeLessThanOrEqual(SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT + 1);

	// Free one slot: the newest unadmitted intent reads, and total state stays bounded.
	reads[0]?.();
	await vi.advanceTimersByTimeAsync(0);
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT + 1);
	expect(effects.journalSize()).toBeLessThanOrEqual(SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT + 1);

	// Nothing outlives the hold, so even ignored reads cannot accumulate state.
	await vi.advanceTimersByTimeAsync(SESSION_BROWSER_DIRECTORY_REFRESH_HOLD_MS);
	expect(effects.journalSize()).toBe(0);
});

// The hold is one of the paths that frees a slot, so it must drain the held intent too.
// Otherwise a saturated journal whose reads never complete leaves the newest intent unread.
it("admits the held refresh when the hold frees a slot", async () => {
	vi.useFakeTimers();
	const onDirectoryRefresh = vi.fn(() => new Promise<void>(() => {}));
	effects = createSessionBrowserEffects({ onDirectoryRefresh });
	const bounded = SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT;
	const dispatchFor = (index: number) => {
		const sessionIdentity = createSessionBrowserIdentity({
			serverEpoch: "epoch-a",
			workspaceId: WORKSPACE_HANDLE,
			sessionHandle: `session-${String(index)}`,
			generation: 1,
		});
		effects?.setCurrentIdentity(sessionIdentity);
		return effects?.dispatch({
			type: "directory_refresh",
			identity: sessionIdentity,
			workspaceHandle: WORKSPACE_HANDLE,
			dedupeKey: "directory-refresh",
		});
	};

	for (let index = 0; index < bounded; index += 1) {
		expect(dispatchFor(index)).toBe(true);
	}
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(bounded);
	// The reads never settle, so only the hold can free a slot for this intent.
	const held = createSessionBrowserIdentity({
		serverEpoch: "epoch-a",
		workspaceId: WORKSPACE_HANDLE,
		sessionHandle: "session-held",
		generation: 1,
	});
	effects.setCurrentIdentity(held);
	expect(
		effects.dispatch({
			type: "directory_refresh",
			identity: held,
			workspaceHandle: WORKSPACE_HANDLE,
			dedupeKey: "directory-refresh",
		}),
	).toBe(true);
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(bounded);

	await vi.advanceTimersByTimeAsync(SESSION_BROWSER_DIRECTORY_REFRESH_HOLD_MS);
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(bounded + 1);
});

// Identity invalidation frees slots as well, so it must drain the held intent rather than
// leaving it waiting for a settlement that will never come.
it("admits the held refresh when invalidation frees a slot", async () => {
	const onDirectoryRefresh = vi.fn(() => new Promise<void>(() => {}));
	effects = createSessionBrowserEffects({ onDirectoryRefresh });
	const bounded = SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT;
	const sessionIdentities: SessionBrowserIdentity[] = [];
	for (let index = 0; index < bounded; index += 1) {
		const sessionIdentity = createSessionBrowserIdentity({
			serverEpoch: "epoch-a",
			workspaceId: WORKSPACE_HANDLE,
			sessionHandle: `session-${String(index)}`,
			generation: 1,
		});
		sessionIdentities.push(sessionIdentity);
		effects.setCurrentIdentity(sessionIdentity);
		expect(
			effects.dispatch({
				type: "directory_refresh",
				identity: sessionIdentity,
				workspaceHandle: WORKSPACE_HANDLE,
				dedupeKey: "directory-refresh",
			}),
		).toBe(true);
	}
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(bounded);

	const held = createSessionBrowserIdentity({
		serverEpoch: "epoch-a",
		workspaceId: WORKSPACE_HANDLE,
		sessionHandle: "session-held",
		generation: 1,
	});
	effects.setCurrentIdentity(held);
	expect(
		effects.dispatch({
			type: "directory_refresh",
			identity: held,
			workspaceHandle: WORKSPACE_HANDLE,
			dedupeKey: "directory-refresh",
		}),
	).toBe(true);
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(bounded);

	const first = sessionIdentities[0];
	if (!first) throw new Error("expected a session identity");
	effects.invalidateIdentity(first);
	expect(onDirectoryRefresh).toHaveBeenCalledTimes(bounded + 1);
});

// Delayed refreshes are the production path for settled turns. Admission must be checked when
// the timer fires, not only at scheduling, or every delayed intent reads at once.
it("applies the concurrency limit to delayed refreshes when their timer fires", () => {
	const onDirectoryRefresh = vi.fn(() => new Promise<void>(() => {}));
	const recording = createRecordingSessionBrowserEffects({ onDirectoryRefresh });
	effects = recording;
	const bounded = SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT;
	const arrivals = bounded * 4;
	for (let index = 0; index < arrivals; index += 1) {
		const sessionIdentity = createSessionBrowserIdentity({
			serverEpoch: "epoch-a",
			workspaceId: WORKSPACE_HANDLE,
			sessionHandle: `session-${String(index)}`,
			generation: 1,
		});
		effects.setCurrentIdentity(sessionIdentity);
		expect(
			effects.dispatch({
				type: "directory_refresh",
				identity: sessionIdentity,
				workspaceHandle: WORKSPACE_HANDLE,
				dedupeKey: "directory-refresh",
				delayMs: 100,
			}),
		).toBe(true);
	}

	recording.runTimers();

	expect(onDirectoryRefresh).toHaveBeenCalledTimes(bounded);
	// The journal may not grow with the arrival rate either.
	expect(effects.journalSize()).toBeLessThanOrEqual(bounded + 1);
});

// A pair's own trailing refresh outranks the held overflow intent: draining overflow first
// would let the held intent take the freed slot, demote this key's accepted trailing refresh
// into the single overflow slot, and let a later intent overwrite it. The trailing refresh
// would then never run and the Sidebar could stay on stale directory content.
it("runs a pair's trailing refresh ahead of the held intent when a slot frees", async () => {
	vi.useFakeTimers();
	const reads: Array<() => void> = [];
	const handled: string[] = [];
	const onDirectoryRefresh = vi.fn((workspaceHandle: string) => {
		handled.push(workspaceHandle);
		return new Promise<void>((resolve) => {
			reads.push(resolve);
		});
	});
	effects = createSessionBrowserEffects({ onDirectoryRefresh });
	const bounded = SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT;
	const dispatchWorkspace = (workspaceId: string) => {
		const workspaceIdentity = { workspaceId };
		effects?.setCurrentWorkspaceIdentity(workspaceIdentity);
		return effects?.dispatch({
			type: "directory_refresh",
			workspaceIdentity,
			workspaceHandle: workspaceId,
			dedupeKey: "directory-refresh",
		});
	};

	// Saturate the cap with distinct Workspaces, give A a trailing refresh, then let B hold
	// the overflow slot and let a later intent try to overwrite it.
	const saturated = Array.from({ length: bounded - 1 }, (_value, index) => `ws-${String(index)}`);
	const first = saturated[0];
	if (!first) throw new Error("expected a saturated workspace");
	for (const workspaceId of saturated) expect(dispatchWorkspace(workspaceId)).toBe(true);
	expect(dispatchWorkspace(first)).toBe(true);
	expect(dispatchWorkspace("ws-overflow")).toBe(true);
	expect(dispatchWorkspace("ws-later")).toBe(true);
	expect(handled).toHaveLength(bounded);

	// Finishing A must run A's own trailing refresh, not the held intent for another Workspace.
	reads[0]?.();
	await vi.advanceTimersByTimeAsync(0);
	expect(handled.filter((workspaceId) => workspaceId === first)).toHaveLength(2);
});

// A hold handoff must not be undone by the superseded pair's promise settling late. The old
// completion arrives with a stale token; freeing the slot on it would drop the slot the newer
// pair owns and admit the held intent, exceeding the concurrency limit.
it.each(["resolve", "reject"] as const)(
	"ignores a late %s from the pair a hold already superseded",
	async (outcome) => {
		vi.useFakeTimers();
		type Pending = { settle: (error?: unknown) => void };
		const pending: Pending[] = [];
		const onDirectoryRefresh = vi.fn(
			() =>
				new Promise<void>((resolve, reject) => {
					pending.push({
						settle: (error) => (error === undefined ? resolve() : reject(error)),
					});
				}),
		);
		effects = createSessionBrowserEffects({ onDirectoryRefresh });
		const bounded = SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT;
		const dispatchFor = (sessionHandle: string) => {
			const sessionIdentity = createSessionBrowserIdentity({
				serverEpoch: "epoch-a",
				workspaceId: WORKSPACE_HANDLE,
				sessionHandle,
				generation: 1,
			});
			effects?.setCurrentIdentity(sessionIdentity);
			return effects?.dispatch({
				type: "directory_refresh",
				identity: sessionIdentity,
				workspaceHandle: WORKSPACE_HANDLE,
				dedupeKey: "directory-refresh",
			});
		};

		// Saturate every slot, then give the first key a trailing refresh.
		for (let index = 0; index < bounded; index += 1) expect(dispatchFor(`s-${String(index)}`)).toBe(true);
		expect(dispatchFor("s-0")).toBe(true);
		expect(onDirectoryRefresh).toHaveBeenCalledTimes(bounded);

		// The hold concludes every original pair; s-0's trailing refresh becomes a new pair.
		await vi.advanceTimersByTimeAsync(SESSION_BROWSER_DIRECTORY_REFRESH_HOLD_MS);
		const superseded = pending[0];
		if (!superseded) throw new Error("expected the first pair");
		expect(pending).toHaveLength(bounded + 1);

		// Refill to the limit with fresh keys, then hold one more intent behind them.
		for (let index = 0; index < bounded - 1; index += 1) {
			expect(dispatchFor(`refill-${String(index)}`)).toBe(true);
		}
		expect(dispatchFor("s-overflow")).toBe(true);
		const callsWhileHeld = onDirectoryRefresh.mock.calls.length;
		expect(callsWhileHeld).toBe(bounded + 1 + (bounded - 1));

		// The superseded pair settles late. It must not free the newer pair's slot, which
		// would admit the held intent and exceed the limit.
		superseded.settle(outcome === "reject" ? new Error("late failure") : undefined);
		await vi.advanceTimersByTimeAsync(0);

		expect(onDirectoryRefresh).toHaveBeenCalledTimes(callsWhileHeld);
	},
);
