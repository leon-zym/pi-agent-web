import { Check, Copy } from "lucide-react";
import { memo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { stripAnsi } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import type { UiUserMessage } from "../../types/view-models";

/**
 * Right-aligned light-blue bubble (DESIGN.md): max 525px, 22px radius,
 * queued injections carry a 插队/排队 badge.
 */
export const UserMessageBubble = memo(function UserMessageBubble({ message }: { message: UiUserMessage }) {
	const [copied, setCopied] = useState(false);
	const displayText = stripAnsi(message.text);

	const copy = () => {
		void navigator.clipboard.writeText(message.text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<div className="flex flex-col items-end gap-1.5">
			<div className="group relative max-w-[525px] rounded-xl bg-user-bubble px-4 py-2.5">
				{displayText && (
					<p className="text-[15px] leading-[24px] whitespace-pre-wrap break-words text-ink">{displayText}</p>
				)}
				{message.images?.map((image, index) => (
					<img
						key={`${image.mimeType}:${index}`}
						src={`data:${image.mimeType};base64,${image.data}`}
						alt={tt("composer.attachmentImage", { n: index + 1 })}
						className="mt-2 max-h-64 rounded-md"
					/>
				))}
				<button
					type="button"
					aria-label={tt("userMessage.copyAria")}
					className={cn(
						"absolute -bottom-2 -left-2 flex size-6 items-center justify-center rounded-full border border-border bg-surface text-ink-3 opacity-0 shadow-lv1 transition-opacity [@media(hover:hover)]:group-hover:opacity-100",
					)}
					onClick={copy}
				>
					{copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
				</button>
			</div>
			{!message.delivered && <span className="text-xs text-ink-3">{tt("status.waitingInjection")}</span>}
			{message.source !== "prompt" && (
				<Badge variant={message.source === "steer" ? "primary" : "default"}>
					{message.source === "steer" ? tt("status.steer") : tt("status.followUp")}
				</Badge>
			)}
		</div>
	);
});
