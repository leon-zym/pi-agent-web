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

/** Minimal message shape shared by user/assistant/toolResult payloads. */
export interface AnyMessageLite {
	role: string;
	content: unknown;
	[key: string]: unknown;
}
