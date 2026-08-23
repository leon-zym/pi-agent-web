import { Check, ChevronLeft, ChevronsUpDown, Settings2, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { displayError, displayLabel } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useModelDirectoryStore } from "../../stores/model-directory";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useSessionTransportStore } from "../../stores/session-transport";

const LEVEL_LABEL: Record<string, string> = {
	off: "model.levelOff",
	minimal: "model.levelMinimal",
	low: "model.levelLow",
	medium: "model.levelMedium",
	high: "model.levelHigh",
	xhigh: "model.levelXhigh",
	max: "model.levelMax",
};

type Page = "root" | "model" | "effort";

/**
 * Two-level model / thinking menu. The host-reported
 * current selection is the only truth; failures keep the previous selection
 * and toast near the composer. Changes apply to the NEXT request.
 */
export function ModelSelector() {
	const models = useModelDirectoryStore((s) => s.models);
	const byProvider = useModelDirectoryStore((s) => s.byProvider);
	const currentModel = useModelDirectoryStore((s) => s.currentModel);
	const thinkingLevels = useModelDirectoryStore((s) => s.thinkingLevels);
	const currentLevel = useModelDirectoryStore((s) => s.currentThinkingLevel);
	const [page, setPage] = useState<Page>("root");
	const [open, setOpen] = useState(false);
	const sessionHandle = useSessionDirectoryStore((s) => s.currentSession?.sessionHandle ?? null);
	const canControl = useSessionTransportStore((state) => {
		const channel = sessionHandle ? state.sessions[sessionHandle] : undefined;
		return Boolean(channel?.lease.isController && channel.lease.fencingToken);
	});
	const runtimeState = useSessionTransportStore((state) =>
		sessionHandle ? state.sessions[sessionHandle]?.runtime?.state : undefined,
	);
	const runtimeBusy = runtimeState === "running" || runtimeState === "waiting_ui";
	const hasModels = models.length > 0;

	const currentModelObject = useMemo(
		() =>
			models.find((model) => model.provider === currentModel?.provider && model.id === currentModel?.modelId),
		[models, currentModel],
	);

	const supportsThinking = Boolean(hasModels && currentModelObject?.reasoning && thinkingLevels.length > 0);

	const selectModel = async (provider: string, modelId: string) => {
		const sessionHandle = useSessionDirectoryStore.getState().currentSession?.sessionHandle;
		if (!sessionHandle) return;
		try {
			await useModelDirectoryStore.getState().selectModel(sessionHandle, provider, modelId);
			setPage("root");
		} catch (error) {
			toast.error(tt("model.switchFailed"), {
				description: displayError(error),
			});
		}
	};

	const selectLevel = async (level: string) => {
		const sessionHandle = useSessionDirectoryStore.getState().currentSession?.sessionHandle;
		if (!sessionHandle) return;
		try {
			await useModelDirectoryStore.getState().selectThinkingLevel(sessionHandle, level as never);
			setPage("root");
		} catch (error) {
			toast.error(tt("model.effortSwitchFailed"), {
				description: displayError(error),
			});
		}
	};

	const label = [
		!hasModels
			? tt("model.configure")
			: currentModel
				? displayLabel(currentModelObject?.name ?? currentModel.modelId)
				: tt("model.select"),
		supportsThinking && currentLevel ? tt(LEVEL_LABEL[currentLevel] as never) : null,
	]
		.filter(Boolean)
		.join(" · ");
	const compactLabel = hasModels ? label : tt("model.noModels");

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setPage("root");
			}}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={tt(hasModels ? "model.menuAria" : "model.configure")}
					disabled={!canControl}
					className="flex h-7 min-w-0 max-w-26 items-center gap-1 rounded-sm px-1.5 text-xs text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none sm:max-w-52 sm:px-2 max-lg:h-10 max-lg:min-w-10"
				>
					<span className="min-w-0 truncate sm:hidden">{compactLabel}</span>
					<span className="hidden min-w-0 truncate sm:inline">{label}</span>
					<ChevronsUpDown className="size-3 shrink-0 text-ink-3" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64">
				{page === "root" && (
					<div className="flex flex-col p-0.5">
						<MenuItem
							icon={<Sparkles className="size-4 text-ink-3" />}
							label={tt("model.label")}
							value={
								!hasModels
									? tt("model.noModels")
									: currentModel
										? displayLabel(currentModelObject?.name ?? currentModel.modelId)
										: tt("model.none")
							}
							onClick={() => setPage("model")}
						/>
						{supportsThinking && (
							<MenuItem
								icon={<Sparkles className="size-4 text-ink-3" />}
								label={tt("model.effort")}
								value={currentLevel ? tt(LEVEL_LABEL[currentLevel] as never) : "—"}
								onClick={() => setPage("effort")}
							/>
						)}
					</div>
				)}
				{page === "model" && (
					<div className="flex max-h-80 flex-col overflow-hidden">
						<PageHeader title={tt("model.select")} onBack={() => setPage("root")} />
						<div className="scroll-slim min-h-0 overflow-y-auto">
							{!hasModels && (
								<div className="px-3 py-3">
									<p className="text-xs leading-5 text-ink-3">{tt("model.noModelsHint")}</p>
									<button
										type="button"
										className="mt-2 inline-flex h-10 items-center gap-1.5 rounded-sm bg-primary px-2.5 text-xs font-medium text-white hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none lg:h-7"
										onClick={() => {
											setOpen(false);
											window.dispatchEvent(new CustomEvent("piweb:open-settings"));
										}}
									>
										<Settings2 className="size-3.5" />
										{tt("model.configure")}
									</button>
								</div>
							)}
							{Object.entries(byProvider).map(([provider, providerModels]) => (
								<div key={provider}>
									<div className="sticky top-0 z-10 bg-surface px-2 py-1 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
										{displayLabel(provider)}
									</div>
									{providerModels.map((model) => (
										<button
											key={model.id}
											type="button"
											className={cn(
												"flex min-h-10 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-hover lg:min-h-0",
												currentModel?.provider === provider && currentModel?.modelId === model.id
													? "text-primary"
													: "text-ink",
											)}
											disabled={!canControl}
											onClick={() => void selectModel(provider, model.id)}
										>
											<span className="min-w-0 flex-1 truncate">{displayLabel(model.name)}</span>
											{currentModel?.provider === provider && currentModel?.modelId === model.id && (
												<Check className="size-4 shrink-0" />
											)}
										</button>
									))}
								</div>
							))}
						</div>
					</div>
				)}
				{page === "effort" && (
					<div className="flex flex-col p-1 gap-2">
						<PageHeader title={tt("model.effort")} onBack={() => setPage("root")} />
						<div className="p-1">
							<SegmentedControl
								className="w-full justify-between"
								value={currentLevel}
								onChange={(level) => void selectLevel(level)}
								disabled={!canControl}
								options={thinkingLevels.map((level) => ({
									value: level,
									label: tt(LEVEL_LABEL[level] as never),
								}))}
							/>
						</div>
					</div>
				)}

				<p className="mt-1 border-t border-border px-2 pt-2 pb-1 text-[11px] leading-4 text-ink-3">
					{tt(runtimeBusy ? "model.nextRequestBusy" : "model.nextRequest")}
				</p>
			</PopoverContent>
		</Popover>
	);
}

function MenuItem({
	icon,
	label,
	value,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	value: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className="flex min-h-10 items-center gap-2 rounded-sm px-2 py-2 text-left text-[13px] text-ink transition-colors hover:bg-hover"
			onClick={onClick}
		>
			{icon}
			<span className="flex-1">{label}</span>
			<span className="max-w-32 truncate text-xs text-ink-3">{value}</span>
		</button>
	);
}

function PageHeader({ title, onBack }: { title: string; onBack: () => void }) {
	return (
		<div className="z-20 flex flex-none items-center gap-1 border-b border-border bg-surface px-1 py-1.5">
			<button
				type="button"
				aria-label={tt("model.back")}
				className="flex size-10 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink lg:size-6"
				onClick={onBack}
			>
				<ChevronLeft className="size-4" />
			</button>
			<span className="text-[13px] font-medium">{title}</span>
		</div>
	);
}
