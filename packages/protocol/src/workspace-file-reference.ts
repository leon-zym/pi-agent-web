/** Browser-safe budgets and DTOs for Host-owned Workspace file expansion. */

export const WORKSPACE_FILE_SEARCH_MAX_RESULTS = 50;
export const WORKSPACE_FILE_SEARCH_MAX_DIRECTORIES = 300;
export const WORKSPACE_FILE_SEARCH_QUERY_MAX_CHARS = 200;
export const WORKSPACE_FILE_METADATA_READ_MAX_BYTES = 16 * 1024;
export const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 2 * 1024;
export const WORKSPACE_FILE_LARGE_THRESHOLD_BYTES = 64 * 1024;
export const WORKSPACE_FILE_TEXT_MAX_BYTES = 256 * 1024;
export const WORKSPACE_FILE_BINARY_MAX_BYTES = 64 * 1024;
/** Raw bytes whose base64 form still fits the per-image command ceiling. */
export const WORKSPACE_FILE_IMAGE_MAX_BYTES = 1536 * 1024;
export const WORKSPACE_FILE_REFERENCE_MAX_COUNT = 8;
export const WORKSPACE_FILE_REFERENCE_TEXT_TOTAL_MAX_BYTES = 512 * 1024;

export type WorkspaceFileKindDto = "text" | "image" | "binary" | "unknown";

export type WorkspaceFileRiskDto =
	| "large"
	| "binary"
	| "image"
	| "hidden"
	| "ignored"
	| "generated"
	| "credential"
	| "policy_unknown";

export type WorkspaceFileAvailabilityDto = "ready" | "confirmation_required" | "blocked" | "unavailable";

export interface WorkspaceFileMetadataDto {
	path: string;
	canonicalIdentity: string | null;
	byteSize: number | null;
	kind: WorkspaceFileKindDto;
	mimeType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
	estimatedTokens: number | null;
	risks: WorkspaceFileRiskDto[];
	availability: WorkspaceFileAvailabilityDto;
	reason?: string;
	preview?: string;
	previewTruncated: boolean;
}

export interface WorkspaceFileSearchDto {
	query: string;
	files: WorkspaceFileMetadataDto[];
	scannedDirectories: number;
	truncated: boolean;
	skippedEntries: number;
	policy: "gitignore" | "none" | "unknown";
}

export type WorkspaceFileReferenceContentDto =
	| { type: "text"; text: string }
	| { type: "binary_base64"; data: string }
	| {
			type: "image";
			mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
			data: string;
	  };

/** Captured bytes are immutable Browser state for file-reference expansion. */
export interface WorkspaceFileReferenceDto {
	metadata: WorkspaceFileMetadataDto;
	content: WorkspaceFileReferenceContentDto;
}

export interface WorkspaceFileCaptureRequestDto {
	path: string;
	canonicalIdentity: string;
	confirmed: boolean;
}
