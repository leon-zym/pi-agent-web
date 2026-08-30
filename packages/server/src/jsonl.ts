import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;
/** Pi emits get_messages as one JSONL response, so snapshots receive a larger but still finite budget. */
export const MAX_JSONL_SNAPSHOT_LINE_BYTES = 64 * 1024 * 1024;
/** Canonical content-reference mode admits selected externalizable raw frames up to this hard ceiling. */
export const MAX_JSONL_CONTENT_REF_LINE_BYTES = 64 * 1024 * 1024;

export class JsonlLineTooLongError extends Error {
	constructor(maxBytes: number) {
		super(`JSONL line exceeds the ${String(maxBytes)} byte limit`);
		this.name = "JsonlLineTooLongError";
	}
}

export interface JsonlReaderOptions {
	maxLineBytes?: number | (() => number);
	onError?: (error: Error) => void;
}

/** Return values are ignored, except thenables are awaited before the next line is read. */
export type JsonlLineConsumer = (line: string) => unknown;

/**
 * Strict LF-only JSONL line reader.
 *
 * Semantically identical to Pi's RPC JSONL reader:
 * - Split on LF only; U+2028/U+2029 are legal inside JSON strings, so Node's
 *   readline must never be used.
 * - Tolerate a trailing \r (accept CRLF input).
 * - Callers handle JSON.parse themselves (dirty lines are silently dropped).
 */
export function attachJsonlLineReader(
	stream: Readable,
	onLine: JsonlLineConsumer,
	options: JsonlReaderOptions = {},
): () => void {
	const decoder = new StringDecoder("utf8");
	const currentMaxLineBytes = () => {
		const configured = options.maxLineBytes ?? MAX_JSONL_LINE_BYTES;
		return typeof configured === "function" ? configured() : configured;
	};
	let buffer = "";
	let failed = false;
	let detached = false;
	let ended = false;
	let tail = Promise.resolve();

	const fail = (error: unknown) => {
		if (failed || detached) return;
		failed = true;
		buffer = "";
		stream.pause();
		stream.off("data", onData);
		stream.off("end", onEnd);
		options.onError?.(error instanceof Error ? error : new Error(String(error)));
	};

	function onStreamError(error: Error): void {
		fail(error);
	}

	function onClose(): void {
		stream.off("error", onStreamError);
	}

	const emitLine = async (line: string): Promise<void> => {
		const maxLineBytes = currentMaxLineBytes();
		if (Buffer.byteLength(line) > maxLineBytes) {
			throw new JsonlLineTooLongError(maxLineBytes);
		}
		await onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const consume = async (chunk: string | Buffer): Promise<void> => {
		if (failed || detached) return;
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		for (;;) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				const maxLineBytes = currentMaxLineBytes();
				if (Buffer.byteLength(buffer) > maxLineBytes) throw new JsonlLineTooLongError(maxLineBytes);
				return;
			}
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			await emitLine(line);
			if (failed || detached) return;
		}
	};

	function onData(chunk: string | Buffer): void {
		if (failed || detached) return;
		stream.pause();
		tail = tail.then(() => consume(chunk));
		const current = tail;
		void current.then(
			() => {
				if (current === tail && !ended && !failed && !detached) stream.resume();
			},
			(error) => fail(error),
		);
	}

	async function finish(): Promise<void> {
		if (failed || detached) return;
		buffer += decoder.end();
		if (buffer.length > 0) {
			const line = buffer;
			buffer = "";
			await emitLine(line);
		}
	}

	function onEnd(): void {
		if (failed || detached) return;
		ended = true;
		tail = tail.then(() => finish());
		void tail.catch(fail);
	}

	stream.on("data", onData);
	stream.on("end", onEnd);
	// Keep the error observer until close, including after detach. Node streams
	// may report a teardown error after listeners have otherwise been removed;
	// an unobserved `error` event would escape the process boundary.
	stream.on("error", onStreamError);
	stream.once("close", onClose);

	return () => {
		detached = true;
		buffer = "";
		stream.off("data", onData);
		stream.off("end", onEnd);
		stream.resume();
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
