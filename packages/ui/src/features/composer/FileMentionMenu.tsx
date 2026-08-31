import type {
	WorkspaceFileMetadataDto,
	WorkspaceFileReferenceDto,
	WorkspaceFileRiskDto,
} from "@pi-agent-web/protocol";
import { AlertTriangle, CornerDownLeft, FileCode, FileImage, FileLock2 } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "../../lib/api";
import { displayLabel, formatBytes } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useComposerStore } from "../../stores/composer";

interface FileMentionMenuProps {
	workspaceHandle: string;
	onCapture: (
		file: WorkspaceFileMetadataDto,
		confirmed: boolean,
		signal: AbortSignal,
	) => Promise<WorkspaceFileReferenceDto>;
	onSelect: (reference: WorkspaceFileReferenceDto) => void;
}

export interface FileMentionMenuHandle {
	move: (delta: -1 | 1) => void;
	moveTo: (edge: "first" | "last") => void;
	commitHighlighted: () => boolean;
}

/** Bounded metadata preview and explicit confirmation for Host-owned file expansion. */
export const FileMentionMenu = forwardRef<FileMentionMenuHandle, FileMentionMenuProps>(
	function FileMentionMenu({ workspaceHandle, onCapture, onSelect }, ref) {
		const mentionTrigger = useComposerStore((state) => state.mentionTrigger);
		const [files, setFiles] = useState<WorkspaceFileMetadataDto[]>([]);
		const [loading, setLoading] = useState(false);
		const [truncated, setTruncated] = useState(false);
		const [highlight, setHighlight] = useState(0);
		const [confirmPath, setConfirmPath] = useState<string | null>(null);
		const [capturing, setCapturing] = useState(false);
		const [captureError, setCaptureError] = useState<string | null>(null);
		const listRef = useRef<HTMLDivElement>(null);
		const captureController = useRef<AbortController | null>(null);

		const query = mentionTrigger?.query ?? "";
		const selected = files[highlight];

		useEffect(() => {
			const controller = new AbortController();
			captureController.current?.abort();
			captureController.current = null;
			setFiles([]);
			setLoading(true);
			setCapturing(false);
			setConfirmPath(null);
			setCaptureError(null);
			const timer = setTimeout(async () => {
				try {
					const result = await api.searchWorkspaceFiles(workspaceHandle, query, controller.signal);
					setFiles(result.files);
					setTruncated(result.truncated);
					setHighlight(0);
				} catch (error) {
					if (!controller.signal.aborted) {
						setFiles([]);
						setCaptureError(error instanceof Error ? error.message : String(error));
					}
				} finally {
					if (!controller.signal.aborted) setLoading(false);
				}
			}, 150);

			return () => {
				clearTimeout(timer);
				controller.abort();
			};
		}, [workspaceHandle, query]);

		useEffect(
			() => () => {
				captureController.current?.abort();
			},
			[],
		);

		useEffect(() => {
			setHighlight((current) => (files.length === 0 ? 0 : Math.min(current, files.length - 1)));
		}, [files.length]);

		useEffect(() => {
			setConfirmPath(null);
			setCaptureError(null);
			listRef.current
				?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
				?.scrollIntoView({ block: "nearest" });
		}, [highlight]);

		const capture = useCallback(
			(file: WorkspaceFileMetadataDto, confirmed: boolean) => {
				if (capturing || !file.canonicalIdentity) return;
				captureController.current?.abort();
				const controller = new AbortController();
				captureController.current = controller;
				setCapturing(true);
				setCaptureError(null);
				void onCapture(file, confirmed, controller.signal)
					.then((reference) => {
						if (!controller.signal.aborted) onSelect(reference);
					})
					.catch((error) => {
						if (!controller.signal.aborted) {
							setCaptureError(error instanceof Error ? error.message : String(error));
						}
					})
					.finally(() => {
						if (!controller.signal.aborted) setCapturing(false);
					});
			},
			[capturing, onCapture, onSelect],
		);

		const commitHighlighted = useCallback((): boolean => {
			const file = files[highlight];
			if (!file) return false;
			if (file.availability === "blocked" || file.availability === "unavailable") {
				setConfirmPath(file.path);
				return true;
			}
			if (file.availability === "confirmation_required" && confirmPath !== file.path) {
				setConfirmPath(file.path);
				return true;
			}
			capture(file, file.availability === "confirmation_required");
			return true;
		}, [capture, confirmPath, files, highlight]);

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
			return <MenuMessage testId="file-mention-loading" message={tt("mention.loadingFiles")} />;
		}

		if (files.length === 0) {
			return (
				<MenuMessage
					testId="file-mention-empty"
					message={captureError ? tt("mention.searchFailed") : tt("mention.noMatch")}
				/>
			);
		}

		const showDetail = selected && (confirmPath === selected.path || Boolean(selected.preview));
		return (
			<div
				ref={listRef}
				role="listbox"
				data-testid="file-mention-menu"
				aria-label={tt("mention.title")}
				className="absolute right-4 bottom-full left-4 z-50 mb-2 overflow-hidden rounded-md border border-border bg-surface shadow-lv3"
			>
				<div className="px-3 pt-2.5 pb-1 text-[11px] font-medium text-ink-3">{tt("mention.title")}</div>
				<div className="scroll-slim max-h-56 overflow-y-auto px-1">
					{files.map((file, index) => (
						<FileOption
							key={`${file.path}:${file.canonicalIdentity ?? "unavailable"}`}
							file={file}
							selected={index === highlight}
							index={index}
							onChoose={() => {
								setHighlight(index);
								setConfirmPath(file.path);
								if (file.availability === "ready") capture(file, false);
							}}
							onHighlight={() => setHighlight(index)}
						/>
					))}
				</div>

				{showDetail && (
					<div data-testid="file-mention-detail" className="border-t border-border bg-surface-2 px-3 py-2.5">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<p className="truncate font-mono text-xs text-ink-2">{displayLabel(selected.path)}</p>
								<p className="mt-0.5 text-[11px] text-ink-3">{metadataSummary(selected)}</p>
							</div>
							{selected.availability === "confirmation_required" && (
								<button
									type="button"
									disabled={capturing}
									onMouseDown={(event) => {
										event.preventDefault();
										capture(selected, true);
									}}
									className="min-h-10 shrink-0 rounded-sm bg-warning-soft px-3 text-xs font-medium text-warning transition-transform active:scale-96 disabled:opacity-50 motion-reduce:transform-none"
								>
									{capturing ? tt("mention.capturing") : tt("mention.includeAnyway")}
								</button>
							)}
						</div>
						{selected.preview && (
							<pre className="scroll-slim mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded-sm bg-base p-2 font-mono text-[11px] leading-4 text-ink-2">
								{selected.preview}
							</pre>
						)}
						{selected.availability === "blocked" && (
							<p className="mt-2 text-xs text-danger">{tt("mention.blocked")}</p>
						)}
						{selected.availability === "unavailable" && (
							<p className="mt-2 text-xs text-danger">{tt("mention.unavailable")}</p>
						)}
						{captureError && <p className="mt-2 text-xs text-danger">{tt("mention.captureFailed")}</p>}
					</div>
				)}

				<div className="border-t border-border px-3 py-1.5 text-[11px] text-ink-3 sm:flex sm:items-center sm:justify-between sm:gap-3">
					<span className="hidden sm:inline">
						{truncated ? tt("mention.resultsTruncated") : tt("mention.hostExpanded")}
					</span>
					<span className="block text-center sm:shrink-0 sm:text-right">
						<span className="sm:hidden">{tt("mention.hintMobile")}</span>
						<span className="hidden sm:inline">{tt("mention.hint")}</span>
					</span>
				</div>
			</div>
		);
	},
);

function MenuMessage({ testId, message }: { testId: string; message: string }) {
	return (
		<div
			data-testid={testId}
			className="absolute right-4 bottom-full left-4 z-50 mb-2 rounded-md border border-border bg-surface p-2 shadow-lv3"
		>
			<p className="px-2 py-1 text-[13px] text-ink-3">{message}</p>
		</div>
	);
}

function FileOption({
	file,
	selected,
	index,
	onChoose,
	onHighlight,
}: {
	file: WorkspaceFileMetadataDto;
	selected: boolean;
	index: number;
	onChoose: () => void;
	onHighlight: () => void;
}) {
	const parts = file.path.split("/");
	const fileName = parts.pop() ?? file.path;
	const directory = parts.join("/");
	const Icon = file.kind === "image" ? FileImage : file.risks.includes("credential") ? FileLock2 : FileCode;
	return (
		<div
			role="option"
			aria-selected={selected}
			tabIndex={-1}
			data-testid={`file-mention-item-${String(index)}`}
			onMouseDown={(event) => {
				event.preventDefault();
				onChoose();
			}}
			onMouseEnter={onHighlight}
			className={cn(
				"flex min-h-11 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-[13px]",
				selected ? "bg-hover text-ink" : "text-ink-2",
			)}
		>
			<Icon className="size-4 shrink-0 text-ink-3" />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-baseline gap-2">
					<span className="min-w-0 truncate font-medium font-mono">{displayLabel(fileName)}</span>
					{directory && (
						<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3">
							{displayLabel(directory)}
						</span>
					)}
				</div>
				<p className="mt-0.5 truncate text-[11px] text-ink-3">{metadataSummary(file)}</p>
			</div>
			{file.availability !== "ready" && <AlertTriangle className="size-3.5 shrink-0 text-warning" />}
			{selected && <CornerDownLeft className="size-3.5 shrink-0 text-ink-3" />}
		</div>
	);
}

function metadataSummary(file: WorkspaceFileMetadataDto): string {
	const values = [
		file.byteSize === null ? tt("mention.sizeUnknown") : formatBytes(file.byteSize),
		tt(`mention.kind.${file.kind}` as never),
		file.estimatedTokens === null ? null : tt("mention.estimatedTokens", { count: file.estimatedTokens }),
		...file.risks.map((risk) => tt(riskKey(risk) as never)),
	];
	return values.filter(Boolean).join(" · ");
}

function riskKey(risk: WorkspaceFileRiskDto): string {
	return `mention.risk.${risk}`;
}
