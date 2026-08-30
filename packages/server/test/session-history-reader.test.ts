import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	buildSessionContext,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { scanNativeSessionHistory } from "../src/session-history-reader.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sessionFile(entries: unknown[]): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-history-reader-"));
	roots.push(root);
	const file = path.join(root, "session.jsonl");
	await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
	return file;
}

function header() {
	return {
		type: "session",
		version: 3,
		id: "native-a",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/workspace",
	};
}

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-01-01T00:00:0${id.slice(-1)}.000Z`,
		message: {
			role,
			content: role === "user" ? text : [{ type: "text", text }],
			timestamp: 1,
			...(role === "assistant"
				? {
						provider: "provider",
						model: "model",
						api: "api",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
					}
				: {}),
		},
	};
}

describe("Native Session history reader", () => {
	it("scans bounded metadata and pages the active branch from newest to oldest", async () => {
		const file = await sessionFile([
			header(),
			message("a", null, "user", "one"),
			message("b", "a", "assistant", "two"),
			message("c", "b", "user", "three"),
			message("d", "c", "assistant", "four"),
			message("e", "d", "user", "five"),
		]);
		const plan = await scanNativeSessionHistory(file, {
			expectedNativeSessionId: "native-a",
			expectedCwd: "/workspace",
			initialMessageLimit: 2,
		});

		expect(plan.totalMessages).toBe(5);
		expect(plan.initialStart).toBe(2);
		const initial = await plan.readInitial();
		expect(initial.entries.map((entry) => entry.id)).toEqual(["c", "d", "e"]);
		expect(initial.itemCount).toBe(3);
		expect(initial.nextCursor).toEqual(expect.any(String));

		const older = await plan.readPage(initial.nextCursor!, 2);
		expect(older.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
		expect(older.nextCursor).toBeNull();
	});

	it("reproduces Pi compaction path selection without retaining message payloads", async () => {
		const file = await sessionFile([
			header(),
			message("a", null, "user", "old"),
			message("b", "a", "assistant", "old answer"),
			{
				type: "compaction",
				id: "compact",
				parentId: "b",
				timestamp: "2026-01-01T00:00:03.000Z",
				summary: "summary",
				firstKeptEntryId: "b",
				tokensBefore: 10,
			},
			message("c", "compact", "user", "new"),
		]);
		const plan = await scanNativeSessionHistory(file, { initialMessageLimit: 10 });

		const initial = await plan.readInitial();
		expect(initial.entries.map((entry) => entry.id)).toEqual(["compact", "b", "c"]);
	});

	it("matches Pi context selection across branches, compaction, and summaries", async () => {
		const entries = [
			message("a", null, "user", "old question"),
			message("b", "a", "assistant", "kept answer"),
			message("x", "a", "assistant", "abandoned branch"),
			{
				type: "compaction",
				id: "compact",
				parentId: "b",
				timestamp: "2026-01-01T00:00:03.000Z",
				summary: "summary",
				firstKeptEntryId: "b",
				tokensBefore: 10,
			},
			message("c", "compact", "user", "new question"),
			{
				type: "branch_summary",
				id: "summary",
				parentId: "c",
				timestamp: "2026-01-01T00:00:04.000Z",
				fromId: "x",
				summary: "branch context",
			},
		] as SessionEntry[];
		const file = await sessionFile([header(), ...entries]);
		const plan = await scanNativeSessionHistory(file, { initialMessageLimit: 32 });
		const initial = await plan.readInitial();

		expect(initial.entries.flatMap(sessionEntryToContextMessages)).toEqual(
			buildSessionContext(entries, "summary").messages,
		);
	});

	it("fails closed when the source changes between bounded reads", async () => {
		const file = await sessionFile([header(), message("a", null, "user", "one")]);
		const plan = await scanNativeSessionHistory(file, { initialMessageLimit: 1 });
		expect(plan.isSourceCurrent()).toBe(true);
		await writeFile(file, `${JSON.stringify(header())}\n`, "utf8");

		expect(plan.isSourceCurrent()).toBe(false);
		await expect(plan.readInitial()).rejects.toMatchObject({ code: "session_history_changed" });
	});

	it("honors cancellation before reading a history page", async () => {
		const file = await sessionFile([
			header(),
			message("a", null, "user", "one"),
			message("b", "a", "assistant", "two"),
			message("c", "b", "user", "three"),
		]);
		const plan = await scanNativeSessionHistory(file, { initialMessageLimit: 1 });
		const initial = await plan.readInitial();
		const controller = new AbortController();
		controller.abort();

		await expect(plan.readPage(initial.nextCursor!, 1, controller.signal)).rejects.toMatchObject({
			code: "session_history_cancelled",
		});
	});

	it("bounds the retained record index independently of the source byte budget", async () => {
		const file = await sessionFile([
			header(),
			message("a", null, "user", "one"),
			message("b", "a", "assistant", "two"),
			message("c", "b", "user", "three"),
		]);

		await expect(scanNativeSessionHistory(file, { maxIndexedRecords: 2 })).rejects.toMatchObject({
			code: "session_history_too_large",
		});
	});
});
