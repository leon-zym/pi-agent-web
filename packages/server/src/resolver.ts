import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Three-tier Pi runtime resolution (design spec §7.2):
 * 1. PI_PATH env var / --pi-path CLI arg (pi-web's own convention; pi source
 *    has no such variable).
 * 2. The global "pi" command on PATH (seamlessly inherits ~/.pi config and
 *    extensions).
 * 3. Bundled fallback: @earendil-works/pi-coding-agent's dist/rpc-entry.js.
 *
 * The fallback entry MUST be dist/rpc-entry.js (the dedicated RPC entry),
 * not dist/cli.js.
 */

export interface ResolvedPi {
	/** Executable for spawn */
	command: string;
	/** Extra args (excluding spawn options like cwd/stdio) */
	args: string[];
	/** Resolution source, for diagnostics and UI display */
	source: "pi-path" | "system" | "bundled" | "homebrew";
	label: string;
}

export interface ResolveOptions {
	env?: NodeJS.ProcessEnv;
	piPath?: string;
	/** Base module path used for the require.resolve fallback */
	baseDir?: string;
}

function exists(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

function tryHomebrewEntries(env: NodeJS.ProcessEnv): string[] {
	const roots = [
		"/opt/homebrew/Cellar/pi-coding-agent",
		"/usr/local/Cellar/pi-coding-agent",
		path.join(env.HOME ?? "", "homebrew/Cellar/pi-coding-agent"),
	];
	const found: string[] = [];
	for (const root of roots) {
		if (!exists(root)) continue;
		try {
			for (const ver of fs.readdirSync(root)) {
				const entry = path.join(
					root,
					ver,
					"libexec",
					"lib",
					"node_modules",
					"@earendil-works",
					"pi-coding-agent",
					"dist",
					"rpc-entry.js",
				);
				if (exists(entry)) found.push(entry);
			}
		} catch {
			// Unreadable dir: skip.
		}
	}
	return found;
}

function resolveBundledEntry(env: NodeJS.ProcessEnv, baseDir?: string): string | null {
	const requireBase = baseDir ?? process.cwd();
	const candidates: string[] = [];
	// 1. This project's node_modules (the server package declares the dependency)
	try {
		const localRequire = createRequire(path.join(requireBase, "package.json"));
		candidates.push(localRequire.resolve("@earendil-works/pi-coding-agent/dist/rpc-entry.js"));
	} catch {
		// not installed
	}
	// 2. pnpm global store / global install
	try {
		const probe = createRequire(path.join(requireBase, "__resolver_probe__.js"));
		candidates.push(probe.resolve("@earendil-works/pi-coding-agent/dist/rpc-entry.js"));
	} catch {
		// not installed
	}
	// 3. Homebrew Cellar (verified layout on this machine)
	candidates.push(...tryHomebrewEntries(env));

	for (const candidate of candidates) {
		if (candidate && exists(candidate)) return candidate;
	}
	return null;
}

async function whichPi(env: NodeJS.ProcessEnv): Promise<string | null> {
	const pathVar = env.PATH ?? "";
	const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
	const dirs = pathVar.split(path.delimiter).filter(Boolean);
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = path.resolve(dir, `pi${ext}`);
			if (exists(candidate)) {
				try {
					fs.accessSync(candidate, fs.constants.X_OK);
					return candidate;
				} catch {
					// exists but not executable: keep looking
				}
			}
		}
	}
	return null;
}

/**
 * Resolve the Pi runtime. Throws with remediation hints when all three tiers miss.
 */
export async function resolvePiRuntime(options: ResolveOptions = {}): Promise<ResolvedPi> {
	const env = options.env ?? process.env;

	// Tier 1: PI_PATH / --pi-path (custom convention)
	if (options.piPath) {
		return resolveExplicitPath(options.piPath);
	}

	// Tier 2: global pi on PATH
	const systemPi = await whichPi(env);
	if (systemPi) {
		return {
			command: systemPi,
			args: ["--mode", "rpc"],
			source: "system",
			label: `system pi (${systemPi})`,
		};
	}

	// Tier 3: bundled dependency / homebrew fallback
	const entry = resolveBundledEntry(env, options.baseDir);
	if (entry) {
		return {
			command: process.execPath,
			args: [entry],
			source: entry.includes("Cellar") ? "homebrew" : "bundled",
			label: `bundled runtime (${entry})`,
		};
	}

	throw new Error(
		[
			"Unable to locate the Pi Coding Agent runtime. Satisfy any of:",
			"  1. set PI_PATH (or pass --pi-path) to the pi executable;",
			"  2. install the global pi command on PATH;",
			"  3. install @earendil-works/pi-coding-agent (or the Homebrew pi-coding-agent formula).",
		].join("\n"),
	);
}

function resolveExplicitPath(piPath: string): ResolvedPi {
	const resolved = path.resolve(expandHome(piPath));
	if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
		// Directory install: prefer rpc-entry.js, then cli.js
		for (const rel of [
			"dist/rpc-entry.js",
			"lib/node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js",
			"dist/cli.js",
		]) {
			const candidate = path.join(resolved, rel);
			if (exists(candidate)) {
				return {
					command: process.execPath,
					args: [candidate],
					source: "pi-path",
					label: `PI_PATH (${candidate})`,
				};
			}
		}
		throw new Error(`PI_PATH directory has no dist/rpc-entry.js: ${resolved}`);
	}

	if (!exists(resolved)) {
		throw new Error(`PI_PATH does not exist: ${resolved}`);
	}

	if (resolved.endsWith(".js") || resolved.endsWith(".mjs") || resolved.endsWith(".cjs")) {
		return {
			command: process.execPath,
			args: [resolved],
			source: "pi-path",
			label: `PI_PATH (${resolved})`,
		};
	}

	return {
		command: resolved,
		args: ["--mode", "rpc"],
		source: "pi-path",
		label: `PI_PATH (${resolved})`,
	};
}

function expandHome(p: string): string {
	if (p === "~") return process.env.HOME ?? p;
	if (p.startsWith("~/")) return path.join(process.env.HOME ?? "", p.slice(2));
	return p;
}

/** For CLI display/diagnostics: which runtime will be used. */
export async function describePiRuntime(options: ResolveOptions = {}): Promise<string> {
	const resolved = await resolvePiRuntime(options);
	return `${resolved.source}: ${resolved.command} ${resolved.args.join(" ")}`;
}

export { execFileAsync };
