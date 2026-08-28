const MIB = 1024 * 1024;

export const SESSION_TEXT_MAX_BYTES = MIB;
export const SESSION_WS_CLIENT_MAX_BYTES = 8 * MIB;
/** Maximum negotiated Gateway-to-browser frame, including a bounded history snapshot envelope. */
export const SESSION_WS_SERVER_MAX_BYTES = 65 * MIB;
export const SESSION_SNAPSHOT_MAX_BYTES = 64 * MIB;
export const SESSION_IMAGE_MAX_COUNT = 16;
export const SESSION_IMAGE_MAX_BASE64_CHARS = 2 * MIB;
export const SESSION_IMAGE_TOTAL_MAX_BASE64_CHARS = 6 * MIB;
export const SESSION_PI_JSONL_MAX_BYTES = 8 * MIB;
export const SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES = 64 * MIB;
/** Covers the maximum escaped Session identity, sequence fields, and event wrapper. */
export const SESSION_EVENT_ENVELOPE_HEADROOM_BYTES = 4 * 1024;
export const SESSION_NORMALIZED_EVENT_MAX_BYTES =
	SESSION_PI_JSONL_MAX_BYTES + SESSION_EVENT_ENVELOPE_HEADROOM_BYTES;
export const SESSION_REPLAY_FRAME_MAX_BYTES = SESSION_NORMALIZED_EVENT_MAX_BYTES;
export const SESSION_REPLAY_MAX_BYTES = 16 * MIB;
export const SESSION_OUTBOUND_QUEUE_MAX_BYTES = MIB;
export const SESSION_CATCH_UP_MAX_BYTES = MIB;
export const SESSION_ATTACHMENT_BLOB_MAX_BYTES = 8 * MIB;
export const SESSION_ATTACHMENT_CACHE_MAX_BYTES = 64 * MIB;
export const SESSION_ATTACHMENT_CACHE_MAX_ITEMS = 256;

export interface SessionPayloadBudgetDto {
	maxCommandFrameBytes: number;
	maxCommandTextBytes: number;
	maxInlineImageBase64Bytes: number;
	maxInlineImagesBase64Bytes: number;
	maxImageCount: number;
	maxPiJsonlFrameBytes: number;
	maxPiSnapshotJsonlFrameBytes: number;
	maxNormalizedEventFrameBytes: number;
	maxReplayFrameBytes: number;
	maxReplayBytes: number;
	maxSnapshotCanonicalBytes: number;
	maxServerFrameBytes: number;
	maxQueuedBacklogBytes: number;
	maxCatchUpBacklogBytes: number;
	maxAttachmentBlobBytes: number;
	maxAttachmentCacheBytes: number;
	maxAttachmentCacheItems: number;
}

export const SESSION_PAYLOAD_BUDGET = Object.freeze({
	maxCommandFrameBytes: SESSION_WS_CLIENT_MAX_BYTES,
	maxCommandTextBytes: SESSION_TEXT_MAX_BYTES,
	maxInlineImageBase64Bytes: SESSION_IMAGE_MAX_BASE64_CHARS,
	maxInlineImagesBase64Bytes: SESSION_IMAGE_TOTAL_MAX_BASE64_CHARS,
	maxImageCount: SESSION_IMAGE_MAX_COUNT,
	maxPiJsonlFrameBytes: SESSION_PI_JSONL_MAX_BYTES,
	maxPiSnapshotJsonlFrameBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
	maxNormalizedEventFrameBytes: SESSION_NORMALIZED_EVENT_MAX_BYTES,
	maxReplayFrameBytes: SESSION_REPLAY_FRAME_MAX_BYTES,
	maxReplayBytes: SESSION_REPLAY_MAX_BYTES,
	maxSnapshotCanonicalBytes: SESSION_SNAPSHOT_MAX_BYTES,
	maxServerFrameBytes: SESSION_WS_SERVER_MAX_BYTES,
	maxQueuedBacklogBytes: SESSION_OUTBOUND_QUEUE_MAX_BYTES,
	maxCatchUpBacklogBytes: SESSION_CATCH_UP_MAX_BYTES,
	maxAttachmentBlobBytes: SESSION_ATTACHMENT_BLOB_MAX_BYTES,
	maxAttachmentCacheBytes: SESSION_ATTACHMENT_CACHE_MAX_BYTES,
	maxAttachmentCacheItems: SESSION_ATTACHMENT_CACHE_MAX_ITEMS,
}) satisfies SessionPayloadBudgetDto;

type UnknownRecord = Record<string, unknown>;

function isCanonicalRecord(value: unknown, allowedKeys: readonly string[]): value is UnknownRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (Object.getPrototypeOf(value) !== Object.prototype) return false;
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))) return false;
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) return false;
	}
	return true;
}

function isSafePositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const PAYLOAD_BUDGET_KEYS = Object.keys(SESSION_PAYLOAD_BUDGET);

export function isSessionPayloadBudgetDto(value: unknown): value is SessionPayloadBudgetDto {
	if (!isCanonicalRecord(value, PAYLOAD_BUDGET_KEYS)) return false;
	if (Object.keys(value).length !== PAYLOAD_BUDGET_KEYS.length) return false;
	if (!PAYLOAD_BUDGET_KEYS.every((key) => isSafePositiveInteger(value[key]))) return false;
	const budget = value as unknown as SessionPayloadBudgetDto;
	return (
		budget.maxCommandTextBytes <= budget.maxCommandFrameBytes &&
		budget.maxInlineImageBase64Bytes <= budget.maxInlineImagesBase64Bytes &&
		budget.maxInlineImagesBase64Bytes <= budget.maxCommandFrameBytes &&
		budget.maxCommandFrameBytes <= budget.maxPiJsonlFrameBytes &&
		budget.maxPiJsonlFrameBytes <= budget.maxPiSnapshotJsonlFrameBytes &&
		budget.maxPiJsonlFrameBytes <= Number.MAX_SAFE_INTEGER - SESSION_EVENT_ENVELOPE_HEADROOM_BYTES &&
		budget.maxPiJsonlFrameBytes + SESSION_EVENT_ENVELOPE_HEADROOM_BYTES <=
			budget.maxNormalizedEventFrameBytes &&
		budget.maxNormalizedEventFrameBytes <= budget.maxReplayFrameBytes &&
		budget.maxReplayFrameBytes <= budget.maxReplayBytes &&
		budget.maxReplayFrameBytes <= budget.maxServerFrameBytes &&
		budget.maxPiSnapshotJsonlFrameBytes <= budget.maxSnapshotCanonicalBytes &&
		budget.maxSnapshotCanonicalBytes <= budget.maxServerFrameBytes &&
		budget.maxQueuedBacklogBytes <= budget.maxServerFrameBytes &&
		budget.maxCatchUpBacklogBytes <= budget.maxServerFrameBytes &&
		budget.maxAttachmentBlobBytes <= budget.maxAttachmentCacheBytes
	);
}

export interface SessionAttachmentRefDto {
	type: "attachment_ref";
	serverEpoch: string;
	sha256: string;
	mediaType: string;
	byteLength: number;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export function isSessionAttachmentRefDto(value: unknown): value is SessionAttachmentRefDto {
	if (!isCanonicalRecord(value, ["type", "serverEpoch", "sha256", "mediaType", "byteLength"])) {
		return false;
	}
	return (
		Object.keys(value).length === 5 &&
		value.type === "attachment_ref" &&
		typeof value.serverEpoch === "string" &&
		value.serverEpoch.length > 0 &&
		value.serverEpoch.length <= 128 &&
		typeof value.sha256 === "string" &&
		SHA256_RE.test(value.sha256) &&
		typeof value.mediaType === "string" &&
		MEDIA_TYPE_RE.test(value.mediaType) &&
		isSafePositiveInteger(value.byteLength) &&
		value.byteLength <= SESSION_ATTACHMENT_BLOB_MAX_BYTES
	);
}

export function attachmentRefMatchesServerEpoch(
	attachment: SessionAttachmentRefDto,
	serverEpoch: string,
): boolean {
	return attachment.serverEpoch === serverEpoch;
}

/** Admits a reference only against the complete budget and epoch negotiated for this connection. */
export function isSessionAttachmentRefForNegotiatedBudget(
	value: unknown,
	expectedServerEpoch: string,
	budget: SessionPayloadBudgetDto,
): value is SessionAttachmentRefDto {
	return (
		isSessionPayloadBudgetDto(budget) &&
		isSessionAttachmentRefDto(value) &&
		value.serverEpoch === expectedServerEpoch &&
		value.byteLength <= budget.maxAttachmentBlobBytes
	);
}

export type SessionPayloadAdmissionBoundaryDto =
	| "capability"
	| "command_frame"
	| "command_text"
	| "inline_image"
	| "inline_images"
	| "pi_jsonl_frame"
	| "normalized_event_frame"
	| "replay_frame"
	| "replay_buffer"
	| "snapshot"
	| "outbound_queue"
	| "catch_up_buffer"
	| "attachment_ref"
	| "attachment_blob"
	| "attachment_cache";

type SizedPayloadAdmissionErrorDto = {
	type: "payload_admission_error";
	code: "payload_too_large" | "attachment_cache_exhausted";
	boundary: SessionPayloadAdmissionBoundaryDto;
	limitBytes: number;
	actualBytes: number;
};

type UnsizedPayloadAdmissionErrorDto = {
	type: "payload_admission_error";
	code:
		| "attachment_ref_invalid"
		| "attachment_ref_epoch_mismatch"
		| "attachment_unavailable"
		| "capability_required";
	boundary: SessionPayloadAdmissionBoundaryDto;
};

export type SessionAttachmentCacheItemLimitAdmissionErrorDto = {
	type: "payload_admission_error";
	code: "attachment_cache_item_limit_exceeded";
	boundary: "attachment_cache";
	limitItems: number;
	actualItems: number;
};

export type SessionPayloadAdmissionErrorDto =
	| SizedPayloadAdmissionErrorDto
	| SessionAttachmentCacheItemLimitAdmissionErrorDto
	| UnsizedPayloadAdmissionErrorDto;

const PAYLOAD_ADMISSION_BOUNDARIES = new Set<SessionPayloadAdmissionBoundaryDto>([
	"capability",
	"command_frame",
	"command_text",
	"inline_image",
	"inline_images",
	"pi_jsonl_frame",
	"normalized_event_frame",
	"replay_frame",
	"replay_buffer",
	"snapshot",
	"outbound_queue",
	"catch_up_buffer",
	"attachment_ref",
	"attachment_blob",
	"attachment_cache",
]);

export function isSessionPayloadAdmissionErrorDto(value: unknown): value is SessionPayloadAdmissionErrorDto {
	if (
		!isCanonicalRecord(value, [
			"type",
			"code",
			"boundary",
			"limitBytes",
			"actualBytes",
			"limitItems",
			"actualItems",
		])
	) {
		return false;
	}
	if (
		value.type !== "payload_admission_error" ||
		typeof value.boundary !== "string" ||
		!PAYLOAD_ADMISSION_BOUNDARIES.has(value.boundary as SessionPayloadAdmissionBoundaryDto)
	) {
		return false;
	}
	if (value.code === "payload_too_large" || value.code === "attachment_cache_exhausted") {
		if (value.code === "attachment_cache_exhausted" && value.boundary !== "attachment_cache") {
			return false;
		}
		if (
			value.code === "payload_too_large" &&
			(value.boundary === "capability" || value.boundary === "attachment_ref")
		) {
			return false;
		}
		return (
			Object.keys(value).length === 5 &&
			isSafePositiveInteger(value.limitBytes) &&
			isSafePositiveInteger(value.actualBytes) &&
			value.actualBytes > value.limitBytes
		);
	}
	if (value.code === "attachment_cache_item_limit_exceeded") {
		return (
			Object.keys(value).length === 5 &&
			value.boundary === "attachment_cache" &&
			isSafePositiveInteger(value.limitItems) &&
			isSafePositiveInteger(value.actualItems) &&
			value.actualItems > value.limitItems
		);
	}
	if (
		value.code !== "attachment_ref_invalid" &&
		value.code !== "attachment_ref_epoch_mismatch" &&
		value.code !== "attachment_unavailable" &&
		value.code !== "capability_required"
	) {
		return false;
	}
	if (Object.keys(value).length !== 3) return false;
	if (value.code === "capability_required") return value.boundary === "capability";
	return value.boundary === "attachment_ref";
}
