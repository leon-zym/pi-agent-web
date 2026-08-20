import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizePathAllowMissing, SessionLayoutResolver } from "../src/session-layout-resolver.js";

const temporaryRoots: string[] = [];

function temporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-layout-"));
	temporaryRoots.push(directory);
	return directory;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SessionLayoutResolver", () => {
	it("normalizes relative Pi environment overrides for each child workspace", () => {
		const root = temporaryDirectory();
		const workspaceA = path.join(root, "workspace-a");
		const workspaceB = path.join(root, "workspace-b");
		const resolver = new SessionLayoutResolver({
			env: {
				PI_CODING_AGENT_DIR: "relative-agent",
				PI_CODING_AGENT_SESSION_DIR: "relative-sessions",
			},
			runtimeCwd: path.join(root, "gateway"),
		});

		expect(resolver.resolveForWorkspace(workspaceA).sessionDir).toBe(
			path.join(workspaceA, "relative-sessions"),
		);
		expect(resolver.resolveForWorkspace(workspaceB).sessionDir).toBe(
			path.join(workspaceB, "relative-sessions"),
		);
		expect(resolver.normalizedChildEnvForWorkspace(workspaceA)).toEqual({
			PI_CODING_AGENT_DIR: path.join(workspaceA, "relative-agent"),
			PI_CODING_AGENT_SESSION_DIR: path.join(workspaceA, "relative-sessions"),
		});
		expect(resolver.normalizedChildEnvForWorkspace(workspaceB)).toEqual({
			PI_CODING_AGENT_DIR: path.join(workspaceB, "relative-agent"),
			PI_CODING_AGENT_SESSION_DIR: path.join(workspaceB, "relative-sessions"),
		});
	});

	it("discovers relative environment directories once per known workspace", () => {
		const root = temporaryDirectory();
		const workspaceA = path.join(root, "workspace-a");
		const workspaceB = path.join(root, "workspace-b");
		const resolver = new SessionLayoutResolver({
			agentDir: path.join(root, "agent"),
			env: { PI_CODING_AGENT_SESSION_DIR: "relative-sessions" },
			runtimeCwd: path.join(root, "gateway"),
		});

		const environmentSources = resolver
			.discoveryPlan([workspaceA, workspaceB])
			.sources.filter((source) => source.reason === "environment");
		expect(environmentSources).toEqual([
			{
				mode: "direct",
				path: path.join(workspaceA, "relative-sessions"),
				reason: "environment",
				workspacePath: workspaceA,
			},
			{
				mode: "direct",
				path: path.join(workspaceB, "relative-sessions"),
				reason: "environment",
				workspacePath: workspaceB,
			},
		]);
	});

	it("deduplicates workspace-relative sources that converge on one physical directory", () => {
		const root = temporaryDirectory();
		const workspaceA = path.join(root, "workspace-a");
		const workspaceB = path.join(root, "workspace-b");
		const resolver = new SessionLayoutResolver({
			agentDir: path.join(root, "agent"),
			env: { PI_CODING_AGENT_SESSION_DIR: ".." },
			runtimeCwd: path.join(root, "gateway"),
		});

		const environmentSources = resolver
			.discoveryPlan([workspaceA, workspaceB])
			.sources.filter((source) => source.reason === "environment");
		expect(environmentSources).toHaveLength(1);
		expect(environmentSources[0]).toMatchObject({ mode: "direct", path: root, reason: "environment" });
	});

	it("matches Pi's encoded default layout", () => {
		const root = temporaryDirectory();
		const agentDir = path.join(root, "agent");
		const workspace = path.join(root, "projects", "with:colon");
		const resolver = new SessionLayoutResolver({ agentDir, env: {}, runtimeCwd: root });
		const expectedName = `--${path
			.resolve(workspace)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`;

		expect(resolver.resolveForWorkspace(workspace)).toMatchObject({
			workspacePath: path.resolve(workspace),
			sessionDir: path.join(agentDir, "sessions", expectedName),
			source: "default",
		});
	});

	it("uses the environment custom directory directly with highest runtime precedence", () => {
		const root = temporaryDirectory();
		const agentDir = path.join(root, "agent");
		const workspace = path.join(root, "workspace");
		const envDir = path.join(root, "env-sessions");
		const globalDir = path.join(root, "global-sessions");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: globalDir }));
		const resolver = new SessionLayoutResolver({
			agentDir,
			env: { PI_CODING_AGENT_SESSION_DIR: envDir },
			runtimeCwd: root,
		});

		expect(resolver.resolveForWorkspace(workspace)).toMatchObject({
			sessionDir: envDir,
			source: "environment",
		});
		const plan = resolver.discoveryPlan([workspace]);
		expect(plan.sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ mode: "nested-default-root", reason: "default" }),
				expect.objectContaining({ mode: "direct", path: envDir, reason: "environment" }),
				expect.objectContaining({ mode: "direct", path: globalDir, reason: "global-settings" }),
			]),
		);
	});

	it("uses merged global and known-project settings without appending an encoded cwd", () => {
		const root = temporaryDirectory();
		const agentDir = path.join(root, "agent");
		const workspace = path.join(root, "workspace");
		const globalDir = path.join(root, "global-sessions");
		const projectDir = path.join(root, "project-sessions");
		fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: globalDir }));
		fs.writeFileSync(
			path.join(workspace, ".pi", "settings.json"),
			JSON.stringify({ sessionDir: projectDir }),
		);
		const resolver = new SessionLayoutResolver({ agentDir, env: {}, runtimeCwd: root });

		expect(resolver.resolveForWorkspace(workspace)).toMatchObject({
			sessionDir: projectDir,
			source: "project-settings",
		});
		expect(resolver.discoveryPlan([workspace]).sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ mode: "direct", path: globalDir, reason: "global-settings" }),
				expect.objectContaining({
					mode: "direct",
					path: projectDir,
					reason: "project-settings",
					workspacePath: workspace,
				}),
			]),
		);
	});

	it("resolves relative global and project session directories from each workspace", () => {
		const root = temporaryDirectory();
		const agentDir = path.join(root, "agent");
		const workspaceA = path.join(root, "workspace-a");
		const workspaceB = path.join(root, "workspace-b");
		fs.mkdirSync(path.join(workspaceB, ".pi"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "history" }));
		fs.writeFileSync(
			path.join(workspaceB, ".pi", "settings.json"),
			JSON.stringify({ sessionDir: "project-history" }),
		);
		const resolver = new SessionLayoutResolver({
			agentDir,
			env: {},
			runtimeCwd: path.join(root, "gateway"),
		});

		expect(resolver.resolveForWorkspace(workspaceA)).toMatchObject({
			sessionDir: path.join(workspaceA, "history"),
			source: "global-settings",
		});
		expect(resolver.resolveForWorkspace(workspaceB)).toMatchObject({
			sessionDir: path.join(workspaceB, "project-history"),
			source: "project-settings",
		});

		const sources = resolver.discoveryPlan([workspaceA, workspaceB]).sources;
		expect(sources).toEqual(
			expect.arrayContaining([
				{
					mode: "direct",
					path: path.join(workspaceA, "history"),
					reason: "global-settings",
					workspacePath: workspaceA,
				},
				{
					mode: "direct",
					path: path.join(workspaceB, "history"),
					reason: "global-settings",
					workspacePath: workspaceB,
				},
				{
					mode: "direct",
					path: path.join(workspaceB, "project-history"),
					reason: "project-settings",
					workspacePath: workspaceB,
				},
			]),
		);
	});

	it("uses workspace-relative agent directories consistently for settings and defaults", () => {
		const root = temporaryDirectory();
		const workspaceA = path.join(root, "workspace-a");
		const workspaceB = path.join(root, "workspace-b");
		for (const workspace of [workspaceA, workspaceB]) {
			fs.mkdirSync(path.join(workspace, "relative-agent"), { recursive: true });
			fs.writeFileSync(
				path.join(workspace, "relative-agent", "settings.json"),
				JSON.stringify({ sessionDir: "history" }),
			);
		}
		const resolver = new SessionLayoutResolver({
			env: { PI_CODING_AGENT_DIR: "relative-agent" },
			runtimeCwd: path.join(root, "gateway"),
		});

		expect(resolver.resolveForWorkspace(workspaceA).sessionDir).toBe(path.join(workspaceA, "history"));
		expect(resolver.resolveForWorkspace(workspaceB).sessionDir).toBe(path.join(workspaceB, "history"));
		const plan = resolver.discoveryPlan([workspaceA, workspaceB]);
		expect(plan.sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					mode: "nested-default-root",
					path: path.join(workspaceA, "relative-agent", "sessions"),
				}),
				expect.objectContaining({
					mode: "nested-default-root",
					path: path.join(workspaceB, "relative-agent", "sessions"),
				}),
				expect.objectContaining({
					mode: "direct",
					path: path.join(workspaceA, "history"),
					reason: "global-settings",
				}),
				expect.objectContaining({
					mode: "direct",
					path: path.join(workspaceB, "history"),
					reason: "global-settings",
				}),
			]),
		);
	});

	it("does not invent gateway-relative discovery paths without a known workspace", () => {
		const root = temporaryDirectory();
		const absoluteAgentDir = path.join(root, "absolute-agent");
		fs.mkdirSync(absoluteAgentDir, { recursive: true });
		fs.writeFileSync(
			path.join(absoluteAgentDir, "settings.json"),
			JSON.stringify({ sessionDir: "global-history" }),
		);
		const resolver = new SessionLayoutResolver({
			agentDir: absoluteAgentDir,
			env: { PI_CODING_AGENT_SESSION_DIR: "environment-history" },
			runtimeCwd: path.join(root, "gateway"),
		});

		const plan = resolver.discoveryPlan();
		expect(plan.sources.filter((source) => source.mode === "direct")).toEqual([]);
		expect(plan.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("PI_CODING_AGENT_SESSION_DIR"),
				expect.stringContaining("global sessionDir"),
			]),
		);
		expect(plan.sources.some((source) => source.path.includes("gateway"))).toBe(false);
	});

	it("does not invent a gateway-relative agent directory without a known workspace", () => {
		const root = temporaryDirectory();
		const resolver = new SessionLayoutResolver({
			env: { PI_CODING_AGENT_DIR: "relative-agent" },
			runtimeCwd: path.join(root, "gateway"),
		});

		const plan = resolver.discoveryPlan();
		expect(plan.sources).toEqual([]);
		expect(plan.diagnostics).toEqual([
			expect.objectContaining({ message: expect.stringContaining("PI_CODING_AGENT_DIR") }),
		]);
	});

	it("canonicalizes a missing leaf through the nearest real ancestor", () => {
		const root = temporaryDirectory();
		const realParent = path.join(root, "real-parent");
		const linkedParent = path.join(root, "linked-parent");
		fs.mkdirSync(realParent);
		fs.symlinkSync(realParent, linkedParent, "dir");

		expect(canonicalizePathAllowMissing(path.join(linkedParent, "future", "session.jsonl"))).toBe(
			path.join(fs.realpathSync(realParent), "future", "session.jsonl"),
		);
	});
});
