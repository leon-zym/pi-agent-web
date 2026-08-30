import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBenchmarkArtifacts } from "./performance-benchmark-validator.mjs";

const scenario = {
	id: "stream-test",
	kind: "streaming",
	targetBytes: 10240,
	chunkBytes: 128,
	chunkDelayMs: 1,
	warmups: 1,
	samples: 2,
};

const matrix = {
	schemaVersion: 1,
	tiers: {
		representative: { scenarios: [scenario] },
		stress: { scenarios: [] },
	},
	knownCoverageGaps: [],
};

function validResult() {
	return {
		schemaVersion: 1,
		tier: "representative",
		scenarioId: scenario.id,
		kind: scenario.kind,
		status: "passed",
		startedAt: "2026-08-30T00:00:00.000Z",
		finishedAt: "2026-08-30T00:00:01.000Z",
		browserVersion: "Chromium 140",
		parameters: structuredClone(scenario),
		trials: [
			{ index: 0, warmup: true, metrics: { latencyMs: 5 }, correctness: { complete: true } },
			{ index: 1, warmup: false, metrics: { latencyMs: 10 }, correctness: { complete: true } },
			{ index: 2, warmup: false, metrics: { latencyMs: 20 }, correctness: { complete: true } },
		],
		summaries: { latencyMs: { count: 2, min: 10, median: 15, p95: 20, max: 20 } },
		gates: [
			{
				metric: "latencyMs",
				statistic: "p95",
				comparison: "lte",
				threshold: 25,
				actual: 20,
				mode: "observe",
				passed: true,
				rationale: "fixture",
			},
			{
				metric: "correctnessFailures",
				statistic: "value",
				comparison: "eq",
				threshold: 0,
				actual: 0,
				mode: "hard",
				passed: true,
				rationale: "fixture",
			},
		],
		notes: [],
		errors: [],
	};
}

function validate(value = validResult(), overrides = {}) {
	return validateBenchmarkArtifacts({
		matrix: overrides.matrix ?? matrix,
		tier: "representative",
		artifacts: overrides.artifacts ?? [{ name: `${value.scenarioId}.json`, value }],
	});
}

function errorText(outcome) {
	return outcome.errors.join("\n");
}

test("accepts one complete internally consistent artifact", () => {
	assert.deepEqual(validate().errors, []);
});

test("rejects duplicate matrix ids before lookup can overwrite them", () => {
	const duplicateMatrix = structuredClone(matrix);
	duplicateMatrix.tiers.representative.scenarios.push(structuredClone(scenario));
	assert.match(
		errorText(validate(validResult(), { matrix: duplicateMatrix })),
		/duplicate matrix scenario id/,
	);
});

test("rejects artifact identity and parameters that drift from the matrix", () => {
	const value = validResult();
	value.kind = "history";
	value.parameters.targetBytes += 1;
	const errors = errorText(validate(value));
	assert.match(errors, /kind must match matrix/);
	assert.match(errors, /parameters must exactly match matrix/);
});

test("rejects duplicate, missing, and extra artifact ids without result-map overwrite", () => {
	const duplicate = validResult();
	const extra = validResult();
	extra.scenarioId = "extra";
	extra.parameters.id = "extra";
	const errors = errorText(
		validate(validResult(), {
			artifacts: [
				{ name: "first.json", value: validResult() },
				{ name: "second.json", value: duplicate },
				{ name: "extra.json", value: extra },
			],
		}),
	);
	assert.match(errors, /duplicate scenario artifact: stream-test/);
	assert.match(errors, /unexpected scenario artifact: extra/);
	const missingErrors = errorText(
		validate(validResult(), { artifacts: [{ name: "extra.json", value: extra }] }),
	);
	assert.match(missingErrors, /missing scenario artifact: stream-test/);
	assert.match(missingErrors, /unexpected scenario artifact: extra/);
});

test("rejects trial index, warmup, metric, and correctness shape drift", () => {
	const value = validResult();
	value.trials[1].index = 9;
	value.trials[2].warmup = true;
	value.trials[2].metrics = [];
	value.trials[2].correctness = { complete: "yes" };
	const errors = errorText(validate(value));
	assert.match(errors, /trial 1 index must be 1/);
	assert.match(errors, /trial 2 warmup must be false/);
	assert.match(errors, /trial 2 metrics must be a record/);
	assert.match(errors, /trial 2 correctness\.complete must be boolean/);
});

test("rejects a gated metric with a null measured sample instead of filtering it to green", () => {
	const value = validResult();
	value.trials[1].metrics.latencyMs = null;
	value.summaries.latencyMs = { count: 1, min: 20, median: 20, p95: 20, max: 20 };
	assert.match(errorText(validate(value)), /gated metric latencyMs must be finite in every measured trial/);
});

test("recomputes summaries and gate actual/pass state", () => {
	const value = validResult();
	value.summaries.latencyMs.p95 = 1;
	value.gates[0].actual = 1;
	value.gates[0].passed = false;
	const errors = errorText(validate(value));
	assert.match(errors, /summary latencyMs\.p95 must be 20/);
	assert.match(errors, /gate latencyMs\.p95 actual must be 20/);
	assert.match(errors, /gate latencyMs\.p95 passed must be true/);
});

test("recomputes correctness failures and requires errors/status consistency", () => {
	const value = validResult();
	value.trials[2].correctness.complete = false;
	value.gates[1].actual = 0;
	value.errors.push("synthetic failure");
	const errors = errorText(validate(value));
	assert.match(errors, /correctnessFailures actual must be 1/);
	assert.match(errors, /status must be failed when errors and hard gates are evaluated/);
});
