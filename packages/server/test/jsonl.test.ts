import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { attachJsonlLineReader, collectLines, JsonlLineTooLongError } from "../src/jsonl";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

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
		const drained = deferred();
		const stream = Readable.from(['{"a":1}\n{"b":', "2}\n"]);
		const detach = attachJsonlLineReader(stream, (line) => {
			collected.push(line);
			if (collected.length === 2) drained.resolve();
		});
		await new Promise<void>((resolve) => {
			stream.on("end", resolve);
			stream.resume();
		});
		await drained.promise;
		detach();
		expect(collected).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("awaits one async consumer at a time and pauses the readable between same-chunk lines", async () => {
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const completed = deferred();
		const observed: string[] = [];
		const stream = new PassThrough({ highWaterMark: 8 });
		attachJsonlLineReader(
			stream,
			async (line) => {
				observed.push(`start:${line}`);
				if (line === "first") {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
				observed.push(`end:${line}`);
			},
			{ onError: completed.reject },
		);
		stream.once("end", completed.resolve);

		stream.end("first\nsecond\nthird\n");
		await firstStarted.promise;

		expect(stream.isPaused()).toBe(true);
		expect(observed).toEqual(["start:first"]);

		releaseFirst.resolve();
		await completed.promise;
		expect(observed).toEqual([
			"start:first",
			"end:first",
			"start:second",
			"end:second",
			"start:third",
			"end:third",
		]);
	});

	it("releases readable backpressure on detach without delivering queued lines", async () => {
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const ended = deferred();
		const observed: string[] = [];
		const stream = new PassThrough();
		const detach = attachJsonlLineReader(stream, async (line) => {
			observed.push(line);
			if (line === "first") {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
		});
		stream.once("end", ended.resolve);
		stream.end("first\nsecond\n");
		await firstStarted.promise;
		expect(stream.isPaused()).toBe(true);

		detach();
		expect(stream.isPaused()).toBe(false);
		releaseFirst.resolve();
		await ended.promise;
		expect(observed).toEqual(["first"]);
	});

	it("reports an unterminated line that exceeds its byte budget", async () => {
		const errors: Error[] = [];
		const failed = deferred();
		const stream = Readable.from(["x".repeat(17)]);
		attachJsonlLineReader(stream, () => {}, {
			maxLineBytes: 16,
			onError: (error) => {
				errors.push(error);
				failed.resolve();
			},
		});
		await failed.promise;
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(JsonlLineTooLongError);
	});

	it("reads the active byte budget for each in-flight line", async () => {
		const errors: Error[] = [];
		let maxLineBytes = 32;
		const stream = Readable.from(["x".repeat(24), "x".repeat(9)]);
		attachJsonlLineReader(stream, () => {}, {
			maxLineBytes: () => maxLineBytes,
			onError: (error) => errors.push(error),
		});
		stream.once("data", () => {
			maxLineBytes = 64;
		});
		await new Promise<void>((resolve) => stream.on("end", resolve));

		expect(errors).toEqual([]);
	});

	it("routes consumer exceptions through onError and stops reading", async () => {
		const lines: string[] = [];
		const errors: Error[] = [];
		const failed = deferred();
		const stream = Readable.from(["first\nsecond\n"]);
		attachJsonlLineReader(
			stream,
			(line) => {
				lines.push(line);
				throw new Error("consumer rejected frame");
			},
			{
				onError: (error) => {
					errors.push(error);
					failed.resolve();
				},
			},
		);
		await failed.promise;

		expect(lines).toEqual(["first"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("consumer rejected frame");
	});

	it("routes an async consumer rejection once and drops the rest of the same chunk", async () => {
		const lines: string[] = [];
		const failed = deferred();
		const errors: Error[] = [];
		const stream = Readable.from(["first\nsecond\nthird\n"]);
		attachJsonlLineReader(
			stream,
			async (line) => {
				lines.push(line);
				throw new Error("async consumer rejected frame");
			},
			{
				onError: (error) => {
					errors.push(error);
					failed.resolve();
				},
			},
		);

		await failed.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(lines).toEqual(["first"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("async consumer rejected frame");
	});

	it("routes a readable error before any data exactly once", () => {
		const errors: Error[] = [];
		const stream = new PassThrough();
		attachJsonlLineReader(stream, () => {}, { onError: (error) => errors.push(error) });

		expect(() => stream.emit("error", new Error("stdout failed before data"))).not.toThrow();
		expect(() => stream.emit("error", new Error("duplicate stdout failure"))).not.toThrow();
		expect(errors.map((error) => error.message)).toEqual(["stdout failed before data"]);
		stream.destroy();
	});

	it("routes a readable error during async consumption and ignores the late consumer rejection", async () => {
		const started = deferred();
		const release = deferred();
		const errors: Error[] = [];
		const stream = new PassThrough();
		attachJsonlLineReader(
			stream,
			async () => {
				started.resolve();
				await release.promise;
				throw new Error("late consumer rejection");
			},
			{ onError: (error) => errors.push(error) },
		);
		stream.write("first\nsecond\n");
		await started.promise;

		expect(() => stream.emit("error", new Error("stdout failed during decode"))).not.toThrow();
		expect(() => stream.emit("error", new Error("duplicate stdout failure"))).not.toThrow();
		release.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(errors.map((error) => error.message)).toEqual(["stdout failed during decode"]);
		stream.destroy();
	});

	it("observes a readable error racing after detach without reporting or throwing", () => {
		const errors: Error[] = [];
		const stream = new PassThrough();
		const detach = attachJsonlLineReader(stream, () => {}, { onError: (error) => errors.push(error) });
		detach();

		expect(() => stream.emit("error", new Error("stdout failed after detach"))).not.toThrow();
		expect(errors).toEqual([]);
		stream.destroy();
	});
});
