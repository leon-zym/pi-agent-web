import { memo, useCallback, useEffect, useState } from "react";
import { tt, useT } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import type { ProductTurn } from "../../types/view-models";

export interface ConversationTocProps {
	turns: readonly ProductTurn[];
	activeTurnId?: string | null;
	hoveredTurnId?: string | null;
	rightMargin?: number;
	className?: string;
}

const MIN_RIGHT_MARGIN = 240;

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
	className,
}: ConversationTocProps) {
	const { t } = useT();
	void t;
	const [observedActiveTurnId, setObservedActiveTurnId] = useState<string | null>(null);
	const [measuredMargin, setMeasuredMargin] = useState<number>(calculateRightMargin);
	const [internalHoveredTurnId, setInternalHoveredTurnId] = useState<string | null>(null);

	const activeTurnId = controlledActiveTurnId ?? observedActiveTurnId;
	const hoveredTurnId =
		controlledHoveredTurnId !== undefined ? controlledHoveredTurnId : internalHoveredTurnId;
	const rightMargin = controlledRightMargin ?? measuredMargin;
	const isVisible = rightMargin >= MIN_RIGHT_MARGIN;

	// Monitor right margin on window resize / viewport resize if not explicitly controlled
	useEffect(() => {
		if (controlledRightMargin !== undefined) return;
		const updateMargin = () => {
			setMeasuredMargin(calculateRightMargin());
		};
		updateMargin();
		window.addEventListener("resize", updateMargin);

		const viewport = document.querySelector("[data-chat-viewport]");
		let resizeObserver: ResizeObserver | null = null;
		if (viewport && typeof ResizeObserver !== "undefined") {
			resizeObserver = new ResizeObserver(updateMargin);
			resizeObserver.observe(viewport);
		}

		return () => {
			window.removeEventListener("resize", updateMargin);
			resizeObserver?.disconnect();
		};
	}, [controlledRightMargin]);

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

		for (const el of elements) {
			observer.observe(el);
		}

		return () => observer.disconnect();
	}, [controlledActiveTurnId, turns]);

	const scrollToTurn = useCallback((turnId: string) => {
		const el = document.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
		if (el) {
			const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
			el.scrollIntoView({
				behavior: reduceMotion ? "auto" : "smooth",
				block: "start",
			});
		}
	}, []);

	if (turns.length === 0) return null;

	return (
		<nav
			aria-label={tt("toc.title")}
			data-conversation-toc="true"
			className={cn(
				"fixed top-20 right-3 z-20 flex flex-col items-center gap-2 py-4 transition-opacity duration-200 select-none",
				!isVisible && "pointer-events-none opacity-0",
				className,
			)}
		>
			<div className="flex flex-col items-center gap-2 rounded-full border border-border/60 bg-surface/80 px-1.5 py-3 shadow-lv1">
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
