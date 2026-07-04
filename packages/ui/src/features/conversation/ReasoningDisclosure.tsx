import { Brain, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { firstLine, lastLine } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useViewStore } from "../../stores/view";

export interface ReasoningDisclosureProps {
	text: string;
	status: "streaming" | "settled" | "interrupted";
	isTail: boolean;
	defaultOpen?: boolean;
}

/**
 * Compact 24px reasoning row (DESIGN.md): streaming shows the newest line
 * with a 2.6s light sweep; settled collapses back to the first-line summary.
 * Pure props only, no socket access.
 */
export function ReasoningDisclosure({ text, status, isTail, defaultOpen }: ReasoningDisclosureProps) {
	const open = useViewStore((s) =>
		defaultOpen !== undefined ? defaultOpen : s.expandedThinking["thinking:"],
	);
	const [localOpen, setLocalOpen] = useState<boolean | null>(null);
	const expanded = localOpen ?? open ?? false;
	const summaryRef = useRef<HTMLSpanElement>(null);

	// While streaming, keep the summary pinned to the newest line.
	useEffect(() => {
		if (status === "streaming" && expanded === false && summaryRef.current) {
			summaryRef.current.scrollLeft = summaryRef.current.scrollWidth;
		}
	}, [text, status, expanded]);

	const toggle = () => {
		if (localOpen === null) {
			setLocalOpen(!(open ?? false));
		} else {
			setLocalOpen(!localOpen);
		}
	};

	const summary = status === "streaming" ? lastLine(text) : firstLine(text);
	const showSweep = status === "streaming" && isTail && !expanded;

	return (
		<div className="flex flex-col">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={toggle}
				className={cn(
					"group flex h-6 items-center gap-1.5 rounded-sm text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40",
					showSweep && "thinking-sweep",
				)}
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 text-ink-3 transition-transform duration-200",
						expanded && "rotate-90",
					)}
				/>
				<Brain className="size-3.5 shrink-0 text-ink-3" />
				<span
					ref={summaryRef}
					className={cn("min-w-0 flex-1 truncate text-[13px] leading-6 text-ink-3", "font-mono")}
				>
					{summary || (status === "streaming" ? "思考中…" : "已思考")}
				</span>
				<span className="pr-1 text-[11px] text-ink-3/70">{status === "streaming" ? "进行中" : ""}</span>
			</button>
			{expanded && (
				<div className="mt-1.5 ml-[22px] border-l border-border pl-3">
					<p className="text-[13px] leading-[22px] whitespace-pre-wrap break-words text-ink-2">{text}</p>
				</div>
			)}
		</div>
	);
}
