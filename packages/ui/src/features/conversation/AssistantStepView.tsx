import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import type { AssistantStep, ContentBlock } from "../../types/view-models";
import { MarkdownBlock } from "./MarkdownBlock";
import { ReasoningDisclosure } from "./ReasoningDisclosure";
import { ToolCallRow } from "./ToolCallRow";

function BlockView({
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
}

/**
 * One assistant response step: blocks in source order, then tool results.
 * Text blocks sit on the 748px reading axis; no bubble (DESIGN.md).
 */
export function AssistantStepView({ step }: { turnId: string; step: AssistantStep }) {
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
		<div className={cn("flex flex-col gap-3")}>
			{step.blocks.map((block, index) => (
				<BlockView
					key={block.key}
					block={block}
					results={step.toolResults.filter(
						(r) => r.toolCallId === (block.type === "tool_call" ? block.toolCallId : ""),
					)}
					isLast={index === step.blocks.length - 1}
				/>
			))}
		</div>
	);
}
