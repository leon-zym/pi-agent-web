import type { ReactNode } from "react";
import { stripAnsi } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import type { ContentBlock, UiToolResult } from "../../types/view-models";
import { HighlightedCode } from "./HighlightedCode";

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

const MAX_TOOL_SUMMARY_SOURCE_CHARACTERS = 1024;

function argString(args: unknown, keys: string[]): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value !== "string") continue;
		const sample = value.slice(0, MAX_TOOL_SUMMARY_SOURCE_CHARACTERS);
		const trimmed = sample.trim();
		if (trimmed.length > 0) {
			return value.length > sample.length ? `${trimmed}…` : trimmed;
		}
	}
	return undefined;
}

function argText(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? stripAnsi(value) : undefined;
}

function payloadText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of ["output", "partial", "text", "content"] as const) {
			const content = record[key];
			if (typeof content === "string") return content;
			if (key === "content" && Array.isArray(content)) {
				return content
					.filter(
						(block) =>
							typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
					)
					.map((block) => String((block as { text?: unknown }).text ?? ""))
					.join("\n");
			}
		}
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

export function toolOutputText(ctx: ToolPresenterContext): string {
	const finalOutput = payloadText(ctx.block.result) || ctx.results[0]?.content || "";
	const output =
		ctx.block.status === "done" || ctx.block.status === "error" || ctx.block.status === "skipped"
			? finalOutput || ctx.block.partialOutput || ""
			: ctx.block.partialOutput || finalOutput;
	return stripAnsi(output);
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

function BashBody({ ctx }: { ctx: ToolPresenterContext }) {
	const command = argText(ctx.block.args, "command") ?? "";
	const output = toolOutputText(ctx);

	return (
		<div className="flex flex-col gap-3">
			<section data-tool-section="command" aria-label={tt("tool.command")}>
				<p className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
					{tt("tool.command")}
				</p>
				<HighlightedCode
					code={command || tt("tool.noCommand")}
					language={command ? "bash" : undefined}
					className="max-h-[260px] border border-border"
				/>
			</section>
			<section data-tool-section="output" aria-label={tt("tool.output")}>
				<p className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
					{tt("tool.output")}
				</p>
				<pre className="scroll-slim max-h-[260px] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-[18px] whitespace-pre-wrap break-words text-ink-2">
					{output || tt("common.noOutput")}
				</pre>
			</section>
		</div>
	);
}

const bashPresenter: ToolPresenter = {
	summarize: (ctx) => {
		const command = argString(ctx.block.args, ["command"]);
		return command ?? "bash";
	},
	renderBody: (ctx) => <BashBody ctx={ctx} />,
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
