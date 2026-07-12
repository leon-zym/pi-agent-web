import { Blocks, CornerDownLeft, MessageSquareText, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { tt } from "../../lib/i18n";
import { runSlashCommand } from "../../lib/session-controller";
import { cn } from "../../lib/utils";
import { useComposerStore } from "../../stores/composer";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useSlashCommandsStore } from "../../stores/slash-commands";
import type { RpcSlashCommand } from "../../types/pi-types";

interface SlashMenuProps {
	anchorRef: React.RefObject<HTMLDivElement | null>;
	onExecute: (commandName: string) => void;
}

const SOURCE_META = {
	extension: { label: "slash.extension", icon: Blocks },
	prompt: { label: "slash.prompt", icon: MessageSquareText },
	skill: { label: "slash.skill", icon: Sparkles },
} as const;

function fuzzyScore(query: string, name: string): number {
	if (!query) return 0;
	const lowerName = name.toLowerCase();
	const lowerQuery = query.toLowerCase();
	if (lowerName.startsWith(lowerQuery)) return 100 - lowerName.length;
	if (lowerName.includes(lowerQuery)) return 50 - lowerName.length;
	// subsequence match
	let qi = 0;
	for (let i = 0; i < lowerName.length && qi < lowerQuery.length; i++) {
		if (lowerName[i] === lowerQuery[qi]) qi++;
	}
	return qi === lowerQuery.length ? 20 - lowerName.length : -1;
}

/**
 * Slash command listbox anchored above the composer:
 * grouped by source, fuzzy candidates, exact-name execution, unknown "/"
 * input is never silently sent as a plain prompt.
 */
export function SlashMenu({ anchorRef, onExecute }: SlashMenuProps) {
	const commands = useSlashCommandsStore((s) => s.commands);
	const trigger = useComposerStore((s) => s.trigger);
	const [highlight, setHighlight] = useState(0);

	void anchorRef;

	const query = (trigger?.query ?? "").toLowerCase();

	const groups = useMemo(() => {
		const matched: Array<{ command: RpcSlashCommand; displayName: string }> = [];
		for (const command of commands) {
			const displayName = command.name.startsWith("skill:") ? command.name.slice(6) : command.name;
			const score = fuzzyScore(query, command.name);
			if (score < 0) continue;
			matched.push({ command, displayName });
		}
		matched.sort((a, b) => fuzzyScore(query, a.command.name) - fuzzyScore(query, b.command.name));
		return matched;
	}, [commands, query]);

	useEffect(() => {
		setHighlight(0);
	}, [query]);

	const executeHighlighted = () => {
		const item = groups[highlight];
		if (!item) return;
		const wsId = useSessionDirectoryStore.getState().currentWorkspaceId;
		if (wsId) void runSlashCommand(wsId, `/${item.command.name}`);
	};

	useEffect(() => {
		const onEnter = () => executeHighlighted();
		window.addEventListener("piweb:slash-enter", onEnter);
		return () => window.removeEventListener("piweb:slash-enter", onEnter);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [groups, highlight]);

	if (groups.length === 0) {
		return (
			<div className="absolute right-4 bottom-full left-4 z-50 mb-2 rounded-md border border-border bg-surface p-2 shadow-lv3">
				<p className="px-2 py-1 text-[13px] text-ink-3">
					{commands.length === 0 ? tt("slash.loadingCommands") : tt("slash.noMatch")}
				</p>
			</div>
		);
	}

	const bySource = new Map<
		RpcSlashCommand["source"],
		Array<{ command: RpcSlashCommand; displayName: string }>
	>();
	for (const item of groups) {
		const list = bySource.get(item.command.source) ?? [];
		list.push(item);
		bySource.set(item.command.source, list);
	}

	let flatIndex = -1;

	return (
		<div
			role="listbox"
			aria-label={tt("composer.commandMenu")}
			className="scroll-slim absolute right-4 bottom-full left-4 z-50 mb-2 max-h-80 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-lv3"
		>
			{[...bySource.entries()].map(([source, items]) => {
				const meta = SOURCE_META[source];
				const Icon = meta.icon;
				return (
					<div key={source}>
						<div className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
							{meta.label}
						</div>
						{items.map(({ command, displayName }) => {
							flatIndex += 1;
							const index = flatIndex;
							const selected = index === highlight;
							return (
								<div
									key={`${command.source}:${command.name}`}
									role="option"
									aria-selected={selected}
									tabIndex={-1}
									onMouseDown={(event) => {
										event.preventDefault();
										onExecute(command.name);
									}}
									onMouseEnter={() => setHighlight(index)}
									className={cn(
										"flex h-10 cursor-default items-center gap-2 rounded-sm px-2 text-[13px]",
										selected ? "bg-hover text-ink" : "text-ink-2",
									)}
								>
									<Icon className="size-4 shrink-0 text-ink-3" />
									<span className="min-w-0 flex-1 truncate font-mono">/{displayName}</span>
									{command.description && (
										<span className="max-w-48 truncate text-xs text-ink-3">{command.description}</span>
									)}
									{selected && <CornerDownLeft className="size-3.5 shrink-0 text-ink-3" />}
								</div>
							);
						})}
					</div>
				);
			})}
			<div className="border-t border-border px-2 py-1.5 text-[11px] text-ink-3">{tt("slash.hint")}</div>
		</div>
	);
}
