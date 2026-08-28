import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FutureProductSessionEventDto, SessionContentRefDto } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	type EpochContentHold,
	EpochContentStore,
	type EpochStoredContentRef,
} from "../src/epoch-content-store.js";
import { createGatewayFuturePayloadActivation } from "../src/gateway-payload-activation.js";
import { legacyRpcV1Adapter } from "../src/legacy-rpc-v1.js";
import { canonicalizeSessionFile, sessionHandleForFile } from "../src/native-session-catalog.js";
import type { PiHostFuturePayloadExternalizer } from "../src/pi-host-adapter.js";
import type { PiPayloadExternalizerInput, PiPayloadLease } from "../src/pi-payload-externalizer.js";
import type { SessionLiveProjectionLimits } from "../src/session-live-projection.js";
import { SessionLiveProjection } from "../src/session-live-projection.js";
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
	maxAutoRestarts = 0,
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
		maxAutoRestarts,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oversizedHistoryLease(): {
	lease: PiPayloadLease<EpochStoredContentRef>;
	refs: readonly SessionContentRefDto[];
	counters: { adopt: number; transferRelease: number; leaseRelease: number };
} {
	const first: SessionContentRefDto = Object.freeze({
		type: "content_ref",
		serverEpoch: "future-epoch",
		sha256: "a".repeat(64),
		byteLength: 33 * 1024 * 1024,
		encoding: "utf-8",
	});
	const second: SessionContentRefDto = Object.freeze({
		type: "content_ref",
		serverEpoch: "future-epoch",
		sha256: "b".repeat(64),
		byteLength: 33 * 1024 * 1024,
		encoding: "utf-8",
	});
	const refs: readonly SessionContentRefDto[] = Object.freeze([first, second]);
	const holds: readonly EpochContentHold<SessionContentRefDto>[] = Object.freeze(
		refs.map((ref) => Object.freeze({ ref })),
	);
	const counters = { adopt: 0, transferRelease: 0, leaseRelease: 0 };
	let state: "provisional" | "transferred" = "provisional";
	const lease: PiPayloadLease<EpochStoredContentRef> = Object.freeze({
		refs,
		transfer() {
			if (state !== "provisional") throw new Error("history lease was already transferred");
			state = "transferred";
			return Object.freeze({
				refs,
				adopt(accept: (entries: readonly EpochContentHold<EpochStoredContentRef>[]) => true) {
					counters.adopt += 1;
					if (accept(holds) !== true) throw new Error("history lease adoption was rejected");
				},
				async release() {
					counters.transferRelease += 1;
				},
			});
		},
		async release() {
			counters.leaseRelease += 1;
		},
	});
	return { lease, refs, counters };
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

	it("preflights a two-ref future compaction before owner adoption and CAS commit", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		const exactStore = new EpochContentStore({
			webDataDir: path.join(root, "web-data"),
			serverEpoch: "future-epoch",
		});
		store = exactStore;
		await exactStore.initialize();
		const activation = createGatewayFuturePayloadActivation(exactStore, "future-epoch");
		const oversized = oversizedHistoryLease();
		expect(oversized.refs.every((ref) => ref.byteLength < 48 * 1024 * 1024)).toBe(true);
		expect(oversized.refs.reduce((total, ref) => total + ref.byteLength, 0)).toBeGreaterThan(
			64 * 1024 * 1024,
		);
		let historyResponses = 0;
		const externalizer: PiHostFuturePayloadExternalizer = Object.freeze({
			...activation.externalizer,
			async externalize(input: PiPayloadExternalizerInput, signal: AbortSignal) {
				if (input.kind === "response" && input.expectedCommand === "get_messages") {
					historyResponses += 1;
					if (historyResponses === 2) {
						if (!isRecord(input.value) || typeof input.value.id !== "string") {
							throw new Error("compaction response id is unavailable");
						}
						return Object.freeze({
							value: {
								type: "response",
								id: input.value.id,
								command: "get_messages",
								success: true,
								data: {
									messages: oversized.refs.map((ref, index) => ({
										role: "toolResult",
										toolCallId: `logical-${String(index)}`,
										toolName: "fixture",
										content: [{ type: "text", text: { type: "external_text", ref } }],
										isError: false,
										timestamp: index + 1,
									})),
								},
							},
							lease: oversized.lease,
						});
					}
				}
				return activation.externalizer.externalize(input, signal);
			},
		});
		const releasedHolds: EpochStoredContentRef[] = [];
		const piPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer,
			async releaseHold(hold: { readonly ref: EpochStoredContentRef }) {
				releasedHolds.push(hold.ref);
			},
		});
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFutureSupervisorFixture(
			target,
			piPayloadServices,
			messages,
			{
				maxLiveEventItems: 6,
			},
			3,
		);
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		const runtime = exactRuntime(supervisor, target.sessionHandle);
		const projection = Reflect.get(runtime, "liveProjection");
		if (!(projection instanceof SessionLiveProjection)) {
			throw new Error("future live projection is unavailable");
		}
		const projectionBefore = projection.snapshot();
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "compaction-three-frame" },
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
			error: "session_snapshot_overflow",
		});
		await waitFor(() => oversized.counters.transferRelease > 0 || releasedHolds.length > 0);
		await new Promise<void>((resolve) => setTimeout(resolve, 750));
		expect(supervisor.getRuntime(target.sessionHandle)?.generation).toBe(before.generation);
		const projectionAfter = projection.snapshot();
		expect(oversized.counters).toEqual({ adopt: 0, transferRelease: 1, leaseRelease: 0 });
		expect(releasedHolds).toEqual([]);
		expect(projectionAfter.baseSeq).toBe(projectionBefore.baseSeq);
		expect(projectionAfter.asOfSeq).toBe(settled.seq);
		expect(projectionAfter.projectionEvents.at(-1)).toMatchObject({
			seq: settled.seq,
			event: { type: "agent_settled" },
		});
	});
});
