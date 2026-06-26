import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findChildSessions, scanSessionDir, scanSessionFile } from "../src/session-scan.ts";

function writeSession(dir: string, fileName: string, lines: string[]): string {
	const p = path.join(dir, fileName);
	fs.writeFileSync(p, lines.map((l) => `${l}\n`).join(""));
	return p;
}

describe("session scanning", () => {
	it("extracts header + bounded info window", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-scan-"));
		const p = writeSession(dir, "2026-01-01T00-00-00-000Z_abc.jsonl", [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "abc",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp/proj",
			}),
			JSON.stringify({ type: "session_info", id: "e1", parentId: null, name: "My Session" }),
			JSON.stringify({
				type: "message",
				id: "e2",
				parentId: "e1",
				message: { role: "user", content: [{ type: "text", text: "hello world" }] },
			}),
			JSON.stringify({
				type: "message",
				id: "e3",
				parentId: "e2",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			}),
		]);
		const summary = await scanSessionFile(p);
		expect(summary).not.toBeNull();
		expect(summary?.id).toBe("abc");
		expect(summary?.name).toBe("My Session");
		expect(summary?.cwd).toBe("/tmp/proj");
		expect(summary?.messageCount).toBe(2);
		expect(summary?.firstMessage).toBe("hello world");
		expect(summary?.path).toBe("2026-01-01T00-00-00-000Z_abc.jsonl");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("skips files without a valid header", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-scan-"));
		const p = writeSession(dir, "bad.jsonl", ["not json at all"]);
		expect(await scanSessionFile(p)).toBeNull();
		const p2 = writeSession(dir, "bad2.jsonl", [JSON.stringify({ type: "message", id: "x" })]);
		expect(await scanSessionFile(p2)).toBeNull();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("sorts by mtime desc and detects children for lineage protection", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-scan-"));
		const parentPath = writeSession(dir, "2026-01-01T00-00-00-000Z_parent.jsonl", [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "parent",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp/proj",
			}),
		]);
		const childPath = writeSession(dir, "2026-01-02T00-00-00-000Z_child.jsonl", [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "child",
				timestamp: "2026-01-02T00:00:00.000Z",
				cwd: "/tmp/proj",
				parentSession: parentPath,
			}),
		]);
		// Force mtimes: child newer than parent.
		const older = new Date(Date.now() - 60_000);
		const newer = new Date();
		fs.utimesSync(parentPath, older, older);
		fs.utimesSync(childPath, newer, newer);

		const sessions = await scanSessionDir(dir);
		expect(sessions.map((s) => s.id)).toEqual(["child", "parent"]);

		const children = await findChildSessions(dir, parentPath);
		expect(children).toEqual([childPath]);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
