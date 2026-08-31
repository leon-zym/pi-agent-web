import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const ARCHIVE_BLOCK_BYTES = 512;
const ARCHIVE_END_BYTES = ARCHIVE_BLOCK_BYTES * 2;
const ARCHIVE_MTIME = 0;
const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;

function comparePaths(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function asBuffer(value, label) {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	if (typeof value === "string") return Buffer.from(value, "utf8");
	throw new Error(`${label} must be a Buffer, Uint8Array, or string`);
}

export function assertSafeArchivePath(value, label = "archive entry") {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) {
		throw new Error(`${label} has an invalid path`);
	}
	if (value.startsWith("/") || value.endsWith("/")) throw new Error(`${label} must be a relative file path`);
	const segments = value.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new Error(`${label} escapes the bundle root: ${value}`);
	}
	return value;
}

function writeString(buffer, offset, byteLength, value, label) {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength > byteLength) throw new Error(`${label} is too long for ustar`);
	bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, byteLength, value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
	const octal = value.toString(8);
	if (octal.length > byteLength - 1) throw new Error(`${label} does not fit in ustar`);
	writeString(buffer, offset, byteLength, `${octal.padStart(byteLength - 1, "0")}\0`, label);
}

function writeChecksum(buffer) {
	buffer.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of buffer) sum += byte;
	const octal = sum.toString(8);
	if (octal.length > 6) throw new Error("ustar checksum does not fit");
	writeString(buffer, 148, 8, `${octal.padStart(6, "0")}\0 `, "ustar checksum");
}

function splitUstarPath(entryPath) {
	const bytes = Buffer.from(entryPath, "utf8");
	if (bytes.byteLength <= 100) return { name: entryPath, prefix: "" };
	for (let index = entryPath.length - 1; index >= 0; index -= 1) {
		if (entryPath[index] !== "/") continue;
		const prefix = entryPath.slice(0, index);
		const name = entryPath.slice(index + 1);
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
	}
	throw new Error(`archive entry path is too long for ustar: ${entryPath}`);
}

function createUstarHeader(entry) {
	const header = Buffer.alloc(ARCHIVE_BLOCK_BYTES);
	const archivePath = entry.type === "directory" ? `${entry.path}/` : entry.path;
	const { name, prefix } = splitUstarPath(archivePath);
	writeString(header, 0, 100, name, "ustar name");
	writeOctal(header, 100, 8, entry.mode, "ustar mode");
	writeOctal(header, 108, 8, 0, "ustar uid");
	writeOctal(header, 116, 8, 0, "ustar gid");
	writeOctal(header, 124, 12, entry.content.byteLength, "ustar size");
	writeOctal(header, 136, 12, ARCHIVE_MTIME, "ustar mtime");
	header[156] = entry.type === "directory" ? "5".charCodeAt(0) : 0;
	writeString(header, 257, 6, "ustar\0", "ustar magic");
	writeString(header, 263, 2, "00", "ustar version");
	writeString(header, 345, 155, prefix, "ustar prefix");
	writeChecksum(header);
	return header;
}

function archivePadding(size) {
	const remainder = size % ARCHIVE_BLOCK_BYTES;
	return remainder === 0 ? 0 : ARCHIVE_BLOCK_BYTES - remainder;
}

function assertNoFileEntryAncestors(entries, label) {
	const files = new Set(entries.filter((entry) => entry.type === "file").map((entry) => entry.path));
	for (const entry of entries) {
		let parent = path.posix.dirname(entry.path);
		while (parent !== ".") {
			if (files.has(parent)) {
				throw new Error(`${label} file entry ${parent} cannot be an ancestor of ${entry.path}`);
			}
			parent = path.posix.dirname(parent);
		}
	}
}

function normaliseArchiveEntries(entries) {
	if (!Array.isArray(entries) || entries.length === 0) throw new Error("archive requires at least one entry");
	const byPath = new Map();
	for (const candidate of entries) {
		if (!candidate || typeof candidate !== "object") throw new Error("archive entry must be an object");
		const entryPath = assertSafeArchivePath(candidate.path);
		if (candidate.type !== "file" && candidate.type !== "directory") {
			throw new Error(`archive entry ${entryPath} has an unsupported type`);
		}
		const mode = candidate.type === "directory" ? DIRECTORY_MODE : FILE_MODE;
		if (candidate.mode !== undefined && candidate.mode !== mode) {
			throw new Error(`archive entry ${entryPath} has a non-canonical mode`);
		}
		if (byPath.has(entryPath)) throw new Error(`archive entry is duplicated: ${entryPath}`);
		byPath.set(entryPath, {
			path: entryPath,
			type: candidate.type,
			mode,
			content:
				candidate.type === "file"
					? asBuffer(candidate.content ?? Buffer.alloc(0), entryPath)
					: Buffer.alloc(0),
		});
	}
	for (const entry of [...byPath.values()]) {
		let parent = path.posix.dirname(entry.path);
		while (parent !== ".") {
			if (!byPath.has(parent)) {
				byPath.set(parent, {
					path: parent,
					type: "directory",
					mode: DIRECTORY_MODE,
					content: Buffer.alloc(0),
				});
			}
			parent = path.posix.dirname(parent);
		}
	}
	const normalised = [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path));
	assertNoFileEntryAncestors(normalised, "archive");
	return normalised;
}

export function createDeterministicTarGz(entries) {
	const normalised = normaliseArchiveEntries(entries);
	const parts = [];
	for (const entry of normalised) {
		parts.push(createUstarHeader(entry));
		if (entry.content.byteLength > 0) parts.push(entry.content);
		const padding = archivePadding(entry.content.byteLength);
		if (padding > 0) parts.push(Buffer.alloc(padding));
	}
	parts.push(Buffer.alloc(ARCHIVE_END_BYTES));
	const compressed = gzipSync(Buffer.concat(parts), { level: 9 });
	compressed.writeUInt32LE(ARCHIVE_MTIME, 4);
	compressed[9] = 255;
	return compressed;
}

function readNullTerminatedString(buffer, offset, byteLength) {
	const raw = buffer.subarray(offset, offset + byteLength);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? raw.byteLength : end).toString("utf8");
}

function readOctal(buffer, offset, byteLength, label) {
	const raw = readNullTerminatedString(buffer, offset, byteLength).trim();
	if (!/^[0-7]+$/.test(raw)) throw new Error(`${label} is not a valid octal value`);
	const value = Number.parseInt(raw, 8);
	if (!Number.isSafeInteger(value)) throw new Error(`${label} is outside the safe integer range`);
	return value;
}

function validateHeaderChecksum(header) {
	const expected = readOctal(header, 148, 8, "ustar checksum");
	const copy = Buffer.from(header);
	copy.fill(0x20, 148, 156);
	let actual = 0;
	for (const byte of copy) actual += byte;
	if (expected !== actual) throw new Error("ustar header checksum is invalid");
}

function isZeroBlock(block) {
	return block.every((byte) => byte === 0);
}

function assertHarmlessGlobalPaxHeader(content) {
	let offset = 0;
	while (offset < content.byteLength) {
		const separator = content.indexOf(0x20, offset);
		if (separator === -1) throw new Error("PAX global header has no record length");
		const lengthText = content.subarray(offset, separator).toString("ascii");
		if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error("PAX global header has an invalid record length");
		const recordLength = Number.parseInt(lengthText, 10);
		const recordEnd = offset + recordLength;
		if (recordEnd > content.byteLength || recordLength <= separator - offset + 1) {
			throw new Error("PAX global header record exceeds its bounds");
		}
		const record = content.subarray(separator + 1, recordEnd).toString("utf8");
		if (!record.endsWith("\n")) throw new Error("PAX global header record has no newline");
		const keyEnd = record.indexOf("=");
		if (keyEnd <= 0 || record.slice(0, keyEnd) !== "comment") {
			throw new Error("archive contains an unsupported PAX global attribute");
		}
		offset = recordEnd;
	}
}

function parseTarEntries(unpacked, { allowHarmlessGlobalPax = false } = {}) {
	const entries = [];
	const seenPaths = new Set();
	let offset = 0;
	let terminated = false;
	while (offset + ARCHIVE_BLOCK_BYTES <= unpacked.byteLength) {
		const header = unpacked.subarray(offset, offset + ARCHIVE_BLOCK_BYTES);
		if (isZeroBlock(header)) {
			if (
				offset + ARCHIVE_END_BYTES > unpacked.byteLength ||
				!isZeroBlock(unpacked.subarray(offset + ARCHIVE_BLOCK_BYTES, offset + ARCHIVE_END_BYTES))
			) {
				throw new Error("archive must end with two zero blocks");
			}
			if (!unpacked.subarray(offset).every((byte) => byte === 0)) {
				throw new Error("archive has data after its terminator");
			}
			terminated = true;
			break;
		}
		validateHeaderChecksum(header);
		if (readNullTerminatedString(header, 257, 6) !== "ustar") throw new Error("archive entry is not ustar");
		const typeFlag = header[156];
		const type =
			typeFlag === 0 || typeFlag === "0".charCodeAt(0)
				? "file"
				: typeFlag === "5".charCodeAt(0)
					? "directory"
					: typeFlag === "g".charCodeAt(0)
						? "pax-global"
						: null;
		if (!type) throw new Error("archive contains an unsupported entry type");
		const name = readNullTerminatedString(header, 0, 100);
		const prefix = readNullTerminatedString(header, 345, 155);
		const archivePath = `${prefix ? `${prefix}/` : ""}${name}`.replace(/\/$/, "");
		assertSafeArchivePath(archivePath);
		const mode = readOctal(header, 100, 8, `archive mode for ${archivePath}`);
		const uid = readOctal(header, 108, 8, `archive uid for ${archivePath}`);
		const gid = readOctal(header, 116, 8, `archive gid for ${archivePath}`);
		const size = readOctal(header, 124, 12, `archive size for ${archivePath}`);
		const mtime = readOctal(header, 136, 12, `archive mtime for ${archivePath}`);
		const contentStart = offset + ARCHIVE_BLOCK_BYTES;
		const contentEnd = contentStart + size;
		if (contentEnd > unpacked.byteLength)
			throw new Error(`archive entry ${archivePath} exceeds archive bounds`);
		if (type === "pax-global") {
			if (!allowHarmlessGlobalPax) throw new Error("archive contains an unsupported entry type");
			assertHarmlessGlobalPaxHeader(unpacked.subarray(contentStart, contentEnd));
			offset = contentEnd + archivePadding(size);
			continue;
		}
		if (seenPaths.has(archivePath)) {
			throw new Error(`archive entry is duplicated: ${archivePath}`);
		}
		seenPaths.add(archivePath);
		entries.push({
			path: archivePath,
			type,
			mode,
			uid,
			gid,
			mtime,
			user: readNullTerminatedString(header, 265, 32),
			group: readNullTerminatedString(header, 297, 32),
			size,
			content: Buffer.from(unpacked.subarray(contentStart, contentEnd)),
		});
		offset = contentEnd + archivePadding(size);
	}
	if (!terminated) throw new Error("archive is missing its terminator");
	assertNoFileEntryAncestors(entries, "archive");
	return entries;
}

export function readTarEntries(archive) {
	return parseTarEntries(asBuffer(archive, "archive"), { allowHarmlessGlobalPax: true });
}

export function readGzipTarEntries(archive) {
	const compressed = asBuffer(archive, "archive");
	if (compressed.byteLength < 10 || compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed[2] !== 8) {
		throw new Error("archive is not a gzip stream");
	}
	let unpacked;
	try {
		unpacked = gunzipSync(compressed);
	} catch (error) {
		throw new Error("archive is not a valid gzip stream", { cause: error });
	}
	return parseTarEntries(unpacked);
}

function assertDeterministicGzipHeader(compressed) {
	if (
		compressed.byteLength < 10 ||
		compressed[0] !== 0x1f ||
		compressed[1] !== 0x8b ||
		compressed[2] !== 8 ||
		compressed[3] !== 0 ||
		compressed.readUInt32LE(4) !== ARCHIVE_MTIME ||
		compressed[8] !== 2 ||
		compressed[9] !== 255
	) {
		throw new Error("archive gzip header is not deterministic");
	}
}

export function inspectDeterministicTarGz(archive, options = {}) {
	const compressed = asBuffer(archive, "archive");
	assertDeterministicGzipHeader(compressed);
	const entries = readGzipTarEntries(compressed);
	for (const entry of entries) {
		if (entry.uid !== 0 || entry.gid !== 0) {
			throw new Error(`archive entry ${entry.path} has non-root numeric ownership`);
		}
		if (entry.user || entry.group) throw new Error(`archive entry ${entry.path} has named ownership`);
		if (entry.mode !== (entry.type === "directory" ? DIRECTORY_MODE : FILE_MODE)) {
			throw new Error(`archive entry ${entry.path} has a non-canonical mode`);
		}
		if (entry.mtime !== ARCHIVE_MTIME) {
			throw new Error(`archive entry ${entry.path} has a non-deterministic mtime`);
		}
		if (entry.type === "directory" && entry.size !== 0) {
			throw new Error(`archive directory ${entry.path} must be empty`);
		}
	}
	assertNoFileEntryAncestors(entries, "archive");
	let previousPath;
	for (const entry of entries) {
		if (previousPath !== undefined && comparePaths(previousPath, entry.path) >= 0) {
			throw new Error("archive entries are not in deterministic path order");
		}
		previousPath = entry.path;
	}
	if (options.rootName) {
		const rootName = assertSafeArchivePath(options.rootName, "bundle root");
		if (entries[0]?.path !== rootName || entries[0]?.type !== "directory") {
			throw new Error("archive is missing its canonical bundle root");
		}
		if (entries.some((entry) => entry.path !== rootName && !entry.path.startsWith(`${rootName}/`))) {
			throw new Error("archive has entries outside its bundle root");
		}
	}
	return entries;
}

function isWithin(candidate, parent) {
	return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function lstatOrNull(filePath, operations = fs) {
	try {
		return operations.lstatSync(filePath);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function assertRealDirectory(directory, root, operations = fs) {
	const stat = operations.lstatSync(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new Error(`archive extraction path is not a real directory: ${directory}`);
	const realDirectory = operations.realpathSync(directory);
	if (!isWithin(realDirectory, root)) throw new Error("archive extraction path escapes its root");
	return realDirectory;
}

function assertNoSymlinkAncestors(directory, operations) {
	const immediateParent = path.resolve(directory);
	for (let candidate = immediateParent; ; candidate = path.dirname(candidate)) {
		const stat = lstatOrNull(candidate, operations);
		if (stat) {
			if (stat.isSymbolicLink() && candidate === immediateParent) {
				throw new Error(`archive extraction ancestor must not be a symlink: ${candidate}`);
			}
			if (!stat.isDirectory() && !stat.isSymbolicLink()) {
				throw new Error(`archive extraction ancestor is not a directory: ${candidate}`);
			}
		}
		if (path.dirname(candidate) === candidate) return;
	}
}

function createOwnedExtractionRoot(destinationRoot, operations = fs) {
	const resolvedRoot = path.resolve(destinationRoot);
	if (lstatOrNull(resolvedRoot, operations)) {
		throw new Error(`archive extraction root must be newly created: ${resolvedRoot}`);
	}
	const parent = path.dirname(resolvedRoot);
	assertNoSymlinkAncestors(parent, operations);
	const parentStat = operations.lstatSync(parent);
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
		throw new Error(`archive extraction parent must be a real directory: ${parent}`);
	}
	const realParent = operations.realpathSync(parent);
	const canonicalRoot = path.join(realParent, path.basename(resolvedRoot));
	if (lstatOrNull(canonicalRoot, operations)) {
		throw new Error(`archive extraction root must be newly created: ${resolvedRoot}`);
	}
	try {
		operations.mkdirSync(canonicalRoot, { mode: DIRECTORY_MODE });
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new Error(`archive extraction root must be newly created: ${resolvedRoot}`);
		}
		throw error;
	}
	const rootStat = operations.lstatSync(canonicalRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error(`archive extraction root is not a real directory: ${canonicalRoot}`);
	}
	const realRoot = operations.realpathSync(canonicalRoot);
	if (path.dirname(realRoot) !== realParent || operations.readdirSync(realRoot).length !== 0) {
		throw new Error("archive extraction root changed while it was being created");
	}
	return realRoot;
}

function createOwnedDirectory(root, segments, mode, operations) {
	let current = root;
	for (const segment of segments) {
		const candidate = path.join(current, segment);
		const existing = lstatOrNull(candidate, operations);
		if (!existing) {
			try {
				operations.mkdirSync(candidate, { mode });
			} catch (error) {
				if (error?.code === "EEXIST") {
					throw new Error(`archive extraction directory was concurrently created: ${candidate}`);
				}
				throw error;
			}
		}
		current = assertRealDirectory(candidate, root, operations);
	}
	return current;
}

/** Extracts only parsed regular files/directories into a caller-owned empty tree. */
export function extractTarEntries(entries, destinationRoot, { operations = fs } = {}) {
	if (!Array.isArray(entries)) throw new Error("archive extraction requires parsed entries");
	const realRoot = createOwnedExtractionRoot(destinationRoot, operations);
	for (const entry of entries) {
		const segments = assertSafeArchivePath(entry.path).split("/");
		const parent = createOwnedDirectory(realRoot, segments.slice(0, -1), DIRECTORY_MODE, operations);
		const destination = path.join(parent, segments.at(-1));
		if (entry.type === "directory") {
			const existing = lstatOrNull(destination, operations);
			if (existing) {
				assertRealDirectory(destination, realRoot, operations);
				continue;
			}
			try {
				operations.mkdirSync(destination, { mode: entry.mode });
			} catch (error) {
				if (error?.code === "EEXIST") {
					throw new Error(`archive extraction directory was concurrently created: ${destination}`);
				}
				throw error;
			}
			assertRealDirectory(destination, realRoot, operations);
			operations.chmodSync(destination, entry.mode);
			continue;
		}
		if (entry.type !== "file") throw new Error(`archive entry ${entry.path} has an unsupported type`);
		try {
			operations.writeFileSync(destination, entry.content, { flag: "wx", mode: entry.mode });
		} catch (error) {
			if (error?.code === "EEXIST") {
				throw new Error(`archive extraction file was concurrently created: ${destination}`);
			}
			throw error;
		}
		operations.chmodSync(destination, entry.mode);
	}
	return realRoot;
}
