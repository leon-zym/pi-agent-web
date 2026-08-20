import { lazy, memo, Suspense } from "react";
import { stripAnsi } from "../../lib/format";
import { cn } from "../../lib/utils";

const SettledMarkdown = lazy(() => import("./SettledMarkdown"));

function PlainMarkdownFallback({ text }: { text: string }) {
	return <div className="whitespace-pre-wrap">{text}</div>;
}

/**
 * Assistant prose renderer: only text + streaming props.
 * Streaming stays on a stable plain-text renderer. The full Markdown parser
 * and syntax highlighter load only after settlement, keeping them out of the
 * initial bundle and off the high-frequency delta path.
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
				"min-w-0 max-w-full text-[15px] leading-[26px] break-words [overflow-wrap:anywhere] text-ink",
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
			{streaming ? (
				<PlainMarkdownFallback text={displayText} />
			) : (
				<Suspense fallback={<PlainMarkdownFallback text={displayText} />}>
					<SettledMarkdown text={displayText} />
				</Suspense>
			)}
		</div>
	);
});
