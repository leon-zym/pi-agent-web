import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { benchmarkQuota } from "./benchmark-quota.mjs";

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

// Sanitized producer-shaped layout from the one-shot Actions probe34218564159:
// full v2 mount, two non-root levels, root interfaces absent, both levels max.
function quotaFixture(overrides = {}, group = "/slice/job") {
	return {
		"/proc/self/cgroup": `0::${group}\n`,
		"/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
		"/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory pids\n",
		"/sys/fs/cgroup/slice/cpu.max": "max 100000\n",
		"/sys/fs/cgroup/slice/job/cpu.max": "max 100000\n",
		"/sys/fs/cgroup/slice/memory.max": "max\n",
		"/sys/fs/cgroup/slice/job/memory.max": "max\n",
		...overrides,
	};
}

function quotaFrom(files) {
	return benchmarkQuota({
		platform: "linux",
		totalMemory: 4096,
		readFile(name) {
			if (files[name] instanceof Error) throw files[name];
			if (typeof files[name] === "string") return files[name];
			throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
		},
	});
}

test("collects the observed Actions hierarchy instead of assuming a root quota file", () => {
	const result = quotaFrom(quotaFixture());
	assert.equal(result.cpu, "unlimited");
	assert.equal(result.memoryBytes, 4096);
	assert.deepEqual(
		result.evidence.filter((e) => e.controller === "cpu").map((e) => e.value),
		["max 100000", "max 100000"],
	);
});

test("finite ancestor limits constrain unlimited children for CPU and memory", () => {
	const result = quotaFrom(
		quotaFixture({
			"/sys/fs/cgroup/slice/cpu.max": "200000 100000",
			"/sys/fs/cgroup/slice/memory.max": "2048",
		}),
	);
	assert.equal(result.cpu, "200000/100000");
	assert.equal(result.memoryBytes, 2048);
	assert.equal(
		quotaFrom(
			quotaFixture({
				"/sys/fs/cgroup/slice/cpu.max": "200000 100000",
				"/sys/fs/cgroup/slice/job/cpu.max": "10000 10000",
			}),
		).cpu,
		"10000/10000",
	);
});

test("missing, denied and malformed constraints stay unknown", () => {
	for (const value of [
		undefined,
		"",
		"max garbage",
		"max",
		"0 100000",
		"100 0",
		"-1 100000",
		"1e3 100000",
		"9007199254740992 1",
		Object.assign(new Error(), { code: "EACCES" }),
	]) {
		const result = quotaFrom(quotaFixture({ "/sys/fs/cgroup/slice/cpu.max": value }));
		assert.equal(result.cpu, "unavailable", String(value));
	}
	const denied = quotaFrom(
		quotaFixture({ "/sys/fs/cgroup/slice/cpu.max": Object.assign(new Error(), { code: "EACCES" }) }),
	);
	assert.ok(denied.evidence.some((e) => e.error === "EACCES"));
	const memory = quotaFrom(quotaFixture({ "/sys/fs/cgroup/slice/memory.max": undefined }));
	assert.equal(memory.memoryBytes, "unavailable");
});

test("real root requires both an available controller and absent root interface", () => {
	assert.equal(quotaFrom(quotaFixture({}, "/")).cpu, "unlimited");
	for (const overrides of [
		{ "/sys/fs/cgroup/cpu.max": "max 100000" },
		{ "/sys/fs/cgroup/cpu.max": Object.assign(new Error(), { code: "EACCES" }) },
		{ "/sys/fs/cgroup/cgroup.controllers": "memory" },
		{ "/sys/fs/cgroup/cgroup.controllers": undefined },
	])
		assert.equal(quotaFrom(quotaFixture(overrides)).cpu, "unavailable");
});

test("unsupported v1, absent proc evidence, hidden roots and ambiguous mounts fail closed", () => {
	for (const overrides of [
		{
			"/proc/self/cgroup": "2:cpu,cpuacct:/job",
			"/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct",
		},
		{ "/proc/self/cgroup": "" },
		{ "/proc/self/cgroup": undefined },
		{ "/proc/self/mountinfo": "" },
		{ "/proc/self/mountinfo": "1 0 0:1 /parent /sys/fs/cgroup rw - cgroup2 cgroup rw" },
		{
			"/proc/self/mountinfo":
				"1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n2 0 0:1 / /other rw - cgroup2 cgroup rw",
		},
		{ "/proc/self/cgroup": "0::/slice/../job" },
		{ "/proc/self/cgroup": `0::/${"deep/".repeat(20)}job` },
	]) {
		const result = quotaFrom(quotaFixture(overrides));
		assert.equal(result.cpu, "unavailable");
		assert.equal(result.memoryBytes, "unavailable");
	}
});

test("non-Linux preserves the explicit CPU sentinel without probing Linux paths", () => {
	assert.deepEqual(
		benchmarkQuota({
			platform: "darwin",
			totalMemory: 4096,
			readFile() {
				throw new Error("must not read");
			},
		}),
		{
			cpu: "unavailable",
			memoryBytes: 4096,
			evidence: [],
		},
	);
});

test("preserves a whitespace-only cgroup name instead of reading the unlimited root", () => {
	const result = quotaFrom(
		quotaFixture(
			{
				"/sys/fs/cgroup/ /cpu.max": "10000 100000\n",
				"/sys/fs/cgroup/ /memory.max": "1024\n",
			},
			"/ ",
		),
	);
	assert.equal(result.cpu, "10000/100000");
	assert.equal(result.memoryBytes, 1024);
});

test("preserves trailing whitespace instead of reading an unlimited sibling", () => {
	const result = quotaFrom(
		quotaFixture(
			{
				"/sys/fs/cgroup/job/cpu.max": "max 100000\n",
				"/sys/fs/cgroup/job/memory.max": "max\n",
				"/sys/fs/cgroup/job /cpu.max": "20000 100000\n",
				"/sys/fs/cgroup/job /memory.max": "2048\n",
			},
			"/job ",
		),
	);
	assert.equal(result.cpu, "20000/100000");
	assert.equal(result.memoryBytes, 2048);
});
