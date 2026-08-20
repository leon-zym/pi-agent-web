import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { interpolate, useT } from "../../lib/i18n";
import "./syntax-highlight.css";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

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
			}}
		>
			{text}
		</ReactMarkdown>
	);
}
