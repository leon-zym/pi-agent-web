import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectData } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiProcess } from "../src/pi-process.js";

const fakePiPath = path.join(import.meta.dirname, "fixtures", "fake-pi.mjs");
const processGroupPiPath = path.join(import.meta.dirname, "fixtures", "process-group-pi.mjs");
const longLinePiPath = path.join(import.meta.dirname, "fixtures", "long-line-pi.mjs");

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition did not settle before timeout");
}

describe("PiProcess response correlation", () => {
	let proc: PiProcess | undefined;
	let descendantPid: number | undefined;
	let tempDir: string | undefined;

	afterEach(async () => {
		await proc?.stop();
		proc = undefined;
		const cleanupPid = descendantPid;
		descendantPid = undefined;
		if (cleanupPid !== undefined) {
			try {
				process.kill(cleanupPid, "SIGKILL");
			} catch {
				// The process wrapper already reaped the descendant.
			}
		}
		const cleanupDir = tempDir;
		tempDir = undefined;
		if (cleanupDir !== undefined) await rm(cleanupDir, { recursive: true, force: true });
	});

	it("drops a response without id and settles the caller through its timeout", async () => {
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			commandTimeoutMs: 50,
		});
		await proc.start();

		await expect(proc.send({ id: "missing-id", type: "get_last_assistant_text" }, 50)).rejects.toThrow(
			"command timed out",
		);
	});

	it("rejects duplicate process-local pending ids instead of overwriting the first request", async () => {
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
		});
		await proc.start();

		const first = proc.send({ id: "same-id", type: "get_last_assistant_text" }, 100);
		await expect(proc.send({ id: "same-id", type: "get_last_assistant_text" }, 100)).rejects.toThrow(
			"duplicate pending command id",
		);
		await expect(first).rejects.toThrow("command timed out");
	});

	it("isolates a malformed typed event as a child protocol failure", async () => {
		const exits: Array<{ stderrTail: string }> = [];
		const events: string[] = [];
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			onEvent: (event) => events.push(event.type),
			onExit: (info) => exits.push(info),
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "malformed-event" })).rejects.toThrow(
			"invalid Pi event frame",
		);
		await waitFor(() => exits.length === 1);
		expect(exits[0]?.stderrTail).toContain("invalid Pi event frame");
		expect(events).toEqual([]);
		expect(proc.running).toBe(false);
	});

	it("reports a spawn error exactly once without an unhandled rejection", async () => {
		const exits: Array<{ code: number | null }> = [];
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			proc = new PiProcess({
				cwd: process.cwd(),
				resolved: {
					command: path.join(tmpdir(), `pi-web-missing-${String(process.pid)}`),
					args: [],
					source: "pi-path",
					label: "missing Pi",
				},
				onExit: (info) => exits.push(info),
			});

			await expect(proc.start()).rejects.toThrow("failed to start pi process");
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			expect(exits).toHaveLength(1);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("appends a session target without mutating the resolved runtime arguments", async () => {
		const resolved = {
			command: process.execPath,
			args: [fakePiPath, "--mode", "rpc"],
			source: "pi-path" as const,
			label: "fake Pi",
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved,
			args: ["--session", "/tmp/native.jsonl"],
		});
		await proc.start();

		const state = expectData(await proc.send({ type: "get_state" })) as { argv: string[] };
		expect(state.argv).toEqual(["--mode", "rpc", "--session", "/tmp/native.jsonl"]);
		expect(resolved.args).toEqual([fakePiPath, "--mode", "rpc"]);
	});

	it.runIf(process.platform !== "win32")("stops descendants in Pi's detached process group", async () => {
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: {
				command: process.execPath,
				args: [processGroupPiPath],
				source: "pi-path",
				label: "group Pi",
			},
		});
		await proc.start();
		const state = expectData(await proc.send({ type: "get_state" })) as { descendantPid: number };
		descendantPid = state.descendantPid;

		await proc.stop();
		expect(() => process.kill(state.descendantPid, 0)).toThrow();
	});

	it.runIf(process.platform !== "win32")(
		"cleans the detached process group before reporting an unexpected leader exit",
		async () => {
			tempDir = await mkdtemp(path.join(tmpdir(), "pi-web-process-group-"));
			const marker = path.join(tempDir, "descendant-survived");
			const unhandledRejections: unknown[] = [];
			const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
			process.on("unhandledRejection", onUnhandledRejection);

			try {
				let resolveExit: ((info: { code: number | null }) => void) | undefined;
				const exited = new Promise<{ code: number | null }>((resolve) => {
					resolveExit = resolve;
				});
				proc = new PiProcess({
					cwd: process.cwd(),
					resolved: {
						command: process.execPath,
						args: [processGroupPiPath],
						source: "pi-path",
						label: "group Pi",
					},
					env: { PI_WEB_PROCESS_GROUP_EXIT_MARKER: marker },
					onExit: (info) => resolveExit?.(info),
				});
				await proc.start();
				const state = expectData(await proc.send({ type: "get_state" })) as {
					descendantPid: number;
				};
				descendantPid = state.descendantPid;

				await proc.send({ type: "get_last_assistant_text" });
				expect((await exited).code).toBe(23);
				expect(() => process.kill(state.descendantPid, 0)).toThrow();
				await new Promise<void>((resolve) => setTimeout(resolve, 450));

				expect(existsSync(marker)).toBe(false);
				expect(unhandledRejections).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandledRejection);
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"does not signal a saved process group after its leader PID is reused",
		async () => {
			tempDir = await mkdtemp(path.join(tmpdir(), "pi-web-process-group-reuse-"));
			const marker = path.join(tempDir, "descendant-survived");
			let resolveExit: (() => void) | undefined;
			const exited = new Promise<void>((resolve) => {
				resolveExit = resolve;
			});
			proc = new PiProcess({
				cwd: process.cwd(),
				resolved: {
					command: process.execPath,
					args: [processGroupPiPath],
					source: "pi-path",
					label: "group Pi",
				},
				env: { PI_WEB_PROCESS_GROUP_EXIT_MARKER: marker },
				onExit: () => resolveExit?.(),
			});
			await proc.start();
			const state = expectData(await proc.send({ type: "get_state" })) as {
				leaderPid: number;
				descendantPid: number;
			};
			descendantPid = state.descendantPid;

			const realKill = process.kill.bind(process);
			const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
				if (pid === state.leaderPid && signal === 0) return true;
				return realKill(pid, signal);
			});
			try {
				await proc.send({ type: "get_last_assistant_text" });
				await exited;
				expect(
					killSpy.mock.calls.some(
						([pid, signal]) => pid === -state.leaderPid && (signal === "SIGTERM" || signal === "SIGKILL"),
					),
				).toBe(false);
			} finally {
				killSpy.mockRestore();
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"keeps a restart barrier while unexpected process-group cleanup is in flight",
		async () => {
			tempDir = await mkdtemp(path.join(tmpdir(), "pi-web-process-group-barrier-"));
			const marker = path.join(tempDir, "descendant-survived");
			let resolveExit: (() => void) | undefined;
			const exited = new Promise<void>((resolve) => {
				resolveExit = resolve;
			});
			proc = new PiProcess({
				cwd: process.cwd(),
				resolved: {
					command: process.execPath,
					args: [processGroupPiPath],
					source: "pi-path",
					label: "group Pi",
				},
				env: {
					PI_WEB_PROCESS_GROUP_EXIT_MARKER: marker,
					PI_WEB_PROCESS_GROUP_IGNORE_TERM: "1",
				},
				onExit: () => resolveExit?.(),
			});
			await proc.start();
			const state = expectData(await proc.send({ type: "get_state" })) as {
				descendantPid: number;
			};
			descendantPid = state.descendantPid;

			await proc.send({ type: "get_last_assistant_text" });
			await waitFor(() => existsSync(`${marker}.leader`));
			let rejectedWhileFinalizing = false;
			const deadline = Date.now() + 200;
			while (!rejectedWhileFinalizing && Date.now() < deadline) {
				try {
					await proc.send({ type: "get_state" }, 20);
				} catch {
					rejectedWhileFinalizing = true;
				}
			}

			expect(rejectedWhileFinalizing).toBe(true);
			expect(proc.running).toBe(true);
			await exited;
			expect(proc.running).toBe(false);
			expect(() => process.kill(state.descendantPid, 0)).toThrow();
		},
	);

	it.runIf(process.platform !== "win32")(
		"cleans descendants before reporting a fatal JSONL protocol failure",
		async () => {
			tempDir = await mkdtemp(path.join(tmpdir(), "pi-web-process-group-protocol-"));
			const marker = path.join(tempDir, "descendant-survived");
			let initialState: { descendantPid: number } | undefined;
			let resolveExit:
				| ((info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void)
				| undefined;
			const exited = new Promise<{
				code: number | null;
				signal: NodeJS.Signals | null;
				stderrTail: string;
			}>((resolve) => {
				resolveExit = resolve;
			});
			proc = new PiProcess({
				cwd: process.cwd(),
				resolved: {
					command: process.execPath,
					args: [processGroupPiPath],
					source: "pi-path",
					label: "group Pi",
				},
				env: {
					PI_WEB_PROCESS_GROUP_EXIT_MARKER: marker,
					PI_WEB_PROCESS_GROUP_PROTOCOL_FAILURE: "1",
				},
				onReady: (state) => {
					initialState = state as unknown as typeof initialState;
				},
				onExit: (info) => resolveExit?.(info),
			});
			await proc.start();
			expect(initialState).toBeDefined();
			descendantPid = initialState?.descendantPid;

			const info = await exited;
			expect(info.stderrTail).toContain("JSONL line exceeds");
			expect(proc.running).toBe(false);
			expect(() => process.kill(initialState!.descendantPid, 0)).toThrow();
			await new Promise<void>((resolve) => setTimeout(resolve, 350));
			expect(existsSync(marker)).toBe(false);
		},
	);

	it("terminates a process that emits an oversized JSONL line", async () => {
		const failures: string[] = [];
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: {
				command: process.execPath,
				args: [longLinePiPath],
				source: "pi-path",
				label: "long line Pi",
			},
			onExit: (info) => failures.push(info.stderrTail),
		});
		await proc.start();
		await waitFor(() => failures.length === 1);
		await waitFor(() => !proc?.running);
		expect(failures[0]).toContain("JSONL line exceeds");
	});

	it("accepts a bounded get_messages snapshot above the ordinary JSONL line budget", async () => {
		const snapshotBytes = 8 * 1024 * 1024 + 1_024;
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			env: { PI_WEB_FAKE_SNAPSHOT_BYTES: String(snapshotBytes) },
		});
		await proc.start();

		const data = expectData(await proc.send({ type: "get_messages" }, 5_000)) as {
			messages: Array<{ content: Array<{ text: string }> }>;
		};
		expect(data.messages[0]?.content[0]?.text).toHaveLength(snapshotBytes);
		expect(proc.running).toBe(true);
	});

	it("terminates a get_messages response that exceeds its explicit snapshot budget", async () => {
		const failures: string[] = [];
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			env: { PI_WEB_FAKE_SNAPSHOT_BYTES: "2048" },
			snapshotLineMaxBytes: 1_024,
			onExit: (info) => failures.push(info.stderrTail),
		});
		await proc.start();

		await expect(proc.send({ type: "get_messages" }, 1_000)).rejects.toThrow(
			"JSONL line exceeds the 1024 byte limit",
		);
		await waitFor(() => failures.length === 1);
		expect(proc.running).toBe(false);
	});
});
