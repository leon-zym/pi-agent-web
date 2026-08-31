import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
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
	return [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path));
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

function readNullTerminatedString(buffer, offset, byteLength) {
	const raw = buffer.subarray(offset, offset + byteLength);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? raw.byteLength : end).toString("utf8");
}

function readOctal(buffer, offset, byteLength, label) {
	const raw = readNullTerminatedString(buffer, offset, byteLength).trim();
	if (!/^[0-7]+$/.test(raw)) throw new Error(`${label} is not a valid octal value`);
	const value = Number.parseInt(raw, 8);
	if (!Number.isSafeInteger(value)) throw new Error(`${label} is outside the safe integer range`);
	return value;
}

function validateHeaderChecksum(header) {
	const expected = readOctal(header, 148, 8, "ustar checksum");
	const copy = Buffer.from(header);
	copy.fill(0x20, 148, 156);
	let actual = 0;
	for (const byte of copy) actual += byte;
	if (expected !== actual) throw new Error("ustar header checksum is invalid");
}

function isZeroBlock(block) {
	return block.every((byte) => byte === 0);
}

export function inspectDeterministicTarGz(archive, options = {}) {
	const compressed = asBuffer(archive, "archive");
	if (
		compressed.byteLength < 10 ||
		compressed[0] !== 0x1f ||
		compressed[1] !== 0x8b ||
		compressed[2] !== 8 ||
		compressed.readUInt32LE(4) !== ARCHIVE_MTIME ||
		compressed[9] !== 255
	) {
		throw new Error("archive gzip header is not deterministic");
	}
	let unpacked;
	try {
		unpacked = gunzipSync(compressed);
	} catch (error) {
		throw new Error("archive is not a valid gzip stream", { cause: error });
	}
	const entries = [];
	let offset = 0;
	let terminated = false;
	while (offset + ARCHIVE_BLOCK_BYTES <= unpacked.byteLength) {
		const header = unpacked.subarray(offset, offset + ARCHIVE_BLOCK_BYTES);
		if (isZeroBlock(header)) {
			if (
				offset + ARCHIVE_END_BYTES > unpacked.byteLength ||
				!isZeroBlock(unpacked.subarray(offset + ARCHIVE_BLOCK_BYTES, offset + ARCHIVE_END_BYTES))
			) {
				throw new Error("archive must end with two zero blocks");
			}
			if (!unpacked.subarray(offset).every((byte) => byte === 0))
				throw new Error("archive has data after its terminator");
			terminated = true;
			break;
		}
		validateHeaderChecksum(header);
		if (readNullTerminatedString(header, 257, 6) !== "ustar") throw new Error("archive entry is not ustar");
		const typeFlag = header[156];
		const type =
			typeFlag === 0 || typeFlag === "0".charCodeAt(0)
				? "file"
				: typeFlag === "5".charCodeAt(0)
					? "directory"
					: null;
		if (!type) throw new Error("archive contains an unsupported entry type");
		const name = readNullTerminatedString(header, 0, 100);
		const prefix = readNullTerminatedString(header, 345, 155);
		const archivePath = `${prefix ? `${prefix}/` : ""}${name}`.replace(/\/$/, "");
		assertSafeArchivePath(archivePath);
		const mode = readOctal(header, 100, 8, `archive mode for ${archivePath}`);
		const uid = readOctal(header, 108, 8, `archive uid for ${archivePath}`);
		const gid = readOctal(header, 116, 8, `archive gid for ${archivePath}`);
		const size = readOctal(header, 124, 12, `archive size for ${archivePath}`);
		const mtime = readOctal(header, 136, 12, `archive mtime for ${archivePath}`);
		if (uid !== 0 || gid !== 0)
			throw new Error(`archive entry ${archivePath} has non-root numeric ownership`);
		if (readNullTerminatedString(header, 265, 32) || readNullTerminatedString(header, 297, 32)) {
			throw new Error(`archive entry ${archivePath} has named ownership`);
		}
		if (mode !== (type === "directory" ? DIRECTORY_MODE : FILE_MODE)) {
			throw new Error(`archive entry ${archivePath} has a non-canonical mode`);
		}
		if (mtime !== ARCHIVE_MTIME)
			throw new Error(`archive entry ${archivePath} has a non-deterministic mtime`);
		if (type === "directory" && size !== 0) throw new Error(`archive directory ${archivePath} must be empty`);
		const contentStart = offset + ARCHIVE_BLOCK_BYTES;
		const contentEnd = contentStart + size;
		if (contentEnd > unpacked.byteLength)
			throw new Error(`archive entry ${archivePath} exceeds archive bounds`);
		entries.push({
			path: archivePath,
			type,
			mode,
			size,
			content: Buffer.from(unpacked.subarray(contentStart, contentEnd)),
		});
		offset = contentEnd + archivePadding(size);
	}
	if (!terminated) throw new Error("archive is missing its terminator");
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

function assertBundleLockfile(lockfile, rootManifest) {
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
	if (JSON.stringify(rootPackage.dependencies) !== JSON.stringify(rootManifest.dependencies)) {
		throw new Error("generated package-lock.json does not preserve bundle-local dependencies");
	}
	for (const [packagePath, value] of Object.entries(lockfile.packages)) {
		if (!packagePath.includes("node_modules/@pi-agent-web/")) continue;
		if (!value || typeof value !== "object" || value.link === true || typeof value.resolved !== "string") {
			throw new Error(`internal package lock entry ${packagePath} is not a bundled tarball`);
		}
		const packageName = `@pi-agent-web/${packagePath.split("node_modules/@pi-agent-web/").at(-1)}`;
		const expected = rootManifest.dependencies[packageName];
		if (!expected || value.resolved !== expected) {
			throw new Error(`internal package lock entry ${packagePath} does not resolve to ${String(expected)}`);
		}
	}
	for (const [packageName, resolved] of Object.entries(rootManifest.dependencies)) {
		const lockEntry = lockfile.packages[`node_modules/${packageName}`];
		if (!lockEntry || lockEntry.resolved !== resolved || lockEntry.link === true) {
			throw new Error(`bundle package ${packageName} does not resolve to its local tgz`);
		}
	}
}

function assertOutsideRepository(candidatePath, root) {
	const resolvedCandidate = path.resolve(candidatePath);
	const resolvedRoot = path.resolve(root);
	if (resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
		throw new Error("bundle output must stay outside the repository");
	}
	return resolvedCandidate;
}

function writeGeneratedFile(filePath, content) {
	fs.writeFileSync(filePath, content, {
		encoding: Buffer.isBuffer(content) ? undefined : "utf8",
		flag: "wx",
		mode: FILE_MODE,
	});
	fs.chmodSync(filePath, FILE_MODE);
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

function createBundleManifest({ bundleName, packages, source, sourceCommit, tag }) {
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
		source: { commit: sourceCommit, tag: tag ?? null },
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
		"This bundle installs the included Pi Agent Web packages and resolves third-party dependencies from the npm registry.",
		"It is not offline or self-contained.",
		"",
		"```sh",
		"npm ci --omit=dev --ignore-scripts",
		"npx --no-install pi-web",
		"```",
		"",
	].join("\n");
}

function prepareOutputDirectory(outputDir, root) {
	if (outputDir === undefined) return fs.mkdtempSync(path.join(os.tmpdir(), "piweb-release-bundle-"));
	const destination = assertOutsideRepository(outputDir, root);
	fs.mkdirSync(destination, { recursive: true, mode: DIRECTORY_MODE });
	if (fs.lstatSync(destination).isSymbolicLink())
		throw new Error("bundle output directory must not be a symlink");
	return destination;
}

export function createReleaseBundle({ mode = "candidate", outputDir, root = REPOSITORY_ROOT, tag } = {}) {
	if (mode !== "candidate" && mode !== "release") throw new Error(`unknown bundle mode: ${mode}`);
	const source = releaseSource(root);
	const sourceCommit = requireCleanCommit(root);
	if (mode === "release") verifyReleaseTag({ root, tag, version: source.version, sourceCommit });
	if (mode === "candidate" && tag !== undefined)
		throw new Error("candidate bundles must not claim a release tag");

	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-release-bundle-staging-"));
	try {
		const tarballDir = path.join(tempRoot, "tarballs");
		const tarballs = packWorkspacePackages({ root, tarballDir });
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
			path.join(root, "LICENSE"),
			path.join(stagingRoot, "LICENSE"),
			fs.constants.COPYFILE_EXCL,
		);
		fs.chmodSync(path.join(stagingRoot, "LICENSE"), FILE_MODE);
		run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--omit=dev"], {
			cwd: stagingRoot,
			env: { ...process.env, npm_config_registry: PUBLIC_NPM_REGISTRY },
		});
		fs.chmodSync(path.join(stagingRoot, "package-lock.json"), FILE_MODE);
		assertBundleLockfile(
			readJson(path.join(stagingRoot, "package-lock.json"), "bundle package-lock.json"),
			rootManifest,
		);
		const manifest = createBundleManifest({
			bundleName,
			packages,
			source,
			sourceCommit,
			tag: mode === "release" ? tag : undefined,
		});
		writeGeneratedFile(
			path.join(stagingRoot, "bundle-manifest.json"),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		);
		writeGeneratedFile(path.join(stagingRoot, "SHA256SUMS"), createChecksums(stagingRoot));

		const outputRoot = prepareOutputDirectory(outputDir, root);
		const archiveName = `${bundleName}.tar.gz`;
		const archivePath = path.join(outputRoot, archiveName);
		const checksumPath = `${archivePath}.sha256`;
		if (fs.existsSync(archivePath) || fs.existsSync(checksumPath)) {
			throw new Error(`refusing to overwrite existing bundle output in ${outputRoot}`);
		}
		const archive = createDeterministicTarGz(collectBundleEntries(stagingRoot));
		inspectDeterministicTarGz(archive, { rootName: bundleName });
		writeGeneratedFile(archivePath, archive);
		writeGeneratedFile(checksumPath, `${sha256(archive)}  ${archiveName}\n`);
		return { archivePath, checksumPath, manifest, outputRoot };
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

function parseCliArguments(argv) {
	let mode = "candidate";
	let outputDir;
	let tag;
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
		if (argument === "--output" || argument === "--tag") {
			const value = argv[index + 1];
			if (!value) throw new Error(`${argument} requires a value`);
			if (argument === "--output") outputDir = value;
			else tag = value;
			index += 1;
			continue;
		}
		throw new Error(`unknown argument: ${argument}`);
	}
	return { mode, outputDir, tag };
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
