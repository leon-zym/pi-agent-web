import { memo, useCallback, useEffect, useState } from "react";
import { tt, useT } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import type { ProductTurn } from "../../types/view-models";

export interface ConversationTocProps {
	turns: readonly ProductTurn[];
	activeTurnId?: string | null;
	hoveredTurnId?: string | null;
	rightMargin?: number;
	wideContent?: boolean;
	className?: string;
	onTurnSelect?: (turnId: string) => void;
}

const MIN_RIGHT_MARGIN = 240;

function hasWideConversationContent(): boolean {
	if (typeof document === "undefined") return false;
	const viewport = document.querySelector<HTMLElement>("[data-chat-viewport]");
	const content = viewport?.querySelector<HTMLElement>("[data-conversation-content]");
	if (!viewport || !content) return false;
	const contentWidth = content.clientWidth;
	return Array.from(
		content.querySelectorAll<HTMLElement>('pre, table, [data-diff-block="true"] .scroll-slim'),
	).some(
		(element) =>
			element.scrollWidth > element.clientWidth + 1 ||
			element.getBoundingClientRect().width > contentWidth + 1,
	);
}

function calculateRightMargin(): number {
	if (typeof window === "undefined") return 300;
	const viewport = document.querySelector("[data-chat-viewport]");
	if (viewport) {
		return (viewport.clientWidth - 748) / 2;
	}
	return (window.innerWidth - 748) / 2;
}

function getTurnPrompt(turn: ProductTurn): string {
	const prompt = turn.userMessages
		.map((message) => message.text.trim())
		.filter(Boolean)
		.join(" ");
	return prompt || tt("turn.sectionAria");
}

/**
 * Conversation TOC Outline Rail (DESIGN.md Section 5.6):
 * - Miniature vertical track on the right of the conversation column
 * - Tick marks for each User Turn
 * - Active turn tracking via IntersectionObserver
 * - 220px preview bubble on hover/keyboard focus
 * - Click smoothly scrolls to the turn
 * - Collision protection: Auto-hides when right margin is < 240px
 */
export const ConversationToc = memo(function ConversationToc({
	turns,
	activeTurnId: controlledActiveTurnId,
	hoveredTurnId: controlledHoveredTurnId,
	rightMargin: controlledRightMargin,
	wideContent: controlledWideContent,
	className,
	onTurnSelect,
}: ConversationTocProps) {
	const { t } = useT();
	void t;
	const [observedActiveTurnId, setObservedActiveTurnId] = useState<string | null>(null);
	const [measuredMargin, setMeasuredMargin] = useState<number>(calculateRightMargin);
	const [measuredWideContent, setMeasuredWideContent] = useState<boolean>(hasWideConversationContent);
	const [internalHoveredTurnId, setInternalHoveredTurnId] = useState<string | null>(null);

	const activeTurnId = controlledActiveTurnId ?? observedActiveTurnId;
	const hoveredTurnId =
		controlledHoveredTurnId !== undefined ? controlledHoveredTurnId : internalHoveredTurnId;
	const rightMargin = controlledRightMargin ?? measuredMargin;
	const wideContent = controlledWideContent ?? measuredWideContent;
	const isVisible = rightMargin >= MIN_RIGHT_MARGIN && !wideContent;

	// Re-measure only the uncontrolled collision inputs.
	useEffect(() => {
		if (controlledRightMargin !== undefined && controlledWideContent !== undefined) return;
		let scheduledFrame: number | null = null;
		const updateMeasurements = () => {
			if (controlledRightMargin === undefined) setMeasuredMargin(calculateRightMargin());
			if (controlledWideContent === undefined) setMeasuredWideContent(hasWideConversationContent());
		};
		const scheduleUpdate = () => {
			if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
			scheduledFrame = requestAnimationFrame(() => {
				scheduledFrame = null;
				updateMeasurements();
			});
		};
		updateMeasurements();
		window.addEventListener("resize", scheduleUpdate);

		const viewport = document.querySelector("[data-chat-viewport]");
		const content = viewport?.querySelector("[data-conversation-content]");
		let resizeObserver: ResizeObserver | null = null;
		if (viewport && typeof ResizeObserver !== "undefined") {
			resizeObserver = new ResizeObserver(scheduleUpdate);
			resizeObserver.observe(viewport);
			if (content) resizeObserver.observe(content);
		}
		const mutationObserver =
			content && typeof MutationObserver !== "undefined" ? new MutationObserver(scheduleUpdate) : null;
		mutationObserver?.observe(content, { childList: true, characterData: true, subtree: true });

		return () => {
			window.removeEventListener("resize", scheduleUpdate);
			if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
			resizeObserver?.disconnect();
			mutationObserver?.disconnect();
		};
	}, [controlledRightMargin, controlledWideContent]);

	// Track active visible turn using IntersectionObserver
	useEffect(() => {
		if (controlledActiveTurnId !== undefined) return;
		if (typeof window === "undefined" || !("IntersectionObserver" in window)) return;

		const elements = document.querySelectorAll<HTMLElement>("[data-turn-id]");
		if (elements.length === 0) return;

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						const turnId = (entry.target as HTMLElement).dataset.turnId;
						if (turnId) {
							setObservedActiveTurnId(turnId);
							break;
						}
					}
				}
			},
			{
				threshold: [0.1, 0.5],
				rootMargin: "-10% 0px -60% 0px",
			},
		);

		const observeMountedTurns = () => {
			observer.disconnect();
			for (const element of document.querySelectorAll<HTMLElement>("[data-turn-id]")) {
				observer.observe(element);
			}
		};
		observeMountedTurns();

		const viewport = document.querySelector("[data-chat-viewport]");
		const mutationObserver =
			viewport && "MutationObserver" in window
				? new MutationObserver((records) => {
						const turnWindowChanged = records.some((record) =>
							[...record.addedNodes, ...record.removedNodes].some(
								(node) =>
									node instanceof Element &&
									(node.matches("[data-turn-id]") || node.querySelector("[data-turn-id]")),
							),
						);
						if (turnWindowChanged) observeMountedTurns();
					})
				: null;
		if (viewport && mutationObserver) {
			mutationObserver.observe(viewport, { childList: true, subtree: true });
		}

		return () => {
			observer.disconnect();
			mutationObserver?.disconnect();
		};
	}, [controlledActiveTurnId, turns.length]);

	const scrollToTurn = useCallback(
		(turnId: string) => {
			if (onTurnSelect) {
				onTurnSelect(turnId);
				return;
			}
			const scroll = () => {
				const el = Array.from(document.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
					(candidate) => candidate.dataset.turnId === turnId,
				);
				if (!el) return;
				const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
				el.scrollIntoView({
					behavior: reduceMotion ? "auto" : "smooth",
					block: "start",
				});
			};
			const isMounted = Array.from(document.querySelectorAll<HTMLElement>("[data-turn-id]")).some(
				(candidate) => candidate.dataset.turnId === turnId,
			);
			if (isMounted) scroll();
			else window.requestAnimationFrame(scroll);
		},
		[onTurnSelect],
	);

	if (turns.length === 0) return null;

	return (
		<nav
			aria-label={tt("toc.title")}
			aria-hidden={!isVisible}
			data-conversation-toc="true"
			data-toc-wide-content={wideContent ? "true" : "false"}
			className={cn(
				"fixed top-20 right-3 z-20 flex flex-col items-center gap-2 py-4 transition-opacity duration-200 select-none",
				!isVisible && "invisible pointer-events-none opacity-0",
				className,
			)}
		>
			<div className="flex max-h-[min(70vh,640px)] flex-col items-center gap-2 overflow-y-auto rounded-full border border-border/60 bg-surface/80 px-1.5 py-3 shadow-lv1">
				{turns.map((turn, index) => {
					const prompt = getTurnPrompt(turn);
					const isActive = turn.id === activeTurnId || (!activeTurnId && index === 0);
					const isHovered = hoveredTurnId === turn.id;
					const statusLabel = turn.status === "running" ? tt("status.running") : tt("common.done");

					return (
						<div key={turn.id} className="group relative flex items-center justify-center">
							<button
								type="button"
								data-toc-tick={turn.id}
								data-toc-active={isActive ? "true" : undefined}
								aria-label={tt("toc.turn", { n: index + 1 })}
								onClick={() => scrollToTurn(turn.id)}
								onMouseEnter={() => setInternalHoveredTurnId(turn.id)}
								onMouseLeave={() => setInternalHoveredTurnId((cur) => (cur === turn.id ? null : cur))}
								onFocus={() => setInternalHoveredTurnId(turn.id)}
								onBlur={() => setInternalHoveredTurnId((cur) => (cur === turn.id ? null : cur))}
								className={cn(
									"h-1.5 rounded-full transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none",
									isActive
										? "w-4 bg-primary shadow-xs"
										: "w-2 bg-border-strong hover:w-3 hover:bg-ink-3 group-focus-visible:w-3 group-focus-visible:bg-ink-3",
								)}
							/>

							{/* 220px Preview Bubble */}
							{isHovered && (
								<div
									data-testid="toc-preview-bubble"
									aria-hidden="true"
									className="pointer-events-none absolute top-1/2 right-full z-30 mr-3 w-[220px] max-w-[220px] -translate-y-1/2 rounded-lg border border-border bg-surface p-2.5 text-xs text-ink shadow-lv2 transition-opacity duration-150"
								>
									<div className="mb-1 flex items-center justify-between font-mono text-[10px] text-ink-3">
										<span className="font-semibold text-primary">{tt("toc.turn", { n: index + 1 })}</span>
										<span className="text-ink-3">{statusLabel}</span>
									</div>
									<p className="line-clamp-3 text-xs leading-relaxed text-ink-2 break-words">{prompt}</p>
								</div>
							)}
						</div>
					);
				})}
			</div>
		</nav>
	);
});
