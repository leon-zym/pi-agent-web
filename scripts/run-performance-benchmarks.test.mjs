import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptsDirectory, "..");
const runnerPath = path.join(scriptsDirectory, "run-performance-benchmarks.mjs");
const runnerLockPath = path.join(repositoryRoot, ".piweb-benchmark-runner.lock");

function runRunner(environment) {
	return spawnSync(process.execPath, [runnerPath, "representative"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: { ...process.env, ...environment },
	});
}

test("creates parent and run evidence before a clean-checkout build failure", () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-benchmark-runner-"));
	try {
		const fakeBin = path.join(temporaryDirectory, "bin");
		const artifactRoot = path.join(temporaryDirectory, "performance");
		fs.mkdirSync(fakeBin, { recursive: true });
		const fakePnpm = path.join(fakeBin, "pnpm");
		fs.writeFileSync(fakePnpm, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
		const runId = "clean-checkout-failure";
		const result = runRunner({
			PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
			PI_WEB_BENCHMARK_ARTIFACT_ROOT: artifactRoot,
			PI_WEB_BENCHMARK_RUN_ID: runId,
			PI_WEB_BENCHMARK_VARIANTS: "coalesced,sequential",
		});
		assert.equal(result.status, 1, result.stderr);
		const runDirectory = path.join(artifactRoot, "representative", runId);
		assert.ok(fs.existsSync(path.join(runDirectory, "run-manifest.json")));
		assert.ok(fs.existsSync(path.join(runDirectory, "manifest.json")));
		assert.ok(fs.existsSync(path.join(runDirectory, "logs", "build-standard.stdout.log")));
		assert.ok(fs.existsSync(path.join(runDirectory, "logs", "build-standard.stderr.log")));
		assert.ok(fs.existsSync(path.join(runDirectory, "failure.json")));
		assert.ok(fs.existsSync(path.join(runDirectory, "benchmark.json")));
		const runManifest = JSON.parse(fs.readFileSync(path.join(runDirectory, "run-manifest.json"), "utf8"));
		assert.equal(runManifest.source.dirty, false);
		const failure = JSON.parse(fs.readFileSync(path.join(runDirectory, "failure.json"), "utf8"));
		assert.equal(failure.phase, "build-standard");
		assert.equal(fs.existsSync(runnerLockPath), false);
	} finally {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("rejects singleton formal variant requests before starting a run", () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-benchmark-runner-"));
	try {
		const result = runRunner({
			PI_WEB_BENCHMARK_ARTIFACT_ROOT: path.join(temporaryDirectory, "performance"),
			PI_WEB_BENCHMARK_RUN_ID: "singleton-variant",
			PI_WEB_BENCHMARK_VARIANTS: "coalesced",
		});
		assert.equal(result.status, 2);
		assert.match(result.stderr, /exactly coalesced,sequential/);
		assert.equal(fs.existsSync(runnerLockPath), false);
	} finally {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("rejects an active same-WorkTree runner lock rather than racing", () => {
	if (fs.existsSync(runnerLockPath)) {
		throw new Error("test requires no active benchmark runner lock");
	}
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-benchmark-runner-"));
	try {
		fs.writeFileSync(runnerLockPath, "active\n", { mode: 0o600 });
		const result = runRunner({
			PI_WEB_BENCHMARK_ARTIFACT_ROOT: path.join(temporaryDirectory, "performance"),
			PI_WEB_BENCHMARK_RUN_ID: "locked-runner",
			PI_WEB_BENCHMARK_VARIANTS: "coalesced,sequential",
		});
		assert.equal(result.status, 2);
		assert.match(result.stderr, /another benchmark runner is active/);
	} finally {
		fs.rmSync(runnerLockPath, { force: true });
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});
