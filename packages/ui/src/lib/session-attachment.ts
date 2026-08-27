import type { SessionAttachmentRefDto, SessionImageContentDto } from "@pi-agent-web/protocol";

export function isSessionAttachmentImage(
	image: SessionImageContentDto,
): image is SessionImageContentDto & { data: SessionAttachmentRefDto } {
	return typeof image.data !== "string";
}

/** Same-origin URL; the browser supplies the authenticated Gateway cookie without copying the body. */
export function sessionImageSource(image: SessionImageContentDto): string {
	if (typeof image.data === "string") {
		return `data:${image.mimeType};base64,${image.data}`;
	}
	return `/api/v1/attachments/${encodeURIComponent(image.data.serverEpoch)}/${image.data.sha256}`;
}

/** React list identity must never copy or retain the potentially multi-megabyte inline body. */
export function sessionImageKey(image: SessionImageContentDto, index: number): string {
	return typeof image.data === "string"
		? `${image.mimeType}:inline:${index}`
		: `${image.data.serverEpoch}:${image.data.sha256}:${index}`;
}

interface AttachmentFailureChannel {
	baselineAuthoritative: boolean;
	runtime: { generation: number } | null;
}

/** Fence a DOM load failure to the exact Runtime whose projection baseline is currently committed. */
export function reportAuthoritativeAttachmentFailure(
	sessionHandle: string,
	channel: AttachmentFailureChannel | undefined,
	report: (sessionHandle: string, generation: number, error: unknown) => boolean,
): boolean {
	if (!channel?.baselineAuthoritative || channel.runtime === null) return false;
	return report(
		sessionHandle,
		channel.runtime.generation,
		new Error("Session attachment became unavailable"),
	);
}
