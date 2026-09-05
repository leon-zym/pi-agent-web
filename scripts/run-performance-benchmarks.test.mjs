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

function fileSnapshot(directory) {
	const snapshot = {};
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			for (const [relativePath, contents] of Object.entries(fileSnapshot(entryPath))) {
				snapshot[path.join(entry.name, relativePath)] = contents;
			}
		} else if (entry.isFile()) {
			snapshot[entry.name] = fs.readFileSync(entryPath).toString("base64");
		}
	}
	return snapshot;
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
		assert.equal(typeof runManifest.source.dirty, "boolean");
		const failure = JSON.parse(fs.readFileSync(path.join(runDirectory, "failure.json"), "utf8"));
		assert.equal(failure.phase, "build-standard");
		assert.equal(fs.existsSync(runnerLockPath), false);
	} finally {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("refuses a run directory collision without mutating existing evidence", () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-benchmark-runner-"));
	try {
		const artifactRoot = path.join(temporaryDirectory, "performance");
		const runId = "existing-run";
		const runDirectory = path.join(artifactRoot, "representative", runId);
		fs.mkdirSync(path.join(runDirectory, "builds", "coalesced"), { recursive: true });
		fs.mkdirSync(path.join(runDirectory, "logs"), { recursive: true });
		fs.writeFileSync(path.join(runDirectory, "run-manifest.json"), "previous manifest\n");
		fs.writeFileSync(path.join(runDirectory, "benchmark.json"), "previous benchmark\n");
		fs.writeFileSync(path.join(runDirectory, "failure.json"), "previous failure\n");
		fs.writeFileSync(path.join(runDirectory, "logs", "previous.log"), "previous logs\n");
		fs.writeFileSync(path.join(runDirectory, "builds", "coalesced", "server.js"), "previous build\n");
		const before = fileSnapshot(runDirectory);

		const result = runRunner({
			PI_WEB_BENCHMARK_ARTIFACT_ROOT: artifactRoot,
			PI_WEB_BENCHMARK_RUN_ID: runId,
			PI_WEB_BENCHMARK_VARIANTS: "coalesced,sequential",
		});

		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Refusing to overwrite existing benchmark run/);
		assert.deepEqual(fileSnapshot(runDirectory), before);
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
