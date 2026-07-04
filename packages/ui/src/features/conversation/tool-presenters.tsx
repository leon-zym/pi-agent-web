import type { ReactNode } from "react";
import type { ContentBlock, UiToolResult } from "../../types/view-models";

/**
 * Tool presenter registry (DSH report §8.3): a dedicated compact renderer per
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
		return path ? (description ? path + " · " + description : path) : "edit";
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
