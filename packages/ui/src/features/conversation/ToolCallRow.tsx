import { Check, ChevronRight, CircleAlert, ExternalLink, Loader2, SkipForward, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { stripAnsi } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useProjectionStore } from "../../stores/projection";
import { useViewStore } from "../../stores/view";
import type { ContentBlock, UiToolResult } from "../../types/view-models";
import { formatToolArguments } from "./code-display";
import { HighlightedCode } from "./HighlightedCode";
import { getToolPresenter, toolDiffStats, toolOutputText } from "./tool-presenters";

type ToolCallBlock = Extract<ContentBlock, { type: "tool_call" }>;

const STATUS_ICON: Record<
	ToolCallBlock["status"],
	{ icon: typeof Wrench; className: string; label: string }
> = {
	preparing: { icon: Loader2, className: "text-ink-3 animate-spin", label: "status.preparing" },
	running: { icon: Loader2, className: "text-primary animate-spin", label: "status.executing" },
	done: { icon: Check, className: "text-success", label: "common.done" },
	error: { icon: CircleAlert, className: "text-danger", label: "common.error" },
	skipped: { icon: SkipForward, className: "text-ink-3", label: "status.skipped" },
};

const MAX_TOOL_SUMMARY_CHARACTERS = 320;

function boundedToolSummary(summary: string): string {
	const sample = summary.slice(0, MAX_TOOL_SUMMARY_CHARACTERS * 4);
	const clean = stripAnsi(sample);
	const truncated = summary.length > sample.length || clean.length > MAX_TOOL_SUMMARY_CHARACTERS;
	return `${clean.slice(0, MAX_TOOL_SUMMARY_CHARACTERS)}${truncated ? "…" : ""}`;
}

function GenericToolBody({ context }: { context: ReturnType<typeof toolContext> }) {
	const { block, results } = context;
	const isError = block.status === "error" || results.some((result) => result.isError);
	const args = useMemo(() => formatToolArguments(block.args, block.argsText), [block.args, block.argsText]);
	const output = useMemo(() => toolOutputText({ block, results }), [block, results]);
	const displayOutput = output || (isError ? tt("tool.executionError") : "");

	return (
		<>
			<HighlightedCode code={args.code} language={args.language} className="max-h-[260px]" />
			{block.toolName !== "bash" && displayOutput && (
				<div
					className={cn(
						"scroll-slim max-h-[260px] overflow-y-auto rounded-sm bg-surface-2 p-2.5 font-mono text-xs leading-[18px] whitespace-pre-wrap break-all",
						isError ? "text-danger" : "text-ink-2",
					)}
				>
					{displayOutput}
				</div>
			)}
		</>
	);
}

function toolContext(block: ToolCallBlock, results: UiToolResult[]) {
	return { block, results };
}

export function ExpandedToolCallBody({ block, results }: { block: ToolCallBlock; results: UiToolResult[] }) {
	const context = toolContext(block, results);
	const presenter = getToolPresenter(block.toolName);
	const presenterBody = presenter.renderBody?.(context);
	const fullOutputPath =
		typeof block.result === "object" && block.result !== null
			? ((block.result as Record<string, unknown>).fullOutputPath as string | undefined)
			: undefined;

	return (
		<div className="ml-[22px] flex flex-col gap-2 border-l border-border pl-3">
			{presenterBody ?? <GenericToolBody context={context} />}
			{block.toolName === "bash" && fullOutputPath && (
				<span className="text-[11px] text-ink-3">{tt("tool.fullLog", { path: fullOutputPath })}</span>
			)}
		</div>
	);
}

export interface ToolCallRowProps {
	block: ToolCallBlock;
	results: UiToolResult[];
	stacked?: boolean;
	className?: string;
}

/**
 * Tool call as a first-class inline node (never inside markdown):
 * collapsed summary row, two-phase status, inline expansion capped at
 * terminal 224px / code 260px; the full log goes to the right inspector.
 */
export function ToolCallRow({ block, results, stacked, className }: ToolCallRowProps) {
	const [expanded, setExpanded] = useState(false);
	const presenter = getToolPresenter(block.toolName);
	const presenterContext = toolContext(block, results);
	const summary = boundedToolSummary(presenter.summarize(presenterContext));
	const diffStats = toolDiffStats(presenterContext);
	const effectiveStatus = results.some((result) => result.isError) ? "error" : block.status;
	const status = STATUS_ICON[effectiveStatus];
	const StatusIcon = status.icon;

	return (
		<div className={cn("flex min-w-0 max-w-full flex-col gap-1", stacked && "px-2.5 py-1.5", className)}>
			<div className="group flex items-center gap-1.5 rounded-sm py-0.5 hover:bg-hover">
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
					className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
				>
					<ChevronRight
						className={cn(
							"size-3.5 shrink-0 text-ink-3 transition-transform duration-200",
							expanded && "rotate-90",
						)}
					/>
					<StatusIcon className={cn("size-3.5 shrink-0", status.className)} />
					<Wrench className="size-3.5 shrink-0 text-ink-3" />
					<span className="shrink-0 font-mono text-[13px] text-ink">{block.toolName}</span>
					{summary && <span className="min-w-0 truncate text-[13px] text-ink-3">· {summary}</span>}
					{diffStats && (
						<span
							data-testid="tool-diff-badge"
							className="inline-flex shrink-0 items-center gap-1 rounded-xs border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums"
						>
							<span className="text-success">+{diffStats.additions}</span>
							<span className="text-danger">-{diffStats.deletions}</span>
						</span>
					)}
					<span className="sr-only">{tt(status.label as never)}</span>
				</button>
				<button
					type="button"
					aria-label={tt("tool.inspectAria")}
					className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-0 transition-opacity hover:bg-hover hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/40"
					onClick={() => {
						const view = useViewStore.getState();
						const sessionId = useProjectionStore.getState().currentSessionId;
						view.selectTool(sessionId ?? "", block.key);
					}}
				>
					<ExternalLink className="size-3.5" />
				</button>
				{block.status === "skipped" && (
					<span className="shrink-0 text-[11px] text-ink-3">{tt("status.skipped")}</span>
				)}
			</div>

			{expanded && <ExpandedToolCallBody block={block} results={results} />}
		</div>
	);
}
