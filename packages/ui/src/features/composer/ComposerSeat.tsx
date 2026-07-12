import { ImagePlus, Plus, SendHorizontal, Square, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { tt, useT } from "../../lib/i18n";
import { abortCurrentRun, submitDraft } from "../../lib/session-controller";
import { cn } from "../../lib/utils";
import { useComposerStore } from "../../stores/composer";
import { selectActiveTurnId, useProjectionStore } from "../../stores/projection";
import { useSessionDirectoryStore } from "../../stores/session-directory";
import { useSlashCommandsStore } from "../../stores/slash-commands";
import { ContextMeter } from "./ContextMeter";
import { ModelSelector } from "./ModelSelector";
import { QueueDock } from "./QueueDock";
import { SlashMenu } from "./SlashMenu";

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
	const queue = useComposerStore((s) => s.queue);
	const trigger = useComposerStore((s) => s.trigger);
	const deliveryMode = useComposerStore((s) => s.deliveryMode);
	const setDraft = useComposerStore((s) => s.setDraft);
	const setImages = useComposerStore((s) => s.setImages);
	const setTrigger = useComposerStore((s) => s.setTrigger);
	const setDeliveryMode = useComposerStore((s) => s.setDeliveryMode);

	const hasWorkspace = useSessionDirectoryStore((s) => s.currentWorkspaceId !== null);
	const hasSession = useSessionDirectoryStore((s) => s.currentSession !== null);
	const running = useProjectionStore(selectActiveTurnId) !== null;

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
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

	const queueCount = queue.steering.length + queue.followUp.length;

	const exactCommandMatch = useMemo(() => {
		if (!draft.trimStart().startsWith("/")) return true;
		const token = draft.trimStart().split(/\s/, 1)[0]?.slice(1) ?? "";
		return commands.some((command) => command.name === token);
	}, [draft, commands]);

	const submit = (mode: "prompt" | "steer" | "follow_up") => {
		if (!hasWorkspace || !hasSession) {
			toast.error(tt("composer.needWorkspaceSession"));
			return;
		}
		if (draft.trimStart().startsWith("/") && !exactCommandMatch) {
			toast.error(tt("composer.unknownCommand", { command: draft.trimStart().split(/\s/, 1)[0] ?? "" }), {
				description: tt("composer.unknownCommandDesc"),
			});
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
		if (event.key === "Enter" && !event.shiftKey && !composing) {
			event.preventDefault();
			if (trigger) {
				// Slash menu owns Enter: execute the highlighted command.
				window.dispatchEvent(new CustomEvent("piweb:slash-enter"));
				return;
			}
			if (running) {
				if ((event.metaKey || event.ctrlKey) && deliveryMode !== "follow_up") {
					setDeliveryMode("follow_up");
				}
				submit(deliveryMode === "follow_up" ? "follow_up" : "steer");
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

	const pickImage = (files: FileList | null) => {
		if (!files) return;
		for (const file of Array.from(files).slice(0, 4)) {
			if (!file.type.startsWith("image/")) continue;
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result;
				if (typeof result !== "string") return;
				const base64 = result.slice(result.indexOf(",") + 1);
				setImages([
					...useComposerStore.getState().images,
					{ type: "image", data: base64, mimeType: file.type },
				]);
			};
			reader.readAsDataURL(file);
		}
	};

	const focus = () => textareaRef.current?.focus();

	return (
		<div className="relative mx-auto w-full max-w-[780px] px-4 pb-3">
			<QueueDock />
			{trigger && (
				<SlashMenu
					anchorRef={cardRef}
					onExecute={(commandName) => {
						if (!trigger) return;
						const value = draft;
						const before = value.slice(0, trigger.index);
						const after = value.slice(trigger.index + 1 + trigger.query.length);
						setDraft(`${before}/${commandName} ${after}`);
						setTrigger(null);
						focus();
					}}
				/>
			)}
			<div ref={cardRef} className="rounded-xl border border-border bg-surface shadow-lv2">
				<div className="px-4 pt-3">
					{images.length > 0 && (
						<div className="mb-2 flex flex-wrap gap-2">
							{images.map((image, index) => (
								<div key={`${image.mimeType}:${index}`} className="group relative">
									<img
										src={`data:${image.mimeType};base64,${image.data}`}
										alt={tt("composer.attachment", { n: index + 1 })}
										className="h-16 rounded-md object-cover"
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
									: running
										? tt("composer.steerPlaceholder")
										: tt("composer.defaultPlaceholder")
						}
						rows={1}
						className="w-full resize-none bg-transparent text-[15px] leading-6 text-ink outline-none placeholder:text-ink-3"
						style={{ maxHeight: 24 * MAX_LINES }}
					/>
				</div>
				<div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
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
								aria-label={tt("composer.addImage")}
								onClick={() => document.getElementById("piweb-image-input")?.click()}
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
						onChange={(event) => pickImage(event.target.files)}
					/>

					{running && (
						<div className="ml-1 flex items-center gap-1 rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
							<Zap className="size-3 text-primary" />
							<button
								type="button"
								onClick={() => setDeliveryMode("steer")}
								className={cn(
									"rounded-full px-1.5 py-0.5 transition-colors",
									deliveryMode === "steer" && "bg-primary-soft text-primary",
								)}
							>
								插队
							</button>
							<button
								type="button"
								onClick={() => setDeliveryMode("follow_up")}
								className={cn(
									"rounded-full px-1.5 py-0.5 transition-colors",
									deliveryMode === "follow_up" && "bg-primary-soft text-primary",
								)}
							>
								排队
							</button>
						</div>
					)}

					<div className="flex-1" />

					<ModelSelector />
					<ContextMeter />

					{running && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									aria-label={tt("composer.stop")}
									className="text-danger"
									onClick={() => void abortCurrentRun()}
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
								className="size-[34px] rounded-full"
								disabled={!draft.trim() && images.length === 0 && queueCount === 0}
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
			{running && (
				<p className="mt-1.5 text-center text-[11px] text-ink-3">
					{tt("composer.runningHint1", {
						mode: deliveryMode === "follow_up" ? tt("status.followUp") : tt("status.steer"),
					})}
					{tt("composer.runningHint2", {
						other: deliveryMode === "follow_up" ? tt("status.steer") : tt("status.followUp"),
					})}
				</p>
			)}
		</div>
	);
}
