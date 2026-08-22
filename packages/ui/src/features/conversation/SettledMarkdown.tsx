import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { interpolate, useT } from "../../lib/i18n";
import { DiffBlock } from "./DiffBlock";
import "./syntax-highlight.css";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

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

/** Heavy Markdown dependencies are isolated behind MarkdownBlock's lazy boundary. */
export default function SettledMarkdown({ text }: { text: string }) {
	const { t } = useT();

	return (
		<ReactMarkdown
			remarkPlugins={remarkPlugins}
			rehypePlugins={rehypePlugins}
			components={{
				a: (props) => <a {...props} target="_blank" rel="noreferrer noopener" />,
				img: ({ src, alt }) => {
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
				pre: ({ children, ...props }) => {
					const firstChild = Array.isArray(children) ? children[0] : children;
					if (
						firstChild &&
						typeof firstChild === "object" &&
						"props" in firstChild &&
						typeof (firstChild as { props?: { className?: string } }).props?.className === "string" &&
						/language-(?:diff|patch)/.test((firstChild as { props: { className: string } }).props.className)
					) {
						return <>{children}</>;
					}
					return <pre {...props}>{children}</pre>;
				},
				code: ({ className, children, ...props }) => {
					if (typeof className === "string" && /language-(?:diff|patch)/.test(className)) {
						const rawDiff = extractNodeText(children).replace(/\n$/, "");
						return <DiffBlock diff={rawDiff} />;
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
