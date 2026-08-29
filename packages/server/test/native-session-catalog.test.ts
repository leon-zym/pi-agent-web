import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	canonicalizeSessionFile,
	NATIVE_SESSION_FILE_SCAN_CONCURRENCY,
	NATIVE_SESSION_FIRST_MESSAGE_MAX_CHARS,
	NativeSessionCatalog,
	sessionHandleForCanonicalFile,
	sessionHandleForFile,
} from "../src/native-session-catalog.js";
import { SessionLayoutResolver } from "../src/session-layout-resolver.js";
import { WorkspacePreferences } from "../src/workspace-preferences.js";

const temporaryRoots: string[] = [];

function temporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-catalog-"));
	temporaryRoots.push(directory);
	return directory;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeSession(
	directory: string,
	fileName: string,
	options: {
		id: string;
		cwd?: string;
		name?: string;
		createdAt?: string;
		activityAt?: number;
		firstMessage?: string;
		parentSession?: string;
	},
): string {
	fs.mkdirSync(directory, { recursive: true });
	const createdAt = options.createdAt ?? "2026-01-01T00:00:00.000Z";
	const activityAt = options.activityAt ?? Date.parse("2026-01-02T00:00:00.000Z");
	const firstMessage = options.firstMessage ?? `question for ${options.id}`;
	const header: Record<string, unknown> = {
		type: "session",
		version: 3,
		id: options.id,
		timestamp: createdAt,
	};
	if (options.cwd !== undefined) header.cwd = options.cwd;
	if (options.parentSession !== undefined) header.parentSession = options.parentSession;
	const lines: unknown[] = [header];
	if (options.name) {
		lines.push({
			type: "session_info",
			id: `${options.id}-info`,
			parentId: null,
			timestamp: createdAt,
			name: options.name,
		});
	}
	lines.push({
		type: "message",
		id: `${options.id}-user`,
		parentId: null,
		timestamp: new Date(activityAt).toISOString(),
		message: { role: "user", content: firstMessage, timestamp: activityAt },
	});
	lines.push({
		type: "message",
		id: `${options.id}-assistant`,
		parentId: `${options.id}-user`,
		timestamp: new Date(activityAt + 1).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: `answer for ${options.id}` }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: activityAt + 1,
		},
	});
	const file = path.join(directory, fileName);
	fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

function createResolver(root: string, env: Record<string, string | undefined> = {}): SessionLayoutResolver {
	return new SessionLayoutResolver({
		agentDir: path.join(root, "agent"),
		env,
		runtimeCwd: root,
		settingsProbeCwd: root,
	});
}

describe("NativeSessionCatalog", () => {
	it("discovers native Pi history with activity-based summaries and canonical lineage", async () => {
		const root = temporaryDirectory();
		const resolver = createResolver(root);
		const workspaceA = path.join(root, "workspace-a");
		const workspaceB = path.join(root, "workspace-b");
		fs.mkdirSync(workspaceA);
		fs.mkdirSync(workspaceB);
		const directoryA = resolver.defaultSessionDirForWorkspace(workspaceA);
		const directoryB = resolver.defaultSessionDirForWorkspace(workspaceB);
		const parentFile = path.join(directoryA, "missing-parent.jsonl");
		const fileA = writeSession(directoryA, "a.jsonl", {
			id: "native-a",
			cwd: workspaceA,
			name: "Alpha",
			firstMessage: "exact first question",
			parentSession: parentFile,
		});
		writeSession(directoryB, "b.jsonl", { id: "native-b", cwd: workspaceB });

		const catalog = new NativeSessionCatalog({ layoutResolver: resolver, cacheTtlMs: 0 });
		const snapshot = await catalog.refresh({ force: true });
		const actual = snapshot.sessions.find(
			(session) => session.sessionFile === canonicalizeSessionFile(fileA),
		);

		expect(snapshot.sessions).toHaveLength(2);
		expect(snapshot.workspaces).toHaveLength(2);
		expect(actual).toMatchObject({
			nativeSessionId: "native-a",
			cwd: fs.realpathSync(workspaceA),
			name: "Alpha",
			parentSessionFile: canonicalizeSessionFile(parentFile),
			messageCount: 2,
			firstMessage: "exact first question",
			workspaceAvailable: true,
		});
		expect(actual?.created.getTime()).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
		expect(actual?.modified.getTime()).toBe(Date.parse("2026-01-02T00:00:00.001Z"));
		expect(actual && "allMessagesText" in actual).toBe(false);
	});

	it("streams multi-megabyte histories without retaining message text", async () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		const sessionDir = path.join(root, "large-sessions");
		fs.mkdirSync(workspace);
		fs.mkdirSync(sessionDir);
		const startTime = Date.parse("2026-02-01T00:00:00.000Z");
		const firstMessage = `  first\n\tpreview ${"x".repeat(1_000)}`;
		const lines: string[] = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "large",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: workspace,
			}),
			JSON.stringify({ type: "session_info", name: "Old name" }),
			JSON.stringify({
				type: "message",
				timestamp: new Date(startTime).toISOString(),
				message: { role: "user", content: firstMessage, timestamp: startTime },
			}),
		];
		const extraMessages = 5_000;
		for (let index = 0; index < extraMessages; index += 1) {
			const timestamp = startTime + index + 1;
			lines.push(
				JSON.stringify({
					type: "message",
					timestamp: new Date(timestamp).toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: `${String(index)}:${"y".repeat(1_024)}` }],
						timestamp,
					},
				}),
			);
		}
		lines.push(JSON.stringify({ type: "session_info", name: "  Final name  " }));
		const file = path.join(sessionDir, "large.jsonl");
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
		expect(fs.statSync(file).size).toBeGreaterThan(5 * 1024 * 1024);

		const snapshot = await new NativeSessionCatalog({
			layoutResolver: createResolver(root, { PI_CODING_AGENT_SESSION_DIR: sessionDir }),
		}).refresh({ force: true });
		const session = snapshot.sessions[0];

		expect(session).toMatchObject({
			nativeSessionId: "large",
			name: "Final name",
			messageCount: extraMessages + 1,
			modified: new Date(startTime + extraMessages),
		});
		expect(session?.firstMessage).toHaveLength(NATIVE_SESSION_FIRST_MESSAGE_MAX_CHARS);
		expect(session?.firstMessage.startsWith("first preview ")).toBe(true);
		expect(session && "allMessagesText" in session).toBe(false);
		expect(JSON.stringify(session).length).toBeLessThan(2_000);
	});

	it("collapses expanded skill bodies in the first-message summary", async () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		writeSession(path.join(root, "sessions"), "skill.jsonl", {
			id: "skill-summary",
			cwd: workspace,
			firstMessage:
				'<skill name="e2e" location="/private/e2e/SKILL.md">\nSECRET_SKILL_BODY_MUST_NOT_RENDER\n</skill>\n\natomic argument',
		});

		const snapshot = await new NativeSessionCatalog({
			layoutResolver: createResolver(root, {
				PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
			}),
		}).refresh({ force: true });

		expect(snapshot.sessions[0]?.firstMessage).toBe("/skill:e2e atomic argument");
		expect(snapshot.sessions[0]?.firstMessage).not.toContain("SECRET_SKILL_BODY_MUST_NOT_RENDER");
		expect(snapshot.sessions[0]?.firstMessage).not.toContain("/private/e2e/SKILL.md");
	});

	it("fails private when a skill summary has an ambiguous closing delimiter", async () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		const sessionDirectory = path.join(root, "sessions");
		fs.mkdirSync(workspace);
		writeSession(sessionDirectory, "ambiguous-skill.jsonl", {
			id: "ambiguous-skill-summary",
			cwd: workspace,
			firstMessage:
				'<skill name="e2e" location="/private/e2e/SKILL.md">\nExample delimiter:\n</skill>\n\nSECRET BODY AFTER EXAMPLE\n</skill>\n\nreal user args',
		});

		const snapshot = await new NativeSessionCatalog({
			layoutResolver: createResolver(root, {
				PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
			}),
		}).refresh({ force: true });

		expect(snapshot.sessions[0]?.firstMessage).toBe("/skill:e2e");
		expect(snapshot.sessions[0]?.firstMessage).not.toContain("SECRET");
		expect(snapshot.sessions[0]?.firstMessage).not.toContain("/private");
		expect(snapshot.sessions[0]?.firstMessage).not.toContain("real user args");
	});

	it("does not use an inline skill closing-token example as a summary boundary", async () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		const sessionDirectory = path.join(root, "sessions");
		fs.mkdirSync(workspace);
		writeSession(sessionDirectory, "inline-skill-close.jsonl", {
			id: "inline-skill-close",
			cwd: workspace,
			firstMessage:
				'<skill name="e2e" location="/private/e2e/SKILL.md">\nUse inline example: </skill>\n\nSECRET TRAILING BODY',
		});

		const snapshot = await new NativeSessionCatalog({
			layoutResolver: createResolver(root, {
				PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
			}),
		}).refresh({ force: true });

		expect(snapshot.sessions[0]?.firstMessage).toBe("/skill:e2e");
	});

	it("treats custom environment and project session directories as direct layouts", async () => {
		const root = temporaryDirectory();
		const environmentDir = path.join(root, "environment-sessions");
		const projectDir = path.join(root, "project-sessions");
		const workspaceA = path.join(root, "workspace-a");
		const workspaceB = path.join(root, "workspace-b");
		fs.mkdirSync(path.join(workspaceB, ".pi"), { recursive: true });
		fs.mkdirSync(workspaceA);
		fs.writeFileSync(
			path.join(workspaceB, ".pi", "settings.json"),
			JSON.stringify({ sessionDir: projectDir }),
		);
		writeSession(environmentDir, "env.jsonl", { id: "env", cwd: workspaceA });
		writeSession(projectDir, "project.jsonl", { id: "project", cwd: workspaceB });
		const resolver = createResolver(root, { PI_CODING_AGENT_SESSION_DIR: environmentDir });

		const snapshot = await new NativeSessionCatalog({
			layoutResolver: resolver,
			knownWorkspacePaths: [workspaceB],
		}).refresh({ force: true });

		expect(snapshot.sessions.map((session) => session.nativeSessionId).sort()).toEqual(["env", "project"]);
		expect(snapshot.scannedSources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ mode: "direct", path: environmentDir, reason: "environment" }),
				expect.objectContaining({ mode: "direct", path: projectDir, reason: "project-settings" }),
			]),
		);
	});

	it("discovers a global settings sessionDir without any host workspace registry", async () => {
		const root = temporaryDirectory();
		const agentDir = path.join(root, "agent");
		const globalDirectory = path.join(root, "global-sessions");
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(workspace);
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: globalDirectory }));
		writeSession(globalDirectory, "global.jsonl", { id: "global", cwd: workspace });

		const snapshot = await new NativeSessionCatalog({ layoutResolver: createResolver(root) }).refresh({
			force: true,
		});

		expect(snapshot.sessions.map((session) => session.nativeSessionId)).toEqual(["global"]);
		expect(snapshot.scannedSources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ mode: "direct", path: globalDirectory, reason: "global-settings" }),
			]),
		);
	});

	it("keeps duplicate native session ids distinct by canonical session file", async () => {
		const root = temporaryDirectory();
		const resolver = createResolver(root);
		const workspaceA = path.join(root, "workspace-a");
		const workspaceB = path.join(root, "workspace-b");
		fs.mkdirSync(workspaceA);
		fs.mkdirSync(workspaceB);
		writeSession(resolver.defaultSessionDirForWorkspace(workspaceA), "one.jsonl", {
			id: "same-native-id",
			cwd: workspaceA,
		});
		writeSession(resolver.defaultSessionDirForWorkspace(workspaceB), "two.jsonl", {
			id: "same-native-id",
			cwd: workspaceB,
		});

		const sessions = (await new NativeSessionCatalog({ layoutResolver: resolver }).refresh({ force: true }))
			.sessions;
		expect(sessions).toHaveLength(2);
		expect(new Set(sessions.map((session) => session.nativeSessionId))).toEqual(new Set(["same-native-id"]));
		expect(new Set(sessions.map((session) => session.sessionHandle)).size).toBe(2);
	});

	it("retains missing and empty Header.cwd records as unavailable", async () => {
		const root = temporaryDirectory();
		const resolver = createResolver(root);
		const missingWorkspace = path.join(root, "deleted-workspace");
		const directory = path.join(root, "custom-sessions");
		writeSession(directory, "missing.jsonl", { id: "missing-cwd", cwd: missingWorkspace });
		writeSession(directory, "empty.jsonl", { id: "empty-cwd" });
		const customResolver = createResolver(root, { PI_CODING_AGENT_SESSION_DIR: directory });

		const snapshot = await new NativeSessionCatalog({ layoutResolver: customResolver }).refresh({
			force: true,
		});
		const missing = snapshot.sessions.find((session) => session.nativeSessionId === "missing-cwd");
		const empty = snapshot.sessions.find((session) => session.nativeSessionId === "empty-cwd");
		expect(missing).toMatchObject({
			workspacePath: path.join(fs.realpathSync(root), path.basename(missingWorkspace)),
			workspaceAvailable: false,
			workspaceUnavailableReason: "missing",
		});
		expect(empty).toMatchObject({
			cwd: "",
			workspacePath: null,
			workspaceAvailable: false,
			workspaceUnavailableReason: "cwd-empty",
		});
		expect(resolver.defaultSessionsRootForWorkspace(root)).toContain(path.join("agent", "sessions"));
	});

	it("isolates corrupt JSONL and corrupt or absent preferences from native discovery", async () => {
		const root = temporaryDirectory();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const directory = resolver.defaultSessionDirForWorkspace(workspace);
		const goodFile = writeSession(directory, "good.jsonl", { id: "good", cwd: workspace });
		fs.appendFileSync(
			goodFile,
			`{broken-middle-line\n${JSON.stringify({
				type: "message",
				timestamp: "2026-01-03T00:00:00.000Z",
				message: { role: "user", content: "still readable" },
			})}\n`,
		);
		fs.writeFileSync(path.join(directory, "bad.jsonl"), "{not-json\n");
		const dataDir = path.join(root, "web-data");
		fs.mkdirSync(dataDir);
		fs.writeFileSync(path.join(dataDir, "workspace-preferences.json"), "{also-broken");
		const preferences = new WorkspacePreferences(dataDir);
		try {
			const snapshot = await new NativeSessionCatalog({ layoutResolver: resolver, preferences }).refresh({
				force: true,
			});
			expect(snapshot.sessions.map((session) => session.nativeSessionId)).toEqual(["good"]);
			expect(snapshot.sessions[0]?.messageCount).toBe(3);
			expect(snapshot.diagnostics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ source: "preferences", message: expect.stringContaining("malformed") }),
				]),
			);
		} finally {
			preferences.close();
		}
	});

	it("deduplicates concurrent refreshes and caches the completed snapshot", async () => {
		const root = temporaryDirectory();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		writeSession(resolver.defaultSessionDirForWorkspace(workspace), "one.jsonl", {
			id: "one",
			cwd: workspace,
		});
		let now = 100;
		const catalog = new NativeSessionCatalog({ layoutResolver: resolver, cacheTtlMs: 1_000, now: () => now });
		const first = catalog.refresh({ force: true });
		const concurrent = catalog.refresh({ force: true });
		expect(concurrent).toBe(first);
		const snapshot = await first;
		now = 500;
		expect(await catalog.refresh()).toBe(snapshot);
		expect(catalog.getSnapshot()).toBe(snapshot);
	});

	it("starts a newer scan when force refresh collides with an older in-flight discovery", async () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		const sessionDir = path.join(root, "direct-sessions");
		fs.mkdirSync(workspace);
		writeSession(sessionDir, "parent.jsonl", { id: "parent", cwd: workspace });
		const resolver = createResolver(root, { PI_CODING_AGENT_SESSION_DIR: sessionDir });
		const originalCreateReadStream = fs.createReadStream.bind(fs);
		let firstReadStarted: (() => void) | undefined;
		const firstRead = new Promise<void>((resolve) => {
			firstReadStarted = resolve;
		});
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let gateFirstRead = true;
		const createReadStream = vi.spyOn(fs, "createReadStream");
		createReadStream.mockImplementation(((filePath, options) => {
			if (!gateFirstRead) return originalCreateReadStream(filePath, options);
			gateFirstRead = false;
			const delayed = new PassThrough();
			firstReadStarted?.();
			void firstGate.then(() => {
				originalCreateReadStream(filePath, options).pipe(delayed);
			});
			return delayed as unknown as fs.ReadStream;
		}) as typeof fs.createReadStream);
		const catalog = new NativeSessionCatalog({ layoutResolver: resolver, cacheTtlMs: 0 });
		const older = catalog.refresh();
		await firstRead;
		writeSession(sessionDir, "child.jsonl", { id: "child", cwd: workspace });
		const forced = catalog.refresh({ force: true });
		releaseFirst?.();

		expect((await older).sessions.map((session) => session.nativeSessionId)).toEqual(["parent"]);
		expect((await forced).sessions.map((session) => session.nativeSessionId).sort()).toEqual([
			"child",
			"parent",
		]);
		expect(createReadStream).toHaveBeenCalledTimes(3);
	});

	it("reuses unchanged file summaries when one JSONL file revision changes", async () => {
		const root = temporaryDirectory();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const sessionDirectory = resolver.defaultSessionDirForWorkspace(workspace);
		const file = writeSession(sessionDirectory, "one.jsonl", {
			id: "one",
			cwd: workspace,
		});
		writeSession(sessionDirectory, "two.jsonl", { id: "two", cwd: workspace });
		const createReadStream = vi.spyOn(fs, "createReadStream");
		const catalog = new NativeSessionCatalog({ layoutResolver: resolver, cacheTtlMs: 0 });

		expect((await catalog.refresh({ force: true })).sessions).toHaveLength(2);
		expect((await catalog.refresh({ force: true })).sessions).toHaveLength(2);
		expect(createReadStream).toHaveBeenCalledTimes(2);

		fs.appendFileSync(
			file,
			`${JSON.stringify({
				type: "message",
				id: "one-followup",
				parentId: "one-assistant",
				timestamp: "2026-01-03T00:00:00.000Z",
				message: { role: "user", content: "follow up", timestamp: Date.parse("2026-01-03T00:00:00.000Z") },
			})}\n`,
		);
		expect((await catalog.refresh({ force: true })).sessions[0]?.messageCount).toBe(3);
		expect(createReadStream).toHaveBeenCalledTimes(3);
		const appendOptions = createReadStream.mock.calls[2]?.[1] as { start?: number } | undefined;
		if (!appendOptions) throw new Error("incremental scan did not open a stream");
		expect(appendOptions.start).toBeGreaterThan(0);
	});

	it("rebuilds a cached file after truncation or inode replacement", async () => {
		const root = temporaryDirectory();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const sessionDirectory = resolver.defaultSessionDirForWorkspace(workspace);
		const file = writeSession(sessionDirectory, "one.jsonl", { id: "one", cwd: workspace });
		const createReadStream = vi.spyOn(fs, "createReadStream");
		const catalog = new NativeSessionCatalog({ layoutResolver: resolver, cacheTtlMs: 0 });

		expect((await catalog.refresh({ force: true })).sessions[0]).toMatchObject({
			nativeSessionId: "one",
			messageCount: 2,
		});
		expect(createReadStream).toHaveBeenCalledTimes(1);

		fs.writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: "one", timestamp: "2026-01-01T00:00:00.000Z", cwd: workspace })}\n`,
		);
		expect((await catalog.refresh({ force: true })).sessions[0]).toMatchObject({
			nativeSessionId: "one",
			messageCount: 0,
		});
		expect(createReadStream).toHaveBeenCalledTimes(2);

		const replacement = writeSession(sessionDirectory, "replacement.jsonl", {
			id: "replacement",
			cwd: workspace,
		});
		fs.renameSync(replacement, file);
		expect((await catalog.refresh({ force: true })).sessions[0]).toMatchObject({
			nativeSessionId: "replacement",
			messageCount: 2,
		});
		expect(createReadStream).toHaveBeenCalledTimes(3);
	});

	it("rebuilds after same-inode truncation and regrowth despite an unchanged Header", async () => {
		const root = temporaryDirectory();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const sessionDirectory = resolver.defaultSessionDirForWorkspace(workspace);
		const file = writeSession(sessionDirectory, "one.jsonl", { id: "one", cwd: workspace });
		const catalog = new NativeSessionCatalog({ layoutResolver: resolver, cacheTtlMs: 0 });

		expect((await catalog.refresh({ force: true })).sessions[0]).toMatchObject({
			nativeSessionId: "one",
			messageCount: 2,
		});
		const replacement = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "one",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: workspace,
			}),
			JSON.stringify({
				type: "message",
				timestamp: "2026-01-03T00:00:00.000Z",
				message: {
					role: "user",
					content: "replacement ".repeat(20_000),
					timestamp: Date.parse("2026-01-03T00:00:00.000Z"),
				},
			}),
		].join("\n");
		expect(Buffer.byteLength(replacement)).toBeGreaterThan(fs.statSync(file).size);
		fs.writeFileSync(file, `${replacement}\n`);

		expect((await catalog.refresh({ force: true })).sessions[0]).toMatchObject({
			nativeSessionId: "one",
			messageCount: 1,
			firstMessage: expect.stringContaining("replacement"),
		});
	});

	it("retries a scan against a fixed descriptor when a symlink target changes mid-read", async () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		const targets = path.join(root, "targets");
		const sessionDirectory = path.join(root, "sessions");
		fs.mkdirSync(workspace);
		const targetA = writeSession(targets, "a.jsonl", { id: "a", cwd: workspace });
		const targetB = writeSession(targets, "b.jsonl", { id: "b", cwd: workspace });
		fs.mkdirSync(sessionDirectory);
		const link = path.join(sessionDirectory, "linked.jsonl");
		fs.symlinkSync(targetA, link);
		const originalCreateReadStream = fs.createReadStream.bind(fs);
		let replaced = false;
		const createReadStream = vi.spyOn(fs, "createReadStream");
		createReadStream.mockImplementation(((filePath, options) => {
			if (!replaced && filePath === link) {
				replaced = true;
				fs.unlinkSync(link);
				fs.symlinkSync(targetB, link);
			}
			return originalCreateReadStream(filePath, options);
		}) as typeof fs.createReadStream);
		const catalog = new NativeSessionCatalog({
			layoutResolver: createResolver(root, { PI_CODING_AGENT_SESSION_DIR: sessionDirectory }),
			cacheTtlMs: 0,
		});

		expect((await catalog.refresh({ force: true })).sessions[0]).toMatchObject({ nativeSessionId: "b" });
		expect(createReadStream.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("invalidates a directory cache when a symlink changes its canonical target", async () => {
		const root = temporaryDirectory();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		const sessionDirectory = resolver.defaultSessionDirForWorkspace(workspace);
		const targets = path.join(root, "targets");
		fs.mkdirSync(workspace);
		fs.mkdirSync(targets);
		const targetA = writeSession(targets, "a.jsonl", { id: "same", cwd: workspace });
		const targetB = path.join(targets, "b.jsonl");
		fs.linkSync(targetA, targetB);
		const link = path.join(sessionDirectory, "linked.jsonl");
		fs.mkdirSync(sessionDirectory, { recursive: true });
		fs.symlinkSync(targetA, link);
		const catalog = new NativeSessionCatalog({ layoutResolver: resolver, cacheTtlMs: 0 });

		expect((await catalog.refresh({ force: true })).sessions[0]?.sessionFile).toBe(
			canonicalizeSessionFile(targetA),
		);
		fs.unlinkSync(link);
		fs.symlinkSync(targetB, link);

		expect((await catalog.refresh({ force: true })).sessions[0]?.sessionFile).toBe(
			canonicalizeSessionFile(targetB),
		);
	});

	it("retries a file after a transient read error without retaining a negative cache", async () => {
		const root = temporaryDirectory();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		writeSession(resolver.defaultSessionDirForWorkspace(workspace), "one.jsonl", {
			id: "one",
			cwd: workspace,
		});
		const originalCreateReadStream = fs.createReadStream.bind(fs);
		const createReadStream = vi.spyOn(fs, "createReadStream");
		createReadStream.mockImplementationOnce((_filePath, _options) => {
			const stream = new PassThrough();
			const error = Object.assign(new Error("temporary read failure"), { code: "EIO" });
			process.nextTick(() => stream.destroy(error));
			return stream as unknown as fs.ReadStream;
		});
		createReadStream.mockImplementation((filePath, options) => originalCreateReadStream(filePath, options));
		const catalog = new NativeSessionCatalog({ layoutResolver: resolver, cacheTtlMs: 0 });

		const first = await catalog.refresh({ force: true });
		expect(first.sessions).toEqual([]);
		expect(first.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "discovery_retryable",
					path: expect.stringContaining("one.jsonl"),
					retryable: true,
					partial: true,
					stale: false,
				}),
			]),
		);
		expect((await catalog.refresh({ force: true })).sessions[0]).toMatchObject({
			nativeSessionId: "one",
			messageCount: 2,
		});
		expect(createReadStream).toHaveBeenCalledTimes(2);
	});

	it("keeps a stale file summary visible and retries it after a transient refresh failure", async () => {
		const root = temporaryDirectory();
		const resolver = createResolver(root);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const sessionDirectory = resolver.defaultSessionDirForWorkspace(workspace);
		const file = writeSession(sessionDirectory, "one.jsonl", { id: "one", cwd: workspace });
		const createReadStream = vi.spyOn(fs, "createReadStream");
		const catalog = new NativeSessionCatalog({ layoutResolver: resolver, cacheTtlMs: 0 });

		expect((await catalog.refresh({ force: true })).sessions[0]?.messageCount).toBe(2);
		fs.appendFileSync(
			file,
			`${JSON.stringify({
				type: "message",
				timestamp: "2026-01-03T00:00:00.000Z",
				message: { role: "user", content: "follow up", timestamp: Date.parse("2026-01-03T00:00:00.000Z") },
			})}\n`,
		);
		createReadStream.mockImplementationOnce((_filePath, _options) => {
			const stream = new PassThrough();
			const error = Object.assign(new Error("temporary read failure"), { code: "EIO" });
			process.nextTick(() => stream.destroy(error));
			return stream as unknown as fs.ReadStream;
		});

		const stale = await catalog.refresh({ force: true });
		expect(stale.sessions[0]?.messageCount).toBe(2);
		expect(stale.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "discovery_retryable",
					path: expect.stringContaining("one.jsonl"),
					retryable: true,
					partial: true,
					stale: true,
				}),
			]),
		);

		expect((await catalog.refresh({ force: true })).sessions[0]?.messageCount).toBe(3);
	});

	it("evicts cached directories that disappear from the current discovery plan", async () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		const projectSessionDir = path.join(root, "project-sessions");
		fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi", "settings.json"),
			JSON.stringify({ sessionDir: projectSessionDir }),
		);
		writeSession(projectSessionDir, "one.jsonl", { id: "one", cwd: workspace });
		let workspaceHints = [workspace];
		const createReadStream = vi.spyOn(fs, "createReadStream");
		const catalog = new NativeSessionCatalog({
			layoutResolver: createResolver(root),
			knownWorkspacePaths: () => workspaceHints,
			cacheTtlMs: 0,
		});

		expect((await catalog.refresh({ force: true })).sessions).toHaveLength(1);
		expect(createReadStream).toHaveBeenCalledTimes(1);
		workspaceHints = [];
		expect((await catalog.refresh({ force: true })).sessions).toHaveLength(0);
		workspaceHints = [workspace];
		expect((await catalog.refresh({ force: true })).sessions).toHaveLength(1);
		expect(createReadStream).toHaveBeenCalledTimes(2);
	});

	it("bounds concurrent file summary streams across a large directory", async () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		const sessionDir = path.join(root, "many-sessions");
		fs.mkdirSync(workspace);
		const fileCount = NATIVE_SESSION_FILE_SCAN_CONCURRENCY * 3;
		for (let index = 0; index < fileCount; index += 1) {
			writeSession(sessionDir, `${String(index).padStart(3, "0")}.jsonl`, {
				id: `session-${String(index)}`,
				cwd: workspace,
			});
		}

		const originalCreateReadStream = fs.createReadStream.bind(fs);
		let opened = 0;
		let active = 0;
		let maximumActive = 0;
		let workersReady: (() => void) | undefined;
		const firstWorkersReady = new Promise<void>((resolve) => {
			workersReady = resolve;
		});
		let releaseWorkers: (() => void) | undefined;
		const workerGate = new Promise<void>((resolve) => {
			releaseWorkers = resolve;
		});
		vi.spyOn(fs, "createReadStream").mockImplementation(((filePath, options) => {
			const delayed = new PassThrough();
			opened += 1;
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			delayed.once("close", () => {
				active -= 1;
			});
			if (opened === NATIVE_SESSION_FILE_SCAN_CONCURRENCY) workersReady?.();
			void workerGate.then(() => {
				originalCreateReadStream(filePath, options).pipe(delayed);
			});
			return delayed as unknown as fs.ReadStream;
		}) as typeof fs.createReadStream);

		const refresh = new NativeSessionCatalog({
			layoutResolver: createResolver(root, { PI_CODING_AGENT_SESSION_DIR: sessionDir }),
		}).refresh({ force: true });
		await firstWorkersReady;
		expect(opened).toBe(NATIVE_SESSION_FILE_SCAN_CONCURRENCY);
		releaseWorkers?.();
		expect((await refresh).sessions).toHaveLength(fileCount);
		expect(maximumActive).toBeLessThanOrEqual(NATIVE_SESSION_FILE_SCAN_CONCURRENCY);
	});

	it("retains the last complete directory view when the discovery page budget is exhausted", async () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(workspace);
		writeSession(sessionDir, "one.jsonl", { id: "one", cwd: workspace });
		const catalog = new NativeSessionCatalog({
			layoutResolver: createResolver(root, { PI_CODING_AGENT_SESSION_DIR: sessionDir }),
			cacheTtlMs: 0,
			maxDiscoveryPages: 3,
		});

		expect(
			(await catalog.refresh({ force: true })).sessions.map((session) => session.nativeSessionId),
		).toEqual(["one"]);
		writeSession(sessionDir, "two.jsonl", { id: "two", cwd: workspace });

		const partial = await catalog.refresh({ force: true });
		expect(partial.sessions.map((session) => session.nativeSessionId)).toContain("one");
		expect(partial.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "discovery_pages_exhausted",
					partial: true,
					stale: true,
				}),
			]),
		);
	});

	it("bounds total discovery bytes and reports a partial result", async () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(workspace);
		writeSession(sessionDir, "large.jsonl", { id: "large", cwd: workspace });

		const snapshot = await new NativeSessionCatalog({
			layoutResolver: createResolver(root, { PI_CODING_AGENT_SESSION_DIR: sessionDir }),
			maxDiscoveryBytes: 1,
		}).refresh({ force: true });

		expect(snapshot.sessions).toEqual([]);
		expect(snapshot.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "discovery_bytes_exhausted", partial: true, stale: false }),
			]),
		);
	});

	it("returns stale history for timeout and cancellation instead of failing the catalog refresh", async () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(workspace);
		writeSession(sessionDir, "one.jsonl", { id: "one", cwd: workspace });
		const catalog = new NativeSessionCatalog({
			layoutResolver: createResolver(root, { PI_CODING_AGENT_SESSION_DIR: sessionDir }),
			cacheTtlMs: 0,
		});
		const initial = await catalog.refresh({ force: true });

		const timeoutCatalog = new NativeSessionCatalog({
			layoutResolver: createResolver(root, { PI_CODING_AGENT_SESSION_DIR: sessionDir }),
			maxDiscoveryTimeMs: 0,
		});
		const timedOut = await timeoutCatalog.refresh({ force: true });
		expect(timedOut.sessions).toEqual([]);
		expect(timedOut.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "discovery_time_exhausted", partial: true, stale: false }),
			]),
		);

		const controller = new AbortController();
		controller.abort();
		const cancelled = await catalog.refresh({ force: true, signal: controller.signal });
		expect(cancelled.sessions.map((session) => session.nativeSessionId)).toEqual(
			initial.sessions.map((session) => session.nativeSessionId),
		);
		expect(cancelled.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "discovery_cancelled", partial: true, stale: true }),
			]),
		);
	});
});

describe("native session identity", () => {
	it("stays stable before and after a file appears below a symlinked parent", () => {
		const root = temporaryDirectory();
		const realDirectory = path.join(root, "real-sessions");
		const linkedDirectory = path.join(root, "linked-sessions");
		fs.mkdirSync(realDirectory);
		fs.symlinkSync(realDirectory, linkedDirectory, "dir");
		const futureViaLink = path.join(linkedDirectory, "future.jsonl");
		const expectedCanonical = path.join(fs.realpathSync(realDirectory), "future.jsonl");
		const before = sessionHandleForFile(futureViaLink);

		expect(canonicalizeSessionFile(futureViaLink)).toBe(expectedCanonical);
		fs.writeFileSync(futureViaLink, "");
		expect(canonicalizeSessionFile(futureViaLink)).toBe(expectedCanonical);
		expect(sessionHandleForFile(futureViaLink)).toBe(before);
		expect(sessionHandleForCanonicalFile(expectedCanonical)).toBe(before);
	});
});
