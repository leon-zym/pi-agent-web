import { isDeepStrictEqual } from "node:util";

const RESULT_KEYS = [
	"browserVersion",
	"errors",
	"finishedAt",
	"gates",
	"kind",
	"notes",
	"parameters",
	"scenarioId",
	"schemaVersion",
	"startedAt",
	"status",
	"summaries",
	"tier",
	"trials",
];
const TRIAL_KEYS = ["correctness", "index", "metrics", "warmup"];
const SUMMARY_KEYS = ["count", "max", "median", "min", "p95"];
const GATE_KEYS = ["actual", "comparison", "metric", "mode", "passed", "rationale", "statistic", "threshold"];
const SUMMARY_STATISTICS = new Set(["median", "p95", "max"]);
const COMPARISONS = new Set(["lte", "gte", "eq"]);
const GATE_MODES = new Set(["hard", "observe"]);

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

function matrixScenarios(matrix, tier, errors) {
	if (!isRecord(matrix) || matrix.schemaVersion !== 1) {
		errors.push("matrix: schemaVersion must be 1");
		return [];
	}
	const tiers = matrix.tiers;
	const selected = isRecord(tiers) ? tiers[tier] : undefined;
	if (!isRecord(selected) || !Array.isArray(selected.scenarios)) {
		errors.push(`matrix: tier ${tier} must contain a scenarios array`);
		return [];
	}
	const scenarios = selected.scenarios;
	const counts = new Map();
	for (const [index, scenario] of scenarios.entries()) {
		if (!isRecord(scenario)) {
			errors.push(`matrix: scenario ${String(index)} must be a record`);
			continue;
		}
		if (typeof scenario.id !== "string" || scenario.id.length === 0) {
			errors.push(`matrix: scenario ${String(index)} id must be a non-empty string`);
		} else {
			counts.set(scenario.id, (counts.get(scenario.id) ?? 0) + 1);
		}
		if (typeof scenario.kind !== "string" || scenario.kind.length === 0) {
			errors.push(`matrix: scenario ${String(index)} kind must be a non-empty string`);
		}
		if (!Number.isSafeInteger(scenario.warmups) || scenario.warmups < 0) {
			errors.push(`matrix: scenario ${String(index)} warmups must be a non-negative integer`);
		}
		if (!Number.isSafeInteger(scenario.samples) || scenario.samples <= 0) {
			errors.push(`matrix: scenario ${String(index)} samples must be a positive integer`);
		}
	}
	for (const [id, count] of counts) {
		if (count > 1) errors.push(`matrix: duplicate matrix scenario id: ${id}`);
	}
	return scenarios.filter((scenario) => isRecord(scenario) && typeof scenario.id === "string");
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
		if (!isRecord(trial.metrics)) {
			errors.push(`trial ${String(index)} metrics must be a record`);
		} else {
			const keys = Object.keys(trial.metrics).sort();
			expectedMetricKeys ??= keys;
			if (!isDeepStrictEqual(keys, expectedMetricKeys)) {
				errors.push(`trial ${String(index)} metric keys must match trial 0`);
			}
			for (const [metric, value] of Object.entries(trial.metrics)) {
				if (value !== null && !isFiniteNumber(value)) {
					errors.push(`trial ${String(index)} metrics.${metric} must be finite or null`);
				}
			}
		}
		if (!isRecord(trial.correctness)) {
			errors.push(`trial ${String(index)} correctness must be a record`);
		} else {
			const keys = Object.keys(trial.correctness).sort();
			expectedCorrectnessKeys ??= keys;
			if (!isDeepStrictEqual(keys, expectedCorrectnessKeys)) {
				errors.push(`trial ${String(index)} correctness keys must match trial 0`);
			}
			for (const [name, value] of Object.entries(trial.correctness)) {
				if (typeof value !== "boolean") {
					errors.push(`trial ${String(index)} correctness.${name} must be boolean`);
				}
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
			.map((trial) => trial.metrics[metric])
			.filter(isFiniteNumber);
		if (values.length > 0) summaries[metric] = summarize(values);
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
			if (actual[key] !== expected[key]) {
				errors.push(`summary ${metric}.${key} must be ${String(expected[key])}`);
			}
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
		if (gate.passed !== expectedPassed) {
			errors.push(`gate ${key} passed must be ${String(expectedPassed)}`);
		}
		validated.push({ ...gate, recomputedPassed: expectedPassed });
	}
	return validated;
}

function validateResult(result, definition, tier) {
	const errors = [];
	if (!exactKeys(result, RESULT_KEYS)) {
		errors.push(`result must contain exactly ${RESULT_KEYS.join(", ")}`);
	}
	if (!isRecord(result)) return errors;
	if (result.schemaVersion !== 1) errors.push("schemaVersion must be 1");
	if (result.tier !== tier) errors.push(`tier must be ${tier}`);
	if (result.scenarioId !== definition.id) errors.push(`scenarioId must be ${definition.id}`);
	if (result.kind !== definition.kind) errors.push("kind must match matrix");
	if (!isDeepStrictEqual(result.parameters, definition)) {
		errors.push("parameters must exactly match matrix");
	}
	if (typeof result.browserVersion !== "string" || result.browserVersion.length === 0) {
		errors.push("browserVersion must be a non-empty string");
	}
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

/** Strictly validate one tier's complete raw artifact set. */
export function validateBenchmarkArtifacts({ matrix, tier, artifacts }) {
	const errors = [];
	const expectedScenarios = matrixScenarios(matrix, tier, errors);
	const definitions = new Map();
	for (const scenario of expectedScenarios) {
		if (!definitions.has(scenario.id)) definitions.set(scenario.id, scenario);
	}

	const artifactIds = artifacts
		.map((artifact) => (isRecord(artifact.value) ? artifact.value.scenarioId : undefined))
		.filter((id) => typeof id === "string");
	for (const id of definitions.keys()) {
		const count = artifactIds.filter((candidate) => candidate === id).length;
		if (count === 0) errors.push(`missing scenario artifact: ${id}`);
		if (count > 1) errors.push(`duplicate scenario artifact: ${id}`);
	}
	for (const id of new Set(artifactIds)) {
		if (!definitions.has(id)) errors.push(`unexpected scenario artifact: ${id}`);
	}

	const results = [];
	for (const artifact of artifacts) {
		if (!isRecord(artifact.value)) {
			errors.push(`${artifact.name}: artifact must be a record`);
			continue;
		}
		const definition = definitions.get(artifact.value.scenarioId);
		if (!definition) continue;
		const resultErrors = validateResult(artifact.value, definition, tier);
		for (const error of resultErrors) errors.push(`${artifact.name}: ${error}`);
		if (resultErrors.length === 0) results.push(artifact.value);
	}
	results.sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
	return { errors, results };
}
