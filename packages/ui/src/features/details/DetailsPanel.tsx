import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { expectData } from "@pi-agent-web/server/wire";
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
import { forkFromEntry } from "../../lib/session-controller";
import { cn } from "../../lib/utils";
import { useProjectionStore } from "../../stores/projection";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useTransportStore } from "../../stores/transport";
import { type RightPanelMode, useViewStore } from "../../stores/view";

const MODES: Array<{ mode: RightPanelMode; label: string; icon: typeof Wrench }> = [
	{ mode: "inspector", label: "检查", icon: Wrench },
	{ mode: "tree", label: "分支", icon: GitBranch },
	{ mode: "debug", label: "事件", icon: Bug },
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
		return (
			<p className="px-4 py-8 text-center text-[13px] text-ink-3">
				在对话中点击工具行的「检查」图标，在这里查看完整输出。
			</p>
		);
	}
	const block = selected.block;
	if (block.type !== "tool_call") return null;

	const resultText =
		selected.results[0]?.content ??
		(typeof block.result === "string"
			? block.result
			: typeof block.result === "object" && block.result !== null
				? JSON.stringify(block.result, null, 2)
				: (block.partialOutput ?? ""));

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
						? "生成参数"
						: block.status === "running"
							? "执行中"
							: block.status === "done"
								? "完成"
								: block.status === "error"
									? "出错"
									: "未执行"}
				</Badge>
			</div>
			<div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
				<div className="px-4 py-3">
					<p className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">参数</p>
					<pre className="scroll-slim max-h-64 overflow-y-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-[18px] whitespace-pre-wrap break-all text-ink-2">
						{block.argsText || JSON.stringify(block.args ?? {}, null, 2)}
					</pre>
				</div>
				<div className="px-4 py-3">
					<p className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">输出</p>
					<pre className="scroll-slim max-h-[420px] overflow-y-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-[18px] whitespace-pre-wrap break-all text-ink-2">
						{resultText || "（无输出）"}
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
				return content.slice(0, 60) || "用户消息";
			}
			if (message.role === "assistant") {
				const text = message.content
					.filter((b) => b.type === "text")
					.map((b) => (b as { text: string }).text)
					.join(" ");
				return text.slice(0, 60) || "助手回复";
			}
			return "role" in message && message.role === "toolResult" && "toolName" in message
				? String(message.toolName) + " 结果"
				: "工具结果";
		}
		case "thinking_level_change":
			return "思考级别 → " + entry.thinkingLevel;
		case "model_change":
			return "模型 → " + entry.provider + "/" + entry.modelId;
		case "compaction":
			return "上下文压缩";
		case "branch_summary":
			return "分支摘要";
		case "label":
			return entry.label ?? "标签";
		case "session_info":
			return entry.name ? "重命名 → " + entry.name : "会话信息";
		case "custom":
		case "custom_message":
			return "自定义条目";
		default:
			return "条目";
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
}: {
	node: SessionTreeNode;
	depth: number;
	leafId: string | null;
	onFork: (entryId: string) => void;
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
						当前
					</Badge>
				)}
				{isUserMessage && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label="从此处分叉"
								className="flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-primary"
								onClick={() => onFork(node.entry.id)}
							>
								<GitFork className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent>从这条消息分叉</TooltipContent>
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
						/>
					))}
				</div>
			)}
		</div>
	);
}

function TreeView() {
	const workspaceId = useSessionDirectoryStore((s) => s.currentWorkspaceId);
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
				<span className="text-[13px] font-medium text-ink">会话分支树</span>
				<div className="flex-1" />
				<Button variant="ghost" size="sm" onClick={() => void load()}>
					刷新
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
					<p className="px-2 py-6 text-center text-[12px] text-ink-3">当前会话没有条目</p>
				) : (
					tree.map((node) => (
						<TreeNodeView
							key={node.entry.id}
							node={node}
							depth={0}
							leafId={leafId}
							onFork={(id) => void fork(id)}
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
				<span className="text-[13px] font-medium text-ink">原始事件（最近 200 条）</span>
				<input
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="过滤事件类型…"
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
						{label}
					</button>
				))}
				<div className="flex-1" />
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={open ? "收起详情面板" : "展开详情面板"}
							className="flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
							onClick={onToggle}
						>
							{open ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
						</button>
					</TooltipTrigger>
					<TooltipContent>{open ? "收起" : "展开"}</TooltipContent>
				</Tooltip>
			</div>
			<div className="min-h-0 flex-1">
				{mode === "tree" ? <TreeView /> : mode === "debug" ? <DebugView /> : <InspectorView />}
			</div>
		</div>
	);
}
