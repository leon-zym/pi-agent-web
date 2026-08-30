import fs from "node:fs";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import matrix from "./matrix.json" with { type: "json" };

export type BenchmarkTier = "representative" | "stress";
export type BenchmarkKind =
	| "streaming"
	| "concurrency"
	| "history"
	| "recovery-disconnect"
	| "recovery-crash"
	| "content-roundtrip";

export interface BenchmarkScenario {
	id: string;
	kind: BenchmarkKind;
	warmups: number;
	samples: number;
	targetBytes?: number;
	chunkBytes?: number;
	chunkDelayMs?: number;
	sessions?: number;
	sourceBytes?: number;
	turns?: number;
	inputBytes?: number;
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

export interface BenchmarkScenarioResult {
	schemaVersion: 1;
	tier: BenchmarkTier;
	scenarioId: string;
	kind: BenchmarkKind;
	status: "passed" | "failed";
	startedAt: string;
	finishedAt: string;
	browserVersion: string;
	parameters: BenchmarkScenario;
	trials: BenchmarkTrial[];
	summaries: Record<string, BenchmarkMetricSummary>;
	gates: BenchmarkGate[];
	notes: string[];
	errors: string[];
}

interface BrowserBenchmarkSnapshot {
	inputToPublicationMs: number | null;
	inputToNextPaintMs: number | null;
	streamDurationMs: number | null;
	settlementMs: number | null;
	totalCompletionMs: number | null;
	liveLongTaskMaxMs: number;
	liveLongTasksOver50Ms: number;
	heapDeltaBytes: number | null;
	publicationBatches: number;
	turnNodes: number;
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

export function benchmarkTier(): BenchmarkTier {
	const value = process.env.PI_WEB_BENCHMARK_TIER;
	if (!isTier(value)) {
		throw new Error("PI_WEB_BENCHMARK_TIER must be representative or stress");
	}
	return value;
}

export function scenariosFor(kind: BenchmarkKind): BenchmarkScenario[] {
	const tier = benchmarkTier();
	return (matrix.tiers[tier].scenarios as BenchmarkScenario[]).filter((scenario) => scenario.kind === kind);
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
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function rawDirectory(): string {
	const directory = process.env.PI_WEB_BENCHMARK_RAW_DIR;
	if (!directory || !path.isAbsolute(directory)) {
		throw new Error("PI_WEB_BENCHMARK_RAW_DIR must be an absolute path");
	}
	return directory;
}

export async function runBenchmarkScenario(
	page: Page,
	testInfo: TestInfo,
	scenario: BenchmarkScenario,
	execute: (outcome: BenchmarkOutcome) => Promise<void>,
): Promise<void> {
	const tier = benchmarkTier();
	const startedAt = new Date().toISOString();
	const outcome: BenchmarkOutcome = { trials: [], gates: [], notes: [] };
	const errors: string[] = [];
	try {
		await execute(outcome);
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
	const result: BenchmarkScenarioResult = {
		schemaVersion: 1,
		tier,
		scenarioId: scenario.id,
		kind: scenario.kind,
		status: errors.length === 0 ? "passed" : "failed",
		startedAt,
		finishedAt: new Date().toISOString(),
		browserVersion: page.context().browser()?.version() ?? "unknown",
		parameters: scenario,
		trials: outcome.trials,
		summaries: summariesFor(outcome.trials),
		gates: outcome.gates,
		notes: outcome.notes,
		errors,
	};
	const directory = rawDirectory();
	fs.mkdirSync(directory, { recursive: true });
	const resultPath = path.join(directory, `${scenario.id}.json`);
	fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
	await testInfo.attach(`${scenario.id}.json`, {
		path: resultPath,
		contentType: "application/json",
	});
	if (errors.length > 0) throw new Error(errors.join("\n"));
}

export async function installBrowserBenchmarkObserver(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const getUsedHeap = () => {
			const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
			return memory?.usedJSHeapSize ?? null;
		};
		const collectGarbage = () => {
			(globalThis as typeof globalThis & { gc?: () => void }).gc?.();
		};
		const state = {
			active: false,
			startedAt: 0,
			firstPublicationAt: null as number | null,
			firstPaintAt: null as number | null,
			streamEndedAt: null as number | null,
			settledAt: null as number | null,
			heapStartedAt: null as number | null,
			publicationBatches: 0,
			longTasks: [] as Array<{ startTime: number; duration: number }>,
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
				collectGarbage();
				state.active = true;
				state.startedAt = performance.now();
				state.firstPublicationAt = null;
				state.firstPaintAt = null;
				state.streamEndedAt = null;
				state.settledAt = null;
				state.heapStartedAt = getUsedHeap();
				state.publicationBatches = 0;
				state.longTasks.length = 0;
			},
			markStreamEnd: () => {
				state.streamEndedAt = performance.now();
			},
			markSettled: () => {
				state.settledAt = performance.now();
				state.active = false;
			},
			snapshot: (): BrowserBenchmarkSnapshot => {
				collectGarbage();
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
					publicationBatches: state.publicationBatches,
					turnNodes: document.querySelectorAll("[data-turn-id]").length,
				};
			},
		};
		Object.defineProperty(window, "__piwebBenchmark", { configurable: true, value: api });
	});
}

type BenchmarkWindow = typeof window & {
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
	await page.evaluate(() => (window as BenchmarkWindow).__piwebBenchmark.start());
}

export async function markBrowserStreamEnd(page: Page): Promise<void> {
	await page.evaluate(() => (window as BenchmarkWindow).__piwebBenchmark.markStreamEnd());
}

export async function finishBrowserMeasurement(page: Page): Promise<BrowserBenchmarkSnapshot> {
	await page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	);
	await page.evaluate(() => (window as BenchmarkWindow).__piwebBenchmark.markSettled());
	return page.evaluate(() => (window as BenchmarkWindow).__piwebBenchmark.snapshot());
}

export function correctnessFailureCount(trials: BenchmarkTrial[]): number {
	return trials.reduce(
		(total, trial) => total + Object.values(trial.correctness).filter((value) => !value).length,
		0,
	);
}
