import { ArrowRightLeft, Eye, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { tt } from "../../lib/i18n";
import {
	type SessionControlMode,
	type SessionControlStatus as SessionControlStatusModel,
	useSessionControlStatus,
	useSessionControlStore,
} from "../../stores/session-control";

export type SessionControlSurface = "header" | "composer" | "extension";

interface SessionControlStatusViewProps {
	status: SessionControlStatusModel;
	surface: SessionControlSurface;
	showNotice?: boolean;
}

function statusLabel(mode: SessionControlMode): string {
	switch (mode) {
		case "controller":
			return tt("lease.controller");
		case "view_only":
			return tt("lease.viewOnly");
		case "reconnecting":
			return tt("lease.reconnecting");
	}
}

function statusVariant(mode: SessionControlMode): "default" | "success" | "warning" {
	switch (mode) {
		case "controller":
			return "success";
		case "view_only":
			return "default";
		case "reconnecting":
			return "warning";
	}
}

function StatusIcon({ mode }: { mode: SessionControlMode }) {
	if (mode === "controller") return <ShieldCheck aria-hidden="true" className="size-3" />;
	if (mode === "view_only") return <Eye aria-hidden="true" className="size-3" />;
	return <RefreshCw aria-hidden="true" className="size-3" />;
}

function errorDescription(status: SessionControlStatusModel): string | null {
	const error = status.error;
	if (!error) return null;
	if (error.code === "session_lease_revision_stale") return tt("lease.takeoverStale");
	if (error.code === "session_generation_stale") return tt("lease.takeoverGenerationStale");
	if (error.code === "session_takeover_not_available") return tt("lease.takeoverUnavailable");
	if (error.operation === "takeover") return tt("lease.takeoverFailed");
	return null;
}

function SessionTakeoverAction({
	status,
	compact = false,
}: {
	status: SessionControlStatusModel;
	compact?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const pending = status.takeoverPending;
	if (!status.canTakeOver && !pending) return null;

	const submit = (event: React.MouseEvent<HTMLButtonElement>) => {
		if (!status.sessionHandle) {
			event.preventDefault();
			return;
		}
		if (!useSessionControlStore.getState().requestTakeover(status.sessionHandle)) {
			event.preventDefault();
			return;
		}
		setOpen(false);
	};

	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger asChild>
				<Button
					size="sm"
					variant="default"
					className="shrink-0"
					data-testid={`session-takeover-${compact ? "header" : (status.sessionHandle ?? "action")}`}
					aria-label={pending ? tt("lease.takeOverPending") : tt("lease.takeOver")}
					disabled={pending || !status.canTakeOver}
				>
					<ArrowRightLeft aria-hidden="true" className="size-3.5" />
					<span className={compact ? "hidden sm:inline" : undefined}>
						{pending ? tt("lease.takeOverPending") : tt("lease.takeOver")}
					</span>
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent className="w-[calc(100%-2rem)] max-w-md">
				<AlertDialogHeader>
					<AlertDialogTitle>{tt("lease.takeOverTitle")}</AlertDialogTitle>
					<AlertDialogDescription>{tt("lease.takeOverDescription")}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter className="flex-wrap">
					<AlertDialogCancel>{tt("common.cancel")}</AlertDialogCancel>
					<AlertDialogAction onClick={submit}>{tt("lease.takeOver")}</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

export function SessionControlStatusView({
	status,
	surface,
	showNotice = surface === "composer",
}: SessionControlStatusViewProps) {
	const error = errorDescription(status);
	const notice = showNotice && status.notice ? tt("lease.revoked") : null;

	if (surface === "header") {
		return (
			<div
				data-testid="session-control-status"
				data-session-control-mode={status.mode}
				className="flex min-w-0 shrink-0 items-center gap-1"
			>
				<Badge
					variant={statusVariant(status.mode)}
					className="max-w-32 gap-1 px-1.5 sm:px-2"
					title={statusLabel(status.mode)}
				>
					<StatusIcon mode={status.mode} />
					<span className="truncate">{statusLabel(status.mode)}</span>
				</Badge>
				<SessionTakeoverAction status={status} compact />
			</div>
		);
	}

	if (status.mode === "controller" && !error && !notice) return null;

	return (
		<div
			data-testid={`${surface}-session-control`}
			data-session-control-mode={status.mode}
			role={error || notice ? "status" : undefined}
			aria-live={error || notice ? "polite" : undefined}
			className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-[12px] text-ink-2"
		>
			<div className="flex min-w-0 flex-1 items-start gap-2">
				<Badge variant={statusVariant(status.mode)} className="mt-0.5 shrink-0 gap-1 px-1.5">
					<StatusIcon mode={status.mode} />
					{statusLabel(status.mode)}
				</Badge>
				<div className="min-w-0 leading-5">
					{notice && <p>{notice}</p>}
					{error && <p className={notice ? "mt-0.5 text-danger" : "text-danger"}>{error}</p>}
					{!notice && !error && (
						<p>
							{status.mode === "view_only" ? tt("lease.observerBanner") : tt("lease.reconnectingDescription")}
						</p>
					)}
				</div>
			</div>
			<SessionTakeoverAction status={status} />
		</div>
	);
}

export function SessionControlStatus({
	sessionHandle,
	surface,
	showNotice,
}: {
	sessionHandle: string | null;
	surface: SessionControlSurface;
	showNotice?: boolean;
}) {
	const status = useSessionControlStatus(sessionHandle);
	return <SessionControlStatusView status={status} surface={surface} showNotice={showNotice} />;
}
