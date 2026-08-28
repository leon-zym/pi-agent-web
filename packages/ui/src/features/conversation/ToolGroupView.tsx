import { ChevronRight, Zap } from "lucide-react";
import { useState } from "react";
import { formatDuration } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import type { ContentBlock, UiToolResult } from "../../types/view-models";
import { ToolCallRow } from "./ToolCallRow";

type ToolCallBlock = Extract<ContentBlock, { type: "tool_call" }>;

export interface ToolGroupViewProps {
	tools: ToolCallBlock[];
	resultsByToolCallId: Map<string, UiToolResult[]>;
	durationMs?: number;
	defaultOpen?: boolean;
}

export function formatToolGroupSummary(
	tools: ToolCallBlock[],
	durationMs?: number,
	hasError?: boolean,
): string {
	const count = tools.length;
	const toolCallsLabel = tt("toolGroup.toolCalls");

	// Breakdown counts per toolName
	const counts = new Map<string, number>();
	for (const tool of tools) {
		counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
	}
	const breakdown = Array.from(counts.entries())
		.map(([name, num]) => `${name} × ${num}`)
		.join(", ");

	const durationText = durationMs !== undefined && durationMs > 0 ? ` · ${formatDuration(durationMs)}` : "";
	const statusLabel = hasError ? tt("toolGroup.error") : tt("toolGroup.done");

	return `⚡ ${count} ${toolCallsLabel} · ${breakdown}${durationText} [${statusLabel}]`;
}

/**
 * Settled ToolGroup Aggregation & Stacked Layout (DESIGN.md Section 5.3):
 * - Aggregates >2 consecutive tool calls in settled steps into a single collapsible row.
 * - Expands into a stacked layout with 1px hairline dividers, rounded-t-md on first item,
 *   rounded-none on middle items, and rounded-b-md on last item.
 */
export function ToolGroupView({
	tools,
	resultsByToolCallId,
	durationMs,
	defaultOpen = false,
}: ToolGroupViewProps) {
	const [expanded, setExpanded] = useState(defaultOpen);

	const hasError = tools.some(
		(tool) =>
			tool.status === "error" || (resultsByToolCallId.get(tool.toolCallId) ?? []).some((r) => r.isError),
	);

	const summaryText = formatToolGroupSummary(tools, durationMs, hasError);

	return (
		<div className="flex min-w-0 max-w-full flex-col gap-1">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded(!expanded)}
				className={cn(
					"group flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40",
				)}
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 text-ink-3 transition-transform duration-200",
						expanded && "rotate-90",
					)}
				/>
				<Zap className="size-3.5 shrink-0 text-primary" />
				<span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink-2">{summaryText}</span>
			</button>

			{expanded && (
				<div className="mt-1 flex flex-col divide-y divide-border rounded-md border border-border bg-surface-2/30">
					{tools.map((tool, index) => {
						const isFirst = index === 0;
						const isLast = index === tools.length - 1;
						const roundingClass =
							isFirst && isLast
								? "rounded-md"
								: isFirst
									? "rounded-t-md rounded-b-none"
									: isLast
										? "rounded-b-md rounded-t-none"
										: "rounded-none";

						const results = resultsByToolCallId.get(tool.toolCallId) ?? [];

						return (
							<ToolCallRow key={tool.key} block={tool} results={results} stacked className={roundingClass} />
						);
					})}
				</div>
			)}
		</div>
	);
}
