import {
	FUTURE_SESSION_CONTENT_REF_BUDGET,
	isSessionContentRefBudgetDto,
	isSessionPayloadBudgetDto,
	type SessionContentRefBudgetDto,
	type SessionPayloadBudgetDto,
} from "./payload-budget.js";

export type { SessionPayloadBudgetDto } from "./payload-budget.js";
export { SESSION_PAYLOAD_BUDGET } from "./payload-budget.js";

export const GATEWAY_PROTOCOL_VERSION = { major: 1, minor: 3 } as const;
export const MAX_GATEWAY_HELLO_CAPABILITIES = 64;
export const MAX_GATEWAY_HELLO_CAPABILITY_LENGTH = 128;
export const MIN_GATEWAY_SERVER_FRAME_BYTES = 1024;
export const GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY = "session.hot_runtime_inventory";
export const GATEWAY_PAYLOAD_BUDGET_CAPABILITY = "payload.epoch_attachment_refs";
export const GATEWAY_PAYLOAD_BUDGET_PROTOCOL_MINOR = 2;
/** Protocol 1.3 generic UTF-8 content-reference capability. */
export const GATEWAY_CONTENT_REF_CAPABILITY = "payload.epoch_content_refs";
export const GATEWAY_CONTENT_REF_PROTOCOL_MINOR = 3;
const GATEWAY_BASE_CAPABILITIES = [
	"rpc.commands",
	"rpc.events",
	"rpc.extension_ui",
	"session.multiplex",
] as const;
/** Capabilities a Gateway requires before accepting a client connection. */
export const GATEWAY_CLIENT_REQUIRED_CAPABILITIES = [
	...GATEWAY_BASE_CAPABILITIES,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	GATEWAY_CONTENT_REF_CAPABILITY,
] as const;
/** Capabilities the production Browser requires the negotiated Gateway to provide. */
export const GATEWAY_SERVER_REQUIRED_CAPABILITIES = [
	...GATEWAY_BASE_CAPABILITIES,
	GATEWAY_HOT_RUNTIME_INVENTORY_CAPABILITY,
	GATEWAY_PAYLOAD_BUDGET_CAPABILITY,
	GATEWAY_CONTENT_REF_CAPABILITY,
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
	payloadBudget?: SessionPayloadBudgetDto;
}

/** Protocol 1.3 client hello with the complete typed-content capability contract. */
export interface GatewayContentRefClientHelloDto extends Omit<GatewayClientHelloDto, "protocol"> {
	protocol: {
		major: typeof GATEWAY_PROTOCOL_VERSION.major;
		minor: typeof GATEWAY_CONTENT_REF_PROTOCOL_MINOR;
	};
}

/** Protocol 1.3 server hello with the complete generic-content budget. */
export interface GatewayContentRefServerHelloDto
	extends Omit<GatewayServerHelloDto, "protocol" | "payloadBudget"> {
	protocol: {
		major: typeof GATEWAY_PROTOCOL_VERSION.major;
		minor: typeof GATEWAY_CONTENT_REF_PROTOCOL_MINOR;
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

const GATEWAY_CLIENT_HELLO_KEYS = ["type", "protocol", "clientBuild", "capabilities", "limits"];
const GATEWAY_SERVER_HELLO_KEYS = [
	"type",
	"protocol",
	"serverBuild",
	"serverEpoch",
	"piVersion",
	"adapterId",
	"capabilities",
	"limits",
	"payloadBudget",
];
const GATEWAY_FUTURE_SERVER_HELLO_KEYS = [...GATEWAY_SERVER_HELLO_KEYS, "contentRefBudget"];

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

function isCanonicalCurrentClientHello(value: unknown): value is GatewayClientHelloDto {
	try {
		if (
			!isCanonicalRecord(value, GATEWAY_CLIENT_HELLO_KEYS) ||
			!isCanonicalRecord(value.protocol, ["major", "minor"]) ||
			!isCanonicalRecord(value.limits, ["maxServerFrameBytes"])
		) {
			return false;
		}
		return isGatewayClientHello(value);
	} catch {
		return false;
	}
}

function isCanonicalCurrentServerHello(value: unknown): value is GatewayServerHelloDto {
	try {
		if (
			!isCanonicalRecord(value, GATEWAY_SERVER_HELLO_KEYS) ||
			!isCanonicalRecord(value.protocol, ["major", "minor"]) ||
			!isCanonicalRecord(value.limits, [
				"maxClientFrameBytes",
				"maxSnapshotFrameBytes",
				"maxExtensionRequests",
			])
		) {
			return false;
		}
		return isGatewayServerHello(value);
	} catch {
		return false;
	}
}

function isCanonicalFutureContentRefBudget(value: unknown): value is SessionContentRefBudgetDto {
	return (
		isSessionContentRefBudgetDto(value) &&
		value.maxContentBlobBytes === FUTURE_SESSION_CONTENT_REF_BUDGET.maxContentBlobBytes &&
		value.inlineContentThresholdBytes === FUTURE_SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes
	);
}

function futureContentFrameRelationship(
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

function isGatewayContentRefClientHelloCore(value: unknown): value is GatewayContentRefClientHelloDto {
	try {
		return (
			isCanonicalCurrentClientHello(value) &&
			value.protocol.major === GATEWAY_PROTOCOL_VERSION.major &&
			value.protocol.minor === GATEWAY_CONTENT_REF_PROTOCOL_MINOR &&
			GATEWAY_CLIENT_REQUIRED_CAPABILITIES.every((capability) => value.capabilities.includes(capability))
		);
	} catch {
		return false;
	}
}

function isGatewayContentRefServerHelloCore(value: unknown): value is GatewayContentRefServerHelloDto {
	try {
		if (
			!isCanonicalRecord(value, GATEWAY_FUTURE_SERVER_HELLO_KEYS)
		) {
			return false;
		}
		const protocol = value.protocol;
		const limits = value.limits;
		const capabilities = value.capabilities;
		const payloadBudget = value.payloadBudget;
		const contentRefBudget = value.contentRefBudget;
		if (
			!Object.hasOwn(value, "payloadBudget") ||
			!Object.hasOwn(value, "contentRefBudget") ||
			value.type !== "server_hello" ||
			!isCanonicalRecord(protocol, ["major", "minor"]) ||
			!isProtocolVersion(protocol) ||
			protocol.major !== GATEWAY_PROTOCOL_VERSION.major ||
			protocol.minor !== GATEWAY_CONTENT_REF_PROTOCOL_MINOR ||
			!isBoundedNonEmptyString(value.serverBuild, 128) ||
			!isBoundedNonEmptyString(value.serverEpoch, 128) ||
			!isBoundedNonEmptyString(value.piVersion, 64) ||
			!isBoundedNonEmptyString(value.adapterId, 128) ||
			!isCapabilities(capabilities) ||
			!isCanonicalRecord(limits, ["maxClientFrameBytes", "maxSnapshotFrameBytes", "maxExtensionRequests"]) ||
			!isSafeNonNegativeInteger(limits.maxClientFrameBytes) ||
			limits.maxClientFrameBytes <= 0 ||
			!isSafeNonNegativeInteger(limits.maxSnapshotFrameBytes) ||
			limits.maxSnapshotFrameBytes <= 0 ||
			!isSafeNonNegativeInteger(limits.maxExtensionRequests) ||
			limits.maxExtensionRequests <= 0 ||
			!GATEWAY_SERVER_REQUIRED_CAPABILITIES.every((capability) => capabilities.includes(capability)) ||
			!isSessionPayloadBudgetDto(payloadBudget) ||
			!isCanonicalFutureContentRefBudget(contentRefBudget)
		) {
			return false;
		}
		return futureContentFrameRelationship(payloadBudget, contentRefBudget, limits.maxSnapshotFrameBytes);
	} catch {
		return false;
	}
}

/** Guard a hello against one explicit target minor without changing the production guards. */
export function isGatewayClientHelloForMinor(
	value: unknown,
	targetMinor: number,
): value is GatewayClientHelloDto {
	if (targetMinor === GATEWAY_CONTENT_REF_PROTOCOL_MINOR) return isGatewayContentRefClientHelloCore(value);
	if (targetMinor !== 1 && targetMinor !== 2) return false;
	return (
		isCanonicalCurrentClientHello(value) &&
		value.protocol.minor === targetMinor &&
		!value.capabilities.includes(GATEWAY_CONTENT_REF_CAPABILITY)
	);
}

/** Guard a server hello against one explicit target minor without changing the production guards. */
export function isGatewayServerHelloForMinor(
	value: unknown,
	targetMinor: number,
): value is GatewayServerHelloDto {
	if (targetMinor === GATEWAY_CONTENT_REF_PROTOCOL_MINOR) return isGatewayContentRefServerHelloCore(value);
	if (targetMinor !== 1 && targetMinor !== 2) return false;
	return (
		isCanonicalCurrentServerHello(value) &&
		value.protocol.minor === targetMinor &&
		!value.capabilities.includes(GATEWAY_CONTENT_REF_CAPABILITY)
	);
}

/** Guard the private protocol 1.3 hello shapes; this never changes advertised production version data. */
export function isGatewayContentRefClientHello(value: unknown): value is GatewayContentRefClientHelloDto {
	return isGatewayContentRefClientHelloCore(value);
}

export function isGatewayContentRefServerHello(value: unknown): value is GatewayContentRefServerHelloDto {
	return isGatewayContentRefServerHelloCore(value);
}

export type GatewayContentRefNegotiation =
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
				| "protocol_selection_invalid"
				| "capability_missing"
				| "gateway_capability_missing"
				| "server_frame_selection_invalid";
	  };

function hasProtocolMinor(value: unknown, minor: number): boolean {
	try {
		return isRecord(value) && isRecord(value.protocol) && value.protocol.minor === minor;
	} catch {
		return false;
	}
}

/**
 * Negotiate the private content-reference vertical at exactly protocol minor 3.
 * It intentionally does not participate in the production 1.2 negotiation.
 */
export function negotiateGatewayContentRef(
	clientHello: unknown,
	serverHello: unknown,
): GatewayContentRefNegotiation {
	if (
		(hasProtocolMinor(clientHello, 2) && hasProtocolMinor(serverHello, GATEWAY_CONTENT_REF_PROTOCOL_MINOR)) ||
		(hasProtocolMinor(clientHello, GATEWAY_CONTENT_REF_PROTOCOL_MINOR) && hasProtocolMinor(serverHello, 2))
	) {
		return { negotiated: false, reason: "protocol_minor_unsupported" };
	}
	if (!isGatewayContentRefClientHello(clientHello) || !isGatewayContentRefServerHello(serverHello)) {
		return { negotiated: false, reason: "hello_invalid" };
	}
	if (
		clientHello.protocol.major !== GATEWAY_PROTOCOL_VERSION.major ||
		serverHello.protocol.major !== GATEWAY_PROTOCOL_VERSION.major
	) {
		return { negotiated: false, reason: "protocol_major_unsupported" };
	}
	if (
		clientHello.protocol.minor !== GATEWAY_CONTENT_REF_PROTOCOL_MINOR ||
		serverHello.protocol.minor !== GATEWAY_CONTENT_REF_PROTOCOL_MINOR
	) {
		return { negotiated: false, reason: "protocol_selection_invalid" };
	}
	if (!clientHello.capabilities.includes(GATEWAY_PAYLOAD_BUDGET_CAPABILITY)) {
		return { negotiated: false, reason: "capability_missing" };
	}
	if (!serverHello.capabilities.includes(GATEWAY_PAYLOAD_BUDGET_CAPABILITY)) {
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

export function isGatewayClientHello(value: unknown): value is GatewayClientHelloDto {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["type", "protocol", "clientBuild", "capabilities", "limits"])
	) {
		return false;
	}
	if (
		value.type !== "client_hello" ||
		!isProtocolVersion(value.protocol) ||
		!isBoundedNonEmptyString(value.clientBuild, 128) ||
		!isCapabilities(value.capabilities) ||
		!isRecord(value.limits) ||
		!hasOnlyKeys(value.limits, ["maxServerFrameBytes"]) ||
		!isSafeNonNegativeInteger(value.limits.maxServerFrameBytes) ||
		value.limits.maxServerFrameBytes < MIN_GATEWAY_SERVER_FRAME_BYTES
	) {
		return false;
	}
	return !(
		value.protocol.minor < GATEWAY_PAYLOAD_BUDGET_PROTOCOL_MINOR &&
		value.capabilities.includes(GATEWAY_PAYLOAD_BUDGET_CAPABILITY)
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
			"payloadBudget",
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
	const validLimits =
		isSafeNonNegativeInteger(value.limits.maxClientFrameBytes) &&
		value.limits.maxClientFrameBytes > 0 &&
		isSafeNonNegativeInteger(value.limits.maxSnapshotFrameBytes) &&
		value.limits.maxSnapshotFrameBytes > 0 &&
		isSafeNonNegativeInteger(value.limits.maxExtensionRequests) &&
		value.limits.maxExtensionRequests > 0;
	if (!validLimits) return false;
	const hasCapability = value.capabilities.includes(GATEWAY_PAYLOAD_BUDGET_CAPABILITY);
	const hasBudget = Object.hasOwn(value, "payloadBudget");
	if (value.protocol.minor < GATEWAY_PAYLOAD_BUDGET_PROTOCOL_MINOR) return !hasCapability && !hasBudget;
	return hasCapability && hasBudget && isSessionPayloadBudgetDto(value.payloadBudget);
}

export type GatewayPayloadBudgetNegotiation =
	| { negotiated: true; budget: SessionPayloadBudgetDto }
	| {
			negotiated: false;
			reason:
				| "hello_invalid"
				| "protocol_major_unsupported"
				| "protocol_minor_unsupported"
				| "protocol_selection_invalid"
				| "capability_missing"
				| "gateway_capability_missing"
				| "server_frame_selection_invalid";
	  };

export function negotiateGatewayPayloadBudget(
	clientHello: GatewayClientHelloDto,
	serverHello: GatewayServerHelloDto,
): GatewayPayloadBudgetNegotiation {
	if (!isGatewayClientHello(clientHello) || !isGatewayServerHello(serverHello)) {
		return { negotiated: false, reason: "hello_invalid" };
	}
	if (
		clientHello.protocol.major !== GATEWAY_PROTOCOL_VERSION.major ||
		serverHello.protocol.major !== GATEWAY_PROTOCOL_VERSION.major
	) {
		return { negotiated: false, reason: "protocol_major_unsupported" };
	}
	if (
		clientHello.protocol.minor < GATEWAY_PAYLOAD_BUDGET_PROTOCOL_MINOR ||
		serverHello.protocol.minor < GATEWAY_PAYLOAD_BUDGET_PROTOCOL_MINOR
	) {
		return { negotiated: false, reason: "protocol_minor_unsupported" };
	}
	if (
		serverHello.protocol.minor !== Math.min(clientHello.protocol.minor, GATEWAY_PAYLOAD_BUDGET_PROTOCOL_MINOR)
	) {
		return { negotiated: false, reason: "protocol_selection_invalid" };
	}
	if (!clientHello.capabilities.includes(GATEWAY_PAYLOAD_BUDGET_CAPABILITY)) {
		return { negotiated: false, reason: "capability_missing" };
	}
	if (!serverHello.capabilities.includes(GATEWAY_PAYLOAD_BUDGET_CAPABILITY) || !serverHello.payloadBudget) {
		return { negotiated: false, reason: "gateway_capability_missing" };
	}
	if (
		serverHello.limits.maxSnapshotFrameBytes > clientHello.limits.maxServerFrameBytes ||
		serverHello.payloadBudget.maxServerFrameBytes > clientHello.limits.maxServerFrameBytes ||
		serverHello.payloadBudget.maxCommandFrameBytes > serverHello.limits.maxClientFrameBytes ||
		serverHello.payloadBudget.maxServerFrameBytes > serverHello.limits.maxSnapshotFrameBytes
	) {
		return { negotiated: false, reason: "server_frame_selection_invalid" };
	}
	return { negotiated: true, budget: serverHello.payloadBudget };
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
