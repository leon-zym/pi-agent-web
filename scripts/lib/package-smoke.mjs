import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
	const { cwd = REPOSITORY_ROOT, env = process.env, timeoutMs = 120_000 } = options;
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: "pipe", timeout: timeoutMs });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	}
	return result.stdout ?? "";
}

export function packageManifest(tarball, options = {}) {
	return JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"], options));
}

export function listTarballEntries(tarball, options = {}) {
	return run("tar", ["-tzf", tarball], options).split("\n").filter(Boolean);
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
			const entries = listTarballEntries(tarball);
			if (!hasPackageFile(entries, "dist")) {
				throw new Error(`Missing dist directory in ${path.basename(tarball)}`);
			}
			if (!entries.includes("package/LICENSE")) {
				throw new Error(`Missing LICENSE in ${path.basename(tarball)}`);
			}
			if (hasPackagePath(entries, "src")) {
				throw new Error(`Source directory leaked into ${path.basename(tarball)}`);
			}
			const manifest = packageManifest(tarball);
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

export function packWorkspacePackages({ root = REPOSITORY_ROOT, tarballDir }) {
	fs.mkdirSync(tarballDir, { recursive: true });
	for (const packageName of PACKAGE_NAMES) {
		run("pnpm", ["--filter", packageName, "pack", "--pack-destination", tarballDir], { cwd: root });
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

export function launchInstalledCli({ installDir, args, cwd, env }) {
	return spawn(process.execPath, [installedCliEntry(installDir), ...args], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
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

export function waitForChildExit(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		const finish = (exited) => {
			clearTimeout(timer);
			child.off("exit", onExit);
			resolve(exited);
		};
		child.once("exit", onExit);
	});
}

function signalChild(child, signal, processGroup) {
	if (processGroup && process.platform !== "win32" && child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return true;
		} catch (error) {
			if (error?.code === "ESRCH") return false;
			throw error;
		}
	}
	return child.kill(signal);
}

export async function closeChild(child, timeoutMs = 2_000, options = {}) {
	const { processGroup = false } = options;
	if (child.exitCode !== null || child.signalCode !== null) {
		if (processGroup) signalChild(child, "SIGKILL", true);
		return;
	}
	signalChild(child, "SIGTERM", processGroup);
	if (await waitForChildExit(child, timeoutMs)) return;
	signalChild(child, "SIGKILL", processGroup);
	if (!(await waitForChildExit(child, timeoutMs))) throw new Error("Packaged CLI did not exit after SIGKILL");
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
	run("tar", ["-xzf", archivePath, "-C", destinationDir], { cwd: destinationDir });
	const bundleRoot = path.join(destinationDir, bundleName);
	assertRegularDirectory(bundleRoot, "extracted bundle root");
	return bundleRoot;
}

export function installBundle({ bundleRoot }) {
	run("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
		cwd: bundleRoot,
		env: { ...process.env, npm_config_registry: "https://registry.npmjs.org/" },
	});
}

export function resolveExecutable(name, pathValue = process.env.PATH) {
	if (typeof pathValue !== "string" || pathValue.length === 0) throw new Error(`PATH cannot resolve ${name}`);
	const suffixes = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
	for (const directory of pathValue.split(path.delimiter)) {
		if (!directory) continue;
		for (const suffix of suffixes) {
			const candidate = path.join(directory, `${name}${suffix}`);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				return candidate;
			} catch {
				// Try the next directory or platform suffix.
			}
		}
	}
	throw new Error(`Unable to resolve ${name} from PATH`);
}

export function controlledNpxEnvironment({ emptyBinDir, baseEnv = process.env }) {
	const npxPath = resolveExecutable("npx", baseEnv.PATH);
	const pathEntries = [path.dirname(npxPath), path.dirname(process.execPath), emptyBinDir];
	return { ...baseEnv, PATH: [...new Set(pathEntries)].join(path.delimiter) };
}

export function launchInstalledNpx({ args, cwd, detached = false, env }) {
	const npxPath = resolveExecutable("npx");
	return spawn(npxPath, ["--no-install", "pi-web", ...args], {
		cwd,
		detached,
		stdio: ["ignore", "pipe", "pipe"],
		env,
	});
}

export async function terminateChildWithin(child, timeoutMs = 2_000, options = {}) {
	const { processGroup = false } = options;
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (!signalChild(child, "SIGTERM", processGroup)) {
		throw new Error("Unable to send SIGTERM to the packaged CLI");
	}
	if (!(await waitForChildExit(child, timeoutMs))) {
		throw new Error(`Packaged CLI did not exit after SIGTERM within ${String(timeoutMs)}ms`);
	}
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
