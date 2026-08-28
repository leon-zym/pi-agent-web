import { describe, expect, it } from "vitest";
import {
	GATEWAY_CLIENT_REQUIRED_CAPABILITIES,
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_REQUIRED_CAPABILITIES,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	isGatewayClientHello,
	isGatewayProtocolError,
	isGatewayServerHello,
	negotiateGatewayPayloadBudget,
	SESSION_PAYLOAD_BUDGET,
} from "../src/gateway-handshake.js";

describe("Gateway hello DTOs", () => {
	it("requires epoch attachment references in both directional capability sets", () => {
		expect(GATEWAY_PROTOCOL_VERSION).toEqual({ major: 1, minor: 2 });
		expect(GATEWAY_CLIENT_REQUIRED_CAPABILITIES).not.toContain(GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY);
		expect(GATEWAY_SERVER_REQUIRED_CAPABILITIES).toContain(GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY);
		expect(GATEWAY_CLIENT_REQUIRED_CAPABILITIES).toContain(GATEWAY_PAYLOAD_BUDGET_CAPABILITY);
		expect(GATEWAY_SERVER_REQUIRED_CAPABILITIES).toContain(GATEWAY_PAYLOAD_BUDGET_CAPABILITY);
		expect(GATEWAY_REQUIRED_CAPABILITIES).toEqual(GATEWAY_CLIENT_REQUIRED_CAPABILITIES);
	});

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
		expect(
			isGatewayClientHello({
				type: "client_hello",
				protocol: { major: 1, minor: 0 },
				clientBuild: "0.1.0",
				capabilities: ["rpc.commands"],
				limits: { maxServerFrameBytes: 1024 },
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
				capabilities: ["rpc.commands", "rpc.events", GATEWAY_PAYLOAD_BUDGET_CAPABILITY],
				limits: {
					maxClientFrameBytes: 8 * 1024 * 1024,
					maxSnapshotFrameBytes: 32 * 1024 * 1024,
					maxExtensionRequests: 256,
				},
				payloadBudget: SESSION_PAYLOAD_BUDGET,
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

	it("keeps protocol 1.1 hello at the old shape", () => {
		const legacyCapabilities = [
			"rpc.commands",
			"rpc.events",
			"rpc.extension_ui",
			"session.multiplex",
			GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
		];
		const client = {
			type: "client_hello",
			protocol: { major: 1, minor: 1 },
			clientBuild: "0.1.0",
			capabilities: legacyCapabilities,
			limits: { maxServerFrameBytes: 65 * 1024 * 1024 },
		};
		const server = {
			type: "server_hello",
			protocol: { major: 1, minor: 1 },
			serverBuild: "0.1.0",
			serverEpoch: "epoch-a",
			piVersion: "0.84.2",
			adapterId: "legacy-rpc-v1",
			capabilities: legacyCapabilities,
			limits: {
				maxClientFrameBytes: 8 * 1024 * 1024,
				maxSnapshotFrameBytes: 65 * 1024 * 1024,
				maxExtensionRequests: 256,
			},
		};
		expect(isGatewayClientHello(client)).toBe(true);
		expect(isGatewayServerHello(server)).toBe(true);
		expect(
			isGatewayClientHello({
				...client,
				capabilities: [...client.capabilities, GATEWAY_PAYLOAD_BUDGET_CAPABILITY],
			}),
		).toBe(false);
		expect(
			isGatewayServerHello({
				...server,
				capabilities: [...server.capabilities, GATEWAY_PAYLOAD_BUDGET_CAPABILITY],
				payloadBudget: SESSION_PAYLOAD_BUDGET,
			}),
		).toBe(false);
	});

	it("requires the protocol 1.2 capability and complete budget as one negotiated shape", () => {
		const client = {
			type: "client_hello" as const,
			protocol: { major: 1, minor: 2 },
			clientBuild: "0.1.0",
			capabilities: Array.from(
				new Set([...GATEWAY_SERVER_REQUIRED_CAPABILITIES, GATEWAY_PAYLOAD_BUDGET_CAPABILITY]),
			),
			limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
		};
		const server = {
			type: "server_hello" as const,
			protocol: { major: 1, minor: 2 },
			serverBuild: "0.1.0",
			serverEpoch: "epoch-a",
			piVersion: "0.84.2",
			adapterId: "legacy-rpc-v1",
			capabilities: Array.from(
				new Set([...GATEWAY_SERVER_REQUIRED_CAPABILITIES, GATEWAY_PAYLOAD_BUDGET_CAPABILITY]),
			),
			limits: {
				maxClientFrameBytes: SESSION_PAYLOAD_BUDGET.maxCommandFrameBytes,
				maxSnapshotFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
				maxExtensionRequests: 256,
			},
			payloadBudget: SESSION_PAYLOAD_BUDGET,
		};
		expect(isGatewayClientHello(client)).toBe(true);
		expect(isGatewayServerHello(server)).toBe(true);
		expect(negotiateGatewayPayloadBudget(client, server)).toEqual({
			negotiated: true,
			budget: SESSION_PAYLOAD_BUDGET,
		});
		expect(isGatewayServerHello({ ...server, payloadBudget: undefined })).toBe(false);
		expect(
			isGatewayServerHello({
				...server,
				payloadBudget: { ...SESSION_PAYLOAD_BUDGET, maxContentBlobBytes: 48 * 1024 * 1024 },
			}),
		).toBe(false);
		expect(
			isGatewayServerHello({
				...server,
				capabilities: server.capabilities.filter(
					(capability) => capability !== GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
				),
			}),
		).toBe(false);
	});
});
