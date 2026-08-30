import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type PiCapability, type PiHostAdapter, PiHostProbeError } from "./pi-host-adapter.js";
import { createPiRpcAdapter, piRpcAdapter } from "./pi-rpc-adapter.js";

export type { PiCapability } from "./pi-host-adapter.js";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_RPC_ENTRY_SPECIFIER = `${PI_PACKAGE_NAME}/rpc-entry`;
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_PROBE_MAX_OUTPUT_BYTES = 4 * 1024;
const EXACT_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/** Stable, non-sensitive reasons why a selected Pi runtime is unavailable. */
export type PiRuntimeDiagnosticCode =
	| "pi_runtime_missing"
	| "pi_probe_spawn_failed"
	| "pi_probe_timeout"
	| "pi_probe_nonzero_exit"
	| "pi_probe_output_invalid"
	| "pi_probe_output_oversized"
	| "pi_version_mismatch"
	| "pi_version_unsupported"
	| "pi_version_not_promoted"
	| "pi_capability_missing"
	| "protocol_incompatible";

export class PiRuntimeDiagnosticError extends Error {
	readonly code: PiRuntimeDiagnosticCode;

	constructor(code: PiRuntimeDiagnosticCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PiRuntimeDiagnosticError";
		this.code = code;
	}
}

export interface PiCompatibility {
	version: string;
	status: "current" | "candidate";
	adapterId: "pi-rpc";
	capabilities: readonly PiCapability[];
}

const PI_RPC_CAPABILITIES = [
	"session.create",
	"session.open",
	"session.fork",
	"session.clone",
	"rpc.commands",
	"rpc.events",
	"rpc.extension_ui",
] as const satisfies readonly PiCapability[];

/**
 * Exact versions reviewed against the adapter fixtures. Candidate means that
 * the version is compatible as an explicit override, not that distributions
 * may silently replace their pinned current runtime with it.
 */
export const PI_COMPATIBILITY_MATRIX: Readonly<Record<string, PiCompatibility>> = Object.freeze({
	"0.84.2": Object.freeze({
		version: "0.84.2",
		status: "current",
		adapterId: "pi-rpc",
		capabilities: Object.freeze([...PI_RPC_CAPABILITIES]),
	}),
	"0.84.3": Object.freeze({
		version: "0.84.3",
		status: "candidate",
		adapterId: "pi-rpc",
		capabilities: Object.freeze([...PI_RPC_CAPABILITIES, "rpc.toolcall_identity"] as const),
	}),
});

export const REQUIRED_PI_CAPABILITIES = Object.freeze([
	"session.create",
	"session.open",
	"session.fork",
	"session.clone",
	"rpc.commands",
	"rpc.events",
	"rpc.extension_ui",
] as const satisfies readonly PiCapability[]);

export interface ResolvedPi {
	/** Executable for Session process spawn. */
	command: string;
	/** RPC entry arguments, excluding Session-specific arguments. */
	args: string[];
	/** Resolution source; only pi-path is an expert override. */
	source: "pi-path" | "system" | "bundled" | "homebrew";
	/** Internal diagnostic label. Never expose it from health endpoints. */
	label: string;
	/** Concrete adapter selected by a validated production runtime. */
	adapter?: PiHostAdapter;
}

export interface ProbedPiRuntime extends ResolvedPi {
	adapter: PiHostAdapter;
	version: string;
	adapterId: PiCompatibility["adapterId"];
	compatibilityStatus: PiCompatibility["status"];
	capabilities: readonly PiCapability[];
}

interface RuntimeCandidate extends ResolvedPi {
	versionArgs: string[];
	adapter: PiHostAdapter;
	/** Package manifest version, when the selected target belongs to a package. */
	packageVersion?: string;
}

export interface ResolveOptions {
	env?: NodeJS.ProcessEnv;
	piPath?: string;
	probeTimeoutMs?: number;
	probeMaxOutputBytes?: number;
	requiredCapabilities?: readonly PiCapability[];
	/** @deprecated Bundled resolution is module-relative and intentionally ignores cwd. */
	baseDir?: string;
	/** @deprecated No implicit Homebrew lookup occurs. */
	homebrewRoots?: string[];
	/** Deterministic package-export seam for resolver tests. */
	bundledEntryUrl?: string | URL;
	/** Deterministic distribution-manifest seam for compatibility tests. */
	expectedBundledVersion?: string;
}

interface PackageManifest {
	name?: unknown;
	version?: unknown;
	bin?: unknown;
	dependencies?: Record<string, unknown>;
	exports?: Record<string, unknown>;
}

function diagnostic(
	code: PiRuntimeDiagnosticCode,
	message: string,
	cause?: unknown,
): PiRuntimeDiagnosticError {
	return new PiRuntimeDiagnosticError(code, message, cause === undefined ? undefined : { cause });
}

function exists(filePath: string): boolean {
	try {
		return fs.existsSync(filePath);
	} catch {
		return false;
	}
}

function readManifest(filePath: string): PackageManifest | null {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as PackageManifest)
			: null;
	} catch {
		return null;
	}
}

interface PiPackageInfo {
	root: string;
	version: string;
	cliEntry: string;
}

function packageManifestForEntry(entry: string): PiPackageInfo | null {
	let dir = path.dirname(path.resolve(entry));
	for (;;) {
		const manifest = readManifest(path.join(dir, "package.json"));
		if (manifest?.name === PI_PACKAGE_NAME && typeof manifest.version === "string") {
			const binTarget =
				typeof manifest.bin === "string"
					? manifest.bin
					: typeof manifest.bin === "object" && manifest.bin !== null && !Array.isArray(manifest.bin)
						? (manifest.bin as Record<string, unknown>).pi
						: undefined;
			if (typeof binTarget !== "string") return null;
			const cliEntry = path.resolve(dir, binTarget);
			const relative = path.relative(dir, cliEntry);
			if (relative.startsWith("..") || path.isAbsolute(relative) || !exists(cliEntry)) return null;
			return { root: dir, version: manifest.version, cliEntry };
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function declaredDistributionPiVersion(): string {
	const manifest = readManifest(path.resolve(import.meta.dirname, "..", "package.json"));
	const version = manifest?.dependencies?.[PI_PACKAGE_NAME];
	if (typeof version !== "string" || !EXACT_SEMVER.test(version)) {
		throw diagnostic(
			"pi_version_mismatch",
			"The server distribution does not declare an exact Pi runtime version.",
		);
	}
	return version;
}

function resolveBundledCandidate(options: ResolveOptions): RuntimeCandidate {
	let entryUrl: string;
	try {
		entryUrl = String(options.bundledEntryUrl ?? import.meta.resolve(PI_RPC_ENTRY_SPECIFIER));
	} catch (error) {
		throw diagnostic(
			"pi_runtime_missing",
			"The bundled Pi runtime package export could not be resolved.",
			error,
		);
	}

	let entry: string;
	try {
		entry = fileURLToPath(entryUrl);
	} catch (error) {
		throw diagnostic(
			"pi_runtime_missing",
			"The bundled Pi runtime package export is not a local file.",
			error,
		);
	}
	if (!exists(entry)) {
		throw diagnostic("pi_runtime_missing", "The bundled Pi runtime entry is missing.");
	}

	const packageInfo = packageManifestForEntry(entry);
	if (!packageInfo) {
		throw diagnostic("pi_version_mismatch", "The bundled Pi runtime entry has no valid package manifest.");
	}
	const expectedVersion = options.expectedBundledVersion ?? declaredDistributionPiVersion();
	if (packageInfo.version !== expectedVersion) {
		throw diagnostic(
			"pi_version_mismatch",
			`The bundled Pi runtime package version does not match the distribution manifest (${expectedVersion}).`,
		);
	}

	return {
		command: process.execPath,
		args: [entry],
		versionArgs: [packageInfo.cliEntry, "--version"],
		packageVersion: packageInfo.version,
		adapter: piRpcAdapter,
		source: "bundled",
		label: `bundled runtime (${entry})`,
	};
}

function exportedEntryFromPackageRoot(packageRoot: string): string | null {
	const manifest = readManifest(path.join(packageRoot, "package.json"));
	if (manifest?.name !== PI_PACKAGE_NAME) return null;
	const rpcExport = manifest.exports?.["./rpc-entry"];
	const target =
		typeof rpcExport === "string"
			? rpcExport
			: typeof rpcExport === "object" && rpcExport !== null && !Array.isArray(rpcExport)
				? (rpcExport as Record<string, unknown>).import
				: undefined;
	if (typeof target !== "string" || !target.startsWith("./")) return null;
	const entry = path.resolve(packageRoot, target);
	const relative = path.relative(packageRoot, entry);
	if (relative.startsWith("..") || path.isAbsolute(relative) || !exists(entry)) return null;
	return entry;
}

function resolveExplicitPath(piPath: string, env: NodeJS.ProcessEnv): RuntimeCandidate {
	const resolved = path.resolve(expandHome(piPath, env));
	if (exists(resolved) && fs.statSync(resolved).isDirectory()) {
		const packageRoots = [
			resolved,
			path.join(resolved, "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
		];
		for (const packageRoot of packageRoots) {
			const entry = exportedEntryFromPackageRoot(packageRoot);
			if (!entry) continue;
			const packageInfo = packageManifestForEntry(entry);
			if (!packageInfo) continue;
			return {
				command: process.execPath,
				args: [entry],
				versionArgs: [packageInfo.cliEntry, "--version"],
				packageVersion: packageInfo.version,
				adapter: piRpcAdapter,
				source: "pi-path",
				label: `PI_PATH (${entry})`,
			};
		}
		throw diagnostic("pi_runtime_missing", "The PI_PATH directory has no exported Pi RPC entry.");
	}

	if (!exists(resolved)) {
		throw diagnostic("pi_runtime_missing", "The configured PI_PATH does not exist.");
	}

	if (resolved.endsWith(".js") || resolved.endsWith(".mjs") || resolved.endsWith(".cjs")) {
		const packageInfo = packageManifestForEntry(resolved);
		return {
			command: process.execPath,
			args: [resolved],
			versionArgs: [packageInfo?.cliEntry ?? resolved, "--version"],
			...(packageInfo ? { packageVersion: packageInfo.version } : {}),
			adapter: piRpcAdapter,
			source: "pi-path",
			label: `PI_PATH (${resolved})`,
		};
	}

	return {
		command: resolved,
		args: ["--mode", "rpc"],
		versionArgs: ["--version"],
		adapter: piRpcAdapter,
		source: "pi-path",
		label: `PI_PATH (${resolved})`,
	};
}

function expandHome(value: string, env: NodeJS.ProcessEnv): string {
	if (value === "~") return env.HOME ?? value;
	if (value.startsWith("~/")) return path.join(env.HOME ?? "", value.slice(2));
	return value;
}

function mapProbeError(error: unknown): never {
	if (!(error instanceof PiHostProbeError)) throw error;
	const diagnostics = {
		spawn_failed: ["pi_probe_spawn_failed", "The Pi runtime version probe could not start."],
		timeout: ["pi_probe_timeout", "The Pi runtime version probe timed out."],
		nonzero_exit: ["pi_probe_nonzero_exit", "The Pi runtime version probe exited unsuccessfully."],
		output_invalid: ["pi_probe_output_invalid", "The Pi runtime version probe returned an invalid version."],
		output_oversized: [
			"pi_probe_output_oversized",
			"The Pi runtime version probe exceeded its output limit.",
		],
	} as const satisfies Record<PiHostProbeError["kind"], readonly [PiRuntimeDiagnosticCode, string]>;
	const [code, message] = diagnostics[error.kind];
	throw diagnostic(code, message, error);
}

export function compatibilityForPiVersion(version: string): PiCompatibility | undefined {
	return Object.hasOwn(PI_COMPATIBILITY_MATRIX, version) ? PI_COMPATIBILITY_MATRIX[version] : undefined;
}

export function assertRequiredPiCapabilities(
	compatibility: PiCompatibility,
	required: readonly PiCapability[] = REQUIRED_PI_CAPABILITIES,
): void {
	const available = new Set(compatibility.capabilities);
	const missing = required.filter((capability) => !available.has(capability));
	if (missing.length > 0) {
		throw diagnostic(
			"pi_capability_missing",
			`The Pi runtime is missing required adapter capabilities: ${missing.join(", ")}.`,
		);
	}
}

export async function probePiRuntime(
	candidate: RuntimeCandidate,
	options: ResolveOptions = {},
): Promise<ProbedPiRuntime> {
	let version: string;
	try {
		version = await candidate.adapter.probeVersion({
			command: candidate.command,
			args: candidate.versionArgs,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			timeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
			maxOutputBytes: options.probeMaxOutputBytes ?? DEFAULT_PROBE_MAX_OUTPUT_BYTES,
		});
	} catch (error) {
		mapProbeError(error);
	}
	if (candidate.packageVersion !== undefined && candidate.packageVersion !== version) {
		throw diagnostic(
			"pi_version_mismatch",
			"The Pi runtime package manifest and executable version do not match.",
		);
	}
	const compatibility = compatibilityForPiVersion(version);
	if (!compatibility) {
		throw diagnostic(
			"pi_version_unsupported",
			`Pi runtime ${version} is not supported by this Gateway build.`,
		);
	}
	if (candidate.source === "bundled" && compatibility.status !== "current") {
		throw diagnostic(
			"pi_version_not_promoted",
			"The bundled Pi runtime is reviewed only as a candidate and has not been promoted.",
		);
	}
	assertRequiredPiCapabilities(compatibility, options.requiredCapabilities);
	const adapter = createPiRpcAdapter(version, compatibility.capabilities);
	return {
		command: candidate.command,
		args: candidate.args,
		source: candidate.source,
		label: candidate.label,
		adapter,
		version,
		adapterId: compatibility.adapterId,
		compatibilityStatus: compatibility.status,
		capabilities: adapter.capabilities,
	};
}

/**
 * Resolve and validate a Pi runtime before it can own a Session process.
 * Explicit PI_PATH is an expert override; PATH and cwd never shadow the
 * distribution-owned package export.
 */
export async function resolvePiRuntime(options: ResolveOptions = {}): Promise<ProbedPiRuntime> {
	const env = options.env ?? process.env;
	const explicitPath = options.piPath ?? env.PI_PATH;
	const candidate = explicitPath ? resolveExplicitPath(explicitPath, env) : resolveBundledCandidate(options);
	return probePiRuntime(candidate, options);
}

/** For CLI display/diagnostics: which validated runtime will be used. */
export async function describePiRuntime(options: ResolveOptions = {}): Promise<string> {
	const resolved = await resolvePiRuntime(options);
	return `${resolved.source}: Pi ${resolved.version} (${resolved.adapterId})`;
}
