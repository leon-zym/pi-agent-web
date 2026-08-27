import { SESSION_IMAGE_MAX_BASE64_CHARS, SESSION_IMAGE_TOTAL_MAX_BASE64_CHARS } from "@pi-agent-web/protocol";
import type { ImageContent } from "../types/pi-types";

export const COMPOSER_IMAGE_MAX_COUNT = 4;
const TARGET_BASE64_CHARS = 1_500_000;
const MAX_DIMENSION = 2_048;
const PASSTHROUGH_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

interface DecodedBitmap {
	source: CanvasImageSource;
	width: number;
	height: number;
	close: () => void;
}

interface LoadedImage {
	source: CanvasImageSource;
	width: number;
	height: number;
	decode?: () => Promise<void>;
}

interface ImageAttachmentEncoder {
	encode: (type: string, quality: number) => Promise<Blob | null>;
}

/** Injectable browser primitives keep image admission deterministic in unit tests. */
export interface ImageAttachmentPlatform {
	decodeBitmap?: (file: File) => Promise<DecodedBitmap>;
	createObjectURL: (blob: Blob) => string;
	revokeObjectURL: (url: string) => void;
	loadImage: (url: string) => Promise<LoadedImage>;
	createEncoder: (source: CanvasImageSource, width: number, height: number) => ImageAttachmentEncoder | null;
	readAsDataURL: (blob: Blob) => Promise<string>;
}

export class ImageAttachmentError extends Error {
	constructor(
		readonly code: "decode_failed" | "too_large" | "too_many" | "total_too_large",
		message: string,
	) {
		super(message);
		this.name = "ImageAttachmentError";
	}
}

export function imagePayloadChars(images: ImageContent[]): number {
	return images.reduce((total, image) => total + image.data.length, 0);
}

/** Decode and resize browser-selected images before they enter the WebSocket frame. */
export async function prepareImageAttachments(
	files: File[],
	existing: ImageContent[],
	platform: ImageAttachmentPlatform = browserImageAttachmentPlatform(),
): Promise<ImageContent[]> {
	const candidates = files.filter((file) => file.type.startsWith("image/"));
	const available = COMPOSER_IMAGE_MAX_COUNT - existing.length;
	if (available <= 0) throw new ImageAttachmentError("too_many", "attachment_limit_reached");
	const selected = candidates.slice(0, available);
	if (selected.length === 0) return existing;

	const prepared: ImageContent[] = [];
	for (const file of selected) prepared.push(await prepareImage(file, platform));
	const combined = [...existing, ...prepared];
	if (imagePayloadChars(combined) > SESSION_IMAGE_TOTAL_MAX_BASE64_CHARS) {
		throw new ImageAttachmentError("total_too_large", "attachment_total_too_large");
	}
	return combined;
}

async function prepareImage(file: File, platform: ImageAttachmentPlatform): Promise<ImageContent> {
	if (file.size > 50 * 1024 * 1024) {
		throw new ImageAttachmentError("too_large", "attachment_too_large");
	}

	let source: DecodedImage;
	try {
		source = await decodeImage(file, platform);
	} catch {
		throw new ImageAttachmentError("decode_failed", "attachment_decode_failed");
	}
	try {
		if (PASSTHROUGH_MIME_TYPES.has(file.type) && base64CharacterLength(file.size) <= TARGET_BASE64_CHARS) {
			source.dispose();
			return await blobAsAttachment(file, platform, false);
		}
		const candidate = await resizeImage(source, platform);
		if (candidate && candidate.data.length <= SESSION_IMAGE_MAX_BASE64_CHARS) return candidate;
	} finally {
		source.dispose();
	}
	throw new ImageAttachmentError("too_large", "attachment_too_large");
}

function base64CharacterLength(byteLength: number): number {
	return 4 * Math.ceil(byteLength / 3);
}

interface DecodedImage {
	source: CanvasImageSource;
	width: number;
	height: number;
	dispose: () => void;
}

async function decodeImage(file: File, platform: ImageAttachmentPlatform): Promise<DecodedImage> {
	if (platform.decodeBitmap) {
		const bitmap = await platform.decodeBitmap(file);
		let disposed = false;
		return {
			source: bitmap.source,
			width: bitmap.width,
			height: bitmap.height,
			dispose: () => {
				if (disposed) return;
				disposed = true;
				bitmap.close();
			},
		};
	}
	const url = platform.createObjectURL(file);
	try {
		const image = await platform.loadImage(url);
		if (!image.decode) throw new Error("image_decode_unsupported");
		await image.decode();
		let disposed = false;
		return {
			source: image.source,
			width: image.width,
			height: image.height,
			dispose: () => {
				if (disposed) return;
				disposed = true;
				platform.revokeObjectURL(url);
			},
		};
	} catch (error) {
		platform.revokeObjectURL(url);
		throw error;
	}
}

async function resizeImage(
	decoded: DecodedImage,
	platform: ImageAttachmentPlatform,
): Promise<ImageContent | null> {
	const longest = Math.max(decoded.width, decoded.height);
	const baseScale = Math.min(1, MAX_DIMENSION / Math.max(1, longest));
	let smallest: ImageContent | null = null;
	for (const scale of [baseScale, baseScale * 0.8, baseScale * 0.64]) {
		const width = Math.max(1, Math.round(decoded.width * scale));
		const height = Math.max(1, Math.round(decoded.height * scale));
		const encoder = platform.createEncoder(decoded.source, width, height);
		if (!encoder) continue;
		for (const quality of [0.86, 0.72, 0.58]) {
			const blob = await encoder.encode("image/webp", quality);
			if (!blob) continue;
			const attachment = await blobAsAttachment(blob, platform);
			if (!smallest || attachment.data.length < smallest.data.length) smallest = attachment;
			if (attachment.data.length <= TARGET_BASE64_CHARS) return attachment;
		}
	}
	return smallest;
}

async function blobAsAttachment(
	blob: Blob,
	platform: ImageAttachmentPlatform,
	enforceLimit = true,
): Promise<ImageContent> {
	const dataUrl = await platform.readAsDataURL(blob);
	const comma = dataUrl.indexOf(",");
	const data = comma === -1 ? "" : dataUrl.slice(comma + 1);
	if (!data || (enforceLimit && data.length > SESSION_IMAGE_MAX_BASE64_CHARS)) {
		throw new ImageAttachmentError("too_large", "attachment_too_large");
	}
	return {
		type: "image",
		data,
		mimeType: blob.type || "image/png",
	};
}

function browserImageAttachmentPlatform(): ImageAttachmentPlatform {
	return {
		decodeBitmap:
			typeof globalThis.createImageBitmap === "function"
				? async (file) => {
						const bitmap = await globalThis.createImageBitmap(file);
						return {
							source: bitmap,
							width: bitmap.width,
							height: bitmap.height,
							close: () => bitmap.close(),
						};
					}
				: undefined,
		createObjectURL: (blob) => URL.createObjectURL(blob),
		revokeObjectURL: (url) => URL.revokeObjectURL(url),
		loadImage: (url) =>
			new Promise((resolve, reject) => {
				const image = new Image();
				image.decoding = "async";
				image.onload = () =>
					resolve({
						source: image,
						width: image.naturalWidth,
						height: image.naturalHeight,
						...(typeof image.decode === "function" ? { decode: () => image.decode() } : {}),
					});
				image.onerror = () => reject(new Error("image_decode_failed"));
				image.src = url;
			}),
		createEncoder: (source, width, height) => {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d", { alpha: true });
			if (!context) return null;
			context.drawImage(source, 0, 0, width, height);
			return {
				encode: (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
			};
		},
		readAsDataURL: (blob) =>
			new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () =>
					typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("image_read_failed"));
				reader.onerror = () => reject(reader.error ?? new Error("image_read_failed"));
				reader.readAsDataURL(blob);
			}),
	};
}
