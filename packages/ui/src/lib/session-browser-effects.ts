import type { SessionRuntimeIdentityDto } from "@pi-agent-web/protocol";
import { toast } from "sonner";
import { playAttentionChime, playCompletionChime } from "./audio-feedback";
import type { TabStatus } from "./tab-badge";
import { updateTabBadge } from "./tab-badge";

/** The journal is deliberately finite; effect keys remain identity-scoped. */
export const SESSION_BROWSER_EFFECT_JOURNAL_LIMIT = 256;

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
	let nextToken = 0;
	let disposed = false;

	const allocateToken = (): number => {
		nextToken += 1;
		return nextToken;
	};

	const removeJournalEntry = (key: string, token?: number): void => {
		if (token !== undefined && journal.get(key) !== token) return;
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
		removeJournalEntry(key, token);
	};

	const clearIdentityState = (identity: SessionBrowserIdentity): void => {
		const prefix = `${identityKey(identity)}:`;
		for (const key of [...journal.keys()]) {
			if (key.startsWith(prefix)) cancelJournalEntry(key);
		}
		for (const [key, scheduled] of [...timers]) {
			if (!key.startsWith(prefix)) continue;
			clearTimer(scheduled.timer);
			timers.delete(key);
			removeJournalEntry(key, scheduled.token);
		}
	};

	const clearWorkspaceState = (identity: WorkspaceBrowserIdentity): void => {
		const prefix = `${workspaceIdentityKey(identity)}:`;
		for (const key of [...journal.keys()]) {
			if (key.startsWith(prefix)) cancelJournalEntry(key);
		}
		for (const [key, scheduled] of [...timers]) {
			if (!key.startsWith(prefix)) continue;
			clearTimer(scheduled.timer);
			timers.delete(key);
			removeJournalEntry(key, scheduled.token);
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

	const runDirectoryRefresh = (
		effect: Extract<SessionBrowserEffect, { type: "directory_refresh" }>,
		key: string,
		token: number,
	): void => {
		if (!isActive(effect, key, token)) {
			removeJournalEntry(key, token);
			return;
		}
		try {
			const result = options.onDirectoryRefresh?.(effect.workspaceHandle, effect.force === true);
			if (isPromiseLike(result)) {
				void result.then(
					() => removeJournalEntry(key, token),
					(error) => {
						if (isActive(effect, key, token)) reportError(options, effect, error);
						removeJournalEntry(key, token);
					},
				);
			} else {
				removeJournalEntry(key, token);
			}
		} catch (error) {
			if (isActive(effect, key, token)) reportError(options, effect, error);
			removeJournalEntry(key, token);
		}
	};

	const dispatch = (effect: SessionBrowserEffect): boolean => {
		if (disposed) return false;
		if ("identity" in effect ? !isSessionEffectCurrent(effect) : !isWorkspaceEffectCurrent(effect))
			return false;
		const key = effectKey(effect);
		if (journal.has(key)) return false;
		const groupKey = latestEffectGroupKey(effect);
		if (groupKey) {
			const previousKey = latestKeyByGroup.get(groupKey);
			if (previousKey) cancelJournalEntry(previousKey);
		}
		const token = allocateToken();
		journal.set(key, token);
		if (groupKey) latestKeyByGroup.set(groupKey, key);
		while (journal.size > SESSION_BROWSER_EFFECT_JOURNAL_LIMIT) {
			const oldest = journal.keys().next().value;
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
		onDirectoryRefresh: async (workspaceHandle, force) => {
			const { useSessionDirectoryStore } = await import("../stores/session-directory");
			const directory = useSessionDirectoryStore.getState();
			void directory.loadWorkspaces();
			if (
				force ||
				directory.currentWorkspaceHandle === workspaceHandle ||
				directory.sessionsByWorkspace[workspaceHandle]
			) {
				void directory.reloadSessions(workspaceHandle, { force });
			}
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
