import { expectData } from "@pi-agent-web/protocol";
import { Check, ChevronRight, Download, Folder, GitBranch, Pencil, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { formatRelativeTime } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { deleteSession, renameSession } from "../../lib/session-controller";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useTransportStore } from "../../stores/transport";
import { useViewStore } from "../../stores/view";

function sessionTitle(name: string | undefined, firstMessage: string | undefined, fallback: string): string {
	return name || firstMessage || fallback;
}

/**
 * Top row of the center column: workspace crumb, session title (inline
 * rename), process status and session actions.
 */
export function SessionHeader() {
	const workspace = useSessionDirectoryStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId));
	const currentSession = useSessionDirectoryStore((s) => s.currentSession);
	const workspaceId = useSessionDirectoryStore((s) => s.currentWorkspaceId);
	const processStatus = useTransportStore((s) => (workspaceId ? s.processStatus[workspaceId] : undefined));
	const setRightPanelMode = useViewStore((s) => s.setRightPanelMode);
	const setRightPanelOpen = useViewStore((s) => s.setRightPanelOpen);
	const [editing, setEditing] = useState(false);
	const [draftName, setDraftName] = useState("");

	const title = useMemo(() => {
		if (!currentSession) return "";
		return sessionTitle(currentSession.name, currentSession.firstMessage, tt("header.unnamed"));
	}, [currentSession]);

	const startRename = () => {
		if (!currentSession) return;
		setDraftName(currentSession.name ?? "");
		setEditing(true);
	};

	const commitRename = async () => {
		if (!currentSession) return;
		const name = draftName.trim();
		if (name) await renameSession(currentSession, name);
		setEditing(false);
	};

	const exportHtml = async () => {
		if (!workspaceId) return;
		try {
			const response = await useTransportStore.getState().sendCommand(workspaceId, { type: "export_html" });
			const { path } = expectData(response) as { path: string };
			toast.success(tt("header.exported"), {
				description: path,
				action: {
					label: tt("common.copyPath"),
					onClick: () =>
						void navigator.clipboard.writeText(path).then(() => toast.success(tt("common.pathCopied"))),
				},
			});
		} catch (error) {
			toast.error(tt("header.exportFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	return (
		<header className="flex h-12 flex-none items-center gap-2 border-b border-border px-4">
			<div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
				<Folder className="size-3.5 shrink-0 text-ink-3" />
				<span className="max-w-40 truncate text-ink-3">
					{workspace?.displayName ?? tt("header.noWorkspace")}
				</span>
				{currentSession && (
					<>
						<ChevronRight className="size-3.5 shrink-0 text-ink-3" />
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
									className="h-6 w-48 text-[13px]"
								/>
								<Button
									variant="ghost"
									size="icon"
									className="size-6"
									onClick={() => void commitRename()}
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
								className="group flex min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-ink hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
								onClick={startRename}
							>
								<span className="truncate font-medium">{title}</span>
								<Pencil className="size-3 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
							</button>
						)}
					</>
				)}
			</div>

			{currentSession && (
				<div className="flex flex-none items-center gap-0.5">
					<span className="mr-2 hidden text-xs text-ink-3 md:inline">
						{formatRelativeTime(currentSession.modified)}
					</span>
					<Badge
						variant={
							processStatus?.state === "crashed"
								? "danger"
								: processStatus?.state === "starting"
									? "warning"
									: processStatus?.state === "running"
										? "success"
										: "default"
						}
						className="mr-1 gap-1"
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
									: tt("status.running")}
						</span>
					</Badge>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
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
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label={tt("header.exportHtml")}
								onClick={() => void exportHtml()}
							>
								<Download className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{tt("header.exportHtml")}</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label={tt("header.deleteSession")}
								onClick={() => void deleteSession(currentSession)}
							>
								<Trash2 className="size-4 text-ink-3" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{tt("header.deleteSession")}</TooltipContent>
					</Tooltip>
				</div>
			)}
		</header>
	);
}
