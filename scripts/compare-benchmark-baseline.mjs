import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const defaultBaselinePath = path.join(
	repositoryRoot,
	"tests/e2e/benchmarks/baselines/reference-linux-x64.json",
);

function formatNumber(value) {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	if (Number.isInteger(value)) return value.toLocaleString("en-US");
	return Number(value.toFixed(2)).toLocaleString("en-US");
}

function formatDelta(diff) {
	if (diff === null || diff === undefined || !Number.isFinite(diff)) return "—";
	const prefix = diff > 0 ? "+" : "";
	const formatted = Number.isInteger(diff)
		? diff.toLocaleString("en-US")
		: Number(diff.toFixed(2)).toLocaleString("en-US");
	return `${prefix}${formatted}`;
}

function formatPercent(pct) {
	if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
	const prefix = pct > 0 ? "+" : "";
	return `${prefix}${pct.toFixed(1)}%`;
}

export function compareBenchmarkBaseline(benchmark, baselineData) {
	const results = Array.isArray(benchmark?.results) ? benchmark.results : [];
	const baselineScenarios = baselineData?.scenarios ?? {};

	const scenarioComparisons = [];
	const warnings = [];
	let totalMetricsEvaluated = 0;

	for (const result of results) {
		const scenarioKey = `${result.domain}:${result.scenarioId}:${result.variant}`;
		const baselineScenario = baselineScenarios[scenarioKey];

		const metricComparisons = [];
		const summaries = result.summaries ?? {};

		const metricKeys = new Set([
			...Object.keys(summaries),
			...(baselineScenario?.metrics ? Object.keys(baselineScenario.metrics) : []),
		]);

		const sortedMetricKeys = [...metricKeys].sort();

		for (const metricName of sortedMetricKeys) {
			totalMetricsEvaluated++;
			const observedSummary = summaries[metricName];
			const baselineMetric = baselineScenario?.metrics?.[metricName];

			const actual = observedSummary?.median ?? null;
			const baselineMedian = baselineMetric?.maxMedian ?? null;
			const threshold = baselineMetric?.threshold ?? null;

			let diff = null;
			let pctDiff = null;
			let isWarning = false;
			let status = "OK";

			if (actual !== null && baselineMedian !== null) {
				diff = actual - baselineMedian;
				if (baselineMedian !== 0) {
					pctDiff = (diff / baselineMedian) * 100;
				} else {
					pctDiff = diff === 0 ? 0 : null;
				}
			}

			if (actual !== null && threshold !== null) {
				if (actual > threshold) {
					isWarning = true;
					status = "WARNING";
					warnings.push({
						scenarioKey,
						domain: result.domain,
						scenarioId: result.scenarioId,
						variant: result.variant,
						metricName,
						actual,
						baselineMedian,
						threshold,
						diff,
						pctDiff,
						exceededBy: actual - threshold,
					});
				}
			} else if (baselineMetric === undefined) {
				status = "UNTRACKED";
			} else if (actual === null) {
				status = "MISSING";
			}

			metricComparisons.push({
				metricName,
				actual,
				baselineMedian,
				threshold,
				diff,
				pctDiff,
				isWarning,
				status,
			});
		}

		scenarioComparisons.push({
			scenarioKey,
			domain: result.domain,
			scenarioId: result.scenarioId,
			variant: result.variant,
			metrics: metricComparisons,
			hasBaseline: Boolean(baselineScenario),
		});
	}

	return {
		runId: benchmark?.runId ?? "unknown",
		tier: benchmark?.tier ?? "unknown",
		profileId: baselineData?.profileId ?? "unknown",
		baselineRuns: baselineData?.provenanceRuns ?? [],
		formula: baselineData?.formula ?? "",
		scenarios: scenarioComparisons,
		warnings,
		totalScenarios: scenarioComparisons.length,
		totalMetrics: totalMetricsEvaluated,
	};
}

export function generateComparisonMarkdown(comparison) {
	const lines = [
		"# Performance Benchmark Baseline Comparison",
		"",
		`- Target Run: \`${comparison.runId}\``,
		`- Tier: \`${comparison.tier}\``,
		`- Baseline Profile: \`${comparison.profileId}\``,
		`- Total Scenarios Evaluated: ${String(comparison.totalScenarios)}`,
		`- Total Metrics Evaluated: ${String(comparison.totalMetrics)}`,
		`- Status: ${comparison.warnings.length === 0 ? "PASSED (No threshold regressions)" : `WARNING (${String(comparison.warnings.length)} metric(s) exceeded threshold)`}`,
		"",
	];

	if (comparison.warnings.length > 0) {
		lines.push(
			"## ⚠️ Threshold Warnings",
			"",
			"| Scenario | Metric | Actual Median | Baseline Median | Threshold | Exceeded By |",
			"| :--- | :--- | ---: | ---: | ---: | ---: |",
		);
		for (const w of comparison.warnings) {
			lines.push(
				`| \`${w.scenarioKey}\` | \`${w.metricName}\` | ${formatNumber(w.actual)} | ${formatNumber(w.baselineMedian)} | ${formatNumber(w.threshold)} | +${formatNumber(w.exceededBy)} |`,
			);
		}
		lines.push("");
	} else {
		lines.push("> ✅ All observed scenario medians are within calibrated baseline thresholds.", "");
	}

	lines.push("## Scenario Details", "");

	for (const scenario of comparison.scenarios) {
		lines.push(`### \`${scenario.scenarioKey}\``, "");
		if (!scenario.hasBaseline) {
			lines.push("> *No baseline profile entry calibrated for this scenario.*", "");
			continue;
		}

		lines.push(
			"| Metric | Actual Median | Baseline Median | Delta | Delta % | Threshold | Status |",
			"| :--- | ---: | ---: | ---: | ---: | ---: | :---: |",
		);
		for (const m of scenario.metrics) {
			const statusBadge = m.isWarning ? "⚠️ WARNING" : m.status;
			lines.push(
				`| \`${m.metricName}\` | ${formatNumber(m.actual)} | ${formatNumber(m.baselineMedian)} | ${formatDelta(m.diff)} | ${formatPercent(m.pctDiff)} | ${formatNumber(m.threshold)} | ${statusBadge} |`,
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function parseArgs(args) {
	let target = null;
	let baseline = null;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			return { help: true, target: null, baseline: null };
		}
		if (arg === "--baseline") {
			i++;
			if (i < args.length) {
				baseline = args[i];
			}
		} else if (arg.startsWith("--baseline=")) {
			baseline = arg.slice("--baseline=".length);
		} else if (!arg.startsWith("-")) {
			if (!target) {
				target = arg;
			}
		}
	}

	return { help: false, target, baseline };
}

export function main() {
	const args = process.argv.slice(2);
	const parsed = parseArgs(args);

	if (parsed.help || !parsed.target) {
		process.stdout.write(
			"Usage: node scripts/compare-benchmark-baseline.mjs <path-to-benchmark-dir-or-benchmark.json> [--baseline <path-to-baseline.json>]\n",
		);
		return 0;
	}

	const resolvedTarget = path.resolve(process.cwd(), parsed.target);
	let benchmarkFile = resolvedTarget;
	let isDir = false;

	try {
		const stat = fs.statSync(resolvedTarget);
		if (stat.isDirectory()) {
			isDir = true;
			benchmarkFile = path.join(resolvedTarget, "benchmark.json");
		}
	} catch (error) {
		process.stderr.write(`Target path does not exist: ${resolvedTarget} (${error.message})\n`);
		return 0;
	}

	if (!fs.existsSync(benchmarkFile)) {
		process.stderr.write(`Benchmark JSON file not found at: ${benchmarkFile}\n`);
		return 0;
	}

	const resolvedBaseline = parsed.baseline
		? path.resolve(process.cwd(), parsed.baseline)
		: defaultBaselinePath;

	if (!fs.existsSync(resolvedBaseline)) {
		process.stderr.write(`Baseline JSON file not found at: ${resolvedBaseline}\n`);
		return 0;
	}

	let benchmark;
	try {
		benchmark = JSON.parse(fs.readFileSync(benchmarkFile, "utf8"));
	} catch (error) {
		process.stderr.write(`Failed to parse benchmark JSON at ${benchmarkFile}: ${error.message}\n`);
		return 0;
	}

	let baselineData;
	try {
		baselineData = JSON.parse(fs.readFileSync(resolvedBaseline, "utf8"));
	} catch (error) {
		process.stderr.write(`Failed to parse baseline JSON at ${resolvedBaseline}: ${error.message}\n`);
		return 0;
	}

	const comparison = compareBenchmarkBaseline(benchmark, baselineData);
	const markdown = generateComparisonMarkdown(comparison);

	process.stdout.write(`${markdown}\n`);

	if (isDir) {
		const comparisonFilePath = path.join(resolvedTarget, "benchmark-comparison.md");
		try {
			fs.writeFileSync(comparisonFilePath, `${markdown}\n`, "utf8");
		} catch (error) {
			process.stderr.write(`Failed to write comparison file to ${comparisonFilePath}: ${error.message}\n`);
		}
	}

	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = main();
}
