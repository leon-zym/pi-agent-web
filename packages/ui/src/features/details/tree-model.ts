import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { displayLabel } from "../../lib/format";
import { presentUserMessage, serializePresentedUserMessage } from "../../lib/user-message-presentation";

export function activeTreeEntryIds(tree: SessionTreeNode[], leafId: string | null): Set<string> {
	if (!leafId) return new Set();
	const path: string[] = [];

	function visit(node: SessionTreeNode): boolean {
		path.push(node.entry.id);
		if (node.entry.id === leafId) return true;
		for (const child of node.children) {
			if (visit(child)) return true;
		}
		path.pop();
		return false;
	}

	for (const root of tree) {
		if (visit(root)) return new Set(path);
		path.length = 0;
	}
	return new Set();
}

export function resolvedTreeNodeLabel(
	node: SessionTreeNode,
	fallback: (entry: SessionEntry) => string,
): string {
	const label = node.label?.trim();
	return label
		? displayLabel(serializePresentedUserMessage(presentUserMessage(label)))
		: fallback(node.entry);
}
