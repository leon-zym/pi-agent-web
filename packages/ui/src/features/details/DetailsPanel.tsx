import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { expectData } from "@pi-agent-web/protocol";
import {
	Bot,
	Bug,
	ChevronRight,
	GitBranch,
	GitFork,
	ListTree,
	MessageSquare,
	PanelRightClose,
	PanelRightOpen,
	Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { displayError, displayLabel } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { presentUserMessage, serializePresentedUserMessage } from "../../lib/user-message-presentation";
import { cn } from "../../lib/utils";
import { useProjectionStore } from "../../stores/projection";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { sessionTransport, useSessionTransportStore } from "../../stores/session-transport";
import type { SessionRawEventRecord } from "../../stores/session-transport-contract";
import { type RightPanelMode, useViewStore } from "../../stores/view";
import { formatJsonCode, formatToolArguments, formatUnknownCode } from "../conversation/code-display";
import { HighlightedCode } from "../conversation/HighlightedCode";
import { activeTreeEntryIds, resolvedTreeNodeLabel } from "./tree-model";

const MODES: Array<{ mode: RightPanelMode; label: string; icon: typeof Wrench }> = [
	{ mode: "inspector", label: "details.inspector", icon: Wrench },
	{ mode: "tree", label: "details.tree", icon: GitBranch },
	{ mode: "debug", label: "details.debug", icon: Bug },
];

function useSelectedToolBlock() {
	const selectedTool = useViewStore((s) => s.selectedTool);
	const selectedSessionId = useViewStore((s) => s.selectedToolSessionId);
	const currentSessionHandle = useSessionDirectoryStore((s) => s.currentSession?.sessionHandle ?? null);
	const projection = useProjectionStore((s) =>
		selectedSessionId && selectedSessionId === currentSessionHandle
			? s.projections[selectedSessionId]
			: undefined,
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

	const argsCode = formatToolArguments(block.args, block.argsText);
	const resultCode = formatUnknownCode(
		selected.results[0]?.content ?? block.result ?? block.partialOutput ?? "",
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
					<HighlightedCode code={argsCode.code} language={argsCode.language} className="max-h-64" />
				</div>
				<div className="px-4 py-3">
					<p className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
						{tt("details.output")}
					</p>
					<HighlightedCode
						code={resultCode.code || tt("common.noOutput")}
						language={resultCode.code ? resultCode.language : undefined}
						className="max-h-[420px] whitespace-pre-wrap break-words"
					/>
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
				const rawContent =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((b) => b.type === "text")
								.map((b) => (b as { text: string }).text)
								.join(" ");
				const content = serializePresentedUserMessage(presentUserMessage(rawContent));
				return displayLabel(content).slice(0, 60) || tt("details.userMessage");
			}
			if (message.role === "assistant") {
				const text = message.content
					.filter((b) => b.type === "text")
					.map((b) => (b as { text: string }).text)
					.join(" ");
				return displayLabel(text).slice(0, 60) || tt("details.assistantReply");
			}
			return "role" in message && message.role === "toolResult" && "toolName" in message
				? displayLabel(String(message.toolName))
				: tt("details.toolResult");
		}
		case "thinking_level_change":
			return tt("details.levelChange", { level: displayLabel(entry.thinkingLevel) });
		case "model_change":
			return tt("details.modelChange", {
				provider: displayLabel(entry.provider),
				model: displayLabel(entry.modelId),
			});
		case "compaction":
			return tt("details.compaction");
		case "branch_summary":
			return tt("details.branchSummary");
		case "label":
			return entry.label ? displayLabel(entry.label) : tt("details.labelEntry");
		case "session_info":
			return entry.name
				? tt("details.renameTo", { name: displayLabel(entry.name) })
				: tt("details.sessionInfo");
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
	activePathIds,
	onFork,
	canFork,
}: {
	node: SessionTreeNode;
	depth: number;
	leafId: string | null;
	activePathIds: Set<string>;
	onFork: (entryId: string) => void;
	canFork: boolean;
}) {
	const Icon = entryIcon(node.entry);
	const isLeaf = node.entry.id === leafId;
	const isOnActivePath = activePathIds.has(node.entry.id);
	const [expanded, setExpanded] = useState(depth < 2 || isOnActivePath);
	const isUserMessage = node.entry.type === "message" && node.entry.message.role === "user";
	const hasChildren = node.children.length > 0;
	useEffect(() => {
		if (isOnActivePath) setExpanded(true);
	}, [isOnActivePath]);

	return (
		<div className="flex flex-col">
			<div
				data-active-path={isOnActivePath ? "true" : undefined}
				className={cn(
					"group flex items-center gap-1 rounded-sm py-0.5 pr-1 hover:bg-hover focus-within:bg-hover",
					isOnActivePath && !isLeaf && "bg-primary-soft/35",
					isLeaf && "bg-primary-soft",
				)}
				style={{ paddingLeft: depth * 14 }}
			>
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
					className="flex size-5 shrink-0 items-center justify-center text-ink-3 disabled:opacity-30"
					disabled={!hasChildren}
				>
					<ChevronRight
						className={cn(
							"size-3.5 transition-transform duration-200 motion-reduce:transition-none",
							!hasChildren && "invisible",
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
					{resolvedTreeNodeLabel(node, entryLabel)}
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
								className="flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-70 hover:bg-hover hover:text-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
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
							activePathIds={activePathIds}
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
	const sessionHandle = useSessionDirectoryStore((s) => s.currentSession?.sessionHandle ?? null);
	const channel = useSessionTransportStore((state) =>
		sessionHandle ? state.sessions[sessionHandle] : undefined,
	);
	const canFork = Boolean(
		channel?.subscribed &&
			channel.generation !== null &&
			channel.lease.isController &&
			channel.lease.fencingToken &&
			channel.runtime?.state === "idle",
	);
	const [tree, setTree] = useState<SessionTreeNode[]>([]);
	const [leafId, setLeafId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const requestRef = useRef(0);
	const activePathIds = useMemo(() => activeTreeEntryIds(tree, leafId), [tree, leafId]);

	const load = async (targetSessionHandle = sessionHandle) => {
		const request = ++requestRef.current;
		if (!targetSessionHandle) {
			setTree([]);
			setLeafId(null);
			setLoading(false);
			return;
		}
		setLoading(true);
		try {
			const response = await sessionTransport.store
				.getState()
				.sendCommand(targetSessionHandle, { type: "get_tree" });
			const data = expectData(response) as { tree: SessionTreeNode[]; leafId: string | null };
			if (
				request !== requestRef.current ||
				useSessionDirectoryStore.getState().currentSession?.sessionHandle !== targetSessionHandle
			) {
				return;
			}
			setTree(data.tree);
			setLeafId(data.leafId);
		} catch {
			// stale tree is better than a crash
		} finally {
			if (request === requestRef.current) setLoading(false);
		}
	};

	useEffect(() => {
		void load(sessionHandle);
		return () => {
			requestRef.current += 1;
		};
	}, [sessionHandle]);

	const fork = async (entryId: string) => {
		const targetSessionHandle = sessionHandle;
		if (!targetSessionHandle || !canFork) return;
		try {
			const response = await sessionTransport.store
				.getState()
				.sendCommand(targetSessionHandle, { type: "fork", entryId });
			const data = expectData(response) as { cancelled?: boolean } | undefined;
			if (data?.cancelled) {
				toast.info(tt("session.forkCancelled"));
				return;
			}
			toast.success(tt("session.forked"));
			if (useSessionDirectoryStore.getState().currentSession?.sessionHandle === targetSessionHandle) {
				await load(targetSessionHandle);
			}
		} catch (error) {
			toast.error(tt("session.forkFailed"), {
				description: displayError(error),
			});
		}
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-none items-start gap-2 border-b border-border px-4 py-3">
				<GitBranch className="mt-0.5 size-4 shrink-0 text-ink-3" />
				<div className="min-w-0 flex-1">
					<p className="text-[13px] font-medium text-ink">{tt("details.treeTitle")}</p>
					<p className="mt-0.5 text-[11px] leading-4 text-ink-3">{tt("details.treeDescription")}</p>
				</div>
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
							activePathIds={activePathIds}
							onFork={(id) => void fork(id)}
							canFork={canFork}
						/>
					))
				)}
			</div>
		</div>
	);
}

export function DebugEventRow({
	event,
	expanded,
	onToggle,
}: {
	event: SessionRawEventRecord;
	expanded: boolean;
	onToggle: () => void;
}) {
	const eventKey = `${String(event.generation)}:${String(event.seq)}`;
	return (
		<div className="overflow-hidden rounded-md border border-border bg-surface">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={onToggle}
				className="flex w-full items-center gap-2 px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40"
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 text-ink-3 transition-transform motion-reduce:transition-none",
						expanded && "rotate-90",
					)}
				/>
				<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">{event.eventType}</span>
				<span className="shrink-0 font-mono text-[10px] text-ink-3">
					{new Date(event.receivedAt).toISOString().slice(11, 19)} · {event.generation}:{event.seq}
				</span>
			</button>
			{expanded && (
				<div className="border-t border-border p-2" data-event-payload={eventKey}>
					<p className="mb-1.5 text-[10px] font-medium tracking-wide text-ink-3 uppercase">
						{tt("details.eventPayload")}
					</p>
					<HighlightedCode
						code={formatJsonCode(event.payload)}
						language="json"
						className="max-h-80 text-[11px] leading-4"
					/>
				</div>
			)}
		</div>
	);
}

function DebugView() {
	const currentSession = useSessionDirectoryStore((s) => s.currentSession);
	const sessionHandle = currentSession?.sessionHandle ?? null;
	const channel = useSessionTransportStore((state) =>
		sessionHandle ? state.sessions[sessionHandle] : undefined,
	);
	const [filter, setFilter] = useState("");
	const [expandedEventKey, setExpandedEventKey] = useState<string | null>(null);
	const events = useMemo(
		() => (channel?.rawEvents ?? []).filter((event) => !filter || event.eventType.includes(filter)),
		[channel?.rawEvents, filter],
	);
	const runtime = channel?.runtime ?? currentSession?.runtime ?? null;
	const runtimeCode = formatJsonCode({
		sessionHandle,
		generation: channel?.generation ?? null,
		lastSeq: channel?.lastSeq ?? 0,
		controller: channel?.lease.isController ?? false,
		runtime,
	});
	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
				<Bug className="size-4 text-ink-3" />
				<span className="text-[13px] font-medium text-ink">{tt("details.debugTitle")}</span>
				<input
					aria-label={tt("details.filterEvents")}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder={tt("details.filterEvents")}
					className="ml-auto h-6 w-32 rounded-sm border border-border bg-surface px-2 text-xs text-ink outline-none placeholder:text-ink-3"
				/>
			</div>
			<div className="scroll-slim min-h-0 flex-1 overflow-y-auto p-2">
				<HighlightedCode code={runtimeCode} language="json" className="max-h-64 text-[11px] leading-4" />
				<div className="mt-2 flex flex-col gap-1">
					{events.map((event) => {
						const eventKey = `${String(event.generation)}:${String(event.seq)}`;
						const expanded = eventKey === expandedEventKey;
						return (
							<DebugEventRow
								key={eventKey}
								event={event}
								expanded={expanded}
								onToggle={() => setExpandedEventKey(expanded ? null : eventKey)}
							/>
						);
					})}
				</div>
			</div>
		</div>
	);
}

/**
 * Right details panel (DESIGN.md): inspector / conversation tree / debug drawer.
 * The column width is owned by AppShell; closing keeps this subtree mounted.
 */
export function DetailsPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	const mode = useViewStore((s) => s.rightPanelMode);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-12 flex-none items-center gap-1 border-b border-border px-2 lg:h-11">
				{MODES.map(({ mode: m, label, icon: Icon }) => (
					<button
						key={m}
						type="button"
						onClick={() => {
							useViewStore.getState().setRightPanelMode(m);
							if (!open) onToggle();
						}}
						className={cn(
							"flex h-10 items-center gap-1.5 rounded-sm px-2 text-[12px] transition-colors lg:h-7",
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
							className="flex size-10 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink lg:size-7"
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
