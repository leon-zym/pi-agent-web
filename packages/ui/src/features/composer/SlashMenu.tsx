import { Blocks, CornerDownLeft, MessageSquareText, Sparkles } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { displayLabel } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useComposerStore } from "../../stores/composer";
import { useSlashCommandsStore } from "../../stores/slash-commands";
import {
	buildSlashMenuGroups,
	edgeSlashHighlight,
	moveSlashHighlight,
	resolveHighlightedSlashCommand,
	type SlashMenuItem,
} from "./slash-menu-model";

interface SlashMenuProps {
	onSelect: (item: SlashMenuItem) => void;
}

export interface SlashMenuHandle {
	move: (delta: -1 | 1) => void;
	moveTo: (edge: "first" | "last") => void;
	commitHighlighted: () => boolean;
}

const SOURCE_META = {
	extension: { label: "slash.extension", icon: Blocks },
	prompt: { label: "slash.prompt", icon: MessageSquareText },
	skill: { label: "slash.skill", icon: Sparkles },
} as const;

/**
 * Slash command listbox anchored above the composer:
 * grouped by source with fuzzy candidates. A commit selects the highlighted
 * command as an atomic composer token; it never executes from the menu.
 */
export const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(function SlashMenu({ onSelect }, ref) {
	const commands = useSlashCommandsStore((s) => s.commands);
	const trigger = useComposerStore((s) => s.trigger);
	const [highlight, setHighlight] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	const query = (trigger?.query ?? "").toLowerCase();
	const groups = useMemo(() => buildSlashMenuGroups(commands, query), [commands, query]);
	const itemCount = groups.reduce((count, group) => count + group.items.length, 0);

	useEffect(() => {
		setHighlight(0);
	}, [query]);

	useEffect(() => {
		setHighlight((current) => (itemCount === 0 ? 0 : Math.min(current, itemCount - 1)));
	}, [itemCount]);

	useEffect(() => {
		listRef.current
			?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
			?.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	const commitHighlighted = useCallback((): boolean => {
		const item = resolveHighlightedSlashCommand(groups, highlight);
		if (!item) return false;
		onSelect(item);
		return true;
	}, [groups, highlight, onSelect]);

	useImperativeHandle(
		ref,
		() => ({
			move: (delta) => setHighlight((current) => moveSlashHighlight(current, delta, itemCount)),
			moveTo: (edge) => setHighlight(edgeSlashHighlight(edge, itemCount)),
			commitHighlighted,
		}),
		[commitHighlighted, itemCount],
	);

	if (itemCount === 0) {
		return (
			<div className="absolute right-4 bottom-full left-4 z-50 mb-2 rounded-md border border-border bg-surface p-2 shadow-lv3">
				<p className="px-2 py-1 text-[13px] text-ink-3">
					{commands.length === 0 ? tt("slash.loadingCommands") : tt("slash.noMatch")}
				</p>
			</div>
		);
	}

	return (
		<div
			ref={listRef}
			role="listbox"
			aria-label={tt("composer.commandMenu")}
			className="scroll-slim absolute right-4 bottom-full left-4 z-50 mb-2 max-h-80 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-lv3"
		>
			{groups.map(({ source, items }) => {
				const meta = SOURCE_META[source];
				const Icon = meta.icon;
				return (
					<div key={source}>
						<div className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
							{tt(meta.label)}
						</div>
						{items.map((item) => {
							const { command, displayName, index } = item;
							const selected = index === highlight;
							return (
								<div
									key={`${command.source}:${command.name}`}
									role="option"
									aria-selected={selected}
									tabIndex={-1}
									onMouseDown={(event) => {
										event.preventDefault();
										onSelect(item);
									}}
									onMouseEnter={() => setHighlight(index)}
									className={cn(
										"flex h-10 cursor-default items-center gap-2 rounded-sm px-2 text-[13px]",
										selected ? "bg-hover text-ink" : "text-ink-2",
									)}
								>
									<Icon className="size-4 shrink-0 text-ink-3" />
									<span className="min-w-0 flex-1 truncate font-mono">/{displayLabel(displayName)}</span>
									{command.description && (
										<span className="max-w-48 truncate text-xs text-ink-3">
											{displayLabel(command.description)}
										</span>
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
});
