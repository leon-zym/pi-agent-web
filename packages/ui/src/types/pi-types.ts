/**
 * Local structural types for pieces the coding-agent package does not export
 * from its root entry. The wire data is plain JSON; these narrow shapes keep
 * the UI decoupled from deep package internals.
 */

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Subset of pi-ai Model we actually render. */
export interface ModelLite {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	contextWindow: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/** get_commands entries (rpc-types.ts RpcSlashCommand, not re-exported). */
export interface RpcSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: {
		path?: string;
		source?: string;
		scope?: string;
		origin?: string;
	};
}

/** Minimal message shape shared by user/assistant/toolResult payloads. */
export interface AnyMessageLite {
	role: string;
	content: unknown;
	[key: string]: unknown;
}
