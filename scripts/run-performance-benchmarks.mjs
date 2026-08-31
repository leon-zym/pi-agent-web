import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	BENCHMARK_SCHEMA_VERSION,
	BENCHMARK_SUITE_VERSION,
	loadBenchmarkMatrix,
	validateBenchmarkArtifacts,
} from "./performance-benchmark-validator.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const matrixPath = path.join(repositoryRoot, "tests/e2e/benchmarks/matrix.json");
const artifactRoot = path.join(repositoryRoot, "test-results", "performance");
const fixturePaths = [
	"tests/e2e/fixtures/deterministic-pi.mjs",
	"tests/e2e/fixtures/page-observation.ts",
	"tests/e2e/fixtures/production-harness.ts",
	"tests/e2e/fixtures/test.ts",
];
const buildOutputPaths = ["packages/cli/dist", "packages/server/dist", "packages/ui/dist"];
const allowedVariants = new Set(["coalesced", "sequential"]);

function usage() {
	return "usage: node scripts/run-performance-benchmarks.mjs <representative|stress>";
}

function validTier(value) {
	return value === "representative" || value === "stress";
}

function validRunId(value) {
	return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
}

function defaultRunId() {
	return `${new Date().toISOString().replaceAll(/[:.]/g, "").toLowerCase()}-p${String(process.pid)}-${randomUUID().slice(0, 8)}`;
}

function variantsForRun(value) {
	const variants = (value ?? "coalesced")
		.split(",")
		.map((variant) => variant.trim())
		.filter(Boolean);
	if (variants.length === 0 || variants.some((variant) => !allowedVariants.has(variant))) {
		throw new Error("PI_WEB_BENCHMARK_VARIANTS must be a comma-separated list of coalesced and sequential");
	}
	if (new Set(variants).size !== variants.length) {
		throw new Error("PI_WEB_BENCHMARK_VARIANTS must not repeat a build variant");
	}
	return variants;
}

function commandOutput(command, args, fallback = "unavailable") {
	try {
		return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8" }).trim() || fallback;
	} catch {
		return fallback;
	}
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function hashFile(filePath) {
	return sha256(fs.readFileSync(filePath));
}

function hashTree(directory) {
	if (!fs.existsSync(directory))
		throw new Error(`Build output is missing: ${path.relative(repositoryRoot, directory)}`);
	const files = [];
	const visit = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else if (entry.isFile()) files.push(entryPath);
		}
	};
	visit(directory);
	const hash = createHash("sha256");
	for (const filePath of files.sort((left, right) => left.localeCompare(right))) {
		hash.update(path.relative(directory, filePath).replaceAll(path.sep, "/"));
		hash.update("\0");
		hash.update(hashFile(filePath));
		hash.update("\n");
	}
	return hash.digest("hex");
}

function combinedBuildHash() {
	const hash = createHash("sha256");
	for (const relativePath of buildOutputPaths) {
		const directory = path.join(repositoryRoot, relativePath);
		hash.update(relativePath);
		hash.update("\0");
		hash.update(hashTree(directory));
		hash.update("\n");
	}
	return hash.digest("hex");
}

function fixtureHashes() {
	const hashes = {};
	for (const relativePath of fixturePaths) {
		hashes[relativePath] = hashFile(path.join(repositoryRoot, relativePath));
	}
	return hashes;
}

function cgroupValue(relativePath) {
	if (process.platform !== "linux") return undefined;
	try {
		return fs.readFileSync(path.join("/sys/fs/cgroup", relativePath), "utf8").trim();
	} catch {
		return undefined;
	}
}

function cpuQuota() {
	const value = cgroupValue("cpu.max");
	if (!value) return "unavailable";
	const [quota, period] = value.split(/\s+/, 2);
	if (!quota || quota === "max") return "unlimited";
	return period ? `${quota}/${period}` : quota;
}

function memoryQuota() {
	const value = cgroupValue("memory.max");
	if (!value || value === "max") return os.totalmem();
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : os.totalmem();
}

function environmentForRun(runId, chromium = "unavailable") {
	const cpus = os.cpus();
	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		suiteVersion: BENCHMARK_SUITE_VERSION,
		runId,
		os: os.platform(),
		kernel: os.release(),
		architecture: os.arch(),
		cpu: {
			model: cpus[0]?.model ?? "unavailable",
			logicalCount: Math.max(1, os.availableParallelism()),
		},
		quota: { cpu: cpuQuota(), memoryBytes: memoryQuota() },
		memory: { totalBytes: os.totalmem() },
		image:
			process.env.PI_WEB_BENCHMARK_IMAGE ??
			process.env.GITHUB_IMAGE ??
			process.env.ImageOS ??
			process.env.RUNNER_IMAGE ??
			"unavailable",
		node: process.version,
		pnpm: commandOutput("pnpm", ["--version"]),
		playwright: commandOutput("pnpm", ["exec", "playwright", "--version"]),
		chromium,
		referenceProfile: process.env.PI_WEB_BENCHMARK_REFERENCE_PROFILE ?? "unprofiled",
	};
}

function writeJson(filePath, value) {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runCommand(label, command, args, extraEnvironment, logDirectory) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: { ...process.env, ...extraEnvironment },
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	const failure = result.error
		? `${result.error instanceof Error ? (result.error.stack ?? result.error.message) : String(result.error)}\n`
		: "";
	fs.writeFileSync(path.join(logDirectory, `${label}.stdout.log`), stdout, "utf8");
	fs.writeFileSync(path.join(logDirectory, `${label}.stderr.log`), `${stderr}${failure}`, "utf8");
	if (stdout) process.stdout.write(stdout);
	if (stderr) process.stderr.write(stderr);
	if (result.error) process.stderr.write(failure);
	return result.status ?? 1;
}

function jsonFiles(directory) {
	const files = [];
	const visit = (current) => {
		if (!fs.existsSync(current)) return;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else if (entry.isFile() && entry.name.endsWith(".json")) files.push(entryPath);
		}
	};
	visit(directory);
	return files.sort((left, right) => left.localeCompare(right));
}

function collectRawArtifacts(rawDirectory) {
	const parseErrors = [];
	const artifacts = [];
	const rawArtifacts = [];
	for (const filePath of jsonFiles(rawDirectory)) {
		const name = path.relative(rawDirectory, filePath).replaceAll(path.sep, "/");
		try {
			const value = readJson(filePath);
			if (name.endsWith(".result.json")) artifacts.push({ name, value });
			else rawArtifacts.push({ name, value });
		} catch (error) {
			parseErrors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { artifacts, parseErrors, rawArtifacts };
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function expectedScenarioSet(matrix, tier, variants) {
	const scenarios = matrix.tiers[tier]?.scenarios;
	if (!Array.isArray(scenarios)) throw new Error(`Matrix tier ${tier} is unavailable`);
	return variants.flatMap((variant) =>
		scenarios.map((scenario) => ({
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

function countsFor(expected, field) {
	return Object.fromEntries(
		expected.map((entry) => [`${entry.domain}/${entry.id}/${entry.variant}`, entry[field]]),
	);
}

function capabilitiesFor(expected, artifacts) {
	const values = Object.fromEntries(
		[...new Set(expected.flatMap((entry) => entry.requiredCapabilities))]
			.sort()
			.map((capability) => [capability, true]),
	);
	for (const artifact of artifacts) {
		if (artifact?.value?.capabilities === undefined) continue;
		for (const capability of Object.keys(values)) {
			if (artifact.value.capabilities[capability] !== true) values[capability] = false;
		}
	}
	return values;
}

function reportMarkdown(report, manifest) {
	const lines = [
		`# Performance benchmark — ${report.tier}`,
		"",
		`- Run: \`${report.runId}\``,
		`- Commit: \`${manifest.source.commit}\`${manifest.source.dirty ? " (dirty worktree)" : ""}`,
		`- Seed: \`${manifest.seed}\``,
		`- Variants: ${Object.keys(manifest.buildVariants).join(", ")}`,
		`- Playwright exit: ${String(report.playwrightExitCode)}`,
		"",
		"| Domain | Scenario | Variant | Status | Measured samples |",
		"| --- | --- | --- | --- | ---: |",
	];
	for (const result of report.results) {
		const samples = result.trials.filter((trial) => trial.warmup === false).length;
		lines.push(
			`| ${result.domain} | ${result.scenarioId} | ${result.variant} | ${result.status} | ${String(samples)} |`,
		);
	}
	lines.push(
		"",
		"> This validated artifact documents the declared incomplete Phase 1 matrix. It does not close Issue #28 or establish a reference baseline.",
		"",
	);
	return lines.join("\n");
}

function main() {
	const tier = process.argv[2];
	if (!validTier(tier)) {
		process.stderr.write(`${usage()}\n`);
		process.exitCode = 2;
		return;
	}
	const runId = process.env.PI_WEB_BENCHMARK_RUN_ID ?? defaultRunId();
	if (!validRunId(runId)) {
		process.stderr.write("PI_WEB_BENCHMARK_RUN_ID must be a safe artifact directory name\n");
		process.exitCode = 2;
		return;
	}
	let variants;
	try {
		variants = variantsForRun(process.env.PI_WEB_BENCHMARK_VARIANTS);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
		return;
	}

	const runDirectory = path.join(artifactRoot, tier, runId);
	try {
		fs.mkdirSync(runDirectory, { recursive: false });
	} catch (error) {
		if (isRecord(error) && error.code === "EEXIST") {
			process.stderr.write(
				`Refusing to overwrite existing benchmark run: ${path.relative(repositoryRoot, runDirectory)}\n`,
			);
			process.exitCode = 2;
			return;
		}
		throw error;
	}
	const rawDirectory = path.join(runDirectory, "raw");
	const logsDirectory = path.join(runDirectory, "logs");
	const playwrightDirectory = path.join(runDirectory, "playwright");
	fs.mkdirSync(rawDirectory, { recursive: true });
	fs.mkdirSync(logsDirectory, { recursive: true });
	fs.mkdirSync(playwrightDirectory, { recursive: true });

	let matrix;
	try {
		matrix = loadBenchmarkMatrix(matrixPath);
	} catch (error) {
		const errors = [error instanceof Error ? (error.stack ?? error.message) : String(error)];
		fs.writeFileSync(path.join(logsDirectory, "matrix-load.error.log"), `${errors.join("\n")}\n`, "utf8");
		writeJson(path.join(logsDirectory, "validation.json"), { errors, runId, tier });
		process.stderr.write(`${errors[0]}\n`);
		process.exitCode = 1;
		return;
	}

	const expected = expectedScenarioSet(matrix, tier, variants);
	const source = {
		commit: commandOutput("git", ["rev-parse", "HEAD"]),
		dirty: commandOutput("git", ["status", "--porcelain"], "") !== "",
	};
	const manifest = {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		suiteVersion: BENCHMARK_SUITE_VERSION,
		tier,
		runId,
		seed: process.env.PI_WEB_BENCHMARK_SEED ?? "pi-agent-web-benchmark-v2",
		source,
		matrix: matrix.provenance,
		fixtureHashes: fixtureHashes(),
		lockfileHash: hashFile(path.join(repositoryRoot, "pnpm-lock.yaml")),
		buildVariants: Object.fromEntries(variants.map((variant) => [variant, sha256(`pending:${variant}`)])),
		warmupCounts: countsFor(expected, "warmups"),
		measuredCounts: countsFor(expected, "measured"),
		capabilities: capabilitiesFor(expected, []),
		expectedScenarioSet: expected,
	};
	writeJson(path.join(runDirectory, "manifest.json"), manifest);
	writeJson(path.join(runDirectory, "environment.json"), environmentForRun(runId));

	const statuses = [];
	for (const variant of variants) {
		const benchmarkEnvironment = {
			PI_WEB_BENCHMARK_BUILD: "1",
			PI_WEB_BENCHMARK_RUN_ID: runId,
			PI_WEB_BENCHMARK_SEED: manifest.seed,
			PI_WEB_BENCHMARK_TIER: tier,
			PI_WEB_BENCHMARK_VARIANT: variant,
			PI_WEB_BENCHMARK_ARTIFACT_DIR: runDirectory,
			PI_WEB_BENCHMARK_RAW_DIR: rawDirectory,
			PI_WEB_BENCHMARK_PLAYWRIGHT_DIR: path.join(playwrightDirectory, variant),
			VITE_PI_WEB_BENCHMARK_BUILD: "1",
			VITE_PI_WEB_BENCHMARK_VARIANT: variant,
		};
		const buildStatus = runCommand(
			`build-${variant}`,
			"pnpm",
			["build"],
			benchmarkEnvironment,
			logsDirectory,
		);
		statuses.push({ variant, buildStatus });
		if (buildStatus !== 0) continue;
		try {
			manifest.buildVariants[variant] = combinedBuildHash();
		} catch (error) {
			statuses.push({ variant, buildHashError: error instanceof Error ? error.message : String(error) });
			continue;
		}
		const playwrightStatus = runCommand(
			`playwright-${variant}`,
			"pnpm",
			["exec", "playwright", "test", "--config", "tests/e2e/benchmarks/playwright.config.ts"],
			benchmarkEnvironment,
			logsDirectory,
		);
		statuses.push({ variant, playwrightStatus });
	}

	const { artifacts, parseErrors, rawArtifacts } = collectRawArtifacts(rawDirectory);
	const browserVersions = [
		...new Set(
			artifacts
				.map((artifact) => artifact.value?.browserVersion)
				.filter((value) => typeof value === "string"),
		),
	];
	const chromium = browserVersions.length === 1 ? browserVersions[0] : "unavailable";
	manifest.capabilities = capabilitiesFor(expected, artifacts);
	writeJson(path.join(runDirectory, "manifest.json"), manifest);
	const environment = environmentForRun(runId, chromium);
	writeJson(path.join(runDirectory, "environment.json"), environment);

	const playwrightStatuses = statuses
		.map((status) => status.playwrightStatus)
		.filter((status) => Number.isInteger(status));
	const buildFailures =
		statuses.some((status) => status.buildStatus !== undefined && status.buildStatus !== 0) ||
		statuses.some((status) => status.buildHashError !== undefined);
	const playwrightExitCode =
		buildFailures || playwrightStatuses.length !== variants.length ? -1 : Math.max(...playwrightStatuses);
	const validated = validateBenchmarkArtifacts({
		matrix,
		tier,
		runId,
		artifacts,
		rawArtifacts,
		manifest,
		environment,
		playwrightExitCode,
	});
	const validationErrors = [...parseErrors, ...validated.errors];
	writeJson(path.join(logsDirectory, "validation.json"), {
		runId,
		tier,
		statuses,
		parseErrors,
		validationErrors,
	});
	const report = {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		suiteVersion: BENCHMARK_SUITE_VERSION,
		tier,
		runId,
		manifestHash: hashFile(path.join(runDirectory, "manifest.json")),
		environmentHash: hashFile(path.join(runDirectory, "environment.json")),
		playwrightExitCode,
		results: validated.results,
		validationErrors,
	};
	writeJson(path.join(runDirectory, "benchmark.json"), report);
	if (validationErrors.length === 0) {
		fs.writeFileSync(path.join(runDirectory, "benchmark.md"), reportMarkdown(report, manifest), "utf8");
	}
	process.stdout.write(`benchmark artifacts: ${path.relative(repositoryRoot, runDirectory)}\n`);
	if (validationErrors.length > 0) {
		for (const error of validationErrors) process.stderr.write(`benchmark validation: ${error}\n`);
		process.exitCode = 1;
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

main();
