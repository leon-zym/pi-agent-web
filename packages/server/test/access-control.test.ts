import { describe, expect, it } from "vitest";
import {
	createGatewayAccessControl,
	createGatewayAccessDenialReporter,
	type GatewayAccessDenial,
} from "../src/access-control.js";

const secret = "test-session-secret";

function headers(host: string, origin?: string): Record<string, string> {
	return {
		host,
		...(origin ? { origin } : {}),
	};
}

describe("gateway access control policy", () => {
	it.each([
		["localhost:3000", "http://localhost:3000"],
		["127.0.0.1:3000", "http://127.0.0.1:3000"],
		["[::1]:3000", "http://[::1]:3000"],
	])("accepts the exact loopback origin for %s", (host, origin) => {
		const access = createGatewayAccessControl(secret);
		expect(access.isAllowedOrigin(headers(host, origin))).toBe(true);
	});

	it("rejects cross-port and cross-host origins", () => {
		const denials: GatewayAccessDenial[] = [];
		const access = createGatewayAccessControl(secret, { onDenied: (reason) => denials.push(reason) });

		expect(access.isAllowedOrigin(headers("127.0.0.1:3000", "http://127.0.0.1:5173"))).toBe(false);
		expect(access.isAllowedOrigin(headers("127.0.0.1:3000", "http://localhost:3000"))).toBe(false);
		expect(denials).toEqual(["cross_origin", "cross_origin"]);
	});

	it("requires Fetch Metadata when a browser GET omits Origin", () => {
		const access = createGatewayAccessControl(secret);
		expect(access.isAllowedOrigin({ host: "127.0.0.1:3000", "sec-fetch-site": "same-origin" })).toBe(true);
		expect(access.isAllowedOrigin({ host: "127.0.0.1:3000" })).toBe(false);
		expect(access.isAllowedOrigin({ host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" })).toBe(false);
	});

	it("reports only stable denial codes for malformed targets, origins, and cookies", () => {
		const denials: GatewayAccessDenial[] = [];
		const access = createGatewayAccessControl(secret, { onDenied: (reason) => denials.push(reason) });

		expect(access.isAllowedOrigin(headers("evil.example:3000", "http://evil.example:3000"))).toBe(false);
		expect(access.isAllowedOrigin(headers("127.0.0.1:3000", "https://127.0.0.1:3000"))).toBe(false);
		expect(
			access.isAuthorized({
				...headers("127.0.0.1:3000", "http://127.0.0.1:3000"),
				cookie: "pi_web_session=wrong",
			}),
		).toBe(false);
		expect(denials).toEqual(["invalid_target", "invalid_origin", "invalid_session_cookie"]);
		expect(JSON.stringify(denials)).not.toContain(secret);
	});

	it.each(["evil@127.0.0.1:3000", "127.0.0.1:3000/path", "127.0.0.1:3000?query", "127.0.0.1:3000#fragment"])(
		"rejects a malformed Host authority: %s",
		(host) => {
			const access = createGatewayAccessControl(secret);
			expect(access.isAllowedOrigin(headers(host, "http://127.0.0.1:3000"))).toBe(false);
		},
	);

	it("rate-limits denial reports and summarizes the suppressed count", () => {
		let now = 0;
		const reports: Array<{ reason: GatewayAccessDenial; suppressed: number }> = [];
		const report = createGatewayAccessDenialReporter((entry) => reports.push(entry), {
			intervalMs: 1_000,
			now: () => now,
		});

		report("cross_origin");
		report("cross_origin");
		now = 999;
		report("invalid_session_cookie");
		now = 1_000;
		report("invalid_origin");

		expect(reports).toEqual([
			{ reason: "cross_origin", suppressed: 0 },
			{ reason: "invalid_origin", suppressed: 2 },
		]);
	});
});
