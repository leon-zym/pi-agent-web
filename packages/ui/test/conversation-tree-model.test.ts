import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { activeTreeEntryIds, resolvedTreeNodeLabel } from "../src/features/details/tree-model";

function messageNode(
	id: string,
	parentId: string | null,
	children: SessionTreeNode[] = [],
	label?: string,
): SessionTreeNode {
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp: "2026-08-21T00:00:00.000Z",
			message: { role: "user", content: id, timestamp: 0 },
		},
		children,
		label,
	};
}

describe("conversation tree model", () => {
	it("marks only the ancestor path ending at Pi's active leaf", () => {
		const activeLeaf = messageNode("active", "root");
		const tree = [messageNode("root", null, [activeLeaf, messageNode("alternate", "root")])];
		expect([...activeTreeEntryIds(tree, "active")]).toEqual(["root", "active"]);
	});

	it("uses Pi's resolved label before the generated entry preview", () => {
		const node = messageNode("entry", null, [], "Release investigation");
		expect(resolvedTreeNodeLabel(node, () => "generated preview")).toBe("Release investigation");
	});

	it("fails private for an ambiguous expanded-skill tree label", () => {
		const node = messageNode(
			"skill-entry",
			null,
			[],
			'<skill name="review" location="/private/review/SKILL.md">\nExample:\n</skill>\n\nPRIVATE TREE BODY\n</skill>\n\nreal user args',
		);
		expect(resolvedTreeNodeLabel(node, () => "generated preview")).toBe("/skill:review");
	});
});
