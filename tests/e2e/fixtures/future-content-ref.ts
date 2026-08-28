import type { Page, WebSocket } from "@playwright/test";
import type { StartHarnessOptions } from "./production-harness";

/** Explicit opt-in for the post-7E private Browser lane. It is never set by CI. */
export const PRIVATE_L3_ENV = "PI_WEB_E2E_PRIVATE_L3";
/** Passed only to the deterministic Pi fixture; it does not activate the Gateway. */
export const FUTURE_FIXTURE_ENV = "PI_WEB_E2E_CONTENT_REF_FIXTURE";
export const FUTURE_CONTENT_PROMPT = "E2E_FUTURE_CONTENT_REFS";
export const FUTURE_READY_TEXT = "E2E_FUTURE_CONTENT_REFS_READY";

export const FUTURE_PROTOCOL_MINOR = 3;
export const FUTURE_CAPABILITIES = [
	"rpc.commands",
	"rpc.events",
	"rpc.extension_ui",
	"session.multiplex",
	"session.hot_runtime_inventory",
	"payload.epoch_attachment_refs",
	"payload.epoch_content_refs",
] as const;
export const FUTURE_PAYLOAD_BUDGET = {
	maxCommandFrameBytes: 8 * 1024 * 1024,
	maxCommandTextBytes: 1024 * 1024,
	maxInlineImageBase64Bytes: 2 * 1024 * 1024,
	maxInlineImagesBase64Bytes: 6 * 1024 * 1024,
	maxImageCount: 16,
	maxPiJsonlFrameBytes: 8 * 1024 * 1024,
	maxPiSnapshotJsonlFrameBytes: 64 * 1024 * 1024,
	maxNormalizedEventFrameBytes: 8 * 1024 * 1024 + 4 * 1024,
	maxReplayFrameBytes: 8 * 1024 * 1024 + 4 * 1024,
	maxReplayBytes: 16 * 1024 * 1024,
	maxSnapshotCanonicalBytes: 64 * 1024 * 1024,
	maxServerFrameBytes: 65 * 1024 * 1024,
	maxQueuedBacklogBytes: 1024 * 1024,
	maxCatchUpBacklogBytes: 1024 * 1024,
	maxAttachmentBlobBytes: 8 * 1024 * 1024,
	maxAttachmentCacheBytes: 64 * 1024 * 1024,
	maxAttachmentCacheItems: 256,
} as const;
export const FUTURE_CONTENT_REF_BUDGET = {
	maxContentBlobBytes: 48 * 1024 * 1024,
	inlineContentThresholdBytes: 256 * 1024,
} as const;

export interface ObservedWireFrame {
	direction: "sent" | "received";
	frame: Record<string, unknown>;
	raw: string;
}

export interface FutureWireObservation {
	sockets: WebSocket[];
	closed: WebSocket[];
	events: ObservedWireFrame[];
}

export interface ObservedContentRef {
	type: "content_ref";
	encoding: "utf-8";
	serverEpoch: string;
	sha256: string;
	byteLength: number;
}

export function privateL3Enabled(): boolean {
	return process.env[PRIVATE_L3_ENV] === "1";
}

/**
 * This option selects only the future Pi input fixture. A 1.2 Gateway ignores it;
 * the private spec still fails closed on the negotiated hello before using it.
 */
export function futureFixtureHarnessOptions(): StartHarnessOptions {
	return { extraEnv: { [FUTURE_FIXTURE_ENV]: "1" } };
}

export function contentRefUrl(
	origin: string,
	ref: Pick<ObservedContentRef, "serverEpoch" | "sha256">,
): string {
	return new URL(`/api/v1/content/${encodeURIComponent(ref.serverEpoch)}/${ref.sha256}`, origin).toString();
}

function parseWireFrame(
	payload: string | Buffer,
): { frame: Record<string, unknown>; raw: string } | undefined {
	const raw = payload.toString();
	try {
		const frame = JSON.parse(raw) as unknown;
		return typeof frame === "object" && frame !== null && !Array.isArray(frame)
			? { frame: frame as Record<string, unknown>, raw }
			: undefined;
	} catch {
		return undefined;
	}
}

export function observeFutureWire(page: Page): FutureWireObservation {
	const observation: FutureWireObservation = { sockets: [], closed: [], events: [] };
	page.on("websocket", (socket) => {
		observation.sockets.push(socket);
		socket.on("framesent", ({ payload }) => {
			const parsed = parseWireFrame(payload);
			if (parsed) observation.events.push({ direction: "sent", ...parsed });
		});
		socket.on("framereceived", ({ payload }) => {
			const parsed = parseWireFrame(payload);
			if (parsed) observation.events.push({ direction: "received", ...parsed });
		});
		socket.on("close", () => observation.closed.push(socket));
	});
	return observation;
}

export function receivedWireFrames(observation: FutureWireObservation): Record<string, unknown>[] {
	return observation.events.filter((event) => event.direction === "received").map((event) => event.frame);
}

export function sentWireFrames(observation: FutureWireObservation): Record<string, unknown>[] {
	return observation.events.filter((event) => event.direction === "sent").map((event) => event.frame);
}

export function collectContentRefs(observation: FutureWireObservation): ObservedContentRef[] {
	const refs: ObservedContentRef[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const candidate = value as Record<string, unknown>;
		if (
			candidate.type === "content_ref" &&
			candidate.encoding === "utf-8" &&
			typeof candidate.serverEpoch === "string" &&
			typeof candidate.sha256 === "string" &&
			typeof candidate.byteLength === "number"
		) {
			refs.push(candidate as unknown as ObservedContentRef);
		}
		for (const child of Object.values(candidate)) visit(child);
	};
	for (const event of observation.events) {
		if (event.direction === "received") visit(event.frame);
	}
	return refs;
}

export function contentRefFrames(observation: FutureWireObservation): ObservedWireFrame[] {
	return observation.events.filter(
		(event) => event.direction === "received" && event.raw.includes('"content_ref"'),
	);
}

export function futureHello(observation: FutureWireObservation): Record<string, unknown> | undefined {
	return receivedWireFrames(observation).find((frame) => frame.type === "server_hello");
}
