import {
	expectCommandData,
	type SessionEntryDto,
	type SessionRuntimeIdentityDto,
} from "@pi-agent-web/protocol";
import {
	Bot,
	Brain,
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
import { runtimeIsReady } from "../../lib/runtime-state";
import { isSessionControlReady } from "../../lib/session-capabilities";
import { presentUserMessage, serializePresentedUserMessage } from "../../lib/user-message-presentation";
import { cn } from "../../lib/utils";
import { useProjectionStore } from "../../stores/projection";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { sessionTransport, useSessionTransportStore } from "../../stores/session-transport";
import type { SessionRawEventRecord } from "../../stores/session-transport-contract";
import { type RightPanelMode, useViewStore } from "../../stores/view";
import type { AssistantStep, ContentBlock, UiToolResult } from "../../types/view-models";
import { formatJsonCode, formatToolArguments, formatUnknownCode } from "../conversation/code-display";
import { HighlightedCode } from "../conversation/HighlightedCode";
import {
	createSessionRuntimeIdentity,
	type ToolCallBlock,
	useLazyToolContent,
} from "../conversation/use-lazy-tool-content";
import {
	type ConversationTreeRow,
	flattenConversationTree,
	pendingConversationTreeSnapshot,
	resolvedTreeNodeLabel,
	visibleConversationTreeSnapshot,
} from "./tree-model";

const MODES: Array<{ mode: RightPanelMode; label: string; icon: typeof Wrench }> = [
	{ mode: "inspector", label: "details.inspector", icon: Wrench },
	{ mode: "tree", label: "details.tree", icon: GitBranch },
	{ mode: "debug", label: "details.debug", icon: Bug },
];

interface SelectedToolBlock {
	block: ContentBlock;
	results: UiToolResult[];
	step: AssistantStep;
	sessionHandle: string | null;
	sessionIdentity: SessionRuntimeIdentityDto | null;
}

function useSelectedToolBlock(): SelectedToolBlock | undefined {
	const selectedTool = useViewStore((s) => s.selectedTool);
	const selectedSessionId = useViewStore((s) => s.selectedToolSessionId);
	const selectedChannel = useSessionTransportStore((state) =>
		selectedSessionId ? state.sessions[selectedSessionId] : undefined,
	);
	const projection = useProjectionStore((s) =>
		selectedSessionId ? s.projections[selectedSessionId] : undefined,
	);
	const sessionIdentity = useMemo(
		() => createSessionRuntimeIdentity(selectedChannel?.runtime, selectedSessionId),
		[
			selectedChannel?.runtime?.generation,
			selectedChannel?.runtime?.serverEpoch,
			selectedChannel?.runtime?.sessionHandle,
			selectedChannel?.runtime?.workspaceId,
			selectedSessionId,
		],
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
						return { block, results, step, sessionHandle: selectedSessionId, sessionIdentity };
					}
				}
			}
		}
		return undefined;
	}, [projection, selectedTool, selectedSessionId, sessionIdentity]);
}

function InspectorToolCall({
	block,
	results,
	sessionIdentity,
}: {
	block: ToolCallBlock;
	results: UiToolResult[];
	sessionIdentity: SelectedToolBlock["sessionIdentity"];
}) {
	const lazyContent = useLazyToolContent({
		enabled: true,
		identity: sessionIdentity,
		block,
		results,
	});
	if (lazyContent.status !== "ready") {
		return lazyContent.status === "error" ? (
			<p role="alert" className="px-4 py-8 text-center text-[12px] text-danger">
				{tt("tool.executionError")}
			</p>
		) : (
			<div role="status" className="px-4 py-8 text-center text-[12px] text-ink-3">
				{tt("common.loading")}
			</div>
		);
	}

	const materializedBlock = lazyContent.block;
	const materializedResults = lazyContent.results;
	const argsCode = formatToolArguments(materializedBlock.args, materializedBlock.argsText);
	const resultCode = formatUnknownCode(
		materializedResults[0]?.content ?? materializedBlock.result ?? materializedBlock.partialOutput ?? "",
	);

	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
				<Wrench className="size-4 text-ink-3" />
				<span className="font-mono text-[13px] font-medium text-ink">{materializedBlock.toolName}</span>
				<div className="flex-1" />
				<Badge
					variant={
						materializedBlock.status === "error"
							? "danger"
							: materializedBlock.status === "done"
								? "success"
								: materializedBlock.status === "running"
									? "primary"
									: "default"
					}
				>
					{materializedBlock.status === "preparing"
						? tt("status.generatingArgs")
						: materializedBlock.status === "running"
							? tt("status.executing")
							: materializedBlock.status === "done"
								? tt("common.done")
								: materializedBlock.status === "error"
									? tt("common.error")
									: tt("status.notExecuted")}
				</Badge>
			</div>
			<InspectorCodeSections argsCode={argsCode} resultCode={resultCode} />
		</div>
	);
}

function InspectorView({ open }: { open: boolean }) {
	const selected = useSelectedToolBlock();
	if (!open) return null;
	if (!selected) {
		return <p className="px-4 py-8 text-center text-[13px] text-ink-3">{tt("details.inspectorEmpty")}</p>;
	}
	const block = selected.block;
	if (block.type === "thinking") {
		return (
			<div className="flex h-full flex-col">
				<div className="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
					<Brain className="size-4 text-ink-3" />
					<span className="font-mono text-[13px] font-medium text-ink">{tt("status.thinking")}</span>
					<div className="flex-1" />
					<Badge variant={block.isStreaming ? "primary" : "default"}>
						{block.isStreaming ? tt("status.inProgress") : tt("status.thought")}
					</Badge>
				</div>
				<div
					data-details-output-region="true"
					className="scroll-slim flex min-h-0 flex-1 flex-col overflow-y-auto p-4 font-mono text-xs leading-[18px] whitespace-pre-wrap break-words text-ink-2"
				>
					{block.text}
				</div>
			</div>
		);
	}
	if (block.type !== "tool_call") return null;
	return (
		<InspectorToolCall block={block} results={selected.results} sessionIdentity={selected.sessionIdentity} />
	);
}

export function InspectorCodeSections({
	argsCode,
	resultCode,
}: {
	argsCode: ReturnType<typeof formatToolArguments>;
	resultCode: ReturnType<typeof formatUnknownCode>;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<section aria-label={tt("details.args")} className="flex max-h-[42%] flex-none flex-col px-4 py-3">
				<p className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
					{tt("details.args")}
				</p>
				<HighlightedCode code={argsCode.code} language={argsCode.language} className="min-h-0 max-h-64" />
			</section>
			<section
				aria-label={tt("details.output")}
				data-details-output-region="true"
				className="flex min-h-0 flex-1 flex-col border-t border-border px-4 py-3"
			>
				<p className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
					{tt("details.output")}
				</p>
				<HighlightedCode
					code={resultCode.code || tt("common.noOutput")}
					language={resultCode.code ? resultCode.language : undefined}
					className="min-h-0 flex-1 whitespace-pre-wrap break-words"
				/>
			</section>
		</div>
	);
}

function entryLabel(entry: SessionEntryDto): string {
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

function entryIcon(entry: SessionEntryDto) {
	if (entry.type === "message" && entry.message.role === "user") return MessageSquare;
	if (entry.type === "message" && entry.message.role === "assistant") return Bot;
	if (entry.type === "model_change" || entry.type === "thinking_level_change") return ListTree;
	return ListTree;
}

export function TreeNodeRow({
	row,
	onToggle,
	onFork,
	canFork,
}: {
	row: ConversationTreeRow;
	onToggle: (entryId: string) => void;
	onFork: (entryId: string) => void;
	canFork: boolean;
}) {
	const Icon = entryIcon(row.node.entry);
	const isUserMessage = row.node.entry.type === "message" && row.node.entry.message.role === "user";
	const label = resolvedTreeNodeLabel(row.node, entryLabel);

	return (
		<div
			data-active-path={row.isOnActivePath ? "true" : undefined}
			data-tree-depth={row.depth}
			className={cn(
				"group flex min-h-7 min-w-0 items-center gap-1 rounded-sm px-1 hover:bg-hover focus-within:bg-hover",
				row.isOnActivePath && !row.isLeaf && "bg-primary-soft/35",
				row.isLeaf && "bg-primary-soft",
				!row.isOnActivePath && "opacity-60 hover:opacity-100 focus-within:opacity-100",
			)}
		>
			{row.foldable ? (
				<button
					type="button"
					aria-expanded={!row.collapsed}
					aria-label={tt(row.collapsed ? "details.expand" : "details.collapse")}
					onClick={() => onToggle(row.node.entry.id)}
					className="flex size-10 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40"
				>
					<ChevronRight className={cn("size-3.5", !row.collapsed && "rotate-90")} />
				</button>
			) : (
				<span aria-hidden="true" className="size-10 shrink-0" />
			)}
			{row.prefix && (
				<span
					aria-hidden="true"
					className="shrink-0 whitespace-pre font-mono text-[11px] leading-none text-ink-3"
				>
					{row.prefix}
				</span>
			)}
			<span
				aria-hidden="true"
				className={cn("size-1.5 shrink-0 rounded-full", row.isOnActivePath ? "bg-primary" : "bg-transparent")}
			/>
			<Icon className={cn("size-3.5 shrink-0", row.isOnActivePath ? "text-primary" : "text-ink-3")} />
			<span
				title={label}
				className={cn(
					"min-w-0 flex-1 truncate text-[12px]",
					row.isLeaf ? "font-medium text-ink" : "text-ink-2",
				)}
			>
				{label}
			</span>
			{row.isLeaf && (
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
							className="flex size-10 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-70 hover:bg-hover hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-30"
							onClick={() => onFork(row.node.entry.id)}
							disabled={!canFork}
						>
							<GitFork className="size-3.5" />
						</button>
					</TooltipTrigger>
					<TooltipContent>{tt("details.forkFromHere")}</TooltipContent>
				</Tooltip>
			)}
		</div>
	);
}

function TreeView() {
	const sessionHandle = useSessionDirectoryStore((s) => s.currentSession?.sessionHandle ?? null);
	const channel = useSessionTransportStore((state) =>
		sessionHandle ? state.sessions[sessionHandle] : undefined,
	);
	const connectionState = useSessionTransportStore((state) => state.connectionState);
	const channelReady = Boolean(
		sessionHandle && connectionState === "online" && channel?.subscribed && channel.generation !== null,
	);
	const canFork = isSessionControlReady(channel) && runtimeIsReady(channel?.runtime);
	const [snapshot, setSnapshot] = useState(() => pendingConversationTreeSnapshot(sessionHandle));
	const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
	const requestRef = useRef(0);
	const matchingSnapshot = visibleConversationTreeSnapshot(snapshot, sessionHandle);
	const visibleSnapshot =
		sessionHandle && !channelReady ? pendingConversationTreeSnapshot(sessionHandle) : matchingSnapshot;
	const rows = useMemo(
		() => flattenConversationTree(visibleSnapshot.tree, visibleSnapshot.leafId, collapsedIds),
		[visibleSnapshot.tree, visibleSnapshot.leafId, collapsedIds],
	);

	const load = async (targetSessionHandle = sessionHandle) => {
		if (!targetSessionHandle) {
			requestRef.current += 1;
			setSnapshot(pendingConversationTreeSnapshot(null));
			return;
		}
		const targetChannel = sessionTransport.store.getState().sessions[targetSessionHandle];
		if (
			sessionTransport.store.getState().connectionState !== "online" ||
			!targetChannel?.subscribed ||
			targetChannel.generation === null
		) {
			requestRef.current += 1;
			setSnapshot(pendingConversationTreeSnapshot(targetSessionHandle));
			return;
		}
		const request = ++requestRef.current;
		setSnapshot(pendingConversationTreeSnapshot(targetSessionHandle));
		try {
			const response = await sessionTransport.store
				.getState()
				.sendCommand(targetSessionHandle, { type: "get_tree" });
			const data = expectCommandData(response, "get_tree");
			if (
				request !== requestRef.current ||
				useSessionDirectoryStore.getState().currentSession?.sessionHandle !== targetSessionHandle
			) {
				return;
			}
			setSnapshot({
				sessionHandle: targetSessionHandle,
				status: "ready",
				tree: data.tree,
				leafId: data.leafId,
			});
		} catch (error) {
			if (
				request !== requestRef.current ||
				useSessionDirectoryStore.getState().currentSession?.sessionHandle !== targetSessionHandle
			) {
				return;
			}
			setSnapshot({
				sessionHandle: targetSessionHandle,
				status: "error",
				tree: [],
				leafId: null,
				error: displayError(error),
			});
		}
	};

	useEffect(() => {
		if (!sessionHandle || !channelReady) {
			requestRef.current += 1;
			setSnapshot(pendingConversationTreeSnapshot(sessionHandle));
			return;
		}
		void load(sessionHandle);
		return () => {
			requestRef.current += 1;
		};
	}, [sessionHandle, channelReady, channel?.generation]);

	useEffect(() => {
		setCollapsedIds(new Set());
	}, [sessionHandle]);

	const fork = async (entryId: string) => {
		const targetSessionHandle = sessionHandle;
		if (!targetSessionHandle || !canFork) return;
		try {
			const response = await sessionTransport.store
				.getState()
				.sendCommand(targetSessionHandle, { type: "fork", entryId });
			const data = expectCommandData(response, "fork");
			if (data.cancelled) {
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
			<div className="flex flex-none items-center gap-2 border-b border-border px-4 py-2.5">
				<GitBranch className="size-4 shrink-0 text-ink-3" />
				<div className="min-w-0 flex-1">
					<p className="text-[13px] font-medium text-ink">{tt("details.treeTitle")}</p>
					<p className="truncate text-[11px] leading-4 text-ink-3" title={tt("details.treeDescription")}>
						{tt("details.treeDescription")}
					</p>
				</div>
				<Button
					variant="ghost"
					size="sm"
					className="h-10"
					disabled={!channelReady || visibleSnapshot.status === "loading"}
					onClick={() => void load()}
				>
					{tt("details.refresh")}
				</Button>
			</div>
			<div
				aria-busy={visibleSnapshot.status === "loading"}
				data-tree-load-status={visibleSnapshot.status}
				className="scroll-slim min-h-0 flex-1 overflow-y-auto p-2"
			>
				{visibleSnapshot.status === "loading" ? (
					<div className="flex flex-col gap-2 p-2">
						<Skeleton className="h-6 w-full" />
						<Skeleton className="h-6 w-4/5" />
						<Skeleton className="h-6 w-3/5" />
					</div>
				) : visibleSnapshot.status === "error" ? (
					<p role="alert" className="px-2 py-6 text-center text-[12px] text-danger">
						{visibleSnapshot.error}
					</p>
				) : rows.length === 0 ? (
					<p className="px-2 py-6 text-center text-[12px] text-ink-3">{tt("details.treeEmpty")}</p>
				) : (
					<div className="flex min-w-0 flex-col gap-0.5">
						{rows.map((row) => (
							<TreeNodeRow
								key={row.node.entry.id}
								row={row}
								onToggle={(id) =>
									setCollapsedIds((current) => {
										const next = new Set(current);
										if (next.has(id)) next.delete(id);
										else next.add(id);
										return next;
									})
								}
								onFork={(id) => void fork(id)}
								canFork={canFork}
							/>
						))}
					</div>
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
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
				<HighlightedCode
					code={runtimeCode}
					language="json"
					className="max-h-[38%] flex-none text-[11px] leading-4"
				/>
				<DebugEventsRegion
					events={events}
					expandedEventKey={expandedEventKey}
					onExpandedEventKeyChange={setExpandedEventKey}
				/>
			</div>
		</div>
	);
}

export function DebugEventsRegion({
	events,
	expandedEventKey,
	onExpandedEventKeyChange,
}: {
	events: SessionRawEventRecord[];
	expandedEventKey: string | null;
	onExpandedEventKeyChange: (eventKey: string | null) => void;
}) {
	return (
		<div
			data-details-raw-events-region="true"
			className="scroll-slim mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1"
		>
			{events.map((event) => {
				const eventKey = `${String(event.generation)}:${String(event.seq)}`;
				const expanded = eventKey === expandedEventKey;
				return (
					<DebugEventRow
						key={eventKey}
						event={event}
						expanded={expanded}
						onToggle={() => onExpandedEventKeyChange(expanded ? null : eventKey)}
					/>
				);
			})}
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
			<div className="flex h-12 min-w-0 flex-none items-center gap-1 border-b border-border px-2 lg:h-11">
				<fieldset
					data-details-tabs="true"
					aria-label={tt("appShell.detailsTitle")}
					className="m-0 flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden border-0 p-0"
				>
					{MODES.map(({ mode: m, label, icon: Icon }) => (
						<button
							key={m}
							type="button"
							title={tt(label as never)}
							aria-pressed={mode === m}
							onClick={() => {
								useViewStore.getState().setRightPanelMode(m);
								if (!open) onToggle();
							}}
							className={cn(
								"flex h-10 items-center justify-center gap-1 rounded-sm px-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none",
								m === "tree" ? "min-w-0 flex-1" : "shrink-0",
								mode === m ? "bg-hover font-medium text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2",
							)}
						>
							<Icon className="size-3.5 shrink-0" />
							<span data-details-tab-label="true" className="min-w-0 whitespace-nowrap">
								{tt(label as never)}
							</span>
						</button>
					))}
				</fieldset>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={open ? tt("details.collapsePanel") : tt("details.expandPanel")}
							data-details-collapse="true"
							className="flex size-10 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
							onClick={onToggle}
						>
							{open ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
						</button>
					</TooltipTrigger>
					<TooltipContent>{open ? tt("details.collapse") : tt("details.expand")}</TooltipContent>
				</Tooltip>
			</div>
			<div className="min-h-0 flex-1">
				{mode === "tree" ? <TreeView /> : mode === "debug" ? <DebugView /> : <InspectorView open={open} />}
			</div>
		</div>
	);
}
