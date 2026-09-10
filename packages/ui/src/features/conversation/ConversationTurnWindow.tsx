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
	getRemotePrependWindowStart,
	getSafeTurnWindowStart,
	getTurnWindowRange,
	revealTurnWindowStart,
} from "./turn-window";

// This pre-mount control is eliminated from ordinary production bundles.
const fullHistory =
	import.meta.env.VITE_PI_WEB_BENCHMARK_BUILD === "1" &&
	Reflect.get(globalThis, "__piwebBenchmarkFullHistory") === true;
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
	remoteHistoryHasOlder?: boolean;
	remoteHistoryLoading?: boolean;
	remoteHistoryError?: string | null;
	remoteHistorySnapshotId?: string | null;
	onLoadRemoteOlder?: () => boolean;
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

function findVisibleTurn(container: HTMLDivElement | null): HTMLElement | undefined {
	if (!container) return undefined;
	const viewport = container.getBoundingClientRect();
	return Array.from(container.querySelectorAll<HTMLElement>("[data-turn-id]")).find((candidate) => {
		const rect = candidate.getBoundingClientRect();
		return rect.bottom > viewport.top && rect.top < viewport.bottom;
	});
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
		{
			turns,
			statusRows,
			sessionHandle,
			sessionIdentity,
			remoteHistoryHasOlder = false,
			remoteHistoryLoading = false,
			remoteHistoryError = null,
			remoteHistorySnapshotId = null,
			onLoadRemoteOlder,
			onAttachmentLoadError,
			scrollContainerRef,
		},
		ref,
	) {
		const [start, setStart] = useState(() => getSavedStart(sessionHandle, turns.length));
		const sessionHandleRef = useRef<string | null>(sessionHandle ?? null);
		const scheduledFramesRef = useRef(new Set<number>());
		const startRef = useRef(start);
		const turnsRef = useRef(turns);
		const previousTurnCountRef = useRef(turns.length);
		const mountedRef = useRef(false);
		const remotePrependRef = useRef<{
			identity: typeof sessionIdentity;
			snapshotId: typeof remoteHistorySnapshotId;
			firstTurnId: string;
			start: number;
			anchorId: string;
			anchorTop: number;
		} | null>(null);
		const olderButtonRef = useRef<HTMLButtonElement | null>(null);
		const removedFocusedButtonRef = useRef(false);
		const setOlderButton = useCallback((button: HTMLButtonElement | null) => {
			if (!button && olderButtonRef.current === document.activeElement) {
				removedFocusedButtonRef.current = true;
			}
			olderButtonRef.current = button;
		}, []);
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

		const remote = remotePrependRef.current;
		const ownsRemote =
			remote &&
			remote.identity === sessionIdentity &&
			remote.snapshotId === remoteHistorySnapshotId &&
			!remoteHistoryError;
		const remoteStart = ownsRemote
			? getRemotePrependWindowStart(turns, remote.firstTurnId, remote.start, remote.anchorId)
			: null;
		// Select the corrected slice before commit, so the stable keyed anchor never unmounts.
		const renderedStart = remoteStart ?? start;
		const range = useMemo(
			() =>
				fullHistory
					? { start: 0, end: turns.length, hasOlder: false, hasNewer: false }
					: getTurnWindowRange(turns.length, renderedStart),
			[turns.length, renderedStart],
		);

		useLayoutEffect(() => {
			if (remoteStart !== null && remote) {
				pendingPrependRef.current = {
					nextStart: remoteStart,
					scrollTop: scrollContainerRef.current?.scrollTop ?? 0,
					anchorId: remote.anchorId,
					anchorTop: remote.anchorTop,
				};
				startRef.current = remoteStart;
				setStart(remoteStart);
			}
			if (!ownsRemote || remoteStart !== null || !remoteHistoryLoading) {
				remotePrependRef.current = null;
			}
		}, [ownsRemote, remote, remoteStart, remoteHistoryLoading, scrollContainerRef]);

		useEffect(() => {
			const previousCount = previousTurnCountRef.current;
			previousTurnCountRef.current = turns.length;
			if (remoteStart !== null) return;
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
				const wasAtLatest = current >= getInitialTurnWindowStart(previousCount);
				if (turns.length > previousCount && (wasAtLatest || followsLatest)) {
					return getInitialTurnWindowStart(turns.length);
				}
				return getSafeTurnWindowStart(turns.length, current);
			});
		}, [remoteStart, scrollContainerRef, turns.length]);

		useLayoutEffect(() => {
			if (sessionHandle) rememberWindowStart(sessionHandle, renderedStart);
			const pending = pendingPrependRef.current;
			if (!pending || pending.nextStart !== renderedStart) return;
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
		}, [scrollContainerRef, sessionHandle, renderedStart, turns]);

		useLayoutEffect(() => {
			if (!removedFocusedButtonRef.current) return;
			removedFocusedButtonRef.current = false;
			// The final older control yields to the adjacent conversation, only if it still owned focus.
			if (document.activeElement === document.body) {
				scrollContainerRef.current?.focus({ preventScroll: true });
			}
		});

		useLayoutEffect(() => {
			const frame = window.requestAnimationFrame(() => {
				mountedRef.current = true;
			});
			return () => window.cancelAnimationFrame(frame);
		}, []);

		const loadOlder = useCallback(() => {
			const currentStart = startRef.current;
			const currentRange = fullHistory
				? { hasOlder: false }
				: getTurnWindowRange(turnsRef.current.length, currentStart);
			if (remotePrependRef.current || (!currentRange.hasOlder && remoteHistoryLoading)) return;
			const container = scrollContainerRef.current;
			const anchor = findVisibleTurn(container);
			if (!currentRange.hasOlder) {
				if (!remoteHistoryHasOlder || !onLoadRemoteOlder) return;
				const firstTurnId = turnsRef.current[0]?.id;
				if (anchor?.dataset.turnId && firstTurnId) {
					remotePrependRef.current = {
						identity: sessionIdentity,
						snapshotId: remoteHistorySnapshotId,
						firstTurnId,
						start: currentStart,
						anchorId: anchor.dataset.turnId,
						anchorTop: anchor.getBoundingClientRect().top,
					};
				}
				if (!onLoadRemoteOlder()) remotePrependRef.current = null;
				return;
			}
			const nextStart = getPreviousTurnWindowStart(currentStart, CONVERSATION_TURN_PAGE_SIZE);
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
		}, [
			onLoadRemoteOlder,
			remoteHistoryHasOlder,
			remoteHistoryLoading,
			remoteHistorySnapshotId,
			sessionIdentity,
			scrollContainerRef,
		]);

		const scrollToLatest = useCallback(() => {
			remotePrependRef.current = null;
			pendingPrependRef.current = null;
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
			remotePrependRef.current = null;
			pendingPrependRef.current = null;
			const currentStart = startRef.current;
			const currentRange = fullHistory
				? { hasNewer: false }
				: getTurnWindowRange(turnsRef.current.length, currentStart);
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
				remotePrependRef.current = null;
				pendingPrependRef.current = null;
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
				const pending = remotePrependRef.current;
				if (pending) {
					const anchor = findVisibleTurn(container);
					if (anchor?.dataset.turnId) {
						pending.anchorId = anchor.dataset.turnId;
						pending.anchorTop = anchor.getBoundingClientRect().top;
					}
				}
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
				{(range.hasOlder || remoteHistoryHasOlder) && (
					<div className="flex flex-col items-center gap-1">
						<button
							type="button"
							data-load-older-turns="true"
							ref={setOlderButton}
							onClick={loadOlder}
							aria-disabled={remoteHistoryLoading && !range.hasOlder}
							aria-busy={remoteHistoryLoading && !range.hasOlder}
							className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-ink-2 shadow-lv1 hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
						>
							{range.hasOlder
								? tt("chatViewport.loadOlder")
								: remoteHistoryLoading
									? tt("chatViewport.loadingOlder")
									: remoteHistoryError
										? tt("chatViewport.retryOlder")
										: tt("chatViewport.loadOlder")}
						</button>
						{!range.hasOlder && remoteHistoryError && (
							<span role="status" className="text-[11px] text-danger">
								{remoteHistoryError}
							</span>
						)}
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
