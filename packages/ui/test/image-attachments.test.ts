import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ImageAttachmentPlatform, prepareImageAttachments } from "../src/lib/image-attachments";

function selectedFile(bytes: Uint8Array, type: string, name = "selected-image"): File {
	return new File([Uint8Array.from(bytes).buffer], name, { type });
}

async function dataUrl(blob: Blob): Promise<string> {
	const bytes = Buffer.from(await blob.arrayBuffer());
	return `data:${blob.type};base64,${bytes.toString("base64")}`;
}

function bitmapPlatform(overrides: Partial<ImageAttachmentPlatform> = {}) {
	const close = vi.fn();
	const decodeBitmap = vi.fn(async () => ({
		source: {} as CanvasImageSource,
		width: 640,
		height: 480,
		close,
	}));
	const encodeImage = vi.fn(async () => new Blob([Uint8Array.from([9, 8, 7])], { type: "image/webp" }));
	const createEncoder = vi.fn(() => ({ encode: encodeImage }));
	const readAsDataURL = vi.fn(dataUrl);
	const platform: ImageAttachmentPlatform = {
		decodeBitmap,
		createObjectURL: vi.fn(() => "blob:decode-temporary"),
		revokeObjectURL: vi.fn(),
		loadImage: vi.fn(async () => ({
			source: {} as CanvasImageSource,
			width: 640,
			height: 480,
			decode: vi.fn(async () => undefined),
		})),
		createEncoder,
		readAsDataURL,
		...overrides,
	};
	return { close, createEncoder, decodeBitmap, encodeImage, platform, readAsDataURL };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("image attachment preparation", () => {
	it.each([
		["JPEG", "image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])],
		["PNG", "image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
		["animated WebP", "image/webp", Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])],
		["animated GIF", "image/gif", Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5, 6])],
	])(
		"native-decodes a small allowlisted %s before preserving its exact bytes",
		async (_label, type, bytes) => {
			const { close, decodeBitmap, encodeImage, platform, readAsDataURL } = bitmapPlatform();
			const file = selectedFile(bytes, type);

			const prepared = await prepareImageAttachments([file], [], platform);

			expect(decodeBitmap).toHaveBeenCalledOnce();
			expect(decodeBitmap).toHaveBeenCalledWith(file);
			expect(encodeImage).not.toHaveBeenCalled();
			expect(close).toHaveBeenCalledOnce();
			expect(close.mock.invocationCallOrder[0]).toBeLessThan(readAsDataURL.mock.invocationCallOrder[0]!);
			expect(prepared).toEqual([
				{
					type: "image",
					mimeType: type,
					data: Buffer.from(bytes).toString("base64"),
				},
			]);
			expect(Buffer.from(prepared[0]!.data, "base64")).toEqual(Buffer.from(bytes));
		},
	);

	it("rejects a small allowlisted file when native decode fails without producing an attachment", async () => {
		const { platform, readAsDataURL } = bitmapPlatform({
			decodeBitmap: vi.fn(async () => {
				throw new Error("malformed raster");
			}),
		});

		await expect(
			prepareImageAttachments([selectedFile(Uint8Array.from([1, 2, 3]), "image/png")], [], platform),
		).rejects.toMatchObject({ code: "decode_failed" });
		expect(readAsDataURL).not.toHaveBeenCalled();
		expect(platform.createEncoder).not.toHaveBeenCalled();
	});

	it("revokes the fallback decoder's temporary object URL exactly once after passthrough", async () => {
		const revokeObjectURL = vi.fn();
		const decode = vi.fn(async () => undefined);
		const loadImage = vi.fn(async () => ({
			source: {} as CanvasImageSource,
			width: 32,
			height: 24,
			decode,
		}));
		const { encodeImage, platform, readAsDataURL } = bitmapPlatform({
			decodeBitmap: undefined,
			createObjectURL: vi.fn(() => "blob:fallback-decode"),
			revokeObjectURL,
			loadImage,
		});
		const file = selectedFile(Uint8Array.from([0x47, 0x49, 0x46]), "image/gif");

		const prepared = await prepareImageAttachments([file], [], platform);

		expect(loadImage).toHaveBeenCalledWith("blob:fallback-decode");
		expect(decode).toHaveBeenCalledOnce();
		expect(revokeObjectURL).toHaveBeenCalledOnce();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:fallback-decode");
		expect(revokeObjectURL.mock.invocationCallOrder[0]).toBeLessThan(
			readAsDataURL.mock.invocationCallOrder[0]!,
		);
		expect(encodeImage).not.toHaveBeenCalled();
		expect(Buffer.from(prepared[0]!.data, "base64")).toEqual(Buffer.from([0x47, 0x49, 0x46]));
	});

	it("revokes the fallback decoder's temporary object URL exactly once when decode fails", async () => {
		const revokeObjectURL = vi.fn();
		const { platform, readAsDataURL } = bitmapPlatform({
			decodeBitmap: undefined,
			createObjectURL: vi.fn(() => "blob:fallback-error"),
			revokeObjectURL,
			loadImage: vi.fn(async () => {
				throw new Error("image element rejected the file");
			}),
		});

		await expect(
			prepareImageAttachments([selectedFile(Uint8Array.from([1]), "image/png")], [], platform),
		).rejects.toMatchObject({ code: "decode_failed" });
		expect(revokeObjectURL).toHaveBeenCalledOnce();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:fallback-error");
		expect(readAsDataURL).not.toHaveBeenCalled();
	});

	it("awaits fallback image.decode before admitting passthrough bytes", async () => {
		let releaseDecode!: () => void;
		const decodeGate = new Promise<void>((resolve) => {
			releaseDecode = resolve;
		});
		const decode = vi.fn(() => decodeGate);
		const revokeObjectURL = vi.fn();
		const { platform, readAsDataURL } = bitmapPlatform({
			decodeBitmap: undefined,
			createObjectURL: vi.fn(() => "blob:fallback-decode-gate"),
			revokeObjectURL,
			loadImage: vi.fn(async () => ({
				source: {} as CanvasImageSource,
				width: 32,
				height: 24,
				decode,
			})),
		});

		const preparation = prepareImageAttachments(
			[selectedFile(Uint8Array.from([1, 2, 3]), "image/png")],
			[],
			platform,
		);
		await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
		expect(readAsDataURL).not.toHaveBeenCalled();
		expect(revokeObjectURL).not.toHaveBeenCalled();

		releaseDecode();
		await expect(preparation).resolves.toHaveLength(1);
		expect(revokeObjectURL).toHaveBeenCalledOnce();
	});

	it("rejects and revokes the fallback URL when image.decode rejects after load", async () => {
		const revokeObjectURL = vi.fn();
		const { platform, readAsDataURL } = bitmapPlatform({
			decodeBitmap: undefined,
			createObjectURL: vi.fn(() => "blob:fallback-pixel-error"),
			revokeObjectURL,
			loadImage: vi.fn(async () => ({
				source: {} as CanvasImageSource,
				width: 32,
				height: 24,
				decode: vi.fn(async () => {
					throw new Error("pixel decode failed");
				}),
			})),
		});

		await expect(
			prepareImageAttachments([selectedFile(Uint8Array.from([1, 2, 3]), "image/png")], [], platform),
		).rejects.toMatchObject({ code: "decode_failed" });
		expect(readAsDataURL).not.toHaveBeenCalled();
		expect(revokeObjectURL).toHaveBeenCalledOnce();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:fallback-pixel-error");
	});

	it("fails closed when neither createImageBitmap nor image.decode is available", async () => {
		const revokeObjectURL = vi.fn();
		const { platform, readAsDataURL } = bitmapPlatform({
			decodeBitmap: undefined,
			createObjectURL: vi.fn(() => "blob:fallback-no-decode-api"),
			revokeObjectURL,
			loadImage: vi.fn(async () => ({
				source: {} as CanvasImageSource,
				width: 32,
				height: 24,
			})),
		});

		await expect(
			prepareImageAttachments([selectedFile(Uint8Array.from([1, 2, 3]), "image/png")], [], platform),
		).rejects.toMatchObject({ code: "decode_failed" });
		expect(readAsDataURL).not.toHaveBeenCalled();
		expect(revokeObjectURL).toHaveBeenCalledOnce();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:fallback-no-decode-api");
	});

	it("revokes the fallback decoder's temporary object URL when post-decode serialization fails", async () => {
		const revokeObjectURL = vi.fn();
		const { platform } = bitmapPlatform({
			decodeBitmap: undefined,
			createObjectURL: vi.fn(() => "blob:fallback-read-error"),
			revokeObjectURL,
			readAsDataURL: vi.fn(async () => {
				throw new Error("file reader failed");
			}),
		});

		await expect(
			prepareImageAttachments([selectedFile(Uint8Array.from([1, 2, 3]), "image/png")], [], platform),
		).rejects.toThrow("file reader failed");
		expect(revokeObjectURL).toHaveBeenCalledOnce();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:fallback-read-error");
	});

	it("closes a decoded bitmap exactly once when passthrough serialization fails", async () => {
		const { close, platform } = bitmapPlatform({
			readAsDataURL: vi.fn(async () => {
				throw new Error("file reader failed");
			}),
		});

		await expect(
			prepareImageAttachments([selectedFile(Uint8Array.from([1, 2, 3]), "image/png")], [], platform),
		).rejects.toThrow("file reader failed");
		expect(close).toHaveBeenCalledOnce();
	});

	it.each([
		["a large allowlisted raster", "image/png", new Uint8Array(1_200_000)],
		["a small unsupported raster", "image/avif", Uint8Array.from([1, 2, 3, 4])],
	])("keeps %s on the existing bounded canvas-to-WebP path", async (_label, type, bytes) => {
		const { close, decodeBitmap, encodeImage, platform, readAsDataURL } = bitmapPlatform();
		const file = selectedFile(bytes, type);

		const prepared = await prepareImageAttachments([file], [], platform);

		expect(decodeBitmap).toHaveBeenCalledOnce();
		expect(encodeImage).toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
		expect(readAsDataURL).toHaveBeenCalledOnce();
		expect(prepared).toEqual([
			{
				type: "image",
				mimeType: "image/webp",
				data: Buffer.from([9, 8, 7]).toString("base64"),
			},
		]);
	});
});
