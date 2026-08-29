import { describe, expect, it } from "vitest";
import {
	CONVERSATION_TURN_PAGE_SIZE,
	CONVERSATION_TURN_WINDOW_SIZE,
	getInitialTurnWindowStart,
	getPreviousTurnWindowStart,
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
