import { Bot } from "lucide-react";
import { tt } from "../../lib/i18n";
import { useSessionDirectoryStore } from "../../stores/session-directory";

/** Quiet empty state: no marketing hero, just orientation (docs/design.md). */
export function EmptyHero() {
	const hasWorkspace = useSessionDirectoryStore((s) => s.currentWorkspaceHandle !== null);
	const hasSession = useSessionDirectoryStore((s) => s.currentSession !== null);

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
			<div className="flex size-12 items-center justify-center rounded-xl bg-primary-soft text-primary">
				<Bot className="size-6" />
			</div>
			<p className="text-base font-medium text-ink">
				{!hasWorkspace
					? tt("hero.pickWorkspace")
					: !hasSession
						? tt("hero.pickSession")
						: tt("hero.firstTurn")}
			</p>
			<p className="max-w-sm text-[13px] leading-relaxed text-ink-3">
				{tt("hero.hint1")}
				{tt("hero.hint2")}
			</p>
		</div>
	);
}
