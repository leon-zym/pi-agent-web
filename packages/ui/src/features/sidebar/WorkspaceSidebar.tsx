import type { SessionSummary, WorkspaceSummary } from "@pi-agent-web/protocol";
import {
	Bot,
	ChevronRight,
	Folder,
	FolderPlus,
	Moon,
	PanelLeftClose,
	PanelLeftOpen,
	Pencil,
	Plus,
	RotateCw,
	Search,
	Settings,
	Sun,
	SunMoon,
	Trash2,
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
import { Button } from "../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { api } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { deleteSession, newSession, openSession, renameSession } from "../../lib/session-controller";
import { useTheme } from "../../lib/use-theme";
import { cn } from "../../lib/utils";
import { useProjectionStore } from "../../stores/projection";
import { useSessionControlStore } from "../../stores/session-control";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useTransportStore } from "../../stores/transport";

type SessionStatus = "idle" | "running" | "error";

function sessionTitle(session: SessionSummary): string {
	if (session.name) return session.name;
	if (session.firstMessage) return session.firstMessage.slice(0, 40);
	return tt("sidebar.emptySession");
}

function sessionStatus(session: SessionSummary, isCurrent: boolean): SessionStatus {
	if (!isCurrent) return "idle";
	const projectionState = useProjectionStore.getState();
	const projection = projectionState.projections[session.id];
	if (projectionState.currentSessionId === session.id && projection?.activeTurnId != null) return "running";
	const last = projection?.turns[projection.turns.length - 1];
	if (last?.status === "error") return "error";
	return "idle";
}

function StatusDot({ status }: { status: SessionStatus }) {
	if (status === "running") return <span className="size-2 shrink-0 rounded-full bg-primary pulse-dot" />;
	if (status === "error") return <span className="size-2 shrink-0 rounded-full bg-danger" />;
	return <span className="size-2 shrink-0 rounded-full bg-ink-3/30" />;
}

interface SessionRowProps {
	session: SessionSummary;
	workspace: WorkspaceSummary;
	current: boolean;
}

function SessionRow({ session, current }: SessionRowProps) {
	const [renameOpen, setRenameOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [name, setName] = useState(session.name ?? "");
	const currentWorkspaceId = useSessionDirectoryStore((s) => s.currentWorkspaceId);
	const canControl = useSessionControlStore((s) => s.canControl(currentWorkspaceId));

	const status = sessionStatus(session, current);
	const empty = session.messageCount === 0 && !session.name;
	const title = sessionTitle(session);

	const startRename = () => {
		setName(session.name ?? "");
		setRenameOpen(true);
	};

	const commitRename = () => {
		const trimmed = name.trim();
		if (trimmed) void renameSession(session, trimmed);
		setRenameOpen(false);
	};

	return (
		<li
			role="treeitem"
			aria-selected={current}
			tabIndex={-1}
			className="group relative flex h-8 items-center gap-2 rounded-sm pr-1 hover:bg-hover"
		>
			{current && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary" />}
			<button
				type="button"
				onClick={() => void openSession(session)}
				disabled={!current && !canControl}
				className={cn(
					"flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
					current ? "font-medium text-ink" : "text-ink-2",
				)}
			>
				<StatusDot status={status} />
				<span className={cn("min-w-0 flex-1 truncate text-[13px]", empty && "text-ink-3")}>{title}</span>
				{!empty && (
					<span className="shrink-0 font-mono text-[11px] text-ink-3 tabular-nums">
						{formatRelativeTime(session.modified)}
					</span>
				)}
			</button>
			{!empty && (
				<div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
					{current && (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={tt("sidebar.renameSession")}
									className="flex size-6 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
									onClick={startRename}
									disabled={!canControl}
								>
									<Pencil className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent>{tt("common.rename")}</TooltipContent>
						</Tooltip>
					)}
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={tt("sidebar.deleteSession")}
								className="flex size-6 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-danger"
								onClick={() => setDeleteOpen(true)}
								disabled={!canControl}
							>
								<Trash2 className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent>{tt("common.delete")}</TooltipContent>
					</Tooltip>
				</div>
			)}

			<Dialog open={renameOpen} onOpenChange={setRenameOpen}>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>{tt("sidebar.renameSession")}</DialogTitle>
						<DialogDescription>{tt("sidebar.renameDescription")}</DialogDescription>
					</DialogHeader>
					<Input
						autoFocus
						value={name}
						placeholder={session.firstMessage ?? tt("sidebar.sessionNamePlaceholder")}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") commitRename();
						}}
					/>
					<DialogFooter>
						<Button variant="outline" onClick={() => setRenameOpen(false)}>
							{tt("common.cancel")}
						</Button>
						<Button onClick={commitRename} disabled={!canControl || !name.trim()}>
							{tt("common.save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{tt("sidebar.deleteSession")}</AlertDialogTitle>
						<AlertDialogDescription>{tt("sidebar.deleteDescription", { title })}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{tt("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={() => void deleteSession(session)}>
							{tt("common.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</li>
	);
}

interface WorkspaceGroupProps {
	workspace: WorkspaceSummary;
	sessions: SessionSummary[];
	defaultExpanded: boolean;
}

function WorkspaceGroup({ workspace, sessions, defaultExpanded }: WorkspaceGroupProps) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const [removeOpen, setRemoveOpen] = useState(false);
	const currentWorkspaceId = useSessionDirectoryStore((s) => s.currentWorkspaceId);
	const currentSession = useSessionDirectoryStore((s) => s.currentSession);
	const canControl = useSessionControlStore((s) => s.canControl(currentWorkspaceId));
	const visible = sessions.slice(0, expanded ? undefined : 5);
	const more = sessions.length - visible.length;

	return (
		<div className="flex flex-col">
			<div className="group flex h-8 items-center gap-1 rounded-sm pr-1 hover:bg-hover">
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					aria-expanded={expanded}
					className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
				>
					<ChevronRight
						className={cn(
							"size-3.5 shrink-0 text-ink-3 transition-transform duration-200",
							expanded && "rotate-90",
						)}
					/>
					<Folder
						className={cn(
							"size-3.5 shrink-0",
							currentWorkspaceId === workspace.id ? "text-primary" : "text-ink-3",
						)}
					/>
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-[13px]",
							currentWorkspaceId === workspace.id ? "font-medium text-ink" : "text-ink-2",
						)}
					>
						{workspace.displayName}
					</span>
					<span className="shrink-0 font-mono text-[11px] text-ink-3 tabular-nums">
						{workspace.sessionCount}
					</span>
				</button>
				<div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={tt("sidebar.newSession")}
								className="flex size-6 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
								onClick={() => void newSession()}
								disabled={currentWorkspaceId !== workspace.id || !canControl}
							>
								<Plus className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent>{tt("sidebar.newSession")}</TooltipContent>
					</Tooltip>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								aria-label={tt("sidebar.workspaceActions")}
								className="flex size-6 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
							>
								<Settings className="size-3.5" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							<DropdownMenuItem
								onClick={() => void useSessionDirectoryStore.getState().selectWorkspace(workspace.id)}
							>
								{tt("sidebar.openWorkspace")}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem variant="destructive" onClick={() => setRemoveOpen(true)}>
								{tt("sidebar.removeWorkspace")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{expanded && (
				<ul className="flex flex-col pl-3">
					{visible.map((session) => (
						<SessionRow
							key={session.id}
							session={session}
							workspace={workspace}
							current={currentWorkspaceId === workspace.id && currentSession?.id === session.id}
						/>
					))}
					{more > 0 && (
						<button
							type="button"
							className="h-7 rounded-sm pl-2.5 text-left text-[12px] text-ink-3 hover:bg-hover hover:text-ink-2"
							onClick={() => setExpanded(true)}
						>
							{tt("sidebar.expandMore", { count: more })}
						</button>
					)}
				</ul>
			)}

			<AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{tt("sidebar.removeWorkspace")}</AlertDialogTitle>
						<AlertDialogDescription>
							{tt("sidebar.removeWorkspaceDescription", { name: workspace.displayName })}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{tt("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => void useSessionDirectoryStore.getState().removeWorkspace(workspace.id)}
						>
							{tt("sidebar.removeWorkspace")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function AddWorkspaceDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [path, setPath] = useState<string | null>(null);
	const [picking, setPicking] = useState(false);
	const chooseDirectory = async () => {
		setPicking(true);
		try {
			const selected = await api.pickWorkspaceDirectory();
			if (selected.path) setPath(selected.path);
		} catch (error) {
			toast.error(tt("sidebar.workspaceAddFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setPicking(false);
		}
	};
	const add = async () => {
		if (!path) return;
		try {
			await useSessionDirectoryStore.getState().addWorkspace(path);
			toast.success(tt("sidebar.workspaceAdded"));
			setPath(null);
			onOpenChange(false);
		} catch (error) {
			toast.error(tt("sidebar.workspaceAddFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{tt("sidebar.workspaceDialogTitle")}</DialogTitle>
					<DialogDescription>{tt("sidebar.workspaceDialogDescription")}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-2">
					<Button
						variant="outline"
						className="h-9 justify-start"
						onClick={() => void chooseDirectory()}
						disabled={picking}
					>
						<FolderPlus className="size-4" />
						{picking ? tt("common.loading") : tt("sidebar.chooseWorkspaceFolder")}
					</Button>
					<div className="min-h-9 rounded-sm bg-surface-2 px-3 py-2 font-mono text-[12px] leading-5 text-ink-2">
						<span className={cn("break-all", !path && "text-ink-3")}>
							{path ?? tt("sidebar.workspacePickerEmpty")}
						</span>
					</div>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{tt("common.cancel")}
					</Button>
					<Button onClick={() => void add()} disabled={!path || picking}>
						{tt("sidebar.addWorkspace")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Workspace / session browser (DESIGN.md): expanded 280px tree or 56px rail.
 * Rows are hover-fill only; the selected session gets a 2px primary bar.
 */
export function WorkspaceSidebar({ rail, onToggleRail }: { rail: boolean; onToggleRail?: () => void }) {
	const workspaces = useSessionDirectoryStore((s) => s.workspaces);
	const sessions = useSessionDirectoryStore((s) => s.sessions);
	const currentWorkspaceId = useSessionDirectoryStore((s) => s.currentWorkspaceId);
	const canControl = useSessionControlStore((s) => s.canControl(currentWorkspaceId));
	const searchQuery = useSessionDirectoryStore((s) => s.searchQuery);
	const setSearchQuery = useSessionDirectoryStore((s) => s.setSearchQuery);
	const [addOpen, setAddOpen] = useState(false);
	const { preference, resolved, set } = useTheme();

	const processStatus = useTransportStore((s) =>
		currentWorkspaceId ? s.processStatus[currentWorkspaceId] : undefined,
	);

	const filtered = useMemo(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return null;
		return sessions.filter((session) => sessionTitle(session).toLowerCase().includes(query)).slice(0, 20);
	}, [sessions, searchQuery]);

	const cycleTheme = () => {
		set(preference === "light" ? "dark" : preference === "dark" ? "system" : "light");
	};

	const ThemeIcon = preference === "system" ? SunMoon : resolved === "dark" ? Moon : Sun;

	const restartProcess = async () => {
		if (!currentWorkspaceId) return;
		try {
			await api.restartProcess(currentWorkspaceId);
			toast.success(tt("sidebar.restarted"));
		} catch (error) {
			toast.error(tt("sidebar.restartFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	if (rail) {
		return (
			<nav aria-label={tt("sidebar.navAria")} className="flex h-full flex-col items-center gap-1 py-2">
				<div className="mb-2 flex size-9 items-center justify-center rounded-sm bg-primary-soft text-primary">
					<Bot className="size-5" />
				</div>
				{onToggleRail && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={tt("appShell.expandSidebar")}
								className="flex size-9 items-center justify-center rounded-sm text-ink-2 transition-[color,background-color,scale] hover:bg-hover active:scale-95"
								onClick={onToggleRail}
							>
								<PanelLeftOpen className="size-4" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">{tt("appShell.expandSidebar")}</TooltipContent>
					</Tooltip>
				)}
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("sidebar.newSession")}
							disabled={!currentWorkspaceId || !canControl}
							className="flex size-9 items-center justify-center rounded-sm text-ink-2 hover:bg-hover disabled:opacity-40"
							onClick={() => void newSession()}
						>
							<Plus className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="right">{tt("sidebar.newSession")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("sidebar.addWorkspace")}
							className="flex size-9 items-center justify-center rounded-sm text-ink-2 hover:bg-hover"
							onClick={() => setAddOpen(true)}
						>
							<FolderPlus className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="right">{tt("sidebar.addWorkspace")}</TooltipContent>
				</Tooltip>
				<div className="flex-1" />
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("sidebar.switchTheme")}
							className="flex size-9 items-center justify-center rounded-sm text-ink-2 hover:bg-hover"
							onClick={cycleTheme}
						>
							<ThemeIcon className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="right">{tt("sidebar.switchTheme")}</TooltipContent>
				</Tooltip>
				<AddWorkspaceDialog open={addOpen} onOpenChange={setAddOpen} />
			</nav>
		);
	}

	return (
		<nav aria-label={tt("sidebar.navAria")} className="flex h-full flex-col">
			<div className="flex h-11 flex-none items-center gap-2 px-3">
				<div className="flex size-7 items-center justify-center rounded-md bg-primary-soft text-primary">
					<Bot className="size-4" />
				</div>
				<span className="text-[13px] font-semibold text-ink">{tt("sidebar.brand")}</span>
				<div className="flex-1" />
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("sidebar.addWorkspace")}
							className="flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
							onClick={() => setAddOpen(true)}
						>
							<FolderPlus className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent>{tt("sidebar.addWorkspace")}</TooltipContent>
				</Tooltip>
				{onToggleRail && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={tt("appShell.collapseSidebar")}
								className="flex size-7 items-center justify-center rounded-sm text-ink-3 transition-[color,background-color,scale] hover:bg-hover hover:text-ink active:scale-95"
								onClick={onToggleRail}
							>
								<PanelLeftClose className="size-4" />
							</button>
						</TooltipTrigger>
						<TooltipContent>{tt("appShell.collapseSidebar")}</TooltipContent>
					</Tooltip>
				)}
			</div>

			<div className="px-3 pb-2">
				<Button
					variant="secondary"
					className="h-8 w-full justify-start gap-1.5 text-[13px]"
					disabled={!currentWorkspaceId || !canControl}
					onClick={() => void newSession()}
				>
					<Plus className="size-4" />
					{tt("sidebar.newSession")}
				</Button>
			</div>

			<div className="px-3 pb-1">
				<div className="relative">
					<Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
					<Input
						value={searchQuery}
						onChange={(event) => setSearchQuery(event.target.value)}
						placeholder={tt("sidebar.searchPlaceholder")}
						className="h-7 pr-7 pl-8 text-[13px]"
					/>
				</div>
			</div>

			<div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-2 pb-2">
				{filtered !== null ? (
					filtered.length > 0 ? (
						<ul className="flex flex-col">
							{filtered.map((session) => {
								const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
								return (
									<div key={session.id} className="flex flex-col">
										<div className="px-2 pt-1.5 pb-0.5 text-[11px] text-ink-3">
											{workspace?.displayName ?? ""}
										</div>
										<SessionRow
											session={session}
											workspace={
												workspace ?? {
													id: "",
													path: "",
													displayName: "",
													sessionCount: 0,
													lastOpenedAt: null,
												}
											}
											current={
												currentWorkspaceId === workspace?.id &&
												useSessionDirectoryStore.getState().currentSession?.id === session.id
											}
										/>
									</div>
								);
							})}
						</ul>
					) : (
						<p className="px-2 py-4 text-center text-[12px] text-ink-3">{tt("sidebar.noMatch")}</p>
					)
				) : workspaces.length === 0 ? (
					<div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
						<p className="text-[13px] text-ink-3">{tt("sidebar.noWorkspaces")}</p>
						<Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
							<FolderPlus className="size-3.5" />
							{tt("sidebar.addWorkspace")}
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-0.5">
						{workspaces.map((workspace) => (
							<WorkspaceGroup
								key={workspace.id}
								workspace={workspace}
								sessions={workspace.id === currentWorkspaceId ? sessions : []}
								defaultExpanded={workspace.id === currentWorkspaceId}
							/>
						))}
					</div>
				)}
			</div>

			<div className="flex flex-none items-center gap-1 border-t border-border px-2 py-1.5">
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("sidebar.switchTheme")}
							className="flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
							onClick={cycleTheme}
						>
							<ThemeIcon className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent>
						{tt("sidebar.theme")}：
						{preference === "system"
							? tt("sidebar.themeSystem")
							: preference === "light"
								? tt("sidebar.themeLight")
								: tt("sidebar.themeDark")}
					</TooltipContent>
				</Tooltip>
				{currentWorkspaceId && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={tt("sidebar.processNotStarted")}
								className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-sm text-[11px] text-ink-3 hover:bg-hover"
								onClick={() => void restartProcess()}
								disabled={!canControl}
							>
								<span
									className={cn(
										"size-1.5 rounded-full",
										processStatus?.state === "running" && "bg-success",
										processStatus?.state === "starting" && "bg-warning pulse-dot",
										processStatus?.state === "crashed" && "bg-danger",
										!processStatus && "bg-ink-3/40",
									)}
								/>
								<span className="font-mono">
									{processStatus?.state === "running"
										? tt("sidebar.processPi")
										: processStatus?.state === "starting"
											? tt("sidebar.processStarting")
											: processStatus?.state === "crashed"
												? tt("sidebar.processCrashed")
												: tt("sidebar.processNotStarted")}
								</span>
							</button>
						</TooltipTrigger>
						<TooltipContent>
							{processStatus?.state === "crashed" ? processStatus.error : tt("status.clickToRestart")}
						</TooltipContent>
					</Tooltip>
				)}
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("common.settings")}
							className="flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
							onClick={() => window.dispatchEvent(new CustomEvent("piweb:open-settings"))}
						>
							<Settings className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent>{tt("common.settings")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("sidebar.restartProcess")}
							className="flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
							onClick={() => void restartProcess()}
							disabled={!canControl}
						>
							<RotateCw className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent>{tt("sidebar.restartProcess")}</TooltipContent>
				</Tooltip>
			</div>

			<AddWorkspaceDialog open={addOpen} onOpenChange={setAddOpen} />
		</nav>
	);
}
