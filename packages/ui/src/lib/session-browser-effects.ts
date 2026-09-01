import { toast } from "sonner";
import { useSessionDirectoryStore } from "../stores/session-directory";
import { playAttentionChime, playCompletionChime } from "./audio-feedback";
import type { SessionLifecycleIdentity } from "./session-lifecycle-registry";
import type { TabStatus } from "./tab-badge";
import { updateTabBadge } from "./tab-badge";

export type SessionBrowserIdentity = SessionLifecycleIdentity;

export function createSessionBrowserIdentity(identity: SessionBrowserIdentity): SessionBrowserIdentity {
	return Object.freeze({ ...identity });
}

export type SessionBrowserEffect =
	| {
			type: "toast";
			identity: SessionBrowserIdentity;
			dedupeKey: string;
			level: "info" | "success" | "warning" | "error";
			message: string;
			description?: string;
	  }
	| {
			type: "audio";
			identity: SessionBrowserIdentity;
			dedupeKey: string;
			sound: "attention" | "completion";
	  }
	| {
			type: "title";
			identity: SessionBrowserIdentity;
			dedupeKey: string;
			title: string;
	  }
	| {
			type: "tab_badge";
			identity: SessionBrowserIdentity;
			dedupeKey: string;
			status: TabStatus;
			label?: string;
	  }
	| {
			type: "directory_refresh";
			identity: SessionBrowserIdentity;
			dedupeKey: string;
			workspaceHandle: string;
			force?: boolean;
			delayMs?: number;
	  }
	| {
			type: "navigation";
			identity: SessionBrowserIdentity;
			dedupeKey: string;
			action: "select_session" | "activate_workspace";
			workspaceHandle: string;
			sessionHandle?: string | null;
	  }
	| {
			type: "timer";
			identity: SessionBrowserIdentity;
			dedupeKey: string;
			delayMs: number;
			run: () => void;
	  }
	| {
			type: "custom";
			identity: SessionBrowserIdentity;
			dedupeKey: string;
			run: () => void | Promise<void>;
	  };

export interface SessionBrowserEffects {
	readonly now: () => number;
	readonly dispatch: (effect: SessionBrowserEffect) => boolean;
	readonly setCurrentIdentity: (identity: SessionBrowserIdentity) => void;
	readonly invalidateIdentity: (identity: SessionBrowserIdentity) => void;
	readonly isCurrent: (identity: SessionBrowserIdentity) => boolean;
	readonly dispose: () => void;
}

export interface SessionBrowserEffectsOptions {
	readonly now?: () => number;
	readonly setTimer?: (run: () => void, delayMs: number) => unknown;
	readonly clearTimer?: (timer: unknown) => void;
	readonly onDirectoryRefresh?: (workspaceHandle: string, force: boolean) => void | Promise<void>;
	readonly onNavigation?: (effect: Extract<SessionBrowserEffect, { type: "navigation" }>) => void;
	readonly onEffect?: (effect: SessionBrowserEffect) => void;
	readonly onEffectError?: (error: unknown, effect: SessionBrowserEffect) => void;
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
		identity.serverEpoch,
		identity.workspaceId,
		identity.sessionHandle,
		identity.generation,
	]);
}

function effectKey(effect: SessionBrowserEffect): string {
	return `${identityKey(effect.identity)}:${effect.dedupeKey}`;
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

function runEffect(options: SessionBrowserEffectsOptions, effect: SessionBrowserEffect): void {
	try {
		const result = (() => {
			switch (effect.type) {
				case "timer":
				case "custom":
					return effect.run();
				default:
					return undefined;
			}
		})();
		if (result && typeof (result as Promise<void>).then === "function") {
			void (result as Promise<void>).catch((error) => reportError(options, effect, error));
		}
	} catch (error) {
		reportError(options, effect, error);
	}
}

function observeEffectResult(
	options: SessionBrowserEffectsOptions,
	effect: SessionBrowserEffect,
	result: unknown,
): void {
	if (result && typeof (result as Promise<void>).then === "function") {
		void (result as Promise<void>).catch((error) => reportError(options, effect, error));
	}
}

export function createSessionBrowserEffects(
	options: SessionBrowserEffectsOptions = {},
): SessionBrowserEffects {
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? ((run, delayMs) => globalThis.setTimeout(run, delayMs));
	const clearTimer =
		options.clearTimer ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
	const currentByHandle = new Map<string, SessionBrowserIdentity>();
	const seen = new Set<string>();
	const timers = new Map<string, unknown>();
	let disposed = false;

	const isCurrent = (identity: SessionBrowserIdentity): boolean => {
		const current = currentByHandle.get(identity.sessionHandle);
		return current !== undefined && sameIdentity(current, identity);
	};
	const clearTimersForIdentity = (identity: SessionBrowserIdentity): void => {
		const prefix = `${identityKey(identity)}:`;
		for (const [key, timer] of timers) {
			if (!key.startsWith(prefix)) continue;
			clearTimer(timer);
			timers.delete(key);
			seen.delete(key);
		}
	};

	const dispatch = (effect: SessionBrowserEffect): boolean => {
		if (disposed || !isCurrent(effect.identity)) return false;
		const key = effectKey(effect);
		if (seen.has(key)) return false;
		seen.add(key);
		try {
			options.onEffect?.(effect);
		} catch (error) {
			reportError(options, effect, error);
		}

		if (effect.type === "timer") {
			const timer = setTimer(
				() => {
					timers.delete(key);
					if (disposed || !isCurrent(effect.identity)) return;
					runEffect(options, effect);
				},
				Math.max(0, effect.delayMs),
			);
			timers.set(key, timer);
			return true;
		}
		if (effect.type === "directory_refresh") {
			const run = () => {
				if (disposed || !isCurrent(effect.identity)) {
					seen.delete(key);
					return;
				}
				try {
					observeEffectResult(
						options,
						effect,
						options.onDirectoryRefresh?.(effect.workspaceHandle, effect.force === true),
					);
				} catch (error) {
					reportError(options, effect, error);
				} finally {
					// Directory refreshes coalesce only while their scheduled callback is pending.
					seen.delete(key);
				}
			};
			if (effect.delayMs !== undefined) {
				const timer = setTimer(
					() => {
						timers.delete(key);
						run();
					},
					Math.max(0, effect.delayMs),
				);
				timers.set(key, timer);
			} else {
				run();
			}
			return true;
		}
		if (effect.type === "navigation") {
			try {
				options.onNavigation?.(effect);
			} catch (error) {
				reportError(options, effect, error);
			}
			return true;
		}
		runEffect(options, effect);
		return true;
	};

	return {
		now,
		dispatch,
		setCurrentIdentity: (identity) => {
			if (disposed) return;
			const previous = currentByHandle.get(identity.sessionHandle);
			if (previous && !sameIdentity(previous, identity)) clearTimersForIdentity(previous);
			currentByHandle.set(identity.sessionHandle, createSessionBrowserIdentity(identity));
		},
		invalidateIdentity: (identity) => {
			const current = currentByHandle.get(identity.sessionHandle);
			if (current && sameIdentity(current, identity)) currentByHandle.delete(identity.sessionHandle);
			clearTimersForIdentity(identity);
		},
		isCurrent,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			for (const timer of timers.values()) clearTimer(timer);
			timers.clear();
			currentByHandle.clear();
			seen.clear();
		},
	};
}

export interface RecordingSessionBrowserEffects extends SessionBrowserEffects {
	readonly intents: SessionBrowserEffect[];
	readonly runTimers: () => void;
}

export function createRecordingSessionBrowserEffects(
	options: Omit<SessionBrowserEffectsOptions, "setTimer" | "clearTimer" | "onEffect"> = {},
): RecordingSessionBrowserEffects {
	const intents: SessionBrowserEffect[] = [];
	const pendingTimers = new Map<number, () => void>();
	let timerCounter = 0;
	const effects = createSessionBrowserEffects({
		...options,
		setTimer: (run) => {
			timerCounter += 1;
			pendingTimers.set(timerCounter, run);
			return timerCounter;
		},
		clearTimer: (timer) => {
			pendingTimers.delete(timer as number);
		},
		onEffect: (effect) => intents.push(effect),
	});
	return {
		...effects,
		intents,
		runTimers: () => {
			for (const [timer, run] of [...pendingTimers]) {
				pendingTimers.delete(timer);
				run();
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
			} catch (error) {
				reportError(options, effect, error);
			}
			switch (effect.type) {
				case "toast":
					toast[effect.level](
						effect.message,
						effect.description ? { description: effect.description } : undefined,
					);
					return;
				case "audio":
					void (effect.sound === "attention" ? playAttentionChime() : playCompletionChime()).catch((error) =>
						reportError(options, effect, error),
					);
					return;
				case "title":
					if (typeof document !== "undefined") document.title = effect.title;
					return;
				case "tab_badge":
					updateTabBadge(effect.status, effect.label);
					return;
				default:
					return;
			}
		},
	});
}

/** Production wiring for the typed effect sink; lifecycle owners only receive the injected interface. */
export function createDefaultSessionBrowserEffects(): SessionBrowserEffects {
	return createProductionSessionBrowserEffects({
		onDirectoryRefresh: (workspaceHandle, force) => {
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
