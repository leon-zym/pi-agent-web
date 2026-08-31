import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { createDeterministicTarGz } from "./create-release-bundle.mjs";
import {
	assertInstalledProductIsolation,
	inspectPackageTarballs,
	PACKAGE_NAMES,
} from "./lib/package-smoke.mjs";

const tempRoots = [];
const TAR_BLOCK_BYTES = 512;

function tempRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-package-smoke-test-"));
	tempRoots.push(root);
	return root;
}

function archiveEntryPath(header) {
	const end = header.indexOf(0);
	return header.subarray(0, end === -1 ? header.byteLength : end).toString("utf8");
}

function archiveEntryByteLength(header) {
	const rawSize = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
	const size = Number.parseInt(rawSize, 8);
	return TAR_BLOCK_BYTES + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
}

function omitTarDirectoryHeaders(archive, paths) {
	const unpacked = gunzipSync(archive);
	const retained = [];
	let offset = 0;
	while (offset + TAR_BLOCK_BYTES <= unpacked.byteLength) {
		const header = unpacked.subarray(offset, offset + TAR_BLOCK_BYTES);
		if (header.every((byte) => byte === 0)) {
			retained.push(unpacked.subarray(offset));
			break;
		}
		const nextOffset = offset + archiveEntryByteLength(header);
		if (!paths.has(archiveEntryPath(header))) retained.push(unpacked.subarray(offset, nextOffset));
		offset = nextOffset;
	}
	const compressed = gzipSync(Buffer.concat(retained), { level: 9 });
	compressed.writeUInt32LE(0, 4);
	compressed[9] = 255;
	return compressed;
}

function writePackageTarball(root, name, manifest = {}, options = {}) {
	const { includeDistFile = true, extraEntries = [], omittedDirectoryHeaders = [] } = options;
	fs.mkdirSync(root, { recursive: true });
	const packageManifest = {
		name,
		version: "0.1.0",
		license: "MIT",
		repository: { url: "git+https://github.com/leon-zym/pi-agent-web.git" },
		...manifest,
	};
	const completeArchive = createDeterministicTarGz([
		{ path: "package", type: "directory" },
		{ path: "package/LICENSE", type: "file", content: "MIT\n" },
		{ path: "package/dist", type: "directory" },
		...(includeDistFile ? [{ path: "package/dist/index.js", type: "file", content: "export {};\n" }] : []),
		...extraEntries,
		{ path: "package/package.json", type: "file", content: `${JSON.stringify(packageManifest)}\n` },
	]);
	const archive =
		omittedDirectoryHeaders.length === 0
			? completeArchive
			: omitTarDirectoryHeaders(completeArchive, new Set(omittedDirectoryHeaders));
	const tarball = path.join(root, `${name.replace("/", "-")}.tgz`);
	fs.writeFileSync(tarball, archive);
	return tarball;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("inspects the complete packed package set and rejects workspace dependency leaks", () => {
	const root = tempRoot();
	const tarballs = PACKAGE_NAMES.map((name) => writePackageTarball(root, name));
	assert.equal(inspectPackageTarballs(tarballs).length, 4);

	const leakedTarballs = PACKAGE_NAMES.map((name) =>
		writePackageTarball(path.join(root, "leaked"), name, {
			dependencies: name === "@pi-agent-web/server" ? { "@pi-agent-web/protocol": "workspace:*" } : {},
		}),
	);
	assert.throws(() => inspectPackageTarballs(leakedTarballs), /Workspace dependency leaked/);
});

test("accepts dist files without an explicit dist directory header", () => {
	const root = tempRoot();
	const tarballs = PACKAGE_NAMES.map((name) =>
		writePackageTarball(
			path.join(root, "no-dist-header"),
			name,
			{},
			{
				omittedDirectoryHeaders: ["package/dist/"],
			},
		),
	);
	assert.equal(inspectPackageTarballs(tarballs).length, PACKAGE_NAMES.length);
});

test("requires a dist file instead of only a dist directory header", () => {
	const root = tempRoot();
	const tarballs = PACKAGE_NAMES.map((name) =>
		writePackageTarball(path.join(root, "empty-dist"), name, {}, { includeDistFile: false }),
	);
	assert.throws(() => inspectPackageTarballs(tarballs), /Missing dist directory/);
});

test("rejects source file entries without an explicit source directory header", () => {
	const root = tempRoot();
	const tarballs = PACKAGE_NAMES.map((name) =>
		writePackageTarball(
			path.join(root, "source-file"),
			name,
			{},
			{
				extraEntries:
					name === "@pi-agent-web/cli"
						? [{ path: "package/src/index.ts", type: "file", content: "export {};\n" }]
						: [],
				omittedDirectoryHeaders: ["package/src/"],
			},
		),
	);
	assert.throws(() => inspectPackageTarballs(tarballs), /Source directory leaked/);
});

test("requires installed product packages to be real paths outside the workspace", () => {
	const root = tempRoot();
	const installDir = path.join(root, "install");
	for (const packageName of PACKAGE_NAMES) {
		fs.mkdirSync(path.join(installDir, "node_modules", ...packageName.split("/")), { recursive: true });
	}
	assert.equal(
		assertInstalledProductIsolation({ installDir, repositoryRoot: process.cwd() }),
		fs.realpathSync(installDir),
	);

	const linkedPackage = path.join(installDir, "node_modules", "@pi-agent-web", "cli");
	fs.rmSync(linkedPackage, { recursive: true, force: true });
	fs.symlinkSync(path.join(installDir, "node_modules", "@pi-agent-web", "server"), linkedPackage);
	assert.throws(
		() => assertInstalledProductIsolation({ installDir, repositoryRoot: process.cwd() }),
		/must not be a symlink/,
	);
});
