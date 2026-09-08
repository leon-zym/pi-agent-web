import { describe, expect, it } from "vitest";
import {
	CONVERSATION_TURN_PAGE_SIZE,
	CONVERSATION_TURN_WINDOW_SIZE,
	getInitialTurnWindowStart,
	getPreviousTurnWindowStart,
	getRemotePrependWindowStart,
	getSafeTurnWindowStart,
	getTurnWindowRange,
	revealTurnWindowStart,
} from "../src/features/conversation/turn-window";

describe("conversation turn window", () => {
	it("starts at the newest bounded page", () => {
		expect(getInitialTurnWindowStart(12)).toBe(0);
		expect(getInitialTurnWindowStart(CONVERSATION_TURN_WINDOW_SIZE + 1)).toBe(1);
	});

	it("describes older and newer boundaries without exceeding the turn count", () => {
		expect(getTurnWindowRange(100, 12)).toEqual({
			start: 12,
			end: 12 + CONVERSATION_TURN_WINDOW_SIZE,
			hasOlder: true,
			hasNewer: true,
		});
		expect(getTurnWindowRange(100, 80)).toEqual({
			start: 80,
			end: 100,
			hasOlder: true,
			hasNewer: false,
		});
	});

	it("prepends one page and reveals a requested turn inside the window", () => {
		expect(getPreviousTurnWindowStart(40)).toBe(40 - CONVERSATION_TURN_PAGE_SIZE);
		expect(getPreviousTurnWindowStart(10)).toBe(0);
		expect(revealTurnWindowStart(3, 100)).toBe(0);
		expect(revealTurnWindowStart(50, 100)).toBe(18);
		expect(revealTurnWindowStart(99, 100)).toBe(36);
	});

	it("clamps a saved window when the historical session becomes shorter", () => {
		expect(getSafeTurnWindowStart(80, 100)).toBe(getInitialTurnWindowStart(80));
		expect(getSafeTurnWindowStart(80, -10)).toBe(0);
	});
});

describe("remote prepend window", () => {
	const old = Array.from({ length: 48 }, (_, i) => ({ id: `old-${i}` }));
	const prepend = (count: number) => [
		...Array.from({ length: count }, (_, i) => ({ id: `older-${i}` })),
		...old,
	];

	it.each([12, 64])("retains the original visible turn with a %i-turn page", (count) => {
		const turns = prepend(count);
		const start = getRemotePrependWindowStart(turns, "old-0", 0, "old-0");
		expect(start).not.toBeNull();
		const range = getTurnWindowRange(turns.length, start!);
		expect(turns.slice(range.start, range.end)).toContain(old[0]);
		expect(range.end - range.start).toBeLessThanOrEqual(64);
		expect(range.start).toBe(Math.max(0, count - 24));
	});

	it("keeps a lower visible anchor inside the bound", () => {
		const turns = prepend(64);
		const start = getRemotePrependWindowStart(turns, "old-0", 0, "old-47");
		const range = getTurnWindowRange(turns.length, start!);
		expect(turns.slice(range.start, range.end)).toContain(old[47]);
		expect(range.end - range.start).toBe(64);
	});

	it("does not treat append, replacement, or a missing anchor as prepend completion", () => {
		expect(getRemotePrependWindowStart([...old, { id: "new" }], "old-0", 0, "old-0")).toBeNull();
		expect(getRemotePrependWindowStart([{ id: "replacement" }], "old-0", 0, "old-0")).toBeNull();
		expect(getRemotePrependWindowStart(prepend(64), "old-0", 0, "missing")).toBeNull();
	});
});
