import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { BoundedUtf8CodecError, prepareBoundedUtf8Encoding } from "../src/bounded-utf8-codec.js";

async function readChunks(stream: Readable): Promise<Buffer[]> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
	return chunks;
}

function digest(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function seededJson(seed: number, depth = 0): unknown {
	const next = (seed * 1_664_525 + 1_013_904_223) >>> 0;
	if (depth >= 4) {
		switch (next % 5) {
			case 0:
				return null;
			case 1:
				return next % 2 === 0;
			case 2:
				return (next % 10_000) / 7;
			case 3:
				return `text-${String(next)}-"-\\-\n-😀`;
			default:
				return -0;
		}
	}
	if (next % 3 === 0) {
		return Array.from({ length: next % 5 }, (_, index) => seededJson(next + index + 1, depth + 1));
	}
	if (next % 3 === 1) {
		return {
			[`key-${String(next % 11)}`]: seededJson(next + 1, depth + 1),
			[String(next % 7)]: seededJson(next + 2, depth + 1),
		};
	}
	return seededJson(next, 4);
}

describe("bounded UTF-8 codec", () => {
	it("measures, hashes, replays, and chunks text without splitting surrogate pairs", async () => {
		const value = `${"a".repeat(65_530)}😀界${"z".repeat(70_000)}\ud800`;
		const expected = Buffer.from(value, "utf8");
		const prepared = await prepareBoundedUtf8Encoding({ kind: "text", value });

		expect(prepared).toMatchObject({
			kind: "text",
			byteLength: expected.byteLength,
			sha256: digest(expected),
		});
		for (let replay = 0; replay < 2; replay += 1) {
			const chunks = await readChunks(prepared.createReadable());
			expect(chunks.length).toBeGreaterThan(2);
			expect(chunks.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true);
			expect(Buffer.concat(chunks)).toEqual(expected);
			// Valid pairs remain within one chunk, so independently decoding chunks is lossless before the lone tail.
			expect(chunks.map((chunk) => chunk.toString("utf8")).join("")).toBe(value.replace("\ud800", "�"));
		}
	});

	it("matches JSON.stringify bytes for ordering, escapes, surrogates, and finite numbers", async () => {
		const values: unknown[] = [
			null,
			true,
			false,
			0,
			-0,
			1.25,
			Number.MAX_SAFE_INTEGER,
			-Number.MAX_SAFE_INTEGER,
			['quote"', "slash/", "backslash\\", "\b\f\n\r\t", "\u0000\u001f", "😀", "\ud800", "\udc00"],
			{ z: 1, "2": "two", "1": "one", a: { nested: [true, null, "界"] } },
		];
		for (const value of values) {
			const serialized = JSON.stringify(value);
			expect(serialized).toBeTypeOf("string");
			const prepared = await prepareBoundedUtf8Encoding({ kind: "json", value });
			const chunks = await readChunks(prepared.createReadable());
			const bytes = Buffer.from(serialized as string);
			expect(Buffer.concat(chunks)).toEqual(bytes);
			expect(prepared.byteLength).toBe(bytes.byteLength);
			expect(prepared.sha256).toBe(digest(bytes));
		}
	});

	it("matches JSON.stringify across deterministic generated JSON data", async () => {
		for (let seed = 1; seed <= 100; seed += 1) {
			const value = seededJson(seed);
			const expected = Buffer.from(JSON.stringify(value));
			const prepared = await prepareBoundedUtf8Encoding({ kind: "json", value });
			expect(Buffer.concat(await readChunks(prepared.createReadable()))).toEqual(expected);
			expect(prepared.byteLength).toBe(expected.byteLength);
			expect(prepared.sha256).toBe(digest(expected));
		}
	});

	it("rejects non-JSON shapes, cycles, holes, accessors, and structural ceilings", async () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const hole = Array.from({ length: 2 }, () => 1);
		delete hole[1];
		let getterReads = 0;
		const accessor = Object.defineProperty({}, "value", {
			enumerable: true,
			get() {
				getterReads += 1;
				return 1;
			},
		});
		const invalid = [
			cyclic,
			hole,
			{ value: undefined },
			{ value: Symbol("x") },
			{ value: 1n },
			{ value: Number.NaN },
			{ value: Number.POSITIVE_INFINITY },
			{ value: Number.MAX_SAFE_INTEGER + 1 },
			{ value: -(Number.MAX_SAFE_INTEGER + 1) },
			new Date(0),
			accessor,
		];
		for (const value of invalid) {
			await expect(prepareBoundedUtf8Encoding({ kind: "json", value })).rejects.toBeInstanceOf(
				BoundedUtf8CodecError,
			);
		}
		expect(getterReads).toBe(0);

		let tooDeep: unknown = null;
		for (let depth = 0; depth < 34; depth += 1) tooDeep = { child: tooDeep };
		await expect(prepareBoundedUtf8Encoding({ kind: "json", value: tooDeep })).rejects.toMatchObject({
			code: "json_depth_exceeded",
		});

		const tooManyItems = Array.from({ length: 10_000 }, (_, index) => Array.from({ length: 5 }, () => index));
		await expect(prepareBoundedUtf8Encoding({ kind: "json", value: tooManyItems })).rejects.toMatchObject({
			code: "json_items_exceeded",
		});
	});

	it("stops at the byte ceiling before inspecting later properties and exposes trusted evidence", async () => {
		let laterDescriptorReads = 0;
		const target = { first: "x".repeat(1_000), later: 1 };
		const value = new Proxy(target, {
			getOwnPropertyDescriptor(inner, property) {
				if (property === "later") laterDescriptorReads += 1;
				return Reflect.getOwnPropertyDescriptor(inner, property);
			},
		});
		await expect(prepareBoundedUtf8Encoding({ kind: "json", value }, { maxBytes: 32 })).rejects.toMatchObject(
			{
				code: "byte_limit_exceeded",
				limit: 32,
				actual: expect.any(Number),
			},
		);
		expect(laterDescriptorReads).toBe(0);
		try {
			await prepareBoundedUtf8Encoding({ kind: "json", value }, { maxBytes: 32 });
		} catch (error) {
			expect(error).toBeInstanceOf(BoundedUtf8CodecError);
			expect((error as BoundedUtf8CodecError).actual).toBeGreaterThan(
				(error as BoundedUtf8CodecError).limit ?? 0,
			);
		}
	});

	it("accepts the exact byte ceiling and rejects its first byte above", async () => {
		const exactText = await prepareBoundedUtf8Encoding({ kind: "text", value: "界" }, { maxBytes: 3 });
		expect(exactText.byteLength).toBe(3);
		await expect(
			prepareBoundedUtf8Encoding({ kind: "text", value: "界x" }, { maxBytes: 3 }),
		).rejects.toMatchObject({ code: "byte_limit_exceeded", limit: 3, actual: 4 });

		const exactJson = await prepareBoundedUtf8Encoding({ kind: "json", value: {} }, { maxBytes: 2 });
		expect(exactJson.byteLength).toBe(2);
		await expect(
			prepareBoundedUtf8Encoding({ kind: "json", value: [] }, { maxBytes: 1 }),
		).rejects.toMatchObject({ code: "byte_limit_exceeded", limit: 1, actual: 2 });
	});

	it("honors abort before and during measurement and lazy replay", async () => {
		const before = new AbortController();
		before.abort();
		await expect(
			prepareBoundedUtf8Encoding({ kind: "text", value: "hello" }, { signal: before.signal }),
		).rejects.toMatchObject({ code: "aborted" });

		const during = new AbortController();
		const measuring = prepareBoundedUtf8Encoding(
			{ kind: "text", value: "😀".repeat(2 * 1024 * 1024) },
			{ signal: during.signal },
		);
		setImmediate(() => during.abort());
		await expect(measuring).rejects.toMatchObject({ code: "aborted" });

		const jsonAbort = new AbortController();
		const jsonValue = "x".repeat(8 * 1024 * 1024);
		let codeUnitReads = 0;
		const originalCharCodeAt = String.prototype.charCodeAt;
		const charCodeAt = vi.spyOn(String.prototype, "charCodeAt").mockImplementation(function (
			this: string,
			index: number,
		) {
			codeUnitReads += 1;
			return originalCharCodeAt.call(this, index);
		});
		try {
			const measuringJson = prepareBoundedUtf8Encoding(
				{ kind: "json", value: jsonValue },
				{ signal: jsonAbort.signal },
			);
			setImmediate(() => jsonAbort.abort());
			await expect(measuringJson).rejects.toMatchObject({ code: "aborted" });
			expect(codeUnitReads).toBeLessThan(jsonValue.length / 2);
		} finally {
			charCodeAt.mockRestore();
		}

		const prepared = await prepareBoundedUtf8Encoding({ kind: "text", value: "x".repeat(200_000) });
		const replay = new AbortController();
		const stream = prepared.createReadable({ signal: replay.signal });
		stream.resume();
		await once(stream, "data");
		replay.abort();
		await expect(once(stream, "end")).rejects.toMatchObject({ code: "aborted" });
	});

	it("revalidates the second pass so invalid mutation fails while digest drift remains store-verifiable", async () => {
		const value: { payload?: string } = { payload: "before" };
		const prepared = await prepareBoundedUtf8Encoding({ kind: "json", value }, { maxBytes: 64 });
		value.payload = "after";
		const mutated = Buffer.concat(await readChunks(prepared.createReadable()));
		expect(mutated).toEqual(Buffer.from('{"payload":"after"}'));
		expect(digest(mutated)).not.toBe(prepared.sha256);

		value.payload = "x".repeat(100);
		await expect(readChunks(prepared.createReadable())).rejects.toMatchObject({
			code: "byte_limit_exceeded",
			limit: 64,
			actual: expect.any(Number),
		});

		Object.defineProperty(value, "payload", {
			enumerable: true,
			get() {
				return "invalid";
			},
		});
		await expect(readChunks(prepared.createReadable())).rejects.toMatchObject({ code: "invalid_json" });
	});

	it("never calls whole-root JSON.stringify, TextEncoder.encode, or Buffer.from on the full string", async () => {
		const value = "😀".repeat(200_000);
		const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
			throw new Error("whole-root stringify is forbidden");
		});
		const encode = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(() => {
			throw new Error("whole-root TextEncoder.encode is forbidden");
		});
		const originalBufferFrom = Buffer.from.bind(Buffer);
		const stringLengths: number[] = [];
		const bufferFrom = vi.spyOn(Buffer, "from").mockImplementation(((input: unknown, ...rest: unknown[]) => {
			if (typeof input === "string") stringLengths.push(input.length);
			return originalBufferFrom(input as never, ...(rest as never[]));
		}) as typeof Buffer.from);

		try {
			const prepared = await prepareBoundedUtf8Encoding({ kind: "json", value: { payload: value } });
			await readChunks(prepared.createReadable());
			expect(stringLengths.length).toBeGreaterThan(1);
			expect(Math.max(...stringLengths)).toBeLessThan(value.length);
		} finally {
			bufferFrom.mockRestore();
			encode.mockRestore();
			stringify.mockRestore();
		}
	});
});
