import type { PiSessionEntryDto, PiSessionTreeNodeDto } from "@pi-agent-web/protocol";
import { displayLabel } from "../../lib/format";
import { presentUserMessage, serializePresentedUserMessage } from "../../lib/user-message-presentation";

export type ConversationTreeLoadStatus = "loading" | "ready" | "error";

export interface ConversationTreeSnapshot {
	sessionHandle: string | null;
	status: ConversationTreeLoadStatus;
	tree: PiSessionTreeNodeDto[];
	leafId: string | null;
	error?: string;
}

interface TreeGutter {
	position: number;
	show: boolean;
}

export interface ConversationTreeRow {
	node: PiSessionTreeNodeDto;
	depth: number;
	prefix: string;
	isOnActivePath: boolean;
	isLeaf: boolean;
	hasChildren: boolean;
	foldable: boolean;
	collapsed: boolean;
}

const MAX_PREFIX_CHARS = 12;

export function pendingConversationTreeSnapshot(sessionHandle: string | null): ConversationTreeSnapshot {
	return {
		sessionHandle,
		status: sessionHandle ? "loading" : "ready",
		tree: [],
		leafId: null,
	};
}

export function visibleConversationTreeSnapshot(
	snapshot: ConversationTreeSnapshot,
	sessionHandle: string | null,
): ConversationTreeSnapshot {
	return snapshot.sessionHandle === sessionHandle ? snapshot : pendingConversationTreeSnapshot(sessionHandle);
}

export function activeTreeEntryIds(tree: PiSessionTreeNodeDto[], leafId: string | null): Set<string> {
	if (!leafId) return new Set();
	const parentById = new Map<string, string | null>();
	const stack = [...tree];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node || parentById.has(node.entry.id)) continue;
		parentById.set(node.entry.id, node.entry.parentId ?? null);
		for (const child of node.children) stack.push(child);
	}
	if (!parentById.has(leafId)) return new Set();

	const activeIds = new Set<string>();
	const visited = new Set<string>();
	let currentId: string | null = leafId;
	while (currentId && !visited.has(currentId)) {
		visited.add(currentId);
		activeIds.add(currentId);
		currentId = parentById.get(currentId) ?? null;
	}
	return activeIds;
}

function hasAssistantText(entry: PiSessionEntryDto): boolean {
	if (entry.type !== "message" || entry.message.role !== "assistant") return true;
	const content = (entry.message as { content?: unknown }).content;
	if (!Array.isArray(content)) return typeof content === "string" && content.trim().length > 0;
	return content.some(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string" &&
			block.text.trim().length > 0,
	);
}

function visibleByDefault(node: PiSessionTreeNodeDto, leafId: string | null): boolean {
	const entry = node.entry;
	if (entry.id === leafId) return true;
	if (
		entry.type === "label" ||
		entry.type === "custom" ||
		entry.type === "model_change" ||
		entry.type === "thinking_level_change" ||
		entry.type === "session_info"
	) {
		return false;
	}
	if (entry.type !== "message" || entry.message.role !== "assistant") return true;
	if (hasAssistantText(entry)) return true;
	const message = entry.message as { stopReason?: string; errorMessage?: string };
	return Boolean(
		message.errorMessage ||
			(message.stopReason && message.stopReason !== "stop" && message.stopReason !== "toolUse"),
	);
}

function buildTreePrefix({
	indent,
	showConnector,
	isLast,
	gutters,
	isVirtualRootChild,
	multipleRoots,
}: {
	indent: number;
	showConnector: boolean;
	isLast: boolean;
	gutters: TreeGutter[];
	isVirtualRootChild: boolean;
	multipleRoots: boolean;
}): string {
	const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
	const connector = showConnector && !isVirtualRootChild;
	const connectorPosition = connector ? displayIndent - 1 : -1;
	const totalCharacters = displayIndent * 3;
	const clipped = totalCharacters > MAX_PREFIX_CHARS;
	const start = clipped ? totalCharacters - (MAX_PREFIX_CHARS - 1) : 0;
	const prefixChars: string[] = [];
	if (clipped) prefixChars.push("…");
	for (let index = start; index < totalCharacters; index += 1) {
		const level = Math.floor(index / 3);
		const position = index % 3;
		const gutter = gutters.find((candidate) => candidate.position === level);
		if (gutter) {
			prefixChars.push(position === 0 && gutter.show ? "│" : " ");
		} else if (connector && level === connectorPosition) {
			prefixChars.push(position === 0 ? (isLast ? "└" : "├") : position === 1 ? "─" : " ");
		} else {
			prefixChars.push(" ");
		}
	}
	return prefixChars.join("");
}

/**
 * Produces Pi-compatible tree rows: the active branch comes first and a linear
 * chain stays on one visual axis. Indentation grows only at actual branches.
 */
export function flattenConversationTree(
	tree: PiSessionTreeNodeDto[],
	leafId: string | null,
	collapsedIds: ReadonlySet<string> = new Set(),
): ConversationTreeRow[] {
	const activePathIds = activeTreeEntryIds(tree, leafId);
	const orderedNodes: PiSessionTreeNodeDto[] = [];
	const allById = new Map<string, PiSessionTreeNodeDto>();
	const orderedRoots = [...tree].sort(
		(a, b) => Number(activePathIds.has(b.entry.id)) - Number(activePathIds.has(a.entry.id)),
	);
	const stack: PiSessionTreeNodeDto[] = [];
	for (let index = orderedRoots.length - 1; index >= 0; index -= 1) {
		const root = orderedRoots[index];
		if (root) stack.push(root);
	}
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node || allById.has(node.entry.id)) continue;
		allById.set(node.entry.id, node);
		orderedNodes.push(node);
		const children = [...node.children].sort(
			(a, b) => Number(activePathIds.has(b.entry.id)) - Number(activePathIds.has(a.entry.id)),
		);
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (child) stack.push(child);
		}
	}

	const candidateNodes = orderedNodes.filter((node) => visibleByDefault(node, leafId));
	const candidateIds = new Set(candidateNodes.map((node) => node.entry.id));
	const candidateParent = new Map<string, string | null>();
	const nearestCandidateByNode = new Map<string, string | null>();
	for (const node of orderedNodes) {
		const parentId = node.entry.parentId ?? null;
		const nearestParent = parentId
			? candidateIds.has(parentId)
				? parentId
				: (nearestCandidateByNode.get(parentId) ?? null)
			: null;
		if (candidateIds.has(node.entry.id)) candidateParent.set(node.entry.id, nearestParent);
		nearestCandidateByNode.set(
			node.entry.id,
			candidateIds.has(node.entry.id) ? node.entry.id : nearestParent,
		);
	}
	const candidateChildren = new Map<string | null, string[]>();
	candidateChildren.set(null, []);
	for (const node of candidateNodes) {
		const parentId = candidateParent.get(node.entry.id) ?? null;
		const children = candidateChildren.get(parentId) ?? [];
		children.push(node.entry.id);
		candidateChildren.set(parentId, children);
	}

	const hiddenByCollapsedAncestor = new Map<string, boolean>();
	const visibleNodes = candidateNodes.filter((node) => {
		const parentId = candidateParent.get(node.entry.id) ?? null;
		const hidden = Boolean(
			parentId && (collapsedIds.has(parentId) || hiddenByCollapsedAncestor.get(parentId)),
		);
		hiddenByCollapsedAncestor.set(node.entry.id, hidden);
		return !hidden;
	});
	const visibleChildren = new Map<string | null, string[]>();
	visibleChildren.set(null, []);
	for (const node of visibleNodes) {
		const parentId = candidateParent.get(node.entry.id) ?? null;
		const children = visibleChildren.get(parentId) ?? [];
		children.push(node.entry.id);
		visibleChildren.set(parentId, children);
	}

	const roots = visibleChildren.get(null) ?? [];
	const multipleRoots = roots.length > 1;
	const rows: ConversationTreeRow[] = [];
	type StackItem = [string, number, boolean, boolean, boolean, TreeGutter[], boolean];
	const renderStack: StackItem[] = [];
	for (let index = roots.length - 1; index >= 0; index -= 1) {
		const rootId = roots[index];
		if (!rootId) continue;
		renderStack.push([
			rootId,
			multipleRoots ? 1 : 0,
			multipleRoots,
			multipleRoots,
			index === roots.length - 1,
			[],
			multipleRoots,
		]);
	}

	while (renderStack.length > 0) {
		const item = renderStack.pop();
		if (!item) continue;
		const [id, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = item;
		const node = allById.get(id);
		if (!node) continue;
		const children = visibleChildren.get(id) ?? [];
		const originalVisibleChildren = candidateChildren.get(id) ?? [];
		const parentId = candidateParent.get(id) ?? null;
		const siblings = visibleChildren.get(parentId) ?? [];
		const displayDepth = multipleRoots ? Math.max(0, indent - 1) : indent;
		rows.push({
			node,
			depth: displayDepth,
			prefix: buildTreePrefix({
				indent,
				showConnector,
				isLast,
				gutters,
				isVirtualRootChild,
				multipleRoots,
			}),
			isOnActivePath: activePathIds.has(id),
			isLeaf: id === leafId,
			hasChildren: children.length > 0 || originalVisibleChildren.length > 0,
			foldable:
				(children.length > 0 || originalVisibleChildren.length > 0) &&
				(parentId === null || siblings.length > 1),
			collapsed: collapsedIds.has(id),
		});

		const multipleChildren = children.length > 1;
		const childIndent = multipleChildren ? indent + 1 : justBranched && indent > 0 ? indent + 1 : indent;
		const connectorDisplayed = showConnector && !isVirtualRootChild;
		const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
		const connectorPosition = Math.max(0, currentDisplayIndent - 1);
		const unboundedChildGutters = connectorDisplayed
			? [...gutters, { position: connectorPosition, show: !isLast }]
			: gutters;
		const childDisplayIndent = multipleRoots ? Math.max(0, childIndent - 1) : childIndent;
		const firstVisibleCharacter = Math.max(0, childDisplayIndent * 3 - (MAX_PREFIX_CHARS - 1));
		const firstVisibleLevel = Math.floor(firstVisibleCharacter / 3);
		const childGutters = unboundedChildGutters.filter((gutter) => gutter.position >= firstVisibleLevel);
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const childId = children[index];
			if (!childId) continue;
			renderStack.push([
				childId,
				childIndent,
				multipleChildren,
				multipleChildren,
				index === children.length - 1,
				childGutters,
				false,
			]);
		}
	}

	return rows;
}

export function resolvedTreeNodeLabel(
	node: PiSessionTreeNodeDto,
	fallback: (entry: PiSessionEntryDto) => string,
): string {
	const label = node.label?.trim();
	return label
		? displayLabel(serializePresentedUserMessage(presentUserMessage(label)))
		: fallback(node.entry);
}
