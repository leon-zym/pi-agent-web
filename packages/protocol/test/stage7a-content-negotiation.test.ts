import { describe, expect, it } from "vitest";
import {
	FUTURE_SESSION_CONTENT_REF_BUDGET,
	GATEWAY_CLIENT_REQUIRED_CAPABILITIES,
	GATEWAY_CONTENT_REF_CAPABILITY,
	GATEWAY_CONTENT_REF_PROTOCOL_MINOR,
	GATEWAY_PROTOCOL_VERSION,
	GATEWAY_SERVER_REQUIRED_CAPABILITIES,
	type GatewayContentRefClientHelloDto,
	type GatewayContentRefServerHelloDto,
	isGatewayClientHelloForMinor,
	isGatewayContentRefClientHello,
	isGatewayContentRefServerHello,
	isGatewayServerHelloForMinor,
	negotiateGatewayContentRef,
	SESSION_PAYLOAD_BUDGET,
} from "../src/index.js";

const futureClientCapabilities = [...GATEWAY_CLIENT_REQUIRED_CAPABILITIES];
const futureServerCapabilities = [...GATEWAY_SERVER_REQUIRED_CAPABILITIES];

const futureClientHello = {
	type: "client_hello",
	protocol: { major: GATEWAY_PROTOCOL_VERSION.major, minor: GATEWAY_CONTENT_REF_PROTOCOL_MINOR },
	clientBuild: "0.1.0-private",
	capabilities: futureClientCapabilities,
	limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
} satisfies GatewayContentRefClientHelloDto;

const futureServerHello = {
	type: "server_hello",
	protocol: { major: GATEWAY_PROTOCOL_VERSION.major, minor: GATEWAY_CONTENT_REF_PROTOCOL_MINOR },
	serverBuild: "0.1.0-private",
	serverEpoch: "epoch-private",
	piVersion: "0.84.2",
	adapterId: "legacy-rpc-v1",
	capabilities: futureServerCapabilities,
	limits: {
		maxClientFrameBytes: SESSION_PAYLOAD_BUDGET.maxCommandFrameBytes,
		maxSnapshotFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
		maxExtensionRequests: 256,
	},
	payloadBudget: SESSION_PAYLOAD_BUDGET,
	contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
} satisfies GatewayContentRefServerHelloDto;

function currentClientHello() {
	const capabilities = [
		"rpc.commands",
		"rpc.events",
		"rpc.extension_ui",
		"session.multiplex",
		"session.hot_runtime_inventory",
		"payload.epoch_attachment_refs",
	];
	return {
		type: "client_hello",
		protocol: { major: GATEWAY_PROTOCOL_VERSION.major, minor: 2 },
		clientBuild: "0.1.0",
		capabilities,
		limits: { maxServerFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes },
	};
}

function currentServerHello() {
	const capabilities = [
		"rpc.commands",
		"rpc.events",
		"rpc.extension_ui",
		"session.multiplex",
		"session.hot_runtime_inventory",
		"payload.epoch_attachment_refs",
	];
	return {
		type: "server_hello",
		protocol: { major: GATEWAY_PROTOCOL_VERSION.major, minor: 2 },
		serverBuild: "0.1.0",
		serverEpoch: "epoch-current",
		piVersion: "0.84.2",
		adapterId: "legacy-rpc-v1",
		capabilities,
		limits: {
			maxClientFrameBytes: SESSION_PAYLOAD_BUDGET.maxCommandFrameBytes,
			maxSnapshotFrameBytes: SESSION_PAYLOAD_BUDGET.maxServerFrameBytes,
			maxExtensionRequests: 256,
		},
		payloadBudget: SESSION_PAYLOAD_BUDGET,
	};
}

describe("Stage7A private protocol 1.3 content negotiation", () => {
	it("keeps the explicit 1.2 compatibility target separate from active 1.3", () => {
		expect(GATEWAY_PROTOCOL_VERSION).toEqual({ major: 1, minor: 3 });
		expect(GATEWAY_CLIENT_REQUIRED_CAPABILITIES).toContain(GATEWAY_CONTENT_REF_CAPABILITY);
		expect(GATEWAY_SERVER_REQUIRED_CAPABILITIES).toContain(GATEWAY_CONTENT_REF_CAPABILITY);
		expect(isGatewayContentRefClientHello(futureClientHello)).toBe(true);
		expect(isGatewayContentRefServerHello(futureServerHello)).toBe(true);
		expect(isGatewayClientHelloForMinor(currentClientHello(), 2)).toBe(true);
		expect(isGatewayServerHelloForMinor(currentServerHello(), 2)).toBe(true);

		expect(negotiateGatewayContentRef(futureClientHello, futureServerHello)).toEqual({
			negotiated: true,
			payloadBudget: SESSION_PAYLOAD_BUDGET,
			contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
		});
	});

	it("requires the future capability in both directions and the exact canonical server budget", () => {
		expect(
			isGatewayContentRefClientHello({
				...futureClientHello,
				capabilities: futureClientHello.capabilities.filter(
					(capability) => capability !== GATEWAY_CONTENT_REF_CAPABILITY,
				),
			}),
		).toBe(false);
		expect(
			isGatewayContentRefServerHello({
				...futureServerHello,
				capabilities: futureServerHello.capabilities.filter(
					(capability) => capability !== GATEWAY_CONTENT_REF_CAPABILITY,
				),
			}),
		).toBe(false);
		for (const capability of futureServerCapabilities) {
			if (capability === GATEWAY_CONTENT_REF_CAPABILITY) continue;
			expect(
				isGatewayContentRefServerHello({
					...futureServerHello,
					capabilities: futureServerHello.capabilities.filter((candidate) => candidate !== capability),
				}),
			).toBe(false);
		}
		expect(
			isGatewayContentRefServerHello({
				...futureServerHello,
				contentRefBudget: {
					maxContentBlobBytes: FUTURE_SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes - 1,
					inlineContentThresholdBytes: FUTURE_SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes,
				},
			}),
		).toBe(false);
		expect(
			isGatewayContentRefServerHello({
				...futureServerHello,
				contentRefBudget: {
					maxContentBlobBytes: FUTURE_SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes,
				},
			}),
		).toBe(false);
		expect(
			isGatewayContentRefServerHello({
				...futureServerHello,
				contentRefBudget: { ...FUTURE_SESSION_CONTENT_REF_BUDGET, unexpected: true },
			}),
		).toBe(false);
		expect(isGatewayContentRefClientHello({ ...futureClientHello, unexpected: true })).toBe(false);
		expect(isGatewayContentRefServerHello({ ...futureServerHello, unexpected: true })).toBe(false);
	});

	it("rejects payload/content budgets that cannot carry the future frame vertical", () => {
		expect(
			isGatewayContentRefServerHello({
				...futureServerHello,
				payloadBudget: {
					...SESSION_PAYLOAD_BUDGET,
					maxPiSnapshotJsonlFrameBytes: FUTURE_SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes - 1,
					maxSnapshotCanonicalBytes: FUTURE_SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes - 1,
				},
			}),
		).toBe(false);
		expect(
			isGatewayContentRefServerHello({
				...futureServerHello,
				payloadBudget: { ...SESSION_PAYLOAD_BUDGET, unexpected: true },
			}),
		).toBe(false);
		const { maxCommandTextBytes: _omittedCommandTextBytes, ...incompletePayloadBudget } =
			SESSION_PAYLOAD_BUDGET;
		expect(
			isGatewayContentRefServerHello({ ...futureServerHello, payloadBudget: incompletePayloadBudget }),
		).toBe(false);
		expect(
			isGatewayContentRefServerHello({
				...futureServerHello,
				payloadBudget: {
					...SESSION_PAYLOAD_BUDGET,
					maxAttachmentCacheBytes: FUTURE_SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes - 1,
				},
			}),
		).toBe(false);
		expect(
			isGatewayContentRefServerHello({
				...futureServerHello,
				limits: {
					...futureServerHello.limits,
					maxSnapshotFrameBytes: FUTURE_SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes - 1,
				},
			}),
		).toBe(false);
		expect(
			negotiateGatewayContentRef(
				{
					...futureClientHello,
					limits: {
						maxServerFrameBytes: FUTURE_SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes - 1,
					},
				},
				futureServerHello,
			),
		).toMatchObject({ negotiated: false });
	});

	it("rejects future capability, budget, and extra fields on minor 1/2 paths", () => {
		const client = currentClientHello();
		const server = currentServerHello();
		const clientWithFutureCapability = {
			...client,
			capabilities: [...client.capabilities, GATEWAY_CONTENT_REF_CAPABILITY],
		};
		const serverWithFutureCapability = {
			...server,
			capabilities: [...server.capabilities, GATEWAY_CONTENT_REF_CAPABILITY],
		};
		expect(isGatewayClientHelloForMinor(clientWithFutureCapability, 2)).toBe(false);
		expect(isGatewayServerHelloForMinor(serverWithFutureCapability, 2)).toBe(false);
		expect(
			isGatewayServerHelloForMinor({ ...server, contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET }, 2),
		).toBe(false);
		expect(
			isGatewayClientHelloForMinor({ ...client, futureBudget: FUTURE_SESSION_CONTENT_REF_BUDGET }, 2),
		).toBe(false);
		expect(negotiateGatewayContentRef(clientWithFutureCapability, server)).toMatchObject({
			negotiated: false,
		});
		expect(
			negotiateGatewayContentRef(futureClientHello, {
				...server,
				protocol: { major: GATEWAY_PROTOCOL_VERSION.major, minor: 2 },
			}),
		).toMatchObject({ negotiated: false });
	});

	it.each([
		{ label: "null", value: null },
		{ label: "array", value: [] },
		{ label: "string", value: "server hello" },
		{ label: "incomplete budget", value: { maxContentBlobBytes: 1 } },
	])("rejects malformed future server hello input: $label", ({ value }) => {
		expect(isGatewayContentRefServerHello(value)).toBe(false);
	});
});
