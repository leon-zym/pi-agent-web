import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { attachJsonlLineReader, collectLines } from "../src/jsonl";

describe("strict JSONL framing", () => {
	it("splits basic LF lines", () => {
		expect(collectLines(['{"a":1}\n{"b":2}\n'])).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("does not split on U+2028/U+2029 inside JSON strings", () => {
		const payload = JSON.stringify({ text: "a\u2028b\u2029c" });
		const lines = collectLines([`${payload}\n`, "{}"]);
		expect(lines).toEqual([payload, "{}"]);
	});

	it("tolerates CRLF line endings", () => {
		expect(collectLines(["one\r\ntwo\r\nthree"])).toEqual(["one", "two", "three"]);
	});

	it("joins lines across chunk boundaries", () => {
		const chunks = ['{"lo', 'ng":', '1}\n{"a"', ":2}\n"];
		expect(collectLines(chunks)).toEqual(['{"long":1}', '{"a":2}']);
	});

	it("emits a final line without trailing newline", () => {
		expect(collectLines(['{"a":1}\n{"b":2}'])).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("emits empty segments verbatim; consumers drop non-JSON lines", () => {
		// The parser is a pure framer: it emits every LF-delimited segment,
		// including empty ones. JSON.parse("") fails, so dirty/empty lines are
		// dropped at the consumer layer (rpc-client.ts:305-311 behavior).
		const raw = collectLines(['\n\n{"a":1}\n\n']);
		expect(raw).toEqual(["", "", '{"a":1}', ""]);
		const parsed = raw.filter((line) => {
			try {
				JSON.parse(line);
				return true;
			} catch {
				return false;
			}
		});
		expect(parsed).toEqual(['{"a":1}']);
	});

	it("keeps multi-byte UTF-8 intact across chunks", () => {
		const text = "你好，世界 🌍";
		const payload = JSON.stringify({ text });
		const mid = Math.floor(payload.length / 2);
		expect(collectLines([payload.slice(0, mid), payload.slice(mid), "\n"])).toEqual([payload]);
	});

	it("stream reader matches the pure function and detaches cleanly", async () => {
		const collected: string[] = [];
		const stream = Readable.from(['{"a":1}\n{"b":', "2}\n"]);
		const detach = attachJsonlLineReader(stream, (line) => collected.push(line));
		await new Promise<void>((resolve) => {
			stream.on("end", () => {
				detach();
				resolve();
			});
			stream.resume();
		});
		expect(collected).toEqual(['{"a":1}', '{"b":2}']);
	});
});
