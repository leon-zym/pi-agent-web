import { describe, expect, it } from "vitest";
import { createGatewayAccessControl } from "../src/access-control.js";
import { type AppContext, createApp, type GatewayReadiness } from "../src/routes.js";

function appWithReadiness(readiness: GatewayReadiness) {
	const accessControl = createGatewayAccessControl("readiness-test-secret");
	const app = createApp({ accessControl, readiness } as AppContext);
	const headers = {
		Host: "127.0.0.1:31415",
		Origin: "http://127.0.0.1:31415",
		Cookie: accessControl.createSessionCookie().split(";", 1)[0] ?? "",
	};
	return { app, headers };
}

describe("gateway liveness and readiness", () => {
	it("stays live while reporting a stable, redacted runtime diagnostic", async () => {
		const { app, headers } = appWithReadiness({
			ready: false,
			diagnostic: { code: "pi_runtime_missing" },
		});

		const live = await app.request("/api/v1/health/live", { headers });
		expect(live.status).toBe(200);
		expect(await live.json()).toEqual({ ok: true, service: "pi-agent-web", version: "0.1.0" });

		const ready = await app.request("/api/v1/health/ready", { headers });
		expect(ready.status).toBe(503);
		expect(await ready.json()).toEqual({
			ok: false,
			ready: false,
			service: "pi-agent-web",
			version: "0.1.0",
			diagnostic: { code: "pi_runtime_missing" },
		});
	});

	it("reports only negotiated runtime metadata when ready", async () => {
		const runtime = {
			source: "bundled" as const,
			version: "0.84.2",
			adapterId: "legacy-rpc-v1",
			capabilities: ["rpc.commands", "rpc.events"],
		};
		const { app, headers } = appWithReadiness({ ready: true, runtime });

		const ready = await app.request("/api/v1/health/ready", { headers });
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({
			ok: true,
			ready: true,
			service: "pi-agent-web",
			version: "0.1.0",
			runtime,
		});
	});
});
