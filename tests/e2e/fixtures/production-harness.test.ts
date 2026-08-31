import assert from "node:assert/strict";
import { createBenchmarkGatewayIpcFence } from "./production-harness";

declare const describe: typeof import("node:test").describe;
declare const it: typeof import("node:test").it;

const idleSnapshot = {
	type: "piweb-benchmark-gateway-counters",
	generation: "gateway-test",
	trial: { epoch: 0, id: null, state: "idle" },
	counters: {
		maxHeapUsedBytes: 0,
		maxRssBytes: 0,
		memorySampleCount: 0,
		memorySampleIntervalMs: 50,
		memorySamplerOverheadMs: 0,
		publicationCount: 0,
		snapshotBuildCount: 0,
		trialEpoch: 0,
	},
} as const;

describe("benchmark Gateway IPC fence", () => {
	it("accepts the exact requested begin transition before clearing its expectation", () => {
		const fence = createBenchmarkGatewayIpcFence();
		fence.receive(idleSnapshot);
		fence.expect({
			type: "piweb-benchmark-gateway-trial",
			action: "begin",
			trialId: "trial-1",
		});
		fence.receive({
			...idleSnapshot,
			trial: { epoch: 1, id: "trial-1", state: "active" },
			counters: { ...idleSnapshot.counters, memorySampleCount: 1, trialEpoch: 1 },
		});

		assert.equal(fence.error(), undefined);
		assert.deepEqual(fence.snapshot()?.trial, { epoch: 1, id: "trial-1", state: "active" });
	});

	it("fails immediately on malformed IPC after a valid launch snapshot", () => {
		const fence = createBenchmarkGatewayIpcFence();
		fence.receive(idleSnapshot);
		assert.equal(fence.error(), undefined);
		assert.deepEqual(fence.snapshot(), {
			generation: "gateway-test",
			trial: { epoch: 0, id: null, state: "idle" },
			counters: idleSnapshot.counters,
		});

		fence.receive({ type: "unexpected-after-launch" });

		assert.match(fence.error() ?? "", /malformed or unexpected IPC/);
		assert.equal(fence.snapshot()?.generation, "gateway-test");
	});
});
