import { lazy, Suspense } from "react";
import { cn } from "../../lib/utils";
import { type CodeLanguage, shouldSyntaxHighlight } from "./code-display";

const HighlightedCodeContent = lazy(() => import("./HighlightedCodeContent"));

export interface HighlightedCodeProps {
	code: string;
	language?: CodeLanguage;
	className?: string;
	codeClassName?: string;
}

function PlainCode({ code, codeClassName }: Pick<HighlightedCodeProps, "code" | "codeClassName">) {
	return <code className={codeClassName}>{code}</code>;
}

/**
 * Code surface with a plain-text first paint. Highlight.js core and its two
 * registered grammars live behind the lazy child, outside the initial bundle.
 */
export function HighlightedCode({ code, language, className, codeClassName }: HighlightedCodeProps) {
	const highlight = language !== undefined && shouldSyntaxHighlight(code);
	return (
		<pre
			data-code-language={language ?? "plain"}
			data-syntax-highlight={language ? (highlight ? "eligible" : "skipped-size") : "plain"}
			className={cn(
				"scroll-slim overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-[18px] whitespace-pre text-ink-2",
				className,
			)}
		>
			{language && highlight ? (
				<Suspense fallback={<PlainCode code={code} codeClassName={codeClassName} />}>
					<HighlightedCodeContent code={code} language={language} className={codeClassName} />
				</Suspense>
			) : (
				<PlainCode code={code} codeClassName={codeClassName} />
			)}
		</pre>
	);
}
