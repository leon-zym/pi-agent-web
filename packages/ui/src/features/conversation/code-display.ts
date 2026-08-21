import { stripAnsi } from "../../lib/format";

export type CodeLanguage = "bash" | "json";

export interface FormattedCode {
	code: string;
	language: CodeLanguage | undefined;
}

/**
 * highlight.js runs synchronously during React render and its token tree can be
 * many times larger than the source. Keep the budget conservative and explicit:
 * both Unicode characters and encoded UTF-8 bytes must fit.
 */
export const MAX_SYNTAX_HIGHLIGHT_CHARACTERS = 32 * 1024;
export const MAX_SYNTAX_HIGHLIGHT_UTF8_BYTES = 64 * 1024;

export function shouldSyntaxHighlight(code: string): boolean {
	let characters = 0;
	let utf8Bytes = 0;

	for (let index = 0; index < code.length; index += 1) {
		const point = code.codePointAt(index) ?? 0;
		if (point > 0xffff) index += 1;
		characters += 1;
		utf8Bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
		if (characters > MAX_SYNTAX_HIGHLIGHT_CHARACTERS || utf8Bytes > MAX_SYNTAX_HIGHLIGHT_UTF8_BYTES) {
			return false;
		}
	}

	return true;
}

function tryFormatJson(value: unknown): string | undefined {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return undefined;
	}
}

export function formatJsonCode(value: unknown): string {
	return tryFormatJson(value) ?? String(value);
}

/**
 * Settled Pi arguments are authoritative. Raw text only wins while the
 * tool-call JSON is still streaming and has not produced a structured value.
 */
export function formatToolArguments(args: unknown, argsText: string): FormattedCode {
	if (args !== undefined) {
		const code = tryFormatJson(args);
		return code === undefined
			? { code: stripAnsi(String(args)), language: undefined }
			: { code, language: "json" };
	}

	const raw = stripAnsi(argsText);
	if (!shouldSyntaxHighlight(raw)) return { code: raw, language: "json" };
	if (!raw.trim()) return { code: "{}", language: "json" };
	try {
		return { code: formatJsonCode(JSON.parse(raw)), language: "json" };
	} catch {
		return { code: raw, language: undefined };
	}
}

export function formatUnknownCode(value: unknown): FormattedCode {
	if (typeof value === "object" && value !== null) {
		return { code: formatJsonCode(value), language: "json" };
	}
	return { code: stripAnsi(value === undefined || value === null ? "" : String(value)), language: undefined };
}
