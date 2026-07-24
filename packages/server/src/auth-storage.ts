import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuthStatusEntry } from "@pi-agent-web/protocol";
import lockfile from "proper-lockfile";

/**
 * auth.json read/write (see docs/protocol.md for the storage layout).
 * - File mode 0o600; parent dir 0o700.
 * - Writes use proper-lockfile (same lock semantics as pi's auth-storage.ts)
 *   to avoid corrupting auth.json when a pi process writes concurrently.
 * - Status queries return masked info only (providerId + configured), never keys.
 */

type AuthData = Record<string, { type?: string; key?: string; env?: unknown } & Record<string, unknown>>;
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);

export function getAuthFilePath(agentDir: string): string {
	return path.join(agentDir, "auth.json");
}

export function readAuthStatus(agentDir: string): AuthStatusEntry[] {
	const filePath = getAuthFilePath(agentDir);
	let data: AuthData = {};
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as AuthData;
		if (parsed && typeof parsed === "object") data = parsed;
	} catch {
		// Missing or corrupt file: treated as unconfigured.
	}

	return Object.entries(data).map(([providerId, credential]) => {
		const type = typeof credential === "object" && credential !== null ? credential.type : undefined;
		const hasKey =
			typeof credential === "object" &&
			credential !== null &&
			typeof credential.key === "string" &&
			credential.key.length > 0;
		return {
			providerId,
			configured: hasKey || type === "oauth",
			credentialType: type,
		};
	});
}

async function fsyncDirectory(dir: string): Promise<void> {
	try {
		const handle = await fs.promises.open(dir, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// Directory fsync is unavailable on some platforms/filesystems.
	}
}

async function atomicWriteAuthFile(filePath: string, content: string): Promise<void> {
	const dir = path.dirname(filePath);
	const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(tempPath, "wx", 0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.promises.rename(tempPath, filePath);
		await fsyncDirectory(dir);
	} finally {
		await handle?.close().catch(() => {});
		await fs.promises.unlink(tempPath).catch(() => {});
	}
}

async function ensureAuthFile(filePath: string): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	try {
		const handle = await fs.promises.open(filePath, "wx", 0o600);
		try {
			await handle.writeFile("{}\n", "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fsyncDirectory(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await fs.promises.chmod(filePath, 0o600);
}

/**
 * Save an API key for a provider. Returns nothing; throws on invalid input or lock failure.
 */
export async function saveApiKey(agentDir: string, provider: string, key: string): Promise<void> {
	const trimmedProvider = provider.trim();
	if (!trimmedProvider) throw new Error("provider must not be empty");
	if (UNSAFE_PROVIDER_IDS.has(trimmedProvider)) throw new Error("provider is not valid");
	if (!key.trim()) throw new Error("API key must not be empty");

	const filePath = getAuthFilePath(agentDir);
	await ensureAuthFile(filePath);

	// proper-lockfile async lock (lock file lives next to auth.json)
	const release = await lockfile.lock(filePath, {
		realpath: false,
		retries: { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 200 },
		stale: 30_000,
	});

	try {
		let data: AuthData;
		try {
			const parsed = JSON.parse(await fs.promises.readFile(filePath, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("auth.json must contain an object");
			}
			data = Object.assign(Object.create(null) as AuthData, parsed);
		} catch (error) {
			throw new Error(
				`auth.json could not be parsed; refusing to overwrite it: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		// Overwrite with an api_key credential; keep other providers untouched (incl. OAuth).
		data[trimmedProvider] = { type: "api_key", key: key.trim() };
		await atomicWriteAuthFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
	} finally {
		await release();
	}
}
