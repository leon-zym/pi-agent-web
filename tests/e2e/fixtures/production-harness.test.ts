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
	seedHistoricalSession,
	startProductionHarness,
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
		ownedGatewayCount: 2,
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

test("keeps a stable origin while restarting the owned Gateway", async () => {
	const harness = await startProductionHarness();
	try {
		const origin = harness.origin;
		await harness.restart();
		assert.equal(harness.origin, origin);
		assert.equal(harness.lifecycle().activeGatewayCount, 1);
	} finally {
		await harness.stop();
	}
});

test("serializes concurrent restart and stop operations over owned children", async () => {
	const harness = await startProductionHarness();
	try {
		await Promise.all([harness.restart(), harness.restart()]);
		const lifecycle = harness.lifecycle();
		assert.equal(lifecycle.gatewayStarts, 3);
		assert.equal(lifecycle.ownedGatewayCount, lifecycle.gatewayStarts);
		assert.equal(lifecycle.activeGatewayCount, 1);
		await Promise.all([harness.restart(), harness.stop()]);
		assert.equal(harness.lifecycle().activeGatewayCount, 0);
		assert.equal(harness.lifecycle().rootExists, false);
	} finally {
		await harness.stop();
	}
});

for (const [turns, bytes] of [
	[1000, 4 * 1024 ** 2],
	[5000, 16 * 1024 ** 2],
] as const)
	test(`mixed history independently bounds ${turns} turns and ${bytes} bytes`, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-history-recipe-"));
		try {
			const seed = {
				userText: "E2E_MIXED_HISTORY",
				assistantText: "E2E_MIXED_REPLY",
				turnCount: turns,
				targetSourceBytes: bytes,
				mixedHistory: true,
			};
			const { sessionFile } = seedHistoricalSession(root, root, seed);
			const raw = fs.readFileSync(sessionFile);
			assert.equal(raw.length, bytes);
			const entries = raw
				.toString()
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.equal(entries.length, (turns * 12) / 5 + 1);
			const messages = entries.slice(1);
			assert.equal(messages.filter((e) => e.message.role === "user").length, turns);
			assert.equal(messages.filter((e) => e.message.role === "toolResult").length, turns / 5);
			assert.equal(new Set(messages.map((e) => e.id)).size, messages.length);
			for (const [i, entry] of messages.entries())
				assert.equal(entry.parentId, i === 0 ? null : messages[i - 1].id);
			const content = messages.flatMap((e) => e.message.content);
			assert.equal(content.filter((c) => c.type === "thinking").length, turns / 5);
			assert.equal(content.filter((c) => c.type === "toolCall").length, turns / 5);
			for (const size of [10240, 65536, 122880, 1048576]) {
				const matches = content.filter((c) => c.text?.includes(`# Mixed Markdown ${size}\n`));
				assert.equal(matches.length, 1);
				assert.ok(Buffer.byteLength(matches[0].text) >= size);
			}
			assert.equal(content.filter((c) => c.text?.includes("```ts")).length, turns / 5);
			assert.equal(content.filter((c) => c.text?.includes("| key | value |")).length, turns / 5);
			const hash = sha256(raw);
			seedHistoricalSession(root, root, seed);
			assert.equal(sha256(fs.readFileSync(sessionFile)), hash);
			assert.throws(
				() => seedHistoricalSession(root, root, { ...seed, targetSourceBytes: bytes + 1 }),
				/requires/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
