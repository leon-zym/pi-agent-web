export const CONVERSATION_TURN_WINDOW_SIZE = 64;
export const CONVERSATION_TURN_PAGE_SIZE = 24;

export interface TurnWindowRange {
	start: number;
	end: number;
	hasOlder: boolean;
	hasNewer: boolean;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function getInitialTurnWindowStart(
	totalTurns: number,
	windowSize = CONVERSATION_TURN_WINDOW_SIZE,
): number {
	return Math.max(0, totalTurns - windowSize);
}

export function getSafeTurnWindowStart(
	totalTurns: number,
	requestedStart: number,
	windowSize = CONVERSATION_TURN_WINDOW_SIZE,
): number {
	return clamp(requestedStart, 0, getInitialTurnWindowStart(Math.max(0, totalTurns), windowSize));
}

export function getTurnWindowRange(
	totalTurns: number,
	start: number,
	windowSize = CONVERSATION_TURN_WINDOW_SIZE,
): TurnWindowRange {
	const safeTotal = Math.max(0, totalTurns);
	const safeStart = clamp(start, 0, safeTotal);
	const safeWindowSize = Math.max(1, windowSize);
	const end = Math.min(safeTotal, safeStart + safeWindowSize);
	return {
		start: safeStart,
		end,
		hasOlder: safeStart > 0,
		hasNewer: end < safeTotal,
	};
}

export function getPreviousTurnWindowStart(start: number, pageSize = CONVERSATION_TURN_PAGE_SIZE): number {
	return Math.max(0, start - Math.max(1, pageSize));
}

export function revealTurnWindowStart(
	turnIndex: number,
	totalTurns: number,
	windowSize = CONVERSATION_TURN_WINDOW_SIZE,
): number {
	const safeTotal = Math.max(0, totalTurns);
	const safeWindowSize = Math.max(1, windowSize);
	const safeIndex = clamp(turnIndex, 0, Math.max(0, safeTotal - 1));
	const maxStart = Math.max(0, safeTotal - safeWindowSize);
	return clamp(safeIndex - Math.floor(safeWindowSize / 2), 0, maxStart);
}
