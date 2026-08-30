import { expectCommandData, type SessionStateDto } from "@pi-agent-web/protocol";
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
import { isAudioMuted, setAudioMuted } from "../../lib/audio-feedback";
import { displayError } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { isSessionControlReady } from "../../lib/session-capabilities";
import { sendControlCommand } from "../../lib/session-controller";
import { useTheme } from "../../lib/use-theme";
import { cn } from "../../lib/utils";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { sessionTransport, useSessionTransportStore } from "../../stores/session-transport";

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
	disabled = false,
}: {
	options: Array<{ value: T; label: string }>;
	value: T;
	onChange: (value: T) => void;
	disabled?: boolean;
}) {
	return (
		<div className="flex items-center gap-0.5 rounded-sm bg-surface-2 p-0.5">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					onClick={() => onChange(option.value)}
					disabled={disabled}
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
	const sessionHandle = useSessionDirectoryStore((s) => s.currentSession?.sessionHandle ?? null);
	const canControl = useSessionTransportStore((transport) => {
		const channel = sessionHandle ? transport.sessions[sessionHandle] : undefined;
		return isSessionControlReady(channel);
	});
	const [state, setState] = useState<Pick<
		SessionStateDto,
		"autoCompactionEnabled" | "steeringMode" | "followUpMode"
	> | null>(null);
	const [audioMuted, setAudioMutedState] = useState(isAudioMuted);
	const { preference, set: setTheme } = useTheme();

	useEffect(() => {
		setState(null);
		if (!open || !sessionHandle) return;
		let cancelled = false;
		void sessionTransport.store
			.getState()
			.sendCommand(sessionHandle, { type: "get_state" })
			.then((response) => {
				const data = expectCommandData(response, "get_state");
				if (cancelled) return;
				setState({
					autoCompactionEnabled: data.autoCompactionEnabled,
					steeringMode: data.steeringMode,
					followUpMode: data.followUpMode,
				});
			})
			.catch(() => {
				// switches stay disabled
			});
		return () => {
			cancelled = true;
		};
	}, [open, sessionHandle]);

	useEffect(() => {
		if (open) setAudioMutedState(isAudioMuted());
	}, [open]);

	const toggleAutoCompaction = async (enabled: boolean) => {
		if (!sessionHandle || !state) return;
		const targetSessionHandle = sessionHandle;
		try {
			await sendControlCommand(targetSessionHandle, { type: "set_auto_compaction", enabled });
			if (useSessionDirectoryStore.getState().currentSession?.sessionHandle === targetSessionHandle) {
				setState((current) => (current ? { ...current, autoCompactionEnabled: enabled } : current));
			}
		} catch (error) {
			toast.error(tt("settings.saveFailed"), {
				description: displayError(error),
			});
		}
	};

	const setSteeringMode = async (mode: "all" | "one-at-a-time") => {
		if (!sessionHandle || !state) return;
		const targetSessionHandle = sessionHandle;
		try {
			await sendControlCommand(targetSessionHandle, { type: "set_steering_mode", mode });
			if (useSessionDirectoryStore.getState().currentSession?.sessionHandle === targetSessionHandle) {
				setState((current) => (current ? { ...current, steeringMode: mode } : current));
			}
		} catch (error) {
			toast.error(tt("settings.saveFailed"), {
				description: displayError(error),
			});
		}
	};

	const setFollowUpMode = async (mode: "all" | "one-at-a-time") => {
		if (!sessionHandle || !state) return;
		const targetSessionHandle = sessionHandle;
		try {
			await sendControlCommand(targetSessionHandle, { type: "set_follow_up_mode", mode });
			if (useSessionDirectoryStore.getState().currentSession?.sessionHandle === targetSessionHandle) {
				setState((current) => (current ? { ...current, followUpMode: mode } : current));
			}
		} catch (error) {
			toast.error(tt("settings.saveFailed"), {
				description: displayError(error),
			});
		}
	};

	const disabled = !sessionHandle || !state || !canControl;
	const setAudioEnabled = (enabled: boolean) => {
		const muted = !enabled;
		setAudioMuted(muted);
		setAudioMutedState(muted);
	};

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
									disabled={disabled}
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
									disabled={disabled}
								/>
							</div>
						</div>
					</div>

					<Separator />

					<div>
						<SectionLabel>{tt("settings.appearance")}</SectionLabel>
						<div className="flex flex-col gap-3">
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
							<div className="flex min-h-10 items-center justify-between gap-4">
								<div className="min-w-0">
									<label htmlFor="audio-chime" className="text-[13px] text-ink">
										{tt("audio.toggle")}
									</label>
									<p id="audio-chime-status" className="text-[12px] text-ink-3">
										{tt(audioMuted ? "audio.muted" : "audio.unmuted")}
									</p>
								</div>
								<Switch
									id="audio-chime"
									checked={!audioMuted}
									onCheckedChange={setAudioEnabled}
									aria-label={tt("audio.toggle")}
									aria-describedby="audio-chime-status"
								/>
							</div>
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
