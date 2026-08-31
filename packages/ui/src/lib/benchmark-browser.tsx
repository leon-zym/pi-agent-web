import { Profiler, type ReactNode, StrictMode } from "react";
import type { Root } from "react-dom/client";

export type BenchmarkPublicationVariant = "coalesced" | "sequential";

export interface BenchmarkReactTrialSnapshot {
	actualDurationMs: number;
	baseDurationMs: number;
	commitCount: number;
	maxCommitDurationMs: number;
	epoch: number;
}

interface BenchmarkReactTrialState extends BenchmarkReactTrialSnapshot {
	active: boolean;
}

interface BenchmarkBrowserRuntime {
	abortTrial: () => Readonly<BenchmarkReactTrialSnapshot>;
	beginTrial: () => number;
	endTrial: () => Readonly<BenchmarkReactTrialSnapshot>;
	publicationVariant: BenchmarkPublicationVariant;
	trialSnapshot: () => Readonly<BenchmarkReactTrialSnapshot>;
}

interface InstalledBenchmarkRuntime {
	recordCommit: (actualDuration: number, baseDuration: number) => void;
	runtime: BenchmarkBrowserRuntime;
}

declare global {
	interface Window {
		__piwebBenchmarkRuntime?: BenchmarkBrowserRuntime;
	}
}

function benchmarkVariant(): BenchmarkPublicationVariant {
	const value = import.meta.env.VITE_PI_WEB_BENCHMARK_VARIANT;
	if (value === "coalesced" || value === "sequential") return value;
	throw new Error("A benchmark Browser build requires a supported publication variant");
}

function immutableSnapshot(state: BenchmarkReactTrialState): Readonly<BenchmarkReactTrialSnapshot> {
	return Object.freeze({
		actualDurationMs: state.actualDurationMs,
		baseDurationMs: state.baseDurationMs,
		commitCount: state.commitCount,
		maxCommitDurationMs: state.maxCommitDurationMs,
		epoch: state.epoch,
	});
}

function installBenchmarkRuntime(): InstalledBenchmarkRuntime {
	if (import.meta.env.VITE_PI_WEB_BENCHMARK_BUILD !== "1") {
		throw new Error("Benchmark instrumentation cannot run outside a benchmark build");
	}
	const trial: BenchmarkReactTrialState = {
		active: false,
		actualDurationMs: 0,
		baseDurationMs: 0,
		commitCount: 0,
		epoch: 0,
		maxCommitDurationMs: 0,
	};
	const runtime: BenchmarkBrowserRuntime = {
		publicationVariant: benchmarkVariant(),
		beginTrial: () => {
			trial.active = true;
			trial.actualDurationMs = 0;
			trial.baseDurationMs = 0;
			trial.commitCount = 0;
			trial.maxCommitDurationMs = 0;
			trial.epoch += 1;
			return trial.epoch;
		},
		endTrial: () => {
			trial.active = false;
			return immutableSnapshot(trial);
		},
		abortTrial: () => {
			trial.active = false;
			return immutableSnapshot(trial);
		},
		trialSnapshot: () => immutableSnapshot(trial),
	};
	window.__piwebBenchmarkRuntime = runtime;
	return {
		runtime,
		recordCommit: (actualDuration, baseDuration) => {
			if (!trial.active) return;
			trial.actualDurationMs += actualDuration;
			trial.baseDurationMs += baseDuration;
			trial.commitCount += 1;
			trial.maxCommitDurationMs = Math.max(trial.maxCommitDurationMs, actualDuration);
		},
	};
}

/**
 * This root exists only in a Vite benchmark build. The normal production entry never imports the
 * module, so profiling collection and its Browser-only runtime do not enter the standard bundle.
 */
export function renderBenchmarkRoot(root: Root, children: ReactNode): void {
	const { recordCommit } = installBenchmarkRuntime();
	root.render(
		<StrictMode>
			<Profiler
				id="piweb-benchmark-root"
				onRender={(_id, _phase, actualDuration, baseDuration) => {
					recordCommit(actualDuration, baseDuration);
				}}
			>
				{children}
			</Profiler>
		</StrictMode>,
	);
}
