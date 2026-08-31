import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	assertCommittedBundleOutput,
	assertSafeProjectNpmrc,
	createBundleRootManifest,
	createDeterministicTarGz,
	createImmutableSourceSnapshot,
	createReleaseBundle,
	createSanitizedNpmEnvironment,
	hydrateProvisionalBundleLockfile,
	inspectDeterministicTarGz,
	prepareOutputDirectory,
	publishBundleOutputs,
	rebindFrozenBundleLockfile,
	requireCleanCommit,
	validateBundledPackageGraph,
	validateBundleLockfile,
	verifyReleaseTag,
} from "./create-release-bundle.mjs";
import { extractTarEntries, readGzipTarEntries } from "./lib/archive.mjs";

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

function tarEntryLength(header) {
	const rawSize = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
	const size = Number.parseInt(rawSize, 8);
	return 512 + Math.ceil(size / 512) * 512;
}

function headerOffsetForPath(unpacked, targetPath) {
	let offset = 0;
	while (offset + 512 <= unpacked.byteLength) {
		const header = unpacked.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const nameEnd = header.subarray(0, 100).indexOf(0);
		const name = header
			.subarray(0, nameEnd === -1 ? 100 : nameEnd)
			.toString("utf8")
			.replace(/\/$/, "");
		if (name === targetPath) return offset;
		offset += tarEntryLength(header);
	}
	throw new Error(`archive has no ${targetPath} entry`);
}

function lstatOrNull(filePath) {
	try {
		return fs.lstatSync(filePath);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
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

function packageSetWithTarballs(root) {
	return packageSet().map((entry, index) => {
		const tarball = path.join(root, `${entry.manifest.name.replace(/[/@]/g, "-")}.tgz`);
		fs.writeFileSync(tarball, `tarball-${String(index)}\n`);
		return { ...entry, tarball };
	});
}

function git(root, args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function npmConfig(root, environment, key) {
	const result = spawnSync("npm", ["config", "get", key], { cwd: root, env: environment, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`npm config get ${key} failed: ${result.stderr}`);
	return result.stdout.trim();
}

const VALID_SHA512_SRI = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function bundledLockfile(rootManifest, externalResolved = "https://registry.npmjs.org/ws/-/ws-8.18.3.tgz") {
	const packages = {
		"": {
			name: rootManifest.name,
			version: rootManifest.version,
			engines: rootManifest.engines,
			dependencies: rootManifest.dependencies,
		},
		"node_modules/ws": {
			version: "8.18.3",
			integrity: VALID_SHA512_SRI,
			resolved: externalResolved,
		},
	};
	for (const [packageName, resolved] of Object.entries(rootManifest.dependencies)) {
		packages[`node_modules/${packageName}`] = {
			version: rootManifest.version,
			integrity: VALID_SHA512_SRI,
			resolved,
		};
	}
	return {
		name: rootManifest.name,
		version: rootManifest.version,
		lockfileVersion: 3,
		requires: true,
		packages,
	};
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

	const malformedPrefix = corruptArchive(archive, (unpacked) => {
		unpacked.fill(0, 512, 612);
		unpacked.write("file.txt", 512, "utf8");
		unpacked.fill(0, 512 + 345, 512 + 500);
		unpacked.write("../bundle", 512 + 345, "utf8");
		rewriteChecksum(unpacked.subarray(512, 1024));
	});
	assert.throws(() => inspectDeterministicTarGz(malformedPrefix), /escapes the bundle root/);

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

	const gzipWithFilename = Buffer.from(archive);
	gzipWithFilename[3] = 0x08;
	assert.throws(() => inspectDeterministicTarGz(gzipWithFilename), /gzip header is not deterministic/);
});

test("rejects file entries that are ancestors of other archive entries", () => {
	assert.throws(
		() =>
			createDeterministicTarGz([
				{ path: "bundle", type: "directory" },
				{ path: "bundle/parent", type: "file", content: "not a directory" },
				{ path: "bundle/parent/child.txt", type: "file", content: "child" },
			]),
		/cannot be an ancestor/,
	);

	const archive = createDeterministicTarGz([
		{ path: "bundle", type: "directory" },
		{ path: "bundle/parent", type: "directory" },
		{ path: "bundle/parent/child.txt", type: "file", content: "child" },
	]);
	const corrupted = corruptArchive(archive, (unpacked) => {
		const offset = headerOffsetForPath(unpacked, "bundle/parent");
		unpacked[offset + 156] = 0;
		unpacked.write("0000644\0", offset + 100, "ascii");
		rewriteChecksum(unpacked.subarray(offset, offset + 512));
	});
	assert.throws(() => inspectDeterministicTarGz(corrupted), /cannot be an ancestor/);
});

test("refuses an omitted-directory-header extraction through a symlinked ancestor before side effects", (t) => {
	if (process.platform === "win32") {
		t.skip("symlink fixture requires a privileged Windows test environment");
		return;
	}
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-extraction-containment-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const outside = path.join(root, "outside");
	const linkedParent = path.join(root, "linked-parent");
	const destination = path.join(linkedParent, "owned-extraction");
	fs.mkdirSync(outside);
	fs.symlinkSync(outside, linkedParent);
	const archive = createDeterministicTarGz([
		{ path: "bundle/payload.txt", type: "file", content: "payload\n" },
	]);
	const entries = readGzipTarEntries(archive);
	assert.throws(() => extractTarEntries(entries, destination), /symlink|owned|extraction/i);
	assert.equal(fs.existsSync(path.join(outside, "owned-extraction")), false);
	assert.equal(fs.existsSync(path.join(outside, "owned-extraction", "bundle", "payload.txt")), false);
});

test("contains output roots after resolving symlink ancestors", (t) => {
	if (process.platform === "win32") {
		t.skip("symlink fixture requires a privileged Windows test environment");
		return;
	}
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-output-containment-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const repositoryRoot = path.join(root, "repository");
	fs.mkdirSync(repositoryRoot);
	const sentinel = path.join(repositoryRoot, "sentinel.txt");
	fs.writeFileSync(sentinel, "unchanged\n");
	const linkedParent = path.join(root, "linked-output");
	fs.symlinkSync(repositoryRoot, linkedParent);

	assert.throws(
		() => prepareOutputDirectory(path.join(linkedParent, "candidate"), repositoryRoot),
		/outside the repository/,
	);
	assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged\n");
	assert.equal(fs.existsSync(path.join(repositoryRoot, "candidate")), false);
});

test("commits archive and checksum without replacing occupied or raced output directories", (t) => {
	const outputParent = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-output-publication-test-"));
	t.after(() => fs.rmSync(outputParent, { recursive: true, force: true }));
	const outputRoot = path.join(outputParent, "published-bundle");
	const archiveName = "bundle.tar.gz";
	const archive = Buffer.from("archive");
	const checksum = `${createHash("sha256").update(archive).digest("hex")}  ${archiveName}\n`;
	const canonicalOutputRoot = path.join(fs.realpathSync(outputParent), "published-bundle");
	const archivePath = path.join(outputRoot, archiveName);
	const checksumPath = `${archivePath}.sha256`;
	fs.symlinkSync(path.join(outputParent, "missing-target"), outputRoot);
	assert.throws(
		() =>
			publishBundleOutputs({
				outputRoot,
				archiveName,
				archive,
				checksum,
			}),
		/refusing to overwrite existing bundle output/,
	);
	assert.equal(fs.lstatSync(outputRoot).isSymbolicLink(), true);
	fs.unlinkSync(outputRoot);
	fs.mkdirSync(outputRoot);
	assert.throws(
		() =>
			publishBundleOutputs({
				outputRoot,
				archiveName,
				archive,
				checksum,
			}),
		/refusing to overwrite existing bundle output/,
	);
	fs.rmdirSync(outputRoot);
	let racedDestinationCreated = false;
	const raceOperations = {
		...fs,
		mkdirSync(target, options) {
			if (!racedDestinationCreated && target === canonicalOutputRoot) {
				racedDestinationCreated = true;
				fs.mkdirSync(canonicalOutputRoot);
				fs.writeFileSync(path.join(canonicalOutputRoot, "foreign.txt"), "foreign\n");
			}
			return fs.mkdirSync(target, options);
		},
	};
	assert.throws(
		() =>
			publishBundleOutputs({
				outputRoot,
				archiveName,
				archive,
				checksum,
				operations: raceOperations,
			}),
		/refusing to overwrite existing bundle output/,
	);
	assert.equal(fs.readFileSync(path.join(canonicalOutputRoot, "foreign.txt"), "utf8"), "foreign\n");
	fs.rmSync(canonicalOutputRoot, { recursive: true, force: true });

	let publishedMembers = 0;
	const operations = {
		...fs,
		linkSync(source, destination) {
			publishedMembers += 1;
			if (publishedMembers === 2) throw new Error("injected second publication failure");
			return fs.linkSync(source, destination);
		},
	};
	assert.throws(
		() =>
			publishBundleOutputs({
				outputRoot,
				archiveName,
				archive,
				checksum,
				operations,
			}),
		/injected second publication failure/,
	);
	assert.equal(lstatOrNull(outputRoot), null);
	assert.equal(lstatOrNull(archivePath), null);
	assert.equal(lstatOrNull(checksumPath), null);
	assert.deepEqual(fs.readdirSync(outputParent), []);

	let fsyncCalls = 0;
	const fsyncOperations = {
		...fs,
		fsyncSync(descriptor) {
			fsyncCalls += 1;
			if (fsyncCalls === 4) throw new Error("injected post-rename fsync failure");
			return fs.fsyncSync(descriptor);
		},
	};
	assert.throws(
		() =>
			publishBundleOutputs({
				outputRoot,
				archiveName,
				archive,
				checksum,
				operations: fsyncOperations,
			}),
		/injected post-rename fsync failure/,
	);
	assert.equal(lstatOrNull(outputRoot), null);
	assert.deepEqual(fs.readdirSync(outputParent), []);
});

test("binds publication to the canonical parent across an ancestor symlink swap", (t) => {
	if (process.platform === "win32") {
		t.skip("symlink fixture requires a privileged Windows test environment");
		return;
	}
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-output-symlink-swap-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const safeParent = path.join(root, "safe-output");
	const repositoryRoot = path.join(root, "repository");
	const linkedParent = path.join(root, "linked-output");
	fs.mkdirSync(safeParent);
	fs.mkdirSync(repositoryRoot);
	fs.writeFileSync(path.join(repositoryRoot, "sentinel.txt"), "unchanged\n");
	fs.symlinkSync(safeParent, linkedParent);
	const archiveName = "bundle.tar.gz";
	const archive = Buffer.from("archive");
	const checksum = `${createHash("sha256").update(archive).digest("hex")}  ${archiveName}\n`;
	const lexicalOutput = path.join(linkedParent, "published-bundle");
	const canonicalOutput = path.join(fs.realpathSync(safeParent), "published-bundle");
	let swapped = false;
	const operations = {
		...fs,
		mkdirSync(target, options) {
			if (!swapped && target === canonicalOutput) {
				swapped = true;
				fs.unlinkSync(linkedParent);
				fs.symlinkSync(repositoryRoot, linkedParent);
			}
			return fs.mkdirSync(target, options);
		},
	};
	const published = publishBundleOutputs({
		outputRoot: lexicalOutput,
		archiveName,
		archive,
		checksum,
		repositoryRoot,
		operations,
	});
	assert.equal(published.outputRoot, canonicalOutput);
	assertCommittedBundleOutput({ outputRoot: published.outputRoot, archiveName });
	assert.equal(fs.existsSync(path.join(repositoryRoot, "published-bundle")), false);
	assert.equal(fs.readFileSync(path.join(repositoryRoot, "sentinel.txt"), "utf8"), "unchanged\n");
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

test("validates only a complete v3 frozen graph with exact local edges and public SRI sources", () => {
	const rootManifest = createBundleRootManifest(packageSet(), "0.1.0");
	assert.doesNotThrow(() => validateBundleLockfile(bundledLockfile(rootManifest), rootManifest));

	for (const resolved of [
		"https://registry.example.invalid/ws/-/ws-8.18.3.tgz",
		"https://registry.npmjs.org.example.invalid/ws/-/ws-8.18.3.tgz",
		"http://registry.npmjs.org/ws/-/ws-8.18.3.tgz",
		"git+https://github.com/websockets/ws.git",
		"git+ssh://git@github.com/websockets/ws.git",
		"file:../external/ws.tgz",
		"workspace:*",
	]) {
		assert.throws(
			() => validateBundleLockfile(bundledLockfile(rootManifest, resolved), rootManifest),
			/canonical public registry|non-HTTPS resolution/,
		);
	}

	const missingResolution = bundledLockfile(rootManifest);
	delete missingResolution.packages["node_modules/ws"].resolved;
	assert.throws(() => validateBundleLockfile(missingResolution, rootManifest), /missing a resolution/);

	const missingIntegrity = bundledLockfile(rootManifest);
	delete missingIntegrity.packages["node_modules/ws"].integrity;
	assert.throws(() => validateBundleLockfile(missingIntegrity, rootManifest), /integrity/);
	const malformedIntegrity = bundledLockfile(rootManifest);
	malformedIntegrity.packages["node_modules/ws"].integrity = "sha512-fixture";
	assert.throws(() => validateBundleLockfile(malformedIntegrity, rootManifest), /integrity/);

	const nestedExternal = bundledLockfile(rootManifest);
	delete nestedExternal.packages["node_modules/ws"];
	nestedExternal.packages[
		"node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core"
	] = {
		version: "0.84.2",
		integrity: VALID_SHA512_SRI,
		resolved: "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.84.2.tgz",
	};
	assert.doesNotThrow(() => validateBundleLockfile(nestedExternal, rootManifest));

	const hybrid = bundledLockfile(rootManifest);
	hybrid.dependencies = { ws: { version: "8.18.3" } };
	assert.throws(() => validateBundleLockfile(hybrid, rootManifest), /v3|legacy|top-level/);
	const legacy = bundledLockfile(rootManifest);
	legacy.lockfileVersion = 2;
	assert.throws(() => validateBundleLockfile(legacy, rootManifest), /v3|legacy|top-level/);
	const credentialUrl = bundledLockfile(rootManifest);
	credentialUrl.packages["node_modules/ws"].resolved = "https://token@registry.npmjs.org/ws/-/ws-8.18.3.tgz";
	assert.throws(() => validateBundleLockfile(credentialUrl, rootManifest), /canonical public registry/);
	const poisonedMetadata = bundledLockfile(rootManifest);
	poisonedMetadata.packages["node_modules/ws"].authToken = "redacted";
	assert.throws(() => validateBundleLockfile(poisonedMetadata, rootManifest), /forbidden/);
	const credentialNamedDependency = bundledLockfile(rootManifest);
	credentialNamedDependency.packages["node_modules/ws"].dependencies = {
		"@aws-sdk/credential-provider-node": "3.0.0",
	};
	assert.doesNotThrow(() => validateBundleLockfile(credentialNamedDependency, rootManifest));
	const internalAlias = bundledLockfile(rootManifest);
	internalAlias.packages["node_modules/ws"].dependencies = {
		"pi-web-alias": "npm:@pi-agent-web/cli@0.1.0",
	};
	assert.throws(() => validateBundleLockfile(internalAlias, rootManifest), /alias|internal/);
	const nestedLegitimateExternal = bundledLockfile(rootManifest);
	nestedLegitimateExternal.packages["node_modules/@pi-agent-web/cli/node_modules/ws"] = {
		version: "8.18.3",
		integrity: VALID_SHA512_SRI,
		resolved: "https://registry.npmjs.org/ws/-/ws-8.18.3.tgz",
	};
	assert.doesNotThrow(() => validateBundleLockfile(nestedLegitimateExternal, rootManifest));

	const wrongInternalTarball = bundledLockfile(rootManifest);
	wrongInternalTarball.packages["node_modules/@pi-agent-web/cli"].resolved = "file:packages/other.tgz";
	assert.throws(() => validateBundleLockfile(wrongInternalTarball, rootManifest), /bundled tarball/);
});

test("rebinds only local tarball integrities in a frozen dependency lock", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-frozen-lock-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const packages = packageSetWithTarballs(root);
	const rootManifest = createBundleRootManifest(packages, "0.1.0");
	const frozen = bundledLockfile(rootManifest);
	frozen.packages["node_modules/@pi-agent-web/cli/node_modules/ws"] = {
		version: "8.18.3",
		integrity: VALID_SHA512_SRI,
		resolved: "https://registry.npmjs.org/ws/-/ws-8.18.3.tgz",
	};
	const rebound = rebindFrozenBundleLockfile(frozen, rootManifest, packages);
	assert.deepEqual(rebound.packages["node_modules/ws"], frozen.packages["node_modules/ws"]);
	assert.deepEqual(
		rebound.packages["node_modules/@pi-agent-web/cli/node_modules/ws"],
		frozen.packages["node_modules/@pi-agent-web/cli/node_modules/ws"],
	);
	assert.equal(rebound.requires, frozen.requires);
	for (const packageName of Object.keys(rootManifest.dependencies)) {
		assert.match(rebound.packages[`node_modules/${packageName}`].integrity, /^sha512-/);
		assert.equal(
			rebound.packages[`node_modules/${packageName}`].resolved,
			rootManifest.dependencies[packageName],
		);
	}
});

test("hydrates only missing canonical external SRI fields in a provisional graph", () => {
	const rootManifest = createBundleRootManifest(packageSet(), "0.1.0");
	const proposal = bundledLockfile(rootManifest);
	delete proposal.packages["node_modules/ws"].integrity;
	const requested = [];
	const hydrated = hydrateProvisionalBundleLockfile(proposal, rootManifest, {
		fetchTarball(resolved) {
			requested.push(resolved);
			return Buffer.from("fixture tarball bytes");
		},
	});
	assert.deepEqual(requested, ["https://registry.npmjs.org/ws/-/ws-8.18.3.tgz"]);
	assert.match(hydrated.packages["node_modules/ws"].integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
	assert.equal(proposal.packages["node_modules/ws"].integrity, undefined);
	assert.doesNotThrow(() => validateBundleLockfile(hydrated, rootManifest));

	const privateProposal = bundledLockfile(rootManifest, "https://example.invalid/ws/-/ws-8.18.3.tgz");
	delete privateProposal.packages["node_modules/ws"].integrity;
	assert.throws(
		() =>
			hydrateProvisionalBundleLockfile(privateProposal, rootManifest, {
				fetchTarball: () => Buffer.alloc(1),
			}),
		/canonical public registry/,
	);
});

test("fails release mode before any source build when no reviewed frozen lock is supplied", () => {
	assert.throws(
		() => createReleaseBundle({ mode: "release" }),
		/pre-reviewed frozen npm dependency lock input/,
	);
});

test("extracts immutable source bytes from the captured commit instead of mutable worktree files", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-source-snapshot-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	git(root, ["init"]);
	git(root, ["config", "user.email", "release-test@example.invalid"]);
	git(root, ["config", "user.name", "Release Test"]);
	fs.writeFileSync(path.join(root, "fixture.txt"), "committed\n");
	git(root, ["add", "fixture.txt"]);
	git(root, ["commit", "-m", "fixture"]);
	const commit = git(root, ["rev-parse", "HEAD"]);
	fs.writeFileSync(path.join(root, "fixture.txt"), "mutable\n");
	const snapshotRoot = path.join(root, "snapshot");
	createImmutableSourceSnapshot({ root, sourceCommit: commit, destinationRoot: snapshotRoot });
	assert.equal(fs.readFileSync(path.join(snapshotRoot, "fixture.txt"), "utf8"), "committed\n");
	assert.equal(fs.existsSync(path.join(snapshotRoot, ".git")), false);
});

test("isolates npm config precedence from hostile scoped registries without network access", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-npm-config-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const hostileUserConfig = path.join(root, "hostile-user.npmrc");
	const hostileGlobalConfig = path.join(root, "hostile-global.npmrc");
	const hostileBin = path.join(root, "hostile-bin");
	fs.mkdirSync(hostileBin);
	fs.writeFileSync(hostileUserConfig, "@earendil-works:registry=https://example.invalid/\n");
	fs.writeFileSync(hostileGlobalConfig, "registry=https://example.invalid/\n");
	fs.writeFileSync(path.join(root, ".npmrc"), "@earendil-works:registry=https://example.invalid/\n");
	const inheritedEnvironment = {
		PATH: [hostileBin, process.env.PATH].filter(Boolean).join(path.delimiter),
		...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		NPM_CONFIG_CACHE: path.join(root, "hostile-cache"),
		NPM_CONFIG_GLOBALCONFIG: hostileGlobalConfig,
		Npm_Config_Registry: "https://registry.example.invalid/",
		npm_config_userconfig: hostileUserConfig,
		PNPM_CONFIG_REGISTRY: "https://registry.example.invalid/",
		NPM_TOKEN: "must-not-forward",
		NODE_AUTH_TOKEN: "must-not-forward",
		HTTPS_PROXY: "https://proxy.example.invalid/",
		HOME: path.join(root, "hostile-home"),
		UNRELATED_TEST_VALUE: "preserved",
	};
	assert.equal(npmConfig(root, inheritedEnvironment, "@earendil-works:registry"), "https://example.invalid/");

	const environment = createSanitizedNpmEnvironment({ tempRoot: root, baseEnv: inheritedEnvironment });
	assert.throws(() => assertSafeProjectNpmrc(root), /project \.npmrc/);
	assert.equal(environment.UNRELATED_TEST_VALUE, undefined);
	assert.equal(environment.NPM_TOKEN, undefined);
	assert.equal(environment.NODE_AUTH_TOKEN, undefined);
	assert.equal(environment.HTTPS_PROXY, undefined);
	assert.equal(environment.PNPM_CONFIG_REGISTRY, undefined);
	assert.notEqual(environment.HOME, inheritedEnvironment.HOME);
	assert.ok(!environment.PATH.split(path.delimiter).includes(fs.realpathSync(hostileBin)));
	assert.deepEqual(
		Object.keys(environment)
			.filter((key) => /^(?:npm|pnpm)_config_/i.test(key))
			.sort(),
		[
			"npm_config_cache",
			"npm_config_globalconfig",
			"npm_config_prefix",
			"npm_config_registry",
			"npm_config_userconfig",
			"pnpm_config_store_dir",
		],
	);
	assert.match(
		fs.readFileSync(environment.npm_config_userconfig, "utf8"),
		/^registry=https:\/\/registry\.npmjs\.org\/\n$/,
	);
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
