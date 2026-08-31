import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createDeterministicTarGz,
	extractTarEntries,
	inspectDeterministicTarGz,
	readTarEntries,
} from "./lib/archive.mjs";
import {
	inspectPackageTarballs,
	PACKAGE_NAMES,
	packWorkspacePackages,
	REPOSITORY_ROOT,
	resolveTrustedPackageManagerToolchain,
	run,
	sha256,
	sha256File,
} from "./lib/package-smoke.mjs";

export {
	assertSafeArchivePath,
	createDeterministicTarGz,
	inspectDeterministicTarGz,
} from "./lib/archive.mjs";

const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const PUBLIC_NPM_REGISTRY_ORIGIN = new URL(PUBLIC_NPM_REGISTRY).origin;
const INTERNAL_PACKAGE_PREFIX = "@pi-agent-web/";

function comparePaths(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
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

function assertSha512Integrity(packagePath, integrity) {
	if (typeof integrity !== "string" || integrity.trim() !== integrity) {
		throw new Error(`package lock entry ${packagePath} has an invalid sha512 integrity`);
	}
	const match = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
	if (!match) throw new Error(`package lock entry ${packagePath} has an invalid sha512 integrity`);
	const decoded = Buffer.from(match[1], "base64");
	if (decoded.byteLength !== 64 || decoded.toString("base64") !== match[1]) {
		throw new Error(`package lock entry ${packagePath} has an invalid sha512 integrity`);
	}
}

function packageNameFromLockPath(packagePath) {
	if (typeof packagePath !== "string" || packagePath.length === 0) {
		throw new Error("package lock entry has an invalid path");
	}
	const segments = packagePath.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new Error(`package lock entry ${packagePath} has an invalid path`);
	}
	const marker = segments.lastIndexOf("node_modules");
	if (marker === -1 || marker === segments.length - 1) {
		throw new Error(`unexpected package lock entry ${packagePath}`);
	}
	const nameSegments = segments.slice(marker + 1);
	const expectedLength = nameSegments[0].startsWith("@") ? 2 : 1;
	if (
		nameSegments.length !== expectedLength ||
		(nameSegments[0].startsWith("@") && (nameSegments[0].length === 1 || !nameSegments[1]))
	) {
		throw new Error(`unexpected package lock entry ${packagePath}`);
	}
	return nameSegments.join("/");
}

function assertNoSensitiveLockMetadata(value, packagePath) {
	const visit = (candidate, fieldPath) => {
		if (!candidate || typeof candidate !== "object") return;
		for (const [key, nested] of Object.entries(candidate)) {
			const nestedPath = `${fieldPath}.${key}`;
			if (/(?:auth|token|password|credential|proxy|registry)/i.test(key)) {
				throw new Error(`package lock entry ${packagePath} contains a forbidden ${nestedPath} field`);
			}
			if (
				[
					"dependencies",
					"optionalDependencies",
					"peerDependencies",
					"peerDependenciesMeta",
					"bin",
					"engines",
				].includes(key)
			) {
				// These maps are keyed by package names or executable names. A legal
				// package such as @aws-sdk/credential-provider-node is not a config
				// field and must not be treated as a credential leak.
				continue;
			}
			visit(nested, nestedPath);
		}
	};
	visit(value, "entry");
}

function npmAliasTarget(specifier) {
	if (typeof specifier !== "string" || !specifier.startsWith("npm:")) return null;
	const target = specifier.slice("npm:".length);
	const match = target.match(/^(@[^/@]+\/[^/@]+|[^/@]+)(?:@.*)?$/);
	if (!match) throw new Error(`package dependency alias has an invalid target: ${specifier}`);
	return match[1];
}

function assertInternalDependencySpecs(packagePath, value, expectedDependencies) {
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		if (value[field] === undefined) continue;
		if (!value[field] || typeof value[field] !== "object" || Array.isArray(value[field])) {
			throw new Error(`package lock entry ${packagePath} has invalid ${field}`);
		}
		for (const [declaredName, specifier] of Object.entries(value[field])) {
			if (typeof specifier !== "string" || specifier.trim() !== specifier) {
				throw new Error(`package lock entry ${packagePath} has an invalid dependency spec`);
			}
			const aliasTarget = npmAliasTarget(specifier);
			const targetName = aliasTarget ?? declaredName;
			if (!targetName.startsWith(INTERNAL_PACKAGE_PREFIX)) continue;
			if (!Object.hasOwn(expectedDependencies, targetName)) {
				throw new Error(`package lock entry ${packagePath} references an unbundled internal package`);
			}
			if (aliasTarget) {
				throw new Error(`package lock entry ${packagePath} aliases an internal package`);
			}
		}
	}
}

function assertExternalPackageLockEntry(
	packagePath,
	value,
	expectedDependencies,
	{ allowMissingIntegrity = false } = {},
) {
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
	if (value.integrity === undefined && allowMissingIntegrity) {
		// Candidate generation may hydrate this exact canonical tarball below.
	} else {
		assertSha512Integrity(packagePath, value.integrity);
	}
	assertCanonicalPublicResolution(packagePath, value.resolved);
	assertInternalDependencySpecs(packagePath, value, expectedDependencies);
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

export function validateBundleLockfile(
	lockfile,
	rootManifest,
	{ internalIntegrityByPackage, allowMissingExternalIntegrity = false } = {},
) {
	if (
		!lockfile ||
		typeof lockfile !== "object" ||
		Array.isArray(lockfile) ||
		lockfile.lockfileVersion !== 3 ||
		lockfile.requires !== true ||
		lockfile.name !== rootManifest?.name ||
		lockfile.version !== rootManifest?.version ||
		Object.keys(lockfile).some(
			(key) => !["name", "version", "lockfileVersion", "requires", "packages"].includes(key),
		) ||
		Object.hasOwn(lockfile, "dependencies") ||
		!lockfile.packages ||
		typeof lockfile.packages !== "object"
	) {
		throw new Error("package-lock.json is not the supported complete v3 shape");
	}
	const rootPackage = lockfile.packages[""];
	if (!rootPackage || typeof rootPackage !== "object")
		throw new Error("generated package-lock.json has no root package");
	const expectedDependencies = expectedInternalDependencies(rootManifest);
	if (
		Object.keys(rootPackage).some((key) => !["name", "version", "engines", "dependencies"].includes(key)) ||
		rootPackage.name !== rootManifest.name ||
		rootPackage.version !== rootManifest.version ||
		!recordsMatch(rootPackage.engines, rootManifest.engines)
	) {
		throw new Error("generated package-lock.json root package has unexpected metadata");
	}
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
		assertNoSensitiveLockMetadata(value, packagePath);
		const pathPackageName = packageNameFromLockPath(packagePath);
		if (value.name !== undefined && value.name !== pathPackageName) {
			throw new Error(`package lock entry ${packagePath} has an ambiguous package identity`);
		}
		const expected = expectedEntries.get(packagePath);
		if (pathPackageName.startsWith(INTERNAL_PACKAGE_PREFIX)) {
			if (!expected || packagePath !== `node_modules/${pathPackageName}`) {
				throw new Error(`unexpected internal package lock entry ${packagePath}`);
			}
			if (value.link === true || value.resolved !== expected || value.version !== rootManifest.version) {
				throw new Error(`internal package lock entry ${packagePath} is not its bundled tarball`);
			}
			assertSha512Integrity(packagePath, value.integrity);
			const expectedIntegrity = internalIntegrityByPackage?.get(pathPackageName);
			if (expectedIntegrity && value.integrity !== expectedIntegrity) {
				throw new Error(`internal package lock entry ${packagePath} has the wrong bundled tarball integrity`);
			}
			assertInternalDependencySpecs(packagePath, value, expectedDependencies);
			observedEntries.add(packagePath);
			continue;
		}
		if (value.link === true) {
			throw new Error(`external package lock entry ${packagePath} must not link outside the bundle`);
		}
		assertExternalPackageLockEntry(packagePath, value, expectedDependencies, {
			allowMissingIntegrity: allowMissingExternalIntegrity,
		});
	}
	if (observedEntries.size !== expectedEntries.size) {
		throw new Error("generated package-lock.json is missing bundled package entries");
	}
}

function minimalNodeFetchEnvironment() {
	const environment = {};
	if (typeof process.env.PATH === "string" && process.env.PATH.length > 0) {
		environment.PATH = process.env.PATH;
	}
	if (process.platform === "win32" && typeof process.env.SystemRoot === "string") {
		environment.SystemRoot = process.env.SystemRoot;
	}
	return environment;
}

function fetchCanonicalTarball(resolved) {
	const program = [
		"const response = await fetch(process.argv[1], { redirect: 'error' });",
		"if (!response.ok) throw new Error('public tarball fetch failed');",
		"process.stdout.write(Buffer.from(await response.arrayBuffer()));",
	].join("\n");
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", program, resolved], {
		encoding: null,
		stdio: ["ignore", "pipe", "pipe"],
		env: minimalNodeFetchEnvironment(),
		timeout: 120_000,
		maxBuffer: 128 * 1024 * 1024,
	});
	if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.byteLength === 0) {
		throw new Error("unable to fetch a canonical public dependency tarball for provisional lock hydration");
	}
	return result.stdout;
}

/**
 * Candidate mode may add missing integrity fields by downloading only the
 * already-validated canonical public tarballs. Release mode never calls this.
 */
export function hydrateProvisionalBundleLockfile(
	lockfile,
	rootManifest,
	{ fetchTarball = fetchCanonicalTarball } = {},
) {
	validateBundleLockfile(lockfile, rootManifest, { allowMissingExternalIntegrity: true });
	const hydrated = JSON.parse(JSON.stringify(lockfile));
	for (const [packagePath, value] of Object.entries(hydrated.packages)) {
		if (packagePath === "" || value.integrity !== undefined) continue;
		const packageName = packageNameFromLockPath(packagePath);
		if (packageName.startsWith(INTERNAL_PACKAGE_PREFIX)) {
			throw new Error(`internal package lock entry ${packagePath} is missing its bundled tarball integrity`);
		}
		assertCanonicalPublicResolution(packagePath, value.resolved);
		const tarball = fetchTarball(value.resolved);
		if (!Buffer.isBuffer(tarball) && !(tarball instanceof Uint8Array)) {
			throw new Error(`provisional lock hydration did not return bytes for ${packagePath}`);
		}
		value.integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
	}
	validateBundleLockfile(hydrated, rootManifest);
	return hydrated;
}

function nonRebindableLockState(lockfile, rootManifest) {
	const state = JSON.parse(JSON.stringify(lockfile));
	for (const packageName of Object.keys(expectedInternalDependencies(rootManifest))) {
		delete state.packages[`node_modules/${packageName}`].integrity;
	}
	return state;
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
		JSON.stringify(nonRebindableLockState(frozenLockfile, rootManifest)) !==
		JSON.stringify(nonRebindableLockState(rebound, rootManifest))
	) {
		throw new Error("rebinding a frozen package-lock.json changed a non-local dependency graph field");
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

function bindOutputLocation(destination, realRepositoryRoot, operations) {
	const resolvedDestination = path.resolve(destination);
	if (lstatOrNull(resolvedDestination, operations)) {
		throw new Error(`refusing to overwrite existing bundle output: ${resolvedDestination}`);
	}
	const lexicalParent = path.dirname(resolvedDestination);
	const parentStat = lstatOrNull(lexicalParent, operations);
	if (!parentStat) {
		throw new Error("bundle output parent must already exist");
	}
	if (!parentStat.isDirectory() && !parentStat.isSymbolicLink()) {
		throw new Error(`bundle output ancestor is not a directory: ${lexicalParent}`);
	}
	for (let candidate = lexicalParent; ; candidate = path.dirname(candidate)) {
		const stat = lstatOrNull(candidate, operations);
		if (stat) {
			if (!stat.isDirectory() && !stat.isSymbolicLink()) {
				throw new Error(`bundle output ancestor is not a directory: ${candidate}`);
			}
			const realCandidate = operations.realpathSync(candidate);
			if (isSameOrDescendant(realCandidate, realRepositoryRoot)) {
				throw new Error("bundle output must stay outside the repository");
			}
		}
		if (path.dirname(candidate) === candidate) break;
	}
	const canonicalParent = operations.realpathSync(lexicalParent);
	const canonicalParentStat = operations.lstatSync(canonicalParent);
	if (canonicalParentStat.isSymbolicLink() || !canonicalParentStat.isDirectory()) {
		throw new Error("bundle output parent must resolve to a real directory");
	}
	return {
		destination: path.join(canonicalParent, path.basename(resolvedDestination)),
		parent: canonicalParent,
		parentIdentity: canonicalParentStat,
	};
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

function assertBoundOutputParent(location, operations) {
	const current = operations.lstatSync(location.parent);
	if (
		!sameNodeIdentity(current, location.parentIdentity) ||
		current.isSymbolicLink() ||
		!current.isDirectory()
	) {
		throw new Error("bundle output parent changed while publishing");
	}
}

function removeOwnedDirectory(directory, identity, location, operations) {
	if (!identity) return;
	try {
		assertBoundOutputParent(location, operations);
		const current = operations.lstatSync(directory);
		if (sameNodeIdentity(current, identity)) operations.rmSync(directory, { recursive: true, force: true });
	} catch (error) {
		if (error?.code !== "ENOENT") {
			// Preserve the original publication failure and never remove a path
			// whose inode no longer proves this invocation created it.
		}
	}
}

function assertArchiveName(archiveName) {
	if (
		typeof archiveName !== "string" ||
		archiveName.length === 0 ||
		archiveName !== path.basename(archiveName) ||
		archiveName.includes("\0")
	) {
		throw new Error("bundle archive name must be a plain filename");
	}
}

function publishStagedFile(stagedPath, finalPath, operations) {
	if (lstatOrNull(finalPath, operations)) {
		throw new Error(`refusing to overwrite an occupied bundle member: ${finalPath}`);
	}
	// link+unlink provides portable no-replace publication for a file within
	// our exclusively-created directory. Unlike rename(2), it cannot replace a
	// name created by a concurrent writer between the check and publication.
	operations.linkSync(stagedPath, finalPath);
	operations.unlinkSync(stagedPath);
	fsyncFile(finalPath, operations);
}

export const BUNDLE_READY_MARKER = "READY";

export function assertCommittedBundleOutput({ outputRoot, archiveName, operations = fs }) {
	assertArchiveName(archiveName);
	const destination = path.resolve(outputRoot);
	const destinationStat = operations.lstatSync(destination);
	if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
		throw new Error("bundle output is not a real directory");
	}
	const archivePath = path.join(destination, archiveName);
	const checksumPath = `${archivePath}.sha256`;
	const readyPath = path.join(destination, BUNDLE_READY_MARKER);
	const archive = operations.readFileSync(archivePath);
	const expectedChecksum = `${sha256(archive)}  ${archiveName}\n`;
	if (operations.readFileSync(checksumPath, "utf8") !== expectedChecksum) {
		throw new Error("bundle output checksum does not match its archive");
	}
	if (operations.readFileSync(readyPath, "utf8") !== expectedChecksum) {
		throw new Error("bundle output is not committed");
	}
	return { archivePath, checksumPath, outputRoot: destination };
}

/**
 * Reserves the final directory with mkdir(O_EXCL semantics), stages members
 * inside it, and writes READY only after the checksum/archive pair is durable.
 * No pre-existing destination is renamed over or removed.
 */
export function publishBundleOutputs({
	outputRoot,
	archiveName,
	archive,
	checksum,
	validate,
	repositoryRoot = REPOSITORY_ROOT,
	operations = fs,
}) {
	assertArchiveName(archiveName);
	const realRepositoryRoot = operations.realpathSync(repositoryRoot);
	const location = bindOutputLocation(outputRoot, realRepositoryRoot, operations);
	const { destination } = location;
	assertBoundOutputParent(location, operations);
	try {
		operations.mkdirSync(destination, { mode: DIRECTORY_MODE });
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new Error(`refusing to overwrite existing bundle output: ${destination}`);
		}
		throw error;
	}
	const publishedIdentity = operations.lstatSync(destination);
	if (publishedIdentity.isSymbolicLink() || !publishedIdentity.isDirectory()) {
		throw new Error("bundle output reservation is not a real directory");
	}
	if (
		operations.realpathSync(destination) !== destination ||
		operations.readdirSync(destination).length !== 0
	) {
		removeOwnedDirectory(destination, publishedIdentity, location, operations);
		throw new Error("bundle output reservation changed while it was being created");
	}
	const archivePath = path.join(destination, archiveName);
	const checksumPath = `${archivePath}.sha256`;
	const stagedArchivePath = path.join(destination, `.${archiveName}.archive-stage`);
	const stagedChecksumPath = path.join(destination, `.${archiveName}.checksum-stage`);
	const readyPath = path.join(destination, BUNDLE_READY_MARKER);
	try {
		writeStagedFile(stagedArchivePath, archive, operations);
		writeStagedFile(stagedChecksumPath, checksum, operations);
		validate?.({ archivePath: stagedArchivePath, checksumPath: stagedChecksumPath });
		fsyncDirectory(destination, operations);
		assertBoundOutputParent(location, operations);
		publishStagedFile(stagedArchivePath, archivePath, operations);
		publishStagedFile(stagedChecksumPath, checksumPath, operations);
		fsyncDirectory(destination, operations);
		writeStagedFile(readyPath, `${sha256(archive)}  ${archiveName}\n`, operations);
		fsyncDirectory(destination, operations);
		assertBoundOutputParent(location, operations);
		fsyncDirectory(location.parent, operations);
		return assertCommittedBundleOutput({ outputRoot: destination, archiveName, operations });
	} catch (error) {
		removeOwnedDirectory(destination, publishedIdentity, location, operations);
		throw error;
	}
}

function createOwnedDirectory(directory) {
	fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
	const stat = fs.lstatSync(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`release tool environment path is not a real directory: ${directory}`);
	}
}

const SAFE_BUILD_ENVIRONMENT_KEYS = new Set([
	"LANG",
	"LC_ALL",
	"TZ",
	"SystemRoot",
	"SYSTEMROOT",
	"ComSpec",
	"COMSPEC",
	"PATHEXT",
	"WINDIR",
]);

function safeBuildRuntimePath() {
	const candidates =
		process.platform === "win32"
			? [path.dirname(process.execPath), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
			: [
					path.dirname(process.execPath),
					"/opt/homebrew/bin",
					"/usr/local/bin",
					"/System/Cryptexes/App/usr/bin",
					"/usr/bin",
					"/bin",
					"/usr/sbin",
					"/sbin",
				];
	return [
		...new Set(
			candidates
				.map((candidate) => {
					const stat = lstatOrNull(candidate);
					return stat?.isDirectory() && !stat.isSymbolicLink() ? fs.realpathSync(candidate) : null;
				})
				.filter(Boolean),
		),
	].join(path.delimiter);
}

function isForbiddenBuildEnvironmentKey(key) {
	const normalized = key.toLowerCase();
	return (
		normalized.startsWith("npm_config_") ||
		normalized.startsWith("pnpm_config_") ||
		normalized === "npm_token" ||
		normalized === "node_auth_token" ||
		/(?:auth|token|password|credential|proxy|registry)/i.test(key)
	);
}

export function assertSafeProjectNpmrc(root) {
	const projectConfig = path.join(root, ".npmrc");
	const stat = lstatOrNull(projectConfig);
	if (!stat) return;
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error("project .npmrc must be an absent regular file for release builds");
	}
	const meaningfulLines = fs
		.readFileSync(projectConfig, "utf8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith(";"));
	if (meaningfulLines.length > 0) {
		throw new Error("project .npmrc is not allowed in an isolated release build");
	}
}

export function createSanitizedNpmEnvironment({ tempRoot, baseEnv = process.env }) {
	const configRoot = path.join(tempRoot, "npm-config");
	const homePath = path.join(configRoot, "home");
	const userConfigPath = path.join(configRoot, "user.npmrc");
	const globalConfigPath = path.join(configRoot, "global.npmrc");
	const cachePath = path.join(configRoot, "npm-cache");
	const prefixPath = path.join(configRoot, "npm-prefix");
	const pnpmStorePath = path.join(configRoot, "pnpm-store");
	const pnpmHomePath = path.join(configRoot, "pnpm-home");
	const corepackHomePath = path.join(configRoot, "corepack-home");
	const xdgConfigPath = path.join(configRoot, "xdg-config");
	for (const directory of [
		configRoot,
		homePath,
		cachePath,
		prefixPath,
		pnpmStorePath,
		pnpmHomePath,
		corepackHomePath,
		xdgConfigPath,
	]) {
		createOwnedDirectory(directory);
	}
	const registryConfig = `registry=${PUBLIC_NPM_REGISTRY}\n`;
	writeGeneratedFile(userConfigPath, registryConfig);
	writeGeneratedFile(globalConfigPath, registryConfig);
	const environment = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (isForbiddenBuildEnvironmentKey(key) || !SAFE_BUILD_ENVIRONMENT_KEYS.has(key)) continue;
		environment[key] = value;
	}
	return {
		...environment,
		PATH: safeBuildRuntimePath(),
		COREPACK_HOME: corepackHomePath,
		HOME: homePath,
		PNPM_HOME: pnpmHomePath,
		XDG_CACHE_HOME: cachePath,
		XDG_CONFIG_HOME: xdgConfigPath,
		npm_config_cache: cachePath,
		npm_config_globalconfig: globalConfigPath,
		npm_config_prefix: prefixPath,
		npm_config_registry: PUBLIC_NPM_REGISTRY,
		npm_config_userconfig: userConfigPath,
		pnpm_config_store_dir: pnpmStorePath,
		...(process.platform === "win32" ? { USERPROFILE: homePath } : {}),
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
	trustedToolchain,
}) {
	run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--omit=dev"], {
		cwd: stagingRoot,
		env: npmEnvironment,
		toolchain: trustedToolchain,
	});
	const lockPath = path.join(stagingRoot, "package-lock.json");
	const proposedLockfile = readJson(lockPath, "provisional bundle package-lock.json");
	const lockfile = hydrateProvisionalBundleLockfile(proposedLockfile, rootManifest);
	fs.writeFileSync(lockPath, lockfileText(lockfile), { encoding: "utf8", flag: "w", mode: FILE_MODE });
	fs.chmodSync(lockPath, FILE_MODE);
	const lockBytes = fs.readFileSync(lockPath);
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

function buildImmutableSourceSnapshot(snapshotRoot, npmEnvironment, trustedToolchain) {
	run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], {
		cwd: snapshotRoot,
		env: npmEnvironment,
		toolchain: trustedToolchain,
		timeoutMs: 300_000,
	});
	run("pnpm", ["-r", "build"], {
		cwd: snapshotRoot,
		env: npmEnvironment,
		toolchain: trustedToolchain,
		timeoutMs: 300_000,
	});
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

function createBundleManifest({
	bundleName,
	dependencyLock,
	packages,
	source,
	sourceCommit,
	sourceTree,
	tag,
	trustedToolchain,
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
		toolchain: trustedToolchain,
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
	return bindOutputLocation(destination, realRepositoryRoot, operations).destination;
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
	const trustedToolchain = resolveTrustedPackageManagerToolchain({ repositoryRoot: root });

	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-release-bundle-staging-"));
	try {
		const snapshotRoot = createImmutableSourceSnapshot({
			root,
			sourceCommit,
			destinationRoot: path.join(tempRoot, "source"),
		});
		assertSafeProjectNpmrc(snapshotRoot);
		const source = releaseSource(snapshotRoot);
		if (mode === "release") verifyReleaseTag({ root, tag, version: source.version, sourceCommit });
		const npmEnvironment = createSanitizedNpmEnvironment({ tempRoot });
		buildImmutableSourceSnapshot(snapshotRoot, npmEnvironment, trustedToolchain);
		const tarballDir = path.join(tempRoot, "tarballs");
		const tarballs = packWorkspacePackages({
			root: snapshotRoot,
			tarballDir,
			env: npmEnvironment,
			toolchain: trustedToolchain,
		});
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
						trustedToolchain,
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
			trustedToolchain,
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
