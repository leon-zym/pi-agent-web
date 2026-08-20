import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { expectData } from "@pi-agent-web/protocol";
import {
	Bot,
	Bug,
	GitBranch,
	GitFork,
	ListTree,
	MessageSquare,
	PanelRightClose,
	PanelRightOpen,
	Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { stripAnsi } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { forkFromEntry } from "../../lib/session-controller";
import { cn } from "../../lib/utils";
import { useProjectionStore } from "../../stores/projection";
import { useSessionControlStore } from "../../stores/session-control";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useTransportStore } from "../../stores/transport";
import { type RightPanelMode, useViewStore } from "../../stores/view";

const MODES: Array<{ mode: RightPanelMode; label: string; icon: typeof Wrench }> = [
	{ mode: "inspector", label: "details.inspector", icon: Wrench },
	{ mode: "tree", label: "details.tree", icon: GitBranch },
	{ mode: "debug", label: "details.debug", icon: Bug },
];

function useSelectedToolBlock() {
	const selectedTool = useViewStore((s) => s.selectedTool);
	const selectedSessionId = useViewStore((s) => s.selectedToolSessionId);
	const projection = useProjectionStore((s) =>
		selectedSessionId ? s.projections[selectedSessionId] : undefined,
	);
	return useMemo(() => {
		if (!projection || !selectedTool) return undefined;
		for (const turn of projection.turns) {
			for (const step of turn.steps) {
				for (const block of step.blocks) {
					if (block.key === selectedTool) {
						const results = step.toolResults.filter(
							(r) => r.toolCallId === (block.type === "tool_call" ? block.toolCallId : ""),
						);
						return { block, results, step };
					}
				}
			}
		}
		return undefined;
	}, [projection, selectedTool]);
}

function InspectorView() {
	const selected = useSelectedToolBlock();
	if (!selected) {
		return <p className="px-4 py-8 text-center text-[13px] text-ink-3">{tt("details.inspectorEmpty")}</p>;
	}
	const block = selected.block;
	if (block.type !== "tool_call") return null;

	const resultText = stripAnsi(
		selected.results[0]?.content ??
			(typeof block.result === "string"
				? block.result
				: typeof block.result === "object" && block.result !== null
					? JSON.stringify(block.result, null, 2)
					: (block.partialOutput ?? "")),
	);

	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
				<Wrench className="size-4 text-ink-3" />
				<span className="font-mono text-[13px] font-medium text-ink">{block.toolName}</span>
				<div className="flex-1" />
				<Badge
					variant={
						block.status === "error"
							? "danger"
							: block.status === "done"
								? "success"
								: block.status === "running"
									? "primary"
									: "default"
					}
				>
					{block.status === "preparing"
						? tt("status.generatingArgs")
						: block.status === "running"
							? tt("status.executing")
							: block.status === "done"
								? tt("common.done")
								: block.status === "error"
									? tt("common.error")
									: tt("status.notExecuted")}
				</Badge>
			</div>
			<div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
				<div className="px-4 py-3">
					<p className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
						{tt("details.args")}
					</p>
					<pre className="scroll-slim max-h-64 overflow-y-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-[18px] whitespace-pre-wrap break-all text-ink-2">
						{stripAnsi(block.argsText || JSON.stringify(block.args ?? {}, null, 2))}
					</pre>
				</div>
				<div className="px-4 py-3">
					<p className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
						{tt("details.output")}
					</p>
					<pre className="scroll-slim max-h-[420px] overflow-y-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-[18px] whitespace-pre-wrap break-all text-ink-2">
						{resultText || tt("common.noOutput")}
					</pre>
				</div>
			</div>
		</div>
	);
}

function entryLabel(entry: SessionEntry): string {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "user") {
				const content =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((b) => b.type === "text")
								.map((b) => (b as { text: string }).text)
								.join(" ");
				return content.slice(0, 60) || tt("details.userMessage");
			}
			if (message.role === "assistant") {
				const text = message.content
					.filter((b) => b.type === "text")
					.map((b) => (b as { text: string }).text)
					.join(" ");
				return text.slice(0, 60) || tt("details.assistantReply");
			}
			return "role" in message && message.role === "toolResult" && "toolName" in message
				? String(message.toolName)
				: tt("details.toolResult");
		}
		case "thinking_level_change":
			return tt("details.levelChange", { level: entry.thinkingLevel });
		case "model_change":
			return tt("details.modelChange", { provider: entry.provider, model: entry.modelId });
		case "compaction":
			return tt("details.compaction");
		case "branch_summary":
			return tt("details.branchSummary");
		case "label":
			return entry.label ?? tt("details.labelEntry");
		case "session_info":
			return entry.name ? tt("details.renameTo", { name: entry.name }) : tt("details.sessionInfo");
		case "custom":
		case "custom_message":
			return tt("details.customEntry");
		default:
			return tt("details.customEntry");
	}
}

function entryIcon(entry: SessionEntry) {
	if (entry.type === "message" && entry.message.role === "user") return MessageSquare;
	if (entry.type === "message" && entry.message.role === "assistant") return Bot;
	if (entry.type === "model_change" || entry.type === "thinking_level_change") return ListTree;
	return ListTree;
}

function TreeNodeView({
	node,
	depth,
	leafId,
	onFork,
	canFork,
}: {
	node: SessionTreeNode;
	depth: number;
	leafId: string | null;
	onFork: (entryId: string) => void;
	canFork: boolean;
}) {
	const [expanded, setExpanded] = useState(depth < 2);
	const Icon = entryIcon(node.entry);
	const isLeaf = node.entry.id === leafId;
	const isUserMessage = node.entry.type === "message" && node.entry.message.role === "user";
	const hasChildren = node.children.length > 0;

	return (
		<div className="flex flex-col">
			<div
				className="group flex items-center gap-1 rounded-sm py-0.5 pr-1 hover:bg-hover"
				style={{ paddingLeft: depth * 14 }}
			>
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
					className="flex size-5 shrink-0 items-center justify-center text-ink-3 disabled:opacity-30"
					disabled={!hasChildren}
				>
					<ListTree
						className={cn(
							"size-3.5 transition-transform duration-200",
							hasChildren && expanded && "rotate-90",
						)}
					/>
				</button>
				<Icon className="size-3.5 shrink-0 text-ink-3" />
				<span
					className={cn(
						"min-w-0 flex-1 truncate text-[12px]",
						isLeaf ? "font-medium text-ink" : "text-ink-2",
					)}
				>
					{entryLabel(node.entry)}
				</span>
				{isLeaf && (
					<Badge variant="primary" className="shrink-0">
						{tt("details.current")}
					</Badge>
				)}
				{isUserMessage && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={tt("details.forkFromHere")}
								className="flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-30"
								onClick={() => onFork(node.entry.id)}
								disabled={!canFork}
							>
								<GitFork className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent>{tt("details.forkFromHere")}</TooltipContent>
					</Tooltip>
				)}
			</div>
			{expanded && hasChildren && (
				<div className="flex flex-col">
					{node.children.map((child) => (
						<TreeNodeView
							key={child.entry.id}
							node={child}
							depth={depth + 1}
							leafId={leafId}
							onFork={onFork}
							canFork={canFork}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function TreeView() {
	const workspaceId = useSessionDirectoryStore((s) => s.currentWorkspaceId);
	const canFork = useSessionControlStore((s) => s.canControl(workspaceId));
	const [tree, setTree] = useState<SessionTreeNode[]>([]);
	const [leafId, setLeafId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const load = async () => {
		if (!workspaceId) return;
		setLoading(true);
		try {
			const response = await useTransportStore.getState().sendCommand(workspaceId, { type: "get_tree" });
			const data = expectData(response) as { tree: SessionTreeNode[]; leafId: string | null };
			setTree(data.tree);
			setLeafId(data.leafId);
		} catch {
			// stale tree is better than a crash
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspaceId]);

	const fork = async (entryId: string) => {
		await forkFromEntry(entryId);
		await load();
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
				<GitBranch className="size-4 text-ink-3" />
				<span className="text-[13px] font-medium text-ink">{tt("details.treeTitle")}</span>
				<div className="flex-1" />
				<Button variant="ghost" size="sm" onClick={() => void load()}>
					{tt("details.refresh")}
				</Button>
			</div>
			<div className="scroll-slim min-h-0 flex-1 overflow-y-auto p-2">
				{loading ? (
					<div className="flex flex-col gap-2 p-2">
						<Skeleton className="h-6 w-full" />
						<Skeleton className="h-6 w-4/5" />
						<Skeleton className="h-6 w-3/5" />
					</div>
				) : tree.length === 0 ? (
					<p className="px-2 py-6 text-center text-[12px] text-ink-3">{tt("details.treeEmpty")}</p>
				) : (
					tree.map((node) => (
						<TreeNodeView
							key={node.entry.id}
							node={node}
							depth={0}
							leafId={leafId}
							onFork={(id) => void fork(id)}
							canFork={canFork}
						/>
					))
				)}
			</div>
		</div>
	);
}

function DebugView() {
	const rawEvents = useTransportStore((s) => s.rawEvents);
	const processStatus = useTransportStore((s) => s.processStatus);
	const [filter, setFilter] = useState("");
	const events = useMemo(
		() => rawEvents.filter((e) => !filter || e.eventType.includes(filter)),
		[rawEvents, filter],
	);
	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
				<Bug className="size-4 text-ink-3" />
				<span className="text-[13px] font-medium text-ink">{tt("details.debugTitle")}</span>
				<input
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder={tt("details.filterEvents")}
					className="ml-auto h-6 w-32 rounded-sm border border-border bg-surface px-2 text-xs text-ink outline-none placeholder:text-ink-3"
				/>
			</div>
			<div className="scroll-slim min-h-0 flex-1 overflow-y-auto p-2">
				<pre className="font-mono text-[11px] leading-[16px] whitespace-pre-wrap break-all text-ink-2">
					{JSON.stringify(processStatus, null, 2)}
					{"\n"}
					{events
						.map(
							(e) =>
								new Date(e.at).toISOString().slice(11, 19) +
								" [" +
								e.sessionId.slice(0, 8) +
								"] " +
								e.eventType,
						)
						.join("\n")}
				</pre>
			</div>
		</div>
	);
}

/**
 * Right details panel (DESIGN.md): inspector / branch tree / debug drawer.
 * The column width is owned by AppShell; closing keeps this subtree mounted.
 */
export function DetailsPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	const mode = useViewStore((s) => s.rightPanelMode);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-11 flex-none items-center gap-1 border-b border-border px-2">
				{MODES.map(({ mode: m, label, icon: Icon }) => (
					<button
						key={m}
						type="button"
						onClick={() => {
							useViewStore.getState().setRightPanelMode(m);
							if (!open) onToggle();
						}}
						className={cn(
							"flex h-7 items-center gap-1.5 rounded-sm px-2 text-[12px] transition-colors",
							mode === m ? "bg-hover font-medium text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2",
						)}
					>
						<Icon className="size-3.5" />
						{tt(label as never)}
					</button>
				))}
				<div className="flex-1" />
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={open ? tt("details.collapsePanel") : tt("details.expandPanel")}
							className="flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
							onClick={onToggle}
						>
							{open ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
						</button>
					</TooltipTrigger>
					<TooltipContent>{open ? tt("details.collapse") : tt("details.expand")}</TooltipContent>
				</Tooltip>
			</div>
			<div className="min-h-0 flex-1">
				{mode === "tree" ? <TreeView /> : mode === "debug" ? <DebugView /> : <InspectorView />}
			</div>
		</div>
	);
}
