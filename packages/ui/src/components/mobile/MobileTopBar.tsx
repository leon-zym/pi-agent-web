import type { NativeSessionDto, NativeWorkspaceDto, SessionRuntimeStateDto } from "@pi-agent-web/protocol";
import { ChevronsUpDown, Folder } from "lucide-react";
import type * as React from "react";
import { displayLabel } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

export interface MobileTopBarProps {
	workspace?: NativeWorkspaceDto | null;
	session?: NativeSessionDto | null;
	status?: SessionRuntimeStateDto | "crashed" | "error" | "dormant" | null;
	onOpenSwitcher: () => void;
	actions?: React.ReactNode;
}

function runtimeLabel(status?: string | null): string {
	switch (status) {
		case "starting":
			return tt("status.starting");
		case "running":
			return tt("status.running");
		case "waiting_ui":
			return tt("status.waitingUi");
		case "crashed":
		case "error":
			return tt("status.crashed");
		case "dormant":
			return tt("status.dormant");
		default:
			return tt("status.idle");
	}
}

function sessionTitle(session?: NativeSessionDto | null): string {
	if (!session) return tt("sidebar.emptySession");
	if (session.name) return displayLabel(session.name);
	if (session.firstMessage) return displayLabel(session.firstMessage).slice(0, 40);
	return tt("sidebar.emptySession");
}

/**
 * Compact mobile header with primary navigation and Session actions.
 * Integrates workspace name, session title, status indicator, and switcher drawer trigger.
 * All interactive hit targets >= 40px.
 */
export function MobileTopBar({ workspace, session, status, onOpenSwitcher, actions }: MobileTopBarProps) {
	const currentStatus = status ?? "dormant";

	return (
		<header className="flex h-12 flex-none items-center justify-between border-b border-border bg-base px-2">
			<button
				type="button"
				aria-label={tt("mobile.switcher")}
				onClick={onOpenSwitcher}
				className="flex min-h-10 min-w-10 max-w-[calc(100vw-120px)] items-center gap-1.5 rounded-sm px-2 text-left hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
			>
				<Folder className="size-4 shrink-0 text-ink-3" />
				<div className="flex min-w-0 flex-1 flex-col justify-center">
					<span className="truncate text-[10px] leading-tight text-ink-3">
						{workspace?.displayName ? displayLabel(workspace.displayName) : tt("header.noWorkspace")}
					</span>
					<span className="truncate text-[13px] font-medium leading-tight text-ink">
						{sessionTitle(session)}
					</span>
				</div>
				<ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" />
			</button>

			<div className="flex items-center gap-1">
				<Badge
					variant={
						currentStatus === "crashed" || currentStatus === "error"
							? "danger"
							: currentStatus === "starting"
								? "warning"
								: currentStatus === "running" || currentStatus === "waiting_ui"
									? "success"
									: "default"
					}
					className="min-h-7 gap-1 px-2 text-[11px]"
				>
					<span
						className={cn(
							"size-1.5 rounded-full bg-current",
							(currentStatus === "running" || currentStatus === "starting") && "pulse-dot",
						)}
					/>
					<span>{runtimeLabel(currentStatus)}</span>
				</Badge>

				{actions}
			</div>
		</header>
	);
}
