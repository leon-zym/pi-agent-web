import { timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "pi_web_session";

interface HeaderBag {
	get(name: string): string | null;
}

type HeadersInput = HeaderBag | Record<string, string | string[] | undefined>;

export interface GatewayAccessControl {
	isAllowedOrigin: (headers: HeadersInput) => boolean;
	isAuthorized: (headers: HeadersInput) => boolean;
	createSessionCookie: () => string;
}

export type GatewayAccessDenial =
	| "invalid_target"
	| "invalid_origin"
	| "cross_origin"
	| "missing_same_origin_metadata"
	| "invalid_session_cookie";

export interface GatewayAccessControlOptions {
	onDenied?: (reason: GatewayAccessDenial) => void;
}

export interface GatewayAccessDenialReport {
	reason: GatewayAccessDenial;
	suppressed: number;
}

export function createGatewayAccessDenialReporter(
	report: (entry: GatewayAccessDenialReport) => void,
	options: { intervalMs?: number; now?: () => number } = {},
): (reason: GatewayAccessDenial) => void {
	const intervalMs = options.intervalMs ?? 1_000;
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new Error("Gateway access denial report interval must be positive");
	}
	const now = options.now ?? (() => performance.now());
	let lastReportAt = Number.NEGATIVE_INFINITY;
	let suppressed = 0;
	return (reason) => {
		const current = now();
		if (current - lastReportAt < intervalMs) {
			suppressed += 1;
			return;
		}
		report({ reason, suppressed });
		lastReportAt = current;
		suppressed = 0;
	};
}

function headerValue(headers: HeadersInput, name: string): string | undefined {
	if (isHeaderBag(headers)) return headers.get(name) ?? undefined;
	const value = headers[name.toLowerCase()];
	return Array.isArray(value) ? value[0] : value;
}

function isHeaderBag(headers: HeadersInput): headers is HeaderBag {
	return typeof (headers as Partial<HeaderBag>).get === "function";
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function normalizedOrigin(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname) || parsed.origin !== value)
			return undefined;
		return parsed.origin;
	} catch {
		return undefined;
	}
}

function requestOrigin(headers: HeadersInput): string | undefined {
	const host = headerValue(headers, "host");
	if (!host) return undefined;
	try {
		const parsed = new URL(`http://${host}`);
		if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
			return undefined;
		}
		return isLoopbackHost(parsed.hostname) ? parsed.origin : undefined;
	} catch {
		return undefined;
	}
}

function readCookie(headers: HeadersInput, name: string): string | undefined {
	const raw = headerValue(headers, "cookie");
	if (!raw) return undefined;
	for (const entry of raw.split(";")) {
		const [key, ...parts] = entry.trim().split("=");
		if (key === name) return parts.join("=");
	}
	return undefined;
}

function matchesSecret(actual: string | undefined, expected: string): boolean {
	if (!actual || actual.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

/**
 * Same-origin browser GET requests do not carry an Origin header. Fetch
 * Metadata is set by the browser and survives the Vite development proxy.
 */
function isSameOriginFetch(headers: HeadersInput): boolean {
	return headerValue(headers, "sec-fetch-site") === "same-origin";
}

export function createGatewayAccessControl(
	sessionSecret: string,
	options: GatewayAccessControlOptions = {},
): GatewayAccessControl {
	const originDenial = (headers: HeadersInput): GatewayAccessDenial | undefined => {
		const targetOrigin = requestOrigin(headers);
		if (!targetOrigin) return "invalid_target";
		const rawOrigin = headerValue(headers, "origin");
		if (!rawOrigin) return isSameOriginFetch(headers) ? undefined : "missing_same_origin_metadata";
		const origin = normalizedOrigin(rawOrigin);
		if (!origin) return "invalid_origin";
		return origin === targetOrigin ? undefined : "cross_origin";
	};
	const isAllowedOrigin = (headers: HeadersInput): boolean => {
		const denial = originDenial(headers);
		if (denial) options.onDenied?.(denial);
		return denial === undefined;
	};

	return {
		isAllowedOrigin,
		isAuthorized: (headers) => {
			const denial = originDenial(headers);
			if (denial) {
				options.onDenied?.(denial);
				return false;
			}
			if (!matchesSecret(readCookie(headers, SESSION_COOKIE_NAME), sessionSecret)) {
				options.onDenied?.("invalid_session_cookie");
				return false;
			}
			return true;
		},
		createSessionCookie: () => `${SESSION_COOKIE_NAME}=${sessionSecret}; Path=/; HttpOnly; SameSite=Strict`,
	};
}
