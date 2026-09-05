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
	"evidence",
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
	"buildIdentity",
	"buildVariants",
	"canonicalVariants",
	"capabilities",
	"executionOrder",
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
const FORMAL_BENCHMARK_VARIANTS = Object.freeze(["coalesced", "sequential"]);
const BENCHMARK_VARIANTS = new Set(FORMAL_BENCHMARK_VARIANTS);
const RECOVERY_DOMAIN_ID = "recovery";
const RECOVERY_FAULT_KINDS = Object.freeze([
	"recovery-disconnect",
	"recovery-gap",
	"recovery-crash",
	"recovery-rekey",
	"recovery-gateway-restart",
]);
const RECOVERY_CORRECTNESS_KEYS = Object.freeze([
	"recoveryBarrier",
	"zeroDuplicateLostEvents",
	"staleGenerationRejected",
	"staleFenceRejected",
	"staleEpochRejected",
	"finalProjectionMatches",
]);
const RECOVERY_KIND_CORRECTNESS_KEYS = Object.freeze({
	"recovery-disconnect": ["disconnectObserved"],
	"recovery-gap": ["gapResyncObserved"],
	"recovery-crash": ["processRestarted"],
	"recovery-rekey": ["rekeyIdentityChanged"],
	"recovery-gateway-restart": ["restartCleanup"],
});
const BUILD_VARIANT_KEYS = ["serverEntry", "serverEntryHash", "serverTreeHash", "uiDirectory", "uiTreeHash"];
const STANDARD_BUILD_IDENTITY_KEYS = ["cliTreeHash", "serverTreeHash", "uiTreeHash"];
/** Files that can alter benchmark recovery evidence are hashed by both producer and validator. */
export const BENCHMARK_PRODUCER_PATHS = Object.freeze(
	[
		"tests/e2e/benchmarks/benchmark-support.ts",
		"tests/e2e/benchmarks/recovery.spec.ts",
		"tests/e2e/fixtures/deterministic-pi.mjs",
		"tests/e2e/fixtures/page-observation.ts",
		"tests/e2e/fixtures/production-harness.ts",
		"tests/e2e/fixtures/test.ts",
		"tests/e2e/specs/recovery-acceptance.spec.ts",
	].sort(),
);
const HARD_GATE_METRICS = new Set([
	"activeGateways",
	"authenticatedAttachmentFetch",
	"backgroundIngestCheckpointDeficit",
	"browserErrors",
	"browserProjectionCheckpointDeficit",
	"correctnessFailures",
	"gapResyncFrames",
	"gatewayStarts",
	"maxReceivedFrameBytes",
	"maxSentFrameBytes",
	"processStarts",
	"reconnectedSockets",
	"rekeyFrames",
	"rootEntryCount",
	"turnNodes",
]);
const GATE_METRIC_POLICY = Object.freeze(
	Object.fromEntries(
		[
			...HARD_GATE_METRICS,
			"aggregateDeltaPerSecond",
			"baselineFrames",
			"browserFrameArrivalGapMs",
			"browserProjectionLagMs",
			"completionSkewMs",
			"deltaCount",
			"durationSkewMs",
			"firstPageMs",
			"gatewayRestartMs",
			"heapDeltaBytes",
			"inputBase64Chars",
			"inputToNextPaintMs",
			"inputToPublicationMs",
			"liveLongTaskMaxMs",
			"liveLongTasksOver50Ms",
			"nextPageMs",
			"processRestartMs",
			"publicationBatches",
			"publicationRatio",
			"producerProgressGapMs",
			"recoveryMs",
			"rekeyMs",
			"replayFrames",
			"roundTripMs",
			"selectionMs",
			"settlementMs",
			"sourceBytes",
			"streamDurationMs",
			"structuralDomTransitionMs",
			"totalCompletionMs",
		].map((metric) => [metric, HARD_GATE_METRICS.has(metric) ? "hard" : "observe"]),
	),
);
const EVIDENCE_KEYS = ["browserErrors", "hardMetrics", "recovery"];
const BROWSER_ERROR_KEYS = ["console", "page"];
const AUTHORITY_EVIDENCE_KEYS = [
	"fencingToken",
	"generation",
	"nativeSessionId",
	"serverEpoch",
	"sessionFile",
	"sessionHandle",
	"workspaceHandle",
	"workspacePath",
];
const STALE_COMMAND_EVIDENCE_KEYS = [
	"piCommandCountAfter",
	"piCommandCountBefore",
	"responseError",
	"responseSuccess",
	"responseType",
];
const RECOVERY_STALE_KEYS = ["epoch", "fence", "generation", "parent"];
const RECOVERY_SEQUENCE_KEYS = ["expected", "observed"];
const RECOVERY_PROJECTION_KEYS = ["prompt", "promptCount", "reply", "replyCount"];
const RECOVERY_FAULT_KEYS = [
	"activeGateways",
	"gatewayStarts",
	"gapResyncCount",
	"identityChanged",
	"observed",
	"oldParentRejected",
	"ownedGatewayCount",
	"processRestartCount",
	"reconnectCount",
	"rekeyFrameCount",
	"rootEntryCount",
	"stableOrigin",
];

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

function validRelativeArtifactPath(value) {
	return relativeDomainPath(value) && !value.startsWith("./");
}

function seededVariantOrder(seed) {
	return [...FORMAL_BENCHMARK_VARIANTS].sort((left, right) => {
		const leftHash = sha256(`${seed}\0${left}`);
		const rightHash = sha256(`${seed}\0${right}`);
		return leftHash.localeCompare(rightHash) || left.localeCompare(right);
	});
}

function canonicalExpectedScenarioSet(matrix, tier, errors) {
	return matrixScenarios(matrix, tier, errors).flatMap((scenario) =>
		FORMAL_BENCHMARK_VARIANTS.map((variant) => ({
			id: scenario.id,
			domain: scenario.domain,
			kind: scenario.kind,
			variant,
			warmups: scenario.warmups,
			measured: scenario.samples,
			requiredCapabilities: scenario.requiredCapabilities,
		})),
	);
}

/** The formal matrix × variant set is one contract shared by the producer and validator. */
export function canonicalFormalExpectedScenarioSet(matrix, tier) {
	const errors = [];
	const expected = canonicalExpectedScenarioSet(matrix, tier, errors);
	if (errors.length > 0) throw new Error(errors.join("\n"));
	return expected;
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

function validateRecoveryMatrixDomain(matrixOrDomains, tier, errors) {
	let scenarios;
	if (Array.isArray(matrixOrDomains)) {
		const recovery = matrixOrDomains.find((domain) => isRecord(domain) && domain.id === RECOVERY_DOMAIN_ID);
		scenarios = Array.isArray(recovery?.tiers?.[tier]?.scenarios) ? recovery.tiers[tier].scenarios : [];
	} else {
		const isCanonicalFlatMatrix =
			Array.isArray(matrixOrDomains?.domains) ||
			Object.keys(matrixOrDomains?.provenance?.domainHashes ?? {}).length > 1;
		if (!isCanonicalFlatMatrix) return;
		const selected = isRecord(matrixOrDomains?.tiers) ? matrixOrDomains.tiers[tier] : undefined;
		scenarios = Array.isArray(selected?.scenarios)
			? selected.scenarios.filter((scenario) => isRecord(scenario) && scenario.domain === RECOVERY_DOMAIN_ID)
			: [];
	}
	if (scenarios.length === 0) {
		errors.push("matrix: recovery domain must declare all five recovery fault classes");
		return;
	}
	if (scenarios.length !== RECOVERY_FAULT_KINDS.length) {
		errors.push(
			`matrix: recovery/${tier} must contain exactly ${String(RECOVERY_FAULT_KINDS.length)} distinct fault classes`,
		);
	}
	const kinds = scenarios.map((scenario) => (isRecord(scenario) ? scenario.kind : undefined));
	const distinctKinds = [...new Set(kinds)];
	if (
		distinctKinds.length !== RECOVERY_FAULT_KINDS.length ||
		!RECOVERY_FAULT_KINDS.every((kind) => distinctKinds.includes(kind))
	) {
		errors.push(`matrix: recovery/${tier} fault classes must be exactly ${RECOVERY_FAULT_KINDS.join(", ")}`);
	}
	for (const [index, scenario] of scenarios.entries()) {
		if (!isRecord(scenario)) continue;
		const expectedWarmups = tier === "stress" ? 2 : 1;
		const expectedSamples = tier === "stress" ? 100 : 3;
		if (scenario.warmups !== expectedWarmups || scenario.samples !== expectedSamples) {
			errors.push(
				`matrix: recovery/${tier} scenario ${String(index)} must use ${String(expectedWarmups)} warmup(s) and ${String(expectedSamples)} measured sample(s)`,
			);
		}
	}
}

function validateMatrixProjection(matrix, tier, errors) {
	if (!Array.isArray(matrix?.domains)) return;
	const projected = [];
	for (const domain of matrix.domains) {
		const scenarios = Array.isArray(domain?.tiers?.[tier]?.scenarios) ? domain.tiers[tier].scenarios : [];
		for (const scenario of scenarios) {
			projected.push({
				...scenario,
				domain: domain.id,
				requiredCapabilities: Array.isArray(domain.requiredCapabilities)
					? [...domain.requiredCapabilities]
					: [],
			});
		}
	}
	if (!isDeepStrictEqual(matrix.tiers?.[tier]?.scenarios, projected)) {
		errors.push(`matrix: ${tier} tier must exactly project its declared domain matrices`);
	}
}

function isRecoveryKind(kind) {
	return RECOVERY_FAULT_KINDS.includes(kind);
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
	validateRecoveryMatrixDomain(domains, "representative", errors);
	validateRecoveryMatrixDomain(domains, "stress", errors);

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
			if (trial.correctness.complete !== true) {
				errors.push(`trial ${String(index)} correctness.complete must be true`);
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

function validateStringArray(value, label, errors) {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		errors.push(`${label} must be a string array`);
		return false;
	}
	return true;
}

function validateNonnegativeInteger(value, label, errors) {
	if (!Number.isSafeInteger(value) || value < 0) {
		errors.push(`${label} must be a non-negative safe integer`);
		return false;
	}
	return true;
}

function validateAuthorityEvidence(value, label, errors) {
	if (!exactKeys(value, AUTHORITY_EVIDENCE_KEYS)) {
		errors.push(`${label} must contain exactly ${AUTHORITY_EVIDENCE_KEYS.join(", ")}`);
		return false;
	}
	for (const key of [
		"fencingToken",
		"nativeSessionId",
		"serverEpoch",
		"sessionHandle",
		"workspaceHandle",
		"workspacePath",
	]) {
		if (typeof value[key] !== "string" || value[key].length === 0) {
			errors.push(`${label}.${key} must be a non-empty string`);
		}
	}
	if (
		value.sessionFile !== null &&
		(typeof value.sessionFile !== "string" || value.sessionFile.length === 0)
	) {
		errors.push(`${label}.sessionFile must be null or a non-empty string`);
	}
	validateNonnegativeInteger(value.generation, `${label}.generation`, errors);
}

function validateStaleCommandEvidence(value, label, errors) {
	if (!exactKeys(value, STALE_COMMAND_EVIDENCE_KEYS)) {
		errors.push(`${label} must contain exactly ${STALE_COMMAND_EVIDENCE_KEYS.join(", ")}`);
		return false;
	}
	if (typeof value.responseType !== "string" || value.responseType.length === 0) {
		errors.push(`${label}.responseType must be a non-empty string`);
	}
	if (typeof value.responseSuccess !== "boolean") errors.push(`${label}.responseSuccess must be boolean`);
	if (value.responseError !== null && typeof value.responseError !== "string") {
		errors.push(`${label}.responseError must be null or a string`);
	}
	validateNonnegativeInteger(value.piCommandCountBefore, `${label}.piCommandCountBefore`, errors);
	validateNonnegativeInteger(value.piCommandCountAfter, `${label}.piCommandCountAfter`, errors);
	return true;
}

function validateRecoveryTrialEvidence(value, definition, label, errors) {
	if (!isRecord(value)) {
		errors.push(`${label} must be a recovery evidence record`);
		return;
	}
	const expectedKeys = [
		"authorityAfter",
		"authorityBefore",
		"fault",
		"kind",
		"projection",
		"sequence",
		"stale",
	];
	if (!exactKeys(value, expectedKeys)) {
		errors.push(`${label} must contain exactly ${expectedKeys.join(", ")}`);
	}
	if (value.kind !== definition.kind) errors.push(`${label}.kind must match the recovery scenario kind`);
	validateAuthorityEvidence(value.authorityBefore, `${label}.authorityBefore`, errors);
	validateAuthorityEvidence(value.authorityAfter, `${label}.authorityAfter`, errors);

	if (!exactKeys(value.sequence, RECOVERY_SEQUENCE_KEYS)) {
		errors.push(`${label}.sequence must contain exactly ${RECOVERY_SEQUENCE_KEYS.join(", ")}`);
	} else {
		for (const key of RECOVERY_SEQUENCE_KEYS) {
			const sequence = value.sequence[key];
			if (!Array.isArray(sequence) || sequence.some((entry) => !Number.isSafeInteger(entry) || entry <= 0)) {
				errors.push(`${label}.sequence.${key} must be a positive safe integer array`);
			}
		}
	}
	if (!exactKeys(value.projection, RECOVERY_PROJECTION_KEYS)) {
		errors.push(`${label}.projection must contain exactly ${RECOVERY_PROJECTION_KEYS.join(", ")}`);
	} else {
		for (const key of ["prompt", "reply"]) {
			if (typeof value.projection[key] !== "string" || value.projection[key].length === 0) {
				errors.push(`${label}.projection.${key} must be a non-empty string`);
			}
		}
		validateNonnegativeInteger(value.projection.promptCount, `${label}.projection.promptCount`, errors);
		validateNonnegativeInteger(value.projection.replyCount, `${label}.projection.replyCount`, errors);
	}
	if (!exactKeys(value.stale, RECOVERY_STALE_KEYS)) {
		errors.push(`${label}.stale must contain exactly ${RECOVERY_STALE_KEYS.join(", ")}`);
	} else {
		for (const key of RECOVERY_STALE_KEYS) {
			validateStaleCommandEvidence(value.stale[key], `${label}.stale.${key}`, errors);
		}
	}
	if (!exactKeys(value.fault, RECOVERY_FAULT_KEYS)) {
		errors.push(`${label}.fault must contain exactly ${RECOVERY_FAULT_KEYS.join(", ")}`);
	} else {
		for (const key of ["observed", "identityChanged", "oldParentRejected", "stableOrigin"]) {
			if (typeof value.fault[key] !== "boolean") errors.push(`${label}.fault.${key} must be boolean`);
		}
		for (const key of [
			"activeGateways",
			"gatewayStarts",
			"gapResyncCount",
			"ownedGatewayCount",
			"processRestartCount",
			"reconnectCount",
			"rekeyFrameCount",
			"rootEntryCount",
		]) {
			validateNonnegativeInteger(value.fault[key], `${label}.fault.${key}`, errors);
		}
	}
}

function validateTrialEvidence(value, definition, label, errors) {
	if (!exactKeys(value, EVIDENCE_KEYS)) {
		errors.push(`${label}: evidence must contain exactly ${EVIDENCE_KEYS.join(", ")}`);
		return;
	}
	if (!exactKeys(value.browserErrors, BROWSER_ERROR_KEYS)) {
		errors.push(`${label}: evidence.browserErrors must contain exactly ${BROWSER_ERROR_KEYS.join(", ")}`);
	} else {
		validateStringArray(value.browserErrors.console, `${label}: evidence.browserErrors.console`, errors);
		validateStringArray(value.browserErrors.page, `${label}: evidence.browserErrors.page`, errors);
	}
	if (!isRecord(value.hardMetrics) || Object.keys(value.hardMetrics).length === 0) {
		errors.push(`${label}: evidence.hardMetrics must be a non-empty finite-number record`);
	} else {
		for (const [metric, metricValue] of Object.entries(value.hardMetrics)) {
			if (!isFiniteNumber(metricValue) || metricValue < 0) {
				errors.push(`${label}: evidence.hardMetrics.${metric} must be a non-negative finite number`);
			}
		}
	}
	if (isRecoveryKind(definition.kind)) {
		validateRecoveryTrialEvidence(value.recovery, definition, `${label}: evidence.recovery`, errors);
	} else if (value.recovery !== null) {
		errors.push(`${label}: non-recovery evidence.recovery must be null`);
	}
}

function gatePolicy(metric) {
	return GATE_METRIC_POLICY[metric] ?? "observe";
}

function evidenceForTrial(evidenceByTrial, result, trial) {
	return evidenceByTrial.get(
		`${scenarioKey({ domain: result.domain, id: result.scenarioId, variant: result.variant })}/${String(trial.index)}`,
	);
}

function hardMetricValues(metric, result, trials, evidenceByTrial, errors) {
	const values = [];
	for (const trial of trials) {
		const evidence = evidenceForTrial(evidenceByTrial, result, trial);
		const value = evidence?.hardMetrics?.[metric];
		if (!isFiniteNumber(value) || value < 0) {
			errors.push(
				`hard gate metric ${metric} requires authoritative raw evidence for trial ${String(trial.index)}`,
			);
			continue;
		}
		values.push({ trial, value });
	}
	return values;
}

function recoveryFailureCount(evidence, definition) {
	if (!evidence?.recovery) return 0;
	const value = evidence.recovery;
	if (
		!isRecord(value.authorityBefore) ||
		!isRecord(value.authorityAfter) ||
		!isRecord(value.sequence) ||
		!Array.isArray(value.sequence.expected) ||
		!Array.isArray(value.sequence.observed) ||
		!isRecord(value.projection) ||
		!isRecord(value.stale) ||
		RECOVERY_STALE_KEYS.some((key) => !isRecord(value.stale[key])) ||
		!isRecord(value.fault)
	) {
		return 1;
	}
	let failures = 0;
	const before = value.authorityBefore;
	const after = value.authorityAfter;
	const sameIdentity =
		before.workspaceHandle === after.workspaceHandle &&
		before.workspacePath === after.workspacePath &&
		before.sessionHandle === after.sessionHandle &&
		before.nativeSessionId === after.nativeSessionId &&
		before.sessionFile === after.sessionFile;
	const identityChanged =
		before.sessionHandle !== after.sessionHandle ||
		before.nativeSessionId !== after.nativeSessionId ||
		before.sessionFile !== after.sessionFile;
	if (before.workspaceHandle !== after.workspaceHandle || before.workspacePath !== after.workspacePath)
		failures += 1;
	if (definition.kind === "recovery-rekey" ? !identityChanged : !sameIdentity) failures += 1;
	if (
		definition.kind === "recovery-gateway-restart"
			? before.serverEpoch === after.serverEpoch
			: before.serverEpoch !== after.serverEpoch
	) {
		failures += 1;
	}
	if (["recovery-crash", "recovery-rekey"].includes(definition.kind)) {
		if (after.generation <= before.generation) failures += 1;
	} else if (after.generation !== before.generation) {
		failures += 1;
	}
	if (
		!isDeepStrictEqual(value.sequence.expected, value.sequence.observed) ||
		new Set(value.sequence.expected).size !== value.sequence.expected.length ||
		value.sequence.expected.length === 0
	) {
		failures += 1;
	}
	if (value.projection.promptCount !== 1 || value.projection.replyCount !== 1) failures += 1;
	const stale = value.stale;
	if (
		stale.generation.responseSuccess !== false ||
		!stale.generation.responseError?.includes("session_generation_stale") ||
		stale.generation.piCommandCountAfter !== stale.generation.piCommandCountBefore
	)
		failures += 1;
	if (
		stale.fence.responseSuccess !== false ||
		!stale.fence.responseError?.includes("session_read_only") ||
		stale.fence.piCommandCountAfter !== stale.fence.piCommandCountBefore
	)
		failures += 1;
	if (
		stale.epoch.responseType !== "resync_required" ||
		stale.epoch.responseSuccess !== false ||
		stale.epoch.piCommandCountAfter !== stale.epoch.piCommandCountBefore
	)
		failures += 1;
	if (definition.kind === "recovery-rekey") {
		if (
			stale.parent.responseSuccess !== false ||
			stale.parent.piCommandCountAfter !== stale.parent.piCommandCountBefore ||
			!value.fault.oldParentRejected
		) {
			failures += 1;
		}
	} else if (stale.parent.responseType !== "not_applicable") {
		failures += 1;
	}
	const fault = value.fault;
	if (definition.kind === "recovery-disconnect") {
		if (!fault.observed || fault.reconnectCount < 1) failures += 1;
	} else if (definition.kind === "recovery-gap") {
		if (!fault.observed || fault.gapResyncCount !== 1) failures += 1;
	} else if (definition.kind === "recovery-crash") {
		if (!fault.observed || fault.processRestartCount !== 1) failures += 1;
	} else if (definition.kind === "recovery-rekey") {
		if (!fault.observed || fault.rekeyFrameCount !== 1 || !fault.identityChanged) failures += 1;
	} else if (
		!fault.observed ||
		!fault.stableOrigin ||
		fault.gatewayStarts !== 1 ||
		fault.activeGateways !== 1 ||
		fault.ownedGatewayCount !== fault.gatewayStarts ||
		fault.rootEntryCount > 8
	) {
		failures += 1;
	}
	return failures;
}

function validateGates(result, definition, trials, expectedSummaries, evidenceByTrial, errors) {
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
		if (gate.mode === "hard" && gatePolicy(gate.metric) !== "hard") {
			errors.push(`hard gate ${key} diagnostic metric ${gate.metric} must remain observe-only`);
		}
		if (!isFiniteNumber(gate.threshold)) errors.push(`gate ${key} threshold must be finite`);
		if (typeof gate.rationale !== "string" || gate.rationale.length === 0) {
			errors.push(`gate ${key} rationale must be non-empty`);
		}

		let expectedActual = gate.actual;
		if (gate.mode === "hard") {
			const authoritativeValues =
				gate.metric === "browserErrors"
					? []
					: hardMetricValues(gate.metric, result, trials, evidenceByTrial, errors);
			if (gate.metric === "browserErrors") {
				expectedActual = 0;
				for (const trial of trials) {
					const evidence = evidenceForTrial(evidenceByTrial, result, trial);
					if (!evidence) continue;
					expectedActual += evidence.browserErrors.console.length + evidence.browserErrors.page.length;
				}
			} else if (gate.statistic === "value") {
				if (authoritativeValues.length > 0) {
					expectedActual =
						gate.metric === "correctnessFailures"
							? authoritativeValues.reduce((total, entry) => total + entry.value, 0)
							: Math.max(...authoritativeValues.map((entry) => entry.value));
				}
			} else {
				const measuredValues = authoritativeValues
					.filter((entry) => entry.trial.warmup === false)
					.map((entry) => entry.value);
				if (measuredValues.length === definition.samples) {
					expectedActual = summarize(measuredValues)[gate.statistic];
				} else {
					errors.push(`hard gate ${key} has incomplete authoritative raw evidence`);
				}
			}
		} else if (gate.statistic === "value") {
			if (!isFiniteNumber(gate.actual)) errors.push(`gate ${key} actual must be finite`);
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
		if (gate.mode === "hard" && !isFiniteNumber(expectedActual)) {
			errors.push(`hard gate ${key} actual must be finite from authoritative raw evidence`);
		} else if (gate.mode === "hard" && gate.actual !== expectedActual) {
			errors.push(`gate ${key} actual must be ${String(expectedActual)}`);
		}
		const expectedPassed =
			isFiniteNumber(expectedActual) && COMPARISONS.has(gate.comparison) && isFiniteNumber(gate.threshold)
				? compare(expectedActual, gate.comparison, gate.threshold)
				: null;
		if (gate.passed !== expectedPassed) errors.push(`gate ${key} passed must be ${String(expectedPassed)}`);
		if (gate.mode === "hard" && expectedPassed !== true) {
			errors.push(`hard gate ${key} must pass in a complete formal result`);
		}
		validated.push({ ...gate, recomputedPassed: expectedPassed });
	}
	return validated;
}

function validateRecoveryResult(result, definition, trials, evidenceByTrial, errors) {
	const expectedKeys = [
		"complete",
		...RECOVERY_CORRECTNESS_KEYS,
		...(RECOVERY_KIND_CORRECTNESS_KEYS[definition.kind] ?? []),
	];
	for (const [index, trial] of trials.entries()) {
		if (!isRecord(trial?.correctness)) continue;
		for (const key of expectedKeys) {
			if (typeof trial.correctness[key] !== "boolean") {
				errors.push(`trial ${String(index)} correctness.${key} must be boolean for recovery`);
			}
		}
		const evidence = evidenceForTrial(evidenceByTrial, result, trial);
		if (!evidence?.recovery) {
			errors.push(`trial ${String(index)} recovery must include authoritative raw recovery evidence`);
		} else if (recoveryFailureCount(evidence, definition) > 0) {
			errors.push(`trial ${String(index)} recovery evidence failed authoritative recovery invariants`);
		}
	}
	const correctnessGate = Array.isArray(result.gates)
		? result.gates.find(
				(gate) =>
					isRecord(gate) &&
					gate.metric === "correctnessFailures" &&
					gate.statistic === "value" &&
					gate.comparison === "eq" &&
					gate.threshold === 0 &&
					gate.mode === "hard",
			)
		: undefined;
	if (!correctnessGate) {
		errors.push("recovery result must include a hard correctnessFailures=value eq 0 gate");
	}
}

function validateResult(result, definition, tier, runId, evidenceByTrial) {
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
	const gates = validateGates(result, definition, trials, summaries, evidenceByTrial, errors);
	if (isRecoveryKind(definition.kind))
		validateRecoveryResult(result, definition, trials, evidenceByTrial, errors);
	const recordedErrors = Array.isArray(result.errors) ? result.errors : [];
	if (recordedErrors.length > 0) errors.push("result errors must be empty in a complete formal result");
	if (gates.some((gate) => gate.mode === "hard" && gate.recomputedPassed !== true)) {
		errors.push("all hard correctness gates must pass in a complete formal result");
	}
	if (result.status !== "passed") errors.push("status must be passed in a complete formal result");
	return errors;
}

function scenarioKey({ domain, id, variant }) {
	return `${domain}/${id}/${variant}`;
}

function validateRawArtifacts(rawArtifacts, results, errors) {
	const evidenceByTrial = new Map();
	if (!Array.isArray(rawArtifacts)) {
		errors.push("raw artifacts must be an array");
		return evidenceByTrial;
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
		const expectedName = `${value.scenarioId}/${value.variant}-${String(value.trial.index)}.json`;
		if (label !== expectedName) {
			errors.push(`${label}: raw trial path must be ${expectedName}`);
		}
		const expectedEntry = expected.get(indexedKey);
		if (!expectedEntry) {
			errors.push(`${label}: unexpected raw trial: ${indexedKey}`);
			continue;
		}
		const result = expectedEntry.result;
		validateTrialEvidence(value.evidence, { kind: result.kind }, label, errors);
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
		if (isRecord(value.evidence)) evidenceByTrial.set(indexedKey, value.evidence);
	}
	for (const key of expected.keys()) {
		if (!seen.has(key)) errors.push(`missing raw trial: ${key}`);
	}
	return evidenceByTrial;
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
	if (!isDeepStrictEqual(manifest.canonicalVariants, FORMAL_BENCHMARK_VARIANTS)) {
		errors.push(`manifest canonicalVariants must be exactly ${FORMAL_BENCHMARK_VARIANTS.join(", ")}`);
	}
	if (!isDeepStrictEqual(manifest.executionOrder, seededVariantOrder(manifest.seed))) {
		errors.push("manifest executionOrder must be the deterministic seeded formal variant order");
	}
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
	if (!isRecord(manifest.fixtureHashes) || Object.keys(manifest.fixtureHashes).length === 0) {
		errors.push("manifest fixtureHashes must be a non-empty record");
	} else {
		const expectedFixtureHashes = Object.fromEntries(
			BENCHMARK_PRODUCER_PATHS.map((relativePath) => [
				relativePath,
				sha256File(path.join(repositoryRoot, relativePath)),
			]),
		);
		if (!isDeepStrictEqual(manifest.fixtureHashes, expectedFixtureHashes)) {
			errors.push(
				`manifest fixtureHashes must exactly match the shared producer set: ${BENCHMARK_PRODUCER_PATHS.join(", ")}`,
			);
		}
		for (const [name, value] of Object.entries(manifest.fixtureHashes)) {
			if (!validHash(value)) errors.push(`manifest fixtureHashes.${name} must be a SHA-256 hash`);
		}
	}
	if (!exactKeys(manifest.buildIdentity, STANDARD_BUILD_IDENTITY_KEYS)) {
		errors.push(`manifest buildIdentity must contain exactly ${STANDARD_BUILD_IDENTITY_KEYS.join(", ")}`);
	} else {
		for (const key of STANDARD_BUILD_IDENTITY_KEYS) {
			if (!validHash(manifest.buildIdentity[key])) {
				errors.push(`manifest buildIdentity.${key} must be a SHA-256 hash`);
			}
		}
	}
	if (!isRecord(manifest.buildVariants) || !exactKeys(manifest.buildVariants, FORMAL_BENCHMARK_VARIANTS)) {
		errors.push(`manifest buildVariants must contain exactly ${FORMAL_BENCHMARK_VARIANTS.join(", ")}`);
	} else {
		for (const variant of FORMAL_BENCHMARK_VARIANTS) {
			const build = manifest.buildVariants[variant];
			if (!exactKeys(build, BUILD_VARIANT_KEYS)) {
				errors.push(
					`manifest buildVariants.${variant} must contain exactly ${BUILD_VARIANT_KEYS.join(", ")}`,
				);
				continue;
			}
			if (!validRelativeArtifactPath(build.uiDirectory)) {
				errors.push(`manifest buildVariants.${variant}.uiDirectory must be a normalized run-relative path`);
			}
			if (!validRelativeArtifactPath(build.serverEntry)) {
				errors.push(`manifest buildVariants.${variant}.serverEntry must be a normalized run-relative path`);
			}
			for (const key of ["serverEntryHash", "serverTreeHash", "uiTreeHash"]) {
				if (!validHash(build[key])) {
					errors.push(`manifest buildVariants.${variant}.${key} must be a SHA-256 hash`);
				}
			}
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
	const canonicalExpected = canonicalExpectedScenarioSet(matrix, tier, errors);
	if (!isDeepStrictEqual(manifest.expectedScenarioSet, canonicalExpected)) {
		errors.push("manifest expectedScenarioSet must be the complete canonical matrix × formal variant set");
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
	const canonicalKeys = new Set(canonicalExpected.map((entry) => scenarioKey(entry)));
	if (!isDeepStrictEqual(expectedKeys, canonicalKeys)) {
		errors.push("manifest expected scenario keys must exactly match the canonical formal set");
	}
	const canonicalWarmups = Object.fromEntries(
		canonicalExpected.map((entry) => [scenarioKey(entry), entry.warmups]),
	);
	const canonicalMeasured = Object.fromEntries(
		canonicalExpected.map((entry) => [scenarioKey(entry), entry.measured]),
	);
	if (!isDeepStrictEqual(manifest.warmupCounts, canonicalWarmups)) {
		errors.push("manifest warmupCounts must exactly match the canonical formal scenario set");
	}
	if (!isDeepStrictEqual(manifest.measuredCounts, canonicalMeasured)) {
		errors.push("manifest measuredCounts must exactly match the canonical formal scenario set");
	}
	validateCapabilities(
		manifest.capabilities,
		[...new Set(canonicalExpected.flatMap((entry) => entry.requiredCapabilities))],
		errors,
		"manifest",
	);
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
	validateRecoveryMatrixDomain(matrix, tier, errors);
	validateMatrixProjection(matrix, tier, errors);
	const expectedScenarios = matrixScenarios(matrix, tier, errors);
	const definitions = new Map();
	for (const scenario of expectedScenarios) definitions.set(`${scenario.domain}/${scenario.id}`, scenario);

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
	const variants = new Set(FORMAL_BENCHMARK_VARIANTS);
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
		const definition = definitions.get(`${domain}/${id}`);
		if (!definition || definition.domain !== domain || !variants.has(variant)) {
			errors.push(`unexpected scenario artifact: ${key}`);
		}
	}

	const artifactValues = artifactList.map((artifact) => artifact.value).filter(isRecord);
	const evidenceByTrial = validateRawArtifacts(rawArtifacts, artifactValues, errors);
	const results = [];
	for (const artifact of artifactList) {
		const label = typeof artifact?.name === "string" ? artifact.name : "artifact";
		if (!isRecord(artifact?.value)) {
			errors.push(`${label}: artifact must be a record`);
			continue;
		}
		const definition = definitions.get(`${artifact.value.domain}/${artifact.value.scenarioId}`);
		if (!definition) continue;
		const expectedResultName = `${artifact.value.scenarioId}/${artifact.value.variant}.result.json`;
		if (label !== expectedResultName) {
			errors.push(`${label}: result artifact path must be ${expectedResultName}`);
		}
		const resultErrors = validateResult(artifact.value, definition, tier, runId, evidenceByTrial);
		for (const error of resultErrors) errors.push(`${label}: ${error}`);
		if (resultErrors.length === 0) results.push(artifact.value);
	}
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
