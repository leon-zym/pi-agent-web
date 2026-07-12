import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import { expectData } from "@pi-agent-web/protocol";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../../components/ui/dialog";
import { Separator } from "../../components/ui/separator";
import { Switch } from "../../components/ui/switch";
import { tt } from "../../lib/i18n";
import { useTheme } from "../../lib/use-theme";
import { cn } from "../../lib/utils";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useTransportStore } from "../../stores/transport";

interface SettingsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return <p className="mb-2 text-[11px] font-medium tracking-wide text-ink-3 uppercase">{children}</p>;
}

function Segmented<T extends string>({
	options,
	value,
	onChange,
}: {
	options: Array<{ value: T; label: string }>;
	value: T;
	onChange: (value: T) => void;
}) {
	return (
		<div className="flex items-center gap-0.5 rounded-sm bg-surface-2 p-0.5">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					onClick={() => onChange(option.value)}
					className={cn(
						"rounded-sm px-2 py-0.5 text-[12px] transition-colors",
						value === option.value
							? "bg-surface font-medium text-ink shadow-lv1"
							: "text-ink-3 hover:text-ink-2",
					)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

/**
 * Session / appearance settings: all toggles write
 * through RPC commands into ~/.pi/agent/settings.json.
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
	const workspaceId = useSessionDirectoryStore((s) => s.currentWorkspaceId);
	const [state, setState] = useState<Pick<
		RpcSessionState,
		"autoCompactionEnabled" | "steeringMode" | "followUpMode"
	> | null>(null);
	const [autoRetry, setAutoRetry] = useState(true);
	const { preference, set: setTheme } = useTheme();

	useEffect(() => {
		if (!open || !workspaceId) return;
		void useTransportStore
			.getState()
			.sendCommand(workspaceId, { type: "get_state" })
			.then((response) => {
				const data = expectData(response) as RpcSessionState;
				setState({
					autoCompactionEnabled: data.autoCompactionEnabled,
					steeringMode: data.steeringMode,
					followUpMode: data.followUpMode,
				});
			})
			.catch(() => {
				// switches stay disabled
			});
	}, [open, workspaceId]);

	const toggleAutoCompaction = async (enabled: boolean) => {
		if (!workspaceId || !state) return;
		setState({ ...state, autoCompactionEnabled: enabled });
		try {
			await useTransportStore.getState().sendCommand(workspaceId, { type: "set_auto_compaction", enabled });
		} catch (error) {
			toast.error(tt("settings.saveFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const toggleAutoRetry = async (enabled: boolean) => {
		if (!workspaceId) return;
		setAutoRetry(enabled);
		try {
			await useTransportStore.getState().sendCommand(workspaceId, { type: "set_auto_retry", enabled });
		} catch (error) {
			toast.error(tt("settings.saveFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const setSteeringMode = async (mode: "all" | "one-at-a-time") => {
		if (!workspaceId || !state) return;
		setState({ ...state, steeringMode: mode });
		try {
			await useTransportStore.getState().sendCommand(workspaceId, { type: "set_steering_mode", mode });
		} catch (error) {
			toast.error(tt("settings.saveFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const setFollowUpMode = async (mode: "all" | "one-at-a-time") => {
		if (!workspaceId || !state) return;
		setState({ ...state, followUpMode: mode });
		try {
			await useTransportStore.getState().sendCommand(workspaceId, { type: "set_follow_up_mode", mode });
		} catch (error) {
			toast.error(tt("settings.saveFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const disabled = !workspaceId || !state;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{tt("settings.title")}</DialogTitle>
					<DialogDescription>{tt("settings.description")}</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<div>
						<SectionLabel>{tt("settings.session")}</SectionLabel>
						<div className="flex flex-col gap-3">
							<div className="flex items-center justify-between gap-4">
								<div className="min-w-0">
									<p className="text-[13px] text-ink">{tt("settings.autoCompaction")}</p>
									<p className="text-[12px] text-ink-3">{tt("settings.autoCompactionDesc")}</p>
								</div>
								<Switch
									checked={state?.autoCompactionEnabled ?? false}
									disabled={disabled}
									onCheckedChange={(checked) => void toggleAutoCompaction(checked)}
									aria-label={tt("settings.autoCompaction")}
								/>
							</div>
							<div className="flex items-center justify-between gap-4">
								<div className="min-w-0">
									<p className="text-[13px] text-ink">{tt("settings.autoRetry")}</p>
									<p className="text-[12px] text-ink-3">{tt("settings.autoRetryDesc")}</p>
								</div>
								<Switch
									checked={autoRetry}
									disabled={disabled}
									onCheckedChange={(checked) => void toggleAutoRetry(checked)}
									aria-label={tt("settings.autoRetry")}
								/>
							</div>
							<div className="flex items-center justify-between gap-4">
								<div className="min-w-0">
									<p className="text-[13px] text-ink">{tt("settings.steerMode")}</p>
									<p className="text-[12px] text-ink-3">{tt("settings.steerModeDesc")}</p>
								</div>
								<Segmented
									options={[
										{ value: "one-at-a-time", label: tt("settings.oneAtATime") },
										{ value: "all", label: tt("settings.all") },
									]}
									value={state?.steeringMode ?? "one-at-a-time"}
									onChange={(value) => void setSteeringMode(value)}
								/>
							</div>
							<div className="flex items-center justify-between gap-4">
								<div className="min-w-0">
									<p className="text-[13px] text-ink">{tt("settings.followUpMode")}</p>
									<p className="text-[12px] text-ink-3">{tt("settings.followUpModeDesc")}</p>
								</div>
								<Segmented
									options={[
										{ value: "one-at-a-time", label: tt("settings.oneAtATime") },
										{ value: "all", label: tt("settings.all") },
									]}
									value={state?.followUpMode ?? "one-at-a-time"}
									onChange={(value) => void setFollowUpMode(value)}
								/>
							</div>
						</div>
					</div>

					<Separator />

					<div>
						<SectionLabel>{tt("settings.appearance")}</SectionLabel>
						<div className="flex items-center justify-between gap-4">
							<p className="text-[13px] text-ink">{tt("sidebar.theme")}</p>
							<Segmented
								options={[
									{ value: "light", label: tt("sidebar.themeLight") },
									{ value: "dark", label: tt("sidebar.themeDark") },
									{ value: "system", label: tt("sidebar.themeSystem") },
								]}
								value={preference}
								onChange={setTheme}
							/>
						</div>
					</div>

					{disabled && <p className="text-[12px] text-ink-3">{tt("settings.openWorkspaceHint")}</p>}
				</div>

				<div className="flex justify-end">
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{tt("common.close")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
