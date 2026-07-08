import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Strict LF-only JSONL line reader.
 *
 * Semantically identical to pi's src/modes/rpc/jsonl.ts (see docs/protocol.md,
 * Appendix B):
 * - Split on LF only; U+2028/U+2029 are legal inside JSON strings, so Node's
 *   readline must never be used.
 * - Tolerate a trailing \r (accept CRLF input).
 * - Callers handle JSON.parse themselves (dirty lines are silently dropped).
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		for (;;) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

/** Pure framing function (for unit tests): turn arbitrary chunk sequences into lines. */
export function collectLines(chunks: string[]): string[] {
	const lines: string[] = [];
	let buffer = "";
	const decoder = new StringDecoder("utf8");
	for (const chunk of chunks) {
		buffer += decoder.write(Buffer.from(chunk, "utf8"));
		for (;;) {
			const i = buffer.indexOf("\n");
			if (i === -1) break;
			let line = buffer.slice(0, i);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			lines.push(line);
			buffer = buffer.slice(i + 1);
		}
	}
	buffer += decoder.end();
	if (buffer.length > 0) {
		let line = buffer;
		if (line.endsWith("\r")) line = line.slice(0, -1);
		lines.push(line);
	}
	return lines;
}
