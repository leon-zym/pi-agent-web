import { createHash } from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	canonicalizePathAllowMissing,
	type SessionDiscoverySource,
	type SessionLayoutResolver,
	workspaceHandleForPath,
} from "./session-layout-resolver.js";

const DISCOVERY_SOURCE_CONCURRENCY = 4;
const DIRECTORY_SUMMARY_CONCURRENCY = 2;
const DIRECTORY_REVISION_CONCURRENCY = 16;
const SESSION_SCAN_HIGH_WATER_MARK_BYTES = 64 * 1024;
const SESSION_SCAN_MAX_LINE_BYTES = 16 * 1024 * 1024;
const SESSION_SCAN_CHECKPOINT_BYTES = 64 * 1024;
const DEFAULT_DISCOVERY_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_DISCOVERY_MAX_PAGES = 4_096;
const DEFAULT_DISCOVERY_MAX_TIME_MS = 5_000;
const MAX_DISCOVERY_BYTES = 512 * 1024 * 1024;
const MAX_DISCOVERY_PAGES = 100_000;
const MAX_DISCOVERY_TIME_MS = 60_000;

/** The sidebar preview is deliberately independent of the size of the first user message. */
export const NATIVE_SESSION_FIRST_MESSAGE_MAX_CHARS = 160;
/** A single catalog instance never parses more than this many session files at once. */
export const NATIVE_SESSION_FILE_SCAN_CONCURRENCY = 8;

export type NativeSessionCatalogDiagnosticCode =
	| "discovery_bytes_exhausted"
	| "discovery_pages_exhausted"
	| "discovery_time_exhausted"
	| "discovery_cancelled"
	| "discovery_retryable";

export interface NativeSessionDiscoveryLimits {
	maxBytes: number;
	maxPages: number;
	maxTimeMs: number;
}

export type WorkspaceUnavailableReason = "cwd-empty" | "missing" | "not-directory" | "unreadable";

export interface NativeSessionRecord {
	sessionHandle: string;
	nativeSessionId: string;
	/** Canonical real file path. This, not nativeSessionId, is the persisted identity. */
	sessionFile: string;
	cwd: string;
	workspaceHandle: string;
	workspacePath: string | null;
	workspaceAvailable: boolean;
	workspaceUnavailableReason?: WorkspaceUnavailableReason;
	name?: string;
	parentSessionFile?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
}

export interface NativeWorkspaceRecord {
	workspaceHandle: string;
	workspacePath: string | null;
	workspaceAvailable: boolean;
	workspaceUnavailableReason?: WorkspaceUnavailableReason;
	sessionHandles: string[];
}

export interface NativeSessionCatalogDiagnostic {
	source: "layout" | "preferences" | "filesystem";
	message: string;
	path?: string;
	code?: NativeSessionCatalogDiagnosticCode;
	partial?: boolean;
	stale?: boolean;
	retryable?: boolean;
}

export interface NativeSessionCatalogSnapshot {
	generation: number;
	generatedAt: number;
	sessions: NativeSessionRecord[];
	workspaces: NativeWorkspaceRecord[];
	diagnostics: NativeSessionCatalogDiagnostic[];
	scannedSources: SessionDiscoverySource[];
	partial?: boolean;
	stale?: boolean;
}

export interface NativeSessionCatalogOptions {
	layoutResolver: SessionLayoutResolver;
	preferences?: WorkspacePreferenceHints;
	knownWorkspacePaths?: Iterable<string> | (() => Iterable<string>);
	cacheTtlMs?: number;
	now?: () => number;
	discoveryLimits?: Partial<NativeSessionDiscoveryLimits>;
	/** Direct aliases are kept convenient for embedders and test fixtures. */
	maxDiscoveryBytes?: number;
	maxDiscoveryPages?: number;
	maxDiscoveryTimeMs?: number;
}

export interface WorkspacePreferenceHints {
	pathHints(): string[];
	getLoadError?(): Error | null;
}

interface CachedDirectorySummary {
	revision: string;
	sessions: NativeSessionSummary[];
	files: Map<string, CachedSessionFileSummary>;
	retryable: boolean;
}

interface CachedSessionFileSummary {
	revision: string;
	identity: string;
	size: bigint;
	scanOffset: bigint;
	appendSafe: boolean;
	appendCheckpoint?: NativeSessionAppendCheckpoint;
	scanState?: NativeSessionScanState;
	summary: NativeSessionSummary | null;
}

interface NativeSessionSummary {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
}

interface NativeSessionHeader {
	id: string;
	cwd: string;
	timestamp?: string;
	parentSessionPath?: string;
}

interface NativeSessionScanState {
	header?: NativeSessionHeader;
	lineNumber: number;
	name?: string;
	messageCount: number;
	firstMessage?: string;
	lastActivityTime?: number;
}

interface NativeSessionScanResult {
	summary: NativeSessionSummary | null;
	retryable: boolean;
	scanState?: NativeSessionScanState;
	scanOffset?: bigint;
	appendSafe?: boolean;
	appendCheckpoint?: NativeSessionAppendCheckpoint;
	budgetCode?: NativeSessionCatalogDiagnosticCode;
}

interface NativeSessionAppendCheckpoint {
	prefix: string;
	suffix: string;
}

interface NativeSessionAppendCheckpointParts {
	prefix: Buffer;
	suffix: Buffer;
	checkpoint: NativeSessionAppendCheckpoint;
}

interface NativeSessionScanRetry {
	retry: true;
}

interface NativeSessionFileMetadata {
	revision: string;
	identity: string;
	size: bigint;
	dev: bigint;
	ino: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

interface NativeSessionDiscoveryScan {
	sessions: NativeSessionSummary[];
	diagnostics: NativeSessionCatalogDiagnostic[];
	coveredDirectories: Set<string>;
	partial: boolean;
	stale: boolean;
}

type DiscoveryBudgetCode = NativeSessionCatalogDiagnosticCode;

export function canonicalizeSessionFile(sessionFile: string): string {
	return canonicalizePathAllowMissing(sessionFile);
}

export function sessionHandleForCanonicalFile(canonicalSessionFile: string): string {
	return `session_${createHash("sha256").update(path.resolve(canonicalSessionFile)).digest("base64url")}`;
}

export function sessionHandleForFile(sessionFile: string): string {
	return sessionHandleForCanonicalFile(canonicalizeSessionFile(sessionFile));
}

/** A refreshable, process-local projection over Pi's native session files. */
export class NativeSessionCatalog {
	private readonly layoutResolver: SessionLayoutResolver;
	private readonly preferences?: WorkspacePreferenceHints;
	private readonly knownWorkspacePaths?: Iterable<string> | (() => Iterable<string>);
	private readonly cacheTtlMs: number;
	private readonly now: () => number;
	private readonly discoveryLimits: NativeSessionDiscoveryLimits;
	private snapshot: NativeSessionCatalogSnapshot | undefined;
	private refreshPromise: Promise<NativeSessionCatalogSnapshot> | undefined;
	private forcedRefreshPromise: Promise<NativeSessionCatalogSnapshot> | undefined;
	private forcedRefreshRequested = 0;
	private forcedRefreshCompleted = 0;
	private generation = 0;
	private readonly directoryCache = new Map<string, CachedDirectorySummary>();
	private readonly directoryScanLimiter = new AsyncLimiter(DIRECTORY_SUMMARY_CONCURRENCY);
	private readonly sessionFileScanLimiter = new AsyncLimiter(NATIVE_SESSION_FILE_SCAN_CONCURRENCY);
	private readonly directoryScans = new Map<string, Promise<NativeSessionDiscoveryScan>>();

	constructor(options: NativeSessionCatalogOptions) {
		this.layoutResolver = options.layoutResolver;
		this.preferences = options.preferences;
		this.knownWorkspacePaths = options.knownWorkspacePaths;
		this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 1_000);
		this.now = options.now ?? Date.now;
		this.discoveryLimits = normalizeDiscoveryLimits(options);
	}

	getSnapshot(): NativeSessionCatalogSnapshot | undefined {
		return this.snapshot;
	}

	refresh(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<NativeSessionCatalogSnapshot> {
		const now = this.now();
		if (!options.force && this.snapshot && now - this.snapshot.generatedAt < this.cacheTtlMs) {
			return Promise.resolve(this.snapshot);
		}
		if (options.force) {
			this.forcedRefreshRequested += 1;
			if (!this.forcedRefreshPromise) {
				const draining = this.drainForcedRefreshes(options.signal);
				const forced = draining.finally(() => {
					if (this.forcedRefreshPromise === forced) this.forcedRefreshPromise = undefined;
				});
				this.forcedRefreshPromise = forced;
			}
			return this.forcedRefreshPromise;
		}
		if (this.forcedRefreshPromise) return this.forcedRefreshPromise;
		return this.refreshPromise ?? this.startRefresh(options.signal);
	}

	private startRefresh(signal?: AbortSignal): Promise<NativeSessionCatalogSnapshot> {
		const refresh = this.discover(signal)
			.then((snapshot) => {
				this.snapshot = snapshot;
				return snapshot;
			})
			.finally(() => {
				if (this.refreshPromise === refresh) this.refreshPromise = undefined;
			});
		this.refreshPromise = refresh;
		return refresh;
	}

	private async drainForcedRefreshes(signal?: AbortSignal): Promise<NativeSessionCatalogSnapshot> {
		let latest = this.snapshot;
		for (;;) {
			const active = this.refreshPromise;
			if (active) {
				try {
					latest = await active;
				} catch {
					// A forced request still deserves a scan that starts after it.
				}
			}

			const coveredRequest = this.forcedRefreshRequested;
			if (this.forcedRefreshCompleted >= coveredRequest && latest) return latest;
			try {
				latest = await this.startRefresh(signal);
				this.forcedRefreshCompleted = coveredRequest;
			} catch (error) {
				if (this.forcedRefreshRequested > coveredRequest) continue;
				throw error;
			}
			if (this.forcedRefreshCompleted >= this.forcedRefreshRequested) return latest;
		}
	}

	private async discover(signal?: AbortSignal): Promise<NativeSessionCatalogSnapshot> {
		const diagnostics: NativeSessionCatalogDiagnostic[] = [];
		const budget = new DiscoveryBudget(this.discoveryLimits, this.now, signal);
		const previous = this.snapshot;
		const knownWorkspaces = new Set(this.readKnownWorkspacePaths(diagnostics));
		const infoByFile = new Map<string, NativeSessionSummary>();
		const scannedSourceKeys = new Set<string>();
		const scannedSources: SessionDiscoverySource[] = [];
		const currentDirectoryCacheKeys = new Set<string>();
		const coveredDirectories = new Set<string>();
		let partial = false;
		let stale = false;

		try {
			budget.check();
			for (;;) {
				budget.check();
				const plan = this.layoutResolver.discoveryPlan(knownWorkspaces);
				for (const diagnostic of plan.diagnostics) {
					diagnostics.push({
						source: "layout",
						message: `${diagnostic.scope} settings: ${diagnostic.message}`,
						path: diagnostic.workspacePath,
					});
				}

				const pendingSources = plan.sources.filter((source) => {
					const key = sourceKey(source);
					if (scannedSourceKeys.has(key)) return false;
					scannedSourceKeys.add(key);
					return true;
				});
				if (pendingSources.length === 0) break;

				const batches = await mapWithConcurrency(
					pendingSources,
					DISCOVERY_SOURCE_CONCURRENCY,
					async (source): Promise<NativeSessionDiscoveryScan> => {
						try {
							return await this.scanSource(source, currentDirectoryCacheKeys, budget);
						} catch (error) {
							if (isDiscoveryBudgetError(error)) {
								return discoveryBudgetScan(error, source.path, Boolean(previous));
							}
							if (isMissing(error)) return emptyDiscoveryScan();
							if (isRetryableNativeSessionScanError(error)) {
								return retryableDiscoveryScan(source.path, Boolean(previous));
							}
							diagnostics.push({
								source: "filesystem",
								message: error instanceof Error ? error.message : String(error),
								path: source.path,
							});
							return emptyDiscoveryScan();
						}
					},
				);
				scannedSources.push(...pendingSources);

				let discoveredWorkspace = false;
				for (const batch of batches) {
					diagnostics.push(...batch.diagnostics);
					partial ||= batch.partial;
					stale ||= batch.stale;
					for (const directory of batch.coveredDirectories) coveredDirectories.add(directory);
					for (const info of batch.sessions) {
						const sessionFile = canonicalizeSessionFile(info.path);
						if (!infoByFile.has(sessionFile)) infoByFile.set(sessionFile, info);
						if (info.cwd) {
							const workspacePath = canonicalizePathAllowMissing(info.cwd);
							if (!knownWorkspaces.has(workspacePath)) {
								knownWorkspaces.add(workspacePath);
								discoveredWorkspace = true;
							}
						}
					}
				}

				if (budget.interrupted) {
					partial = true;
					break;
				}

				// All new source paths have been scanned and no new Header.cwd can reveal
				// an additional project sessionDir.
				if (!discoveredWorkspace) {
					const followUpPlan = this.layoutResolver.discoveryPlan(knownWorkspaces);
					if (followUpPlan.sources.every((source) => scannedSourceKeys.has(sourceKey(source)))) break;
				}
			}
		} catch (error) {
			if (!isDiscoveryBudgetError(error)) throw error;
			partial = true;
			stale ||= Boolean(previous);
			diagnostics.push(discoveryBudgetDiagnostic(error, undefined, Boolean(previous)));
		}

		if (partial && previous) {
			for (const previousSession of previous.sessions) {
				const sessionFile = canonicalizeSessionFile(previousSession.sessionFile);
				const directory = canonicalizePathAllowMissing(path.dirname(sessionFile));
				if (coveredDirectories.has(directory) || infoByFile.has(sessionFile)) continue;
				infoByFile.set(sessionFile, nativeSummaryFromRecord(previousSession));
				stale = true;
			}
		}

		const sessions = [...infoByFile.entries()]
			.map(([sessionFile, info]) => toNativeSessionRecord(sessionFile, info))
			.sort(
				(a, b) => b.modified.getTime() - a.modified.getTime() || a.sessionFile.localeCompare(b.sessionFile),
			);
		const workspaces = buildWorkspaceRecords(sessions);
		this.pruneDirectoryCache(currentDirectoryCacheKeys);

		return {
			generation: ++this.generation,
			generatedAt: this.now(),
			sessions,
			workspaces,
			diagnostics: dedupeDiagnostics(diagnostics),
			scannedSources,
			...(partial ? { partial: true } : {}),
			...(stale ? { stale: true } : {}),
		};
	}

	private readKnownWorkspacePaths(diagnostics: NativeSessionCatalogDiagnostic[]): string[] {
		const paths: string[] = [];
		try {
			paths.push(
				...(typeof this.knownWorkspacePaths === "function"
					? this.knownWorkspacePaths()
					: (this.knownWorkspacePaths ?? [])),
			);
		} catch (error) {
			diagnostics.push({
				source: "preferences",
				message: `Failed to read workspace path hints: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		try {
			const loadError = this.preferences?.getLoadError?.();
			if (loadError) {
				diagnostics.push({
					source: "preferences",
					message: `Ignoring malformed workspace preferences: ${loadError.message}`,
				});
			}
			paths.push(...(this.preferences?.pathHints() ?? []));
		} catch (error) {
			diagnostics.push({
				source: "preferences",
				message: `Failed to read workspace preferences: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		return paths.filter(Boolean).map(canonicalizePathAllowMissing);
	}

	private async scanSource(
		source: SessionDiscoverySource,
		currentDirectoryCacheKeys: Set<string>,
		budget: DiscoveryBudget,
	): Promise<NativeSessionDiscoveryScan> {
		if (source.mode === "direct") {
			return this.scanDirectDirectory(source.path, currentDirectoryCacheKeys, budget);
		}

		const entries = await readDirectoryEntries(source.path, budget);
		const directories = entries
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => path.join(source.path, entry.name));
		const scans = await Promise.all(
			directories.map((directory) => this.scanDirectDirectory(directory, currentDirectoryCacheKeys, budget)),
		);
		return mergeDiscoveryScans(scans);
	}

	private scanDirectDirectory(
		directory: string,
		currentDirectoryCacheKeys: Set<string>,
		budget: DiscoveryBudget,
	): Promise<NativeSessionDiscoveryScan> {
		const cacheKey = canonicalizePathAllowMissing(directory);
		currentDirectoryCacheKeys.add(cacheKey);
		const activeScan = this.directoryScans.get(cacheKey);
		if (activeScan) return activeScan;

		const scan = this.directoryScanLimiter
			.run(async () => {
				const cached = this.directoryCache.get(cacheKey);
				let beforeRevision: string;
				try {
					beforeRevision = await directoryRevision(directory, budget);
				} catch (error) {
					if (isDiscoveryBudgetError(error)) {
						return discoveryBudgetScan(error, directory, Boolean(cached));
					}
					if (isMissing(error)) {
						return {
							sessions: [],
							diagnostics: [],
							coveredDirectories: new Set([cacheKey]),
							partial: false,
							stale: false,
						};
					}
					if (isRetryableNativeSessionScanError(error)) {
						return retryableDiscoveryScan(directory, Boolean(cached), cached?.sessions);
					}
					throw error;
				}
				if (cached?.retryable !== true && cached?.revision === beforeRevision) {
					return {
						sessions: cached.sessions,
						diagnostics: [],
						coveredDirectories: new Set([cacheKey]),
						partial: false,
						stale: false,
					};
				}

				const scanned = await this.scanSessionDirectory(directory, cached?.files, budget);
				let afterRevision: string;
				try {
					afterRevision = await directoryRevision(directory, budget);
				} catch (error) {
					if (isDiscoveryBudgetError(error)) {
						return {
							...scanned,
							diagnostics: [
								...scanned.diagnostics,
								discoveryBudgetDiagnostic(error, directory, Boolean(cached)),
							],
							partial: true,
							stale: scanned.stale || Boolean(cached),
							coveredDirectories: new Set<string>(),
						};
					}
					if (isRetryableNativeSessionScanError(error)) {
						return {
							...scanned,
							retryable: true,
							diagnostics: [...scanned.diagnostics, retryableDiscoveryDiagnostic(directory, Boolean(cached))],
							partial: true,
							stale: scanned.stale || Boolean(cached),
							coveredDirectories: new Set<string>(),
						};
					}
					throw error;
				}
				if (beforeRevision === afterRevision) {
					this.directoryCache.set(cacheKey, {
						revision: afterRevision,
						sessions: scanned.sessions,
						files: scanned.files,
						// Partial/budgeted views are useful stale data, but must never
						// become a cache hit that suppresses the next retry.
						retryable: scanned.partial || scanned.retryable,
					});
				}
				return {
					...scanned,
					coveredDirectories: scanned.partial ? new Set<string>() : new Set([cacheKey]),
				};
			})
			.finally(() => {
				if (this.directoryScans.get(cacheKey) === scan) this.directoryScans.delete(cacheKey);
			});
		this.directoryScans.set(cacheKey, scan);
		return scan;
	}

	private async scanSessionDirectory(
		directory: string,
		cachedFiles: ReadonlyMap<string, CachedSessionFileSummary> | undefined,
		budget: DiscoveryBudget,
	): Promise<{
		sessions: NativeSessionSummary[];
		files: Map<string, CachedSessionFileSummary>;
		retryable: boolean;
		diagnostics: NativeSessionCatalogDiagnostic[];
		coveredDirectories: Set<string>;
		partial: boolean;
		stale: boolean;
	}> {
		let entries: fs.Dirent[];
		try {
			entries = await readDirectoryEntries(directory, budget);
		} catch (error) {
			if (isMissing(error)) {
				return {
					sessions: [],
					files: new Map(),
					retryable: true,
					diagnostics: [],
					coveredDirectories: new Set<string>(),
					partial: false,
					stale: false,
				};
			}
			if (isDiscoveryBudgetError(error)) {
				return discoveryBudgetDirectoryScan(error, directory, cachedFiles);
			}
			if (isRetryableNativeSessionScanError(error)) {
				return retryableDiscoveryDirectoryScan(directory, cachedFiles);
			}
			throw error;
		}

		const files = new Map(
			entries
				.filter((entry) => entry.name.endsWith(".jsonl") && (entry.isFile() || entry.isSymbolicLink()))
				.map((entry) => {
					const file = path.join(directory, entry.name);
					return [canonicalizeSessionFile(file), file] as const;
				}),
		);
		const scannedFiles = await mapWithConcurrency(
			[...files.entries()],
			NATIVE_SESSION_FILE_SCAN_CONCURRENCY,
			async ([canonicalFile, file]): Promise<{
				canonicalFile: string;
				cached?: CachedSessionFileSummary;
				retryable: boolean;
				budgetCode?: NativeSessionCatalogDiagnosticCode;
				diagnostic?: NativeSessionCatalogDiagnostic;
			}> => {
				try {
					budget.check();
					const cached = cachedFiles?.get(canonicalFile);
					let metadata: NativeSessionFileMetadata;
					try {
						metadata = await sessionFileMetadata(file);
					} catch (error) {
						const retryable = isRetryableNativeSessionScanError(error);
						return {
							canonicalFile,
							...(retryable && cached ? { cached } : {}),
							retryable,
							...(retryable ? { diagnostic: retryableDiscoveryDiagnostic(file, cached !== undefined) } : {}),
						};
					}
					if (cached?.revision === metadata.revision) return { canonicalFile, cached, retryable: false };
					const result = await this.sessionFileScanLimiter.run(() =>
						scanNativeSessionFile(file, metadata, cached, budget),
					);
					if (result.budgetCode) {
						return {
							canonicalFile,
							cached,
							retryable: false,
							budgetCode: result.budgetCode,
						};
					}
					if (result.retryable) {
						return {
							canonicalFile,
							...(cached ? { cached } : {}),
							retryable: true,
							diagnostic: retryableDiscoveryDiagnostic(file, cached !== undefined),
						};
					}
					return {
						canonicalFile,
						cached: {
							revision: metadata.revision,
							identity: metadata.identity,
							size: metadata.size,
							scanOffset: result.scanOffset ?? metadata.size,
							appendSafe: result.appendSafe ?? false,
							appendCheckpoint: result.appendCheckpoint,
							scanState: result.scanState,
							summary: result.summary ? { ...result.summary, path: canonicalFile } : null,
						},
						retryable: false,
					};
				} catch (error) {
					if (isDiscoveryBudgetError(error)) {
						return {
							canonicalFile,
							cached: cachedFiles?.get(canonicalFile),
							retryable: false,
							budgetCode: error.code,
						};
					}
					if (budget?.interrupted) {
						return {
							canonicalFile,
							cached: cachedFiles?.get(canonicalFile),
							retryable: false,
							budgetCode: budget.interrupted,
						};
					}
					if (isRetryableNativeSessionScanError(error)) {
						return {
							canonicalFile,
							cached: cachedFiles?.get(canonicalFile),
							retryable: true,
							diagnostic: retryableDiscoveryDiagnostic(file, Boolean(cachedFiles?.get(canonicalFile))),
						};
					}
					throw error;
				}
			},
		);
		const fileCache = new Map(
			scannedFiles.flatMap((entry) => (entry.cached ? [[entry.canonicalFile, entry.cached] as const] : [])),
		);
		const budgetCodes = new Set(
			scannedFiles.flatMap((entry) => (entry.budgetCode ? [entry.budgetCode] : [])),
		);
		const retryable = scannedFiles.some((entry) => entry.retryable);
		const partial = budgetCodes.size > 0 || retryable;
		const stale =
			(budgetCodes.size > 0 && Boolean(cachedFiles)) ||
			scannedFiles.some((entry) => entry.retryable && entry.cached !== undefined);
		return {
			sessions: scannedFiles
				.map((entry) => entry.cached?.summary ?? null)
				.filter((summary): summary is NativeSessionSummary => summary !== null),
			files: fileCache,
			retryable,
			diagnostics: [
				...[...budgetCodes].map((code) => discoveryBudgetDiagnosticForCode(code, directory, stale)),
				...scannedFiles.flatMap((entry) => (entry.diagnostic ? [entry.diagnostic] : [])),
			],
			coveredDirectories: new Set(),
			partial,
			stale,
		};
	}

	private pruneDirectoryCache(currentDirectoryCacheKeys: ReadonlySet<string>): void {
		for (const cacheKey of this.directoryCache.keys()) {
			if (!currentDirectoryCacheKeys.has(cacheKey)) this.directoryCache.delete(cacheKey);
		}
	}
}

function sourceKey(source: SessionDiscoverySource): string {
	return `${source.mode}\0${canonicalizePathAllowMissing(source.path)}`;
}

function toNativeSessionRecord(sessionFile: string, info: NativeSessionSummary): NativeSessionRecord {
	const workspace = inspectWorkspace(info.cwd, sessionFile);
	return {
		sessionHandle: sessionHandleForCanonicalFile(sessionFile),
		nativeSessionId: info.id,
		sessionFile,
		cwd: workspace.workspacePath ?? info.cwd,
		workspaceHandle: workspace.workspaceHandle,
		workspacePath: workspace.workspacePath,
		workspaceAvailable: workspace.workspaceAvailable,
		workspaceUnavailableReason: workspace.workspaceUnavailableReason,
		name: info.name,
		parentSessionFile: info.parentSessionPath ? canonicalizeSessionFile(info.parentSessionPath) : undefined,
		created: new Date(info.created),
		modified: new Date(info.modified),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	};
}

async function scanNativeSessionFile(
	filePath: string,
	metadata: NativeSessionFileMetadata,
	cached?: CachedSessionFileSummary,
	budget?: DiscoveryBudget,
): Promise<NativeSessionScanResult> {
	let currentMetadata = metadata;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const result = await scanNativeSessionFileAttempt(filePath, currentMetadata, cached, budget);
		if (!("retry" in result)) return result;
		if (attempt === 1) return { summary: null, retryable: true };
		try {
			currentMetadata = await sessionFileMetadata(filePath);
		} catch (error) {
			return { summary: null, retryable: isRetryableNativeSessionScanError(error) };
		}
	}
	return { summary: null, retryable: true };
}

async function scanNativeSessionFileAttempt(
	filePath: string,
	metadata: NativeSessionFileMetadata,
	cached: CachedSessionFileSummary | undefined,
	budget: DiscoveryBudget | undefined,
): Promise<NativeSessionScanResult | NativeSessionScanRetry> {
	let handle: FileHandle | undefined;
	try {
		budget?.check();
		handle = await fs.promises.open(filePath, "r");
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile()) return { summary: null, retryable: false };
		if (!sameSessionFileMetadata(stat, metadata)) return { retry: true };
		if (stat.size === 0n) return { summary: null, retryable: false };

		const incrementalParts = await canIncrementallyScan(handle, metadata, cached, budget);
		const incremental = incrementalParts !== null;
		const state = incremental ? cloneScanState(cached?.scanState) : { lineNumber: 0, messageCount: 0 };
		const checkpoint = new AppendCheckpointAccumulator(incrementalParts ?? undefined);
		const decoder = new StringDecoder("utf8");
		let buffered = "";
		const stream = fs.createReadStream(filePath, {
			fd: handle.fd,
			autoClose: false,
			highWaterMark: SESSION_SCAN_HIGH_WATER_MARK_BYTES,
			...(budget?.signal ? { signal: budget.signal } : {}),
			...(incremental ? { start: Number(cached?.scanOffset) } : {}),
		});

		try {
			for await (const chunk of stream) {
				const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
				budget?.consumeBytes(bytes.byteLength);
				checkpoint.consume(bytes);
				buffered += decoder.write(bytes);
				for (;;) {
					const newlineIndex = buffered.indexOf("\n");
					if (newlineIndex === -1) break;
					parseNativeSessionLine(state, buffered.slice(0, newlineIndex));
					buffered = buffered.slice(newlineIndex + 1);
				}
				if (Buffer.byteLength(buffered) > SESSION_SCAN_MAX_LINE_BYTES) {
					throw new Error(`Session JSONL line exceeds ${String(SESSION_SCAN_MAX_LINE_BYTES)} bytes`);
				}
			}
		} finally {
			if (!stream.readableEnded) stream.destroy();
		}

		buffered += decoder.end();
		const appendSafe = buffered.length === 0;
		if (buffered.length > 0) {
			if (Buffer.byteLength(buffered) > SESSION_SCAN_MAX_LINE_BYTES) {
				throw new Error(`Session JSONL line exceeds ${String(SESSION_SCAN_MAX_LINE_BYTES)} bytes`);
			}
			parseNativeSessionLine(state, buffered);
		}
		const finalStat = await handle.stat({ bigint: true });
		if (!sameSessionFileMetadata(finalStat, metadata)) return { retry: true };
		const pathMetadata = await sessionFileMetadata(filePath);
		if (pathMetadata.identity !== metadata.identity || pathMetadata.revision !== metadata.revision) {
			return { retry: true };
		}

		const header = state.header;
		if (!header) {
			return {
				summary: null,
				retryable: false,
				scanState: state,
				scanOffset: metadata.size,
				appendSafe,
			};
		}
		const headerTime = parseDateMillis(header.timestamp);
		const createdTime = headerTime ?? safeStatCreatedTime(stat);
		const modifiedTime =
			state.lastActivityTime !== undefined && state.lastActivityTime > 0
				? state.lastActivityTime
				: (headerTime ?? Number(stat.mtimeMs));

		return {
			summary: {
				path: filePath,
				id: header.id,
				cwd: header.cwd,
				name: state.name,
				parentSessionPath: header.parentSessionPath,
				created: new Date(createdTime),
				modified: new Date(modifiedTime),
				messageCount: state.messageCount,
				firstMessage: state.firstMessage ?? "",
			},
			retryable: false,
			scanState: state,
			scanOffset: metadata.size,
			appendSafe,
			appendCheckpoint: checkpoint.checkpoint(),
		};
	} catch (error) {
		if (isDiscoveryBudgetError(error)) return { summary: null, retryable: false, budgetCode: error.code };
		if (budget?.interrupted) {
			return { summary: null, retryable: false, budgetCode: budget.interrupted };
		}
		// Native history discovery is best-effort. One changing, corrupt, or
		// unreadable JSONL file must not hide healthy sessions beside it.
		return { summary: null, retryable: isRetryableNativeSessionScanError(error) };
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function canIncrementallyScan(
	handle: FileHandle,
	metadata: NativeSessionFileMetadata,
	cached: CachedSessionFileSummary | undefined,
	budget?: DiscoveryBudget,
): Promise<NativeSessionAppendCheckpointParts | null> {
	if (
		!cached?.appendSafe ||
		!cached.scanState?.header ||
		!cached.appendCheckpoint ||
		cached.identity !== metadata.identity ||
		cached.scanOffset !== cached.size ||
		metadata.size <= cached.scanOffset ||
		cached.scanOffset > BigInt(Number.MAX_SAFE_INTEGER)
	) {
		return null;
	}
	const checkpoint = await readAppendCheckpoint(handle, cached.size, budget);
	if (!checkpoint || !sameAppendCheckpoint(checkpoint.checkpoint, cached.appendCheckpoint)) return null;
	const header = await readSessionHeader(handle, budget);
	return header !== null && sameSessionHeader(header, cached.scanState.header) ? checkpoint : null;
}

async function readSessionHeader(
	handle: FileHandle,
	budget?: DiscoveryBudget,
): Promise<NativeSessionHeader | null> {
	budget?.check();
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	let position = 0;
	while (totalBytes <= SESSION_SCAN_MAX_LINE_BYTES) {
		const buffer = Buffer.allocUnsafe(
			Math.min(SESSION_SCAN_HIGH_WATER_MARK_BYTES, SESSION_SCAN_MAX_LINE_BYTES + 1 - totalBytes),
		);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
		if (bytesRead === 0) return null;
		budget?.consumeBytes(bytesRead);
		const chunk = buffer.subarray(0, bytesRead);
		const newlineIndex = chunk.indexOf(0x0a);
		if (newlineIndex !== -1) {
			const line = Buffer.concat([...chunks, chunk.subarray(0, newlineIndex)]).toString("utf8");
			try {
				return parseNativeSessionHeader(JSON.parse(line));
			} catch {
				return null;
			}
		}
		chunks.push(chunk);
		totalBytes += bytesRead;
		position += bytesRead;
	}
	return null;
}

async function readAppendCheckpoint(
	handle: FileHandle,
	size: bigint,
	budget?: DiscoveryBudget,
): Promise<NativeSessionAppendCheckpointParts | null> {
	if (size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
	const numericSize = Number(size);
	const prefixLength = Math.min(SESSION_SCAN_CHECKPOINT_BYTES, numericSize);
	const suffixStart = Math.max(0, numericSize - SESSION_SCAN_CHECKPOINT_BYTES);
	const suffixLength = numericSize - suffixStart;
	const prefix = await readFileRange(handle, 0, prefixLength, budget);
	const suffix = await readFileRange(handle, suffixStart, suffixLength, budget);
	if (prefix.length !== prefixLength || suffix.length !== suffixLength) return null;
	return { prefix, suffix, checkpoint: appendCheckpoint(prefix, suffix) };
}

async function readFileRange(
	handle: FileHandle,
	position: number,
	length: number,
	budget?: DiscoveryBudget,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let offset = 0;
	while (offset < length) {
		const buffer = Buffer.allocUnsafe(Math.min(SESSION_SCAN_HIGH_WATER_MARK_BYTES, length - offset));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, position + offset);
		if (bytesRead === 0) break;
		budget?.consumeBytes(bytesRead);
		chunks.push(buffer.subarray(0, bytesRead));
		offset += bytesRead;
	}
	return Buffer.concat(chunks);
}

function appendCheckpoint(prefix: Buffer, suffix: Buffer): NativeSessionAppendCheckpoint {
	return {
		prefix: createHash("sha256").update(prefix).digest("hex"),
		suffix: createHash("sha256").update(suffix).digest("hex"),
	};
}

function sameSessionFileMetadata(stat: fs.BigIntStats, metadata: NativeSessionFileMetadata): boolean {
	return (
		stat.isFile() &&
		stat.dev === metadata.dev &&
		stat.ino === metadata.ino &&
		stat.size === metadata.size &&
		stat.mtimeNs === metadata.mtimeNs &&
		stat.ctimeNs === metadata.ctimeNs
	);
}

function sameAppendCheckpoint(
	left: NativeSessionAppendCheckpoint,
	right: NativeSessionAppendCheckpoint,
): boolean {
	return left.prefix === right.prefix && left.suffix === right.suffix;
}

class AppendCheckpointAccumulator {
	private prefix: Buffer;
	private suffix: Buffer;

	constructor(seed?: NativeSessionAppendCheckpointParts) {
		this.prefix = seed?.prefix ?? Buffer.alloc(0);
		this.suffix = seed?.suffix ?? Buffer.alloc(0);
	}

	consume(bytes: Buffer): void {
		if (this.prefix.length < SESSION_SCAN_CHECKPOINT_BYTES) {
			this.prefix = Buffer.concat([
				this.prefix,
				bytes.subarray(0, SESSION_SCAN_CHECKPOINT_BYTES - this.prefix.length),
			]);
		}
		this.suffix = Buffer.concat([this.suffix, bytes]).subarray(-SESSION_SCAN_CHECKPOINT_BYTES);
	}

	checkpoint(): NativeSessionAppendCheckpoint {
		return appendCheckpoint(this.prefix, this.suffix);
	}
}

function cloneScanState(state: NativeSessionScanState | undefined): NativeSessionScanState {
	if (!state) return { lineNumber: 0, messageCount: 0 };
	return {
		...state,
		...(state.header ? { header: { ...state.header } } : {}),
	};
}

function sameSessionHeader(left: NativeSessionHeader, right: NativeSessionHeader): boolean {
	return (
		left.id === right.id &&
		left.cwd === right.cwd &&
		left.timestamp === right.timestamp &&
		left.parentSessionPath === right.parentSessionPath
	);
}

function parseNativeSessionLine(state: NativeSessionScanState, rawLine: string): void {
	const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
	if (Buffer.byteLength(line) > SESSION_SCAN_MAX_LINE_BYTES) {
		throw new Error(`Session JSONL line exceeds ${String(SESSION_SCAN_MAX_LINE_BYTES)} bytes`);
	}

	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		if (state.lineNumber === 0) throw new Error("Session JSONL has an invalid header");
		state.lineNumber += 1;
		return;
	}

	if (state.lineNumber === 0) {
		state.header = parseNativeSessionHeader(value);
		state.lineNumber += 1;
		return;
	}
	state.lineNumber += 1;
	if (!isRecord(value)) return;

	if (value.type === "session_info") {
		state.name = typeof value.name === "string" ? value.name.trim() || undefined : undefined;
		return;
	}
	if (value.type !== "message") return;

	state.messageCount += 1;
	const message = isRecord(value.message) ? value.message : undefined;
	if (!message || (message.role !== "user" && message.role !== "assistant") || !("content" in message)) {
		return;
	}

	const activityTime =
		typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
			? message.timestamp
			: parseDateMillis(typeof value.timestamp === "string" ? value.timestamp : undefined);
	if (activityTime !== undefined) {
		state.lastActivityTime = Math.max(state.lastActivityTime ?? 0, activityTime);
	}

	if (state.firstMessage === undefined && message.role === "user") {
		const firstMessage = sidebarTextFromContent(message.content);
		if (firstMessage) state.firstMessage = firstMessage;
	}
}

function parseNativeSessionHeader(value: unknown): NativeSessionHeader {
	if (!isRecord(value) || value.type !== "session" || typeof value.id !== "string" || !value.id) {
		throw new Error("Session JSONL has an invalid header");
	}
	return {
		id: value.id,
		cwd: typeof value.cwd === "string" ? value.cwd : "",
		timestamp: typeof value.timestamp === "string" ? value.timestamp : undefined,
		parentSessionPath: typeof value.parentSession === "string" ? value.parentSession : undefined,
	};
}

function sidebarTextFromContent(content: unknown): string {
	const textParts: string[] = [];
	if (typeof content === "string") {
		textParts.push(content);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
				textParts.push(block.text);
			}
		}
	}
	const previewText = collapseExpandedSkillInvocation(textParts.join("\n\n"));

	const characters: string[] = [];
	let whitespacePending = false;
	for (const character of previewText) {
		if (/\s/u.test(character)) {
			if (characters.length > 0) whitespacePending = true;
			continue;
		}
		if (whitespacePending) {
			if (characters.length >= NATIVE_SESSION_FIRST_MESSAGE_MAX_CHARS) {
				return characters.join("");
			}
			characters.push(" ");
			whitespacePending = false;
		}
		if (characters.length >= NATIVE_SESSION_FIRST_MESSAGE_MAX_CHARS) {
			return characters.join("");
		}
		characters.push(character);
	}
	return characters.join("");
}

function collapseExpandedSkillInvocation(text: string): string {
	const header = text.match(/^<skill name="([^"\r\n]+)" location="[^"\r\n]+">\r?\n/);
	if (!header) return text;
	const invocation = `/skill:${header[1]}`;
	const bodyAndTail = text.slice(header[0].length);
	// Skill Markdown can contain literal closing-token examples. The envelope is
	// not escaped, so ambiguous boundaries must fail private instead of exposing a tail.
	const closingIndex = bodyAndTail.indexOf("</skill>");
	if (closingIndex === -1) return invocation;
	if (closingIndex === 0 || bodyAndTail[closingIndex - 1] !== "\n") return invocation;
	if (bodyAndTail.indexOf("</skill>", closingIndex + "</skill>".length) !== -1) {
		return invocation;
	}
	const tail = bodyAndTail.slice(closingIndex + "</skill>".length);
	if (tail === "") return invocation;
	const separator = tail.match(/^(?:\r?\n){2}/)?.[0];
	if (!separator) return invocation;
	const argumentsText = tail.slice(separator.length).trim();
	return argumentsText ? `${invocation} ${argumentsText}` : invocation;
}

function parseDateMillis(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function safeStatCreatedTime(stat: fs.Stats | fs.BigIntStats): number {
	const birthtimeMs = Number(stat.birthtimeMs);
	return birthtimeMs > 0 ? birthtimeMs : Number(stat.mtimeMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function inspectWorkspace(cwd: string, sessionFile: string): Omit<NativeWorkspaceRecord, "sessionHandles"> {
	if (!cwd) {
		return {
			workspaceHandle: `workspace_unknown_${createHash("sha256").update(sessionFile).digest("base64url")}`,
			workspacePath: null,
			workspaceAvailable: false,
			workspaceUnavailableReason: "cwd-empty",
		};
	}

	const workspacePath = canonicalizePathAllowMissing(cwd);
	const workspaceHandle = workspaceHandleForPath(workspacePath);
	try {
		const stat = fs.statSync(workspacePath);
		if (!stat.isDirectory()) {
			return {
				workspaceHandle,
				workspacePath,
				workspaceAvailable: false,
				workspaceUnavailableReason: "not-directory",
			};
		}
		try {
			fs.accessSync(workspacePath, fs.constants.R_OK | fs.constants.X_OK);
		} catch {
			return {
				workspaceHandle,
				workspacePath,
				workspaceAvailable: false,
				workspaceUnavailableReason: "unreadable",
			};
		}
		return { workspaceHandle, workspacePath, workspaceAvailable: true };
	} catch (error) {
		return {
			workspaceHandle,
			workspacePath,
			workspaceAvailable: false,
			workspaceUnavailableReason: isMissing(error) ? "missing" : "unreadable",
		};
	}
}

function buildWorkspaceRecords(sessions: NativeSessionRecord[]): NativeWorkspaceRecord[] {
	const records = new Map<string, NativeWorkspaceRecord>();
	for (const session of sessions) {
		const existing = records.get(session.workspaceHandle);
		if (existing) {
			existing.sessionHandles.push(session.sessionHandle);
			continue;
		}
		records.set(session.workspaceHandle, {
			workspaceHandle: session.workspaceHandle,
			workspacePath: session.workspacePath,
			workspaceAvailable: session.workspaceAvailable,
			workspaceUnavailableReason: session.workspaceUnavailableReason,
			sessionHandles: [session.sessionHandle],
		});
	}
	return [...records.values()];
}

function emptyDiscoveryScan(): NativeSessionDiscoveryScan {
	return {
		sessions: [],
		diagnostics: [],
		coveredDirectories: new Set(),
		partial: false,
		stale: false,
	};
}

function mergeDiscoveryScans(scans: NativeSessionDiscoveryScan[]): NativeSessionDiscoveryScan {
	const coveredDirectories = new Set<string>();
	for (const scan of scans) {
		for (const directory of scan.coveredDirectories) coveredDirectories.add(directory);
	}
	return {
		sessions: scans.flatMap((scan) => scan.sessions),
		diagnostics: scans.flatMap((scan) => scan.diagnostics),
		coveredDirectories,
		partial: scans.some((scan) => scan.partial),
		stale: scans.some((scan) => scan.stale),
	};
}

function discoveryBudgetScan(
	error: DiscoveryBudgetExceeded,
	pathValue: string | undefined,
	stale: boolean,
): NativeSessionDiscoveryScan {
	return {
		sessions: [],
		diagnostics: [discoveryBudgetDiagnostic(error, pathValue, stale)],
		coveredDirectories: new Set(),
		partial: true,
		stale,
	};
}

function retryableDiscoveryScan(
	pathValue: string,
	stale: boolean,
	sessions: NativeSessionSummary[] = [],
): NativeSessionDiscoveryScan {
	return {
		sessions,
		diagnostics: [retryableDiscoveryDiagnostic(pathValue, stale)],
		coveredDirectories: new Set(),
		partial: true,
		stale,
	};
}

function retryableDiscoveryDirectoryScan(
	directory: string,
	cachedFiles: ReadonlyMap<string, CachedSessionFileSummary> | undefined,
): {
	sessions: NativeSessionSummary[];
	files: Map<string, CachedSessionFileSummary>;
	retryable: boolean;
	diagnostics: NativeSessionCatalogDiagnostic[];
	coveredDirectories: Set<string>;
	partial: boolean;
	stale: boolean;
} {
	const files = new Map(cachedFiles ?? []);
	return {
		sessions: [...files.values()]
			.map((entry) => entry.summary)
			.filter((summary): summary is NativeSessionSummary => summary !== null),
		files,
		retryable: true,
		diagnostics: [retryableDiscoveryDiagnostic(directory, Boolean(cachedFiles))],
		coveredDirectories: new Set(),
		partial: true,
		stale: Boolean(cachedFiles),
	};
}

function discoveryBudgetDirectoryScan(
	error: DiscoveryBudgetExceeded,
	directory: string,
	cachedFiles: ReadonlyMap<string, CachedSessionFileSummary> | undefined,
): {
	sessions: NativeSessionSummary[];
	files: Map<string, CachedSessionFileSummary>;
	retryable: boolean;
	diagnostics: NativeSessionCatalogDiagnostic[];
	coveredDirectories: Set<string>;
	partial: boolean;
	stale: boolean;
} {
	const files = new Map(cachedFiles ?? []);
	return {
		sessions: [...files.values()]
			.map((entry) => entry.summary)
			.filter((summary): summary is NativeSessionSummary => summary !== null),
		files,
		retryable: false,
		diagnostics: [discoveryBudgetDiagnostic(error, directory, Boolean(cachedFiles))],
		coveredDirectories: new Set(),
		partial: true,
		stale: Boolean(cachedFiles),
	};
}

function discoveryBudgetDiagnostic(
	error: DiscoveryBudgetExceeded,
	pathValue: string | undefined,
	stale: boolean,
): NativeSessionCatalogDiagnostic {
	return discoveryBudgetDiagnosticForCode(error.code, pathValue, stale);
}

function discoveryBudgetDiagnosticForCode(
	code: NativeSessionCatalogDiagnosticCode,
	pathValue: string | undefined,
	stale: boolean,
): NativeSessionCatalogDiagnostic {
	return {
		source: "filesystem",
		code,
		message: discoveryBudgetMessage(code),
		...(pathValue ? { path: pathValue } : {}),
		partial: true,
		stale,
	};
}

function retryableDiscoveryDiagnostic(pathValue: string, stale: boolean): NativeSessionCatalogDiagnostic {
	return {
		source: "filesystem",
		code: "discovery_retryable",
		message: discoveryBudgetMessage("discovery_retryable"),
		path: pathValue,
		partial: true,
		stale,
		retryable: true,
	};
}

function discoveryBudgetMessage(code: NativeSessionCatalogDiagnosticCode): string {
	switch (code) {
		case "discovery_bytes_exhausted":
			return "Native Session discovery stopped after reaching its byte budget";
		case "discovery_pages_exhausted":
			return "Native Session discovery stopped after reaching its page budget";
		case "discovery_time_exhausted":
			return "Native Session discovery stopped after reaching its time budget";
		case "discovery_cancelled":
			return "Native Session discovery was cancelled";
		case "discovery_retryable":
			return "Native Session discovery encountered a transient filesystem state and will be retried";
	}
}

function nativeSummaryFromRecord(session: NativeSessionRecord): NativeSessionSummary {
	return {
		path: session.sessionFile,
		id: session.nativeSessionId,
		cwd: session.cwd,
		name: session.name,
		parentSessionPath: session.parentSessionFile,
		created: new Date(session.created),
		modified: new Date(session.modified),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
	};
}

async function readDirectoryEntries(directory: string, budget: DiscoveryBudget): Promise<fs.Dirent[]> {
	budget.check();
	const handle = await fs.promises.opendir(directory);
	const entries: fs.Dirent[] = [];
	try {
		for await (const entry of handle) {
			budget.consumePage();
			entries.push(entry);
		}
		return entries;
	} finally {
		await handle.close().catch(() => {});
	}
}

class DiscoveryBudgetExceeded extends Error {
	readonly code: DiscoveryBudgetCode;

	constructor(code: DiscoveryBudgetCode) {
		super(discoveryBudgetMessage(code));
		this.name = "DiscoveryBudgetExceeded";
		this.code = code;
	}
}

class DiscoveryBudget {
	private readonly startedAt: number;
	private bytes = 0;
	private pages = 0;
	private reason: DiscoveryBudgetCode | undefined;

	constructor(
		private readonly limits: NativeSessionDiscoveryLimits,
		private readonly now: () => number,
		readonly signal?: AbortSignal,
	) {
		this.startedAt = now();
	}

	get interrupted(): DiscoveryBudgetCode | undefined {
		return this.reason ?? (this.signal?.aborted ? "discovery_cancelled" : undefined);
	}

	check(): void {
		if (this.signal?.aborted) throw this.exhaust("discovery_cancelled");
		if (this.now() - this.startedAt >= this.limits.maxTimeMs) {
			throw this.exhaust("discovery_time_exhausted");
		}
	}

	consumePage(): void {
		this.check();
		if (this.pages >= this.limits.maxPages) throw this.exhaust("discovery_pages_exhausted");
		this.pages += 1;
	}

	consumeBytes(bytes: number): void {
		this.check();
		if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.maxBytes - this.bytes) {
			throw this.exhaust("discovery_bytes_exhausted");
		}
		this.bytes += bytes;
	}

	private exhaust(code: DiscoveryBudgetCode): DiscoveryBudgetExceeded {
		this.reason ??= code;
		return new DiscoveryBudgetExceeded(this.reason);
	}
}

function isDiscoveryBudgetError(error: unknown): error is DiscoveryBudgetExceeded {
	return error instanceof DiscoveryBudgetExceeded;
}

function normalizeDiscoveryLimits(options: NativeSessionCatalogOptions): NativeSessionDiscoveryLimits {
	const configured = options.discoveryLimits;
	return {
		maxBytes: normalizeDiscoveryLimit(
			options.maxDiscoveryBytes ?? configured?.maxBytes,
			DEFAULT_DISCOVERY_MAX_BYTES,
			MAX_DISCOVERY_BYTES,
		),
		maxPages: normalizeDiscoveryLimit(
			options.maxDiscoveryPages ?? configured?.maxPages,
			DEFAULT_DISCOVERY_MAX_PAGES,
			MAX_DISCOVERY_PAGES,
		),
		maxTimeMs: normalizeDiscoveryLimit(
			options.maxDiscoveryTimeMs ?? configured?.maxTimeMs,
			DEFAULT_DISCOVERY_MAX_TIME_MS,
			MAX_DISCOVERY_TIME_MS,
		),
	};
}

function normalizeDiscoveryLimit(value: number | undefined, fallback: number, maximum: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(0, Math.floor(value ?? fallback)));
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		for (;;) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await worker(items[index] as T);
		}
	});
	await Promise.all(runners);
	return results;
}

async function directoryRevision(directory: string, budget?: DiscoveryBudget): Promise<string> {
	let entries: string[];
	try {
		entries = (
			budget
				? (await readDirectoryEntries(directory, budget)).map((entry) => entry.name)
				: await fs.promises.readdir(directory)
		)
			.filter((entry) => entry.endsWith(".jsonl"))
			.sort();
	} catch (error) {
		if (isMissing(error)) return "missing";
		throw error;
	}
	const revisions = await mapWithConcurrency(
		entries,
		DIRECTORY_REVISION_CONCURRENCY,
		async (entry): Promise<string> => {
			budget?.check();
			const revision = await sessionFileRevision(path.join(directory, entry));
			budget?.check();
			return `${entry}\0${revision}`;
		},
	);
	return createHash("sha256").update(revisions.join("\n")).digest("base64url");
}

async function sessionFileRevision(filePath: string): Promise<string> {
	try {
		return (await sessionFileMetadata(filePath)).revision;
	} catch (error) {
		return isMissing(error) ? "missing" : "unreadable";
	}
}

async function sessionFileMetadata(filePath: string): Promise<NativeSessionFileMetadata> {
	const canonicalFile = canonicalizeSessionFile(filePath);
	const linkStat = await fs.promises.lstat(filePath, { bigint: true });
	const stat = await fs.promises.stat(filePath, { bigint: true });
	const identity = `${canonicalFile}\0${linkStat.isSymbolicLink() ? "symlink" : "file"}\0${stat.dev}:${stat.ino}`;
	return {
		identity,
		revision: `${identity}\0${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
		size: stat.size,
		dev: stat.dev,
		ino: stat.ino,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	};
}

function isRetryableNativeSessionScanError(error: unknown): boolean {
	if (isMissing(error)) return true;
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = (error as { code?: unknown }).code;
	return (
		typeof code === "string" &&
		["EACCES", "EAGAIN", "EBUSY", "EIO", "EMFILE", "ENFILE", "ETIMEDOUT"].includes(code)
	);
}

class AsyncLimiter {
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(private readonly concurrency: number) {}

	async run<T>(operation: () => Promise<T>): Promise<T> {
		if (this.active >= this.concurrency) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
		this.active += 1;
		try {
			return await operation();
		} finally {
			this.active -= 1;
			this.waiting.shift()?.();
		}
	}
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
	);
}

function dedupeDiagnostics(diagnostics: NativeSessionCatalogDiagnostic[]): NativeSessionCatalogDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.source}\0${diagnostic.path ?? ""}\0${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
