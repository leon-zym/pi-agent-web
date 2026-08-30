import {
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
	type SessionAttachmentRefDto,
	type SessionContentRefDto,
	type SessionContentRefGuardContext,
} from "@pi-agent-web/protocol";
import type { PiHostPayloadExternalizer } from "../../src/pi-host-adapter.js";
import {
	externalizePiPayload,
	type PiGenericPayloadExternalizerContentStore,
	type PiPayloadExternalizerInput,
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

export function createCanonicalPayloadFixture(serverEpoch: string): CanonicalPayloadFixture {
	const context = Object.freeze({
		serverEpoch,
		payloadBudget: SESSION_PAYLOAD_BUDGET,
		contentRefBudget: SESSION_CONTENT_REF_BUDGET,
	});
	const contentStore: PiGenericPayloadExternalizerContentStore = Object.freeze({
		async stage() {
			throw new Error("canonical payload fixture unexpectedly staged an attachment");
		},
		async stageUtf8() {
			throw new Error("canonical payload fixture unexpectedly staged UTF-8 content");
		},
		async holdPublished(ref: SessionAttachmentRefDto) {
			return Object.freeze({ ref });
		},
		async holdPublishedUtf8(ref: SessionContentRefDto) {
			return Object.freeze({ ref });
		},
		async publish() {},
		async release() {},
	});
	const externalizer: PiHostPayloadExternalizer = Object.freeze({
		mode: "content_ref",
		context,
		externalize: (input: PiPayloadExternalizerInput, signal: AbortSignal) =>
			externalizePiPayload(input, {
				contentStore,
				serverEpoch,
				payloadBudget: context.payloadBudget,
				genericContent: { contentRefBudget: context.contentRefBudget },
				signal,
			}),
	});
	const supervisorServices = createSessionRuntimePiPayloadServices({
		externalizer,
		productSchema: createSessionProductSchema(context),
		releaseHold: async () => {},
	});
	return Object.freeze({ context, externalizer, supervisorServices });
}
