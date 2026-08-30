import type { PiSessionTreeNodeDto } from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import {
	activeTreeEntryIds,
	flattenConversationTree,
	pendingConversationTreeSnapshot,
	resolvedTreeNodeLabel,
	visibleConversationTreeSnapshot,
} from "../src/features/details/tree-model";

function messageNode(
	id: string,
	parentId: string | null,
	children: PiSessionTreeNodeDto[] = [],
	label?: string,
): PiSessionTreeNodeDto {
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
		expect(activeTreeEntryIds(tree, "active")).toEqual(new Set(["root", "active"]));
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

	it("keeps linear history flat and only indents at a real branch", () => {
		const activeTail = messageNode("active-tail", "active-start");
		const activeStart = messageNode("active-start", "branch", [activeTail]);
		const alternate = messageNode("alternate", "branch");
		const branch = messageNode("branch", "linear", [alternate, activeStart]);
		const tree = [messageNode("root", null, [messageNode("linear", "root", [branch])])];

		const rows = flattenConversationTree(tree, "active-tail");
		expect(rows.map((row) => row.node.entry.id)).toEqual([
			"root",
			"linear",
			"branch",
			"active-start",
			"active-tail",
			"alternate",
		]);
		expect(rows.map((row) => row.depth)).toEqual([0, 0, 0, 1, 2, 1]);
		expect(rows.filter((row) => row.isOnActivePath).map((row) => row.node.entry.id)).toEqual([
			"root",
			"linear",
			"branch",
			"active-start",
			"active-tail",
		]);
	});

	it("prioritizes the active root and caps the visual prefix in a deeply branched tree", () => {
		const buildBranch = (level: number, parentId: string | null): PiSessionTreeNodeDto => {
			const id = `active-${level}`;
			if (level === 8) return messageNode(id, parentId);
			return messageNode(id, parentId, [messageNode(`alternate-${level}`, id), buildBranch(level + 1, id)]);
		};
		const activeRoot = buildBranch(0, null);
		const rows = flattenConversationTree([messageNode("inactive-root", null), activeRoot], "active-8");

		expect(rows[0]?.node.entry.id).toBe("active-0");
		expect(Math.max(...rows.map((row) => row.prefix.length))).toBeLessThanOrEqual(12);
	});

	it("folds an entire branch segment without losing its expandable row", () => {
		const root = messageNode("root", null, [messageNode("child", "root")]);
		const rows = flattenConversationTree([root], "child", new Set(["root"]));

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			collapsed: true,
			foldable: true,
			hasChildren: true,
		});
	});

	it("flattens a long linear history without growing indentation or overflowing the stack", () => {
		const entryCount = 5_000;
		let tail = messageNode(`entry-${String(entryCount - 1)}`, `entry-${String(entryCount - 2)}`);
		for (let index = entryCount - 2; index >= 0; index -= 1) {
			tail = messageNode(`entry-${String(index)}`, index === 0 ? null : `entry-${String(index - 1)}`, [tail]);
		}

		const rows = flattenConversationTree([tail], `entry-${String(entryCount - 1)}`);
		expect(rows).toHaveLength(entryCount);
		expect(Math.max(...rows.map((row) => row.depth))).toBe(0);
		expect(Math.max(...rows.map((row) => row.prefix.length))).toBeLessThanOrEqual(12);
	});

	it("bounds connector work in a deeply branching active path", () => {
		const depth = 2_500;
		let active = messageNode(`active-${String(depth)}`, `active-${String(depth - 1)}`);
		for (let level = depth - 1; level >= 0; level -= 1) {
			const id = `active-${String(level)}`;
			active = messageNode(id, level === 0 ? null : `active-${String(level - 1)}`, [
				messageNode(`alternate-${String(level)}`, id),
				active,
			]);
		}

		const rows = flattenConversationTree([active], `active-${String(depth)}`);
		expect(rows).toHaveLength(depth * 2 + 1);
		expect(Math.max(...rows.map((row) => row.prefix.length))).toBeLessThanOrEqual(12);
	});

	it("never exposes a stale or empty snapshot while another Session is loading", () => {
		const previous = {
			sessionHandle: "session-a",
			status: "ready" as const,
			tree: [messageNode("root", null)],
			leafId: "root",
		};
		expect(visibleConversationTreeSnapshot(previous, "session-b")).toEqual(
			pendingConversationTreeSnapshot("session-b"),
		);
		expect(pendingConversationTreeSnapshot("session-b").status).toBe("loading");
	});
});
