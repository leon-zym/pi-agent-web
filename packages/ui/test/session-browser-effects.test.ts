import { describe, expect, it, vi } from "vitest";
import {
	createRecordingSessionBrowserEffects,
	createSessionBrowserIdentity,
	SESSION_BROWSER_EFFECT_JOURNAL_LIMIT,
	type SessionBrowserEffect,
	type SessionBrowserIdentity,
} from "../src/lib/session-browser-effects";

const parent = createSessionBrowserIdentity({
	serverEpoch: "epoch-a",
	workspaceId: "workspace-a",
	sessionHandle: "session-parent",
	generation: 3,
});

describe("SessionBrowserEffects identity boundary", () => {
	it("admits only the exact current identity and re-admits a rematerialized identity", () => {
		const effects = createRecordingSessionBrowserEffects();
		effects.setCurrentIdentity(parent);
		const notice: SessionBrowserEffect = {
			type: "toast",
			identity: parent,
			dedupeKey: "notice",
			level: "info",
			message: "hello",
		};

		expect(effects.dispatch(notice)).toBe(true);
		expect(effects.dispatch(notice)).toBe(false);
		effects.setCurrentIdentity({ ...parent, generation: 4 });
		expect(effects.dispatch(notice)).toBe(false);
		effects.invalidateIdentity({ ...parent, generation: 4 });
		effects.setCurrentIdentity(parent);
		expect(effects.dispatch(notice)).toBe(true);
	});

	it("does not move the identity fence backward", () => {
		const effects = createRecordingSessionBrowserEffects();
		const next = { ...parent, generation: 4 };
		effects.setCurrentIdentity(next);
		effects.setCurrentIdentity(parent);

		expect(effects.currentIdentity(parent.sessionHandle)).toEqual(next);
		expect(effects.dispatch({ ...effectFor(next), dedupeKey: "new" })).toBe(true);
		expect(effects.dispatch(effectFor(parent))).toBe(false);
	});

	it("replays a changed latest title after it returns to an earlier value", () => {
		const effects = createRecordingSessionBrowserEffects();
		effects.setCurrentIdentity(parent);

		const dispatchTitle = (title: string) =>
			effects.dispatch({
				type: "title",
				identity: parent,
				dedupeKey: `title:${title}`,
				title,
				dedupeMode: "latest",
				dedupeGroup: "session-title",
			});

		expect(dispatchTitle("A")).toBe(true);
		expect(dispatchTitle("B")).toBe(true);
		expect(dispatchTitle("A")).toBe(true);
		expect(dispatchTitle("A")).toBe(false);
		expect(effects.intents.filter((effect) => effect.type === "title").map((effect) => effect.title)).toEqual(
			["A", "B", "A"],
		);
	});

	it("replays a changed latest tab badge after it returns to idle", () => {
		const effects = createRecordingSessionBrowserEffects();
		effects.setCurrentIdentity(parent);

		const dispatchBadge = (status: "idle" | "running") =>
			effects.dispatch({
				type: "tab_badge",
				identity: parent,
				dedupeKey: `tab-badge:${status}`,
				status,
				dedupeMode: "latest",
				dedupeGroup: "tab-badge",
			});

		expect(dispatchBadge("idle")).toBe(true);
		expect(dispatchBadge("running")).toBe(true);
		expect(dispatchBadge("idle")).toBe(true);
		expect(dispatchBadge("idle")).toBe(false);
		expect(
			effects.intents.filter((effect) => effect.type === "tab_badge").map((effect) => effect.status),
		).toEqual(["idle", "running", "idle"]);
	});

	it("keeps duplicate event delivery idempotent while allowing distinct event identities", () => {
		const effects = createRecordingSessionBrowserEffects();
		effects.setCurrentIdentity(parent);
		const dispatchCompletion = (eventId: string) =>
			effects.dispatch({
				type: "audio",
				identity: parent,
				dedupeKey: `agent-settled:${eventId}`,
				dedupeMode: "event",
				sound: "completion",
			});

		expect(dispatchCompletion("1")).toBe(true);
		expect(dispatchCompletion("1")).toBe(false);
		expect(dispatchCompletion("2")).toBe(true);
		expect(effects.intents.filter((effect) => effect.type === "audio")).toHaveLength(2);
	});

	it("requires the complete session identity, while allowing explicit workspace effects", () => {
		const effects = createRecordingSessionBrowserEffects();
		effects.setCurrentIdentity(parent);
		expect(effects.dispatch(effectFor({ ...parent, workspaceId: "workspace-other" }))).toBe(false);

		const workspaceIdentity = { workspaceId: parent.workspaceId };
		effects.setCurrentWorkspaceIdentity(workspaceIdentity);
		expect(
			effects.dispatch({
				type: "directory_refresh",
				workspaceIdentity,
				dedupeKey: "workspace-refresh",
				workspaceHandle: workspaceIdentity.workspaceId,
			}),
		).toBe(true);
		effects.invalidateWorkspaceIdentity(workspaceIdentity);
		expect(effects.isCurrentWorkspace(workspaceIdentity)).toBe(false);
	});

	it("drops delayed parent work after an authoritative generation change", () => {
		const effects = createRecordingSessionBrowserEffects();
		const run = vi.fn();
		effects.setCurrentIdentity(parent);
		effects.dispatch({
			type: "timer",
			identity: parent,
			dedupeKey: "delayed-parent",
			delayMs: 100,
			run,
		});
		effects.setCurrentIdentity({ ...parent, generation: 4 });
		effects.runTimers();

		expect(run).not.toHaveBeenCalled();
		expect(effects.pendingTimerCount()).toBe(0);
	});

	it("does not report a rejected promise after its identity is superseded", async () => {
		let rejectGate!: (error: Error) => void;
		const errors: unknown[] = [];
		const gate = new Promise<void>((_resolve, reject) => {
			rejectGate = reject;
		});
		const effects = createRecordingSessionBrowserEffects({
			onEffectError: (error) => errors.push(error),
		});
		effects.setCurrentIdentity(parent);
		effects.dispatch({
			type: "custom",
			identity: parent,
			dedupeKey: "async-parent",
			run: () => gate,
		});
		effects.setCurrentIdentity({ ...parent, generation: 4 });
		rejectGate(new Error("late parent failure"));
		await Promise.resolve();
		await Promise.resolve();

		expect(errors).toEqual([]);
	});

	it("bounds high-cardinality dedupe state and clears timer state on invalidation", () => {
		const timers: Array<() => void> = [];
		const effects = createRecordingSessionBrowserEffects({
			setTimer: (run) => {
				timers.push(run);
				return timers.length;
			},
			clearTimer: (timer) => {
				const index = Number(timer) - 1;
				if (index >= 0) timers[index] = () => {};
			},
		});
		effects.setCurrentIdentity(parent);
		for (let index = 0; index < SESSION_BROWSER_EFFECT_JOURNAL_LIMIT * 4; index += 1) {
			effects.dispatch({
				type: "toast",
				identity: parent,
				dedupeKey: `toast-${String(index)}`,
				level: "info",
				message: String(index),
			});
		}
		effects.dispatch({
			type: "directory_refresh",
			identity: parent,
			dedupeKey: "refresh",
			workspaceHandle: parent.workspaceId,
			delayMs: 100,
		});

		expect(effects.journalSize()).toBeLessThanOrEqual(SESSION_BROWSER_EFFECT_JOURNAL_LIMIT);
		expect(effects.pendingTimerCount()).toBe(1);
		effects.invalidateIdentity(parent);
		expect(effects.journalSize()).toBe(0);
		expect(effects.pendingTimerCount()).toBe(0);
		expect(timers).toHaveLength(1);
	});
});

function effectFor(identity: SessionBrowserIdentity): SessionBrowserEffect {
	return {
		type: "toast",
		identity,
		dedupeKey: "notice",
		level: "info",
		message: "hello",
	};
}
