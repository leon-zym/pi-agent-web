import { createHash } from "node:crypto";
import fs from "node:fs";
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

/** The sidebar preview is deliberately independent of the size of the first user message. */
export const NATIVE_SESSION_FIRST_MESSAGE_MAX_CHARS = 160;
/** A single catalog instance never parses more than this many session files at once. */
export const NATIVE_SESSION_FILE_SCAN_CONCURRENCY = 8;

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
}

export interface NativeSessionCatalogSnapshot {
	generation: number;
	generatedAt: number;
	sessions: NativeSessionRecord[];
	workspaces: NativeWorkspaceRecord[];
	diagnostics: NativeSessionCatalogDiagnostic[];
	scannedSources: SessionDiscoverySource[];
}

export interface NativeSessionCatalogOptions {
	layoutResolver: SessionLayoutResolver;
	preferences?: WorkspacePreferenceHints;
	knownWorkspacePaths?: Iterable<string> | (() => Iterable<string>);
	cacheTtlMs?: number;
	now?: () => number;
}

export interface WorkspacePreferenceHints {
	pathHints(): string[];
	getLoadError?(): Error | null;
}

interface CachedDirectorySummary {
	revision: string;
	sessions: NativeSessionSummary[];
	files: Map<string, CachedSessionFileSummary>;
}

interface CachedSessionFileSummary {
	revision: string;
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
	private snapshot: NativeSessionCatalogSnapshot | undefined;
	private refreshPromise: Promise<NativeSessionCatalogSnapshot> | undefined;
	private forcedRefreshPromise: Promise<NativeSessionCatalogSnapshot> | undefined;
	private forcedRefreshRequested = 0;
	private forcedRefreshCompleted = 0;
	private generation = 0;
	private readonly directoryCache = new Map<string, CachedDirectorySummary>();
	private readonly directoryScanLimiter = new AsyncLimiter(DIRECTORY_SUMMARY_CONCURRENCY);
	private readonly sessionFileScanLimiter = new AsyncLimiter(NATIVE_SESSION_FILE_SCAN_CONCURRENCY);
	private readonly directoryScans = new Map<string, Promise<NativeSessionSummary[]>>();

	constructor(options: NativeSessionCatalogOptions) {
		this.layoutResolver = options.layoutResolver;
		this.preferences = options.preferences;
		this.knownWorkspacePaths = options.knownWorkspacePaths;
		this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 1_000);
		this.now = options.now ?? Date.now;
	}

	getSnapshot(): NativeSessionCatalogSnapshot | undefined {
		return this.snapshot;
	}

	refresh(options: { force?: boolean } = {}): Promise<NativeSessionCatalogSnapshot> {
		const now = this.now();
		if (!options.force && this.snapshot && now - this.snapshot.generatedAt < this.cacheTtlMs) {
			return Promise.resolve(this.snapshot);
		}
		if (options.force) {
			this.forcedRefreshRequested += 1;
			if (!this.forcedRefreshPromise) {
				const draining = this.drainForcedRefreshes();
				const forced = draining.finally(() => {
					if (this.forcedRefreshPromise === forced) this.forcedRefreshPromise = undefined;
				});
				this.forcedRefreshPromise = forced;
			}
			return this.forcedRefreshPromise;
		}
		if (this.forcedRefreshPromise) return this.forcedRefreshPromise;
		return this.refreshPromise ?? this.startRefresh();
	}

	private startRefresh(): Promise<NativeSessionCatalogSnapshot> {
		const refresh = this.discover()
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

	private async drainForcedRefreshes(): Promise<NativeSessionCatalogSnapshot> {
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
				latest = await this.startRefresh();
				this.forcedRefreshCompleted = coveredRequest;
			} catch (error) {
				if (this.forcedRefreshRequested > coveredRequest) continue;
				throw error;
			}
			if (this.forcedRefreshCompleted >= this.forcedRefreshRequested) return latest;
		}
	}

	private async discover(): Promise<NativeSessionCatalogSnapshot> {
		const diagnostics: NativeSessionCatalogDiagnostic[] = [];
		const knownWorkspaces = new Set(this.readKnownWorkspacePaths(diagnostics));
		const infoByFile = new Map<string, NativeSessionSummary>();
		const scannedSourceKeys = new Set<string>();
		const scannedSources: SessionDiscoverySource[] = [];
		const currentDirectoryCacheKeys = new Set<string>();

		for (;;) {
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
				async (source) => {
					try {
						return await this.scanSource(source, currentDirectoryCacheKeys);
					} catch (error) {
						diagnostics.push({
							source: "filesystem",
							message: error instanceof Error ? error.message : String(error),
							path: source.path,
						});
						return [];
					}
				},
			);
			scannedSources.push(...pendingSources);

			let discoveredWorkspace = false;
			for (const info of batches.flat()) {
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

			// All new source paths have been scanned and no new Header.cwd can reveal
			// an additional project sessionDir.
			if (!discoveredWorkspace) {
				const followUpPlan = this.layoutResolver.discoveryPlan(knownWorkspaces);
				if (followUpPlan.sources.every((source) => scannedSourceKeys.has(sourceKey(source)))) break;
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
	): Promise<NativeSessionSummary[]> {
		if (source.mode === "direct") {
			return this.scanDirectDirectory(source.path, currentDirectoryCacheKeys);
		}

		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(source.path, { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}
		const directories = entries
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => path.join(source.path, entry.name));
		const sessions = await Promise.all(
			directories.map((directory) => this.scanDirectDirectory(directory, currentDirectoryCacheKeys)),
		);
		return sessions.flat();
	}

	private scanDirectDirectory(
		directory: string,
		currentDirectoryCacheKeys: Set<string>,
	): Promise<NativeSessionSummary[]> {
		const cacheKey = canonicalizePathAllowMissing(directory);
		currentDirectoryCacheKeys.add(cacheKey);
		const activeScan = this.directoryScans.get(cacheKey);
		if (activeScan) return activeScan;

		const scan = this.directoryScanLimiter
			.run(async () => {
				const beforeRevision = await directoryRevision(directory);
				const cached = this.directoryCache.get(cacheKey);
				if (cached?.revision === beforeRevision) return cached.sessions;

				const scanned = await this.scanSessionDirectory(directory, cached?.files);
				const afterRevision = await directoryRevision(directory);
				if (beforeRevision === afterRevision) {
					this.directoryCache.set(cacheKey, {
						revision: afterRevision,
						sessions: scanned.sessions,
						files: scanned.files,
					});
				}
				return scanned.sessions;
			})
			.finally(() => {
				if (this.directoryScans.get(cacheKey) === scan) this.directoryScans.delete(cacheKey);
			});
		this.directoryScans.set(cacheKey, scan);
		return scan;
	}

	private async scanSessionDirectory(
		directory: string,
		cachedFiles?: ReadonlyMap<string, CachedSessionFileSummary>,
	): Promise<{ sessions: NativeSessionSummary[]; files: Map<string, CachedSessionFileSummary> }> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) return { sessions: [], files: new Map() };
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
			async ([canonicalFile, file]) => {
				const revision = await sessionFileRevision(file);
				const cached = cachedFiles?.get(canonicalFile);
				if (cached?.revision === revision) return [canonicalFile, cached] as const;
				const summary = await this.sessionFileScanLimiter.run(() => scanNativeSessionFile(file));
				return [
					canonicalFile,
					{ revision, summary: summary ? { ...summary, path: canonicalFile } : null },
				] as const;
			},
		);
		const fileCache = new Map(scannedFiles);
		return {
			sessions: scannedFiles
				.map(([, cached]) => cached.summary)
				.filter((summary): summary is NativeSessionSummary => summary !== null),
			files: fileCache,
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

async function scanNativeSessionFile(filePath: string): Promise<NativeSessionSummary | null> {
	try {
		const stat = await fs.promises.stat(filePath);
		if (!stat.isFile() || stat.size === 0) return null;

		const state: NativeSessionScanState = { lineNumber: 0, messageCount: 0 };
		const decoder = new StringDecoder("utf8");
		let buffered = "";
		const stream = fs.createReadStream(filePath, {
			highWaterMark: SESSION_SCAN_HIGH_WATER_MARK_BYTES,
		});

		for await (const chunk of stream) {
			buffered += decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
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

		buffered += decoder.end();
		if (buffered.length > 0) {
			if (Buffer.byteLength(buffered) > SESSION_SCAN_MAX_LINE_BYTES) {
				throw new Error(`Session JSONL line exceeds ${String(SESSION_SCAN_MAX_LINE_BYTES)} bytes`);
			}
			parseNativeSessionLine(state, buffered);
		}

		const header = state.header;
		if (!header) return null;
		const headerTime = parseDateMillis(header.timestamp);
		const createdTime = headerTime ?? safeStatCreatedTime(stat);
		const modifiedTime =
			state.lastActivityTime !== undefined && state.lastActivityTime > 0
				? state.lastActivityTime
				: (headerTime ?? stat.mtimeMs);

		return {
			path: filePath,
			id: header.id,
			cwd: header.cwd,
			name: state.name,
			parentSessionPath: header.parentSessionPath,
			created: new Date(createdTime),
			modified: new Date(modifiedTime),
			messageCount: state.messageCount,
			firstMessage: state.firstMessage ?? "",
		};
	} catch {
		// Native history discovery is best-effort. One changing, corrupt, or
		// unreadable JSONL file must not hide healthy sessions beside it.
		return null;
	}
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

function safeStatCreatedTime(stat: fs.Stats): number {
	return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
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

async function directoryRevision(directory: string): Promise<string> {
	let entries: string[];
	try {
		entries = (await fs.promises.readdir(directory)).filter((entry) => entry.endsWith(".jsonl")).sort();
	} catch (error) {
		if (isMissing(error)) return "missing";
		throw error;
	}
	const revisions = await mapWithConcurrency(
		entries,
		DIRECTORY_REVISION_CONCURRENCY,
		async (entry): Promise<string> => {
			return `${entry}\0${await sessionFileRevision(path.join(directory, entry))}`;
		},
	);
	return createHash("sha256").update(revisions.join("\n")).digest("base64url");
}

async function sessionFileRevision(filePath: string): Promise<string> {
	try {
		const stat = await fs.promises.stat(filePath, { bigint: true });
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
	} catch (error) {
		return isMissing(error) ? "missing" : "unreadable";
	}
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
