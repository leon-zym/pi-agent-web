import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	WORKSPACE_FILE_BINARY_MAX_BYTES,
	WORKSPACE_FILE_IMAGE_MAX_BYTES,
	WORKSPACE_FILE_LARGE_THRESHOLD_BYTES,
	WORKSPACE_FILE_METADATA_READ_MAX_BYTES,
	WORKSPACE_FILE_PREVIEW_MAX_BYTES,
	WORKSPACE_FILE_SEARCH_MAX_DIRECTORIES,
	WORKSPACE_FILE_SEARCH_MAX_RESULTS,
	WORKSPACE_FILE_SEARCH_QUERY_MAX_CHARS,
	WORKSPACE_FILE_TEXT_MAX_BYTES,
	type WorkspaceFileCaptureRequestDto,
	type WorkspaceFileKindDto,
	type WorkspaceFileMetadataDto,
	type WorkspaceFileReferenceDto,
	type WorkspaceFileRiskDto,
	type WorkspaceFileSearchDto,
} from "@pi-agent-web/protocol";

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".pi"]);
const GENERATED_DIRECTORIES = new Set([
	"dist",
	"build",
	"coverage",
	"out",
	"target",
	"vendor",
	".next",
	".nuxt",
	".turbo",
]);
const CREDENTIAL_FILE_PATTERN =
	/^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json|.*\.(?:pem|key|p12|pfx))$/i;
const CREDENTIAL_CONTENT_PATTERN =
	/(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{8,})/i;
const GENERATED_FILE_PATTERN = /(?:\.min\.(?:js|css)|\.map|(?:^|\.)generated\.[^.]+)$/i;
const GIT_POLICY_TIMEOUT_MS = 500;
const GIT_POLICY_OUTPUT_MAX_BYTES = 64 * 1024;

type ImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export class WorkspaceFileReferenceError extends Error {
	constructor(
		readonly status: 409 | 422 | 429,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "WorkspaceFileReferenceError";
	}
}

interface VerifiedFile {
	relativePath: string;
	resolvedPath: string;
	identity: string;
	stat: fs.BigIntStats;
	prefix: Buffer;
}

interface CandidateResult {
	metadata: WorkspaceFileMetadataDto;
	verified?: VerifiedFile;
}

interface GitIgnoreResult {
	ignored: Set<string>;
	policy: WorkspaceFileSearchDto["policy"];
}

class OperationGovernor {
	private active = 0;

	constructor(private readonly limit: number) {}

	acquire(): () => void {
		if (this.active >= this.limit) {
			throw new WorkspaceFileReferenceError(
				429,
				"workspace_file_operations_busy",
				"too many Workspace file operations are active",
			);
		}
		this.active += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active -= 1;
		};
	}
}

/**
 * Host-owned file expansion. Search returns bounded metadata; capture reopens
 * and revalidates the exact file identity before any bytes can enter a prompt.
 */
export class WorkspaceFileReferenceService {
	private readonly operations = new OperationGovernor(4);

	async search(rootPath: string, rawQuery: string, signal?: AbortSignal): Promise<WorkspaceFileSearchDto> {
		const release = this.operations.acquire();
		try {
			const root = await canonicalWorkspaceRoot(rootPath);
			const query = rawQuery.slice(0, WORKSPACE_FILE_SEARCH_QUERY_MAX_CHARS).trim();
			const lowerQuery = query.toLowerCase();
			const queue: string[] = [""];
			const candidates: string[] = [];
			let scannedDirectories = 0;
			let skippedEntries = 0;
			let truncated = false;

			while (queue.length > 0 && candidates.length < WORKSPACE_FILE_SEARCH_MAX_RESULTS) {
				throwIfAborted(signal);
				if (scannedDirectories >= WORKSPACE_FILE_SEARCH_MAX_DIRECTORIES) {
					truncated = true;
					break;
				}
				const relativeDirectory = queue.shift() ?? "";
				scannedDirectories += 1;
				const directory = relativeDirectory ? path.join(root, relativeDirectory) : root;
				let entries: fs.Dirent[];
				try {
					entries = await fs.promises.readdir(directory, { withFileTypes: true });
				} catch {
					skippedEntries += 1;
					continue;
				}
				entries.sort((left, right) => left.name.localeCompare(right.name));

				for (const entry of entries) {
					throwIfAborted(signal);
					if (candidates.length >= WORKSPACE_FILE_SEARCH_MAX_RESULTS) {
						truncated = true;
						break;
					}
					if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
						skippedEntries += 1;
						continue;
					}
					const relativePath = relativeDirectory
						? `${relativeDirectory.split(path.sep).join("/")}/${entry.name}`
						: entry.name;
					if (entry.isDirectory()) {
						queue.push(relativePath.split("/").join(path.sep));
						continue;
					}
					if (!entry.isFile() && !entry.isSymbolicLink()) {
						skippedEntries += 1;
						continue;
					}
					if (!lowerQuery || relativePath.toLowerCase().includes(lowerQuery)) {
						candidates.push(relativePath);
					}
				}
			}
			if (queue.length > 0) truncated = true;

			const inspected: CandidateResult[] = [];
			for (const relativePath of candidates) {
				throwIfAborted(signal);
				inspected.push(await inspectCandidate(root, relativePath));
			}
			const gitIgnore = await ignoredPaths(root, candidates, signal);
			throwIfAborted(signal);
			const files = inspected.map(({ metadata }) => {
				const risks = [...metadata.risks];
				if (gitIgnore.ignored.has(metadata.path)) risks.push("ignored");
				else if (gitIgnore.policy === "unknown") risks.push("policy_unknown");
				return finalizeMetadata({ ...metadata, risks: uniqueRisks(risks) });
			});

			return {
				query,
				files,
				scannedDirectories,
				truncated,
				skippedEntries,
				policy: gitIgnore.policy,
			};
		} finally {
			release();
		}
	}

	async capture(
		rootPath: string,
		request: WorkspaceFileCaptureRequestDto,
		signal?: AbortSignal,
	): Promise<WorkspaceFileReferenceDto> {
		const release = this.operations.acquire();
		try {
			const root = await canonicalWorkspaceRoot(rootPath);
			if (!request.canonicalIdentity || request.canonicalIdentity.length > 256) {
				throw new WorkspaceFileReferenceError(
					422,
					"workspace_file_identity_invalid",
					"Workspace file identity is invalid",
				);
			}
			const candidate = await inspectCandidate(root, request.path);
			if (!candidate.verified || candidate.metadata.availability === "unavailable") {
				throw new WorkspaceFileReferenceError(
					409,
					"workspace_file_unavailable",
					"Workspace file is unavailable",
				);
			}
			if (candidate.verified.identity !== request.canonicalIdentity) {
				throw new WorkspaceFileReferenceError(
					409,
					"workspace_file_identity_changed",
					"Workspace file changed after preview",
				);
			}
			const policy = await ignoredPaths(root, [candidate.metadata.path], signal);
			throwIfAborted(signal);
			const risks = [...candidate.metadata.risks];
			if (policy.ignored.has(candidate.metadata.path)) risks.push("ignored");
			else if (policy.policy === "unknown") risks.push("policy_unknown");
			const metadata = finalizeMetadata({ ...candidate.metadata, risks: uniqueRisks(risks) });
			if (metadata.availability === "blocked") {
				throw new WorkspaceFileReferenceError(
					422,
					"workspace_file_policy_blocked",
					metadata.reason ?? "Workspace file is blocked by content policy",
				);
			}
			if (metadata.availability === "confirmation_required" && request.confirmed !== true) {
				throw new WorkspaceFileReferenceError(
					409,
					"workspace_file_confirmation_required",
					"Workspace file requires explicit confirmation",
				);
			}

			const byteLimit = captureLimit(metadata.kind);
			const bytes = await readVerifiedBytes(root, candidate.verified, byteLimit, signal);
			if (metadata.kind === "image" && metadata.mimeType) {
				return {
					metadata: { ...metadata, preview: undefined },
					content: { type: "image", mimeType: metadata.mimeType, data: bytes.toString("base64") },
				};
			}
			if (metadata.kind === "binary") {
				return {
					metadata: { ...metadata, preview: undefined },
					content: { type: "binary_base64", data: bytes.toString("base64") },
				};
			}
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				throw new WorkspaceFileReferenceError(
					409,
					"workspace_file_classification_changed",
					"Workspace file is no longer valid UTF-8 text",
				);
			}
			return {
				metadata: { ...metadata, preview: undefined },
				content: { type: "text", text },
			};
		} finally {
			release();
		}
	}
}

async function inspectCandidate(root: string, rawRelativePath: string): Promise<CandidateResult> {
	let relativePath: string;
	try {
		relativePath = normalizeRelativePath(rawRelativePath);
	} catch {
		return unavailableMetadata(rawRelativePath, "invalid_path");
	}
	try {
		const verified = await openVerifiedPrefix(root, relativePath);
		return { metadata: metadataForVerified(verified), verified };
	} catch (error) {
		return unavailableMetadata(relativePath, filesystemReason(error));
	}
}

async function openVerifiedPrefix(root: string, relativePath: string): Promise<VerifiedFile> {
	const selectedPath = path.join(root, ...relativePath.split("/"));
	const resolvedPath = await fs.promises.realpath(selectedPath);
	assertInsideWorkspace(root, resolvedPath);
	const handle = await fs.promises.open(resolvedPath, fs.constants.O_RDONLY | noFollowFlag());
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) throw new Error("not_file");
		const prefixLength = Number(
			before.size < BigInt(WORKSPACE_FILE_METADATA_READ_MAX_BYTES)
				? before.size
				: BigInt(WORKSPACE_FILE_METADATA_READ_MAX_BYTES),
		);
		const prefix = Buffer.alloc(prefixLength);
		if (prefixLength > 0) await handle.read(prefix, 0, prefixLength, 0);
		const after = await handle.stat({ bigint: true });
		if (identityForStat(before) !== identityForStat(after)) throw new Error("identity_changed");
		await assertSelectedPathStillResolves(root, selectedPath, resolvedPath, after);
		return { relativePath, resolvedPath, identity: identityForStat(after), stat: after, prefix };
	} finally {
		await handle.close();
	}
}

async function readVerifiedBytes(
	root: string,
	verified: VerifiedFile,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Buffer> {
	throwIfAborted(signal);
	if (verified.stat.size > BigInt(maxBytes)) {
		throw new WorkspaceFileReferenceError(
			422,
			"workspace_file_too_large",
			"Workspace file exceeds its capture byte budget",
		);
	}
	const selectedPath = path.join(root, ...verified.relativePath.split("/"));
	const resolvedPath = await fs.promises.realpath(selectedPath);
	if (resolvedPath !== verified.resolvedPath) throw new Error("identity_changed");
	const handle = await fs.promises.open(resolvedPath, fs.constants.O_RDONLY | noFollowFlag());
	try {
		const before = await handle.stat({ bigint: true });
		if (identityForStat(before) !== verified.identity) throw new Error("identity_changed");
		const bytes = Buffer.alloc(Number(before.size));
		let offset = 0;
		while (offset < bytes.length) {
			throwIfAborted(signal);
			const chunk = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
			if (chunk.bytesRead === 0) throw new Error("short_read");
			offset += chunk.bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (identityForStat(after) !== verified.identity) throw new Error("identity_changed");
		await assertSelectedPathStillResolves(root, selectedPath, resolvedPath, after);
		return bytes;
	} catch (error) {
		if (error instanceof WorkspaceFileReferenceError) throw error;
		throw new WorkspaceFileReferenceError(
			409,
			"workspace_file_identity_changed",
			"Workspace file changed while it was being captured",
		);
	} finally {
		await handle.close();
	}
}

function metadataForVerified(file: VerifiedFile): WorkspaceFileMetadataDto {
	const byteSize = safeStatSize(file.stat.size);
	const mimeType = detectImageMimeType(file.prefix);
	let kind: WorkspaceFileKindDto = "text";
	if (mimeType) kind = "image";
	else if (!isUtf8Text(file.prefix)) kind = "binary";

	const risks: WorkspaceFileRiskDto[] = [];
	const segments = file.relativePath.split("/");
	if (segments.some((segment) => segment.startsWith(".") && segment !== ".")) risks.push("hidden");
	if (
		segments.some((segment) => GENERATED_DIRECTORIES.has(segment)) ||
		GENERATED_FILE_PATTERN.test(segments.at(-1) ?? "")
	) {
		risks.push("generated");
	}
	if (byteSize > WORKSPACE_FILE_LARGE_THRESHOLD_BYTES) risks.push("large");
	if (kind === "image") risks.push("image");
	if (kind === "binary") risks.push("binary");
	const fileName = segments.at(-1) ?? "";
	const credential =
		CREDENTIAL_FILE_PATTERN.test(fileName) ||
		(kind === "text" && CREDENTIAL_CONTENT_PATTERN.test(file.prefix.toString("utf8")));
	if (credential) risks.push("credential");

	const maxBytes = captureLimit(kind);
	const blocked = byteSize > maxBytes;
	const preview = kind === "text" && !credential ? previewText(file.prefix) : undefined;
	return finalizeMetadata({
		path: file.relativePath,
		canonicalIdentity: file.identity,
		byteSize,
		kind,
		...(mimeType ? { mimeType } : {}),
		estimatedTokens:
			kind === "image" ? null : Math.ceil(kind === "binary" ? (byteSize * 4) / 3 : byteSize / 4),
		risks: uniqueRisks(risks),
		availability: blocked ? "blocked" : risks.length > 0 ? "confirmation_required" : "ready",
		...(blocked ? { reason: `file exceeds the ${String(maxBytes)} byte ${kind} capture limit` } : {}),
		...(preview === undefined ? {} : { preview }),
		previewTruncated: kind === "text" && byteSize > WORKSPACE_FILE_PREVIEW_MAX_BYTES,
	});
}

function finalizeMetadata(metadata: WorkspaceFileMetadataDto): WorkspaceFileMetadataDto {
	if (metadata.availability === "unavailable" || metadata.canonicalIdentity === null) return metadata;
	const suppressPreview = metadata.risks.some(
		(risk) => risk === "credential" || risk === "ignored" || risk === "policy_unknown",
	);
	const safeMetadata = suppressPreview ? { ...metadata, preview: undefined } : metadata;
	const maxBytes = captureLimit(metadata.kind);
	if (metadata.byteSize !== null && metadata.byteSize > maxBytes) {
		return {
			...safeMetadata,
			availability: "blocked",
			reason: `file exceeds the ${String(maxBytes)} byte ${metadata.kind} capture limit`,
		};
	}
	return {
		...safeMetadata,
		availability: metadata.risks.length > 0 ? "confirmation_required" : "ready",
	};
}

function unavailableMetadata(pathValue: string, reason: string): CandidateResult {
	return {
		metadata: {
			path: pathValue,
			canonicalIdentity: null,
			byteSize: null,
			kind: "unknown",
			estimatedTokens: null,
			risks: [],
			availability: "unavailable",
			reason,
			previewTruncated: false,
		},
	};
}

async function canonicalWorkspaceRoot(rootPath: string): Promise<string> {
	try {
		const root = await fs.promises.realpath(rootPath);
		const stat = await fs.promises.stat(root);
		if (!stat.isDirectory()) throw new Error("invalid root");
		return root;
	} catch {
		throw new WorkspaceFileReferenceError(
			409,
			"workspace_file_root_unavailable",
			"Workspace root is unavailable",
		);
	}
}

function normalizeRelativePath(rawPath: string): string {
	if (!rawPath || rawPath.length > 8_192 || rawPath.includes("\0") || path.isAbsolute(rawPath)) {
		throw new WorkspaceFileReferenceError(
			422,
			"workspace_file_path_invalid",
			"Workspace file path is invalid",
		);
	}
	const segments = rawPath.split("/");
	if (
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				segment.includes("\\") ||
				hasUnsafePathCharacters(segment) ||
				EXCLUDED_DIRECTORIES.has(segment),
		)
	) {
		throw new WorkspaceFileReferenceError(
			422,
			"workspace_file_path_invalid",
			"Workspace file path is invalid",
		);
	}
	return segments.join("/");
}

function hasUnsafePathCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x061c ||
			code === 0x200e ||
			code === 0x200f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			return true;
		}
	}
	return false;
}

function assertInsideWorkspace(root: string, target: string): void {
	const relative = path.relative(root, target);
	if (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	) {
		return;
	}
	throw new WorkspaceFileReferenceError(
		422,
		"workspace_file_outside_workspace",
		"Workspace file resolves outside the canonical Workspace",
	);
}

async function assertSelectedPathStillResolves(
	root: string,
	selectedPath: string,
	resolvedPath: string,
	openedStat: fs.BigIntStats,
): Promise<void> {
	const currentResolved = await fs.promises.realpath(selectedPath);
	assertInsideWorkspace(root, currentResolved);
	if (currentResolved !== resolvedPath) throw new Error("identity_changed");
	const currentStat = await fs.promises.stat(currentResolved, { bigint: true });
	if (identityForStat(currentStat) !== identityForStat(openedStat)) throw new Error("identity_changed");
}

function identityForStat(stat: fs.BigIntStats): string {
	return `${String(stat.dev)}:${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeNs)}`;
}

function noFollowFlag(): number {
	return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function detectImageMimeType(bytes: Buffer): ImageMimeType | undefined {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	const six = bytes.subarray(0, 6).toString("ascii");
	if (six === "GIF87a" || six === "GIF89a") return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return undefined;
}

function isUtf8Text(bytes: Buffer): boolean {
	if (bytes.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

function previewText(bytes: Buffer): string {
	const bounded = bytes.subarray(0, WORKSPACE_FILE_PREVIEW_MAX_BYTES);
	return new TextDecoder("utf-8").decode(bounded);
}

function captureLimit(kind: WorkspaceFileKindDto): number {
	if (kind === "image") return WORKSPACE_FILE_IMAGE_MAX_BYTES;
	if (kind === "binary") return WORKSPACE_FILE_BINARY_MAX_BYTES;
	if (kind === "text") return WORKSPACE_FILE_TEXT_MAX_BYTES;
	return 0;
}

function uniqueRisks(risks: WorkspaceFileRiskDto[]): WorkspaceFileRiskDto[] {
	return [...new Set(risks)];
}

function safeStatSize(size: bigint): number {
	return size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(size);
}

function filesystemReason(error: unknown): string {
	const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	if (code === "ENOENT" || code === "ENOTDIR") return "not_found";
	if (code === "EACCES" || code === "EPERM") return "unreadable";
	return "identity_unavailable";
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("Workspace file operation cancelled");
}

async function ignoredPaths(root: string, paths: string[], signal?: AbortSignal): Promise<GitIgnoreResult> {
	if (paths.length === 0) return { ignored: new Set(), policy: "none" };
	const hasRepository = await fs.promises
		.stat(path.join(root, ".git"))
		.then(() => true)
		.catch(() => false);
	const hasRootIgnore = await fs.promises
		.stat(path.join(root, ".gitignore"))
		.then(() => true)
		.catch(() => false);
	if (!hasRepository && !hasRootIgnore) return { ignored: new Set(), policy: "none" };
	const timeout = AbortSignal.timeout(GIT_POLICY_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	return await new Promise((resolve) => {
		const child = spawn("git", ["-C", root, "check-ignore", "--no-index", "-z", "--stdin"], {
			cwd: root,
			stdio: ["pipe", "pipe", "ignore"],
			signal: combined,
		});
		let settled = false;
		let output = Buffer.alloc(0);
		const finish = (result: GitIgnoreResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			if (output.length + chunk.length > GIT_POLICY_OUTPUT_MAX_BYTES) {
				child.kill("SIGTERM");
				finish({ ignored: new Set(), policy: "unknown" });
				return;
			}
			output = Buffer.concat([output, chunk]);
		});
		child.on("error", () => finish({ ignored: new Set(), policy: "unknown" }));
		child.on("close", (code) => {
			if (settled) return;
			if (code !== 0 && code !== 1) {
				finish({ ignored: new Set(), policy: "unknown" });
				return;
			}
			const ignored = new Set(
				output
					.toString("utf8")
					.split("\0")
					.filter(Boolean)
					.map((value) => value.split(path.sep).join("/")),
			);
			finish({ ignored, policy: ignored.size > 0 ? "gitignore" : "none" });
		});
		child.stdin.end(`${paths.join("\0")}\0`);
	});
}
