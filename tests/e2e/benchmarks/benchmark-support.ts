import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, TestInfo } from "@playwright/test";
import type { BenchmarkGatewaySnapshot, ProductionHarness } from "../fixtures/production-harness";

export type BenchmarkTier = "representative" | "stress";
export type BenchmarkVariant = "coalesced" | "sequential";
export type BenchmarkKind =
	| "streaming"
	| "concurrency"
	| "history"
	| "recovery-disconnect"
	| "recovery-crash"
	| "content-roundtrip";

export interface BenchmarkScenario {
	id: string;
	domain: string;
	kind: BenchmarkKind;
	requiredCapabilities: string[];
	warmups: number;
	samples: number;
	targetBytes?: number;
	chunkBytes?: number;
	chunkDelayMs?: number;
	sessions?: number;
	sourceBytes?: number;
	turns?: number;
	inputBytes?: number;
	historyReadMode?: "verified_nonempty_native";
}

export interface BenchmarkTrial {
	index: number;
	warmup: boolean;
	metrics: Record<string, number | null>;
	correctness: Record<string, boolean>;
}

export interface BenchmarkMetricSummary {
	count: number;
	min: number;
	median: number;
	p95: number;
	max: number;
}

export interface BenchmarkGate {
	metric: string;
	statistic: "value" | "median" | "p95" | "max";
	comparison: "lte" | "gte" | "eq";
	threshold: number;
	actual: number | null;
	mode: "hard" | "observe";
	passed: boolean | null;
	rationale: string;
}

export interface BenchmarkOutcome {
	trials: BenchmarkTrial[];
	gates: BenchmarkGate[];
	notes: string[];
}

export interface BenchmarkTrialExecution {
	correctness: Record<string, boolean>;
	metrics: Record<string, number | null>;
}

export interface BenchmarkTrialContext {
	finishBrowserMeasurement: () => Promise<BrowserBenchmarkMeasurement>;
}

export interface BenchmarkTrialLifecycle {
	run: (
		index: number,
		execute: (context: BenchmarkTrialContext) => Promise<BenchmarkTrialExecution>,
	) => Promise<void>;
}

export interface BenchmarkScenarioResult {
	schemaVersion: 2;
	suiteVersion: 2;
	tier: BenchmarkTier;
	runId: string;
	scenarioId: string;
	domain: string;
	variant: BenchmarkVariant;
	kind: BenchmarkKind;
	status: "passed" | "failed";
	startedAt: string;
	finishedAt: string;
	browserVersion: string;
	parameters: BenchmarkScenario;
	capabilities: Record<string, boolean>;
	trials: BenchmarkTrial[];
	summaries: Record<string, BenchmarkMetricSummary>;
	gates: BenchmarkGate[];
	notes: string[];
	errors: string[];
}

export interface BrowserBenchmarkSnapshot {
	inputToPublicationMs: number | null;
	inputToNextPaintMs: number | null;
	streamDurationMs: number | null;
	settlementMs: number | null;
	totalCompletionMs: number | null;
	liveLongTaskMaxMs: number;
	liveLongTasksOver50Ms: number;
	heapDeltaBytes: number | null;
	heapPeakBytes: number | null;
	heapSampleCount: number;
	heapSampleIntervalMs: number;
	heapSamplerOverheadMs: number;
	publicationBatches: number;
	turnNodes: number;
}

export interface BrowserReactTrialSnapshot {
	actualDurationMs: number;
	baseDurationMs: number;
	commitCount: number;
	epoch: number;
	maxCommitDurationMs: number;
}

export interface BrowserBenchmarkMeasurement {
	browser: BrowserBenchmarkSnapshot;
	react: BrowserReactTrialSnapshot;
}

export interface BrowserSessionFrameSnapshot {
	deltaFrames: number;
	deltaChars: number;
	firstArrivalAt: number | null;
	lastArrivalAt: number | null;
	maxFrameGapMs: number;
}

function isTier(value: string | undefined): value is BenchmarkTier {
	return value === "representative" || value === "stress";
}

function isVariant(value: string | undefined): value is BenchmarkVariant {
	return value === "coalesced" || value === "sequential";
}

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootMatrixPath = path.join(configDirectory, "matrix.json");

interface MatrixDomainEntry {
	id: string;
	path: string;
}

interface DomainMatrix {
	schemaVersion: number;
	id: string;
	requiredCapabilities: string[];
	tiers: Record<BenchmarkTier, { scenarios: Omit<BenchmarkScenario, "domain" | "requiredCapabilities">[] }>;
}

function loadScenarios(tier: BenchmarkTier): BenchmarkScenario[] {
	const root = JSON.parse(fs.readFileSync(rootMatrixPath, "utf8")) as {
		schemaVersion?: unknown;
		domains?: unknown;
	};
	if (root.schemaVersion !== 2 || !Array.isArray(root.domains)) {
		throw new Error("Benchmark root matrix must use schema version 2");
	}
	const domains = root.domains as MatrixDomainEntry[];
	const scenarios: BenchmarkScenario[] = [];
	for (const entry of domains) {
		if (
			typeof entry?.id !== "string" ||
			typeof entry.path !== "string" ||
			path.isAbsolute(entry.path) ||
			entry.path.includes("..")
		) {
			throw new Error("Benchmark root matrix has an invalid domain entry");
		}
		const domainPath = path.join(configDirectory, entry.path);
		const domain = JSON.parse(fs.readFileSync(domainPath, "utf8")) as DomainMatrix;
		if (
			domain.schemaVersion !== 2 ||
			domain.id !== entry.id ||
			!Array.isArray(domain.requiredCapabilities) ||
			!Array.isArray(domain.tiers?.[tier]?.scenarios)
		) {
			throw new Error(`Benchmark domain matrix is invalid: ${entry.id}`);
		}
		for (const scenario of domain.tiers[tier].scenarios) {
			scenarios.push({
				...scenario,
				domain: domain.id,
				requiredCapabilities: [...domain.requiredCapabilities],
			});
		}
	}
	return scenarios;
}

export function benchmarkTier(): BenchmarkTier {
	const value = process.env.PI_WEB_BENCHMARK_TIER;
	if (!isTier(value)) {
		throw new Error("PI_WEB_BENCHMARK_TIER must be representative or stress");
	}
	return value;
}

export function benchmarkRunId(): string {
	const value = process.env.PI_WEB_BENCHMARK_RUN_ID;
	if (!value || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)) {
		throw new Error("PI_WEB_BENCHMARK_RUN_ID must be a safe artifact directory name");
	}
	return value;
}

export function benchmarkVariant(): BenchmarkVariant {
	const value = process.env.PI_WEB_BENCHMARK_VARIANT;
	if (!isVariant(value)) throw new Error("PI_WEB_BENCHMARK_VARIANT must be coalesced or sequential");
	return value;
}

export function scenariosFor(kind: BenchmarkKind): BenchmarkScenario[] {
	const tier = benchmarkTier();
	return loadScenarios(tier).filter((scenario) => scenario.kind === kind);
}

function measuredValues(trials: BenchmarkTrial[], metric: string): number[] {
	return trials
		.filter((trial) => !trial.warmup)
		.map((trial) => trial.metrics[metric])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
		.sort((left, right) => left - right);
}

function percentile(sorted: number[], percentileValue: number): number {
	if (sorted.length === 0) return Number.NaN;
	const rank = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
	return sorted[Math.max(0, rank)] ?? Number.NaN;
}

export function summarizeMetric(
	trials: BenchmarkTrial[],
	metric: string,
): BenchmarkMetricSummary | undefined {
	const values = measuredValues(trials, metric);
	if (values.length === 0) return undefined;
	const middle = Math.floor(values.length / 2);
	const median =
		values.length % 2 === 0 ? ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2 : (values[middle] ?? 0);
	return {
		count: values.length,
		min: values[0] ?? Number.NaN,
		median,
		p95: percentile(values, 0.95),
		max: values.at(-1) ?? Number.NaN,
	};
}

export function addSummaryGate(
	outcome: BenchmarkOutcome,
	metric: string,
	statistic: "median" | "p95" | "max",
	comparison: "lte" | "gte" | "eq",
	threshold: number,
	mode: "hard" | "observe",
	rationale: string,
): void {
	const summary = summarizeMetric(outcome.trials, metric);
	const actual = summary?.[statistic] ?? null;
	const passed =
		actual === null
			? null
			: comparison === "lte"
				? actual <= threshold
				: comparison === "gte"
					? actual >= threshold
					: actual === threshold;
	outcome.gates.push({ metric, statistic, comparison, threshold, actual, mode, passed, rationale });
}

export function addValueGate(
	outcome: BenchmarkOutcome,
	metric: string,
	actual: number,
	comparison: "lte" | "gte" | "eq",
	threshold: number,
	mode: "hard" | "observe",
	rationale: string,
): void {
	const passed =
		comparison === "lte"
			? actual <= threshold
			: comparison === "gte"
				? actual >= threshold
				: actual === threshold;
	outcome.gates.push({
		metric,
		statistic: "value",
		comparison,
		threshold,
		actual,
		mode,
		passed,
		rationale,
	});
}

function summariesFor(trials: BenchmarkTrial[]): Record<string, BenchmarkMetricSummary> {
	const metricNames = new Set(trials.flatMap((trial) => Object.keys(trial.metrics)));
	const summaries: Record<string, BenchmarkMetricSummary> = {};
	for (const metric of [...metricNames].sort()) {
		const summary = summarizeMetric(trials, metric);
		if (summary) summaries[metric] = summary;
	}
	return summaries;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function rawDirectory(): string {
	const directory = process.env.PI_WEB_BENCHMARK_RAW_DIR;
	if (!directory || !path.isAbsolute(directory)) {
		throw new Error("PI_WEB_BENCHMARK_RAW_DIR must be an absolute path");
	}
	return directory;
}

async function browserCapabilities(page: Page): Promise<Record<string, boolean>> {
	const browser = page.context().browser();
	const observed = await page.evaluate(() => {
		const performanceWithMemory = performance as Performance & { memory?: { usedJSHeapSize?: unknown } };
		const benchmarkWindow = window as typeof window & {
			__piwebBenchmarkRuntime?: { trialSnapshot: () => unknown };
		};
		return {
			browser: true,
			"browser-memory-sampler": typeof performanceWithMemory.memory?.usedJSHeapSize === "number",
			longtask: PerformanceObserver.supportedEntryTypes?.includes("longtask") === true,
			"precise-memory": typeof performanceWithMemory.memory?.usedJSHeapSize === "number",
			"react-profiler": typeof benchmarkWindow.__piwebBenchmarkRuntime?.trialSnapshot === "function",
			websocket: typeof WebSocket === "function",
		};
	});
	return { ...observed, cdp: browser?.browserType().name() === "chromium" };
}

function scenarioDirectory(scenario: BenchmarkScenario): string {
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(scenario.id)) {
		throw new Error(`Benchmark scenario id is not safe for an artifact directory: ${scenario.id}`);
	}
	return path.join(rawDirectory(), scenario.id);
}

function isFiniteMetric(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function trialTelemetry(
	measurement: BrowserBenchmarkMeasurement,
	gateway: Readonly<BenchmarkGatewaySnapshot>,
): Record<string, number> {
	const browser = measurement.browser;
	const react = measurement.react;
	const counters = gateway.counters;
	if (
		browser.heapPeakBytes === null ||
		browser.heapSampleCount < 1 ||
		browser.heapSampleIntervalMs <= 0 ||
		gateway.trial.state !== "ended" ||
		counters.memorySampleCount < 1 ||
		counters.memorySampleIntervalMs <= 0 ||
		react.commitCount < 1
	) {
		throw new Error("benchmark trial telemetry is incomplete");
	}
	const telemetry = {
		browserHeapPeakBytes: browser.heapPeakBytes,
		browserHeapSampleCount: browser.heapSampleCount,
		browserHeapSampleIntervalMs: browser.heapSampleIntervalMs,
		browserHeapSamplerOverheadMs: browser.heapSamplerOverheadMs,
		gatewayHeapPeakBytes: counters.maxHeapUsedBytes,
		gatewayMemorySampleCount: counters.memorySampleCount,
		gatewayMemorySampleIntervalMs: counters.memorySampleIntervalMs,
		gatewayMemorySamplerOverheadMs: counters.memorySamplerOverheadMs,
		gatewayPublicationCount: counters.publicationCount,
		gatewayRssPeakBytes: counters.maxRssBytes,
		gatewaySnapshotBuildCount: counters.snapshotBuildCount,
		gatewayTrialEpoch: counters.trialEpoch,
		reactActualDurationMs: react.actualDurationMs,
		reactBaseDurationMs: react.baseDurationMs,
		reactCommitCount: react.commitCount,
		reactCommitMaxDurationMs: react.maxCommitDurationMs,
	};
	if (!Object.values(telemetry).every(isFiniteMetric)) {
		throw new Error("benchmark trial telemetry contains a non-finite value");
	}
	return telemetry;
}

function trialTelemetryCapabilities(trials: BenchmarkTrial[]): Record<string, boolean> {
	const keys = [
		"browserHeapPeakBytes",
		"browserHeapSampleCount",
		"browserHeapSampleIntervalMs",
		"browserHeapSamplerOverheadMs",
		"gatewayHeapPeakBytes",
		"gatewayMemorySampleCount",
		"gatewayMemorySampleIntervalMs",
		"gatewayMemorySamplerOverheadMs",
		"gatewayPublicationCount",
		"gatewayRssPeakBytes",
		"gatewaySnapshotBuildCount",
		"gatewayTrialEpoch",
		"reactActualDurationMs",
		"reactBaseDurationMs",
		"reactCommitCount",
		"reactCommitMaxDurationMs",
	];
	const complete =
		trials.length > 0 && trials.every((trial) => keys.every((key) => isFiniteMetric(trial.metrics[key])));
	return {
		"browser-memory-sampler":
			complete && trials.every((trial) => (trial.metrics.browserHeapSampleCount ?? 0) > 0),
		"gateway-trial-telemetry":
			complete && trials.every((trial) => (trial.metrics.gatewayMemorySampleCount ?? 0) > 0),
		"react-profiler": complete && trials.every((trial) => (trial.metrics.reactCommitCount ?? 0) > 0),
	};
}

export async function runBenchmarkScenario(
	page: Page,
	testInfo: TestInfo,
	harness: ProductionHarness,
	scenario: BenchmarkScenario,
	execute: (outcome: BenchmarkOutcome, trials: BenchmarkTrialLifecycle) => Promise<void>,
): Promise<void> {
	const tier = benchmarkTier();
	const runId = benchmarkRunId();
	const variant = benchmarkVariant();
	const startedAt = new Date().toISOString();
	const outcome: BenchmarkOutcome = { trials: [], gates: [], notes: [] };
	const errors: string[] = [];
	const trials: BenchmarkTrialLifecycle = {
		run: async (index, executeTrial) => {
			if (index !== outcome.trials.length) {
				throw new Error(`benchmark trial index ${String(index)} is not the next canonical trial`);
			}
			const trialId = `${scenario.id}-${String(index)}`;
			let gatewayActive = false;
			let browserFinished = false;
			let measurement: BrowserBenchmarkMeasurement | undefined;
			try {
				await harness.beginBenchmarkTrial(trialId);
				gatewayActive = true;
				await startBrowserMeasurement(page);
				const finish = async () => {
					if (!measurement) measurement = await finishBrowserMeasurement(page);
					browserFinished = true;
					return measurement;
				};
				const execution = await executeTrial({ finishBrowserMeasurement: finish });
				const completedMeasurement = await finish();
				const gateway = await harness.endBenchmarkTrial(trialId);
				gatewayActive = false;
				outcome.trials.push({
					index,
					warmup: index < scenario.warmups,
					metrics: { ...execution.metrics, ...trialTelemetry(completedMeasurement, gateway) },
					correctness: {
						...execution.correctness,
						complete: Object.values(execution.correctness).every((value) => value === true),
					},
				});
			} catch (error) {
				try {
					if (gatewayActive) await harness.abortBenchmarkTrial(trialId);
				} catch (abortError) {
					throw new Error(`${errorText(error)}\nbenchmark trial abort failed: ${errorText(abortError)}`);
				} finally {
					if (!browserFinished) await abortBrowserMeasurement(page);
				}
				throw error;
			}
		},
	};
	try {
		await execute(outcome, trials);
	} catch (error) {
		errors.push(errorText(error));
	}
	const hardFailures = outcome.gates.filter((gate) => gate.mode === "hard" && gate.passed !== true);
	if (hardFailures.length > 0) {
		errors.push(
			`hard benchmark gates failed: ${hardFailures
				.map(
					(gate) =>
						`${gate.metric}.${gate.statistic}=${String(gate.actual)} ${gate.comparison} ${String(gate.threshold)}`,
				)
				.join(", ")}`,
		);
	}
	const expectedTrials = scenario.warmups + scenario.samples;
	if (outcome.trials.length !== expectedTrials) {
		errors.push(
			`scenario recorded ${String(outcome.trials.length)} trials; expected ${String(expectedTrials)}`,
		);
	}
	let capabilities: Record<string, boolean>;
	try {
		capabilities = await browserCapabilities(page);
		Object.assign(capabilities, trialTelemetryCapabilities(outcome.trials));
	} catch (error) {
		errors.push(`benchmark capability observation failed: ${errorText(error)}`);
		capabilities = Object.fromEntries(scenario.requiredCapabilities.map((capability) => [capability, false]));
	}
	const result: BenchmarkScenarioResult = {
		schemaVersion: 2,
		suiteVersion: 2,
		tier,
		runId,
		scenarioId: scenario.id,
		domain: scenario.domain,
		variant,
		kind: scenario.kind,
		status: errors.length === 0 ? "passed" : "failed",
		startedAt,
		finishedAt: new Date().toISOString(),
		browserVersion: page.context().browser()?.version() ?? "unknown",
		parameters: scenario,
		capabilities,
		trials: outcome.trials,
		summaries: summariesFor(outcome.trials),
		gates: outcome.gates,
		notes: outcome.notes,
		errors,
	};
	const directory = scenarioDirectory(scenario);
	fs.mkdirSync(directory, { recursive: true });
	for (const trial of result.trials) {
		const rawTrial = {
			schemaVersion: result.schemaVersion,
			suiteVersion: result.suiteVersion,
			tier: result.tier,
			runId: result.runId,
			scenarioId: result.scenarioId,
			domain: result.domain,
			variant: result.variant,
			kind: result.kind,
			parameters: result.parameters,
			capabilities: result.capabilities,
			trial,
		};
		fs.writeFileSync(
			path.join(directory, `${variant}-${String(trial.index)}.json`),
			`${JSON.stringify(rawTrial, null, 2)}\n`,
			"utf8",
		);
	}
	const resultPath = path.join(directory, `${variant}.result.json`);
	fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
	await testInfo.attach(`${scenario.id}-${variant}.result.json`, {
		path: resultPath,
		contentType: "application/json",
	});
	if (errors.length > 0) throw new Error(errors.join("\n"));
}

export async function installBrowserBenchmarkObserver(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const HEAP_SAMPLE_INTERVAL_MS = 50;
		const getUsedHeap = () => {
			const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
			return memory?.usedJSHeapSize ?? null;
		};
		const state = {
			active: false,
			startedAt: 0,
			firstPublicationAt: null as number | null,
			firstPaintAt: null as number | null,
			streamEndedAt: null as number | null,
			settledAt: null as number | null,
			heapStartedAt: null as number | null,
			heapPeakBytes: null as number | null,
			heapSampleCount: 0,
			heapSamplerOverheadMs: 0,
			heapSampler: null as number | null,
			publicationBatches: 0,
			longTasks: [] as Array<{ startTime: number; duration: number }>,
		};
		const sampleHeap = () => {
			if (!state.active) return;
			const startedAt = performance.now();
			const heap = getUsedHeap();
			const elapsed = performance.now() - startedAt;
			if (Number.isFinite(elapsed) && elapsed >= 0) state.heapSamplerOverheadMs += elapsed;
			if (heap === null) return;
			state.heapPeakBytes = Math.max(state.heapPeakBytes ?? 0, heap);
			state.heapSampleCount += 1;
		};
		const stopHeapSampler = () => {
			if (state.heapSampler === null) return;
			window.clearInterval(state.heapSampler);
			state.heapSampler = null;
		};
		type SessionFrameState = {
			deltaFrames: number;
			deltaChars: number;
			firstArrivalAt: number | null;
			lastArrivalAt: number | null;
			maxFrameGapMs: number;
		};
		const sessionFrames = new Map<string, SessionFrameState>();
		const observeSocket = (socket: WebSocket) => {
			socket.addEventListener("message", (message) => {
				if (typeof message.data !== "string") return;
				let wire: unknown;
				try {
					wire = JSON.parse(message.data);
				} catch {
					return;
				}
				if (wire === null || typeof wire !== "object") return;
				const candidate = wire as {
					type?: unknown;
					sessionHandle?: unknown;
					event?: {
						type?: unknown;
						assistantMessageEvent?: { type?: unknown; delta?: unknown };
					};
				};
				const delta = candidate.event?.assistantMessageEvent;
				if (
					candidate.type !== "event" ||
					typeof candidate.sessionHandle !== "string" ||
					candidate.event?.type !== "message_update" ||
					delta?.type !== "text_delta" ||
					typeof delta.delta !== "string"
				) {
					return;
				}
				const observed = sessionFrames.get(candidate.sessionHandle);
				if (!observed) return;
				const now = performance.now();
				if (observed.lastArrivalAt !== null) {
					observed.maxFrameGapMs = Math.max(observed.maxFrameGapMs, now - observed.lastArrivalAt);
				}
				observed.deltaFrames += 1;
				observed.deltaChars += delta.delta.length;
				observed.firstArrivalAt ??= now;
				observed.lastArrivalAt = now;
			});
		};
		const BenchmarkWebSocket = new Proxy(window.WebSocket, {
			construct(target, args) {
				const socket = Reflect.construct(target, args) as WebSocket;
				observeSocket(socket);
				return socket;
			},
		});
		Object.defineProperty(window, "WebSocket", {
			configurable: true,
			value: BenchmarkWebSocket,
			writable: true,
		});
		const mutationObserver = new MutationObserver(() => {
			if (!state.active) return;
			const live = document.querySelector<HTMLElement>('[data-markdown-streaming="true"]');
			if (!live?.textContent) return;
			state.publicationBatches += 1;
			if (state.firstPublicationAt !== null) return;
			state.firstPublicationAt = performance.now();
			requestAnimationFrame(() => {
				if (state.firstPaintAt === null) state.firstPaintAt = performance.now();
			});
		});
		mutationObserver.observe(document, { childList: true, characterData: true, subtree: true });
		const longTaskObserver = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
			}
		});
		try {
			longTaskObserver.observe({ entryTypes: ["longtask"] });
		} catch {
			// Capability is represented by empty long-task data on unsupported browsers.
		}
		const api = {
			resetSessionFrames: (sessionHandles: string[]) => {
				sessionFrames.clear();
				for (const sessionHandle of sessionHandles) {
					sessionFrames.set(sessionHandle, {
						deltaFrames: 0,
						deltaChars: 0,
						firstArrivalAt: null,
						lastArrivalAt: null,
						maxFrameGapMs: 0,
					});
				}
			},
			sessionFrameSnapshot: (sessionHandle: string): BrowserSessionFrameSnapshot | null => {
				const observed = sessionFrames.get(sessionHandle);
				return observed ? { ...observed } : null;
			},
			start: () => {
				stopHeapSampler();
				state.active = true;
				state.startedAt = performance.now();
				state.firstPublicationAt = null;
				state.firstPaintAt = null;
				state.streamEndedAt = null;
				state.settledAt = null;
				state.heapStartedAt = getUsedHeap();
				state.heapPeakBytes = null;
				state.heapSampleCount = 0;
				state.heapSamplerOverheadMs = 0;
				state.publicationBatches = 0;
				state.longTasks.length = 0;
				sampleHeap();
				state.heapSampler = window.setInterval(sampleHeap, HEAP_SAMPLE_INTERVAL_MS);
			},
			markStreamEnd: () => {
				state.streamEndedAt = performance.now();
			},
			markSettled: () => {
				sampleHeap();
				stopHeapSampler();
				state.settledAt = performance.now();
				state.active = false;
			},
			snapshot: (): BrowserBenchmarkSnapshot => {
				const heapNow = getUsedHeap();
				const streamEnd = state.streamEndedAt ?? performance.now();
				const liveLongTasks = state.longTasks.filter(
					(entry) => entry.startTime >= state.startedAt && entry.startTime < streamEnd,
				);
				return {
					inputToPublicationMs:
						state.firstPublicationAt === null ? null : state.firstPublicationAt - state.startedAt,
					inputToNextPaintMs: state.firstPaintAt === null ? null : state.firstPaintAt - state.startedAt,
					streamDurationMs: state.streamEndedAt === null ? null : state.streamEndedAt - state.startedAt,
					settlementMs:
						state.streamEndedAt === null || state.settledAt === null
							? null
							: state.settledAt - state.streamEndedAt,
					totalCompletionMs: state.settledAt === null ? null : state.settledAt - state.startedAt,
					liveLongTaskMaxMs: Math.max(0, ...liveLongTasks.map((entry) => entry.duration)),
					liveLongTasksOver50Ms: liveLongTasks.filter((entry) => entry.duration > 50).length,
					heapDeltaBytes:
						state.heapStartedAt === null || heapNow === null ? null : heapNow - state.heapStartedAt,
					heapPeakBytes: state.heapPeakBytes,
					heapSampleCount: state.heapSampleCount,
					heapSampleIntervalMs: HEAP_SAMPLE_INTERVAL_MS,
					heapSamplerOverheadMs: state.heapSamplerOverheadMs,
					publicationBatches: state.publicationBatches,
					turnNodes: document.querySelectorAll("[data-turn-id]").length,
				};
			},
		};
		Object.defineProperty(window, "__piwebBenchmark", { configurable: true, value: api });
	});
}

type BenchmarkWindow = typeof window & {
	__piwebBenchmarkRuntime: {
		abortTrial: () => BrowserReactTrialSnapshot;
		beginTrial: () => number;
		endTrial: () => BrowserReactTrialSnapshot;
		trialSnapshot: () => BrowserReactTrialSnapshot;
	};
	__piwebBenchmark: {
		resetSessionFrames: (sessionHandles: string[]) => void;
		sessionFrameSnapshot: (sessionHandle: string) => BrowserSessionFrameSnapshot | null;
		start: () => void;
		markStreamEnd: () => void;
		markSettled: () => void;
		snapshot: () => BrowserBenchmarkSnapshot;
	};
};

export async function resetBrowserSessionFrames(page: Page, sessionHandles: string[]): Promise<void> {
	await page.evaluate(
		(handles) => (window as BenchmarkWindow).__piwebBenchmark.resetSessionFrames(handles),
		sessionHandles,
	);
}

export async function browserSessionFrameSnapshot(
	page: Page,
	sessionHandle: string,
): Promise<BrowserSessionFrameSnapshot> {
	const snapshot = await page.evaluate(
		(handle) => (window as BenchmarkWindow).__piwebBenchmark.sessionFrameSnapshot(handle),
		sessionHandle,
	);
	if (!snapshot) throw new Error(`Browser frame observer is not tracking ${sessionHandle}`);
	return snapshot;
}

export async function startBrowserMeasurement(page: Page): Promise<void> {
	await page.evaluate(() => {
		const benchmarkWindow = window as BenchmarkWindow;
		if (!benchmarkWindow.__piwebBenchmarkRuntime) {
			throw new Error("benchmark React profiling runtime is unavailable");
		}
		benchmarkWindow.__piwebBenchmarkRuntime.beginTrial();
		benchmarkWindow.__piwebBenchmark.start();
	});
}

export async function markBrowserStreamEnd(page: Page): Promise<void> {
	await page.evaluate(() => (window as BenchmarkWindow).__piwebBenchmark.markStreamEnd());
}

export async function finishBrowserMeasurement(page: Page): Promise<BrowserBenchmarkMeasurement> {
	await page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	);
	return page.evaluate(() => {
		const benchmarkWindow = window as BenchmarkWindow;
		benchmarkWindow.__piwebBenchmark.markSettled();
		return {
			browser: benchmarkWindow.__piwebBenchmark.snapshot(),
			react: benchmarkWindow.__piwebBenchmarkRuntime.endTrial(),
		};
	});
}

export async function abortBrowserMeasurement(page: Page): Promise<void> {
	await page.evaluate(() => {
		const benchmarkWindow = window as BenchmarkWindow;
		benchmarkWindow.__piwebBenchmark.markSettled();
		benchmarkWindow.__piwebBenchmarkRuntime.abortTrial();
	});
}

export function correctnessFailureCount(trials: BenchmarkTrial[]): number {
	return trials.reduce(
		(total, trial) => total + Object.values(trial.correctness).filter((value) => !value).length,
		0,
	);
}
