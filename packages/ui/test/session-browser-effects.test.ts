import { describe, expect, it, vi } from "vitest";
import {
	createRecordingSessionBrowserEffects,
	createSessionBrowserEffects,
	createSessionBrowserIdentity,
	type SessionBrowserEffect,
} from "../src/lib/session-browser-effects";

const identity = createSessionBrowserIdentity({
	serverEpoch: "epoch-a",
	workspaceId: "workspace-a",
	sessionHandle: "session-a",
	generation: 3,
});

describe("SessionBrowserEffects", () => {
	it("records effects in order with their complete captured identity and dedupes a key", () => {
		const effects = createRecordingSessionBrowserEffects();
		effects.setCurrentIdentity(identity);
		const first: SessionBrowserEffect = {
			type: "toast",
			identity,
			dedupeKey: "session-a:notice",
			level: "info",
			message: "hello",
		};

		effects.dispatch(first);
		effects.dispatch(first);
		effects.dispatch({
			type: "tab_badge",
			identity,
			dedupeKey: "session-a:badge",
			status: "running",
			label: "Session A",
		});

		expect(effects.intents).toEqual([first, expect.objectContaining({ type: "tab_badge" })]);
	});

	it("drops a stale scheduled completion after identity changes", () => {
		const effects = createRecordingSessionBrowserEffects();
		const run = vi.fn();
		effects.setCurrentIdentity(identity);
		effects.dispatch({
			type: "timer",
			identity,
			dedupeKey: "session-a:refresh",
			delayMs: 10,
			run,
		});
		effects.setCurrentIdentity({ ...identity, generation: 4 });
		effects.runTimers();

		expect(run).not.toHaveBeenCalled();
	});

	it("isolates effect failures and continues recording subsequent intents", () => {
		const errors: unknown[] = [];
		const effects = createRecordingSessionBrowserEffects({
			onEffectError: (error) => errors.push(error),
		});
		effects.setCurrentIdentity(identity);
		const failing: SessionBrowserEffect = {
			type: "custom",
			identity,
			dedupeKey: "session-a:bad",
			run: () => {
				throw new Error("broken");
			},
		};
		effects.dispatch(failing);
		effects.dispatch({
			type: "toast",
			identity,
			dedupeKey: "session-a:good",
			level: "success",
			message: "still works",
		});

		expect(errors).toHaveLength(1);
		expect(effects.intents).toHaveLength(2);
	});

	it("runs navigation and delayed directory refresh through the injected adapter", async () => {
		const timers: Array<() => void> = [];
		const errors: unknown[] = [];
		const navigate = vi.fn();
		const refresh = vi.fn(async () => {
			throw new Error("refresh failed");
		});
		const effects = createSessionBrowserEffects({
			setTimer: (run) => {
				timers.push(run);
				return timers.length;
			},
			clearTimer: (timer) => {
				const index = (timer as number) - 1;
				if (index >= 0) timers[index] = () => {};
			},
			onNavigation: navigate,
			onDirectoryRefresh: refresh,
			onEffectError: (error) => errors.push(error),
		});
		effects.setCurrentIdentity(identity);

		expect(
			effects.dispatch({
				type: "navigation",
				identity,
				dedupeKey: "select",
				action: "select_session",
				workspaceHandle: identity.workspaceId,
				sessionHandle: identity.sessionHandle,
			}),
		).toBe(true);
		expect(
			effects.dispatch({
				type: "directory_refresh",
				identity,
				dedupeKey: "refresh",
				workspaceHandle: identity.workspaceId,
				delayMs: 10,
			}),
		).toBe(true);
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(refresh).not.toHaveBeenCalled();

		timers.shift()?.();
		await Promise.resolve();
		expect(refresh).toHaveBeenCalledWith(identity.workspaceId, false);
		expect(errors).toHaveLength(1);
		expect(
			effects.dispatch({
				type: "directory_refresh",
				identity,
				dedupeKey: "refresh",
				workspaceHandle: identity.workspaceId,
				delayMs: 10,
			}),
		).toBe(true);
	});

	it("reports rejected asynchronous custom effects without affecting later effects", async () => {
		const errors: unknown[] = [];
		const effects = createRecordingSessionBrowserEffects({
			onEffectError: (error) => errors.push(error),
		});
		effects.setCurrentIdentity(identity);
		effects.dispatch({
			type: "custom",
			identity,
			dedupeKey: "async-failure",
			run: async () => {
				throw new Error("async broken");
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(errors).toHaveLength(1);
		expect(
			effects.dispatch({
				type: "toast",
				identity,
				dedupeKey: "after-async-failure",
				level: "success",
				message: "continues",
			}),
		).toBe(true);
	});
});
