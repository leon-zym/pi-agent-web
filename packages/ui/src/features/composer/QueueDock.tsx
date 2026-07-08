import { ArrowUpRight, ListEnd } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "../../components/ui/badge";
import { useComposerStore } from "../../stores/composer";
import { tt } from "../../lib/i18n";

/**
 * Queue dock above the composer: mirrors queue_update.
 * One entry renders inline; several collapse into a count summary.
 */
export function QueueDock() {
	const queue = useComposerStore((s) => s.queue);

	const entries = useMemo(
		() => [
			...queue.steering.map((text) => ({ text, kind: "steer" as const })),
			...queue.followUp.map((text) => ({ text, kind: "follow_up" as const })),
		],
		[queue],
	);

	if (entries.length === 0) return null;

	const visible = entries.length === 1 ? entries : entries.slice(0, 2);

	return (
		<div className="mb-2 flex flex-col gap-1">
			{visible.map((entry, index) => (
				<div
					key={entry.kind + ":" + index}
					className="flex items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink-2"
				>
					{entry.kind === "steer" ? (
						<ArrowUpRight className="size-3.5 shrink-0 text-primary" />
					) : (
						<ListEnd className="size-3.5 shrink-0 text-ink-3" />
					)}
					<Badge variant={entry.kind === "steer" ? "primary" : "default"} className="shrink-0">
						{tt(entry.kind === "steer" ? "status.steer" : "status.followUp")}
					</Badge>
					<span className="min-w-0 flex-1 truncate">{entry.text}</span>
				</div>
			))}
			{entries.length > 2 && (
				<div className="px-2.5 text-[11px] text-ink-3">{tt("composer.queueCount", { count: entries.length - 2 })}</div>
			)}
		</div>
	);
}
