import type { NativeSessionDto, NativeWorkspaceDto, SessionRuntimeStateDto } from "@pi-agent-web/protocol";
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
	Search,
	Settings,
	Sun,
	SunMoon,
	Trash2,
} from "lucide-react";
import { type Ref, useMemo, useState } from "react";
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
import { displayError, displayLabel, formatRelativeTime } from "../../lib/format";
import { tt } from "../../lib/i18n";
import {
	isSessionControlReady,
	type SessionDeleteBlockReason,
	sessionDeleteCapability,
} from "../../lib/session-capabilities";
import { deleteSession, newSession, openSession, renameSession } from "../../lib/session-controller";
import { useTheme } from "../../lib/use-theme";
import { cn } from "../../lib/utils";
import { useComposerStore } from "../../stores/composer";
import { useProjectionStore } from "../../stores/projection";
import {
	selectCurrentWorkspaceSessions,
	selectVisibleSessionsByWorkspace,
	useSessionDirectoryStore,
} from "../../stores/session-directory";
import { useSessionTransportStore } from "../../stores/session-transport";

type SessionStatus = SessionRuntimeStateDto | "error";

function deleteBlockReason(reason: SessionDeleteBlockReason): string {
	return tt(`sidebar.deleteBlocked.${reason}`);
}

function sessionTitle(session: NativeSessionDto): string {
	if (session.name) return displayLabel(session.name);
	if (session.firstMessage) return displayLabel(session.firstMessage).slice(0, 40);
	return tt("sidebar.emptySession");
}

function runtimeLabel(status: SessionStatus): string {
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

function StatusDot({ status }: { status: SessionStatus }) {
	return (
		<span
			title={runtimeLabel(status)}
			className={cn(
				"size-2 shrink-0 rounded-full",
				status === "running" && "bg-primary pulse-dot",
				status === "starting" && "bg-warning pulse-dot",
				status === "waiting_ui" && "bg-warning",
				(status === "crashed" || status === "error") && "bg-danger",
				status === "idle" && "bg-success",
				status === "dormant" && "bg-ink-3/30",
			)}
		/>
	);
}

interface SessionRowProps {
	session: NativeSessionDto;
	current: boolean;
	comfortable?: boolean;
	onSelect?: () => void;
}

function SessionRow({ session, current, comfortable = false, onSelect }: SessionRowProps) {
	const [renameOpen, setRenameOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [name, setName] = useState(displayLabel(session.name ?? ""));
	const channel = useSessionTransportStore((state) => state.sessions[session.sessionHandle]);
	const projection = useProjectionStore((state) => state.projections[session.sessionHandle]);
	const unread = useSessionDirectoryStore((state) => Boolean(state.unreadBySession[session.sessionHandle]));
	const inventoryState = useSessionDirectoryStore(
		(state) => state.hotRuntimeStateBySession[session.sessionHandle],
	);
	const queuedCount = useComposerStore((state) => {
		const queue = state.bySession[session.sessionHandle]?.queue;
		return (queue?.steering.length ?? 0) + (queue?.followUp.length ?? 0);
	});
	const runtime = channel?.runtime ?? session.runtime;
	const exactLease = isSessionControlReady(channel);
	const status: SessionStatus =
		projection?.turns.at(-1)?.status === "error" ? "error" : (runtime?.state ?? inventoryState ?? "dormant");
	const canRename = current && exactLease;
	const deleteCapability = sessionDeleteCapability(session, channel);
	const empty = session.messageCount === 0 && !session.name && !session.firstMessage;
	const title = sessionTitle(session);
	const modifiedAt = session.modifiedAt ? Date.parse(session.modifiedAt) : Number.NaN;

	const startRename = () => {
		setName(displayLabel(session.name ?? ""));
		setRenameOpen(true);
	};

	const commitRename = () => {
		const trimmed = name.trim();
		if (trimmed) void renameSession(session, trimmed);
		setRenameOpen(false);
	};

	return (
		<li
			data-session-row=""
			data-current={current ? "true" : "false"}
			data-runtime-state={status}
			data-unread={unread ? "true" : "false"}
			data-queued-count={queuedCount}
			className={cn(
				"group relative flex items-center gap-2 rounded-sm pr-1 hover:bg-hover",
				comfortable ? "h-10" : "h-8 [@media(hover:none)]:h-10",
			)}
		>
			{current && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary" />}
			<button
				type="button"
				aria-current={current ? "page" : undefined}
				onClick={() => void openSession(session).then(() => onSelect?.())}
				className={cn(
					"flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
					current ? "font-medium text-ink" : "text-ink-2",
				)}
			>
				<StatusDot status={status} />
				<span className="sr-only">{runtimeLabel(status)}</span>
				<span className={cn("min-w-0 flex-1 truncate text-[13px]", empty && "text-ink-3")}>{title}</span>
				{queuedCount > 0 && (
					<span className="shrink-0 rounded-full bg-warning/12 px-1.5 py-0.5 text-[10px] font-medium text-warning">
						{tt("sidebar.queued", { count: queuedCount })}
					</span>
				)}
				{unread && !current && (
					<span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
						{tt("sidebar.unread")}
					</span>
				)}
				{!empty && Number.isFinite(modifiedAt) && (
					<span className="shrink-0 font-mono text-[11px] text-ink-3 tabular-nums">
						{formatRelativeTime(modifiedAt)}
					</span>
				)}
			</button>
			{!empty && (
				<div
					className={cn(
						"flex shrink-0 items-center transition-opacity",
						comfortable
							? "opacity-100"
							: "opacity-0 group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:opacity-100",
					)}
				>
					{current && (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={tt("sidebar.renameSession")}
									className={cn(
										"flex items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink",
										comfortable ? "size-10" : "size-6 [@media(hover:none)]:size-10",
									)}
									onClick={startRename}
									disabled={!canRename}
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
								className={cn(
									"flex items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-danger",
									comfortable ? "size-10" : "size-6 [@media(hover:none)]:size-10",
								)}
								onClick={() => setDeleteOpen(true)}
								disabled={!deleteCapability.allowed}
							>
								<Trash2 className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent>
							{deleteCapability.allowed ? tt("common.delete") : deleteBlockReason(deleteCapability.reason)}
						</TooltipContent>
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
						placeholder={
							session.firstMessage ? displayLabel(session.firstMessage) : tt("sidebar.sessionNamePlaceholder")
						}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") commitRename();
						}}
					/>
					<DialogFooter>
						<Button variant="outline" onClick={() => setRenameOpen(false)}>
							{tt("common.cancel")}
						</Button>
						<Button onClick={commitRename} disabled={!canRename || !name.trim()}>
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
						<AlertDialogAction
							variant="destructive"
							disabled={!deleteCapability.allowed}
							onClick={() => void deleteSession(session)}
						>
							{tt("common.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</li>
	);
}

interface WorkspaceGroupProps {
	workspace: NativeWorkspaceDto;
	sessions: NativeSessionDto[];
	sessionCount: number;
	defaultExpanded: boolean;
	comfortable?: boolean;
	onSessionSelect?: () => void;
}

function WorkspaceGroup({
	workspace,
	sessions,
	sessionCount,
	defaultExpanded,
	comfortable = false,
	onSessionSelect,
}: WorkspaceGroupProps) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const [removeOpen, setRemoveOpen] = useState(false);
	const currentWorkspaceHandle = useSessionDirectoryStore((s) => s.currentWorkspaceHandle);
	const currentSession = useSessionDirectoryStore((s) => s.currentSession);
	const visible = sessions.slice(0, expanded ? undefined : 5);
	const more = sessions.length - visible.length;
	const selected = currentWorkspaceHandle === workspace.workspaceHandle;

	const openWorkspace = async () => {
		await useSessionDirectoryStore.getState().selectWorkspace(workspace.workspaceHandle);
	};
	const toggleExpanded = () => {
		const next = !expanded;
		setExpanded(next);
		if (next) void useSessionDirectoryStore.getState().reloadSessions(workspace.workspaceHandle);
	};

	const createSession = async () => {
		if (!workspace.available) return;
		if (useSessionDirectoryStore.getState().currentWorkspaceHandle !== workspace.workspaceHandle) {
			await useSessionDirectoryStore.getState().selectWorkspace(workspace.workspaceHandle);
		}
		if (useSessionDirectoryStore.getState().currentWorkspaceHandle !== workspace.workspaceHandle) return;
		const previousSessionHandle = useSessionDirectoryStore.getState().currentSession?.sessionHandle;
		await newSession();
		if (useSessionDirectoryStore.getState().currentSession?.sessionHandle !== previousSessionHandle) {
			onSessionSelect?.();
		}
	};

	return (
		<div className="flex flex-col">
			<div
				className={cn(
					"group flex items-center gap-1 rounded-sm pr-1 hover:bg-hover",
					comfortable ? "h-10" : "h-8 [@media(hover:none)]:h-10",
				)}
				title={
					workspace.available
						? workspace.path
							? displayLabel(workspace.path)
							: undefined
						: displayLabel(workspace.unavailableReason ?? "")
				}
			>
				<button
					type="button"
					onClick={toggleExpanded}
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
							selected ? "text-primary" : "text-ink-3",
							!workspace.available && "opacity-50",
						)}
					/>
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-[13px]",
							selected ? "font-medium text-ink" : "text-ink-2",
							!workspace.available && "text-ink-3",
						)}
					>
						{displayLabel(workspace.displayName)}
					</span>
					<span className="shrink-0 font-mono text-[11px] text-ink-3 tabular-nums">{sessionCount}</span>
				</button>
				<div
					className={cn(
						"flex shrink-0 items-center transition-opacity",
						comfortable
							? "opacity-100"
							: "opacity-0 group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:opacity-100",
					)}
				>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={tt("sidebar.newSession")}
								className={cn(
									"flex items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink",
									comfortable ? "size-10" : "size-6 [@media(hover:none)]:size-10",
								)}
								onClick={() => void createSession()}
								disabled={!workspace.available}
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
								className={cn(
									"flex items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink",
									comfortable ? "size-10" : "size-6 [@media(hover:none)]:size-10",
								)}
							>
								<Settings className="size-3.5" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							<DropdownMenuItem onClick={() => void openWorkspace()}>
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
							key={session.sessionHandle}
							session={session}
							current={selected && currentSession?.sessionHandle === session.sessionHandle}
							comfortable={comfortable}
							onSelect={onSessionSelect}
						/>
					))}
					{more > 0 && (
						<button
							type="button"
							className={cn(
								"rounded-sm pl-2.5 text-left text-[12px] text-ink-3 hover:bg-hover hover:text-ink-2",
								comfortable ? "h-10" : "h-7",
							)}
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
							{tt("sidebar.removeWorkspaceDescription", { name: displayLabel(workspace.displayName) })}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{tt("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() =>
								void useSessionDirectoryStore.getState().removeWorkspace(workspace.workspaceHandle)
							}
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
				description: displayError(error),
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
				description: displayError(error),
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
interface WorkspaceSidebarProps {
	rail: boolean;
	onToggleRail?: () => void;
	onOpenNavigation?: () => void;
	navigationTriggerRef?: Ref<HTMLButtonElement>;
	onRequestClose?: () => void;
	onSessionSelect?: () => void;
}

export function WorkspaceSidebar({
	rail,
	onToggleRail,
	onOpenNavigation,
	navigationTriggerRef,
	onRequestClose,
	onSessionSelect,
}: WorkspaceSidebarProps) {
	const workspaces = useSessionDirectoryStore((s) => s.workspaces);
	const sessions = useSessionDirectoryStore(selectCurrentWorkspaceSessions);
	const sessionsByWorkspace = useSessionDirectoryStore(selectVisibleSessionsByWorkspace);
	const durableSessionsByWorkspace = useSessionDirectoryStore((s) => s.sessionsByWorkspace);
	const hotSessionsByWorkspace = useSessionDirectoryStore((s) => s.hotSessionsByWorkspace);
	const currentWorkspaceHandle = useSessionDirectoryStore((s) => s.currentWorkspaceHandle);
	const currentSession = useSessionDirectoryStore((s) => s.currentSession);
	const searchQuery = useSessionDirectoryStore((s) => s.searchQuery);
	const setSearchQuery = useSessionDirectoryStore((s) => s.setSearchQuery);
	const [addOpen, setAddOpen] = useState(false);
	const { preference, resolved, set } = useTheme();
	const currentWorkspace = workspaces.find(
		(workspace) => workspace.workspaceHandle === currentWorkspaceHandle,
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
	const createSession = async () => {
		const previousSessionHandle = useSessionDirectoryStore.getState().currentSession?.sessionHandle;
		await newSession();
		if (useSessionDirectoryStore.getState().currentSession?.sessionHandle !== previousSessionHandle) {
			onSessionSelect?.();
		}
	};

	if (rail) {
		return (
			<nav aria-label={tt("sidebar.navAria")} className="flex h-full flex-col items-center gap-1 pt-0.5">
				{(onOpenNavigation || onToggleRail) && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								ref={navigationTriggerRef}
								type="button"
								aria-label={tt(onOpenNavigation ? "appShell.openSessions" : "appShell.expandSidebar")}
								className="group relative mb-2 flex size-10 items-center justify-center rounded-sm bg-primary-soft text-primary focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
								onClick={onOpenNavigation ?? onToggleRail}
							>
								<Bot className="size-5 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" />
								<PanelLeftOpen className="absolute size-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">
							{tt(onOpenNavigation ? "appShell.openSessions" : "appShell.expandSidebar")}
						</TooltipContent>
					</Tooltip>
				)}
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("sidebar.newSession")}
							disabled={!currentWorkspace?.available}
							className="flex size-10 items-center justify-center rounded-sm text-ink-2 hover:bg-hover disabled:opacity-40"
							onClick={() => void createSession()}
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
							className="flex size-10 items-center justify-center rounded-sm text-ink-2 hover:bg-hover"
							onClick={() => setAddOpen(true)}
						>
							<FolderPlus className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="right">{tt("sidebar.addWorkspace")}</TooltipContent>
				</Tooltip>
				<div className="flex-1" />
				<div className="flex h-12 w-full flex-none items-center justify-center border-t border-border">
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={tt("sidebar.switchTheme")}
								className="flex size-10 items-center justify-center rounded-sm text-ink-2 hover:bg-hover"
								onClick={cycleTheme}
							>
								<ThemeIcon className="size-4" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">{tt("sidebar.switchTheme")}</TooltipContent>
					</Tooltip>
				</div>
				<AddWorkspaceDialog open={addOpen} onOpenChange={setAddOpen} />
			</nav>
		);
	}

	return (
		<nav aria-label={tt("sidebar.navAria")} className="flex h-full flex-col">
			<div className="flex h-11 flex-none items-center gap-2 px-2">
				<div
					data-sidebar-brand-slot="true"
					className="flex size-10 items-center justify-center rounded-sm bg-primary-soft text-primary"
				>
					<Bot className="size-5" />
				</div>
				<span className="text-[13px] font-semibold text-ink">{tt("sidebar.brand")}</span>
				<div className="flex-1" />
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("sidebar.addWorkspace")}
							className={cn(
								"flex items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink",
								onRequestClose ? "size-10" : "size-7",
							)}
							onClick={() => setAddOpen(true)}
						>
							<FolderPlus className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent>{tt("sidebar.addWorkspace")}</TooltipContent>
				</Tooltip>
				{(onRequestClose || onToggleRail) && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={tt(onRequestClose ? "appShell.closeSessions" : "appShell.collapseSidebar")}
								className={cn(
									"flex items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none",
									onRequestClose ? "size-10" : "size-7",
								)}
								onClick={onRequestClose ?? onToggleRail}
							>
								<PanelLeftClose className="size-4" />
							</button>
						</TooltipTrigger>
						<TooltipContent>
							{tt(onRequestClose ? "appShell.closeSessions" : "appShell.collapseSidebar")}
						</TooltipContent>
					</Tooltip>
				)}
			</div>

			<div className="px-3 pt-2 pb-2">
				<Button
					variant="secondary"
					className={cn("w-full justify-start gap-1.5 text-[13px]", onRequestClose ? "h-10" : "h-8")}
					disabled={!currentWorkspace?.available}
					onClick={() => void createSession()}
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
						className={cn("pr-7 pl-8 text-[13px]", onRequestClose ? "h-10" : "h-7")}
					/>
				</div>
			</div>

			<div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-2 pb-2">
				{filtered !== null ? (
					filtered.length > 0 ? (
						<div className="flex flex-col">
							<div className="px-2 pt-1.5 pb-0.5 text-[11px] text-ink-3">
								{currentWorkspace?.displayName ? displayLabel(currentWorkspace.displayName) : ""}
							</div>
							<ul className="flex flex-col">
								{filtered.map((session) => (
									<SessionRow
										key={session.sessionHandle}
										session={session}
										current={currentSession?.sessionHandle === session.sessionHandle}
										comfortable={Boolean(onRequestClose)}
										onSelect={onSessionSelect}
									/>
								))}
							</ul>
						</div>
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
						{workspaces.map((workspace) => {
							const workspaceSessions = sessionsByWorkspace[workspace.workspaceHandle] ?? [];
							const catalogLoaded = Object.hasOwn(durableSessionsByWorkspace, workspace.workspaceHandle);
							const unpersistedHotCount = new Set(
								(hotSessionsByWorkspace[workspace.workspaceHandle] ?? [])
									.filter((session) => !session.persisted)
									.map((session) => session.sessionHandle),
							).size;
							return (
								<WorkspaceGroup
									key={workspace.workspaceHandle}
									workspace={workspace}
									sessions={workspaceSessions}
									sessionCount={
										catalogLoaded ? workspaceSessions.length : workspace.sessionCount + unpersistedHotCount
									}
									defaultExpanded={workspace.workspaceHandle === currentWorkspaceHandle}
									comfortable={Boolean(onRequestClose)}
									onSessionSelect={onSessionSelect}
								/>
							);
						})}
					</div>
				)}
			</div>

			<div className="flex h-12 flex-none items-center gap-1 border-t border-border px-2">
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("sidebar.switchTheme")}
							className="flex size-10 items-center justify-center rounded-sm text-ink-2 hover:bg-hover hover:text-ink"
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
				<div className="flex-1" />
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={tt("common.settings")}
							className="flex size-10 items-center justify-center rounded-sm text-ink-2 hover:bg-hover hover:text-ink"
							onClick={() => window.dispatchEvent(new CustomEvent("piweb:open-settings"))}
						>
							<Settings className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent>{tt("common.settings")}</TooltipContent>
				</Tooltip>
			</div>

			<AddWorkspaceDialog open={addOpen} onOpenChange={setAddOpen} />
		</nav>
	);
}
