import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readFrozenReferences } from "./benchmark-frozen-references.mjs";
import { BUDGET_POLICY, loadReferenceArchive, referenceSet } from "./benchmark-reference-evidence.mjs";
import {
	BENCHMARK_SCHEMA_VERSION,
	BENCHMARK_SUITE_VERSION,
	benchmarkMetricPolicy,
	canonicalFormalExpectedScenarioSet,
	loadBenchmarkMatrix,
	validateBenchmarkArtifacts,
} from "./performance-benchmark-validator.mjs";

const keyFor = (value) => `${value.domain}:${value.scenarioId ?? value.id}:${value.variant}`;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (left, right) => isDeepStrictEqual(Object.keys(left).sort(), Object.keys(right).sort());
const hash = (text) => createHash("sha256").update(text).digest("hex");

function evidenceErrors(bundle) {
	const errors = [];
	const { benchmark: run, manifest, environment } = bundle ?? {};
	if (!record(run) || !record(manifest) || !record(environment))
		return ["missing run, manifest or environment"];
	if (run.schemaVersion !== BENCHMARK_SCHEMA_VERSION || run.suiteVersion !== BENCHMARK_SUITE_VERSION)
		errors.push("unsupported run schema/suite");
	if (!Array.isArray(run.validationErrors) || run.validationErrors.length || run.playwrightExitCode !== 0)
		errors.push("formal run validation did not succeed");
	if (!run.runId || manifest.runId !== run.runId || environment.runId !== run.runId)
		errors.push("run identity mismatch");
	if (!Array.isArray(run.results) || !run.results.length) return [...errors, "empty results"];
	let expected;
	try {
		expected = canonicalFormalExpectedScenarioSet(loadBenchmarkMatrix(), run.tier);
	} catch {
		return [...errors, "unknown matrix tier"];
	}
	if (!isDeepStrictEqual(manifest.expectedScenarioSet, expected))
		errors.push("incomplete canonical scenario set");
	if (run.results.some((result) => !record(result))) return [...errors, "malformed scenario"];
	const actualKeys = run.results.map(keyFor).sort();
	if (!isDeepStrictEqual(actualKeys, expected.map(keyFor).sort()))
		errors.push("missing, duplicate or unexpected scenario");
	for (const result of run.results) {
		const key = keyFor(result);
		if (result.status !== "passed" || !Array.isArray(result.errors) || result.errors.length)
			errors.push(`${key}: unsuccessful scenario`);
		if (!record(result.summaries) || !Object.keys(result.summaries).length) {
			errors.push(`${key}: empty summaries`);
			continue;
		}
		const definition = expected.find((entry) => keyFor(entry) === key);
		const trials = Array.isArray(result.trials) ? result.trials : [];
		if (!definition || trials.length !== definition.warmups + definition.measured) {
			errors.push(`${key}: incomplete trial count`);
			continue;
		}
		for (const [index, trial] of trials.entries()) {
			if (!record(trial)) {
				errors.push(`${key}: malformed trial ${index}`);
				continue;
			}
			if (trial.index !== index || trial.warmup !== index < definition.warmups)
				errors.push(`${key}: invalid trial index/warmup ${index}`);
			if (
				!record(trial.metrics) ||
				!sameKeys(trial.metrics, result.summaries) ||
				Object.values(trial.metrics).some((value) => !Number.isFinite(value))
			)
				errors.push(`${key}: missing or invalid trial metrics`);
			if (
				!record(trial.correctness) ||
				trial.correctness.complete !== true ||
				Object.values(trial.correctness).some((value) => value !== true)
			)
				errors.push(`${key}: failed correctness`);
		}
		const measured = trials.filter((trial) => record(trial) && trial.warmup === false);
		if (measured.length !== definition.measured) {
			errors.push(`${key}: missing measured trials`);
			continue;
		}
		for (const [name, summary] of Object.entries(result.summaries)) {
			const values = measured.map((trial) => trial.metrics?.[name]).sort((a, b) => a - b);
			if (
				!record(summary) ||
				!benchmarkMetricPolicy(name) ||
				values.some((value) => !Number.isFinite(value))
			) {
				errors.push(`${key}: invalid metric ${name}`);
				continue;
			}
			const median = values[Math.floor(values.length / 2)];
			const expectedSummary = {
				count: values.length,
				min: values[0],
				max: values.at(-1),
				median: values.length % 2 ? median : (values[values.length / 2 - 1] + median) / 2,
				p95: values[Math.ceil(values.length * 0.95) - 1],
			};
			if (!isDeepStrictEqual(summary, expectedSummary)) errors.push(`${key}: invalid summary ${name}`);
		}
		if (
			!Array.isArray(result.gates) ||
			!result.gates.length ||
			result.gates.some((gate) => !record(gate) || (gate.mode === "hard" && gate.passed !== true))
		)
			errors.push(`${key}: missing or failed hard gates`);
	}
	return errors;
}

function missingMetadata(value) {
	if (record(value)) return !Object.keys(value).length || Object.values(value).some(missingMetadata);
	if (Array.isArray(value)) return !value.length || value.some(missingMetadata);
	return value === undefined || value === null || value === "" || value === "unavailable";
}

function compatibilityQuota(environment) {
	// The current producer reads CPU quotas from Linux cgroups only. Darwin's
	// explicit sentinel means inapplicable here; absent fields and Linux unknowns
	// still fail metadata validation. Do not modify the recorded evidence.
	if (environment.os === "darwin" && environment.quota?.cpu === "unavailable")
		return { cpu: "not-applicable:darwin-cgroups", memoryBytes: environment.quota.memoryBytes };
	return { cpu: environment.quota?.cpu, memoryBytes: environment.quota?.memoryBytes };
}

function compatibility(bundle) {
	const { environment: e, manifest: m, benchmark: b } = bundle;
	return {
		environment: Object.fromEntries(
			[
				"os",
				"kernel",
				"architecture",
				"cpu",
				"quota",
				"memory",
				"image",
				"node",
				"pnpm",
				"playwright",
				"chromium",
			].map((key) => [key, key === "quota" ? compatibilityQuota(e) : e[key]]),
		),
		workload: Object.fromEntries(
			[
				"matrix",
				"fixtureHashes",
				"lockfileHash",
				"seed",
				"expectedScenarioSet",
				"warmupCounts",
				"measuredCounts",
			].map((key) => [key, m[key]]),
		),
		schemaVersion: b.schemaVersion,
		suiteVersion: b.suiteVersion,
		tier: b.tier,
		parameters: b.results.map((result) => [keyFor(result), result.parameters]).sort(),
	};
}

function compatibilityDifferences(target, baseline) {
	const differences = [];
	const left = compatibility(target);
	const right = compatibility(baseline);
	for (const group of Object.keys(left)) {
		if (!isDeepStrictEqual(left[group], right[group])) differences.push(`${group} differs`);
	}
	for (const group of [left.environment, left.workload, right.environment, right.workload]) {
		if (missingMetadata(group)) differences.push("missing compatibility metadata");
	}
	return differences;
}

/** Compare complete run bundles. This supplements, and never replaces, formal raw validation. */
export function compareBenchmarkBaseline(target, baseline) {
	const errors = evidenceErrors(target);
	const legacy = record(baseline?.scenarios) && !baseline.benchmark;
	if (legacy && !Object.keys(baseline.scenarios).length) errors.push("empty historical baseline");
	if (!legacy) errors.push(...evidenceErrors(baseline).map((error) => `baseline: ${error}`));
	const comparison = {
		status: "INVALID",
		errors,
		incompatibilities: [],
		metrics: [],
		runId: target?.benchmark?.runId ?? "unknown",
	};
	if (errors.length) return comparison;
	if (legacy) {
		comparison.status = "INCOMPATIBLE";
		comparison.incompatibilities.push(
			"historical calibration lacks exact workload/environment provenance and uses the old metric policy",
		);
		return comparison;
	}
	comparison.incompatibilities = compatibilityDifferences(target, baseline);
	for (const result of target.benchmark.results) {
		const previous = baseline.benchmark.results.find((entry) => keyFor(entry) === keyFor(result));
		if (previous && !sameKeys(result.summaries, previous.summaries))
			comparison.errors.push(`${keyFor(result)}: missing comparison metric`);
	}
	if (comparison.errors.length) return comparison;
	if (comparison.incompatibilities.length) {
		comparison.status = "INCOMPATIBLE";
		return comparison;
	}
	for (const result of target.benchmark.results) {
		const previous = baseline.benchmark.results.find((entry) => keyFor(entry) === keyFor(result));
		for (const [name, summary] of Object.entries(result.summaries)) {
			const policy = benchmarkMetricPolicy(name);
			if (policy.mode === "hard" || policy.direction === "none") continue;
			const reference = previous.summaries[name].median;
			const threshold =
				policy.direction === "higher"
					? reference / 1.5
					: reference + Math.abs(reference) * 0.5 + policy.floor;
			const regression =
				policy.direction === "higher" ? summary.median < threshold : summary.median > threshold;
			comparison.metrics.push({
				scenario: keyFor(result),
				name,
				...policy,
				actual: summary.median,
				reference,
				threshold,
				status: regression ? "REGRESSION" : "OK",
			});
		}
	}
	comparison.status = comparison.metrics.some((metric) => metric.status === "REGRESSION")
		? "REGRESSION"
		: comparison.metrics.length
			? "OK"
			: "INVALID";
	if (!comparison.metrics.length) comparison.errors.push("no diagnostic metrics evaluated");
	return comparison;
}

export function generateComparisonMarkdown(comparison) {
	return [
		"# Performance Benchmark Comparison",
		"",
		`- Target Run: ${comparison.runId}`,
		`- Status: ${comparison.status}`,
		"",
		"Timing/resource regressions are diagnostic. Correctness remains a formal hard gate. OK is not a raw-artifact validation certificate.",
		"",
		...comparison.errors.map((error) => `- INVALID: ${error}`),
		...comparison.incompatibilities.map((reason) => `- INCOMPATIBLE: ${reason}`),
		"",
		"| Scenario | Metric | Unit | Direction | Actual median | Reference median | Threshold | Status |",
		"| --- | --- | --- | --- | ---: | ---: | ---: | --- |",
		...comparison.metrics.map(
			(m) =>
				`| ${m.scenario} | ${m.name} | ${m.unit} | ${m.direction} | ${m.actual} | ${m.reference} | ${m.threshold} | ${m.status} |`,
		),
		"",
	].join("\n");
}

function readBundle(target) {
	const resolved = path.resolve(target);
	const filename = fs.statSync(resolved).isDirectory() ? path.join(resolved, "benchmark.json") : resolved;
	const benchmark = JSON.parse(fs.readFileSync(filename, "utf8"));
	if (record(benchmark.scenarios)) return benchmark;
	const directory = path.dirname(filename);
	const manifestText = fs.readFileSync(path.join(directory, "manifest.json"), "utf8");
	const environmentText = fs.readFileSync(path.join(directory, "environment.json"), "utf8");
	if (hash(manifestText) !== benchmark.manifestHash || hash(environmentText) !== benchmark.environmentHash)
		throw new Error("manifest/environment hashes do not match the run");
	return { benchmark, manifest: JSON.parse(manifestText), environment: JSON.parse(environmentText) };
}

export const STRICT_SERIES = Object.freeze(
	[
		["streaming", "stream-1m", "totalCompletionMs"],
		["concurrency", "sessions-4", "totalCompletionMs"],
		["content", "content-roundtrip", "roundTripMs"],
	].flatMap(([domain, scenario, name]) =>
		["coalesced", "sequential"].map((variant) => ({ scenario: `${domain}:${scenario}:${variant}`, name })),
	),
);

export function readCompleteBundle(directory) {
	const bundle = readBundle(directory);
	if (!fs.statSync(directory).isDirectory())
		throw new Error("strict evaluation requires a full run directory");
	const artifacts = [],
		rawArtifacts = [];
	let bytes = 0,
		count = 0;
	const visit = (relative = "") => {
		for (const entry of fs.readdirSync(path.join(directory, "raw", relative), { withFileTypes: true })) {
			const name = path.posix.join(relative, entry.name);
			if (entry.isDirectory()) {
				visit(name);
				continue;
			}
			if (!entry.isFile() || !name.endsWith(".json")) throw new Error("unexpected raw evidence entry");
			const filename = path.join(directory, "raw", name);
			bytes += fs.statSync(filename).size;
			if (++count > 2048 || bytes > 128 * 1024 * 1024) throw new Error("raw evidence exceeds read budget");
			const artifact = { name, value: JSON.parse(fs.readFileSync(filename, "utf8")) };
			(name.endsWith(".result.json") ? artifacts : rawArtifacts).push(artifact);
		}
	};
	visit();
	const validation = validateBenchmarkArtifacts({
		matrix: loadBenchmarkMatrix(),
		tier: bundle.benchmark.tier,
		runId: bundle.benchmark.runId,
		artifacts,
		rawArtifacts,
		manifest: bundle.manifest,
		environment: bundle.environment,
		playwrightExitCode: bundle.benchmark.playwrightExitCode,
	});
	if (validation.errors.length) throw new Error(validation.errors.join("; "));
	if (!isDeepStrictEqual(validation.results, bundle.benchmark.results))
		throw new Error("raw result files differ from benchmark results");
	return bundle;
}

/** Inputs must include full raw validation; the CLI enforces this with readCompleteBundle. */
export function evaluateStrictBudgets(target, references) {
	const result = {
		status: "INVALID",
		runId: target?.benchmark?.runId ?? "unknown",
		errors: [],
		incompatibilities: [],
		comparisons: [],
	};
	if (!Array.isArray(references) || references.length !== 2) {
		result.errors.push("two fixed references are required");
		return result;
	}
	for (const [index, bundle] of [target, ...references].entries()) {
		result.errors.push(...evidenceErrors(bundle).map((error) => `input ${index}: ${error}`));
		for (const series of STRICT_SERIES) {
			const median = bundle?.benchmark?.results?.find((entry) => keyFor(entry) === series.scenario)
				?.summaries?.[series.name]?.median;
			if (!Number.isFinite(median) || median < 0)
				result.errors.push(`input ${index}: missing/nonnegative median ${series.scenario}/${series.name}`);
		}
	}
	if (new Set([target, ...references].map((bundle) => bundle?.benchmark?.runId)).size !== 3)
		result.errors.push("target and fixed reference run IDs must be distinct");
	if (result.errors.length) return result;
	const comparisons = references.map((reference) => compareBenchmarkBaseline(target, reference));
	result.errors.push(...comparisons.flatMap((comparison) => comparison.errors));
	if (result.errors.length) return result;
	result.incompatibilities = comparisons.flatMap((comparison, index) =>
		comparison.incompatibilities.map((reason) => `reference-${index + 1}: ${reason}`),
	);
	if (result.incompatibilities.length) {
		result.status = "INCOMPATIBLE";
		return result;
	}
	result.comparisons = comparisons.map((comparison, index) => ({
		reference: references[index].benchmark.runId,
		metrics: comparison.metrics
			.filter((metric) =>
				STRICT_SERIES.some((series) => series.scenario === metric.scenario && series.name === metric.name),
			)
			.map((metric) => {
				const threshold = 1.5 * metric.reference + 50;
				return { ...metric, threshold, status: metric.actual > threshold ? "REGRESSION" : "OK" };
			}),
		diagnostic: comparison,
	}));
	if (result.comparisons.some((comparison) => comparison.metrics.length !== 6)) {
		result.errors.push("six budget metrics required per reference");
		return result;
	}
	result.status = result.comparisons.some((comparison) =>
		comparison.metrics.some((metric) => metric.status === "REGRESSION"),
	)
		? "REGRESSION"
		: "OK";
	return result;
}

export function runStrictEvaluation(targetDirectory, description, environment, localArchive) {
	const target = readCompleteBundle(targetDirectory);
	const errors = evidenceErrors(target);
	if (errors.length) throw new Error(errors.join("; "));
	const set = referenceSet(description, environment);
	if (set.status === "pending")
		return {
			status: "UNBUDGETED",
			runId: target.benchmark.runId,
			errors: [],
			incompatibilities: [],
			comparisons: [],
		};
	const archive = loadReferenceArchive(set, environment, localArchive);
	try {
		const references = readFrozenReferences(set, archive.directory);
		if (new Set([target, ...references].map((bundle) => bundle.benchmark.runId)).size !== 3)
			throw new Error("target and fixed reference run IDs must be distinct");
		const incompatibilities = references.flatMap((reference, index) =>
			compatibilityDifferences(target, reference).map((reason) => `reference-${index + 1}: ${reason}`),
		);
		if (incompatibilities.length)
			return {
				status: "INCOMPATIBLE",
				runId: target.benchmark.runId,
				errors: [],
				incompatibilities,
				comparisons: [],
			};
		return evaluateStrictBudgets(target, references);
	} finally {
		archive.dispose();
	}
}

export function generateStrictMarkdown(result) {
	const message =
		result.status === "UNBUDGETED"
			? "性能预算未评估：参考尚未建立 / references pending"
			: result.status === "INCOMPATIBLE"
				? "性能预算未评估：参考环境或工作负载不相容 / incompatible references"
				: `Performance budget: ${result.status}`;
	return [
		"# Completion median budget",
		"",
		`- Policy: ${BUDGET_POLICY}`,
		`- Target: ${result.runId}`,
		`- ${message}`,
		"- Six medians, two fixed references; each threshold = 1.5 × reference + 50 ms. Other metrics are diagnostic.",
		...result.errors.map((error) => `- INVALID: ${error}`),
		...result.incompatibilities.map((reason) => `- ${reason}`),
		...result.comparisons.flatMap((comparison) => [
			"",
			`## Reference ${comparison.reference}`,
			"| Scenario | Metric | Actual ms | Reference ms | Threshold ms | Status |",
			"| --- | --- | ---: | ---: | ---: | --- |",
			...comparison.metrics.map(
				(m) => `| ${m.scenario} | ${m.name} | ${m.actual} | ${m.reference} | ${m.threshold} | ${m.status} |`,
			),
			"",
			generateComparisonMarkdown(comparison.diagnostic),
		]),
		"",
	].join("\n");
}

export function main(args = process.argv.slice(2)) {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(
			"Usage: node scripts/compare-benchmark-baseline.mjs <run-dir-or-json> --baseline <run-dir-or-json>\nStrict: <run-dir> --strict --references <description.json> --environment <actions|local> [--archive <local-cohort.zip>]\n",
		);
		return 0;
	}
	try {
		if (args[1] === "--strict") {
			if (
				![6, 8].includes(args.length) ||
				args[2] !== "--references" ||
				args[4] !== "--environment" ||
				(args.length === 8 && args[6] !== "--archive")
			)
				throw new Error("invalid strict evaluation arguments");
			const result = runStrictEvaluation(
				args[0],
				JSON.parse(fs.readFileSync(args[3], "utf8")),
				args[5],
				args[7],
			);
			process.stdout.write(generateStrictMarkdown(result));
			return ["INVALID", "REGRESSION"].includes(result.status) ? 1 : 0;
		}
		if (args.length !== 3 || args[1] !== "--baseline")
			throw new Error("provide a target run and --baseline run directory or JSON");
		const comparison = compareBenchmarkBaseline(readBundle(args[0]), readBundle(args[2]));
		process.stdout.write(generateComparisonMarkdown(comparison));
		return comparison.status === "INVALID" ? 1 : comparison.status === "INCOMPATIBLE" ? 2 : 0;
	} catch (error) {
		process.stderr.write(`INVALID: ${error.message}\n`);
		return 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
