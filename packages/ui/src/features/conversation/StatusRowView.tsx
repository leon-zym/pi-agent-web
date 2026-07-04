import { Loader2 } from "lucide-react";
import type { StatusRow } from "../../types/view-models";

/** Compact system rows for compaction / auto-retry activity (§5.2). */
export function StatusRowView({ row }: { row: StatusRow }) {
	return (
		<div className="flex items-center gap-2 py-0.5 text-xs text-ink-3">
			{row.state === "running" || row.state === "waiting" ? (
				<Loader2 className="size-3.5 animate-spin text-ink-3" />
			) : (
				<span className="size-1.5 rounded-full bg-ink-3/40" />
			)}
			<span className="font-mono">{row.detail}</span>
		</div>
	);
}
