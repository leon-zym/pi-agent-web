import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import type { UiUserMessage } from "../../types/view-models";

const SOURCE_LABEL: Record<UiUserMessage["source"], string> = {
	prompt: "",
	steer: "插队",
	follow_up: "排队",
};

/**
 * Right-aligned light-blue bubble (DESIGN.md): max 525px, 22px radius,
 * queued injections carry a 插队/排队 badge.
 */
export function UserMessageBubble({ message }: { message: UiUserMessage }) {
	const [copied, setCopied] = useState(false);

	const copy = () => {
		void navigator.clipboard.writeText(message.text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<div className="flex flex-col items-end gap-1.5">
			<div className="group relative max-w-[525px] rounded-xl bg-user-bubble px-4 py-2.5">
				{message.text && (
					<p className="text-[15px] leading-[24px] whitespace-pre-wrap break-words text-ink">
						{message.text}
					</p>
				)}
				{message.images?.map((image, index) => (
					<img
						key={index}
						src={"data:" + image.mimeType + ";base64," + image.data}
						alt={"附件图片 " + (index + 1)}
						className="mt-2 max-h-64 rounded-md"
					/>
				))}
				<button
					type="button"
					aria-label="复制消息"
					className={cn(
						"absolute -bottom-2 -left-2 flex size-6 items-center justify-center rounded-full border border-border bg-surface text-ink-3 opacity-0 shadow-lv1 transition-opacity [@media(hover:hover)]:group-hover:opacity-100",
					)}
					onClick={copy}
				>
					{copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
				</button>
			</div>
			{!message.delivered && <span className="text-xs text-ink-3">等待注入</span>}
			{message.source !== "prompt" && (
				<Badge variant={message.source === "steer" ? "primary" : "default"}>
					{SOURCE_LABEL[message.source]}
				</Badge>
			)}
		</div>
	);
}
