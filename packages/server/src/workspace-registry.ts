import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceSummary } from "@pi-agent-web/protocol";
import lockfile from "proper-lockfile";

/**
 * Workspace registry (Host-owned; Pi has no Workspace concept).
 * Persisted in the Web Server's own data dir (workspaces.json) with atomic writes.
 */

interface RegistryFile {
	version: 1;
	workspaces: WorkspaceRecord[];
}

export interface WorkspaceRecord {
	id: string;
	/** Path entered by the user, retained for display and backwards compatibility. */
	path: string;
	/** Canonical filesystem identity used for process and session ownership checks. */
	cwdRealpath: string;
	displayName?: string;
	lastOpenedAt: number | null;
}

export function workspaceIdForPath(p: string): string {
	return createHash("sha1").update(path.resolve(p)).digest("hex").slice(0, 12);
}

function resolveWorkspaceRealpath(p: string): string {
	return fs.realpathSync(path.resolve(p));
}

export class WorkspaceRegistry {
	private filePath: string;
	private records = new Map<string, WorkspaceRecord>();
	private releaseInstanceLock: (() => void) | null = null;

	constructor(dataDir: string) {
		this.filePath = path.join(dataDir, "workspaces.json");
		fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		const seed = fs.openSync(this.filePath, "a", 0o600);
		fs.closeSync(seed);
		fs.chmodSync(this.filePath, 0o600);
		this.releaseInstanceLock = lockfile.lockSync(this.filePath, { realpath: false, stale: 30_000 });
		this.load();
	}

	private load(): void {
		try {
			const raw = fs.readFileSync(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as RegistryFile;
			let changed = false;
			if (parsed && Array.isArray(parsed.workspaces)) {
				for (const ws of parsed.workspaces) {
					if (ws && typeof ws.id === "string" && typeof ws.path === "string") {
						const cwdRealpath =
							typeof ws.cwdRealpath === "string"
								? path.resolve(ws.cwdRealpath)
								: this.resolveExistingPathOrFallback(ws.path);
						const id = workspaceIdForPath(cwdRealpath);
						const normalized: WorkspaceRecord = {
							...ws,
							id,
							cwdRealpath,
						};
						changed ||= id !== ws.id || cwdRealpath !== ws.cwdRealpath;
						this.records.set(id, normalized);
					}
				}
			}
			if (changed) this.persist();
		} catch {
			// First run or corrupt file: start from an empty registry.
		}
	}

	private resolveExistingPathOrFallback(p: string): string {
		try {
			return resolveWorkspaceRealpath(p);
		} catch {
			return path.resolve(p);
		}
	}

	private persist(): void {
		const dir = path.dirname(this.filePath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tempPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
		const file: RegistryFile = { version: 1, workspaces: [...this.records.values()] };
		let fd: number | undefined;
		try {
			fd = fs.openSync(tempPath, "wx", 0o600);
			fs.writeFileSync(fd, `${JSON.stringify(file, null, 2)}\n`, "utf8");
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fd = undefined;
			fs.renameSync(tempPath, this.filePath);
			try {
				const dirFd = fs.openSync(dir, "r");
				try {
					fs.fsyncSync(dirFd);
				} finally {
					fs.closeSync(dirFd);
				}
			} catch {
				// Directory fsync is unavailable on some platforms/filesystems.
			}
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// The rename succeeded or the temporary file was never created.
			}
		}
	}

	/** Releases this data directory for a later gateway process during shutdown. */
	close(): void {
		const release = this.releaseInstanceLock;
		this.releaseInstanceLock = null;
		release?.();
	}

	/** Register or select a workspace. Returns its stable id. Throws when the dir is missing/unreadable. */
	add(p: string, displayName?: string): WorkspaceSummary {
		const resolved = path.resolve(p);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(resolved);
		} catch {
			throw new Error(`Directory does not exist: ${resolved}`);
		}
		if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
		try {
			fs.accessSync(resolved, fs.constants.R_OK);
		} catch {
			throw new Error(`Directory is not readable: ${resolved}`);
		}

		const cwdRealpath = resolveWorkspaceRealpath(resolved);
		const id = workspaceIdForPath(cwdRealpath);
		const existing = this.records.get(id);
		const record: WorkspaceRecord = existing ?? {
			id,
			path: resolved,
			cwdRealpath,
			lastOpenedAt: null,
		};
		if (displayName !== undefined) record.displayName = displayName;
		this.records.set(id, record);
		this.persist();
		return this.toSummary(record, 0);
	}

	touch(id: string): void {
		const record = this.records.get(id);
		if (!record) return;
		record.lastOpenedAt = Date.now();
		this.persist();
	}

	remove(id: string): void {
		if (this.records.delete(id)) this.persist();
	}

	get(id: string): WorkspaceRecord | undefined {
		return this.records.get(id);
	}

	list(sessionCounts: Map<string, number> = new Map()): WorkspaceSummary[] {
		return [...this.records.values()]
			.map((r) => this.toSummary(r, sessionCounts.get(r.id) ?? 0))
			.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
	}

	private toSummary(r: WorkspaceRecord, sessionCount: number): WorkspaceSummary {
		return {
			id: r.id,
			path: r.path,
			displayName: r.displayName || path.basename(r.path),
			sessionCount,
			lastOpenedAt: r.lastOpenedAt,
		};
	}
}
