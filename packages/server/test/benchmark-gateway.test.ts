import { describe, expect, it } from "vitest";
import {
	BENCHMARK_GATEWAY_COUNTER_MESSAGE,
	BENCHMARK_GATEWAY_TRIAL_CONTROL_MESSAGE,
	createBenchmarkGatewayCounterPort,
	incrementBenchmarkCounter,
	isBenchmarkGatewayCounterMessage,
	isBenchmarkGatewayTrialControlMessage,
	isLogicalSupervisorPublication,
	LOGICAL_SUPERVISOR_PUBLICATION_TYPES,
} from "../src/benchmark-gateway.js";

describe("benchmark Gateway counters", () => {
	it("accepts only exact generation-bound aggregate IPC snapshots and trial controls", () => {
		const counters = createBenchmarkGatewayCounterPort(
			() => ({ heapUsed: 101, rss: 202 }) as NodeJS.MemoryUsage,
		);
		counters.beginTrial("trial-a");
		counters.sampleProcessMemory();
		const message = {
			type: BENCHMARK_GATEWAY_COUNTER_MESSAGE,
			generation: "gateway-1",
			trial: counters.trial(),
			counters: counters.snapshot(),
		};

		expect(isBenchmarkGatewayCounterMessage(message)).toBe(true);
		expect(isBenchmarkGatewayCounterMessage({ ...message, extra: true })).toBe(false);
		expect(
			isBenchmarkGatewayCounterMessage({
				...message,
				counters: { ...message.counters, publicationCount: -1 },
			}),
		).toBe(false);
		expect(
			isBenchmarkGatewayCounterMessage({
				...message,
				trial: { ...message.trial, epoch: message.trial.epoch + 1 },
			}),
		).toBe(false);
		expect(
			isBenchmarkGatewayTrialControlMessage({
				type: BENCHMARK_GATEWAY_TRIAL_CONTROL_MESSAGE,
				action: "begin",
				trialId: "trial-a",
			}),
		).toBe(true);
		expect(
			isBenchmarkGatewayTrialControlMessage({
				type: BENCHMARK_GATEWAY_TRIAL_CONTROL_MESSAGE,
				action: "begin",
				trialId: "trial-a",
				extra: true,
			}),
		).toBe(false);
	});

	it("counts only aggregate logical publications during an active trial and returns immutable snapshots", () => {
		const counters = createBenchmarkGatewayCounterPort(
			() => ({ heapUsed: 101, rss: 202 }) as NodeJS.MemoryUsage,
		);
		counters.recordPublication({ type: "event" });
		counters.recordSnapshotBuild();
		expect(counters.snapshot().publicationCount).toBe(0);
		expect(counters.snapshot().snapshotBuildCount).toBe(0);

		counters.beginTrial("trial-a");
		for (const type of LOGICAL_SUPERVISOR_PUBLICATION_TYPES) {
			expect(isLogicalSupervisorPublication({ type })).toBe(true);
			counters.recordPublication({ type });
		}
		expect(isLogicalSupervisorPublication({ type: "socket_send" })).toBe(false);
		expect(isLogicalSupervisorPublication({ type: "not_a_supervisor_message" })).toBe(false);
		counters.recordSnapshotBuild();
		counters.sampleProcessMemory();

		const first = counters.snapshot();
		expect(first.publicationCount).toBe(LOGICAL_SUPERVISOR_PUBLICATION_TYPES.length);
		expect(first.snapshotBuildCount).toBe(1);
		expect(first.memorySampleCount).toBe(1);
		expect(first.maxHeapUsedBytes).toBe(101);
		expect(first.maxRssBytes).toBe(202);
		expect(Object.isFrozen(first)).toBe(true);
		counters.endTrial("trial-a");
		counters.recordPublication({ type: "event" });
		counters.recordSnapshotBuild();
		const second = counters.snapshot();
		expect(second).not.toBe(first);
		expect(second.publicationCount).toBe(first.publicationCount);
		expect(second.snapshotBuildCount).toBe(first.snapshotBuildCount);
		expect(counters.trial()).toEqual({ id: "trial-a", epoch: 1, state: "ended" });
	});

	it("resets memory maxima and logical counters for each trial epoch", () => {
		let heapUsed = 100;
		const counters = createBenchmarkGatewayCounterPort(
			() => ({ heapUsed, rss: heapUsed * 2 }) as NodeJS.MemoryUsage,
		);
		counters.beginTrial("trial-a");
		counters.sampleProcessMemory();
		counters.recordPublication({ type: "event" });
		counters.endTrial("trial-a");
		expect(counters.snapshot()).toMatchObject({
			maxHeapUsedBytes: 100,
			publicationCount: 1,
			trialEpoch: 1,
		});

		heapUsed = 7;
		counters.beginTrial("trial-b");
		counters.sampleProcessMemory();
		expect(counters.snapshot()).toMatchObject({
			maxHeapUsedBytes: 7,
			maxRssBytes: 14,
			publicationCount: 0,
			snapshotBuildCount: 0,
			trialEpoch: 2,
		});
	});

	it("keeps counter values nonnegative and saturates safely", () => {
		expect(incrementBenchmarkCounter(-1)).toBe(0);
		expect(incrementBenchmarkCounter(0)).toBe(1);
		expect(incrementBenchmarkCounter(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
		expect(incrementBenchmarkCounter(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("isolates process-memory sampling failures and invalid lifecycle messages", () => {
		const counters = createBenchmarkGatewayCounterPort(() => {
			throw new Error("memory sampler unavailable");
		});

		counters.beginTrial("trial-a");
		expect(() => counters.sampleProcessMemory()).not.toThrow();
		counters.recordPublication({ type: "event" });
		expect(counters.snapshot()).toMatchObject({
			maxHeapUsedBytes: 0,
			maxRssBytes: 0,
			memorySampleCount: 0,
			publicationCount: 1,
			snapshotBuildCount: 0,
		});
		expect(() => counters.endTrial("wrong-trial")).toThrow(/lifecycle/);
		counters.abortTrial("trial-a");
		expect(counters.trial()).toEqual({ id: "trial-a", epoch: 1, state: "aborted" });
	});
});
