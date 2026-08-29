import type { SessionImageContentDto, SessionRuntimeIdentityDto } from "@pi-agent-web/protocol";
import {
	forwardRef,
	memo,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { tt } from "../../lib/i18n";
import type { ProductTurn, StatusRow } from "../../types/view-models";
import { StatusRowView } from "./StatusRowView";
import { TurnView } from "./TurnView";
import {
	CONVERSATION_TURN_PAGE_SIZE,
	getInitialTurnWindowStart,
	getPreviousTurnWindowStart,
	getSafeTurnWindowStart,
	getTurnWindowRange,
	revealTurnWindowStart,
} from "./turn-window";

const TURN_LOAD_THRESHOLD = 96;
const TURN_SCROLL_THRESHOLD = 24;
const SAVED_WINDOW_START_LIMIT = 32;

const savedWindowStarts = new Map<string, number>();

export interface ConversationTurnWindowHandle {
	revealTurn: (turnId: string) => void;
	scrollToLatest: () => void;
}

interface ConversationTurnWindowProps {
	turns: readonly ProductTurn[];
	statusRows: readonly StatusRow[];
	sessionHandle?: string | null;
	sessionIdentity?: SessionRuntimeIdentityDto | null;
	onAttachmentLoadError?: (image: SessionImageContentDto) => void;
	scrollContainerRef: RefObject<HTMLDivElement | null>;
}

function getSavedStart(sessionHandle: string | null | undefined, totalTurns: number): number {
	if (!sessionHandle) return getInitialTurnWindowStart(totalTurns);
	const saved = savedWindowStarts.get(sessionHandle);
	return saved === undefined
		? getInitialTurnWindowStart(totalTurns)
		: getSafeTurnWindowStart(totalTurns, saved);
}

function rememberWindowStart(sessionHandle: string, start: number): void {
	savedWindowStarts.delete(sessionHandle);
	savedWindowStarts.set(sessionHandle, start);
	while (savedWindowStarts.size > SAVED_WINDOW_START_LIMIT) {
		const oldest = savedWindowStarts.keys().next().value;
		if (oldest === undefined) break;
		savedWindowStarts.delete(oldest);
	}
}

function scrollToTurnElement(container: HTMLDivElement | null, turnId: string): void {
	if (!container) return;
	const element = Array.from(container.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
		(candidate) => candidate.dataset.turnId === turnId,
	);
	if (!element) return;
	const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
	element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

export const ConversationTurnWindow = memo(
	forwardRef<ConversationTurnWindowHandle, ConversationTurnWindowProps>(function ConversationTurnWindow(
		{ turns, statusRows, sessionHandle, sessionIdentity, onAttachmentLoadError, scrollContainerRef },
		ref,
	) {
		const [start, setStart] = useState(() => getSavedStart(sessionHandle, turns.length));
		const sessionHandleRef = useRef<string | null>(sessionHandle ?? null);
		const scheduledFramesRef = useRef(new Set<number>());
		const startRef = useRef(start);
		const turnsRef = useRef(turns);
		const previousTurnCountRef = useRef(turns.length);
		const mountedRef = useRef(false);
		const pendingPrependRef = useRef<{
			nextStart: number;
			scrollTop: number;
			anchorId?: string;
			anchorTop?: number;
		} | null>(null);

		startRef.current = start;
		turnsRef.current = turns;
		sessionHandleRef.current = sessionHandle ?? null;

		const scheduleAfterCommit = useCallback(
			(callback: () => void) => {
				if (typeof window === "undefined") return;
				const expectedSessionHandle = sessionHandle ?? null;
				let frame = 0;
				frame = window.requestAnimationFrame(() => {
					scheduledFramesRef.current.delete(frame);
					if (sessionHandleRef.current !== expectedSessionHandle) return;
					callback();
				});
				scheduledFramesRef.current.add(frame);
			},
			[sessionHandle],
		);

		useLayoutEffect(() => {
			return () => {
				for (const frame of scheduledFramesRef.current) window.cancelAnimationFrame(frame);
				scheduledFramesRef.current.clear();
			};
		}, []);

		const range = useMemo(() => getTurnWindowRange(turns.length, start), [turns.length, start]);

		useEffect(() => {
			const previousCount = previousTurnCountRef.current;
			previousTurnCountRef.current = turns.length;
			if (turns.length === 0) {
				setStart(0);
				return;
			}

			const container = scrollContainerRef.current;
			const distanceFromBottom = container
				? container.scrollHeight - container.scrollTop - container.clientHeight
				: 0;
			const followsLatest = distanceFromBottom <= TURN_SCROLL_THRESHOLD;
			setStart((current) => {
				if (previousCount === 0) return getInitialTurnWindowStart(turns.length);
				if (turns.length > previousCount && followsLatest) {
					return getInitialTurnWindowStart(turns.length);
				}
				return getSafeTurnWindowStart(turns.length, current);
			});
		}, [scrollContainerRef, turns.length]);

		useLayoutEffect(() => {
			if (sessionHandle) rememberWindowStart(sessionHandle, start);
			const pending = pendingPrependRef.current;
			if (!pending || pending.nextStart !== start) return;
			const container = scrollContainerRef.current;
			if (container) {
				const anchor = pending.anchorId
					? Array.from(container.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
							(candidate) => candidate.dataset.turnId === pending.anchorId,
						)
					: null;
				if (anchor && pending.anchorTop !== undefined) {
					container.scrollTop += anchor.getBoundingClientRect().top - pending.anchorTop;
				} else {
					container.scrollTop = pending.scrollTop;
				}
			}
			pendingPrependRef.current = null;
		}, [scrollContainerRef, sessionHandle, start]);

		useLayoutEffect(() => {
			const frame = window.requestAnimationFrame(() => {
				mountedRef.current = true;
			});
			return () => window.cancelAnimationFrame(frame);
		}, []);

		const loadOlder = useCallback(() => {
			const currentStart = startRef.current;
			const currentRange = getTurnWindowRange(turnsRef.current.length, currentStart);
			if (!currentRange.hasOlder) return;
			const nextStart = getPreviousTurnWindowStart(currentStart, CONVERSATION_TURN_PAGE_SIZE);
			const container = scrollContainerRef.current;
			const viewportTop = container?.getBoundingClientRect().top ?? 0;
			const anchor = container
				? Array.from(container.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
						(candidate) => candidate.getBoundingClientRect().bottom > viewportTop,
					)
				: undefined;
			pendingPrependRef.current = {
				nextStart,
				scrollTop: container?.scrollTop ?? 0,
				...(anchor?.dataset.turnId
					? {
							anchorId: anchor.dataset.turnId,
							anchorTop: anchor.getBoundingClientRect().top,
						}
					: {}),
			};
			setStart(nextStart);
		}, [scrollContainerRef]);

		const scrollToLatest = useCallback(() => {
			const nextStart = getInitialTurnWindowStart(turnsRef.current.length);
			setStart(nextStart);
			const container = scrollContainerRef.current;
			if (container) container.scrollTop = container.scrollHeight;
			scheduleAfterCommit(() => {
				const nextContainer = scrollContainerRef.current;
				if (nextContainer) nextContainer.scrollTop = nextContainer.scrollHeight;
			});
		}, [scheduleAfterCommit, scrollContainerRef]);

		const loadNewer = useCallback(() => {
			const currentStart = startRef.current;
			const currentRange = getTurnWindowRange(turnsRef.current.length, currentStart);
			if (!currentRange.hasNewer) return;
			const maxStart = getInitialTurnWindowStart(turnsRef.current.length);
			setStart(Math.min(maxStart, currentStart + CONVERSATION_TURN_PAGE_SIZE));
			scheduleAfterCommit(() => {
				const container = scrollContainerRef.current;
				if (container) container.scrollTop = container.scrollHeight;
			});
		}, [scheduleAfterCommit, scrollContainerRef]);

		const revealTurn = useCallback(
			(turnId: string) => {
				const index = turnsRef.current.findIndex((turn) => turn.id === turnId);
				if (index < 0) return;
				const nextStart = revealTurnWindowStart(index, turnsRef.current.length);
				setStart(nextStart);
				scheduleAfterCommit(() => scrollToTurnElement(scrollContainerRef.current, turnId));
			},
			[scheduleAfterCommit, scrollContainerRef],
		);

		useImperativeHandle(ref, () => ({ revealTurn, scrollToLatest }), [revealTurn, scrollToLatest]);

		useEffect(() => {
			const container = scrollContainerRef.current;
			if (!container) return;
			const onScroll = () => {
				if (!mountedRef.current) return;
				const currentRange = getTurnWindowRange(turnsRef.current.length, startRef.current);
				if (container.scrollTop <= TURN_LOAD_THRESHOLD) {
					loadOlder();
					return;
				}
				const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
				if (distanceFromBottom <= TURN_LOAD_THRESHOLD && currentRange.hasNewer) loadNewer();
			};
			container.addEventListener("scroll", onScroll, { passive: true });
			return () => container.removeEventListener("scroll", onScroll);
		}, [loadNewer, loadOlder, scrollContainerRef]);

		return (
			<div
				data-turn-window="true"
				data-turn-window-start={range.start}
				data-turn-window-end={range.end}
				data-turn-window-total={turns.length}
				className="flex min-w-0 max-w-full flex-col gap-6"
			>
				{range.hasOlder && (
					<div className="flex flex-col items-center gap-1">
						<button
							type="button"
							data-load-older-turns="true"
							onClick={loadOlder}
							className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-ink-2 shadow-lv1 hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
						>
							{tt("chatViewport.loadOlder")}
						</button>
						<span className="text-[11px] text-ink-3">
							{tt("chatViewport.historyWindow", { loaded: range.end - range.start, total: turns.length })}
						</span>
					</div>
				)}

				{turns.slice(range.start, range.end).map((turn) => (
					<TurnView
						key={turn.id}
						turn={turn}
						sessionHandle={sessionHandle}
						sessionIdentity={sessionIdentity}
						onAttachmentLoadError={onAttachmentLoadError}
					/>
				))}

				{range.hasNewer && (
					<button
						type="button"
						data-load-newer-turns="true"
						onClick={loadNewer}
						className="self-center rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-ink-2 shadow-lv1 hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
					>
						{tt("chatViewport.loadNewer")}
					</button>
				)}

				{!range.hasNewer && statusRows.map((row) => <StatusRowView key={row.key} row={row} />)}
			</div>
		);
	}),
);
