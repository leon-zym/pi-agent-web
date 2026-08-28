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
import type { FutureSessionRuntimePiPayloadServices } from "../src/session-runtime.js";
import type { ExistingSessionTarget, SessionSupervisorMessage } from "../src/session-runtime-types.js";
import { createFutureSessionSupervisor } from "../src/session-supervisor.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", "session-runtime-pi.mjs");

function createTarget(root: string): ExistingSessionTarget {
	const cwd = path.join(root, "workspace");
	const sessionDir = path.join(root, "sessions");
	fs.mkdirSync(cwd);
	fs.mkdirSync(sessionDir);
	const sessionFile = path.join(sessionDir, "2026-08-28T00-00-00-000Z_future-transition.jsonl");
	fs.writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "future-transition",
			timestamp: "2026-08-28T00:00:00.000Z",
			cwd,
		})}\n`,
	);
	return {
		kind: "existing",
		sessionHandle: sessionHandleForFile(sessionFile),
		workspaceId: "workspace-future-transition",
		cwd,
		sessionFile: canonicalizeSessionFile(sessionFile),
		nativeSessionId: "future-transition",
	};
}

function createCollisionTarget(parent: ExistingSessionTarget): ExistingSessionTarget {
	const sessionFile = path.join(
		path.dirname(parent.sessionFile),
		"2026-08-20T00-00-01-000Z_future-transition-clone.jsonl",
	);
	fs.writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "future-transition-clone",
			timestamp: "2026-08-20T00:00:01.000Z",
			cwd: parent.cwd,
		})}\n`,
	);
	return {
		kind: "existing",
		sessionHandle: sessionHandleForFile(sessionFile),
		workspaceId: parent.workspaceId,
		cwd: parent.cwd,
		sessionFile: canonicalizeSessionFile(sessionFile),
		nativeSessionId: "future-transition-clone",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trackedContentRef(byteLength: number): SessionContentRefDto {
	return Object.freeze({
		type: "content_ref",
		serverEpoch: "future-transition-epoch",
		sha256: "a".repeat(64),
		byteLength,
		encoding: "utf-8",
	});
}

function stagedLogicalEvent(byteLength: number): FutureProductSessionEventDto {
	return {
		type: "message_end",
		message: {
			role: "toolResult",
			toolCallId: "transition-logical-0",
			toolName: "fixture",
			content: [
				{
					type: "text",
					text: {
						type: "external_text",
						ref: trackedContentRef(byteLength),
					},
				},
			],
			isError: false,
			timestamp: 1_700_000_000_000,
		},
	};
}

function withTrackedLogicalPayloads(
	services: FutureSessionRuntimePiPayloadServices,
): FutureSessionRuntimePiPayloadServices {
	const trackedHolds = new WeakSet<object>();
	const externalizer: PiHostFuturePayloadExternalizer = Object.freeze({
		...services.externalizer,
		async externalize(input: PiPayloadExternalizerInput, signal: AbortSignal) {
			const serialized = JSON.stringify(input.value);
			const match = /tracked-logical:(\d+)/.exec(serialized);
			if (!match) return services.externalizer.externalize(input, signal);
			const byteLength = Number.parseInt(match[1] ?? "", 10);
			if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
				throw new Error("tracked logical byte length is invalid");
			}
			const ref = trackedContentRef(byteLength);
			const hold: EpochContentHold<SessionContentRefDto> = Object.freeze({ ref });
			trackedHolds.add(hold);
			let leaseState: "provisional" | "transferred" | "released" = "provisional";
			let leaseRelease: Promise<void> | null = null;
			const lease: PiPayloadLease<EpochStoredContentRef> = Object.freeze({
				refs: Object.freeze([ref]),
				transfer() {
					if (leaseState !== "provisional") throw new Error("tracked logical lease was already consumed");
					leaseState = "transferred";
					let transferState: "open" | "adopted" | "released" = "open";
					let transferRelease: Promise<void> | null = null;
					return Object.freeze({
						refs: Object.freeze([ref]),
						adopt(accept: (holds: readonly EpochContentHold<EpochStoredContentRef>[]) => true) {
							if (transferState !== "open") throw new Error("tracked logical transfer was already consumed");
							if (accept(Object.freeze([hold])) !== true) {
								throw new Error("tracked logical transfer adoption was rejected");
							}
							transferState = "adopted";
						},
						async release() {
							if (transferRelease) return transferRelease;
							if (transferState === "adopted") throw new Error("tracked logical transfer was adopted");
							transferState = "released";
							transferRelease = Promise.resolve();
							return transferRelease;
						},
					});
				},
				async release() {
					if (leaseRelease) return leaseRelease;
					if (leaseState === "transferred") throw new Error("tracked logical lease was transferred");
					leaseState = "released";
					leaseRelease = Promise.resolve();
					return leaseRelease;
				},
			});
			if (input.kind === "event") {
				return Object.freeze({ value: stagedLogicalEvent(byteLength), lease });
			}
			if (
				input.kind === "response" &&
				input.expectedCommand === "get_messages" &&
				isRecord(input.value) &&
				typeof input.value.id === "string"
			) {
				const event = stagedLogicalEvent(byteLength);
				if (event.type !== "message_end") throw new Error("tracked logical event shape is invalid");
				return Object.freeze({
					value: {
						type: "response",
						id: input.value.id,
						command: "get_messages",
						success: true,
						data: { messages: [event.message] },
					},
					lease,
				});
			}
			throw new Error("tracked logical marker reached an unexpected payload boundary");
		},
	});
	return Object.freeze({
		...services,
		externalizer,
		async releaseHold(hold: EpochContentHold<EpochStoredContentRef>) {
			if (trackedHolds.has(hold)) return;
			await services.releaseHold(hold);
		},
	});
}

function forgeSecondEventHold(externalizer: PiHostFuturePayloadExternalizer): {
	externalizer: PiHostFuturePayloadExternalizer;
	releaseAttempts: () => number;
} {
	let leasedEvents = 0;
	let releaseAttempts = 0;
	return {
		externalizer: Object.freeze({
			...externalizer,
			async externalize(input: PiPayloadExternalizerInput, signal: AbortSignal) {
				const outcome = await externalizer.externalize(input, signal);
				if (input.kind !== "event" || outcome.lease.refs.length === 0 || ++leasedEvents !== 2) {
					return outcome;
				}
				const exactLease = outcome.lease;
				const forgedLease: PiPayloadLease<EpochStoredContentRef> = Object.freeze({
					refs: exactLease.refs,
					transfer() {
						const exactTransfer = exactLease.transfer();
						return Object.freeze({
							refs: exactTransfer.refs,
							adopt(accept: (holds: readonly EpochContentHold<EpochStoredContentRef>[]) => true) {
								const holds: readonly EpochContentHold<SessionContentRefDto>[] = exactTransfer.refs.map(
									(ref) => {
										if (ref.type !== "content_ref") throw new Error("expected a staged text ref");
										return Object.freeze({
											ref: Object.freeze({ ...ref, serverEpoch: "foreign-transition-epoch" }),
										});
									},
								);
								accept(holds);
							},
							async release() {
								releaseAttempts += 1;
								await exactTransfer.release();
							},
						});
					},
					release: () => exactLease.release(),
				});
				return Object.freeze({ value: outcome.value, lease: forgedLease });
			},
		}),
		releaseAttempts: () => releaseAttempts,
	};
}

function auditPayloadCustody(services: FutureSessionRuntimePiPayloadServices): {
	services: FutureSessionRuntimePiPayloadServices;
	counters: {
		transferAdopt: number;
		transferRelease: number;
		leaseRelease: number;
		holdRelease: number;
	};
} {
	const counters = { transferAdopt: 0, transferRelease: 0, leaseRelease: 0, holdRelease: 0 };
	const externalizer: PiHostFuturePayloadExternalizer = Object.freeze({
		...services.externalizer,
		async externalize(input: PiPayloadExternalizerInput, signal: AbortSignal) {
			const outcome = await services.externalizer.externalize(input, signal);
			if (outcome.lease.refs.length === 0) return outcome;
			const exactLease = outcome.lease;
			const lease: PiPayloadLease<EpochStoredContentRef> = Object.freeze({
				refs: exactLease.refs,
				transfer() {
					const exactTransfer = exactLease.transfer();
					return Object.freeze({
						refs: exactTransfer.refs,
						adopt(accept: (holds: readonly EpochContentHold<EpochStoredContentRef>[]) => true) {
							exactTransfer.adopt(accept);
							counters.transferAdopt += 1;
						},
						async release() {
							counters.transferRelease += 1;
							await exactTransfer.release();
						},
					});
				},
				async release() {
					counters.leaseRelease += 1;
					await exactLease.release();
				},
			});
			return Object.freeze({ value: outcome.value, lease });
		},
	});
	return {
		services: Object.freeze({
			...services,
			externalizer,
			async releaseHold(hold: EpochContentHold<EpochStoredContentRef>) {
				counters.holdRelease += 1;
				await services.releaseHold(hold);
			},
		}),
		counters,
	};
}

function createFixture(
	target: ExistingSessionTarget,
	piPayloadServices: FutureSessionRuntimePiPayloadServices,
	messages: SessionSupervisorMessage<FutureProductSessionEventDto>[],
	env?: Record<string, string>,
	additionalTargets: readonly ExistingSessionTarget[] = [],
) {
	return createFutureSessionSupervisor({
		serverEpoch: "future-transition-epoch",
		resolved: {
			command: process.execPath,
			args: [fixturePath],
			source: "pi-path",
			label: "future transition fixture",
			adapter: legacyRpcV1Adapter,
			version: "0.84.2",
			adapterId: "legacy-rpc-v1",
			compatibilityStatus: "current",
			capabilities: legacyRpcV1Adapter.capabilities,
		},
		resolveSession: async (handle) =>
			[target, ...additionalTargets].find((candidate) => candidate.sessionHandle === handle),
		broadcast: (message) => messages.push(message),
		piPayloadServices,
		env,
		maxAutoRestarts: 0,
		readyTimeoutMs: 2_000,
	});
}

function exactRuntime(supervisor: object, sessionHandle: string): object {
	const runtimes = Reflect.get(supervisor, "runtimes");
	if (!(runtimes instanceof Map)) throw new Error("future Supervisor runtime pool is unavailable");
	const runtime = runtimes.get(sessionHandle);
	if (typeof runtime !== "object" || runtime === null) throw new Error("future runtime is unavailable");
	return runtime;
}

describe("future Session Supervisor identity transitions", () => {
	let root: string | undefined;
	let store: EpochContentStore | undefined;
	let stop: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await stop?.().catch(() => {});
		await store?.shutdown().catch(() => {});
		if (root) fs.rmSync(root, { recursive: true, force: true });
		root = undefined;
		store = undefined;
		stop = undefined;
	});

	it("rekeys a verified clone and publishes its child snapshot", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-transition-"));
		const target = createTarget(root);
		store = new EpochContentStore({
			webDataDir: path.join(root, "web-data"),
			serverEpoch: "future-transition-epoch",
		});
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, "future-transition-epoch");
		const trackedServices = withTrackedLogicalPayloads(activation.supervisorServices);
		const audit = auditPayloadCustody(trackedServices);
		const childLogicalBytes = activation.supervisorServices.productSchema.activeTurnEventLogicalBytes(
			stagedLogicalEvent(1024 * 1024),
		);
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFixture(target, audit.services, messages, {
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_BYTES: String(1024 * 1024),
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_COUNT: "1",
		});
		stop = () => supervisor.stopAll();

		const lease = await supervisor.claim(target.sessionHandle, "future-transition-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future parent runtime was not activated");
		Reflect.set(exactRuntime(supervisor, target.sessionHandle), "activeTurnProjectionLogicalBytes", 17);
		messages.length = 0;

		const result = await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "future-transition-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);

		expect(result).toMatchObject({
			previousSessionHandle: target.sessionHandle,
			generation: before.generation + 1,
			barrierSeq: 1,
		});
		expect(result.sessionHandle).not.toBe(target.sessionHandle);
		expect(supervisor.getRuntime(result.sessionHandle)?.nativeSessionId).toBe("future-transition-clone");
		expect(supervisor.getRuntime(result.sessionHandle)?.lastSeq).toBe(1);
		expect(
			Reflect.get(exactRuntime(supervisor, result.sessionHandle), "activeTurnProjectionLogicalBytes"),
		).toBe(childLogicalBytes);
		expect(supervisor.getRuntime(target.sessionHandle)).toBeUndefined();
		const childOwner = Reflect.get(exactRuntime(supervisor, result.sessionHandle), "generationContentOwner");
		expect(Reflect.get(childOwner, "size")).toBe(1);
		expect(audit.counters).toMatchObject({ transferAdopt: 1, transferRelease: 0, leaseRelease: 0 });
		expect(messages).toContainEqual(
			expect.objectContaining({
				type: "session_rekeyed",
				previousSessionHandle: target.sessionHandle,
				runtime: expect.objectContaining({ sessionHandle: result.sessionHandle }),
			}),
		);
		const initial = await supervisor.subscribe(result.sessionHandle);
		expect(initial).toMatchObject({
			type: "resync_required",
			snapshot: {
				sessionHandle: result.sessionHandle,
				generation: before.generation + 1,
				baseSeq: 0,
				asOfSeq: 1,
			},
		});
	});

	it.each([
		["same identity", { PI_WEB_FIXTURE_TRANSITION_SAME_IDENTITY: "1" }],
		["veto", { PI_WEB_FIXTURE_CANCEL_TRANSITION: "1" }],
	])("keeps the parent authoritative after a %s result", async (_label, env) => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-transition-parent-"));
		const target = createTarget(root);
		store = new EpochContentStore({
			webDataDir: path.join(root, "web-data"),
			serverEpoch: "future-transition-epoch",
		});
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, "future-transition-epoch");
		const trackedServices = withTrackedLogicalPayloads(activation.supervisorServices);
		const audit = auditPayloadCustody(trackedServices);
		const expectedLogicalBytes =
			17 +
			activation.supervisorServices.productSchema.activeTurnEventLogicalBytes(
				stagedLogicalEvent(1024 * 1024),
			);
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFixture(target, audit.services, messages, {
			...env,
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_BYTES: String(1024 * 1024),
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_COUNT: "1",
		});
		stop = () => supervisor.stopAll();
		const lease = await supervisor.claim(target.sessionHandle, "future-parent-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future parent runtime was not activated");
		Reflect.set(exactRuntime(supervisor, target.sessionHandle), "activeTurnProjectionLogicalBytes", 17);
		messages.length = 0;

		const result = await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "future-parent-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);

		expect(result).toMatchObject({
			sessionHandle: target.sessionHandle,
			generation: before.generation,
		});
		expect(result.previousSessionHandle).toBeUndefined();
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			nativeSessionId: target.nativeSessionId,
			generation: before.generation,
			state: "idle",
		});
		expect(messages.some((message) => message.type === "session_rekeyed")).toBe(false);
		expect(
			Reflect.get(exactRuntime(supervisor, target.sessionHandle), "activeTurnProjectionLogicalBytes"),
		).toBe(expectedLogicalBytes);
		expect(audit.counters).toMatchObject({ transferAdopt: 1, transferRelease: 0, leaseRelease: 0 });
	});

	it("rejects two staged 40 MiB logical frames before identity verification", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-transition-staged-limit-"));
		const target = createTarget(root);
		store = new EpochContentStore({
			webDataDir: path.join(root, "web-data"),
			serverEpoch: "future-transition-epoch",
		});
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, "future-transition-epoch");
		const trackedServices = withTrackedLogicalPayloads(activation.supervisorServices);
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFixture(target, trackedServices, messages, {
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_BYTES: String(40 * 1024 * 1024),
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_COUNT: "2",
		});
		stop = () => supervisor.stopAll();
		const lease = await supervisor.claim(target.sessionHandle, "future-staged-limit-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future parent runtime was not activated");
		messages.length = 0;

		await expect(
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "future-staged-limit-controller",
					expectedGeneration: before.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("transition payload ledger logical byte limit exceeded");
		expect(messages.some((message) => message.type === "session_rekeyed")).toBe(false);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			generation: before.generation,
			state: "dormant",
		});
	}, 20_000);

	it("rejects a 40 MiB child base plus 40 MiB staged frame before publishing that frame", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-transition-combined-limit-"));
		const target = createTarget(root);
		store = new EpochContentStore({
			webDataDir: path.join(root, "web-data"),
			serverEpoch: "future-transition-epoch",
		});
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, "future-transition-epoch");
		const trackedServices = withTrackedLogicalPayloads(activation.supervisorServices);
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFixture(target, trackedServices, messages, {
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_BYTES: String(40 * 1024 * 1024),
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_COUNT: "1",
			PI_WEB_FIXTURE_TRANSITION_CHILD_LOGICAL_BYTES: String(40 * 1024 * 1024),
		});
		stop = () => supervisor.stopAll();
		const lease = await supervisor.claim(target.sessionHandle, "future-combined-limit-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future parent runtime was not activated");
		messages.length = 0;

		await expect(
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "future-combined-limit-controller",
					expectedGeneration: before.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("session_snapshot_overflow");
		const childLifecycle = messages.filter(
			(message) =>
				message.type === "session_rekeyed" ||
				(message.type === "runtime_state" && message.runtime.sessionHandle !== target.sessionHandle),
		);
		expect(childLifecycle).toEqual([
			expect.objectContaining({
				type: "session_rekeyed",
				previousSessionHandle: target.sessionHandle,
			}),
			expect.objectContaining({
				type: "runtime_state",
				runtime: expect.objectContaining({
					error: "session_snapshot_overflow",
					lastSeq: 0,
					state: "crashed",
				}),
			}),
		]);
		expect(messages.some((message) => message.type === "event" && message.event.type === "message_end")).toBe(
			false,
		);
	}, 20_000);

	it("fails closed when the child identity cannot be verified", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-transition-uncertain-"));
		const target = createTarget(root);
		store = new EpochContentStore({
			webDataDir: path.join(root, "web-data"),
			serverEpoch: "future-transition-epoch",
		});
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, "future-transition-epoch");
		const trackedServices = withTrackedLogicalPayloads(activation.supervisorServices);
		const audit = auditPayloadCustody(trackedServices);
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFixture(target, audit.services, messages, {
			PI_WEB_FIXTURE_FAIL_TRANSITION_STATE: "1",
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_BYTES: String(1024 * 1024),
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_COUNT: "1",
		});
		stop = () => supervisor.stopAll();
		const lease = await supervisor.claim(target.sessionHandle, "future-uncertain-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future parent runtime was not activated");
		messages.length = 0;

		await expect(
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "future-uncertain-controller",
					expectedGeneration: before.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("unable to verify forked session identity");
		expect(messages.some((message) => message.type === "session_rekeyed")).toBe(false);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			generation: before.generation,
			state: "dormant",
		});
		expect(audit.counters).toEqual({
			transferAdopt: 0,
			transferRelease: 1,
			leaseRelease: 0,
			holdRelease: 0,
		});
	});

	it("rejects a verified child that collides with an already-active canonical runtime", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-transition-collision-"));
		const target = createTarget(root);
		const collision = createCollisionTarget(target);
		store = new EpochContentStore({
			webDataDir: path.join(root, "web-data"),
			serverEpoch: "future-transition-epoch",
		});
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, "future-transition-epoch");
		const trackedServices = withTrackedLogicalPayloads(activation.supervisorServices);
		const audit = auditPayloadCustody(trackedServices);
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFixture(
			target,
			audit.services,
			messages,
			{
				PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_BYTES: String(1024 * 1024),
				PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_COUNT: "1",
			},
			[collision],
		);
		stop = () => supervisor.stopAll();
		await supervisor.activate(collision.sessionHandle);
		const lease = await supervisor.claim(target.sessionHandle, "future-collision-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future parent runtime was not activated");
		messages.length = 0;

		await expect(
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "future-collision-controller",
					expectedGeneration: before.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("canonical_session_already_active");
		expect(messages.some((message) => message.type === "session_rekeyed")).toBe(false);
		expect(supervisor.getRuntime(collision.sessionHandle)).toMatchObject({ state: "idle" });
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({ state: "dormant" });
		expect(audit.counters).toEqual({
			transferAdopt: 0,
			transferRelease: 1,
			leaseRelease: 0,
			holdRelease: 0,
		});
	});

	it("releases a partially drained staged ledger after child adoption rejects", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-transition-partial-drain-"));
		const target = createTarget(root);
		store = new EpochContentStore({
			webDataDir: path.join(root, "web-data"),
			serverEpoch: "future-transition-epoch",
		});
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, "future-transition-epoch");
		const trackedServices = withTrackedLogicalPayloads(activation.supervisorServices);
		const forged = forgeSecondEventHold(trackedServices.externalizer);
		const audited = auditPayloadCustody({
			...trackedServices,
			externalizer: forged.externalizer,
		});
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFixture(target, audited.services, messages, {
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_BYTES: String(1024 * 1024),
			PI_WEB_FIXTURE_TRANSITION_STAGED_LOGICAL_COUNT: "2",
		});
		stop = () => supervisor.stopAll();
		const lease = await supervisor.claim(target.sessionHandle, "future-partial-drain-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future parent runtime was not activated");
		messages.length = 0;

		await expect(
			supervisor.sendCommand(
				target.sessionHandle,
				{ type: "clone" },
				{
					connectionId: "future-partial-drain-controller",
					expectedGeneration: before.generation,
					fencingToken: lease.fencingToken,
				},
			),
		).rejects.toThrow("transition payload ledger drain failed");
		expect(forged.releaseAttempts()).toBe(1);
		expect(audited.counters).toEqual({
			transferAdopt: 1,
			transferRelease: 1,
			leaseRelease: 0,
			holdRelease: 1,
		});
		expect(messages.some((message) => message.type === "session_rekeyed")).toBe(false);
		expect(supervisor.getRuntime(target.sessionHandle)).toMatchObject({
			generation: before.generation,
			state: "dormant",
		});
	});

	it("rekeys to an unpersisted verified child without marking it recoverable", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-future-transition-unpersisted-"));
		const target = createTarget(root);
		store = new EpochContentStore({
			webDataDir: path.join(root, "web-data"),
			serverEpoch: "future-transition-epoch",
		});
		await store.initialize();
		const activation = createGatewayFuturePayloadActivation(store, "future-transition-epoch");
		const messages: SessionSupervisorMessage<FutureProductSessionEventDto>[] = [];
		const supervisor = createFixture(target, activation.supervisorServices, messages, {
			PI_WEB_FIXTURE_UNPERSISTED_TRANSITION: "1",
		});
		stop = () => supervisor.stopAll();
		const lease = await supervisor.claim(target.sessionHandle, "future-unpersisted-controller");
		const before = supervisor.getRuntime(target.sessionHandle);
		if (!before) throw new Error("future parent runtime was not activated");

		const result = await supervisor.sendCommand(
			target.sessionHandle,
			{ type: "clone" },
			{
				connectionId: "future-unpersisted-controller",
				expectedGeneration: before.generation,
				fencingToken: lease.fencingToken,
			},
		);

		expect(result.previousSessionHandle).toBe(target.sessionHandle);
		expect(supervisor.getRuntime(result.sessionHandle)).toMatchObject({
			generation: before.generation + 1,
			recoverable: false,
		});
	});
});
