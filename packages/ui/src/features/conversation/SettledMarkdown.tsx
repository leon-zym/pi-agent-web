import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { interpolate, useT } from "../../lib/i18n";
import { shouldSyntaxHighlight } from "./code-display";
import { DiffBlock } from "./DiffBlock";
import "./syntax-highlight.css";

interface HastNode {
	type: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
	value?: string;
}

function extractHastText(node: HastNode): string {
	if (node.type === "text" || typeof node.value === "string") {
		return node.value ?? "";
	}
	if (Array.isArray(node.children)) {
		return node.children.map(extractHastText).join("");
	}
	return "";
}

function rehypeSyntaxCircuitBreaker() {
	return (tree: HastNode) => {
		const walk = (node: HastNode, parent?: HastNode) => {
			if (node.tagName === "code" && parent?.tagName === "pre") {
				const text = extractHastText(node);
				if (!shouldSyntaxHighlight(text)) {
					node.properties = {
						...(node.properties ?? {}),
						className: ["no-highlight"],
					};
				}
			}
			if (Array.isArray(node.children)) {
				for (const child of node.children) {
					walk(child, node);
				}
			}
		};
		walk(tree);
	};
}

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSyntaxCircuitBreaker, rehypeHighlight];

function extractNodeText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") {
		return String(node);
	}
	if (Array.isArray(node)) {
		return node.map(extractNodeText).join("");
	}
	if (node && typeof node === "object" && "props" in node) {
		const props = (node as { props?: { children?: ReactNode } }).props;
		return extractNodeText(props?.children);
	}
	return "";
}

/** Markdown renderer with progressive streaming support and syntax highlight circuit breaker. */
export default function SettledMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
	const { t } = useT();
	void streaming;

	return (
		<ReactMarkdown
			remarkPlugins={remarkPlugins}
			rehypePlugins={rehypePlugins}
			components={{
				a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
				img: ({ node: _node, src, alt }) => {
					const label = alt?.trim() || t["conversation.markdownImage"];
					const openable = typeof src === "string" && /^(?:https?:\/\/|\/|\.\.?\/)/i.test(src);
					if (!openable) {
						return (
							<span data-markdown-image-blocked="true" role="note">
								{interpolate(t["conversation.markdownImageBlocked"], { label })}
							</span>
						);
					}
					return (
						<a data-markdown-image-link="true" href={src} target="_blank" rel="noreferrer noopener">
							{interpolate(t["conversation.markdownImageLink"], { label })}
						</a>
					);
				},
				pre: ({ node: _node, children, ...props }) => {
					const firstChild = Array.isArray(children) ? children[0] : children;
					if (
						firstChild &&
						typeof firstChild === "object" &&
						"props" in firstChild &&
						typeof (firstChild as { props?: { className?: string } }).props?.className === "string" &&
						/language-(?:diff|patch)/.test((firstChild as { props: { className: string } }).props.className)
					) {
						const diffCode = extractNodeText(
							(firstChild as { props: { children?: ReactNode } }).props?.children,
						);
						if (shouldSyntaxHighlight(diffCode)) {
							return <>{children}</>;
						}
					}
					return <pre {...props}>{children}</pre>;
				},
				code: ({ node: _node, className, children, ...props }) => {
					if (typeof className === "string" && /language-(?:diff|patch)/.test(className)) {
						const rawDiff = extractNodeText(children).replace(/\n$/, "");
						if (shouldSyntaxHighlight(rawDiff)) {
							return <DiffBlock diff={rawDiff} />;
						}
					}
					return (
						<code className={className} {...props}>
							{children}
						</code>
					);
				},
			}}
		>
			{text}
		</ReactMarkdown>
	);
}
