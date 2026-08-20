import { memo, useMemo } from "react";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import type { AssistantStep, ContentBlock } from "../../types/view-models";
import { MarkdownBlock } from "./MarkdownBlock";
import { ReasoningDisclosure } from "./ReasoningDisclosure";
import { ToolCallRow } from "./ToolCallRow";

const EMPTY_RESULTS: import("../../types/view-models").UiToolResult[] = [];

const BlockView = memo(function BlockView({
	block,
	results,
	isLast,
}: {
	block: ContentBlock;
	results: import("../../types/view-models").UiToolResult[];
	isLast: boolean;
}) {
	switch (block.type) {
		case "thinking":
			return (
				<ReasoningDisclosure
					text={block.text}
					status={block.isStreaming ? "streaming" : "settled"}
					isTail={isLast && block.isStreaming}
				/>
			);
		case "text":
			return <MarkdownBlock text={block.markdown} streaming={block.isStreaming} />;
		case "tool_call":
			return <ToolCallRow block={block} results={results} />;
		default:
			return null;
	}
});

/**
 * One assistant response step: blocks in source order, then tool results.
 * Text blocks sit on the 748px reading axis; no bubble (DESIGN.md).
 */
export const AssistantStepView = memo(function AssistantStepView({
	step,
}: {
	turnId: string;
	step: AssistantStep;
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
			{step.blocks.map((block, index) => (
				<BlockView
					key={block.key}
					block={block}
					results={
						block.type === "tool_call"
							? (resultsByToolCallId.get(block.toolCallId) ?? EMPTY_RESULTS)
							: EMPTY_RESULTS
					}
					isLast={index === step.blocks.length - 1}
				/>
			))}
		</div>
	);
});
