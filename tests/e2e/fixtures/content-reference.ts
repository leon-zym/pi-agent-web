import type { Page, WebSocket } from "@playwright/test";
import {
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	GATEWAY_SESSION_HISTORY_CAPABILITY,
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
} from "../../../packages/protocol/dist/index.js";
import type { StartHarnessOptions } from "./production-harness";

/** Passed only to the deterministic Pi fixture; the Gateway always uses the canonical protocol. */
export const CONTENT_REFERENCE_FIXTURE_ENV = "PI_WEB_E2E_CONTENT_REF_FIXTURE";
export const CONTENT_REFERENCE_PROMPT = "E2E_CONTENT_REFERENCES";
export const CONTENT_REFERENCE_READY_TEXT = "E2E_CONTENT_REFERENCES_READY";
export const CANONICAL_PROTOCOL_VERSION = GATEWAY_PROTOCOL_VERSION;
export const CANONICAL_CAPABILITIES = [
	...GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	GATEWAY_SESSION_HISTORY_CAPABILITY,
] as const;
export const CANONICAL_PAYLOAD_BUDGET = SESSION_PAYLOAD_BUDGET;
export const CANONICAL_CONTENT_REF_BUDGET = SESSION_CONTENT_REF_BUDGET;

export interface ObservedWireFrame {
	direction: "sent" | "received";
	frame: Record<string, unknown>;
	raw: string;
}

export interface WireObservation {
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

/** Selects the deterministic Pi input that exercises large content roots. */
export function contentReferenceHarnessOptions(): StartHarnessOptions {
	return { extraEnv: { [CONTENT_REFERENCE_FIXTURE_ENV]: "1" } };
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

export function observeWire(page: Page): WireObservation {
	const observation: WireObservation = { sockets: [], closed: [], events: [] };
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

export function receivedWireFrames(observation: WireObservation): Record<string, unknown>[] {
	return observation.events.filter((event) => event.direction === "received").map((event) => event.frame);
}

export function sentWireFrames(observation: WireObservation): Record<string, unknown>[] {
	return observation.events.filter((event) => event.direction === "sent").map((event) => event.frame);
}

export function collectContentRefs(observation: WireObservation): ObservedContentRef[] {
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

export function contentRefFrames(observation: WireObservation): ObservedWireFrame[] {
	return observation.events.filter(
		(event) => event.direction === "received" && event.raw.includes('"content_ref"'),
	);
}

export function serverHello(observation: WireObservation): Record<string, unknown> | undefined {
	return receivedWireFrames(observation).find((frame) => frame.type === "server_hello");
}
