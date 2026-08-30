import type { SessionImageContentDto } from "@pi-agent-web/protocol";
import { Check, Copy } from "lucide-react";
import { memo, useRef, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { stripAnsi } from "../../lib/format";
import { tt } from "../../lib/i18n";
import { isSessionAttachmentImage, sessionImageKey, sessionImageSource } from "../../lib/session-attachment";
import { serializePresentedUserMessage } from "../../lib/user-message-presentation";
import { cn } from "../../lib/utils";
import type { UiUserMessage } from "../../types/view-models";

/**
 * Right-aligned semantic user bubble: max 525px, 22px radius,
 * queued injections carry a 插队/排队 badge.
 */
interface UserMessageBubbleProps {
	message: UiUserMessage;
	onAttachmentLoadError?: (image: SessionImageContentDto) => void;
}

const UserAttachmentImage = memo(function UserAttachmentImage({
	image,
	index,
	onLoadError,
}: {
	image: SessionImageContentDto;
	index: number;
	onLoadError?: (image: SessionImageContentDto) => void;
}) {
	const reportedFailure = useRef(false);
	const source = sessionImageSource(image);
	return (
		<img
			src={source}
			alt={tt("composer.attachmentImage", { n: index + 1 })}
			className="mt-2 max-h-64 max-w-full rounded-md"
			onError={() => {
				if (!isSessionAttachmentImage(image) || reportedFailure.current) return;
				reportedFailure.current = true;
				onLoadError?.(image);
			}}
		/>
	);
});

export const UserMessageBubble = memo(function UserMessageBubble({
	message,
	onAttachmentLoadError,
}: UserMessageBubbleProps) {
	const [copied, setCopied] = useState(false);
	const displayText = stripAnsi(message.text);
	const displayCommand = message.command ? stripAnsi(message.command) : undefined;
	const copyText = serializePresentedUserMessage({ text: message.text, command: message.command });

	const copy = () => {
		void navigator.clipboard.writeText(copyText).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<div className="flex min-w-0 max-w-full flex-col items-end gap-1.5">
			<div
				data-user-message="true"
				className="group relative min-w-0 max-w-[min(525px,100%)] rounded-xl bg-user-bubble px-4 py-2.5"
			>
				<div className="flex min-w-0 max-w-full flex-wrap items-baseline gap-1.5 text-[15px] leading-[24px] text-ink">
					{displayCommand && (
						<span className="inline-flex max-w-full rounded-md border border-primary/15 bg-primary/8 px-1.5 py-0.5 font-mono text-[12px] leading-5 text-primary">
							{displayCommand}
						</span>
					)}
					{displayText && (
						<span className="min-w-0 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere]">
							{displayText}
						</span>
					)}
				</div>
				{message.images?.map((image, index) => (
					<UserAttachmentImage
						key={sessionImageKey(image, index)}
						image={image}
						index={index}
						onLoadError={onAttachmentLoadError}
					/>
				))}
				<button
					type="button"
					aria-label={tt("userMessage.copyAria")}
					className={cn(
						"absolute -bottom-2 -left-2 flex size-6 items-center justify-center rounded-full text-ink-3 opacity-0 transition-opacity [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none [@media(hover:none)]:-bottom-4 [@media(hover:none)]:-left-4 [@media(hover:none)]:size-10 [@media(hover:none)]:opacity-100",
					)}
					onClick={copy}
				>
					<span className="flex size-6 items-center justify-center rounded-full border border-border bg-surface shadow-lv1">
						{copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
					</span>
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
