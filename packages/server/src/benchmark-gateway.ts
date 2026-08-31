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
export const BENCHMARK_GATEWAY_TRIAL_CONTROL_MESSAGE = "piweb-benchmark-gateway-trial";
export const GATEWAY_MEMORY_SAMPLE_INTERVAL_MS = 50;

export interface BenchmarkGatewayCounters {
	maxHeapUsedBytes: number;
	maxRssBytes: number;
	memorySampleCount: number;
	memorySampleIntervalMs: number;
	memorySamplerOverheadMs: number;
	publicationCount: number;
	snapshotBuildCount: number;
	trialEpoch: number;
}

export interface BenchmarkGatewayTrial {
	epoch: number;
	id: string | null;
	state: "aborted" | "active" | "ended" | "idle";
}

export interface BenchmarkGatewayCounterMessage {
	counters: Readonly<BenchmarkGatewayCounters>;
	generation: string;
	trial: Readonly<BenchmarkGatewayTrial>;
	type: typeof BENCHMARK_GATEWAY_COUNTER_MESSAGE;
}

export interface BenchmarkGatewayTrialControlMessage {
	action: "abort" | "begin" | "end";
	trialId: string;
	type: typeof BENCHMARK_GATEWAY_TRIAL_CONTROL_MESSAGE;
}

export interface BenchmarkGatewayCounterPort {
	abortTrial: (trialId: string) => Readonly<BenchmarkGatewayCounterMessage["trial"]>;
	beginTrial: (trialId: string) => Readonly<BenchmarkGatewayCounterMessage["trial"]>;
	endTrial: (trialId: string) => Readonly<BenchmarkGatewayCounterMessage["trial"]>;
	recordPublication: (message: Pick<SessionSupervisorMessage, "type">) => void;
	recordSnapshotBuild: () => void;
	sampleProcessMemory: () => void;
	snapshot: () => Readonly<BenchmarkGatewayCounters>;
	trial: () => Readonly<BenchmarkGatewayTrial>;
}

type BenchmarkRuntimeFactoryOptions = Omit<SessionRuntimeCoreOptions, "productAdapter" | "payloadCustody">;

const COUNTER_KEYS = [
	"maxHeapUsedBytes",
	"maxRssBytes",
	"memorySampleCount",
	"memorySampleIntervalMs",
	"memorySamplerOverheadMs",
	"publicationCount",
	"snapshotBuildCount",
	"trialEpoch",
];
const COUNTER_MESSAGE_KEYS = ["counters", "generation", "trial", "type"];
const TRIAL_CONTROL_KEYS = ["action", "trialId", "type"];
const TRIAL_KEYS = ["epoch", "id", "state"];

function isSafeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function validTrialId(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
}

function validGeneration(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
}

function validTrial(value: unknown): value is BenchmarkGatewayTrial {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const trial = value as Record<string, unknown>;
	return (
		exactKeys(trial, TRIAL_KEYS) &&
		isSafeCounter(trial.epoch) &&
		(trial.id === null || validTrialId(trial.id)) &&
		["aborted", "active", "ended", "idle"].includes(String(trial.state)) &&
		((trial.state === "idle" && trial.id === null && trial.epoch === 0) ||
			(trial.state !== "idle" && trial.id !== null && trial.epoch > 0))
	);
}

function validCounters(value: unknown): value is BenchmarkGatewayCounters {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const counters = value as Record<string, unknown>;
	return (
		exactKeys(counters, COUNTER_KEYS) &&
		isSafeCounter(counters.maxHeapUsedBytes) &&
		isSafeCounter(counters.maxRssBytes) &&
		isSafeCounter(counters.memorySampleCount) &&
		isSafeCounter(counters.memorySampleIntervalMs) &&
		isFiniteCounter(counters.memorySamplerOverheadMs) &&
		isSafeCounter(counters.publicationCount) &&
		isSafeCounter(counters.snapshotBuildCount) &&
		isSafeCounter(counters.trialEpoch)
	);
}

/** Benchmark-only counter primitive: preserve safe, nonnegative values and saturate at the wire limit. */
export function incrementBenchmarkCounter(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) return 0;
	return value < Number.MAX_SAFE_INTEGER ? value + 1 : Number.MAX_SAFE_INTEGER;
}

function increment(
	counter: BenchmarkGatewayCounters,
	field: "memorySampleCount" | "publicationCount" | "snapshotBuildCount",
): void {
	counter[field] = incrementBenchmarkCounter(counter[field]);
}

function emptyCounters(epoch = 0): BenchmarkGatewayCounters {
	return {
		maxHeapUsedBytes: 0,
		maxRssBytes: 0,
		memorySampleCount: 0,
		memorySampleIntervalMs: GATEWAY_MEMORY_SAMPLE_INTERVAL_MS,
		memorySamplerOverheadMs: 0,
		publicationCount: 0,
		snapshotBuildCount: 0,
		trialEpoch: epoch,
	};
}

/** Aggregate logical publications emitted at the Supervisor composition boundary, never socket sends. */
export function isLogicalSupervisorPublication(message: { type: unknown }): boolean {
	return (
		typeof message.type === "string" &&
		(LOGICAL_SUPERVISOR_PUBLICATION_TYPES as readonly string[]).includes(message.type)
	);
}

/** Strict child-to-parent IPC payload guard: only a generation-bound aggregate trial snapshot crosses it. */
export function isBenchmarkGatewayCounterMessage(value: unknown): value is BenchmarkGatewayCounterMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	return (
		exactKeys(message, COUNTER_MESSAGE_KEYS) &&
		message.type === BENCHMARK_GATEWAY_COUNTER_MESSAGE &&
		validGeneration(message.generation) &&
		validTrial(message.trial) &&
		validCounters(message.counters) &&
		(message.counters as BenchmarkGatewayCounters).trialEpoch ===
			(message.trial as BenchmarkGatewayTrial).epoch
	);
}

/** Strict parent-to-child IPC guard for the benchmark-only trial lifecycle. */
export function isBenchmarkGatewayTrialControlMessage(
	value: unknown,
): value is BenchmarkGatewayTrialControlMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	return (
		exactKeys(message, TRIAL_CONTROL_KEYS) &&
		message.type === BENCHMARK_GATEWAY_TRIAL_CONTROL_MESSAGE &&
		["abort", "begin", "end"].includes(String(message.action)) &&
		validTrialId(message.trialId)
	);
}

/**
 * Benchmark-only in-memory counters. Their owner chooses whether to instantiate this port; it has
 * no route, persistence, or Session authority. Logical observations only count while one explicit
 * trial is active, and the fixed-cadence sampler is deliberately outside publication/snapshot paths.
 */
export function createBenchmarkGatewayCounterPort(
	memoryUsage: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
): BenchmarkGatewayCounterPort {
	let counters = emptyCounters();
	let trial: BenchmarkGatewayTrial = { epoch: 0, id: null, state: "idle" };
	const snapshotTrial = () => Object.freeze({ ...trial });
	const requireActiveTrial = (trialId: string) => {
		if (trial.state !== "active" || trial.id !== trialId) {
			throw new Error("benchmark trial lifecycle does not match the active trial");
		}
	};
	const sampleProcessMemory = () => {
		if (trial.state !== "active") return;
		const startedAt = performance.now();
		try {
			const usage = memoryUsage();
			let sampled = false;
			if (isSafeCounter(usage.heapUsed)) {
				counters.maxHeapUsedBytes = Math.max(counters.maxHeapUsedBytes, usage.heapUsed);
				sampled = true;
			}
			if (isSafeCounter(usage.rss)) {
				counters.maxRssBytes = Math.max(counters.maxRssBytes, usage.rss);
				sampled = true;
			}
			if (sampled) increment(counters, "memorySampleCount");
		} catch {
			// Measurement is deliberately best-effort and must not affect the benchmark Gateway.
		} finally {
			const elapsed = performance.now() - startedAt;
			if (Number.isFinite(elapsed) && elapsed >= 0) {
				counters.memorySamplerOverheadMs = Math.min(
					Number.MAX_VALUE,
					counters.memorySamplerOverheadMs + elapsed,
				);
			}
		}
	};
	return Object.freeze({
		beginTrial: (trialId: string) => {
			if (!validTrialId(trialId)) throw new Error("benchmark trial id is invalid");
			if (trial.state === "active") throw new Error("benchmark trial is already active");
			const epoch = incrementBenchmarkCounter(trial.epoch);
			trial = { epoch, id: trialId, state: "active" };
			counters = emptyCounters(epoch);
			return snapshotTrial();
		},
		endTrial: (trialId: string) => {
			requireActiveTrial(trialId);
			sampleProcessMemory();
			trial = { ...trial, state: "ended" };
			return snapshotTrial();
		},
		abortTrial: (trialId: string) => {
			requireActiveTrial(trialId);
			trial = { ...trial, state: "aborted" };
			return snapshotTrial();
		},
		recordPublication: (message: Pick<SessionSupervisorMessage, "type">) => {
			if (trial.state !== "active" || !isLogicalSupervisorPublication(message)) return;
			increment(counters, "publicationCount");
		},
		recordSnapshotBuild: () => {
			if (trial.state !== "active") return;
			increment(counters, "snapshotBuildCount");
		},
		sampleProcessMemory,
		snapshot: () => Object.freeze({ ...counters }),
		trial: snapshotTrial,
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
