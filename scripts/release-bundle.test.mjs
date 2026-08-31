import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	createBundleRootManifest,
	createDeterministicTarGz,
	inspectDeterministicTarGz,
	requireCleanCommit,
	validateBundledPackageGraph,
	verifyReleaseTag,
} from "./create-release-bundle.mjs";

function rewriteChecksum(header) {
	header.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
}

function corruptArchive(archive, mutate) {
	const unpacked = gunzipSync(archive);
	mutate(unpacked);
	const compressed = gzipSync(unpacked, { level: 9 });
	compressed.writeUInt32LE(0, 4);
	compressed[9] = 255;
	return compressed;
}

function packageEntry(name, dependencies = {}) {
	return {
		manifest: { name, version: "0.1.0", dependencies },
		tarball: `/tmp/${name.replace("/", "-")}.tgz`,
	};
}

function packageSet() {
	return [
		packageEntry("@pi-agent-web/protocol"),
		packageEntry("@pi-agent-web/server", { "@pi-agent-web/protocol": "0.1.0" }),
		packageEntry("@pi-agent-web/ui", { "@pi-agent-web/protocol": "0.1.0" }),
		packageEntry("@pi-agent-web/cli", {
			"@pi-agent-web/server": "0.1.0",
			"@pi-agent-web/ui": "0.1.0",
		}),
	];
}

function git(root, args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

test("builds a byte-stable, canonical bundle archive", () => {
	const entries = [
		{ path: "pi-agent-web-v0.1.0/packages", type: "directory" },
		{ path: "pi-agent-web-v0.1.0/LICENSE", type: "file", content: "MIT\n" },
		{ path: "pi-agent-web-v0.1.0", type: "directory" },
		{ path: "pi-agent-web-v0.1.0/packages/cli.tgz", type: "file", content: Buffer.from([1, 2, 3]) },
	];
	const first = createDeterministicTarGz(entries);
	const second = createDeterministicTarGz([...entries].reverse());
	assert.deepEqual(first, second);
	const observed = inspectDeterministicTarGz(first, { rootName: "pi-agent-web-v0.1.0" });
	assert.deepEqual(
		observed.map((entry) => [entry.path, entry.type, entry.mode, entry.size]),
		[
			["pi-agent-web-v0.1.0", "directory", 0o755, 0],
			["pi-agent-web-v0.1.0/LICENSE", "file", 0o644, 4],
			["pi-agent-web-v0.1.0/packages", "directory", 0o755, 0],
			["pi-agent-web-v0.1.0/packages/cli.tgz", "file", 0o644, 3],
		],
	);
});

test("rejects archive traversal and non-canonical owner, mode, and mtime corruption", () => {
	const archive = createDeterministicTarGz([
		{ path: "bundle", type: "directory" },
		{ path: "bundle/file.txt", type: "file", content: "value" },
	]);
	const traversal = corruptArchive(archive, (unpacked) => {
		unpacked.fill(0, 0, 100);
		unpacked.write("../escape/", 0, "utf8");
		rewriteChecksum(unpacked.subarray(0, 512));
	});
	assert.throws(() => inspectDeterministicTarGz(traversal), /escapes the bundle root/);

	const wrongOwner = corruptArchive(archive, (unpacked) => {
		unpacked.write("0000001\0", 108, "ascii");
		rewriteChecksum(unpacked.subarray(0, 512));
	});
	assert.throws(() => inspectDeterministicTarGz(wrongOwner), /non-root numeric ownership/);

	const wrongMode = corruptArchive(archive, (unpacked) => {
		unpacked.write("0000755\0", 512 + 100, "ascii");
		rewriteChecksum(unpacked.subarray(512, 1024));
	});
	assert.throws(() => inspectDeterministicTarGz(wrongMode), /non-canonical mode/);

	const wrongMtime = corruptArchive(archive, (unpacked) => {
		unpacked.write("00000000001\0", 136, "ascii");
		rewriteChecksum(unpacked.subarray(0, 512));
	});
	assert.throws(() => inspectDeterministicTarGz(wrongMtime), /non-deterministic mtime/);

	const wrongGzipHeader = Buffer.from(archive);
	wrongGzipHeader.writeUInt32LE(1, 4);
	assert.throws(() => inspectDeterministicTarGz(wrongGzipHeader), /gzip header is not deterministic/);
});

test("maps every internal package edge to a bundle-local tgz and rejects version drift", () => {
	const packages = packageSet();
	assert.equal(validateBundledPackageGraph(packages, "0.1.0").size, 4);
	assert.deepEqual(createBundleRootManifest(packages, "0.1.0").dependencies, {
		"@pi-agent-web/cli": "file:packages/pi-agent-web-cli-0.1.0.tgz",
		"@pi-agent-web/protocol": "file:packages/pi-agent-web-protocol-0.1.0.tgz",
		"@pi-agent-web/server": "file:packages/pi-agent-web-server-0.1.0.tgz",
		"@pi-agent-web/ui": "file:packages/pi-agent-web-ui-0.1.0.tgz",
	});

	const drifted = packageSet();
	drifted[1].manifest.version = "0.1.1";
	assert.throws(() => validateBundledPackageGraph(drifted, "0.1.0"), /Version drift/);

	const unbundled = packageSet();
	unbundled[3].manifest.dependencies["@pi-agent-web/missing"] = "0.1.0";
	assert.throws(() => validateBundledPackageGraph(unbundled, "0.1.0"), /unbundled internal package/);
});

test("requires a clean commit and an exact annotated release tag", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-release-tag-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	git(root, ["init"]);
	git(root, ["config", "user.email", "release-test@example.invalid"]);
	git(root, ["config", "user.name", "Release Test"]);
	fs.writeFileSync(path.join(root, "fixture.txt"), "fixture\n");
	git(root, ["add", "fixture.txt"]);
	git(root, ["commit", "-m", "fixture"]);
	const commit = requireCleanCommit(root);
	git(root, ["tag", "v0.1.0"]);
	assert.throws(
		() => verifyReleaseTag({ root, tag: "v0.1.0", version: "0.1.0", sourceCommit: commit }),
		/annotated tag/,
	);
	git(root, ["tag", "-d", "v0.1.0"]);
	git(root, ["tag", "-a", "v0.1.0", "-m", "release fixture"]);
	assert.doesNotThrow(() =>
		verifyReleaseTag({ root, tag: "v0.1.0", version: "0.1.0", sourceCommit: commit }),
	);
	assert.throws(
		() => verifyReleaseTag({ root, tag: "v0.1.0", version: "0.1.1", sourceCommit: commit }),
		/does not match package version/,
	);
	fs.writeFileSync(path.join(root, "untracked.txt"), "dirty\n");
	assert.throws(() => requireCleanCommit(root), /requires a clean commit/);
});
