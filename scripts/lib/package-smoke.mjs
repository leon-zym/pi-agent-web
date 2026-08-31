import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractTarEntries, readGzipTarEntries } from "./archive.mjs";

export const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

export const PACKAGE_NAMES = [
	"@pi-agent-web/protocol",
	"@pi-agent-web/server",
	"@pi-agent-web/ui",
	"@pi-agent-web/cli",
];

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function sha256File(filePath) {
	return sha256(fs.readFileSync(filePath));
}

export function run(command, args, options = {}) {
	const { cwd = REPOSITORY_ROOT, env = process.env, timeoutMs = 120_000, toolchain } = options;
	const invocation =
		toolchain?.[command] ??
		(command === "npm" || command === "npx" || command === "pnpm"
			? resolvePackageManagerCommand(command, { env })
			: { command, argsPrefix: [] });
	const result = spawnSync(invocation.command, [...invocation.argsPrefix, ...args], {
		cwd,
		env,
		encoding: "utf8",
		stdio: "pipe",
		timeout: timeoutMs,
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	}
	return result.stdout ?? "";
}

export function packageManifest(tarball, options = {}) {
	const entries = readPackageTarball(tarball, options);
	return packageManifestFromEntries(entries, tarball);
}

export function listTarballEntries(tarball, options = {}) {
	return archiveEntryNames(readPackageTarball(tarball, options));
}

function readPackageTarball(tarball) {
	return readGzipTarEntries(fs.readFileSync(tarball));
}

function archiveEntryNames(entries) {
	return entries.map((entry) => (entry.type === "directory" ? `${entry.path}/` : entry.path));
}

function packageManifestFromEntries(entries, tarball) {
	const entry = entries.find(
		(candidate) => candidate.path === "package/package.json" && candidate.type === "file",
	);
	if (!entry) throw new Error(`Missing package/package.json in ${path.basename(tarball)}`);
	try {
		return JSON.parse(entry.content.toString("utf8"));
	} catch (error) {
		throw new Error(`Invalid package/package.json in ${path.basename(tarball)}`, { cause: error });
	}
}

function hasPackageFile(entries, directory) {
	const prefix = `package/${directory}/`;
	return entries.some((entry) => entry.startsWith(prefix) && !entry.endsWith("/"));
}

function hasPackagePath(entries, directory) {
	const prefix = `package/${directory}/`;
	return entries.some((entry) => entry === prefix || entry.startsWith(prefix));
}

export function inspectPackageTarballs(tarballs, options = {}) {
	const { repositoryUrl = "git+https://github.com/leon-zym/pi-agent-web.git" } = options;
	if (tarballs.length !== PACKAGE_NAMES.length) {
		throw new Error(`Expected ${String(PACKAGE_NAMES.length)} tarballs, found ${String(tarballs.length)}`);
	}
	const expectedNames = new Set(PACKAGE_NAMES);
	const inspected = tarballs
		.map((tarball) => {
			const archiveEntries = readPackageTarball(tarball);
			const entries = archiveEntryNames(archiveEntries);
			if (!hasPackageFile(entries, "dist")) {
				throw new Error(`Missing dist directory in ${path.basename(tarball)}`);
			}
			if (!entries.includes("package/LICENSE")) {
				throw new Error(`Missing LICENSE in ${path.basename(tarball)}`);
			}
			if (hasPackagePath(entries, "src")) {
				throw new Error(`Source directory leaked into ${path.basename(tarball)}`);
			}
			const manifest = packageManifestFromEntries(archiveEntries, tarball);
			if (manifest.license !== "MIT" || manifest.repository?.url !== repositoryUrl) {
				throw new Error(`Missing publish metadata in ${path.basename(tarball)}`);
			}
			if (JSON.stringify(manifest).includes("workspace:")) {
				throw new Error(`Workspace dependency leaked into ${path.basename(tarball)}`);
			}
			if (!expectedNames.delete(manifest.name)) {
				throw new Error(
					`Unexpected or duplicate package ${String(manifest.name)} in ${path.basename(tarball)}`,
				);
			}
			if (typeof manifest.version !== "string" || manifest.version.length === 0) {
				throw new Error(`Package ${String(manifest.name)} has no version`);
			}
			return { entries, manifest, tarball };
		})
		.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
	if (expectedNames.size > 0) {
		throw new Error(`Missing packaged modules: ${[...expectedNames].join(", ")}`);
	}
	return inspected;
}

export function packWorkspacePackages({ root = REPOSITORY_ROOT, tarballDir, env = process.env, toolchain }) {
	fs.mkdirSync(tarballDir, { recursive: true });
	for (const packageName of PACKAGE_NAMES) {
		run("pnpm", ["--filter", packageName, "pack", "--pack-destination", tarballDir], {
			cwd: root,
			env,
			toolchain,
		});
	}
	return fs
		.readdirSync(tarballDir)
		.filter((entry) => entry.endsWith(".tgz"))
		.sort((left, right) => left.localeCompare(right))
		.map((entry) => path.join(tarballDir, entry));
}

export function installTarballs({ tarballs, installDir }) {
	fs.mkdirSync(installDir, { recursive: true });
	fs.writeFileSync(path.join(installDir, "package.json"), '{"name":"piweb-pack-smoke","private":true}\n', {
		flag: "wx",
	});
	run("npm", ["install", "--ignore-scripts", ...tarballs], { cwd: installDir });
}

export function installedBin(installDir, name = "pi-web") {
	return path.join(installDir, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

export function installedCliEntry(installDir) {
	return path.join(installDir, "node_modules", "@pi-agent-web", "cli", "dist", "cli.js");
}

function childHasExited(child) {
	return child.exitCode !== null || child.signalCode !== null;
}

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function processGroupExists(processGroupId) {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function signalProcessGroup(processGroupId, signal) {
	try {
		process.kill(-processGroupId, signal);
		return true;
	} catch {
		return false;
	}
}

function taskkillProcessTree(rootPid, timeoutMs) {
	const result = spawnSync("taskkill", ["/PID", String(rootPid), "/T", "/F"], {
		encoding: "utf8",
		stdio: "pipe",
		timeout: timeoutMs,
	});
	return result.status === 0 && !result.error;
}

function defaultOwnedProcessOperations() {
	return {
		platform: process.platform,
		now: () => Date.now(),
		processExists,
		processGroupExists,
		signalProcessGroup,
		sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
		taskkillProcessTree,
	};
}

/**
 * Records a process-tree identity at spawn. A detached POSIX child owns a
 * group whose saved PGID is its original leader PID; that identity is never
 * inferred again from a later PID lookup.
 */
export function createOwnedProcessTree(child, { detached = false, operations = {} } = {}) {
	if (!child || typeof child.once !== "function")
		throw new Error("owned process tree requires a child process");
	const ownedOperations = { ...defaultOwnedProcessOperations(), ...operations };
	const leaderPid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
	const processGroupId =
		ownedOperations.platform !== "win32" && detached && leaderPid !== null ? leaderPid : null;
	const tree = {
		child,
		leaderPid,
		processGroupId,
		leaderExitObserved: childHasExited(child),
		operations: ownedOperations,
	};
	child.once("exit", () => {
		tree.leaderExitObserved = true;
	});
	return tree;
}

function savedGroupState(tree) {
	const { leaderPid, processGroupId, leaderExitObserved, operations } = tree;
	if (leaderPid === null || processGroupId === null || leaderPid !== processGroupId) {
		throw new Error("owned POSIX process group identity was not established at spawn");
	}
	const groupAlive = operations.processGroupExists(processGroupId);
	const reused = leaderExitObserved && operations.processExists(leaderPid);
	return { groupAlive, reused };
}

function signalSavedProcessGroup(tree, signal) {
	const state = savedGroupState(tree);
	if (state.reused) throw new Error("saved process-group identity is no longer valid after leader exit");
	if (!state.groupAlive) return false;
	if (!tree.operations.signalProcessGroup(tree.processGroupId, signal)) {
		throw new Error(`unable to signal owned process group with ${signal}`);
	}
	return true;
}

async function waitForSavedProcessGroupExit(tree, timeoutMs, pollIntervalMs) {
	const deadline = tree.operations.now() + timeoutMs;
	for (;;) {
		const state = savedGroupState(tree);
		if (!state.groupAlive) return { exited: true, reused: false };
		if (state.reused) return { exited: false, reused: true };
		const now = tree.operations.now();
		if (now >= deadline) return { exited: false, reused: false };
		await tree.operations.sleep(Math.min(pollIntervalMs, deadline - now));
	}
}

async function terminatePosixOwnedProcessTree(tree, { termTimeoutMs, killTimeoutMs, pollIntervalMs }) {
	const exitedBeforeShutdown = tree.leaderExitObserved || childHasExited(tree.child);
	const initialState = savedGroupState(tree);
	if (initialState.reused) {
		throw new Error("saved process-group identity is no longer valid after leader exit");
	}
	if (initialState.groupAlive) {
		signalSavedProcessGroup(tree, "SIGTERM");
		let result = await waitForSavedProcessGroupExit(tree, termTimeoutMs, pollIntervalMs);
		if (result.reused) throw new Error("saved process-group identity is no longer valid after leader exit");
		if (!result.exited) {
			signalSavedProcessGroup(tree, "SIGKILL");
			result = await waitForSavedProcessGroupExit(tree, killTimeoutMs, pollIntervalMs);
			if (result.reused) throw new Error("saved process-group identity is no longer valid after leader exit");
			if (!result.exited) throw new Error("owned packaged process group did not exit after SIGKILL");
		}
	}
	if (exitedBeforeShutdown) {
		throw new Error("packaged CLI exited before controlled shutdown; owned descendants were cleaned first");
	}
}

async function waitForWindowsRootExit(tree, timeoutMs, pollIntervalMs) {
	const deadline = tree.operations.now() + timeoutMs;
	for (;;) {
		if (!tree.operations.processExists(tree.leaderPid)) return true;
		const now = tree.operations.now();
		if (now >= deadline) return false;
		await tree.operations.sleep(Math.min(pollIntervalMs, deadline - now));
	}
}

async function terminateWindowsOwnedProcessTree(tree, { termTimeoutMs, killTimeoutMs, pollIntervalMs }) {
	const exitedBeforeShutdown = tree.leaderExitObserved || childHasExited(tree.child);
	if (tree.leaderPid === null || exitedBeforeShutdown || !tree.operations.processExists(tree.leaderPid)) {
		throw new Error("cannot prove Windows process-tree cleanup after early root exit");
	}
	if (!tree.operations.taskkillProcessTree(tree.leaderPid, termTimeoutMs + killTimeoutMs)) {
		throw new Error("bounded Windows taskkill process-tree cleanup failed");
	}
	if (!(await waitForWindowsRootExit(tree, termTimeoutMs + killTimeoutMs, pollIntervalMs))) {
		throw new Error("Windows process-tree root did not exit after taskkill");
	}
}

/**
 * Terminates only the tree identity captured by createOwnedProcessTree. POSIX
 * never falls back to a positive PID after the original leader exits.
 */
export async function terminateOwnedProcessTree(tree, options = {}) {
	if (!tree?.operations) throw new Error("owned process tree is required");
	const { termTimeoutMs = 2_000, killTimeoutMs = 2_000, pollIntervalMs = 25 } = options;
	if (
		!Number.isSafeInteger(termTimeoutMs) ||
		!Number.isSafeInteger(killTimeoutMs) ||
		!Number.isSafeInteger(pollIntervalMs) ||
		termTimeoutMs < 0 ||
		killTimeoutMs < 0 ||
		pollIntervalMs <= 0
	) {
		throw new Error("owned process-tree timeouts must be bounded positive integers");
	}
	if (tree.operations.platform === "win32") {
		await terminateWindowsOwnedProcessTree(tree, { termTimeoutMs, killTimeoutMs, pollIntervalMs });
		return;
	}
	await terminatePosixOwnedProcessTree(tree, { termTimeoutMs, killTimeoutMs, pollIntervalMs });
}

function spawnOwnedProcess({ command, args, cwd, detached, env }) {
	const child = spawn(command, args, {
		cwd,
		detached,
		stdio: ["ignore", "pipe", "pipe"],
		env,
	});
	return createOwnedProcessTree(child, { detached });
}

export function launchInstalledCli({ installDir, args, cwd, detached = false, env }) {
	return spawnOwnedProcess({
		command: process.execPath,
		args: [installedCliEntry(installDir), ...args],
		cwd,
		detached,
		env,
	});
}

export function installedNpxCommand({ args, env, invocation }) {
	const npxInvocation = invocation ?? resolvePackageManagerCommand("npx", { env });
	return {
		command: npxInvocation.command,
		args: [...npxInvocation.argsPrefix, "--no-install", "pi-web", ...args],
	};
}

export function launchInstalledNpx({ args, cwd, detached = false, env, invocation }) {
	const command = installedNpxCommand({ args, env, invocation });
	return spawnOwnedProcess({
		command: command.command,
		args: command.args,
		cwd,
		detached,
		env,
	});
}

export function waitForOutput(child, pattern, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(
			() => reject(new Error(`CLI did not print ${String(pattern)}:\n${output}`)),
			timeoutMs,
		);
		const onData = (chunk) => {
			output += chunk.toString();
			const match = output.match(pattern);
			if (!match) return;
			clearTimeout(timer);
			child.stdout.off("data", onData);
			resolve(match);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.once("error", reject);
	});
}

export function waitForSocket(socket, setup, timeoutMessage, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => {
			try {
				socket.terminate();
			} finally {
				finish(new Error(timeoutMessage));
			}
		}, timeoutMs);
		setup(finish);
	});
}

function isWithin(candidate, parent) {
	return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function assertRegularDirectory(directory, label) {
	const stat = fs.lstatSync(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory`);
	return fs.realpathSync(directory);
}

export function assertInstalledProductIsolation({ installDir, repositoryRoot = REPOSITORY_ROOT }) {
	const realInstallDir = assertRegularDirectory(installDir, "installed bundle root");
	const realRepositoryRoot = fs.realpathSync(repositoryRoot);
	if (isWithin(realInstallDir, realRepositoryRoot)) {
		throw new Error("installed product must run outside the workspace");
	}
	const nodeModules = assertRegularDirectory(path.join(installDir, "node_modules"), "installed node_modules");
	if (!isWithin(nodeModules, realInstallDir))
		throw new Error("installed node_modules escapes the bundle root");
	for (const packageName of PACKAGE_NAMES) {
		const packagePath = path.join(installDir, "node_modules", ...packageName.split("/"));
		const stat = fs.lstatSync(packagePath);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`installed package ${packageName} must not be a symlink`);
		}
		const realPackagePath = fs.realpathSync(packagePath);
		if (!isWithin(realPackagePath, realInstallDir)) {
			throw new Error(`installed package ${packageName} escapes the bundle root`);
		}
	}
	return realInstallDir;
}

export function extractBundleArchive({ archivePath, destinationDir, bundleName }) {
	fs.mkdirSync(destinationDir, { recursive: true });
	assertRegularDirectory(destinationDir, "bundle extraction directory");
	extractTarEntries(readGzipTarEntries(fs.readFileSync(archivePath)), destinationDir);
	const bundleRoot = path.join(destinationDir, bundleName);
	assertRegularDirectory(bundleRoot, "extracted bundle root");
	return bundleRoot;
}

export function installBundle({ bundleRoot, env = process.env, toolchain }) {
	run("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
		cwd: bundleRoot,
		env,
		toolchain,
	});
}

export function resolveExecutable(name, pathValue = process.env.PATH, { platform = process.platform } = {}) {
	const candidates = resolveExecutableCandidates(name, pathValue, { platform });
	if (candidates.length > 0) return candidates[0];
	throw new Error(`Unable to resolve ${name} from PATH`);
}

function resolveExecutableCandidates(name, pathValue, { platform = process.platform } = {}) {
	if (typeof pathValue !== "string" || pathValue.length === 0) throw new Error(`PATH cannot resolve ${name}`);
	const suffixes = platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
	const delimiter = platform === "win32" ? ";" : path.delimiter;
	const candidates = [];
	const seen = new Set();
	for (const directory of pathValue.split(delimiter)) {
		if (!directory) continue;
		for (const suffix of suffixes) {
			const candidate = path.join(directory, `${name}${suffix}`);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				const resolved = path.resolve(candidate);
				if (!seen.has(resolved)) {
					seen.add(resolved);
					candidates.push(candidate);
				}
			} catch {
				// Try the next directory or platform suffix.
			}
		}
	}
	return candidates;
}

function readWindowsCommandEntrypoint(commandPath) {
	const wrapper = fs.readFileSync(commandPath, "utf8");
	const match = wrapper.match(/"(?:%~dp0|%dp0%)\\([^"\r\n]+\.(?:c?js|mjs))"/i);
	if (!match) throw new Error(`cannot safely resolve Node entrypoint from ${path.basename(commandPath)}`);
	const relativeEntry = match[1].replaceAll("\\", path.sep);
	if (
		path.isAbsolute(relativeEntry) ||
		relativeEntry.split(path.sep).some((segment) => segment === "..") ||
		!relativeEntry.startsWith(`node_modules${path.sep}`)
	) {
		throw new Error(`unsafe Node entrypoint in ${path.basename(commandPath)}`);
	}
	return path.join(path.dirname(commandPath), relativeEntry);
}

/**
 * Uses a direct Node entrypoint for npm-family .cmd wrappers on Windows rather
 * than building a shell command string. Other platforms execute the resolved
 * binary directly.
 */
export function resolvePackageManagerCommand(
	name,
	{ env = process.env, platform = process.platform, executableResolver = resolveExecutable } = {},
) {
	if (name !== "npm" && name !== "npx" && name !== "pnpm") {
		throw new Error(`unsupported package-manager command: ${name}`);
	}
	const commandPath = executableResolver(name, env.PATH, { platform });
	if (platform !== "win32" || path.extname(commandPath).toLowerCase() !== ".cmd") {
		return { command: commandPath, argsPrefix: [] };
	}
	return { command: process.execPath, argsPrefix: [readWindowsCommandEntrypoint(commandPath)] };
}

function pathIsWithin(candidate, parent) {
	return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function realpathOrNull(candidate) {
	try {
		return fs.realpathSync(candidate);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function lstatOrNull(candidate) {
	try {
		return fs.lstatSync(candidate);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function trustedRuntimeEnvironment(baseEnv = process.env) {
	const environment = {};
	for (const key of [
		"PATH",
		"LANG",
		"LC_ALL",
		"TZ",
		"SystemRoot",
		"SYSTEMROOT",
		"ComSpec",
		"COMSPEC",
		"PATHEXT",
		"WINDIR",
	]) {
		if (typeof baseEnv[key] === "string" && baseEnv[key].length > 0) environment[key] = baseEnv[key];
	}
	return environment;
}

function assertTrustedToolPath(candidate, { workspaceRoots, temporaryRoots, label }) {
	const lexical = path.resolve(candidate);
	const stat = fs.lstatSync(lexical);
	if (stat.isDirectory()) throw new Error(`${label} must be an executable file`);
	const real = fs.realpathSync(lexical);
	const prohibitedRoots = [...workspaceRoots, ...temporaryRoots]
		.map((root) => realpathOrNull(root))
		.filter(Boolean);
	if (
		isNodeModulesBinDirectory(path.dirname(lexical)) ||
		isNodeModulesBinDirectory(path.dirname(real)) ||
		prohibitedRoots.some((root) => pathIsWithin(lexical, root) || pathIsWithin(real, root))
	) {
		throw new Error(`${label} resolves through an untrusted workspace or temporary path`);
	}
	return real;
}

function packageManagerEntryPath(invocation, trustedNode, details) {
	if (invocation.command === process.execPath && invocation.argsPrefix.length === 1) {
		return assertTrustedToolPath(invocation.argsPrefix[0], details);
	}
	const canonicalCommand = assertTrustedToolPath(invocation.command, details);
	if (!/\.(?:c?js|mjs)$/i.test(canonicalCommand)) {
		throw new Error(`${details.label} must resolve to a canonical Node CLI entrypoint`);
	}
	if (!trustedNode) throw new Error("trusted Node executable is required");
	return canonicalCommand;
}

function packageBinDeclaration(manifest, commandName) {
	if (typeof manifest?.bin === "string") return manifest.bin;
	if (!manifest?.bin || typeof manifest.bin !== "object" || Array.isArray(manifest.bin)) return null;
	return typeof manifest.bin[commandName] === "string" ? manifest.bin[commandName] : null;
}

function packageOwnsNodeEntrypoint(entryPath, packageName, commandName) {
	for (let packageRoot = path.dirname(entryPath); ; packageRoot = path.dirname(packageRoot)) {
		const manifestPath = path.join(packageRoot, "package.json");
		let manifest;
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		} catch {
			manifest = null;
		}
		if (manifest?.name === packageName) {
			const declaration = packageBinDeclaration(manifest, commandName);
			if (typeof declaration !== "string" || declaration.length === 0) return false;
			const normalizedDeclaration = declaration.replaceAll("\\", path.sep);
			if (
				path.isAbsolute(normalizedDeclaration) ||
				normalizedDeclaration.split(path.sep).some((segment) => segment === "..")
			) {
				return false;
			}
			const declaredEntrypoint = path.resolve(packageRoot, normalizedDeclaration);
			return (
				pathIsWithin(declaredEntrypoint, packageRoot) && realpathOrNull(declaredEntrypoint) === entryPath
			);
		}
		if (path.dirname(packageRoot) === packageRoot) return false;
	}
}

function verifiedPnpmEntrypoint(candidate, { details, platform }) {
	if (typeof candidate !== "string" || candidate.length === 0) return null;
	let entryCandidate = candidate;
	try {
		if (platform === "win32" && path.extname(candidate).toLowerCase() === ".cmd") {
			assertTrustedToolPath(candidate, details);
			entryCandidate = readWindowsCommandEntrypoint(candidate);
		}
		const entryPath = assertTrustedToolPath(entryCandidate, details);
		if (!/\.(?:c?js|mjs)$/i.test(entryPath)) return null;
		return packageOwnsNodeEntrypoint(entryPath, "pnpm", "pnpm") ? entryPath : null;
	} catch {
		return null;
	}
}

function resolveTrustedPnpmEntrypoint({ baseEnv, platform, details }) {
	const candidates = [];
	if (typeof baseEnv.npm_execpath === "string" && path.isAbsolute(baseEnv.npm_execpath)) {
		candidates.push(baseEnv.npm_execpath);
	}
	candidates.push(...resolveExecutableCandidates("pnpm", baseEnv.PATH, { platform }));
	for (const candidate of candidates) {
		const entryPath = verifiedPnpmEntrypoint(candidate, { details, platform });
		if (entryPath) return entryPath;
	}
	throw new Error("Unable to resolve a verified pnpm Node CLI entrypoint");
}

function readTrustedToolVersion(nodePath, entryPath, environment) {
	const result = spawnSync(nodePath, [entryPath, "--version"], {
		cwd: os.tmpdir(),
		env: trustedRuntimeEnvironment(environment),
		encoding: "utf8",
		stdio: "pipe",
		timeout: 30_000,
	});
	if (result.status !== 0 || typeof result.stdout !== "string") {
		throw new Error(`unable to read trusted tool version for ${path.basename(entryPath)}`);
	}
	const version = result.stdout.trim();
	if (version.length === 0) throw new Error(`trusted tool returned no version: ${path.basename(entryPath)}`);
	return version;
}

/**
 * Resolves npm-family tools before release environment sanitization. Every
 * package-manager CLI is invoked through the captured canonical Node binary,
 * never through PATH after the build environment has been isolated.
 */
export function resolveTrustedPackageManagerToolchain({
	baseEnv = process.env,
	platform = process.platform,
	repositoryRoot = REPOSITORY_ROOT,
	workspaceRoots = [repositoryRoot],
	temporaryRoots,
	executableResolver = resolveExecutable,
	nodePath = process.execPath,
} = {}) {
	const resolvedTemporaryRoots =
		temporaryRoots ??
		[os.tmpdir(), baseEnv.TMPDIR, baseEnv.TEMP, baseEnv.TMP].filter(
			(value) => typeof value === "string" && value.length > 0,
		);
	const trustedNode = assertTrustedToolPath(nodePath, {
		workspaceRoots,
		temporaryRoots: resolvedTemporaryRoots,
		label: "Node executable",
	});
	const toolchain = {
		node: {
			command: trustedNode,
			argsPrefix: [],
			path: trustedNode,
			sha256: sha256File(trustedNode),
			version: process.version,
		},
	};
	for (const name of ["npm", "pnpm", "npx"]) {
		const details = {
			workspaceRoots,
			temporaryRoots: resolvedTemporaryRoots,
			label: `${name} executable`,
		};
		const entryPath =
			name === "pnpm"
				? resolveTrustedPnpmEntrypoint({ baseEnv, platform, details })
				: packageManagerEntryPath(
						resolvePackageManagerCommand(name, {
							env: baseEnv,
							platform,
							executableResolver,
						}),
						trustedNode,
						details,
					);
		toolchain[name] = {
			command: trustedNode,
			argsPrefix: [entryPath],
			path: entryPath,
			sha256: sha256File(entryPath),
			version: readTrustedToolVersion(trustedNode, entryPath, baseEnv),
		};
	}
	return toolchain;
}

function isNodeModulesBinDirectory(directory) {
	const resolvedDirectory = path.resolve(directory);
	return (
		path.basename(resolvedDirectory) === ".bin" &&
		path.basename(path.dirname(resolvedDirectory)) === "node_modules"
	);
}

function canonicalRuntimePathComponent(entry) {
	const lexical = path.resolve(entry);
	const stat = lstatOrNull(lexical);
	if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
	return fs.realpathSync(lexical);
}

export function controlledNpxEnvironment({
	emptyBinDir,
	baseEnv = process.env,
	workspaceRoots = [REPOSITORY_ROOT],
}) {
	const npxPath = resolveExecutable("npx", baseEnv.PATH);
	const realNpxPath = fs.realpathSync(npxPath);
	const npxDirectory = canonicalRuntimePathComponent(path.dirname(npxPath));
	const realNpxDirectory = path.dirname(realNpxPath);
	if (
		!npxDirectory ||
		isNodeModulesBinDirectory(path.dirname(npxPath)) ||
		isNodeModulesBinDirectory(realNpxDirectory)
	) {
		throw new Error("controlled npx must not inherit an npx executable from node_modules/.bin");
	}
	const realWorkspaceRoots = workspaceRoots.map((root) => fs.realpathSync(root));
	const isWorkspaceNodeBin = (directory) =>
		isNodeModulesBinDirectory(directory) && realWorkspaceRoots.some((root) => pathIsWithin(directory, root));
	// npx needs the ordinary host command search path to start its package bin
	// through sh on POSIX. Keep that runtime path, but remove every inherited
	// project node_modules/.bin entry so a source checkout cannot satisfy the
	// installed-product command by PATH fallback.
	const inheritedRuntimePaths = baseEnv.PATH.split(path.delimiter)
		.filter((entry) => entry.length > 0)
		.map(canonicalRuntimePathComponent)
		.filter(Boolean)
		.filter((directory) => !isNodeModulesBinDirectory(directory) && !isWorkspaceNodeBin(directory));
	const canonicalEmptyBinDir = canonicalRuntimePathComponent(emptyBinDir);
	if (!canonicalEmptyBinDir) throw new Error("controlled npx empty bin must be a real directory");
	const pathEntries = [canonicalEmptyBinDir, npxDirectory, ...inheritedRuntimePaths];
	return { ...baseEnv, PATH: [...new Set(pathEntries)].join(path.delimiter) };
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code !== "ESRCH";
	}
}

export async function waitForProcessesToExit(processIds, timeoutMs = 2_000) {
	const uniqueProcessIds = [...new Set(processIds)];
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (uniqueProcessIds.every((pid) => !processIsAlive(pid))) return;
		if (Date.now() >= deadline) {
			throw new Error(`Packaged CLI left child process(es) running: ${uniqueProcessIds.join(", ")}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/**
 * Always terminates the captured tree before evaluating whether a deterministic
 * fixture supplied a child identity. That ordering prevents a failed readiness
 * path with an empty marker from skipping cleanup of the npx wrapper group.
 */
export async function cleanupOwnedProcessTree(
	tree,
	{
		fixtureProcessIds = [],
		requireFixtureProcess = false,
		termTimeoutMs = 2_000,
		killTimeoutMs = 2_000,
		pollIntervalMs = 25,
	} = {},
) {
	const errors = [];
	try {
		await terminateOwnedProcessTree(tree, { termTimeoutMs, killTimeoutMs, pollIntervalMs });
	} catch (error) {
		errors.push(error);
	}
	try {
		if (fixtureProcessIds.length > 0) await waitForProcessesToExit(fixtureProcessIds, termTimeoutMs);
	} catch (error) {
		errors.push(error);
	}
	if (requireFixtureProcess && fixtureProcessIds.length === 0) {
		errors.push(new Error("Explicit deterministic Pi did not record a child process"));
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "owned packaged process cleanup failed");
}
