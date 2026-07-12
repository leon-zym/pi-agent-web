import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useProjectionStore } from "../../stores/projection";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { EmptyHero } from "./EmptyHero";
import { StatusRowView } from "./StatusRowView";
import { TurnView } from "./TurnView";

const PIN_THRESHOLD = 24;

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

	const currentSessionId = useSessionDirectoryStore((s) => s.currentSession?.id ?? null);
	const projection = useProjectionStore((s) =>
		s.currentSessionId ? s.projections[s.currentSessionId] : undefined,
	);

	const scrollToBottom = (smooth = false) => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
		pinnedRef.current = true;
		setPinned(true);
	};

	// Session switch resets to the bottom.
	useEffect(() => {
		scrollToBottom();
	}, [currentSessionId]);

	// Follow on content growth while pinned (streaming deltas).
	useEffect(() => {
		const content = contentRef.current;
		if (!content) return;
		const observer = new ResizeObserver(() => {
			if (pinnedRef.current) {
				const el = scrollRef.current;
				if (el) el.scrollTop = el.scrollHeight;
			}
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const forceScroll = () => scrollToBottom();
		window.addEventListener("piweb:scroll-bottom", forceScroll);
		return () => window.removeEventListener("piweb:scroll-bottom", forceScroll);
	}, []);

	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		const isPinned = distance <= PIN_THRESHOLD;
		pinnedRef.current = isPinned;
		setPinned(isPinned);
	};

	const isEmpty = !projection || projection.turns.length === 0;

	return (
		<div
			ref={scrollRef}
			onScroll={onScroll}
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
					className="flex size-[34px] items-center justify-center rounded-full border border-border bg-surface text-ink-2 shadow-lv2 hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
					onClick={() => scrollToBottom(true)}
				>
					<ArrowDown className="size-4" />
				</button>
			</div>
		</div>
	);
}
