import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FUTURE_SESSION_CONTENT_REF_BUDGET } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { EpochContentStore } from "../src/epoch-content-store.js";
import {
	createGatewayFuturePayloadActivation,
	createGatewayPayloadActivation,
} from "../src/gateway-payload-activation.js";

describe("gateway payload activation", () => {
	let webDataDir: string | undefined;
	let store: EpochContentStore | undefined;

	afterEach(async () => {
		await store?.shutdown();
		if (webDataDir) await rm(webDataDir, { recursive: true, force: true });
		store = undefined;
		webDataDir = undefined;
	});

	it("keeps the production attachment activation in current mode", async () => {
		webDataDir = await mkdtemp(path.join(tmpdir(), "pi-web-current-activation-"));
		store = new EpochContentStore({ webDataDir, serverEpoch: "current-epoch" });
		await store.initialize();

		const activation = createGatewayPayloadActivation(store, "current-epoch");

		expect(activation.externalizer.mode).toBe("attachment");
		expect(activation.context).not.toHaveProperty("contentRefBudget");
	});

	it("creates an explicit default-off future activation with the exact trusted context", async () => {
		webDataDir = await mkdtemp(path.join(tmpdir(), "pi-web-future-activation-"));
		store = new EpochContentStore({ webDataDir, serverEpoch: "future-epoch" });
		await store.initialize();

		const activation = createGatewayFuturePayloadActivation(store, "future-epoch");

		expect(activation.externalizer.mode).toBe("future_content");
		expect(activation.externalizer.context).toBe(activation.context);
		expect(activation.context).toEqual({
			serverEpoch: "future-epoch",
			payloadBudget: expect.any(Object),
			contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
		});
		expect(activation).not.toHaveProperty("supervisorServices");
	});
});
