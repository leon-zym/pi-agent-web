import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { stripAnsi } from "../../lib/format";
import { cn } from "../../lib/utils";
import "highlight.js/styles/github.css";

/**
 * Assistant prose renderer: only text + streaming props.
 * Full syntax highlighting runs once the block settles; while streaming we
 * render plain so each delta stays cheap and React keys stay stable.
 */
export const MarkdownBlock = memo(function MarkdownBlock({
	text,
	streaming,
}: {
	text: string;
	streaming: boolean;
}) {
	const displayText = stripAnsi(text);

	return (
		<div
			className={cn(
				"text-[15px] leading-[26px] break-words text-ink",
				"[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
				"[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
				"[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
				"[&_li]:my-1",
				"[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold",
				"[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold",
				"[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold",
				"[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-primary/40",
				"[&_code]:rounded-xs [&_code]:bg-surface-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-ink",
				"[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-2 [&_pre]:p-3 [&_pre]:text-[13px] [&_pre]:leading-[20px]",
				"[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[13px]",
				"[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-ink-2",
				"[&_hr]:my-4 [&_hr]:border-border",
				"[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[14px]",
				"[&_th]:border [&_th]:border-border [&_th]:bg-surface-2 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium",
				"[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
				"[&_img]:my-2 [&_img]:max-w-full [&_img]:rounded-md",
			)}
		>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={streaming ? [] : [rehypeHighlight]}
				components={{
					a: (props) => <a {...props} target="_blank" rel="noreferrer noopener" />,
				}}
			>
				{displayText}
			</ReactMarkdown>
		</div>
	);
});
