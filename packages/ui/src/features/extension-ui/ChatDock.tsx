import { Clock, Maximize2, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { displayLabel, stripAnsi } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { type PendingDialog, useExtensionUiStore } from "../../stores/extension-ui";
import { useSessionControlStatus } from "../../stores/session-control";
import { SessionControlStatus } from "../session-control/SessionControlStatus";
import { parseOptionText } from "./QuestionCard";

/**
 * ChatDock:
 * Floating pill/dock pinned above Composer for minimized extension dialogs.
 * Maintains real-time response deadlines and quick inline interactions
 * without blocking the chat viewport.
 */
export function ChatDock() {
	const dialogs = useExtensionUiStore((s) => s.dialogs);
	const minimizedDialogIds = useExtensionUiStore((s) => s.minimizedDialogIds);

	const activeDialog = dialogs.find((d) => minimizedDialogIds[d.request.id] === true);
	const controlStatus = useSessionControlStatus(activeDialog?.sessionHandle ?? null);

	if (!activeDialog) return null;

	return <DockItem dialog={activeDialog} canControl={controlStatus.canControl} />;
}

function DockItem({ dialog, canControl }: { dialog: PendingDialog; canControl: boolean }) {
	const request = dialog.request;
	const respond = useExtensionUiStore((s) => s.respond);
	const maximize = useExtensionUiStore((s) => s.maximize);

	const [secondsLeft, setSecondsLeft] = useState<number | null>(() => {
		if (!dialog.deadlineAt) return null;
		return Math.max(0, Math.ceil((dialog.deadlineAt - Date.now()) / 1000));
	});

	useEffect(() => {
		if (!dialog.deadlineAt) return;
		const interval = setInterval(() => {
			const remaining = Math.max(0, Math.ceil((dialog.deadlineAt! - Date.now()) / 1000));
			setSecondsLeft(remaining);
		}, 1000);
		return () => clearInterval(interval);
	}, [dialog.deadlineAt]);

	const cancel = () => {
		if (!canControl) return;
		respond(dialog, { type: "extension_ui_response", id: request.id, cancelled: true });
	};

	const confirm = (val?: string) => {
		if (!canControl) return;
		if (request.method === "confirm") {
			respond(dialog, { type: "extension_ui_response", id: request.id, confirmed: true });
		} else if (request.method === "select") {
			if (val) {
				respond(dialog, { type: "extension_ui_response", id: request.id, value: val });
			}
		}
	};

	return (
		<div
			data-testid="chat-dock"
			className="mb-2 flex w-full flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2 shadow-lv2 transition-[opacity,transform] duration-150"
		>
			<SessionControlStatus sessionHandle={dialog.sessionHandle} surface="extension" showNotice={false} />
			<div className="flex min-w-0 items-center justify-between gap-2">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<Badge variant="primary" className="h-5 shrink-0 gap-1 px-1.5 text-[11px]">
						<Sparkles className="size-3" />
						{displayLabel(request.title || tt("ext.dockTitle"))}
					</Badge>

					{request.method === "confirm" && (
						<span className="min-w-0 truncate text-xs text-ink-2">{stripAnsi(request.message)}</span>
					)}

					{secondsLeft !== null && (
						<span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning tabular-nums">
							<Clock className="size-3" />
							{tt("ext.dockDeadline", { seconds: secondsLeft })}
						</span>
					)}
				</div>

				<div className="flex shrink-0 items-center gap-1">
					{request.method === "confirm" && (
						<>
							<Button
								size="sm"
								variant="outline"
								className="h-6 px-2 text-xs"
								onClick={cancel}
								disabled={!canControl || dialog.responding}
							>
								{tt("ext.cancel")}
							</Button>
							<Button
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={() => confirm()}
								disabled={!canControl || dialog.responding}
							>
								{tt("ext.confirm")}
							</Button>
						</>
					)}

					{request.method === "select" && (
						<div className="flex max-w-[280px] items-center gap-1 overflow-x-auto">
							{request.options.slice(0, 3).map((option) => {
								const parsed = parseOptionText(option);
								return (
									<Button
										key={option}
										size="sm"
										variant="outline"
										className={cn(
											"h-6 px-2 text-xs whitespace-nowrap",
											parsed.isRecommended && "border-primary/40 bg-primary-soft text-primary font-medium",
										)}
										onClick={() => confirm(option)}
										disabled={!canControl || dialog.responding}
									>
										{displayLabel(parsed.label)}
									</Button>
								);
							})}
						</div>
					)}
				</div>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							className="size-6 text-ink-3 hover:text-ink"
							aria-label={tt("ext.maximize")}
							onClick={() => maximize(request.id)}
						>
							<Maximize2 className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{tt("ext.maximize")}</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							className="size-6 text-ink-3 hover:text-danger"
							aria-label={tt("ext.cancel")}
							onClick={cancel}
							disabled={!canControl || dialog.responding}
						>
							<X className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{tt("ext.cancel")}</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
}
