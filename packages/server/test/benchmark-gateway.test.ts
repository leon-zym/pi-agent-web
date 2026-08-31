import { describe, expect, it } from "vitest";
import {
	BENCHMARK_GATEWAY_COUNTER_MESSAGE,
	createBenchmarkGatewayCounterPort,
	incrementBenchmarkCounter,
	isBenchmarkGatewayCounterMessage,
	isLogicalSupervisorPublication,
	LOGICAL_SUPERVISOR_PUBLICATION_TYPES,
} from "../src/benchmark-gateway.js";

describe("benchmark Gateway counters", () => {
	it("accepts only exact aggregate IPC counter snapshots", () => {
		const counters = createBenchmarkGatewayCounterPort(
			() => ({ heapUsed: 101, rss: 202 }) as NodeJS.MemoryUsage,
		);
		const snapshot = counters.snapshot();
		const message = { type: BENCHMARK_GATEWAY_COUNTER_MESSAGE, counters: snapshot };

		expect(isBenchmarkGatewayCounterMessage(message)).toBe(true);
		expect(isBenchmarkGatewayCounterMessage({ ...message, extra: true })).toBe(false);
		expect(
			isBenchmarkGatewayCounterMessage({
				type: BENCHMARK_GATEWAY_COUNTER_MESSAGE,
				counters: { ...snapshot, publicationCount: -1 },
			}),
		).toBe(false);
		expect(
			isBenchmarkGatewayCounterMessage({
				type: BENCHMARK_GATEWAY_COUNTER_MESSAGE,
				counters: { ...snapshot, unexpected: 1 },
			}),
		).toBe(false);
	});

	it("counts only aggregate logical Supervisor publications and returns immutable snapshots", () => {
		const counters = createBenchmarkGatewayCounterPort(
			() => ({ heapUsed: 101, rss: 202 }) as NodeJS.MemoryUsage,
		);
		for (const type of LOGICAL_SUPERVISOR_PUBLICATION_TYPES) {
			expect(isLogicalSupervisorPublication({ type })).toBe(true);
			counters.recordPublication({ type });
		}
		expect(isLogicalSupervisorPublication({ type: "socket_send" })).toBe(false);
		expect(isLogicalSupervisorPublication({ type: "not_a_supervisor_message" })).toBe(false);

		const first = counters.snapshot();
		expect(first.publicationCount).toBe(LOGICAL_SUPERVISOR_PUBLICATION_TYPES.length);
		expect(first.maxHeapUsedBytes).toBe(101);
		expect(first.maxRssBytes).toBe(202);
		expect(Object.isFrozen(first)).toBe(true);
		counters.recordSnapshotBuild();
		const second = counters.snapshot();
		expect(second).not.toBe(first);
		expect(first.snapshotBuildCount).toBe(0);
		expect(second.snapshotBuildCount).toBe(1);
	});

	it("keeps counter values nonnegative and saturates safely", () => {
		expect(incrementBenchmarkCounter(-1)).toBe(0);
		expect(incrementBenchmarkCounter(0)).toBe(1);
		expect(incrementBenchmarkCounter(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
		expect(incrementBenchmarkCounter(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("isolates process-memory sampling failures", () => {
		const counters = createBenchmarkGatewayCounterPort(() => {
			throw new Error("memory sampler unavailable");
		});

		expect(() => counters.sampleProcessMemory()).not.toThrow();
		counters.recordPublication({ type: "event" });
		expect(counters.snapshot()).toEqual({
			maxHeapUsedBytes: 0,
			maxRssBytes: 0,
			publicationCount: 1,
			snapshotBuildCount: 0,
		});
	});
});
