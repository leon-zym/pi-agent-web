import type { SessionRuntimeIdentityDto } from "@pi-agent-web/protocol";
import { toast } from "sonner";
import { playAttentionChime, playCompletionChime } from "./audio-feedback";
import type { TabStatus } from "./tab-badge";
import { updateTabBadge } from "./tab-badge";

/** The journal is deliberately finite; effect keys remain identity-scoped. */
export const SESSION_BROWSER_EFFECT_JOURNAL_LIMIT = 256;

/**
 * A directory refresh holds its key while its reads run. An intent that arrives before those
 * reads start is covered by them; one that arrives while they are reading is kept as a single
 * trailing refresh. A read that outlives this bound releases the key, so a read that never
 * settles cannot block later refreshes.
 */
export const SESSION_BROWSER_DIRECTORY_REFRESH_HOLD_MS = 30_000;

/**
 * Concurrent directory pairs. Distinguishing keys share one directory resource, so this
 * admits a bounded number of reads and holds the newest intent that cannot be admitted in
 * a single slot instead of growing state with the arrival rate.
 */
export const SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT = 8;

export type SessionBrowserIdentity = Readonly<
	Pick<SessionRuntimeIdentityDto, "serverEpoch" | "workspaceId" | "sessionHandle" | "generation">
>;

export type WorkspaceBrowserIdentity = Readonly<{ workspaceId: string }>;

export function createSessionBrowserIdentity(identity: SessionBrowserIdentity): SessionBrowserIdentity {
	return Object.freeze({
		serverEpoch: identity.serverEpoch,
		workspaceId: identity.workspaceId,
		sessionHandle: identity.sessionHandle,
		generation: identity.generation,
	});
}

export function createWorkspaceBrowserIdentity(identity: WorkspaceBrowserIdentity): WorkspaceBrowserIdentity {
	return Object.freeze({ workspaceId: identity.workspaceId });
}

/** Event keys suppress duplicate delivery; latest groups replace their previous value. */
export type SessionBrowserEffectDedupe =
	| {
			dedupeKey: string;
			dedupeMode?: "event";
	  }
	| {
			dedupeKey: string;
			dedupeMode: "latest";
			dedupeGroup: string;
	  };

type SessionBrowserSessionEffectBase = {
	identity: SessionBrowserIdentity;
} & SessionBrowserEffectDedupe;

type SessionBrowserWorkspaceEffectBase = {
	workspaceIdentity: WorkspaceBrowserIdentity;
} & SessionBrowserEffectDedupe;

export type SessionBrowserSessionEffect =
	| (SessionBrowserSessionEffectBase & {
			type: "toast";
			level: "info" | "success" | "warning" | "error";
			message: string;
			description?: string;
	  })
	| (SessionBrowserSessionEffectBase & {
			type: "audio";
			sound: "attention" | "completion";
	  })
	| (SessionBrowserSessionEffectBase & {
			type: "title";
			title: string;
	  })
	| (SessionBrowserSessionEffectBase & {
			type: "tab_badge";
			status: TabStatus;
			label?: string;
	  })
	| (SessionBrowserSessionEffectBase & {
			type: "directory_refresh";
			workspaceHandle: string;
			force?: boolean;
			delayMs?: number;
	  })
	| (SessionBrowserSessionEffectBase & {
			type: "navigation";
			action: "select_session" | "activate_workspace";
			workspaceHandle: string;
			sessionHandle?: string | null;
	  })
	| (SessionBrowserSessionEffectBase & {
			type: "timer";
			delayMs: number;
			run: () => void;
	  })
	| (SessionBrowserSessionEffectBase & {
			type: "custom";
			run: () => void | Promise<void>;
	  });

export type SessionBrowserWorkspaceEffect =
	| (SessionBrowserWorkspaceEffectBase & {
			type: "toast";
			level: "info" | "success" | "warning" | "error";
			message: string;
			description?: string;
	  })
	| (SessionBrowserWorkspaceEffectBase & {
			type: "directory_refresh";
			workspaceHandle: string;
			force?: boolean;
			delayMs?: number;
	  })
	| (SessionBrowserWorkspaceEffectBase & {
			type: "navigation";
			action: "select_session" | "activate_workspace";
			workspaceHandle: string;
			sessionHandle?: string | null;
	  });

export type SessionBrowserEffect = SessionBrowserSessionEffect | SessionBrowserWorkspaceEffect;

export interface SessionBrowserEffects {
	readonly now: () => number;
	/**
	 * Returns whether the effect scheduled work. A directory refresh that arrives while
	 * its pair is still reading is retained as one trailing refresh and returns true; one
	 * that arrives before the scheduled pair has read is subsumed by it and returns false.
	 */
	readonly dispatch: (effect: SessionBrowserEffect) => boolean;
	readonly setCurrentIdentity: (identity: SessionBrowserIdentity) => void;
	readonly currentIdentity: (sessionHandle: string) => SessionBrowserIdentity | null;
	readonly invalidateIdentity: (identity: SessionBrowserIdentity) => void;
	readonly isCurrent: (identity: SessionBrowserIdentity) => boolean;
	readonly setCurrentWorkspaceIdentity: (identity: WorkspaceBrowserIdentity) => void;
	readonly currentWorkspaceIdentity: (workspaceId: string) => WorkspaceBrowserIdentity | null;
	readonly invalidateWorkspaceIdentity: (identity: WorkspaceBrowserIdentity) => void;
	readonly isCurrentWorkspace: (identity: WorkspaceBrowserIdentity) => boolean;
	readonly journalSize: () => number;
	readonly pendingTimerCount: () => number;
	readonly dispose: () => void;
}

export interface SessionBrowserEffectsOptions {
	readonly now?: () => number;
	readonly setTimer?: (run: () => void, delayMs: number) => unknown;
	readonly clearTimer?: (timer: unknown) => void;
	readonly onDirectoryRefresh?: (workspaceHandle: string, force: boolean) => void | Promise<void>;
	readonly onNavigation?: (effect: Extract<SessionBrowserEffect, { type: "navigation" }>) => void;
	readonly onEffect?: (effect: SessionBrowserEffect) => unknown;
	readonly onEffectError?: (error: unknown, effect: SessionBrowserEffect) => void;
}

interface ScheduledTimer {
	readonly token: number;
	readonly timer: unknown;
}

function sameIdentity(left: SessionBrowserIdentity, right: SessionBrowserIdentity): boolean {
	return (
		left.serverEpoch === right.serverEpoch &&
		left.workspaceId === right.workspaceId &&
		left.sessionHandle === right.sessionHandle &&
		left.generation === right.generation
	);
}

function identityKey(identity: SessionBrowserIdentity): string {
	return JSON.stringify([
		"session",
		identity.serverEpoch,
		identity.workspaceId,
		identity.sessionHandle,
		identity.generation,
	]);
}

function workspaceIdentityKey(identity: WorkspaceBrowserIdentity): string {
	return JSON.stringify(["workspace", identity.workspaceId]);
}

function effectScopeKey(effect: SessionBrowserEffect): string {
	return "identity" in effect ? identityKey(effect.identity) : workspaceIdentityKey(effect.workspaceIdentity);
}

function effectKey(effect: SessionBrowserEffect): string {
	return `${effectScopeKey(effect)}:${effect.dedupeKey}`;
}

function latestEffectGroupKey(effect: SessionBrowserEffect): string | null {
	return effect.dedupeMode === "latest" ? `${effectScopeKey(effect)}:group:${effect.dedupeGroup}` : null;
}

function reportError(
	options: SessionBrowserEffectsOptions,
	effect: SessionBrowserEffect,
	error: unknown,
): void {
	try {
		options.onEffectError?.(error, effect);
	} catch {
		// Effect diagnostics must not take down the Session stream.
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function"
	);
}

export function createSessionBrowserEffects(
	options: SessionBrowserEffectsOptions = {},
): SessionBrowserEffects {
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? ((run, delayMs) => globalThis.setTimeout(run, delayMs));
	const clearTimer =
		options.clearTimer ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
	const currentByHandle = new Map<string, SessionBrowserIdentity>();
	const currentByWorkspace = new Map<string, WorkspaceBrowserIdentity>();
	const journal = new Map<string, number>();
	const latestKeyByGroup = new Map<string, string>();
	const timers = new Map<string, ScheduledTimer>();
	// A directory refresh that arrived while its pair was reading. Exactly one is kept;
	// it runs after the pair settles so the burst costs one pair without losing the
	// newer state that arrived mid-read.
	const trailingDirectoryRefresh = new Map<
		string,
		Extract<SessionBrowserEffect, { type: "directory_refresh" }>
	>();
	// Reads carry no signal, so the hold is released after this bound.
	const directoryRefreshHoldTimers = new Map<string, ScheduledTimer>();
	// The newest refresh that could not be admitted because the concurrency limit was
	// reached. A directory read is an idempotent request for current state, so one slot is
	// enough: a newer intent subsumes an older unadmitted one, and state stays bounded.
	let overflowDirectoryRefresh: Extract<SessionBrowserEffect, { type: "directory_refresh" }> | null = null;
	// Keys whose pair is actually reading. Eviction leaves these alone, so an accepted
	// trailing refresh cannot be dropped before the pair that owes it settles.
	const directoryRefreshActive = new Map<string, number>();
	let nextToken = 0;
	let disposed = false;

	const allocateToken = (): number => {
		nextToken += 1;
		return nextToken;
	};

	const clearDirectoryRefreshHold = (key: string): void => {
		const scheduled = directoryRefreshHoldTimers.get(key);
		if (!scheduled) return;
		clearTimer(scheduled.timer);
		directoryRefreshHoldTimers.delete(key);
	};

	const removeJournalEntry = (key: string, token?: number): void => {
		if (token !== undefined && journal.get(key) !== token) return;
		clearDirectoryRefreshHold(key);
		journal.delete(key);
		for (const [groupKey, latestKey] of latestKeyByGroup) {
			if (latestKey === key) latestKeyByGroup.delete(groupKey);
		}
	};

	const cancelJournalEntry = (key: string, token?: number): void => {
		if (token !== undefined && journal.get(key) !== token) return;
		const scheduled = timers.get(key);
		if (scheduled) {
			clearTimer(scheduled.timer);
			timers.delete(key);
		}
		// Drop this key's own trailing refresh before admitting anyone else: it is invalidated
		// along with the pair, so it must not be preferred over the held intent.
		trailingDirectoryRefresh.delete(key);
		releaseDirectoryRefreshSlot(key);
		removeJournalEntry(key, token);
	};

	const clearIdentityState = (identity: SessionBrowserIdentity): void => {
		const prefix = `${identityKey(identity)}:`;
		for (const key of [...trailingDirectoryRefresh.keys()]) {
			if (key.startsWith(prefix)) trailingDirectoryRefresh.delete(key);
		}
		for (const key of [...journal.keys()]) {
			if (key.startsWith(prefix)) cancelJournalEntry(key);
		}
		for (const [key, scheduled] of [...timers]) {
			if (!key.startsWith(prefix)) continue;
			clearTimer(scheduled.timer);
			timers.delete(key);
			removeJournalEntry(key, scheduled.token);
		}
		for (const [key, scheduled] of [...directoryRefreshHoldTimers]) {
			if (!key.startsWith(prefix)) continue;
			clearTimer(scheduled.timer);
			directoryRefreshHoldTimers.delete(key);
		}
	};

	const clearWorkspaceState = (identity: WorkspaceBrowserIdentity): void => {
		const prefix = `${workspaceIdentityKey(identity)}:`;
		for (const key of [...trailingDirectoryRefresh.keys()]) {
			if (key.startsWith(prefix)) trailingDirectoryRefresh.delete(key);
		}
		for (const key of [...journal.keys()]) {
			if (key.startsWith(prefix)) cancelJournalEntry(key);
		}
		for (const [key, scheduled] of [...timers]) {
			if (!key.startsWith(prefix)) continue;
			clearTimer(scheduled.timer);
			timers.delete(key);
			removeJournalEntry(key, scheduled.token);
		}
		for (const [key, scheduled] of [...directoryRefreshHoldTimers]) {
			if (!key.startsWith(prefix)) continue;
			clearTimer(scheduled.timer);
			directoryRefreshHoldTimers.delete(key);
		}
	};

	const isSessionEffectCurrent = (effect: SessionBrowserSessionEffect): boolean => {
		const current = currentByHandle.get(effect.identity.sessionHandle);
		return current !== undefined && sameIdentity(current, effect.identity);
	};
	const isWorkspaceEffectCurrent = (effect: SessionBrowserWorkspaceEffect): boolean => {
		const current = currentByWorkspace.get(effect.workspaceIdentity.workspaceId);
		return current?.workspaceId === effect.workspaceIdentity.workspaceId;
	};

	const isActive = (effect: SessionBrowserEffect, key: string, token: number): boolean => {
		if (disposed || journal.get(key) !== token) return false;
		return "identity" in effect ? isSessionEffectCurrent(effect) : isWorkspaceEffectCurrent(effect);
	};

	const observePromise = (
		effect: SessionBrowserEffect,
		key: string,
		token: number,
		value: unknown,
		removeOnSettle = true,
	): void => {
		if (!isPromiseLike(value)) return;
		void value.then(
			() => {
				if (removeOnSettle) removeJournalEntry(key, token);
			},
			(error) => {
				if (isActive(effect, key, token)) reportError(options, effect, error);
				if (removeOnSettle) removeJournalEntry(key, token);
			},
		);
	};

	const runTimerEffect = (
		effect: Extract<SessionBrowserEffect, { type: "timer" }>,
		key: string,
		token: number,
	): void => {
		if (!isActive(effect, key, token)) return;
		try {
			const result = effect.run();
			observePromise(effect, key, token, result);
		} catch (error) {
			if (isActive(effect, key, token)) reportError(options, effect, error);
		}
	};

	/**
	 * Ends one directory pair: the key is released and the single intent that arrived
	 * while the pair was reading runs as the next pair. A stale token leaves the state
	 * to whichever pair owns the key now.
	 */
	const settleDirectoryRefresh = (key: string, token: number): void => {
		if (journal.get(key) !== token) return;
		const pending = trailingDirectoryRefresh.get(key);
		trailingDirectoryRefresh.delete(key);
		removeJournalEntry(key, token);
		if (pending) dispatch(pending);
	};

	/**
	 * Admits the held refresh once a slot frees. Re-dispatching rechecks identity and the
	 * per-key journal, so an intent that went stale while waiting is dropped instead of read.
	 */
	const admitOverflowDirectoryRefresh = (): void => {
		const overflow = overflowDirectoryRefresh;
		if (!overflow) return;
		if (directoryRefreshActive.size >= SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT) return;
		overflowDirectoryRefresh = null;
		dispatch(overflow);
	};

	/** Frees the slot a key holds, without admitting anyone else yet. */
	const freeDirectoryRefreshSlot = (key: string): void => {
		directoryRefreshActive.delete(key);
	};

	/**
	 * Frees the slot and admits the newest held intent. Only for a release that has already
	 * dropped the key's own trailing refresh, so nothing of higher priority is waiting.
	 */
	const releaseDirectoryRefreshSlot = (key: string): void => {
		freeDirectoryRefreshSlot(key);
		admitOverflowDirectoryRefresh();
	};

	/**
	 * Ends the pair that holds a key. A completion for an older token is ignored: by then a
	 * newer pair owns the key, and freeing it here would drop that pair's slot while its own
	 * trailing refresh is still pending, admitting more pairs than the limit allows.
	 */
	const concludeDirectoryRefresh = (key: string, token: number): void => {
		if (directoryRefreshActive.get(key) !== token) return;
		freeDirectoryRefreshSlot(key);
		settleDirectoryRefresh(key, token);
		admitOverflowDirectoryRefresh();
	};

	/** Bounds how long one pair may hold its key; the reads carry no signal or timeout. */
	const holdDirectoryRefresh = (key: string, token: number): void => {
		try {
			const timer = setTimer(() => {
				// Only the pair that scheduled this hold may clear it and conclude.
				if (directoryRefreshHoldTimers.get(key)?.token !== token) return;
				directoryRefreshHoldTimers.delete(key);
				concludeDirectoryRefresh(key, token);
			}, SESSION_BROWSER_DIRECTORY_REFRESH_HOLD_MS);
			directoryRefreshHoldTimers.set(key, { token, timer });
		} catch {
			// Without a hold the pair still settles normally; a lost read simply keeps the
			// key, which is the pre-existing behavior for these readers.
			directoryRefreshHoldTimers.delete(key);
		}
	};

	/**
	 * Rejects a pair that cannot start because the concurrency limit is reached. The newest
	 * rejected intent takes the single overflow slot, so state stays bounded.
	 */
	const holdOverflowDirectoryRefresh = (
		effect: Extract<SessionBrowserEffect, { type: "directory_refresh" }>,
	): void => {
		overflowDirectoryRefresh = effect;
	};

	const runDirectoryRefresh = (
		effect: Extract<SessionBrowserEffect, { type: "directory_refresh" }>,
		key: string,
		token: number,
	): void => {
		if (!isActive(effect, key, token)) {
			settleDirectoryRefresh(key, token);
			return;
		}
		// A delayed refresh re-checks admission when it fires: intents that were admitted
		// while it waited may already fill the limit.
		if (directoryRefreshActive.size >= SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT) {
			holdOverflowDirectoryRefresh(effect);
			settleDirectoryRefresh(key, token);
			return;
		}
		// The hold marks the pair as reading, so an intent arriving once the reads are
		// dispatched is retained instead of being treated as covered by this pair.
		directoryRefreshActive.set(key, token);
		holdDirectoryRefresh(key, token);
		const settle = (): void => {
			concludeDirectoryRefresh(key, token);
		};
		try {
			const result = options.onDirectoryRefresh?.(effect.workspaceHandle, effect.force === true);
			if (isPromiseLike(result)) {
				void result.then(settle, (error) => {
					if (isActive(effect, key, token)) reportError(options, effect, error);
					settle();
				});
			} else {
				settle();
			}
		} catch (error) {
			if (isActive(effect, key, token)) reportError(options, effect, error);
			settle();
		}
	};

	const dispatch = (effect: SessionBrowserEffect): boolean => {
		if (disposed) return false;
		if ("identity" in effect ? !isSessionEffectCurrent(effect) : !isWorkspaceEffectCurrent(effect))
			return false;
		const key = effectKey(effect);
		if (journal.has(key)) {
			// A directory refresh still scheduled by its delay has not read yet, so it
			// observes this intent's state and the intent is absorbed. One that is already
			// reading may have captured older state, so keep a single trailing refresh.
			if (effect.type === "directory_refresh" && !timers.has(key)) {
				trailingDirectoryRefresh.set(key, effect);
				return true;
			}
			return false;
		}
		// Distinguishing keys share one directory resource, so admit a bounded number of
		// concurrent pairs. The newest intent that cannot be admitted takes the single
		// overflow slot, so state stays bounded however fast intents arrive.
		if (
			effect.type === "directory_refresh" &&
			!directoryRefreshActive.has(key) &&
			directoryRefreshActive.size >= SESSION_BROWSER_DIRECTORY_REFRESH_CONCURRENCY_LIMIT
		) {
			overflowDirectoryRefresh = effect;
			return true;
		}
		const groupKey = latestEffectGroupKey(effect);
		if (groupKey) {
			const previousKey = latestKeyByGroup.get(groupKey);
			if (previousKey) cancelJournalEntry(previousKey);
		}
		const token = allocateToken();
		journal.set(key, token);
		if (groupKey) latestKeyByGroup.set(groupKey, key);
		while (journal.size > SESSION_BROWSER_EFFECT_JOURNAL_LIMIT) {
			// Evict the oldest key that is neither mid-read nor the one just inserted.
			// An active pair already accepted a trailing refresh, and the inserted key has
			// not run yet, so evicting either would drop work dispatch already accepted.
			let oldest: string | undefined;
			for (const candidate of journal.keys()) {
				if (candidate === key) continue;
				if (directoryRefreshActive.has(candidate)) continue;
				oldest = candidate;
				break;
			}
			// Every remaining key is mid-read, so the journal transiently exceeds its limit
			// rather than discarding accepted work. Active pairs are released by their
			// settlement or their hold, so the excess is bounded in time.
			if (oldest === undefined) break;
			cancelJournalEntry(oldest);
		}
		try {
			const result = options.onEffect?.(effect);
			observePromise(effect, key, token, result, false);
		} catch (error) {
			reportError(options, effect, error);
		}
		if (!isActive(effect, key, token)) return true;

		if (effect.type === "timer") {
			try {
				const timer = setTimer(
					() => {
						const scheduled = timers.get(key);
						if (!scheduled || scheduled.token !== token) return;
						timers.delete(key);
						runTimerEffect(effect, key, token);
					},
					Math.max(0, effect.delayMs),
				);
				timers.set(key, { token, timer });
			} catch (error) {
				if (isActive(effect, key, token)) reportError(options, effect, error);
				removeJournalEntry(key, token);
			}
			return true;
		}
		if (effect.type === "directory_refresh") {
			if (effect.delayMs !== undefined) {
				try {
					const timer = setTimer(
						() => {
							const scheduled = timers.get(key);
							if (!scheduled || scheduled.token !== token) return;
							timers.delete(key);
							runDirectoryRefresh(effect, key, token);
						},
						Math.max(0, effect.delayMs),
					);
					timers.set(key, { token, timer });
				} catch (error) {
					if (isActive(effect, key, token)) reportError(options, effect, error);
					removeJournalEntry(key, token);
				}
			} else {
				runDirectoryRefresh(effect, key, token);
			}
			return true;
		}
		if (effect.type === "navigation") {
			try {
				options.onNavigation?.(effect);
			} catch (error) {
				if (isActive(effect, key, token)) reportError(options, effect, error);
			}
			return true;
		}
		if (effect.type === "custom") {
			try {
				observePromise(effect, key, token, effect.run());
			} catch (error) {
				if (isActive(effect, key, token)) reportError(options, effect, error);
			}
		}
		return true;
	};

	return {
		now,
		dispatch,
		setCurrentIdentity: (identity) => {
			if (disposed) return;
			const next = createSessionBrowserIdentity(identity);
			const previous = currentByHandle.get(next.sessionHandle);
			if (
				previous &&
				previous.serverEpoch === next.serverEpoch &&
				previous.workspaceId === next.workspaceId &&
				next.generation < previous.generation
			) {
				return;
			}
			if (previous && !sameIdentity(previous, next)) clearIdentityState(previous);
			currentByHandle.set(next.sessionHandle, next);
		},
		currentIdentity: (sessionHandle) => currentByHandle.get(sessionHandle) ?? null,
		invalidateIdentity: (identity) => {
			const current = currentByHandle.get(identity.sessionHandle);
			if (current && sameIdentity(current, identity)) currentByHandle.delete(identity.sessionHandle);
			clearIdentityState(identity);
		},
		isCurrent: (identity) => {
			const current = currentByHandle.get(identity.sessionHandle);
			return current !== undefined && sameIdentity(current, identity);
		},
		setCurrentWorkspaceIdentity: (identity) => {
			if (disposed) return;
			const next = createWorkspaceBrowserIdentity(identity);
			const previous = currentByWorkspace.get(next.workspaceId);
			if (previous && previous.workspaceId !== next.workspaceId) clearWorkspaceState(previous);
			currentByWorkspace.set(next.workspaceId, next);
		},
		currentWorkspaceIdentity: (workspaceId) => currentByWorkspace.get(workspaceId) ?? null,
		invalidateWorkspaceIdentity: (identity) => {
			const current = currentByWorkspace.get(identity.workspaceId);
			if (current) currentByWorkspace.delete(identity.workspaceId);
			clearWorkspaceState(identity);
		},
		isCurrentWorkspace: (identity) => {
			const current = currentByWorkspace.get(identity.workspaceId);
			return current?.workspaceId === identity.workspaceId;
		},
		journalSize: () => journal.size,
		pendingTimerCount: () => timers.size,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			for (const scheduled of timers.values()) clearTimer(scheduled.timer);
			timers.clear();
			for (const scheduled of directoryRefreshHoldTimers.values()) clearTimer(scheduled.timer);
			directoryRefreshHoldTimers.clear();
			trailingDirectoryRefresh.clear();
			directoryRefreshActive.clear();
			overflowDirectoryRefresh = null;
			journal.clear();
			latestKeyByGroup.clear();
			currentByHandle.clear();
			currentByWorkspace.clear();
		},
	};
}

export interface RecordingSessionBrowserEffects extends SessionBrowserEffects {
	readonly intents: SessionBrowserEffect[];
	readonly runTimers: () => void;
}

export function createRecordingSessionBrowserEffects(
	options: Omit<SessionBrowserEffectsOptions, "onEffect"> = {},
): RecordingSessionBrowserEffects {
	const intents: SessionBrowserEffect[] = [];
	const pendingTimers = new Map<number, { run: () => void; timer: unknown }>();
	let timerCounter = 0;
	const effects = createSessionBrowserEffects({
		...options,
		setTimer: (run, delayMs) => {
			timerCounter += 1;
			const id = timerCounter;
			const timer = options.setTimer?.(() => {
				pendingTimers.delete(id);
				run();
			}, delayMs);
			pendingTimers.set(id, { run, timer: timer ?? id });
			return id;
		},
		clearTimer: (timer) => {
			const id = timer as number;
			const pending = pendingTimers.get(id);
			pendingTimers.delete(id);
			if (pending && options.clearTimer && pending.timer !== id) options.clearTimer(pending.timer);
		},
		onEffect: (effect) => intents.push(effect),
	});
	return {
		...effects,
		intents,
		runTimers: () => {
			for (const [timer, pending] of [...pendingTimers]) {
				pendingTimers.delete(timer);
				if (options.clearTimer && pending.timer !== timer) options.clearTimer(pending.timer);
				pending.run();
			}
		},
	};
}

export function createProductionSessionBrowserEffects(
	options: SessionBrowserEffectsOptions = {},
): SessionBrowserEffects {
	return createSessionBrowserEffects({
		...options,
		onEffect: (effect) => {
			try {
				options.onEffect?.(effect);
				switch (effect.type) {
					case "toast":
						toast[effect.level](
							effect.message,
							effect.description ? { description: effect.description } : undefined,
						);
						return;
					case "audio":
						return effect.sound === "attention" ? playAttentionChime() : playCompletionChime();
					case "title":
						if (typeof document !== "undefined") document.title = effect.title;
						return;
					case "tab_badge":
						updateTabBadge(effect.status, effect.label);
						return;
					default:
						return;
				}
			} catch (error) {
				reportError(options, effect, error);
			}
		},
	});
}

/** Default Browser wiring; stateful callers only receive the typed sink. */
export function createDefaultSessionBrowserEffects(): SessionBrowserEffects {
	return createProductionSessionBrowserEffects({
		// Awaiting both reads keeps this effect's journal entry alive for the whole
		// request pair, so a second intent in the same burst is deduped instead of
		// issuing another Workspace and Session read.
		onDirectoryRefresh: async (workspaceHandle, force) => {
			const { useSessionDirectoryStore } = await import("../stores/session-directory");
			const directory = useSessionDirectoryStore.getState();
			const reads: Promise<unknown>[] = [directory.loadWorkspaces()];
			if (
				force ||
				directory.currentWorkspaceHandle === workspaceHandle ||
				directory.sessionsByWorkspace[workspaceHandle]
			) {
				reads.push(directory.reloadSessions(workspaceHandle, { force }));
			}
			await Promise.all(reads);
		},
	});
}

let activeSessionBrowserEffects = createDefaultSessionBrowserEffects();

export function getSessionBrowserEffects(): SessionBrowserEffects {
	return activeSessionBrowserEffects;
}

export function setSessionBrowserEffects(effects: SessionBrowserEffects): void {
	activeSessionBrowserEffects = effects;
}
