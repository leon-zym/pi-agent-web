import type { SessionResyncReasonDto, SessionRuntimeIdentityDto } from "@pi-agent-web/protocol";

export const SESSION_RESYNC_MAX_ATTEMPTS = 4;
export const SESSION_RESYNC_BACKOFF_MS = [500, 1_000, 2_000] as const;

export type SessionResyncIdentity = SessionRuntimeIdentityDto;

export type SessionResyncStartReason = SessionResyncReasonDto | "server_epoch_changed" | "manual_retry";

export interface SessionResyncStartOptions {
	reason?: SessionResyncStartReason;
	cursorless?: boolean;
}

export type SessionResyncPhase = "syncing" | "retry_wait" | "degraded";

export interface SessionResyncState {
	identity: SessionResyncIdentity;
	phase: SessionResyncPhase;
	attempt: number;
	cursorless: boolean;
	retryAt: number | null;
	lastError: string | null;
}

export interface SessionResyncAttemptContext {
	identity: SessionResyncIdentity;
	attempt: number;
	cursorless: boolean;
	signal: AbortSignal;
}

export interface SessionResyncCompletion {
	identity: SessionResyncIdentity;
	snapshotId: string;
	asOfSeq: number;
}

export interface SessionResyncClock {
	now: () => number;
	setTimeout: (callback: () => void, delayMs: number) => unknown;
	clearTimeout: (timer: unknown) => void;
}

export interface SessionResyncOptions {
	attempt: (
		context: SessionResyncAttemptContext,
	) => Promise<SessionResyncCompletion> | SessionResyncCompletion;
	clock?: SessionResyncClock;
	random?: () => number;
	onRecovered?: (completion: SessionResyncCompletion) => void;
}

export type SessionResyncListener = (sessionHandle: string, state: SessionResyncState | undefined) => void;

export interface SessionResyncCoordinator {
	start: (identity: SessionResyncIdentity, options?: SessionResyncStartOptions) => SessionResyncState;
	manualRetry: (sessionHandle: string) => boolean;
	disconnect: () => void;
	reconnect: () => void;
	unsubscribe: (sessionHandle: string) => void;
	rekey: (previousSessionHandle: string, identity: SessionResyncIdentity) => SessionResyncState;
	getState: (sessionHandle: string) => SessionResyncState | undefined;
	subscribe: (listener: SessionResyncListener) => () => void;
	dispose: () => void;
}

interface ResyncTask {
	token: number;
	controller: AbortController;
}

interface ResyncEntry {
	state: SessionResyncState;
	timer: unknown | undefined;
	task: ResyncTask | undefined;
}

const defaultClock: SessionResyncClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function identitiesMatch(left: SessionResyncIdentity, right: SessionResyncIdentity) {
	return (
		left.serverEpoch === right.serverEpoch &&
		left.workspaceId === right.workspaceId &&
		left.sessionHandle === right.sessionHandle &&
		left.generation === right.generation
	);
}

function requiresCursorlessStart(options: SessionResyncStartOptions | undefined) {
	if (options?.cursorless) return true;
	return (
		options?.reason === "server_epoch_changed" ||
		options?.reason === "epoch_changed" ||
		options?.reason === "generation_changed" ||
		options?.reason === "invalid_cursor" ||
		options?.reason === "manual_retry"
	);
}

function completionError(expectedIdentity: SessionResyncIdentity, completion: unknown) {
	if (typeof completion !== "object" || completion === null) {
		return new Error("Session resync completion is invalid");
	}
	const candidate = completion as Partial<SessionResyncCompletion>;
	if (typeof candidate.identity !== "object" || candidate.identity === null) {
		return new Error("Session resync completion is invalid");
	}
	if (!identitiesMatch(expectedIdentity, candidate.identity)) {
		return new Error("Session resync completion identity mismatch");
	}
	if (typeof candidate.snapshotId !== "string" || candidate.snapshotId.length === 0) {
		return new Error("Session resync completion snapshot identity is invalid");
	}
	if (!Number.isSafeInteger(candidate.asOfSeq) || (candidate.asOfSeq ?? -1) < 0) {
		return new Error("Session resync completion sequence is invalid");
	}
	return undefined;
}

function errorMessage(error: unknown) {
	if (error instanceof Error) return error.message;
	return String(error);
}

function clampRandom(value: number) {
	if (!Number.isFinite(value)) return 0.5;
	return Math.max(0, Math.min(1, value));
}

export function createSessionResyncCoordinator(options: SessionResyncOptions): SessionResyncCoordinator {
	const clock = options.clock ?? defaultClock;
	const random = options.random ?? Math.random;
	const entries = new Map<string, ResyncEntry>();
	const listeners = new Set<SessionResyncListener>();
	let connected = true;
	let disposed = false;
	let nextTaskToken = 1;

	const publish = (sessionHandle: string, state: SessionResyncState | undefined) => {
		for (const listener of listeners) listener(sessionHandle, state);
	};

	const updateState = (entry: ResyncEntry, state: SessionResyncState) => {
		entry.state = state;
		publish(state.identity.sessionHandle, state);
	};

	const abortTask = (entry: ResyncEntry) => {
		const task = entry.task;
		if (!task) return;
		entry.task = undefined;
		task.controller.abort();
	};

	const clearTimer = (entry: ResyncEntry) => {
		if (entry.timer === undefined) return;
		clock.clearTimeout(entry.timer);
		entry.timer = undefined;
	};

	const clearEntry = (sessionHandle: string, shouldPublish = true) => {
		const entry = entries.get(sessionHandle);
		if (!entry) return;
		entries.delete(sessionHandle);
		clearTimer(entry);
		abortTask(entry);
		if (shouldPublish) publish(sessionHandle, undefined);
	};

	const isEntryCurrent = (entry: ResyncEntry) => entries.get(entry.state.identity.sessionHandle) === entry;

	const isCurrent = (entry: ResyncEntry, task: ResyncTask) =>
		isEntryCurrent(entry) && entry.task?.token === task.token;

	const failAttempt = (entry: ResyncEntry, task: ResyncTask, attempt: number, error: unknown) => {
		if (!isCurrent(entry, task)) return;
		entry.task = undefined;
		if (attempt >= SESSION_RESYNC_MAX_ATTEMPTS) {
			updateState(entry, {
				...entry.state,
				phase: "degraded",
				retryAt: null,
				lastError: errorMessage(error),
			});
			return;
		}

		const baseDelay = SESSION_RESYNC_BACKOFF_MS[attempt - 1] ?? 2_000;
		const jitter = 0.8 + clampRandom(random()) * 0.4;
		const delayMs = Math.round(baseDelay * jitter);
		updateState(entry, {
			...entry.state,
			phase: "retry_wait",
			retryAt: clock.now() + delayMs,
			lastError: errorMessage(error),
		});
		if (isEntryCurrent(entry)) scheduleRetry(entry);
	};

	const runAttempt = (entry: ResyncEntry, attempt: number) => {
		if (!connected || disposed || !isEntryCurrent(entry)) return;
		clearTimer(entry);
		abortTask(entry);
		const task: ResyncTask = {
			token: nextTaskToken++,
			controller: new AbortController(),
		};
		entry.task = task;
		updateState(entry, {
			...entry.state,
			phase: "syncing",
			attempt,
			retryAt: null,
		});
		if (!isCurrent(entry, task) || !connected || disposed) return;
		const context: SessionResyncAttemptContext = {
			identity: entry.state.identity,
			attempt,
			cursorless: entry.state.cursorless,
			signal: task.controller.signal,
		};

		let result: Promise<SessionResyncCompletion> | SessionResyncCompletion;
		try {
			result = options.attempt(context);
		} catch (error) {
			result = Promise.reject(error);
		}

		void Promise.resolve(result).then(
			(completion) => {
				if (!isCurrent(entry, task)) return;
				const validationError = completionError(entry.state.identity, completion);
				if (validationError) {
					failAttempt(entry, task, attempt, validationError);
					return;
				}
				entry.task = undefined;
				const { identity } = entry.state;
				entries.delete(identity.sessionHandle);
				publish(identity.sessionHandle, undefined);
				options.onRecovered?.(completion);
			},
			(error: unknown) => failAttempt(entry, task, attempt, error),
		);
	};

	const scheduleRetry = (entry: ResyncEntry) => {
		if (!connected || disposed || !isEntryCurrent(entry) || entry.state.phase !== "retry_wait") {
			return;
		}
		clearTimer(entry);
		const delayMs = Math.max(0, (entry.state.retryAt ?? clock.now()) - clock.now());
		entry.timer = clock.setTimeout(() => {
			entry.timer = undefined;
			if (entries.get(entry.state.identity.sessionHandle) !== entry) return;
			runAttempt(entry, entry.state.attempt + 1);
		}, delayMs);
	};

	const createEntry = (identity: SessionResyncIdentity, cursorless: boolean) => {
		const state: SessionResyncState = {
			identity,
			phase: "syncing",
			attempt: 1,
			cursorless,
			retryAt: null,
			lastError: null,
		};
		const entry: ResyncEntry = { state, timer: undefined, task: undefined };
		entries.set(identity.sessionHandle, entry);
		publish(identity.sessionHandle, state);
		runAttempt(entry, 1);
		return entry.state;
	};

	const start = (identity: SessionResyncIdentity, startOptions?: SessionResyncStartOptions) => {
		if (disposed) throw new Error("Session resync coordinator is disposed");
		const current = entries.get(identity.sessionHandle);
		const requestedCursorless = requiresCursorlessStart(startOptions);
		if (
			current &&
			identitiesMatch(current.state.identity, identity) &&
			(!requestedCursorless || current.state.cursorless)
		) {
			return current.state;
		}
		const identityChanged = current !== undefined;
		clearEntry(identity.sessionHandle, false);
		return createEntry(identity, identityChanged || requestedCursorless);
	};

	return {
		start,
		manualRetry: (sessionHandle) => {
			if (disposed) return false;
			const entry = entries.get(sessionHandle);
			if (entry?.state.phase !== "degraded") return false;
			clearTimer(entry);
			abortTask(entry);
			updateState(entry, {
				...entry.state,
				phase: "syncing",
				attempt: 1,
				cursorless: true,
				retryAt: null,
				lastError: null,
			});
			runAttempt(entry, 1);
			return true;
		},
		disconnect: () => {
			if (!connected || disposed) return;
			connected = false;
			for (const entry of entries.values()) {
				clearTimer(entry);
				abortTask(entry);
			}
		},
		reconnect: () => {
			if (connected || disposed) return;
			connected = true;
			for (const entry of entries.values()) {
				if (entry.state.phase === "degraded") continue;
				if (entry.state.phase === "retry_wait") scheduleRetry(entry);
				else runAttempt(entry, entry.state.attempt);
			}
		},
		unsubscribe: (sessionHandle) => clearEntry(sessionHandle),
		rekey: (previousSessionHandle, identity) => {
			if (disposed) throw new Error("Session resync coordinator is disposed");
			clearEntry(previousSessionHandle);
			if (identity.sessionHandle !== previousSessionHandle) clearEntry(identity.sessionHandle);
			return createEntry(identity, true);
		},
		getState: (sessionHandle) => entries.get(sessionHandle)?.state,
		subscribe: (listener) => {
			if (disposed) return () => undefined;
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			connected = false;
			for (const sessionHandle of [...entries.keys()]) clearEntry(sessionHandle, false);
			listeners.clear();
		},
	};
}
