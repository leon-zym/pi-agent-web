import { homedir } from "node:os";
import path from "node:path";

/**
 * Web Server configuration.
 *
 * Env contract (matches pi source; see docs/protocol.md for the full map):
 * - PI_CODING_AGENT_DIR: overrides the agent config dir (~/.pi/agent)
 * - PI_CODING_AGENT_SESSION_DIR: overrides the session root dir
 * The Web Server only reads these, never hardcodes paths, and passes them
 * through to child processes.
 */

export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
export const ENV_SESSION_DIR = "PI_CODING_AGENT_SESSION_DIR";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[ENV_AGENT_DIR];
	if (override) return path.resolve(expandHome(override));
	return path.join(homedir(), ".pi", "agent");
}

export function getSessionRootDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[ENV_SESSION_DIR];
	if (override) return path.resolve(expandHome(override));
	return path.join(getAgentDir(env), "sessions");
}

/** Web Server's own data dir (workspace registry), default <agentDir>/../web */
export function getWebDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_WEB_DATA_DIR;
	if (override) return path.resolve(expandHome(override));
	return path.join(path.dirname(getAgentDir(env)), "web");
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
	return p;
}

export interface ServerConfig {
	port: number;
	host: string;
	agentDir: string;
	sessionRootDir: string;
	webDataDir: string;
}

export function assertLoopbackHost(host: string): void {
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error("PI_WEB_HOST must be one of 127.0.0.1, localhost, or ::1");
	}
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	const port = Number.parseInt(env.PI_WEB_PORT ?? "3000", 10);
	const config = {
		port: Number.isFinite(port) ? port : 3000,
		host: env.PI_WEB_HOST ?? "127.0.0.1",
		agentDir: getAgentDir(env),
		sessionRootDir: getSessionRootDir(env),
		webDataDir: getWebDataDir(env),
	};
	assertLoopbackHost(config.host);
	return config;
}

/**
 * Session dir safe encoding, character-for-character identical to pi's
 * session-manager.ts:
 *   "--" + resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--"
 */
export function encodeSessionDir(cwd: string): string {
	const resolved = path.resolve(cwd);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Derive a workspace's session dir from its cwd (pi-native capability, Host derives only). */
export function getSessionDirForCwd(cwd: string, sessionRootDir: string): string {
	return path.join(sessionRootDir, encodeSessionDir(cwd));
}

/** Whether a session path belongs to a workspace process's session dir (cross-workspace switch guard). */
export function isSessionInDir(sessionPath: string, sessionDir: string): boolean {
	const resolvedSession = path.resolve(sessionPath);
	const resolvedDir = path.resolve(sessionDir);
	return resolvedSession.startsWith(resolvedDir + path.sep) && path.extname(resolvedSession) === ".jsonl";
}
