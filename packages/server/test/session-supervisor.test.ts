import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
	ExtensionUiRequestDto,
	HotRuntimeInventoryDto,
	SessionAttachmentRefDto,
	SessionCommandResponseDto,
	SessionRuntimeIdentityDto,
} from "@pi-agent-web/protocol";
import { SESSION_SNAPSHOT_MAX_BYTES } from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpochContentHold, EpochStoredContentRef } from "../src/epoch-content-store.js";
import { canonicalizeSessionFile, sessionHandleForFile } from "../src/native-session-catalog.js";
import type { PiHostAdapter, PiHostDecodeOutcome } from "../src/pi-host-adapter.js";
import type { PiPayloadLease, PiPayloadLeaseTransfer } from "../src/pi-payload-externalizer.js";
import { piRpcAdapter } from "../src/pi-rpc-adapter.js";
import { SessionLiveProjection, type SessionLiveProjectionLimits } from "../src/session-live-projection.js";
import type {
	SessionIdentityTransitionCommit,
	SessionRuntime,
	SessionRuntimePiPayloadServices,
} from "../src/session-runtime.js";
import { createSessionRuntimePiPayloadServices } from "../src/session-runtime.js";
import type {
	ExistingSessionTarget,
	SessionRuntimeSnapshot,
	SessionSupervisorMessage,
} from "../src/session-runtime-types.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { createCanonicalPayloadFixture } from "./helpers/canonical-payload.js";

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

function appendLargeNativeHistory(target: ExistingSessionTarget, count: number, textBytes: number): void {
	let parentId: string | null = null;
	const text = "h".repeat(textBytes);
	for (let index = 0; index < count; index += 1) {
		const id = `history-entry-${String(index)}`;
		fs.appendFileSync(
			target.sessionFile,
			`${JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: "2026-08-20T00:00:00.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: `${String(index)}:${text}` }],
					timestamp: index + 1,
				},
			})}\n`,
		);
		parentId = id;
	}
}

function appendNativeHistoryEntry(target: ExistingSessionTarget, index: number, textBytes: number): void {
	const id = `history-entry-${String(index)}`;
	const parentId = index > 0 ? `history-entry-${String(index - 1)}` : null;
	fs.appendFileSync(
		target.sessionFile,
		`${JSON.stringify({
			type: "message",
			id,
			parentId,
			timestamp: "2026-08-20T00:00:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: `${String(index)}:${"h".repeat(textBytes)}` }],
				timestamp: index + 1,
			},
		})}\n`,
	);
}

function messageTextFragments(value: unknown): string[] {
	if (typeof value !== "object" || value === null) return [];
	const content = Reflect.get(value, "content");
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((item) => {
		if (typeof item !== "object" || item === null || Reflect.get(item, "type") !== "text") return [];
		const text = Reflect.get(item, "text");
		return typeof text === "string" ? [text] : [];
	});
}

function createHarness(options: {
	targets: ExistingSessionTarget[];
	onBroadcast?: (message: SessionSupervisorMessage) => void;
	onHotRuntimeInventory?: (inventory: HotRuntimeInventoryDto) => void;
	maxHotProcesses?: number;
	maxHotRuntimes?: number;
	maxRetainedProjectionBytes?: number;
	replayLimit?: number;
	replayMaxBytes?: number;
	transientBufferMaxBytes?: number;
	extensionStateMaxBytes?: number;
	extensionStateMaxItems?: number;
	pendingDialogLimit?: number;
	maxPendingCommands?: number;
	projectionLimits?: Partial<SessionLiveProjectionLimits>;
	restartBaseDelayMs?: number;
	maxAutoRestarts?: number;
	idleTtlMs?: number;
	transientIdleTtlMs?: number;
	env?: Record<string, string>;
	envForWorkspace?: (cwd: string) => Record<string, string>;
	commandTimeoutFor?: (commandType: string) => number;
	adapter?: PiHostAdapter;
	piPayloadServices?: SessionRuntimePiPayloadServices;
}) {
	const messages: SessionSupervisorMessage[] = [];
	const targets = new Map(options.targets.map((target) => [target.sessionHandle, target]));
	const adapter = options.adapter ?? piRpcAdapter;
	const supervisor = new SessionSupervisor({
		serverEpoch: "session-supervisor-test-epoch",
		resolved: {
			command: process.execPath,
			args: [fixturePath],
			source: "pi-path",
			label: "session runtime fixture",
			adapter,
			version: "0.84.2",
			adapterId: "pi-rpc",
			compatibilityStatus: "current",
			capabilities: adapter.capabilities,
		},
		env: options.env,
		envForWorkspace: options.envForWorkspace,
		resolveSession: async (sessionHandle) => targets.get(sessionHandle),
		broadcast: (message) => {
			messages.push(message);
			options.onBroadcast?.(message);
		},
		onHotRuntimeInventory: options.onHotRuntimeInventory,
		...(options.maxHotProcesses !== undefined
			? { maxHotProcesses: options.maxHotProcesses }
			: { maxHotRuntimes: options.maxHotRuntimes ?? 8 }),
		maxRetainedProjectionBytes: options.maxRetainedProjectionBytes,
		replayLimit: options.replayLimit ?? 32,
		replayMaxBytes: options.replayMaxBytes,
		transientBufferMaxBytes: options.transientBufferMaxBytes,
		extensionStateMaxBytes: options.extensionStateMaxBytes,
		extensionStateMaxItems: options.extensionStateMaxItems,
		pendingDialogLimit: options.pendingDialogLimit,
		maxPendingCommands: options.maxPendingCommands,
		projectionLimits: options.projectionLimits,
		piPayloadServices:
			options.piPayloadServices ??
			createCanonicalPayloadFixture("session-supervisor-test-epoch").supervisorServices,
		commandTimeoutFor: options.commandTimeoutFor,
		restartBaseDelayMs: options.restartBaseDelayMs ?? 5,
		maxAutoRestarts: options.maxAutoRestarts,
		readyTimeoutMs: 2_000,
		idleTtlMs: options.idleTtlMs ?? 60_000,
		transientIdleTtlMs: options.transientIdleTtlMs,
	});
	supervisors.push(supervisor);
	return { supervisor, messages, targets };
}

function exactRuntimeObject(supervisor: SessionSupervisor, sessionHandle: string): object {
	const runtimes: unknown = Reflect.get(supervisor, "runtimes");
	if (!(runtimes instanceof Map)) throw new Error("Supervisor runtime pool is unavailable");
	const runtime: unknown = runtimes.get(sessionHandle);
	if (typeof runtime !== "object" || runtime === null) throw new Error("Session Runtime is unavailable");
	return runtime;
}

function deliverExtension(runtime: object, request: ExtensionUiRequestDto): void {
	const processToken: unknown = Reflect.get(runtime, "processToken");
	const proc: unknown = Reflect.get(runtime, "proc");
	const handler: unknown = Reflect.get(runtime, "prepareDecodedExtensionRequest");
	if (
		typeof processToken !== "number" ||
		typeof proc !== "object" ||
		proc === null ||
		typeof handler !== "function"
	) {
		throw new Error("Runtime Extension delivery seam is unavailable");
	}
	const exactPlan = Object.freeze({ kind: "pi_decoded_delivery_plan" as const });
	let commitPrepared: ((transfer: PiPayloadLeaseTransfer<EpochStoredContentRef> | null) => true) | undefined;
	const delivery = {
		value: request,
		prepare(commit: (transfer: PiPayloadLeaseTransfer<EpochStoredContentRef> | null) => true) {
			commitPrepared = commit;
			return exactPlan;
		},
	};
	if (Reflect.apply(handler, runtime, [processToken, proc, delivery]) !== exactPlan || !commitPrepared) {
		throw new Error("Runtime Extension delivery was not prepared exactly");
	}
	const transfer: PiPayloadLeaseTransfer<EpochStoredContentRef> = Object.freeze({
		refs: Object.freeze([]),
		adopt(accept: Parameters<PiPayloadLeaseTransfer<EpochStoredContentRef>["adopt"]>[0]) {
			if (accept(Object.freeze([])) !== true) throw new Error("Empty Extension transfer adoption failed");
		},
		async release() {},
	});
	commitPrepared(transfer);
}

function runtimeMap(runtime: object, key: "pendingDialogs" | "stickyExtension"): Map<unknown, unknown> {
	const value: unknown = Reflect.get(runtime, key);
	if (!(value instanceof Map)) throw new Error(`Runtime ${key} map is unavailable`);
	return value;
}

function runtimeProjection(runtime: object): SessionLiveProjection {
	const projection: unknown = Reflect.get(runtime, "liveProjection");
	if (!(projection instanceof SessionLiveProjection)) throw new Error("Runtime projection is unavailable");
	return projection;
}

function runtimeSemanticWaterline(runtime: object): {
	projectionAsOfSeq: number;
	runtimeLastSeq: number;
	replayLastSeq: number;
} {
	const runtimeLastSeq: unknown = Reflect.get(runtime, "lastSeq");
	const replay: unknown = Reflect.get(runtime, "replay");
	if (typeof runtimeLastSeq !== "number" || !Array.isArray(replay)) {
		throw new Error("Runtime semantic waterline is unavailable");
	}
	const replayTail: unknown = replay.at(-1);
	const replayLastSeq =
		typeof replayTail === "object" &&
		replayTail !== null &&
		typeof Reflect.get(replayTail, "seq") === "number"
			? Reflect.get(replayTail, "seq")
			: 0;
	return {
		projectionAsOfSeq: runtimeProjection(runtime).snapshot().asOfSeq,
		runtimeLastSeq,
		replayLastSeq,
	};
}

function expireDialogEntry(runtime: object, requestId: string, entry: unknown): void {
	const processToken: unknown = Reflect.get(runtime, "processToken");
	const expire: unknown = Reflect.get(runtime, "expireDialog");
	if (typeof processToken !== "number" || typeof expire !== "function") {
		throw new Error("Runtime dialog expiry seam is unavailable");
	}
	Reflect.apply(expire, runtime, [processToken, requestId, entry]);
}

function attachmentRef(sha256: string): SessionAttachmentRefDto {
	return Object.freeze({
		type: "attachment_ref",
		serverEpoch: "session-supervisor-test-epoch",
		sha256,
		mediaType: "image/png",
		byteLength: 4,
	});
}

function trackedLease(
	ref: SessionAttachmentRefDto,
	tracking: {
		adopted: EpochContentHold<EpochStoredContentRef>[][];
		released: EpochContentHold<EpochStoredContentRef>[];
	},
	holdRef: SessionAttachmentRefDto = ref,
): { hold: EpochContentHold<SessionAttachmentRefDto>; lease: PiPayloadLease<EpochStoredContentRef> } {
	const hold: EpochContentHold<SessionAttachmentRefDto> = Object.freeze({ ref: holdRef });
	let state: "pending" | "transferred" | "adopted" | "released" = "pending";
	const lease: PiPayloadLease<EpochStoredContentRef> = Object.freeze({
		refs: Object.freeze([ref]),
		transfer() {
			if (state !== "pending") throw new Error("test lease is not pending");
			state = "transferred";
			return Object.freeze({
				refs: Object.freeze([ref]),
				adopt(accept: Parameters<ReturnType<PiPayloadLease<EpochStoredContentRef>["transfer"]>["adopt"]>[0]) {
					if (state !== "transferred") throw new Error("test transfer is not pending");
					if (accept([hold]) !== true) throw new Error("test transfer adoption was rejected");
					tracking.adopted.push([hold]);
					state = "adopted";
				},
				async release() {
					if (state !== "transferred") return;
					state = "released";
					tracking.released.push(hold);
				},
			});
		},
		async release() {
			if (state !== "pending") return;
			state = "released";
			tracking.released.push(hold);
		},
	});
	return { hold, lease };
}

function rejectingTransferLease(
	ref: SessionAttachmentRefDto,
	tracking: { transferReleaseAttempts: number },
): PiPayloadLease<EpochStoredContentRef> {
	let state: "pending" | "transferred" = "pending";
	return Object.freeze({
		refs: Object.freeze([ref]),
		transfer() {
			if (state !== "pending") throw new Error("test lease is not pending");
			state = "transferred";
			return Object.freeze({
				refs: Object.freeze([ref]),
				adopt() {
					throw new Error("stale test transfer must not be adopted");
				},
				async release() {
					tracking.transferReleaseAttempts += 1;
					throw new Error("fixture stale transfer release failed");
				},
			});
		},
		async release() {
			throw new Error("transferred test lease cannot be released directly");
		},
	});
}

function testPayloadServices(
	released: EpochContentHold<EpochStoredContentRef>[],
): SessionRuntimePiPayloadServices {
	const fixture = createCanonicalPayloadFixture("session-supervisor-test-epoch");
	return createSessionRuntimePiPayloadServices({
		externalizer: fixture.externalizer,
		productSchema: fixture.supervisorServices.productSchema,
		releaseHold: async (entry) => {
			released.push(entry);
		},
	});
}

function startupBaseAdapter(
	ref: SessionAttachmentRefDto,
	lease: PiPayloadLease<EpochStoredContentRef>,
): PiHostAdapter {
	let attached = false;
	return {
		...piRpcAdapter,
		async decodeResponse(value, expectedCommand, context) {
			const outcome = await piRpcAdapter.decodeResponse(value, expectedCommand, context);
			if (expectedCommand !== "get_messages" || attached || outcome.value.success !== true) {
				return outcome;
			}
			attached = true;
			const decoded: PiHostDecodeOutcome<SessionCommandResponseDto & { id: string }> = {
				value: {
					type: "response",
					id: outcome.value.id,
					command: "get_messages",
					success: true,
					data: {
						messages: [
							{
								role: "user",
								content: [{ type: "image", data: ref, mimeType: "image/png" }],
								timestamp: 1,
							},
						],
					},
				},
				lease,
			};
			return decoded;
		},
		decodeUnsolicited(value, context) {
			return piRpcAdapter.decodeUnsolicited(value, context);
		},
	};
}

function transitionPayloadAdapter(input: {
	parentBase?: {
		hold: EpochContentHold<SessionAttachmentRefDto>;
		lease: PiPayloadLease<EpochStoredContentRef>;
	};
	childBase?: {
		hold: EpochContentHold<SessionAttachmentRefDto>;
		lease: PiPayloadLease<EpochStoredContentRef>;
	};
	staged?: { hold: EpochContentHold<SessionAttachmentRefDto>; lease: PiPayloadLease<EpochStoredContentRef> };
	stagedInvalid?: {
		hold: EpochContentHold<SessionAttachmentRefDto>;
		lease: PiPayloadLease<EpochStoredContentRef>;
	};
	postRekey?: {
		hold: EpochContentHold<SessionAttachmentRefDto>;
		lease: PiPayloadLease<EpochStoredContentRef>;
	};
}): PiHostAdapter {
	let getMessagesCount = 0;
	return {
		...piRpcAdapter,
		async decodeResponse(value, expectedCommand, context) {
			const outcome = await piRpcAdapter.decodeResponse(value, expectedCommand, context);
			if (expectedCommand !== "get_messages" || outcome.value.success !== true) return outcome;
			getMessagesCount += 1;
			const attachment = getMessagesCount === 1 ? input.parentBase : input.childBase;
			if (!attachment) return outcome;
			return {
				value: {
					type: "response" as const,
					id: outcome.value.id,
					command: "get_messages" as const,
					success: true as const,
					data: {
						messages: [
							{
								role: "user" as const,
								content: [
									{
										type: "image" as const,
										data: attachment.hold.ref,
										mimeType: "image/png" as const,
									},
								],
								timestamp: getMessagesCount,
							},
						],
					},
				},
				lease: attachment.lease,
			};
		},
		async decodeUnsolicited(value, context) {
			const outcome = await piRpcAdapter.decodeUnsolicited(value, context);
			if (outcome.value.kind !== "event" || outcome.value.event.type !== "message_end") {
				return outcome;
			}
			const message = outcome.value.event.message;
			const marker =
				message.role === "user" && Array.isArray(message.content) && message.content[0]?.type === "text"
					? message.content[0].text
					: null;
			const attachment =
				marker === "transition-staged-ref"
					? input.staged
					: marker === "transition-staged-invalid-ref"
						? input.stagedInvalid
						: marker === "transition-post-rekey-ref"
							? input.postRekey
							: undefined;
			if (!attachment) return outcome;
			return {
				value: {
					kind: "event" as const,
					event: {
						type: "message_end" as const,
						message: {
							role: "user" as const,
							content: [
								{
									type: "image" as const,
									data: attachment.hold.ref,
									mimeType: "image/png" as const,
								},
							],
							timestamp: message.timestamp,
						},
					},
				},
				lease: attachment.lease,
			};
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition did not settle before timeout");
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition did not settle before timeout");
}

function trackRuntimeDeadlines(delayMs = 500): {
	timers: Set<ReturnType<typeof setTimeout>>;
	nativeSetTimeout: typeof setTimeout;
	restore: () => void;
} {
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const nativeSetTimeout = globalThis.setTimeout;
	const nativeClearTimeout = globalThis.clearTimeout;
	const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: (...args: unknown[]) => void,
		delay?: number,
		...args: unknown[]
	) => {
		let timer: ReturnType<typeof setTimeout>;
		timer = nativeSetTimeout(
			(...callbackArgs: unknown[]) => {
				timers.delete(timer);
				callback(...callbackArgs);
			},
			delay,
			...args,
		);
		if (delay === delayMs) timers.add(timer);
		return timer;
	}) as typeof setTimeout);
	const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
		timer: ReturnType<typeof setTimeout>,
	) => {
		timers.delete(timer);
		return nativeClearTimeout(timer);
	}) as typeof clearTimeout);
	return {
		timers,
		nativeSetTimeout,
		restore: () => {
			clearTimeoutSpy.mockRestore();
			setTimeoutSpy.mockRestore();
		},
	};
}

afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SessionSupervisor", () => {
	it("publishes strictly revisioned full inventories for hot lifecycle and operational states", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "hot-inventory-b");
		const second = createNativeSession(root, cwd, "hot-inventory-a");
		const inventories: HotRuntimeInventoryDto[] = [];
		const { supervisor } = createHarness({
			targets: [first, second],
			env: { PI_WEB_FIXTURE_READY_DELAY_MS: "80" },
			onHotRuntimeInventory: (inventory) => inventories.push(inventory),
		});

		expect(supervisor.getHotRuntimeInventory()).toEqual({
			type: "hot_runtime_inventory",
			serverEpoch: supervisor.serverEpoch,
			revision: 0,
			runtimes: [],
		});
		const activating = Promise.all([
			supervisor.activate(first.sessionHandle),
			supervisor.activate(second.sessionHandle),
		]);
		await waitFor(() =>
			inventories.some((inventory) => inventory.runtimes.some((entry) => entry.state === "starting")),
		);
		await activating;
		await waitFor(() =>
			supervisor.getHotRuntimeInventory().runtimes.every((entry) => entry.state === "idle"),
		);

		const current = supervisor.getHotRuntimeInventory();
		expect(current.runtimes.map((entry) => entry.sessionHandle)).toEqual(
			[first.sessionHandle, second.sessionHandle].sort(),
		);
		expect(new Set(current.runtimes.map((entry) => entry.sessionHandle)).size).toBe(2);
		expect(current.runtimes.every((entry) => entry.serverEpoch === supervisor.serverEpoch)).toBe(true);
		expect(inventories.every((inventory) => inventory.runtimes.length <= 2)).toBe(true);
		expect(inventories.map((inventory) => inventory.revision)).toEqual(
			inventories.map((_, index) => index + 1),
		);

		const lease = await supervisor.claim(first.sessionHandle, "hot-controller");
		const before = supervisor.getRuntime(first.sessionHandle)!;
		await supervisor.sendCommand(
			first.sessionHandle,
			{ type: "prompt", message: "open-dialog-no-agent" },
			{
				connectionId: "hot-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() =>
			supervisor
				.getHotRuntimeInventory()
				.runtimes.some(
					(entry) => entry.sessionHandle === first.sessionHandle && entry.state === "waiting_ui",
				),
		);

		const internal = supervisor as unknown as { runtimes: Map<string, SessionRuntime> };
		const firstRuntime = internal.runtimes.get(first.sessionHandle)!;
		const ownedProcess = (firstRuntime as unknown as { proc: { stop: () => Promise<void> } | null }).proc;
		if (!ownedProcess) throw new Error("hot Runtime did not own its Pi process");
		const originalProcessStop = ownedProcess.stop.bind(ownedProcess);
		let releaseProcessStop: (() => void) | undefined;
		const processStopGate = new Promise<void>((resolve) => {
			releaseProcessStop = resolve;
		});
		ownedProcess.stop = async () => {
			await processStopGate;
			await originalProcessStop();
		};
		const stopping = supervisor.stop(first.sessionHandle);
		await waitFor(
			() =>
				!supervisor
					.getHotRuntimeInventory()
					.runtimes.some((entry) => entry.sessionHandle === first.sessionHandle),
		);
		expect(firstRuntime.running).toBe(true);
		releaseProcessStop?.();
		await stopping;
		await supervisor.restart(first.sessionHandle);
		await waitFor(() =>
			supervisor
				.getHotRuntimeInventory()
				.runtimes.some(
					(entry) => entry.sessionHandle === first.sessionHandle && entry.generation > before.generation,
				),
		);
		const restarted = supervisor.getRuntime(first.sessionHandle)!;
		await supervisor.sendCommand(
			first.sessionHandle,
			{ type: "prompt", message: "slow" },
			{
				connectionId: "hot-controller",
				expectedGeneration: restarted.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() =>
			supervisor
				.getHotRuntimeInventory()
				.runtimes.some((entry) => entry.sessionHandle === first.sessionHandle && entry.state === "running"),
		);
		await waitFor(() => supervisor.getRuntime(first.sessionHandle)?.state === "idle");
		await supervisor.stopAll();
		expect(supervisor.getHotRuntimeInventory().runtimes).toEqual([]);
		expect(inventories.map((inventory) => inventory.revision)).toEqual(
			inventories.map((_, index) => index + 1),
		);
	});

	it("publishes rekey, crash, eviction, and unpersisted hot membership without duplicates", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const persisted = createNativeSession(root, cwd, "hot-evicted");
		const crash = createNativeSession(root, cwd, "hot-crash");
		const crashMarker = path.join(root, "crash.marker");
		const inventories: HotRuntimeInventoryDto[] = [];
		const { supervisor } = createHarness({
			targets: [persisted, crash],
			maxHotRuntimes: 1,
			maxAutoRestarts: 0,
			env: { PI_WEB_FIXTURE_CRASH_MARKER: crashMarker },
			onHotRuntimeInventory: (inventory) => inventories.push(inventory),
		});

		await supervisor.activate(persisted.sessionHandle);
		await waitFor(() =>
			inventories.some((inventory) =>
				inventory.runtimes.some((entry) => entry.sessionHandle === persisted.sessionHandle),
			),
		);
		await supervisor.activate(crash.sessionHandle);
		await waitFor(() =>
			supervisor
				.getHotRuntimeInventory()
				.runtimes.some((entry) => entry.sessionHandle === crash.sessionHandle),
		);
		expect(supervisor.getHotRuntimeInventory().runtimes).toHaveLength(1);
		expect(supervisor.getHotRuntimeInventory().runtimes[0]?.sessionHandle).toBe(crash.sessionHandle);

		const lease = await supervisor.claim(crash.sessionHandle, "crash-controller");
		const active = supervisor.getRuntime(crash.sessionHandle)!;
		await supervisor.sendCommand(
			crash.sessionHandle,
			{ type: "prompt", message: "crash-once" },
			{
				connectionId: "crash-controller",
				expectedGeneration: active.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(crash.sessionHandle)?.state === "crashed");
		await waitFor(() => supervisor.getHotRuntimeInventory().runtimes.length === 0);

		const revisionBeforeCreate = supervisor.getHotRuntimeInventory().revision;
		const inventoryCountBeforeCreate = inventories.length;
		const created = await supervisor.createSession({
			workspaceId: "workspace-new",
			cwd,
			sessionDir: path.join(root, "new-sessions"),
			requestedNativeSessionId: "hot-unpersisted",
		});
		await waitFor(() =>
			supervisor
				.getHotRuntimeInventory()
				.runtimes.some((entry) => entry.sessionHandle === created.sessionHandle),
		);
		expect(created.recoverable).toBe(false);
		const inventoriesAfterCreate = inventories.slice(inventoryCountBeforeCreate);
		expect(
			inventoriesAfterCreate.some((inventory) =>
				inventory.runtimes.some((entry) => entry.sessionHandle.startsWith("pending_")),
			),
		).toBe(false);
		const canonicalInventory = inventoriesAfterCreate.find((inventory) =>
			inventory.runtimes.some((entry) => entry.sessionHandle === created.sessionHandle),
		);
		expect(canonicalInventory?.revision).toBe(revisionBeforeCreate + 1);
		expect(
			inventories.every(
				(inventory) =>
					new Set(inventory.runtimes.map((entry) => entry.sessionHandle)).size === inventory.runtimes.length,
			),
		).toBe(true);
		expect(
			inventories.some(
				(inventory) =>
					inventory.runtimes.length === 1 &&
					inventory.runtimes[0]?.sessionHandle === created.sessionHandle &&
					inventory.runtimes[0].state === "idle",
			),
		).toBe(true);
	});

	it("subscribes to one exact hot incarnation without alias resolution or process activation", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "hot-exact");
		const lifecycleMarker = path.join(root, "lifecycle.log");
		const { supervisor } = createHarness({
			targets: [target],
			env: {
				PI_WEB_FIXTURE_LIFECYCLE_MARKER: lifecycleMarker,
				PI_WEB_FIXTURE_READY_DELAY_MS: "80",
			},
		});
		const expected: SessionRuntimeIdentityDto = {
			serverEpoch: supervisor.serverEpoch,
			sessionHandle: target.sessionHandle,
			workspaceId: target.workspaceId,
			generation: 1,
		};

		await expect(supervisor.subscribeHotExact(expected)).rejects.toThrow("hot_runtime_not_found");
		expect(fs.existsSync(lifecycleMarker)).toBe(false);
		const activating = supervisor.activate(target.sessionHandle);
		await waitFor(() => supervisor.getHotRuntimeInventory().runtimes[0]?.state === "starting");
		await expect(
			supervisor.subscribeHotExact(supervisor.getHotRuntimeInventory().runtimes[0]!),
		).rejects.toThrow("session_snapshot_unavailable");
		await activating;
		const hot = supervisor.getHotRuntimeInventory().runtimes[0]!;
		await expect(supervisor.subscribeHotExact({ ...hot, generation: hot.generation + 1 })).rejects.toThrow(
			"hot_runtime_identity_changed",
		);
		await expect(supervisor.subscribeHotExact({ ...hot, workspaceId: "workspace-other" })).rejects.toThrow(
			"hot_runtime_identity_changed",
		);
		await expect(
			supervisor.subscribeHotExact(hot, {
				serverEpoch: "stale-epoch",
				generation: hot.generation,
				seq: 0,
			}),
		).resolves.toMatchObject({ type: "resync_required", reason: "server_epoch_changed" });
		const startsBeforeStop = fs.readFileSync(lifecycleMarker, "utf8").match(/^start:/gm)?.length ?? 0;

		await supervisor.stop(target.sessionHandle);
		await expect(supervisor.subscribeHotExact(hot)).rejects.toThrow("hot_runtime_not_found");
		const startsAfterExactSubscribe =
			fs.readFileSync(lifecycleMarker, "utf8").match(/^start:/gm)?.length ?? 0;
		expect(startsAfterExactSubscribe).toBe(startsBeforeStop);
		await expect(
			supervisor.subscribeHotExact({ ...hot, sessionHandle: `pending_${hot.sessionHandle}` }),
		).rejects.toThrow("hot_runtime_not_found");
	});

	it("coalesces duplicate snapshot builds within one runtime turn", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "snapshot-coalesce");
		const { supervisor } = createHarness({ targets: [target] });
		await supervisor.activate(target.sessionHandle);
		const runtime = exactRuntimeObject(supervisor, target.sessionHandle) as SessionRuntime;
		const internal = runtime as unknown as { buildSessionSnapshot: () => unknown };
		const build = vi.spyOn(internal, "buildSessionSnapshot");
		const lifecycle = runtime as unknown as { onSnapshotBuild: () => void };
		const observation = vi.spyOn(lifecycle, "onSnapshotBuild");

		const first = runtime.sessionSnapshot();
		const second = runtime.sessionSnapshot();

		expect(build).toHaveBeenCalledTimes(1);
		expect(observation).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(runtime.sessionSnapshot()).toBe(first);
		expect(build).toHaveBeenCalledTimes(1);
		expect(observation).toHaveBeenCalledTimes(1);

		const lease = await supervisor.claim(target.sessionHandle, "snapshot-controller");
		const generation = runtime.generation;
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "open-dialog-no-agent" },
			{
				connectionId: "snapshot-controller",
				expectedGeneration: generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() =>
			runtime.getPendingExtensionRequests().some((request) => request.method === "confirm"),
		);
		const beforeClose = runtime.sessionSnapshot();
		const buildsBeforeClose = build.mock.calls.length;
		const dialog = runtime.getPendingExtensionRequests().find((request) => request.method === "confirm");
		if (!dialog || !("id" in dialog)) throw new Error("snapshot cache dialog unavailable");
		expect(
			runtime.sendExtensionUiResponse({ type: "extension_ui_response", id: dialog.id, cancelled: true }),
		).toBe("accepted");
		const afterClose = runtime.sessionSnapshot();
		expect(afterClose).not.toBe(beforeClose);
		expect(build).toHaveBeenCalledTimes(buildsBeforeClose + 1);
		expect(observation).toHaveBeenCalledTimes(buildsBeforeClose + 1);
	});

	it("revalidates exact process ownership after capturing the replay baseline", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "hot-exact-race");
		const { supervisor } = createHarness({ targets: [target] });
		await supervisor.activate(target.sessionHandle);
		const hot = supervisor.getHotRuntimeInventory().runtimes[0]!;
		const internal = supervisor as unknown as { runtimes: Map<string, SessionRuntime> };
		const runtime = internal.runtimes.get(target.sessionHandle)!;
		const originalReplay = runtime.getReplay.bind(runtime);
		runtime.getReplay = (...args) => {
			const baseline = originalReplay(...args);
			void runtime.stop();
			return baseline;
		};

		await expect(supervisor.subscribeHotExact(hot)).rejects.toThrow("hot_runtime_identity_changed");
	});

	it("hard caps configured hot Runtime capacity to the protocol inventory ceiling", () => {
		const { supervisor } = createHarness({ targets: [], maxHotRuntimes: 100_000 });
		const configured = supervisor as unknown as { opts: { maxHotRuntimes: number } };
		expect(configured.opts.maxHotRuntimes).toBe(256);
	});

	it("builds generation zero from get_messages before committing buffered product domains", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "authoritative-startup");
		const { supervisor } = createHarness({
			targets: [target],
			env: { PI_WEB_FIXTURE_STARTUP_PROJECTION_DOMAINS: "1" },
		});

		const initial = await supervisor.subscribe(target.sessionHandle);
		expect(supervisor.serverEpoch).toBe("session-supervisor-test-epoch");
		expect(initial).toMatchObject({
			type: "resync_required",
			reason: "initial",
			runtime: { serverEpoch: supervisor.serverEpoch, lastSeq: 6 },
			snapshot: {
				serverEpoch: supervisor.serverEpoch,
				baseSeq: 0,
				asOfSeq: 6,
			},
		});
		if (initial.type !== "resync_required") throw new Error("initial subscription did not resync");
		expect(initial.snapshot.projectionEvents.map((frame) => frame.event.type)).toEqual([
			"agent_start",
			"message_update",
			"message_update",
			"tool_execution_start",
			"tool_execution_update",
		]);
		expect(initial.snapshot.pendingExtensionRequests).toEqual([
			expect.objectContaining({ id: "startup-domain-dialog", method: "confirm" }),
		]);

		const staleEpoch = await supervisor.subscribe(target.sessionHandle, {
			serverEpoch: "previous-server-epoch",
			generation: initial.runtime.generation,
			seq: initial.runtime.lastSeq,
		});
		expect(staleEpoch).toMatchObject({ type: "resync_required", reason: "server_epoch_changed" });
	});

	it("adopts a ref-bearing startup base into the exact active generation before publishing it", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "startup-owned-image");
		const exactRef = attachmentRef("a".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const tracking = { adopted, released };
		const { hold, lease } = trackedLease(exactRef, tracking);
		const adapter = startupBaseAdapter(exactRef, lease);
		const piPayloadServices = testPayloadServices(released);
		const { supervisor, messages } = createHarness({
			targets: [target],
			adapter,
			piPayloadServices,
			maxAutoRestarts: 0,
		});

		await expect(supervisor.activate(target.sessionHandle)).resolves.toMatchObject({ state: "idle" });
		const initial = await supervisor.subscribe(target.sessionHandle);
		expect(initial).toMatchObject({
			type: "resync_required",
			snapshot: {
				settledMessages: [
					expect.objectContaining({
						content: [expect.objectContaining({ data: exactRef })],
					}),
				],
			},
		});
		expect(adopted).toEqual([[hold]]);
		expect(released).toEqual([]);
		expect(
			messages.findIndex((message) => message.type === "runtime_state" && message.runtime.state === "idle"),
		).toBeGreaterThanOrEqual(0);
	});

	it("flushes an owner-held ref event buffered before the startup base through the trusted projection", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "startup-owned-event");
		const exactRef = attachmentRef("2".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const { hold, lease } = trackedLease(exactRef, { adopted, released });
		let attached = false;
		const adapter: PiHostAdapter = {
			...piRpcAdapter,
			decodeResponse(value, expectedCommand, context) {
				return piRpcAdapter.decodeResponse(value, expectedCommand, context);
			},
			async decodeUnsolicited(value, context) {
				const outcome = await piRpcAdapter.decodeUnsolicited(value, context);
				if (attached || outcome.value.kind !== "event" || outcome.value.event.type !== "agent_start") {
					return outcome;
				}
				attached = true;
				return {
					value: {
						kind: "event" as const,
						event: {
							type: "message_end" as const,
							message: {
								role: "user" as const,
								content: [{ type: "image" as const, data: exactRef, mimeType: "image/png" }],
								timestamp: 5,
							},
						},
					},
					lease,
				};
			},
		};
		const { supervisor } = createHarness({
			targets: [target],
			adapter,
			piPayloadServices: testPayloadServices(released),
			env: { PI_WEB_FIXTURE_STARTUP_PROJECTION_DOMAINS: "1" },
			maxAutoRestarts: 0,
		});

		await expect(supervisor.activate(target.sessionHandle)).resolves.toMatchObject({ state: "waiting_ui" });
		const initial = await supervisor.subscribe(target.sessionHandle);
		expect(initial).toMatchObject({
			type: "resync_required",
			snapshot: {
				projectionEvents: expect.arrayContaining([
					expect.objectContaining({
						event: expect.objectContaining({
							message: expect.objectContaining({
								content: [expect.objectContaining({ data: exactRef })],
							}),
						}),
					}),
				]),
			},
		});
		expect(adopted).toEqual([[hold]]);
		expect(released).toEqual([]);
	});

	it("keeps stop fenced until the active generation owner releases every adopted hold", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "owned-stop-fence");
		const exactRef = attachmentRef("e".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const { hold, lease } = trackedLease(exactRef, { adopted, released });
		let releaseGate!: () => void;
		const gated = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const services = testPayloadServices(released);
		const { supervisor } = createHarness({
			targets: [target],
			adapter: startupBaseAdapter(exactRef, lease),
			piPayloadServices: {
				...services,
				releaseHold: async (entry) => {
					released.push(entry);
					await gated;
				},
			},
			maxAutoRestarts: 0,
		});
		await supervisor.activate(target.sessionHandle);

		const stopping = supervisor.stop(target.sessionHandle);
		await expect(
			Promise.race([
				stopping.then(() => "stopped" as const),
				new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 20)),
			]),
		).resolves.toBe("waiting");
		expect(adopted).toEqual([[hold]]);
		expect(released).toEqual([hold]);
		releaseGate();
		await stopping;
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({ state: "dormant" });
	});

	it("blocks a replacement generation when active owner teardown fails", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "owned-stop-failure");
		const exactRef = attachmentRef("f".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const { lease } = trackedLease(exactRef, { adopted, released });
		const services = testPayloadServices(released);
		const { supervisor } = createHarness({
			targets: [target],
			adapter: startupBaseAdapter(exactRef, lease),
			piPayloadServices: {
				...services,
				releaseHold: async () => {
					throw new Error("fixture owner release failed");
				},
			},
			maxAutoRestarts: 0,
		});
		const before = await supervisor.activate(target.sessionHandle);

		await expect(supervisor.stop(target.sessionHandle)).rejects.toThrow("Session generation cleanup failed");
		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow(
			"generation_content_cleanup_failed",
		);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			generation: before.generation,
			error: "generation_content_cleanup_failed",
		});
	});

	it("retains a nonrecoverable crash projection and its holds until explicit stop", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const other = createNativeSession(root, cwd, "retained-budget-other");
		const exactRef = attachmentRef("c".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const { hold, lease } = trackedLease(exactRef, { adopted, released });
		const { supervisor } = createHarness({
			targets: [other],
			adapter: startupBaseAdapter(exactRef, lease),
			piPayloadServices: testPayloadServices(released),
			env: {
				PI_WEB_FIXTURE_CRASH_MARKER: path.join(root, "unpersisted-crash.marker"),
				PI_WEB_FIXTURE_SKIP_PROMPT_PERSIST: "1",
			},
			maxAutoRestarts: 0,
			maxRetainedProjectionBytes: SESSION_SNAPSHOT_MAX_BYTES,
		});
		const created = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "retained-nonrecoverable",
		});
		const controller = await supervisor.claim(created.sessionHandle, "controller");
		const internal = supervisor as unknown as { runtimes: Map<string, SessionRuntime> };
		const runtime = internal.runtimes.get(created.sessionHandle)!;
		const projection = (runtime as unknown as { liveProjection: { snapshot: () => unknown } }).liveProjection;
		const snapshotSpy = vi.spyOn(projection, "snapshot");

		await supervisor.sendCommand(
			created.sessionHandle,
			{ type: "prompt", message: "crash-once" },
			{
				connectionId: "controller",
				expectedGeneration: created.generation,
				fencingToken: controller.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(created.sessionHandle)?.state === "crashed");

		expect(supervisor.getRuntime(created.sessionHandle)).toMatchObject({
			state: "crashed",
			recoverable: false,
			generation: created.generation,
		});
		expect(adopted).toEqual([[hold]]);
		expect(released).toEqual([]);
		expect(snapshotSpy).not.toHaveBeenCalled();
		await expect(supervisor.activate(other.sessionHandle)).rejects.toThrow("session_projection_capacity");
		expect(released).toEqual([]);
		const retained = await supervisor.subscribe(created.sessionHandle);
		if (retained.type !== "resync_required") throw new Error("retained crash did not resync");
		expect(retained.snapshot).toMatchObject({
			generation: created.generation,
			runtime: { state: "crashed", recoverable: false },
			settledMessages: [
				expect.objectContaining({
					content: [expect.objectContaining({ data: exactRef })],
				}),
			],
		});
		if (!created.sessionFile) throw new Error("retained crash did not expose its candidate file");
		fs.mkdirSync(path.dirname(created.sessionFile), { recursive: true });
		fs.writeFileSync(
			created.sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: created.nativeSessionId,
				timestamp: "2026-08-20T00:00:00.000Z",
				cwd,
			})}\n`,
		);
		await expect(supervisor.restart(created.sessionHandle)).rejects.toThrow(
			"unpersisted_session_cannot_be_recovered",
		);
		expect(supervisor.getRuntime(created.sessionHandle)).toMatchObject({
			state: "crashed",
			recoverable: false,
			generation: created.generation,
		});
		expect(released).toEqual([]);

		await supervisor.stop(created.sessionHandle);
		expect(released).toEqual([hold]);
		expect(() => runtime.sessionSnapshot()).toThrow("session_snapshot_unavailable");
	});

	it("detaches a retain candidate when its crashed projection phase cannot be prepared", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const exactRef = attachmentRef("6".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const { hold, lease } = trackedLease(exactRef, { adopted, released });
		const { supervisor } = createHarness({
			targets: [],
			adapter: startupBaseAdapter(exactRef, lease),
			piPayloadServices: testPayloadServices(released),
			env: {
				PI_WEB_FIXTURE_CRASH_MARKER: path.join(root, "retain-phase-failure.marker"),
				PI_WEB_FIXTURE_SKIP_PROMPT_PERSIST: "1",
			},
			maxAutoRestarts: 0,
		});
		const created = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "retain-phase-failure",
		});
		const controller = await supervisor.claim(created.sessionHandle, "controller");
		const internal = supervisor as unknown as { runtimes: Map<string, SessionRuntime> };
		const runtime = internal.runtimes.get(created.sessionHandle)!;
		const projection = (
			runtime as unknown as {
				liveProjection: { setRuntimePhase: (identity: unknown, phase: string) => void };
			}
		).liveProjection;
		const originalSetRuntimePhase = projection.setRuntimePhase.bind(projection);
		const phaseSpy = vi.spyOn(projection, "setRuntimePhase").mockImplementation((identity, phase) => {
			if (phase === "crashed") throw new Error("fixture crashed projection phase failure");
			originalSetRuntimePhase(identity, phase);
		});

		await supervisor.sendCommand(
			created.sessionHandle,
			{ type: "prompt", message: "crash-once" },
			{
				connectionId: "controller",
				expectedGeneration: created.generation,
				fencingToken: controller.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(created.sessionHandle)?.state === "crashed");
		phaseSpy.mockRestore();

		expect(adopted).toEqual([[hold]]);
		expect(released).toEqual([hold]);
		expect(() => runtime.sessionSnapshot()).toThrow("session_snapshot_unavailable");
		expect(supervisor.getRuntime(created.sessionHandle)).toMatchObject({
			state: "crashed",
			recoverable: false,
			generation: created.generation,
		});
	});

	it("detaches an unpersisted startup projection after a terminal event decode failure", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const exactRef = attachmentRef("7".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const { hold, lease } = trackedLease(exactRef, { adopted, released });
		const base = startupBaseAdapter(exactRef, lease);
		let failEvents = false;
		const adapter: PiHostAdapter = {
			...base,
			async decodeUnsolicited(value, context) {
				const outcome = await base.decodeUnsolicited!(value, context);
				if (failEvents && outcome.value.kind === "event" && outcome.value.event.type === "agent_start") {
					throw new Error("fixture event payload storage failed");
				}
				return outcome;
			},
		};
		const { supervisor } = createHarness({
			targets: [],
			adapter,
			piPayloadServices: testPayloadServices(released),
			env: { PI_WEB_FIXTURE_SKIP_PROMPT_PERSIST: "1" },
			maxAutoRestarts: 0,
		});
		const created = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "event-storage-terminal",
		});
		const controller = await supervisor.claim(created.sessionHandle, "controller");
		const internal = supervisor as unknown as { runtimes: Map<string, SessionRuntime> };
		const runtime = internal.runtimes.get(created.sessionHandle)!;

		failEvents = true;
		void supervisor
			.sendCommand(
				created.sessionHandle,
				{ type: "prompt", message: "small-structural-turn" },
				{
					connectionId: "controller",
					expectedGeneration: created.generation,
					fencingToken: controller.fencingToken,
				},
			)
			.catch(() => {});
		await waitFor(() => supervisor.getRuntime(created.sessionHandle)?.state === "crashed");

		expect(adopted).toEqual([[hold]]);
		expect(released).toEqual([hold]);
		expect(() => runtime.sessionSnapshot()).toThrow("session_snapshot_unavailable");
		expect(supervisor.getRuntime(created.sessionHandle)).toMatchObject({
			state: "crashed",
			recoverable: false,
			generation: created.generation,
		});
		await expect(supervisor.restart(created.sessionHandle)).rejects.toThrow(
			"unpersisted_session_cannot_be_recovered",
		);
	});

	it("keeps a post-crash unverified Session nonrecoverable after its candidate file materializes", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const { supervisor } = createHarness({
			targets: [],
			env: {
				PI_WEB_FIXTURE_CRASH_MARKER: path.join(root, "default-off-crash.marker"),
				PI_WEB_FIXTURE_SKIP_PROMPT_PERSIST: "1",
			},
			maxAutoRestarts: 0,
		});
		const created = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "default-off-late-materialization",
		});
		const controller = await supervisor.claim(created.sessionHandle, "controller");

		await supervisor.sendCommand(
			created.sessionHandle,
			{ type: "prompt", message: "crash-once" },
			{
				connectionId: "controller",
				expectedGeneration: created.generation,
				fencingToken: controller.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(created.sessionHandle)?.state === "crashed");
		expect(supervisor.getRuntime(created.sessionHandle)?.recoverable).toBe(false);
		if (!created.sessionFile) throw new Error("unpersisted Session did not expose its candidate file");
		fs.mkdirSync(path.dirname(created.sessionFile), { recursive: true });
		fs.writeFileSync(
			created.sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: created.nativeSessionId,
				timestamp: "2026-08-20T00:00:00.000Z",
				cwd,
			})}\n`,
		);

		await expect(supervisor.restart(created.sessionHandle)).rejects.toThrow(
			"unpersisted_session_cannot_be_recovered",
		);
		expect(supervisor.getRuntime(created.sessionHandle)).toMatchObject({
			state: "crashed",
			recoverable: false,
			generation: created.generation,
		});
	});

	it("clears a recoverable crash projection and holds before any replacement generation", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "recoverable-owned-crash");
		const exactRef = attachmentRef("d".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const { hold, lease } = trackedLease(exactRef, { adopted, released });
		const { supervisor } = createHarness({
			targets: [target],
			adapter: startupBaseAdapter(exactRef, lease),
			piPayloadServices: testPayloadServices(released),
			env: { PI_WEB_FIXTURE_CRASH_MARKER: path.join(root, "recoverable-crash.marker") },
			maxAutoRestarts: 0,
		});
		const controller = await supervisor.claim(target.sessionHandle, "controller");
		const before = supervisor.getRuntime(target.sessionHandle)!;
		const internal = supervisor as unknown as { runtimes: Map<string, SessionRuntime> };
		const runtime = internal.runtimes.get(target.sessionHandle)!;

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "crash-once" },
			{
				connectionId: "controller",
				expectedGeneration: before.generation,
				fencingToken: controller.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");

		expect(adopted).toEqual([[hold]]);
		expect(released).toEqual([hold]);
		expect(() => runtime.sessionSnapshot()).toThrow("session_snapshot_unavailable");
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			state: "crashed",
			recoverable: true,
			generation: before.generation,
		});
	});

	it("terminalizes the exact active generation when duplicate-hold cleanup poisons its owner", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "owned-fatal-cleanup");
		const exactRef = attachmentRef("1".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const leaseReleased: EpochContentHold<EpochStoredContentRef>[] = [];
		const first = trackedLease(exactRef, { adopted, released: leaseReleased });
		const duplicate = trackedLease(exactRef, { adopted, released: leaseReleased });
		let attachedEvent = false;
		const base = startupBaseAdapter(exactRef, first.lease);
		const adapter: PiHostAdapter = {
			...base,
			async decodeUnsolicited(value, context) {
				const outcome = await piRpcAdapter.decodeUnsolicited(value, context);
				if (attachedEvent || outcome.value.kind !== "event" || outcome.value.event.type !== "agent_end") {
					return outcome;
				}
				attachedEvent = true;
				return { value: outcome.value, lease: duplicate.lease };
			},
		};
		const ownerReleased: EpochContentHold<EpochStoredContentRef>[] = [];
		const services = testPayloadServices(ownerReleased);
		const { supervisor } = createHarness({
			targets: [target],
			adapter,
			piPayloadServices: {
				...services,
				releaseHold: async (entry) => {
					ownerReleased.push(entry);
					if (entry === duplicate.hold) throw new Error("fixture duplicate cleanup failed");
				},
			},
			maxAutoRestarts: 0,
		});
		const controller = await supervisor.claim(target.sessionHandle, "controller");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "small-structural-turn" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: controller.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");

		expect(adopted).toEqual([[first.hold], [duplicate.hold]]);
		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow(/cleanup failed/i);
		expect(supervisor.isActive(target.sessionHandle)).toBe(false);
		expect(ownerReleased).toContain(first.hold);
		expect(supervisor.getRuntime(target.sessionHandle)?.generation).toBe(runtime.generation);
	});

	it("adopts a ref-bearing active history response before resolving it to the caller", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "active-owned-history");
		const exactRef = attachmentRef("b".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const tracking = { adopted, released };
		const { hold, lease } = trackedLease(exactRef, tracking);
		let getMessagesCount = 0;
		const adapter: PiHostAdapter = {
			...piRpcAdapter,
			async decodeResponse(value, expectedCommand, context) {
				const outcome = await piRpcAdapter.decodeResponse(value, expectedCommand, context);
				if (expectedCommand !== "get_messages") return outcome;
				getMessagesCount += 1;
				if (getMessagesCount !== 2 || outcome.value.success !== true) return outcome;
				const decoded: PiHostDecodeOutcome<SessionCommandResponseDto & { id: string }> = {
					value: {
						type: "response",
						id: outcome.value.id,
						command: "get_messages",
						success: true,
						data: {
							messages: [
								{
									role: "user",
									content: [{ type: "image", data: exactRef, mimeType: "image/png" }],
									timestamp: 2,
								},
							],
						},
					},
					lease,
				};
				return decoded;
			},
		};
		const { supervisor } = createHarness({
			targets: [target],
			adapter,
			piPayloadServices: testPayloadServices(released),
			maxAutoRestarts: 0,
		});
		const runtime = await supervisor.activate(target.sessionHandle);

		const response = await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "get_messages" },
			{ connectionId: "reader", expectedGeneration: runtime.generation },
		);

		expect(response).toMatchObject({
			response: {
				success: true,
				data: {
					messages: [
						expect.objectContaining({
							content: [expect.objectContaining({ data: exactRef })],
						}),
					],
				},
			},
		});
		expect(adopted).toEqual([[hold]]);
		expect(released).toEqual([]);
	});

	it("prepares and adopts a ref-bearing active event before seq and replay publication", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "active-owned-event");
		const exactRef = attachmentRef("c".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const tracking = { adopted, released };
		const { hold, lease } = trackedLease(exactRef, tracking);
		let attached = false;
		const adapter: PiHostAdapter = {
			...piRpcAdapter,
			decodeResponse(value, expectedCommand, context) {
				return piRpcAdapter.decodeResponse(value, expectedCommand, context);
			},
			async decodeUnsolicited(value, context) {
				const outcome = await piRpcAdapter.decodeUnsolicited(value, context);
				if (outcome.value.kind !== "event" || outcome.value.event.type !== "agent_end" || attached) {
					return outcome;
				}
				attached = true;
				return {
					value: {
						kind: "event" as const,
						event: {
							type: "agent_end" as const,
							messages: [
								{
									role: "user" as const,
									content: [{ type: "image" as const, data: exactRef, mimeType: "image/png" }],
									timestamp: 3,
								},
							],
							willRetry: false,
						},
					},
					lease,
				};
			},
		};
		const { supervisor, messages } = createHarness({
			targets: [target],
			adapter,
			piPayloadServices: testPayloadServices(released),
			maxAutoRestarts: 0,
		});
		const runtime = await supervisor.activate(target.sessionHandle);
		const controller = await supervisor.claim(target.sessionHandle, "controller");

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "small-structural-turn" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: controller.fencingToken,
			},
		);
		await waitFor(() => adopted.length === 1);

		const published = messages.find(
			(message) => message.type === "event" && message.event.type === "agent_end",
		);
		expect(published).toMatchObject({
			type: "event",
			event: {
				messages: [
					expect.objectContaining({
						content: [expect.objectContaining({ data: exactRef })],
					}),
				],
			},
		});
		expect(adopted).toEqual([[hold]]);
		expect(released).toEqual([]);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({ state: "idle" });
	});

	it("adopts a ref-bearing idle compaction base only after its CAS prepare succeeds", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "active-owned-compaction");
		const exactRef = attachmentRef("d".repeat(64));
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const tracking = { adopted, released };
		const { hold, lease } = trackedLease(exactRef, tracking);
		let getMessagesCount = 0;
		const adapter: PiHostAdapter = {
			...piRpcAdapter,
			async decodeResponse(value, expectedCommand, context) {
				const outcome = await piRpcAdapter.decodeResponse(value, expectedCommand, context);
				if (expectedCommand !== "get_messages") return outcome;
				getMessagesCount += 1;
				if (getMessagesCount !== 2 || outcome.value.success !== true) return outcome;
				const decoded: PiHostDecodeOutcome<SessionCommandResponseDto & { id: string }> = {
					value: {
						type: "response",
						id: outcome.value.id,
						command: "get_messages",
						success: true,
						data: {
							messages: [
								{
									role: "user",
									content: [{ type: "image", data: exactRef, mimeType: "image/png" }],
									timestamp: 4,
								},
							],
						},
					},
					lease,
				};
				return decoded;
			},
			decodeUnsolicited(value, context) {
				return piRpcAdapter.decodeUnsolicited(value, context);
			},
		};
		const { supervisor } = createHarness({
			targets: [target],
			adapter,
			piPayloadServices: testPayloadServices(released),
			projectionLimits: { maxLiveEventItems: 8 },
			maxAutoRestarts: 0,
		});
		const controller = await supervisor.claim(target.sessionHandle, "controller");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "small-structural-turn" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: controller.fencingToken,
			},
		);
		await waitFor(() => adopted.length === 1);

		const initial = await supervisor.subscribe(target.sessionHandle);
		expect(initial).toMatchObject({
			type: "resync_required",
			snapshot: {
				baseSeq: expect.any(Number),
				settledMessages: [
					expect.objectContaining({
						content: [expect.objectContaining({ data: exactRef })],
					}),
				],
				projectionEvents: [],
			},
		});
		expect(adopted).toEqual([[hold]]);
		expect(released).toEqual([]);
	});

	it("permanently blocks replacement when a stale ref-bearing compaction transfer cannot release", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "stale-compaction-release-failure");
		const exactRef = attachmentRef("3".repeat(64));
		const tracking = { transferReleaseAttempts: 0 };
		const lease = rejectingTransferLease(exactRef, tracking);
		let getMessagesCount = 0;
		const adapter: PiHostAdapter = {
			...piRpcAdapter,
			async decodeResponse(value, expectedCommand, context) {
				const outcome = await piRpcAdapter.decodeResponse(value, expectedCommand, context);
				if (expectedCommand !== "get_messages") return outcome;
				getMessagesCount += 1;
				if (getMessagesCount !== 2 || outcome.value.success !== true) return outcome;
				return {
					value: {
						type: "response" as const,
						id: outcome.value.id,
						command: "get_messages" as const,
						success: true as const,
						data: {
							messages: [
								{
									role: "user" as const,
									content: [{ type: "image" as const, data: exactRef, mimeType: "image/png" }],
									timestamp: 6,
								},
							],
						},
					},
					lease,
				};
			},
			decodeUnsolicited(value, context) {
				return piRpcAdapter.decodeUnsolicited(value, context);
			},
		};
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const { supervisor } = createHarness({
			targets: [target],
			adapter,
			piPayloadServices: testPayloadServices(released),
			projectionLimits: { maxLiveEventItems: 8 },
			env: { PI_WEB_FIXTURE_COMPACTION_RACE: "1" },
			maxAutoRestarts: 0,
		});
		const controller = await supervisor.claim(target.sessionHandle, "controller");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "small-structural-turn" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: controller.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");

		expect(tracking.transferReleaseAttempts).toBe(1);
		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow(/cleanup failed/i);
		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow(
			"generation_content_cleanup_failed",
		);
		expect(supervisor.getRuntime(target.sessionHandle)?.generation).toBe(runtime.generation);
		expect(released).toEqual([]);
	});

	it("fails a projection overflow without publishing or entering an automatic restart loop", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "projection-overflow");
		const { supervisor, messages } = createHarness({
			targets: [target],
			env: { PI_WEB_FIXTURE_STARTUP_PROJECTION_DOMAINS: "1" },
			projectionLimits: { maxLiveEventBytes: 1 },
		});

		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow("session_snapshot_overflow");
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			generation: 1,
			lastSeq: 0,
			state: "crashed",
			error: "session_snapshot_overflow",
		});
		expect(messages.some((message) => message.type === "event")).toBe(false);
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		expect(supervisor.getRuntime(target.sessionHandle)?.generation).toBe(1);
		await expect(supervisor.activate(target.sessionHandle)).rejects.toThrow("session_snapshot_overflow");
	});

	it("opens a native history larger than one snapshot frame through a bounded plan", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "chunked-history");
		appendLargeNativeHistory(target, 110, 600 * 1024);
		expect(fs.statSync(target.sessionFile).size).toBeGreaterThan(64 * 1024 * 1024);
		const getMessagesMarker = path.join(root, "get-messages.log");
		const { supervisor } = createHarness({
			targets: [target],
			env: { PI_WEB_FIXTURE_GET_MESSAGES_MARKER: getMessagesMarker },
			maxAutoRestarts: 0,
		});

		await expect(supervisor.activate(target.sessionHandle)).resolves.toMatchObject({ state: "idle" });
		const result = await supervisor.subscribe(target.sessionHandle);
		if (result.type !== "resync_required" || !result.chunkedSnapshot) {
			throw new Error("large native history did not produce a chunked snapshot");
		}
		expect(result.chunkedSnapshot.history).toMatchObject({
			totalMessages: 110,
			loadedMessages: 96,
			nextCursor: expect.any(String),
		});
		expect(result.snapshot.settledMessages).toHaveLength(96);
		expect(fs.existsSync(getMessagesMarker)).toBe(false);

		const older = await result.chunkedSnapshot.readPage(result.chunkedSnapshot.history.nextCursor!, 8);
		expect(older.messages).toHaveLength(8);
		expect(older.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: expect.stringContaining("6:") }],
		});
		expect(older.nextCursor).toEqual(expect.any(String));

		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			result.chunkedSnapshot.readPage(result.chunkedSnapshot.history.nextCursor!, 8, cancelled.signal),
		).rejects.toMatchObject({ code: "session_history_cancelled" });
	});

	it("opens a small verified persisted history natively without Pi get_messages", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "small-native-history");
		appendNativeHistoryEntry(target, 0, 128);
		appendNativeHistoryEntry(target, 1, 128);
		const getMessagesMarker = path.join(root, "get-messages.log");
		const { supervisor } = createHarness({
			targets: [target],
			env: { PI_WEB_FIXTURE_GET_MESSAGES_MARKER: getMessagesMarker },
			maxAutoRestarts: 0,
		});

		await expect(supervisor.activate(target.sessionHandle)).resolves.toMatchObject({ state: "idle" });
		const result = await supervisor.subscribe(target.sessionHandle);
		if (result.type !== "resync_required" || !result.chunkedSnapshot) {
			throw new Error("small persisted history did not produce a native snapshot");
		}
		expect(result.chunkedSnapshot.history).toMatchObject({
			totalMessages: 2,
			loadedMessages: 2,
			nextCursor: null,
		});
		expect(result.snapshot.settledMessages).toHaveLength(2);
		expect(fs.existsSync(getMessagesMarker)).toBe(false);
	});

	it("keeps an empty verified Session on Pi until durable messages exist", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "empty-pi-history");
		const getMessagesMarker = path.join(root, "get-messages.log");
		const { supervisor } = createHarness({
			targets: [target],
			env: {
				PI_WEB_FIXTURE_GET_MESSAGES_MARKER: getMessagesMarker,
				PI_WEB_FIXTURE_LARGE_SETTLED_BASE: "1",
			},
			maxAutoRestarts: 0,
		});

		await supervisor.activate(target.sessionHandle);
		const result = await supervisor.subscribe(target.sessionHandle);
		if (result.type !== "resync_required") throw new Error("empty Session did not resync");
		expect(result.chunkedSnapshot).toBeUndefined();
		expect(result.snapshot.settledMessages).toHaveLength(1);
		expect(fs.readFileSync(getMessagesMarker, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("keeps a new unmaterialized Session on Pi history", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const getMessagesMarker = path.join(root, "get-messages.log");
		const { supervisor } = createHarness({
			targets: [],
			env: { PI_WEB_FIXTURE_GET_MESSAGES_MARKER: getMessagesMarker },
			maxAutoRestarts: 0,
		});

		const runtime = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "new-pi-history",
		});
		expect(runtime.recoverable).toBe(false);
		expect(runtime.sessionFile ? fs.existsSync(runtime.sessionFile) : false).toBe(false);
		expect(fs.readFileSync(getMessagesMarker, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("uses Pi compaction when live projection is newer than a small native base", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "native-live-suffix");
		appendNativeHistoryEntry(target, 0, 128);
		appendNativeHistoryEntry(target, 1, 128);
		const getMessagesMarker = path.join(root, "get-messages.log");
		const { supervisor } = createHarness({
			targets: [target],
			env: {
				PI_WEB_FIXTURE_GET_MESSAGES_MARKER: getMessagesMarker,
				PI_WEB_FIXTURE_LOAD_EXISTING_MESSAGES: "1",
			},
			projectionLimits: { maxLiveEventItems: 2_048 },
			maxAutoRestarts: 0,
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");

		for (let turn = 0; turn < 2; turn += 1) {
			const runtime = supervisor.getRuntime(target.sessionHandle)!;
			await supervisor.sendCommand(
				target.sessionHandle,
				{ type: "prompt", message: "structural-burst" },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
			await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle", 5_000);
		}
		await waitFor(() => fs.existsSync(getMessagesMarker), 5_000);
		await waitFor(() => {
			const snapshot = runtimeProjection(exactRuntimeObject(supervisor, target.sessionHandle)).snapshot();
			return snapshot.projectionEvents.length === 0 && snapshot.settledMessages.length === 6;
		}, 5_000);

		const snapshot = runtimeProjection(exactRuntimeObject(supervisor, target.sessionHandle)).snapshot();
		const text = snapshot.settledMessages.flatMap(messageTextFragments);
		expect(text.filter((value) => value === "structural-burst")).toHaveLength(2);
		expect(text.filter((value) => value.startsWith("structural-burst-")).length).toBe(2);
		expect(fs.readFileSync(getMessagesMarker, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("fails native history pages closed after deletion or inode replacement", async () => {
		for (const mutation of ["delete", "replace"] as const) {
			const root = temporaryRoot();
			const cwd = path.join(root, `workspace-${mutation}`);
			fs.mkdirSync(cwd);
			const target = createNativeSession(root, cwd, `history-${mutation}`);
			appendLargeNativeHistory(target, 110, 128);
			const { supervisor } = createHarness({ targets: [target], maxAutoRestarts: 0 });

			await supervisor.activate(target.sessionHandle);
			const result = await supervisor.subscribe(target.sessionHandle);
			if (result.type !== "resync_required" || !result.chunkedSnapshot?.history.nextCursor) {
				throw new Error("native history did not expose a page cursor");
			}
			const runtime = exactRuntimeObject(supervisor, target.sessionHandle);
			const originalPlan = Reflect.get(runtime, "nativeHistoryPlan");
			const originalSnapshotId = Reflect.get(runtime, "nativeHistorySnapshotId");
			if (mutation === "delete") {
				fs.unlinkSync(target.sessionFile);
			} else {
				const replacement = `${target.sessionFile}.replacement`;
				fs.copyFileSync(target.sessionFile, replacement);
				fs.renameSync(replacement, target.sessionFile);
			}
			const maybeCompact = Reflect.get(runtime, "maybeCompactIdleProjectionBase");
			if (typeof maybeCompact !== "function") throw new Error("Idle compaction seam is unavailable");
			Reflect.apply(maybeCompact, runtime, []);
			let compaction: Promise<void> | null = null;
			await waitFor(() => {
				const candidate = Reflect.get(runtime, "idleBaseCompactionPromise");
				if (!(candidate instanceof Promise)) return false;
				compaction = candidate;
				return true;
			});
			await compaction;
			expect(Reflect.get(runtime, "nativeHistoryPlan")).toBe(originalPlan);
			expect(Reflect.get(runtime, "nativeHistorySnapshotId")).toBe(originalSnapshotId);

			await expect(
				result.chunkedSnapshot.readPage(result.chunkedSnapshot.history.nextCursor, 8),
			).rejects.toThrow();
		}
	});

	it("refreshes the native history cursor when the persisted source grows while idle", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "chunked-history-growth");
		appendLargeNativeHistory(target, 110, 600 * 1024);
		const getMessagesMarker = path.join(root, "get-messages.log");
		const { supervisor } = createHarness({
			targets: [target],
			env: { PI_WEB_FIXTURE_GET_MESSAGES_MARKER: getMessagesMarker },
			maxAutoRestarts: 0,
		});

		await supervisor.activate(target.sessionHandle);
		appendNativeHistoryEntry(target, 110, 600 * 1024);
		const runtime = exactRuntimeObject(supervisor, target.sessionHandle);
		const maybeCompact = Reflect.get(runtime, "maybeCompactIdleProjectionBase");
		if (typeof maybeCompact !== "function") throw new Error("Idle compaction seam is unavailable");
		Reflect.apply(maybeCompact, runtime, []);
		let compaction: Promise<void> | null = null;
		await waitFor(() => {
			const candidate = Reflect.get(runtime, "idleBaseCompactionPromise");
			if (!(candidate instanceof Promise)) return false;
			compaction = candidate;
			return true;
		}, 5_000);
		await compaction;

		const plan = Reflect.get(runtime, "nativeHistoryPlan") as { totalMessages?: number } | null;
		expect(plan?.totalMessages).toBe(111);
		expect(fs.existsSync(getMessagesMarker)).toBe(false);
	});

	it("refreshes a large native history during idle compaction without calling Pi get_messages", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "chunked-history-compaction");
		appendLargeNativeHistory(target, 110, 600 * 1024);
		const getMessagesMarker = path.join(root, "get-messages.log");
		const { supervisor } = createHarness({
			targets: [target],
			env: {
				PI_WEB_FIXTURE_GET_MESSAGES_MARKER: getMessagesMarker,
				PI_WEB_FIXTURE_PERSIST_MESSAGES: "1",
			},
			projectionLimits: { maxLiveEventItems: 2_048 },
			maxAutoRestarts: 0,
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");

		for (let turn = 0; turn < 2; turn += 1) {
			const runtime = supervisor.getRuntime(target.sessionHandle)!;
			await supervisor.sendCommand(
				target.sessionHandle,
				{ type: "prompt", message: "structural-burst" },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
			await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle", 5_000);
		}

		let compaction: Promise<void> | null = null;
		await waitFor(() => {
			const candidate = Reflect.get(
				exactRuntimeObject(supervisor, target.sessionHandle),
				"idleBaseCompactionPromise",
			);
			if (!(candidate instanceof Promise)) return false;
			compaction = candidate;
			return true;
		}, 5_000);
		await compaction;
		expect(fs.existsSync(getMessagesMarker)).toBe(false);
		const settled = runtimeProjection(exactRuntimeObject(supervisor, target.sessionHandle)).snapshot()
			.settledMessages;
		expect(settled).toHaveLength(96);
		const text = settled.flatMap(messageTextFragments);
		expect(text.filter((value) => value.includes("structural-burst"))).toHaveLength(4);
	});

	it("preflights aggregate wire bounds before ready and releases the hot slot on failure", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		const healthyCwd = path.join(root, "healthy-workspace");
		fs.mkdirSync(cwd);
		fs.mkdirSync(healthyCwd);
		const oversized = createNativeSession(root, cwd, "aggregate-overflow");
		const healthy = createNativeSession(root, healthyCwd, "aggregate-healthy");
		const { supervisor, messages } = createHarness({
			targets: [oversized, healthy],
			maxHotRuntimes: 1,
			maxAutoRestarts: 0,
			envForWorkspace: (workspaceCwd): Record<string, string> =>
				workspaceCwd === cwd ? { PI_WEB_FIXTURE_AGGREGATE_SNAPSHOT_ITEMS: "1" } : {},
		});

		await expect(supervisor.activate(oversized.sessionHandle)).rejects.toThrow("session_snapshot_overflow");
		await waitFor(() => supervisor.getRuntime(oversized.sessionHandle)?.state === "crashed");
		expect(supervisor.isActive(oversized.sessionHandle)).toBe(false);
		expect(messages).toContainEqual(
			expect.objectContaining({
				type: "runtime_state",
				runtime: expect.objectContaining({ state: "crashed", error: "session_snapshot_overflow" }),
			}),
		);
		await expect(supervisor.activate(healthy.sessionHandle)).resolves.toMatchObject({ state: "idle" });
	});

	it("externalizes live aggregate details while preserving owned dialog callbacks", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "live-aggregate-content-refs");
		const { supervisor, messages } = createHarness({
			targets: [target],
			maxAutoRestarts: 0,
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const before = supervisor.getRuntime(target.sessionHandle)!;
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "live-aggregate-overflow" },
			{
				connectionId: "controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(
			() =>
				runtimeProjection(exactRuntimeObject(supervisor, target.sessionHandle))
					.snapshot()
					.projectionEvents.filter(
						(frame) =>
							frame.event.type === "message_end" &&
							frame.event.message.role === "toolResult" &&
							frame.event.message.details?.type === "external_json",
					).length === 6,
			5_000,
		);

		const initial = await supervisor.subscribe(target.sessionHandle);
		if (initial.type !== "resync_required") throw new Error("initial subscription did not resync");
		const externalizedDetails = initial.snapshot.projectionEvents.filter(
			(frame) =>
				frame.event.type === "message_end" &&
				frame.event.message.role === "toolResult" &&
				frame.event.message.details?.type === "external_json",
		);
		expect(externalizedDetails).toHaveLength(6);
		expect(initial.snapshot.pendingExtensionRequests).toEqual([
			expect.objectContaining({ method: "confirm", message: "must be synchronously cleared" }),
		]);

		await waitFor(() => supervisor.getPendingExtensionRequests(target.sessionHandle)?.length === 0, 10_000);
		expect(messages).toContainEqual(
			expect.objectContaining({ type: "extension_ui_closed", reason: "expired" }),
		);
		expect(supervisor.getRuntime(target.sessionHandle)?.state).not.toBe("crashed");
	});

	it("compacts settled projection suffixes so normal turns can cross 4096 structural events", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "idle-base-compaction");
		const { supervisor } = createHarness({ targets: [target], maxAutoRestarts: 0 });
		const lease = await supervisor.claim(target.sessionHandle, "controller");

		for (let turn = 0; turn < 5; turn += 1) {
			const runtime = supervisor.getRuntime(target.sessionHandle)!;
			await supervisor.sendCommand(
				target.sessionHandle,
				{ type: "prompt", message: "structural-burst" },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
			await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle", 5_000);
		}

		const current = supervisor.getRuntime(target.sessionHandle)!;
		expect(current.state).toBe("idle");
		expect(current.error).toBeUndefined();
		expect(current.lastSeq).toBeGreaterThan(4_096);
		const initial = await supervisor.subscribe(target.sessionHandle);
		if (initial.type !== "resync_required") throw new Error("initial subscription did not resync");
		expect(initial.snapshot.baseSeq).toBeGreaterThan(0);
		expect(initial.snapshot.projectionEvents.length).toBeLessThan(4_096);
	});

	it("discards an idle base compaction response when a newer event crosses its CAS waterline", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "idle-base-cas");
		const { supervisor } = createHarness({
			targets: [target],
			env: { PI_WEB_FIXTURE_COMPACTION_RACE: "1" },
			projectionLimits: { maxLiveEventItems: 8 },
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "fast" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitForAsync(async () => {
			const initial = await supervisor.subscribe(target.sessionHandle);
			return (
				initial.type === "resync_required" &&
				initial.snapshot.projectionEvents.some((frame) => frame.event.type === "turn_start")
			);
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		const initial = await supervisor.subscribe(target.sessionHandle);
		if (initial.type !== "resync_required") throw new Error("initial subscription did not resync");
		expect(initial.snapshot.baseSeq).toBeLessThan(initial.snapshot.asOfSeq);
		expect(initial.snapshot.projectionEvents.at(-1)?.event.type).toBe("turn_start");
	});

	it("waits for projection high-water before fetching a large settled base", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "idle-base-high-water");
		const marker = path.join(root, "get-messages.log");
		const { supervisor } = createHarness({
			targets: [target],
			projectionLimits: { maxLiveEventItems: 40 },
			env: {
				PI_WEB_FIXTURE_GET_MESSAGES_MARKER: marker,
				PI_WEB_FIXTURE_LARGE_SETTLED_BASE: "1",
			},
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");

		for (let turn = 0; turn < 4; turn += 1) {
			const runtime = supervisor.getRuntime(target.sessionHandle)!;
			await supervisor.sendCommand(
				target.sessionHandle,
				{ type: "prompt", message: "small-structural-turn" },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
			await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle");
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		}
		expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);

		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "small-structural-turn" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => fs.readFileSync(marker, "utf8").trim().split("\n").length === 2);
	});

	it("admits a 2048-event turn after a 2047-event suffix and bounds the next 2050-event turn", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "turn-item-budget");
		const { supervisor } = createHarness({ targets: [target], maxAutoRestarts: 0 });
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const sendTurn = async (structuralCount: number) => {
			const runtime = supervisor.getRuntime(target.sessionHandle)!;
			await supervisor.sendCommand(
				target.sessionHandle,
				{ type: "prompt", message: `structural-count:${String(structuralCount)}` },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
		};

		await sendTurn(2_044);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle", 5_000);
		let initial = await supervisor.subscribe(target.sessionHandle);
		if (initial.type !== "resync_required") throw new Error("initial subscription did not resync");
		expect(initial.snapshot.projectionEvents).toHaveLength(2_047);

		await sendTurn(2_045);
		await waitForAsync(async () => {
			initial = await supervisor.subscribe(target.sessionHandle);
			return initial.type === "resync_required" && initial.snapshot.baseSeq === 4_095;
		}, 5_000);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({ state: "idle", lastSeq: 4_095 });

		await sendTurn(2_047);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed", 5_000);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			state: "crashed",
			error: "session_snapshot_overflow",
			lastSeq: 6_143,
		});
	});

	it("enforces a half-ceiling active-turn byte budget before the 8 MiB live suffix overflows", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "turn-byte-budget");
		const { supervisor } = createHarness({ targets: [target], maxAutoRestarts: 0 });
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "byte-turn:9" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed", 5_000);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			state: "crashed",
			error: "session_snapshot_overflow",
		});
	});

	it("holds the next work command until a delayed high-water compaction restores headroom", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "turn-headroom-wait");
		const getMessagesMarker = path.join(root, "get-messages.log");
		const promptMarker = path.join(root, "prompts.log");
		const { supervisor } = createHarness({
			targets: [target],
			projectionLimits: { maxLiveEventItems: 8 },
			env: {
				PI_WEB_FIXTURE_COMPACTION_DELAY_MS: "200",
				PI_WEB_FIXTURE_GET_MESSAGES_MARKER: getMessagesMarker,
				PI_WEB_FIXTURE_PROMPT_MARKER: promptMarker,
			},
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const sendSmallTurn = () => {
			const runtime = supervisor.getRuntime(target.sessionHandle)!;
			return supervisor.sendCommand(
				target.sessionHandle,
				{ type: "prompt", message: "small-structural-turn" },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
		};

		await sendSmallTurn();
		await waitFor(() => fs.readFileSync(getMessagesMarker, "utf8").trim().split("\n").length === 2);
		const second = sendSmallTurn();
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(fs.readFileSync(promptMarker, "utf8").trim().split("\n")).toHaveLength(1);
		await second;
		expect(fs.readFileSync(promptMarker, "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("returns to ready after a read command overlaps idle base compaction", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "idle-compaction-read-overlap");
		const { supervisor } = createHarness({
			targets: [target],
			projectionLimits: { maxLiveEventItems: 8 },
			env: { PI_WEB_FIXTURE_COMPACTION_DELAY_MS: "200" },
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		const context = {
			connectionId: "controller",
			expectedGeneration: runtime.generation,
			fencingToken: lease.fencingToken,
		};

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "small-structural-turn" },
			context,
		);
		await waitFor(
			() => supervisor.getRuntime(target.sessionHandle)?.busyReasons?.includes("compaction") ?? false,
		);
		await supervisor.sendCommand(target.sessionHandle, { type: "get_state" }, context);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.operationCount === 0);

		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			state: "idle",
			phase: "ready",
			operationCount: 0,
			busyReasons: [],
		});
	});

	it("atomically reserves two half-turns and rejects a third concurrent follow-up before Pi", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "concurrent-turn-reservations");
		const promptMarker = path.join(root, "prompts.log");
		const { supervisor } = createHarness({
			targets: [target],
			maxAutoRestarts: 0,
			env: { PI_WEB_FIXTURE_PROMPT_MARKER: promptMarker },
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		const sendHalfTurn = () =>
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "follow_up", message: "structural-count:2045" },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);

		const results = await Promise.allSettled([sendHalfTurn(), sendHalfTurn(), sendHalfTurn()]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
		const rejected = results.filter((result) => result.status === "rejected");
		expect(rejected).toHaveLength(1);
		expect(String(rejected[0]?.reason)).toContain("session_snapshot_headroom_unavailable");
		await waitFor(() => fs.readFileSync(promptMarker, "utf8").trim().split("\n").length === 2);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle", 5_000);
		expect(supervisor.getRuntime(target.sessionHandle)?.error).toBeUndefined();
	});

	it("releases failed and aborted turn reservations before rekey admission", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "reservation-cleanup-rekey");
		const { supervisor, messages } = createHarness({ targets: [target] });
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		let runtime = supervisor.getRuntime(target.sessionHandle)!;

		const failed = await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "follow_up", message: "follow-up-failure" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		expect(failed.response.success).toBe(false);

		const deadlines = trackRuntimeDeadlines();
		try {
			await supervisor.sendCommand(
				target.sessionHandle,
				{ type: "follow_up", message: "queued-never-starts" },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
			expect(deadlines.timers.size).toBe(1);
			await supervisor.sendCommand(
				target.sessionHandle,
				{ type: "abort" },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);

			const cloned = await supervisor.sendCommand(
				target.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
			expect(cloned.previousSessionHandle).toBe(target.sessionHandle);
			runtime = supervisor.getRuntime(cloned.sessionHandle)!;
			expect(runtime.generation).toBeGreaterThan(1);
			expect(deadlines.timers.size).toBe(0);
			const messagesAfterRekey = messages.length;
			await new Promise<void>((resolve) => deadlines.nativeSetTimeout(resolve, 600));
			expect(messages).toHaveLength(messagesAfterRekey);
		} finally {
			deadlines.restore();
		}
	});

	it("keeps post-abort reservations beyond a delayed abort response causal cutoff", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "abort-reservation-cutoff");
		const abortMarker = path.join(root, "abort.log");
		const { supervisor } = createHarness({
			targets: [target],
			env: {
				PI_WEB_FIXTURE_ABORT_MARKER: abortMarker,
				PI_WEB_FIXTURE_ABORT_RESPONSE_DELAY_MS: "100",
			},
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const send = (message: string) => {
			const runtime = supervisor.getRuntime(target.sessionHandle)!;
			return supervisor.sendCommand(
				target.sessionHandle,
				{ type: "follow_up", message },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
		};

		await send("queued-never-starts");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		const abort = supervisor.sendCommand(
			target.sessionHandle,
			{ type: "abort" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => fs.existsSync(abortMarker));
		await send("queued-never-starts");
		await abort;
		await send("queued-never-starts");
		await expect(send("queued-never-starts")).rejects.toThrow("session_snapshot_headroom_unavailable");
	});

	it("keeps reservation ids strictly monotonic beyond Number.MAX_SAFE_INTEGER", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "large-reservation-cutoff");
		const abortMarker = path.join(root, "abort.log");
		const { supervisor } = createHarness({
			targets: [target],
			env: {
				PI_WEB_FIXTURE_ABORT_MARKER: abortMarker,
				PI_WEB_FIXTURE_ABORT_RESPONSE_DELAY_MS: "100",
			},
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		const runtimeInstance = (supervisor as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get(
			target.sessionHandle,
		)!;
		const internals = runtimeInstance as unknown as {
			nextTurnReservationId: number | bigint;
			pendingTurnReservations: Map<symbol, { id: number | bigint }>;
		};
		internals.nextTurnReservationId =
			typeof internals.nextTurnReservationId === "bigint"
				? BigInt(Number.MAX_SAFE_INTEGER)
				: Number.MAX_SAFE_INTEGER;
		const send = (message: string) =>
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "follow_up", message },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);

		await send("queued-never-starts");
		const firstReservationId = [...internals.pendingTurnReservations.values()][0]?.id;
		const abort = supervisor.sendCommand(
			target.sessionHandle,
			{ type: "abort" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => fs.existsSync(abortMarker));
		await send("queued-never-starts");
		const secondReservationId = [...internals.pendingTurnReservations.values()][1]?.id;
		await abort;
		expect(firstReservationId).toBeDefined();
		expect(secondReservationId).toBeDefined();
		expect(secondReservationId! > firstReservationId!).toBe(true);
		await send("queued-never-starts");
		await expect(send("queued-never-starts")).rejects.toThrow("session_snapshot_headroom_unavailable");
	});

	it("keeps reservations accepted after a stale empty queue update watermark", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "queue-reservation-cutoff");
		const { supervisor, messages } = createHarness({
			targets: [target],
			env: { PI_WEB_FIXTURE_STALE_QUEUE_DELAY_MS: "250" },
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const send = (message: string) => {
			const runtime = supervisor.getRuntime(target.sessionHandle)!;
			return supervisor.sendCommand(
				target.sessionHandle,
				{ type: "follow_up", message },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);
		};
		const queueEvents = () =>
			messages.filter((message) => message.type === "event" && message.event.type === "queue_update");

		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "set_model", provider: "fixture", modelId: "stale-queue-clear" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() =>
			queueEvents().some(
				(message) =>
					message.type === "event" &&
					message.event.type === "queue_update" &&
					message.event.steering.length === 1,
			),
		);
		await send("queued-never-starts");
		await waitFor(() =>
			queueEvents().some(
				(message) =>
					message.type === "event" &&
					message.event.type === "queue_update" &&
					message.event.steering.length === 0,
			),
		);
		await expect(send("queued-never-starts")).rejects.toThrow("session_snapshot_headroom_unavailable");
	});

	it("cancels every no-start reservation deadline when the runtime stops", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "reservation-deadline-stop");
		const { supervisor, messages } = createHarness({ targets: [target] });
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		const send = (delayMs: number) =>
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "follow_up", message: `queued-never-starts:${delayMs}` },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			);

		const deadlines = trackRuntimeDeadlines();
		try {
			await Promise.all([send(100), send(150)]);
			expect(deadlines.timers.size).toBe(2);
			await supervisor.stop(target.sessionHandle);
			const messageCountAfterStop = messages.length;
			expect(deadlines.timers.size).toBe(0);
			await new Promise<void>((resolve) => deadlines.nativeSetTimeout(resolve, 600));
			expect(messages).toHaveLength(messageCountAfterStop);
			expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({ state: "dormant" });
		} finally {
			deadlines.restore();
		}
	});

	it("uses the runtime-selected adapter for Session process arguments and decoding", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "selected-adapter");
		let openCalls = 0;
		const adapter: PiHostAdapter = {
			...piRpcAdapter,
			openSessionArguments(input) {
				openCalls += 1;
				return piRpcAdapter.openSessionArguments(input);
			},
		};
		const { supervisor } = createHarness({ targets: [target], adapter });

		await supervisor.claim(target.sessionHandle, "connection");

		expect(openCalls).toBe(1);
		expect(supervisor.getRuntime(target.sessionHandle)?.state).toBe("idle");
	});

	it("turns a validated relative HTML export path into a pasteable file URL", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace #1 中文");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "export-relative");
		const { supervisor } = createHarness({ targets: [target] });
		const lease = await supervisor.claim(target.sessionHandle, "connection");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;
		const relativePath = path.join("exports", "report #1 中文.html");

		const result = await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "export_html", outputPath: relativePath },
			{
				connectionId: "connection",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);

		const exportedPath = fs.realpathSync(path.join(cwd, relativePath));
		expect(result.response).toMatchObject({
			success: true,
			command: "export_html",
			data: {
				path: exportedPath,
				url: pathToFileURL(exportedPath).href,
			},
		});
		const exportUrl = (result.response as unknown as { data: { url: string } }).data.url;
		expect(exportUrl).toContain("%23");
		expect(exportUrl).toContain("%E4%B8%AD%E6%96%87");
	});

	it("rejects an HTML export response whose file is unavailable", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "export-missing");
		const { supervisor } = createHarness({
			targets: [target],
			env: { PI_WEB_FIXTURE_EXPORT_MISSING: "1" },
		});
		const lease = await supervisor.claim(target.sessionHandle, "connection");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;

		await expect(
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "export_html", outputPath: "missing.html" },
				{
					connectionId: "connection",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("exported HTML file is unavailable");
	});

	it("rejects an HTML export response that resolves to a directory", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "export-directory");
		const { supervisor } = createHarness({
			targets: [target],
			env: { PI_WEB_FIXTURE_EXPORT_DIRECTORY: "1" },
		});
		const lease = await supervisor.claim(target.sessionHandle, "connection");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;

		await expect(
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "export_html", outputPath: "directory-export" },
				{
					connectionId: "connection",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("exported HTML path is not a regular file");
	});

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

	it("keeps admitted work alive but fences later mutations after the controller releases", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		const checkpointDir = path.join(root, "checkpoints");
		fs.mkdirSync(cwd);
		fs.mkdirSync(checkpointDir);
		const target = createNativeSession(root, cwd, "lease-admission-boundary");
		const { supervisor } = createHarness({
			targets: [target],
			env: { PI_WEB_FIXTURE_CHECKPOINT_DIR: checkpointDir },
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		if (!lease.fencingToken) throw new Error("controller lease was not granted");
		const runtime = supervisor.getRuntime(target.sessionHandle)!;

		const accepted = await supervisor.sendCommand(
			target.sessionHandle,
			{ id: "admitted-before-release", type: "prompt", message: "snapshot-checkpoint:thinking" },
			{
				connectionId: "controller",
				expectedGeneration: runtime.generation,
				fencingToken: lease.fencingToken,
			},
		);
		expect(accepted.response).toMatchObject({ command: "prompt", success: true });
		expect(supervisor.getRuntime(target.sessionHandle)?.state).toBe("running");

		expect(supervisor.release(target.sessionHandle, "controller")).toBe(true);
		await expect(
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "set_session_name", name: "must-not-admit-after-release" },
				{
					connectionId: "controller",
					expectedGeneration: runtime.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("session_read_only");
		expect(supervisor.getRuntime(target.sessionHandle)?.state).toBe("running");

		fs.writeFileSync(path.join(checkpointDir, `${target.nativeSessionId}-thinking.release`), "");
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle");
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
			await supervisor.subscribe(target.sessionHandle, {
				serverEpoch: supervisor.serverEpoch,
				generation: current.generation,
				seq: 0,
			}),
		).toMatchObject({ type: "resync_required", reason: "gap" });
		const replay = await supervisor.subscribe(target.sessionHandle, {
			serverEpoch: supervisor.serverEpoch,
			generation: current.generation,
			seq: current.lastSeq - 1,
		});
		expect(replay.type).toBe("replay");
		if (replay.type === "replay") expect(replay.frames).toHaveLength(1);
	});

	it("omits notify from replay and turns a cursor crossing its transient seq into a snapshot gap", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "notify-replay-gap");
		const { supervisor, messages } = createHarness({ targets: [target] });
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const before = supervisor.getRuntime(target.sessionHandle)!;

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "notify-then-event" },
			{
				connectionId: "controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "idle");
		const notify = messages.find(
			(message) => message.type === "extension_ui_request" && message.request.method === "notify",
		);
		if (notify?.type !== "extension_ui_request") throw new Error("notify was not published live");

		const crossed = await supervisor.subscribe(target.sessionHandle, {
			serverEpoch: supervisor.serverEpoch,
			generation: before.generation,
			seq: before.lastSeq,
		});
		expect(crossed).toMatchObject({ type: "resync_required", reason: "gap" });

		const suffix = await supervisor.subscribe(target.sessionHandle, {
			serverEpoch: supervisor.serverEpoch,
			generation: before.generation,
			seq: notify.seq,
		});
		if (suffix.type !== "replay") throw new Error("post-notify cursor did not replay its suffix");
		expect(
			suffix.frames.some(
				(frame) => frame.type === "extension_ui_request" && frame.request.method === "notify",
			),
		).toBe(false);
		expect(suffix.frames.map((frame) => frame.seq)).toEqual(
			Array.from({ length: suffix.frames.length }, (_, index) => notify.seq + index + 1),
		);
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
				serverEpoch: supervisor.serverEpoch,
				generation: current.generation,
				seq: 0,
			});
			expect(expired).toMatchObject({ type: "resync_required", reason: "gap" });
			const retained = await supervisor.subscribe(target.sessionHandle, {
				serverEpoch: supervisor.serverEpoch,
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
		if (replay.type !== "resync_required") throw new Error("initial subscription did not resync");
		expect(replay.snapshot.stickyExtensionState).toHaveLength(4);
		expect(
			replay.snapshot.stickyExtensionState.map((request) =>
				request.method === "setStatus" ? request.statusKey : request.method,
			),
		).toEqual(["status-8", "status-9", "status-10", "status-11"]);
		expect(Buffer.byteLength(JSON.stringify(replay.snapshot.stickyExtensionState))).toBeLessThan(4_096);
	});

	it("keeps an existing dialog and timer when its same-id replacement exceeds the state limit", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "dialog-replacement-atomic");
		const { supervisor, messages } = createHarness({
			targets: [target],
			extensionStateMaxBytes: 256,
			maxAutoRestarts: 0,
		});

		await supervisor.activate(target.sessionHandle);
		const runtime = exactRuntimeObject(supervisor, target.sessionHandle);
		deliverExtension(runtime, {
			type: "extension_ui_request",
			id: "same-dialog",
			method: "confirm",
			title: "Original",
			message: "Keep me",
			timeout: 75,
		});
		messages.length = 0;

		expect(() =>
			deliverExtension(runtime, {
				type: "extension_ui_request",
				id: "same-dialog",
				method: "confirm",
				title: "Replacement",
				message: "x".repeat(1_024),
			}),
		).toThrow("pending_dialog_state_limit_exceeded");
		expect(messages).toEqual([]);
		expect(supervisor.getRuntime(target.sessionHandle)?.lastSeq).toBe(1);
		expect(supervisor.getPendingExtensionRequests(target.sessionHandle)).toEqual([
			expect.objectContaining({ id: "same-dialog", title: "Original" }),
		]);

		await waitFor(() =>
			messages.some(
				(message) =>
					message.type === "extension_ui_closed" &&
					message.requestId === "same-dialog" &&
					message.reason === "expired",
			),
		);
		expect(supervisor.getPendingExtensionRequests(target.sessionHandle)).toEqual([]);
	});

	it("terminalizes an atomically rejected sticky batch without publishing partial Extension frames", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "sticky-batch-atomic");
		const { supervisor, messages } = createHarness({
			targets: [target],
			extensionStateMaxItems: 2,
			maxAutoRestarts: 0,
		});

		await supervisor.activate(target.sessionHandle);
		const runtime = exactRuntimeObject(supervisor, target.sessionHandle);
		for (const statusKey of ["oldest", "newer"]) {
			deliverExtension(runtime, {
				type: "extension_ui_request",
				id: `status-${statusKey}`,
				method: "setStatus",
				statusKey,
				statusText: statusKey,
			});
		}
		for (let index = 0; index < 6; index += 1) {
			deliverExtension(runtime, {
				type: "extension_ui_request",
				id: `notify-${String(index)}`,
				method: "notify",
				message: "advance-sequence",
				notifyType: "info",
			});
		}
		expect(supervisor.getRuntime(target.sessionHandle)?.lastSeq).toBe(8);
		const projection = runtimeProjection(runtime);
		const limits: unknown = Reflect.get(projection, "limits");
		if (typeof limits !== "object" || limits === null) throw new Error("Projection limits unavailable");
		const originalMaxSnapshotBytes: unknown = Reflect.get(limits, "maxSnapshotBytes");
		if (typeof originalMaxSnapshotBytes !== "number") throw new Error("Snapshot limit unavailable");
		Reflect.set(limits, "maxSnapshotBytes", Buffer.byteLength(JSON.stringify(projection.snapshot())));
		messages.length = 0;

		expect(() =>
			deliverExtension(runtime, {
				type: "extension_ui_request",
				id: "status-next",
				method: "setStatus",
				statusKey: "next",
				statusText: "next",
			}),
		).toThrow("session_snapshot_overflow");
		Reflect.set(limits, "maxSnapshotBytes", originalMaxSnapshotBytes);
		expect(messages.filter((message) => message.type === "extension_ui_request")).toEqual([]);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			state: "crashed",
			error: "session_snapshot_overflow",
			lastSeq: 8,
		});
		expect([...runtimeMap(runtime, "stickyExtension").keys()]).toEqual([]);
	});

	it("commits a successful sticky clear-and-set pair consecutively", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "sticky-batch-success");
		const { supervisor, messages } = createHarness({
			targets: [target],
			extensionStateMaxItems: 2,
			maxAutoRestarts: 0,
		});

		await supervisor.activate(target.sessionHandle);
		const runtime = exactRuntimeObject(supervisor, target.sessionHandle);
		for (const statusKey of ["oldest", "newer"]) {
			deliverExtension(runtime, {
				type: "extension_ui_request",
				id: `status-${statusKey}`,
				method: "setStatus",
				statusKey,
				statusText: statusKey,
			});
		}
		messages.length = 0;

		deliverExtension(runtime, {
			type: "extension_ui_request",
			id: "status-next",
			method: "setStatus",
			statusKey: "next",
			statusText: "next",
		});
		const frames = messages.filter(
			(message) =>
				message.type === "extension_ui_request" &&
				message.request.method === "setStatus" &&
				(message.request.statusKey === "oldest" || message.request.statusKey === "next"),
		);
		expect(frames).toHaveLength(2);
		expect(frames.map((frame) => ("seq" in frame ? frame.seq : -1))).toEqual([3, 4]);
		expect(frames[0]).toMatchObject({ request: { statusKey: "oldest", statusText: undefined } });
		expect(frames[1]).toMatchObject({ request: { statusKey: "next", statusText: "next" } });
		expect([...runtimeMap(runtime, "stickyExtension").keys()]).toEqual(["setStatus:newer", "setStatus:next"]);
	});

	it("publishes committed Extension callbacks only after projection, replay, and runtime waterlines agree", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "extension-commit-waterline");
		const { supervisor } = createHarness({ targets: [target], maxAutoRestarts: 0 });

		await supervisor.activate(target.sessionHandle);
		const runtime = exactRuntimeObject(supervisor, target.sessionHandle);
		const options: unknown = Reflect.get(runtime, "opts");
		if (typeof options !== "object" || options === null) throw new Error("Runtime options unavailable");
		const originalHotSetChanged: unknown = Reflect.get(options, "onHotSetChanged");
		const originalEmit: unknown = Reflect.get(options, "emit");
		if (typeof originalHotSetChanged !== "function" || typeof originalEmit !== "function") {
			throw new Error("Runtime callbacks unavailable");
		}
		const observations: Array<{
			source: "hot_set" | "message";
			projectionAsOfSeq: number;
			runtimeLastSeq: number;
			replayLastSeq: number;
		}> = [];
		Reflect.set(options, "onHotSetChanged", () => {
			observations.push({ source: "hot_set", ...runtimeSemanticWaterline(runtime) });
			Reflect.apply(originalHotSetChanged, undefined, []);
		});
		Reflect.set(options, "emit", (message: unknown) => {
			if (
				typeof message === "object" &&
				message !== null &&
				Reflect.get(message, "type") === "runtime_state"
			) {
				observations.push({ source: "message", ...runtimeSemanticWaterline(runtime) });
			}
			Reflect.apply(originalEmit, undefined, [message]);
		});

		try {
			deliverExtension(runtime, {
				type: "extension_ui_request",
				id: "waterline-dialog",
				method: "confirm",
				title: "Waterline",
				message: "Observe the committed state",
			});

			expect(observations).toEqual([
				{ source: "hot_set", projectionAsOfSeq: 1, runtimeLastSeq: 1, replayLastSeq: 1 },
				{ source: "message", projectionAsOfSeq: 1, runtimeLastSeq: 1, replayLastSeq: 1 },
			]);
		} finally {
			Reflect.set(options, "onHotSetChanged", originalHotSetChanged);
			Reflect.set(options, "emit", originalEmit);
		}
	});

	it("keeps committed Extension state coherent when the first publish and its logger throw", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "extension-post-commit-effect-failure");
		const { supervisor, messages } = createHarness({ targets: [target], maxAutoRestarts: 0 });

		await supervisor.activate(target.sessionHandle);
		const runtime = exactRuntimeObject(supervisor, target.sessionHandle);
		deliverExtension(runtime, {
			type: "extension_ui_request",
			id: "same-dialog",
			method: "confirm",
			title: "Original",
			message: "Original",
		});
		messages.length = 0;

		const options: unknown = Reflect.get(runtime, "opts");
		if (typeof options !== "object" || options === null) throw new Error("Runtime options unavailable");
		const originalEmit: unknown = Reflect.get(options, "emit");
		const originalLog: unknown = Reflect.get(options, "log");
		if (typeof originalEmit !== "function") throw new Error("Runtime message callback unavailable");
		const attemptedTypes: string[] = [];
		let rejectFirstCommittedFrame = true;
		Reflect.set(options, "emit", (message: unknown) => {
			const type = typeof message === "object" && message !== null ? Reflect.get(message, "type") : undefined;
			if (type === "extension_ui_closed" || type === "extension_ui_request") {
				attemptedTypes.push(type);
				if (rejectFirstCommittedFrame) {
					rejectFirstCommittedFrame = false;
					throw new Error("fixture first committed publish failed");
				}
			}
			Reflect.apply(originalEmit, undefined, [message]);
		});
		Reflect.set(options, "log", () => {
			throw new Error("fixture committed-effect logger failed");
		});

		try {
			expect(() =>
				deliverExtension(runtime, {
					type: "extension_ui_request",
					id: "same-dialog",
					method: "confirm",
					title: "Replacement",
					message: "Replacement",
				}),
			).not.toThrow();
			expect(attemptedTypes).toEqual(["extension_ui_closed", "extension_ui_request"]);
			expect(runtimeSemanticWaterline(runtime)).toEqual({
				projectionAsOfSeq: 3,
				runtimeLastSeq: 3,
				replayLastSeq: 3,
			});
			expect(supervisor.getPendingExtensionRequests(target.sessionHandle)).toEqual([
				expect.objectContaining({ id: "same-dialog", title: "Replacement" }),
			]);
			const replay = await supervisor.subscribe(target.sessionHandle, {
				serverEpoch: supervisor.serverEpoch,
				generation: supervisor.getRuntime(target.sessionHandle)!.generation,
				seq: 1,
			});
			if (replay.type !== "replay") throw new Error("Committed Extension suffix was not replayable");
			expect(replay.frames.map((frame) => frame.seq)).toEqual([2, 3]);
			expect(
				messages.filter(
					(message) => message.type === "extension_ui_closed" || message.type === "extension_ui_request",
				),
			).toEqual([expect.objectContaining({ type: "extension_ui_request", seq: 3 })]);
		} finally {
			Reflect.set(options, "emit", originalEmit);
			Reflect.set(options, "log", originalLog);
		}
	});

	it("commits same-id close and replacement consecutively and fences the old timer entry", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "dialog-timer-entry-fence");
		const { supervisor, messages } = createHarness({ targets: [target], maxAutoRestarts: 0 });

		await supervisor.activate(target.sessionHandle);
		const runtime = exactRuntimeObject(supervisor, target.sessionHandle);
		deliverExtension(runtime, {
			type: "extension_ui_request",
			id: "same-dialog",
			method: "confirm",
			title: "Original",
			message: "Original",
			timeout: 1_000,
		});
		const initial = await supervisor.subscribe(target.sessionHandle);
		expect(initial).toMatchObject({
			type: "resync_required",
			snapshot: { runtime: { state: "waiting_ui" } },
		});
		const oldEntry = runtimeMap(runtime, "pendingDialogs").get("same-dialog");
		if (!oldEntry) throw new Error("Original dialog entry unavailable");
		messages.length = 0;

		deliverExtension(runtime, {
			type: "extension_ui_request",
			id: "same-dialog",
			method: "confirm",
			title: "Replacement",
			message: "Replacement",
			timeout: 1_000,
		});
		const semanticFrames = messages.filter(
			(message) => message.type === "extension_ui_closed" || message.type === "extension_ui_request",
		);
		expect(semanticFrames.map((frame) => ("seq" in frame ? frame.seq : -1))).toEqual([2, 3]);
		expect(semanticFrames.map((frame) => frame.type)).toEqual([
			"extension_ui_closed",
			"extension_ui_request",
		]);
		messages.length = 0;
		expireDialogEntry(runtime, "same-dialog", oldEntry);
		expect(messages).toEqual([]);
		expect(supervisor.getPendingExtensionRequests(target.sessionHandle)).toEqual([
			expect.objectContaining({ id: "same-dialog", title: "Replacement" }),
		]);
	});

	it("uses one 256-item sticky authority and publishes explicit clears for live eviction", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "sticky-authority");
		const { supervisor, messages } = createHarness({
			targets: [target],
			env: { PI_WEB_FIXTURE_STICKY_COUNT: "257" },
			maxAutoRestarts: 0,
		});

		await expect(supervisor.activate(target.sessionHandle)).resolves.toMatchObject({ state: "idle" });
		const initial = await supervisor.subscribe(target.sessionHandle);
		if (initial.type !== "resync_required") throw new Error("initial subscription did not resync");
		expect(initial.snapshot.stickyExtensionState).toHaveLength(256);
		expect(initial.snapshot.stickyExtensionState[0]).toMatchObject({
			method: "setStatus",
			statusKey: "status-1",
		});
		expect(
			messages.some(
				(message) =>
					message.type === "extension_ui_request" &&
					message.request.method === "setStatus" &&
					message.request.statusKey === "status-0" &&
					message.request.statusText === undefined,
			),
		).toBe(true);
		const liveStatuses = new Map<string, string>();
		for (const message of messages) {
			if (message.type !== "extension_ui_request" || message.request.method !== "setStatus") continue;
			if (message.request.statusText === undefined) liveStatuses.delete(message.request.statusKey);
			else liveStatuses.set(message.request.statusKey, message.request.statusText);
		}
		expect([...liveStatuses.keys()]).toEqual(
			initial.snapshot.stickyExtensionState.flatMap((request) =>
				request.method === "setStatus" ? [request.statusKey] : [],
			),
		);
	});

	it("clears an existing sticky key when an oversized replacement cannot be snapshotted", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "sticky-oversized-replacement");
		const { supervisor, messages } = createHarness({
			targets: [target],
			extensionStateMaxBytes: 256,
			env: { PI_WEB_FIXTURE_STICKY_REPLACEMENT_BYTES: "1024" },
		});

		await supervisor.activate(target.sessionHandle);
		const initial = await supervisor.subscribe(target.sessionHandle);
		if (initial.type !== "resync_required") throw new Error("initial subscription did not resync");
		expect(initial.snapshot.stickyExtensionState).toEqual([]);
		const replacementFrames = messages.filter(
			(message) =>
				message.type === "extension_ui_request" &&
				message.request.method === "setStatus" &&
				message.request.statusKey === "replacement",
		);
		expect(replacementFrames.at(-1)).toMatchObject({
			type: "extension_ui_request",
			request: { statusText: undefined },
		});
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

	it("rebuilds an overflowed runtime on manual restart without an unhandled rejection", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "overflow-restart");
		const marker = path.join(root, "overflow-marker");
		const { supervisor } = createHarness({
			targets: [target],
			projectionLimits: { maxLiveEventItems: 8 },
			maxAutoRestarts: 0,
			env: { PI_WEB_FIXTURE_OVERFLOW_MARKER: marker },
		});
		const lease = await supervisor.claim(target.sessionHandle, "controller");
		const before = supervisor.getRuntime(target.sessionHandle)!;
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await supervisor.sendCommand(
				target.sessionHandle,
				{ type: "prompt", message: "overflow-once" },
				{
					connectionId: "controller",
					expectedGeneration: before.generation,
					fencingToken: lease.fencingToken,
				},
			);
			await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");
			const restarted = await supervisor.restart(target.sessionHandle);
			expect(restarted).toMatchObject({ state: "idle", generation: before.generation + 1 });
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("keeps protocol-incompatible runtimes terminal and never auto-restarts them", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "protocol-incompatible");
		const marker = path.join(root, "lifecycle.log");
		const { supervisor } = createHarness({
			targets: [target],
			restartBaseDelayMs: 5,
			env: { PI_WEB_FIXTURE_LIFECYCLE_MARKER: marker },
		});
		const lease = await supervisor.claim(target.sessionHandle, "connection");
		const before = supervisor.getRuntime(target.sessionHandle)!;

		await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "prompt", message: "protocol-incompatible" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);

		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "crashed");
		await new Promise<void>((resolve) => setTimeout(resolve, 75));
		const terminal = supervisor.getRuntime(target.sessionHandle)!;
		expect(terminal.error).toBe("protocol_incompatible");
		expect(terminal.generation).toBe(before.generation);
		expect(fs.readFileSync(marker, "utf8").match(/^start:/gm)).toHaveLength(1);
		await expect(supervisor.restart(target.sessionHandle)).rejects.toThrow("protocol_incompatible");
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

	it.each([
		{ name: "default-off", services: false },
		{ name: "payload-enabled", services: true },
	])("settles a $name stop while the ready handshake is still pending", async ({ services }) => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, `startup-stop-${String(services)}`);
		const adapter: PiHostAdapter = services
			? {
					...piRpcAdapter,
					decodeResponse(value, expectedCommand, context) {
						return piRpcAdapter.decodeResponse(value, expectedCommand, context);
					},
					decodeUnsolicited(value, context) {
						return piRpcAdapter.decodeUnsolicited(value, context);
					},
				}
			: piRpcAdapter;
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const { supervisor } = createHarness({
			targets: [target],
			adapter,
			...(services ? { piPayloadServices: testPayloadServices(released) } : {}),
			env: { PI_WEB_FIXTURE_READY_DELAY_MS: "250" },
			maxAutoRestarts: 0,
		});

		const activation = supervisor.activate(target.sessionHandle);
		await waitFor(() => supervisor.getRuntime(target.sessionHandle)?.state === "starting");
		const stopping = supervisor.stop(target.sessionHandle);
		const settled = Promise.allSettled([activation, stopping]);

		await expect(
			Promise.race([
				settled.then(() => "settled" as const),
				new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 1_000)),
			]),
		).resolves.toBe("settled");
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({ state: "dormant" });
		expect(released).toEqual([]);
	});

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

	it("uses the explicit hot-process budget for runtime admission", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "process-budget-first");
		const second = createNativeSession(root, cwd, "process-budget-second");
		const { supervisor } = createHarness({ targets: [first, second], maxHotProcesses: 1 });

		await supervisor.claim(first.sessionHandle, "process-budget-connection");
		await expect(supervisor.activate(second.sessionHandle)).rejects.toThrow("session_runtime_capacity");
	});

	it("protects the aggregate retained projection budget from a second hot process", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "projection-budget-first");
		const second = createNativeSession(root, cwd, "projection-budget-second");
		const { supervisor } = createHarness({
			targets: [first, second],
			maxRetainedProjectionBytes: SESSION_SNAPSHOT_MAX_BYTES,
		});

		await supervisor.claim(first.sessionHandle, "projection-budget-connection");
		await expect(supervisor.activate(second.sessionHandle)).rejects.toThrow("session_projection_capacity");
	});

	it("bounds pending commands per Session without coupling independent Sessions", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "command-capacity-first");
		const second = createNativeSession(root, cwd, "command-capacity-second");
		const { supervisor } = createHarness({
			targets: [first, second],
			maxPendingCommands: 1,
			env: { PI_WEB_FIXTURE_COMPACTION_DELAY_MS: "200" },
		});
		const [firstRuntime, secondRuntime] = await Promise.all([
			supervisor.activate(first.sessionHandle),
			supervisor.activate(second.sessionHandle),
		]);
		const context = (runtime: SessionRuntimeSnapshot) => ({
			connectionId: "observer",
			expectedGeneration: runtime.generation,
		});

		const firstPending = supervisor.sendCommand(
			first.sessionHandle,
			{ type: "get_messages", id: "first-pending" },
			context(firstRuntime),
		);
		const secondPending = supervisor.sendCommand(
			second.sessionHandle,
			{ type: "get_messages", id: "second-pending" },
			context(secondRuntime),
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 25));

		await expect(
			supervisor.sendCommand(
				first.sessionHandle,
				{ type: "get_state", id: "first-over-capacity" },
				context(firstRuntime),
			),
		).rejects.toThrow("session_runtime_command_capacity");
		await expect(Promise.all([firstPending, secondPending])).resolves.toHaveLength(2);
	});

	it("pins an idle controller lease against capacity eviction until release", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const first = createNativeSession(root, cwd, "capacity-leased");
		const second = createNativeSession(root, cwd, "capacity-after-release");
		const { supervisor } = createHarness({ targets: [first, second], maxHotRuntimes: 1 });

		await supervisor.claim(first.sessionHandle, "controller");
		await expect(supervisor.activate(second.sessionHandle)).rejects.toThrow("session_runtime_capacity");
		expect(supervisor.getRuntime(first.sessionHandle)?.state).toBe("idle");

		expect(supervisor.release(first.sessionHandle, "controller")).toBe(true);
		await expect(supervisor.activate(second.sessionHandle)).resolves.toMatchObject({ state: "idle" });
		expect(supervisor.getRuntime(first.sessionHandle)?.state).toBe("dormant");
	});

	it("pins an idle controller lease against TTL eviction until release", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const target = createNativeSession(root, cwd, "ttl-leased");
		const { supervisor } = createHarness({ targets: [target], idleTtlMs: 0 });
		const reapIdle = () => (supervisor as unknown as { reapIdle: () => Promise<void> }).reapIdle();

		await supervisor.claim(target.sessionHandle, "controller");
		await reapIdle();
		expect(supervisor.getRuntime(target.sessionHandle)?.state).toBe("idle");

		expect(supervisor.release(target.sessionHandle, "controller")).toBe(true);
		await reapIdle();
		expect(supervisor.getRuntime(target.sessionHandle)?.state).toBe("dormant");
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

	it("reaps a stale unclaimed transient Session without touching the filesystem", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const { supervisor, messages } = createHarness({ targets: [], transientIdleTtlMs: 0 });
		const stale = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "stale-unclaimed",
		});
		const claimed = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "stale-but-claimed",
		});
		await supervisor.claim(claimed.sessionHandle, "controller");
		messages.length = 0;

		await (supervisor as unknown as { reapIdle: () => Promise<void> }).reapIdle();

		expect(supervisor.getRuntime(stale.sessionHandle)).toBeUndefined();
		expect(stale.sessionFile && fs.existsSync(stale.sessionFile)).toBe(false);
		expect(supervisor.getRuntime(claimed.sessionHandle)).toMatchObject({ state: "idle", recoverable: false });
		expect(messages).toContainEqual({ type: "session_directory_changed", workspaceId: "workspace" });
	});

	it("abandons only an untouched transient Session owned by the exact controller", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const { supervisor, messages } = createHarness({ targets: [] });
		const created = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "transient-success",
		});
		const lease = await supervisor.claim(created.sessionHandle, "controller");
		if (!lease.fencingToken || !created.sessionFile) throw new Error("transient controller was not ready");
		messages.length = 0;

		await supervisor.abandonTransient("workspace", created.sessionHandle, {
			expectedGeneration: created.generation,
			fencingToken: lease.fencingToken,
		});

		expect(fs.existsSync(created.sessionFile)).toBe(false);
		expect(supervisor.getRuntime(created.sessionHandle)).toBeUndefined();
		expect(supervisor.leaseFor(created.sessionHandle, "controller")).toEqual({
			serverEpoch: supervisor.serverEpoch,
			sessionHandle: created.sessionHandle,
			generation: 0,
			isController: false,
		});
		expect(messages).toContainEqual({ type: "session_directory_changed", workspaceId: "workspace" });
	});

	it("rejects observer, stale-generation, stale-fence, and cross-Workspace transient abandon", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const { supervisor } = createHarness({ targets: [] });
		const created = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "transient-capability",
		});
		const lease = await supervisor.claim(created.sessionHandle, "controller");
		if (!lease.fencingToken) throw new Error("controller lease was not granted");
		expect(await supervisor.claim(created.sessionHandle, "observer")).toMatchObject({
			isController: false,
		});

		await expect(
			supervisor.abandonTransient("workspace", created.sessionHandle, {
				expectedGeneration: created.generation,
				fencingToken: "observer-has-no-capability",
			}),
		).rejects.toThrow("session_read_only");
		await expect(
			supervisor.abandonTransient("workspace", created.sessionHandle, {
				expectedGeneration: created.generation + 1,
				fencingToken: lease.fencingToken,
			}),
		).rejects.toThrow("session_generation_stale");
		await expect(
			supervisor.abandonTransient("workspace", created.sessionHandle, {
				expectedGeneration: created.generation,
				fencingToken: "stale-token",
			}),
		).rejects.toThrow("session_read_only");
		await expect(
			supervisor.abandonTransient("foreign-workspace", created.sessionHandle, {
				expectedGeneration: created.generation,
				fencingToken: lease.fencingToken,
			}),
		).rejects.toThrow("session_control_required");
		expect(supervisor.getRuntime(created.sessionHandle)).toMatchObject({ state: "idle", recoverable: false });
	});

	it("rejects transient abandon during a Workspace identity transition", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "transient-transition-parent");
		const { supervisor } = createHarness({
			targets: [parent],
			env: { PI_WEB_FIXTURE_TRANSITION_STATE_DELAY_MS: "250" },
		});
		const parentLease = await supervisor.claim(parent.sessionHandle, "parent-controller");
		const parentRuntime = supervisor.getRuntime(parent.sessionHandle)!;
		const transient = await supervisor.createSession({
			workspaceId: parent.workspaceId,
			cwd,
			sessionDir: path.join(root, "transient-sessions"),
			requestedNativeSessionId: "transient-transition-candidate",
		});
		const transientLease = await supervisor.claim(transient.sessionHandle, "transient-controller");
		if (!parentLease.fencingToken || !transientLease.fencingToken) {
			throw new Error("controller lease was not granted");
		}

		const transitioning = supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "parent-controller",
				expectedGeneration: parentRuntime.generation,
				fencingToken: parentLease.fencingToken,
			},
		);
		await waitFor(() =>
			(supervisor as unknown as { workspaceTransitions: Set<string> }).workspaceTransitions.has(
				parent.workspaceId,
			),
		);
		await expect(
			supervisor.abandonTransient(parent.workspaceId, transient.sessionHandle, {
				expectedGeneration: transient.generation,
				fencingToken: transientLease.fencingToken,
			}),
		).rejects.toThrow("workspace_identity_transitioning");
		await transitioning;
		expect(supervisor.getRuntime(transient.sessionHandle)).toMatchObject({ state: "idle" });
	});

	it("allows exact transient abandon after no-op and failed metadata mutations", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const { supervisor } = createHarness({
			targets: [],
			env: {
				PI_WEB_FIXTURE_FAIL_MUTATION: "set_model",
				PI_WEB_FIXTURE_EXPORT_MISSING: "1",
			},
		});

		const createControlled = async (nativeSessionId: string) => {
			const created = await supervisor.createSession({
				workspaceId: "workspace",
				cwd,
				sessionDir: path.join(root, "sessions"),
				requestedNativeSessionId: nativeSessionId,
			});
			const lease = await supervisor.claim(created.sessionHandle, `controller-${nativeSessionId}`);
			if (!lease.fencingToken) throw new Error("controller lease was not granted");
			return { created, lease };
		};
		const contextFor = (
			created: SessionRuntimeSnapshot,
			lease: { fencingToken?: string },
			connectionId: string,
		) => ({
			connectionId,
			expectedGeneration: created.generation,
			fencingToken: lease.fencingToken,
		});

		const mutated = await createControlled("transient-noop-and-failed");
		await supervisor.sendCommand(
			mutated.created.sessionHandle,
			{ type: "set_thinking_level", level: "off" },
			contextFor(mutated.created, mutated.lease, "controller-transient-noop-and-failed"),
		);
		const failedModel = await supervisor.sendCommand(
			mutated.created.sessionHandle,
			{ type: "set_model", provider: "fixture", modelId: "missing" },
			contextFor(mutated.created, mutated.lease, "controller-transient-noop-and-failed"),
		);
		expect(failedModel.response).toMatchObject({ success: false, command: "set_model" });
		await expect(
			supervisor.sendCommand(
				mutated.created.sessionHandle,
				{ type: "export_html", outputPath: "missing.html" },
				contextFor(mutated.created, mutated.lease, "controller-transient-noop-and-failed"),
			),
		).rejects.toThrow("exported HTML file is unavailable");
		expect(supervisor.getRuntime(mutated.created.sessionHandle)).toMatchObject({
			state: "idle",
			recoverable: false,
		});
		await supervisor.abandonTransient("workspace", mutated.created.sessionHandle, {
			expectedGeneration: mutated.created.generation,
			fencingToken: mutated.lease.fencingToken!,
		});
		expect(supervisor.getRuntime(mutated.created.sessionHandle)).toBeUndefined();
	});

	it("reaps repeated no-op transient mutations before they exhaust the hot pool", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const maxHotRuntimes = 2;
		const { supervisor } = createHarness({
			targets: [],
			maxHotRuntimes,
			transientIdleTtlMs: 0,
		});
		const reapIdle = () => (supervisor as unknown as { reapIdle: () => Promise<void> }).reapIdle();

		for (let index = 0; index <= maxHotRuntimes; index += 1) {
			const connectionId = `controller-noop-${String(index)}`;
			const created = await supervisor.createSession({
				workspaceId: "workspace",
				cwd,
				sessionDir: path.join(root, "sessions"),
				requestedNativeSessionId: `transient-noop-${String(index)}`,
			});
			const lease = await supervisor.claim(created.sessionHandle, connectionId);
			if (!lease.fencingToken) throw new Error("controller lease was not granted");
			await supervisor.sendCommand(
				created.sessionHandle,
				{ type: "set_thinking_level", level: "off" },
				{
					connectionId,
					expectedGeneration: created.generation,
					fencingToken: lease.fencingToken,
				},
			);
			expect(supervisor.release(created.sessionHandle, connectionId)).toBe(true);
			await reapIdle();
			expect(supervisor.getRuntime(created.sessionHandle)).toBeUndefined();
		}
	});

	it("retains an unpersisted accepted multimodal prompt as genuine in-memory conversation state", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const { supervisor } = createHarness({
			targets: [],
			env: { PI_WEB_FIXTURE_SKIP_PROMPT_PERSIST: "1" },
		});
		const created = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "transient-memory-conversation",
		});
		const connectionId = "controller-memory-conversation";
		const lease = await supervisor.claim(created.sessionHandle, connectionId);
		if (!lease.fencingToken) throw new Error("controller lease was not granted");
		await supervisor.sendCommand(
			created.sessionHandle,
			{
				type: "prompt",
				message: "",
				images: [{ type: "image", data: "YQ==", mimeType: "image/png" }],
			},
			{
				connectionId,
				expectedGeneration: created.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(created.sessionHandle)?.state === "idle");
		expect(supervisor.getRuntime(created.sessionHandle)).toMatchObject({ recoverable: false });
		await expect(
			supervisor.abandonTransient("workspace", created.sessionHandle, {
				expectedGeneration: created.generation,
				fencingToken: lease.fencingToken,
			}),
		).rejects.toThrow("session_not_abandonable");
	});

	it("refuses transient abandon while running or waiting on UI", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const { supervisor } = createHarness({ targets: [] });

		const createControlled = async (nativeSessionId: string) => {
			const created = await supervisor.createSession({
				workspaceId: "workspace",
				cwd,
				sessionDir: path.join(root, "sessions"),
				requestedNativeSessionId: nativeSessionId,
			});
			const lease = await supervisor.claim(created.sessionHandle, `controller-${nativeSessionId}`);
			if (!lease.fencingToken) throw new Error("controller lease was not granted");
			return { created, lease };
		};
		const contextFor = (
			created: SessionRuntimeSnapshot,
			lease: { fencingToken?: string },
			connectionId: string,
		) => ({
			connectionId,
			expectedGeneration: created.generation,
			fencingToken: lease.fencingToken,
		});

		const running = await createControlled("transient-running");
		await supervisor.sendCommand(
			running.created.sessionHandle,
			{ type: "prompt", message: "slow" },
			contextFor(running.created, running.lease, "controller-transient-running"),
		);
		expect(supervisor.getRuntime(running.created.sessionHandle)?.state).toBe("running");
		await expect(
			supervisor.abandonTransient("workspace", running.created.sessionHandle, {
				expectedGeneration: running.created.generation,
				fencingToken: running.lease.fencingToken!,
			}),
		).rejects.toThrow("session_not_abandonable");

		const waiting = await createControlled("transient-waiting");
		await supervisor.sendCommand(
			waiting.created.sessionHandle,
			{ type: "prompt", message: "open-dialog-no-agent" },
			contextFor(waiting.created, waiting.lease, "controller-transient-waiting"),
		);
		expect(supervisor.getRuntime(waiting.created.sessionHandle)?.state).toBe("waiting_ui");
		await expect(
			supervisor.abandonTransient("workspace", waiting.created.sessionHandle, {
				expectedGeneration: waiting.created.generation,
				fencingToken: waiting.lease.fencingToken!,
			}),
		).rejects.toThrow("session_not_abandonable");
	});

	it("retains a stopped runtime when its JSONL materializes during transient abandon", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const { supervisor } = createHarness({ targets: [] });
		const created = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "transient-materialized-race",
		});
		const lease = await supervisor.claim(created.sessionHandle, "controller");
		if (!lease.fencingToken || !created.sessionFile) throw new Error("transient controller was not ready");
		const internal = supervisor as unknown as { runtimes: Map<string, SessionRuntime> };
		const runtime = internal.runtimes.get(created.sessionHandle)!;
		const originalStop = runtime.stop.bind(runtime);
		runtime.stop = async () => {
			await originalStop();
			fs.mkdirSync(path.dirname(created.sessionFile!), { recursive: true });
			fs.writeFileSync(
				created.sessionFile!,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: created.nativeSessionId,
					timestamp: "2026-08-20T00:00:00.000Z",
					cwd,
				})}\n`,
			);
		};

		await expect(
			supervisor.abandonTransient("workspace", created.sessionHandle, {
				expectedGeneration: created.generation,
				fencingToken: lease.fencingToken,
			}),
		).rejects.toThrow("session_materialized");
		expect(fs.existsSync(created.sessionFile)).toBe(true);
		expect(supervisor.getRuntime(created.sessionHandle)).toMatchObject({
			state: "dormant",
			recoverable: true,
		});
		expect(supervisor.leaseFor(created.sessionHandle, "controller")).toMatchObject({
			isController: true,
			fencingToken: lease.fencingToken,
		});
	});

	it("does not abandon across an already-reserved command admission window", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const { supervisor } = createHarness({ targets: [] });
		const created = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "transient-command-race",
		});
		const lease = await supervisor.claim(created.sessionHandle, "controller");
		if (!lease.fencingToken) throw new Error("controller lease was not granted");
		const internal = supervisor as unknown as { runtimes: Map<string, SessionRuntime> };
		const runtime = internal.runtimes.get(created.sessionHandle)!;
		const originalStart = runtime.start.bind(runtime);
		let releaseStart: (() => void) | undefined;
		let commandReserved = false;
		let startCalls = 0;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		runtime.start = async () => {
			startCalls += 1;
			if (startCalls >= 2) {
				commandReserved = true;
				await startGate;
			}
			await originalStart();
		};

		const command = supervisor.sendCommand(
			created.sessionHandle,
			{ type: "get_state" },
			{
				connectionId: "controller",
				expectedGeneration: created.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => commandReserved);
		await expect(
			supervisor.abandonTransient("workspace", created.sessionHandle, {
				expectedGeneration: created.generation,
				fencingToken: lease.fencingToken,
			}),
		).rejects.toThrow("session_not_abandonable");
		releaseStart?.();
		await expect(command).resolves.toMatchObject({ response: { success: true, command: "get_state" } });
		expect(supervisor.getRuntime(created.sessionHandle)?.state).toBe("idle");
	});

	it("tracks an in-progress transient abandon through shutdown", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const { supervisor } = createHarness({ targets: [] });
		const created = await supervisor.createSession({
			workspaceId: "workspace",
			cwd,
			sessionDir: path.join(root, "sessions"),
			requestedNativeSessionId: "transient-shutdown",
		});
		const lease = await supervisor.claim(created.sessionHandle, "controller");
		if (!lease.fencingToken) throw new Error("controller lease was not granted");
		const internal = supervisor as unknown as { runtimes: Map<string, SessionRuntime> };
		const runtime = internal.runtimes.get(created.sessionHandle)!;
		const originalStop = runtime.stop.bind(runtime);
		let releaseStop: (() => void) | undefined;
		let stopEntered = false;
		const stopGate = new Promise<void>((resolve) => {
			releaseStop = resolve;
		});
		runtime.stop = async () => {
			stopEntered = true;
			await stopGate;
			await originalStop();
		};

		const abandoning = supervisor.abandonTransient("workspace", created.sessionHandle, {
			expectedGeneration: created.generation,
			fencingToken: lease.fencingToken,
		});
		await waitFor(() => stopEntered);
		await expect(
			supervisor.sendCommand(
				created.sessionHandle,
				{ type: "get_state" },
				{
					connectionId: "controller",
					expectedGeneration: created.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("session_deleting");
		const shutdown = supervisor.stopAll();
		const premature = await Promise.race([
			shutdown.then(() => "closed" as const),
			new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 20)),
		]);
		expect(premature).toBe("waiting");
		releaseStop?.();
		await Promise.all([abandoning, shutdown]);
		expect(supervisor.listRuntimes()).toEqual([]);
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

	it("moves staged payload ownership to the verified child before publishing its rekey", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "payload-transition-parent");
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const tracking = { adopted, released };
		const parentBase = trackedLease(attachmentRef("4".repeat(64)), tracking);
		const staged = trackedLease(attachmentRef("5".repeat(64)), tracking);
		const childBase = trackedLease(attachmentRef("6".repeat(64)), tracking);
		const postRekey = trackedLease(attachmentRef("7".repeat(64)), tracking);
		const { supervisor, messages } = createHarness({
			targets: [parent],
			adapter: transitionPayloadAdapter({ parentBase, staged, childBase, postRekey }),
			piPayloadServices: testPayloadServices(released),
			env: { PI_WEB_FIXTURE_TRANSITION_PAYLOAD_EVENTS: "1" },
			maxAutoRestarts: 0,
		});
		const lease = await supervisor.claim(parent.sessionHandle, "controller");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		messages.length = 0;

		const result = await supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => adopted.flat().includes(postRekey.hold));

		expect(result).toMatchObject({
			previousSessionHandle: parent.sessionHandle,
			generation: before.generation + 1,
		});
		expect(result.sessionHandle).not.toBe(parent.sessionHandle);
		expect(released).toEqual([parentBase.hold]);
		expect(adopted.flat()).toEqual(
			expect.arrayContaining([parentBase.hold, staged.hold, childBase.hold, postRekey.hold]),
		);

		const initial = await supervisor.subscribe(result.sessionHandle);
		if (initial.type !== "resync_required") throw new Error("transitioned child did not resync");
		expect(initial.snapshot.settledMessages).toEqual([
			expect.objectContaining({
				content: [expect.objectContaining({ data: childBase.hold.ref })],
			}),
		]);
		expect(initial.snapshot.projectionEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: expect.objectContaining({
						message: expect.objectContaining({
							content: [expect.objectContaining({ data: staged.hold.ref })],
						}),
					}),
				}),
				expect.objectContaining({
					event: expect.objectContaining({
						message: expect.objectContaining({
							content: [expect.objectContaining({ data: postRekey.hold.ref })],
						}),
					}),
				}),
			]),
		);
		expect(JSON.stringify(initial.snapshot)).not.toContain(parentBase.hold.ref.sha256);

		const rekeyIndex = messages.findIndex((message) => message.type === "session_rekeyed");
		const stagedIndex = messages.findIndex(
			(message) =>
				message.type === "event" &&
				message.event.type === "message_end" &&
				message.event.message.role === "user" &&
				Array.isArray(message.event.message.content) &&
				message.event.message.content[0]?.type === "image" &&
				typeof message.event.message.content[0].data === "object" &&
				message.event.message.content[0].data.sha256 === staged.hold.ref.sha256,
		);
		expect(rekeyIndex).toBeGreaterThanOrEqual(0);
		expect(stagedIndex).toBeGreaterThan(rekeyIndex);

		await supervisor.stop(result.sessionHandle);
		expect(released).toEqual(
			expect.arrayContaining([parentBase.hold, staged.hold, childBase.hold, postRekey.hold]),
		);
	});

	it("publishes a child blocking dialog while retired parent cleanup is fenced", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "payload-transition-applying-dialog");
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const tracking = { adopted, released };
		const parentBase = trackedLease(attachmentRef("8".repeat(64)), tracking);
		const staged = trackedLease(attachmentRef("9".repeat(64)), tracking);
		const childBase = trackedLease(attachmentRef("a".repeat(64)), tracking);
		let parentReleaseEntered = false;
		let releaseParent!: () => void;
		const parentReleaseGate = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});
		const services = testPayloadServices(released);
		const { supervisor, messages } = createHarness({
			targets: [parent],
			adapter: transitionPayloadAdapter({ parentBase, staged, childBase }),
			piPayloadServices: {
				...services,
				releaseHold: async (entry) => {
					released.push(entry);
					if (entry === parentBase.hold) {
						parentReleaseEntered = true;
						await parentReleaseGate;
					}
				},
			},
			env: {
				PI_WEB_FIXTURE_TRANSITION_DIALOG_DURING_PARENT_CLEANUP: "1",
				PI_WEB_FIXTURE_TRANSITION_PAYLOAD_EVENTS: "1",
			},
			maxAutoRestarts: 0,
		});
		const lease = await supervisor.claim(parent.sessionHandle, "controller");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		messages.length = 0;

		const transitioning = supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => parentReleaseEntered);
		const dialogVisibleBeforeRelease = await waitFor(
			() =>
				messages.some(
					(message) =>
						message.type === "extension_ui_request" &&
						message.request.id.startsWith("transition-applying-dialog-"),
				),
			500,
		).then(
			() => true,
			() => false,
		);
		const rekeyed = messages.find((message) => message.type === "session_rekeyed");
		const dialog = messages.find(
			(message) =>
				message.type === "extension_ui_request" &&
				message.request.id.startsWith("transition-applying-dialog-"),
		);
		releaseParent();
		const result = await transitioning;

		expect(dialogVisibleBeforeRelease).toBe(true);
		expect(rekeyed).toMatchObject({
			type: "session_rekeyed",
			previousSessionHandle: parent.sessionHandle,
			runtime: { sessionHandle: result.sessionHandle, generation: before.generation + 1 },
		});
		expect(messages.indexOf(dialog!)).toBeGreaterThan(messages.indexOf(rekeyed!));
		const initial = await supervisor.subscribe(result.sessionHandle);
		if (initial.type !== "resync_required") throw new Error("transitioned child did not resync");
		expect(initial.snapshot.asOfSeq).toBe(initial.runtime.lastSeq);
		expect(initial.snapshot.pendingExtensionRequests).toEqual([
			expect.objectContaining({ id: dialog?.type === "extension_ui_request" ? dialog.request.id : "" }),
		]);
	});

	it("cleans a partial child drain and blocks replacement when that cleanup fails", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "payload-transition-partial-drain");
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const tracking = { adopted, released };
		const parentBase = trackedLease(attachmentRef("0".repeat(64)), tracking);
		const staged = trackedLease(attachmentRef("1".repeat(64)), tracking);
		const childBase = trackedLease(attachmentRef("2".repeat(64)), tracking);
		const foreignRef = Object.freeze({
			...attachmentRef("3".repeat(64)),
			serverEpoch: "foreign-transition-epoch",
		});
		const stagedInvalid = trackedLease(attachmentRef("3".repeat(64)), tracking, foreignRef);
		const services = testPayloadServices(released);
		const { supervisor, messages } = createHarness({
			targets: [parent],
			adapter: transitionPayloadAdapter({ parentBase, staged, stagedInvalid, childBase }),
			piPayloadServices: {
				...services,
				releaseHold: async (entry) => {
					released.push(entry);
					if (entry === childBase.hold) throw new Error("fixture child cleanup failed");
				},
			},
			env: {
				PI_WEB_FIXTURE_TRANSITION_PAYLOAD_EVENTS: "1",
				PI_WEB_FIXTURE_TRANSITION_PAYLOAD_PARTIAL: "1",
			},
			maxAutoRestarts: 0,
		});
		const controller = await supervisor.claim(parent.sessionHandle, "controller");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		messages.length = 0;

		await expect(
			supervisor.sendCommand(
				parent.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "controller",
					expectedGeneration: before.generation,
					fencingToken: controller.fencingToken,
				},
			),
		).rejects.toThrow(/cleanup failed/i);

		expect(messages.some((message) => message.type === "session_rekeyed")).toBe(false);
		expect(adopted.flat()).toEqual(expect.arrayContaining([parentBase.hold, childBase.hold, staged.hold]));
		expect(adopted.flat()).not.toContain(stagedInvalid.hold);
		expect(released).toEqual(
			expect.arrayContaining([parentBase.hold, childBase.hold, staged.hold, stagedInvalid.hold]),
		);
		expect(supervisor.getRuntime(parent.sessionHandle)).toMatchObject({
			generation: before.generation,
			state: "crashed",
			error: "generation_content_cleanup_failed",
		});
		await expect(supervisor.activate(parent.sessionHandle)).rejects.toThrow(
			"generation_content_cleanup_failed",
		);
	});

	it("keeps a rejected retired parent cleanup in the child terminal fence", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "payload-transition-retired-failure");
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const tracking = { adopted, released };
		const parentBase = trackedLease(attachmentRef("4".repeat(64)), tracking);
		const staged = trackedLease(attachmentRef("5".repeat(64)), tracking);
		const childBase = trackedLease(attachmentRef("6".repeat(64)), tracking);
		const services = testPayloadServices(released);
		const { supervisor, messages } = createHarness({
			targets: [parent],
			adapter: transitionPayloadAdapter({ parentBase, staged, childBase }),
			piPayloadServices: {
				...services,
				releaseHold: async (entry) => {
					released.push(entry);
					if (entry === parentBase.hold) throw new Error("fixture retired parent cleanup failed");
				},
			},
			env: { PI_WEB_FIXTURE_TRANSITION_PAYLOAD_EVENTS: "1" },
			maxAutoRestarts: 0,
		});
		const controller = await supervisor.claim(parent.sessionHandle, "controller");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		messages.length = 0;

		await expect(
			supervisor.sendCommand(
				parent.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "controller",
					expectedGeneration: before.generation,
					fencingToken: controller.fencingToken,
				},
			),
		).rejects.toThrow(/cleanup failed/i);

		const child = supervisor.listRuntimes().find((entry) => entry.sessionHandle !== parent.sessionHandle);
		expect(child).toMatchObject({
			generation: before.generation + 1,
			state: "crashed",
			error: "generation_content_cleanup_failed",
		});
		expect(messages.filter((message) => message.type === "session_rekeyed")).toHaveLength(1);
		expect(released).toEqual(expect.arrayContaining([parentBase.hold, staged.hold, childBase.hold]));
		await expect(supervisor.activate(child!.sessionHandle)).rejects.toThrow(
			"generation_content_cleanup_failed",
		);
	});

	it.each([
		["vetoed", { PI_WEB_FIXTURE_CANCEL_TRANSITION: "1" }],
		["same-identity", { PI_WEB_FIXTURE_TRANSITION_SAME_IDENTITY: "1" }],
	])("keeps %s staged payload ownership with the parent generation", async (_label, transitionEnv) => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, `payload-parent-${_label}`);
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const tracking = { adopted, released };
		const parentBase = trackedLease(attachmentRef("8".repeat(64)), tracking);
		const staged = trackedLease(attachmentRef("9".repeat(64)), tracking);
		const { supervisor, messages } = createHarness({
			targets: [parent],
			adapter: transitionPayloadAdapter({ parentBase, staged }),
			piPayloadServices: testPayloadServices(released),
			env: {
				...transitionEnv,
				PI_WEB_FIXTURE_TRANSITION_PAYLOAD_EVENTS: "1",
			},
			maxAutoRestarts: 0,
		});
		const lease = await supervisor.claim(parent.sessionHandle, "controller");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		messages.length = 0;

		const result = await supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);

		expect(result).toMatchObject({
			sessionHandle: parent.sessionHandle,
			generation: before.generation,
		});
		expect(result.previousSessionHandle).toBeUndefined();
		expect(adopted.flat()).toEqual(expect.arrayContaining([parentBase.hold, staged.hold]));
		expect(released).toEqual([]);
		expect(messages.some((message) => message.type === "session_rekeyed")).toBe(false);

		const initial = await supervisor.subscribe(parent.sessionHandle);
		if (initial.type !== "resync_required") throw new Error("parent transition did not resync");
		expect(initial.snapshot.settledMessages).toEqual([
			expect.objectContaining({
				content: [expect.objectContaining({ data: parentBase.hold.ref })],
			}),
		]);
		expect(initial.snapshot.projectionEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: expect.objectContaining({
						message: expect.objectContaining({
							content: [expect.objectContaining({ data: staged.hold.ref })],
						}),
					}),
				}),
			]),
		);

		await supervisor.stop(parent.sessionHandle);
		expect(released).toEqual(expect.arrayContaining([parentBase.hold, staged.hold]));
	});

	it("releases every undecided payload without attributing it to the parent when verification fails", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "payload-transition-uncertain");
		const adopted: EpochContentHold<EpochStoredContentRef>[][] = [];
		const released: EpochContentHold<EpochStoredContentRef>[] = [];
		const tracking = { adopted, released };
		const parentBase = trackedLease(attachmentRef("a".repeat(64)), tracking);
		const staged = trackedLease(attachmentRef("b".repeat(64)), tracking);
		const { supervisor, messages } = createHarness({
			targets: [parent],
			adapter: transitionPayloadAdapter({ parentBase, staged }),
			piPayloadServices: testPayloadServices(released),
			env: {
				PI_WEB_FIXTURE_FAIL_TRANSITION_STATE: "1",
				PI_WEB_FIXTURE_TRANSITION_PAYLOAD_EVENTS: "1",
			},
			maxAutoRestarts: 0,
		});
		const lease = await supervisor.claim(parent.sessionHandle, "controller");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		messages.length = 0;

		await expect(
			supervisor.sendCommand(
				parent.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "controller",
					expectedGeneration: before.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("unable to verify forked session identity");

		expect(supervisor.getRuntime(parent.sessionHandle)).toMatchObject({
			sessionHandle: parent.sessionHandle,
			generation: before.generation,
			state: "dormant",
		});
		expect(adopted.flat()).toContain(parentBase.hold);
		expect(released).toEqual(expect.arrayContaining([parentBase.hold, staged.hold]));
		expect(messages.some((message) => message.type === "session_rekeyed")).toBe(false);
		expect(JSON.stringify(messages)).not.toContain(staged.hold.ref.sha256);

		await expect(supervisor.activate(parent.sessionHandle)).resolves.toMatchObject({
			sessionHandle: parent.sessionHandle,
			nativeSessionId: parent.nativeSessionId,
			generation: before.generation + 1,
		});
	});

	it("accepts Pi's unpersisted child identity when forking before the first user entry", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "unpersisted-fork-parent");
		const { supervisor } = createHarness({
			targets: [parent],
			env: { PI_WEB_FIXTURE_UNPERSISTED_TRANSITION: "1" },
		});
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;

		const result = await supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "fork", entryId: "first-user-entry" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);

		const child = supervisor.getRuntime(result.sessionHandle)!;
		expect(result.previousSessionHandle).toBe(parent.sessionHandle);
		expect(child.nativeSessionId).toBe("unpersisted-fork-parent-fork");
		expect(child.recoverable).toBe(false);
		expect(child.sessionFile).toBeTruthy();
		expect(fs.existsSync(child.sessionFile!)).toBe(false);
		expect(child.state).toBe("idle");

		await supervisor.sendCommand(
			result.sessionHandle,
			{ type: "prompt", message: "persist the fork" },
			{
				connectionId: "connection",
				expectedGeneration: child.generation,
				fencingToken: lease.fencingToken,
			},
		);
		await waitFor(() => supervisor.getRuntime(result.sessionHandle)?.recoverable === true);
		expect(fs.existsSync(child.sessionFile!)).toBe(true);
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
		const order: string[] = [];
		const { supervisor, messages } = createHarness({
			targets: [parent],
			env: { PI_WEB_FIXTURE_TRANSITION_STICKY: "1" },
			onBroadcast: (message) => {
				if (message.type === "session_rekeyed") order.push("rekey");
				if (message.type === "extension_ui_request" && message.request.method === "setStatus") {
					order.push("staged");
				}
			},
			onHotRuntimeInventory: () => order.push("inventory"),
		});
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		order.length = 0;
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
		// The identity fence and its post-rekey inventory must precede staged child
		// frames. The final inventory reflects the transition command completing and
		// its operation count dropping after the staged frames are published.
		expect(order).toEqual(["rekey", "inventory", "staged", "inventory"]);
		expect(messages[stickyIndex]).toMatchObject({
			type: "extension_ui_request",
			sessionHandle: result.sessionHandle,
			generation: result.generation,
		});
	});

	it("makes the child snapshot available before publishing its rekey", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "snapshot-ready-parent");
		let supervisor!: SessionSupervisor;
		let immediateSubscribe: Promise<unknown> | undefined;
		({ supervisor } = createHarness({
			targets: [parent],
			onBroadcast: (message) => {
				if (message.type === "session_rekeyed") {
					immediateSubscribe = supervisor.subscribe(message.runtime.sessionHandle);
				}
			},
		}));
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;

		const result = await supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken!,
			},
		);

		expect(immediateSubscribe).toBeDefined();
		await expect(immediateSubscribe).resolves.toMatchObject({
			type: "resync_required",
			runtime: {
				sessionHandle: result.sessionHandle,
				generation: result.generation,
			},
			snapshot: {
				sessionHandle: result.sessionHandle,
				generation: result.generation,
				asOfSeq: 0,
			},
		});
	});

	it("publishes a rekey only after retained child dialogs reach the snapshot waterline", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "dialog-waterline-parent");
		let supervisor!: SessionSupervisor;
		let immediateSubscribe: Promise<unknown> | undefined;
		const harness = createHarness({
			targets: [parent],
			env: { PI_WEB_FIXTURE_TRANSITION_DIALOG_AFTER_BASE: "1" },
			onBroadcast: (message) => {
				if (message.type === "session_rekeyed") {
					immediateSubscribe = supervisor.subscribe(message.runtime.sessionHandle);
				}
			},
		});
		supervisor = harness.supervisor;
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;

		await supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken!,
			},
		);

		const baseline = await immediateSubscribe;
		expect(baseline).toMatchObject({ type: "resync_required" });
		if (!baseline || typeof baseline !== "object" || !("snapshot" in baseline)) {
			throw new Error("immediate child subscription did not produce a snapshot baseline");
		}
		const snapshot = baseline.snapshot as {
			asOfSeq: number;
			runtime: { lastSeq: number };
			pendingExtensionRequests: Array<{ id: string }>;
		};
		const dialogId = `transition-dialog-dialog-waterline-parent-clone`;
		const baselineDialogs = snapshot.pendingExtensionRequests.filter((request) => request.id === dialogId);
		const suffixDialogs = harness.messages.filter(
			(message) =>
				message.type === "extension_ui_request" &&
				message.request.id === dialogId &&
				message.seq > snapshot.asOfSeq,
		);
		expect(baselineDialogs).toHaveLength(1);
		expect(snapshot.asOfSeq).toBeGreaterThan(0);
		expect(snapshot.asOfSeq).toBe(snapshot.runtime.lastSeq);
		expect(baselineDialogs.length + suffixDialogs.length).toBe(1);
	});

	it("publishes one rekey before terminal state when staged child projection commit overflows", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "staged-overflow-parent");
		const lifecycleMarker = path.join(root, "lifecycle.log");
		const order: string[] = [];
		const { supervisor, messages } = createHarness({
			targets: [parent],
			maxAutoRestarts: 0,
			projectionLimits: { maxExtensionItems: 0 },
			env: {
				PI_WEB_FIXTURE_LIFECYCLE_MARKER: lifecycleMarker,
				PI_WEB_FIXTURE_TRANSITION_DIALOG_AFTER_BASE: "1",
			},
			onBroadcast: (message) => {
				if (message.type === "session_rekeyed") order.push("rekey");
				if (
					message.type === "runtime_state" &&
					(message.runtime.state === "crashed" || message.runtime.state === "dormant")
				) {
					order.push("terminal");
				}
			},
			onHotRuntimeInventory: () => order.push("inventory"),
		});
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		order.length = 0;

		await expect(
			supervisor.sendCommand(
				parent.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "connection",
					expectedGeneration: before.generation,
					fencingToken: lease.fencingToken!,
				},
			),
		).rejects.toThrow("session_snapshot_overflow");

		const child = supervisor.listRuntimes().find((runtime) => runtime.sessionHandle !== parent.sessionHandle);
		expect(child).toBeDefined();
		const rekeys = messages.filter((message) => message.type === "session_rekeyed");
		expect(rekeys).toHaveLength(1);
		expect(rekeys[0]).toMatchObject({
			previousSessionHandle: parent.sessionHandle,
			runtime: { sessionHandle: child?.sessionHandle, state: "waiting_ui" },
		});
		const rekeyIndex = messages.indexOf(rekeys[0]!);
		const terminalIndex = messages.findIndex(
			(message) =>
				message.type === "runtime_state" &&
				message.runtime.sessionHandle === child?.sessionHandle &&
				(message.runtime.state === "crashed" || message.runtime.state === "dormant"),
		);
		expect(rekeyIndex).toBeGreaterThanOrEqual(0);
		expect(terminalIndex).toBeGreaterThan(rekeyIndex);
		expect(order.slice(0, 3)).toEqual(["rekey", "inventory", "terminal"]);
		expect(
			messages.filter(
				(message) =>
					message.type === "extension_ui_request" &&
					message.request.id.startsWith("transition-dialog-staged-overflow-parent-clone"),
			),
		).toEqual([]);
		expect(child).toMatchObject({ state: "crashed", error: "session_snapshot_overflow" });
		expect(supervisor.isActive(child!.sessionHandle)).toBe(false);
		if (process.platform !== "win32") {
			const childPid = Number(fs.readFileSync(lifecycleMarker, "utf8").match(/^start:(\d+)$/m)?.[1]);
			expect(Number.isSafeInteger(childPid)).toBe(true);
			expect(() => process.kill(childPid, 0)).toThrow();
		}

		const reopenedParent = await supervisor.activate(parent.sessionHandle);
		expect(reopenedParent.nativeSessionId).toBe("staged-overflow-parent");
		expect(reopenedParent.sessionHandle).toBe(parent.sessionHandle);
	});

	it("rejects a child identity commit when its process dies after loading the base", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "stale-process-parent");
		const { supervisor, messages } = createHarness({ targets: [parent], maxAutoRestarts: 0 });
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		const internal = supervisor as unknown as {
			commitIdentityTransition: (
				runtime: SessionRuntime,
				transition: SessionIdentityTransitionCommit,
			) => Promise<void>;
		};
		const originalCommit = internal.commitIdentityTransition.bind(supervisor);
		let signalCommitEntered!: () => void;
		const commitEntered = new Promise<void>((resolve) => {
			signalCommitEntered = resolve;
		});
		let releaseCommit!: () => void;
		const commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		internal.commitIdentityTransition = async (...args) => {
			signalCommitEntered();
			await commitGate;
			return originalCommit(...args);
		};

		const clone = supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken!,
			},
		);
		void clone.catch(() => {});
		await commitEntered;
		await supervisor.stop(parent.sessionHandle);
		releaseCommit();

		await expect(clone).rejects.toThrow("session_generation_stale");
		expect(messages.some((message) => message.type === "session_rekeyed")).toBe(false);
		expect(supervisor.listRuntimes()).toEqual([
			expect.objectContaining({
				sessionHandle: parent.sessionHandle,
				state: "dormant",
			}),
		]);
	});

	it("synchronizes the child projection phase after a staged dialog expires before identity apply", async () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd);
		const parent = createNativeSession(root, cwd, "expired-dialog-parent");
		const { supervisor, messages } = createHarness({
			targets: [parent],
			env: {
				PI_WEB_FIXTURE_TRANSITION_DIALOG_AFTER_BASE: "1",
				PI_WEB_FIXTURE_TRANSITION_DIALOG_TIMEOUT_MS: "100",
			},
		});
		const lease = await supervisor.claim(parent.sessionHandle, "connection");
		const before = supervisor.getRuntime(parent.sessionHandle)!;
		const internal = supervisor as unknown as {
			commitIdentityTransition: (
				runtime: SessionRuntime,
				transition: SessionIdentityTransitionCommit,
			) => Promise<void>;
		};
		const originalCommit = internal.commitIdentityTransition.bind(supervisor);
		let signalCommitEntered!: () => void;
		const commitEntered = new Promise<void>((resolve) => {
			signalCommitEntered = resolve;
		});
		let releaseCommit!: () => void;
		const commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		internal.commitIdentityTransition = async (...args) => {
			signalCommitEntered();
			await commitGate;
			return originalCommit(...args);
		};

		const clone = supervisor.sendCommand(
			parent.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "connection",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken!,
			},
		);
		void clone.catch(() => {});
		await commitEntered;
		expect(supervisor.getPendingExtensionRequests(parent.sessionHandle)).toContainEqual(
			expect.objectContaining({ id: "transition-dialog-expired-dialog-parent-clone" }),
		);
		await waitFor(
			() =>
				!supervisor
					.getPendingExtensionRequests(parent.sessionHandle)
					?.some((request) => request.id === "transition-dialog-expired-dialog-parent-clone"),
		);
		releaseCommit();
		const result = await clone;

		expect(supervisor.getRuntime(result.sessionHandle)?.state).toBe("idle");
		const baseline = await supervisor.subscribe(result.sessionHandle);
		expect(baseline).toMatchObject({
			type: "resync_required",
			runtime: { state: "idle" },
			snapshot: {
				asOfSeq: 0,
				runtime: { state: "idle", lastSeq: 0 },
				pendingExtensionRequests: [],
			},
		});
		expect(
			messages.filter(
				(message) =>
					message.type === "extension_ui_request" &&
					message.request.id === "transition-dialog-expired-dialog-parent-clone",
			),
		).toEqual([]);
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
			serverEpoch: "session-supervisor-test-epoch",
			piPayloadServices: createCanonicalPayloadFixture("session-supervisor-test-epoch").supervisorServices,
			resolved: {
				command: process.execPath,
				args: [fixturePath],
				source: "pi-path",
				label: "session runtime fixture",
				adapter: piRpcAdapter,
				version: "0.84.2",
				adapterId: "pi-rpc",
				compatibilityStatus: "current",
				capabilities: piRpcAdapter.capabilities,
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
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			state: "idle",
			phase: "busy",
			operationCount: 1,
			busyReasons: ["command"],
		});
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
