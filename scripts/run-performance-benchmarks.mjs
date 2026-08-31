import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	BENCHMARK_SCHEMA_VERSION,
	BENCHMARK_SUITE_VERSION,
	canonicalFormalExpectedScenarioSet,
	loadBenchmarkMatrix,
	validateBenchmarkArtifacts,
} from "./performance-benchmark-validator.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const matrixPath = path.join(repositoryRoot, "tests/e2e/benchmarks/matrix.json");
const defaultArtifactRoot = path.join(repositoryRoot, "test-results", "performance");
const fixturePaths = [
	"tests/e2e/fixtures/deterministic-pi.mjs",
	"tests/e2e/fixtures/page-observation.ts",
	"tests/e2e/fixtures/production-harness.ts",
	"tests/e2e/fixtures/test.ts",
];
const FORMAL_BENCHMARK_VARIANTS = Object.freeze(["coalesced", "sequential"]);
const standardBuildOutputs = {
	cli: path.join(repositoryRoot, "packages/cli/dist"),
	server: path.join(repositoryRoot, "packages/server/dist"),
	ui: path.join(repositoryRoot, "packages/ui/dist"),
};
const serverRuntimeDependencies = path.join(repositoryRoot, "packages/server/node_modules");
const benchmarkServerLegacyOutput = path.join(repositoryRoot, "packages/server/dist-benchmark");
const runnerLockPath = path.join(repositoryRoot, ".piweb-benchmark-runner.lock");
const executableExtensions = new Set([".cjs", ".css", ".html", ".js", ".mjs"]);
const standardBenchmarkNeedles = [
	"benchmark-",
	"PI_WEB_BENCHMARK",
	"VITE_PI_WEB_BENCHMARK",
	"__piwebBenchmark",
	"piweb-benchmark-gateway",
];

class RunFailure extends Error {
	constructor(phase, message) {
		super(message);
		this.phase = phase;
	}
}

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

function artifactRootForRun() {
	const configured = process.env.PI_WEB_BENCHMARK_ARTIFACT_ROOT;
	if (!configured) return defaultArtifactRoot;
	if (!path.isAbsolute(configured)) {
		throw new Error("PI_WEB_BENCHMARK_ARTIFACT_ROOT must be an absolute path");
	}
	return path.resolve(configured);
}

function variantsForRun(value) {
	const variants = (value ?? FORMAL_BENCHMARK_VARIANTS.join(","))
		.split(",")
		.map((variant) => variant.trim())
		.filter(Boolean);
	if (!Object.is(variants.length, FORMAL_BENCHMARK_VARIANTS.length)) {
		throw new Error("formal performance benchmarks require exactly coalesced,sequential");
	}
	if (new Set(variants).size !== FORMAL_BENCHMARK_VARIANTS.length) {
		throw new Error("formal performance benchmarks require each formal variant exactly once");
	}
	for (const variant of FORMAL_BENCHMARK_VARIANTS) {
		if (!variants.includes(variant)) {
			throw new Error("formal performance benchmarks require exactly coalesced,sequential");
		}
	}
	return FORMAL_BENCHMARK_VARIANTS;
}

function commandOutput(command, args, fallback = "unavailable") {
	try {
		return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8" }).trim() || fallback;
	} catch {
		return fallback;
	}
}

function sourceIdentity() {
	const status = commandOutput("git", ["status", "--porcelain"], "");
	return {
		commit: commandOutput("git", ["rev-parse", "HEAD"]),
		dirty: status
			.split("\n")
			.filter(Boolean)
			.some((line) => line !== "?? .piweb-benchmark-runner.lock"),
	};
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function hashFile(filePath) {
	return sha256(fs.readFileSync(filePath));
}

function hashTree(directory) {
	if (!fs.existsSync(directory)) {
		throw new Error(`Build output is missing: ${path.relative(repositoryRoot, directory)}`);
	}
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

function standardBuildIdentity() {
	return {
		cliTreeHash: hashTree(standardBuildOutputs.cli),
		serverTreeHash: hashTree(standardBuildOutputs.server),
		uiTreeHash: hashTree(standardBuildOutputs.ui),
	};
}

function buildOutputFiles(directory) {
	const files = [];
	const visit = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else if (entry.isFile() && executableExtensions.has(path.extname(entry.name))) files.push(entryPath);
		}
	};
	visit(directory);
	return files.sort((left, right) => left.localeCompare(right));
}

function scanStandardExecutableOutputs() {
	if (fs.existsSync(benchmarkServerLegacyOutput)) {
		throw new RunFailure(
			"standard-build-exclusion",
			"packages/server/dist-benchmark exists; refusing a run that could reuse benchmark executables",
		);
	}
	const matches = [];
	for (const [label, directory] of Object.entries(standardBuildOutputs)) {
		for (const filePath of buildOutputFiles(directory)) {
			const text = fs.readFileSync(filePath, "utf8");
			for (const needle of standardBenchmarkNeedles) {
				if (text.includes(needle)) {
					matches.push({ file: path.relative(repositoryRoot, filePath), needle });
				}
			}
		}
		if (!fs.existsSync(directory)) {
			throw new RunFailure("standard-build-exclusion", `${label} standard build output is missing`);
		}
	}
	const packageExports = [
		"packages/cli/package.json",
		"packages/server/package.json",
		"packages/ui/package.json",
	].map((relativePath) => ({
		relativePath,
		text: fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
	}));
	for (const packageExport of packageExports) {
		for (const needle of standardBenchmarkNeedles) {
			if (packageExport.text.includes(needle)) {
				matches.push({ file: packageExport.relativePath, needle });
			}
		}
	}
	if (matches.length > 0) {
		throw new RunFailure(
			"standard-build-exclusion",
			`standard executable/package output contains benchmark instrumentation: ${JSON.stringify(matches)}`,
		);
	}
	return {
		executableFiles: Object.fromEntries(
			Object.entries(standardBuildOutputs).map(([label, directory]) => [
				label,
				buildOutputFiles(directory).map((filePath) => path.relative(repositoryRoot, filePath)),
			]),
		),
		matches,
		sourceMapCaveat:
			"Source maps are intentionally excluded from this executable scan; Vite source-map sourcesContent may retain eliminated benchmark source text.",
	};
}

function assertStandardBuildUnchanged(before) {
	if (fs.existsSync(benchmarkServerLegacyOutput)) {
		throw new RunFailure(
			"standard-build-integrity",
			"packages/server/dist-benchmark was created during a benchmark variant run",
		);
	}
	const after = standardBuildIdentity();
	if (JSON.stringify(after) !== JSON.stringify(before)) {
		throw new RunFailure(
			"standard-build-integrity",
			`canonical standard outputs changed during benchmark execution: ${JSON.stringify({ before, after })}`,
		);
	}
	return after;
}

function fixtureHashes() {
	const hashes = {};
	for (const relativePath of fixturePaths) {
		hashes[relativePath] = hashFile(path.join(repositoryRoot, relativePath));
	}
	return hashes;
}

function seededVariantOrder(seed) {
	return [...FORMAL_BENCHMARK_VARIANTS].sort((left, right) => {
		const leftHash = sha256(`${seed}\0${left}`);
		const rightHash = sha256(`${seed}\0${right}`);
		return leftHash.localeCompare(rightHash) || left.localeCompare(right);
	});
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

function writeText(filePath, value) {
	fs.writeFileSync(filePath, `${value.endsWith("\n") ? value : `${value}\n`}`, "utf8");
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
	writeText(path.join(logDirectory, `${label}.stdout.log`), stdout);
	writeText(path.join(logDirectory, `${label}.stderr.log`), `${stderr}${failure}`);
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
			const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
			if (name.endsWith(".result.json")) artifacts.push({ name, value });
			else rawArtifacts.push({ name, value });
		} catch (error) {
			parseErrors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { artifacts, parseErrors, rawArtifacts };
}

function countsFor(expected, field) {
	return Object.fromEntries(
		expected.map((entry) => [`${entry.domain}/${entry.id}/${entry.variant}`, entry[field]]),
	);
}

function capabilitiesFor(expected, artifacts) {
	const required = [...new Set(expected.flatMap((entry) => entry.requiredCapabilities))].sort();
	const values = Object.fromEntries(required.map((capability) => [capability, true]));
	for (const artifact of artifacts) {
		if (artifact?.value?.capabilities === undefined) continue;
		for (const capability of required) {
			if (artifact.value.capabilities[capability] !== true) values[capability] = false;
		}
	}
	return values;
}

function relativeRunPath(runDirectory, filePath) {
	const relativePath = path.relative(runDirectory, filePath).replaceAll(path.sep, "/");
	if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
		throw new Error("benchmark build path escaped its run directory");
	}
	return relativePath;
}

function variantBuildPaths(runDirectory, variant) {
	const root = path.join(runDirectory, "builds", variant);
	return {
		root,
		serverDirectory: path.join(root, "server"),
		serverEntry: path.join(root, "server", "benchmark-main.js"),
		uiDirectory: path.join(root, "ui"),
	};
}

function placeholderBuildVariant(runDirectory, variant) {
	const paths = variantBuildPaths(runDirectory, variant);
	return {
		serverEntry: relativeRunPath(runDirectory, paths.serverEntry),
		serverEntryHash: "0".repeat(64),
		serverTreeHash: "0".repeat(64),
		uiDirectory: relativeRunPath(runDirectory, paths.uiDirectory),
		uiTreeHash: "0".repeat(64),
	};
}

function verifyVariantBuild(runDirectory, paths, buildVariant) {
	const observed = {
		serverEntry: relativeRunPath(runDirectory, paths.serverEntry),
		serverEntryHash: hashFile(paths.serverEntry),
		serverTreeHash: hashTree(paths.serverDirectory),
		uiDirectory: relativeRunPath(runDirectory, paths.uiDirectory),
		uiTreeHash: hashTree(paths.uiDirectory),
	};
	if (JSON.stringify(observed) !== JSON.stringify(buildVariant)) {
		throw new RunFailure(
			"variant-build-integrity",
			`benchmark variant build drifted from its manifest identity: ${JSON.stringify({ expected: buildVariant, observed })}`,
		);
	}
	return observed;
}

function linkVariantServerRuntimeDependencies(serverDirectory) {
	if (!fs.statSync(serverRuntimeDependencies).isDirectory()) {
		throw new RunFailure("build-server-dependencies", "packages/server/node_modules is unavailable");
	}
	const destination = path.join(serverDirectory, "node_modules");
	if (fs.existsSync(destination)) {
		throw new RunFailure(
			"build-server-dependencies",
			"benchmark server output unexpectedly already contains node_modules",
		);
	}
	// Node resolves ESM packages relative to the isolated executable, while pnpm keeps this package's
	// direct dependencies under packages/server/node_modules. The symlink is transient run scaffolding,
	// not a copied package output, and rmSync(paths.root) removes only this link after each variant.
	fs.symlinkSync(
		path.relative(fs.realpathSync(serverDirectory), fs.realpathSync(serverRuntimeDependencies)),
		destination,
		"dir",
	);
}

function removeVariantBuild(runDirectory, buildDirectory) {
	const relativePath = path.relative(runDirectory, buildDirectory);
	if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		throw new Error("refusing to remove a benchmark build outside its owned run directory");
	}
	fs.rmSync(buildDirectory, { recursive: true, force: true });
}

function removeRunOwnedBuilds(runDirectory) {
	const buildsDirectory = path.join(runDirectory, "builds");
	const relativePath = path.relative(runDirectory, buildsDirectory);
	if (relativePath !== "builds")
		throw new Error("refusing to remove an unexpected benchmark build directory");
	fs.rmSync(buildsDirectory, { recursive: true, force: true });
}

function claimRunnerLock(runId) {
	try {
		const descriptor = fs.openSync(runnerLockPath, "wx", 0o600);
		fs.writeFileSync(
			descriptor,
			`${JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() })}\n`,
		);
		return () => {
			try {
				fs.closeSync(descriptor);
			} catch {
				// The lock can already be closed after an interrupted startup path.
			}
			try {
				fs.unlinkSync(runnerLockPath);
			} catch (error) {
				if (!isNodeError(error, "ENOENT")) throw error;
			}
		};
	} catch (error) {
		if (isNodeError(error, "EEXIST")) {
			throw new Error("another benchmark runner is active in this WorkTree; refusing to race build outputs");
		}
		throw error;
	}
}

function isNodeError(error, code) {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function reportMarkdown(report, manifest) {
	const lines = [
		`# Performance benchmark — ${report.tier}`,
		"",
		`- Run: \`${report.runId}\``,
		`- Commit: \`${manifest.source.commit}\`${manifest.source.dirty ? " (dirty worktree)" : ""}`,
		`- Seed: \`${manifest.seed}\``,
		`- Canonical variants: ${manifest.canonicalVariants.join(", ")}`,
		`- Seeded execution order: ${manifest.executionOrder.join(", ")}`,
		`- Playwright exit: ${String(report.playwrightExitCode)}`,
		"",
		"| Domain | Scenario | Variant | Status | Measured samples |",
		"| --- | --- | --- | ---: | ---: |",
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

function writeFailure(runDirectory, logsDirectory, failure) {
	if (!runDirectory) return;
	const detail = {
		failedAt: new Date().toISOString(),
		...failure,
	};
	try {
		fs.mkdirSync(runDirectory, { recursive: true });
		const failureLogDirectory = logsDirectory ?? path.join(runDirectory, "logs");
		fs.mkdirSync(failureLogDirectory, { recursive: true });
		writeJson(path.join(runDirectory, "failure.json"), detail);
		writeText(
			path.join(failureLogDirectory, `${String(failure.phase ?? "unexpected")}.error.log`),
			String(failure.message ?? "benchmark runner failed"),
		);
		const runManifestPath = path.join(runDirectory, "run-manifest.json");
		if (fs.existsSync(runManifestPath)) {
			const runManifest = JSON.parse(fs.readFileSync(runManifestPath, "utf8"));
			writeJson(runManifestPath, { ...runManifest, status: "failed", failure: detail });
		}
	} catch (error) {
		process.stderr.write(
			`benchmark failure evidence could not be written: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}

function initialRunManifest({ runId, tier, variants, source }) {
	return {
		runId,
		tier,
		variants,
		startedAt: new Date().toISOString(),
		command: process.argv,
		source,
		status: "started",
	};
}

function failureReport({ runId, tier, source, phase, message }) {
	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		suiteVersion: BENCHMARK_SUITE_VERSION,
		tier,
		runId,
		source,
		playwrightExitCode: -1,
		results: [],
		validationErrors: [message],
		failurePhase: phase,
	};
}

async function main() {
	const tier = process.argv[2];
	if (!validTier(tier)) {
		process.stderr.write(`${usage()}\n`);
		return 2;
	}
	const runId = process.env.PI_WEB_BENCHMARK_RUN_ID ?? defaultRunId();
	if (!validRunId(runId)) {
		process.stderr.write("PI_WEB_BENCHMARK_RUN_ID must be a safe artifact directory name\n");
		return 2;
	}
	let variants;
	try {
		variants = variantsForRun(process.env.PI_WEB_BENCHMARK_VARIANTS);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}

	let artifactRoot;
	try {
		artifactRoot = artifactRootForRun();
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
	let releaseLock;
	try {
		releaseLock = claimRunnerLock(runId);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}

	let ownedRunDirectory;
	let logsDirectory;
	const source = sourceIdentity();
	try {
		const tierDirectory = path.join(artifactRoot, tier);
		fs.mkdirSync(tierDirectory, { recursive: true });
		const proposedRunDirectory = path.join(tierDirectory, runId);
		try {
			fs.mkdirSync(proposedRunDirectory, { recursive: false });
		} catch (error) {
			if (isNodeError(error, "EEXIST")) {
				throw new RunFailure(
					"run-creation",
					`Refusing to overwrite existing benchmark run: ${path.relative(repositoryRoot, proposedRunDirectory)}`,
				);
			}
			throw error;
		}
		ownedRunDirectory = proposedRunDirectory;
		const rawDirectory = path.join(ownedRunDirectory, "raw");
		logsDirectory = path.join(ownedRunDirectory, "logs");
		const playwrightDirectory = path.join(ownedRunDirectory, "playwright");
		writeJson(
			path.join(ownedRunDirectory, "run-manifest.json"),
			initialRunManifest({ runId, tier, variants, source }),
		);
		fs.mkdirSync(rawDirectory, { recursive: true });
		fs.mkdirSync(logsDirectory, { recursive: true });
		fs.mkdirSync(playwrightDirectory, { recursive: true });

		let matrix;
		try {
			matrix = loadBenchmarkMatrix(matrixPath);
		} catch (error) {
			throw new RunFailure(
				"matrix-load",
				error instanceof Error ? (error.stack ?? error.message) : String(error),
			);
		}
		const expected = canonicalFormalExpectedScenarioSet(matrix, tier);
		const seed = process.env.PI_WEB_BENCHMARK_SEED ?? "pi-agent-web-benchmark-v2";
		const executionOrder = seededVariantOrder(seed);
		const manifest = {
			schemaVersion: BENCHMARK_SCHEMA_VERSION,
			suiteVersion: BENCHMARK_SUITE_VERSION,
			tier,
			runId,
			seed,
			source,
			matrix: matrix.provenance,
			fixtureHashes: fixtureHashes(),
			lockfileHash: hashFile(path.join(repositoryRoot, "pnpm-lock.yaml")),
			buildIdentity: {
				cliTreeHash: "0".repeat(64),
				serverTreeHash: "0".repeat(64),
				uiTreeHash: "0".repeat(64),
			},
			buildVariants: Object.fromEntries(
				FORMAL_BENCHMARK_VARIANTS.map((variant) => [
					variant,
					placeholderBuildVariant(ownedRunDirectory, variant),
				]),
			),
			canonicalVariants: [...FORMAL_BENCHMARK_VARIANTS],
			executionOrder,
			warmupCounts: countsFor(expected, "warmups"),
			measuredCounts: countsFor(expected, "measured"),
			capabilities: capabilitiesFor(expected, []),
			expectedScenarioSet: expected,
		};
		writeJson(path.join(ownedRunDirectory, "manifest.json"), manifest);
		writeJson(path.join(ownedRunDirectory, "environment.json"), environmentForRun(runId));

		if (fs.existsSync(benchmarkServerLegacyOutput)) {
			throw new RunFailure(
				"standard-build-exclusion",
				"packages/server/dist-benchmark already exists; remove generated stale output outside this runner before retrying",
			);
		}
		const standardBuildStatus = runCommand("build-standard", "pnpm", ["build"], {}, logsDirectory);
		if (standardBuildStatus !== 0) {
			throw new RunFailure("build-standard", `standard pnpm build exited ${String(standardBuildStatus)}`);
		}
		const standardIdentity = standardBuildIdentity();
		manifest.buildIdentity = standardIdentity;
		const standardExclusion = scanStandardExecutableOutputs();
		writeJson(path.join(logsDirectory, "standard-build-isolation.json"), {
			identity: standardIdentity,
			...standardExclusion,
		});
		writeJson(path.join(ownedRunDirectory, "manifest.json"), manifest);

		const statuses = [{ phase: "build-standard", status: standardBuildStatus }];
		for (const variant of executionOrder) {
			const paths = variantBuildPaths(ownedRunDirectory, variant);
			try {
				fs.mkdirSync(paths.serverDirectory, { recursive: true });
				fs.mkdirSync(paths.uiDirectory, { recursive: true });
				const benchmarkEnvironment = {
					PI_WEB_BENCHMARK_BUILD: "1",
					PI_WEB_BENCHMARK_RUN_ID: runId,
					PI_WEB_BENCHMARK_SEED: seed,
					PI_WEB_BENCHMARK_TIER: tier,
					PI_WEB_BENCHMARK_VARIANT: variant,
					PI_WEB_BENCHMARK_ARTIFACT_DIR: ownedRunDirectory,
					PI_WEB_BENCHMARK_RAW_DIR: rawDirectory,
					PI_WEB_BENCHMARK_PLAYWRIGHT_DIR: path.join(playwrightDirectory, variant),
					PI_WEB_BENCHMARK_VARIANT_BUILD_DIR: paths.root,
					PI_WEB_BENCHMARK_SERVER_ENTRY: paths.serverEntry,
					PI_WEB_BENCHMARK_STATIC_DIR: paths.uiDirectory,
					PI_WEB_BENCHMARK_UI_OUT_DIR: paths.uiDirectory,
					VITE_PI_WEB_BENCHMARK_BUILD: "1",
					VITE_PI_WEB_BENCHMARK_VARIANT: variant,
				};
				const uiBuildStatus = runCommand(
					`build-ui-${variant}`,
					"pnpm",
					["--filter", "@pi-agent-web/ui", "build"],
					benchmarkEnvironment,
					logsDirectory,
				);
				statuses.push({ phase: `build-ui-${variant}`, status: uiBuildStatus });
				if (uiBuildStatus !== 0) {
					throw new RunFailure(`build-ui-${variant}`, `benchmark UI build exited ${String(uiBuildStatus)}`);
				}
				const serverBuildStatus = runCommand(
					`build-server-${variant}`,
					"pnpm",
					[
						"--filter",
						"@pi-agent-web/server",
						"exec",
						"tsc",
						"-p",
						"tsconfig.benchmark.json",
						"--noEmit",
						"false",
						"--outDir",
						paths.serverDirectory,
					],
					benchmarkEnvironment,
					logsDirectory,
				);
				statuses.push({ phase: `build-server-${variant}`, status: serverBuildStatus });
				if (serverBuildStatus !== 0) {
					throw new RunFailure(
						`build-server-${variant}`,
						`benchmark server build exited ${String(serverBuildStatus)}`,
					);
				}
				linkVariantServerRuntimeDependencies(paths.serverDirectory);
				if (!fs.existsSync(paths.serverEntry)) {
					throw new RunFailure(
						`build-server-${variant}`,
						"benchmark server build did not emit benchmark-main.js",
					);
				}
				const buildVariant = {
					serverEntry: relativeRunPath(ownedRunDirectory, paths.serverEntry),
					serverEntryHash: hashFile(paths.serverEntry),
					serverTreeHash: hashTree(paths.serverDirectory),
					uiDirectory: relativeRunPath(ownedRunDirectory, paths.uiDirectory),
					uiTreeHash: hashTree(paths.uiDirectory),
				};
				manifest.buildVariants[variant] = buildVariant;
				writeJson(path.join(ownedRunDirectory, "manifest.json"), manifest);
				assertStandardBuildUnchanged(standardIdentity);
				const preflight = verifyVariantBuild(ownedRunDirectory, paths, buildVariant);
				writeJson(path.join(logsDirectory, `preflight-${variant}.json`), {
					variant,
					...preflight,
				});
				const playwrightStatus = runCommand(
					`playwright-${variant}`,
					"pnpm",
					["exec", "playwright", "test", "--config", "tests/e2e/benchmarks/playwright.config.ts"],
					{
						...benchmarkEnvironment,
						PI_WEB_BENCHMARK_SERVER_ENTRY_HASH: buildVariant.serverEntryHash,
						PI_WEB_BENCHMARK_SERVER_TREE_HASH: buildVariant.serverTreeHash,
						PI_WEB_BENCHMARK_UI_TREE_HASH: buildVariant.uiTreeHash,
					},
					logsDirectory,
				);
				statuses.push({ phase: `playwright-${variant}`, status: playwrightStatus });
				const served = verifyVariantBuild(ownedRunDirectory, paths, buildVariant);
				writeJson(path.join(logsDirectory, `served-${variant}.json`), {
					variant,
					...served,
					matchesManifest: true,
				});
				assertStandardBuildUnchanged(standardIdentity);
			} finally {
				if (fs.existsSync(paths.root)) removeVariantBuild(ownedRunDirectory, paths.root);
			}
		}
		removeRunOwnedBuilds(ownedRunDirectory);

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
		writeJson(path.join(ownedRunDirectory, "manifest.json"), manifest);
		const environment = environmentForRun(runId, chromium);
		writeJson(path.join(ownedRunDirectory, "environment.json"), environment);
		const playwrightStatuses = statuses
			.filter((status) => status.phase.startsWith("playwright-"))
			.map((status) => status.status)
			.filter((status) => Number.isInteger(status));
		const playwrightExitCode =
			playwrightStatuses.length !== FORMAL_BENCHMARK_VARIANTS.length ? -1 : Math.max(...playwrightStatuses);
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
			manifestHash: hashFile(path.join(ownedRunDirectory, "manifest.json")),
			environmentHash: hashFile(path.join(ownedRunDirectory, "environment.json")),
			playwrightExitCode,
			results: validated.results,
			validationErrors,
		};
		writeJson(path.join(ownedRunDirectory, "benchmark.json"), report);
		if (validationErrors.length === 0) {
			fs.writeFileSync(
				path.join(ownedRunDirectory, "benchmark.md"),
				reportMarkdown(report, manifest),
				"utf8",
			);
		} else {
			writeFailure(ownedRunDirectory, logsDirectory, {
				phase: "validation",
				message: validationErrors.join("\n"),
				statuses,
			});
		}
		process.stdout.write(`benchmark artifacts: ${path.relative(repositoryRoot, ownedRunDirectory)}\n`);
		if (validationErrors.length > 0) {
			for (const error of validationErrors) process.stderr.write(`benchmark validation: ${error}\n`);
			return 1;
		}
		const runManifestPath = path.join(ownedRunDirectory, "run-manifest.json");
		const runManifest = JSON.parse(fs.readFileSync(runManifestPath, "utf8"));
		writeJson(runManifestPath, { ...runManifest, status: "completed", finishedAt: new Date().toISOString() });
		return 0;
	} catch (error) {
		const failure =
			error instanceof RunFailure
				? error
				: new RunFailure(
						"unexpected",
						error instanceof Error ? (error.stack ?? error.message) : String(error),
					);
		if (ownedRunDirectory) {
			writeFailure(ownedRunDirectory, logsDirectory, { phase: failure.phase, message: failure.message });
			try {
				writeJson(
					path.join(ownedRunDirectory, "benchmark.json"),
					failureReport({ runId, tier, source, phase: failure.phase, message: failure.message }),
				);
			} catch (reportError) {
				process.stderr.write(
					`benchmark failure report could not be written: ${reportError instanceof Error ? reportError.message : String(reportError)}\n`,
				);
			}
		}
		try {
			if (ownedRunDirectory) removeRunOwnedBuilds(ownedRunDirectory);
		} catch (cleanupError) {
			process.stderr.write(
				`benchmark build cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
			);
		}
		process.stderr.write(`benchmark ${failure.phase}: ${failure.message}\n`);
		return 1;
	} finally {
		releaseLock?.();
	}
}

void main().then((exitCode) => {
	process.exitCode = exitCode;
});
