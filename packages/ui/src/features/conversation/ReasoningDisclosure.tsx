import { Brain, ChevronRight, ExternalLink } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { stripAnsi, tailTeaser } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useProjectionStore } from "../../stores/projection";
import { useViewStore } from "../../stores/view";

export interface ReasoningDisclosureProps {
	text: string;
	status: "streaming" | "settled" | "interrupted";
	isTail: boolean;
	defaultOpen?: boolean;
	blockKey?: string;
	onInspect?: () => void;
}

/**
 * Two-stage in-place thinking disclosure (docs/design.md, Conversation surfaces):
 * - Streaming: 5-line scrollable window (max-h-[110px]), auto-scrolled to bottom,
 *   with 2.6s .thinking-sweep signature motion.
 * - Settled: Collapses into tail teaser summary by default using CSS Grid transition.
 * - In-place expand/collapse: Clicking card toggles full reasoning text inline.
 * - Secondary action: Micro ExternalLink button in upper right to inspect in DetailsPanel.
 */
export function ReasoningDisclosure({
	text,
	status,
	isTail,
	defaultOpen,
	blockKey,
	onInspect,
}: ReasoningDisclosureProps) {
	const displayText = stripAnsi(text);
	const storeOpen = useViewStore((s) =>
		defaultOpen !== undefined
			? defaultOpen
			: blockKey
				? s.expandedThinking[blockKey]
				: s.expandedThinking["thinking:"],
	);
	const [localOpen, setLocalOpen] = useState<boolean | null>(null);
	const expanded = localOpen ?? storeOpen ?? false;
	const scrollRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to bottom on streaming text append
	useEffect(() => {
		if (status === "streaming" && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [displayText, status]);

	const toggle = () => {
		if (localOpen === null) {
			setLocalOpen(!(storeOpen ?? false));
		} else {
			setLocalOpen(!localOpen);
		}
	};

	const handleInspect = (e: MouseEvent) => {
		e.stopPropagation();
		if (onInspect) {
			onInspect();
		} else {
			const view = useViewStore.getState();
			const sessionId = useProjectionStore.getState().currentSessionId;
			view.selectTool(sessionId ?? "", blockKey ?? "thinking");
		}
	};

	const summary = tailTeaser(displayText);
	const isStreaming = status === "streaming";
	const showSweep = isStreaming && isTail && !expanded;

	return (
		<div className="flex min-w-0 max-w-full flex-col">
			<div
				className={cn(
					"group flex min-h-6 items-center gap-1.5 rounded-sm hover:bg-hover [@media(hover:none)]:min-h-10",
					showSweep && "thinking-sweep",
				)}
			>
				<button
					type="button"
					aria-expanded={expanded}
					onClick={toggle}
					className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [@media(hover:none)]:min-h-10"
				>
					<ChevronRight
						className={cn(
							"size-3.5 shrink-0 text-ink-3 transition-transform duration-200",
							expanded && "rotate-90",
						)}
					/>
					<Brain className="size-3.5 shrink-0 text-ink-3" />
					<span className={cn("min-w-0 flex-1 truncate text-[13px] leading-6 text-ink-3 font-mono")}>
						{isStreaming ? tt("status.thinking") : summary || tt("status.thought")}
					</span>
					<span className="shrink-0 pr-1 text-[11px] text-ink-3/70">
						{isStreaming ? tt("status.inProgress") : ""}
					</span>
				</button>
				<button
					type="button"
					aria-label={tt("reasoning.inspectAria")}
					onClick={handleInspect}
					className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-0 transition-opacity hover:bg-hover hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/40 [@media(hover:none)]:size-10 [@media(hover:none)]:opacity-100"
				>
					<ExternalLink className="size-3.5" />
				</button>
			</div>

			{isStreaming && (
				<div
					ref={scrollRef}
					data-testid="thinking-stream-window"
					className="scroll-slim mt-1.5 ml-[22px] max-h-[110px] overflow-y-auto border-l border-border pl-3 font-mono text-xs leading-[20px] whitespace-pre-wrap break-words text-ink-3"
				>
					{displayText}
				</div>
			)}

			{!isStreaming && (
				<div
					className={cn(
						"grid transition-[grid-template-rows] duration-200 ease-out",
						expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
					)}
				>
					<div className="overflow-hidden">
						<div className="mt-1.5 ml-[22px] border-l border-border pl-3">
							<p className="font-mono text-[13px] leading-[22px] whitespace-pre-wrap break-words text-ink-2">
								{displayText}
							</p>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
