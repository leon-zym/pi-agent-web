export const GATEWAY_PROTOCOL_VERSION = { major: 1, minor: 1 } as const;
export const MAX_GATEWAY_HELLO_CAPABILITIES = 64;
export const MAX_GATEWAY_HELLO_CAPABILITY_LENGTH = 128;
export const MIN_GATEWAY_SERVER_FRAME_BYTES = 1024;
export const GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY = "session.hot_runtime_inventory";
const GATEWAY_BASE_CAPABILITIES = [
	"rpc.commands",
	"rpc.events",
	"rpc.extension_ui",
	"session.multiplex",
] as const;
/** Capabilities a Gateway requires before accepting a client connection. */
export const GATEWAY_CLIENT_REQUIRED_CAPABILITIES = [...GATEWAY_BASE_CAPABILITIES] as const;
/** Capabilities the current Browser requires the negotiated Gateway to provide. */
export const GATEWAY_SERVER_REQUIRED_CAPABILITIES = [
	...GATEWAY_BASE_CAPABILITIES,
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
] as const;
/** @deprecated Use the directional required-capability sets. */
export const GATEWAY_REQUIRED_CAPABILITIES = GATEWAY_CLIENT_REQUIRED_CAPABILITIES;

export interface GatewayProtocolVersionDto {
	major: number;
	minor: number;
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

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isProtocolVersion(value: unknown): value is GatewayProtocolVersionDto {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["major", "minor"]) &&
		isSafeNonNegativeInteger(value.major) &&
		isSafeNonNegativeInteger(value.minor)
	);
}

function isCapabilities(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_GATEWAY_HELLO_CAPABILITIES &&
		value.every((capability) => isBoundedNonEmptyString(capability, MAX_GATEWAY_HELLO_CAPABILITY_LENGTH)) &&
		new Set(value).size === value.length
	);
}

export function isGatewayClientHello(value: unknown): value is GatewayClientHelloDto {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["type", "protocol", "clientBuild", "capabilities", "limits"])
	) {
		return false;
	}
	return (
		value.type === "client_hello" &&
		isProtocolVersion(value.protocol) &&
		isBoundedNonEmptyString(value.clientBuild, 128) &&
		isCapabilities(value.capabilities) &&
		isRecord(value.limits) &&
		hasOnlyKeys(value.limits, ["maxServerFrameBytes"]) &&
		isSafeNonNegativeInteger(value.limits.maxServerFrameBytes) &&
		value.limits.maxServerFrameBytes >= MIN_GATEWAY_SERVER_FRAME_BYTES
	);
}

export function isGatewayServerHello(value: unknown): value is GatewayServerHelloDto {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"type",
			"protocol",
			"serverBuild",
			"serverEpoch",
			"piVersion",
			"adapterId",
			"capabilities",
			"limits",
		])
	) {
		return false;
	}
	if (
		value.type !== "server_hello" ||
		!isProtocolVersion(value.protocol) ||
		!isBoundedNonEmptyString(value.serverBuild, 128) ||
		!isBoundedNonEmptyString(value.serverEpoch, 128) ||
		!isBoundedNonEmptyString(value.piVersion, 64) ||
		!isBoundedNonEmptyString(value.adapterId, 128) ||
		!isCapabilities(value.capabilities) ||
		!isRecord(value.limits) ||
		!hasOnlyKeys(value.limits, ["maxClientFrameBytes", "maxSnapshotFrameBytes", "maxExtensionRequests"])
	) {
		return false;
	}
	return (
		isSafeNonNegativeInteger(value.limits.maxClientFrameBytes) &&
		value.limits.maxClientFrameBytes > 0 &&
		isSafeNonNegativeInteger(value.limits.maxSnapshotFrameBytes) &&
		value.limits.maxSnapshotFrameBytes > 0 &&
		isSafeNonNegativeInteger(value.limits.maxExtensionRequests) &&
		value.limits.maxExtensionRequests > 0
	);
}

export function isGatewayProtocolError(value: unknown): value is GatewayProtocolErrorDto {
	if (!isRecord(value) || !hasOnlyKeys(value, ["type", "code", "supported"])) return false;
	return (
		value.type === "protocol_error" &&
		["hello_required", "invalid_hello", "protocol_major_unsupported", "capability_unsupported"].includes(
			String(value.code),
		) &&
		isRecord(value.supported) &&
		hasOnlyKeys(value.supported, ["major", "minMinor", "maxMinor"]) &&
		isSafeNonNegativeInteger(value.supported.major) &&
		isSafeNonNegativeInteger(value.supported.minMinor) &&
		isSafeNonNegativeInteger(value.supported.maxMinor) &&
		value.supported.minMinor <= value.supported.maxMinor
	);
}
