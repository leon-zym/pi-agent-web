export type RasterMediaType = "image/gif" | "image/jpeg" | "image/png" | "image/webp";

export type RasterAdmissionErrorCode =
	| "invalid_raster_magic"
	| "invalid_raster_structure"
	| "truncated_raster_header"
	| "unsupported_media_type";

export class RasterAdmissionError extends Error {
	constructor(
		readonly code: RasterAdmissionErrorCode,
		message: string,
	) {
		super(message);
		this.name = "RasterAdmissionError";
	}
}

export interface RasterAdmissionValidator {
	/** Consumes a borrowed chunk without retaining or copying the complete body. */
	push(chunk: Uint8Array): void;
	finish(): void;
}

type ContainerValidator = {
	push(chunk: Uint8Array): void;
	finish(): void;
};

type RasterRule = {
	extension: "gif" | "jpg" | "png" | "webp";
	minimumBytes: number;
	prefixBytes: number;
	matches: (prefix: Uint8Array, byteLength: number) => boolean;
	validator: (prefix: Uint8Array, byteLength: number) => ContainerValidator;
};

// Gateway admission authenticates the allowlisted container type and rejects gross truncation.
// Codec decodability remains the responsibility of browser preprocessing and the Pi/provider path.
const RASTER_RULES: ReadonlyMap<RasterMediaType, RasterRule> = new Map<RasterMediaType, RasterRule>([
	[
		"image/png",
		{
			extension: "png",
			minimumBytes: 24,
			prefixBytes: 24,
			matches: (prefix, byteLength) => {
				const buffer = Buffer.from(prefix);
				return (
					byteLength >= 33 &&
					buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
					buffer.readUInt32BE(8) === 13 &&
					buffer.subarray(12, 16).toString("ascii") === "IHDR" &&
					buffer.readUInt32BE(16) > 0 &&
					buffer.readUInt32BE(20) > 0
				);
			},
			validator: () => tailValidator(Buffer.from("0000000049454e44", "hex"), 12),
		},
	],
	[
		"image/jpeg",
		{
			extension: "jpg",
			minimumBytes: 6,
			prefixBytes: 4,
			matches: matchesJpegPrefix,
			validator: () => tailValidator(Buffer.from([0xff, 0xd9]), 2),
		},
	],
	[
		"image/webp",
		{
			extension: "webp",
			minimumBytes: 20,
			prefixBytes: 20,
			matches: (prefix, byteLength) => {
				const buffer = Buffer.from(prefix);
				const chunkType = buffer.subarray(12, 16).toString("ascii");
				return (
					byteLength >= 20 &&
					buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
					buffer.subarray(8, 12).toString("ascii") === "WEBP" &&
					(chunkType === "VP8 " || chunkType === "VP8L" || chunkType === "VP8X")
				);
			},
			validator: (prefix, byteLength) => new WebpContainerValidator(prefix, byteLength),
		},
	],
	[
		"image/gif",
		{
			extension: "gif",
			minimumBytes: 13,
			prefixBytes: 13,
			matches: (prefix) => {
				const buffer = Buffer.from(prefix);
				const signature = buffer.subarray(0, 6).toString("ascii");
				return (
					(signature === "GIF87a" || signature === "GIF89a") &&
					buffer.readUInt16LE(6) > 0 &&
					buffer.readUInt16LE(8) > 0
				);
			},
			validator: () => tailValidator(Buffer.from([0x3b]), 1),
		},
	],
]);

export function isRasterMediaType(value: string): value is RasterMediaType {
	return RASTER_RULES.has(value as RasterMediaType);
}

export function rasterFileExtension(mediaType: RasterMediaType): RasterRule["extension"] {
	return RASTER_RULES.get(mediaType)!.extension;
}

export function createRasterAdmissionValidator(
	mediaType: string,
	byteLength: number,
): RasterAdmissionValidator {
	const rule = RASTER_RULES.get(mediaType as RasterMediaType);
	if (!rule) {
		throw new RasterAdmissionError("unsupported_media_type", "Attachment media type is not supported");
	}
	if (byteLength < rule.minimumBytes) {
		throw new RasterAdmissionError("truncated_raster_header", "Attachment raster header is truncated");
	}

	const prefix = Buffer.alloc(Math.min(rule.prefixBytes, byteLength));
	let prefixOffset = 0;
	let failure: RasterAdmissionError | undefined;
	let container: ContainerValidator | undefined;

	return {
		push(chunk) {
			if (failure || chunk.byteLength === 0) return;
			let remainderOffset = 0;
			if (!container) {
				const copied = Math.min(chunk.byteLength, prefix.byteLength - prefixOffset);
				prefix.set(chunk.subarray(0, copied), prefixOffset);
				prefixOffset += copied;
				remainderOffset = copied;
				if (prefixOffset !== prefix.byteLength) return;
				if (!rule.matches(prefix, byteLength)) {
					failure = new RasterAdmissionError(
						"invalid_raster_magic",
						"Attachment bytes do not match the media type",
					);
					return;
				}
				container = rule.validator(prefix, byteLength);
				try {
					container.push(prefix);
				} catch (error) {
					if (!(error instanceof RasterAdmissionError)) throw error;
					failure = error;
					container = undefined;
					return;
				}
			}
			if (container && remainderOffset < chunk.byteLength) {
				try {
					container.push(chunk.subarray(remainderOffset));
				} catch (error) {
					if (!(error instanceof RasterAdmissionError)) throw error;
					failure = error;
					container = undefined;
				}
			}
		},
		finish() {
			if (failure) throw failure;
			if (!container) {
				throw new RasterAdmissionError("truncated_raster_header", "Attachment raster header is truncated");
			}
			container.finish();
		},
	};
}

function invalidRasterStructure(): never {
	throw new RasterAdmissionError("invalid_raster_structure", "Attachment raster structure is invalid");
}

class WebpContainerValidator implements ContainerValidator {
	#offset = 0;
	#chunkHeader = Buffer.alloc(8);
	#chunkHeaderOffset = 0;
	#chunkRemaining = 0;
	#chunkNeedsPadding = false;
	#paddingPending = false;
	readonly #byteLength: number;
	readonly #declaredRiffSize: number;

	constructor(prefix: Uint8Array, byteLength: number) {
		this.#byteLength = byteLength;
		this.#declaredRiffSize = Buffer.from(prefix).readUInt32LE(4);
	}

	push(chunk: Uint8Array): void {
		for (const byte of chunk) {
			const position = this.#offset++;
			if (position < 12) continue;
			if (this.#paddingPending) {
				this.#paddingPending = false;
				continue;
			}
			if (this.#chunkRemaining > 0) {
				this.#chunkRemaining--;
				if (this.#chunkRemaining === 0) this.#paddingPending = this.#chunkNeedsPadding;
				continue;
			}
			this.#chunkHeader[this.#chunkHeaderOffset++] = byte;
			if (this.#chunkHeaderOffset !== this.#chunkHeader.byteLength) continue;
			this.#chunkHeaderOffset = 0;
			const chunkSize = this.#chunkHeader.readUInt32LE(4);
			const paddedSize = chunkSize + (chunkSize & 1);
			if (paddedSize > this.#byteLength - this.#offset) invalidRasterStructure();
			this.#chunkRemaining = chunkSize;
			this.#chunkNeedsPadding = (chunkSize & 1) !== 0;
		}
	}

	finish(): void {
		if (
			this.#declaredRiffSize !== this.#byteLength - 8 ||
			this.#offset !== this.#byteLength ||
			this.#chunkHeaderOffset !== 0 ||
			this.#chunkRemaining !== 0 ||
			this.#paddingPending
		) {
			invalidRasterStructure();
		}
	}
}

function matchesJpegPrefix(prefix: Uint8Array, byteLength: number): boolean {
	return (
		byteLength >= 6 &&
		prefix[0] === 0xff &&
		prefix[1] === 0xd8 &&
		prefix[2] === 0xff &&
		prefix[3] !== 0x00 &&
		prefix[3] !== 0xd8 &&
		prefix[3] !== 0xd9
	);
}

function tailValidator(expectedPrefix: Buffer, tailBytes: number): ContainerValidator {
	const tail = Buffer.alloc(tailBytes);
	let seen = 0;
	return {
		push(chunk) {
			const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			if (buffer.byteLength >= tailBytes) {
				tail.set(buffer.subarray(buffer.byteLength - tailBytes));
			} else {
				const filled = Math.min(seen, tailBytes);
				const retained = Math.min(filled, tailBytes - buffer.byteLength);
				if (retained > 0) tail.copyWithin(0, filled - retained, filled);
				tail.set(buffer, retained);
			}
			seen += buffer.byteLength;
		},
		finish() {
			if (seen < tailBytes || !tail.subarray(0, expectedPrefix.byteLength).equals(expectedPrefix)) {
				invalidRasterStructure();
			}
		},
	};
}
