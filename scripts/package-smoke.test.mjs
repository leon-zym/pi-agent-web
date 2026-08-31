import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createDeterministicTarGz } from "./create-release-bundle.mjs";
import {
	assertInstalledProductIsolation,
	inspectPackageTarballs,
	PACKAGE_NAMES,
} from "./lib/package-smoke.mjs";

const tempRoots = [];

function tempRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-package-smoke-test-"));
	tempRoots.push(root);
	return root;
}

function writePackageTarball(root, name, manifest = {}) {
	fs.mkdirSync(root, { recursive: true });
	const packageManifest = {
		name,
		version: "0.1.0",
		license: "MIT",
		repository: { url: "git+https://github.com/leon-zym/pi-agent-web.git" },
		...manifest,
	};
	const archive = createDeterministicTarGz([
		{ path: "package", type: "directory" },
		{ path: "package/LICENSE", type: "file", content: "MIT\n" },
		{ path: "package/dist", type: "directory" },
		{ path: "package/dist/index.js", type: "file", content: "export {};\n" },
		{ path: "package/package.json", type: "file", content: `${JSON.stringify(packageManifest)}\n` },
	]);
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
