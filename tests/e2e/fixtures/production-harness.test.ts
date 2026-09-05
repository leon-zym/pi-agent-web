import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	assertPreservedHarnessIdentity,
	benchmarkBuildPathsFromEnvironment,
	type HarnessSession,
	type HarnessWorkspace,
	isBoundedHarnessLifecycle,
	MAX_HARNESS_ROOT_ENTRIES,
} from "./production-harness";

const buildEnvironmentKeys = [
	"PI_WEB_BENCHMARK_VARIANT_BUILD_DIR",
	"PI_WEB_BENCHMARK_SERVER_ENTRY",
	"PI_WEB_BENCHMARK_STATIC_DIR",
	"PI_WEB_BENCHMARK_SERVER_ENTRY_HASH",
	"PI_WEB_BENCHMARK_SERVER_TREE_HASH",
	"PI_WEB_BENCHMARK_UI_TREE_HASH",
] as const;

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function hashTree(directory: string): string {
	const files: string[] = [];
	const visit = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else if (entry.isFile()) files.push(entryPath);
		}
	};
	visit(directory);
	const hash = createHash("sha256");
	for (const filePath of files.sort((left, right) => left.localeCompare(right))) {
		hash.update(path.relative(directory, filePath).replaceAll(path.sep, "/"));
		hash.update("\0");
		hash.update(sha256(fs.readFileSync(filePath)));
		hash.update("\n");
	}
	return hash.digest("hex");
}

test("accepts only exact run-owned benchmark executables", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-benchmark-build-"));
	const previous = Object.fromEntries(buildEnvironmentKeys.map((key) => [key, process.env[key]]));
	try {
		const serverDirectory = path.join(root, "server");
		const staticDirectory = path.join(root, "ui");
		fs.mkdirSync(serverDirectory, { recursive: true });
		fs.mkdirSync(staticDirectory, { recursive: true });
		const serverEntry = path.join(serverDirectory, "benchmark-main.js");
		fs.writeFileSync(serverEntry, "export {};\n", "utf8");
		fs.writeFileSync(path.join(staticDirectory, "index.html"), "<main>benchmark</main>\n", "utf8");
		Object.assign(process.env, {
			PI_WEB_BENCHMARK_VARIANT_BUILD_DIR: root,
			PI_WEB_BENCHMARK_SERVER_ENTRY: serverEntry,
			PI_WEB_BENCHMARK_STATIC_DIR: staticDirectory,
			PI_WEB_BENCHMARK_SERVER_ENTRY_HASH: sha256(fs.readFileSync(serverEntry)),
			PI_WEB_BENCHMARK_SERVER_TREE_HASH: hashTree(serverDirectory),
			PI_WEB_BENCHMARK_UI_TREE_HASH: hashTree(staticDirectory),
		});

		const resolved = benchmarkBuildPathsFromEnvironment();
		assert.equal(resolved.buildRoot, fs.realpathSync(root));
		assert.equal(resolved.serverEntry, fs.realpathSync(serverEntry));
		assert.equal(resolved.staticDir, fs.realpathSync(staticDirectory));

		process.env.PI_WEB_BENCHMARK_UI_TREE_HASH = "0".repeat(64);
		assert.throws(() => benchmarkBuildPathsFromEnvironment(), /run manifest; refusing stale or mixed output/);
	} finally {
		for (const key of buildEnvironmentKeys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("keeps restart identity and lifecycle cleanup checks deterministic", () => {
	const workspace: HarnessWorkspace = { workspaceHandle: "workspace-1", path: "/tmp/piweb/workspace" };
	const session: HarnessSession = {
		sessionHandle: "session-1",
		workspaceHandle: workspace.workspaceHandle,
		nativeSessionId: "native-1",
		sessionFile: "/tmp/piweb/sessions/native-1.jsonl",
		persisted: true,
		firstMessage: "before",
		messageCount: 2,
	};
	assert.doesNotThrow(() => assertPreservedHarnessIdentity(workspace, session, [workspace], [session]));
	assert.throws(
		() =>
			assertPreservedHarnessIdentity(
				workspace,
				session,
				[{ ...workspace, path: "/tmp/piweb/other-workspace" }],
				[session],
			),
		/Workspace root/,
	);
	assert.throws(
		() =>
			assertPreservedHarnessIdentity(
				workspace,
				session,
				[workspace],
				[{ ...session, nativeSessionId: "native-other" }],
			),
		/Session identity/,
	);

	const healthy = {
		gatewayStarts: 2,
		activeGatewayCount: 1,
		activeGatewayPid: 123,
		rootExists: true,
		rootEntryCount: MAX_HARNESS_ROOT_ENTRIES,
	};
	assert.equal(isBoundedHarnessLifecycle(healthy), true);
	assert.equal(isBoundedHarnessLifecycle({ ...healthy, activeGatewayCount: 2 }), false);
	assert.equal(
		isBoundedHarnessLifecycle({ ...healthy, rootEntryCount: MAX_HARNESS_ROOT_ENTRIES + 1 }),
		false,
	);
	assert.equal(isBoundedHarnessLifecycle({ ...healthy, rootExists: false }), false);
});
