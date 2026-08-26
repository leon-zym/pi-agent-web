import type { SlashCommandDto } from "@pi-agent-web/protocol";
import type { SlashCommandToken, SlashTrigger } from "../../stores/composer";

const SOURCE_ORDER: SlashCommandDto["source"][] = ["extension", "prompt", "skill"];

export interface SlashMenuItem {
	command: SlashCommandDto;
	displayName: string;
	score: number;
	index: number;
}

export interface SlashMenuGroup {
	source: SlashCommandDto["source"];
	items: SlashMenuItem[];
}

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

function displayName(command: SlashCommandDto): string {
	return command.name.startsWith("skill:") ? command.name.slice(6) : command.name;
}

/** Build the exact order rendered by the grouped listbox. */
export function buildSlashMenuGroups(commands: SlashCommandDto[], query: string): SlashMenuGroup[] {
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

/** Resolve the visual highlight rather than guessing from a partial fuzzy query. */
export function resolveHighlightedSlashCommand(
	groups: SlashMenuGroup[],
	highlight: number,
): SlashMenuItem | null {
	return groups.flatMap((group) => group.items).find((item) => item.index === highlight) ?? null;
}

export function selectSlashCommand(
	draft: string,
	trigger: SlashTrigger,
	item: Pick<SlashMenuItem, "command" | "displayName">,
): { command: SlashCommandToken; draft: string } {
	const before = draft.slice(0, trigger.index).trimEnd();
	const after = draft.slice(trigger.index + 1 + trigger.query.length).trimStart();
	return {
		command: {
			name: item.command.name,
			displayName: item.displayName,
			source: item.command.source,
		},
		draft: before && after ? `${before} ${after}` : before || after,
	};
}

/** Parse an exact raw invocation at submit time so it cannot bypass the atomic token model. */
export function resolveRawSlashCommand(
	draft: string,
	commands: SlashCommandDto[],
): { command: SlashCommandToken; draft: string } | null {
	const match = draft.match(/^\s*\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match?.[1]) return null;
	const query = match[1].toLowerCase();
	const command = commands.find((candidate) => {
		const visibleName = displayName(candidate).toLowerCase();
		return candidate.name.toLowerCase() === query || visibleName === query;
	});
	if (!command) return null;
	return {
		command: {
			name: command.name,
			displayName: displayName(command),
			source: command.source,
		},
		draft: match[2]?.trim() ?? "",
	};
}
