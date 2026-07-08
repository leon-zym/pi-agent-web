import { Gauge } from "lucide-react";
import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { tt } from "../../lib/i18n";
import { formatCost, formatTokens } from "../../lib/format";
import { useSessionStatsStore } from "../../stores/session-stats";

/**
 * Context meter: get_session_stats().contextUsage with
 * live message_update usage while streaming. tokens/percent can be null right
 * after compaction: show a placeholder, never a fake 0%.
 */
export function ContextMeter() {
	const stats = useSessionStatsStore((s) => s.stats);
	const liveUsage = useSessionStatsStore((s) => s.liveUsage);

	const usage = stats?.contextUsage;

	const display = useMemo(() => {
		if (!usage) return { kind: "empty" as const };
		if (
			usage.tokens === null ||
			usage.percent === null ||
			usage.tokens === undefined ||
			usage.percent === undefined
		) {
			return { kind: "computing" as const };
		}
		return {
			kind: "ready" as const,
			tokens: usage.tokens,
			percent: usage.percent,
			window: usage.contextWindow,
		};
	}, [usage]);

	const liveTokens = liveUsage?.totalTokens ?? null;
	const totalCost = stats?.cost ?? 0;

	const tooltip = [
		display.kind === "ready"
			? tt("context.tooltipTokens", {
					tokens: formatTokens(display.tokens),
					window: formatTokens(display.window),
					percent: Math.round(display.percent),
				})
			: tt("context.tooltipComputing"),
		stats ? tt("context.tooltipTotal", { tokens: formatTokens(stats.tokens.total), cost: formatCost(totalCost) }) : null,
		liveTokens !== null ? tt("context.tooltipLive", { tokens: formatTokens(liveTokens) }) : null,
	]		.join("\n");

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={tt("context.aria")}
					className="flex h-7 items-center gap-1 rounded-sm px-2 text-xs text-ink-3 transition-colors hover:bg-hover hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
				>
					<Gauge className="size-3.5" />
					{display.kind === "ready" ? (
						<>
							<span className="h-1 w-10 overflow-hidden rounded-full bg-hover">
								<span
									className="block h-full rounded-full bg-primary"
									style={{ width: Math.min(100, Math.max(2, display.percent)) + "%" }}
								/>
							</span>
							<span className="font-mono tabular-nums">{Math.round(display.percent)}%</span>
						</>
					) : display.kind === "computing" ? (
						<span className="font-mono">{tt("common.computing")}</span>
					) : null}
				</button>
			</TooltipTrigger>
			<TooltipContent className="font-mono text-[11px] whitespace-pre-line">{tooltip}</TooltipContent>
		</Tooltip>
	);
}
