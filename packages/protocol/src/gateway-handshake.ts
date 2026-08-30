import {
	isSessionContentRefBudgetDto,
	isSessionPayloadBudgetDto,
	SESSION_CONTENT_REF_BUDGET,
	type SessionContentRefBudgetDto,
	type SessionPayloadBudgetDto,
} from "./payload-budget.js";

export const GATEWAY_PROTOCOL_VERSION = { major: 1, minor: 3 } as const;
export const MAX_GATEWAY_HELLO_CAPABILITIES = 64;
export const MAX_GATEWAY_HELLO_CAPABILITY_LENGTH = 128;
export const MIN_GATEWAY_SERVER_FRAME_BYTES = 1024;
export const GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY = "session.hot_runtime_inventory";
export const GATEWAY_PAYLOAD_BUDGET_CAPABILITY = "payload.epoch_attachment_refs";
export const GATEWAY_CONTENT_REF_CAPABILITY = "payload.epoch_content_refs";

const GATEWAY_BASE_CAPABILITIES = [
	"rpc.commands",
	"rpc.events",
	"rpc.extension_ui",
	"session.multiplex",
] as const;

/** Capabilities the Gateway requires before accepting a Browser connection. */
export const GATEWAY_CLIENT_REQUIRED_CAPABILITIES = [
	...GATEWAY_BASE_CAPABILITIES,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	GATEWAY_CONTENT_REF_CAPABILITY,
] as const;

/** Capabilities the Browser requires from the negotiated Gateway. */
export const GATEWAY_SERVER_REQUIRED_CAPABILITIES = [
	...GATEWAY_BASE_CAPABILITIES,
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	GATEWAY_CONTENT_REF_CAPABILITY,
] as const;

export interface GatewayProtocolVersionDto {
	major: typeof GATEWAY_PROTOCOL_VERSION.major;
	minor: typeof GATEWAY_PROTOCOL_VERSION.minor;
}

export interface GatewayClientHelloDto {
	type: "client_hello";
	protocol: GatewayProtocolVersionDto;
	clientBuild: string;
	capabilities: string[];
	limits: {
		maxServerFrameBytes: number;
	};
}

export interface GatewayServerHelloDto {
	type: "server_hello";
	protocol: GatewayProtocolVersionDto;
	serverBuild: string;
	serverEpoch: string;
	piVersion: string;
	adapterId: string;
	capabilities: string[];
	limits: {
		maxClientFrameBytes: number;
		maxSnapshotFrameBytes: number;
		maxExtensionRequests: number;
	};
	payloadBudget: SessionPayloadBudgetDto;
	contentRefBudget: SessionContentRefBudgetDto;
}

export interface GatewayProtocolErrorDto {
	type: "protocol_error";
	code: "hello_required" | "invalid_hello" | "protocol_major_unsupported" | "capability_unsupported";
	supported: {
		major: number;
		minMinor: number;
		maxMinor: number;
	};
}

export type GatewayNegotiation =
	| {
			negotiated: true;
			payloadBudget: SessionPayloadBudgetDto;
			contentRefBudget: SessionContentRefBudgetDto;
	  }
	| {
			negotiated: false;
			reason:
				| "hello_invalid"
				| "protocol_major_unsupported"
				| "protocol_minor_unsupported"
				| "capability_missing"
				| "gateway_capability_missing"
				| "server_frame_selection_invalid";
	  };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalRecord(value: unknown, allowed: readonly string[]): value is UnknownRecord {
	try {
		if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string" || !allowed.includes(key)) return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isCapabilities(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_GATEWAY_HELLO_CAPABILITIES &&
		value.every((capability) => isBoundedNonEmptyString(capability, MAX_GATEWAY_HELLO_CAPABILITY_LENGTH)) &&
		new Set(value).size === value.length
	);
}

function hasExactProtocol(value: unknown): value is GatewayProtocolVersionDto {
	return (
		isCanonicalRecord(value, ["major", "minor"]) &&
		value.major === GATEWAY_PROTOCOL_VERSION.major &&
		value.minor === GATEWAY_PROTOCOL_VERSION.minor
	);
}

function hasRequiredCapabilities(capabilities: readonly string[], required: readonly string[]): boolean {
	return required.every((capability) => capabilities.includes(capability));
}

function isCanonicalContentRefBudget(value: unknown): value is SessionContentRefBudgetDto {
	return (
		isSessionContentRefBudgetDto(value) &&
		value.maxContentBlobBytes === SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes &&
		value.inlineContentThresholdBytes === SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes
	);
}

function contentFrameRelationship(
	payloadBudget: SessionPayloadBudgetDto,
	contentRefBudget: SessionContentRefBudgetDto,
	maxSnapshotFrameBytes: number,
): boolean {
	const maxContentBlobBytes = contentRefBudget.maxContentBlobBytes;
	return (
		maxContentBlobBytes <= payloadBudget.maxPiSnapshotJsonlFrameBytes &&
		maxContentBlobBytes <= payloadBudget.maxSnapshotCanonicalBytes &&
		maxContentBlobBytes <= payloadBudget.maxServerFrameBytes &&
		maxContentBlobBytes <= payloadBudget.maxAttachmentCacheBytes &&
		payloadBudget.maxSnapshotCanonicalBytes <= maxSnapshotFrameBytes &&
		payloadBudget.maxServerFrameBytes <= maxSnapshotFrameBytes
	);
}

function isGatewayClientHelloShape(value: unknown): value is GatewayClientHelloDto {
	try {
		if (
			!isCanonicalRecord(value, ["type", "protocol", "clientBuild", "capabilities", "limits"]) ||
			value.type !== "client_hello" ||
			!hasExactProtocol(value.protocol) ||
			!isBoundedNonEmptyString(value.clientBuild, 128) ||
			!isCapabilities(value.capabilities) ||
			!isCanonicalRecord(value.limits, ["maxServerFrameBytes"]) ||
			!isSafeNonNegativeInteger(value.limits.maxServerFrameBytes) ||
			value.limits.maxServerFrameBytes < MIN_GATEWAY_SERVER_FRAME_BYTES
		) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

function isGatewayServerHelloShape(value: unknown): value is GatewayServerHelloDto {
	try {
		if (
			!isCanonicalRecord(value, [
				"type",
				"protocol",
				"serverBuild",
				"serverEpoch",
				"piVersion",
				"adapterId",
				"capabilities",
				"limits",
				"payloadBudget",
				"contentRefBudget",
			]) ||
			value.type !== "server_hello" ||
			!hasExactProtocol(value.protocol) ||
			!isBoundedNonEmptyString(value.serverBuild, 128) ||
			!isBoundedNonEmptyString(value.serverEpoch, 128) ||
			!isBoundedNonEmptyString(value.piVersion, 64) ||
			!isBoundedNonEmptyString(value.adapterId, 128) ||
			!isCapabilities(value.capabilities) ||
			!isCanonicalRecord(value.limits, [
				"maxClientFrameBytes",
				"maxSnapshotFrameBytes",
				"maxExtensionRequests",
			]) ||
			!isSafeNonNegativeInteger(value.limits.maxClientFrameBytes) ||
			value.limits.maxClientFrameBytes <= 0 ||
			!isSafeNonNegativeInteger(value.limits.maxSnapshotFrameBytes) ||
			value.limits.maxSnapshotFrameBytes <= 0 ||
			!isSafeNonNegativeInteger(value.limits.maxExtensionRequests) ||
			value.limits.maxExtensionRequests <= 0 ||
			!isSessionPayloadBudgetDto(value.payloadBudget) ||
			!isCanonicalContentRefBudget(value.contentRefBudget)
		) {
			return false;
		}
		return contentFrameRelationship(
			value.payloadBudget,
			value.contentRefBudget,
			value.limits.maxSnapshotFrameBytes,
		);
	} catch {
		return false;
	}
}

/** Guard the only supported Browser hello: protocol 1.3 with content references. */
export function isGatewayClientHello(value: unknown): value is GatewayClientHelloDto {
	return (
		isGatewayClientHelloShape(value) &&
		hasRequiredCapabilities(value.capabilities, GATEWAY_CLIENT_REQUIRED_CAPABILITIES)
	);
}

/** Guard the only supported Gateway hello: protocol 1.3 with both negotiated budgets. */
export function isGatewayServerHello(value: unknown): value is GatewayServerHelloDto {
	return (
		isGatewayServerHelloShape(value) &&
		hasRequiredCapabilities(value.capabilities, GATEWAY_SERVER_REQUIRED_CAPABILITIES)
	);
}

function protocolSelection(value: unknown): { major: number; minor: number } | null {
	try {
		if (!isRecord(value) || !isRecord(value.protocol)) return null;
		const { major, minor } = value.protocol;
		if (!isSafeNonNegativeInteger(major) || !isSafeNonNegativeInteger(minor)) return null;
		return { major, minor };
	} catch {
		return null;
	}
}

export function negotiateGatewayHello(clientHello: unknown, serverHello: unknown): GatewayNegotiation {
	const clientProtocol = protocolSelection(clientHello);
	const serverProtocol = protocolSelection(serverHello);
	if (
		(clientProtocol && clientProtocol.major !== GATEWAY_PROTOCOL_VERSION.major) ||
		(serverProtocol && serverProtocol.major !== GATEWAY_PROTOCOL_VERSION.major)
	) {
		return { negotiated: false, reason: "protocol_major_unsupported" };
	}
	if (
		(clientProtocol && clientProtocol.minor !== GATEWAY_PROTOCOL_VERSION.minor) ||
		(serverProtocol && serverProtocol.minor !== GATEWAY_PROTOCOL_VERSION.minor)
	) {
		return { negotiated: false, reason: "protocol_minor_unsupported" };
	}
	if (!isGatewayClientHelloShape(clientHello) || !isGatewayServerHelloShape(serverHello)) {
		return { negotiated: false, reason: "hello_invalid" };
	}
	if (!hasRequiredCapabilities(clientHello.capabilities, GATEWAY_CLIENT_REQUIRED_CAPABILITIES)) {
		return { negotiated: false, reason: "capability_missing" };
	}
	if (!hasRequiredCapabilities(serverHello.capabilities, GATEWAY_SERVER_REQUIRED_CAPABILITIES)) {
		return { negotiated: false, reason: "gateway_capability_missing" };
	}
	if (
		serverHello.limits.maxSnapshotFrameBytes > clientHello.limits.maxServerFrameBytes ||
		serverHello.payloadBudget.maxServerFrameBytes > clientHello.limits.maxServerFrameBytes ||
		serverHello.payloadBudget.maxCommandFrameBytes > serverHello.limits.maxClientFrameBytes ||
		serverHello.payloadBudget.maxServerFrameBytes > serverHello.limits.maxSnapshotFrameBytes ||
		serverHello.payloadBudget.maxSnapshotCanonicalBytes > serverHello.limits.maxSnapshotFrameBytes ||
		serverHello.contentRefBudget.maxContentBlobBytes > clientHello.limits.maxServerFrameBytes
	) {
		return { negotiated: false, reason: "server_frame_selection_invalid" };
	}
	return {
		negotiated: true,
		payloadBudget: serverHello.payloadBudget,
		contentRefBudget: serverHello.contentRefBudget,
	};
}

/** Parse terminal negotiation errors, including the response sent to a protocol 1.2 client. */
export function isGatewayProtocolError(value: unknown): value is GatewayProtocolErrorDto {
	if (!isCanonicalRecord(value, ["type", "code", "supported"])) return false;
	return (
		value.type === "protocol_error" &&
		["hello_required", "invalid_hello", "protocol_major_unsupported", "capability_unsupported"].includes(
			String(value.code),
		) &&
		isCanonicalRecord(value.supported, ["major", "minMinor", "maxMinor"]) &&
		isSafeNonNegativeInteger(value.supported.major) &&
		isSafeNonNegativeInteger(value.supported.minMinor) &&
		isSafeNonNegativeInteger(value.supported.maxMinor) &&
		value.supported.minMinor <= value.supported.maxMinor
	);
}
