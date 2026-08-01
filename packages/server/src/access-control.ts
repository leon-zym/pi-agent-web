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

const DEV_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]);

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

export function createGatewayAccessControl(sessionSecret: string): GatewayAccessControl {
	const isAllowedOrigin = (headers: HeadersInput): boolean => {
		const origin = normalizedOrigin(headerValue(headers, "origin"));
		if (!origin) return isSameOriginFetch(headers);
		return origin === requestOrigin(headers) || DEV_ORIGINS.has(origin);
	};

	return {
		isAllowedOrigin,
		isAuthorized: (headers) =>
			isAllowedOrigin(headers) && matchesSecret(readCookie(headers, SESSION_COOKIE_NAME), sessionSecret),
		createSessionCookie: () => `${SESSION_COOKIE_NAME}=${sessionSecret}; Path=/; HttpOnly; SameSite=Strict`,
	};
}
