import { Check, ChevronLeft, ChevronsUpDown, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useModelDirectoryStore } from "../../stores/model-directory";
import { useSessionDirectoryStore } from "../../stores/session-directory";

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

	const currentModelObject = useMemo(
		() =>
			models.find((model) => model.provider === currentModel?.provider && model.id === currentModel?.modelId),
		[models, currentModel],
	);

	const supportsThinking = currentModelObject
		? currentModelObject.reasoning && thinkingLevels.length > 0
		: true;

	const selectModel = async (provider: string, modelId: string) => {
		const workspaceId = useSessionDirectoryStore.getState().currentWorkspaceId;
		if (!workspaceId) return;
		try {
			await useModelDirectoryStore.getState().selectModel(workspaceId, provider, modelId);
			setOpen(false);
			setPage("root");
		} catch (error) {
			toast.error(tt("model.switchFailed"), { description: error instanceof Error ? error.message : String(error) });
		}
	};

	const selectLevel = async (level: string) => {
		const workspaceId = useSessionDirectoryStore.getState().currentWorkspaceId;
		if (!workspaceId) return;
		try {
			await useModelDirectoryStore.getState().selectThinkingLevel(workspaceId, level as never);
			setOpen(false);
			setPage("root");
		} catch (error) {
			toast.error(tt("model.effortSwitchFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const label = [
		currentModel ? (currentModelObject?.name ?? currentModel.modelId) : tt("model.select"),
		supportsThinking && currentLevel ? tt(LEVEL_LABEL[currentLevel] as never) : null,
	]
		.filter(Boolean)
		.join(" · ");

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
					aria-label={tt("model.menuAria")}
					className="flex h-7 max-w-52 items-center gap-1 rounded-sm px-2 text-xs text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
				>
					<span className="min-w-0 truncate">{label}</span>
					<ChevronsUpDown className="size-3 shrink-0 text-ink-3" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64">
				{page === "root" && (
					<div className="flex flex-col p-0.5">
						<MenuItem
							icon={<Sparkles className="size-4 text-ink-3" />}
							label={tt("model.label")}
							value={currentModel ? (currentModelObject?.name ?? currentModel.modelId) : tt("model.none")}
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
					<div className="scroll-slim flex max-h-80 flex-col overflow-y-auto">
						<PageHeader title={tt("model.select")} onBack={() => setPage("root")} />
						{Object.entries(byProvider).map(([provider, providerModels]) => (
							<div key={provider}>
								<div className="sticky top-0 z-10 bg-surface px-2 py-1 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
									{provider}
								</div>
								{providerModels.map((model) => (
									<button
										key={model.id}
										type="button"
										className={cn(
											"flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-hover",
											currentModel?.provider === provider && currentModel?.modelId === model.id
												? "text-primary"
												: "text-ink",
										)}
										onClick={() => void selectModel(provider, model.id)}
									>
										<span className="min-w-0 flex-1 truncate">{model.name}</span>
										{currentModel?.provider === provider && currentModel?.modelId === model.id && (
											<Check className="size-4 shrink-0" />
										)}
									</button>
								))}
							</div>
						))}
					</div>
				)}
				{page === "effort" && (
					<div className="flex flex-col p-0.5">
						<PageHeader title={tt("model.effort")} onBack={() => setPage("root")} />
						{thinkingLevels.map((level) => (
							<button
								key={level}
								type="button"
								className={cn(
									"flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-hover",
									currentLevel === level ? "text-primary" : "text-ink",
								)}
								onClick={() => void selectLevel(level)}
							>
								<span className="flex-1">{tt(LEVEL_LABEL[level] as never)}</span>
								{currentLevel === level && <Check className="size-4" />}
							</button>
						))}
					</div>
				)}
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
			className="flex items-center gap-2 rounded-sm px-2 py-2 text-left text-[13px] text-ink transition-colors hover:bg-hover"
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
		<div className="flex items-center gap-1 px-1 py-1.5">
			<button
				type="button"
				aria-label={tt("model.back")}
				className="flex size-6 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
				onClick={onBack}
			>
				<ChevronLeft className="size-4" />
			</button>
			<span className="text-[13px] font-medium">{title}</span>
		</div>
	);
}
