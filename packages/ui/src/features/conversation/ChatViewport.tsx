import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "../../components/ui/skeleton";
import { tt } from "../../lib/i18n";
import { reportAuthoritativeAttachmentFailure } from "../../lib/session-attachment";
import { cn } from "../../lib/utils";
import { useProjectionStore } from "../../stores/projection";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { sessionTransport, useSessionTransportStore } from "../../stores/session-transport";
import { ConversationToc } from "./ConversationToc";
import { EmptyHero } from "./EmptyHero";
import { SessionRecoveryNotice } from "./SessionRecoveryNotice";
import { StatusRowView } from "./StatusRowView";
import { TurnView } from "./TurnView";
import { createSessionRuntimeIdentity } from "./use-lazy-tool-content";

const PIN_THRESHOLD = 24;
const SAVED_SESSION_SCROLL_LIMIT = 32;

interface SavedSessionScroll {
	scrollTop: number;
	pinned: boolean;
	anchor?: { turnId: string; offset: number };
}

const savedSessionScroll = new Map<string, SavedSessionScroll>();

function ConversationLoadingSkeleton() {
	return (
		<div
			data-conversation-loading="true"
			role="status"
			aria-label={tt("common.loading")}
			className="flex flex-1 flex-col gap-8 pt-6"
		>
			<div className="flex justify-end">
				<div className="w-[min(78%,32rem)] rounded-xl border border-border/70 bg-surface/70 p-4">
					<Skeleton className="h-3 w-11/12 rounded-full" />
					<Skeleton className="mt-3 h-3 w-3/5 rounded-full" />
				</div>
			</div>
			<div className="flex gap-3">
				<Skeleton className="size-7 shrink-0 rounded-full" />
				<div className="min-w-0 flex-1 space-y-3 pt-1">
					<Skeleton className="h-3 w-4/5 rounded-full" />
					<Skeleton className="h-3 w-full rounded-full" />
					<Skeleton className="h-3 w-2/3 rounded-full" />
				</div>
			</div>
			<div className="flex gap-3 opacity-60">
				<Skeleton className="size-7 shrink-0 rounded-full" />
				<div className="min-w-0 flex-1 space-y-3 pt-1">
					<Skeleton className="h-3 w-3/4 rounded-full" />
					<Skeleton className="h-3 w-1/2 rounded-full" />
				</div>
			</div>
			<span className="sr-only">{tt("common.loading")}</span>
		</div>
	);
}

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
	const sessionHandle = currentSessionId;
	const runtime = useSessionTransportStore((state) =>
		sessionHandle ? state.sessions[sessionHandle]?.runtime : null,
	);
	const sessionIdentity = useMemo(
		() => createSessionRuntimeIdentity(runtime, sessionHandle),
		[runtime?.generation, runtime?.serverEpoch, runtime?.sessionHandle, runtime?.workspaceId, sessionHandle],
	);
	const projection = useProjectionStore((s) =>
		currentSessionId ? s.projections[currentSessionId] : undefined,
	);
	const creatingSession = useSessionDirectoryStore((state) => state.sessionCreation !== null);
	const recovery = useSessionTransportStore((state) =>
		currentSessionId ? state.sessions[currentSessionId]?.recovery : null,
	);
	const manualRetryResync = useSessionTransportStore((state) => state.manualRetryResync);
	const reportAttachmentLoadError = useCallback(() => {
		if (currentSessionId === null) return;
		reportAuthoritativeAttachmentFailure(
			currentSessionId,
			sessionTransport.store.getState().sessions[currentSessionId],
			sessionTransport.reportProjectionFailure,
		);
	}, [currentSessionId]);

	const scrollToBottom = useCallback(
		(smooth = false) => {
			const el = scrollRef.current;
			if (!el) return;
			const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
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

	const isLoading = creatingSession || (currentSessionId !== null && projection === undefined);
	const isEmpty = !projection || projection.turns.length === 0;

	return (
		<div
			ref={scrollRef}
			onScroll={onScroll}
			data-chat-viewport="true"
			className="scroll-slim h-full overflow-x-hidden overflow-y-auto overscroll-contain"
		>
			<div
				ref={contentRef}
				className="mx-auto flex min-h-full min-w-0 w-full max-w-[748px] flex-col px-6 py-6"
			>
				{recovery && (
					<div className="mb-4 shrink-0">
						<SessionRecoveryNotice
							state={recovery}
							onRetry={() => {
								if (currentSessionId) manualRetryResync(currentSessionId);
							}}
						/>
					</div>
				)}
				{isLoading ? (
					<ConversationLoadingSkeleton />
				) : isEmpty ? (
					<EmptyHero />
				) : (
					<div className="flex min-w-0 max-w-full flex-col gap-6">
						{projection.turns.map((turn) => (
							<TurnView
								key={turn.id}
								turn={turn}
								sessionHandle={sessionHandle}
								sessionIdentity={sessionIdentity}
								onAttachmentLoadError={reportAttachmentLoadError}
							/>
						))}
						{projection.statusRows.map((row) => (
							<StatusRowView key={row.key} row={row} />
						))}
					</div>
				)}
			</div>

			<ConversationToc turns={projection?.turns ?? []} />

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
