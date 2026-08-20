import type { ReactNode } from "react";
import { stripAnsi } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import type { ContentBlock, UiToolResult } from "../../types/view-models";

/**
 * Tool presenter registry: a dedicated compact renderer per
 * tool plus a universal fallback so unknown tools never break the chat.
 * Presenters never execute tools; they only format already-captured data.
 */

export type ToolCallBlock = Extract<ContentBlock, { type: "tool_call" }>;

export interface ToolPresenterContext {
	block: ToolCallBlock;
	results: UiToolResult[];
}

export interface ToolPresenter {
	/** One-line summary shown on the collapsed row. */
	summarize(ctx: ToolPresenterContext): string;
	/** Optional expanded body; falls back to the generic renderer. */
	renderBody?(ctx: ToolPresenterContext): ReactNode;
}

function argString(args: unknown, keys: string[]): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function resultText(ctx: ToolPresenterContext): string {
	const result = ctx.results[0];
	if (!result) return "";
	return result.content;
}

function diffFromDetails(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = value as Record<string, unknown>;
	return typeof details.diff === "string" && details.diff.length > 0 ? stripAnsi(details.diff) : undefined;
}

function editDiff(ctx: ToolPresenterContext): string | undefined {
	for (const result of ctx.results) {
		const diff = diffFromDetails(result.details);
		if (diff) return diff;
	}
	if (typeof ctx.block.result !== "object" || ctx.block.result === null) return undefined;
	return diffFromDetails((ctx.block.result as Record<string, unknown>).details);
}

function DiffBody({ diff }: { diff: string }) {
	return (
		<section aria-label={tt("tool.diff")}>
			<pre className="scroll-slim max-h-[360px] overflow-auto rounded-md border border-border bg-surface-2 py-2 font-mono text-xs leading-[18px] text-ink-2">
				{diff.split("\n").map((line, index) => {
					const kind =
						line.startsWith("+") && !line.startsWith("+++")
							? "add"
							: line.startsWith("-") && !line.startsWith("---")
								? "delete"
								: line.startsWith("@@")
									? "hunk"
									: "context";
					return (
						<span
							key={`${String(index)}:${line}`}
							data-diff-kind={kind}
							className={cn(
								"block min-h-[18px] whitespace-pre px-3",
								kind === "add" && "bg-success/10 text-success",
								kind === "delete" && "bg-danger/10 text-danger",
								kind === "hunk" && "text-primary",
								kind === "context" && "text-ink-3",
							)}
						>
							{line || " "}
						</span>
					);
				})}
			</pre>
		</section>
	);
}

const bashPresenter: ToolPresenter = {
	summarize: (ctx) => {
		const command = argString(ctx.block.args, ["command"]);
		return command ?? "bash";
	},
};

const readPresenter: ToolPresenter = {
	summarize: (ctx) => {
		const path = argString(ctx.block.args, ["file_path", "path"]);
		return path ?? "read";
	},
};

const editPresenter: ToolPresenter = {
	summarize: (ctx) => {
		const path = argString(ctx.block.args, ["file_path", "path"]);
		const description = argString(ctx.block.args, ["description"]);
		return path ? (description ? `${path} · ${description}` : path) : "edit";
	},
	renderBody: (ctx) => {
		const diff = editDiff(ctx);
		return diff ? <DiffBody diff={diff} /> : null;
	},
};

const grepPresenter: ToolPresenter = {
	summarize: (ctx) => argString(ctx.block.args, ["pattern"]) ?? "grep",
};

const genericPresenter: ToolPresenter = {
	summarize: (ctx) => {
		const text =
			argString(ctx.block.args, ["description", "command", "path", "url", "query", "pattern"]) ??
			argString(ctx.block.args, ["file_path"]) ??
			"";
		return text || ctx.block.toolName;
	},
};

const presenters = new Map<string, ToolPresenter>([
	["bash", bashPresenter],
	["read", readPresenter],
	["edit", editPresenter],
	["grep", grepPresenter],
]);

export function getToolPresenter(toolName: string): ToolPresenter {
	return presenters.get(toolName) ?? genericPresenter;
}

export { resultText };
