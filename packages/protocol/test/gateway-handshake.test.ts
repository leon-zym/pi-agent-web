import { describe, expect, it } from "vitest";
import {
	GATEWAY_PROTOCOL_VERSION,
	isGatewayClientHello,
	isGatewayProtocolError,
	isGatewayServerHello,
} from "../src/gateway-handshake.js";

describe("Gateway hello DTOs", () => {
	it("accepts a bounded versioned client hello", () => {
		expect(
			isGatewayClientHello({
				type: "client_hello",
				protocol: GATEWAY_PROTOCOL_VERSION,
				clientBuild: "0.1.0",
				capabilities: ["session-multiplex-v1"],
				limits: { maxServerFrameBytes: 32 * 1024 * 1024 },
			}),
		).toBe(true);
	});

	it("rejects malformed versions, duplicate capabilities, and unsafe limits", () => {
		const base = {
			type: "client_hello",
			protocol: GATEWAY_PROTOCOL_VERSION,
			clientBuild: "0.1.0",
			capabilities: ["session-multiplex-v1"],
			limits: { maxServerFrameBytes: 1024 },
		};
		expect(isGatewayClientHello({ ...base, protocol: { major: 1.5, minor: 0 } })).toBe(false);
		expect(isGatewayClientHello({ ...base, capabilities: ["same", "same"] })).toBe(false);
		expect(
			isGatewayClientHello({ ...base, limits: { maxServerFrameBytes: Number.MAX_SAFE_INTEGER + 1 } }),
		).toBe(false);
	});

	it("validates all compatibility metadata in server hello and protocol errors", () => {
		expect(
			isGatewayServerHello({
				type: "server_hello",
				protocol: GATEWAY_PROTOCOL_VERSION,
				serverBuild: "0.1.0",
				serverEpoch: "0198f1f1-epoch",
				piVersion: "0.84.2",
				adapterId: "legacy-rpc-v1",
				capabilities: ["rpc.commands", "rpc.events"],
				limits: {
					maxClientFrameBytes: 8 * 1024 * 1024,
					maxSnapshotFrameBytes: 32 * 1024 * 1024,
					maxExtensionRequests: 256,
				},
			}),
		).toBe(true);
		expect(
			isGatewayProtocolError({
				type: "protocol_error",
				code: "protocol_major_unsupported",
				supported: { major: 1, minMinor: 0, maxMinor: 0 },
			}),
		).toBe(true);
	});
});
