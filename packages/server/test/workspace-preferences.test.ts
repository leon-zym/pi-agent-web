import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceHandleForPath } from "../src/session-layout-resolver.js";
import { WorkspacePreferences } from "../src/workspace-preferences.js";

const temporaryRoots: string[] = [];

function temporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-preferences-"));
	temporaryRoots.push(directory);
	return directory;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("WorkspacePreferences", () => {
	it("persists presentation preferences without treating session data as registry state", () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const preferences = new WorkspacePreferences(root);
		try {
			const canonicalWorkspace = fs.realpathSync(workspace);
			const saved = preferences.upsert({
				pathHint: workspace,
				pinned: true,
				displayName: "Pinned project",
				lastOpenedAt: 123,
			});
			expect(saved.workspaceHandle).toBe(workspaceHandleForPath(workspace));
			const document = JSON.parse(fs.readFileSync(preferences.filePath, "utf8"));
			expect(document).toEqual({
				version: 1,
				preferences: [
					{
						workspaceHandle: saved.workspaceHandle,
						pathHint: canonicalWorkspace,
						pinned: true,
						displayName: "Pinned project",
						lastOpenedAt: 123,
					},
				],
			});
			expect(JSON.stringify(document)).not.toContain("sessionCount");
			const cleared = preferences.upsert({
				pathHint: workspace,
				pinned: false,
				displayName: null,
				lastOpenedAt: null,
			});
			expect(cleared).toMatchObject({ pinned: false, displayName: undefined, lastOpenedAt: null });
		} finally {
			preferences.close();
		}
	});

	it("imports the legacy registry only as path and display hints", () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		fs.writeFileSync(
			path.join(root, "workspaces.json"),
			JSON.stringify({
				version: 1,
				workspaces: [
					{
						id: "obsolete-host-id",
						path: "/obsolete/alias",
						cwdRealpath: workspace,
						displayName: "Legacy name",
						lastOpenedAt: 456,
					},
				],
			}),
		);
		const preferences = new WorkspacePreferences(root);
		try {
			const canonicalWorkspace = fs.realpathSync(workspace);
			expect(preferences.list()).toEqual([
				{
					workspaceHandle: workspaceHandleForPath(workspace),
					pathHint: canonicalWorkspace,
					pinned: false,
					displayName: "Legacy name",
					lastOpenedAt: 456,
				},
			]);
		} finally {
			preferences.close();
		}
	});

	it("isolates a malformed preference file", () => {
		const root = temporaryDirectory();
		fs.writeFileSync(path.join(root, "workspace-preferences.json"), "{broken");
		const preferences = new WorkspacePreferences(root);
		try {
			expect(preferences.getLoadError()).toBeInstanceOf(Error);
			expect(preferences.list()).toEqual([]);
			const workspace = path.join(root, "workspace");
			fs.mkdirSync(workspace);
			expect(() => preferences.upsert({ pathHint: workspace, pinned: true })).not.toThrow();
			expect(preferences.list()).toHaveLength(1);
		} finally {
			preferences.close();
		}
	});

	it("rejects stale mutations after releasing the instance lock", () => {
		const root = temporaryDirectory();
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		const first = new WorkspacePreferences(root);
		const saved = first.upsert({ pathHint: workspace, displayName: "first" });
		first.close();

		const second = new WorkspacePreferences(root);
		try {
			expect(() => first.upsert({ pathHint: workspace, displayName: "stale" })).toThrow("is closed");
			expect(() => first.touch(saved.workspaceHandle, 456)).toThrow("is closed");
			expect(() => first.remove(saved.workspaceHandle)).toThrow("is closed");
			expect(second.get(saved.workspaceHandle)?.displayName).toBe("first");
		} finally {
			second.close();
		}
	});
});
