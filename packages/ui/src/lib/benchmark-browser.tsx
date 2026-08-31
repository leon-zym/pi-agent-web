import { Profiler, type ReactNode, StrictMode } from "react";
import type { Root } from "react-dom/client";

export type BenchmarkPublicationVariant = "coalesced" | "sequential";

interface BenchmarkCommit {
	actualDuration: number;
	baseDuration: number;
	commitTime: number;
	phase: "mount" | "nested-update" | "update";
}

interface BenchmarkBrowserRuntime {
	commits: BenchmarkCommit[];
	publicationVariant: BenchmarkPublicationVariant;
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

function installSequentialFrameClock(): void {
	const scheduled = new Map<number, () => void>();
	const requestFrame = window.requestAnimationFrame.bind(window);
	const cancelFrame = window.cancelAnimationFrame.bind(window);
	let nextHandle = 1;
	window.requestAnimationFrame = (callback) => {
		const handle = nextHandle;
		nextHandle += 1;
		scheduled.set(handle, () => callback(performance.now()));
		queueMicrotask(() => {
			const pending = scheduled.get(handle);
			if (!pending) return;
			scheduled.delete(handle);
			pending();
		});
		return handle;
	};
	window.cancelAnimationFrame = (handle) => {
		if (scheduled.delete(handle)) return;
		cancelFrame(handle);
	};
	// Keep both native bindings reachable for a debugger without exposing a product API.
	void requestFrame;
}

function installBenchmarkRuntime(): BenchmarkBrowserRuntime {
	if (import.meta.env.VITE_PI_WEB_BENCHMARK_BUILD !== "1") {
		throw new Error("Benchmark instrumentation cannot run outside a benchmark build");
	}
	const runtime: BenchmarkBrowserRuntime = {
		commits: [],
		publicationVariant: benchmarkVariant(),
	};
	if (runtime.publicationVariant === "sequential") installSequentialFrameClock();
	window.__piwebBenchmarkRuntime = runtime;
	return runtime;
}

/**
 * This root exists only in a Vite benchmark build. The normal production entry never imports the
 * module, so profiler collection and the sequential publication clock do not enter that bundle.
 */
export function renderBenchmarkRoot(root: Root, children: ReactNode): void {
	const runtime = installBenchmarkRuntime();
	root.render(
		<StrictMode>
			<Profiler
				id="piweb-benchmark-root"
				onRender={(_id, phase, actualDuration, baseDuration, _startTime, commitTime) => {
					runtime.commits.push({ actualDuration, baseDuration, commitTime, phase });
				}}
			>
				{children}
			</Profiler>
		</StrictMode>,
	);
}
