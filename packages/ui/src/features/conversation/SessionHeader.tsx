import { expectData } from "@pi-agent-web/protocol";
import {
	Check,
	ChevronRight,
	Download,
	Folder,
	GitBranch,
	MoreHorizontal,
	Pencil,
	Trash2,
	X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { displayError, displayLabel, formatRelativeTime, stripAnsi } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { type SessionDeleteBlockReason, sessionDeleteCapability } from "../../lib/session-capabilities";
import { deleteSession, renameSession, sendControlCommand } from "../../lib/session-controller";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useSessionTransportStore } from "../../stores/session-transport";
import { useViewStore } from "../../stores/view";

function sessionTitle(name: string | undefined, firstMessage: string | undefined, fallback: string): string {
	return displayLabel(name || firstMessage || fallback);
}

function deleteBlockReason(reason: SessionDeleteBlockReason): string {
	return tt(`sidebar.deleteBlocked.${reason}`);
}

/**
 * Top row of the center column: workspace crumb, session title (inline
 * rename), process status and session actions.
 */
export function SessionHeader() {
	const workspace = useSessionDirectoryStore((s) =>
		s.workspaces.find((candidate) => candidate.workspaceHandle === s.currentWorkspaceHandle),
	);
	const currentSession = useSessionDirectoryStore((s) => s.currentSession);
	const sessionHandle = currentSession?.sessionHandle ?? null;
	const channel = useSessionTransportStore((state) =>
		sessionHandle ? state.sessions[sessionHandle] : undefined,
	);
	const canControl = Boolean(channel?.lease.isController && channel.lease.fencingToken);
	const processStatus = channel?.runtime;
	const setRightPanelMode = useViewStore((s) => s.setRightPanelMode);
	const setRightPanelOpen = useViewStore((s) => s.setRightPanelOpen);
	const [editing, setEditing] = useState(false);
	const [draftName, setDraftName] = useState("");
	const [deleteOpen, setDeleteOpen] = useState(false);
	const deleteCapability = currentSession
		? sessionDeleteCapability(currentSession, channel)
		: ({ allowed: false, reason: "runtime_unavailable" } as const);

	const title = useMemo(() => {
		if (!currentSession) return "";
		return sessionTitle(currentSession.name, currentSession.firstMessage, tt("sidebar.emptySession"));
	}, [currentSession]);

	const startRename = () => {
		if (!currentSession) return;
		setDraftName(displayLabel(currentSession.name ?? ""));
		setEditing(true);
	};

	const commitRename = async () => {
		if (!currentSession) return;
		const name = draftName.trim();
		if (name) await renameSession(currentSession, name);
		setEditing(false);
	};

	const exportHtml = async () => {
		if (!sessionHandle) return;
		try {
			const response = await sendControlCommand(sessionHandle, { type: "export_html" });
			const { path } = expectData(response) as { path: string };
			toast.success(tt("header.exported"), {
				description: stripAnsi(path),
				action: {
					label: tt("common.copyPath"),
					onClick: () =>
						void navigator.clipboard.writeText(path).then(() => toast.success(tt("common.pathCopied"))),
				},
			});
		} catch (error) {
			toast.error(tt("header.exportFailed"), {
				description: displayError(error),
			});
		}
	};

	return (
		<header className="flex h-12 flex-none items-center gap-1.5 border-b border-border px-2.5 sm:gap-2 sm:px-4">
			<div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
				<Folder className="hidden size-3.5 shrink-0 text-ink-3 sm:block" />
				<div className="flex min-w-0 flex-1 flex-col justify-center sm:flex-row sm:items-center sm:justify-start sm:gap-1.5">
					<span className="truncate text-[10px] leading-3 text-ink-3 sm:max-w-40 sm:text-[13px] sm:leading-5">
						{workspace?.displayName ? displayLabel(workspace.displayName) : tt("header.noWorkspace")}
					</span>
					{currentSession && (
						<>
							<ChevronRight className="hidden size-3.5 shrink-0 text-ink-3 sm:block" />
							{editing ? (
								<span className="flex min-w-0 items-center gap-1">
									<Input
										autoFocus
										value={draftName}
										onChange={(e) => setDraftName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") void commitRename();
											if (e.key === "Escape") setEditing(false);
										}}
										className="h-6 min-w-0 flex-1 text-[13px] sm:w-48 sm:flex-none"
									/>
									<Button
										variant="ghost"
										size="icon"
										className="size-6"
										onClick={() => void commitRename()}
										disabled={!canControl}
										aria-label={tt("header.confirmRename")}
									>
										<Check className="size-3.5" />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										className="size-6"
										onClick={() => setEditing(false)}
										aria-label={tt("header.cancelRename")}
									>
										<X className="size-3.5" />
									</Button>
								</span>
							) : (
								<button
									type="button"
									className="group flex min-w-0 items-center gap-1.5 rounded-sm py-0.5 text-left text-ink hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none sm:px-1.5"
									onClick={startRename}
									disabled={!canControl}
								>
									<span className="truncate font-medium">{title}</span>
									<Pencil className="hidden size-3 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 sm:block" />
								</button>
							)}
						</>
					)}
				</div>
			</div>

			{currentSession && (
				<div className="flex flex-none items-center gap-0.5">
					{currentSession.messageCount > 0 && currentSession.modifiedAt && (
						<span className="mr-2 hidden text-xs text-ink-3 md:inline">
							{formatRelativeTime(Date.parse(currentSession.modifiedAt))}
						</span>
					)}
					<Badge
						variant={
							processStatus?.state === "crashed"
								? "danger"
								: processStatus?.state === "starting"
									? "warning"
									: processStatus?.state === "running" || processStatus?.state === "waiting_ui"
										? "success"
										: "default"
						}
						className="max-w-30 gap-1 px-1.5 sm:mr-1 sm:px-2"
					>
						<span className="inline-flex items-center gap-1">
							<span
								className={
									"size-1.5 rounded-full bg-current" +
									(processStatus?.state === "starting" ? " pulse-dot" : "")
								}
							/>
							{processStatus?.state === "crashed"
								? tt("status.crashed")
								: processStatus?.state === "starting"
									? tt("status.starting")
									: processStatus?.state === "running"
										? tt("status.running")
										: processStatus?.state === "waiting_ui"
											? tt("status.waitingUi")
											: processStatus?.state === "idle"
												? tt("status.idle")
												: tt("status.dormant")}
						</span>
					</Badge>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="max-lg:size-10"
								aria-label={tt("header.branchTree")}
								onClick={() => {
									setRightPanelMode("tree");
									setRightPanelOpen(true);
								}}
							>
								<GitBranch className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{tt("header.branchTree")}</TooltipContent>
					</Tooltip>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="max-lg:size-10"
								aria-label={tt("header.moreActions")}
							>
								<MoreHorizontal className="size-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-64">
							<DropdownMenuItem disabled={!canControl} onClick={() => void exportHtml()}>
								<Download />
								{tt("header.exportHtml")}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								disabled={!deleteCapability.allowed}
								onClick={() => setDeleteOpen(true)}
							>
								<Trash2 />
								{tt("header.deleteSession")}
							</DropdownMenuItem>
							{!deleteCapability.allowed && (
								<DropdownMenuLabel className="whitespace-normal font-normal leading-4">
									{deleteBlockReason(deleteCapability.reason)}
								</DropdownMenuLabel>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			)}
			{currentSession && (
				<AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{tt("sidebar.deleteSession")}</AlertDialogTitle>
							<AlertDialogDescription>{tt("sidebar.deleteDescription", { title })}</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>{tt("common.cancel")}</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								disabled={!deleteCapability.allowed}
								onClick={() => void deleteSession(currentSession)}
							>
								{tt("common.delete")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</header>
	);
}
