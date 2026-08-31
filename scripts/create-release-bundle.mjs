import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { extractTarEntries, readGzipTarEntries, readTarEntries } from "./lib/archive.mjs";
import {
	inspectPackageTarballs,
	PACKAGE_NAMES,
	packWorkspacePackages,
	REPOSITORY_ROOT,
	run,
	sha256,
	sha256File,
} from "./lib/package-smoke.mjs";

const ARCHIVE_BLOCK_BYTES = 512;
const ARCHIVE_END_BYTES = ARCHIVE_BLOCK_BYTES * 2;
const ARCHIVE_MTIME = 0;
const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const PUBLIC_NPM_REGISTRY_ORIGIN = new URL(PUBLIC_NPM_REGISTRY).origin;
const INTERNAL_PACKAGE_PREFIX = "@pi-agent-web/";

function comparePaths(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function asBuffer(value, label) {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	if (typeof value === "string") return Buffer.from(value, "utf8");
	throw new Error(`${label} must be a Buffer, Uint8Array, or string`);
}

export function assertSafeArchivePath(value, label = "archive entry") {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) {
		throw new Error(`${label} has an invalid path`);
	}
	if (value.startsWith("/") || value.endsWith("/")) throw new Error(`${label} must be a relative file path`);
	const segments = value.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new Error(`${label} escapes the bundle root: ${value}`);
	}
	return value;
}

function writeString(buffer, offset, byteLength, value, label) {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength > byteLength) throw new Error(`${label} is too long for ustar`);
	bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, byteLength, value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
	const octal = value.toString(8);
	if (octal.length > byteLength - 1) throw new Error(`${label} does not fit in ustar`);
	writeString(buffer, offset, byteLength, `${octal.padStart(byteLength - 1, "0")}\0`, label);
}

function writeChecksum(buffer) {
	buffer.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of buffer) sum += byte;
	const octal = sum.toString(8);
	if (octal.length > 6) throw new Error("ustar checksum does not fit");
	writeString(buffer, 148, 8, `${octal.padStart(6, "0")}\0 `, "ustar checksum");
}

function splitUstarPath(entryPath) {
	const bytes = Buffer.from(entryPath, "utf8");
	if (bytes.byteLength <= 100) return { name: entryPath, prefix: "" };
	for (let index = entryPath.length - 1; index >= 0; index -= 1) {
		if (entryPath[index] !== "/") continue;
		const prefix = entryPath.slice(0, index);
		const name = entryPath.slice(index + 1);
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
	}
	throw new Error(`archive entry path is too long for ustar: ${entryPath}`);
}

function createUstarHeader(entry) {
	const header = Buffer.alloc(ARCHIVE_BLOCK_BYTES);
	const archivePath = entry.type === "directory" ? `${entry.path}/` : entry.path;
	const { name, prefix } = splitUstarPath(archivePath);
	writeString(header, 0, 100, name, "ustar name");
	writeOctal(header, 100, 8, entry.mode, "ustar mode");
	writeOctal(header, 108, 8, 0, "ustar uid");
	writeOctal(header, 116, 8, 0, "ustar gid");
	writeOctal(header, 124, 12, entry.content.byteLength, "ustar size");
	writeOctal(header, 136, 12, ARCHIVE_MTIME, "ustar mtime");
	header[156] = entry.type === "directory" ? "5".charCodeAt(0) : 0;
	writeString(header, 257, 6, "ustar\0", "ustar magic");
	writeString(header, 263, 2, "00", "ustar version");
	writeString(header, 345, 155, prefix, "ustar prefix");
	writeChecksum(header);
	return header;
}

function archivePadding(size) {
	const remainder = size % ARCHIVE_BLOCK_BYTES;
	return remainder === 0 ? 0 : ARCHIVE_BLOCK_BYTES - remainder;
}

function normaliseArchiveEntries(entries) {
	if (!Array.isArray(entries) || entries.length === 0) throw new Error("archive requires at least one entry");
	const byPath = new Map();
	for (const candidate of entries) {
		if (!candidate || typeof candidate !== "object") throw new Error("archive entry must be an object");
		const entryPath = assertSafeArchivePath(candidate.path);
		if (candidate.type !== "file" && candidate.type !== "directory") {
			throw new Error(`archive entry ${entryPath} has an unsupported type`);
		}
		const mode = candidate.type === "directory" ? DIRECTORY_MODE : FILE_MODE;
		if (candidate.mode !== undefined && candidate.mode !== mode) {
			throw new Error(`archive entry ${entryPath} has a non-canonical mode`);
		}
		if (byPath.has(entryPath)) throw new Error(`archive entry is duplicated: ${entryPath}`);
		byPath.set(entryPath, {
			path: entryPath,
			type: candidate.type,
			mode,
			content:
				candidate.type === "file"
					? asBuffer(candidate.content ?? Buffer.alloc(0), entryPath)
					: Buffer.alloc(0),
		});
	}
	for (const entry of [...byPath.values()]) {
		let parent = path.posix.dirname(entry.path);
		while (parent !== ".") {
			if (!byPath.has(parent)) {
				byPath.set(parent, {
					path: parent,
					type: "directory",
					mode: DIRECTORY_MODE,
					content: Buffer.alloc(0),
				});
			}
			parent = path.posix.dirname(parent);
		}
	}
	const normalised = [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path));
	assertNoFileEntryAncestors(normalised, "archive");
	return normalised;
}

function assertNoFileEntryAncestors(entries, label) {
	const files = new Set(entries.filter((entry) => entry.type === "file").map((entry) => entry.path));
	for (const entry of entries) {
		let parent = path.posix.dirname(entry.path);
		while (parent !== ".") {
			if (files.has(parent)) {
				throw new Error(`${label} file entry ${parent} cannot be an ancestor of ${entry.path}`);
			}
			parent = path.posix.dirname(parent);
		}
	}
}

export function createDeterministicTarGz(entries) {
	const normalised = normaliseArchiveEntries(entries);
	const parts = [];
	for (const entry of normalised) {
		parts.push(createUstarHeader(entry));
		if (entry.content.byteLength > 0) parts.push(entry.content);
		const padding = archivePadding(entry.content.byteLength);
		if (padding > 0) parts.push(Buffer.alloc(padding));
	}
	parts.push(Buffer.alloc(ARCHIVE_END_BYTES));
	const compressed = gzipSync(Buffer.concat(parts), { level: 9 });
	compressed.writeUInt32LE(ARCHIVE_MTIME, 4);
	compressed[9] = 255;
	return compressed;
}

export function inspectDeterministicTarGz(archive, options = {}) {
	const compressed = asBuffer(archive, "archive");
	if (
		compressed.byteLength < 10 ||
		compressed[0] !== 0x1f ||
		compressed[1] !== 0x8b ||
		compressed[2] !== 8 ||
		compressed[3] !== 0 ||
		compressed.readUInt32LE(4) !== ARCHIVE_MTIME ||
		compressed[8] !== 2 ||
		compressed[9] !== 255
	) {
		throw new Error("archive gzip header is not deterministic");
	}
	const entries = readGzipTarEntries(compressed);
	for (const entry of entries) {
		const { archivePath, gid, mode, mtime, size, type, uid, user, group } = {
			archivePath: entry.path,
			...entry,
		};
		if (uid !== 0 || gid !== 0)
			throw new Error(`archive entry ${archivePath} has non-root numeric ownership`);
		if (user || group) {
			throw new Error(`archive entry ${archivePath} has named ownership`);
		}
		if (mode !== (type === "directory" ? DIRECTORY_MODE : FILE_MODE)) {
			throw new Error(`archive entry ${archivePath} has a non-canonical mode`);
		}
		if (mtime !== ARCHIVE_MTIME)
			throw new Error(`archive entry ${archivePath} has a non-deterministic mtime`);
		if (type === "directory" && size !== 0) throw new Error(`archive directory ${archivePath} must be empty`);
	}
	assertNoFileEntryAncestors(entries, "archive");
	let previousPath;
	for (const entry of entries) {
		if (previousPath !== undefined && comparePaths(previousPath, entry.path) >= 0) {
			throw new Error("archive entries are not in deterministic path order");
		}
		previousPath = entry.path;
	}
	if (options.rootName) {
		const rootName = assertSafeArchivePath(options.rootName, "bundle root");
		if (entries[0]?.path !== rootName || entries[0]?.type !== "directory") {
			throw new Error("archive is missing its canonical bundle root");
		}
		if (entries.some((entry) => entry.path !== rootName && !entry.path.startsWith(`${rootName}/`))) {
			throw new Error("archive has entries outside its bundle root");
		}
	}
	return entries;
}

function readJson(filePath, label) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new Error(`Unable to read ${label}`, { cause: error });
	}
}

function packageTarballFileName(manifest) {
	if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
		throw new Error("package metadata requires a name and version");
	}
	return `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
}

function dependencyEntries(manifest) {
	return [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]
		.filter((value) => value && typeof value === "object")
		.flatMap((dependencies) => Object.entries(dependencies));
}

export function validateBundledPackageGraph(packages, expectedVersion) {
	if (!Array.isArray(packages) || packages.length !== PACKAGE_NAMES.length) {
		throw new Error("bundle must contain the complete package set");
	}
	const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
	for (const packageName of PACKAGE_NAMES) {
		if (!byName.has(packageName)) throw new Error(`bundle is missing ${packageName}`);
	}
	for (const entry of packages) {
		if (entry.manifest.version !== expectedVersion) {
			throw new Error(
				`Version drift: ${entry.manifest.name} is ${String(entry.manifest.version)}, expected ${expectedVersion}`,
			);
		}
		for (const [dependencyName] of dependencyEntries(entry.manifest)) {
			if (dependencyName.startsWith(INTERNAL_PACKAGE_PREFIX) && !byName.has(dependencyName)) {
				throw new Error(`${entry.manifest.name} depends on unbundled internal package ${dependencyName}`);
			}
		}
	}
	return byName;
}

export function createBundleRootManifest(packages, version) {
	const dependencies = {};
	for (const entry of [...packages].sort((left, right) =>
		comparePaths(left.manifest.name, right.manifest.name),
	)) {
		dependencies[entry.manifest.name] = `file:packages/${packageTarballFileName(entry.manifest)}`;
	}
	return {
		name: `pi-agent-web-${version}-bundle`,
		version,
		private: true,
		engines: { node: ">=22" },
		dependencies,
	};
}

function recordsMatch(actual, expected) {
	if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
	const actualEntries = Object.entries(actual);
	const expectedEntries = Object.entries(expected);
	return (
		actualEntries.length === expectedEntries.length &&
		expectedEntries.every(([key, value]) => actual[key] === value)
	);
}

function expectedInternalDependencies(rootManifest) {
	if (!rootManifest || typeof rootManifest !== "object" || typeof rootManifest.version !== "string") {
		throw new Error("bundle root manifest has no version");
	}
	const expected = Object.fromEntries(
		PACKAGE_NAMES.map((packageName) => {
			const archiveName = `${packageName.slice(1).replace("/", "-")}-${rootManifest.version}.tgz`;
			return [packageName, `file:packages/${archiveName}`];
		}),
	);
	if (!recordsMatch(rootManifest.dependencies, expected)) {
		throw new Error("bundle root manifest does not contain exact bundled dependencies");
	}
	return expected;
}

function assertCanonicalPublicResolution(packagePath, resolved) {
	if (typeof resolved !== "string" || resolved.length === 0 || resolved.trim() !== resolved) {
		throw new Error(`external package lock entry ${packagePath} is missing a resolution`);
	}
	let url;
	try {
		url = new URL(resolved);
	} catch {
		throw new Error(`external package lock entry ${packagePath} has a non-HTTPS resolution`);
	}
	if (
		url.protocol !== "https:" ||
		url.origin !== PUBLIC_NPM_REGISTRY_ORIGIN ||
		url.username.length > 0 ||
		url.password.length > 0 ||
		!url.pathname.includes("/-/") ||
		url.search.length > 0 ||
		url.hash.length > 0
	) {
		throw new Error(`external package lock entry ${packagePath} is not from the canonical public registry`);
	}
}

function assertExternalPackageLockEntry(packagePath, value) {
	if (
		typeof value.version !== "string" ||
		value.version.length === 0 ||
		value.version.trim() !== value.version
	) {
		throw new Error(`external package lock entry ${packagePath} is missing a package version`);
	}
	if (
		value.version.startsWith("workspace:") ||
		value.version.startsWith("file:") ||
		value.version.startsWith("link:") ||
		value.version.startsWith("git+")
	) {
		throw new Error(`external package lock entry ${packagePath} has a non-registry package spec`);
	}
	if (
		typeof value.integrity !== "string" ||
		value.integrity.length === 0 ||
		value.integrity.trim() !== value.integrity
	) {
		throw new Error(`external package lock entry ${packagePath} is missing an integrity`);
	}
	assertCanonicalPublicResolution(packagePath, value.resolved);
}

function internalTarballIntegrities(packages) {
	if (!Array.isArray(packages) || packages.length !== PACKAGE_NAMES.length) {
		throw new Error("bundle must contain every internal tarball before lock validation");
	}
	return new Map(
		packages.map((entry) => [
			entry.manifest.name,
			`sha512-${createHash("sha512").update(fs.readFileSync(entry.tarball)).digest("base64")}`,
		]),
	);
}

export function validateBundleLockfile(lockfile, rootManifest, { internalIntegrityByPackage } = {}) {
	if (
		!lockfile ||
		typeof lockfile !== "object" ||
		!lockfile.packages ||
		typeof lockfile.packages !== "object"
	) {
		throw new Error("generated package-lock.json has no packages map");
	}
	const rootPackage = lockfile.packages[""];
	if (!rootPackage || typeof rootPackage !== "object")
		throw new Error("generated package-lock.json has no root package");
	const expectedDependencies = expectedInternalDependencies(rootManifest);
	if (!recordsMatch(rootPackage.dependencies, expectedDependencies)) {
		throw new Error("generated package-lock.json does not preserve bundle-local dependencies");
	}
	if (rootPackage.link === true || rootPackage.resolved !== undefined) {
		throw new Error("generated package-lock.json root package must be metadata only");
	}
	const expectedEntries = new Map(
		Object.entries(expectedDependencies).map(([packageName, resolved]) => [
			`node_modules/${packageName}`,
			resolved,
		]),
	);
	const observedEntries = new Set();
	for (const [packagePath, value] of Object.entries(lockfile.packages)) {
		if (packagePath === "") continue;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`package lock entry ${packagePath} is not an object`);
		}
		const expected = expectedEntries.get(packagePath);
		if (expected) {
			if (value.link === true || value.resolved !== expected || value.version !== rootManifest.version) {
				throw new Error(`internal package lock entry ${packagePath} is not its bundled tarball`);
			}
			const packageName = packagePath.slice("node_modules/".length);
			const expectedIntegrity = internalIntegrityByPackage?.get(packageName);
			if (expectedIntegrity && value.integrity !== expectedIntegrity) {
				throw new Error(`internal package lock entry ${packagePath} has the wrong bundled tarball integrity`);
			}
			observedEntries.add(packagePath);
			continue;
		}
		if (packagePath.includes(`node_modules/${INTERNAL_PACKAGE_PREFIX}`)) {
			throw new Error(`unexpected internal package lock entry ${packagePath}`);
		}
		if (!packagePath.startsWith("node_modules/")) {
			throw new Error(`unexpected package lock entry ${packagePath}`);
		}
		if (value.link === true) {
			throw new Error(`external package lock entry ${packagePath} must not link outside the bundle`);
		}
		assertExternalPackageLockEntry(packagePath, value);
	}
	if (observedEntries.size !== expectedEntries.size) {
		throw new Error("generated package-lock.json is missing bundled package entries");
	}
}

function externalLockEntries(lockfile, rootManifest) {
	const internalPaths = new Set(
		Object.keys(expectedInternalDependencies(rootManifest)).map(
			(packageName) => `node_modules/${packageName}`,
		),
	);
	return Object.fromEntries(
		Object.entries(lockfile.packages)
			.filter(([packagePath]) => packagePath !== "" && !internalPaths.has(packagePath))
			.map(([packagePath, value]) => [packagePath, value]),
	);
}

/**
 * Release mode never asks npm to resolve a graph. It copies the reviewed graph
 * and changes only the exact local tarball integrity fields for this build.
 */
export function rebindFrozenBundleLockfile(frozenLockfile, rootManifest, packages) {
	validateBundleLockfile(frozenLockfile, rootManifest);
	const rebound = JSON.parse(JSON.stringify(frozenLockfile));
	const integrityByPackage = internalTarballIntegrities(packages);
	for (const [packageName, integrity] of integrityByPackage) {
		const packagePath = `node_modules/${packageName}`;
		const entry = rebound.packages[packagePath];
		if (!entry || typeof entry !== "object") {
			throw new Error(`frozen package-lock.json is missing ${packagePath}`);
		}
		entry.integrity = integrity;
	}
	if (
		JSON.stringify(externalLockEntries(frozenLockfile, rootManifest)) !==
		JSON.stringify(externalLockEntries(rebound, rootManifest))
	) {
		throw new Error("rebinding a frozen package-lock.json changed an external dependency");
	}
	validateBundleLockfile(rebound, rootManifest, { internalIntegrityByPackage: integrityByPackage });
	return rebound;
}

function isSameOrDescendant(candidatePath, parentPath) {
	return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}${path.sep}`);
}

function lstatOrNull(filePath, operations = fs) {
	try {
		return operations.lstatSync(filePath);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function assertOutputTargetIsSafe(destination, realRepositoryRoot, operations) {
	const ancestors = [];
	for (let candidate = destination; ; candidate = path.dirname(candidate)) {
		ancestors.push(candidate);
		if (path.dirname(candidate) === candidate) break;
	}
	for (const candidate of ancestors) {
		const stat = lstatOrNull(candidate, operations);
		if (!stat) continue;
		const realCandidate = operations.realpathSync(candidate);
		if (isSameOrDescendant(realCandidate, realRepositoryRoot)) {
			throw new Error("bundle output must stay outside the repository");
		}
		if (candidate === destination) {
			throw new Error(`refusing to overwrite existing bundle output: ${destination}`);
		}
		if (!stat.isDirectory() && !stat.isSymbolicLink()) {
			throw new Error(`bundle output ancestor is not a directory: ${candidate}`);
		}
	}
}

function writeGeneratedFile(filePath, content) {
	fs.writeFileSync(filePath, content, {
		encoding: Buffer.isBuffer(content) ? undefined : "utf8",
		flag: "wx",
		mode: FILE_MODE,
	});
	fs.chmodSync(filePath, FILE_MODE);
}

function fsyncFile(filePath, operations) {
	const descriptor = operations.openSync(filePath, "r");
	try {
		operations.fsyncSync(descriptor);
	} finally {
		operations.closeSync(descriptor);
	}
}

function fsyncDirectory(directory, operations) {
	const descriptor = operations.openSync(directory, "r");
	try {
		operations.fsyncSync(descriptor);
	} finally {
		operations.closeSync(descriptor);
	}
}

function writeStagedFile(filePath, content, operations) {
	const descriptor = operations.openSync(filePath, "wx", FILE_MODE);
	try {
		operations.writeFileSync(descriptor, content, {
			encoding: Buffer.isBuffer(content) ? undefined : "utf8",
		});
		operations.fchmodSync(descriptor, FILE_MODE);
		operations.fsyncSync(descriptor);
	} finally {
		operations.closeSync(descriptor);
	}
}

function sameNodeIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function removeOwnedDirectory(directory, identity, operations) {
	if (!identity) return;
	try {
		const current = operations.lstatSync(directory);
		if (sameNodeIdentity(current, identity)) operations.rmSync(directory, { recursive: true, force: true });
	} catch (error) {
		if (error?.code !== "ENOENT") {
			// Preserve the original publication failure and never remove a path
			// whose inode no longer proves this invocation created it.
		}
	}
}

/**
 * Publishes the archive/checksum set by renaming one fully written sibling
 * directory. The final target must not exist; dangling symlinks count as
 * occupied and no pre-existing target is ever removed during rollback.
 */
export function publishBundleOutputs({
	outputRoot,
	archiveName,
	archive,
	checksum,
	validate,
	operations = fs,
}) {
	const destination = path.resolve(outputRoot);
	if (lstatOrNull(destination, operations)) {
		throw new Error(`refusing to overwrite existing bundle output: ${destination}`);
	}
	const outputParent = path.dirname(destination);
	const parentStat = operations.lstatSync(outputParent);
	if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
		throw new Error("bundle output parent must be a real directory");
	}
	const stageRoot = `${destination}.staging`;
	if (lstatOrNull(stageRoot, operations)) {
		throw new Error(`refusing to publish concurrently to bundle output: ${destination}`);
	}
	try {
		operations.mkdirSync(stageRoot, { mode: DIRECTORY_MODE });
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new Error(`refusing to publish concurrently to bundle output: ${destination}`);
		}
		throw error;
	}
	const stageIdentity = operations.lstatSync(stageRoot);
	const stagedArchivePath = path.join(stageRoot, archiveName);
	const stagedChecksumPath = `${stagedArchivePath}.sha256`;
	let publishedIdentity;
	try {
		writeStagedFile(stagedArchivePath, archive, operations);
		writeStagedFile(stagedChecksumPath, checksum, operations);
		validate?.({ archivePath: stagedArchivePath, checksumPath: stagedChecksumPath });
		fsyncDirectory(stageRoot, operations);
		if (lstatOrNull(destination, operations)) {
			throw new Error(`refusing to overwrite existing bundle output: ${destination}`);
		}
		operations.renameSync(stageRoot, destination);
		publishedIdentity = operations.lstatSync(destination);
		fsyncDirectory(destination, operations);
		fsyncDirectory(outputParent, operations);
		return {
			archivePath: path.join(destination, archiveName),
			checksumPath: `${path.join(destination, archiveName)}.sha256`,
			outputRoot: destination,
		};
	} catch (error) {
		removeOwnedDirectory(destination, publishedIdentity, operations);
		throw error;
	} finally {
		removeOwnedDirectory(stageRoot, stageIdentity, operations);
	}
}

export function createSanitizedNpmEnvironment({ tempRoot, baseEnv = process.env }) {
	const configRoot = path.join(tempRoot, "npm-config");
	const userConfigPath = path.join(configRoot, "user.npmrc");
	const globalConfigPath = path.join(configRoot, "global.npmrc");
	const cachePath = path.join(configRoot, "cache");
	fs.mkdirSync(configRoot, { recursive: true, mode: DIRECTORY_MODE });
	fs.mkdirSync(cachePath, { recursive: true, mode: DIRECTORY_MODE });
	const registryConfig = `registry=${PUBLIC_NPM_REGISTRY}\n`;
	writeGeneratedFile(userConfigPath, registryConfig);
	writeGeneratedFile(globalConfigPath, registryConfig);
	const environment = Object.fromEntries(
		Object.entries(baseEnv).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
	);
	return {
		...environment,
		npm_config_cache: cachePath,
		npm_config_globalconfig: globalConfigPath,
		npm_config_registry: PUBLIC_NPM_REGISTRY,
		npm_config_userconfig: userConfigPath,
	};
}

function lockfileText(lockfile) {
	return `${JSON.stringify(lockfile, null, "\t")}\n`;
}

function sourcePnpmLockSha256(snapshotRoot) {
	const sourceLockfile = path.join(snapshotRoot, "pnpm-lock.yaml");
	if (!fs.lstatSync(sourceLockfile).isFile())
		throw new Error("immutable source snapshot has no pnpm-lock.yaml");
	return sha256File(sourceLockfile);
}

function createProvisionalDependencyLock({
	packages,
	rootManifest,
	snapshotRoot,
	stagingRoot,
	npmEnvironment,
}) {
	run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--omit=dev"], {
		cwd: stagingRoot,
		env: npmEnvironment,
	});
	const lockPath = path.join(stagingRoot, "package-lock.json");
	fs.chmodSync(lockPath, FILE_MODE);
	const lockBytes = fs.readFileSync(lockPath);
	const lockfile = readJson(lockPath, "provisional bundle package-lock.json");
	validateBundleLockfile(lockfile, rootManifest, {
		internalIntegrityByPackage: internalTarballIntegrities(packages),
	});
	return {
		lockfile,
		metadata: {
			kind: "provisional",
			packageLockSha256: sha256(lockBytes),
			sourcePnpmLockSha256: sourcePnpmLockSha256(snapshotRoot),
		},
	};
}

function consumeFrozenDependencyLock({
	frozenDependencyLock,
	packages,
	rootManifest,
	snapshotRoot,
	stagingRoot,
}) {
	if (typeof frozenDependencyLock !== "string" || frozenDependencyLock.length === 0) {
		throw new Error("release mode requires a pre-reviewed frozen npm dependency lock input");
	}
	const frozenPath = path.resolve(frozenDependencyLock);
	const frozenBytes = fs.readFileSync(frozenPath);
	let frozenLockfile;
	try {
		frozenLockfile = JSON.parse(frozenBytes.toString("utf8"));
	} catch (error) {
		throw new Error("unable to read the pre-reviewed frozen npm dependency lock", { cause: error });
	}
	const lockfile = rebindFrozenBundleLockfile(frozenLockfile, rootManifest, packages);
	const reboundBytes = Buffer.from(lockfileText(lockfile));
	writeGeneratedFile(path.join(stagingRoot, "package-lock.json"), reboundBytes);
	return {
		lockfile,
		metadata: {
			kind: "frozen",
			frozenNpmLockSha256: sha256(frozenBytes),
			packageLockSha256: sha256(reboundBytes),
			sourcePnpmLockSha256: sourcePnpmLockSha256(snapshotRoot),
		},
	};
}

function collectBundleEntries(bundleRoot) {
	const entries = [];
	const visit = (absolutePath, relativePath) => {
		const stat = fs.lstatSync(absolutePath);
		if (stat.isSymbolicLink()) throw new Error(`bundle staging tree contains a symlink: ${relativePath}`);
		if (stat.isDirectory()) {
			entries.push({ path: relativePath, type: "directory" });
			for (const name of fs.readdirSync(absolutePath).sort(comparePaths)) {
				visit(path.join(absolutePath, name), `${relativePath}/${name}`);
			}
			return;
		}
		if (!stat.isFile()) throw new Error(`bundle staging tree contains a non-file: ${relativePath}`);
		entries.push({ path: relativePath, type: "file", content: fs.readFileSync(absolutePath) });
	};
	visit(bundleRoot, path.basename(bundleRoot));
	return entries;
}

function createChecksums(bundleRoot) {
	const lines = [];
	const visit = (absolutePath, relativePath) => {
		for (const name of fs.readdirSync(absolutePath).sort(comparePaths)) {
			const nextAbsolute = path.join(absolutePath, name);
			const nextRelative = relativePath ? `${relativePath}/${name}` : name;
			const stat = fs.lstatSync(nextAbsolute);
			if (stat.isSymbolicLink()) throw new Error(`bundle checksum input is a symlink: ${nextRelative}`);
			if (stat.isDirectory()) visit(nextAbsolute, nextRelative);
			else if (stat.isFile() && nextRelative !== "SHA256SUMS")
				lines.push(`${sha256File(nextAbsolute)}  ${nextRelative}`);
			else throw new Error(`bundle checksum input is not a regular file: ${nextRelative}`);
		}
	};
	visit(bundleRoot, "");
	return `${lines.join("\n")}\n`;
}

function releaseSource(root) {
	const rootManifest = readJson(path.join(root, "package.json"), "root package.json");
	if (typeof rootManifest.version !== "string" || rootManifest.version.length === 0) {
		throw new Error("root package.json has no version");
	}
	const packageManifests = PACKAGE_NAMES.map((packageName) => {
		const packageDirectory = packageName.slice(packageName.indexOf("/") + 1);
		return readJson(
			path.join(root, "packages", packageDirectory, "package.json"),
			`${packageName} package.json`,
		);
	});
	const repositoryUrl = packageManifests[0]?.repository?.url;
	if (typeof repositoryUrl !== "string" || repositoryUrl.length === 0) {
		throw new Error("package metadata is missing a repository URL");
	}
	if (packageManifests.some((manifest) => manifest.repository?.url !== repositoryUrl)) {
		throw new Error("package repository metadata drifts across packages");
	}
	const piVersion = packageManifests.find((manifest) => manifest.name === "@pi-agent-web/server")
		?.dependencies?.["@earendil-works/pi-coding-agent"];
	if (typeof piVersion !== "string" || piVersion.length === 0)
		throw new Error("server package has no bundled Pi version");
	const protocolSource = fs.readFileSync(
		path.join(root, "packages/protocol/src/gateway-handshake.ts"),
		"utf8",
	);
	const protocolMatch = protocolSource.match(
		/GATEWAY_PROTOCOL_VERSION\s*=\s*\{\s*major:\s*(\d+),\s*minor:\s*(\d+)\s*\}/,
	);
	if (!protocolMatch) throw new Error("unable to read the Gateway protocol version");
	return {
		piVersion,
		protocolVersion: `${protocolMatch[1]}.${protocolMatch[2]}`,
		repositoryUrl,
		version: rootManifest.version,
	};
}

export function requireCleanCommit(root = REPOSITORY_ROOT) {
	const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root });
	if (status.trim()) throw new Error("release bundle generation requires a clean commit");
	const commit = run("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Git did not return a full commit SHA");
	return commit;
}

export function captureSourceIdentity(root = REPOSITORY_ROOT) {
	const commit = requireCleanCommit(root);
	const tree = run("git", ["rev-parse", `${commit}^{tree}`], { cwd: root }).trim();
	if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error("Git did not return a full source tree SHA");
	return { commit, tree };
}

export function createImmutableSourceSnapshot({ root = REPOSITORY_ROOT, sourceCommit, destinationRoot }) {
	if (!/^[0-9a-f]{40}$/.test(sourceCommit))
		throw new Error("immutable source snapshot requires a full commit SHA");
	if (lstatOrNull(destinationRoot))
		throw new Error("immutable source snapshot destination must not already exist");
	const result = spawnSync("git", ["archive", "--format=tar", sourceCommit], {
		cwd: root,
		encoding: null,
		maxBuffer: 128 * 1024 * 1024,
		stdio: "pipe",
	});
	if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
		throw new Error(`git archive ${sourceCommit} failed: ${result.stderr?.toString("utf8") ?? ""}`);
	}
	extractTarEntries(readTarEntries(result.stdout), destinationRoot);
	return destinationRoot;
}

function buildImmutableSourceSnapshot(snapshotRoot, npmEnvironment) {
	run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], {
		cwd: snapshotRoot,
		env: npmEnvironment,
		timeoutMs: 300_000,
	});
	run("pnpm", ["-r", "build"], { cwd: snapshotRoot, env: npmEnvironment, timeoutMs: 300_000 });
}

function revalidateSourceIdentity({ root, sourceCommit, sourceTree, mode, source, tag }) {
	const current = captureSourceIdentity(root);
	if (current.commit !== sourceCommit || current.tree !== sourceTree) {
		throw new Error("source commit or tree changed while the release bundle was being prepared");
	}
	if (mode === "release") verifyReleaseTag({ root, tag, version: source.version, sourceCommit });
}

export function verifyReleaseTag({ root = REPOSITORY_ROOT, tag, version, sourceCommit }) {
	if (typeof tag !== "string" || !/^v[0-9A-Za-z.+-]+$/.test(tag))
		throw new Error("release mode requires a safe v-prefixed tag");
	if (tag !== `v${version}`) throw new Error(`release tag ${tag} does not match package version ${version}`);
	const reference = `refs/tags/${tag}`;
	if (run("git", ["cat-file", "-t", reference], { cwd: root }).trim() !== "tag") {
		throw new Error(`release tag ${tag} must be an annotated tag, not a lightweight tag`);
	}
	const taggedCommit = run("git", ["rev-parse", `${tag}^{commit}`], { cwd: root }).trim();
	if (taggedCommit !== sourceCommit) throw new Error(`release tag ${tag} does not point at ${sourceCommit}`);
}

function toolchain() {
	return {
		node: process.version,
		npm: run("npm", ["--version"]).trim(),
		pnpm: run("pnpm", ["--version"]).trim(),
	};
}

function createBundleManifest({
	bundleName,
	dependencyLock,
	packages,
	source,
	sourceCommit,
	sourceTree,
	tag,
}) {
	return {
		schemaVersion: 1,
		integrity: {
			algorithm: "SHA-256",
			statement:
				"Checksums provide integrity only; they are not a signature, attestation, or provenance claim.",
		},
		bundle: {
			install: "npm ci --omit=dev --ignore-scripts",
			name: bundleName,
			version: source.version,
		},
		source: { commit: sourceCommit, tree: sourceTree, tag: tag ?? null },
		dependencyLock,
		toolchain: toolchain(),
		runtime: { piVersion: source.piVersion, gatewayProtocol: source.protocolVersion },
		packages: packages.map((entry) => ({
			name: entry.manifest.name,
			version: entry.manifest.version,
			file: `packages/${packageTarballFileName(entry.manifest)}`,
			sha256: sha256File(entry.tarball),
			bytes: fs.statSync(entry.tarball).size,
		})),
	};
}

function createInstallInstructions(bundleName) {
	return [
		`# ${bundleName}`,
		"",
		"Requires Node.js >=22, npm, and public network access to the npm registry for third-party dependencies.",
		"This bundle installs the included Pi Agent Web packages and resolves third-party dependencies from that registry.",
		"It is not offline or self-contained.",
		"",
		"```sh",
		"npm ci --omit=dev --ignore-scripts",
		"npx --no-install pi-web",
		"```",
		"",
	].join("\n");
}

export function prepareOutputDirectory(outputDir, root = REPOSITORY_ROOT, operations = fs) {
	const realRepositoryRoot = operations.realpathSync(root);
	const destination =
		outputDir === undefined
			? path.join(os.tmpdir(), `piweb-release-bundle-${randomUUID()}`)
			: path.resolve(outputDir);
	// Validate all existing ancestors before creating either the output target or
	// its sibling stage. This prevents a symlinked parent from creating files in
	// the repository before containment can be checked.
	assertOutputTargetIsSafe(destination, realRepositoryRoot, operations);
	return destination;
}

export function createReleaseBundle({
	mode = "candidate",
	outputDir,
	root = REPOSITORY_ROOT,
	tag,
	frozenDependencyLock,
} = {}) {
	if (mode !== "candidate" && mode !== "release") throw new Error(`unknown bundle mode: ${mode}`);
	if (mode === "candidate" && tag !== undefined)
		throw new Error("candidate bundles must not claim a release tag");
	if (mode === "candidate" && frozenDependencyLock !== undefined) {
		throw new Error("candidate bundles must create a provisional dependency lock proposal");
	}
	if (mode === "release" && (typeof frozenDependencyLock !== "string" || frozenDependencyLock.length === 0)) {
		throw new Error("release mode requires a pre-reviewed frozen npm dependency lock input");
	}
	const { commit: sourceCommit, tree: sourceTree } = captureSourceIdentity(root);

	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-release-bundle-staging-"));
	try {
		const snapshotRoot = createImmutableSourceSnapshot({
			root,
			sourceCommit,
			destinationRoot: path.join(tempRoot, "source"),
		});
		const source = releaseSource(snapshotRoot);
		if (mode === "release") verifyReleaseTag({ root, tag, version: source.version, sourceCommit });
		const npmEnvironment = createSanitizedNpmEnvironment({ tempRoot });
		buildImmutableSourceSnapshot(snapshotRoot, npmEnvironment);
		const tarballDir = path.join(tempRoot, "tarballs");
		const tarballs = packWorkspacePackages({ root: snapshotRoot, tarballDir, env: npmEnvironment });
		const packages = inspectPackageTarballs(tarballs, { repositoryUrl: source.repositoryUrl });
		validateBundledPackageGraph(packages, source.version);

		const bundleName = `pi-agent-web-v${source.version}`;
		const stagingRoot = path.join(tempRoot, bundleName);
		const packagesRoot = path.join(stagingRoot, "packages");
		fs.mkdirSync(packagesRoot, { recursive: true, mode: DIRECTORY_MODE });
		const rootManifest = createBundleRootManifest(packages, source.version);
		writeGeneratedFile(
			path.join(stagingRoot, "package.json"),
			`${JSON.stringify(rootManifest, null, "\t")}\n`,
		);
		for (const entry of packages) {
			const destination = path.join(packagesRoot, packageTarballFileName(entry.manifest));
			fs.copyFileSync(entry.tarball, destination, fs.constants.COPYFILE_EXCL);
			fs.chmodSync(destination, FILE_MODE);
		}
		writeGeneratedFile(path.join(stagingRoot, "INSTALL.md"), createInstallInstructions(bundleName));
		fs.copyFileSync(
			path.join(snapshotRoot, "LICENSE"),
			path.join(stagingRoot, "LICENSE"),
			fs.constants.COPYFILE_EXCL,
		);
		fs.chmodSync(path.join(stagingRoot, "LICENSE"), FILE_MODE);
		const dependencyLock =
			mode === "candidate"
				? createProvisionalDependencyLock({
						packages,
						rootManifest,
						snapshotRoot,
						stagingRoot,
						npmEnvironment,
					})
				: consumeFrozenDependencyLock({
						frozenDependencyLock,
						packages,
						rootManifest,
						snapshotRoot,
						stagingRoot,
					});
		const manifest = createBundleManifest({
			bundleName,
			dependencyLock: dependencyLock.metadata,
			packages,
			source,
			sourceCommit,
			sourceTree,
			tag: mode === "release" ? tag : undefined,
		});
		writeGeneratedFile(
			path.join(stagingRoot, "bundle-manifest.json"),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		);
		writeGeneratedFile(path.join(stagingRoot, "SHA256SUMS"), createChecksums(stagingRoot));

		const archiveName = `${bundleName}.tar.gz`;
		const archive = createDeterministicTarGz(collectBundleEntries(stagingRoot));
		inspectDeterministicTarGz(archive, { rootName: bundleName });
		revalidateSourceIdentity({ root, sourceCommit, sourceTree, mode, source, tag });
		const outputRoot = prepareOutputDirectory(outputDir, root);
		const {
			archivePath,
			checksumPath,
			outputRoot: publishedOutputRoot,
		} = publishBundleOutputs({
			outputRoot,
			archiveName,
			archive,
			checksum: `${sha256(archive)}  ${archiveName}\n`,
			validate: ({ archivePath: stagedArchivePath, checksumPath: stagedChecksumPath }) => {
				const stagedArchive = fs.readFileSync(stagedArchivePath);
				inspectDeterministicTarGz(stagedArchive, { rootName: bundleName });
				const expectedChecksum = `${sha256(stagedArchive)}  ${archiveName}\n`;
				if (fs.readFileSync(stagedChecksumPath, "utf8") !== expectedChecksum) {
					throw new Error("staged bundle checksum does not match its archive");
				}
			},
		});
		return { archivePath, checksumPath, manifest, outputRoot: publishedOutputRoot };
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

function parseCliArguments(argv) {
	let mode = "candidate";
	let outputDir;
	let tag;
	let frozenDependencyLock;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--candidate") {
			mode = "candidate";
			continue;
		}
		if (argument === "--release") {
			mode = "release";
			continue;
		}
		if (argument === "--output" || argument === "--tag" || argument === "--frozen-lock") {
			const value = argv[index + 1];
			if (!value) throw new Error(`${argument} requires a value`);
			if (argument === "--output") outputDir = value;
			else if (argument === "--tag") tag = value;
			else frozenDependencyLock = value;
			index += 1;
			continue;
		}
		throw new Error(`unknown argument: ${argument}`);
	}
	return { mode, outputDir, tag, frozenDependencyLock };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = createReleaseBundle(parseCliArguments(process.argv.slice(2)));
		console.log(`RELEASE BUNDLE OK: ${result.archivePath}`);
		console.log(`SHA-256: ${result.checksumPath}`);
	} catch (error) {
		process.exitCode = 1;
		console.error("RELEASE BUNDLE ERROR:", error);
	}
}
