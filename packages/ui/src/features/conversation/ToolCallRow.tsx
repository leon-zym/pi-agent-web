import {
	Check,
	ChevronRight,
	CircleAlert,
	ExternalLink,
	Loader2,
	SkipForward,
	Wrench,
	X,
} from "lucide-react";
import { useState } from "react";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useProjectionStore } from "../../stores/projection";
import { useViewStore } from "../../stores/view";
import type { ContentBlock, UiToolResult } from "../../types/view-models";
import { getToolPresenter } from "./tool-presenters";

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

function flattenArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return String(args);
	}
}

function flattenResult(result: unknown): string {
	if (result === undefined || result === null) return "";
	if (typeof result === "string") return result;
	if (typeof result === "object") {
		const record = result as Record<string, unknown>;
		if (typeof record.content === "string") return record.content;
		if (Array.isArray(record.content)) {
			return record.content
				.filter(
					(block) =>
						typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
				)
				.map((block) => (block as { text: string }).text)
				.join("\n");
		}
		try {
			return JSON.stringify(result, null, 2);
		} catch {
			return String(result);
		}
	}
	return String(result);
}

/**
 * Tool call as a first-class inline node (never inside markdown):
 * collapsed summary row, two-phase status, inline expansion capped at
 * terminal 224px / code 260px; the full log goes to the right inspector.
 */
export function ToolCallRow({ block, results }: { block: ToolCallBlock; results: UiToolResult[] }) {
	const [expanded, setExpanded] = useState(false);
	const presenter = getToolPresenter(block.toolName);
	const summary = presenter.summarize({ block, results });
	const effectiveStatus = results.some((result) => result.isError) ? "error" : block.status;
	const status = STATUS_ICON[effectiveStatus];
	const StatusIcon = status.icon;
	const isBash = block.toolName === "bash";

	const output = block.partialOutput || flattenResult(block.result) || results[0]?.content || "";
	const fullOutputPath =
		typeof block.result === "object" && block.result !== null
			? ((block.result as Record<string, unknown>).fullOutputPath as string | undefined)
			: undefined;

	return (
		<div className="flex flex-col gap-1">
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
					<span className="sr-only">{tt(status.label as never)}</span>
				</button>
				<button
					type="button"
					aria-label={tt("tool.inspectAria")}
					className="flex size-6 items-center justify-center rounded-sm text-ink-3 opacity-0 transition-opacity hover:bg-hover hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/40"
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

			{expanded && (
				<div className="ml-[22px] flex flex-col gap-2 border-l border-border pl-3">
					<div className="max-h-[224px] overflow-y-auto scroll-slim rounded-sm bg-surface-2 p-2.5 font-mono text-xs leading-[18px] whitespace-pre-wrap break-all text-ink-2">
						{isBash ? output || tt("common.noOutput") : flattenArgs(block.args)}
					</div>
					{!isBash && output && (
						<div className="max-h-[260px] overflow-y-auto scroll-slim rounded-sm bg-surface-2 p-2.5 font-mono text-xs leading-[18px] whitespace-pre-wrap break-all text-ink-2">
							{output}
						</div>
					)}
					{isBash && fullOutputPath && (
						<span className="text-[11px] text-ink-3">{tt("tool.fullLog", { path: fullOutputPath })}</span>
					)}
					{results.map((result) =>
						result.isError ? (
							<div key={result.toolCallId} className="flex items-start gap-1.5 text-[13px] text-danger">
								<X className="mt-0.5 size-3.5 shrink-0" />
								<span className="whitespace-pre-wrap break-words">
									{result.content || tt("tool.executionError")}
								</span>
							</div>
						) : null,
					)}
				</div>
			)}
		</div>
	);
}
