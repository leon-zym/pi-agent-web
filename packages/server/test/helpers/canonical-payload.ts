import {
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
	type SessionContentRefGuardContext,
} from "@pi-agent-web/protocol";
import type { EpochContentHold, EpochStoredContentRef } from "../../src/epoch-content-store.js";
import type { PiHostPayloadExternalizer } from "../../src/pi-host-adapter.js";
import type {
	Externalized,
	PiPayloadExternalizerInput,
	PiPayloadLease,
} from "../../src/pi-payload-externalizer.js";
import { createSessionProductSchema } from "../../src/session-product-schema.js";
import {
	createSessionRuntimePiPayloadServices,
	type SessionRuntimePiPayloadServices,
} from "../../src/session-runtime.js";

export interface CanonicalPayloadFixture {
	context: SessionContentRefGuardContext;
	externalizer: PiHostPayloadExternalizer;
	supervisorServices: SessionRuntimePiPayloadServices;
}

function emptyLease(): PiPayloadLease<EpochStoredContentRef> {
	let transferred = false;
	return Object.freeze({
		refs: Object.freeze([]),
		transfer() {
			if (transferred) throw new Error("empty payload lease was already transferred");
			transferred = true;
			return Object.freeze({
				refs: Object.freeze([]),
				adopt(accept: (holds: readonly EpochContentHold<EpochStoredContentRef>[]) => true) {
					if (accept([]) !== true) throw new Error("empty payload lease adoption was rejected");
				},
				release: async () => {},
			});
		},
		release: async () => {},
	});
}

export function createCanonicalPayloadFixture(serverEpoch: string): CanonicalPayloadFixture {
	const context = Object.freeze({
		serverEpoch,
		payloadBudget: SESSION_PAYLOAD_BUDGET,
		contentRefBudget: SESSION_CONTENT_REF_BUDGET,
	});
	const externalizer: PiHostPayloadExternalizer = Object.freeze({
		mode: "content_ref",
		context,
		externalize: async (
			input: PiPayloadExternalizerInput,
		): Promise<Externalized<unknown, EpochStoredContentRef>> => ({
			value: input.value,
			lease: emptyLease(),
		}),
	});
	const supervisorServices = createSessionRuntimePiPayloadServices({
		externalizer,
		productSchema: createSessionProductSchema(context),
		releaseHold: async () => {},
	});
	return Object.freeze({ context, externalizer, supervisorServices });
}
