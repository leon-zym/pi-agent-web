import { CircleDashed, TriangleAlert } from "lucide-react";
import { Button } from "../../components/ui/button";
import { tt } from "../../lib/i18n";
import type { SessionResyncState } from "../../lib/session-resync";

export interface SessionRecoveryNoticeProps {
	state: SessionResyncState;
	onRetry: () => void;
}

export function SessionRecoveryNotice({ state, onRetry }: SessionRecoveryNoticeProps) {
	const degraded = state.phase === "degraded";
	const Icon = degraded ? TriangleAlert : CircleDashed;

	return (
		<section
			role="status"
			aria-live="polite"
			aria-atomic="true"
			data-testid="session-recovery-notice"
			data-resync-state={state.phase}
			className="mx-auto flex w-full max-w-[820px] items-start gap-3 rounded-md border border-warning/25 bg-warning-soft px-3 py-2.5 text-ink shadow-xs"
		>
			<Icon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="text-[13px] font-semibold leading-5">
					{degraded ? tt("resync.degraded") : tt("resync.syncing")}
				</p>
				<p className="mt-0.5 text-xs leading-5 text-ink-2">
					{degraded ? tt("resync.degradedDescription") : tt("resync.syncingDescription")}
				</p>
				<p className="mt-1 text-xs leading-5 text-warning">{tt("resync.stale")}</p>
			</div>
			{degraded && (
				<Button
					type="button"
					variant="outline"
					onClick={onRetry}
					className="min-h-9 shrink-0 border-warning/35 bg-base text-warning transition-[color,background-color,scale] hover:bg-warning-soft hover:text-warning focus-visible:ring-warning/40 active:scale-[0.96]"
				>
					{tt("resync.manualRetry")}
				</Button>
			)}
		</section>
	);
}
