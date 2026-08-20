import { describe, expect, it } from "vitest";
import {
	buildSlashMenuGroups,
	edgeSlashHighlight,
	fuzzyScore,
	insertSlashCommand,
	moveSlashHighlight,
	resolveSlashCommit,
} from "../src/features/composer/slash-menu-model";
import type { RpcSlashCommand } from "../src/types/pi-types";

function command(name: string, source: RpcSlashCommand["source"]): RpcSlashCommand {
	return { name, source, sourceInfo: {} };
}

describe("slash menu model", () => {
	it("sorts strongest matches first inside stable source groups", () => {
		const groups = buildSlashMenuGroups(
			[
				command("skill:map-review", "skill"),
				command("my-map", "extension"),
				command("map-file", "extension"),
				command("map", "extension"),
				command("map-prompt", "prompt"),
			],
			"map",
		);

		expect(groups.map((group) => group.source)).toEqual(["extension", "prompt", "skill"]);
		expect(groups[0]?.items.map((item) => item.command.name)).toEqual(["map", "map-file", "my-map"]);
		expect(groups.flatMap((group) => group.items).map((item) => item.index)).toEqual([0, 1, 2, 3, 4]);
	});

	it("matches skill display names while preserving their executable names", () => {
		const groups = buildSlashMenuGroups([command("skill:review", "skill")], "review");

		expect(groups[0]?.items[0]).toMatchObject({ displayName: "review" });
		expect(resolveSlashCommit(groups, "review")).toEqual({
			kind: "execute",
			commandName: "skill:review",
		});
		expect(resolveSlashCommit(groups, "skill:review")).toEqual({
			kind: "execute",
			commandName: "skill:review",
		});
		expect(resolveSlashCommit(groups, "rev")).toEqual({ kind: "none" });
	});

	it("wraps keyboard highlights in both directions", () => {
		expect(moveSlashHighlight(0, -1, 3)).toBe(2);
		expect(moveSlashHighlight(2, 1, 3)).toBe(0);
		expect(moveSlashHighlight(1, 1, 3)).toBe(2);
		expect(moveSlashHighlight(0, 1, 0)).toBe(0);
	});

	it("moves Home and End to the listbox edges", () => {
		expect(edgeSlashHighlight("first", 4)).toBe(0);
		expect(edgeSlashHighlight("last", 4)).toBe(3);
		expect(edgeSlashHighlight("last", 0)).toBe(0);
	});

	it("inserts a clicked command at the active slash token", () => {
		expect(insertSlashCommand("Before /rev after", { index: 7, query: "rev" }, "skill:review")).toBe(
			"Before /skill:review after",
		);
		expect(insertSlashCommand("/rev", { index: 0, query: "rev" }, "skill:review")).toBe("/skill:review ");
	});

	it("ranks exact, prefix, contains, and subsequence matches in that order", () => {
		expect(fuzzyScore("map", "map")).toBeGreaterThan(fuzzyScore("map", "map-file"));
		expect(fuzzyScore("map", "map-file")).toBeGreaterThan(fuzzyScore("map", "my-map"));
		expect(fuzzyScore("map", "my-app")).toBeGreaterThan(fuzzyScore("map", "other"));
		expect(fuzzyScore("map", "other")).toBe(-1);
	});
});
