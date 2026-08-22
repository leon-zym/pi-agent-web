import { CornerDownLeft, FileCode } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "../../lib/api";
import { displayLabel } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useComposerStore } from "../../stores/composer";

interface FileMentionMenuProps {
	workspaceHandle: string;
	onSelect: (filePath: string) => void;
}

export interface FileMentionMenuHandle {
	move: (delta: -1 | 1) => void;
	moveTo: (edge: "first" | "last") => void;
	commitHighlighted: () => boolean;
}

/**
 * File mention listbox anchored above the composer:
 * Debounced fuzzy search for workspace files triggered by "@".
 */
export const FileMentionMenu = forwardRef<FileMentionMenuHandle, FileMentionMenuProps>(
	function FileMentionMenu({ workspaceHandle, onSelect }, ref) {
		const mentionTrigger = useComposerStore((s) => s.mentionTrigger);
		const [files, setFiles] = useState<string[]>([]);
		const [loading, setLoading] = useState(false);
		const [highlight, setHighlight] = useState(0);
		const listRef = useRef<HTMLDivElement>(null);

		const query = mentionTrigger?.query ?? "";

		useEffect(() => {
			let active = true;
			setLoading(true);
			const timer = setTimeout(async () => {
				try {
					const results = await api.searchWorkspaceFiles(workspaceHandle, query);
					if (active) {
						setFiles(results);
						setHighlight(0);
					}
				} catch {
					if (active) {
						setFiles([]);
					}
				} finally {
					if (active) {
						setLoading(false);
					}
				}
			}, 150);

			return () => {
				active = false;
				clearTimeout(timer);
			};
		}, [workspaceHandle, query]);

		useEffect(() => {
			setHighlight((current) => (files.length === 0 ? 0 : Math.min(current, files.length - 1)));
		}, [files.length]);

		useEffect(() => {
			listRef.current
				?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
				?.scrollIntoView({ block: "nearest" });
		}, [highlight]);

		const commitHighlighted = useCallback((): boolean => {
			if (files.length === 0 || highlight < 0 || highlight >= files.length) return false;
			const selected = files[highlight];
			if (!selected) return false;
			onSelect(selected);
			return true;
		}, [files, highlight, onSelect]);

		useImperativeHandle(
			ref,
			() => ({
				move: (delta) =>
					setHighlight((current) => {
						if (files.length === 0) return 0;
						return (current + delta + files.length) % files.length;
					}),
				moveTo: (edge) => setHighlight(edge === "first" ? 0 : Math.max(0, files.length - 1)),
				commitHighlighted,
			}),
			[commitHighlighted, files.length],
		);

		if (loading && files.length === 0) {
			return (
				<div
					data-testid="file-mention-loading"
					className="absolute right-4 bottom-full left-4 z-50 mb-2 rounded-md border border-border bg-surface p-2 shadow-lv3"
				>
					<p className="px-2 py-1 text-[13px] text-ink-3">{tt("mention.loadingFiles")}</p>
				</div>
			);
		}

		if (files.length === 0) {
			return (
				<div
					data-testid="file-mention-empty"
					className="absolute right-4 bottom-full left-4 z-50 mb-2 rounded-md border border-border bg-surface p-2 shadow-lv3"
				>
					<p className="px-2 py-1 text-[13px] text-ink-3">{tt("mention.noMatch")}</p>
				</div>
			);
		}

		return (
			<div
				ref={listRef}
				role="listbox"
				data-testid="file-mention-menu"
				aria-label={tt("mention.title")}
				className="scroll-slim absolute right-4 bottom-full left-4 z-50 mb-2 max-h-80 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-lv3"
			>
				<div className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
					{tt("mention.title")}
				</div>
				{files.map((filePath, index) => {
					const selected = index === highlight;
					const parts = filePath.split("/");
					const fileName = parts.pop() ?? filePath;
					const dirPath = parts.join("/");

					return (
						<div
							key={filePath}
							role="option"
							aria-selected={selected}
							tabIndex={-1}
							data-testid={`file-mention-item-${index}`}
							onMouseDown={(event) => {
								event.preventDefault();
								onSelect(filePath);
							}}
							onMouseEnter={() => setHighlight(index)}
							className={cn(
								"flex h-9 cursor-default items-center gap-2 rounded-sm px-2 text-[13px]",
								selected ? "bg-hover text-ink" : "text-ink-2",
							)}
						>
							<FileCode className="size-4 shrink-0 text-ink-3" />
							<span className="min-w-0 font-medium font-mono">{displayLabel(fileName)}</span>
							{dirPath && (
								<span className="min-w-0 flex-1 truncate text-xs text-ink-3 font-mono">
									{displayLabel(dirPath)}
								</span>
							)}
							{selected && <CornerDownLeft className="size-3.5 shrink-0 text-ink-3" />}
						</div>
					);
				})}
				<div className="border-t border-border px-2 py-1.5 text-[11px] text-ink-3">{tt("mention.hint")}</div>
			</div>
		);
	},
);
