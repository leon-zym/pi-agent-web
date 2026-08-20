import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { canonicalizePathAllowMissing, workspaceHandleForPath } from "./session-layout-resolver.js";

interface PreferencesFile {
	version: 1;
	preferences: WorkspacePreference[];
}

interface LegacyRegistryFile {
	version?: unknown;
	workspaces?: unknown;
}

export interface WorkspacePreference {
	workspaceHandle: string;
	/** Discovery hint only. Native JSONL Header.cwd remains authoritative. */
	pathHint: string;
	pinned: boolean;
	displayName?: string;
	lastOpenedAt: number | null;
}

export interface WorkspacePreferenceInput {
	pathHint: string;
	pinned?: boolean;
	displayName?: string | null;
	lastOpenedAt?: number | null;
}

/** Host-owned presentation preferences; never a workspace or session source of truth. */
export class WorkspacePreferences {
	readonly filePath: string;

	private readonly records = new Map<string, WorkspacePreference>();
	private releaseInstanceLock: (() => void) | null = null;
	private loadError: Error | null = null;
	private closed = false;

	constructor(dataDir: string) {
		const resolvedDataDir = path.resolve(dataDir);
		this.filePath = path.join(resolvedDataDir, "workspace-preferences.json");
		fs.mkdirSync(resolvedDataDir, { recursive: true, mode: 0o700 });
		const existed = fs.existsSync(this.filePath);
		const seed = fs.openSync(this.filePath, "a", 0o600);
		fs.closeSync(seed);
		fs.chmodSync(this.filePath, 0o600);
		this.releaseInstanceLock = lockfile.lockSync(this.filePath, { realpath: false, stale: 30_000 });

		if (existed && fs.readFileSync(this.filePath, "utf8").trim()) {
			this.loadCurrentFile();
		} else {
			this.loadLegacyHints(path.join(resolvedDataDir, "workspaces.json"));
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const release = this.releaseInstanceLock;
		this.releaseInstanceLock = null;
		release?.();
	}

	getLoadError(): Error | null {
		return this.loadError;
	}

	list(): WorkspacePreference[] {
		return [...this.records.values()]
			.map((record) => ({ ...record }))
			.sort(
				(a, b) =>
					Number(b.pinned) - Number(a.pinned) ||
					(b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) ||
					a.pathHint.localeCompare(b.pathHint),
			);
	}

	get(workspaceHandle: string): WorkspacePreference | undefined {
		const record = this.records.get(workspaceHandle);
		return record ? { ...record } : undefined;
	}

	pathHints(): string[] {
		return [...new Set([...this.records.values()].map((record) => record.pathHint))];
	}

	upsert(input: WorkspacePreferenceInput): WorkspacePreference {
		this.assertOpen();
		if (!input.pathHint.trim()) throw new Error("Workspace path hint must not be empty");
		const pathHint = canonicalizePathAllowMissing(input.pathHint);
		const workspaceHandle = workspaceHandleForPath(pathHint);
		const existing = this.records.get(workspaceHandle);
		const hasDisplayName = Object.hasOwn(input, "displayName");
		const hasLastOpenedAt = Object.hasOwn(input, "lastOpenedAt");
		const record: WorkspacePreference = {
			workspaceHandle,
			pathHint,
			pinned: input.pinned ?? existing?.pinned ?? false,
			displayName: hasDisplayName ? (input.displayName ?? undefined) : existing?.displayName,
			lastOpenedAt: hasLastOpenedAt ? (input.lastOpenedAt ?? null) : (existing?.lastOpenedAt ?? null),
		};
		this.records.set(workspaceHandle, record);
		this.persist();
		return { ...record };
	}

	touch(workspaceHandle: string, openedAt = Date.now()): void {
		this.assertOpen();
		const existing = this.records.get(workspaceHandle);
		if (!existing) return;
		this.records.set(workspaceHandle, { ...existing, lastOpenedAt: openedAt });
		this.persist();
	}

	remove(workspaceHandle: string): void {
		this.assertOpen();
		if (this.records.delete(workspaceHandle)) this.persist();
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("WorkspacePreferences is closed");
	}

	private loadCurrentFile(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<PreferencesFile>;
			if (parsed.version !== 1 || !Array.isArray(parsed.preferences)) {
				throw new Error("Unsupported workspace preference file");
			}
			for (const value of parsed.preferences) {
				const record = normalizePreference(value);
				if (record) this.records.set(record.workspaceHandle, record);
			}
		} catch (error) {
			this.loadError = error instanceof Error ? error : new Error(String(error));
			this.records.clear();
		}
	}

	private loadLegacyHints(legacyPath: string): void {
		if (!fs.existsSync(legacyPath)) return;
		try {
			const parsed = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as LegacyRegistryFile;
			if (!Array.isArray(parsed.workspaces)) return;
			for (const value of parsed.workspaces) {
				if (!isRecord(value)) continue;
				const candidate =
					typeof value.cwdRealpath === "string"
						? value.cwdRealpath
						: typeof value.path === "string"
							? value.path
							: undefined;
				if (!candidate) continue;
				const pathHint = canonicalizePathAllowMissing(candidate);
				const workspaceHandle = workspaceHandleForPath(pathHint);
				this.records.set(workspaceHandle, {
					workspaceHandle,
					pathHint,
					pinned: false,
					displayName: typeof value.displayName === "string" ? value.displayName : undefined,
					lastOpenedAt: typeof value.lastOpenedAt === "number" ? value.lastOpenedAt : null,
				});
			}
		} catch {
			// A malformed legacy hint file must never affect native session discovery.
		}
	}

	private persist(): void {
		this.assertOpen();
		const directory = path.dirname(this.filePath);
		const temporaryPath = path.join(
			directory,
			`.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
		);
		const document: PreferencesFile = { version: 1, preferences: [...this.records.values()] };
		let descriptor: number | undefined;

		try {
			descriptor = fs.openSync(temporaryPath, "wx", 0o600);
			fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
			fs.fsyncSync(descriptor);
			fs.closeSync(descriptor);
			descriptor = undefined;
			fs.renameSync(temporaryPath, this.filePath);
			fs.chmodSync(this.filePath, 0o600);
			this.loadError = null;
			fsyncDirectory(directory);
		} finally {
			if (descriptor !== undefined) fs.closeSync(descriptor);
			try {
				fs.unlinkSync(temporaryPath);
			} catch {
				// The rename succeeded or the temporary file was never created.
			}
		}
	}
}

function normalizePreference(value: unknown): WorkspacePreference | null {
	if (!isRecord(value) || typeof value.pathHint !== "string" || !value.pathHint.trim()) return null;
	const pathHint = canonicalizePathAllowMissing(value.pathHint);
	return {
		workspaceHandle: workspaceHandleForPath(pathHint),
		pathHint,
		pinned: value.pinned === true,
		displayName: typeof value.displayName === "string" ? value.displayName : undefined,
		lastOpenedAt:
			typeof value.lastOpenedAt === "number" && Number.isFinite(value.lastOpenedAt)
				? value.lastOpenedAt
				: null,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function fsyncDirectory(directory: string): void {
	try {
		const descriptor = fs.openSync(directory, "r");
		try {
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
	} catch {
		// Directory fsync is unavailable on some platforms/filesystems.
	}
}
