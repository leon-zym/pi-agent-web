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
	"observation",
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
	"recovery-rekey": ["rekeyIdentityChanged", "staleParentRejected"],
	"recovery-gateway-restart": ["restartCleanup"],
});
const BUILD_VARIANT_KEYS = ["serverEntry", "serverEntryHash", "serverTreeHash", "uiDirectory", "uiTreeHash"];
const STANDARD_BUILD_IDENTITY_KEYS = ["cliTreeHash", "serverTreeHash", "uiTreeHash"];
/** Files that can alter benchmark recovery observations are hashed by both producer and validator. */
export const BENCHMARK_PRODUCER_PATHS = Object.freeze(
	[
		"scripts/run-performance-benchmarks.mjs",
		"tests/e2e/benchmarks/benchmark-support.ts",
		"tests/e2e/benchmarks/concurrency.spec.ts",
		"tests/e2e/benchmarks/content-roundtrip.spec.ts",
		"tests/e2e/benchmarks/history.spec.ts",
		"tests/e2e/benchmarks/playwright.config.ts",
		"tests/e2e/benchmarks/recovery.spec.ts",
		"tests/e2e/benchmarks/streaming.spec.ts",
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
	"mountedTurnNodes",
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
const OBSERVATION_KEYS = ["browserErrors", "facts", "kind"];
const BROWSER_ERROR_KEYS = ["console", "page"];
const AUTHORITY_FACT_KEYS = [
	"fencingToken",
	"generation",
	"nativeSessionId",
	"persisted",
	"serverEpoch",
	"sessionFile",
	"sessionHandle",
	"workspaceHandle",
	"workspacePath",
];
const STALE_COMMAND_KEYS = [
	"piCommandCountAfter",
	"piCommandCountBefore",
	"requestId",
	"responseError",
	"responseSuccess",
	"responseType",
];
const RECOVERY_STALE_KEYS = ["epoch", "fence", "generation", "parent"];
const RECOVERY_SEQUENCE_KEYS = ["barrier", "cursorBefore", "mode", "observedEventSeqs", "watermarkAfter"];
const RECOVERY_BARRIER_KEYS = [
	"asOfSeq",
	"baseSeq",
	"barrierSeq",
	"reason",
	"required",
	"runtimeLastSeq",
	"snapshotSeen",
];
const RECOVERY_CURSOR_KEYS = ["generation", "serverEpoch", "sessionHandle", "seq"];
const RECOVERY_WATERMARK_KEYS = ["generation", "lastSeq", "serverEpoch", "sessionHandle"];
const RECOVERY_PROJECTION_KEYS = ["prompt", "promptCount", "reply", "replyCount"];
const RECOVERY_PARENT_KEYS = [
	"childNativeSessionId",
	"childSessionFile",
	"childSessionHandle",
	"parentNativeSessionId",
	"parentSessionFile",
	"parentSessionHandle",
	"previousSessionHandle",
];
const RECOVERY_PI_MARKER_KEYS = ["at", "commandId", "pid", "sessionId", "text", "type"];
const RECOVERY_LIFECYCLE_KEYS = [
	"activeGatewayCount",
	"activeGatewayPid",
	"gatewayStarts",
	"ownedGatewayCount",
	"rootPath",
	"rootEntryCount",
	"rootExists",
];
const RECOVERY_PROTOCOL_KEYS = [
	"barrier",
	"cursorBefore",
	"mode",
	"observedEventSeqs",
	"rekeyFrameCount",
	"resyncFrameCount",
	"snapshotFrameCount",
	"watermarkAfter",
];
const RECOVERY_IDENTITY_KEYS = ["after", "before", "parentRelation"];
const RECOVERY_LIFECYCLE_PAIR_KEYS = ["after", "before", "originAfter", "originBefore"];
const RECOVERY_PI_KEYS = ["markersAfter", "markersBefore", "targetSessionId"];
const RECOVERY_STALE_FACT_KEYS = ["epoch", "fence", "generation", "parent"];
const RECOVERY_FACT_KEYS = ["identity", "lifecycle", "pi", "protocol", "projection", "socket", "stale"];
const STREAMING_FACT_KEYS = ["dom", "frames"];
const STREAMING_DOM_KEYS = [
	"liveRichNodeCount",
	"settledCountAfterRelease",
	"settledCountBeforeRelease",
	"settledText",
	"streamingCountAfterRelease",
	"streamingCountBeforeRelease",
	"turnNodes",
];
const STREAMING_FRAME_KEYS = ["deltaCount", "largeFrameBytes", "largeFrameTypes"];
const CONCURRENCY_FACT_KEYS = ["sessions", "socket"];
const CONCURRENCY_SESSION_KEYS = [
	"expected",
	"minimumBackgroundCheckpoints",
	"minimumProjectionCheckpoints",
	"projected",
	"settled",
	"started",
];
const SOCKET_KEYS = ["closed", "opened"];
const HISTORY_FACT_KEYS = ["dom", "history", "pi"];
const HISTORY_DOM_KEYS = ["mountedTurnNodes", "oldestTurnCount"];
const HISTORY_KEYS = [
	"actualSourceBytes",
	"expectedInitialTurns",
	"expectedSourceBytes",
	"expectedTurns",
	"initialTurns",
	"windowTotal",
];
const HISTORY_PI_KEYS = ["getMessagesCount"];
const CONTENT_FACT_KEYS = ["attachments", "frames", "socket"];
const CONTENT_ATTACHMENT_KEYS = [
	"attachmentRefCount",
	"expectedInputBase64Chars",
	"fetchStatus",
	"imageComplete",
	"inlineImageSignatureCount",
	"naturalWidth",
	"observedInputBase64Chars",
];
const CONTENT_FRAME_KEYS = ["maxReceivedFrameBytes", "maxSentFrameBytes"];
const RECOVERY_PROTOCOL_MODE = new Set(["replay", "resync"]);
const RECOVERY_RESYNC_REASONS = new Set([
	"initial",
	"epoch_changed",
	"generation_changed",
	"gap",
	"invalid_cursor",
]);
const RECOVERY_LIFECYCLE_MAX_ROOT_ENTRIES = 8;
const OBSERVATION_FACT_KEYS_BY_KIND = {
	streaming: STREAMING_FACT_KEYS,
	concurrency: CONCURRENCY_FACT_KEYS,
	history: HISTORY_FACT_KEYS,
	"content-roundtrip": CONTENT_FACT_KEYS,
	"recovery-disconnect": RECOVERY_FACT_KEYS,
	"recovery-gap": RECOVERY_FACT_KEYS,
	"recovery-crash": RECOVERY_FACT_KEYS,
	"recovery-rekey": RECOVERY_FACT_KEYS,
	"recovery-gateway-restart": RECOVERY_FACT_KEYS,
};
const REQUIRED_HARD_GATES_BY_KIND = Object.freeze({
	streaming: [
		["correctnessFailures", "value", "eq", 0],
		["browserErrors", "value", "eq", 0],
		["turnNodes", "max", "lte", 64],
	],
	concurrency: [
		["correctnessFailures", "value", "eq", 0],
		["browserErrors", "value", "eq", 0],
		["browserProjectionCheckpointDeficit", "max", "lte", 0],
		["backgroundIngestCheckpointDeficit", "max", "lte", 0],
	],
	history: [
		["correctnessFailures", "value", "eq", 0],
		["browserErrors", "value", "eq", 0],
		["mountedTurnNodes", "max", "lte", 64],
	],
	"content-roundtrip": [
		["correctnessFailures", "value", "eq", 0],
		["browserErrors", "value", "eq", 0],
		["authenticatedAttachmentFetch", "value", "eq", 1],
		["maxSentFrameBytes", "max", "lte", 8 * 1024 * 1024],
		["maxReceivedFrameBytes", "max", "lte", 256 * 1024],
	],
	"recovery-disconnect": [
		["correctnessFailures", "value", "eq", 0],
		["browserErrors", "value", "eq", 0],
		["reconnectedSockets", "max", "lte", 2],
	],
	"recovery-gap": [
		["correctnessFailures", "value", "eq", 0],
		["browserErrors", "value", "eq", 0],
		["gapResyncFrames", "max", "eq", 1],
	],
	"recovery-crash": [
		["correctnessFailures", "value", "eq", 0],
		["browserErrors", "value", "eq", 0],
		["processStarts", "max", "eq", 1],
	],
	"recovery-rekey": [
		["correctnessFailures", "value", "eq", 0],
		["browserErrors", "value", "eq", 0],
		["rekeyFrames", "max", "eq", 1],
	],
	"recovery-gateway-restart": [
		["correctnessFailures", "value", "eq", 0],
		["browserErrors", "value", "eq", 0],
		["gatewayStarts", "max", "eq", 1],
		["activeGateways", "max", "eq", 1],
		["rootEntryCount", "max", "lte", RECOVERY_LIFECYCLE_MAX_ROOT_ENTRIES],
	],
});

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
		if (!Array.isArray(matrixOrDomains?.domains)) {
			errors.push("matrix: validation requires the canonical loadBenchmarkMatrix projection");
			return;
		}
		const recovery = matrixOrDomains.domains.find(
			(domain) => isRecord(domain) && domain.id === RECOVERY_DOMAIN_ID,
		);
		scenarios = Array.isArray(recovery?.tiers?.[tier]?.scenarios) ? recovery.tiers[tier].scenarios : [];
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
	if (!Array.isArray(matrix?.domains)) {
		errors.push("matrix: validation requires the canonical loadBenchmarkMatrix projection");
		return;
	}
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

function validateCanonicalMatrix(matrix, errors) {
	let canonical;
	try {
		canonical = loadBenchmarkMatrix();
	} catch (error) {
		errors.push(
			`matrix: unable to load the canonical matrix projection: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	if (!isDeepStrictEqual(matrix, canonical)) {
		errors.push("matrix must exactly match the canonical loadBenchmarkMatrix projection");
	}
	const expectedKeys = ["domains", "knownCoverageGaps", "provenance", "schemaVersion", "scope", "tiers"];
	if (!exactKeys(matrix, expectedKeys)) {
		errors.push(`matrix must contain exactly ${expectedKeys.join(", ")} from loadBenchmarkMatrix`);
		return;
	}
	if (matrix.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
		errors.push(`matrix: schemaVersion must be ${String(BENCHMARK_SCHEMA_VERSION)}`);
	}
	if (!matrixScopeIsCurrent(matrix.scope)) errors.push("matrix: scope must declare #28 Phase 1 / incomplete");
	if (
		!Array.isArray(matrix.knownCoverageGaps) ||
		matrix.knownCoverageGaps.some((gap) => typeof gap !== "string")
	) {
		errors.push("matrix: knownCoverageGaps must be a string array");
	}
	if (!Array.isArray(matrix.domains) || matrix.domains.length === 0) {
		errors.push("matrix: domains must be a non-empty array");
		return;
	}
	if (!exactKeys(matrix.tiers, ["representative", "stress"])) {
		errors.push("matrix: tiers must contain exactly representative and stress");
	}
	const domainIds = [];
	for (const [index, domain] of matrix.domains.entries()) {
		if (!exactKeys(domain, [...DOMAIN_MATRIX_KEYS, "path"])) {
			errors.push(
				`matrix: loaded domain ${String(index)} must contain exactly ${[...DOMAIN_MATRIX_KEYS, "path"].join(", ")}`,
			);
			continue;
		}
		if (typeof domain.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(domain.id)) {
			errors.push(`matrix: loaded domain ${String(index)} id must be a lowercase identifier`);
			continue;
		}
		if (domainIds.includes(domain.id)) errors.push(`matrix: duplicate loaded domain id: ${domain.id}`);
		domainIds.push(domain.id);
		if (!relativeDomainPath(domain.path))
			errors.push(`matrix: loaded domain ${domain.id} path is not normalized`);
		if (domain.schemaVersion !== BENCHMARK_SCHEMA_VERSION)
			errors.push(
				`matrix: loaded domain ${domain.id} schemaVersion must be ${String(BENCHMARK_SCHEMA_VERSION)}`,
			);
		if (
			!Array.isArray(domain.requiredCapabilities) ||
			domain.requiredCapabilities.length === 0 ||
			domain.requiredCapabilities.some((capability) => typeof capability !== "string") ||
			new Set(domain.requiredCapabilities).size !== domain.requiredCapabilities.length ||
			!isDeepStrictEqual(domain.requiredCapabilities, [...domain.requiredCapabilities].sort())
		) {
			errors.push(`matrix: loaded domain ${domain.id} requiredCapabilities must be sorted and unique`);
		}
		if (!exactKeys(domain.tiers, ["representative", "stress"])) {
			errors.push(`matrix: loaded domain ${domain.id} tiers must contain representative and stress`);
			continue;
		}
		for (const tier of ["representative", "stress"]) {
			if (!exactKeys(domain.tiers[tier], ["scenarios"]) || !Array.isArray(domain.tiers[tier].scenarios)) {
				errors.push(`matrix: loaded domain ${domain.id}/${tier} must contain a scenarios array`);
			}
		}
	}
	if (domainIds.some((id, index) => index > 0 && domainIds[index - 1].localeCompare(id) >= 0)) {
		errors.push("matrix: loaded domains must be sorted by id");
	}
	if (!exactKeys(matrix.provenance, MATRIX_PROVENANCE_KEYS)) {
		errors.push(`matrix: provenance must contain exactly ${MATRIX_PROVENANCE_KEYS.join(", ")}`);
	} else {
		if (!validHash(matrix.provenance.rootHash))
			errors.push("matrix: provenance.rootHash must be a SHA-256 hash");
		if (!isRecord(matrix.provenance.domainHashes)) {
			errors.push("matrix: provenance.domainHashes must be a record");
		} else {
			const hashKeys = Object.keys(matrix.provenance.domainHashes).sort();
			if (!isDeepStrictEqual(hashKeys, [...domainIds].sort()))
				errors.push("matrix: provenance.domainHashes must exactly cover loaded domains");
			for (const [domainId, hash] of Object.entries(matrix.provenance.domainHashes)) {
				if (!validHash(hash))
					errors.push(`matrix: provenance.domainHashes.${domainId} must be a SHA-256 hash`);
			}
		}
	}
	for (const tier of ["representative", "stress"]) validateMatrixProjection(matrix, tier, errors);
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
	if (!Array.isArray(matrix.domains)) {
		errors.push("matrix: only the canonical loadBenchmarkMatrix projection is accepted");
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

function validateNonnegativeNumber(value, label, errors) {
	if (!isFiniteNumber(value) || value < 0) {
		errors.push(`${label} must be a non-negative finite number`);
		return false;
	}
	return true;
}

function validateAuthorityFact(value, label, errors) {
	if (!exactKeys(value, AUTHORITY_FACT_KEYS)) {
		errors.push(`${label} must contain exactly ${AUTHORITY_FACT_KEYS.join(", ")}`);
		return false;
	}
	for (const key of [
		"fencingToken",
		"nativeSessionId",
		"serverEpoch",
		"sessionFile",
		"sessionHandle",
		"workspaceHandle",
		"workspacePath",
	]) {
		if (typeof value[key] !== "string" || value[key].length === 0) {
			errors.push(`${label}.${key} must be a non-empty string`);
		}
	}
	if (value.persisted !== true)
		errors.push(`${label}.persisted must be true for authoritative recovery identity`);
	validateNonnegativeInteger(value.generation, `${label}.generation`, errors);
	return true;
}

function validateStaleFact(value, label, errors) {
	if (!exactKeys(value, STALE_COMMAND_KEYS)) {
		errors.push(`${label} must contain exactly ${STALE_COMMAND_KEYS.join(", ")}`);
		return false;
	}
	if (typeof value.requestId !== "string" || value.requestId.length === 0) {
		errors.push(`${label}.requestId must be a non-empty string`);
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

function validateMarkerArray(value, label, errors) {
	if (!Array.isArray(value)) {
		errors.push(`${label} must be an array`);
		return;
	}
	let previousAt = -Infinity;
	for (const [index, marker] of value.entries()) {
		const markerLabel = `${label}[${String(index)}]`;
		if (!exactKeys(marker, RECOVERY_PI_MARKER_KEYS)) {
			errors.push(`${markerLabel} must contain exactly ${RECOVERY_PI_MARKER_KEYS.join(", ")}`);
			continue;
		}
		if (!isFiniteNumber(marker.at) || marker.at < 0) errors.push(`${markerLabel}.at must be non-negative`);
		if (isFiniteNumber(marker.at) && marker.at < previousAt) errors.push(`${label} must be ordered by at`);
		if (isFiniteNumber(marker.at)) previousAt = marker.at;
		validateNonnegativeInteger(marker.pid, `${markerLabel}.pid`, errors);
		if (marker.pid === 0) errors.push(`${markerLabel}.pid must be positive`);
		for (const key of ["sessionId", "type"]) {
			if (typeof marker[key] !== "string" || marker[key].length === 0)
				errors.push(`${markerLabel}.${key} must be a non-empty string`);
		}
		for (const key of ["commandId", "text"]) {
			if (marker[key] !== null && typeof marker[key] !== "string")
				errors.push(`${markerLabel}.${key} must be null or a string`);
		}
	}
}

function validateProtocolFact(value, label, errors) {
	if (!exactKeys(value, RECOVERY_PROTOCOL_KEYS)) {
		errors.push(`${label} must contain exactly ${RECOVERY_PROTOCOL_KEYS.join(", ")}`);
		return;
	}
	if (!RECOVERY_PROTOCOL_MODE.has(value.mode)) errors.push(`${label}.mode is invalid`);
	if (!exactKeys(value.cursorBefore, RECOVERY_CURSOR_KEYS)) {
		errors.push(`${label}.cursorBefore must contain exactly ${RECOVERY_CURSOR_KEYS.join(", ")}`);
	} else {
		for (const key of ["serverEpoch", "sessionHandle"]) {
			if (typeof value.cursorBefore[key] !== "string" || value.cursorBefore[key].length === 0)
				errors.push(`${label}.cursorBefore.${key} must be a non-empty string`);
		}
		validateNonnegativeInteger(value.cursorBefore.generation, `${label}.cursorBefore.generation`, errors);
		validateNonnegativeInteger(value.cursorBefore.seq, `${label}.cursorBefore.seq`, errors);
	}
	if (!exactKeys(value.watermarkAfter, RECOVERY_WATERMARK_KEYS)) {
		errors.push(`${label}.watermarkAfter must contain exactly ${RECOVERY_WATERMARK_KEYS.join(", ")}`);
	} else {
		for (const key of ["serverEpoch", "sessionHandle"]) {
			if (typeof value.watermarkAfter[key] !== "string" || value.watermarkAfter[key].length === 0)
				errors.push(`${label}.watermarkAfter.${key} must be a non-empty string`);
		}
		validateNonnegativeInteger(value.watermarkAfter.generation, `${label}.watermarkAfter.generation`, errors);
		validateNonnegativeInteger(value.watermarkAfter.lastSeq, `${label}.watermarkAfter.lastSeq`, errors);
	}
	if (
		!Array.isArray(value.observedEventSeqs) ||
		value.observedEventSeqs.some((seq) => !Number.isSafeInteger(seq) || seq <= 0)
	) {
		errors.push(`${label}.observedEventSeqs must be a positive safe integer array`);
	}
	validateNonnegativeInteger(value.rekeyFrameCount, `${label}.rekeyFrameCount`, errors);
	validateNonnegativeInteger(value.resyncFrameCount, `${label}.resyncFrameCount`, errors);
	validateNonnegativeInteger(value.snapshotFrameCount, `${label}.snapshotFrameCount`, errors);
	if (!exactKeys(value.barrier, RECOVERY_BARRIER_KEYS)) {
		errors.push(`${label}.barrier must contain exactly ${RECOVERY_BARRIER_KEYS.join(", ")}`);
	} else {
		for (const key of ["asOfSeq", "baseSeq", "barrierSeq", "runtimeLastSeq"]) {
			if (value.barrier[key] !== null)
				validateNonnegativeInteger(value.barrier[key], `${label}.barrier.${key}`, errors);
		}
		if (value.barrier.reason !== null && !RECOVERY_RESYNC_REASONS.has(value.barrier.reason))
			errors.push(`${label}.barrier.reason is invalid`);
		if (typeof value.barrier.required !== "boolean") errors.push(`${label}.barrier.required must be boolean`);
		if (typeof value.barrier.snapshotSeen !== "boolean")
			errors.push(`${label}.barrier.snapshotSeen must be boolean`);
	}
}

function validateLifecycleFact(value, label, errors) {
	if (!exactKeys(value, RECOVERY_LIFECYCLE_KEYS)) {
		errors.push(`${label} must contain exactly ${RECOVERY_LIFECYCLE_KEYS.join(", ")}`);
		return;
	}
	for (const key of ["activeGatewayCount", "gatewayStarts", "ownedGatewayCount", "rootEntryCount"])
		validateNonnegativeInteger(value[key], `${label}.${key}`, errors);
	if (value.activeGatewayPid !== null)
		validateNonnegativeInteger(value.activeGatewayPid, `${label}.activeGatewayPid`, errors);
	if (value.activeGatewayPid === 0) errors.push(`${label}.activeGatewayPid must be positive when present`);
	if (typeof value.rootPath !== "string" || value.rootPath.length === 0)
		errors.push(`${label}.rootPath must be non-empty`);
	if (typeof value.rootExists !== "boolean") errors.push(`${label}.rootExists must be boolean`);
}

function validateProjectionFact(value, label, errors) {
	if (!exactKeys(value, RECOVERY_PROJECTION_KEYS)) {
		errors.push(`${label} must contain exactly ${RECOVERY_PROJECTION_KEYS.join(", ")}`);
		return;
	}
	for (const key of ["prompt", "reply"]) {
		if (typeof value[key] !== "string" || value[key].length === 0)
			errors.push(`${label}.${key} must be non-empty`);
	}
	validateNonnegativeInteger(value.promptCount, `${label}.promptCount`, errors);
	validateNonnegativeInteger(value.replyCount, `${label}.replyCount`, errors);
}

function validateParentRelation(value, label, errors) {
	if (value === null) return;
	if (!exactKeys(value, RECOVERY_PARENT_KEYS)) {
		errors.push(`${label} must be null or contain exactly ${RECOVERY_PARENT_KEYS.join(", ")}`);
		return;
	}
	for (const key of RECOVERY_PARENT_KEYS) {
		if (typeof value[key] !== "string" || value[key].length === 0)
			errors.push(`${label}.${key} must be non-empty`);
	}
}

function validateRecoveryFacts(value, label, errors) {
	if (!exactKeys(value, RECOVERY_FACT_KEYS)) {
		errors.push(`${label} must contain exactly ${RECOVERY_FACT_KEYS.join(", ")}`);
		return;
	}
	if (!exactKeys(value.identity, RECOVERY_IDENTITY_KEYS)) {
		errors.push(`${label}.identity must contain exactly ${RECOVERY_IDENTITY_KEYS.join(", ")}`);
	} else {
		validateAuthorityFact(value.identity.before, `${label}.identity.before`, errors);
		validateAuthorityFact(value.identity.after, `${label}.identity.after`, errors);
		validateParentRelation(value.identity.parentRelation, `${label}.identity.parentRelation`, errors);
	}
	if (!exactKeys(value.lifecycle, RECOVERY_LIFECYCLE_PAIR_KEYS)) {
		errors.push(`${label}.lifecycle must contain exactly ${RECOVERY_LIFECYCLE_PAIR_KEYS.join(", ")}`);
	} else {
		validateLifecycleFact(value.lifecycle.before, `${label}.lifecycle.before`, errors);
		validateLifecycleFact(value.lifecycle.after, `${label}.lifecycle.after`, errors);
		for (const key of ["originBefore", "originAfter"])
			if (typeof value.lifecycle[key] !== "string" || value.lifecycle[key].length === 0)
				errors.push(`${label}.lifecycle.${key} must be non-empty`);
	}
	if (!exactKeys(value.pi, RECOVERY_PI_KEYS)) {
		errors.push(`${label}.pi must contain exactly ${RECOVERY_PI_KEYS.join(", ")}`);
	} else {
		validateMarkerArray(value.pi.markersBefore, `${label}.pi.markersBefore`, errors);
		validateMarkerArray(value.pi.markersAfter, `${label}.pi.markersAfter`, errors);
		if (typeof value.pi.targetSessionId !== "string" || value.pi.targetSessionId.length === 0)
			errors.push(`${label}.pi.targetSessionId must be non-empty`);
	}
	validateProtocolFact(value.protocol, `${label}.protocol`, errors);
	validateProjectionFact(value.projection, `${label}.projection`, errors);
	if (!exactKeys(value.socket, SOCKET_KEYS)) {
		errors.push(`${label}.socket must contain exactly ${SOCKET_KEYS.join(", ")}`);
	} else {
		validateNonnegativeInteger(value.socket.closed, `${label}.socket.closed`, errors);
		validateNonnegativeInteger(value.socket.opened, `${label}.socket.opened`, errors);
	}
	if (!exactKeys(value.stale, RECOVERY_STALE_FACT_KEYS)) {
		errors.push(`${label}.stale must contain exactly ${RECOVERY_STALE_FACT_KEYS.join(", ")}`);
	} else {
		for (const key of RECOVERY_STALE_KEYS) {
			if (key === "parent" && value.stale[key] === null) continue;
			validateStaleFact(value.stale[key], `${label}.stale.${key}`, errors);
		}
	}
}

function validateObservationFacts(value, kind, label, errors) {
	const expectedKeys = OBSERVATION_FACT_KEYS_BY_KIND[kind];
	if (!expectedKeys || !exactKeys(value, expectedKeys)) {
		errors.push(`${label}.facts must contain exactly ${(expectedKeys ?? []).join(", ")}`);
		return;
	}
	if (kind === "streaming") {
		if (!exactKeys(value.dom, STREAMING_DOM_KEYS)) errors.push(`${label}.facts.dom has invalid keys`);
		else {
			for (const key of [
				"liveRichNodeCount",
				"settledCountAfterRelease",
				"settledCountBeforeRelease",
				"streamingCountAfterRelease",
				"streamingCountBeforeRelease",
				"turnNodes",
			])
				validateNonnegativeInteger(value.dom[key], `${label}.facts.dom.${key}`, errors);
			if (typeof value.dom.settledText !== "string")
				errors.push(`${label}.facts.dom.settledText must be a string`);
		}
		if (!exactKeys(value.frames, STREAMING_FRAME_KEYS)) errors.push(`${label}.facts.frames has invalid keys`);
		else {
			validateNonnegativeInteger(value.frames.deltaCount, `${label}.facts.frames.deltaCount`, errors);
			validateStringArray(value.frames.largeFrameTypes, `${label}.facts.frames.largeFrameTypes`, errors);
			if (!Array.isArray(value.frames.largeFrameBytes))
				errors.push(`${label}.facts.frames.largeFrameBytes must be an array`);
			else {
				for (const [index, entry] of value.frames.largeFrameBytes.entries()) {
					validateNonnegativeInteger(
						entry,
						`${label}.facts.frames.largeFrameBytes[${String(index)}]`,
						errors,
					);
				}
			}
		}
		return;
	}
	if (kind === "concurrency") {
		if (!exactKeys(value.sessions, CONCURRENCY_SESSION_KEYS))
			errors.push(`${label}.facts.sessions has invalid keys`);
		else
			for (const key of CONCURRENCY_SESSION_KEYS)
				validateNonnegativeInteger(value.sessions[key], `${label}.facts.sessions.${key}`, errors);
		validateSocketFact(value.socket, `${label}.facts.socket`, errors);
		return;
	}
	if (kind === "history") {
		if (!exactKeys(value.dom, HISTORY_DOM_KEYS)) errors.push(`${label}.facts.dom has invalid keys`);
		else
			for (const key of HISTORY_DOM_KEYS)
				validateNonnegativeInteger(value.dom[key], `${label}.facts.dom.${key}`, errors);
		if (!exactKeys(value.history, HISTORY_KEYS)) errors.push(`${label}.facts.history has invalid keys`);
		else
			for (const key of HISTORY_KEYS)
				validateNonnegativeInteger(value.history[key], `${label}.facts.history.${key}`, errors);
		if (!exactKeys(value.pi, HISTORY_PI_KEYS)) errors.push(`${label}.facts.pi has invalid keys`);
		else validateNonnegativeInteger(value.pi.getMessagesCount, `${label}.facts.pi.getMessagesCount`, errors);
		return;
	}
	if (kind === "content-roundtrip") {
		if (!exactKeys(value.attachments, CONTENT_ATTACHMENT_KEYS))
			errors.push(`${label}.facts.attachments has invalid keys`);
		else {
			for (const key of [
				"attachmentRefCount",
				"expectedInputBase64Chars",
				"fetchStatus",
				"naturalWidth",
				"observedInputBase64Chars",
			])
				validateNonnegativeInteger(value.attachments[key], `${label}.facts.attachments.${key}`, errors);
			for (const key of ["imageComplete"])
				if (typeof value.attachments[key] !== "boolean")
					errors.push(`${label}.facts.attachments.${key} must be boolean`);
			validateNonnegativeInteger(
				value.attachments.inlineImageSignatureCount,
				`${label}.facts.attachments.inlineImageSignatureCount`,
				errors,
			);
		}
		if (!exactKeys(value.frames, CONTENT_FRAME_KEYS)) errors.push(`${label}.facts.frames has invalid keys`);
		else
			for (const key of CONTENT_FRAME_KEYS)
				validateNonnegativeInteger(value.frames[key], `${label}.facts.frames.${key}`, errors);
		validateSocketFact(value.socket, `${label}.facts.socket`, errors);
		return;
	}
	validateRecoveryFacts(value, `${label}.facts`, errors);
}

function validateSocketFact(value, label, errors) {
	if (!exactKeys(value, SOCKET_KEYS)) {
		errors.push(`${label} must contain exactly ${SOCKET_KEYS.join(", ")}`);
		return;
	}
	validateNonnegativeInteger(value.closed, `${label}.closed`, errors);
	validateNonnegativeInteger(value.opened, `${label}.opened`, errors);
}

function validateObservation(value, definition, label, errors) {
	if (!exactKeys(value, OBSERVATION_KEYS)) {
		errors.push(`${label}: observation must contain exactly ${OBSERVATION_KEYS.join(", ")}`);
		return;
	}
	if (value.kind !== definition.kind) errors.push(`${label}: observation.kind must match scenario kind`);
	if (!exactKeys(value.browserErrors, BROWSER_ERROR_KEYS)) {
		errors.push(`${label}: observation.browserErrors must contain exactly ${BROWSER_ERROR_KEYS.join(", ")}`);
	} else {
		validateStringArray(value.browserErrors.console, `${label}: observation.browserErrors.console`, errors);
		validateStringArray(value.browserErrors.page, `${label}: observation.browserErrors.page`, errors);
	}
	validateObservationFacts(value.facts, definition.kind, label, errors);
}

function gatePolicy(metric) {
	return GATE_METRIC_POLICY[metric] ?? "observe";
}

function observationForTrial(observationByTrial, result, trial) {
	return observationByTrial.get(
		`${scenarioKey({ domain: result.domain, id: result.scenarioId, variant: result.variant })}/${String(trial.index)}`,
	);
}

function newRecoveryMarkers(facts) {
	const beforeMarkers = Array.isArray(facts?.pi?.markersBefore) ? facts.pi.markersBefore : null;
	const after = Array.isArray(facts?.pi?.markersAfter) ? facts.pi.markersAfter : null;
	if (!beforeMarkers || !after) return [];
	const before = beforeMarkers.length;
	if (
		before > after.length ||
		!beforeMarkers.every((marker, index) => isDeepStrictEqual(marker, after[index]))
	)
		return [];
	return after.slice(before);
}

function recoverySequenceIsContinuous(facts) {
	const protocol = facts?.protocol;
	if (!isRecord(protocol) || !isRecord(protocol.cursorBefore) || !isRecord(protocol.watermarkAfter))
		return false;
	if (!isRecord(protocol.barrier)) return false;
	const cursor = protocol.cursorBefore;
	const watermark = protocol.watermarkAfter;
	const observed = Array.isArray(protocol.observedEventSeqs) ? protocol.observedEventSeqs : [];
	const uniqueAndOrdered =
		new Set(observed).size === observed.length &&
		observed.every((seq, index) => index === 0 || seq > observed[index - 1]);
	if (!uniqueAndOrdered) return false;
	if (protocol.mode === "replay") {
		if (
			protocol.barrier.required ||
			protocol.barrier.snapshotSeen ||
			protocol.barrier.reason !== null ||
			protocol.barrier.asOfSeq !== null ||
			protocol.barrier.baseSeq !== null ||
			protocol.barrier.barrierSeq !== null ||
			protocol.barrier.runtimeLastSeq !== null ||
			protocol.resyncFrameCount !== 0 ||
			protocol.snapshotFrameCount !== 0
		)
			return false;
		const count = watermark.lastSeq - cursor.seq;
		if (count < 0) return false;
		const expected = Array.from({ length: count }, (_, index) => cursor.seq + index + 1);
		return isDeepStrictEqual(observed, expected);
	}
	if (
		protocol.mode !== "resync" ||
		!protocol.barrier.required ||
		!protocol.barrier.snapshotSeen ||
		!RECOVERY_RESYNC_REASONS.has(protocol.barrier.reason) ||
		protocol.resyncFrameCount !== 1 ||
		protocol.snapshotFrameCount < 1
	)
		return false;
	const barrier = protocol.barrier;
	if (
		barrier.asOfSeq === null ||
		barrier.baseSeq === null ||
		barrier.barrierSeq === null ||
		barrier.runtimeLastSeq === null ||
		barrier.asOfSeq !== barrier.barrierSeq ||
		barrier.asOfSeq !== barrier.runtimeLastSeq ||
		barrier.baseSeq > barrier.asOfSeq
	)
		return false;
	const postBarrier = observed.filter((seq) => seq > barrier.asOfSeq);
	const count = watermark.lastSeq - barrier.asOfSeq;
	if (count < 0) return false;
	const expected = Array.from({ length: count }, (_, index) => barrier.asOfSeq + index + 1);
	return isDeepStrictEqual(postBarrier, expected) && observed.every((seq) => seq > barrier.asOfSeq);
}

function recoveryProtocolIsCorrect(facts, definition) {
	const protocol = facts?.protocol;
	if (!isRecord(protocol) || !isRecord(protocol.barrier)) return false;
	const reason = protocol.barrier.reason;
	if (definition.kind === "recovery-disconnect") {
		return protocol.mode === "replay" && protocol.rekeyFrameCount === 0;
	}
	if (definition.kind === "recovery-gap") {
		return protocol.mode === "resync" && reason === "gap" && protocol.rekeyFrameCount === 0;
	}
	if (definition.kind === "recovery-crash") {
		return (
			protocol.mode === "resync" &&
			(reason === "initial" || reason === "generation_changed") &&
			protocol.rekeyFrameCount === 0
		);
	}
	if (definition.kind === "recovery-rekey") {
		return (
			protocol.mode === "resync" &&
			(reason === "initial" || reason === "generation_changed") &&
			protocol.rekeyFrameCount === 1
		);
	}
	return (
		protocol.mode === "resync" &&
		(reason === "initial" || reason === "epoch_changed") &&
		protocol.rekeyFrameCount === 0
	);
}

function recoveryIdentityIsCorrect(facts, definition) {
	const before = facts?.identity?.before;
	const after = facts?.identity?.after;
	if (!before || !after || before.persisted !== true || after.persisted !== true) return false;
	if (before.workspaceHandle !== after.workspaceHandle || before.workspacePath !== after.workspacePath)
		return false;
	const changed =
		before.sessionHandle !== after.sessionHandle &&
		before.nativeSessionId !== after.nativeSessionId &&
		before.sessionFile !== after.sessionFile;
	if (definition.kind === "recovery-rekey") {
		const relation = facts.identity.parentRelation;
		if (
			!relation ||
			!changed ||
			after.generation <= before.generation ||
			after.serverEpoch !== before.serverEpoch ||
			relation.previousSessionHandle !== before.sessionHandle
		)
			return false;
		return (
			relation.parentSessionHandle === before.sessionHandle &&
			relation.parentNativeSessionId === before.nativeSessionId &&
			relation.parentSessionFile === before.sessionFile &&
			relation.childSessionHandle === after.sessionHandle &&
			relation.childNativeSessionId === after.nativeSessionId &&
			relation.childSessionFile === after.sessionFile
		);
	}
	if (facts.identity.parentRelation !== null || changed) return false;
	const samePersistedIdentity =
		before.sessionHandle === after.sessionHandle &&
		before.nativeSessionId === after.nativeSessionId &&
		before.sessionFile === after.sessionFile;
	if (!samePersistedIdentity) return false;
	if (definition.kind === "recovery-crash") {
		return after.generation > before.generation && after.serverEpoch === before.serverEpoch;
	}
	if (definition.kind === "recovery-gateway-restart") {
		return after.generation === before.generation && after.serverEpoch !== before.serverEpoch;
	}
	return after.generation === before.generation && after.serverEpoch === before.serverEpoch;
}

function recoveryLifecycleIsCorrect(facts, definition) {
	const before = facts?.lifecycle?.before;
	const after = facts?.lifecycle?.after;
	if (!before || !after) return false;
	const bounded =
		after.activeGatewayCount === 1 &&
		after.rootExists === true &&
		after.rootEntryCount <= RECOVERY_LIFECYCLE_MAX_ROOT_ENTRIES &&
		typeof after.rootPath === "string" &&
		after.rootPath.length > 0;
	if (
		!bounded ||
		facts.lifecycle.originBefore !== facts.lifecycle.originAfter ||
		before.rootPath !== after.rootPath
	)
		return false;
	if (definition.kind === "recovery-gateway-restart") {
		return (
			after.gatewayStarts - before.gatewayStarts === 1 &&
			after.ownedGatewayCount - before.ownedGatewayCount === 1
		);
	}
	return after.gatewayStarts === before.gatewayStarts && after.ownedGatewayCount === before.ownedGatewayCount;
}

function recoveryStaleIsCorrect(facts, definition) {
	const stale = facts?.stale;
	if (!stale) return false;
	const noSideEffect = (entry) =>
		entry && entry.responseSuccess === false && entry.piCommandCountAfter === entry.piCommandCountBefore;
	if (
		!noSideEffect(stale.generation) ||
		!stale.generation.responseError?.includes("session_generation_stale") ||
		!noSideEffect(stale.fence) ||
		!stale.fence.responseError?.includes("session_read_only") ||
		!noSideEffect(stale.epoch) ||
		stale.epoch.responseType !== "resync_required"
	)
		return false;
	if (definition.kind === "recovery-rekey") {
		return noSideEffect(stale.parent) && stale.parent.responseError?.includes("session_read_only");
	}
	return stale.parent === null;
}

function recoveryPiIsCorrect(facts, definition) {
	const target = facts?.pi?.targetSessionId;
	const projection = facts?.projection;
	const freshMarkers = newRecoveryMarkers(facts);
	if (typeof target !== "string" || !projection || freshMarkers.length === 0) return false;
	const promptMarkers = freshMarkers.filter(
		(marker) => marker.type === "prompt" && marker.sessionId === target && marker.text === projection.prompt,
	);
	const settledMarkers = freshMarkers.filter(
		(marker) => marker.type === "settled" && marker.sessionId === target && marker.text === projection.prompt,
	);
	if (
		promptMarkers.length !== 1 ||
		settledMarkers.length !== 1 ||
		(promptMarkers[0]?.at ?? Number.POSITIVE_INFINITY) > (settledMarkers[0]?.at ?? Number.NEGATIVE_INFINITY)
	)
		return false;
	if (definition.kind !== "recovery-crash") return true;
	const requests = freshMarkers.filter(
		(marker) => marker.type === "crash_requested" && marker.sessionId === target,
	);
	if (requests.length !== 1) return false;
	const restarted = freshMarkers.filter(
		(marker) =>
			marker.type === "started" &&
			marker.sessionId === target &&
			marker.at >= requests[0].at &&
			marker.pid !== requests[0].pid,
	);
	return (
		restarted.length === 1 &&
		(promptMarkers[0]?.at ?? Number.NEGATIVE_INFINITY) >= restarted[0].at &&
		(settledMarkers[0]?.at ?? Number.NEGATIVE_INFINITY) >= promptMarkers[0].at
	);
}

function deriveCorrectness(observation, definition) {
	const facts = observation?.facts;
	if (!isRecord(facts)) return { complete: false };
	let correctness;
	if (definition.kind === "streaming") {
		const dom = facts?.dom;
		const frames = facts?.frames;
		const targetBytes = definition.targetBytes ?? 0;
		correctness = {
			liveTailStayedPlain: dom?.liveRichNodeCount === 0,
			structuralReleaseHeldInStreamingDom:
				dom?.streamingCountBeforeRelease === 1 && dom?.settledCountBeforeRelease === 0,
			structuralReleasePublishedSettledDom:
				dom?.streamingCountAfterRelease === 0 && dom?.settledCountAfterRelease === 1,
			settledEndSentinel:
				typeof dom?.settledText === "string" && dom.settledText.includes("STREAM_BUDGET_END"),
			settledUnicode: typeof dom?.settledText === "string" && dom.settledText.includes("🧪"),
			structuralFramesEmittedInOrder: frames?.largeFrameTypes?.join(",") === "text_end,message_end",
			frameBudgetPreserved:
				Array.isArray(frames?.largeFrameBytes) &&
				frames.largeFrameBytes.every((bytes) => bytes > targetBytes),
		};
	} else if (definition.kind === "concurrency") {
		const sessions = facts?.sessions;
		const socket = facts?.socket;
		const expected = definition.sessions ?? sessions?.expected ?? 0;
		correctness = {
			allSessionsStarted: sessions?.started === expected,
			allSessionsSettled: sessions?.settled === expected,
			allBackgroundProjectionsRecovered: sessions?.projected === expected,
			allSessionsObservedTwice: (sessions?.minimumProjectionCheckpoints ?? -1) >= 2,
			backgroundSessionsIngestedBetweenSwitches:
				expected === 1 || (sessions?.minimumBackgroundCheckpoints ?? -1) >= 2,
			singleMultiplexedSocket: socket?.opened === 1 && socket.closed === 0,
		};
	} else if (definition.kind === "history") {
		const dom = facts?.dom;
		const history = facts?.history;
		correctness = {
			exactSourceBoundary: history?.actualSourceBytes === history?.expectedSourceBytes,
			allTurnsPaged: history?.windowTotal === history?.expectedTurns,
			historyWindowMatchesReadPath: history?.initialTurns === history?.expectedInitialTurns,
			oldestTurnReachable: dom?.oldestTurnCount === 1,
			expectedHistoryReadPath: facts?.pi?.getMessagesCount === 0,
		};
	} else if (definition.kind === "content-roundtrip") {
		const attachments = facts?.attachments;
		const socket = facts?.socket;
		correctness = {
			inputReachedPiAtExpectedSize:
				attachments?.observedInputBase64Chars === attachments?.expectedInputBase64Chars,
			typedOutputRefsObserved: (attachments?.attachmentRefCount ?? -1) >= 2,
			outputBlobResolved: attachments?.imageComplete === true && (attachments?.naturalWidth ?? 0) > 0,
			largeOutputStayedOffWebSocket: attachments?.inlineImageSignatureCount === 0,
			socketRemainedUsable: socket?.opened === 1 && socket.closed === 0,
		};
	} else {
		const identityFacts = isRecord(facts.identity) ? facts.identity : undefined;
		const protocolFacts = isRecord(facts.protocol) ? facts.protocol : undefined;
		const identity = recoveryIdentityIsCorrect(facts, definition);
		const protocolSource = identityFacts?.before;
		const protocol =
			recoverySequenceIsContinuous(facts) &&
			recoveryProtocolIsCorrect(facts, definition) &&
			protocolSource &&
			identityFacts?.after &&
			protocolFacts?.cursorBefore?.sessionHandle === protocolSource.sessionHandle &&
			protocolFacts.cursorBefore.generation === protocolSource.generation &&
			protocolFacts.cursorBefore.serverEpoch === protocolSource.serverEpoch &&
			protocolFacts.watermarkAfter.sessionHandle === identityFacts.after.sessionHandle &&
			protocolFacts.watermarkAfter.generation === identityFacts.after.generation &&
			protocolFacts.watermarkAfter.serverEpoch === identityFacts.after.serverEpoch;
		const projection = facts.projection?.promptCount === 1 && facts.projection?.replyCount === 1;
		const staleGenerationRejected =
			facts.stale?.generation?.responseSuccess === false &&
			facts.stale.generation.responseError?.includes("session_generation_stale") === true &&
			facts.stale.generation.piCommandCountAfter === facts.stale.generation.piCommandCountBefore;
		const staleFenceRejected =
			facts.stale?.fence?.responseSuccess === false &&
			facts.stale.fence.responseError?.includes("session_read_only") === true &&
			facts.stale.fence.piCommandCountAfter === facts.stale.fence.piCommandCountBefore;
		const staleEpochRejected =
			facts.stale?.epoch?.responseType === "resync_required" &&
			facts.stale.epoch.responseSuccess === false &&
			facts.stale.epoch.piCommandCountAfter === facts.stale.epoch.piCommandCountBefore;
		correctness = {
			recoveryBarrier: identity && protocol && recoveryLifecycleIsCorrect(facts, definition),
			zeroDuplicateLostEvents: recoveryPiIsCorrect(facts, definition) && projection,
			staleGenerationRejected,
			staleFenceRejected,
			staleEpochRejected,
			finalProjectionMatches: projection,
			...(definition.kind === "recovery-disconnect"
				? { disconnectObserved: facts.socket?.opened > 0 && facts.socket?.closed > 0 }
				: {}),
			...(definition.kind === "recovery-gap"
				? {
						gapResyncObserved:
							facts.protocol?.mode === "resync" &&
							facts.protocol.barrier.reason === "gap" &&
							facts.protocol.resyncFrameCount === 1,
					}
				: {}),
			...(definition.kind === "recovery-crash"
				? { processRestarted: recoveryPiIsCorrect(facts, definition) }
				: {}),
			...(definition.kind === "recovery-rekey"
				? {
						rekeyIdentityChanged: identity && facts.protocol?.rekeyFrameCount === 1,
						staleParentRejected: recoveryStaleIsCorrect(facts, definition),
					}
				: {}),
			...(definition.kind === "recovery-gateway-restart"
				? { restartCleanup: recoveryLifecycleIsCorrect(facts, definition) }
				: {}),
		};
	}
	return { ...correctness, complete: Object.values(correctness).every((value) => value === true) };
}

function deriveHardMetric(metric, result, definition, trials, observationByTrial) {
	const observations = trials.map((trial) => observationForTrial(observationByTrial, result, trial));
	if (observations.some((observation) => !isRecord(observation) || !isRecord(observation.facts))) return null;
	if (
		metric === "browserErrors" &&
		observations.every(
			(observation) =>
				isRecord(observation.browserErrors) &&
				Array.isArray(observation.browserErrors.console) &&
				Array.isArray(observation.browserErrors.page),
		)
	)
		return observations.reduce(
			(total, observation) =>
				total + observation.browserErrors.console.length + observation.browserErrors.page.length,
			0,
		);
	if (metric === "correctnessFailures")
		return observations.reduce(
			(total, observation) =>
				total +
				Object.values(deriveCorrectness(observation, definition)).filter((value) => value !== true).length,
			0,
		);
	const values = observations.map((observation) => {
		const facts = observation.facts;
		if (metric === "turnNodes") return isRecord(facts.dom) ? facts.dom.turnNodes : null;
		if (metric === "browserProjectionCheckpointDeficit")
			return isRecord(facts.sessions) ? Math.max(0, 2 - facts.sessions.minimumProjectionCheckpoints) : null;
		if (metric === "backgroundIngestCheckpointDeficit")
			return isRecord(facts.sessions) ? Math.max(0, 2 - facts.sessions.minimumBackgroundCheckpoints) : null;
		if (metric === "mountedTurnNodes") return isRecord(facts.dom) ? facts.dom.mountedTurnNodes : null;
		if (metric === "authenticatedAttachmentFetch")
			return isRecord(facts.attachments) ? facts.attachments.fetchStatus : null;
		if (metric === "maxSentFrameBytes") return isRecord(facts.frames) ? facts.frames.maxSentFrameBytes : null;
		if (metric === "maxReceivedFrameBytes")
			return isRecord(facts.frames) ? facts.frames.maxReceivedFrameBytes : null;
		if (metric === "reconnectedSockets") return isRecord(facts.socket) ? facts.socket.opened : null;
		if (metric === "gapResyncFrames")
			return isRecord(facts.protocol) ? facts.protocol.resyncFrameCount : null;
		if (metric === "processStarts")
			return isRecord(facts.pi) && typeof facts.pi.targetSessionId === "string"
				? newRecoveryMarkers(facts).filter(
						(marker) => marker.type === "started" && marker.sessionId === facts.pi.targetSessionId,
					).length
				: null;
		if (metric === "rekeyFrames") return isRecord(facts.protocol) ? facts.protocol.rekeyFrameCount : null;
		if (metric === "gatewayStarts")
			return isRecord(facts.lifecycle?.after) && isRecord(facts.lifecycle?.before)
				? facts.lifecycle.after.gatewayStarts - facts.lifecycle.before.gatewayStarts
				: null;
		if (metric === "activeGateways")
			return isRecord(facts.lifecycle?.after) ? facts.lifecycle.after.activeGatewayCount : null;
		if (metric === "rootEntryCount")
			return isRecord(facts.lifecycle?.after) ? facts.lifecycle.after.rootEntryCount : null;
		return null;
	});
	return values.every((value) => isFiniteNumber(value) && value >= 0) ? values : null;
}

function hardMetricValues(metric, result, definition, trials, observationByTrial, errors) {
	const value = deriveHardMetric(metric, result, definition, trials, observationByTrial);
	if (value === null)
		errors.push(`hard gate metric ${metric} requires independently recomputable atomic observations`);
	if (value === null) return [];
	return trials.map((trial) => {
		const observation = observationForTrial(observationByTrial, result, trial);
		const perTrial = deriveHardMetric(
			metric,
			result,
			definition,
			[trial],
			new Map([
				[
					`${scenarioKey({ domain: result.domain, id: result.scenarioId, variant: result.variant })}/${String(trial.index)}`,
					observation,
				],
			]),
		);
		return { trial, value: Array.isArray(perTrial) ? perTrial[0] : perTrial };
	});
}

function validateGates(result, definition, trials, expectedSummaries, observationByTrial, errors) {
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
			const authoritativeValues = hardMetricValues(
				gate.metric,
				result,
				definition,
				trials,
				observationByTrial,
				errors,
			);
			if (authoritativeValues.length === 0) {
				expectedActual = null;
			} else if (gate.metric === "browserErrors" || gate.metric === "correctnessFailures") {
				expectedActual = authoritativeValues.reduce((total, entry) => total + entry.value, 0);
			} else if (gate.statistic === "value") {
				const values = authoritativeValues.map((entry) => entry.value);
				expectedActual =
					gate.metric === "authenticatedAttachmentFetch"
						? Math.max(...values)
						: values.every((value) => value === values[0])
							? values[0]
							: null;
				if (expectedActual === null) errors.push(`hard gate ${key} value must be stable across all trials`);
			} else {
				const measuredValues = authoritativeValues
					.filter((entry) => entry.trial.warmup === false)
					.map((entry) => entry.value);
				if (measuredValues.length === definition.samples) {
					expectedActual = summarize(measuredValues)[gate.statistic];
				} else {
					errors.push(`hard gate ${key} has incomplete independently derived observations`);
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
			errors.push(`hard gate ${key} actual must be finite from independently derived observations`);
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
	for (const [metric, statistic, comparison, threshold] of REQUIRED_HARD_GATES_BY_KIND[definition.kind] ??
		[]) {
		const matching = validated.find(
			(gate) =>
				gate.metric === metric &&
				gate.statistic === statistic &&
				gate.comparison === comparison &&
				gate.threshold === threshold &&
				gate.mode === "hard",
		);
		if (!matching) errors.push(`missing required hard gate ${metric}.${statistic}`);
	}
	return validated;
}

function validateRecoveryResult(result, definition, trials, observationByTrial, errors) {
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
		const observation = observationForTrial(observationByTrial, result, trial);
		if (!observation) errors.push(`trial ${String(index)} recovery must include an atomic observation`);
		else if (!Object.values(deriveCorrectness(observation, definition)).every((value) => value === true))
			errors.push(`trial ${String(index)} recovery observation failed independently derived invariants`);
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

function validateResult(result, definition, tier, runId, observationByTrial) {
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
	for (const [index, trial] of trials.entries()) {
		const observation = observationForTrial(observationByTrial, result, trial);
		if (!observation) {
			errors.push(`trial ${String(index)} must have an atomic raw observation`);
			continue;
		}
		const derived = deriveCorrectness(observation, definition);
		if (!isDeepStrictEqual(trial.correctness, derived))
			errors.push(`trial ${String(index)} correctness must equal independently derived observation claims`);
	}
	const gates = validateGates(result, definition, trials, summaries, observationByTrial, errors);
	if (isRecoveryKind(definition.kind))
		validateRecoveryResult(result, definition, trials, observationByTrial, errors);
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
	const observationByTrial = new Map();
	if (!Array.isArray(rawArtifacts)) {
		errors.push("raw artifacts must be an array");
		return observationByTrial;
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
		if (!validRelativeArtifactPath(label))
			errors.push(`${label}: raw artifact path must be normalized and relative`);
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
		validateObservation(value.observation, { kind: result.kind }, label, errors);
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
		if (!exactKeys(value.trial, ["index", "warmup"])) {
			errors.push(`${label}: raw trial must contain exactly index, warmup`);
		} else if (
			!isDeepStrictEqual(value.trial, {
				index: expectedEntry.trial.index,
				warmup: expectedEntry.trial.warmup,
			})
		) {
			errors.push(`${label}: raw trial index and warmup must match its scenario result`);
		}
		if (isRecord(value.observation)) observationByTrial.set(indexedKey, value.observation);
	}
	for (const key of expected.keys()) {
		if (!seen.has(key)) errors.push(`missing raw trial: ${key}`);
	}
	return observationByTrial;
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
	validateCanonicalMatrix(matrix, errors);
	validateRecoveryMatrixDomain(matrix, tier, errors);
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
	const observationByTrial = validateRawArtifacts(rawArtifacts, artifactValues, errors);
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
		const resultErrors = validateResult(artifact.value, definition, tier, runId, observationByTrial);
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
