import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FutureProductSessionEventDto, FutureSessionSnapshotDto } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { EpochContentStore, type EpochStoredContentRef } from "../src/epoch-content-store.js";
import { createGatewayFuturePayloadActivation } from "../src/gateway-payload-activation.js";
import { legacyRpcV1Adapter } from "../src/legacy-rpc-v1.js";
import { canonicalizeSessionFile, sessionHandleForFile } from "../src/native-session-catalog.js";
import type { SessionLiveProjectionLimits } from "../src/session-live-projection.js";
import type { FutureSessionRuntimePiPayloadServices } from "../src/session-runtime.js";
import type { ExistingSessionTarget, SessionSupervisorMessage } from "../src/session-runtime-types.js";
import { createFutureSessionSupervisor } from "../src/session-supervisor.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");

function createTarget(root: string): ExistingSessionTarget {
	const cwd = path.join(root, "workspace");
	const sessionDir = path.join(root, "sessions");
	fs.mkdirSync(cwd);
	fs.mkdirSync(sessionDir);
	const sessionFile = path.join(sessionDir, "2026-08-28T00-00-00-000Z_future-runtime.jsonl");
	fs.writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "future-runtime",
			timestamp: "2026-08-28T00:00:00.000Z",
			cwd,
		})}\n`,
	);
	return {
		kind: "existing",
		sessionHandle: sessionHandleForFile(sessionFile),
		workspaceId: "workspace-future-runtime",
		cwd,
		sessionFile: canonicalizeSessionFile(sessionFile),
		nativeSessionId: "future-runtime",
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition did not settle before timeout");
}

function createFutureSupervisorFixture(
	target: ExistingSessionTarget,
	piPayloadServices: FutureSessionRuntimePiPayloadServices,
	messages: SessionSupervisorMessage<FutureProductSessionEventDto>[],
	projectionLimits?: Partial<SessionLiveProjectionLimits>,
) {
	return createFutureSessionSupervisor({
		serverEpoch: "future-epoch",
		resolved: {
			command: process.execPath,
			args: [fixturePath],
			source: "pi-path",
			label: "future Session runtime fixture",
			adapter: legacyRpcV1Adapter,
			version: "0.84.2",
			adapterId: "legacy-rpc-v1",
			compatibilityStatus: "current",
			capabilities: legacyRpcV1Adapter.capabilities,
		},
		resolveSession: async (handle) => (handle === target.sessionHandle ? target : undefined),
		broadcast: (message) => messages.push(message),
		piPayloadServices,
		projectionLimits,
		maxAutoRestarts: 0,
		readyTimeoutMs: 2_000,
	});
}

function activeLogicalBytes(runtime: object): number {
	const value = Reflect.get(runtime, "activeTurnProjectionLogicalBytes");
	if (typeof value !== "number") throw new Error("future runtime logical byte state is unavailable");
	return value;
}

function exactRuntime(supervisor: object, sessionHandle: string): object {
	const runtimes = Reflect.get(supervisor, "runtimes");
	if (!(runtimes instanceof Map)) throw new Error("future Supervisor runtime pool is unavailable");
	const runtime = runtimes.get(sessionHandle);
	if (typeof runtime !== "object" || runtime === null) throw new Error("future runtime is unavailable");
	return runtime;
}

function isEventMessage(
	message: SessionSupervisorMessage<FutureProductSessionEventDto>,
): message is Extract<SessionSupervisorMessage<FutureProductSessionEventDto>, { type: "event" }> {
	return message.type === "event";
}

describe("future Session Supervisor payload mode", () => {
	let root: string | undefined;
	let store: EpochContentStore | undefined;
	let stop: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await stop?.();
		await store?.shutdown();
		if (root) fs.rmSync(root, { recursive: true, force: true });
		stop = undefined;
		store = undefined;
		root = undefined;
	});

	it("keeps startup history, ordinary responses, replay, and snapshots in the private future family", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, "future-epoch");
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFutureSupervisorFixture(target, activation.supervisorServices, messages);
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const runtime = supervisor.getRuntime(target.sessionHandle);
		if (!runtime) throw new Error("future runtime was not activated");
		const result = await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "snapshot-checkpoint:tool" },
			{
				connectionId: "future-controller",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		expect(result.response).toMatchObject({ command: "prompt", success: true });
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle");

		const initial = await supervisor.subscribe(target.sessionHandle);
		if (initial.type !== "resync_required") throw new Error("future subscription did not resync");
		const toolStart = initial.snapshot.projectionEvents.find(
			(frame) => frame.event.type === "tool_execution_start",
		);
		expect(toolStart).toMatchObject({
			event: { type: "tool_execution_start", args: { type: "inline_json" } },
		});
		expect(messages.some((message) => message.type === "event")).toBe(true);
	});

	it("resets logical turn accounting only at authoritative settlement", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, "future-epoch");
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFutureSupervisorFixture(target, activation.supervisorServices, messages);
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "logical-settle-boundary" },
			{
				connectionId: "future-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() =>
			messages.some((message) => message.type === "event" && message.event.type === "agent_end"),
		);
		const runtime = exactRuntime(supervisor, target.sessionHandle);
		const throughAgentEnd = messages
			.filter(isEventMessage)
			.filter((message) => message.event.type !== "agent_settled");
		const expectedBeforeSettlement = throughAgentEnd.reduce(
			(total, message) =>
				total + activation.supervisorServices.productSchema.activeTurnEventLogicalBytes(message.event),
			0,
		);
		expect(activeLogicalBytes(runtime)).toBe(expectedBeforeSettlement);

		await waitFor(() =>
			messages.some(
				(message) =>
					message.type === "event" &&
					message.event.type === "queue_update" &&
					message.event.steering.includes("post-settle-marker"),
			),
		);
		const postSettlement = messages.find(
			(message) =>
				message.type === "event" &&
				message.event.type === "queue_update" &&
				message.event.steering.includes("post-settle-marker"),
		);
		if (postSettlement?.type !== "event") {
			throw new Error("post-settlement event was not delivered");
		}
		expect(activeLogicalBytes(runtime)).toBe(
			activation.supervisorServices.productSchema.activeTurnEventLogicalBytes(postSettlement.event),
		);
	});

	it("clears logical turn accounting during generation cleanup before restart", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, "future-epoch");
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFutureSupervisorFixture(target, activation.supervisorServices, messages);
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "logical-cleanup-boundary" },
			{
				connectionId: "future-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() =>
			messages.some((message) => message.type === "event" && message.event.type === "turn_start"),
		);
		const runtime = exactRuntime(supervisor, target.sessionHandle);
		expect(activeLogicalBytes(runtime)).toBeGreaterThan(0);

		await supervisor.stop(target.sessionHandle);
		expect(activeLogicalBytes(runtime)).toBe(0);
		await supervisor.activate(target.sessionHandle);
		expect(activeLogicalBytes(runtime)).toBe(0);
	});

	it("terminalizes a future compaction overflow without advancing seq and releases its transfer", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		const exactStore = new EpochContentStore({
			webDataDir: path.join(root, "web-data"),
			serverEpoch: "future-epoch",
		});
		store = exactStore;
		await exactStore.initialize();
		const activation = createGatewayFuturePayloadActivation(exactStore, "future-epoch");
		const baseSchema = activation.supervisorServices.productSchema;
		const overflowSchema = Object.freeze({
			...baseSchema,
			snapshotLogicalBytes(snapshot: FutureSessionSnapshotDto) {
				if (snapshot.settledMessages.some((message) => message.role === "toolResult")) {
					throw new Error("fixture future compaction logical overflow");
				}
				return baseSchema.snapshotLogicalBytes(snapshot);
			},
		});
		const releasedRefs: EpochStoredContentRef[] = [];
		const piPayloadServices = Object.freeze({
			...activation.supervisorServices,
			productSchema: overflowSchema,
			async releaseHold(hold: { readonly ref: EpochStoredContentRef }) {
				releasedRefs.push(hold.ref);
				await exactStore.release(hold);
			},
		});
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFutureSupervisorFixture(target, piPayloadServices, messages, {
			maxLiveEventItems: 6,
		});
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "future-compaction-overflow" },
			{
				connectionId: "future-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");
		const settled = messages.find(
			(message) => message.type === "event" && message.event.type === "agent_settled",
		);
		if (settled?.type !== "event") throw new Error("settlement event was not delivered");
		const crashed = supervisor.getRuntime(target.sessionHandle);
		expect(crashed).toMatchObject({
			state: "crashed",
			lastSeq: settled.seq,
			error: expect.stringContaining("session_snapshot_overflow"),
		});
		await waitFor(() => releasedRefs.some((ref) => ref.type === "content_ref"));
		expect(releasedRefs.some((ref) => ref.type === "content_ref")).toBe(true);
	});
});
