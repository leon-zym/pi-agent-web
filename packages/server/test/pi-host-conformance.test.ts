import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type {
	ExtensionUiRequestDto,
	ProductSessionEventDto,
	SessionCommandTypeDto,
} from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import { LEGACY_RPC_V1_ADAPTER_ID, legacyRpcV1Adapter } from "../src/legacy-rpc-v1.js";

type IsSubset<Subset, Superset> = [Subset] extends [Superset] ? true : false;
type Assert<Condition extends true> = Condition;
type UpstreamSuccessResponseCommand = Exclude<RpcResponse, { success: false }>["command"];
type ProductAuthoritativeEventType = Exclude<ProductSessionEventDto, { type: "extension_error" }>["type"];

// These aliases are intentionally type-only. A Pi package upgrade fails this test at the
// adapter boundary if a product command/event/method disappears from the reviewed upstream wire.
type _ProductCommandsRemainUpstream = Assert<IsSubset<SessionCommandTypeDto, RpcCommand["type"]>>;
type _ProductResponsesRemainUpstream = Assert<
	IsSubset<SessionCommandTypeDto, UpstreamSuccessResponseCommand>
>;
type _ProductEventsRemainUpstream = Assert<
	IsSubset<ProductAuthoritativeEventType, JsonAgentSessionEvent["type"]>
>;
type _ProductExtensionMethodsRemainUpstream = Assert<
	IsSubset<ExtensionUiRequestDto["method"], RpcExtensionUIRequest["method"]>
>;

const UPSTREAM_CONFORMANCE: readonly [
	_ProductCommandsRemainUpstream,
	_ProductResponsesRemainUpstream,
	_ProductEventsRemainUpstream,
	_ProductExtensionMethodsRemainUpstream,
] = [true, true, true, true];

describe("Pi host adapter upstream conformance", () => {
	it("keeps upstream imports type-only and the runtime adapter product-facing", () => {
		expect(UPSTREAM_CONFORMANCE).toEqual([true, true, true, true]);
		expect(LEGACY_RPC_V1_ADAPTER_ID).toBe("legacy-rpc-v1");
		expect(legacyRpcV1Adapter.id).toBe(LEGACY_RPC_V1_ADAPTER_ID);
		expect(legacyRpcV1Adapter.encodeCommand({ type: "get_state", id: "command-1" })).toEqual({
			type: "get_state",
			id: "command-1",
		});
	});
});
