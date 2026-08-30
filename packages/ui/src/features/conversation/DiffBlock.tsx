import { Check, Copy, FileCode } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { stripAnsi } from "../../lib/format";
import { tt, useT } from "../../lib/i18n";
import { cn } from "../../lib/utils";

export type DiffLineKind = "add" | "delete" | "context" | "hunk" | "header";

export interface ParsedDiffLine {
	kind: DiffLineKind;
	oldLineNumber: number | null;
	newLineNumber: number | null;
	prefix: string;
	content: string;
	raw: string;
}

export function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
	const clean = stripAnsi(diff);
	const rawLines = clean.split("\n");
	const result: ParsedDiffLine[] = [];

	let currentOldLine = 1;
	let currentNewLine = 1;

	for (const raw of rawLines) {
		if (
			raw.startsWith("---") ||
			raw.startsWith("+++") ||
			raw.startsWith("diff ") ||
			raw.startsWith("index ") ||
			raw.startsWith("\\")
		) {
			result.push({
				kind: "header",
				oldLineNumber: null,
				newLineNumber: null,
				prefix: "",
				content: raw,
				raw,
			});
			continue;
		}

		const hunkMatch = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/.exec(raw);
		if (hunkMatch) {
			currentOldLine = Number.parseInt(hunkMatch[1] ?? "1", 10);
			currentNewLine = Number.parseInt(hunkMatch[2] ?? "1", 10);
			result.push({
				kind: "hunk",
				oldLineNumber: null,
				newLineNumber: null,
				prefix: "@@",
				content: raw,
				raw,
			});
			continue;
		}

		if (raw.startsWith("+")) {
			result.push({
				kind: "add",
				oldLineNumber: null,
				newLineNumber: currentNewLine++,
				prefix: "+",
				content: raw.slice(1),
				raw,
			});
		} else if (raw.startsWith("-")) {
			result.push({
				kind: "delete",
				oldLineNumber: currentOldLine++,
				newLineNumber: null,
				prefix: "-",
				content: raw.slice(1),
				raw,
			});
		} else {
			const content = raw.startsWith(" ") ? raw.slice(1) : raw;
			result.push({
				kind: "context",
				oldLineNumber: currentOldLine++,
				newLineNumber: currentNewLine++,
				prefix: " ",
				content,
				raw,
			});
		}
	}

	return result;
}

export function extractCleanCode(diff: string): string {
	const parsed = parseUnifiedDiff(diff);
	const codeLines: string[] = [];
	for (const line of parsed) {
		if (line.kind === "add" || line.kind === "context") {
			codeLines.push(line.content);
		}
	}
	return codeLines.join("\n");
}

export interface DiffBlockProps {
	diff: string;
	fileName?: string;
	className?: string;
}

/**
 * Line-Level Gutter DiffBlock & Clean Copy (DESIGN.md Section 5.4):
 * - Dual-column Gutter (old line # / new line #) and +/- column
 * - Semantic row highlights (bg-success-soft/30 text-success / bg-danger-soft/30 text-danger)
 * - Top action bar with Clean Copy button (strips +/- markers) and Raw Diff Copy button
 */
export function DiffBlock({ diff, fileName, className }: DiffBlockProps) {
	const { t } = useT();
	void t;
	const [copiedClean, setCopiedClean] = useState(false);
	const [copiedRaw, setCopiedRaw] = useState(false);
	const cleanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const rawTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (cleanTimerRef.current) clearTimeout(cleanTimerRef.current);
			if (rawTimerRef.current) clearTimeout(rawTimerRef.current);
		};
	}, []);

	const parsedLines = useMemo(() => parseUnifiedDiff(diff), [diff]);
	const displayFileName = fileName || tt("tool.diff");

	const handleCleanCopy = async () => {
		const cleanCode = extractCleanCode(diff);
		try {
			if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(cleanCode);
			}
			setCopiedClean(true);
			if (cleanTimerRef.current) clearTimeout(cleanTimerRef.current);
			cleanTimerRef.current = setTimeout(() => setCopiedClean(false), 2000);
		} catch {}
	};

	const handleRawCopy = async () => {
		try {
			if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(diff);
			}
			setCopiedRaw(true);
			if (rawTimerRef.current) clearTimeout(rawTimerRef.current);
			rawTimerRef.current = setTimeout(() => setCopiedRaw(false), 2000);
		} catch {}
	};

	return (
		<div
			data-diff-block="true"
			className={cn(
				"my-3 flex flex-col rounded-md border border-border bg-surface-2/40 overflow-hidden font-mono",
				className,
			)}
		>
			{/* Top action bar */}
			<div className="flex min-h-8 flex-col border-b border-border bg-surface px-2 py-1 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-3 lg:h-8 lg:py-0">
				<div className="flex min-w-0 items-center gap-1.5 text-ink-2 sm:flex-1">
					<FileCode aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
					<span
						data-diff-file-name="true"
						title={displayFileName}
						className="min-w-0 truncate font-mono text-[11px] font-medium text-ink"
					>
						{displayFileName}
					</span>
				</div>
				<div className="grid w-full grid-cols-2 items-center gap-1 sm:flex sm:w-auto">
					<button
						type="button"
						onClick={handleCleanCopy}
						className="inline-flex min-h-10 items-center justify-center gap-1 rounded-xs px-2 text-[11px] font-medium text-ink-2 hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none lg:min-h-0 lg:py-0.5"
					>
						{copiedClean ? (
							<>
								<Check className="size-3 text-success" />
								<span>{tt("diff.cleanCopied")}</span>
							</>
						) : (
							<>
								<Copy className="size-3 text-ink-3" />
								<span>{tt("diff.cleanCopy")}</span>
							</>
						)}
					</button>
					<button
						type="button"
						onClick={handleRawCopy}
						className="inline-flex min-h-10 items-center justify-center gap-1 rounded-xs px-2 text-[11px] font-medium text-ink-2 hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none lg:min-h-0 lg:py-0.5"
					>
						{copiedRaw ? (
							<>
								<Check className="size-3 text-success" />
								<span>{tt("diff.rawCopied")}</span>
							</>
						) : (
							<>
								<Copy className="size-3 text-ink-3" />
								<span>{tt("diff.rawCopy")}</span>
							</>
						)}
					</button>
				</div>
			</div>

			{/* Dual-column Gutter table */}
			<div className="scroll-slim max-h-[500px] overflow-x-auto overflow-y-auto text-xs leading-[20px]">
				<table className="w-full border-collapse">
					<tbody>
						{parsedLines.map((line, index) => {
							const isAdd = line.kind === "add";
							const isDelete = line.kind === "delete";
							const isHunk = line.kind === "hunk";
							const isHeader = line.kind === "header";

							return (
								<tr
									key={`${index}:${line.kind}:${line.raw}`}
									data-diff-line={line.kind}
									data-diff-kind={line.kind}
									className={cn(
										"min-h-[20px] transition-colors",
										isAdd && "bg-success-soft/30 text-success",
										isDelete && "bg-danger-soft/30 text-danger",
										isHunk && "bg-surface-2 text-primary font-semibold",
										isHeader && "bg-surface-2/60 text-ink-3",
										line.kind === "context" && "text-ink-2 hover:bg-hover",
									)}
								>
									{/* Old Line # Gutter */}
									<td
										data-old-line={line.oldLineNumber ?? ""}
										className="w-10 select-none pr-2 text-right font-mono text-[11px] text-ink-3/70 tabular-nums"
									>
										{line.oldLineNumber ?? ""}
									</td>

									{/* New Line # Gutter */}
									<td
										data-new-line={line.newLineNumber ?? ""}
										className="w-10 select-none pr-2 text-right font-mono text-[11px] text-ink-3/70 tabular-nums"
									>
										{line.newLineNumber ?? ""}
									</td>

									{/* Prefix Column (+, -, @@, space) */}
									<td className="w-4 select-none text-center font-mono text-[11px] font-bold">
										{line.prefix}
									</td>

									{/* Code Content */}
									<td className="whitespace-pre pr-3 pl-1 font-mono text-xs">{line.content || " "}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
