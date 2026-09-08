import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRecoveryRecorder } from "../packages/ui/src/lib/benchmark-recovery-recorder.ts";
import { expectedRestartAuthenticationError } from "../tests/e2e/benchmarks/restart-authentication-observation.ts";
import {
	BENCHMARK_PRODUCER_PATHS,
	canonicalFormalExpectedScenarioSet,
	loadBenchmarkMatrix,
	validateBenchmarkArtifacts,
} from "./performance-benchmark-validator.mjs";
import { disconnectEvidenceIsValid } from "./recovery-evidence-validator.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const RUN_ID = "20260831t000000z-fixture";
const FORMAL_VARIANTS = ["coalesced", "sequential"];
// Independently maintained oracle: this must not be generated from the validator export under test.
const EXPECTED_BENCHMARK_PRODUCER_PATHS = Object.freeze([
	"packages/ui/src/lib/benchmark-browser.tsx",
	"packages/ui/src/lib/benchmark-recovery-recorder.ts",
	"scripts/run-performance-benchmarks.mjs",
	"tests/e2e/benchmarks/benchmark-support.ts",
	"tests/e2e/benchmarks/concurrency.spec.ts",
	"tests/e2e/benchmarks/content-roundtrip.spec.ts",
	"tests/e2e/benchmarks/history.spec.ts",
	"tests/e2e/benchmarks/playwright.config.ts",
	"tests/e2e/benchmarks/recovery-evidence.ts",
	"tests/e2e/benchmarks/recovery.spec.ts",
	"tests/e2e/benchmarks/restart-authentication-observation.ts",
	"tests/e2e/benchmarks/streaming.spec.ts",
	"tests/e2e/fixtures/deterministic-pi.mjs",
	"tests/e2e/fixtures/page-observation.ts",
	"tests/e2e/fixtures/production-harness.ts",
	"tests/e2e/fixtures/test.ts",
	"tests/e2e/specs/recovery-acceptance.spec.ts",
]);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrix = loadBenchmarkMatrix();
const representativeScenarios = matrix.tiers.representative.scenarios;
const scenario = representativeScenarios.find((entry) => entry.kind === "streaming");
const recoveryScenario = representativeScenarios.find((entry) => entry.kind === "recovery-crash");
if (!scenario || !recoveryScenario) throw new Error("fixture matrix is missing streaming or crash scenarios");

function variantOrder(seed = "fixture-seed") {
	return [...FORMAL_VARIANTS].sort((left, right) => {
		const hash = (variant) => createHash("sha256").update(`${seed}\0${variant}`).digest("hex");
		return hash(left).localeCompare(hash(right)) || left.localeCompare(right);
	});
}

function fixtureHashes() {
	return Object.fromEntries(
		EXPECTED_BENCHMARK_PRODUCER_PATHS.map((relativePath) => [
			relativePath,
			createHash("sha256")
				.update(fs.readFileSync(path.join(repositoryRoot, relativePath)))
				.digest("hex"),
		]),
	);
}

function browserErrors() {
	return { console: [], page: [] };
}

const EXPECTED_GATEWAY_RESTART_REFUSAL =
	"WebSocket connection to 'ws://127.0.0.1:3000/api/v1/ws' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED";

function base64CharsForBytes(byteLength) {
	// The content fixture uses unwrapped RFC 4648 Base64: four characters per three bytes, rounded up.
	return 4 * Math.ceil(byteLength / 3);
}

function authority(sessionHandle, nativeSessionId, sessionFile, serverEpoch, generation) {
	return {
		fencingToken: `fence-${sessionHandle}`,
		generation,
		nativeSessionId,
		persisted: true,
		serverEpoch,
		sessionFile,
		sessionHandle,
		workspaceHandle: "workspace",
		workspacePath: "/workspace",
	};
}

function staleFact(type, error = null) {
	return {
		piCommandCountAfter: 0,
		piCommandCountBefore: 0,
		requestId: `request-${type}`,
		responseError: error,
		responseSuccess: false,
		responseType: type === "epoch" ? "resync_required" : "response",
	};
}

function marker(at, type, sessionId, text = null, pid = 100) {
	return { at, commandId: null, pid, sessionId, text, type };
}

function disconnectEvidence() {
	let high = 0;
	const row = (kind, socket, seq, projected = high) => {
		high = projected;
		return { kind, socket, seq, projected, baseline: true, resync: false };
	};
	return {
		trial: 0,
		invalid: false,
		ended: true,
		beforeOverwrite: { prompt: "prompt", reply: "reply", promptCount: 1, replyCount: 1 },
		rows: [
			row("start", 0, 0),
			row("attach", 1, 0),
			row("wire", 1, 1),
			row("gate", 1, 1),
			row("close", 1, 0),
			row("subscribe", 2, 0),
			row("wire", 2, 1),
			row("forward", 2, 1),
			row("bus", 0, 1),
			row("state", 0, 1, 1),
			row("wire", 2, 2),
			row("hold", 2, 2, 1),
			row("release", 2, 0, 1),
			row("forward", 2, 2),
			row("bus", 0, 2),
			row("state", 0, 2, 2),
			row("wire", 2, 3),
			row("forward", 2, 3),
			row("bus", 0, 3),
			row("state", 0, 3, 3),
			row("end", 0, 3, 3),
		],
	};
}

function recoveryObservation(kind) {
	const before = authority("session-parent", "native-parent", "/workspace/parent.jsonl", "epoch-a", 1);
	const rekey = kind === "recovery-rekey";
	const gatewayRestart = kind === "recovery-gateway-restart";
	const crash = kind === "recovery-crash";
	const after = rekey
		? authority("session-child", "native-child", "/workspace/child.jsonl", "epoch-a", 2)
		: authority(
				before.sessionHandle,
				before.nativeSessionId,
				before.sessionFile,
				gatewayRestart ? "epoch-b" : before.serverEpoch,
				crash ? 2 : before.generation,
			);
	const source = { generation: 1, serverEpoch: "epoch-a", sessionHandle: "session-parent", seq: 0 };
	const resync = kind === "recovery-gap" || gatewayRestart || rekey || crash;
	const barrierSeq = resync ? 1 : null;
	const watermarkGeneration = rekey || crash ? 2 : 1;
	const watermarkEpoch = gatewayRestart ? "epoch-b" : "epoch-a";
	const watermarkSession = rekey ? "session-child" : "session-parent";
	const watermarkSeq = resync ? 2 : 3;
	const targetSessionId = after.nativeSessionId;
	const markers = crash
		? [
				marker(1, "crash_requested", targetSessionId, "prompt", 100),
				marker(2, "started", targetSessionId, null, 101),
				marker(3, "prompt", targetSessionId, "prompt", 101),
				marker(4, "settled", targetSessionId, "prompt", 101),
			]
		: [marker(1, "prompt", targetSessionId, "prompt"), marker(2, "settled", targetSessionId, "prompt")];
	return {
		kind,
		browserErrors: browserErrors(),
		facts: {
			identity: {
				before,
				after,
				parentRelation: rekey
					? {
							childNativeSessionId: after.nativeSessionId,
							childSessionFile: after.sessionFile,
							childSessionHandle: after.sessionHandle,
							parentNativeSessionId: before.nativeSessionId,
							parentSessionFile: before.sessionFile,
							parentSessionHandle: before.sessionHandle,
							previousSessionHandle: before.sessionHandle,
						}
					: null,
			},
			lifecycle: {
				before: {
					activeGatewayCount: 1,
					activeGatewayPid: 10,
					gatewayStarts: 4,
					ownedGatewayCount: 4,
					rootPath: "/tmp/benchmark-root",
					rootEntryCount: 2,
					rootExists: true,
				},
				after: {
					activeGatewayCount: 1,
					activeGatewayPid: 11,
					gatewayStarts: gatewayRestart ? 5 : 4,
					ownedGatewayCount: gatewayRestart ? 5 : 4,
					rootPath: "/tmp/benchmark-root",
					rootEntryCount: 2,
					rootExists: true,
				},
				originAfter: "http://127.0.0.1:3000",
				originBefore: "http://127.0.0.1:3000",
			},
			pi: { markersAfter: markers, markersBefore: [], targetSessionId },
			protocol: {
				disconnectEvidence: resync ? null : disconnectEvidence(),
				barrier: {
					asOfSeq: barrierSeq,
					baseSeq: resync ? 0 : null,
					barrierSeq,
					reason:
						kind === "recovery-gap"
							? "gap"
							: gatewayRestart
								? "epoch_changed"
								: rekey || crash
									? "initial"
									: null,
					required: resync,
					runtimeLastSeq: barrierSeq,
					snapshotSeen: resync,
				},
				cursorBefore: source,
				mode: resync ? "resync" : "replay",
				boundary: {
					resyncFrameIndex: resync ? 0 : null,
					snapshotFrameIndex: resync ? 1 : null,
				},
				postBarrierEventSeqs: resync ? [2] : [],
				preBarrierEventSeqs: resync ? [1] : [],
				rekeyFrameCount: rekey ? 1 : 0,
				resyncFrameCount: resync ? 1 : 0,
				replayEventSeqs: resync ? [] : [1, 1, 2, 3],
				snapshotFrameCount: resync ? 1 : 0,
				watermarkAfter: {
					generation: watermarkGeneration,
					lastSeq: watermarkSeq,
					serverEpoch: watermarkEpoch,
					sessionHandle: watermarkSession,
				},
			},
			projection: { prompt: "prompt", promptCount: 1, reply: "reply", replyCount: 1 },
			socket: {
				closed: kind === "recovery-disconnect" || kind === "recovery-gap" || gatewayRestart ? 1 : 0,
				opened: kind === "recovery-disconnect" || kind === "recovery-gap" || gatewayRestart ? 1 : 0,
			},
			stale: {
				epoch: staleFact("epoch"),
				fence: staleFact("fence", "session_read_only"),
				generation: staleFact("generation", "session_generation_stale"),
				parent: rekey ? staleFact("parent", "session_read_only") : null,
			},
		},
	};
}

function observationFor(definition, index = 0) {
	if (definition.kind.startsWith("recovery-")) {
		const observation = recoveryObservation(definition.kind);
		if (observation.facts.protocol.disconnectEvidence)
			observation.facts.protocol.disconnectEvidence.trial = index;
		return observation;
	}
	if (definition.kind === "streaming") {
		if (!Number.isSafeInteger(definition.targetBytes))
			throw new Error("streaming fixture is missing targetBytes");
		const targetBytes = definition.targetBytes;
		return {
			kind: "streaming",
			browserErrors: browserErrors(),
			facts: {
				dom: {
					liveRichNodeCount: 0,
					settledCountAfterRelease: 1,
					settledCountBeforeRelease: 0,
					settledText: "STREAM_BUDGET_END 🧪",
					streamingCountAfterRelease: 0,
					streamingCountBeforeRelease: 1,
					turnNodes: 4,
					streamingDomMutationBatches: 2,
				},
				frames: {
					deltaCount: 2,
					largeFrameBytes: [targetBytes + 1, targetBytes + 2],
					largeFrameTypes: ["text_end", "message_end"],
				},
			},
		};
	}
	if (definition.kind === "concurrency") {
		const expected = definition.sessions ?? 1;
		return {
			kind: "concurrency",
			browserErrors: browserErrors(),
			facts: {
				sessions: {
					expected,
					minimumBackgroundCheckpoints: 2,
					minimumProjectionCheckpoints: 2,
					projected: expected,
					settled: expected,
					started: expected,
				},
				socket: { closed: 0, opened: 1 },
			},
		};
	}
	if (definition.kind === "history") {
		if (!Number.isSafeInteger(definition.turns) || !Number.isSafeInteger(definition.sourceBytes))
			throw new Error("history fixture is missing sourceBytes or turns");
		const expectedTurns = definition.turns;
		const expectedSourceBytes = definition.sourceBytes;
		return {
			kind: "history",
			browserErrors: browserErrors(),
			facts: {
				dom: { mountedTurnNodes: 4, oldestTurnCount: 1 },
				history: {
					actualSourceBytes: expectedSourceBytes,
					expectedInitialTurns: Math.min(48, expectedTurns),
					expectedSourceBytes,
					expectedTurns,
					initialTurns: Math.min(48, expectedTurns),
					windowTotal: expectedTurns,
				},
				pi: { getMessagesCount: 0 },
			},
		};
	}
	if (definition.kind === "content-roundtrip") {
		if (!Number.isSafeInteger(definition.inputBytes))
			throw new Error("content fixture is missing inputBytes");
		const inputBase64Chars = base64CharsForBytes(definition.inputBytes);
		return {
			kind: "content-roundtrip",
			browserErrors: browserErrors(),
			facts: {
				attachments: {
					attachmentRefCount: 2,
					expectedInputBase64Chars: inputBase64Chars,
					fetchStatus: 1,
					imageComplete: true,
					inlineImageSignatureCount: 0,
					naturalWidth: 1,
					observedInputBase64Chars: inputBase64Chars,
				},
				frames: { maxReceivedFrameBytes: 1024, maxSentFrameBytes: 2048 },
				socket: { closed: 0, opened: 1 },
			},
		};
	}
	throw new Error(`fixture matrix contains an unsupported benchmark kind: ${definition.kind}`);
}

function correctnessFor(definition) {
	const keys =
		definition.kind === "streaming"
			? [
					"nonemptyStreamingObservation",
					"liveTailStayedPlain",
					"structuralReleaseHeldInStreamingDom",
					"structuralReleasePublishedSettledDom",
					"settledEndSentinel",
					"settledUnicode",
					"structuralFramesEmittedInOrder",
					"frameBudgetPreserved",
				]
			: definition.kind === "concurrency"
				? [
						"allSessionsStarted",
						"allSessionsSettled",
						"allBackgroundProjectionsRecovered",
						"allSessionsObservedTwice",
						"backgroundSessionsIngestedBetweenSwitches",
						"singleMultiplexedSocket",
					]
				: definition.kind === "history"
					? [
							"exactSourceBoundary",
							"allTurnsPaged",
							"historyWindowMatchesReadPath",
							"oldestTurnReachable",
							"expectedHistoryReadPath",
						]
					: definition.kind === "content-roundtrip"
						? [
								"inputReachedPiAtExpectedSize",
								"typedOutputRefsObserved",
								"outputBlobResolved",
								"largeOutputStayedOffWebSocket",
								"socketRemainedUsable",
							]
						: [
								"recoveryBarrier",
								"zeroDuplicateLostEvents",
								"staleGenerationRejected",
								"staleFenceRejected",
								"staleEpochRejected",
								"finalProjectionMatches",
								definition.kind === "recovery-disconnect"
									? "disconnectObserved"
									: definition.kind === "recovery-gap"
										? "gapResyncObserved"
										: definition.kind === "recovery-crash"
											? "processRestarted"
											: definition.kind === "recovery-rekey"
												? "rekeyIdentityChanged"
												: "restartCleanup",
							];
	if (definition.kind === "recovery-rekey") keys.push("staleParentRejected");
	return Object.fromEntries([...keys.map((key) => [key, true]), ["complete", true]]);
}

function hardGate(metric, statistic, comparison, threshold, actual) {
	return {
		metric,
		statistic,
		comparison,
		threshold,
		actual,
		mode: "hard",
		passed: true,
		rationale: "fixture",
	};
}

function validGates(definition, variant) {
	const measuredP95 =
		variant === "coalesced" ? (definition.warmups === 0 ? 10 : 20) : definition.warmups === 0 ? 11 : 21;
	const gates = [
		{
			metric: "latencyMs",
			statistic: "p95",
			comparison: "lte",
			threshold: 25,
			actual: measuredP95,
			mode: "observe",
			passed: true,
			rationale: "fixture",
		},
		hardGate("correctnessFailures", "value", "eq", 0, 0),
		hardGate("browserErrors", "value", "eq", 0, 0),
	];
	if (definition.kind === "streaming") gates.push(hardGate("turnNodes", "max", "lte", 64, 4));
	if (definition.kind === "concurrency") {
		gates.push(hardGate("browserProjectionCheckpointDeficit", "max", "lte", 0, 0));
		gates.push(hardGate("backgroundIngestCheckpointDeficit", "max", "lte", 0, 0));
	}
	if (definition.kind === "history") gates.push(hardGate("mountedTurnNodes", "max", "lte", 64, 4));
	if (definition.kind === "content-roundtrip") {
		gates.push(hardGate("authenticatedAttachmentFetch", "value", "eq", 1, 1));
		gates.push(hardGate("maxSentFrameBytes", "max", "lte", 8 * 1024 * 1024, 2048));
		gates.push(hardGate("maxReceivedFrameBytes", "max", "lte", 256 * 1024, 1024));
	}
	if (definition.kind === "recovery-disconnect")
		gates.push(hardGate("reconnectedSockets", "max", "lte", 2, 1));
	if (definition.kind === "recovery-gap") gates.push(hardGate("gapResyncFrames", "max", "eq", 1, 1));
	if (definition.kind === "recovery-crash") gates.push(hardGate("processStarts", "max", "eq", 1, 1));
	if (definition.kind === "recovery-rekey") gates.push(hardGate("rekeyFrames", "max", "eq", 1, 1));
	if (definition.kind === "recovery-gateway-restart") {
		gates.push(hardGate("gatewayStarts", "max", "eq", 1, 1));
		gates.push(hardGate("activeGateways", "max", "eq", 1, 1));
		gates.push(hardGate("rootEntryCount", "max", "lte", 8, 2));
	}
	return gates;
}

function validResult(variant, definition) {
	const measured = Array.from({ length: definition.samples }, (_, index) => {
		if (variant === "coalesced") return index === 0 ? 10 : 20;
		return index === 0 ? 11 : 21;
	});
	const correctness = correctnessFor(definition);
	return {
		schemaVersion: 2,
		suiteVersion: 4,
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
		capabilities: { browser: true, websocket: true, cdp: true, longtask: true, "precise-memory": true },
		trials: [
			...(definition.warmups > 0
				? [{ index: 0, warmup: true, metrics: { latencyMs: 5 }, correctness: structuredClone(correctness) }]
				: []),
			...measured.map((value, index) => ({
				index: index + definition.warmups,
				warmup: false,
				metrics: { latencyMs: value },
				correctness: structuredClone(correctness),
			})),
		],
		summaries: {
			latencyMs: {
				count: measured.length,
				min: measured[0],
				median:
					measured.length % 2 === 0
						? (measured[measured.length / 2 - 1] + measured[measured.length / 2]) / 2
						: measured[Math.floor(measured.length / 2)],
				p95: measured.at(-1),
				max: measured.at(-1),
			},
		},
		gates: validGates(definition, variant),
		notes: [],
		errors: [],
	};
}

function validResults() {
	return representativeScenarios.flatMap((definition) =>
		FORMAL_VARIANTS.map((variant) => validResult(variant, definition)),
	);
}

function validManifest(matrixValue = matrix) {
	const expected = canonicalFormalExpectedScenarioSet(matrixValue, "representative");
	const keys = expected.map((entry) => `${entry.domain}/${entry.id}/${entry.variant}`);
	return {
		schemaVersion: 2,
		suiteVersion: 4,
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
		warmupCounts: Object.fromEntries(keys.map((key, index) => [key, expected[index].warmups])),
		measuredCounts: Object.fromEntries(keys.map((key, index) => [key, expected[index].measured])),
		capabilities: { browser: true, websocket: true, cdp: true, longtask: true, "precise-memory": true },
		expectedScenarioSet: expected,
	};
}

function validEnvironment() {
	return {
		schemaVersion: 2,
		suiteVersion: 4,
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
			observation: structuredClone(observationFor(result.parameters, trial.index)),
			trial: { index: trial.index, warmup: trial.warmup },
		},
	}));
}

function validate(overrides = {}) {
	const results = overrides.results ?? validResults();
	const matrixValue = overrides.matrix ?? matrix;
	return validateBenchmarkArtifacts({
		matrix: matrixValue,
		tier: "representative",
		runId: RUN_ID,
		artifacts:
			overrides.artifacts ??
			results.map((value) => ({ name: `${value.scenarioId}/${value.variant}.result.json`, value })),
		rawArtifacts: overrides.rawArtifacts ?? results.flatMap(rawFor),
		manifest: overrides.manifest ?? validManifest(matrixValue),
		environment: overrides.environment ?? validEnvironment(),
		playwrightExitCode: overrides.playwrightExitCode ?? 0,
	});
}

function errorText(outcome) {
	return outcome.errors.join("\n");
}

function resultsForKind(kind) {
	return validResults().filter((result) => result.kind === kind);
}

test("loads the complete root and domain matrices with exactly five recovery classes per tier", () => {
	assert.deepEqual(Object.keys(matrix.provenance.domainHashes), [
		"concurrency",
		"content",
		"history",
		"recovery",
		"streaming",
	]);
	assert.equal(matrix.tiers.representative.scenarios.length, 11);
	const recovery = matrix.domains.find((domain) => domain.id === "recovery");
	assert.ok(recovery);
	assert.deepEqual(
		recovery.tiers.representative.scenarios.map((entry) => entry.kind),
		["recovery-disconnect", "recovery-gap", "recovery-crash", "recovery-rekey", "recovery-gateway-restart"],
	);
});

test("defines canonical formal pairs from the loaded matrix projection", () => {
	const expected = canonicalFormalExpectedScenarioSet(matrix, "representative");
	assert.equal(expected.length, matrix.tiers.representative.scenarios.length * 2);
	const firstScenario = representativeScenarios[0];
	assert.ok(firstScenario);
	assert.deepEqual(
		expected.slice(0, 2).map((entry) => `${entry.id}/${entry.variant}`),
		[`${firstScenario.id}/coalesced`, `${firstScenario.id}/sequential`],
	);
});

test("keeps the validator producer-path export aligned with an independent oracle", () => {
	assert.deepEqual(BENCHMARK_PRODUCER_PATHS, EXPECTED_BENCHMARK_PRODUCER_PATHS);
});

test("accepts one complete formal schema-v2 artifact set", () => {
	assert.deepEqual(validate().errors, []);
});

test("requires canonical result and raw artifact paths", () => {
	const results = validResults();
	const artifacts = results.map((value) => ({
		name: `${value.scenarioId}/${value.variant}.result.json`,
		value,
	}));
	artifacts[0].name = "renamed.result.json";
	assert.match(errorText(validate({ results, artifacts })), /result artifact path must be/);
	const rawArtifacts = results.flatMap(rawFor);
	rawArtifacts[0].name = "../escape.json";
	assert.match(errorText(validate({ results, rawArtifacts })), /raw artifact path|raw trial path must be/);
});

test("enforces exact Issue #28 Phase 1 complete matrix scope", () => {
	const incompleteMatrix = structuredClone(matrix);
	incompleteMatrix.scope.status = "incomplete";
	assert.match(
		errorText(validate({ matrix: incompleteMatrix, manifest: validManifest() })),
		/#28 Phase 1 \/ complete/,
	);

	const overclaimedPhaseMatrix = structuredClone(matrix);
	overclaimedPhaseMatrix.scope.phase = 2;
	assert.match(
		errorText(validate({ matrix: overclaimedPhaseMatrix, manifest: validManifest() })),
		/#28 Phase 1 \/ complete/,
	);

	const invalidLabelMatrix = structuredClone(matrix);
	invalidLabelMatrix.scope.label = "#28 Phase 1 / incomplete";
	assert.match(
		errorText(validate({ matrix: invalidLabelMatrix, manifest: validManifest() })),
		/#28 Phase 1 \/ complete/,
	);
});

test("rejects missing, duplicate, and partial raw trial observations", () => {
	const results = validResults();
	const partial = results.flatMap(rawFor).slice(0, -1);
	assert.match(errorText(validate({ results, rawArtifacts: partial })), /missing raw trial/);
	const duplicate = [...results.flatMap(rawFor), structuredClone(rawFor(results[0])[0])];
	assert.match(errorText(validate({ results, rawArtifacts: duplicate })), /duplicate raw trial/);
	const malformed = results.flatMap(rawFor);
	delete malformed[0].value.observation;
	assert.match(errorText(validate({ results, rawArtifacts: malformed })), /observation/);
});

test("derives browser-error hard gates from atomic observations", () => {
	const results = validResults();
	const rawArtifacts = results.flatMap(rawFor);
	rawArtifacts[0].value.observation.browserErrors.console.push("observed console error");
	assert.match(errorText(validate({ results, rawArtifacts })), /gate browserErrors\.value actual must be 1/);
});

test("allows only one exact Gateway restart refusal in its own raw trial", () => {
	const accepted = validResults().flatMap(rawFor);
	const acceptedTrial = accepted.find((artifact) => artifact.value.kind === "recovery-gateway-restart");
	assert.ok(acceptedTrial);
	acceptedTrial.value.observation.browserErrors.console.push(EXPECTED_GATEWAY_RESTART_REFUSAL);
	assert.deepEqual(validate({ rawArtifacts: accepted }).errors, []);

	for (const [label, mutate] of [
		[
			"wrong host",
			(observation) =>
				observation.browserErrors.console.push(
					EXPECTED_GATEWAY_RESTART_REFUSAL.replace("127.0.0.1", "localhost"),
				),
		],
		[
			"wrong path",
			(observation) =>
				observation.browserErrors.console.push(
					EXPECTED_GATEWAY_RESTART_REFUSAL.replace("/api/v1/ws", "/api/v1/other"),
				),
		],
		[
			"wrong message",
			(observation) =>
				observation.browserErrors.console.push(
					EXPECTED_GATEWAY_RESTART_REFUSAL.replace("net::ERR_CONNECTION_REFUSED", "net::ERR_FAILED"),
				),
		],
		[
			"duplicate refusal",
			(observation) =>
				observation.browserErrors.console.push(
					EXPECTED_GATEWAY_RESTART_REFUSAL,
					EXPECTED_GATEWAY_RESTART_REFUSAL,
				),
		],
		[
			"page error",
			(observation) => {
				observation.browserErrors.console.push(EXPECTED_GATEWAY_RESTART_REFUSAL);
				observation.browserErrors.page.push("unexpected page error");
			},
		],
	]) {
		const rawArtifacts = validResults().flatMap(rawFor);
		const restartTrial = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-gateway-restart");
		assert.ok(restartTrial);
		mutate(restartTrial.value.observation);
		assert.match(errorText(validate({ rawArtifacts })), /browserErrors/, `${label} must fail validation`);
	}

	const nonRestart = validResults().flatMap(rawFor);
	const disconnectTrial = nonRestart.find((artifact) => artifact.value.kind === "recovery-disconnect");
	assert.ok(disconnectTrial);
	disconnectTrial.value.observation.browserErrors.console.push(EXPECTED_GATEWAY_RESTART_REFUSAL);
	assert.match(errorText(validate({ rawArtifacts: nonRestart })), /browserErrors/);
});

test("accepts an explicit rekey pre-admission rejection only without side effects", () => {
	const accepted = validResults().flatMap(rawFor);
	const rekeyTrials = accepted.filter((artifact) => artifact.value.kind === "recovery-rekey");
	assert.ok(rekeyTrials.length > 0);
	for (const artifact of rekeyTrials) {
		artifact.value.observation.facts.stale.parent.responseError = "session_not_subscribed";
	}
	assert.deepEqual(validate({ rawArtifacts: accepted }).errors, []);

	for (const [label, mutate] of [
		["arbitrary rejection", (parent) => (parent.responseError = "session_unknown")],
		["accepted response", (parent) => (parent.responseSuccess = true)],
		["Pi side effect", (parent) => (parent.piCommandCountAfter += 1)],
	]) {
		const rawArtifacts = validResults().flatMap(rawFor);
		const rekeyTrial = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-rekey");
		assert.ok(rekeyTrial);
		rekeyTrial.value.observation.facts.stale.parent.responseError = "session_not_subscribed";
		mutate(rekeyTrial.value.observation.facts.stale.parent);
		assert.match(errorText(validate({ rawArtifacts })), /correctness|stale/, `${label} must fail validation`);
	}
});

test("does not require background checkpoints for one Session but keeps the multi-Session deficit gate", () => {
	const oneSession = validResults().flatMap(rawFor);
	for (const artifact of oneSession) {
		if (artifact.value.kind === "concurrency" && artifact.value.observation.facts.sessions.expected === 1) {
			artifact.value.observation.facts.sessions.minimumBackgroundCheckpoints = 0;
		}
	}
	assert.deepEqual(validate({ rawArtifacts: oneSession }).errors, []);

	const multiSession = validResults().flatMap(rawFor);
	for (const artifact of multiSession) {
		if (artifact.value.kind === "concurrency" && artifact.value.observation.facts.sessions.expected > 1) {
			artifact.value.observation.facts.sessions.minimumBackgroundCheckpoints = 0;
		}
	}
	assert.match(
		errorText(validate({ rawArtifacts: multiSession })),
		/gate backgroundIngestCheckpointDeficit\.max actual must be 2/,
	);
});

test("keeps timing metrics observe-only and enforces required structural hard gates", () => {
	const results = validResults();
	results[0].gates[0].mode = "hard";
	assert.match(errorText(validate({ results })), /hard gate.*latencyMs.*observe-only/);
	const history = resultsForKind("history")[0];
	assert.ok(history);
	assert.ok(history.gates.some((gate) => gate.metric === "mountedTurnNodes" && gate.mode === "hard"));
});

test("rejects a flat or partial matrix instead of accepting a fallback projection", () => {
	const flattened = structuredClone(matrix);
	delete flattened.domains;
	const outcome = validate({
		matrix: flattened,
		artifacts: [],
		rawArtifacts: [],
		manifest: {},
		environment: {},
	});
	assert.match(errorText(outcome), /canonical loadBenchmarkMatrix projection/);
});

test("rejects a synthetic matrix projection even when its local shape is valid", () => {
	const forged = structuredClone(matrix);
	const streamingDomain = forged.domains.find((domain) => domain.id === "streaming");
	assert.ok(streamingDomain);
	streamingDomain.requiredCapabilities = [...streamingDomain.requiredCapabilities, "forged"];
	assert.match(
		errorText(validate({ matrix: forged, artifacts: [], rawArtifacts: [], manifest: {} })),
		/canonical/,
	);
});

test("requires every recovery correctness field and the hard correctness gate", () => {
	const results = validResults();
	const crash = results.find((result) => result.kind === "recovery-crash" && result.variant === "coalesced");
	assert.ok(crash);
	delete crash.trials[1].correctness.processRestarted;
	assert.match(
		errorText(validate({ results })),
		/correctness\.processRestarted must be boolean for recovery/,
	);
	const noGate = validResults();
	const noCrashGate = noGate.find(
		(result) => result.kind === "recovery-crash" && result.variant === "coalesced",
	);
	assert.ok(noCrashGate);
	noCrashGate.gates = noCrashGate.gates.filter((gate) => gate.metric !== "correctnessFailures");
	assert.match(errorText(validate({ results: noGate })), /missing required hard gate correctnessFailures/);
});

test("fails closed on malformed observations and missing required capabilities", () => {
	const malformed = validResults();
	delete malformed[0].capabilities.websocket;
	assert.match(errorText(validate({ results: malformed })), /missing required capability: websocket/);
	const rawArtifacts = validResults().flatMap(rawFor);
	const streamingRaw = rawArtifacts.find((artifact) => artifact.value.kind === "streaming");
	assert.ok(streamingRaw);
	delete streamingRaw.value.observation.facts.dom;
	assert.match(errorText(validate({ rawArtifacts })), /facts.*dom/);
});

test("rejects incomplete correctness and failed result status with a zero outer exit", () => {
	const results = validResults();
	results[0].trials[1].correctness.complete = false;
	results[0].status = "failed";
	assert.match(errorText(validate({ results })), /correctness\.complete must be true/);
	assert.match(errorText(validate({ results })), /status must be passed in a complete formal result/);
});

test("rejects singleton producer declarations and a tampered execution order", () => {
	const manifest = validManifest();
	manifest.canonicalVariants = ["coalesced"];
	manifest.executionOrder = ["coalesced"];
	assert.match(errorText(validate({ manifest })), /canonicalVariants must be exactly/);
	const orderManifest = validManifest();
	orderManifest.executionOrder.reverse();
	assert.match(errorText(validate({ manifest: orderManifest })), /deterministic seeded formal variant order/);
});

test("recomputes summaries, gates, and canonical manifest counts", () => {
	const results = validResults();
	const first = results[0];
	first.summaries.latencyMs.p95 = 1;
	first.gates[0].actual = 1;
	first.gates[0].passed = false;
	const manifest = validManifest();
	manifest.measuredCounts[`${first.domain}/${first.scenarioId}/${first.variant}`] = 1;
	const errors = errorText(validate({ results, manifest }));
	assert.match(errors, /summary latencyMs\.p95 must be 20/);
	assert.match(errors, /gate latencyMs\.p95 actual must be 20/);
	assert.match(errors, /measuredCounts.*must match expected scenario/);
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
	for (const requiredPath of EXPECTED_BENCHMARK_PRODUCER_PATHS) {
		const manifest = validManifest();
		delete manifest.fixtureHashes[requiredPath];
		assert.match(errorText(validate({ manifest })), /fixtureHashes.*exactly/);
	}
});

test("rejects duplicate, missing, and extra scenario results before map overwrite", () => {
	const results = validResults();
	const duplicate = structuredClone(results[0]);
	const artifacts = results.map((value) => ({
		name: `${value.scenarioId}/${value.variant}.result.json`,
		value,
	}));
	artifacts.push({
		name: `${duplicate.scenarioId}/${duplicate.variant}.duplicate.result.json`,
		value: duplicate,
	});
	const extra = structuredClone(results[0]);
	extra.scenarioId = "extra";
	extra.parameters.id = "extra";
	artifacts.push({ name: "extra/coalesced.result.json", value: extra });
	const errors = errorText(validate({ artifacts }));
	assert.match(errors, /duplicate scenario artifact/);
	assert.match(errors, /unexpected scenario artifact/);
});

test("requires an authoritative watermark and strict partitioned sequence continuity", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const recoveryRaw = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-crash");
	assert.ok(recoveryRaw);
	recoveryRaw.value.observation.facts.protocol.watermarkAfter.lastSeq = 2;
	recoveryRaw.value.observation.facts.protocol.postBarrierEventSeqs = [1];
	assert.match(errorText(validate({ rawArtifacts })), /sequence|watermark|independently derived/);
});

test("derives restart ownership from cumulative before/after lifecycle snapshots", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const restartRaw = rawArtifacts.filter((artifact) => artifact.value.kind === "recovery-gateway-restart");
	assert.ok(restartRaw.length > 0);
	for (const artifact of restartRaw) {
		const lifecycle = artifact.value.observation.facts.lifecycle;
		lifecycle.before.gatewayStarts = 5;
		lifecycle.before.ownedGatewayCount = 5;
		lifecycle.after.gatewayStarts = 6;
		lifecycle.after.ownedGatewayCount = 6;
	}
	assert.deepEqual(validate({ rawArtifacts }).errors, []);
	restartRaw[0].value.observation.facts.lifecycle.after.ownedGatewayCount = 7;
	assert.match(errorText(validate({ rawArtifacts })), /correctness|gateway|independently derived/);
});

test("does not accept forged non-recovery hard claims detached from observations", () => {
	const results = validResults();
	const streaming = results.find((result) => result.kind === "streaming" && result.variant === "coalesced");
	assert.ok(streaming);
	streaming.gates.find((gate) => gate.metric === "turnNodes").actual = 999;
	streaming.gates.find((gate) => gate.metric === "turnNodes").passed = false;
	assert.match(errorText(validate({ results })), /turnNodes.*actual must be 4/);
});

test("permits mountedTurnNodes as an independently recomputable hard gate", () => {
	const history = resultsForKind("history").find((result) => result.variant === "coalesced");
	assert.ok(history);
	const gate = history.gates.find((entry) => entry.metric === "mountedTurnNodes");
	assert.ok(gate);
	assert.equal(gate.mode, "hard");
	assert.equal(gate.actual, 4);
	assert.deepEqual(validate().errors, []);
});

test("does not aggregate a missing hard value observation away", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const contentRaw = rawArtifacts.filter((artifact) => artifact.value.kind === "content-roundtrip");
	assert.ok(contentRaw.length > 0);
	for (const artifact of contentRaw) artifact.value.observation.facts.attachments.fetchStatus = 0;
	assert.match(
		errorText(validate({ rawArtifacts })),
		/authenticatedAttachmentFetch.*actual must be 0|correctness/,
	);
});

test("rejects null or partial persisted recovery identity", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const recoveryRaw = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-crash");
	assert.ok(recoveryRaw);
	recoveryRaw.value.observation.facts.identity.before.sessionFile = null;
	assert.match(errorText(validate({ rawArtifacts })), /sessionFile|persisted|identity/);
});

test("rejects stale-authority side effects even when the response is rejected", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const recoveryRaw = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-crash");
	assert.ok(recoveryRaw);
	recoveryRaw.value.observation.facts.stale.generation.piCommandCountAfter = 1;
	assert.match(errorText(validate({ rawArtifacts })), /correctness|stale|independently derived/);
});

test("binds history and content correctness to canonical workload definitions", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const historyRaw = rawArtifacts.find((artifact) => artifact.value.kind === "history");
	assert.ok(historyRaw);
	const history = historyRaw.value.observation.facts.history;
	history.actualSourceBytes += 1;
	history.expectedSourceBytes = history.actualSourceBytes;
	history.windowTotal += 1;
	history.expectedTurns = history.windowTotal;
	const contentRaw = rawArtifacts.find((artifact) => artifact.value.kind === "content-roundtrip");
	assert.ok(contentRaw);
	contentRaw.value.observation.facts.attachments.observedInputBase64Chars = 0;
	contentRaw.value.observation.facts.attachments.expectedInputBase64Chars = 0;
	assert.match(errorText(validate({ rawArtifacts })), /correctness|independently derived/);
});

test("ignores redundant raw workload expectations when observations match the matrix", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	for (const artifact of rawArtifacts) {
		if (artifact.value.kind === "history") {
			artifact.value.observation.facts.history.expectedInitialTurns = 0;
			artifact.value.observation.facts.history.expectedSourceBytes = 0;
			artifact.value.observation.facts.history.expectedTurns = 0;
		}
		if (artifact.value.kind === "content-roundtrip") {
			artifact.value.observation.facts.attachments.expectedInputBase64Chars = 0;
		}
	}
	assert.deepEqual(validate({ rawArtifacts }).errors, []);
});

test("requires an exact non-empty ordered streaming frame pair", () => {
	assert.ok(scenario.targetBytes !== undefined);
	for (const largeFrameBytes of [
		[],
		[scenario.targetBytes + 1],
		[scenario.targetBytes + 1, scenario.targetBytes + 2, scenario.targetBytes + 3],
	]) {
		const rawArtifacts = validResults().flatMap(rawFor);
		const streamingRaw = rawArtifacts.find((artifact) => artifact.value.kind === "streaming");
		assert.ok(streamingRaw);
		streamingRaw.value.observation.facts.frames.largeFrameBytes = largeFrameBytes;
		assert.match(errorText(validate({ rawArtifacts })), /correctness|independently derived/);
	}
});

test("requires recovery progress beyond the authoritative pre-fault cursor", () => {
	for (const kind of ["recovery-disconnect", "recovery-gap"]) {
		const rawArtifacts = validResults().flatMap(rawFor);
		const recoveryRaw = rawArtifacts.find((artifact) => artifact.value.kind === kind);
		assert.ok(recoveryRaw);
		const protocol = recoveryRaw.value.observation.facts.protocol;
		protocol.cursorBefore.seq = 1;
		protocol.watermarkAfter.lastSeq = 1;
		protocol.replayEventSeqs = [];
		protocol.preBarrierEventSeqs = [];
		protocol.postBarrierEventSeqs = [];
		if (protocol.mode === "resync") {
			protocol.barrier.asOfSeq = 1;
			protocol.barrier.barrierSeq = 1;
			protocol.barrier.runtimeLastSeq = 1;
		}
		const errors = errorText(validate({ rawArtifacts }));
		assert.ok(errors.length > 0, `${kind}: expected non-advancing recovery progress to fail`);
		assert.match(errors, /correctness|sequence|watermark|independently derived/);
	}
});

test("records ordered recovery sequence partitions around the snapshot boundary", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const replayRaw = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-disconnect");
	const resyncRaw = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-gap");
	assert.ok(replayRaw);
	assert.ok(resyncRaw);
	assert.deepEqual(replayRaw.value.observation.facts.protocol.boundary, {
		resyncFrameIndex: null,
		snapshotFrameIndex: null,
	});
	assert.deepEqual(replayRaw.value.observation.facts.protocol.replayEventSeqs, [1, 1, 2, 3]);
	assert.deepEqual(resyncRaw.value.observation.facts.protocol.boundary, {
		resyncFrameIndex: 0,
		snapshotFrameIndex: 1,
	});
	assert.deepEqual(resyncRaw.value.observation.facts.protocol.preBarrierEventSeqs, [1]);
	assert.deepEqual(resyncRaw.value.observation.facts.protocol.postBarrierEventSeqs, [2]);
});

test("rejects a same-identity resync barrier that predates the consumed cursor", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const recoveryRaw = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-gap");
	assert.ok(recoveryRaw);
	const protocol = recoveryRaw.value.observation.facts.protocol;
	protocol.cursorBefore.seq = 2;
	protocol.barrier.asOfSeq = 1;
	protocol.barrier.barrierSeq = 1;
	protocol.barrier.runtimeLastSeq = 1;
	protocol.watermarkAfter.lastSeq = 3;
	protocol.preBarrierEventSeqs = [1, 2];
	protocol.postBarrierEventSeqs = [2, 3];
	assert.match(errorText(validate({ rawArtifacts })), /correctness|sequence|independently derived/);
});

test("accepts a nonempty pre-barrier prefix when the snapshot advances the watermark", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const recoveryRaw = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-gap");
	assert.ok(recoveryRaw);
	const protocol = recoveryRaw.value.observation.facts.protocol;
	protocol.postBarrierEventSeqs = [];
	protocol.watermarkAfter.lastSeq = protocol.barrier.asOfSeq;
	assert.deepEqual(validate({ rawArtifacts }).errors, []);
});

test("rejects post-barrier gaps and duplicates", () => {
	for (const postBarrierEventSeqs of [[3], [2, 2]]) {
		const rawArtifacts = validResults().flatMap(rawFor);
		const recoveryRaw = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-gap");
		assert.ok(recoveryRaw);
		recoveryRaw.value.observation.facts.protocol.postBarrierEventSeqs = postBarrierEventSeqs;
		assert.match(errorText(validate({ rawArtifacts })), /correctness|sequence|independently derived/);
	}
});

test("does not reclassify a pre-fault marker as the recovered target prompt", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const recoveryRaw = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-disconnect");
	assert.ok(recoveryRaw);
	const facts = recoveryRaw.value.observation.facts;
	const preFaultPrompt = structuredClone(facts.pi.markersAfter[0]);
	const recoveredPrompt = { ...preFaultPrompt, at: preFaultPrompt.at + 2 };
	const recoveredSettled = { ...facts.pi.markersAfter[1], at: preFaultPrompt.at + 3 };
	facts.pi.markersBefore = [preFaultPrompt];
	facts.pi.markersAfter = [preFaultPrompt, recoveredPrompt, recoveredSettled];
	assert.match(errorText(validate({ rawArtifacts })), /correctness|independently derived/);
});

test("requires a real before/after Gateway restart lifecycle and PID transition", () => {
	for (const mutate of [
		(lifecycle) => {
			lifecycle.before.activeGatewayCount = 0;
			lifecycle.before.activeGatewayPid = null;
		},
		(lifecycle) => {
			lifecycle.after.activeGatewayPid = lifecycle.before.activeGatewayPid;
		},
		(lifecycle) => {
			lifecycle.after.activeGatewayPid = null;
		},
	]) {
		const rawArtifacts = validResults().flatMap(rawFor);
		const restartRaw = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-gateway-restart");
		assert.ok(restartRaw);
		mutate(restartRaw.value.observation.facts.lifecycle);
		assert.match(errorText(validate({ rawArtifacts })), /correctness|gateway|independently derived/);
	}
});

test("rejects traversal, duplicate, missing, and extra raw labels", () => {
	const results = validResults();
	const rawArtifacts = results.flatMap(rawFor);
	rawArtifacts[0].name = "stream-test/../../escape.json";
	const duplicate = structuredClone(rawArtifacts[1]);
	duplicate.name = rawArtifacts[1].name;
	rawArtifacts.push(duplicate);
	rawArtifacts.pop();
	rawArtifacts.pop();
	rawArtifacts.push({ name: "extra/coalesced-0.json", value: structuredClone(rawArtifacts[0].value) });
	assert.match(
		errorText(validate({ results, rawArtifacts })),
		/raw artifact path|raw trial path|missing raw trial|unexpected raw trial/,
	);
});

for (const field of ["turnNodes", "streamingDomMutationBatches", "deltaCount"]) {
	test(`rejects empty streaming ${field} even when producer claims success`, () => {
		const results = validResults();
		const rawArtifacts = results.flatMap(rawFor);
		const raw = rawArtifacts.find((entry) => entry.value.kind === "streaming");
		const facts = raw.value.observation.facts;
		if (field === "deltaCount") facts.frames.deltaCount = 0;
		else facts.dom[field] = 0;
		assert.match(
			errorText(validate({ results, rawArtifacts })),
			/correctness must equal independently derived/,
		);
	});
}

test("rejects suite-v2 streaming evidence after observer semantics changed", () => {
	const results = validResults();
	results[0].suiteVersion = 2;
	assert.match(errorText(validate({ results })), /suiteVersion must be 4/);
});

for (const warmup of [true, false]) {
	test(`rejects streaming turn overmount in ${warmup ? "warmup" : "measured"} trials`, () => {
		const results = validResults();
		const streaming = results.find((result) => result.kind === "streaming");
		for (const entry of streaming.trials) entry.metrics.turnNodes = 4;
		streaming.summaries.turnNodes = { count: 3, min: 4, max: 4, median: 4, p95: 4 };
		assert.deepEqual(validate({ results }).errors, []);
		const trial = streaming.trials.find((entry) => entry.warmup === warmup);
		trial.metrics.turnNodes = 65;
		if (!warmup) {
			streaming.summaries.turnNodes.max = 65;
			streaming.summaries.turnNodes.p95 = 65;
		}
		const rawArtifacts = results.flatMap(rawFor);
		const raw = rawArtifacts.find(
			(entry) =>
				entry.value.scenarioId === streaming.scenarioId &&
				entry.value.variant === streaming.variant &&
				entry.value.trial.index === trial.index,
		);
		raw.value.observation.facts.dom.turnNodes = 65;
		// Keep raw facts and trial metrics consistent; the per-trial correctness
		// claim must reject overmount even when the summary excludes warmups.
		assert.match(
			errorText(validate({ results, rawArtifacts })),
			/correctness must equal independently derived/,
		);
	});
}

test("accepts wire-ahead replay with unique bus admission and confirmed coverage", () => {
	const evidence = disconnectEvidence();
	assert.equal(disconnectEvidenceIsValid(evidence, 0, 3, evidence.beforeOverwrite), true);
});
for (const [name, mutate] of [
	["same socket duplicate", (e) => e.rows.splice(3, 0, { ...e.rows[2] })],
	["repeated bus admission", (e) => e.rows.splice(9, 0, { ...e.rows[8] })],
	["missing close", (e) => e.rows.splice(4, 1)],
	["missing subscribe", (e) => e.rows.splice(5, 1)],
	[
		"wrong cursor",
		(e) => {
			e.rows[5].seq = 1;
		},
	],
	[
		"unconfirmed projection",
		(e) => {
			e.rows.at(-1).projected = 2;
		},
	],
	[
		"projection reversal",
		(e) => {
			e.rows[15].projected = 0;
		},
	],
	[
		"wrong identity or observer failure",
		(e) => {
			e.invalid = true;
		},
	],
	[
		"empty evidence",
		(e) => {
			e.rows = [];
		},
	],
	[
		"missing end",
		(e) => {
			e.ended = false;
		},
	],
	[
		"repeated append before overwrite",
		(e) => {
			e.beforeOverwrite.reply = "replyreply";
		},
	],
	[
		"snapshot jump",
		(e) => {
			e.rows[9].resync = true;
		},
	],
])
	test(`rejects disconnect ${name}`, () => {
		const evidence = disconnectEvidence();
		mutate(evidence);
		assert.equal(disconnectEvidenceIsValid(evidence, 0, 3, { prompt: "prompt", reply: "reply" }), false);
	});
test("recorder fails closed on reset, overflow, late callbacks, and missing start", () => {
	const row = disconnectEvidence().rows[0];
	for (const exercise of [
		(r) => {
			r.start(0);
			r.start(1);
		},
		(r) => {
			r.start(0);
			r.record(0, row);
			r.record(0, row);
		},
		(r) => {
			r.start(0);
			r.end(0);
			r.record(0, row);
		},
		(r) => {
			r.record(0, row);
			r.start(0);
		},
	]) {
		const recorder = createRecoveryRecorder(1);
		exercise(recorder);
		assert.ok(recorder.read() === null || recorder.read().invalid);
		recorder.start(1);
		assert.ok(recorder.read() === null || recorder.read().invalid);
	}
	const recorder = createRecoveryRecorder();
	recorder.start(0);
	recorder.record(0, row);
	assert.equal(recorder.read().rows.length, 1);
	assert.equal(recorder.read().rows.length, 1);
	recorder.end(0);
	recorder.start(1);
	assert.equal(recorder.read().invalid, false);
});

test("actual observer, callback gate and validator preserve the complete wire identity", async () => {
	const { armRecoveryGate, installRecoveryGate } = await import(
		"../tests/e2e/benchmarks/recovery-evidence.ts"
	);
	const source = fs.readFileSync(
		new URL("../packages/ui/src/lib/benchmark-browser.tsx", import.meta.url),
		"utf8",
	);
	const observer = stripTypeScriptTypes(
		source
			.slice(source.indexOf("export function installRecoveryEvidence"), source.indexOf("/**\n * This root"))
			.replace("export function", "function"),
	);
	const originalWindow = globalThis.window;
	async function run(change = {}, tail = false) {
		let bus;
		let changed;
		const channel = {
			runtime: { serverEpoch: "epoch", generation: 1, workspaceId: "workspace" },
			lastSeq: 0,
			projectedSeq: 0,
			baselineAuthoritative: true,
			resync: null,
		};
		class Socket {
			static OPEN = 1;
			readyState = 1;
			listeners = new Map();
			send() {}
			addEventListener(type, callback) {
				this.listeners.set(type, callback);
			}
			close() {
				this.readyState = 3;
			}
			receive(message) {
				this.listeners.get("message")?.({ data: JSON.stringify(message) });
			}
		}
		const win = { WebSocket: Socket };
		vm.runInNewContext(`${observer}\ninstallRecoveryEvidence();`, {
			window: win,
			createRecoveryRecorder,
			sessionTransport: {
				store: {
					getState: () => ({ sessions: { session: channel } }),
					subscribe: (callback) => {
						changed = callback;
					},
				},
				frameBus: {
					subscribeAll: (callback) => {
						bus = callback;
					},
				},
			},
		});
		globalThis.window = win;
		await installRecoveryGate({ addInitScript: (install) => install() });
		const delivered = [];
		const callback = (event) => {
			const message = JSON.parse(event.data);
			delivered.push(message.seq);
			bus({ message });
			channel.lastSeq = message.seq;
			channel.projectedSeq = message.seq;
			changed();
		};
		const old = new win.WebSocket();
		old.onmessage = callback;
		await armRecoveryGate(
			{ evaluate: (evaluate, args) => evaluate(args) },
			0,
			"session",
			"epoch",
			1,
			"workspace",
		);
		const frame = (seq, event) => ({
			type: "event",
			sessionHandle: "session",
			serverEpoch: "epoch",
			generation: 1,
			workspaceId: "workspace",
			seq,
			event,
		});
		const delta = frame(1, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "unique-token" },
		});
		const end = frame(2, { type: "message_end", message: { role: "assistant" } });
		old.receive({ ...delta, ...(tail ? {} : change) });
		if (tail) old.receive({ ...end, ...change });
		assert.deepEqual(delivered, []);
		assert.equal(old.readyState, 3);
		old.listeners.get("close")();
		const next = new win.WebSocket();
		next.onmessage = callback;
		next.send(
			JSON.stringify({
				type: "session_subscribe",
				sessionHandle: "session",
				cursor: { seq: 0, serverEpoch: "epoch", generation: 1 },
			}),
		);
		next.receive(delta);
		next.receive(end);
		next.receive(frame(3, { type: "agent_settled" }));
		assert.deepEqual(delivered, [1]);
		win.__piwebRecoveryGate.release();
		assert.deepEqual(delivered, [1, 2, 3]);
		const evidence = structuredClone(win.__piwebRecoveryGate.finish());
		evidence.beforeOverwrite = { prompt: "prompt", reply: "unique-token", promptCount: 1, replyCount: 1 };
		const valid = disconnectEvidenceIsValid(evidence, 0, 3, evidence.beforeOverwrite);
		old.receive(delta);
		assert.equal(win.__piwebBenchmarkRecovery.read().invalid, true);
		assert.deepEqual(delivered, [1, 2, 3]);
		return { evidence, valid };
	}
	try {
		assert.equal((await run()).valid, true);
		assert.equal((await run({}, true)).valid, true);
		for (const change of [{ workspaceId: "OTHER" }, { serverEpoch: "OTHER" }, { generation: 2 }]) {
			for (const tail of [false, true]) {
				const result = await run(change, tail);
				assert.equal(result.evidence.invalid, true, JSON.stringify({ change, tail }));
				assert.equal(result.valid, false);
			}
		}
	} finally {
		globalThis.window = originalWindow;
	}
});

test("legal overlap preserves an already admitted prefix and does not infer acceptance from old wire tail", () => {
	const evidence = disconnectEvidence();
	const sample = (kind, socket, seq, projected) => ({
		kind,
		socket,
		seq,
		projected,
		baseline: true,
		resync: false,
	});
	const prefix = [sample("start", 0, 24, 24), sample("attach", 1, 24, 24)];
	for (let seq = 25; seq <= 31; seq++) {
		prefix.push(
			sample("wire", 1, seq, seq - 1),
			sample("forward", 1, seq, seq - 1),
			sample("bus", 0, seq, seq - 1),
			sample("state", 0, seq, seq),
		);
	}
	const suffix = evidence.rows.slice(2).map((row) => ({
		...row,
		seq: row.kind === "close" || row.kind === "release" ? 0 : row.seq + 31,
		projected: row.projected + 31,
	}));
	// Receipt after the gate may precede the old socket close, without a corresponding callback.
	suffix.splice(2, 0, sample("wire", 1, 33, 31));
	evidence.rows = [...prefix, ...suffix];
	assert.equal(disconnectEvidenceIsValid(evidence, 24, 34, evidence.beforeOverwrite), true);
	const gateIndex = evidence.rows.findIndex((row) => row.kind === "gate");
	evidence.rows.splice(gateIndex + 1, 0, sample("forward", 1, 32, 31));
	assert.equal(disconnectEvidenceIsValid(evidence, 24, 34, evidence.beforeOverwrite), false);
});

test("rejects disconnect evidence captured for a different trial", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const raw = rawArtifacts.find((entry) => entry.value.kind === "recovery-disconnect");
	raw.value.observation.facts.protocol.disconnectEvidence.trial++;
	assert.match(errorText(validate({ rawArtifacts })), /must belong to this trial/);
});

function authenticationFixture(observation) {
	const url = `${observation.facts.lifecycle.originBefore}/api/v1/bootstrap`;
	const text = "Failed to load resource: net::ERR_CONNECTION_REFUSED";
	observation.browserErrors.console = [text];
	observation.facts.restartAuthentication = {
		arm: 1,
		seal: 5,
		invalid: false,
		requests: [
			{
				url,
				method: "GET",
				resourceType: "fetch",
				samePage: true,
				mainFrame: true,
				redirected: false,
				start: 2,
				failure: 3,
				error: "net::ERR_CONNECTION_REFUSED",
			},
			{
				url,
				method: "GET",
				resourceType: "fetch",
				samePage: true,
				mainFrame: true,
				redirected: false,
				start: 6,
				failure: null,
				error: null,
			},
		],
		console: [{ index: 0, at: 4, type: "error", text, url, samePage: true }],
	};
	return observation.facts.restartAuthentication;
}

test("independently attributes one restart bootstrap refusal while preserving raw errors", () => {
	const rawArtifacts = validResults().flatMap(rawFor);
	const observation = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-gateway-restart")
		.value.observation;
	const evidence = authenticationFixture(observation);
	assert.equal(
		expectedRestartAuthenticationError(
			evidence,
			observation.facts.lifecycle.originBefore,
			observation.browserErrors.console,
		),
		0,
	);
	assert.deepEqual(validate({ rawArtifacts }).errors, []);
	assert.equal(observation.browserErrors.console.length, 1);
});

test("restart authentication attribution fails closed for adversarial evidence", () => {
	const cases = [
		[
			"another resource same text",
			(e) => {
				e.console[0].url += "/other";
			},
		],
		[
			"403",
			(e) => {
				e.requests[0].error = "net::ERR_HTTP_RESPONSE_CODE_FAILURE";
			},
		],
		[
			"wrong path",
			(e) => {
				e.requests[0].url += "/other";
			},
		],
		[
			"wrong port",
			(e) => {
				e.requests[0].url = "http://127.0.0.1:1/api/v1/bootstrap";
			},
		],
		[
			"query",
			(e) => {
				e.requests[0].url += "?x=1";
			},
		],
		[
			"redirect",
			(e) => {
				e.requests[0].redirected = true;
			},
		],
		[
			"method",
			(e) => {
				e.requests[0].method = "POST";
			},
		],
		[
			"resource type",
			(e) => {
				e.requests[0].resourceType = "document";
			},
		],
		[
			"wrong error",
			(e) => {
				e.requests[0].error = "net::ERR_FAILED";
			},
		],
		[
			"wrong page",
			(e) => {
				e.requests[0].samePage = false;
			},
		],
		[
			"wrong frame",
			(e) => {
				e.requests[0].mainFrame = false;
			},
		],
		[
			"wrong console page",
			(e) => {
				e.console[0].samePage = false;
			},
		],
		[
			"console type",
			(e) => {
				e.console[0].type = "warning";
			},
		],
		[
			"empty location",
			(e) => {
				e.console[0].url = "";
			},
		],
		[
			"pre-arm request",
			(e) => {
				e.requests[0].start = 0;
			},
		],
		[
			"post-seal failure",
			(e) => {
				e.requests[0].failure = 7;
			},
		],
		[
			"post-seal console",
			(e) => {
				e.console[0].at = 8;
			},
		],
		[
			"missing request",
			(e) => {
				e.requests.shift();
			},
		],
		[
			"missing console",
			(e) => {
				e.console = [];
			},
		],
		[
			"duplicate request",
			(e) => {
				e.requests.push({ ...e.requests[0] });
			},
		],
		[
			"duplicate console",
			(e, o) => {
				e.console.push({ ...e.console[0], index: 1 });
				o.browserErrors.console.push(e.console[0].text);
			},
		],
		[
			"concurrent request",
			(e) => {
				e.seal = 10;
				e.requests.push({ ...e.requests[0], start: 7, failure: 8 });
			},
		],
		[
			"overflow",
			(e) => {
				e.invalid = true;
			},
		],
		[
			"missing evidence",
			(_, o) => {
				delete o.facts.restartAuthentication;
			},
		],
	];
	for (const [label, mutate] of cases) {
		const rawArtifacts = validResults().flatMap(rawFor);
		const observation = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-gateway-restart")
			.value.observation;
		const evidence = authenticationFixture(observation);
		mutate(evidence, observation);
		assert.equal(
			expectedRestartAuthenticationError(
				observation.facts.restartAuthentication ?? null,
				observation.facts.lifecycle.originBefore,
				observation.browserErrors.console,
			),
			null,
			label,
		);
		assert.match(errorText(validate({ rawArtifacts })), /browserErrors/, label);
	}
	const rawArtifacts = validResults().flatMap(rawFor);
	const observation = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-gateway-restart")
		.value.observation;
	authenticationFixture(observation);
	observation.browserErrors.page.push("page error");
	assert.match(errorText(validate({ rawArtifacts })), /gate browserErrors\.value actual must be 1/);
});

test("validates restart attribution fields independently of the error gate", () => {
	for (const mutate of [
		(e) => {
			delete e.arm;
		},
		(e) => {
			e.seal = "5";
		},
		(e) => {
			e.requests[0].samePage = "true";
		},
		(e) => {
			e.requests[0].extra = true;
		},
		(e) => {
			e.requests[0].failure = e.requests[0].start;
		},
		(e) => {
			e.requests[1].error = "unpaired failure";
		},
		(e) => {
			e.console.push({ index: 1, at: 4, type: "error", text: "", url: "", samePage: true });
		},
	]) {
		const rawArtifacts = validResults().flatMap(rawFor);
		const observation = rawArtifacts.find((artifact) => artifact.value.kind === "recovery-gateway-restart")
			.value.observation;
		const evidence = authenticationFixture(observation);
		observation.browserErrors.console = [];
		evidence.console = [];
		mutate(evidence);
		assert.match(errorText(validate({ rawArtifacts })), /restartAuthentication has invalid public-API facts/);
	}
});
