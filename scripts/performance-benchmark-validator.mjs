import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const BENCHMARK_SCHEMA_VERSION = 2;
export const BENCHMARK_SUITE_VERSION = 2;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const defaultMatrixPath = path.join(repositoryRoot, "tests/e2e/benchmarks/matrix.json");

const RESULT_KEYS = [
	"browserVersion",
	"capabilities",
	"domain",
	"errors",
	"finishedAt",
	"gates",
	"kind",
	"notes",
	"parameters",
	"runId",
	"scenarioId",
	"schemaVersion",
	"startedAt",
	"status",
	"suiteVersion",
	"summaries",
	"tier",
	"trials",
	"variant",
];
const RAW_TRIAL_KEYS = [
	"capabilities",
	"domain",
	"kind",
	"parameters",
	"runId",
	"scenarioId",
	"schemaVersion",
	"suiteVersion",
	"tier",
	"trial",
	"variant",
];
const TRIAL_KEYS = ["correctness", "index", "metrics", "warmup"];
const SUMMARY_KEYS = ["count", "max", "median", "min", "p95"];
const GATE_KEYS = ["actual", "comparison", "metric", "mode", "passed", "rationale", "statistic", "threshold"];
const ROOT_MATRIX_KEYS = ["domains", "knownCoverageGaps", "schemaVersion", "scope"];
const DOMAIN_MATRIX_KEYS = ["id", "requiredCapabilities", "schemaVersion", "tiers"];
const MATRIX_SCOPE_KEYS = ["issue", "label", "phase", "status"];
const MANIFEST_KEYS = [
	"buildVariants",
	"capabilities",
	"expectedScenarioSet",
	"fixtureHashes",
	"lockfileHash",
	"matrix",
	"measuredCounts",
	"runId",
	"schemaVersion",
	"seed",
	"source",
	"suiteVersion",
	"tier",
	"warmupCounts",
];
const SOURCE_KEYS = ["commit", "dirty"];
const MATRIX_PROVENANCE_KEYS = ["domainHashes", "rootHash"];
const EXPECTED_SCENARIO_KEYS = [
	"domain",
	"id",
	"kind",
	"measured",
	"requiredCapabilities",
	"variant",
	"warmups",
];
const ENVIRONMENT_KEYS = [
	"architecture",
	"chromium",
	"cpu",
	"image",
	"kernel",
	"memory",
	"node",
	"os",
	"playwright",
	"pnpm",
	"quota",
	"referenceProfile",
	"runId",
	"schemaVersion",
	"suiteVersion",
];
const CPU_KEYS = ["logicalCount", "model"];
const QUOTA_KEYS = ["cpu", "memoryBytes"];
const MEMORY_KEYS = ["totalBytes"];
const SUMMARY_STATISTICS = new Set(["median", "p95", "max"]);
const COMPARISONS = new Set(["lte", "gte", "eq"]);
const GATE_MODES = new Set(["hard", "observe"]);
const BENCHMARK_VARIANTS = new Set(["coalesced", "sequential"]);

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function exactKeys(value, expected) {
	if (!isRecord(value)) return false;
	return isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
	return sha256(fs.readFileSync(filePath));
}

function validHash(value) {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validRunId(value) {
	return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
}

function percentile(sorted, percentileValue) {
	const rank = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
	return sorted[Math.max(0, rank)];
}

function summarize(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle];
	return {
		count: sorted.length,
		min: sorted[0],
		median,
		p95: percentile(sorted, 0.95),
		max: sorted.at(-1),
	};
}

function compare(actual, comparison, threshold) {
	if (comparison === "lte") return actual <= threshold;
	if (comparison === "gte") return actual >= threshold;
	return actual === threshold;
}

function relativeDomainPath(value) {
	if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) return false;
	const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
	return normalized === value && !normalized.startsWith("../") && normalized !== "..";
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function matrixScopeIsCurrent(scope) {
	return (
		exactKeys(scope, MATRIX_SCOPE_KEYS) &&
		scope.issue === 28 &&
		scope.phase === 1 &&
		scope.status === "incomplete" &&
		scope.label === "#28 Phase 1 / incomplete"
	);
}

function validateScenarioDefinition(scenario, domainId, tier, errors, index) {
	if (!isRecord(scenario)) {
		errors.push(`matrix: ${domainId}/${tier} scenario ${String(index)} must be a record`);
		return undefined;
	}
	if (typeof scenario.id !== "string" || scenario.id.length === 0) {
		errors.push(`matrix: ${domainId}/${tier} scenario ${String(index)} id must be a non-empty string`);
	}
	if (typeof scenario.kind !== "string" || scenario.kind.length === 0) {
		errors.push(`matrix: ${domainId}/${tier} scenario ${String(index)} kind must be a non-empty string`);
	}
	if (!Number.isSafeInteger(scenario.warmups) || scenario.warmups < 0) {
		errors.push(
			`matrix: ${domainId}/${tier} scenario ${String(index)} warmups must be a non-negative integer`,
		);
	}
	if (!Number.isSafeInteger(scenario.samples) || scenario.samples <= 0) {
		errors.push(`matrix: ${domainId}/${tier} scenario ${String(index)} samples must be a positive integer`);
	}
	if (typeof scenario.id !== "string" || typeof scenario.kind !== "string") return undefined;
	return { ...scenario, domain: domainId };
}

/**
 * Loads the root manifest and its domain matrices in a stable order. The returned matrix is an
 * in-memory projection only: the root JSON remains the source of the declared domain files.
 */
export function loadBenchmarkMatrix(matrixPath = defaultMatrixPath) {
	const errors = [];
	let root;
	try {
		root = readJson(matrixPath);
	} catch (error) {
		throw new Error(
			`Unable to read benchmark matrix ${matrixPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!exactKeys(root, ROOT_MATRIX_KEYS)) {
		errors.push(`matrix: root must contain exactly ${ROOT_MATRIX_KEYS.join(", ")}`);
	}
	if (root?.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
		errors.push(`matrix: schemaVersion must be ${String(BENCHMARK_SCHEMA_VERSION)}`);
	}
	if (!matrixScopeIsCurrent(root?.scope)) {
		errors.push("matrix: scope must declare #28 Phase 1 / incomplete");
	}
	if (
		!Array.isArray(root?.knownCoverageGaps) ||
		root.knownCoverageGaps.some((gap) => typeof gap !== "string")
	) {
		errors.push("matrix: knownCoverageGaps must be a string array");
	}
	if (!Array.isArray(root?.domains) || root.domains.length === 0) {
		errors.push("matrix: domains must be a non-empty array");
	}

	const rootDirectory = path.dirname(matrixPath);
	const domainEntries = Array.isArray(root?.domains) ? root.domains : [];
	const domains = [];
	const domainHashes = {};
	const domainIds = new Set();
	let previousId = "";
	for (const [index, entry] of domainEntries.entries()) {
		if (!exactKeys(entry, ["id", "path"])) {
			errors.push(`matrix: domain ${String(index)} must contain exactly id, path`);
			continue;
		}
		if (typeof entry.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(entry.id)) {
			errors.push(`matrix: domain ${String(index)} id must be a lowercase identifier`);
			continue;
		}
		if (domainIds.has(entry.id)) errors.push(`matrix: duplicate domain id: ${entry.id}`);
		if (previousId.localeCompare(entry.id) >= 0) errors.push("matrix: domains must be sorted by id");
		previousId = entry.id;
		domainIds.add(entry.id);
		if (!relativeDomainPath(entry.path)) {
			errors.push(`matrix: domain ${entry.id} path must be a normalized relative path`);
			continue;
		}
		const domainPath = path.resolve(rootDirectory, entry.path);
		if (!domainPath.startsWith(`${rootDirectory}${path.sep}`)) {
			errors.push(`matrix: domain ${entry.id} escapes the matrix directory`);
			continue;
		}
		let domain;
		try {
			domain = readJson(domainPath);
			domainHashes[entry.id] = sha256File(domainPath);
		} catch (error) {
			errors.push(
				`matrix: unable to read domain ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		if (!exactKeys(domain, DOMAIN_MATRIX_KEYS)) {
			errors.push(`matrix: domain ${entry.id} must contain exactly ${DOMAIN_MATRIX_KEYS.join(", ")}`);
		}
		if (domain?.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
			errors.push(`matrix: domain ${entry.id} schemaVersion must be ${String(BENCHMARK_SCHEMA_VERSION)}`);
		}
		if (domain?.id !== entry.id) errors.push(`matrix: domain ${entry.id} id must match its root entry`);
		if (
			!Array.isArray(domain?.requiredCapabilities) ||
			domain.requiredCapabilities.length === 0 ||
			domain.requiredCapabilities.some(
				(capability) => typeof capability !== "string" || capability.length === 0,
			) ||
			new Set(domain.requiredCapabilities).size !== domain.requiredCapabilities.length ||
			!isDeepStrictEqual(domain.requiredCapabilities, [...domain.requiredCapabilities].sort())
		) {
			errors.push(
				`matrix: domain ${entry.id} requiredCapabilities must be a non-empty sorted unique string array`,
			);
		}
		if (
			!isRecord(domain?.tiers) ||
			!isRecord(domain.tiers.representative) ||
			!isRecord(domain.tiers.stress)
		) {
			errors.push(`matrix: domain ${entry.id} must define representative and stress tiers`);
			continue;
		}
		for (const tier of ["representative", "stress"]) {
			const tierValue = domain.tiers[tier];
			if (!exactKeys(tierValue, ["scenarios"]) || !Array.isArray(tierValue.scenarios)) {
				errors.push(`matrix: domain ${entry.id}/${tier} must contain a scenarios array`);
			}
		}
		domains.push({ ...domain, path: entry.path });
	}

	const tiers = { representative: { scenarios: [] }, stress: { scenarios: [] } };
	const scenarioIds = { representative: new Set(), stress: new Set() };
	for (const domain of domains) {
		for (const tier of ["representative", "stress"]) {
			const scenarios = Array.isArray(domain.tiers?.[tier]?.scenarios) ? domain.tiers[tier].scenarios : [];
			for (const [index, scenario] of scenarios.entries()) {
				const definition = validateScenarioDefinition(scenario, domain.id, tier, errors, index);
				if (!definition) continue;
				if (scenarioIds[tier].has(definition.id))
					errors.push(`matrix: duplicate scenario id: ${definition.id}`);
				scenarioIds[tier].add(definition.id);
				tiers[tier].scenarios.push({
					...definition,
					requiredCapabilities: Array.isArray(domain.requiredCapabilities)
						? [...domain.requiredCapabilities]
						: [],
				});
			}
		}
	}
	if (errors.length > 0) throw new Error(errors.join("\n"));
	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		scope: root.scope,
		knownCoverageGaps: root.knownCoverageGaps,
		domains,
		tiers,
		provenance: {
			rootHash: sha256File(matrixPath),
			domainHashes,
		},
	};
}

function matrixScenarios(matrix, tier, errors) {
	if (!isRecord(matrix) || matrix.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
		errors.push(`matrix: schemaVersion must be ${String(BENCHMARK_SCHEMA_VERSION)}`);
		return [];
	}
	if (!matrixScopeIsCurrent(matrix.scope)) errors.push("matrix: scope must declare #28 Phase 1 / incomplete");
	const selected = isRecord(matrix.tiers) ? matrix.tiers[tier] : undefined;
	if (!isRecord(selected) || !Array.isArray(selected.scenarios)) {
		errors.push(`matrix: tier ${tier} must contain a scenarios array`);
		return [];
	}
	const definitions = [];
	const ids = new Set();
	for (const [index, scenario] of selected.scenarios.entries()) {
		const domain = isRecord(scenario) && typeof scenario.domain === "string" ? scenario.domain : "unknown";
		const definition = validateScenarioDefinition(scenario, domain, tier, errors, index);
		if (!definition) continue;
		if (!Array.isArray(scenario.requiredCapabilities) || scenario.requiredCapabilities.length === 0) {
			errors.push(`matrix: scenario ${definition.id} must declare required capabilities`);
		}
		if (ids.has(definition.id)) errors.push(`matrix: duplicate matrix scenario id: ${definition.id}`);
		ids.add(definition.id);
		definitions.push(definition);
	}
	return definitions;
}

function validateCapabilities(capabilities, requiredCapabilities, errors, label) {
	if (!isRecord(capabilities) || Object.keys(capabilities).length === 0) {
		errors.push(`${label} capabilities must be a non-empty boolean record`);
		return;
	}
	for (const [name, value] of Object.entries(capabilities)) {
		if (typeof value !== "boolean") errors.push(`${label} capabilities.${name} must be boolean`);
	}
	for (const capability of requiredCapabilities) {
		if (capabilities[capability] !== true)
			errors.push(`${label} is missing required capability: ${capability}`);
	}
}

function validateTrials(result, definition, errors) {
	if (!Array.isArray(result.trials)) {
		errors.push("trials must be an array");
		return { trials: [], summaries: {} };
	}
	const expectedTrials = definition.warmups + definition.samples;
	if (result.trials.length !== expectedTrials) {
		errors.push(`recorded ${String(result.trials.length)} trials; expected ${String(expectedTrials)}`);
	}
	let expectedMetricKeys;
	let expectedCorrectnessKeys;
	for (const [index, trial] of result.trials.entries()) {
		if (!exactKeys(trial, TRIAL_KEYS)) {
			errors.push(`trial ${String(index)} must contain exactly ${TRIAL_KEYS.join(", ")}`);
		}
		if (!isRecord(trial)) continue;
		if (trial.index !== index) errors.push(`trial ${String(index)} index must be ${String(index)}`);
		const expectedWarmup = index < definition.warmups;
		if (trial.warmup !== expectedWarmup) {
			errors.push(`trial ${String(index)} warmup must be ${String(expectedWarmup)}`);
		}
		if (!isRecord(trial.metrics) || Object.keys(trial.metrics).length === 0) {
			errors.push(`trial ${String(index)} metrics must be a non-empty record`);
		} else {
			const keys = Object.keys(trial.metrics).sort();
			expectedMetricKeys ??= keys;
			if (!isDeepStrictEqual(keys, expectedMetricKeys)) {
				errors.push(`trial ${String(index)} metric keys must match trial 0`);
			}
			for (const [metric, value] of Object.entries(trial.metrics)) {
				if (!isFiniteNumber(value)) errors.push(`trial ${String(index)} metrics.${metric} must be finite`);
			}
		}
		if (!isRecord(trial.correctness) || Object.keys(trial.correctness).length === 0) {
			errors.push(`trial ${String(index)} correctness must be a non-empty record`);
		} else {
			const keys = Object.keys(trial.correctness).sort();
			expectedCorrectnessKeys ??= keys;
			if (!isDeepStrictEqual(keys, expectedCorrectnessKeys)) {
				errors.push(`trial ${String(index)} correctness keys must match trial 0`);
			}
			for (const [name, value] of Object.entries(trial.correctness)) {
				if (typeof value !== "boolean")
					errors.push(`trial ${String(index)} correctness.${name} must be boolean`);
			}
		}
	}

	const metricNames = new Set(
		result.trials.flatMap((trial) => (isRecord(trial?.metrics) ? Object.keys(trial.metrics) : [])),
	);
	const summaries = {};
	for (const metric of [...metricNames].sort()) {
		const values = result.trials
			.filter((trial) => isRecord(trial) && trial.warmup === false && isRecord(trial.metrics))
			.map((trial) => trial.metrics[metric]);
		if (values.some((value) => !isFiniteNumber(value))) {
			errors.push(`measured metric ${metric} must be finite in every measured trial`);
			continue;
		}
		if (values.length !== definition.samples) {
			errors.push(
				`measured metric ${metric} recorded ${String(values.length)} samples; expected ${String(definition.samples)}`,
			);
			continue;
		}
		summaries[metric] = summarize(values);
	}
	return { trials: result.trials, summaries };
}

function validateSummaries(result, expectedSummaries, errors) {
	if (!isRecord(result.summaries)) {
		errors.push("summaries must be a record");
		return;
	}
	const expectedNames = Object.keys(expectedSummaries).sort();
	const actualNames = Object.keys(result.summaries).sort();
	if (!isDeepStrictEqual(actualNames, expectedNames)) {
		errors.push(`summary metrics must be exactly: ${expectedNames.join(", ")}`);
	}
	for (const [metric, expected] of Object.entries(expectedSummaries)) {
		const actual = result.summaries[metric];
		if (!exactKeys(actual, SUMMARY_KEYS)) {
			errors.push(`summary ${metric} must contain exactly ${SUMMARY_KEYS.join(", ")}`);
			continue;
		}
		for (const key of SUMMARY_KEYS) {
			if (actual[key] !== expected[key])
				errors.push(`summary ${metric}.${key} must be ${String(expected[key])}`);
		}
	}
}

function validateGates(result, trials, expectedSummaries, errors) {
	if (!Array.isArray(result.gates) || result.gates.length === 0) {
		errors.push("gates must be a non-empty array");
		return [];
	}
	const gateKeys = new Set();
	const validated = [];
	for (const [index, gate] of result.gates.entries()) {
		if (!exactKeys(gate, GATE_KEYS)) {
			errors.push(`gate ${String(index)} must contain exactly ${GATE_KEYS.join(", ")}`);
			continue;
		}
		const key = `${gate.metric}.${gate.statistic}`;
		if (gateKeys.has(key)) errors.push(`duplicate gate: ${key}`);
		gateKeys.add(key);
		if (typeof gate.metric !== "string" || gate.metric.length === 0) {
			errors.push(`gate ${String(index)} metric must be a non-empty string`);
			continue;
		}
		if (gate.statistic !== "value" && !SUMMARY_STATISTICS.has(gate.statistic)) {
			errors.push(`gate ${key} statistic is invalid`);
			continue;
		}
		if (!COMPARISONS.has(gate.comparison)) errors.push(`gate ${key} comparison is invalid`);
		if (!GATE_MODES.has(gate.mode)) errors.push(`gate ${key} mode is invalid`);
		if (!isFiniteNumber(gate.threshold)) errors.push(`gate ${key} threshold must be finite`);
		if (typeof gate.rationale !== "string" || gate.rationale.length === 0) {
			errors.push(`gate ${key} rationale must be non-empty`);
		}

		let expectedActual = gate.actual;
		if (gate.statistic === "value") {
			if (!isFiniteNumber(gate.actual)) errors.push(`gate ${key} actual must be finite`);
			if (gate.metric === "correctnessFailures") {
				expectedActual = trials.reduce(
					(total, trial) =>
						total +
						(isRecord(trial?.correctness)
							? Object.values(trial.correctness).filter((value) => value !== true).length
							: 0),
					0,
				);
				if (gate.actual !== expectedActual) {
					errors.push(`correctnessFailures actual must be ${String(expectedActual)}`);
				}
			}
		} else {
			const measured = trials.filter((trial) => isRecord(trial) && trial.warmup === false);
			if (measured.some((trial) => !isRecord(trial.metrics) || !isFiniteNumber(trial.metrics[gate.metric]))) {
				errors.push(`gated metric ${gate.metric} must be finite in every measured trial`);
			}
			expectedActual = expectedSummaries[gate.metric]?.[gate.statistic];
			if (!isFiniteNumber(expectedActual)) {
				errors.push(`gate ${key} has no recomputable summary`);
			} else if (gate.actual !== expectedActual) {
				errors.push(`gate ${key} actual must be ${String(expectedActual)}`);
			}
		}
		const expectedPassed =
			isFiniteNumber(expectedActual) && COMPARISONS.has(gate.comparison) && isFiniteNumber(gate.threshold)
				? compare(expectedActual, gate.comparison, gate.threshold)
				: null;
		if (gate.passed !== expectedPassed) errors.push(`gate ${key} passed must be ${String(expectedPassed)}`);
		validated.push({ ...gate, recomputedPassed: expectedPassed });
	}
	return validated;
}

function validateResult(result, definition, tier, runId) {
	const errors = [];
	if (!exactKeys(result, RESULT_KEYS)) errors.push(`result must contain exactly ${RESULT_KEYS.join(", ")}`);
	if (!isRecord(result)) return errors;
	if (result.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
		errors.push(`schemaVersion must be ${String(BENCHMARK_SCHEMA_VERSION)}`);
	}
	if (result.suiteVersion !== BENCHMARK_SUITE_VERSION) {
		errors.push(`suiteVersion must be ${String(BENCHMARK_SUITE_VERSION)}`);
	}
	if (result.tier !== tier) errors.push(`tier must be ${tier}`);
	if (result.runId !== runId) errors.push(`runId must be ${runId}`);
	if (result.scenarioId !== definition.id) errors.push(`scenarioId must be ${definition.id}`);
	if (result.domain !== definition.domain) errors.push(`domain must be ${definition.domain}`);
	if (result.kind !== definition.kind) errors.push("kind must match matrix");
	if (!BENCHMARK_VARIANTS.has(result.variant)) errors.push("variant must be coalesced or sequential");
	if (!isDeepStrictEqual(result.parameters, definition)) errors.push("parameters must exactly match matrix");
	if (typeof result.browserVersion !== "string" || result.browserVersion.length === 0) {
		errors.push("browserVersion must be a non-empty string");
	}
	validateCapabilities(result.capabilities, definition.requiredCapabilities ?? [], errors, "result");
	const startedAt = Date.parse(result.startedAt);
	const finishedAt = Date.parse(result.finishedAt);
	if (!Number.isFinite(startedAt)) errors.push("startedAt must be an ISO timestamp");
	if (!Number.isFinite(finishedAt)) errors.push("finishedAt must be an ISO timestamp");
	if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt < startedAt) {
		errors.push("finishedAt must not precede startedAt");
	}
	if (!Array.isArray(result.notes) || result.notes.some((note) => typeof note !== "string")) {
		errors.push("notes must be a string array");
	}
	if (!Array.isArray(result.errors) || result.errors.some((error) => typeof error !== "string")) {
		errors.push("errors must be a string array");
	}

	const { trials, summaries } = validateTrials(result, definition, errors);
	validateSummaries(result, summaries, errors);
	const gates = validateGates(result, trials, summaries, errors);
	const recordedErrors = Array.isArray(result.errors) ? result.errors : [];
	const expectedStatus =
		recordedErrors.length > 0 || gates.some((gate) => gate.mode === "hard" && gate.recomputedPassed !== true)
			? "failed"
			: "passed";
	if (result.status !== expectedStatus) {
		errors.push(`status must be ${expectedStatus} when errors and hard gates are evaluated`);
	}
	return errors;
}

function scenarioKey({ domain, id, variant }) {
	return `${domain}/${id}/${variant}`;
}

function validateRawArtifacts(rawArtifacts, results, errors) {
	if (!Array.isArray(rawArtifacts)) {
		errors.push("raw artifacts must be an array");
		return;
	}
	const expected = new Map();
	for (const result of results) {
		if (!isRecord(result) || !Array.isArray(result.trials)) continue;
		const base = scenarioKey({ domain: result.domain, id: result.scenarioId, variant: result.variant });
		for (const trial of result.trials) {
			if (!isRecord(trial) || !Number.isSafeInteger(trial.index)) continue;
			expected.set(`${base}/${String(trial.index)}`, { result, trial });
		}
	}
	const seen = new Set();
	for (const artifact of rawArtifacts) {
		const label = typeof artifact?.name === "string" ? artifact.name : "raw artifact";
		const value = artifact?.value;
		if (!exactKeys(value, RAW_TRIAL_KEYS)) {
			errors.push(`${label}: raw trial must contain exactly ${RAW_TRIAL_KEYS.join(", ")}`);
			continue;
		}
		const key = scenarioKey({ domain: value.domain, id: value.scenarioId, variant: value.variant });
		if (!isRecord(value.trial) || !Number.isSafeInteger(value.trial.index)) {
			errors.push(`${label}: raw trial must contain a trial with a safe integer index`);
			continue;
		}
		const indexedKey = `${key}/${String(value.trial.index)}`;
		if (seen.has(indexedKey)) errors.push(`${label}: duplicate raw trial: ${indexedKey}`);
		seen.add(indexedKey);
		const expectedEntry = expected.get(indexedKey);
		if (!expectedEntry) {
			errors.push(`${label}: unexpected raw trial: ${indexedKey}`);
			continue;
		}
		const result = expectedEntry.result;
		for (const field of [
			"schemaVersion",
			"suiteVersion",
			"tier",
			"runId",
			"scenarioId",
			"domain",
			"variant",
			"kind",
		]) {
			if (value[field] !== result[field])
				errors.push(`${label}: raw ${field} must match its scenario result`);
		}
		if (!isDeepStrictEqual(value.parameters, result.parameters)) {
			errors.push(`${label}: raw parameters must match its scenario result`);
		}
		if (!isDeepStrictEqual(value.capabilities, result.capabilities)) {
			errors.push(`${label}: raw capabilities must match its scenario result`);
		}
		if (!isDeepStrictEqual(value.trial, expectedEntry.trial)) {
			errors.push(`${label}: raw trial must match its scenario result`);
		}
	}
	for (const key of expected.keys()) {
		if (!seen.has(key)) errors.push(`missing raw trial: ${key}`);
	}
}

function validateManifest(manifest, matrix, tier, runId, results, errors) {
	if (!exactKeys(manifest, MANIFEST_KEYS)) {
		errors.push(`manifest must contain exactly ${MANIFEST_KEYS.join(", ")}`);
		return;
	}
	if (manifest.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
		errors.push(`manifest schemaVersion must be ${String(BENCHMARK_SCHEMA_VERSION)}`);
	}
	if (manifest.suiteVersion !== BENCHMARK_SUITE_VERSION) {
		errors.push(`manifest suiteVersion must be ${String(BENCHMARK_SUITE_VERSION)}`);
	}
	if (manifest.tier !== tier) errors.push(`manifest tier must be ${tier}`);
	if (manifest.runId !== runId || !validRunId(manifest.runId)) errors.push(`manifest runId must be ${runId}`);
	if (typeof manifest.seed !== "string" || manifest.seed.length === 0)
		errors.push("manifest seed must be non-empty");
	if (!exactKeys(manifest.source, SOURCE_KEYS)) {
		errors.push(`manifest source must contain exactly ${SOURCE_KEYS.join(", ")}`);
	} else {
		if (!/^[a-f0-9]{40}$/i.test(manifest.source.commit))
			errors.push("manifest source.commit must be a commit SHA");
		if (typeof manifest.source.dirty !== "boolean") errors.push("manifest source.dirty must be boolean");
	}
	if (!exactKeys(manifest.matrix, MATRIX_PROVENANCE_KEYS)) {
		errors.push(`manifest matrix must contain exactly ${MATRIX_PROVENANCE_KEYS.join(", ")}`);
	} else {
		if (!validHash(manifest.matrix.rootHash)) errors.push("manifest matrix.rootHash must be a SHA-256 hash");
		if (!isRecord(manifest.matrix.domainHashes)) errors.push("manifest matrix.domainHashes must be a record");
		else {
			const expectedHashes = matrix.provenance?.domainHashes ?? {};
			if (!isDeepStrictEqual(manifest.matrix.domainHashes, expectedHashes)) {
				errors.push("manifest matrix.domainHashes must exactly match loaded domain hashes");
			}
		}
		if (manifest.matrix.rootHash !== matrix.provenance?.rootHash) {
			errors.push("manifest matrix.rootHash must match the loaded root matrix hash");
		}
	}
	for (const [label, hashes] of [
		["fixtureHashes", manifest.fixtureHashes],
		["buildVariants", manifest.buildVariants],
	]) {
		if (!isRecord(hashes) || Object.keys(hashes).length === 0) {
			errors.push(`manifest ${label} must be a non-empty record`);
			continue;
		}
		for (const [name, value] of Object.entries(hashes)) {
			if (!validHash(value)) errors.push(`manifest ${label}.${name} must be a SHA-256 hash`);
		}
	}
	if (!validHash(manifest.lockfileHash)) errors.push("manifest lockfileHash must be a SHA-256 hash");
	if (!isRecord(manifest.warmupCounts) || !isRecord(manifest.measuredCounts)) {
		errors.push("manifest warmupCounts and measuredCounts must be records");
	}
	if (!Array.isArray(manifest.expectedScenarioSet) || manifest.expectedScenarioSet.length === 0) {
		errors.push("manifest expectedScenarioSet must be a non-empty array");
		return;
	}
	const expectedDefinitions = matrixScenarios(matrix, tier, errors);
	const expectedKeys = new Set();
	for (const entry of manifest.expectedScenarioSet) {
		if (!exactKeys(entry, EXPECTED_SCENARIO_KEYS)) {
			errors.push(`manifest expected scenario must contain exactly ${EXPECTED_SCENARIO_KEYS.join(", ")}`);
			continue;
		}
		const key = scenarioKey(entry);
		if (expectedKeys.has(key)) errors.push(`manifest duplicate expected scenario: ${key}`);
		expectedKeys.add(key);
		if (!BENCHMARK_VARIANTS.has(entry.variant))
			errors.push(`manifest expected scenario ${key} has invalid variant`);
		const definition = expectedDefinitions.find(
			(candidate) => candidate.id === entry.id && candidate.domain === entry.domain,
		);
		if (!definition || entry.kind !== definition.kind)
			errors.push(`manifest expected scenario ${key} does not match matrix`);
		if (!definition || entry.warmups !== definition.warmups || entry.measured !== definition.samples) {
			errors.push(`manifest expected scenario ${key} counts must match matrix`);
		}
		if (!definition || !isDeepStrictEqual(entry.requiredCapabilities, definition.requiredCapabilities)) {
			errors.push(`manifest expected scenario ${key} capabilities must match matrix`);
		}
		if (manifest.warmupCounts?.[key] !== entry.warmups)
			errors.push(`manifest warmupCounts.${key} must match expected scenario`);
		if (manifest.measuredCounts?.[key] !== entry.measured)
			errors.push(`manifest measuredCounts.${key} must match expected scenario`);
	}
	const variants = new Set(manifest.expectedScenarioSet.map((entry) => entry?.variant));
	for (const variant of variants) {
		if (!validHash(manifest.buildVariants?.[variant])) {
			errors.push(`manifest buildVariants must include expected variant: ${String(variant)}`);
		}
	}
	validateCapabilities(manifest.capabilities, [], errors, "manifest");
	for (const result of results) {
		const key = scenarioKey({ domain: result.domain, id: result.scenarioId, variant: result.variant });
		if (!expectedKeys.has(key)) errors.push(`result is not in manifest expectedScenarioSet: ${key}`);
	}
}

function validateEnvironment(environment, runId, results, errors) {
	if (!exactKeys(environment, ENVIRONMENT_KEYS)) {
		errors.push(`environment must contain exactly ${ENVIRONMENT_KEYS.join(", ")}`);
		return;
	}
	if (environment.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
		errors.push(`environment schemaVersion must be ${String(BENCHMARK_SCHEMA_VERSION)}`);
	}
	if (environment.suiteVersion !== BENCHMARK_SUITE_VERSION) {
		errors.push(`environment suiteVersion must be ${String(BENCHMARK_SUITE_VERSION)}`);
	}
	if (environment.runId !== runId) errors.push(`environment runId must be ${runId}`);
	for (const key of [
		"os",
		"kernel",
		"architecture",
		"image",
		"node",
		"pnpm",
		"playwright",
		"chromium",
		"referenceProfile",
	]) {
		if (typeof environment[key] !== "string" || environment[key].length === 0) {
			errors.push(`environment ${key} must be a non-empty string`);
		}
	}
	if (!exactKeys(environment.cpu, CPU_KEYS))
		errors.push(`environment cpu must contain exactly ${CPU_KEYS.join(", ")}`);
	else {
		if (typeof environment.cpu.model !== "string" || environment.cpu.model.length === 0)
			errors.push("environment cpu.model must be non-empty");
		if (!Number.isSafeInteger(environment.cpu.logicalCount) || environment.cpu.logicalCount <= 0) {
			errors.push("environment cpu.logicalCount must be positive");
		}
	}
	if (!exactKeys(environment.quota, QUOTA_KEYS))
		errors.push(`environment quota must contain exactly ${QUOTA_KEYS.join(", ")}`);
	else {
		if (typeof environment.quota.cpu !== "string" || environment.quota.cpu.length === 0)
			errors.push("environment quota.cpu must be non-empty");
		if (!Number.isSafeInteger(environment.quota.memoryBytes) || environment.quota.memoryBytes <= 0) {
			errors.push("environment quota.memoryBytes must be positive");
		}
	}
	if (
		!exactKeys(environment.memory, MEMORY_KEYS) ||
		!Number.isSafeInteger(environment.memory?.totalBytes) ||
		environment.memory.totalBytes <= 0
	) {
		errors.push("environment memory.totalBytes must be positive");
	}
	for (const result of results) {
		if (result.browserVersion !== environment.chromium) {
			errors.push(`environment chromium must match result ${result.scenarioId} browserVersion`);
		}
	}
}

/** Strictly validate one tier's complete raw artifact set and provenance. */
export function validateBenchmarkArtifacts({
	matrix,
	tier,
	runId,
	artifacts,
	rawArtifacts,
	manifest,
	environment,
	playwrightExitCode,
}) {
	const errors = [];
	if (tier !== "representative" && tier !== "stress") errors.push("tier must be representative or stress");
	if (!validRunId(runId)) errors.push("runId must be a safe artifact directory name");
	const expectedScenarios = matrixScenarios(matrix, tier, errors);
	const definitions = new Map();
	for (const scenario of expectedScenarios) definitions.set(scenario.id, scenario);

	if (!Array.isArray(artifacts) || artifacts.length === 0)
		errors.push("scenario artifacts must be a non-empty array");
	const artifactList = Array.isArray(artifacts) ? artifacts : [];
	const artifactKeys = [];
	for (const artifact of artifactList) {
		if (!isRecord(artifact?.value)) continue;
		const value = artifact.value;
		if (
			typeof value.scenarioId === "string" &&
			typeof value.domain === "string" &&
			typeof value.variant === "string"
		) {
			artifactKeys.push(scenarioKey({ domain: value.domain, id: value.scenarioId, variant: value.variant }));
		}
	}
	const variants = new Set(
		Array.isArray(manifest?.expectedScenarioSet)
			? manifest.expectedScenarioSet
					.map((entry) => entry?.variant)
					.filter((variant) => typeof variant === "string")
			: [],
	);
	for (const definition of definitions.values()) {
		for (const variant of variants) {
			const key = scenarioKey({ domain: definition.domain, id: definition.id, variant });
			const count = artifactKeys.filter((candidate) => candidate === key).length;
			if (count === 0) errors.push(`missing scenario artifact: ${key}`);
			if (count > 1) errors.push(`duplicate scenario artifact: ${key}`);
		}
	}
	for (const key of new Set(artifactKeys)) {
		const [domain, id, variant] = key.split("/");
		const definition = definitions.get(id);
		if (!definition || definition.domain !== domain || !variants.has(variant)) {
			errors.push(`unexpected scenario artifact: ${key}`);
		}
	}

	const results = [];
	for (const artifact of artifactList) {
		const label = typeof artifact?.name === "string" ? artifact.name : "artifact";
		if (!isRecord(artifact?.value)) {
			errors.push(`${label}: artifact must be a record`);
			continue;
		}
		const definition = definitions.get(artifact.value.scenarioId);
		if (!definition) continue;
		const resultErrors = validateResult(artifact.value, definition, tier, runId);
		for (const error of resultErrors) errors.push(`${label}: ${error}`);
		if (resultErrors.length === 0) results.push(artifact.value);
	}
	const artifactValues = artifactList.map((artifact) => artifact.value).filter(isRecord);
	validateRawArtifacts(rawArtifacts, artifactValues, errors);
	validateManifest(manifest, matrix, tier, runId, artifactValues, errors);
	validateEnvironment(environment, runId, artifactValues, errors);
	if (!Number.isInteger(playwrightExitCode)) errors.push("Playwright exit code must be an integer");
	if (playwrightExitCode !== 0) {
		errors.push(`Playwright exited nonzero: ${String(playwrightExitCode)}`);
		for (const result of artifactValues) {
			if (result.status === "passed")
				errors.push(`Playwright nonzero cannot report green: ${result.scenarioId}`);
		}
	}
	results.sort((left, right) =>
		scenarioKey({ domain: left.domain, id: left.scenarioId, variant: left.variant }).localeCompare(
			scenarioKey({ domain: right.domain, id: right.scenarioId, variant: right.variant }),
		),
	);
	return { errors, results };
}
