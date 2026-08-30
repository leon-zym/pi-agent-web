import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBenchmarkArtifacts } from "./performance-benchmark-validator.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const matrixPath = path.join(repositoryRoot, "tests/e2e/benchmarks/matrix.json");
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const tier = process.argv[2];
const skipBuild = process.argv.includes("--skip-build");

if (tier !== "representative" && tier !== "stress") {
	process.stderr.write(
		"usage: node scripts/run-performance-benchmarks.mjs <representative|stress> [--skip-build]\n",
	);
	process.exit(2);
}

const artifactDirectory = path.join(repositoryRoot, "test-results", "performance", tier);
const rawDirectory = path.join(artifactDirectory, "raw");
fs.rmSync(artifactDirectory, { recursive: true, force: true });
fs.mkdirSync(rawDirectory, { recursive: true });

function run(command, args, extraEnvironment = {}) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		stdio: "inherit",
		env: { ...process.env, ...extraEnvironment },
	});
	if (result.error) throw result.error;
	return result.status ?? 1;
}

function commandOutput(command, args, fallback = "unknown") {
	try {
		return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
	} catch {
		return fallback;
	}
}

if (!skipBuild) {
	const buildStatus = run("pnpm", ["build"]);
	if (buildStatus !== 0) process.exit(buildStatus);
}

const benchmarkEnvironment = {
	PI_WEB_BENCHMARK_TIER: tier,
	PI_WEB_BENCHMARK_ARTIFACT_DIR: artifactDirectory,
	PI_WEB_BENCHMARK_RAW_DIR: rawDirectory,
};
const playwrightStatus = run(
	"pnpm",
	["exec", "playwright", "test", "--config", "tests/e2e/benchmarks/playwright.config.ts"],
	benchmarkEnvironment,
);

const expectedScenarios = matrix.tiers[tier].scenarios;
const parseErrors = [];
const artifacts = [];
for (const entry of fs.readdirSync(rawDirectory, { withFileTypes: true })) {
	if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
	const resultPath = path.join(rawDirectory, entry.name);
	try {
		artifacts.push({ name: entry.name, value: JSON.parse(fs.readFileSync(resultPath, "utf8")) });
	} catch (error) {
		parseErrors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
const validated = validateBenchmarkArtifacts({ matrix, tier, artifacts });
const validationErrors = [...parseErrors, ...validated.errors];
const results = validated.results;

const commit = commandOutput("git", ["rev-parse", "HEAD"]);
const dirty = commandOutput("git", ["status", "--porcelain"], "") !== "";
const cpus = os.cpus();
const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	tier,
	commit,
	dirty,
	environment: {
		platform: os.platform(),
		release: os.release(),
		architecture: os.arch(),
		cpuModel: cpus[0]?.model ?? "unknown",
		logicalCpuCount: cpus.length,
		totalMemoryBytes: os.totalmem(),
		node: process.version,
		playwright: commandOutput("pnpm", ["exec", "playwright", "--version"]),
		chromium: results[0]?.browserVersion ?? "unknown",
	},
	workload: expectedScenarios,
	knownCoverageGaps: matrix.knownCoverageGaps,
	playwrightExitCode: playwrightStatus,
	validationErrors,
	results,
};

function number(value) {
	return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function markdownFor(value) {
	const lines = [
		`# Performance benchmark — ${value.tier}`,
		"",
		`- Commit: \`${value.commit}\`${value.dirty ? " (dirty worktree)" : ""}`,
		`- Generated: ${value.generatedAt}`,
		`- Environment: ${value.environment.platform} ${value.environment.release}, ${value.environment.cpuModel}, Node ${value.environment.node}, Chromium ${value.environment.chromium}`,
		`- Playwright exit: ${String(value.playwrightExitCode)}`,
		"",
		"| Scenario | Status | Samples | Selected p95 metrics | Hard gates |",
		"| --- | --- | ---: | --- | --- |",
	];
	for (const result of value.results) {
		const sampleCount = result.trials.filter((trial) => !trial.warmup).length;
		const metrics = Object.entries(result.summaries)
			.filter(([name]) =>
				[
					"inputToNextPaintMs",
					"settlementMs",
					"totalCompletionMs",
					"heapDeltaBytes",
					"recoveryMs",
					"firstPageMs",
					"nextPageMs",
					"maxProgressGapMs",
				].includes(name),
			)
			.map(([name, summary]) => `${name}=${number(summary.p95)}`)
			.join("<br>");
		const hardGates = result.gates.filter((gate) => gate.mode === "hard");
		const passed = hardGates.filter((gate) => gate.passed === true).length;
		lines.push(
			`| ${result.scenarioId} | ${result.status} | ${String(sampleCount)} | ${metrics || "—"} | ${String(passed)}/${String(hardGates.length)} |`,
		);
	}
	lines.push("", "## Validation", "");
	if (value.validationErrors.length === 0) lines.push("Artifact set is complete and schema-valid.");
	else for (const error of value.validationErrors) lines.push(`- ${error}`);
	lines.push("", "## Known coverage gaps", "");
	for (const gap of value.knownCoverageGaps) lines.push(`- ${gap}`);
	lines.push("");
	return `${lines.join("\n")}\n`;
}

const jsonPath = path.join(artifactDirectory, "benchmark.json");
const markdownPath = path.join(artifactDirectory, "benchmark.md");
fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
fs.writeFileSync(markdownPath, markdownFor(report), "utf8");
process.stdout.write(`benchmark JSON: ${path.relative(repositoryRoot, jsonPath)}\n`);
process.stdout.write(`benchmark summary: ${path.relative(repositoryRoot, markdownPath)}\n`);

const failedResults = results.filter((result) => result.status !== "passed");
if (playwrightStatus !== 0 || validationErrors.length > 0 || failedResults.length > 0) process.exit(1);
