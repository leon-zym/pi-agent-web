import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	BENCHMARK_SCHEMA_VERSION,
	BENCHMARK_SUITE_VERSION,
	benchmarkMetricPolicy,
	canonicalFormalExpectedScenarioSet,
	loadBenchmarkMatrix,
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
		suiteVersion: b.suiteVersion,
		tier: b.tier,
		parameters: b.results.map((result) => [keyFor(result), result.parameters]).sort(),
	};
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
	const left = compatibility(target);
	const right = compatibility(baseline);
	for (const group of Object.keys(left)) {
		if (!isDeepStrictEqual(left[group], right[group])) comparison.incompatibilities.push(`${group} differs`);
	}
	for (const group of [left.environment, left.workload, right.environment, right.workload]) {
		if (missingMetadata(group)) comparison.incompatibilities.push("missing compatibility metadata");
	}
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

export function main(args = process.argv.slice(2)) {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(
			"Usage: node scripts/compare-benchmark-baseline.mjs <run-dir-or-json> --baseline <run-dir-or-json>\n",
		);
		return 0;
	}
	try {
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
