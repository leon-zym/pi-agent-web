import type { SessionRuntimeIdentityDto } from "@pi-agent-web/protocol";
import { memo, useMemo } from "react";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import type { AssistantStep, ContentBlock } from "../../types/view-models";
import { MarkdownBlock } from "./MarkdownBlock";
import { ReasoningDisclosure } from "./ReasoningDisclosure";
import { ToolCallRow } from "./ToolCallRow";
import { ToolGroupView } from "./ToolGroupView";

const EMPTY_RESULTS: import("../../types/view-models").UiToolResult[] = [];

const BlockView = memo(function BlockView({
	block,
	results,
	isLast,
	sessionHandle,
	sessionIdentity,
}: {
	block: ContentBlock;
	results: import("../../types/view-models").UiToolResult[];
	isLast: boolean;
	sessionHandle?: string | null;
	sessionIdentity?: SessionRuntimeIdentityDto | null;
}) {
	switch (block.type) {
		case "thinking":
			return (
				<ReasoningDisclosure
					blockKey={block.key}
					text={block.text}
					status={block.isStreaming ? "streaming" : "settled"}
					isTail={isLast && block.isStreaming}
				/>
			);
		case "text":
			return <MarkdownBlock text={block.markdown} streaming={block.isStreaming} />;
		case "tool_call":
			return (
				<ToolCallRow
					block={block}
					results={results}
					sessionHandle={sessionHandle}
					sessionIdentity={sessionIdentity}
				/>
			);
		default:
			return null;
	}
});

type GroupedBlockItem =
	| { type: "single"; block: ContentBlock; isLast: boolean }
	| { type: "tool_group"; key: string; tools: Array<Extract<ContentBlock, { type: "tool_call" }>> };

/**
 * One assistant response step: blocks in source order, then tool results.
 * Text blocks sit on the reading axis without a bubble.
 * When settled, >2 consecutive tool calls are aggregated into a ToolGroupView.
 */
export const AssistantStepView = memo(function AssistantStepView({
	step,
	sessionHandle,
	sessionIdentity,
}: {
	turnId: string;
	step: AssistantStep;
	sessionHandle?: string | null;
	sessionIdentity?: SessionRuntimeIdentityDto | null;
}) {
	const resultsByToolCallId = useMemo(() => {
		const index = new Map<string, import("../../types/view-models").UiToolResult[]>();
		for (const result of step.toolResults) {
			const results = index.get(result.toolCallId);
			if (results) results.push(result);
			else index.set(result.toolCallId, [result]);
		}
		return index;
	}, [step.toolResults]);

	const stepDurationMs = useMemo(() => {
		if (step.timing?.startTime && step.timing?.endTime) {
			return Math.max(0, step.timing.endTime - step.timing.startTime);
		}
		return undefined;
	}, [step.timing]);

	const groupedItems = useMemo<GroupedBlockItem[]>(() => {
		if (!step.isSettled) {
			return step.blocks.map((block, index) => ({
				type: "single",
				block,
				isLast: index === step.blocks.length - 1,
			}));
		}

		const items: GroupedBlockItem[] = [];
		let currentToolGroup: Array<Extract<ContentBlock, { type: "tool_call" }>> = [];

		const flushToolGroup = () => {
			if (currentToolGroup.length === 0) return;
			if (currentToolGroup.length > 2) {
				items.push({
					type: "tool_group",
					key: `group:${currentToolGroup[0]!.key}`,
					tools: currentToolGroup,
				});
			} else {
				for (let i = 0; i < currentToolGroup.length; i++) {
					items.push({
						type: "single",
						block: currentToolGroup[i]!,
						isLast: false,
					});
				}
			}
			currentToolGroup = [];
		};

		for (let i = 0; i < step.blocks.length; i++) {
			const block = step.blocks[i]!;
			if (block.type === "tool_call") {
				currentToolGroup.push(block);
			} else {
				flushToolGroup();
				items.push({
					type: "single",
					block,
					isLast: i === step.blocks.length - 1,
				});
			}
		}
		flushToolGroup();

		return items;
	}, [step.blocks, step.isSettled]);

	if (step.blocks.length === 0 && step.toolResults.length === 0) {
		// Streaming gap between turns: show a working indicator line.
		return (
			<div className="flex items-center gap-2 py-1 text-[13px] text-ink-3">
				<span className="size-1.5 rounded-full bg-primary pulse-dot" />
				<span>{tt("common.processing")}</span>
			</div>
		);
	}

	return (
		<div className={cn("flex min-w-0 max-w-full flex-col gap-3")}>
			{groupedItems.map((item) => {
				if (item.type === "tool_group") {
					return (
						<ToolGroupView
							key={item.key}
							tools={item.tools}
							resultsByToolCallId={resultsByToolCallId}
							durationMs={stepDurationMs}
							sessionHandle={sessionHandle}
							sessionIdentity={sessionIdentity}
						/>
					);
				}

				const block = item.block;
				return (
					<BlockView
						key={block.key}
						block={block}
						results={
							block.type === "tool_call"
								? (resultsByToolCallId.get(block.toolCallId) ?? EMPTY_RESULTS)
								: EMPTY_RESULTS
						}
						isLast={item.isLast}
						sessionHandle={sessionHandle}
						sessionIdentity={sessionIdentity}
					/>
				);
			})}
		</div>
	);
});
