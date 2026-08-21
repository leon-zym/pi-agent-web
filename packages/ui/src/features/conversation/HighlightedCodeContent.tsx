import highlightJs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import { Fragment, type ReactNode, useMemo } from "react";
import { type CodeLanguage, shouldSyntaxHighlight } from "./code-display";
import "./syntax-highlight.css";

highlightJs.registerLanguage("bash", bash);
highlightJs.registerLanguage("json", json);

interface HighlightToken {
	scope?: string;
	children: Array<HighlightToken | string>;
}

function tokenClassName(scope: string): string {
	if (scope.startsWith("language:")) return scope.replace("language:", "language-");
	const [head, ...tail] = scope.split(".");
	return [`hljs-${head}`, ...tail.map((part, index) => `${part}${"_".repeat(index + 1)}`)].join(" ");
}

function renderTokens(children: HighlightToken["children"], path = "root"): ReactNode[] {
	return children.map((child, index) => {
		const key = `${path}:${String(index)}`;
		if (typeof child === "string") return <Fragment key={key}>{child}</Fragment>;
		return (
			<span key={key} className={child.scope ? tokenClassName(child.scope) : undefined}>
				{renderTokens(child.children, key)}
			</span>
		);
	});
}

export function highlightTokens(code: string, language: CodeLanguage): HighlightToken {
	if (!shouldSyntaxHighlight(code)) return { children: [code] };
	const result = highlightJs.highlight(code, { language, ignoreIllegals: true });
	return (result._emitter as unknown as { rootNode: HighlightToken }).rootNode;
}

export default function HighlightedCodeContent({
	code,
	language,
	className,
}: {
	code: string;
	language: CodeLanguage;
	className?: string;
}) {
	const highlighted = shouldSyntaxHighlight(code);
	const tokens = useMemo(() => highlightTokens(code, language), [code, language]);
	return (
		<code
			data-syntax-highlight={highlighted ? "applied" : "skipped-size"}
			className={highlighted ? `hljs language-${language}${className ? ` ${className}` : ""}` : className}
		>
			{renderTokens(tokens.children)}
		</code>
	);
}
