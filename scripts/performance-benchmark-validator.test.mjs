import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BENCHMARK_PRODUCER_PATHS,
	canonicalFormalExpectedScenarioSet,
	loadBenchmarkMatrix,
	validateBenchmarkArtifacts,
} from "./performance-benchmark-validator.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const RUN_ID = "20260831t000000z-fixture";
const FORMAL_VARIANTS = ["coalesced", "sequential"];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const recoveryScenario = {
	...scenario,
	id: "recovery-test",
	domain: "recovery",
	kind: "recovery-crash",
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

const recoveryMatrix = {
	...matrix,
	tiers: {
		...matrix.tiers,
		representative: { scenarios: [recoveryScenario] },
	},
	provenance: { rootHash: HASH_A, domainHashes: { recovery: HASH_B } },
};

const recoveryCorrectness = {
	complete: true,
	recoveryBarrier: true,
	zeroDuplicateLostEvents: true,
	staleGenerationRejected: true,
	staleFenceRejected: true,
	staleEpochRejected: true,
	finalProjectionMatches: true,
	processRestarted: true,
};

function variantOrder(seed = "fixture-seed") {
	return [...FORMAL_VARIANTS].sort((left, right) => {
		const hash = (variant) => createHash("sha256").update(`${seed}\0${variant}`).digest("hex");
		return hash(left).localeCompare(hash(right)) || left.localeCompare(right);
	});
}

function trialMetrics(latencyMs) {
	return {
		latencyMs,
	};
}

function fixtureHashes() {
	return Object.fromEntries(
		BENCHMARK_PRODUCER_PATHS.map((relativePath) => [
			relativePath,
			createHash("sha256")
				.update(fs.readFileSync(path.join(repositoryRoot, relativePath)))
				.digest("hex"),
		]),
	);
}

function recoveryEvidence(kind) {
	const rekey = kind === "recovery-rekey";
	const restart = kind === "recovery-gateway-restart";
	const crash = kind === "recovery-crash";
	const authorityBefore = {
		workspaceHandle: "workspace",
		workspacePath: "/workspace",
		sessionHandle: "session-parent",
		nativeSessionId: "native-parent",
		sessionFile: "/tmp/parent.jsonl",
		serverEpoch: "epoch-a",
		generation: 1,
		fencingToken: "fence-a",
	};
	const authorityAfter = {
		...authorityBefore,
		...(rekey
			? {
					sessionHandle: "session-child",
					nativeSessionId: "native-child",
					sessionFile: "/tmp/child.jsonl",
					generation: 2,
				}
			: {}),
		...(restart ? { serverEpoch: "epoch-b" } : {}),
		...(crash ? { generation: 2 } : {}),
	};
	const stale = {
		generation: {
			responseType: "response",
			responseSuccess: false,
			responseError: "session_generation_stale",
			piCommandCountBefore: 0,
			piCommandCountAfter: 0,
		},
		fence: {
			responseType: "response",
			responseSuccess: false,
			responseError: "session_read_only",
			piCommandCountBefore: 0,
			piCommandCountAfter: 0,
		},
		epoch: {
			responseType: "resync_required",
			responseSuccess: false,
			responseError: null,
			piCommandCountBefore: 0,
			piCommandCountAfter: 0,
		},
		parent: rekey
			? {
					responseType: "response",
					responseSuccess: false,
					responseError: "session_read_only",
					piCommandCountBefore: 0,
					piCommandCountAfter: 0,
				}
			: {
					responseType: "not_applicable",
					responseSuccess: false,
					responseError: null,
					piCommandCountBefore: 0,
					piCommandCountAfter: 0,
				},
	};
	return {
		kind,
		authorityBefore,
		authorityAfter,
		sequence: { expected: [1], observed: [1] },
		projection: { prompt: "prompt", reply: "reply", promptCount: 1, replyCount: 1 },
		stale,
		fault: {
			observed: true,
			reconnectCount: kind === "recovery-disconnect" ? 1 : 0,
			gapResyncCount: kind === "recovery-gap" ? 1 : 0,
			processRestartCount: crash ? 1 : 0,
			rekeyFrameCount: rekey ? 1 : 0,
			identityChanged: rekey,
			oldParentRejected: rekey,
			gatewayStarts: restart ? 1 : 0,
			activeGateways: 1,
			rootEntryCount: 2,
			stableOrigin: true,
			ownedGatewayCount: restart ? 2 : 1,
		},
	};
}

function trialEvidence(result) {
	return {
		browserErrors: { console: [], page: [] },
		hardMetrics: { correctnessFailures: 0 },
		recovery: result.kind.startsWith("recovery-") ? recoveryEvidence(result.kind) : null,
	};
}

function validResult(
	variant,
	baseLatency = variant === "coalesced" ? 10 : 11,
	definition = scenario,
	correctness = { complete: true },
) {
	const measured = [baseLatency, baseLatency + 10];
	return {
		schemaVersion: 2,
		suiteVersion: 2,
		tier: "representative",
		runId: RUN_ID,
		scenarioId: definition.id,
		domain: definition.domain,
		variant,
		kind: definition.kind,
		status: "passed",
		startedAt: "2026-08-30T00:00:00.000Z",
		finishedAt: "2026-08-30T00:00:01.000Z",
		browserVersion: "Chromium 140",
		parameters: structuredClone(definition),
		capabilities: {
			browser: true,
			websocket: true,
		},
		trials: [
			{ index: 0, warmup: true, metrics: trialMetrics(5), correctness: structuredClone(correctness) },
			{
				index: 1,
				warmup: false,
				metrics: trialMetrics(measured[0]),
				correctness: structuredClone(correctness),
			},
			{
				index: 2,
				warmup: false,
				metrics: trialMetrics(measured[1]),
				correctness: structuredClone(correctness),
			},
		],
		summaries: Object.fromEntries(
			Object.entries(trialMetrics(measured[0])).map(([metric, value]) => [
				metric,
				metric === "latencyMs"
					? { count: 2, min: measured[0], median: baseLatency + 5, p95: measured[1], max: measured[1] }
					: { count: 2, min: value, median: value, p95: value, max: value },
			]),
		),
		gates: [
			{
				metric: "latencyMs",
				statistic: "p95",
				comparison: "lte",
				threshold: 25,
				actual: measured[1],
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

function validResults(definition = scenario, correctness = { complete: true }) {
	return FORMAL_VARIANTS.map((variant) => validResult(variant, undefined, definition, correctness));
}

function expectedScenario(variant, definition = scenario) {
	return {
		id: definition.id,
		domain: definition.domain,
		kind: definition.kind,
		variant,
		warmups: definition.warmups,
		measured: definition.samples,
		requiredCapabilities: structuredClone(definition.requiredCapabilities),
	};
}

function validManifest(definition = scenario, matrixValue = matrix) {
	const expected = FORMAL_VARIANTS.map((variant) => expectedScenario(variant, definition));
	return {
		schemaVersion: 2,
		suiteVersion: 2,
		tier: "representative",
		runId: RUN_ID,
		seed: "fixture-seed",
		source: { commit: "c".repeat(40), dirty: false },
		matrix: structuredClone(matrixValue.provenance),
		fixtureHashes: fixtureHashes(),
		lockfileHash: HASH_B,
		buildIdentity: { cliTreeHash: HASH_A, serverTreeHash: HASH_B, uiTreeHash: HASH_C },
		buildVariants: Object.fromEntries(
			FORMAL_VARIANTS.map((variant) => [
				variant,
				{
					uiDirectory: `builds/${variant}/ui`,
					uiTreeHash: HASH_A,
					serverEntry: `builds/${variant}/server/benchmark-main.js`,
					serverEntryHash: HASH_B,
					serverTreeHash: HASH_C,
				},
			]),
		),
		canonicalVariants: [...FORMAL_VARIANTS],
		executionOrder: variantOrder(),
		warmupCounts: Object.fromEntries(
			expected.map((entry) => [`${entry.domain}/${entry.id}/${entry.variant}`, entry.warmups]),
		),
		measuredCounts: Object.fromEntries(
			expected.map((entry) => [`${entry.domain}/${entry.id}/${entry.variant}`, entry.measured]),
		),
		capabilities: {
			browser: true,
			websocket: true,
		},
		expectedScenarioSet: expected,
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
			evidence: trialEvidence(result),
			trial: structuredClone(trial),
		},
	}));
}

function validate(overrides = {}) {
	const definition = overrides.definition ?? scenario;
	const matrixValue = overrides.matrix ?? matrix;
	const results = overrides.results ?? validResults(definition, overrides.correctness);
	return validateBenchmarkArtifacts({
		matrix: matrixValue,
		tier: "representative",
		runId: RUN_ID,
		artifacts:
			overrides.artifacts ??
			results.map((value) => ({ name: `${value.scenarioId}/${value.variant}.result.json`, value })),
		rawArtifacts: overrides.rawArtifacts ?? results.flatMap(rawFor),
		manifest: overrides.manifest ?? validManifest(definition, matrixValue),
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
	assert.equal(loaded.tiers.representative.scenarios.length, 11);
	const recovery = loaded.domains.find((domain) => domain.id === "recovery");
	assert.ok(recovery);
	assert.deepEqual(
		recovery.tiers.representative.scenarios.map((entry) => entry.kind),
		["recovery-disconnect", "recovery-gap", "recovery-crash", "recovery-rekey", "recovery-gateway-restart"],
	);
	assert.deepEqual(
		recovery.tiers.representative.scenarios.map(({ warmups, samples }) => [warmups, samples]),
		Array.from({ length: 5 }, () => [1, 3]),
	);
	assert.deepEqual(
		recovery.tiers.stress.scenarios.map(({ warmups, samples }) => [warmups, samples]),
		Array.from({ length: 5 }, () => [2, 100]),
	);
	assert.equal(
		recovery.tiers.stress.scenarios.reduce((total, entry) => total + entry.samples, 0),
		500,
	);
});

test("defines canonical formal pairs per matrix scenario rather than producer execution order", () => {
	const secondScenario = { ...scenario, id: "stream-second" };
	const expected = canonicalFormalExpectedScenarioSet(
		{
			...matrix,
			tiers: {
				...matrix.tiers,
				representative: { scenarios: [scenario, secondScenario] },
			},
		},
		"representative",
	);
	assert.deepEqual(
		expected.map((entry) => `${entry.id}/${entry.variant}`),
		[
			"stream-test/coalesced",
			"stream-test/sequential",
			"stream-second/coalesced",
			"stream-second/sequential",
		],
	);
});

test("accepts one complete formal schema-v2 artifact set", () => {
	assert.deepEqual(validate().errors, []);
});

test("requires canonical result artifact paths before counting results", () => {
	const results = validResults();
	const artifacts = results.map((value) => ({
		name: `${value.scenarioId}/${value.variant}.result.json`,
		value,
	}));
	artifacts[0].name = "renamed.result.json";
	assert.match(errorText(validate({ results, artifacts })), /result artifact path must be/);
});

test("rejects a matrix that overclaims Issue #28 completion", () => {
	const completedMatrix = structuredClone(matrix);
	completedMatrix.scope.status = "complete";
	assert.match(errorText(validate({ matrix: completedMatrix })), /#28 Phase 1 \/ incomplete/);
});

test("rejects missing, duplicate, and partial raw trial evidence", () => {
	const results = validResults();
	const partial = results.flatMap(rawFor).slice(0, -1);
	assert.match(errorText(validate({ results, rawArtifacts: partial })), /missing raw trial/);
	const duplicate = [...results.flatMap(rawFor), structuredClone(rawFor(results[0])[0])];
	assert.match(errorText(validate({ results, rawArtifacts: duplicate })), /duplicate raw trial/);
	const invalidPath = results.flatMap(rawFor);
	invalidPath[0].name = "tampered-trial.json";
	assert.match(errorText(validate({ results, rawArtifacts: invalidPath })), /raw trial path must be/);
});

test("does not trust forged hard browser-error data without authoritative raw evidence", () => {
	const results = validResults();
	const rawArtifacts = results.flatMap(rawFor);
	delete rawArtifacts[0].value.evidence;
	assert.match(errorText(validate({ results, rawArtifacts })), /evidence|raw trial must contain exactly/);
	const forgedResults = validResults();
	forgedResults[0].gates.push({
		metric: "browserErrors",
		statistic: "value",
		comparison: "eq",
		threshold: 0,
		actual: 0,
		mode: "hard",
		passed: true,
		rationale: "fixture",
	});
	const forgedRawArtifacts = forgedResults.flatMap(rawFor);
	forgedRawArtifacts[0].value.evidence.browserErrors.console.push("authoritative console error");
	assert.match(
		errorText(validate({ results: forgedResults, rawArtifacts: forgedRawArtifacts })),
		/gate browserErrors\.value actual must be 1/,
	);
});

test("rejects hard timing metrics in every domain", () => {
	const nonRecovery = validResults();
	nonRecovery[0].gates[0].mode = "hard";
	assert.match(errorText(validate({ results: nonRecovery })), /hard gate.*latencyMs.*observe-only/);

	const recovery = validResults(recoveryScenario, recoveryCorrectness);
	recovery[0].gates[0].metric = "elapsedMs";
	recovery[0].gates[0].mode = "hard";
	assert.match(
		errorText(
			validate({
				definition: recoveryScenario,
				matrix: recoveryMatrix,
				results: recovery,
			}),
		),
		/hard gate.*elapsedMs.*observe-only/,
	);
});

test("does not silently accept a flat recovery matrix missing four fault classes", () => {
	const flattened = structuredClone(loadBenchmarkMatrix());
	flattened.domains = undefined;
	flattened.tiers.representative.scenarios = flattened.tiers.representative.scenarios.filter(
		(entry) => entry.kind === "recovery-disconnect" || !entry.kind.startsWith("recovery-"),
	);
	const outcome = validateBenchmarkArtifacts({
		matrix: flattened,
		tier: "representative",
		runId: RUN_ID,
		artifacts: [],
		rawArtifacts: [],
		manifest: {},
		environment: {},
		playwrightExitCode: 0,
	});
	assert.match(errorText(outcome), /recovery\/representative.*exactly 5|all five recovery fault classes/);
});

test("requires every recovery correctness field and keeps diagnostic gates observational", () => {
	const results = validResults(recoveryScenario, recoveryCorrectness);
	assert.deepEqual(validate({ definition: recoveryScenario, matrix: recoveryMatrix, results }).errors, []);

	const missingCorrectness = structuredClone(results);
	delete missingCorrectness[0].trials[1].correctness.processRestarted;
	assert.match(
		errorText(
			validate({
				definition: recoveryScenario,
				matrix: recoveryMatrix,
				results: missingCorrectness,
				rawArtifacts: missingCorrectness.flatMap(rawFor),
			}),
		),
		/correctness\.processRestarted must be boolean for recovery/,
	);

	const hardDiagnostic = structuredClone(results);
	hardDiagnostic[0].gates[0].mode = "hard";
	assert.match(
		errorText(
			validate({
				definition: recoveryScenario,
				matrix: recoveryMatrix,
				results: hardDiagnostic,
				rawArtifacts: hardDiagnostic.flatMap(rawFor),
			}),
		),
		/diagnostic metric latencyMs must remain observe-only/,
	);

	const missingGate = structuredClone(results);
	missingGate[0].gates = missingGate[0].gates.filter((gate) => gate.metric !== "correctnessFailures");
	assert.match(
		errorText(
			validate({
				definition: recoveryScenario,
				matrix: recoveryMatrix,
				results: missingGate,
				rawArtifacts: missingGate.flatMap(rawFor),
			}),
		),
		/hard correctnessFailures=value eq 0 gate/,
	);
});

test("fails closed on malformed evidence and missing required capabilities", () => {
	const nonfinite = validResults();
	nonfinite[0].trials[1].metrics.latencyMs = Number.NaN;
	nonfinite[0].summaries.latencyMs = {
		count: 2,
		min: Number.NaN,
		median: Number.NaN,
		p95: Number.NaN,
		max: Number.NaN,
	};
	assert.match(
		errorText(validate({ results: nonfinite, rawArtifacts: nonfinite.flatMap(rawFor) })),
		/metrics\.latencyMs must be finite/,
	);
	const missing = validResults();
	missing[0].trials[1].metrics = {};
	assert.match(
		errorText(validate({ results: missing, rawArtifacts: missing.flatMap(rawFor) })),
		/metrics must be a non-empty record/,
	);
	const staleGate = validResults();
	staleGate[0].gates[0].metric = "heapDeltaBytes";
	assert.match(
		errorText(validate({ results: staleGate, rawArtifacts: staleGate.flatMap(rawFor) })),
		/gated metric heapDeltaBytes must be finite in every measured trial/,
	);
	const unavailable = validResults();
	unavailable[0].capabilities.websocket = false;
	assert.match(
		errorText(validate({ results: unavailable, rawArtifacts: unavailable.flatMap(rawFor) })),
		/missing required capability: websocket/,
	);
	const malformedRecovery = validResults(recoveryScenario, recoveryCorrectness);
	const malformedRecoveryRaw = malformedRecovery.flatMap(rawFor);
	delete malformedRecoveryRaw[0].value.evidence.recovery.authorityBefore;
	assert.match(
		errorText(
			validate({
				definition: recoveryScenario,
				matrix: recoveryMatrix,
				results: malformedRecovery,
				rawArtifacts: malformedRecoveryRaw,
			}),
		),
		/evidence\.recovery\.authorityBefore/,
	);
});

test("rejects incomplete correctness and failed result status even with a zero outer exit", () => {
	const incomplete = validResults();
	incomplete[0].trials[1].correctness.complete = false;
	incomplete[0].gates[1].actual = 1;
	incomplete[0].gates[1].passed = false;
	incomplete[0].status = "failed";
	assert.match(
		errorText(validate({ results: incomplete, rawArtifacts: incomplete.flatMap(rawFor) })),
		/correctness\.complete must be true/,
	);
	assert.match(
		errorText(validate({ results: incomplete, rawArtifacts: incomplete.flatMap(rawFor) })),
		/status must be passed in a complete formal result/,
	);
	const failed = validResults();
	failed[0].status = "failed";
	assert.match(
		errorText(validate({ results: failed, rawArtifacts: failed.flatMap(rawFor) })),
		/status must be passed in a complete formal result/,
	);
});

test("rejects singleton producer declarations and a tampered execution order", () => {
	const manifest = validManifest();
	manifest.expectedScenarioSet = manifest.expectedScenarioSet.filter(
		(entry) => entry.variant === "coalesced",
	);
	manifest.buildVariants = { coalesced: manifest.buildVariants.coalesced };
	manifest.canonicalVariants = ["coalesced"];
	manifest.executionOrder = ["coalesced"];
	assert.match(errorText(validate({ manifest })), /canonicalVariants must be exactly/);
	assert.match(errorText(validate({ manifest })), /complete canonical matrix × formal variant set/);
	const orderManifest = validManifest();
	orderManifest.executionOrder.reverse();
	assert.match(errorText(validate({ manifest: orderManifest })), /deterministic seeded formal variant order/);
});

test("recomputes summaries, gates, tier, and canonical manifest counts", () => {
	const results = validResults();
	results[0].summaries.latencyMs.p95 = 1;
	results[0].gates[0].actual = 1;
	results[0].gates[0].passed = false;
	const manifest = validManifest();
	manifest.measuredCounts["streaming/stream-test/coalesced"] = 1;
	const errors = errorText(validate({ results, manifest }));
	assert.match(errors, /summary latencyMs\.p95 must be 20/);
	assert.match(errors, /gate latencyMs\.p95 actual must be 20/);
	assert.match(errors, /gate latencyMs\.p95 passed must be true/);
	assert.match(errors, /measuredCounts\.streaming\/stream-test\/coalesced must match expected scenario/);
});

test("rejects provenance hash drift and a nonzero Playwright run reported green", () => {
	const manifest = validManifest();
	manifest.matrix.rootHash = HASH_B;
	const errors = errorText(validate({ manifest, playwrightExitCode: 1 }));
	assert.match(errors, /rootHash must match the loaded root matrix hash/);
	assert.match(errors, /Playwright exited nonzero: 1/);
	assert.match(errors, /Playwright nonzero cannot report green/);
});

test("requires the exact shared fixture producer hash set", () => {
	const manifest = validManifest();
	manifest.fixtureHashes.extraProducer = HASH_A;
	assert.match(errorText(validate({ manifest })), /fixtureHashes.*exactly/);
});

test("rejects duplicate, missing, and extra scenario results before result-map overwrite", () => {
	const results = validResults();
	const duplicate = structuredClone(results[0]);
	const extra = structuredClone(results[0]);
	extra.scenarioId = "extra";
	extra.parameters.id = "extra";
	const errors = errorText(
		validate({
			artifacts: [
				{ name: "first.result.json", value: results[0] },
				{ name: "second.result.json", value: duplicate },
				{ name: "sequential.result.json", value: results[1] },
				{ name: "extra.result.json", value: extra },
			],
		}),
	);
	assert.match(errors, /duplicate scenario artifact: streaming\/stream-test\/coalesced/);
	assert.match(errors, /unexpected scenario artifact: streaming\/extra\/coalesced/);
});
