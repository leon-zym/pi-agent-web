import assert from "node:assert/strict";
import { test } from "node:test";
import { loadBenchmarkMatrix, validateBenchmarkArtifacts } from "./performance-benchmark-validator.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const RUN_ID = "20260831t000000z-fixture";

const scenario = {
	id: "stream-test",
	domain: "streaming",
	kind: "streaming",
	targetBytes: 10240,
	chunkBytes: 128,
	chunkDelayMs: 1,
	warmups: 1,
	samples: 2,
	requiredCapabilities: ["browser", "websocket"],
};

const matrix = {
	schemaVersion: 2,
	scope: { issue: 28, phase: 1, status: "incomplete", label: "#28 Phase 1 / incomplete" },
	tiers: {
		representative: { scenarios: [scenario] },
		stress: { scenarios: [] },
	},
	provenance: { rootHash: HASH_A, domainHashes: { streaming: HASH_B } },
};

function validResult() {
	return {
		schemaVersion: 2,
		suiteVersion: 2,
		tier: "representative",
		runId: RUN_ID,
		scenarioId: scenario.id,
		domain: scenario.domain,
		variant: "coalesced",
		kind: scenario.kind,
		status: "passed",
		startedAt: "2026-08-30T00:00:00.000Z",
		finishedAt: "2026-08-30T00:00:01.000Z",
		browserVersion: "Chromium 140",
		parameters: structuredClone(scenario),
		capabilities: { browser: true, websocket: true },
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

function expectedScenario() {
	return {
		id: scenario.id,
		domain: scenario.domain,
		kind: scenario.kind,
		variant: "coalesced",
		warmups: scenario.warmups,
		measured: scenario.samples,
		requiredCapabilities: structuredClone(scenario.requiredCapabilities),
	};
}

function validManifest() {
	const expected = expectedScenario();
	const key = `${expected.domain}/${expected.id}/${expected.variant}`;
	return {
		schemaVersion: 2,
		suiteVersion: 2,
		tier: "representative",
		runId: RUN_ID,
		seed: "fixture-seed",
		source: { commit: "c".repeat(40), dirty: false },
		matrix: structuredClone(matrix.provenance),
		fixtureHashes: { deterministicPi: HASH_A },
		lockfileHash: HASH_B,
		buildVariants: { coalesced: HASH_A },
		warmupCounts: { [key]: 1 },
		measuredCounts: { [key]: 2 },
		capabilities: { browser: true, websocket: true },
		expectedScenarioSet: [expected],
	};
}

function validEnvironment() {
	return {
		schemaVersion: 2,
		suiteVersion: 2,
		runId: RUN_ID,
		os: "linux",
		kernel: "6.0",
		architecture: "x64",
		cpu: { model: "fixture", logicalCount: 2 },
		quota: { cpu: "unlimited", memoryBytes: 1024 },
		memory: { totalBytes: 1024 },
		image: "fixture",
		node: "v24.0.0",
		pnpm: "11.21.0",
		playwright: "1.62.1",
		chromium: "Chromium 140",
		referenceProfile: "unprofiled",
	};
}

function rawFor(result) {
	return result.trials.map((trial) => ({
		name: `${result.scenarioId}/${result.variant}-${String(trial.index)}.json`,
		value: {
			schemaVersion: result.schemaVersion,
			suiteVersion: result.suiteVersion,
			tier: result.tier,
			runId: result.runId,
			scenarioId: result.scenarioId,
			domain: result.domain,
			variant: result.variant,
			kind: result.kind,
			parameters: structuredClone(result.parameters),
			capabilities: structuredClone(result.capabilities),
			trial: structuredClone(trial),
		},
	}));
}

function validate(value = validResult(), overrides = {}) {
	return validateBenchmarkArtifacts({
		matrix: overrides.matrix ?? matrix,
		tier: "representative",
		runId: RUN_ID,
		artifacts: overrides.artifacts ?? [{ name: `${value.scenarioId}.result.json`, value }],
		rawArtifacts: overrides.rawArtifacts ?? rawFor(value),
		manifest: overrides.manifest ?? validManifest(),
		environment: overrides.environment ?? validEnvironment(),
		playwrightExitCode: overrides.playwrightExitCode ?? 0,
	});
}

function errorText(outcome) {
	return outcome.errors.join("\n");
}

test("loads the root manifest through sorted domain matrices", () => {
	const loaded = loadBenchmarkMatrix();
	assert.equal(loaded.schemaVersion, 2);
	assert.deepEqual(Object.keys(loaded.provenance.domainHashes), [
		"concurrency",
		"content",
		"history",
		"recovery",
		"streaming",
	]);
	assert.equal(loaded.tiers.representative.scenarios.length, 8);
});

test("accepts one complete schema-v2 artifact set", () => {
	assert.deepEqual(validate().errors, []);
});

test("rejects a matrix that overclaims Issue #28 completion", () => {
	const completedMatrix = structuredClone(matrix);
	completedMatrix.scope.status = "complete";
	assert.match(errorText(validate(validResult(), { matrix: completedMatrix })), /#28 Phase 1 \/ incomplete/);
});

test("rejects missing, duplicate, and partial raw trial evidence", () => {
	const result = validResult();
	const partial = rawFor(result).slice(0, 2);
	const partialErrors = errorText(validate(result, { rawArtifacts: partial }));
	assert.match(partialErrors, /missing raw trial/);
	const duplicate = [...rawFor(result), structuredClone(rawFor(result)[0])];
	const duplicateErrors = errorText(validate(result, { rawArtifacts: duplicate }));
	assert.match(duplicateErrors, /duplicate raw trial/);
});

test("fails closed on non-finite measurements and missing required capabilities", () => {
	const nonfinite = validResult();
	nonfinite.trials[1].metrics.latencyMs = Number.NaN;
	nonfinite.summaries.latencyMs = {
		count: 2,
		min: Number.NaN,
		median: Number.NaN,
		p95: Number.NaN,
		max: Number.NaN,
	};
	const nonfiniteErrors = errorText(validate(nonfinite, { rawArtifacts: rawFor(nonfinite) }));
	assert.match(nonfiniteErrors, /metrics\.latencyMs must be finite/);
	const unavailable = validResult();
	unavailable.capabilities.websocket = false;
	const unavailableErrors = errorText(validate(unavailable, { rawArtifacts: rawFor(unavailable) }));
	assert.match(unavailableErrors, /missing required capability: websocket/);
});

test("recomputes summaries, gates, tier, and manifest counts", () => {
	const result = validResult();
	result.summaries.latencyMs.p95 = 1;
	result.gates[0].actual = 1;
	result.gates[0].passed = false;
	const manifest = validManifest();
	manifest.measuredCounts["streaming/stream-test/coalesced"] = 1;
	const errors = errorText(validate(result, { manifest }));
	assert.match(errors, /summary latencyMs\.p95 must be 20/);
	assert.match(errors, /gate latencyMs\.p95 actual must be 20/);
	assert.match(errors, /gate latencyMs\.p95 passed must be true/);
	assert.match(errors, /measuredCounts\.streaming\/stream-test\/coalesced must match expected scenario/);
});

test("rejects provenance hash drift and a nonzero Playwright run reported green", () => {
	const manifest = validManifest();
	manifest.matrix.rootHash = HASH_B;
	const errors = errorText(validate(validResult(), { manifest, playwrightExitCode: 1 }));
	assert.match(errors, /rootHash must match the loaded root matrix hash/);
	assert.match(errors, /Playwright exited nonzero: 1/);
	assert.match(errors, /Playwright nonzero cannot report green/);
});

test("rejects duplicate, missing, and extra scenario results before result-map overwrite", () => {
	const duplicate = validResult();
	const extra = validResult();
	extra.scenarioId = "extra";
	extra.parameters.id = "extra";
	const errors = errorText(
		validate(validResult(), {
			artifacts: [
				{ name: "first.result.json", value: validResult() },
				{ name: "second.result.json", value: duplicate },
				{ name: "extra.result.json", value: extra },
			],
		}),
	);
	assert.match(errors, /duplicate scenario artifact: streaming\/stream-test\/coalesced/);
	assert.match(errors, /unexpected scenario artifact: streaming\/extra\/coalesced/);
});
