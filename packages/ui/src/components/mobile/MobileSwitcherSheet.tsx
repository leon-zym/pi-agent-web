import type { NativeSessionDto, NativeWorkspaceDto } from "@pi-agent-web/protocol";
import { Check, Folder, Plus } from "lucide-react";
import { displayLabel, formatRelativeTime } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../ui/sheet";

export interface MobileSwitcherContentProps {
	workspaces: NativeWorkspaceDto[];
	currentWorkspaceHandle?: string | null;
	sessionsByWorkspace: Record<string, NativeSessionDto[]>;
	currentSessionHandle?: string | null;
	onSelectWorkspace: (workspaceHandle: string) => void;
	onSelectSession: (session: NativeSessionDto) => void;
	onNewSession: () => void;
	onClose?: () => void;
}

export interface MobileSwitcherSheetProps extends MobileSwitcherContentProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

function sessionTitle(session: NativeSessionDto): string {
	if (session.name) return displayLabel(session.name);
	if (session.firstMessage) return displayLabel(session.firstMessage).slice(0, 40);
	return tt("sidebar.emptySession");
}

/**
 * Mobile touch drawer content for switching workspaces and sessions.
 * All touch hit targets >= 40px.
 */
export function MobileSwitcherContent({
	workspaces,
	currentWorkspaceHandle,
	sessionsByWorkspace,
	currentSessionHandle,
	onSelectWorkspace,
	onSelectSession,
	onNewSession,
	onClose,
}: MobileSwitcherContentProps) {
	const activeWorkspace =
		workspaces.find((w) => w.workspaceHandle === currentWorkspaceHandle) ?? workspaces[0];
	const activeWorkspaceHandle = activeWorkspace?.workspaceHandle ?? "";
	const sessions = sessionsByWorkspace[activeWorkspaceHandle] ?? [];

	return (
		<div className="flex h-full max-h-[85vh] flex-col overflow-hidden bg-sidebar">
			{/* Touch drawer pill handle */}
			<div className="flex h-6 flex-none items-center justify-center pt-2">
				<div className="h-1.5 w-12 rounded-full bg-ink-3/30" />
			</div>

			<div className="px-4 pb-2">
				<h2 className="text-base font-semibold text-ink">{tt("mobile.switcher")}</h2>
			</div>

			{/* Workspace switcher tabs / selector if multiple */}
			{workspaces.length > 1 && (
				<div className="scroll-slim flex flex-none gap-1.5 overflow-x-auto px-4 py-1">
					{workspaces.map((ws) => {
						const isSelected = ws.workspaceHandle === activeWorkspaceHandle;
						return (
							<button
								key={ws.workspaceHandle}
								type="button"
								onClick={() => onSelectWorkspace(ws.workspaceHandle)}
								className={cn(
									"flex h-10 min-w-10 shrink-0 items-center gap-1.5 rounded-sm px-3 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none",
									isSelected
										? "bg-primary-soft text-primary"
										: "bg-surface text-ink-2 hover:bg-hover hover:text-ink",
								)}
							>
								<Folder className="size-4 shrink-0" />
								<span className="truncate max-w-40">{displayLabel(ws.displayName)}</span>
								{isSelected && <Check className="size-3.5" />}
							</button>
						);
					})}
				</div>
			)}

			<div className="flex flex-none items-center justify-between px-4 pt-2 pb-1">
				<span className="text-[12px] font-medium text-ink-3">
					{activeWorkspace?.displayName ? displayLabel(activeWorkspace.displayName) : tt("sidebar.brand")}
				</span>
				<Button
					variant="secondary"
					size="sm"
					className="h-10 gap-1.5 px-3 text-[13px]"
					onClick={() => {
						onNewSession();
						onClose?.();
					}}
					disabled={!activeWorkspace?.available}
				>
					<Plus className="size-4" />
					{tt("sidebar.newSession")}
				</Button>
			</div>

			{/* Session list */}
			<div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-3 py-1">
				{sessions.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-8 text-center text-sm text-ink-3">
						{tt("sidebar.emptySession")}
					</div>
				) : (
					<ul className="flex flex-col gap-1">
						{sessions.map((session) => {
							const isSelected = session.sessionHandle === currentSessionHandle;
							const modifiedAt = session.modifiedAt ? Date.parse(session.modifiedAt) : Number.NaN;
							return (
								<li key={session.sessionHandle}>
									<button
										type="button"
										onClick={() => {
											onSelectSession(session);
											onClose?.();
										}}
										className={cn(
											"group flex h-10 w-full min-w-10 items-center justify-between rounded-sm px-3 text-left transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none",
											isSelected ? "bg-primary-soft/60 font-medium text-ink" : "text-ink-2",
										)}
									>
										<span className="min-w-0 flex-1 truncate text-[13px]">{sessionTitle(session)}</span>
										{!Number.isNaN(modifiedAt) && (
											<span className="ml-2 shrink-0 font-mono text-[11px] text-ink-3 tabular-nums">
												{formatRelativeTime(modifiedAt)}
											</span>
										)}
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
}

/**
 * Mobile touch drawer for switching Workspaces and Sessions.
 * All touch hit targets >= 40px.
 */
export function MobileSwitcherSheet({
	open,
	onOpenChange,
	workspaces,
	currentWorkspaceHandle,
	sessionsByWorkspace,
	currentSessionHandle,
	onSelectWorkspace,
	onSelectSession,
	onNewSession,
}: MobileSwitcherSheetProps) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="bottom"
				showCloseButton={true}
				className="flex max-h-[85vh] flex-col overflow-hidden bg-sidebar p-0 shadow-lv3"
			>
				<SheetTitle className="sr-only">{tt("mobile.switcher")}</SheetTitle>
				<SheetDescription className="sr-only">{tt("mobile.selectWorkspace")}</SheetDescription>
				<MobileSwitcherContent
					workspaces={workspaces}
					currentWorkspaceHandle={currentWorkspaceHandle}
					sessionsByWorkspace={sessionsByWorkspace}
					currentSessionHandle={currentSessionHandle}
					onSelectWorkspace={onSelectWorkspace}
					onSelectSession={onSelectSession}
					onNewSession={onNewSession}
					onClose={() => onOpenChange(false)}
				/>
			</SheetContent>
		</Sheet>
	);
}
