import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

export type SessionLayoutSource = "environment" | "global-settings" | "project-settings" | "default";

export interface SessionLayoutDiagnostic {
	scope: "global" | "project";
	message: string;
	workspacePath?: string;
}

export interface WorkspaceSessionLayout {
	workspacePath: string;
	sessionDir: string;
	source: SessionLayoutSource;
	diagnostics: SessionLayoutDiagnostic[];
}

export interface SessionDiscoverySource {
	/** Default Pi storage is nested; configured custom storage is a direct JSONL directory. */
	mode: "nested-default-root" | "direct";
	path: string;
	reason: Exclude<SessionLayoutSource, "default"> | "default";
	workspacePath?: string;
}

export interface SessionDiscoveryPlan {
	sources: SessionDiscoverySource[];
	diagnostics: SessionLayoutDiagnostic[];
}

export interface SessionLayoutResolverOptions {
	/** Effective Pi agent directory. Relative values follow Pi's child-cwd semantics. */
	agentDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
	/** Gateway cwd used only as the fallback settings probe cwd. */
	runtimeCwd?: string;
	homeDir?: string;
	/** Existing path used only to load the global settings file. */
	settingsProbeCwd?: string;
}

/**
 * Resolve a path while retaining realpath identity for a missing leaf.
 *
 * `realpath` cannot resolve a session file before Pi creates it. Walking to the
 * closest existing ancestor first prevents a handle from changing when that
 * ancestor was reached through a symlink.
 */
export function canonicalizePathAllowMissing(inputPath: string): string {
	const resolved = path.resolve(inputPath);
	try {
		return fs.realpathSync(resolved);
	} catch {
		const suffix: string[] = [];
		let cursor = resolved;

		for (;;) {
			try {
				return path.join(fs.realpathSync(cursor), ...suffix);
			} catch {
				const parent = path.dirname(cursor);
				if (parent === cursor) return resolved;
				suffix.unshift(path.basename(cursor));
				cursor = parent;
			}
		}
	}
}

export function workspaceHandleForPath(workspacePath: string): string {
	const canonical = canonicalizePathAllowMissing(workspacePath);
	return `workspace_${hashIdentity(canonical)}`;
}

function hashIdentity(value: string): string {
	return createHash("sha256").update(value).digest("base64url");
}

function expandTilde(value: string, homeDir: string): string {
	if (value === "~") return homeDir;
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		return path.join(homeDir, value.slice(2));
	}
	return value;
}

function diagnosticFromError(
	error: { scope: "global" | "project"; error: Error },
	workspacePath?: string,
): SessionLayoutDiagnostic {
	return {
		scope: error.scope,
		message: error.error.message,
		workspacePath: error.scope === "project" ? workspacePath : undefined,
	};
}

/** Mirrors Pi's runtime session directory precedence without mutating process.env. */
export class SessionLayoutResolver {
	private readonly env: Readonly<Record<string, string | undefined>>;
	private readonly homeDir: string;
	private readonly settingsProbeCwd: string;
	private readonly configuredAgentDir: string;
	private readonly agentDirOrigin: "option" | "environment" | "default";

	constructor(options: SessionLayoutResolverOptions = {}) {
		this.env = options.env ?? process.env;
		this.homeDir = options.homeDir ?? os.homedir();
		const runtimeCwd = path.resolve(options.runtimeCwd ?? process.cwd());
		const environmentAgentDir = this.env[PI_AGENT_DIR_ENV];
		this.configuredAgentDir =
			options.agentDir ?? environmentAgentDir ?? path.join(this.homeDir, CONFIG_DIR_NAME, "agent");
		this.agentDirOrigin =
			options.agentDir !== undefined ? "option" : environmentAgentDir ? "environment" : "default";
		this.settingsProbeCwd = path.resolve(options.settingsProbeCwd ?? runtimeCwd);
	}

	/** Resolve the agent directory exactly as a Pi child launched in this workspace will. */
	agentDirForWorkspace(workspacePath: string): string {
		return this.resolveConfiguredPath(this.configuredAgentDir, this.resolveWorkspacePath(workspacePath));
	}

	defaultSessionsRootForWorkspace(workspacePath: string): string {
		return path.join(this.agentDirForWorkspace(workspacePath), "sessions");
	}

	/**
	 * Return absolute overrides for a Pi child launched in this workspace.
	 *
	 * Callers should merge this object into `PiProcessOptions.env`. Passing the
	 * same normalized values to the child prevents its cwd from reinterpreting a
	 * relative gateway override differently from catalog resolution.
	 */
	normalizedChildEnvForWorkspace(workspacePath: string): Record<string, string> {
		const resolvedWorkspace = this.resolveWorkspacePath(workspacePath);
		const normalized: Record<string, string> = {};
		if (this.agentDirOrigin !== "default") {
			normalized[PI_AGENT_DIR_ENV] = this.resolveConfiguredPath(this.configuredAgentDir, resolvedWorkspace);
		}
		const sessionDir = this.env[PI_SESSION_DIR_ENV];
		if (sessionDir) {
			normalized[PI_SESSION_DIR_ENV] = this.resolveConfiguredPath(sessionDir, resolvedWorkspace);
		}
		return normalized;
	}

	/** Pi's exact encoded default directory layout for a workspace. */
	defaultSessionDirForWorkspace(workspacePath: string): string {
		const resolvedWorkspace = this.resolveWorkspacePath(workspacePath);
		const encoded = `--${resolvedWorkspace.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		return path.join(this.defaultSessionsRootForWorkspace(resolvedWorkspace), encoded);
	}

	/** Resolve the directory a newly launched Pi process will use for this workspace. */
	resolveForWorkspace(workspacePath: string): WorkspaceSessionLayout {
		const resolvedWorkspace = this.resolveWorkspacePath(workspacePath);
		const envSessionDir = this.env[PI_SESSION_DIR_ENV];
		if (envSessionDir) {
			return {
				workspacePath: resolvedWorkspace,
				sessionDir: this.resolveConfiguredPath(envSessionDir, resolvedWorkspace),
				source: "environment",
				diagnostics: [],
			};
		}

		const settings = SettingsManager.create(resolvedWorkspace, this.agentDirForWorkspace(resolvedWorkspace));
		const sessionDir = settings.getSessionDir();
		const diagnostics = settings.drainErrors().map((error) => diagnosticFromError(error, resolvedWorkspace));
		if (sessionDir) {
			const projectSessionDir = settings.getProjectSettings().sessionDir;
			return {
				workspacePath: resolvedWorkspace,
				sessionDir: this.resolveConfiguredPath(sessionDir, resolvedWorkspace),
				source: projectSessionDir ? "project-settings" : "global-settings",
				diagnostics,
			};
		}

		return {
			workspacePath: resolvedWorkspace,
			sessionDir: this.defaultSessionDirForWorkspace(resolvedWorkspace),
			source: "default",
			diagnostics,
		};
	}

	/**
	 * Build discovery sources. The default root is always included so changing a
	 * setting never hides older native Pi history. Project settings are resolved
	 * only for paths already known from native headers or preference hints.
	 */
	discoveryPlan(knownWorkspacePaths: Iterable<string> = []): SessionDiscoveryPlan {
		const workspaces = this.resolveWorkspacePaths(knownWorkspacePaths);
		const sources: SessionDiscoverySource[] = [];
		const diagnostics: SessionLayoutDiagnostic[] = [];

		if (this.isRelativeConfiguredPath(this.configuredAgentDir)) {
			if (workspaces.length === 0) {
				diagnostics.push({
					scope: "global",
					message:
						this.agentDirOrigin === "environment"
							? `Cannot discover relative ${PI_AGENT_DIR_ENV} without a known workspace`
							: "Cannot discover a relative Pi agent directory without a known workspace",
				});
			} else {
				for (const workspacePath of workspaces) {
					sources.push({
						mode: "nested-default-root",
						path: this.defaultSessionsRootForWorkspace(workspacePath),
						reason: "default",
						workspacePath,
					});
				}
			}
		} else {
			sources.push({
				mode: "nested-default-root",
				path: path.join(
					this.resolveConfiguredPath(this.configuredAgentDir, this.settingsProbeCwd),
					"sessions",
				),
				reason: "default",
			});
		}

		const envSessionDir = this.env[PI_SESSION_DIR_ENV];
		if (envSessionDir) {
			this.addSharedConfiguredSources(
				sources,
				diagnostics,
				envSessionDir,
				"environment",
				workspaces,
				`relative ${PI_SESSION_DIR_ENV}`,
			);
		}

		if (this.isRelativeConfiguredPath(this.configuredAgentDir)) {
			for (const workspacePath of workspaces) {
				const globalSettings = SettingsManager.create(
					workspacePath,
					this.agentDirForWorkspace(workspacePath),
					{ projectTrusted: false },
				);
				const globalSessionDir = globalSettings.getGlobalSettings().sessionDir;
				diagnostics.push(...globalSettings.drainErrors().map((error) => diagnosticFromError(error)));
				if (globalSessionDir) {
					this.addSharedConfiguredSources(
						sources,
						diagnostics,
						globalSessionDir,
						"global-settings",
						[workspacePath],
						"relative global sessionDir",
					);
				}
			}
		} else {
			const globalSettings = SettingsManager.create(
				this.settingsProbeCwd,
				this.resolveConfiguredPath(this.configuredAgentDir, this.settingsProbeCwd),
				{ projectTrusted: false },
			);
			const globalSessionDir = globalSettings.getGlobalSettings().sessionDir;
			diagnostics.push(...globalSettings.drainErrors().map((error) => diagnosticFromError(error)));
			if (globalSessionDir) {
				this.addSharedConfiguredSources(
					sources,
					diagnostics,
					globalSessionDir,
					"global-settings",
					workspaces,
					"relative global sessionDir",
				);
			}
		}

		for (const workspacePath of workspaces) {
			const settings = SettingsManager.create(workspacePath, this.agentDirForWorkspace(workspacePath));
			const projectSessionDir = settings.getProjectSettings().sessionDir;
			diagnostics.push(...settings.drainErrors().map((error) => diagnosticFromError(error, workspacePath)));
			if (!projectSessionDir) continue;
			sources.push({
				mode: "direct",
				path: this.resolveConfiguredPath(projectSessionDir, workspacePath),
				reason: "project-settings",
				workspacePath,
			});
		}

		return { sources: dedupeSources(sources), diagnostics: dedupeDiagnostics(diagnostics) };
	}

	private addSharedConfiguredSources(
		sources: SessionDiscoverySource[],
		diagnostics: SessionLayoutDiagnostic[],
		configuredPath: string,
		reason: "environment" | "global-settings",
		workspacePaths: readonly string[],
		diagnosticLabel: string,
	): void {
		if (!this.isRelativeConfiguredPath(configuredPath)) {
			sources.push({
				mode: "direct",
				path: this.resolveConfiguredPath(configuredPath, this.settingsProbeCwd),
				reason,
			});
			return;
		}
		if (workspacePaths.length === 0) {
			diagnostics.push({
				scope: "global",
				message: `Cannot discover ${diagnosticLabel} without a known workspace`,
			});
			return;
		}
		for (const workspacePath of workspacePaths) {
			sources.push({
				mode: "direct",
				path: this.resolveConfiguredPath(configuredPath, workspacePath),
				reason,
				workspacePath,
			});
		}
	}

	private resolveWorkspacePath(workspacePath: string): string {
		return path.resolve(expandTilde(workspacePath, this.homeDir));
	}

	private resolveWorkspacePaths(workspacePaths: Iterable<string>): string[] {
		const seen = new Set<string>();
		const resolved: string[] = [];
		for (const workspacePath of workspacePaths) {
			if (!workspacePath) continue;
			const normalized = this.resolveWorkspacePath(workspacePath);
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			resolved.push(normalized);
		}
		return resolved;
	}

	private isRelativeConfiguredPath(configuredPath: string): boolean {
		return !path.isAbsolute(expandTilde(configuredPath, this.homeDir));
	}

	private resolveConfiguredPath(configuredPath: string, baseDir: string): string {
		return path.resolve(baseDir, expandTilde(configuredPath, this.homeDir));
	}
}

function dedupeSources(sources: SessionDiscoverySource[]): SessionDiscoverySource[] {
	const seen = new Set<string>();
	return sources.filter((source) => {
		// Header.cwd, not the discovery source, owns Workspace identity. If two
		// relative configurations converge on the same physical directory, one
		// scan is authoritative and avoids duplicate SessionManager work.
		const key = `${source.mode}\0${canonicalizePathAllowMissing(source.path)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function dedupeDiagnostics(diagnostics: SessionLayoutDiagnostic[]): SessionLayoutDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.scope}\0${diagnostic.workspacePath ?? ""}\0${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
