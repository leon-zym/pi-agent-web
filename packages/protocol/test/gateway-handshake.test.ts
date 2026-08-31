import { describe, expect, it } from "vitest";
import {
	GATEWAY_CLIENT_REQUIRED_CAPABILITIES,
	GATEWAY_CONTENT_REF_CAPABILITY,
	GATEWAY_FENCED_TAKEOVER_CAPABILITY,
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	type GatewayClientHelloDto,
	type GatewayServerHelloDto,
	hasUnsupportedGatewayProtocolMajor,
	isGatewayClientHello,
	isGatewayProtocolError,
	isGatewayServerHello,
	negotiateGatewayHello,
	SESSION_CONTENT_REF_BUDGET,
	SESSION_PAYLOAD_BUDGET,
} from "../src/index.js";

function clientHello(): GatewayClientHelloDto {
	return {
		type: "client_hello",
		protocol: GATEWAY_PROTOCOL_VERSION,
		clientBuild: "0.1.0",
		capabilities: [...GATEWAY_CLIENT_REQUIRED_CAPABILITIES],
		limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
	};
}

function serverHello(): GatewayServerHelloDto {
	return {
		type: "server_hello",
		protocol: GATEWAY_PROTOCOL_VERSION,
		serverBuild: "0.1.0",
		serverEpoch: "epoch-a",
		piVersion: "0.84.2",
		adapterId: "pi-rpc",
		capabilities: [...GATEWAY_SERVER_REQUIRED_CAPABILITIES],
		limits: {
			maxClientFrameBytes: SESSION_PAYLOAD_BUDGET.maxCommandFrameBytes,
			maxSnapshotFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
			maxExtensionRequests: 256,
		},
		payloadBudget: SESSION_PAYLOAD_BUDGET,
		contentRefBudget: SESSION_CONTENT_REF_BUDGET,
	};
}

describe("Gateway hello DTOs", () => {
	it("publishes one exact protocol and directional capability contract", () => {
		expect(GATEWAY_PROTOCOL_VERSION).toEqual({ major: 1, minor: 4 });
		expect(GATEWAY_CLIENT_REQUIRED_CAPABILITIES).not.toContain(GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY);
		expect(GATEWAY_SERVER_REQUIRED_CAPABILITIES).toContain(GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY);
		for (const capability of [
			GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
			GATEWAY_CONTENT_REF_CAPABILITY,
			GATEWAY_FENCED_TAKEOVER_CAPABILITY,
		]) {
			expect(GATEWAY_CLIENT_REQUIRED_CAPABILITIES).toContain(capability);
			expect(GATEWAY_SERVER_REQUIRED_CAPABILITIES).toContain(capability);
		}
	});

	it("accepts only canonical protocol 1.4 hello shapes", () => {
		expect(isGatewayClientHello(clientHello())).toBe(true);
		expect(isGatewayServerHello(serverHello())).toBe(true);
		expect(isGatewayClientHello({ ...clientHello(), protocol: { major: 1, minor: 3 } })).toBe(false);
		expect(isGatewayServerHello({ ...serverHello(), protocol: { major: 1, minor: 3 } })).toBe(false);
		expect(isGatewayClientHello({ ...clientHello(), protocol: { major: 1, minor: 2 } })).toBe(false);
		expect(isGatewayServerHello({ ...serverHello(), protocol: { major: 1, minor: 2 } })).toBe(false);
		expect(hasUnsupportedGatewayProtocolMajor({ ...clientHello(), protocol: { major: 99, minor: 4 } })).toBe(
			true,
		);
		expect(hasUnsupportedGatewayProtocolMajor({ ...clientHello(), protocol: { major: 1, minor: 2 } })).toBe(
			false,
		);
	});

	it("rejects missing capabilities, budgets, duplicate values, and extra properties", () => {
		const client = clientHello();
		const server = serverHello();
		expect(
			isGatewayClientHello({
				...client,
				capabilities: client.capabilities.filter(
					(capability) => capability !== GATEWAY_CONTENT_REF_CAPABILITY,
				),
			}),
		).toBe(false);
		expect(
			isGatewayServerHello({
				...server,
				capabilities: server.capabilities.filter(
					(capability) => capability !== GATEWAY_FENCED_TAKEOVER_CAPABILITY,
				),
			}),
		).toBe(false);
		expect(isGatewayClientHello({ ...client, capabilities: ["same", "same"] })).toBe(false);
		expect(isGatewayClientHello({ ...client, unexpected: true })).toBe(false);
		expect(
			isGatewayServerHello({
				...server,
				contentRefBudget: {
					...SESSION_CONTENT_REF_BUDGET,
					maxContentBlobBytes: SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes - 1,
				},
			}),
		).toBe(false);
		const { contentRefBudget: _, ...withoutContentBudget } = server;
		expect(isGatewayServerHello(withoutContentBudget)).toBe(false);
		expect(isGatewayServerHello({ ...server, unexpected: true })).toBe(false);
	});

	it("rejects accessors without invoking them", () => {
		let reads = 0;
		const value = { ...serverHello() } as Record<string, unknown>;
		Object.defineProperty(value, "payloadBudget", {
			enumerable: true,
			get() {
				reads += 1;
				return SESSION_PAYLOAD_BUDGET;
			},
		});
		expect(isGatewayServerHello(value)).toBe(false);
		expect(reads).toBe(0);
	});

	it("negotiates both budgets and enforces the selected frame relationship", () => {
		expect(negotiateGatewayHello(clientHello(), serverHello())).toEqual({
			negotiated: true,
			payloadBudget: SESSION_PAYLOAD_BUDGET,
			contentRefBudget: SESSION_CONTENT_REF_BUDGET,
		});
		expect(
			negotiateGatewayHello({ ...clientHello(), limits: { maxServerFrameBytes: 1024 } }, serverHello()),
		).toEqual({ negotiated: false, reason: "server_frame_selection_invalid" });
		expect(
			negotiateGatewayHello({ ...clientHello(), protocol: { major: 1, minor: 3 } }, serverHello()),
		).toEqual({ negotiated: false, reason: "protocol_minor_unsupported" });
		expect(
			negotiateGatewayHello({ ...clientHello(), protocol: { major: 1, minor: 2 } }, serverHello()),
		).toEqual({ negotiated: false, reason: "protocol_minor_unsupported" });
	});

	it("parses the terminal error returned to a protocol 1.3 Browser", () => {
		expect(
			isGatewayProtocolError({
				type: "protocol_error",
				code: "invalid_hello",
				supported: { major: 1, minMinor: 4, maxMinor: 4 },
			}),
		).toBe(true);
	});
});
