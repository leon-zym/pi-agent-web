import { SESSION_IMAGE_MAX_BASE64_CHARS, SESSION_IMAGE_TOTAL_MAX_BASE64_CHARS } from "@pi-agent-web/protocol";
import type { ImageContent } from "../types/pi-types";

export const COMPOSER_IMAGE_MAX_COUNT = 4;
const TARGET_BASE64_CHARS = 1_500_000;
const MAX_DIMENSION = 2_048;
const PASSTHROUGH_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

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
): Promise<ImageContent[]> {
	const candidates = files.filter((file) => file.type.startsWith("image/"));
	const available = COMPOSER_IMAGE_MAX_COUNT - existing.length;
	if (available <= 0) throw new ImageAttachmentError("too_many", "attachment_limit_reached");
	const selected = candidates.slice(0, available);
	if (selected.length === 0) return existing;

	const prepared: ImageContent[] = [];
	for (const file of selected) prepared.push(await prepareImage(file));
	const combined = [...existing, ...prepared];
	if (imagePayloadChars(combined) > SESSION_IMAGE_TOTAL_MAX_BASE64_CHARS) {
		throw new ImageAttachmentError("total_too_large", "attachment_total_too_large");
	}
	return combined;
}

async function prepareImage(file: File): Promise<ImageContent> {
	if (file.size > 50 * 1024 * 1024) {
		throw new ImageAttachmentError("too_large", "attachment_too_large");
	}
	const original = await blobAsAttachment(file, false);
	if (PASSTHROUGH_MIME_TYPES.has(original.mimeType) && original.data.length <= TARGET_BASE64_CHARS) {
		return original;
	}

	let source: DecodedImage;
	try {
		source = await decodeImage(file);
	} catch {
		throw new ImageAttachmentError("decode_failed", "attachment_decode_failed");
	}
	try {
		const candidate = await resizeImage(source);
		if (candidate && candidate.data.length <= SESSION_IMAGE_MAX_BASE64_CHARS) return candidate;
	} finally {
		source.dispose();
	}
	throw new ImageAttachmentError("too_large", "attachment_too_large");
}

interface DecodedImage {
	source: CanvasImageSource;
	width: number;
	height: number;
	dispose: () => void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
	if (typeof createImageBitmap === "function") {
		const bitmap = await createImageBitmap(file);
		return {
			source: bitmap,
			width: bitmap.width,
			height: bitmap.height,
			dispose: () => bitmap.close(),
		};
	}
	const url = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.decoding = "async";
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error("image_decode_failed"));
			image.src = url;
		});
		return {
			source: image,
			width: image.naturalWidth,
			height: image.naturalHeight,
			dispose: () => URL.revokeObjectURL(url),
		};
	} catch (error) {
		URL.revokeObjectURL(url);
		throw error;
	}
}

async function resizeImage(decoded: DecodedImage): Promise<ImageContent | null> {
	const longest = Math.max(decoded.width, decoded.height);
	const baseScale = Math.min(1, MAX_DIMENSION / Math.max(1, longest));
	let smallest: ImageContent | null = null;
	for (const scale of [baseScale, baseScale * 0.8, baseScale * 0.64]) {
		const width = Math.max(1, Math.round(decoded.width * scale));
		const height = Math.max(1, Math.round(decoded.height * scale));
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d", { alpha: true });
		if (!context) continue;
		context.drawImage(decoded.source, 0, 0, width, height);
		for (const quality of [0.86, 0.72, 0.58]) {
			const blob = await canvasToBlob(canvas, "image/webp", quality);
			if (!blob) continue;
			const attachment = await blobAsAttachment(blob);
			if (!smallest || attachment.data.length < smallest.data.length) smallest = attachment;
			if (attachment.data.length <= TARGET_BASE64_CHARS) return attachment;
		}
	}
	return smallest;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function blobAsAttachment(blob: Blob, enforceLimit = true): Promise<ImageContent> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () =>
			typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("image_read_failed"));
		reader.onerror = () => reject(reader.error ?? new Error("image_read_failed"));
		reader.readAsDataURL(blob);
	});
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
