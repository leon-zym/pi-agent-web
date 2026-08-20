import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionHandleForFile } from "../src/native-session-catalog.js";
import {
	RecoverableSessionTrash,
	type RecoverableSessionTrashMetadata,
} from "../src/recoverable-session-trash.js";
import { workspaceHandleForPath } from "../src/session-layout-resolver.js";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-trash-"));
	temporaryRoots.push(root);
	return root;
}

function writeSession(root: string, name = "session.jsonl", nativeSessionId = "native"): string {
	const workspace = path.join(root, "workspace");
	fs.mkdirSync(workspace, { recursive: true });
	const sessionFile = path.join(root, "native", name);
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: nativeSessionId, cwd: workspace })}\n`,
		{ mode: 0o600 },
	);
	return fs.realpathSync(sessionFile);
}

function targetFor(root: string, sessionFile: string, nativeSessionId = "native") {
	return {
		sessionHandle: sessionHandleForFile(sessionFile),
		workspaceHandle: workspaceHandleForPath(path.join(root, "workspace")),
		nativeSessionId,
		sessionFile,
	};
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("RecoverableSessionTrash", () => {
	it("atomically moves one exact Session into a private, self-describing entry", async () => {
		const root = temporaryRoot();
		const webDataDir = path.join(root, "web-data");
		const source = writeSession(root, "session.jsonl", "native-id");
		const trash = new RecoverableSessionTrash(webDataDir, {
			now: () => Date.parse("2026-08-21T10:11:12.345Z"),
			randomId: () => "entry-id",
		});

		const result = await trash.move(targetFor(root, source, "native-id"));

		expect(fs.existsSync(source)).toBe(false);
		expect(result.entryDirectory).toBe(
			path.join(webDataDir, "trash", "sessions", "2026-08-21T10-11-12-345Z_entry-id"),
		);
		expect(fs.statSync(result.entryDirectory).mode & 0o777).toBe(0o700);
		expect(fs.readFileSync(result.sessionFile, "utf8")).toContain('"id":"native-id"');
		const metadata = JSON.parse(
			fs.readFileSync(result.metadataFile, "utf8"),
		) as RecoverableSessionTrashMetadata;
		expect(metadata).toMatchObject({
			version: 1,
			trashId: "2026-08-21T10-11-12-345Z_entry-id",
			trashedAt: "2026-08-21T10:11:12.345Z",
			originalSessionFile: source,
			sessionHandle: sessionHandleForFile(source),
			workspaceHandle: workspaceHandleForPath(path.join(root, "workspace")),
			nativeSessionId: "native-id",
			storedFileName: "session.jsonl",
		});
		expect(fs.statSync(result.metadataFile).mode & 0o777).toBe(0o600);
	});

	it("never falls back to copy-and-unlink when the atomic rename crosses devices", async () => {
		const root = temporaryRoot();
		const source = writeSession(root);
		const rename = vi.fn(async () => {
			throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
		});
		const trash = new RecoverableSessionTrash(path.join(root, "web-data"), {
			randomId: () => "cross-device",
			rename,
		});

		await expect(trash.move(targetFor(root, source))).rejects.toThrow("same filesystem");

		expect(rename).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(source)).toBe(true);
		expect(fs.readdirSync(path.join(root, "web-data", "trash", "sessions"))).toEqual([]);
	});

	it("refuses to reuse an existing entry and leaves the later source untouched", async () => {
		const root = temporaryRoot();
		const first = writeSession(root, "first.jsonl");
		const second = writeSession(root, "second.jsonl");
		const trash = new RecoverableSessionTrash(path.join(root, "web-data"), {
			now: () => 0,
			randomId: () => "collision",
		});
		await trash.move(targetFor(root, first));
		await expect(trash.move(targetFor(root, second))).rejects.toThrow(
			"unable to reserve a unique trash entry",
		);

		expect(fs.existsSync(second)).toBe(true);
		const entries = fs.readdirSync(path.join(root, "web-data", "trash", "sessions"));
		expect(entries).toEqual(["1970-01-01T00-00-00-000Z_collision"]);
	});

	it("rejects symlinks and non-JSONL sources before creating an entry", async () => {
		const root = temporaryRoot();
		const canonical = writeSession(root);
		const linked = path.join(root, "linked.jsonl");
		fs.symlinkSync(canonical, linked);
		const text = path.join(root, "notes.txt");
		fs.writeFileSync(text, "not a session");
		const trash = new RecoverableSessionTrash(path.join(root, "web-data"));
		await expect(trash.move(targetFor(root, linked))).rejects.toThrow("canonical regular file");
		await expect(trash.move(targetFor(root, text))).rejects.toThrow("JSONL");
		expect(fs.existsSync(canonical)).toBe(true);
	});

	it("rejects path, native id, and Header cwd identity mismatches before moving", async () => {
		const root = temporaryRoot();
		const source = writeSession(root);
		const trash = new RecoverableSessionTrash(path.join(root, "web-data"));

		await expect(
			trash.move({
				...targetFor(root, source),
				sessionHandle: "session_forged",
			}),
		).rejects.toThrow("does not match");
		await expect(
			trash.move({ ...targetFor(root, source), nativeSessionId: "forged-native-id" }),
		).rejects.toThrow("Header id does not match");
		const otherWorkspace = path.join(root, "identity-other-workspace");
		fs.mkdirSync(otherWorkspace);
		await expect(
			trash.move({
				...targetFor(root, source),
				workspaceHandle: workspaceHandleForPath(otherWorkspace),
			}),
		).rejects.toThrow("Header cwd does not match");
		expect(fs.existsSync(source)).toBe(true);
	});

	it("detects an inode swap at rename time and restores the unexpected file without overwriting", async () => {
		const root = temporaryRoot();
		const source = writeSession(root);
		const originalBackup = path.join(root, "original-backup.jsonl");
		const otherWorkspace = path.join(root, "other-workspace");
		fs.mkdirSync(otherWorkspace);
		const rename = vi.fn(async (from: string, destination: string) => {
			await fs.promises.rename(from, originalBackup);
			await fs.promises.writeFile(
				from,
				`${JSON.stringify({ type: "session", version: 3, id: "other", cwd: otherWorkspace })}\n`,
			);
			await fs.promises.rename(from, destination);
		});
		const trash = new RecoverableSessionTrash(path.join(root, "web-data"), { rename });

		await expect(trash.move(targetFor(root, source))).rejects.toThrow(
			"identity changed during the atomic move",
		);

		expect(rename).toHaveBeenCalledTimes(1);
		expect(fs.readFileSync(source, "utf8")).toContain('"id":"other"');
		expect(fs.readFileSync(originalBackup, "utf8")).toContain('"id":"native"');
		expect(fs.readdirSync(path.join(root, "web-data", "trash", "sessions"))).toEqual([]);
	});
});
