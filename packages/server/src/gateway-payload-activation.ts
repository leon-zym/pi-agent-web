import { SESSION_PAYLOAD_BUDGET, type SessionAttachmentGuardContext } from "@pi-agent-web/protocol";
import type { EpochContentHold, EpochContentStore } from "./epoch-content-store.js";
import type { PiHostPayloadExternalizer } from "./pi-host-adapter.js";
import { externalizePiPayload, type PiPayloadExternalizerInput } from "./pi-payload-externalizer.js";
import type { SessionRuntimePiPayloadServices } from "./session-runtime.js";

/** One production activation root for attachment guards, storage, Pi decoding, and ownership. */
export interface GatewayPayloadActivation {
	readonly context: SessionAttachmentGuardContext;
	readonly contentStore: EpochContentStore;
	readonly externalizer: PiHostPayloadExternalizer;
	readonly supervisorServices: SessionRuntimePiPayloadServices;
}

export function createGatewayPayloadActivation(
	contentStore: EpochContentStore,
	serverEpoch: string,
): GatewayPayloadActivation {
	const context = Object.freeze({ serverEpoch, payloadBudget: SESSION_PAYLOAD_BUDGET });
	const externalizer: PiHostPayloadExternalizer = Object.freeze({
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
