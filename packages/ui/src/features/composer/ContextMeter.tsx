import type { SessionStatsDto } from "@pi-agent-web/protocol";
import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { formatCost, formatTokens } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { runtimeIsBusy } from "../../lib/runtime-state";
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
	const runtimeBusy = useSessionTransportStore((state) =>
		runtimeIsBusy(sessionHandle ? state.sessions[sessionHandle]?.runtime : undefined),
	);

	const display = useMemo(() => {
		return resolveContextDisplay(stats, runtimeBusy);
	}, [stats, runtimeBusy]);

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
				<span
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={display.kind === "ready" ? Math.round(display.percent) : undefined}
					aria-label={
						display.kind === "ready"
							? tt("context.ariaReady", { percent: Math.round(display.percent) })
							: tt(display.kind === "loading" ? "context.loading" : "context.unavailable")
					}
					data-state={display.kind}
					data-testid="context-meter"
					className="flex size-7 shrink-0 items-center justify-center gap-1.5 rounded-full text-xs text-ink-3 max-lg:size-10 lg:h-7 lg:w-auto lg:px-1"
				>
					<svg viewBox="0 0 20 20" className="size-5 shrink-0 -rotate-90" aria-hidden="true">
						<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
						{display.kind === "ready" && (
							<circle
								cx="10"
								cy="10"
								r="7"
								fill="none"
								stroke="var(--piw-primary)"
								strokeWidth="2"
								strokeLinecap="round"
								pathLength="100"
								strokeDasharray="100"
								strokeDashoffset={100 - Math.min(100, Math.max(0, display.percent))}
							/>
						)}
					</svg>
					{display.kind === "ready" ? (
						<span className="hidden items-center lg:inline-flex">
							<span className="font-mono tabular-nums">{Math.round(display.percent)}%</span>
						</span>
					) : (
						<span className="hidden font-mono lg:inline">
							{tt(display.kind === "loading" ? "common.computing" : "context.unavailableShort")}
						</span>
					)}
				</span>
			</TooltipTrigger>
			<TooltipContent className="font-mono text-[11px] whitespace-pre-line">{tooltip}</TooltipContent>
		</Tooltip>
	);
}

export type ContextDisplay =
	| { kind: "loading" }
	| { kind: "unavailable" }
	| { kind: "ready"; tokens: number; percent: number; window: number | null };

export function resolveContextDisplay(stats: SessionStatsDto | null, pending = false): ContextDisplay {
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
