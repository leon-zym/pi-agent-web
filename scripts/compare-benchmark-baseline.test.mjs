import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	loadReferenceArchive,
	referenceSet,
	unpackReferenceArchive,
} from "./benchmark-reference-evidence.mjs";
import { compareBenchmarkBaseline, generateComparisonMarkdown } from "./compare-benchmark-baseline.mjs";
import {
	benchmarkMetricPolicy,
	canonicalFormalExpectedScenarioSet,
	loadBenchmarkMatrix,
} from "./performance-benchmark-validator.mjs";

function fixture(tier = "representative") {
	const expected = canonicalFormalExpectedScenarioSet(loadBenchmarkMatrix(), tier);
	const results = expected.map((entry) => ({
		domain: entry.domain,
		scenarioId: entry.id,
		variant: entry.variant,
		status: "passed",
		errors: [],
		parameters: { fixture: "same" },
		gates: [{ mode: "hard", passed: true }],
		trials: Array.from({ length: entry.warmups + entry.measured }, (_, index) => ({
			index,
			warmup: index < entry.warmups,
			correctness: { complete: true },
			metrics: {
				aggregateDeltaPerSecond: 100,
				streamingDomMutationPerDeltaRatio: 0.1,
				recoveryMs: 100,
				browserErrors: 0,
			},
		})),
		summaries: Object.fromEntries(
			Object.entries({
				aggregateDeltaPerSecond: 100,
				streamingDomMutationPerDeltaRatio: 0.1,
				recoveryMs: 100,
				browserErrors: 0,
			}).map(([key, value]) => [
				key,
				{ count: entry.measured, min: value, max: value, median: value, p95: value },
			]),
		),
	}));
	return {
		benchmark: {
			schemaVersion: 2,
			suiteVersion: 6,
			runId: "fixture",
			tier,
			results,
			validationErrors: [],
			playwrightExitCode: 0,
		},
		manifest: {
			runId: "fixture",
			expectedScenarioSet: expected,
			matrix: { rootHash: "a" },
			fixtureHashes: { fixture: "b" },
			lockfileHash: "c",
			seed: "fixed",
			warmupCounts: { fixture: 1 },
			measuredCounts: { fixture: 3 },
		},
		environment: {
			runId: "fixture",
			os: "linux",
			kernel: "kernel",
			architecture: "x64",
			cpu: { model: "cpu A", logicalCount: 4 },
			quota: { cpu: "4", memoryBytes: 1024 },
			memory: { totalBytes: 1024 },
			image: "image-1",
			node: "v22",
			pnpm: "11.21.0",
			playwright: "1.62.1",
			chromium: "151",
		},
	};
}
function metric(bundle, name, value) {
	const result = bundle.benchmark.results[0];
	for (const trial of result.trials) trial.metrics[name] = value;
	result.summaries[name] = {
		count: result.trials.filter((trial) => !trial.warmup).length,
		min: value,
		max: value,
		median: value,
		p95: value,
	};
}

test("complete comparable evidence is OK and includes units and direction", () => {
	const result = compareBenchmarkBaseline(fixture(), fixture());
	assert.equal(result.status, "OK");
	assert.ok(result.metrics.length > 0);
	assert.match(generateComparisonMarkdown(result), /Status: OK/);
	assert.equal(result.metrics.find((m) => m.name === "aggregateDeltaPerSecond").direction, "higher");
	assert.equal(
		result.metrics.some((m) => m.name === "browserErrors"),
		false,
	);
});

for (const [name, mutate] of Object.entries({
	empty: (b) => {
		b.benchmark.results = [];
	},
	missingScenario: (b) => {
		b.benchmark.results.pop();
	},
	duplicateScenario: (b) => {
		b.benchmark.results.push(b.benchmark.results[0]);
	},
	missingMetric: (b) => {
		delete b.benchmark.results[0].summaries.streamingDomMutationPerDeltaRatio;
	},
	missingBothTrialAndSummary: (b) => {
		const r = b.benchmark.results[0];
		delete r.summaries.streamingDomMutationPerDeltaRatio;
		for (const t of r.trials) delete t.metrics.streamingDomMutationPerDeltaRatio;
	},
	emptyMetrics: (b) => {
		b.benchmark.results[0].summaries = {};
	},
	nan: (b) => metric(b, "streamingDomMutationPerDeltaRatio", Number.NaN),
	infinity: (b) => metric(b, "streamingDomMutationPerDeltaRatio", Number.POSITIVE_INFINITY),
	failedValidation: (b) => {
		b.benchmark.validationErrors = ["failed"];
	},
	failedCorrectness: (b) => {
		b.benchmark.results[0].trials[0].correctness.complete = false;
	},
	failedGate: (b) => {
		b.benchmark.results[0].gates[0].passed = false;
	},
	zeroSamples: (b) => {
		b.benchmark.results[0].trials = [];
	},
}))
	test(`${name} evidence is INVALID, never green`, () => {
		const target = fixture();
		mutate(target);
		const result = compareBenchmarkBaseline(target, fixture());
		assert.equal(result.status, "INVALID");
		assert.ok(result.errors.length);
		assert.match(generateComparisonMarkdown(result), /Status: INVALID/);
	});

test("throughput increases are OK; decreases regress", () => {
	const target = fixture();
	metric(target, "aggregateDeltaPerSecond", 200);
	assert.equal(compareBenchmarkBaseline(target, fixture()).status, "OK");
	metric(target, "aggregateDeltaPerSecond", 60);
	assert.equal(compareBenchmarkBaseline(target, fixture()).status, "REGRESSION");
});

test("long tasks over 50 ms are counts without a timing floor", () => {
	assert.deepEqual(benchmarkMetricPolicy("liveLongTasksOver50Ms"), {
		mode: "observe",
		unit: "count",
		direction: "lower",
		floor: 0,
	});
	const reference = fixture();
	const target = fixture();
	metric(reference, "liveLongTasksOver50Ms", 0);
	metric(target, "liveLongTasksOver50Ms", 1);
	const result = compareBenchmarkBaseline(target, reference);
	assert.equal(result.status, "REGRESSION");
	const count = result.metrics.find((entry) => entry.name === "liveLongTasksOver50Ms");
	assert.equal(count.unit, "count");
	assert.equal(count.threshold, 0);
	assert.equal(benchmarkMetricPolicy("liveLongTaskMaxMs").unit, "ms");
	assert.equal(benchmarkMetricPolicy("liveLongTaskMaxMs").floor, 50);
});

test("ratio has no +50 floor; timing keeps its millisecond floor", () => {
	const target = fixture();
	metric(target, "streamingDomMutationPerDeltaRatio", 0.2);
	const result = compareBenchmarkBaseline(target, fixture());
	assert.equal(result.status, "REGRESSION");
	assert.ok(
		Math.abs(result.metrics.find((m) => m.name === "streamingDomMutationPerDeltaRatio").threshold - 0.15) <
			1e-10,
	);
	metric(target, "streamingDomMutationPerDeltaRatio", 0.1);
	metric(target, "recoveryMs", 200);
	assert.equal(compareBenchmarkBaseline(target, fixture()).status, "OK");
	metric(target, "recoveryMs", 201);
	assert.equal(compareBenchmarkBaseline(target, fixture()).status, "REGRESSION");
});

for (const [name, mutate] of Object.entries({
	platform: (b) => {
		b.environment.os = "darwin";
	},
	cpu: (b) => {
		b.environment.cpu.model = "cpu B";
	},
	image: (b) => {
		b.environment.image = "image-2";
	},
	toolchain: (b) => {
		b.environment.chromium = "152";
	},
	fixture: (b) => {
		b.manifest.fixtureHashes.fixture = "changed";
	},
	parameters: (b) => {
		b.benchmark.results[0].parameters.fixture = "changed";
	},
	missingMetadata: (b) => {
		delete b.environment.cpu;
	},
}))
	test(`${name} mismatch is INCOMPATIBLE without applying budgets`, () => {
		const target = fixture();
		mutate(target);
		const result = compareBenchmarkBaseline(target, fixture());
		assert.equal(result.status, "INCOMPATIBLE");
		assert.equal(result.metrics.length, 0);
	});

test("historical calibration remains incompatible, not silently recalibrated", () => {
	assert.equal(compareBenchmarkBaseline(fixture(), { scenarios: { old: {} } }).status, "INCOMPATIBLE");
	assert.equal(compareBenchmarkBaseline({}, { scenarios: {} }).status, "INVALID");
});

test("CLI invalid input fails while help succeeds", () => {
	const cli = "scripts/compare-benchmark-baseline.mjs";
	assert.equal(spawnSync(process.execPath, [cli, "--help"]).status, 0);
	const invalid = spawnSync(
		process.execPath,
		[cli, "/missing/benchmark.json", "--baseline", "/missing/baseline.json"],
		{ encoding: "utf8" },
	);
	assert.equal(invalid.status, 1);
	assert.match(invalid.stderr, /INVALID/);
});

test("CLI compares complete artifact directories and enforces provenance hashes", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-comparison-test-"));
	const write = (name, bundle) => {
		const target = path.join(directory, name);
		fs.mkdirSync(target, { recursive: true });
		for (const field of ["manifest", "environment"]) {
			const text = `${JSON.stringify(bundle[field])}\n`;
			fs.writeFileSync(path.join(target, `${field}.json`), text);
			bundle.benchmark[`${field}Hash`] = createHash("sha256").update(text).digest("hex");
		}
		fs.writeFileSync(path.join(target, "benchmark.json"), JSON.stringify(bundle.benchmark));
		return target;
	};
	try {
		const baseline = write("baseline", fixture());
		const bundle = fixture();
		bundle.benchmark.runId = bundle.manifest.runId = bundle.environment.runId = "second-run";
		const target = write("target", bundle);
		const compare = () =>
			spawnSync(
				process.execPath,
				["scripts/compare-benchmark-baseline.mjs", target, "--baseline", baseline],
				{ encoding: "utf8" },
			);
		let result = compare();
		assert.equal(result.status, 0);
		assert.match(result.stdout, /Status: OK/);
		metric(bundle, "aggregateDeltaPerSecond", 1);
		write("target", bundle);
		result = compare();
		assert.equal(result.status, 0);
		assert.match(result.stdout, /Status: REGRESSION/);
		bundle.environment.cpu.model = "different CPU";
		write("target", bundle);
		result = compare();
		assert.equal(result.status, 2);
		assert.match(result.stdout, /Status: INCOMPATIBLE/);
		fs.appendFileSync(path.join(target, "environment.json"), " ");
		result = compare();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /hashes do not match/);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("different complete tiers are incompatible without dereferencing missing scenarios", () => {
	assert.equal(compareBenchmarkBaseline(fixture("stress"), fixture()).status, "INCOMPATIBLE");
	assert.equal(compareBenchmarkBaseline(fixture(), { scenarios: {} }).status, "INVALID");
});

function darwinFixture() {
	const bundle = fixture();
	Object.assign(bundle.environment, {
		os: "darwin",
		kernel: "25.0.0",
		architecture: "arm64",
		cpu: { model: "Apple M4", logicalCount: 10 },
		quota: { cpu: "unavailable", memoryBytes: 17179869184 },
		memory: { totalBytes: 17179869184 },
		image: "local-host-v1",
	});
	return bundle;
}

test("Darwin producer quota is inapplicable, while unknown Linux quota still rejects", () => {
	assert.equal(compareBenchmarkBaseline(darwinFixture(), darwinFixture()).status, "OK");
	const linux = fixture();
	linux.environment.quota.cpu = "unavailable";
	assert.equal(compareBenchmarkBaseline(linux, linux).status, "INCOMPATIBLE");
	const missing = darwinFixture();
	delete missing.environment.quota.cpu;
	assert.equal(compareBenchmarkBaseline(missing, missing).status, "INCOMPATIBLE");
	const changed = darwinFixture();
	changed.environment.cpu.model = "Apple M3";
	assert.equal(compareBenchmarkBaseline(changed, darwinFixture()).status, "INCOMPATIBLE");
});

for (const [name, mutate] of Object.entries({
	missingWarmup: (trials) => {
		trials.shift();
	},
	failedWarmup: (trials) => {
		trials[0].correctness.complete = false;
	},
	failedWarmupClaim: (trials) => {
		trials[0].correctness.noLostEvents = false;
	},
	extraWarmup: (trials) => {
		trials.push({ ...trials[0] });
	},
	duplicateIndex: (trials) => {
		trials[1].index = 0;
	},
	wrongWarmupFlag: (trials) => {
		trials[0].warmup = false;
	},
	malformedTrial: (trials) => {
		trials[0] = null;
	},
}))
	test(`${name} invalidates the complete trial envelope`, () => {
		const bundle = fixture();
		mutate(bundle.benchmark.results[0].trials);
		assert.equal(compareBenchmarkBaseline(bundle, fixture()).status, "INVALID");
	});

test("warmup measurements do not enter measured summaries", () => {
	const bundle = fixture();
	bundle.benchmark.results[0].trials[0].metrics.recoveryMs = 99999;
	assert.equal(compareBenchmarkBaseline(bundle, fixture()).status, "OK");
});

test("unknown Linux memory quota cannot be compared even with known CPU quota", () => {
	const bundle = fixture();
	bundle.environment.quota = { cpu: "unlimited", memoryBytes: "unavailable" };
	assert.equal(compareBenchmarkBaseline(bundle, structuredClone(bundle)).status, "INCOMPATIBLE");
});

test("active reference descriptors and archive integrity fail closed", (t) => {
	const pending = {
		policy: "completion-median-v1",
		actions: { status: "pending" },
		local: { status: "pending" },
	};
	assert.equal(referenceSet(pending, "actions").status, "pending");
	const active = {
		status: "active",
		source: "c".repeat(40),
		artifactId: 123,
		sha256: "a".repeat(64),
		reference1: "ref1",
		reference2: "ref2",
	};
	for (const mutate of [
		(set) => delete set.sha256,
		(set) => (set.reference2 = "ref1"),
		(set) => (set.status = "pending"),
		(set) => (set.artifactId = 0),
	]) {
		const description = structuredClone(pending);
		description.actions = structuredClone(active);
		mutate(description.actions);
		assert.throws(() => referenceSet(description, "actions"), /invalid active/);
	}
	assert.throws(() => unpackReferenceArchive(Buffer.from("bad"), active.sha256), /digest/);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "reference-archive-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const zip = path.join(root, "unsafe.zip");
	execFileSync("python3", [
		"-c",
		"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../escape','unsafe'); z.close()",
		zip,
	]);
	const bytes = fs.readFileSync(zip);
	assert.throws(
		() => unpackReferenceArchive(bytes, createHash("sha256").update(bytes).digest("hex")),
		/unsafe reference archive/,
	);
});

test("expired activated Actions artifacts are setup failures before archive download", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "expired-reference-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const gh = path.join(root, "gh");
	fs.writeFileSync(
		gh,
		`#!/bin/sh
printf '%s\\n' '{"id":123,"expired":true,"size_in_bytes":10,"expires_at":"2000-01-01T00:00:00Z"}'
`,
	);
	fs.chmodSync(gh, 0o755);
	const previousPath = process.env.PATH,
		previousRepo = process.env.GITHUB_REPOSITORY;
	process.env.PATH = `${root}:${previousPath}`;
	process.env.GITHUB_REPOSITORY = "fixture/repository";
	try {
		assert.throws(() => loadReferenceArchive({ artifactId: 123 }, "actions"), /expired/);
	} finally {
		process.env.PATH = previousPath;
		if (previousRepo === undefined) delete process.env.GITHUB_REPOSITORY;
		else process.env.GITHUB_REPOSITORY = previousRepo;
	}
});
