import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PACKAGES, parseArgs, stageRelease, validateTarball } from "./release-stage.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(rootDir, "scripts", "release-stage.mjs");

function createTarball(dir, tarballPath, files, manifestObj = {}) {
	const pkgDir = path.join(dir, "package");
	fs.rmSync(pkgDir, { recursive: true, force: true });
	fs.mkdirSync(pkgDir, { recursive: true });
	for (const [relPath, content] of Object.entries(files)) {
		const full = path.join(pkgDir, relPath);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
	const manifestContent = JSON.stringify({
		name: "@pi-agent-web/protocol",
		version: "0.1.0",
		...manifestObj,
	});
	fs.writeFileSync(path.join(pkgDir, "package.json"), manifestContent);
	spawnSync("tar", ["-czf", tarballPath, "package"], { cwd: dir });
}

test("fails closed locally when CI and --allow-local are absent", () => {
	const env = { ...process.env };
	delete env.CI;
	delete env.GITHUB_ACTIONS;
	const res = spawnSync(process.execPath, [scriptPath, "--tag=v0.1.0"], { env, encoding: "utf8" });
	assert.notEqual(res.status, 0);
	assert.match(
		res.stderr + res.stdout,
		/release-stage is runner-only\. Pass --allow-local for local testing\./,
	);
});

test("rejects tag mismatch against root version", () => {
	const res = spawnSync(process.execPath, [scriptPath, "--tag=v9.9.9", "--allow-local"], {
		encoding: "utf8",
	});
	assert.notEqual(res.status, 0);
	assert.match(res.stderr + res.stdout, /Tag v9\.9\.9 does not match root version/);
});

test("parseArgs parses flags and positional tag", () => {
	assert.deepEqual(parseArgs(["--tag=v0.1.0", "--allow-local"]), {
		tag: "v0.1.0",
		outDir: "dist/staging",
		allowLocal: true,
		skipGitCheck: false,
	});
	assert.deepEqual(parseArgs(["v1.0.0", "--out-dir=tmp/out", "--allow-local", "--allow-dirty"]), {
		tag: "v1.0.0",
		outDir: "tmp/out",
		allowLocal: true,
		skipGitCheck: true,
	});
});

test("validateTarball enforces package shape and rejects leaks", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-test-tar-"));
	try {
		const validTar = path.join(tmp, "valid.tgz");
		createTarball(tmp, validTar, {
			"dist/index.js": "export {};",
			"dist/index.d.ts": "export declare const x = 1;",
			LICENSE: "MIT",
		});
		const parsed = validateTarball(validTar, "@pi-agent-web/protocol");
		assert.equal(parsed.name, "@pi-agent-web/protocol");

		const missingDist = path.join(tmp, "no-dist.tgz");
		createTarball(tmp, missingDist, { LICENSE: "MIT" });
		assert.throws(() => validateTarball(missingDist), /Missing package\/dist\//);

		const missingLicense = path.join(tmp, "no-license.tgz");
		createTarball(tmp, missingLicense, { "dist/index.js": "ok" });
		assert.throws(() => validateTarball(missingLicense), /Missing package\/LICENSE/);

		const leakedSrc = path.join(tmp, "leaked-src.tgz");
		createTarball(tmp, leakedSrc, { "dist/index.js": "ok", LICENSE: "MIT", "src/index.ts": "export {}" });
		assert.throws(() => validateTarball(leakedSrc), /Source leaked/);

		const uncompiledTs = path.join(tmp, "uncompiled-ts.tgz");
		createTarball(tmp, uncompiledTs, { "dist/foo.ts": "export {}", LICENSE: "MIT" });
		assert.throws(() => validateTarball(uncompiledTs), /Uncompiled TypeScript leaked/);

		const workspaceLeak = path.join(tmp, "workspace-leak.tgz");
		createTarball(
			tmp,
			workspaceLeak,
			{ "dist/index.js": "ok", LICENSE: "MIT" },
			{ dependencies: { "@pi-agent-web/protocol": "workspace:*" } },
		);
		assert.throws(() => validateTarball(workspaceLeak), /Workspace protocol leaked/);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("stageRelease rejects workspace package version mismatch", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-test-ws-"));
	try {
		fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ version: "0.1.0" }));
		for (const pkg of PACKAGES) {
			const sub = path.join(tmp, "packages", pkg.replace("@pi-agent-web/", ""));
			fs.mkdirSync(sub, { recursive: true });
			fs.writeFileSync(
				path.join(sub, "package.json"),
				JSON.stringify({ version: pkg.endsWith("cli") ? "0.2.0" : "0.1.0" }),
			);
		}
		assert.throws(
			() => stageRelease({ tag: "v0.1.0", allowLocal: true, skipGitCheck: true, rootDir: tmp }),
			/version 0\.2\.0 does not match 0\.1\.0/,
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
