import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ExtensionUiRequestDto,
	ProductSessionEventDto,
	SessionContentRefDto,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	type EpochContentHold,
	EpochContentStore,
	type EpochStoredContentRef,
} from "../src/epoch-content-store.js";
import { createGatewayPayloadActivation } from "../src/gateway-payload-activation.js";
import { canonicalizeSessionFile, sessionHandleForFile } from "../src/native-session-catalog.js";
import type { PiHostPayloadExternalizer } from "../src/pi-host-adapter.js";
import type {
	PiPayloadExternalizerInput,
	PiPayloadLease,
	PiPayloadLeaseTransfer,
} from "../src/pi-payload-externalizer.js";
import { piRpcAdapter } from "../src/pi-rpc-adapter.js";
import type { SessionLiveProjectionLimits } from "../src/session-live-projection.js";
import { SessionLiveProjection } from "../src/session-live-projection.js";
import type { SessionRuntimePiPayloadServices } from "../src/session-runtime.js";
import type { ExistingSessionTarget, SessionSupervisorMessage } from "../src/session-runtime-types.js";
import { SessionSupervisor } from "../src/session-supervisor.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");
type CanonicalSupervisorMessage = SessionSupervisorMessage<ProductSessionEventDto, ExtensionUiRequestDto>;

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

function createSupervisorFixture(
	target: ExistingSessionTarget,
	piPayloadServices: SessionRuntimePiPayloadServices,
	messages: CanonicalSupervisorMessage[],
	projectionLimits?: Partial<SessionLiveProjectionLimits>,
	maxAutoRestarts = 0,
	env?: Record<string, string>,
	runtimeLimits?: {
		extensionStateMaxBytes?: number;
		extensionStateMaxItems?: number;
		readyTimeoutMs?: number;
		transientBufferMaxBytes?: number;
	},
) {
	return new SessionSupervisor({
		serverEpoch: "future-epoch",
		resolved: {
			command: process.execPath,
			args: [fixturePath],
			source: "pi-path",
			label: "future Session runtime fixture",
			adapter: piRpcAdapter,
			version: "0.84.2",
			adapterId: "pi-rpc",
			compatibilityStatus: "current",
			capabilities: piRpcAdapter.capabilities,
		},
		resolveSession: async (handle) => (handle === target.sessionHandle ? target : undefined),
		broadcast: (message) => messages.push(message),
		piPayloadServices,
		projectionLimits,
		maxAutoRestarts,
		env,
		...runtimeLimits,
		readyTimeoutMs: runtimeLimits?.readyTimeoutMs ?? 2_000,
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

function generationOwnerRefs(runtime: object): readonly EpochStoredContentRef[] {
	const owner = Reflect.get(runtime, "generationContentOwner");
	if (typeof owner !== "object" || owner === null) throw new Error("future generation owner is unavailable");
	const refs = Reflect.get(owner, "refs");
	if (!Array.isArray(refs)) throw new Error("future generation owner refs are unavailable");
	return refs;
}

interface ExtensionLeaseCounters {
	transfer: number;
	adopt: number;
	transferRelease: number;
	leaseRelease: number;
}

function instrumentExtensionLease(
	lease: PiPayloadLease<EpochStoredContentRef>,
	counters: ExtensionLeaseCounters,
	beforeTransfer?: () => void,
): PiPayloadLease<EpochStoredContentRef> {
	return Object.freeze({
		refs: lease.refs,
		transfer() {
			counters.transfer += 1;
			beforeTransfer?.();
			const transfer = lease.transfer();
			const wrapped: PiPayloadLeaseTransfer<EpochStoredContentRef> = Object.freeze({
				refs: transfer.refs,
				adopt(accept: (holds: readonly EpochContentHold<EpochStoredContentRef>[]) => true) {
					counters.adopt += 1;
					transfer.adopt(accept);
				},
				async release() {
					counters.transferRelease += 1;
					await transfer.release();
				},
			});
			return wrapped;
		},
		async release() {
			counters.leaseRelease += 1;
			await lease.release();
		},
	});
}

function instrumentExtensionExternalizer(
	base: PiHostPayloadExternalizer,
	counters: ExtensionLeaseCounters,
	forgeRequestRef = false,
	beforeTransfer?: () => void,
): PiHostPayloadExternalizer {
	return Object.freeze({
		...base,
		async externalize(input: PiPayloadExternalizerInput, signal: AbortSignal) {
			const outcome = await base.externalize(input, signal);
			if (input.kind !== "extension_ui_request") return outcome;
			const lease = instrumentExtensionLease(outcome.lease, counters, beforeTransfer);
			if (!forgeRequestRef) return Object.freeze({ value: outcome.value, lease });
			if (!isRecord(outcome.value) || !isRecord(outcome.value.prefill)) {
				throw new Error("future Extension externalized prefill is unavailable");
			}
			const ref = outcome.value.prefill.ref;
			if (!isRecord(ref)) throw new Error("future Extension externalized ref is unavailable");
			return Object.freeze({
				value: {
					...outcome.value,
					prefill: {
						type: "external_text",
						ref: { ...ref, sha256: "f".repeat(64) },
					},
				},
				lease,
			});
		},
	});
}

function logicalPairExtensionExternalizer(
	base: PiHostPayloadExternalizer,
	counters: ExtensionLeaseCounters,
): PiHostPayloadExternalizer {
	return Object.freeze({
		...base,
		async externalize(input: PiPayloadExternalizerInput, signal: AbortSignal) {
			if (
				input.kind !== "extension_ui_request" ||
				!isRecord(input.value) ||
				typeof input.value.id !== "string" ||
				!input.value.id.startsWith("startup-future-editor-logical-")
			) {
				return base.externalize(input, signal);
			}
			const second = input.value.id.includes("logical-1-");
			const ref: EpochStoredContentRef = Object.freeze({
				type: "content_ref",
				serverEpoch: "future-epoch",
				sha256: (second ? "b" : "a").repeat(64),
				byteLength: 33 * 1024 * 1024,
				encoding: "utf-8",
			});
			const holds: readonly EpochContentHold<EpochStoredContentRef>[] = Object.freeze([
				Object.freeze({ ref }),
			]);
			let state: "provisional" | "transferred" = "provisional";
			const lease: PiPayloadLease<EpochStoredContentRef> = Object.freeze({
				refs: Object.freeze([ref]),
				transfer() {
					if (state !== "provisional") throw new Error("logical Extension lease already transferred");
					state = "transferred";
					return Object.freeze({
						refs: Object.freeze([ref]),
						adopt(accept: (entries: readonly EpochContentHold<EpochStoredContentRef>[]) => true) {
							if (accept(holds) !== true) throw new Error("logical Extension lease adoption rejected");
						},
						async release() {},
					});
				},
				async release() {},
			});
			return Object.freeze({
				value: Object.freeze({
					...input.value,
					prefill: Object.freeze({ type: "external_text", ref }),
				}),
				lease: instrumentExtensionLease(lease, counters),
			});
		},
	});
}

function isEventMessage(
	message: CanonicalSupervisorMessage,
): message is Extract<CanonicalSupervisorMessage, { type: "event" }> {
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

	it("publishes a normal 320 KiB editor request only after its exact future ref is generation-owned", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, activation.supervisorServices, messages);
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "future-extension-large-editor" },
			{
				connectionId: "future-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() =>
			messages.some(
				(message) =>
					message.type === "extension_ui_request" &&
					message.request.id === `future-editor-${target.nativeSessionId}`,
			),
		);
		const requestFrame = messages.find(
			(message) =>
				message.type === "extension_ui_request" &&
				message.request.id === `future-editor-${target.nativeSessionId}`,
		);
		if (requestFrame?.type !== "extension_ui_request" || requestFrame.request.method !== "editor") {
			throw new Error("future editor request was not published");
		}
		expect(requestFrame.request.prefill).toMatchObject({ type: "external_text" });
		if (
			typeof requestFrame.request.prefill !== "object" ||
			requestFrame.request.prefill === null ||
			requestFrame.request.prefill.type !== "external_text"
		) {
			throw new Error("future editor prefill was not externalized");
		}
		expect(generationOwnerRefs(exactRuntime(supervisor, target.sessionHandle))).toEqual([
			requestFrame.request.prefill.ref,
		]);
	});

	it("rejects a forged future Extension wrapper-to-transfer ref mismatch before adoption", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const counters: ExtensionLeaseCounters = {
			transfer: 0,
			adopt: 0,
			transferRelease: 0,
			leaseRelease: 0,
		};
		const services: SessionRuntimePiPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer: instrumentExtensionExternalizer(activation.externalizer, counters, true),
		});
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, services, messages);
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "future-extension-large-editor" },
			{
				connectionId: "future-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");
		await waitFor(() => counters.transferRelease === 1);
		expect(messages.filter((message) => message.type === "extension_ui_request")).toEqual([]);
		expect(counters).toEqual({ transfer: 1, adopt: 0, transferRelease: 1, leaseRelease: 0 });
	});

	it("releases generation ownership exactly once when Extension CAS fails after adoption", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const counters: ExtensionLeaseCounters = {
			transfer: 0,
			adopt: 0,
			transferRelease: 0,
			leaseRelease: 0,
		};
		const released: EpochStoredContentRef[] = [];
		const services: SessionRuntimePiPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer: instrumentExtensionExternalizer(activation.externalizer, counters),
			async releaseHold(hold: EpochContentHold<EpochStoredContentRef>) {
				released.push(hold.ref);
				await activation.supervisorServices.releaseHold(hold);
			},
		});
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, services, messages, undefined, 3);
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		const runtime = exactRuntime(supervisor, target.sessionHandle);
		const projection = Reflect.get(runtime, "liveProjection");
		if (!(projection instanceof SessionLiveProjection)) {
			throw new Error("future live projection is unavailable");
		}
		const commitPreparedBatch = projection.commitPreparedBatch.bind(projection);
		let rejectNextBatch = true;
		Reflect.set(projection, "commitPreparedBatch", (token: Parameters<typeof commitPreparedBatch>[0]) => {
			if (rejectNextBatch) {
				rejectNextBatch = false;
				return null;
			}
			return commitPreparedBatch(token);
		});

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "future-extension-large-editor" },
			{
				connectionId: "future-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");
		await waitFor(() => released.length === 1);
		expect(counters).toEqual({ transfer: 1, adopt: 1, transferRelease: 0, leaseRelease: 0 });
		expect(released).toHaveLength(1);
		expect(messages.filter((message) => message.type === "extension_ui_request")).toEqual([]);
		expect(supervisor.getPendingExtensionRequests(target.sessionHandle)).toEqual([]);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			state: "crashed",
			generation: before.generation,
			lastSeq: before.lastSeq + 1,
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 750));
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			state: "crashed",
			generation: before.generation,
			lastSeq: before.lastSeq + 1,
		});
		expect(released).toHaveLength(1);
	});

	it("retains a closed future Extension ref until exact generation stop releases its owner", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const counters: ExtensionLeaseCounters = {
			transfer: 0,
			adopt: 0,
			transferRelease: 0,
			leaseRelease: 0,
		};
		const released: EpochStoredContentRef[] = [];
		const services: SessionRuntimePiPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer: instrumentExtensionExternalizer(activation.externalizer, counters),
			async releaseHold(hold: EpochContentHold<EpochStoredContentRef>) {
				released.push(hold.ref);
				await activation.supervisorServices.releaseHold(hold);
			},
		});
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, services, messages);
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "future-extension-large-editor" },
			{
				connectionId: "future-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => supervisor.getPendingExtensionRequests(target.sessionHandle)?.length === 1);
		const owned = generationOwnerRefs(exactRuntime(supervisor, target.sessionHandle));
		expect(owned).toHaveLength(1);
		expect(
			await supervisor.sendExtensionUiResponse(
				target.sessionHandle,
				{
					type: "extension_ui_response",
					id: `future-editor-${target.nativeSessionId}`,
					value: "accepted",
				},
				{
					connectionId: "future-controller",
					expectedGeneration: before.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).toBe("accepted");
		expect(generationOwnerRefs(exactRuntime(supervisor, target.sessionHandle))).toEqual(owned);
		expect(released).toEqual([]);

		await supervisor.stop(target.sessionHandle);
		await waitFor(() => released.length === 1);
		expect(released).toEqual(owned);
		expect(counters).toEqual({ transfer: 1, adopt: 1, transferRelease: 0, leaseRelease: 0 });
		const restarted = await supervisor.restart(target.sessionHandle);
		expect(restarted).toMatchObject({ generation: before.generation + 1, lastSeq: 0, state: "idle" });
		expect(generationOwnerRefs(exactRuntime(supervisor, target.sessionHandle))).toEqual([]);
		expect(released).toEqual(owned);
	});

	it("keeps an awaiting-response inline future blocking dialog visible and lets its veto finish", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(
			target,
			activation.supervisorServices,
			messages,
			undefined,
			0,
			{ PI_WEB_FIXTURE_TRANSITION_INLINE_DIALOG: "1" },
		);
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		const clone = supervisor.sendCommand(
			target.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "future-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		const dialogId = `transition-inline-dialog-${target.nativeSessionId}`;
		await waitFor(() =>
			messages.some(
				(message) =>
					message.type === "extension_ui_request" &&
					message.request.id === dialogId &&
					message.request.method === "confirm",
			),
		);
		expect(supervisor.getPendingExtensionRequests(target.sessionHandle)).toContainEqual(
			expect.objectContaining({ id: dialogId, method: "confirm" }),
		);
		expect(
			await supervisor.sendExtensionUiResponse(
				target.sessionHandle,
				{ type: "extension_ui_response", id: dialogId, confirmed: false },
				{
					connectionId: "future-controller",
					expectedGeneration: before.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).toBe("accepted");
		await expect(clone).resolves.toMatchObject({
			sessionHandle: target.sessionHandle,
			generation: before.generation,
		});
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({ state: "idle" });
		expect(supervisor.getPendingExtensionRequests(target.sessionHandle)).toEqual([]);
	});

	it("releases a stale future Extension transfer before adoption when semantic revision changes after prepare", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const counters: ExtensionLeaseCounters = {
			transfer: 0,
			adopt: 0,
			transferRelease: 0,
			leaseRelease: 0,
		};
		let beforeTransfer = () => {};
		const services: SessionRuntimePiPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer: instrumentExtensionExternalizer(activation.externalizer, counters, false, () =>
				beforeTransfer(),
			),
		});
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, services, messages, undefined, 3);
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "open-dialog-no-agent" },
			{
				connectionId: "future-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		const oldDialogId = `dialog-${target.nativeSessionId}`;
		await waitFor(() => supervisor.getPendingExtensionRequests(target.sessionHandle)?.length === 1);
		counters.transfer = 0;
		counters.adopt = 0;
		counters.transferRelease = 0;
		counters.leaseRelease = 0;
		const beforeIncoming = supervisor.getRuntime(target.sessionHandle);
		if (!beforeIncoming) throw new Error("future runtime disappeared before stale delivery");
		beforeTransfer = () => {
			void supervisor.sendExtensionUiResponse(
				target.sessionHandle,
				{ type: "extension_ui_response", id: oldDialogId, cancelled: true },
				{
					connectionId: "future-controller",
					expectedGeneration: beforeIncoming.generation,
					fencingToken: lease.fencingToken,
				},
			);
		};
		messages.length = 0;

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "future-extension-large-editor" },
			{
				connectionId: "future-controller",
				expectedGeneration: beforeIncoming.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");
		await waitFor(() => counters.transferRelease === 1);
		expect(counters).toEqual({ transfer: 1, adopt: 0, transferRelease: 1, leaseRelease: 0 });
		expect(
			messages.some(
				(message) =>
					message.type === "extension_ui_request" &&
					message.request.id === `future-editor-${target.nativeSessionId}`,
			),
		).toBe(false);
		const closeFrames = messages.filter((message) => message.type === "extension_ui_closed");
		expect(closeFrames).toEqual([
			expect.objectContaining({ type: "extension_ui_closed", requestId: oldDialogId }),
		]);
		const closeFrame = closeFrames[0];
		if (closeFrame?.type !== "extension_ui_closed") {
			throw new Error("semantic race dialog close frame is unavailable");
		}
		expect(supervisor.getPendingExtensionRequests(target.sessionHandle)).toEqual([]);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			state: "crashed",
			generation: beforeIncoming.generation,
			lastSeq: closeFrame.seq,
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 750));
		expect(supervisor.getRuntime(target.sessionHandle)?.generation).toBe(beforeIncoming.generation);
	});

	it("adopts and publishes a leased 320 KiB future editor delivered during startup", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const counters: ExtensionLeaseCounters = {
			transfer: 0,
			adopt: 0,
			transferRelease: 0,
			leaseRelease: 0,
		};
		const services: SessionRuntimePiPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer: instrumentExtensionExternalizer(activation.externalizer, counters),
		});
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, services, messages, undefined, 3, {
			PI_WEB_FIXTURE_STARTUP_FUTURE_EDITOR: "1",
		});
		stop = () => supervisor.stopAll();

		await expect(supervisor.activate(target.sessionHandle)).resolves.toMatchObject({ state: "waiting_ui" });
		const frame = messages.find(
			(message) =>
				message.type === "extension_ui_request" &&
				message.request.id === `startup-future-editor-${target.nativeSessionId}`,
		);
		if (frame?.type !== "extension_ui_request" || frame.request.method !== "editor") {
			throw new Error("startup future editor request was not published");
		}
		if (
			typeof frame.request.prefill !== "object" ||
			frame.request.prefill === null ||
			frame.request.prefill.type !== "external_text"
		) {
			throw new Error("startup future editor request was not externalized");
		}
		expect(counters).toEqual({ transfer: 1, adopt: 1, transferRelease: 0, leaseRelease: 0 });
		expect(generationOwnerRefs(exactRuntime(supervisor, target.sessionHandle))).toEqual([
			frame.request.prefill.ref,
		]);
		const initial = await supervisor.subscribe(target.sessionHandle);
		expect(initial).toMatchObject({
			type: "resync_required",
			snapshot: {
				runtime: { state: "waiting_ui", lastSeq: frame.seq },
				pendingExtensionRequests: [expect.objectContaining({ id: frame.request.id })],
			},
		});
	});

	it("publishes only the authoritative leased editor when startup replaces an unpublished request", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const counters: ExtensionLeaseCounters = {
			transfer: 0,
			adopt: 0,
			transferRelease: 0,
			leaseRelease: 0,
		};
		const services: SessionRuntimePiPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer: instrumentExtensionExternalizer(activation.externalizer, counters),
		});
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, services, messages, undefined, 0, {
			PI_WEB_FIXTURE_STARTUP_FUTURE_EDITOR_REPLACEMENT: "1",
		});
		stop = () => supervisor.stopAll();

		await expect(supervisor.activate(target.sessionHandle)).resolves.toMatchObject({ state: "waiting_ui" });
		const requestId = `startup-future-editor-replacement-${target.nativeSessionId}`;
		const published = messages.filter(
			(message) => message.type === "extension_ui_request" && message.request.id === requestId,
		);
		expect(published).toHaveLength(1);
		expect(published[0]).toMatchObject({
			type: "extension_ui_request",
			request: { id: requestId, method: "editor", title: "Authoritative startup editor" },
		});
		expect(
			messages.some((message) => message.type === "extension_ui_closed" && message.requestId === requestId),
		).toBe(false);
		expect(counters).toEqual({ transfer: 2, adopt: 2, transferRelease: 0, leaseRelease: 0 });
		const initial = await supervisor.subscribe(target.sessionHandle);
		expect(initial).toMatchObject({
			type: "resync_required",
			snapshot: {
				pendingExtensionRequests: [
					expect.objectContaining({ id: requestId, title: "Authoritative startup editor" }),
				],
			},
		});
	});

	it("flushes the planned future startup sticky sequence without reapplying final-map eviction", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(
			target,
			activation.supervisorServices,
			messages,
			undefined,
			0,
			{ PI_WEB_FIXTURE_STICKY_COUNT: "3" },
			{ extensionStateMaxItems: 2 },
		);
		stop = () => supervisor.stopAll();

		await expect(supervisor.activate(target.sessionHandle)).resolves.toMatchObject({ state: "idle" });
		const stickyFrames = messages.filter(
			(message): message is Extract<CanonicalSupervisorMessage, { type: "extension_ui_request" }> =>
				message.type === "extension_ui_request" && message.request.method === "setStatus",
		);
		expect(stickyFrames.map((frame) => frame.request)).toEqual([
			expect.objectContaining({ statusKey: "status-0", statusText: "value-0" }),
			expect.objectContaining({ statusKey: "status-1", statusText: "value-1" }),
			expect.objectContaining({ statusKey: "status-0", statusText: undefined }),
			expect.objectContaining({ statusKey: "status-2", statusText: "value-2" }),
		]);
		const initial = await supervisor.subscribe(target.sessionHandle);
		expect(initial).toMatchObject({
			type: "resync_required",
			snapshot: {
				stickyExtensionState: [
					expect.objectContaining({ statusKey: "status-1", statusText: "value-1" }),
					expect.objectContaining({ statusKey: "status-2", statusText: "value-2" }),
				],
			},
		});
	});

	it("rejects the second 33 MiB startup editor before transfer when combined logical state exceeds 64 MiB", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const counters: ExtensionLeaseCounters = {
			transfer: 0,
			adopt: 0,
			transferRelease: 0,
			leaseRelease: 0,
		};
		const released: EpochStoredContentRef[] = [];
		const services: SessionRuntimePiPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer: logicalPairExtensionExternalizer(activation.externalizer, counters),
			async releaseHold(hold: EpochContentHold<EpochStoredContentRef>) {
				released.push(hold.ref);
			},
		});
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, services, messages, undefined, 3, {
			PI_WEB_FIXTURE_STARTUP_FUTURE_EDITOR_LOGICAL_PAIR: "1",
		});
		stop = () => supervisor.stopAll();

		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow("session_snapshot_overflow");
		await waitFor(() => released.length === 1 && counters.leaseRelease === 1, 10_000);
		expect(counters).toEqual({ transfer: 1, adopt: 1, transferRelease: 0, leaseRelease: 1 });
		expect(released).toHaveLength(1);
		expect(messages.filter((message) => message.type === "extension_ui_request")).toEqual([]);
		expect(supervisor.getPendingExtensionRequests(target.sessionHandle)).toEqual([]);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			state: "crashed",
			generation: 1,
			lastSeq: 0,
			error: "session_snapshot_overflow",
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 750));
		expect(supervisor.getRuntime(target.sessionHandle)?.generation).toBe(1);
		expect(released).toHaveLength(1);
	});

	it("releases a startup Extension transfer when semantic revision changes after prepare", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const counters: ExtensionLeaseCounters = {
			transfer: 0,
			adopt: 0,
			transferRelease: 0,
			leaseRelease: 0,
		};
		let beforeTransfer = () => {};
		const services: SessionRuntimePiPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer: instrumentExtensionExternalizer(activation.externalizer, counters, false, () =>
				beforeTransfer(),
			),
		});
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, services, messages, undefined, 3, {
			PI_WEB_FIXTURE_STARTUP_FUTURE_EDITOR: "1",
		});
		stop = () => supervisor.stopAll();
		beforeTransfer = () => {
			const runtime = exactRuntime(supervisor, target.sessionHandle);
			const revision = Reflect.get(runtime, "extensionSemanticRevision");
			if (typeof revision !== "number") throw new Error("startup semantic revision is unavailable");
			Reflect.set(runtime, "extensionSemanticRevision", revision + 1);
		};

		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow(
			"extension_semantic_operation_stale",
		);
		await waitFor(() => counters.transferRelease === 1);
		expect(counters).toEqual({ transfer: 1, adopt: 0, transferRelease: 1, leaseRelease: 0 });
		expect(messages.filter((message) => message.type === "extension_ui_request")).toEqual([]);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			state: "crashed",
			generation: 1,
			lastSeq: 0,
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 750));
		expect(supervisor.getRuntime(target.sessionHandle)?.generation).toBe(1);
	});

	it("filters a timed-out startup editor before ready and releases its hold only on stop", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const counters: ExtensionLeaseCounters = {
			transfer: 0,
			adopt: 0,
			transferRelease: 0,
			leaseRelease: 0,
		};
		const released: EpochStoredContentRef[] = [];
		const services: SessionRuntimePiPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer: instrumentExtensionExternalizer(activation.externalizer, counters),
			async releaseHold(hold: EpochContentHold<EpochStoredContentRef>) {
				released.push(hold.ref);
				await activation.supervisorServices.releaseHold(hold);
			},
		});
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, services, messages, undefined, 0, {
			PI_WEB_FIXTURE_READY_DELAY_MS: "500",
			PI_WEB_FIXTURE_STARTUP_FUTURE_EDITOR: "1",
			PI_WEB_FIXTURE_STARTUP_TIMEOUT_INPUT: "1",
			PI_WEB_FIXTURE_STARTUP_TIMEOUT_INPUT_MS: "20",
		});
		stop = () => supervisor.stopAll();

		await expect(supervisor.activate(target.sessionHandle)).resolves.toMatchObject({
			state: "waiting_ui",
			lastSeq: 1,
		});
		const requestFrames = messages.filter((message) => message.type === "extension_ui_request");
		expect(requestFrames).toHaveLength(1);
		expect(requestFrames[0]).toMatchObject({
			type: "extension_ui_request",
			request: { id: `startup-future-editor-${target.nativeSessionId}`, method: "editor" },
		});
		expect(messages.filter((message) => message.type === "extension_ui_closed")).toEqual([]);
		expect(supervisor.getPendingExtensionRequests(target.sessionHandle)).toEqual([
			expect.objectContaining({
				id: `startup-future-editor-${target.nativeSessionId}`,
				method: "editor",
			}),
		]);
		expect(counters).toEqual({ transfer: 1, adopt: 1, transferRelease: 0, leaseRelease: 1 });
		expect(generationOwnerRefs(exactRuntime(supervisor, target.sessionHandle))).toHaveLength(1);
		expect(released).toEqual([]);

		await supervisor.stop(target.sessionHandle);
		await waitFor(() => released.length === 1);
		expect(released).toHaveLength(1);
		expect(counters).toEqual({ transfer: 1, adopt: 1, transferRelease: 0, leaseRelease: 1 });
	});

	it("retains an awaiting-response leased blocking request through the identity transition", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const counters: ExtensionLeaseCounters = {
			transfer: 0,
			adopt: 0,
			transferRelease: 0,
			leaseRelease: 0,
		};
		const services: SessionRuntimePiPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer: instrumentExtensionExternalizer(activation.externalizer, counters),
		});
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, services, messages, undefined, 3, {
			PI_WEB_FIXTURE_TRANSITION_FUTURE_EDITOR: "1",
		});
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		const result = await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "future-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		expect(result.sessionHandle).not.toBe(target.sessionHandle);
		expect(supervisor.getRuntime(result.sessionHandle)).toMatchObject({ state: "waiting_ui" });
		expect(supervisor.getPendingExtensionRequests(result.sessionHandle)).toContainEqual(
			expect.objectContaining({
				id: `transition-future-editor-${target.nativeSessionId}`,
				method: "editor",
				prefill: expect.objectContaining({ type: "external_text" }),
			}),
		);
		expect(messages).toContainEqual(
			expect.objectContaining({
				type: "extension_ui_request",
				request: expect.objectContaining({ id: `transition-future-editor-${target.nativeSessionId}` }),
			}),
		);
		expect(counters.adopt).toBe(1);
		expect(counters.transferRelease).toBe(0);
	});

	it("retains a leased editor delivered during transition verification", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const counters: ExtensionLeaseCounters = {
			transfer: 0,
			adopt: 0,
			transferRelease: 0,
			leaseRelease: 0,
		};
		const services: SessionRuntimePiPayloadServices = Object.freeze({
			...activation.supervisorServices,
			externalizer: instrumentExtensionExternalizer(activation.externalizer, counters),
		});
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, services, messages, undefined, 3, {
			PI_WEB_FIXTURE_TRANSITION_VERIFYING_FUTURE_EDITOR: "1",
		});
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future runtime was not activated");
		const result = await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "future-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		expect(result.sessionHandle).not.toBe(target.sessionHandle);
		expect(messages.filter((message) => message.type === "session_rekeyed")).toHaveLength(1);
		expect(supervisor.getPendingExtensionRequests(result.sessionHandle)).toContainEqual(
			expect.objectContaining({
				id: `transition-verifying-future-editor-${target.nativeSessionId}-clone`,
				method: "editor",
				prefill: expect.objectContaining({ type: "external_text" }),
			}),
		);
		expect(counters.adopt).toBe(1);
		expect(counters.transferRelease).toBe(0);
	});

	it("keeps startup history, ordinary responses, replay, and snapshots in the private future family", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-runtime-"));
		const target = createTarget(root);
		store = new EpochContentStore({ webDataDir: path.join(root, "web-data"), serverEpoch: "future-epoch" });
		await store.initialize();
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, activation.supervisorServices, messages);
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
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, activation.supervisorServices, messages);
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
		const activation = createGatewayPayloadActivation(store, "future-epoch");
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(target, activation.supervisorServices, messages);
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
		const activation = createGatewayPayloadActivation(exactStore, "future-epoch");
		const oversized = oversizedHistoryLease();
		expect(oversized.refs.every((ref) => ref.byteLength < 48 * 1024 * 1024)).toBe(true);
		expect(oversized.refs.reduce((total, ref) => total + ref.byteLength, 0)).toBeGreaterThan(
			64 * 1024 * 1024,
		);
		let historyResponses = 0;
		const externalizer: PiHostPayloadExternalizer = Object.freeze({
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
		const messages: CanonicalSupervisorMessage[] = [];
		const supervisor = createSupervisorFixture(
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
