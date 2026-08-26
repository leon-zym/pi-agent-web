import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectData } from "@pi-agent-web/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiProcess } from "../src/pi-process";
import { resolvePiRuntime } from "../src/resolver";
import { SessionLayoutResolver } from "../src/session-layout-resolver";

/**
 * Transport compatibility against the installed Pi runtime. Uses a temporary
 * session directory via PI_CODING_AGENT_SESSION_DIR so the user's real
 * sessions are never touched.
 */

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-e2e-"));
const workspaceDir = path.join(tempRoot, "workspace");
const sessionRoot = path.join(tempRoot, "sessions");
fs.mkdirSync(workspaceDir, { recursive: true });
fs.mkdirSync(sessionRoot, { recursive: true });

// Pre-seed a session file belonging to this workspace (header + two messages).
const seededDir = new SessionLayoutResolver({
	env: { PI_CODING_AGENT_SESSION_DIR: sessionRoot },
	runtimeCwd: workspaceDir,
}).resolveForWorkspace(workspaceDir).sessionDir;
fs.mkdirSync(seededDir, { recursive: true });
const seededPath = path.join(seededDir, "2026-01-01T00-00-00-000Z_seeded.jsonl");
fs.writeFileSync(
	seededPath,
	[
		JSON.stringify({
			type: "session",
			version: 3,
			id: "seeded-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: workspaceDir,
		}),
		JSON.stringify({
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "ping" }], timestamp: 0 },
		}),
		JSON.stringify({
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "pong" }],
				api: "openai-completions",
				provider: "deepseek",
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
				timestamp: 0,
			},
		}),
	]
		.map((l) => `${l}\n`)
		.join(""),
);

describe("pi process integration (real runtime)", () => {
	let proc: PiProcess;

	beforeAll(async () => {
		const resolved = await resolvePiRuntime({ baseDir: process.cwd() });
		console.log("integration test uses runtime:", resolved.label);
		proc = new PiProcess({
			cwd: workspaceDir,
			resolved,
			readyTimeoutMs: 30_000,
			env: {
				PI_CODING_AGENT_SESSION_DIR: sessionRoot,
			},
		});
		await proc.start();
	}, 40_000);

	afterAll(async () => {
		await proc?.stop();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("ready handshake yields a get_state response", async () => {
		const response = await proc.send({ type: "get_state" });
		expect(response.type).toBe("response");
		expect(response.success).toBe(true);
		const state = expectData(response) as { sessionId: string; sessionFile?: string };
		expect(typeof state.sessionId).toBe("string");
	});

	it("get_commands returns the wrapped {commands} shape", async () => {
		const response = await proc.send({ type: "get_commands" });
		expect(response.success).toBe(true);
		const data = expectData(response) as { commands: unknown[] };
		expect(Array.isArray(data.commands)).toBe(true);
		for (const command of data.commands.slice(0, 5)) {
			const c = command as { name?: string; source?: string };
			expect(typeof c.name).toBe("string");
			expect(["extension", "prompt", "skill"]).toContain(c.source);
		}
	});

	it("switch_session loads a session file of the same workspace", async () => {
		const response = await proc.send({ type: "switch_session", sessionPath: seededPath });
		expect(response.success).toBe(true);
		const data = expectData(response) as { cancelled: boolean };
		expect(data.cancelled).toBe(false);

		const stateResponse = await proc.send({ type: "get_state" });
		const state = expectData(stateResponse) as { sessionId: string; sessionFile?: string };
		expect(state.sessionId).toBe("seeded-session");
	});

	it("get_entries returns the seeded tree with a consistent leafId", async () => {
		const response = await proc.send({ type: "get_entries" });
		expect(response.success).toBe(true);
		const data = expectData(response) as { entries: Array<{ id: string }>; leafId: string | null };
		expect(data.entries.length).toBeGreaterThanOrEqual(2);
		// pi appends model/thinking entries when loading a bare session, so the
		// leaf moves past the seeded entries. Invariant: leafId is the last entry.
		expect(data.leafId).toBe(data.entries[data.entries.length - 1]?.id ?? null);
		expect(data.entries.map((e) => e.id)).toContain("e1");
		expect(data.entries.map((e) => e.id)).toContain("e2");
	});

	it("get_messages returns the active-branch messages", async () => {
		const response = await proc.send({ type: "get_messages" });
		const data = expectData(response) as { messages: Array<{ role: string }> };
		expect(data.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("bash with id returns a result carrying the output", async () => {
		// bash_execution_update streaming is verified in the UI e2e stage.
		const response = await proc.send({ type: "bash", command: "echo hi", id: "bash-test-1" }, 60_000);
		expect(response.success).toBe(true);
		const data = expectData(response) as { output: string; exitCode: number | null };
		expect(data.output).toContain("hi");
	}, 70_000);

	it("set_session_name writes a session_info entry", async () => {
		const response = await proc.send({ type: "set_session_name", name: "Integration Session" });
		expect(response.success).toBe(true);
	});

	it("fails closed when Pi answers an out-of-contract command discriminant", async () => {
		await expect(proc.send({ type: "bogus_command" as never })).rejects.toMatchObject({
			name: "PiProtocolIncompatibleError",
			diagnostic: expect.objectContaining({
				code: "protocol_incompatible",
				reason: "malformed_response",
			}),
		});
	});
});
