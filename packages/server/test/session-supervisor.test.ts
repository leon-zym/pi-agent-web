import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeSessionFile, sessionHandleForFile } from "../src/native-session-catalog.js";
import type { SessionRuntime } from "../src/session-runtime.js";
import type { ExistingSessionTarget, SessionSupervisorMessage } from "../src/session-runtime-types.js";
import { SessionSupervisor } from "../src/session-supervisor.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");
const temporaryRoots: string[] = [];
const supervisors: SessionSupervisor[] = [];

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-session-supervisor-"));
	temporaryRoots.push(root);
	return root;
}

function createNativeSession(root: string, cwd: string, nativeSessionId: string): ExistingSessionTarget {
	const sessionDir = path.join(root, "sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, `2026-08-20T00-00-00-000Z_${nativeSessionId}.jsonl`);
	fs.writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: nativeSessionId,
			timestamp: "2026-08-20T00:00:00.000Z",
			cwd,
		})}\n`,
	);
	return {
		kind: "existing",
		sessionHandle: sessionHandleForFile(sessionFile),
		workspaceId: `workspace-${path.basename(cwd)}`,
		cwd,
		sessionFile: canonicalizeSessionFile(sessionFile),
		nativeSessionId,
	};
}

function createHarness(options: {
	targets: ExistingSessionTarget[];
	maxHotRuntimes?: number;
	replayLimit?: number;
	replayMaxBytes?: number;
	transientBufferMaxBytes?: number;
	extensionStateMaxBytes?: number;
	extensionStateMaxItems?: number;
	pendingDialogLimit?: number;
	restartBaseDelayMs?: number;
	maxAutoRestarts?: number;
	env?: Record<string, string>;
	commandTimeoutFor?: (commandType: string) => number;
}) {
	const messages: SessionSupervisorMessage[] = [];
	const targets = new Map(options.targets.map((target) => [target.sessionHandle, target]));
	const supervisor = new SessionSupervisor({
		resolved: {
			command: process.execPath,
			args: [fixturePath],
			source: "pi-path",
			label: "session runtime fixture",
		},
		env: options.env,
		resolveSession: async (sessionHandle) => targets.get(sessionHandle),
		broadcast: (message) => messages.push(message),
		maxHotRuntimes: options.maxHotRuntimes ?? 8,
		replayLimit: options.replayLimit ?? 32,
		replayMaxBytes: options.replayMaxBytes,
		transientBufferMaxBytes: options.transientBufferMaxBytes,
		extensionStateMaxBytes: options.extensionStateMaxBytes,
		extensionStateMaxItems: options.extensionStateMaxItems,
		pendingDialogLimit: options.pendingDialogLimit,
		commandTimeoutFor: options.commandTimeoutFor,
		restartBaseDelayMs: options.restartBaseDelayMs ?? 5,
		maxAutoRestarts: options.maxAutoRestarts,
		readyTimeoutMs: 2_000,
		idleTtlMs: 60_000,
	});
	supervisors.push(supervisor);
	return { supervisor, messages, targets };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition did not settle before timeout");
}

afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SessionSupervisor", () => {
	it("runs two Sessions from the same Workspace concurrently without switching either process", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "first");
		const second = createNativeSession(root, cwd, "second");
		const { supervisor, messages } = createHarness({ targets: [first, second] });

		const firstLease = await supervisor.claim(first.sessionHandle, "connection-a");
		const secondLease = await supervisor.claim(second.sessionHandle, "connection-a");
		const firstRuntime = supervisor.getRuntime(first.sessionHandle)!;
		const secondRuntime = supervisor.getRuntime(second.sessionHandle)!;

		await Promise.all([
			supervisor.sendCommand(
				first.sessionHandle,
				{ type: "prompt", message: "slow" },
				{
					connectionId: "connection-a",
					expectedGeneration: firstRuntime.generation,
					fencingToken: firstLease.fencingToken,
				},
			),
			supervisor.sendCommand(
				second.sessionHandle,
				{ type: "prompt", message: "fast" },
				{
					connectionId: "connection-a",
					expectedGeneration: secondRuntime.generation,
					fencingToken: secondLease.fencingToken,
				},
			),
		]);

		await waitFor(
			() =>
				messages.filter((message) => message.type === "event" && message.event.type === "message_update")
					.length === 2,
		);
		const updateHandles = messages
			.flatMap((message) =>
				message.type === "event" && message.event.type === "message_update" ? [message.sessionHandle] : [],
			)
			.sort();
		expect(updateHandles).toEqual([first.sessionHandle, second.sessionHandle].sort());
		expect(supervisor.listRuntimes().filter((runtime) => runtime.state !== "dormant")).toHaveLength(2);
	});

	it("publishes a settlement event before its derived idle runtime state", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "settlement-order");
		const { supervisor, messages } = createHarness({ targets: [target] });
		const lease = await supervisor.claim(target.sessionHandle, "connection");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		const startIndex = messages.length;

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "fast" },
			{
				connectionId: "connection",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() =>
			messages
				.slice(startIndex)
				.some((message) => message.type === "event" && message.event.type === "agent_settled"),
		);

		const commandMessages = messages.slice(startIndex);
		const settledIndex = commandMessages.findIndex(
			(message) => message.type === "event" && message.event.type === "agent_settled",
		);
		const idleIndex = commandMessages.findIndex(
			(message) => message.type === "runtime_state" && message.runtime.state === "idle",
		);
		expect(settledIndex).toBeGreaterThanOrEqual(0);
		expect(idleIndex).toBeGreaterThan(settledIndex);
	});

	it("fences stale controllers independently per Session", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "lease");
		const { supervisor } = createHarness({ targets: [target] });

		const first = await supervisor.claim(target.sessionHandle, "connection-a");
		expect((await supervisor.claim(target.sessionHandle, "connection-b")).isController).toBe(false);
		expect(supervisor.release(target.sessionHandle, "connection-a")).toBe(true);
		const second = await supervisor.claim(target.sessionHandle, "connection-b");
		expect(second.fencingToken).not.toBe(first.fencingToken);
		const runtime = supervisor.getRuntime(target.sessionHandle)!;

		await expect(
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "set_session_name", name: "stale" },
				{
					connectionId: "connection-a",
					expectedGeneration: runtime.generation,
					fencingToken: first.fencingToken,
				},
			),
		).rejects.toThrow("session_read_only");
	});

	it("returns replay gaps explicitly instead of silently dropping events", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "replay");
		const { supervisor } = createHarness({ targets: [target], replayLimit: 2 });
		const lease = await supervisor.claim(target.sessionHandle, "connection");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "events" },
			{
				connectionId: "connection",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => (supervisor.getRuntime(target.sessionHandle)?.lastSeq ?? 0) >= 4);

		const current = supervisor.getRuntime(target.sessionHandle)!;
		expect(await supervisor.subscribe(target.sessionHandle)).toMatchObject({
			type: "resync_required",
			reason: "initial",
		});
		expect(
			await supervisor.subscribe(target.sessionHandle, { generation: current.generation, seq: 0 }),
		).toMatchObject({ type: "resync_required", reason: "gap" });
		const replay = await supervisor.subscribe(target.sessionHandle, {
			generation: current.generation,
			seq: current.lastSeq - 1,
		});
		expect(replay.type).toBe("replay");
		if (replay.type === "replay") expect(replay.frames).toHaveLength(1);
	});

	it("bounds replay bytes independently across large multi-Session event streams", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "replay-bytes-a");
		const second = createNativeSession(root, cwd, "replay-bytes-b");
		const replayMaxBytes = 1_200;
		const { supervisor } = createHarness({
			targets: [first, second],
			replayLimit: 128,
			replayMaxBytes,
			env: { PI_WEB_FIXTURE_EVENT_BYTES: "400" },
		});

		for (const [index, target] of [first, second].entries()) {
			const connectionId = `replay-bytes-${String(index)}`;
			const lease = await supervisor.claim(target.sessionHandle, connectionId);
			const runtime = supervisor.getRuntime(target.sessionHandle)!;
			await supervisor.sendCommand(
				target.sessionHandle,
				{ type: "prompt", message: "large-events" },
				{
					connectionId,
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
			await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle");
			const current = supervisor.getRuntime(target.sessionHandle)!;
			const expired = await supervisor.subscribe(target.sessionHandle, {
				generation: current.generation,
				seq: 0,
			});
			expect(expired).toMatchObject({ type: "resync_required", reason: "gap" });
			const retained = await supervisor.subscribe(target.sessionHandle, {
				generation: current.generation,
				seq: current.lastSeq - 2,
			});
			if (retained.type !== "replay") throw new Error("recent bounded replay was not retained");
			expect(Buffer.byteLength(JSON.stringify(retained.frames))).toBeLessThanOrEqual(replayMaxBytes);
		}
	});

	it("fails closed when startup buffering exceeds its byte ceiling", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "startup-buffer-limit");
		const { supervisor } = createHarness({
			targets: [target],
			transientBufferMaxBytes: 512,
			maxAutoRestarts: 0,
			env: { PI_WEB_FIXTURE_STARTUP_FRAME_BYTES: "2048" },
		});

		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow(
			"startup_frame_buffer_limit_exceeded",
		);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");
		expect(supervisor.getRuntime(target.sessionHandle)?.recoverable).toBe(true);
	});

	it("fails closed when an identity transition floods its staged frame buffer", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "transition-buffer-limit");
		const { supervisor, messages } = createHarness({
			targets: [parent],
			transientBufferMaxBytes: 512,
			maxAutoRestarts: 0,
			env: { PI_WEB_FIXTURE_TRANSITION_FRAME_BYTES: "2048" },
		});
		const lease = await supervisor.claim(parent.sessionHandle, "transition-buffer-owner");
		const runtime = supervisor.getRuntime(parent.sessionHandle)!;

		await expect(
			supervisor.sendCommand(
				parent.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "transition-buffer-owner",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("transition_frame_buffer_limit_exceeded");
		expect(
			messages.filter(
				(message) =>
					message.type === "extension_ui_request" && message.request.id.startsWith("transition-flood-"),
			),
		).toEqual([]);
		expect(supervisor.getRuntime(parent.sessionHandle)?.state).toBe("dormant");
	});

	it("fails closed when a forked JSONL Header changes before identity commit", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		const otherCwd = path.join(root, "other-workspace");
		fs.mkdirSync(cwd);
		fs.mkdirSync(otherCwd);
		const parent = createNativeSession(root, cwd, "transition-header-parent");
		const { supervisor } = createHarness({
			targets: [parent],
			env: { PI_WEB_FIXTURE_TRANSITION_STATE_DELAY_MS: "250" },
		});
		const lease = await supervisor.claim(parent.sessionHandle, "controller");
		const runtime = supervisor.getRuntime(parent.sessionHandle)!;
		const clone = supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		let childFile = "";
		await waitFor(() => {
			childFile =
				fs
					.readdirSync(path.dirname(parent.sessionFile))
					.map((file) => path.join(path.dirname(parent.sessionFile), file))
					.find((file) => file.includes("transition-header-parent-clone")) ?? "";
			return Boolean(childFile);
		});
		fs.writeFileSync(
			childFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "forged-child",
				timestamp: "2026-08-20T00:00:00.000Z",
				cwd: otherCwd,
			})}\n`,
		);

		await expect(clone).rejects.toThrow("Header");
		expect(supervisor.getRuntime(parent.sessionHandle)).toMatchObject({
			sessionHandle: parent.sessionHandle,
			state: "dormant",
		});
	});

	it("bounds reconnectable sticky extension state and honors semantic clears", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "sticky-state-limit");
		const { supervisor } = createHarness({
			targets: [target],
			extensionStateMaxBytes: 4_096,
			extensionStateMaxItems: 4,
			env: {
				PI_WEB_FIXTURE_STICKY_COUNT: "12",
				PI_WEB_FIXTURE_CLEAR_FIRST_STICKY: "1",
			},
		});

		await supervisor.activate(target.sessionHandle);
		const replay = await supervisor.subscribe(target.sessionHandle);
		expect(replay.extensionRequests).toHaveLength(4);
		expect(
			replay.extensionRequests.map((request) =>
				request.method === "setStatus" ? request.statusKey : request.method,
			),
		).toEqual(["status-8", "status-9", "status-10", "status-11"]);
		expect(Buffer.byteLength(JSON.stringify(replay.extensionRequests))).toBeLessThan(4_096);
	});

	it("fails closed when extensions exceed the pending dialog budget", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "dialog-state-limit");
		const { supervisor } = createHarness({
			targets: [target],
			pendingDialogLimit: 2,
			extensionStateMaxItems: 8,
			env: { PI_WEB_FIXTURE_DIALOG_COUNT: "3" },
			maxAutoRestarts: 0,
		});

		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow(
			"pending_dialog_state_limit_exceeded",
		);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");
		expect(supervisor.getPendingExtensionRequests(target.sessionHandle)).toEqual([]);
	});

	it("restarts a crashed persisted Session from the same native file", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "crash");
		const marker = path.join(root, "crash-marker");
		const { supervisor } = createHarness({
			targets: [target],
			restartBaseDelayMs: 5,
			env: { PI_WEB_FIXTURE_CRASH_MARKER: marker },
		});
		const lease = await supervisor.claim(target.sessionHandle, "connection");
		const before = supervisor.getRuntime(target.sessionHandle)!;
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "crash-once" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);

		await waitFor(() => (supervisor.getRuntime(target.sessionHandle)?.generation ?? 0) > before.generation);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle");
		const after = supervisor.getRuntime(target.sessionHandle)!;
		expect(after.sessionFile).toBe(target.sessionFile);
		expect(after.nativeSessionId).toBe(target.nativeSessionId);
	});

	it.runIf(process.platform !== "win32")(
		"waits for explicit process-group cleanup before restarting the same Session",
		async () => {
			const root = temporaryRoot();
			const cwd = path.join(root, "workspace");
			fs.mkdirSync(cwd);
			const target = createNativeSession(root, cwd, "stop-start-barrier");
			const marker = path.join(root, "lifecycle.log");
			const { supervisor } = createHarness({
				targets: [target],
				env: {
					PI_WEB_FIXTURE_IGNORE_TERM: "1",
					PI_WEB_FIXTURE_LIFECYCLE_MARKER: marker,
				},
			});

			await supervisor.activate(target.sessionHandle);
			const stopping = supervisor.stop(target.sessionHandle);
			await waitFor(() => fs.readFileSync(marker, "utf8").includes("term:"));

			let restarted = false;
			const activating = supervisor.activate(target.sessionHandle).then((runtime) => {
				restarted = true;
				return runtime;
			});
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			expect(restarted).toBe(false);
			expect(fs.readFileSync(marker, "utf8").match(/^start:/gm)).toHaveLength(1);

			await stopping;
			await activating;
			expect(fs.readFileSync(marker, "utf8").match(/^start:/gm)).toHaveLength(2);
		},
	);

	it("never evicts active work when the hot runtime capacity is exhausted", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "capacity-a");
		const second = createNativeSession(root, cwd, "capacity-b");
		const { supervisor } = createHarness({ targets: [first, second], maxHotRuntimes: 1 });
		const lease = await supervisor.claim(first.sessionHandle, "connection");
		const runtime = supervisor.getRuntime(first.sessionHandle)!;
		await supervisor.sendCommand(
			first.sessionHandle,
			{ type: "prompt", message: "slow" },
			{
				connectionId: "connection",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(first.sessionHandle)?.state === "running");

		await expect(supervisor.activate(second.sessionHandle)).rejects.toThrow("session_runtime_capacity");
		expect(supervisor.getRuntime(first.sessionHandle)?.state).toBe("running");
	});

	it("never evicts an unpersisted empty Session because it cannot be recovered", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const existing = createNativeSession(root, cwd, "existing");
		const { supervisor } = createHarness({ targets: [existing], maxHotRuntimes: 1 });

		const created = await supervisor.createSession({
			workspaceId: existing.workspaceId,
			cwd,
			sessionDir: path.join(root, "new-sessions"),
			requestedNativeSessionId: "empty",
		});
		expect(created.recoverable).toBe(false);
		expect(created.state).toBe("idle");

		await expect(supervisor.activate(existing.sessionHandle)).rejects.toThrow("session_runtime_capacity");
		expect(supervisor.getRuntime(created.sessionHandle)?.state).toBe("idle");
	});

	it("rekeys forked processes to the child while leaving the parent independently addressable", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "parent");
		const { supervisor } = createHarness({ targets: [parent] });
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const runtime = supervisor.getRuntime(parent.sessionHandle)!;
		const result = await supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "connection",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);

		expect(result.previousSessionHandle).toBe(parent.sessionHandle);
		expect(result.sessionHandle).not.toBe(parent.sessionHandle);
		expect(supervisor.getRuntime(result.sessionHandle)?.nativeSessionId).toBe("parent-clone");
		expect(supervisor.getRuntime(parent.sessionHandle)).toBeUndefined();
		const reopenedParent = await supervisor.activate(parent.sessionHandle);
		expect(reopenedParent.nativeSessionId).toBe("parent");
		expect(supervisor.listRuntimes()).toHaveLength(2);
	});

	it("drops ambiguous child frames and reopens the parent when transition identity verification fails", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "verify-parent");
		const { supervisor, messages } = createHarness({
			targets: [parent],
			env: { PI_WEB_FIXTURE_FAIL_TRANSITION_STATE: "1" },
		});
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const runtime = supervisor.getRuntime(parent.sessionHandle)!;

		await expect(
			supervisor.sendCommand(
				parent.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "connection",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("unable to verify forked session identity");
		expect(
			messages.some(
				(message) =>
					message.type === "event" &&
					message.event.type === "message_update" &&
					message.event.assistantMessageEvent.type === "text_delta",
			),
		).toBe(false);
		expect(supervisor.getRuntime(parent.sessionHandle)?.state).toBe("dormant");

		const reopened = await supervisor.activate(parent.sessionHandle);
		expect(reopened.nativeSessionId).toBe("verify-parent");
		expect(reopened.sessionFile).toBe(parent.sessionFile);
	});

	it("fails closed when a dispatched identity transition never returns a response", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "timeout-parent");
		const { supervisor, messages } = createHarness({
			targets: [parent],
			env: {
				PI_WEB_FIXTURE_DROP_TRANSITION_RESPONSE: "1",
				PI_WEB_FIXTURE_TRANSITION_STICKY: "1",
			},
			commandTimeoutFor: (commandType) => (commandType === "clone" ? 50 : 2_000),
		});
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;

		await expect(
			supervisor.sendCommand(
				parent.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "connection",
					expectedGeneration: before.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("command timed out");
		const failed = supervisor.getRuntime(parent.sessionHandle);
		expect(failed).toMatchObject({
			sessionHandle: parent.sessionHandle,
			generation: before.generation,
			lastSeq: before.lastSeq,
			state: "dormant",
			recoverable: true,
		});
		expect(
			messages.some(
				(message) => message.type === "extension_ui_request" && message.request.method === "setStatus",
			),
		).toBe(false);
		expect(
			fs.readdirSync(path.dirname(parent.sessionFile)).some((file) => file.includes("timeout-parent-clone")),
		).toBe(true);

		const reopened = await supervisor.activate(parent.sessionHandle);
		expect(reopened.nativeSessionId).toBe("timeout-parent");
		expect(reopened.sessionFile).toBe(parent.sessionFile);
	});

	it("reapplies the hot-runtime capacity gate when a dormant Session is reopened", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "reopen-a");
		const second = createNativeSession(root, cwd, "reopen-b");
		const { supervisor } = createHarness({ targets: [first, second], maxHotRuntimes: 1 });

		await supervisor.activate(first.sessionHandle);
		await supervisor.activate(second.sessionHandle);
		expect(supervisor.getRuntime(first.sessionHandle)?.state).toBe("dormant");
		expect(supervisor.getRuntime(second.sessionHandle)?.state).toBe("idle");

		await supervisor.activate(first.sessionHandle);
		expect(supervisor.getRuntime(first.sessionHandle)?.state).toBe("idle");
		expect(supervisor.getRuntime(second.sessionHandle)?.state).toBe("dormant");
		expect(supervisor.listRuntimes().filter((runtime) => runtime.state !== "dormant")).toHaveLength(1);
	});

	it("protects a prompt accepted before agent_start from capacity eviction", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const active = createNativeSession(root, cwd, "response-first");
		const other = createNativeSession(root, cwd, "response-other");
		const { supervisor } = createHarness({ targets: [active, other], maxHotRuntimes: 1 });
		const lease = await supervisor.claim(active.sessionHandle, "connection");
		const runtime = supervisor.getRuntime(active.sessionHandle)!;

		await supervisor.sendCommand(
			active.sessionHandle,
			{ type: "prompt", message: "response-first" },
			{
				connectionId: "connection",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		expect(supervisor.getRuntime(active.sessionHandle)?.state).toBe("running");
		await expect(supervisor.activate(other.sessionHandle)).rejects.toThrow("session_runtime_capacity");
		await waitFor(() => supervisor.getRuntime(active.sessionHandle)?.state === "idle");
	});

	it("serializes identity admission and rejects a command fenced to the parent generation", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "admission-parent");
		const { supervisor } = createHarness({
			targets: [parent],
			env: { PI_WEB_FIXTURE_TRANSITION_STATE_DELAY_MS: "100" },
		});
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		const clone = supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() =>
			fs
				.readdirSync(path.dirname(parent.sessionFile))
				.some((file) => file.includes("admission-parent-clone")),
		);
		const staleRead = supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "get_state" },
			{ connectionId: "connection", expectedGeneration: before.generation },
		);

		const transitioned = await clone;
		await expect(staleRead).rejects.toThrow("session_generation_stale");
		expect(transitioned.generation).toBe(before.generation + 1);
	});

	it("treats a vetoed clone as a no-op without clearing generation or replay", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "cancel-parent");
		const { supervisor, messages } = createHarness({
			targets: [parent],
			env: {
				PI_WEB_FIXTURE_CANCEL_TRANSITION: "1",
				PI_WEB_FIXTURE_TRANSITION_STICKY: "1",
			},
		});
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		const result = await supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);

		expect(result.previousSessionHandle).toBeUndefined();
		expect(result.sessionHandle).toBe(parent.sessionHandle);
		expect(result.generation).toBe(before.generation);
		expect(messages.some((message) => message.type === "session_rekeyed")).toBe(false);
		expect(supervisor.getPendingExtensionRequests(parent.sessionHandle)).toContainEqual(
			expect.objectContaining({ method: "setStatus", statusText: "cancelled" }),
		);
	});

	it("rekeys subscribers before emitting staged child extension frames", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "ordered-parent");
		const { supervisor, messages } = createHarness({
			targets: [parent],
			env: { PI_WEB_FIXTURE_TRANSITION_STICKY: "1" },
		});
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		const result = await supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);

		const rekeyIndex = messages.findIndex((message) => message.type === "session_rekeyed");
		const stickyIndex = messages.findIndex(
			(message) => message.type === "extension_ui_request" && message.request.method === "setStatus",
		);
		expect(rekeyIndex).toBeGreaterThanOrEqual(0);
		expect(stickyIndex).toBeGreaterThan(rekeyIndex);
		expect(messages[stickyIndex]).toMatchObject({
			type: "extension_ui_request",
			sessionHandle: result.sessionHandle,
			generation: result.generation,
		});
	});

	it("reserves Workspace activation until a fork child identity is committed", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "collision-parent");
		const { supervisor, targets } = createHarness({
			targets: [parent],
			env: { PI_WEB_FIXTURE_TRANSITION_STATE_DELAY_MS: "250" },
		});
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		const clone = supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		let childFile = "";
		await waitFor(() => {
			childFile =
				fs
					.readdirSync(path.dirname(parent.sessionFile))
					.map((file) => path.join(path.dirname(parent.sessionFile), file))
					.find((file) => file.includes("collision-parent-clone")) ?? "";
			return Boolean(childFile);
		});
		const child: ExistingSessionTarget = {
			kind: "existing",
			sessionHandle: sessionHandleForFile(childFile),
			workspaceId: parent.workspaceId,
			cwd,
			sessionFile: canonicalizeSessionFile(childFile),
			nativeSessionId: "collision-parent-clone",
		};
		targets.set(child.sessionHandle, child);
		await expect(supervisor.activate(child.sessionHandle)).rejects.toThrow(
			"workspace_identity_transitioning",
		);

		const transitioned = await clone;
		expect(transitioned.sessionHandle).toBe(child.sessionHandle);
		expect(supervisor.getRuntime(parent.sessionHandle)).toBeUndefined();
		expect(supervisor.getRuntime(child.sessionHandle)?.state).toBe("idle");
		expect(
			supervisor.listRuntimes().filter((runtime) => runtime.sessionHandle === child.sessionHandle),
		).toHaveLength(1);
	});

	it("keeps failed startup tracked and publishes a terminal crashed state", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "invalid-start");
		fs.writeFileSync(target.sessionFile, "not-json\n");
		const { supervisor, messages } = createHarness({
			targets: [target],
			maxAutoRestarts: 0,
		});

		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow();
		expect(supervisor.getRuntime(target.sessionHandle)?.state).toBe("crashed");
		expect(
			messages.some((message) => message.type === "runtime_state" && message.runtime.state === "crashed"),
		).toBe(true);
	});

	it("does not start a delayed activation after shutdown begins", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "shutdown");
		let releaseResolve: (() => void) | undefined;
		const resolveGate = new Promise<void>((resolve) => {
			releaseResolve = resolve;
		});
		const supervisor = new SessionSupervisor({
			resolved: {
				command: process.execPath,
				args: [fixturePath],
				source: "pi-path",
				label: "session runtime fixture",
			},
			resolveSession: async () => {
				await resolveGate;
				return target;
			},
			broadcast: () => {},
		});
		supervisors.push(supervisor);
		const activation = supervisor.activate(target.sessionHandle);
		const shutdown = supervisor.stopAll();
		releaseResolve?.();

		await shutdown;
		await expect(activation).rejects.toThrow("session_supervisor_closed");
		expect(supervisor.listRuntimes()).toEqual([]);
	});

	it("rechecks shutdown after a blocked capacity eviction and shares the close promise", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "shutdown-capacity-a");
		const second = createNativeSession(root, cwd, "shutdown-capacity-b");
		const { supervisor } = createHarness({ targets: [first, second], maxHotRuntimes: 1 });
		await supervisor.activate(first.sessionHandle);
		const internal = supervisor as unknown as { runtimes: Map<string, SessionRuntime> };
		const firstRuntime = internal.runtimes.get(first.sessionHandle)!;
		const originalStop = firstRuntime.stop.bind(firstRuntime);
		let releaseStop: (() => void) | undefined;
		let stopEntered = false;
		const stopGate = new Promise<void>((resolve) => {
			releaseStop = resolve;
		});
		firstRuntime.stop = async () => {
			stopEntered = true;
			await stopGate;
			await originalStop();
		};

		const activation = supervisor.activate(second.sessionHandle);
		await waitFor(() => stopEntered);
		const firstClose = supervisor.stopAll();
		const secondClose = supervisor.stopAll();
		expect(secondClose).toBe(firstClose);
		releaseStop?.();

		await firstClose;
		await expect(activation).rejects.toThrow("session_supervisor_closed");
		expect(supervisor.listRuntimes()).toEqual([]);
	});

	it("rejects a frozen Session identity after its path is replaced by a symlink", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const requested = createNativeSession(root, cwd, "frozen-a");
		const replacement = createNativeSession(root, cwd, "frozen-b");
		fs.unlinkSync(requested.sessionFile);
		fs.symlinkSync(replacement.sessionFile, requested.sessionFile);
		const { supervisor } = createHarness({ targets: [requested], maxAutoRestarts: 0 });

		await expect(supervisor.activate(requested.sessionHandle)).rejects.toThrow("different session file");
		expect(supervisor.getRuntime(replacement.sessionHandle)).toBeUndefined();
	});

	it("rejects a Session whose native Header.cwd changes after discovery", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		const foreignCwd = path.join(root, "foreign-workspace");
		fs.mkdirSync(cwd);
		fs.mkdirSync(foreignCwd);
		const target = createNativeSession(root, cwd, "frozen-header-cwd");
		const openedMarker = path.join(root, "opened.marker");
		const { supervisor } = createHarness({
			targets: [target],
			maxAutoRestarts: 0,
			env: {
				PI_WEB_FIXTURE_OPEN_MARKER: openedMarker,
				PI_WEB_FIXTURE_READY_DELAY_MS: "250",
			},
		});

		const activation = supervisor.activate(target.sessionHandle);
		await waitFor(() => fs.existsSync(openedMarker));
		fs.writeFileSync(
			target.sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: target.nativeSessionId,
				timestamp: "2026-08-20T00:00:00.000Z",
				cwd: foreignCwd,
			})}\n`,
		);

		await expect(activation).rejects.toThrow("header identity changed");
		expect(supervisor.getRuntime(target.sessionHandle)?.state).toBe("crashed");
	});

	it("pins a new Session to its requested native id", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const { supervisor } = createHarness({
			targets: [],
			env: { PI_WEB_FIXTURE_READY_ID: "wrong-existing-id" },
		});

		await expect(
			supervisor.createSession({
				workspaceId: "workspace",
				cwd,
				sessionDir: path.join(root, "sessions"),
				requestedNativeSessionId: "requested-new-id",
			}),
		).rejects.toThrow("requested new id");
		expect(supervisor.listRuntimes()).toEqual([]);
	});

	it("restores idle after a dialog-only extension command and allows abort_bash through admission", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "dialog-command");
		const { supervisor } = createHarness({ targets: [target] });
		const lease = await supervisor.claim(target.sessionHandle, "connection");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "open-dialog-no-agent" },
			{
				connectionId: "connection",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		expect(supervisor.getRuntime(target.sessionHandle)?.state).toBe("waiting_ui");
		expect(
			await supervisor.sendExtensionUiResponse(
				target.sessionHandle,
				{ type: "extension_ui_response", id: "dialog-dialog-command", confirmed: true },
				{
					connectionId: "connection",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).toBe("accepted");
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle");

		const bash = supervisor.sendCommand(
			target.sessionHandle,
			{ type: "bash", command: "long" },
			{
				connectionId: "connection",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		await expect(
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "abort_bash" },
				{
					connectionId: "connection",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).resolves.toMatchObject({ response: { success: true } });
		await expect(bash).resolves.toMatchObject({ response: { success: true } });
	});

	it("settles manual compaction without waiting for an agent_settled event", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "manual-compaction");
		const { supervisor } = createHarness({ targets: [target] });
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;

		for (const customInstructions of [undefined, "failure"] as const) {
			await supervisor.sendCommand(
				target.sessionHandle,
				{ type: "compact", ...(customInstructions ? { customInstructions } : {}) },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
			expect(supervisor.getRuntime(target.sessionHandle)?.state).toBe("idle");
		}

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "compact", customInstructions: "retry" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		expect(supervisor.getRuntime(target.sessionHandle)?.state).toBe("running");
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle");
	});

	it("holds a pool-level deletion reservation against concurrent activation", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "deletion-race");
		const { supervisor } = createHarness({ targets: [target] });
		let releaseDelete: (() => void) | undefined;
		const deleteGate = new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});
		const deleting = supervisor.withSessionDeletion(target.workspaceId, target.sessionHandle, async () => {
			await deleteGate;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow("session_deleting");
		releaseDelete?.();
		await deleting;
		expect(supervisor.getRuntime(target.sessionHandle)).toBeUndefined();
	});

	it("requires an exact controller capability before stopping and deleting a Session", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "controlled-delete");
		const { supervisor } = createHarness({ targets: [target] });
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		if (!lease.fencingToken) throw new Error("controller lease was not granted");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		let operationRan = false;

		await expect(
			supervisor.withControlledSessionDeletion(
				target.workspaceId,
				target.sessionHandle,
				{ expectedGeneration: runtime.generation, fencingToken: "stale-token" },
				async () => {
					operationRan = true;
				},
			),
		).rejects.toThrow("session_read_only");
		await expect(
			supervisor.withControlledSessionDeletion(
				target.workspaceId,
				target.sessionHandle,
				{ expectedGeneration: runtime.generation + 1, fencingToken: lease.fencingToken },
				async () => {
					operationRan = true;
				},
			),
		).rejects.toThrow("session_generation_stale");
		expect(operationRan).toBe(false);
		expect(supervisor.getRuntime(target.sessionHandle)?.state).toBe("idle");

		await supervisor.withControlledSessionDeletion(
			target.workspaceId,
			target.sessionHandle,
			{ expectedGeneration: runtime.generation, fencingToken: lease.fencingToken },
			async () => {
				operationRan = true;
				expect(supervisor.isActive(target.sessionHandle)).toBe(false);
				fs.rmSync(target.sessionFile);
			},
		);
		expect(operationRan).toBe(true);
		expect(supervisor.getRuntime(target.sessionHandle)).toBeUndefined();
	});

	it("rejects child deletion while a Workspace identity transition is uncommitted", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "delete-transition-parent");
		const { supervisor } = createHarness({
			targets: [parent],
			env: { PI_WEB_FIXTURE_TRANSITION_STATE_DELAY_MS: "250" },
		});
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		const clone = supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		let childFile = "";
		await waitFor(() => {
			childFile =
				fs
					.readdirSync(path.dirname(parent.sessionFile))
					.map((file) => path.join(path.dirname(parent.sessionFile), file))
					.find((file) => file.includes("delete-transition-parent-clone")) ?? "";
			return Boolean(childFile);
		});
		const childHandle = sessionHandleForFile(childFile);
		let operationRan = false;

		await expect(
			supervisor.withSessionDeletion(parent.workspaceId, childHandle, async () => {
				operationRan = true;
				fs.rmSync(childFile);
			}),
		).rejects.toThrow("workspace_identity_transitioning");
		expect(operationRan).toBe(false);
		expect(fs.existsSync(childFile)).toBe(true);

		const transitioned = await clone;
		expect(transitioned.sessionHandle).toBe(childHandle);
		expect(supervisor.getRuntime(childHandle)).toMatchObject({ recoverable: true, state: "idle" });
	});

	it("waits for an in-flight recoverable deletion before shutdown completes", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "shutdown-delete");
		const { supervisor } = createHarness({ targets: [target] });
		let enterDelete: (() => void) | undefined;
		const deleteEntered = new Promise<void>((resolve) => {
			enterDelete = resolve;
		});
		let releaseDelete: (() => void) | undefined;
		const deleteGate = new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});
		const deleting = supervisor.withSessionDeletion(target.workspaceId, target.sessionHandle, async () => {
			enterDelete?.();
			await deleteGate;
		});
		await deleteEntered;
		let shutdownCompleted = false;
		const shutdown = supervisor.stopAll().then(() => {
			shutdownCompleted = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(shutdownCompleted).toBe(false);

		releaseDelete?.();
		await deleting;
		await shutdown;
		expect(shutdownCompleted).toBe(true);
	});
});
