import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { createDeterministicTarGz } from "./create-release-bundle.mjs";
import {
	assertInstalledProductIsolation,
	cleanupOwnedProcessTree,
	controlledNpxEnvironment,
	createOwnedProcessTree,
	inspectPackageTarballs,
	PACKAGE_NAMES,
	resolvePackageManagerCommand,
	resolveTrustedPackageManagerToolchain,
	terminateOwnedProcessTree,
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

function appendDuplicateFileMember(archive, entryPath, replacementContent) {
	const unpacked = gunzipSync(archive);
	let offset = 0;
	let sourceRecord;
	while (offset + TAR_BLOCK_BYTES <= unpacked.byteLength) {
		const header = unpacked.subarray(offset, offset + TAR_BLOCK_BYTES);
		if (header.every((byte) => byte === 0)) break;
		const recordLength = archiveEntryByteLength(header);
		if (archiveEntryPath(header).replace(/\/$/, "") === entryPath) {
			sourceRecord = Buffer.from(unpacked.subarray(offset, offset + recordLength));
			break;
		}
		offset += recordLength;
	}
	if (!sourceRecord) throw new Error(`archive has no ${entryPath} member`);
	const originalSize = Number.parseInt(
		sourceRecord.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(),
		8,
	);
	if (replacementContent.byteLength !== originalSize) {
		throw new Error("duplicate fixture content must preserve the original tar member size");
	}
	replacementContent.copy(sourceRecord, TAR_BLOCK_BYTES);
	const terminator = unpacked.subarray(unpacked.byteLength - TAR_BLOCK_BYTES * 2);
	const duplicated = Buffer.concat([
		unpacked.subarray(0, unpacked.byteLength - TAR_BLOCK_BYTES * 2),
		sourceRecord,
		terminator,
	]);
	const compressed = gzipSync(duplicated, { level: 9 });
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

class FakeChild extends EventEmitter {
	constructor(pid = 4101) {
		super();
		this.pid = pid;
		this.exitCode = null;
		this.signalCode = null;
	}

	exit(code = 0, signal = null) {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("exit", code, signal);
	}
}

function ownedTreeFixture({ onSignal, platform = "linux" } = {}) {
	const child = new FakeChild();
	const state = { groupAlive: true, leaderAlive: true, now: 0, signals: [], taskkills: 0 };
	const operations = {
		platform,
		now: () => state.now,
		processExists: () => state.leaderAlive,
		processGroupExists: () => state.groupAlive,
		signalProcessGroup: (_groupId, signal) => {
			state.signals.push(signal);
			onSignal?.({ child, signal, state });
			return true;
		},
		sleep: async (milliseconds) => {
			state.now += milliseconds;
		},
		taskkillProcessTree: () => {
			state.taskkills += 1;
			onSignal?.({ child, signal: "TASKKILL", state });
			return true;
		},
	};
	return {
		child,
		state,
		tree: createOwnedProcessTree(child, { detached: platform !== "win32", operations }),
	};
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

test("rejects a duplicate packaged CLI member before installation", () => {
	const root = tempRoot();
	const tarballs = PACKAGE_NAMES.map((name) => writePackageTarball(root, name));
	const cliTarball = tarballs.find((tarball) => tarball.includes("pi-agent-web-cli"));
	const duplicate = appendDuplicateFileMember(
		fs.readFileSync(cliTarball),
		"package/dist/index.js",
		Buffer.from("last-last!\n"),
	);
	fs.writeFileSync(cliTarball, duplicate);
	assert.throws(() => inspectPackageTarballs(tarballs), /duplicated|duplicate/i);
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

test("cleans a live owned POSIX group with TERM", async () => {
	const { tree, state } = ownedTreeFixture({
		onSignal: ({ child, signal, state: fixtureState }) => {
			if (signal === "SIGTERM") {
				fixtureState.groupAlive = false;
				fixtureState.leaderAlive = false;
				child.exit();
			}
		},
	});
	await terminateOwnedProcessTree(tree, { termTimeoutMs: 10, killTimeoutMs: 10, pollIntervalMs: 1 });
	assert.deepEqual(state.signals, ["SIGTERM"]);
});

test("cleans an owned group before failing a deterministic smoke with no recorded child", async () => {
	const { tree, state } = ownedTreeFixture({
		onSignal: ({ child, signal, state: fixtureState }) => {
			if (signal === "SIGTERM") {
				fixtureState.groupAlive = false;
				fixtureState.leaderAlive = false;
				child.exit();
			}
		},
	});
	await assert.rejects(
		() =>
			cleanupOwnedProcessTree(tree, {
				requireFixtureProcess: true,
				termTimeoutMs: 10,
				killTimeoutMs: 10,
				pollIntervalMs: 1,
			}),
		/did not record a child process/,
	);
	assert.deepEqual(state.signals, ["SIGTERM"]);
});

test("cleans an early-exited owned group but fails the smoke", async () => {
	const { child, tree, state } = ownedTreeFixture({
		onSignal: ({ signal, state: fixtureState }) => {
			if (signal === "SIGTERM") {
				fixtureState.groupAlive = false;
				fixtureState.leaderAlive = false;
			}
		},
	});
	state.leaderAlive = false;
	child.exit(1);
	await assert.rejects(
		() => terminateOwnedProcessTree(tree, { termTimeoutMs: 10, killTimeoutMs: 10, pollIntervalMs: 1 }),
		/exited before controlled shutdown/,
	);
	assert.deepEqual(state.signals, ["SIGTERM"]);
});

test("refuses to signal a reused saved POSIX PID or process group", async () => {
	const { child, tree, state } = ownedTreeFixture();
	child.exit(1);
	state.leaderAlive = true;
	await assert.rejects(
		() => terminateOwnedProcessTree(tree, { termTimeoutMs: 10, killTimeoutMs: 10, pollIntervalMs: 1 }),
		/saved process-group identity is no longer valid/,
	);
	assert.deepEqual(state.signals, []);
});

test("uses a bounded TERM-to-KILL sequence only while the saved group is valid", async () => {
	const { tree, state } = ownedTreeFixture({
		onSignal: ({ signal, state: fixtureState }) => {
			if (signal === "SIGKILL") {
				fixtureState.groupAlive = false;
				fixtureState.leaderAlive = false;
			}
		},
	});
	await terminateOwnedProcessTree(tree, { termTimeoutMs: 4, killTimeoutMs: 4, pollIntervalMs: 1 });
	assert.deepEqual(state.signals, ["SIGTERM", "SIGKILL"]);
	assert.ok(state.now <= 8);
});

test("uses bounded Windows tree cleanup only while the root identity is live", async () => {
	const { tree, state } = ownedTreeFixture({
		platform: "win32",
		onSignal: ({ signal, state: fixtureState }) => {
			if (signal === "TASKKILL") fixtureState.leaderAlive = false;
		},
	});
	await terminateOwnedProcessTree(tree, { termTimeoutMs: 10, killTimeoutMs: 10, pollIntervalMs: 1 });
	assert.equal(state.taskkills, 1);
});

test("fails Windows cleanup explicitly after an early root exit", async () => {
	const { child, tree, state } = ownedTreeFixture({ platform: "win32" });
	state.leaderAlive = false;
	child.exit(1);
	await assert.rejects(
		() => terminateOwnedProcessTree(tree, { termTimeoutMs: 10, killTimeoutMs: 10, pollIntervalMs: 1 }),
		/cannot prove Windows process-tree cleanup after early root exit/,
	);
	assert.equal(state.taskkills, 0);
});

test("selects a Windows npm-family wrapper through its Node entrypoint without a shell string", () => {
	const root = tempRoot();
	const wrapperPath = path.join(root, "npx.cmd");
	const entryPath = path.join(root, "node_modules", "npm", "bin", "npx-cli.js");
	fs.mkdirSync(path.dirname(entryPath), { recursive: true });
	fs.writeFileSync(entryPath, "// fixture\n");
	fs.writeFileSync(wrapperPath, '@echo off\r\n"%dp0%\\node_modules\\npm\\bin\\npx-cli.js" %*\r\n');
	const invocation = resolvePackageManagerCommand("npx", {
		platform: "win32",
		env: { PATH: root },
		executableResolver: () => wrapperPath,
	});
	assert.equal(invocation.command, process.execPath);
	assert.deepEqual(invocation.argsPrefix, [entryPath]);
});

test("keeps system command paths while excluding inherited node_modules bins for npx", () => {
	const root = tempRoot();
	const npxDir = path.join(root, "npm-runtime");
	const shellDir = path.join(root, "shell-runtime");
	const inheritedBin = path.join(root, "source", "node_modules", ".bin");
	const inheritedBinAlias = path.join(root, "source-bin-alias");
	const emptyBinDir = path.join(root, "empty-bin");
	fs.mkdirSync(npxDir, { recursive: true });
	fs.mkdirSync(shellDir, { recursive: true });
	fs.mkdirSync(inheritedBin, { recursive: true });
	fs.symlinkSync(inheritedBin, inheritedBinAlias);
	fs.mkdirSync(emptyBinDir, { recursive: true });
	const npxPath = path.join(npxDir, "npx");
	fs.writeFileSync(npxPath, "#!/bin/sh\n");
	fs.chmodSync(npxPath, 0o755);
	const environment = controlledNpxEnvironment({
		emptyBinDir,
		baseEnv: { PATH: [inheritedBinAlias, inheritedBin, npxDir, shellDir].join(path.delimiter) },
	});
	const pathEntries = environment.PATH.split(path.delimiter).map((entry) => path.resolve(entry));
	assert.ok(pathEntries.includes(fs.realpathSync(emptyBinDir)));
	assert.ok(pathEntries.includes(fs.realpathSync(npxDir)));
	assert.ok(pathEntries.includes(fs.realpathSync(shellDir)));
	assert.ok(!pathEntries.includes(fs.realpathSync(inheritedBin)));
	assert.ok(!pathEntries.includes(fs.realpathSync(inheritedBinAlias)));
});

test("rejects PATH-first fake package managers and workspace symlink aliases", () => {
	const root = tempRoot();
	const fakeBin = path.join(root, "fake-bin");
	fs.mkdirSync(fakeBin);
	const fakePnpm = path.join(fakeBin, "pnpm");
	fs.writeFileSync(fakePnpm, "#!/bin/sh\necho fake\n");
	fs.chmodSync(fakePnpm, 0o755);
	assert.throws(
		() =>
			resolveTrustedPackageManagerToolchain({
				baseEnv: { PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter) },
				repositoryRoot: process.cwd(),
			}),
		/untrusted workspace or temporary path/,
	);

	const workspace = path.join(root, "workspace");
	const workspaceBin = path.join(workspace, "node_modules", ".bin");
	fs.mkdirSync(workspaceBin, { recursive: true });
	fs.symlinkSync(process.execPath, path.join(workspaceBin, "pnpm"));
	assert.throws(
		() =>
			resolveTrustedPackageManagerToolchain({
				baseEnv: { PATH: [workspaceBin, process.env.PATH].filter(Boolean).join(path.delimiter) },
				repositoryRoot: workspace,
				workspaceRoots: [workspace],
			}),
		/untrusted workspace or temporary path/,
	);
});
