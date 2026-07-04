import { ImagePlus, Plus, SendHorizontal, Square, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
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
 * While the agent runs, Enter injects as 插队 (steer), Cmd/Ctrl+Enter queues
 * as 排队 (follow_up); a bare prompt is blocked during streaming.
 */
export function ComposerSeat() {
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
		el.style.height = Math.min(el.scrollHeight, 24 * MAX_LINES) + "px";
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
			toast.error("请先打开工作区并选择会话");
			return;
		}
		if (draft.trimStart().startsWith("/") && !exactCommandMatch) {
			toast.error("未知命令：" + (draft.trimStart().split(/\s/, 1)[0] ?? ""), {
				description: "无法识别的 / 命令不会作为普通消息发送",
			});
			return;
		}
		if (draft.length > MAX_LENGTH) {
			toast.error("消息过长");
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
						setDraft(before + "/" + commandName + " " + after);
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
								<div key={index} className="group relative">
									<img
										src={"data:" + image.mimeType + ";base64," + image.data}
										alt={"附件 " + (index + 1)}
										className="h-16 rounded-md object-cover"
									/>
									<button
										type="button"
										aria-label="移除附件"
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
								? "在左侧选择一个工作区…"
								: !hasSession
									? "选择或新建会话后开始对话…"
									: running
										? "输入插队消息，回车注入；Cmd/Ctrl+Enter 排队…"
										: "输入消息，/ 打开命令菜单…"
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
								aria-label="命令菜单"
								onClick={() => {
									const el = textareaRef.current;
									if (!el) return;
									const cursor = el.selectionStart ?? draft.length;
									const at = detectSlashTrigger(draft, cursor);
									if (at) {
										setTrigger(at);
									} else {
										setDraft(draft + "/");
										setTrigger({ index: draft.length, query: "" });
									}
									focus();
								}}
							>
								<Plus className="size-4 text-ink-3" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>命令菜单（/）</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label="添加图片"
								onClick={() => document.getElementById("piweb-image-input")?.click()}
							>
								<ImagePlus className="size-4 text-ink-3" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>添加图片</TooltipContent>
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
									aria-label="停止"
									className="text-danger"
									onClick={() => void abortCurrentRun()}
								>
									<Square className="size-4 fill-current" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>停止当前运行</TooltipContent>
						</Tooltip>
					)}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								size="icon"
								aria-label={running ? "插队发送" : "发送"}
								className="size-[34px] rounded-full"
								disabled={!draft.trim() && images.length === 0 && queueCount === 0}
								onClick={() =>
									running ? submit(deliveryMode === "follow_up" ? "follow_up" : "steer") : submit("prompt")
								}
							>
								<SendHorizontal className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{running ? "发送（插队/排队）" : "发送"}</TooltipContent>
					</Tooltip>
				</div>
			</div>
			{running && (
				<p className="mt-1.5 text-center text-[11px] text-ink-3">
					运行中：回车以「{deliveryMode === "follow_up" ? "排队" : "插队"}」注入，Cmd/Ctrl+Enter 切换为「
					{deliveryMode === "follow_up" ? "插队" : "排队"}」
				</p>
			)}
		</div>
	);
}
