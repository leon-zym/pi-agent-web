import {
	FUTURE_SESSION_CONTENT_REF_BUDGET,
	type FutureSessionContentRefGuardContext,
	SESSION_PAYLOAD_BUDGET,
	type SessionAttachmentGuardContext,
} from "@pi-agent-web/protocol";
import type { EpochContentHold, EpochContentStore } from "./epoch-content-store.js";
import type {
	PiHostAttachmentPayloadExternalizer,
	PiHostFuturePayloadExternalizer,
} from "./pi-host-adapter.js";
import { externalizePiPayload, type PiPayloadExternalizerInput } from "./pi-payload-externalizer.js";
import type { SessionRuntimePiPayloadServices } from "./session-runtime.js";

/** One production activation root for attachment guards, storage, Pi decoding, and ownership. */
export interface GatewayPayloadActivation {
	readonly context: SessionAttachmentGuardContext;
	readonly contentStore: EpochContentStore;
	readonly externalizer: PiHostAttachmentPayloadExternalizer;
	readonly supervisorServices: SessionRuntimePiPayloadServices;
}

/** Default-off future activation root. Stage 4C1 does not connect this to Main or Runtime. */
export interface GatewayFuturePayloadActivation {
	readonly context: FutureSessionContentRefGuardContext;
	readonly contentStore: EpochContentStore;
	readonly externalizer: PiHostFuturePayloadExternalizer;
}

export function createGatewayPayloadActivation(
	contentStore: EpochContentStore,
	serverEpoch: string,
): GatewayPayloadActivation {
	const context = Object.freeze({ serverEpoch, payloadBudget: SESSION_PAYLOAD_BUDGET });
	const externalizer: PiHostAttachmentPayloadExternalizer = Object.freeze({
		mode: "attachment",
		context,
		externalize: (input: PiPayloadExternalizerInput, signal: AbortSignal) =>
			externalizePiPayload(input, {
				contentStore,
				serverEpoch: context.serverEpoch,
				payloadBudget: context.payloadBudget,
				signal,
			}),
	});
	const supervisorServices: SessionRuntimePiPayloadServices = Object.freeze({
		externalizer,
		releaseHold: (hold: EpochContentHold) => contentStore.release(hold),
	});
	return Object.freeze({ context, contentStore, externalizer, supervisorServices });
}

export function createGatewayFuturePayloadActivation(
	contentStore: EpochContentStore,
	serverEpoch: string,
): GatewayFuturePayloadActivation {
	const context = Object.freeze({
		serverEpoch,
		payloadBudget: SESSION_PAYLOAD_BUDGET,
		contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
	});
	const externalizer: PiHostFuturePayloadExternalizer = Object.freeze({
		mode: "future_content",
		context,
		externalize: (input: PiPayloadExternalizerInput, signal: AbortSignal) =>
			externalizePiPayload(input, {
				contentStore,
				serverEpoch: context.serverEpoch,
				payloadBudget: context.payloadBudget,
				genericContent: { contentRefBudget: context.contentRefBudget },
				signal,
			}),
	});
	return Object.freeze({ context, contentStore, externalizer });
}
