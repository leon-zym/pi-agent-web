export interface PresentedUserMessage {
	text: string;
	command?: string;
}

const SKILL_HEADER = /^<skill name="([^"\r\n]+)" location="[^"\r\n]+">\r?\n/;
const SKILL_CLOSE = "</skill>";
const SLASH_COMMAND = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

/** Collapse Pi's expanded skill payload, or a raw slash invocation, into presentation-safe parts. */
export function presentUserMessage(rawText: string): PresentedUserMessage {
	const skillHeader = rawText.match(SKILL_HEADER);
	if (skillHeader) {
		return {
			command: `/skill:${skillHeader[1]}`,
			text: unambiguousSkillArguments(rawText.slice(skillHeader[0].length)),
		};
	}

	const slash = rawText.match(SLASH_COMMAND);
	if (slash) {
		return {
			command: `/${slash[1]}`,
			text: slash[2]?.trim() ?? "",
		};
	}

	return { text: rawText };
}

function unambiguousSkillArguments(bodyAndTail: string): string {
	// Pi does not escape closing-token examples inside Skill Markdown. Never
	// guess which token owns the tail: an ambiguous envelope exposes no body or args.
	const closingIndex = bodyAndTail.indexOf(SKILL_CLOSE);
	if (closingIndex === -1) return "";
	if (closingIndex === 0 || bodyAndTail[closingIndex - 1] !== "\n") return "";
	if (bodyAndTail.indexOf(SKILL_CLOSE, closingIndex + SKILL_CLOSE.length) !== -1) return "";

	const tail = bodyAndTail.slice(closingIndex + SKILL_CLOSE.length);
	if (tail === "") return "";
	const separator = tail.match(/^(?:\r?\n){2}/)?.[0];
	return separator ? tail.slice(separator.length).trim() : "";
}

export function serializePresentedUserMessage(message: PresentedUserMessage): string {
	return message.command ? `${message.command}${message.text ? ` ${message.text}` : ""}` : message.text;
}
