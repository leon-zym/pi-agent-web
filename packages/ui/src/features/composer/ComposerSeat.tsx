import { ImagePlus, Plus, SendHorizontal, Square, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { stripAnsi } from "../../lib/format";
import { tt, useT } from "../../lib/i18n";
import { ImageAttachmentError, prepareImageAttachments } from "../../lib/image-attachments";
import { abortCurrentRun, submitDraft } from "../../lib/session-controller";
import { cn } from "../../lib/utils";
import { useComposerStore } from "../../stores/composer";
import { selectActiveTurnId, useProjectionStore } from "../../stores/projection";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useSessionTransportStore } from "../../stores/session-transport";
import { useSlashCommandsStore } from "../../stores/slash-commands";
import { ContextMeter } from "./ContextMeter";
import { resolveRunningSubmitKind } from "./composer-input";
import { ModelSelector } from "./ModelSelector";
import { QueueDock } from "./QueueDock";
import { SlashMenu, type SlashMenuHandle } from "./SlashMenu";
import { insertSlashCommand } from "./slash-menu-model";

const MAX_LINES = 14;
const MAX_LENGTH = 100_000;

function detectSlashTrigger(text: string, cursorIndex: number): { index: number; query: string } | null {
	// A slash opens the menu at line start or after whitespace/punctuation, and
	// never inside a URL (https:// must not trigger).
	const start = text.lastIndexOf("/", cursorIndex - 1);
	if (start === -1) return null;
	const before = text[start - 1];
	if (start > 0 && before !== undefined && !/[\s，。、：；！？""''（）：]/.test(before)) return null;
	const after = text.slice(start + 1, cursorIndex);
	if (/\s/.test(after)) return null;
	if (/[.:]\/\//.test(text.slice(start - 2, start + 2))) return null;
	if (after.startsWith("/")) return null;
	return { index: start, query: after };
}

/**
 * Persistent sticky composer (DESIGN.md): one DOM instance across session
 * switches, floating capsule card, queue dock above, toolbar below.
 * While the agent runs, Enter injects as steer, Cmd/Ctrl+Enter queues
 * as follow-up; a bare prompt is blocked during streaming.
 */
export function ComposerSeat() {
	const { t } = useT();
	void t;
	const draft = useComposerStore((s) => s.draft);
	const images = useComposerStore((s) => s.images);
	const trigger = useComposerStore((s) => s.trigger);
	const deliveryMode = useComposerStore((s) => s.deliveryMode);
	const submitting = useComposerStore((s) => s.submitState === "submitting");
	const setDraft = useComposerStore((s) => s.setDraft);
	const setImages = useComposerStore((s) => s.setImages);
	const setTrigger = useComposerStore((s) => s.setTrigger);
	const setDeliveryMode = useComposerStore((s) => s.setDeliveryMode);

	const hasWorkspace = useSessionDirectoryStore((s) => s.currentWorkspaceHandle !== null);
	const hasSession = useSessionDirectoryStore((s) => s.currentSession !== null);
	const sessionHandle = useSessionDirectoryStore((s) => s.currentSession?.sessionHandle ?? null);
	const canControl = useSessionTransportStore((state) => {
		const channel = sessionHandle ? state.sessions[sessionHandle] : undefined;
		return Boolean(channel?.lease.isController && channel.lease.fencingToken);
	});
	const runtimeBusy = useSessionTransportStore((state) => {
		const runtimeState = sessionHandle ? state.sessions[sessionHandle]?.runtime?.state : undefined;
		return runtimeState === "running" || runtimeState === "waiting_ui";
	});
	const activeTurnId = useProjectionStore(selectActiveTurnId);
	const running = runtimeBusy || activeTurnId !== null;

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const slashMenuRef = useRef<SlashMenuHandle>(null);
	const [composing, setComposing] = useState(false);

	const commands = useSlashCommandsStore((s) => s.commands);

	const adjustHeight = () => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 24 * MAX_LINES)}px`;
	};

	useEffect(() => {
		adjustHeight();
	}, [draft]);

	const exactCommandMatch = useMemo(() => {
		if (!draft.trimStart().startsWith("/")) return true;
		const token = draft.trimStart().split(/\s/, 1)[0]?.slice(1) ?? "";
		return commands.some((command) => command.name === token);
	}, [draft, commands]);

	const submit = (mode: "prompt" | "steer" | "follow_up") => {
		if (useComposerStore.getState().submitState === "submitting") return;
		if (!hasWorkspace || !hasSession || !canControl) {
			toast.error(tt("composer.needWorkspaceSession"));
			return;
		}
		if (draft.trimStart().startsWith("/") && !exactCommandMatch) {
			toast.error(
				tt("composer.unknownCommand", {
					command: stripAnsi(draft.trimStart().split(/\s/, 1)[0] ?? ""),
				}),
				{
					description: tt("composer.unknownCommandDesc"),
				},
			);
			return;
		}
		if (draft.length > MAX_LENGTH) {
			toast.error(tt("composer.tooLong"));
			return;
		}
		setTrigger(null);
		window.dispatchEvent(new CustomEvent("piweb:scroll-bottom"));
		void submitDraft(mode);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (!canControl) return;
		if (trigger && !composing) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				slashMenuRef.current?.move(event.key === "ArrowDown" ? 1 : -1);
				return;
			}
			if (event.key === "Home" || event.key === "End") {
				event.preventDefault();
				slashMenuRef.current?.moveTo(event.key === "Home" ? "first" : "last");
				return;
			}
			const commitWithEnter = event.key === "Enter" && !event.shiftKey;
			const commitWithSpace =
				event.key === " " && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
			if (commitWithEnter || commitWithSpace) {
				const executed = slashMenuRef.current?.commitExact() ?? false;
				if (executed) {
					event.preventDefault();
					return;
				}
			}
		}
		if (event.key === "Enter" && !event.shiftKey && !composing) {
			event.preventDefault();
			if (running) {
				const queueShortcut = event.metaKey || event.ctrlKey;
				const kind = resolveRunningSubmitKind(deliveryMode, queueShortcut);
				if (queueShortcut && deliveryMode !== "follow_up") {
					setDeliveryMode("follow_up");
				}
				submit(kind);
			} else {
				submit("prompt");
			}
		}
		if (event.key === "Escape" && trigger) {
			setTrigger(null);
		}
	};

	const onInput = () => {
		const el = textareaRef.current;
		if (!el) return;
		const value = el.value;
		const cursor = el.selectionStart ?? value.length;
		setDraft(value);
		setTrigger(detectSlashTrigger(value, cursor));
		adjustHeight();
	};

	const pickImage = async (files: FileList | null) => {
		if (!files) return;
		const targetSessionHandle = useSessionDirectoryStore.getState().currentSession?.sessionHandle;
		if (!targetSessionHandle) return;
		const existing = useComposerStore.getState().bySession[targetSessionHandle]?.images ?? [];
		try {
			const prepared = await prepareImageAttachments(Array.from(files), existing);
			useComposerStore.getState().setImagesForSession(targetSessionHandle, prepared);
		} catch (error) {
			const code = error instanceof ImageAttachmentError ? error.code : "decode_failed";
			toast.error(tt(`composer.imageError.${code}` as never));
		}
	};

	const focus = () => textareaRef.current?.focus();

	return (
		<div className="relative mx-auto w-full max-w-[780px] px-3 pb-3 sm:px-4">
			<QueueDock />
			{hasWorkspace && !canControl && (
				<p className="mb-2 rounded-sm bg-surface-2 px-3 py-2 text-[12px] text-ink-3">
					{tt("lease.readOnly")}
				</p>
			)}
			{trigger && (
				<SlashMenu
					ref={slashMenuRef}
					onExecute={(commandName) => {
						if (!trigger) return;
						setDraft(insertSlashCommand(draft, trigger, commandName));
						setTrigger(null);
						focus();
					}}
				/>
			)}
			<div
				data-testid="composer-card"
				className="min-w-0 rounded-xl border border-border bg-surface shadow-lv2"
				aria-busy={submitting}
			>
				<div className="px-4 pt-3">
					{images.length > 0 && (
						<div className="mb-2 flex flex-wrap gap-2">
							{images.map((image, index) => (
								<div key={`${image.mimeType}:${index}`} className="group relative">
									<img
										src={`data:${image.mimeType};base64,${image.data}`}
										alt={tt("composer.attachment", { n: index + 1 })}
										className="size-16 rounded-md object-cover"
									/>
									<button
										type="button"
										aria-label={tt("composer.removeAttachment")}
										className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-surface text-ink-3 shadow-lv1 hover:text-danger"
										onClick={() => setImages(images.filter((_, i) => i !== index))}
									>
										×
									</button>
								</div>
							))}
						</div>
					)}
					<textarea
						ref={textareaRef}
						value={draft}
						onChange={onInput}
						onKeyDown={onKeyDown}
						onCompositionStart={() => setComposing(true)}
						onCompositionEnd={() => setComposing(false)}
						placeholder={
							!hasWorkspace
								? tt("composer.pickWorkspace")
								: !hasSession
									? tt("composer.pickSession")
									: !canControl
										? tt("lease.observerPlaceholder")
										: running
											? tt("composer.steerPlaceholder")
											: tt("composer.defaultPlaceholder")
						}
						rows={1}
						disabled={!canControl}
						className="w-full resize-none bg-transparent text-[15px] leading-6 text-ink outline-none placeholder:text-ink-3"
						style={{ maxHeight: 24 * MAX_LINES }}
					/>
				</div>
				{running && (
					<div className="px-3 pt-1 sm:hidden">
						<div className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
							<Zap className="size-3 text-primary" />
							<button
								type="button"
								onClick={() => setDeliveryMode("steer")}
								className={cn(
									"min-h-10 rounded-full px-3 transition-colors",
									deliveryMode === "steer" && "bg-primary-soft text-primary",
								)}
							>
								{tt("status.steer")}
							</button>
							<button
								type="button"
								onClick={() => setDeliveryMode("follow_up")}
								className={cn(
									"min-h-10 rounded-full px-3 transition-colors",
									deliveryMode === "follow_up" && "bg-primary-soft text-primary",
								)}
							>
								{tt("status.followUp")}
							</button>
						</div>
					</div>
				)}
				<div
					data-testid="composer-toolbar"
					className="flex min-w-0 items-center gap-0.5 overflow-hidden px-2 pt-1 pb-2.5 sm:gap-1 sm:px-2.5"
				>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="max-lg:size-10 shrink-0"
								aria-label={tt("composer.commandMenu")}
								onClick={() => {
									const el = textareaRef.current;
									if (!el) return;
									const cursor = el.selectionStart ?? draft.length;
									const at = detectSlashTrigger(draft, cursor);
									if (at) {
										setTrigger(at);
									} else {
										setDraft(`${draft}/`);
										setTrigger({ index: draft.length, query: "" });
									}
									focus();
								}}
								disabled={!canControl}
							>
								<Plus className="size-4 text-ink-3" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{tt("composer.commandMenuSlash")}</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="max-lg:size-10 shrink-0"
								aria-label={tt("composer.addImage")}
								onClick={() => document.getElementById("piweb-image-input")?.click()}
								disabled={!canControl}
							>
								<ImagePlus className="size-4 text-ink-3" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{tt("composer.addImage")}</TooltipContent>
					</Tooltip>
					<input
						id="piweb-image-input"
						type="file"
						accept="image/*"
						multiple
						className="hidden"
						onChange={(event) => {
							void pickImage(event.target.files);
							event.currentTarget.value = "";
						}}
						disabled={!canControl}
					/>

					{running && (
						<div className="ml-1 hidden items-center gap-1 rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2 sm:flex">
							<Zap className="size-3 text-primary" />
							<button
								type="button"
								onClick={() => setDeliveryMode("steer")}
								className={cn(
									"max-lg:min-h-10 max-lg:px-3 rounded-full px-1.5 py-0.5 transition-colors",
									deliveryMode === "steer" && "bg-primary-soft text-primary",
								)}
							>
								{tt("status.steer")}
							</button>
							<button
								type="button"
								onClick={() => setDeliveryMode("follow_up")}
								className={cn(
									"max-lg:min-h-10 max-lg:px-3 rounded-full px-1.5 py-0.5 transition-colors",
									deliveryMode === "follow_up" && "bg-primary-soft text-primary",
								)}
							>
								{tt("status.followUp")}
							</button>
						</div>
					)}

					<div className="min-w-0 flex-1" />

					<div className="flex min-w-0 items-center justify-end gap-0.5 sm:gap-1">
						<ModelSelector />
						<ContextMeter />

						{running && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										aria-label={tt("composer.stop")}
										className="max-lg:size-10 shrink-0 text-danger"
										onClick={() => void abortCurrentRun()}
										disabled={!canControl}
									>
										<Square className="size-4 fill-current" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>{tt("composer.stopCurrent")}</TooltipContent>
							</Tooltip>
						)}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="icon"
									aria-label={running ? tt("composer.steerSend") : tt("composer.send")}
									className="size-[34px] max-lg:size-10 shrink-0 rounded-full"
									disabled={!canControl || submitting || (!draft.trim() && images.length === 0)}
									onClick={() =>
										running ? submit(deliveryMode === "follow_up" ? "follow_up" : "steer") : submit("prompt")
									}
								>
									<SendHorizontal className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{running ? tt("composer.sendQueued") : tt("composer.send")}</TooltipContent>
						</Tooltip>
					</div>
				</div>
			</div>
			{running && (
				<p className="mt-1.5 hidden text-center text-[11px] text-ink-3 sm:block">
					{tt("composer.runningHint1", {
						mode: deliveryMode === "follow_up" ? tt("status.followUp") : tt("status.steer"),
					})}
					{tt("composer.runningHint2")}
				</p>
			)}
		</div>
	);
}
