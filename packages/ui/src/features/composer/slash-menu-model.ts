import type { RpcSlashCommand } from "../../types/pi-types";

const SOURCE_ORDER: RpcSlashCommand["source"][] = ["extension", "prompt", "skill"];

export interface SlashMenuItem {
	command: RpcSlashCommand;
	displayName: string;
	score: number;
	index: number;
}

export interface SlashMenuGroup {
	source: RpcSlashCommand["source"];
	items: SlashMenuItem[];
}

export type SlashCommitAction = { kind: "execute"; commandName: string } | { kind: "none" };

export function fuzzyScore(query: string, name: string): number {
	if (!query) return 0;
	const lowerName = name.toLowerCase();
	const lowerQuery = query.toLowerCase();
	if (lowerName === lowerQuery) return 200 - lowerName.length;
	if (lowerName.startsWith(lowerQuery)) return 100 - lowerName.length;
	if (lowerName.includes(lowerQuery)) return 50 - lowerName.length;
	let queryIndex = 0;
	for (let index = 0; index < lowerName.length && queryIndex < lowerQuery.length; index += 1) {
		if (lowerName[index] === lowerQuery[queryIndex]) queryIndex += 1;
	}
	return queryIndex === lowerQuery.length ? 20 - lowerName.length : -1;
}

function displayName(command: RpcSlashCommand): string {
	return command.name.startsWith("skill:") ? command.name.slice(6) : command.name;
}

/** Build the exact order rendered by the grouped listbox. */
export function buildSlashMenuGroups(commands: RpcSlashCommand[], query: string): SlashMenuGroup[] {
	const normalizedQuery = query.toLowerCase();
	let index = 0;
	const result: SlashMenuGroup[] = [];
	for (const source of SOURCE_ORDER) {
		const items = commands
			.filter((command) => command.source === source)
			.map((command) => {
				const visibleName = displayName(command);
				return {
					command,
					displayName: visibleName,
					score: Math.max(
						fuzzyScore(normalizedQuery, command.name),
						fuzzyScore(normalizedQuery, visibleName),
					),
				};
			})
			.filter((item) => item.score >= 0)
			.sort((left, right) => right.score - left.score || left.displayName.localeCompare(right.displayName))
			.map((item) => ({ ...item, index: index++ }));
		if (items.length > 0) result.push({ source, items });
	}
	return result;
}

export function moveSlashHighlight(current: number, delta: -1 | 1, count: number): number {
	if (count <= 0) return 0;
	return (current + delta + count) % count;
}

export function edgeSlashHighlight(edge: "first" | "last", count: number): number {
	if (count <= 0 || edge === "first") return 0;
	return count - 1;
}

/** Space/Enter execute only an exact real or display-name match. */
export function resolveSlashCommit(groups: SlashMenuGroup[], query: string): SlashCommitAction {
	const items = groups.flatMap((group) => group.items);
	const normalizedQuery = query.trim().toLowerCase();
	if (normalizedQuery) {
		const exactName = items.find((item) => item.command.name.toLowerCase() === normalizedQuery);
		const exactDisplay = items.find((item) => item.displayName.toLowerCase() === normalizedQuery);
		const exact = exactName ?? exactDisplay;
		if (exact) return { kind: "execute", commandName: exact.command.name };
	}
	return { kind: "none" };
}

export function insertSlashCommand(
	draft: string,
	trigger: { index: number; query: string },
	commandName: string,
): string {
	const before = draft.slice(0, trigger.index);
	const after = draft.slice(trigger.index + 1 + trigger.query.length);
	const separator = /^\s/.test(after) ? "" : " ";
	return `${before}/${commandName}${separator}${after}`;
}
