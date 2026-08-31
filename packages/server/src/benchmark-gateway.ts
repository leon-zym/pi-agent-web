import {
	SessionRuntime,
	type SessionRuntimeCoreOptions,
	type SessionRuntimePiPayloadServices,
} from "./session-runtime.js";
import type { SessionSupervisorMessage } from "./session-runtime-types.js";

export const LOGICAL_SUPERVISOR_PUBLICATION_TYPES = [
	"auth_changed",
	"event",
	"extension_ui_closed",
	"extension_ui_request",
	"runtime_state",
	"session_directory_changed",
	"session_rekeyed",
] as const;

export const BENCHMARK_GATEWAY_COUNTER_MESSAGE = "piweb-benchmark-gateway-counters";

export interface BenchmarkGatewayCounters {
	maxHeapUsedBytes: number;
	maxRssBytes: number;
	publicationCount: number;
	snapshotBuildCount: number;
}

export interface BenchmarkGatewayCounterMessage {
	type: typeof BENCHMARK_GATEWAY_COUNTER_MESSAGE;
	counters: Readonly<BenchmarkGatewayCounters>;
}

export interface BenchmarkGatewayCounterPort {
	recordPublication: (message: Pick<SessionSupervisorMessage, "type">) => void;
	recordSnapshotBuild: () => void;
	sampleProcessMemory: () => void;
	snapshot: () => Readonly<BenchmarkGatewayCounters>;
}

type BenchmarkRuntimeFactoryOptions = Omit<SessionRuntimeCoreOptions, "productAdapter" | "payloadCustody">;

function isSafeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactCounterKeys(value: Record<string, unknown>): boolean {
	return (
		Object.keys(value).sort().join(",") ===
		["maxHeapUsedBytes", "maxRssBytes", "publicationCount", "snapshotBuildCount"].join(",")
	);
}

/** Benchmark-only counter primitive: preserve safe, nonnegative values and saturate at the wire limit. */
export function incrementBenchmarkCounter(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) return 0;
	return value < Number.MAX_SAFE_INTEGER ? value + 1 : Number.MAX_SAFE_INTEGER;
}

function increment(
	counter: BenchmarkGatewayCounters,
	field: "publicationCount" | "snapshotBuildCount",
): void {
	counter[field] = incrementBenchmarkCounter(counter[field]);
}

/** Aggregate logical publications emitted at the Supervisor composition boundary, never socket sends. */
export function isLogicalSupervisorPublication(message: { type: unknown }): boolean {
	return (
		typeof message.type === "string" &&
		(LOGICAL_SUPERVISOR_PUBLICATION_TYPES as readonly string[]).includes(message.type)
	);
}

/** Strict IPC payload guard: only aggregate counter snapshots cross the process boundary. */
export function isBenchmarkGatewayCounterMessage(value: unknown): value is BenchmarkGatewayCounterMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	if (Object.keys(message).sort().join(",") !== "counters,type") return false;
	if (message.type !== BENCHMARK_GATEWAY_COUNTER_MESSAGE) return false;
	if (typeof message.counters !== "object" || message.counters === null || Array.isArray(message.counters)) {
		return false;
	}
	const counters = message.counters as Record<string, unknown>;
	return (
		exactCounterKeys(counters) &&
		isSafeCounter(counters.maxHeapUsedBytes) &&
		isSafeCounter(counters.maxRssBytes) &&
		isSafeCounter(counters.publicationCount) &&
		isSafeCounter(counters.snapshotBuildCount)
	);
}

/**
 * Benchmark-only in-memory counters. Their owner chooses whether to instantiate this port; it has
 * no route, persistence, or Session authority and intentionally records only aggregate process facts.
 */
export function createBenchmarkGatewayCounterPort(
	memoryUsage: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
): BenchmarkGatewayCounterPort {
	const counters: BenchmarkGatewayCounters = {
		maxHeapUsedBytes: 0,
		maxRssBytes: 0,
		publicationCount: 0,
		snapshotBuildCount: 0,
	};
	const sampleProcessMemory = () => {
		try {
			const usage = memoryUsage();
			if (isSafeCounter(usage.heapUsed))
				counters.maxHeapUsedBytes = Math.max(counters.maxHeapUsedBytes, usage.heapUsed);
			if (isSafeCounter(usage.rss)) counters.maxRssBytes = Math.max(counters.maxRssBytes, usage.rss);
		} catch {
			// Measurement is deliberately best-effort and must not affect the benchmark Gateway.
		}
	};
	return Object.freeze({
		recordPublication: (message: Pick<SessionSupervisorMessage, "type">) => {
			if (!isLogicalSupervisorPublication(message)) return;
			increment(counters, "publicationCount");
			sampleProcessMemory();
		},
		recordSnapshotBuild: () => {
			increment(counters, "snapshotBuildCount");
			sampleProcessMemory();
		},
		sampleProcessMemory,
		snapshot: () => Object.freeze({ ...counters }),
	});
}

class InstrumentedSessionRuntime extends SessionRuntime {
	constructor(
		options: BenchmarkRuntimeFactoryOptions,
		services: SessionRuntimePiPayloadServices,
		private readonly counters: BenchmarkGatewayCounterPort,
	) {
		super({ ...options, piPayloadServices: services });
	}

	protected override onSnapshotBuild(): void {
		try {
			this.counters.recordSnapshotBuild();
		} catch {
			// Observation failure must not alter the canonical Session snapshot path.
		}
	}
}

/** Factory supplied only by the alternate process entry to SessionSupervisorCore. */
export function createInstrumentedRuntimeFactory(
	services: SessionRuntimePiPayloadServices,
	counters: BenchmarkGatewayCounterPort,
): (options: BenchmarkRuntimeFactoryOptions) => SessionRuntime {
	return (options) => new InstrumentedSessionRuntime(options, services, counters);
}
