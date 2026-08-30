import {
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
	type SessionContentRefGuardContext,
} from "@pi-agent-web/protocol";
import type { EpochContentHold, EpochContentStore, EpochStoredContentRef } from "./epoch-content-store.js";
import type { PiHostPayloadExternalizer } from "./pi-host-adapter.js";
import { externalizePiPayload, type PiPayloadExternalizerInput } from "./pi-payload-externalizer.js";
import { createSessionProductSchema } from "./session-product-schema.js";
import {
	createSessionRuntimePiPayloadServices,
	type SessionRuntimePiPayloadServices,
} from "./session-runtime.js";

/** One production activation root for attachment guards, storage, Pi decoding, and ownership. */
export interface GatewayPayloadActivation {
	readonly context: SessionContentRefGuardContext;
	readonly contentStore: EpochContentStore;
	readonly externalizer: PiHostPayloadExternalizer;
	readonly supervisorServices: SessionRuntimePiPayloadServices;
}

export function createGatewayPayloadActivation(
	contentStore: EpochContentStore,
	serverEpoch: string,
): GatewayPayloadActivation {
	const context = Object.freeze({
		serverEpoch,
		payloadBudget: SESSION_PAYLOAD_BUDGET,
		contentRefBudget: SESSION_CONTENT_REF_BUDGET,
	});
	const externalizer: PiHostPayloadExternalizer = Object.freeze({
		mode: "content_ref",
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
	const supervisorServices = createSessionRuntimePiPayloadServices({
		externalizer,
		productSchema: createSessionProductSchema(context),
		releaseHold: (hold: EpochContentHold<EpochStoredContentRef>) => contentStore.release(hold),
	});
	return Object.freeze({ context, contentStore, externalizer, supervisorServices });
}
