import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { Gauge } from "lucide-react";
import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { formatCost, formatTokens } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useSessionStatsStore } from "../../stores/session-stats";
import { useSessionTransportStore } from "../../stores/session-transport";

/**
 * Context meter: get_session_stats().contextUsage with
 * live message_update usage while streaming. tokens/percent can be null right
 * after compaction: show a placeholder, never a fake 0%.
 */
export function ContextMeter() {
	const stats = useSessionStatsStore((s) => s.stats);
	const liveUsage = useSessionStatsStore((s) => s.liveUsage);
	const sessionHandle = useSessionDirectoryStore((s) => s.currentSession?.sessionHandle ?? null);
	const runtimeState = useSessionTransportStore((state) =>
		sessionHandle ? state.sessions[sessionHandle]?.runtime?.state : undefined,
	);
	const pending = runtimeState === "starting" || runtimeState === "running" || runtimeState === "waiting_ui";

	const display = useMemo(() => {
		return resolveContextDisplay(stats, pending);
	}, [stats, pending]);

	const liveTokens = liveUsage?.totalTokens ?? null;
	const totalCost = stats?.cost ?? 0;

	const tooltip = [
		display.kind === "ready"
			? tt("context.tooltipTokens", {
					tokens: formatTokens(display.tokens),
					window: display.window === null ? "—" : formatTokens(display.window),
					percent: Math.round(display.percent),
				})
			: display.kind === "loading"
				? tt("context.tooltipComputing")
				: tt("context.tooltipUnavailable"),
		stats
			? tt("context.tooltipTotal", { tokens: formatTokens(stats.tokens.total), cost: formatCost(totalCost) })
			: null,
		liveTokens !== null ? tt("context.tooltipLive", { tokens: formatTokens(liveTokens) }) : null,
	].join("\n");

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={
						display.kind === "ready"
							? tt("context.ariaReady", { percent: Math.round(display.percent) })
							: tt(display.kind === "loading" ? "context.loading" : "context.unavailable")
					}
					data-state={display.kind}
					className="flex size-7 shrink-0 items-center justify-center gap-1 rounded-sm text-xs text-ink-3 transition-colors hover:bg-hover hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none max-lg:size-10 lg:h-7 lg:w-auto lg:px-2"
				>
					<Gauge className="size-3.5" />
					{display.kind === "ready" ? (
						<span className="hidden items-center gap-1 sm:inline-flex">
							<span className="h-1 w-10 overflow-hidden rounded-full bg-hover">
								<span
									className="block h-full rounded-full bg-primary"
									style={{ width: `${Math.min(100, Math.max(2, display.percent))}%` }}
								/>
							</span>
							<span className="font-mono tabular-nums">{Math.round(display.percent)}%</span>
						</span>
					) : (
						<span className="hidden font-mono sm:inline">
							{tt(display.kind === "loading" ? "common.computing" : "context.unavailableShort")}
						</span>
					)}
				</button>
			</TooltipTrigger>
			<TooltipContent className="font-mono text-[11px] whitespace-pre-line">{tooltip}</TooltipContent>
		</Tooltip>
	);
}

export type ContextDisplay =
	| { kind: "loading" }
	| { kind: "unavailable" }
	| { kind: "ready"; tokens: number; percent: number; window: number | null };

export function resolveContextDisplay(stats: SessionStats | null, pending = false): ContextDisplay {
	if (!stats) return { kind: pending ? "loading" : "unavailable" };
	const usage = stats.contextUsage;
	if (
		!usage ||
		usage.tokens === null ||
		usage.percent === null ||
		usage.tokens === undefined ||
		usage.percent === undefined
	) {
		return { kind: "unavailable" };
	}
	return {
		kind: "ready",
		tokens: usage.tokens,
		percent: usage.percent,
		window: usage.contextWindow,
	};
}
