import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { AuthStatusEntry } from "./wire.ts";

/**
 * auth.json read/write (design spec §7.1 / §4.1).
 * - File mode 0o600; parent dir 0o700.
 * - Writes use proper-lockfile (same lock semantics as pi's auth-storage.ts)
 *   to avoid corrupting auth.json when a pi process writes concurrently.
 * - Status queries return masked info only (providerId + configured), never keys.
 */

type AuthData = Record<string, { type?: string; key?: string; env?: unknown } & Record<string, unknown>>;

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

/**
 * Save an API key for a provider. Returns nothing; throws on invalid input or lock failure.
 */
export async function saveApiKey(agentDir: string, provider: string, key: string): Promise<void> {
	const trimmedProvider = provider.trim();
	if (!trimmedProvider) throw new Error("provider must not be empty");
	if (!key.trim()) throw new Error("API key must not be empty");

	const filePath = getAuthFilePath(agentDir);
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!fs.existsSync(filePath)) {
		fs.writeFileSync(filePath, "{}", { encoding: "utf8", mode: 0o600 });
	}
	fs.chmodSync(filePath, 0o600);

	// proper-lockfile async lock (lock file lives next to auth.json)
	const release = await lockfile.lock(filePath, {
		realpath: false,
		retries: { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 200 },
		stale: 30_000,
	});

	try {
		let data: AuthData = {};
		try {
			const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as AuthData;
			if (parsed && typeof parsed === "object") data = parsed;
		} catch {
			data = {};
		}
		// Overwrite with an api_key credential; keep other providers untouched (incl. OAuth).
		data[trimmedProvider] = { type: "api_key", key: key.trim() };
		fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.chmodSync(filePath, 0o600);
	} finally {
		await release();
	}
}
