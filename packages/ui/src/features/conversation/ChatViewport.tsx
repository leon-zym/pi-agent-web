import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useProjectionStore } from "../../stores/projection";
import { EmptyHero } from "./EmptyHero";
import { StatusRowView } from "./StatusRowView";
import { TurnView } from "./TurnView";

const PIN_THRESHOLD = 24;
const SAVED_SESSION_SCROLL_LIMIT = 32;

interface SavedSessionScroll {
	scrollTop: number;
	pinned: boolean;
	anchor?: { turnId: string; offset: number };
}

const savedSessionScroll = new Map<string, SavedSessionScroll>();

function rememberSessionScroll(sessionHandle: string, value: SavedSessionScroll): void {
	savedSessionScroll.delete(sessionHandle);
	savedSessionScroll.set(sessionHandle, value);
	while (savedSessionScroll.size > SAVED_SESSION_SCROLL_LIMIT) {
		const oldest = savedSessionScroll.keys().next().value;
		if (oldest === undefined) break;
		savedSessionScroll.delete(oldest);
	}
}

function captureSessionScroll(element: HTMLDivElement, pinned: boolean): SavedSessionScroll {
	if (pinned) return { scrollTop: element.scrollTop, pinned: true };
	const viewportTop = element.getBoundingClientRect().top;
	const anchor = Array.from(element.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
		(candidate) => candidate.getBoundingClientRect().bottom > viewportTop,
	);
	return {
		scrollTop: element.scrollTop,
		pinned: false,
		...(anchor?.dataset.turnId
			? {
					anchor: {
						turnId: anchor.dataset.turnId,
						offset: anchor.getBoundingClientRect().top - viewportTop,
					},
				}
			: {}),
	};
}

function restoreSessionScroll(element: HTMLDivElement, saved: SavedSessionScroll): void {
	if (saved.pinned) {
		element.scrollTop = element.scrollHeight;
		return;
	}
	element.scrollTop = Math.min(saved.scrollTop, Math.max(0, element.scrollHeight - element.clientHeight));
	if (!saved.anchor) return;
	const anchor = Array.from(element.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
		(candidate) => candidate.dataset.turnId === saved.anchor?.turnId,
	);
	if (!anchor) return;
	const currentOffset = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top;
	element.scrollTop += currentOffset - saved.anchor.offset;
}

/**
 * Scroll container with pinned-follow semantics (DESIGN.md): follow only
 * while within 24px of the bottom; reading up pauses follow; a floating
 * button returns to the newest message.
 */
export function ChatViewport() {
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const pinnedRef = useRef(true);
	const [pinned, setPinned] = useState(true);

	const currentSessionId = useProjectionStore((s) => s.currentSessionId);
	const projection = useProjectionStore((s) =>
		currentSessionId ? s.projections[currentSessionId] : undefined,
	);

	const scrollToBottom = useCallback(
		(smooth = false) => {
			const el = scrollRef.current;
			if (!el) return;
			const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduceMotion ? "smooth" : "auto" });
			pinnedRef.current = true;
			setPinned(true);
			if (currentSessionId) {
				rememberSessionScroll(currentSessionId, { scrollTop: el.scrollTop, pinned: true });
			}
		},
		[currentSessionId],
	);

	// Preserve each Session's reading position. Appended background content does
	// not disturb an unpinned reader; a Session that was at the bottom resumes at
	// its newest content.
	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (!element || !currentSessionId) return;
		const saved = savedSessionScroll.get(currentSessionId);
		const nextPinned = saved?.pinned ?? true;
		restoreSessionScroll(element, saved ?? { scrollTop: 0, pinned: true });
		pinnedRef.current = nextPinned;
		setPinned(nextPinned);
	}, [currentSessionId]);

	// Follow on content growth while pinned (streaming deltas).
	useEffect(() => {
		const content = contentRef.current;
		if (!content) return;
		const observer = new ResizeObserver(() => {
			const el = scrollRef.current;
			if (!el) return;
			if (pinnedRef.current) {
				el.scrollTop = el.scrollHeight;
				if (currentSessionId) {
					rememberSessionScroll(currentSessionId, { scrollTop: el.scrollTop, pinned: true });
				}
			} else if (currentSessionId) {
				const saved = savedSessionScroll.get(currentSessionId);
				if (saved) restoreSessionScroll(el, saved);
			}
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, [currentSessionId]);

	useEffect(() => {
		const forceScroll = () => scrollToBottom();
		window.addEventListener("piweb:scroll-bottom", forceScroll);
		return () => window.removeEventListener("piweb:scroll-bottom", forceScroll);
	}, [scrollToBottom]);

	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		const isPinned = distance <= PIN_THRESHOLD;
		pinnedRef.current = isPinned;
		setPinned(isPinned);
		if (currentSessionId) {
			rememberSessionScroll(currentSessionId, captureSessionScroll(el, isPinned));
		}
	};

	const isEmpty = !projection || projection.turns.length === 0;

	return (
		<div
			ref={scrollRef}
			onScroll={onScroll}
			data-chat-viewport="true"
			className="scroll-slim h-full overflow-y-auto overscroll-contain"
		>
			<div ref={contentRef} className="mx-auto flex min-h-full w-full max-w-[748px] flex-col px-6 py-6">
				{isEmpty ? (
					<EmptyHero />
				) : (
					<div className="flex flex-col gap-6">
						{projection.turns.map((turn) => (
							<TurnView key={turn.id} turn={turn} />
						))}
						{projection.statusRows.map((row) => (
							<StatusRowView key={row.key} row={row} />
						))}
					</div>
				)}
			</div>

			{/* Bottom fade into the composer area. */}
			<div className="pointer-events-none sticky bottom-0 -mt-10 h-10 bg-gradient-to-t from-base to-transparent" />

			{/* Floating return-to-bottom button above the composer. */}
			<div
				className={cn(
					"sticky bottom-3 z-10 flex justify-center transition-opacity duration-200",
					pinned ? "pointer-events-none opacity-0" : "opacity-100",
				)}
			>
				<button
					type="button"
					aria-label={tt("chatViewport.backToBottom")}
					className="flex size-10 items-center justify-center rounded-full border border-border bg-surface text-ink-2 shadow-lv2 hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
					onClick={() => scrollToBottom(true)}
				>
					<ArrowDown className="size-4" />
				</button>
			</div>
		</div>
	);
}
