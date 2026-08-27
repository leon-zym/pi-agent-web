import { describe, expect, it } from "vitest";
import {
	createRasterAdmissionValidator,
	type RasterMediaType,
	rasterFileExtension,
} from "../src/raster-admission.js";

const PNG = Buffer.from(
	"89504e470d0a1a0a0000000d4948445200000001000000010806000000000000000000000049454e4400000000",
	"hex",
);
const JPEG = Buffer.from("ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9", "hex");
const WEBP = Buffer.concat([
	Buffer.from("RIFF"),
	Buffer.from([22, 0, 0, 0]),
	Buffer.from("WEBPVP8 "),
	Buffer.from([10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]),
]);
const GIF = Buffer.from("474946383961010001000000002c00000000010001000002024401003b", "hex");

describe("fixed-memory raster admission", () => {
	it.each([
		["image/png", "png", PNG],
		["image/jpeg", "jpg", JPEG],
		["image/webp", "webp", WEBP],
		["image/gif", "gif", GIF],
	] as const)("validates chunked and already-decoded %s bytes", (mediaType, extension, bytes) => {
		expect(rasterFileExtension(mediaType)).toBe(extension);
		const streamed = createRasterAdmissionValidator(mediaType, bytes.byteLength);
		for (let offset = 0; offset < bytes.byteLength; offset += 3) {
			streamed.push(bytes.subarray(offset, offset + 3));
		}
		expect(() => streamed.finish()).not.toThrow();

		const decoded = createRasterAdmissionValidator(mediaType, bytes.byteLength);
		decoded.push(bytes);
		expect(() => decoded.finish()).not.toThrow();
	});

	it.each([
		["image/png", PNG, 12],
		["image/jpeg", JPEG, 2],
		["image/webp", WEBP, 1],
		["image/gif", GIF, 1],
	] as const)("rejects grossly truncated %s structure", (mediaType, bytes, trim) => {
		const truncated = bytes.subarray(0, -trim);
		const validator = createRasterAdmissionValidator(mediaType, truncated.byteLength);
		validator.push(truncated);
		expect(() => validator.finish()).toThrow(expect.objectContaining({ code: "invalid_raster_structure" }));
	});

	it("rejects unsupported media types and declared header truncation before consuming bytes", () => {
		expect(() => createRasterAdmissionValidator("image/svg+xml", 100)).toThrow(
			expect.objectContaining({ code: "unsupported_media_type" }),
		);
		for (const [mediaType, minimum] of [
			["image/png", 24],
			["image/jpeg", 6],
			["image/webp", 20],
			["image/gif", 13],
		] as const satisfies readonly (readonly [RasterMediaType, number])[]) {
			expect(() => createRasterAdmissionValidator(mediaType, minimum - 1)).toThrow(
				expect.objectContaining({ code: "truncated_raster_header" }),
			);
		}
	});
});
