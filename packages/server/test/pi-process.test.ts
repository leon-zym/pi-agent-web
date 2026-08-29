import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	expectData,
	FUTURE_SESSION_CONTENT_REF_BUDGET,
	type ProductSessionEventDto,
	SESSION_PAYLOAD_BUDGET,
	type SessionAttachmentRefDto,
	type SessionCommandResponseDto,
	type SessionContentRefDto,
} from "@pi-agent-web/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpochContentHold, EpochStoredContentRef } from "../src/epoch-content-store.js";
import { GenerationContentOwner } from "../src/generation-content-owner.js";
import { MAX_JSONL_FUTURE_CONTENT_LINE_BYTES, MAX_JSONL_LINE_BYTES } from "../src/jsonl.js";
import { legacyRpcV1Adapter } from "../src/legacy-rpc-v1.js";
import {
	type PiHostAdapter,
	type PiHostDecodeContext,
	type PiHostFutureDecodeContext,
	PiHostResponseExternalizationError,
	type PiHostUnsolicitedFrame,
	PiProtocolIncompatibleError,
} from "../src/pi-host-adapter.js";
import {
	PiPayloadExternalizationError,
	type PiPayloadExternalizerInput,
	type PiPayloadLease,
	type PiPayloadLeaseTransfer,
} from "../src/pi-payload-externalizer.js";
import { type PiDecodedDeliveryConsumer, PiProcess, type PiProcessOptions } from "../src/pi-process.js";

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function fakeLease(options: { rejectRelease?: boolean } = {}): {
	lease: PiPayloadLease;
	release: ReturnType<typeof vi.fn>;
	adopt: ReturnType<typeof vi.fn>;
} {
	const ref: SessionAttachmentRefDto = {
		type: "attachment_ref",
		serverEpoch: "process-test-epoch",
		sha256: "a".repeat(64),
		mediaType: "image/png",
		byteLength: 1,
	};
	const hold = Object.freeze({ ref });
	let transferred = false;
	const release = vi.fn(async () => {
		if (options.rejectRelease) throw new Error("injected lease release failure");
	});
	const adopt = vi.fn((accept: (holds: readonly EpochContentHold[]) => true) => {
		if (accept([hold]) !== true) throw new Error("lease was not adopted");
	});
	const lease: PiPayloadLease = Object.freeze({
		refs: Object.freeze([ref]),
		transfer() {
			if (transferred) throw new Error("already transferred");
			transferred = true;
			return Object.freeze({ refs: lease.refs, adopt, release });
		},
		release,
	});
	return { lease, release, adopt };
}

function fakeFutureLease(): {
	lease: PiPayloadLease<EpochStoredContentRef>;
	release: ReturnType<typeof vi.fn>;
} {
	const ref: SessionContentRefDto = {
		type: "content_ref",
		serverEpoch: "process-test-epoch",
		sha256: "b".repeat(64),
		encoding: "utf-8",
		byteLength: FUTURE_SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes,
	};
	const hold: EpochContentHold<SessionContentRefDto> = Object.freeze({ ref });
	const release = vi.fn(async () => {});
	let transferred = false;
	const lease: PiPayloadLease<EpochStoredContentRef> = Object.freeze({
		refs: Object.freeze([ref]),
		transfer() {
			if (transferred) throw new Error("already transferred");
			transferred = true;
			return Object.freeze({
				refs: lease.refs,
				adopt(accept: (holds: readonly EpochContentHold<EpochStoredContentRef>[]) => true) {
					if (accept([hold]) !== true) throw new Error("future lease was not adopted");
				},
				release,
			});
		},
		release,
	});
	return { lease, release };
}

function fakeMixedFutureLease(): {
	lease: PiPayloadLease<EpochStoredContentRef>;
	release: ReturnType<typeof vi.fn>;
} {
	const attachmentRef: SessionAttachmentRefDto = {
		type: "attachment_ref",
		serverEpoch: "process-test-epoch",
		sha256: "a".repeat(64),
		mediaType: "image/png",
		byteLength: 1,
	};
	const contentRef: SessionContentRefDto = {
		type: "content_ref",
		serverEpoch: "process-test-epoch",
		sha256: "b".repeat(64),
		encoding: "utf-8",
		byteLength: FUTURE_SESSION_CONTENT_REF_BUDGET.inlineContentThresholdBytes,
	};
	const attachmentHold: EpochContentHold<SessionAttachmentRefDto> = Object.freeze({ ref: attachmentRef });
	const contentHold: EpochContentHold<SessionContentRefDto> = Object.freeze({ ref: contentRef });
	const release = vi.fn(async () => {});
	let transferred = false;
	const lease: PiPayloadLease<EpochStoredContentRef> = Object.freeze({
		refs: Object.freeze([attachmentRef, contentRef]),
		transfer() {
			if (transferred) throw new Error("already transferred");
			transferred = true;
			return Object.freeze({
				refs: lease.refs,
				adopt(accept: (holds: readonly EpochContentHold<EpochStoredContentRef>[]) => true) {
					if (accept([attachmentHold, contentHold]) !== true) throw new Error("mixed lease was not adopted");
				},
				release,
			});
		},
		release,
	});
	return { lease, release };
}

const futurePayloadExternalizer = {
	mode: "future_content",
	context: {
		serverEpoch: "process-test-epoch",
		payloadBudget: SESSION_PAYLOAD_BUDGET,
		contentRefBudget: FUTURE_SESSION_CONTENT_REF_BUDGET,
	},
	externalize: vi.fn(async (input: { value: unknown }) => ({
		value: input.value,
		lease: {
			refs: [] as readonly EpochStoredContentRef[],
			transfer() {
				throw new Error("empty future lease is not transferable");
			},
			release: async () => {},
		},
	})),
} as const;

type DecodedFrame =
	| { kind: "response"; command: string }
	| { kind: "orphaned_response" }
	| PiHostUnsolicitedFrame;

function withAsyncDecodeGate(
	gate: (frame: DecodedFrame, signal: AbortSignal | undefined) => Promise<void>,
): PiHostAdapter {
	return {
		...legacyRpcV1Adapter,
		async decodeResponse(value, expectedCommand, context?: PiHostDecodeContext) {
			const decoded = await legacyRpcV1Adapter.decodeResponse(value, expectedCommand);
			await gate({ kind: "response", command: expectedCommand }, context?.signal);
			return decoded;
		},
		async decodeOrphanedResponse(value, context?: PiHostDecodeContext) {
			const decoded = await legacyRpcV1Adapter.decodeOrphanedResponse(value);
			await gate({ kind: "orphaned_response" }, context?.signal);
			return decoded;
		},
		async decodeUnsolicited(value, context?: PiHostDecodeContext) {
			const decoded = await legacyRpcV1Adapter.decodeUnsolicited(value);
			await gate(decoded.value, context?.signal);
			return decoded;
		},
	};
}

function processGroupPids(marker: string): { leaderPid: number; descendantPid: number } {
	return JSON.parse(readFileSync(marker, "utf8")) as { leaderPid: number; descendantPid: number };
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

	it("fails closed on a response without a correlating id", async () => {
		const exits: Array<{ reason?: string; diagnostic?: { reason: string } }> = [];
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			commandTimeoutMs: 50,
			onExit: (info) => exits.push(info),
		});
		await proc.start();

		await expect(proc.send({ id: "missing-id", type: "get_last_assistant_text" }, 50)).rejects.toMatchObject({
			name: "PiProtocolIncompatibleError",
			diagnostic: { reason: "malformed_response" },
		});
		await waitFor(() => exits.length === 1);
		expect(exits[0]).toMatchObject({
			reason: "protocol_incompatible",
			diagnostic: { reason: "malformed_response" },
		});
	});

	it("rejects duplicate process-local pending ids instead of overwriting the first request", async () => {
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
		});
		await proc.start();

		const first = proc.send({ id: "same-id", type: "prompt", message: "never-response" }, 100);
		await expect(
			proc.send({ id: "same-id", type: "prompt", message: "never-response" }, 100),
		).rejects.toThrow("duplicate pending command id");
		await expect(first).rejects.toThrow("command timed out");
	});

	it("reuses a settled public id with a fresh wire id without correlating the late old response", async () => {
		const encodedIds: string[] = [];
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			encodeCommand(command) {
				encodedIds.push(command.id);
				return legacyRpcV1Adapter.encodeCommand(command);
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
		});
		await proc.start();
		const internals = proc as unknown as {
			pending: Map<string, unknown>;
			pendingPublicIds: Map<string, string>;
		};

		await expect(
			proc.send({ id: "retired-id", type: "prompt", message: "delayed-response" }, 20),
		).rejects.toThrow("command timed out");
		expect(internals.pendingPublicIds.size).toBe(0);

		let secondSettled = false;
		const second = proc
			.send({ id: "retired-id", type: "prompt", message: "delayed-reused-response" }, 250)
			.finally(() => {
				secondSettled = true;
			});
		expect(internals.pendingPublicIds.size).toBe(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 80));
		expect(secondSettled).toBe(false);
		await expect(second).resolves.toMatchObject({ id: "retired-id", command: "prompt", success: true });
		expect(internals.pendingPublicIds.size).toBe(0);
		expect(internals.pending.size).toBe(0);
		const promptWireIds = encodedIds.slice(-2);
		expect(promptWireIds).toHaveLength(2);
		expect(promptWireIds[0]).not.toBe(promptWireIds[1]);
		expect(promptWireIds).not.toContain("retired-id");
		await expect(proc.send({ type: "get_state" })).resolves.toMatchObject({ success: true });
		expect(proc.running).toBe(true);
	});

	it("never exposes the payload externalizer to an unknown-id orphan response", async () => {
		const orphanContexts: Array<PiHostDecodeContext | undefined> = [];
		const externalize = vi.fn();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			decodeResponse(value, expectedCommand) {
				return legacyRpcV1Adapter.decodeResponse(value, expectedCommand);
			},
			decodeOrphanedResponse(value, context) {
				orphanContexts.push(context);
				return legacyRpcV1Adapter.decodeOrphanedResponse(value, context);
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			payloadExternalizer: {
				context: { serverEpoch: "orphan-test-epoch", payloadBudget: SESSION_PAYLOAD_BUDGET },
				externalize,
			},
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "orphan-response" })).resolves.toMatchObject({
			success: true,
		});
		expect(orphanContexts).toHaveLength(1);
		expect(orphanContexts[0]?.externalizer).toBeUndefined();
		expect(externalize).not.toHaveBeenCalled();
	});

	it("isolates a malformed typed event as a child protocol failure", async () => {
		const exits: Array<{
			stderrTail: string;
			reason?: string;
			diagnostic?: { frameKind: string; reason: string; frameType?: string };
		}> = [];
		const events: string[] = [];
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			onEvent: (event) => events.push(event.type),
			onExit: (info) => exits.push(info),
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "malformed-event" })).rejects.toMatchObject({
			name: "PiProtocolIncompatibleError",
			diagnostic: { frameKind: "event", reason: "malformed_event", frameType: "queue_update" },
		});
		await waitFor(() => exits.length === 1);
		expect(exits[0]).toMatchObject({
			reason: "protocol_incompatible",
			diagnostic: { frameKind: "event", reason: "malformed_event", frameType: "queue_update" },
		});
		expect(events).toEqual([]);
		expect(proc.running).toBe(false);
	});

	it("preserves event-response-event order while adapter normalization is asynchronous", async () => {
		const firstEventStarted = deferred();
		const releaseFirstEvent = deferred();
		const normalized: string[] = [];
		const delivered: string[] = [];
		const adapter = withAsyncDecodeGate(async (frame) => {
			if (frame.kind === "event" && frame.event.type === "agent_start") {
				firstEventStarted.resolve();
				await releaseFirstEvent.promise;
			}
			if (frame.kind === "event") normalized.push(`event:${frame.event.type}`);
			if (frame.kind === "response" && frame.command === "prompt") normalized.push("response:prompt");
		});
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			onEvent: (event) => delivered.push(`event:${event.type}`),
		});
		await proc.start();

		const response = proc.send({ type: "prompt", message: "ordered-async" }).then((value) => {
			delivered.push("response:prompt");
			return value;
		});
		await firstEventStarted.promise;
		expect(normalized).toEqual([]);
		expect(delivered).toEqual([]);

		releaseFirstEvent.resolve();
		await response;
		await waitFor(() => delivered.includes("event:agent_settled"));
		expect(normalized).toEqual(["event:agent_start", "response:prompt", "event:agent_settled"]);
		expect(delivered).toEqual(["event:agent_start", "response:prompt", "event:agent_settled"]);
	});

	it("drops an old async decode completion after stop and restart", async () => {
		const oldEventStarted = deferred();
		const releaseOldEvent = deferred();
		const delivered: string[] = [];
		const exits: Array<{ stderrTail: string }> = [];
		const adapter = withAsyncDecodeGate(async (frame) => {
			if (frame.kind === "event" && frame.event.type === "agent_start") {
				oldEventStarted.resolve();
				await releaseOldEvent.promise;
				throw new Error("stale externalizer rejected frame");
			}
		});
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			onEvent: (event) => delivered.push(event.type),
			onExit: (info) => exits.push(info),
		});
		await proc.start();

		const oldCommand = proc.send({ type: "prompt", message: "ordered-async" });
		const oldRejected = expect(oldCommand).rejects.toThrow();
		await oldEventStarted.promise;
		await proc.stop();
		await oldRejected;
		await proc.start();

		releaseOldEvent.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(delivered).toEqual([]);
		expect(exits).toEqual([]);
		expect(proc.running).toBe(true);
	});

	it("does not let a stale async response consume a reused pending id after restart", async () => {
		const oldResponseStarted = deferred();
		const releaseOldResponse = deferred();
		const newResponseStarted = deferred();
		const releaseNewResponse = deferred();
		let promptResponseCount = 0;
		const adapter = withAsyncDecodeGate(async (frame) => {
			if (frame.kind !== "response" || frame.command !== "prompt") return;
			promptResponseCount += 1;
			if (promptResponseCount === 1) {
				oldResponseStarted.resolve();
				await releaseOldResponse.promise;
				return;
			}
			newResponseStarted.resolve();
			await releaseNewResponse.promise;
		});
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
		});
		await proc.start();

		const oldCommand = proc.send({ id: "reused-id", type: "prompt", message: "old-response" });
		const oldResult = oldCommand.then(
			() => "resolved",
			() => "rejected",
		);
		await oldResponseStarted.promise;
		await proc.stop();
		expect(await oldResult).toBe("rejected");
		await proc.start();

		let newSettled = false;
		const newCommand = proc.send({ id: "reused-id", type: "prompt", message: "new-response" }).finally(() => {
			newSettled = true;
		});
		await newResponseStarted.promise;
		releaseOldResponse.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(newSettled).toBe(false);

		releaseNewResponse.resolve();
		await expect(newCommand).resolves.toMatchObject({ id: "reused-id", command: "prompt", success: true });
		expect(proc.running).toBe(true);
	});

	it("terminalizes exactly once when async normalization rejects", async () => {
		const exits: Array<{ stderrTail: string }> = [];
		const delivered: string[] = [];
		let normalizationAttempts = 0;
		const adapter = withAsyncDecodeGate(async (frame) => {
			if (frame.kind !== "event") return;
			normalizationAttempts += 1;
			throw new Error("externalizer rejected frame");
		});
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			onEvent: (event) => delivered.push(event.type),
			onExit: (info) => exits.push(info),
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "ordered-async" })).rejects.toThrow(
			"externalizer rejected frame",
		);
		await waitFor(() => exits.length === 1);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(normalizationAttempts).toBe(1);
		expect(delivered).toEqual([]);
		expect(exits).toHaveLength(1);
		expect(exits[0]?.stderrTail).toContain("externalizer rejected frame");
		expect(proc.running).toBe(false);
	});

	it("aborts a never-settling decode at the spawn deadline and observes its late rejection", async () => {
		const decodeStarted = deferred();
		let rejectDecode: ((error: Error) => void) | undefined;
		let decodeSignal: AbortSignal | undefined;
		const decodeGate = new Promise<void>((_resolve, reject) => {
			rejectDecode = reject;
		});
		const exits: Array<{ stderrTail: string }> = [];
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			const adapter = withAsyncDecodeGate(async (frame, signal) => {
				if (frame.kind !== "event") return;
				decodeSignal = signal;
				decodeStarted.resolve();
				await decodeGate;
			});
			proc = new PiProcess({
				cwd: process.cwd(),
				resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
				adapter,
				decodeTimeoutMs: 20,
				onExit: (info) => exits.push(info),
			});
			await proc.start();

			const command = proc.send({ type: "prompt", message: "ordered-async" });
			await decodeStarted.promise;
			const outcome = await Promise.race([
				command.then(
					() => "resolved",
					(error: Error) => error.message,
				),
				new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 150)),
			]);
			expect(outcome).toContain("decode timed out");
			expect(decodeSignal?.aborted).toBe(true);
			await waitFor(() => exits.length === 1);

			rejectDecode?.(new Error("late externalizer rejection"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(exits).toHaveLength(1);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("observes a failed lease release from a late success after an event decode deadline", async () => {
		const decodeStarted = deferred();
		const releaseDecode = deferred();
		const leased = fakeLease({ rejectRelease: true });
		const exits: Array<{ stderrTail: string }> = [];
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeUnsolicited(value, context);
				if (outcome.value.kind !== "event" || outcome.value.event.type !== "agent_start") return outcome;
				decodeStarted.resolve();
				await releaseDecode.promise;
				return { value: outcome.value, lease: leased.lease };
			},
		};
		try {
			proc = new PiProcess({
				cwd: process.cwd(),
				resolved: {
					command: process.execPath,
					args: [fakePiPath],
					source: "pi-path",
					label: "fake Pi",
				},
				adapter,
				decodeTimeoutMs: 20,
				onExit: (info) => exits.push(info),
			});
			await proc.start();

			const command = proc.send({ type: "prompt", message: "ordered-async" });
			await decodeStarted.promise;
			await expect(command).rejects.toThrow("decode timed out");
			await waitFor(() => exits.length === 1);
			releaseDecode.resolve();
			await waitFor(() => leased.release.mock.calls.length === 1);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(leased.release).toHaveBeenCalledOnce();
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("keeps the removed pre-callback hold adoption API out of PiProcess options", () => {
		const options: PiProcessOptions = {
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			// @ts-expect-error pre-callback hold adoption was intentionally removed
			adoptDecodedHolds: () => true,
		};
		void options;
	});

	it("releases and fails closed when the inline-only event callback receives a lease", async () => {
		const leased = fakeLease();
		const delivered: string[] = [];
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeUnsolicited(value, context);
				return outcome.value.kind === "event" && outcome.value.event.type === "agent_start"
					? { value: outcome.value, lease: leased.lease }
					: outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			onEvent: (event) => delivered.push(event.type),
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "ordered-async" })).rejects.toThrow(
			"inline-only Pi event delivery cannot carry attachment holds",
		);
		expect(leased.release).toHaveBeenCalledOnce();
		expect(delivered).toEqual([]);
	});

	it("hands a leased event transfer to the decoded callback without releasing it", async () => {
		const leased = fakeLease();
		const order: string[] = [];
		let claimed: PiPayloadLeaseTransfer | null | undefined;
		let consumerReturned = false;
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeUnsolicited(value, context);
				return outcome.value.kind === "event" && outcome.value.event.type === "agent_start"
					? { value: outcome.value, lease: leased.lease }
					: outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			onDecodedEvent: (delivery) => {
				expect(delivery.value.type).toBe("agent_start");
				const plan = delivery.prepare((transfer) => {
					expect(consumerReturned).toBe(true);
					claimed = transfer;
					order.push("accept");
					return true;
				});
				consumerReturned = true;
				return plan;
			},
		});
		await proc.start();

		await proc.send({ type: "prompt", message: "ordered-async" });
		await waitFor(() => order.includes("accept"));
		expect(order).toEqual(["accept"]);
		expect(claimed?.refs).toEqual(leased.lease.refs);
		expect(leased.release).not.toHaveBeenCalled();
		await claimed?.release();
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it("returns a leased response transfer from sendDecoded without releasing it", async () => {
		const leased = fakeLease();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeResponse(value, expectedCommand, context) {
				const outcome = await legacyRpcV1Adapter.decodeResponse(value, expectedCommand, context);
				return expectedCommand === "prompt" ? { value: outcome.value, lease: leased.lease } : outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
		});
		await proc.start();

		let claimed: PiPayloadLeaseTransfer | null | undefined;
		const response = await proc.sendDecoded(
			{ id: "public-response", type: "prompt", message: "response" },
			(delivery) => {
				expect(delivery.value).toMatchObject({ id: "public-response", command: "prompt", success: true });
				return delivery.prepare((transfer) => {
					claimed = transfer;
					return true;
				});
			},
		);
		expect(response).toMatchObject({ id: "public-response", command: "prompt", success: true });
		expect(claimed?.refs).toEqual(leased.lease.refs);
		expect(leased.release).not.toHaveBeenCalled();
		await claimed?.release();
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it("delivers a future content lease as an EpochStoredContentRef transfer", async () => {
		const leased = fakeMixedFutureLease();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeFutureResponse(value, expectedCommand, context: PiHostFutureDecodeContext) {
				const outcome = await legacyRpcV1Adapter.decodeFutureResponse(value, expectedCommand, context);
				return expectedCommand === "prompt" ? { value: outcome.value, lease: leased.lease } : outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			payloadExternalizer: futurePayloadExternalizer,
		});
		await proc.start();

		let claimed: PiPayloadLeaseTransfer<EpochStoredContentRef> | null | undefined;
		const response = await proc.sendFutureDecoded(
			{ id: "future-public-response", type: "prompt", message: "response" },
			(delivery) =>
				delivery.prepare((transfer) => {
					claimed = transfer;
					return true;
				}),
		);

		expect(response).toMatchObject({ id: "future-public-response", command: "prompt", success: true });
		expect(claimed?.refs).toEqual(leased.lease.refs);
		expect(leased.release).not.toHaveBeenCalled();
		await claimed?.release();
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it("rejects the current decoded-delivery API in future mode without skipping its consumer", async () => {
		const consume: PiDecodedDeliveryConsumer<SessionCommandResponseDto> = vi.fn((delivery) =>
			delivery.prepare(() => true),
		);
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			payloadExternalizer: futurePayloadExternalizer,
		});
		await proc.start();

		await expect(proc.sendDecoded({ type: "get_state" }, consume)).rejects.toThrow(
			"current decoded delivery is not available in future content mode",
		);
		expect(consume).not.toHaveBeenCalled();
		expect(proc.running).toBe(true);
	});

	it.each([
		["inline wrapper without a lease", false],
		["leased wrapper", true],
	] as const)("never leaks a future history %s through current send", async (_name, withLease) => {
		const leased = fakeFutureLease();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeFutureResponse(value, expectedCommand, context) {
				const outcome = await legacyRpcV1Adapter.decodeFutureResponse(value, expectedCommand, context);
				if (expectedCommand !== "get_messages") return outcome;
				return {
					value: {
						type: "response",
						id: outcome.value.id,
						command: "get_messages",
						success: true,
						data: {
							messages: [
								{
									role: "toolResult",
									toolCallId: "tool-1",
									toolName: "read",
									content: [{ type: "text", text: "small" }],
									details: { type: "inline_json", value: { ok: true } },
									isError: false,
									timestamp: 1,
								},
							],
						},
					},
					lease: withLease ? leased.lease : null,
				};
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			payloadExternalizer: futurePayloadExternalizer,
		});
		await proc.start();

		await expect(proc.send({ type: "get_messages" })).rejects.toThrow(
			"future content history responses require a decoded consumer",
		);
		if (withLease) expect(leased.release).toHaveBeenCalledOnce();
		else expect(leased.release).not.toHaveBeenCalled();
	});

	it("releases a future content lease when its pending command times out during decode", async () => {
		const responseStarted = deferred();
		const releaseResponse = deferred();
		const leased = fakeFutureLease();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeFutureResponse(value, expectedCommand, context) {
				const outcome = await legacyRpcV1Adapter.decodeFutureResponse(value, expectedCommand, context);
				if (expectedCommand !== "prompt") return outcome;
				responseStarted.resolve();
				await releaseResponse.promise;
				return { value: outcome.value, lease: leased.lease };
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			payloadExternalizer: futurePayloadExternalizer,
		});
		await proc.start();

		const command = proc.sendFutureDecoded(
			{ type: "prompt", message: "response" },
			(delivery) => delivery.prepare(() => true),
			20,
		);
		await responseStarted.promise;
		await expect(command).rejects.toThrow("command timed out");
		releaseResponse.resolve();
		await waitFor(() => leased.release.mock.calls.length === 1);
		expect(leased.release).toHaveBeenCalledOnce();
		expect(proc.running).toBe(true);
	});

	it("keeps a future response decode deadline local and releases its late union lease", async () => {
		const responseStarted = deferred();
		const releaseResponse = deferred();
		const leased = fakeFutureLease();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeFutureResponse(value, expectedCommand, context) {
				const outcome = await legacyRpcV1Adapter.decodeFutureResponse(value, expectedCommand, context);
				if (expectedCommand !== "prompt") return outcome;
				responseStarted.resolve();
				await releaseResponse.promise;
				return { value: outcome.value, lease: leased.lease };
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			payloadExternalizer: futurePayloadExternalizer,
			decodeTimeoutMs: 20,
		});
		await proc.start();

		const command = proc.sendFutureDecoded({ type: "prompt", message: "response" }, (delivery) =>
			delivery.prepare(() => true),
		);
		await responseStarted.promise;
		await expect(command).rejects.toMatchObject({
			name: "PiHostResponseExternalizationError",
			failure: "deadline",
		});
		expect(proc.running).toBe(true);
		releaseResponse.resolve();
		await waitFor(() => leased.release.mock.calls.length === 1);
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it("keeps current Extension UI on the inline callback", async () => {
		const delivered: string[] = [];
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			onExtensionUiRequest: (request) => delivered.push(request.id),
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "open-dialog" })).resolves.toMatchObject({
			success: true,
		});
		expect(delivered).toEqual(["fake-dialog"]);
		expect(proc.running).toBe(true);
	});

	it("delivers future Extension UI through PreparedDecodedDelivery and transfers its lease", async () => {
		const leased = fakeFutureLease();
		const delivered: string[] = [];
		let claimed: PiPayloadLeaseTransfer<EpochStoredContentRef> | null | undefined;
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeFutureUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeFutureUnsolicited(value, context);
				return outcome.value.kind === "extension_ui_request"
					? { value: outcome.value, lease: leased.lease }
					: outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			payloadExternalizer: futurePayloadExternalizer,
			onFutureDecodedExtensionUiRequest: (delivery) => {
				delivered.push(delivery.value.id);
				return delivery.prepare((transfer) => {
					claimed = transfer;
					return true;
				});
			},
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "open-dialog" })).resolves.toMatchObject({
			success: true,
		});
		expect(delivered).toEqual(["fake-dialog"]);
		expect(claimed?.refs).toEqual(leased.lease.refs);
		expect(leased.release).not.toHaveBeenCalled();
		await claimed?.release();
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it("terminally releases a future Extension lease when its prepared consumer is missing", async () => {
		const leased = fakeFutureLease();
		const exits: Array<{ stderrTail: string }> = [];
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeFutureUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeFutureUnsolicited(value, context);
				return outcome.value.kind === "extension_ui_request"
					? { value: outcome.value, lease: leased.lease }
					: outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			payloadExternalizer: futurePayloadExternalizer,
			onExit: (info) => exits.push(info),
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "open-dialog" })).rejects.toThrow(
			"future Pi Extension UI delivery requires a decoded consumer",
		);
		await waitFor(() => exits.length === 1);
		expect(leased.release).toHaveBeenCalledOnce();
		expect(proc.running).toBe(false);
	});

	it("releases a stopped future Extension decode without delivering into the restarted spawn", async () => {
		const extensionStarted = deferred();
		const releaseExtension = deferred();
		const leased = fakeFutureLease();
		const delivered: string[] = [];
		let extensionSignal: AbortSignal | undefined;
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeFutureUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeFutureUnsolicited(value, context);
				if (outcome.value.kind !== "extension_ui_request") return outcome;
				extensionSignal = context.signal;
				extensionStarted.resolve();
				await releaseExtension.promise;
				return { value: outcome.value, lease: leased.lease };
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			payloadExternalizer: futurePayloadExternalizer,
			onFutureDecodedExtensionUiRequest: (delivery) => {
				delivered.push(delivery.value.id);
				return delivery.prepare(() => true);
			},
		});
		await proc.start();

		const oldCommand = proc.send({ type: "prompt", message: "open-dialog" });
		const oldResult = oldCommand.then(
			() => "resolved",
			() => "rejected",
		);
		await extensionStarted.promise;
		await proc.stop();
		expect(await oldResult).toBe("rejected");
		expect(extensionSignal?.aborted).toBe(true);
		await proc.start();

		releaseExtension.resolve();
		await waitFor(() => leased.release.mock.calls.length === 1);
		expect(leased.release).toHaveBeenCalledOnce();
		expect(delivered).toEqual([]);
		expect(proc.running).toBe(true);
	});

	it("keeps a future authoritative-event deadline terminal and releases its late union lease", async () => {
		const eventStarted = deferred();
		const releaseEvent = deferred();
		const leased = fakeFutureLease();
		const exits: Array<{ stderrTail: string }> = [];
		let eventSignal: AbortSignal | undefined;
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeFutureUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeFutureUnsolicited(value, context);
				if (outcome.value.kind !== "event" || outcome.value.event.type !== "agent_start") return outcome;
				eventSignal = context.signal;
				eventStarted.resolve();
				await releaseEvent.promise;
				return { value: outcome.value, lease: leased.lease };
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			payloadExternalizer: futurePayloadExternalizer,
			decodeTimeoutMs: 20,
			onFutureDecodedEvent: (delivery) => delivery.prepare(() => true),
			onExit: (info) => exits.push(info),
		});
		await proc.start();

		const command = proc.send({ type: "prompt", message: "ordered-async" });
		await eventStarted.promise;
		await expect(command).rejects.toThrow("decode timed out");
		await waitFor(() => exits.length === 1);
		expect(eventSignal?.aborted).toBe(true);
		expect(proc.running).toBe(false);
		releaseEvent.resolve();
		await waitFor(() => leased.release.mock.calls.length === 1);
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it("releases a stopped future decode after restart without delivering into the new spawn", async () => {
		const eventStarted = deferred();
		const releaseEvent = deferred();
		const leased = fakeFutureLease();
		const delivered: string[] = [];
		let eventSignal: AbortSignal | undefined;
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeFutureUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeFutureUnsolicited(value, context);
				if (outcome.value.kind !== "event" || outcome.value.event.type !== "agent_start") return outcome;
				eventSignal = context.signal;
				eventStarted.resolve();
				await releaseEvent.promise;
				return { value: outcome.value, lease: leased.lease };
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			payloadExternalizer: futurePayloadExternalizer,
			onFutureDecodedEvent: (delivery) => {
				delivered.push(delivery.value.type);
				return delivery.prepare(() => true);
			},
		});
		await proc.start();

		const oldCommand = proc.send({ type: "prompt", message: "ordered-async" });
		const oldResult = oldCommand.then(
			() => "resolved",
			() => "rejected",
		);
		await eventStarted.promise;
		await proc.stop();
		expect(await oldResult).toBe("rejected");
		expect(eventSignal?.aborted).toBe(true);
		await proc.start();

		releaseEvent.resolve();
		await waitFor(() => leased.release.mock.calls.length === 1);
		expect(leased.release).toHaveBeenCalledOnce();
		expect(delivered).toEqual([]);
		expect(proc.running).toBe(true);
	});

	it("releases and rejects a decoded callback that returns true without claiming ownership", async () => {
		const leased = fakeLease();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeUnsolicited(value, context);
				return outcome.value.kind === "event" && outcome.value.event.type === "agent_start"
					? { value: outcome.value, lease: leased.lease }
					: outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			onDecodedEvent: (() => true) as unknown as PiDecodedDeliveryConsumer<ProductSessionEventDto>,
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "ordered-async" })).rejects.toThrow(
			"did not prepare its exact delivery",
		);
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it("releases and fails closed when inline-only send receives a leased response", async () => {
		const leased = fakeLease();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeResponse(value, expectedCommand, context) {
				const outcome = await legacyRpcV1Adapter.decodeResponse(value, expectedCommand, context);
				return expectedCommand === "prompt" ? { value: outcome.value, lease: leased.lease } : outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "leased-inline-response" })).rejects.toThrow(
			"inline-only Pi response delivery cannot carry attachment holds",
		);
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it.each([
		["false", (): boolean => false],
		["undefined", (): undefined => undefined],
		["thenable", (): Promise<never> => Promise.reject(new Error("async consumer rejected"))],
		[
			"throw",
			(): never => {
				throw new Error("decoded event callback failed");
			},
		],
	] as const)("releases a leased event when the decoded callback returns %s", async (_name, callback) => {
		const leased = fakeLease();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeUnsolicited(value, context);
				return outcome.value.kind === "event" && outcome.value.event.type === "agent_start"
					? { value: outcome.value, lease: leased.lease }
					: outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			onDecodedEvent: callback as unknown as PiDecodedDeliveryConsumer<ProductSessionEventDto>,
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "ordered-async" })).rejects.toThrow();
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it.each([
		["false", (): boolean => false],
		["undefined", (): undefined => undefined],
		["thenable", (): Promise<never> => Promise.reject(new Error("async commit rejected"))],
		[
			"throw",
			(): never => {
				throw new Error("decoded plan commit failed");
			},
		],
	] as const)("releases a leased event when the prepared commit returns %s", async (_name, result) => {
		const leased = fakeLease();
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeUnsolicited(value, context);
				return outcome.value.kind === "event" && outcome.value.event.type === "agent_start"
					? { value: outcome.value, lease: leased.lease }
					: outcome;
			},
		};
		try {
			proc = new PiProcess({
				cwd: process.cwd(),
				resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
				adapter,
				onDecodedEvent: (delivery) =>
					delivery.prepare(result as unknown as (transfer: PiPayloadLeaseTransfer | null) => true),
			});
			await proc.start();

			await expect(proc.send({ type: "prompt", message: "ordered-async" })).rejects.toThrow();
			expect(leased.release).toHaveBeenCalledOnce();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("does not expose a transfer when the decoded consumer stops the owning spawn", async () => {
		const leased = fakeLease();
		let commitCalled = false;
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeUnsolicited(value, context);
				return outcome.value.kind === "event" && outcome.value.event.type === "agent_start"
					? { value: outcome.value, lease: leased.lease }
					: outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			onDecodedEvent: (delivery) => {
				const plan = delivery.prepare(() => {
					commitCalled = true;
					return true;
				});
				void proc?.stop();
				return plan;
			},
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "ordered-async" })).rejects.toThrow();
		await waitFor(() => leased.release.mock.calls.length === 1);
		expect(commitCalled).toBe(false);
		expect(leased.adopt).not.toHaveBeenCalled();
	});

	it("does not release custody after a literal-true commit even when that commit stops the spawn", async () => {
		const leased = fakeLease();
		let ownedTransfer: PiPayloadLeaseTransfer | null | undefined;
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeUnsolicited(value, context);
				return outcome.value.kind === "event" && outcome.value.event.type === "agent_start"
					? { value: outcome.value, lease: leased.lease }
					: outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			onDecodedEvent: (delivery) =>
				delivery.prepare((transfer) => {
					ownedTransfer = transfer;
					void proc?.stop();
					return true;
				}),
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "ordered-async" })).rejects.toThrow();
		expect(ownedTransfer?.refs).toEqual(leased.lease.refs);
		expect(leased.release).not.toHaveBeenCalled();
		await ownedTransfer?.release();
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it("terminalizes after an adopted commit throws and leaves cleanup to the generation owner", async () => {
		const exactRef: SessionAttachmentRefDto = {
			type: "attachment_ref",
			serverEpoch: "process-test-epoch",
			sha256: "c".repeat(64),
			mediaType: "image/png",
			byteLength: 1,
		};
		const exactHold = Object.freeze({ ref: exactRef });
		const releaseOwnedHold = vi.fn(async (_hold: EpochContentHold) => {});
		const owner = new GenerationContentOwner({
			serverEpoch: exactRef.serverEpoch,
			generation: 3,
			release: releaseOwnedHold,
		});
		let transferState: "pending" | "adopted" | "released" = "pending";
		const transferRelease = vi.fn(async () => {
			if (transferState !== "pending") return;
			transferState = "released";
			await releaseOwnedHold(exactHold);
		});
		const transfer: PiPayloadLeaseTransfer = {
			refs: [exactRef],
			adopt(accept) {
				if (transferState !== "pending") throw new Error("transfer is not pending");
				if (accept([exactHold]) !== true) throw new Error("transfer was not accepted");
				transferState = "adopted";
			},
			release: transferRelease,
		};
		const lease: PiPayloadLease = {
			refs: [exactRef],
			transfer: () => transfer,
			release: async () => {
				if (transferState === "pending") await transferRelease();
			},
		};
		const exits: Array<{ stderrTail: string }> = [];
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeUnsolicited(value, context);
				return outcome.value.kind === "event" && outcome.value.event.type === "agent_start"
					? { value: outcome.value, lease }
					: outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			onDecodedEvent: (delivery) =>
				delivery.prepare((transfer) => {
					if (!transfer) throw new Error("missing transfer");
					owner.adopt(transfer);
					throw new Error("projection commit failed after adoption");
				}),
			onExit: (info) => exits.push(info),
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "ordered-async" })).rejects.toThrow(
			"projection commit failed after adoption",
		);
		await waitFor(() => exits.length === 1);
		expect(owner.size).toBe(1);
		expect(transferRelease).toHaveBeenCalledOnce();
		expect(releaseOwnedHold).not.toHaveBeenCalled();
		expect(exits).toHaveLength(1);
		await owner.release();
		expect(releaseOwnedHold).toHaveBeenCalledOnce();
	});

	it("releases a leased event when no event callback is installed", async () => {
		const leased = fakeLease();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeUnsolicited(value, context) {
				const outcome = await legacyRpcV1Adapter.decodeUnsolicited(value, context);
				return outcome.value.kind === "event" && outcome.value.event.type === "agent_start"
					? { value: outcome.value, lease: leased.lease }
					: outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "ordered-async" })).resolves.toMatchObject({
			success: true,
		});
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it("releases the original lease when transfer throws and aggregates a cleanup rejection", async () => {
		const ref: SessionAttachmentRefDto = {
			type: "attachment_ref",
			serverEpoch: "process-test-epoch",
			sha256: "b".repeat(64),
			mediaType: "image/png",
			byteLength: 1,
		};
		const release = vi.fn(async () => {
			throw new Error("transfer cleanup failed");
		});
		const lease: PiPayloadLease = {
			refs: [ref],
			transfer() {
				throw new Error("transfer failed");
			},
			release,
		};
		const exits: Array<{ stderrTail: string }> = [];
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			const adapter: PiHostAdapter = {
				...legacyRpcV1Adapter,
				async decodeUnsolicited(value, context) {
					const outcome = await legacyRpcV1Adapter.decodeUnsolicited(value, context);
					return outcome.value.kind === "event" && outcome.value.event.type === "agent_start"
						? { value: outcome.value, lease }
						: outcome;
				},
			};
			proc = new PiProcess({
				cwd: process.cwd(),
				resolved: {
					command: process.execPath,
					args: [fakePiPath],
					source: "pi-path",
					label: "fake Pi",
				},
				adapter,
				onDecodedEvent: (delivery) => delivery.prepare(() => true),
				onExit: (info) => exits.push(info),
			});
			await proc.start();

			await expect(proc.send({ type: "prompt", message: "ordered-async" })).rejects.toMatchObject({
				name: "AggregateError",
			});
			await waitFor(() => exits.length === 1);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(release).toHaveBeenCalledOnce();
			expect(exits).toHaveLength(1);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("releases a leased response when its pending command times out during decode", async () => {
		const responseStarted = deferred();
		const releaseResponse = deferred();
		const leased = fakeLease();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeResponse(value, expectedCommand, context) {
				const outcome = await legacyRpcV1Adapter.decodeResponse(value, expectedCommand, context);
				if (expectedCommand !== "prompt") return outcome;
				responseStarted.resolve();
				await releaseResponse.promise;
				return { value: outcome.value, lease: leased.lease };
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
		});
		await proc.start();

		const command = proc.send({ type: "prompt", message: "ordered-async" }, 20);
		await responseStarted.promise;
		await expect(command).rejects.toThrow("command timed out");
		releaseResponse.resolve();
		await waitFor(() => leased.release.mock.calls.length === 1);
		expect(proc.running).toBe(true);
	});

	it("rejects a response-local delivery failure without terminating the Pi process", async () => {
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			decodeResponse(value, expectedCommand, context) {
				if (expectedCommand === "prompt") {
					throw new PiHostResponseExternalizationError("prompt", "cache_bytes_exhausted");
				}
				return legacyRpcV1Adapter.decodeResponse(value, expectedCommand, context);
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "response-local" })).rejects.toThrow(
			"Gateway failed to deliver the Pi prompt response",
		);
		await expect(proc.send({ type: "get_state" })).resolves.toMatchObject({
			command: "get_state",
			success: true,
		});
		expect(proc.running).toBe(true);
	});

	it("keeps a response decode deadline local while aborting its operation signal", async () => {
		const responseStarted = deferred();
		let responseSignal: AbortSignal | undefined;
		const never = new Promise<void>(() => {});
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeResponse(value, expectedCommand, context) {
				const outcome = await legacyRpcV1Adapter.decodeResponse(value, expectedCommand, context);
				if (expectedCommand !== "prompt") return outcome;
				responseSignal = context?.signal;
				responseStarted.resolve();
				await never;
				return outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			decodeTimeoutMs: 20,
		});
		await proc.start();

		const response = proc.send({ type: "prompt", message: "response-deadline" });
		await responseStarted.promise;
		await expect(response).rejects.toMatchObject({
			name: "PiHostResponseExternalizationError",
			failure: "deadline",
		});
		expect(responseSignal?.aborted).toBe(true);
		await expect(proc.send({ type: "get_state" })).resolves.toMatchObject({ success: true });
		expect(proc.running).toBe(true);
	});

	it("uses its own deadline provenance when the adapter rejects from the operation abort signal", async () => {
		const responseStarted = deferred();
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			async decodeResponse(value, expectedCommand, context) {
				const outcome = await legacyRpcV1Adapter.decodeResponse(value, expectedCommand, context);
				if (expectedCommand !== "prompt") return outcome;
				responseStarted.resolve();
				await new Promise<never>((_resolve, reject) => {
					const rejectAborted = () =>
						reject(new PiPayloadExternalizationError("aborted", "operation signal aborted"));
					if (context?.signal.aborted) rejectAborted();
					else context?.signal.addEventListener("abort", rejectAborted, { once: true });
				});
				return outcome;
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			decodeTimeoutMs: 20,
		});
		await proc.start();

		const response = proc.send({ type: "prompt", message: "deadline-abort-race" });
		await responseStarted.promise;
		await expect(response).rejects.toMatchObject({
			name: "PiHostResponseExternalizationError",
			failure: "deadline",
		});
		await expect(proc.send({ type: "get_state" })).resolves.toMatchObject({ success: true });
		expect(proc.running).toBe(true);
	});

	it("treats a typed response-local error from an authoritative event as terminal", async () => {
		const exits: Array<{ stderrTail: string }> = [];
		const adapter: PiHostAdapter = {
			...legacyRpcV1Adapter,
			decodeUnsolicited(value, context) {
				if ((value as { type?: string }).type === "agent_start") {
					throw new PiHostResponseExternalizationError("get_messages", "cache_bytes_exhausted");
				}
				return legacyRpcV1Adapter.decodeUnsolicited(value, context);
			},
		};
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			onExit: (info) => exits.push(info),
		});
		await proc.start();

		await expect(proc.send({ type: "prompt", message: "ordered-async" })).rejects.toThrow(
			"Gateway failed to deliver",
		);
		await waitFor(() => exits.length === 1);
		expect(proc.running).toBe(false);
	});

	it("aborts an active decode on manual stop and drops its late protocol rejection after restart", async () => {
		const decodeStarted = deferred();
		const releaseDecode = deferred();
		let decodeSignal: AbortSignal | undefined;
		const exits: Array<{ reason?: string }> = [];
		const adapter = withAsyncDecodeGate(async (frame, signal) => {
			if (frame.kind !== "event") return;
			decodeSignal = signal;
			decodeStarted.resolve();
			await releaseDecode.promise;
			throw new PiProtocolIncompatibleError({
				code: "protocol_incompatible",
				adapterId: legacyRpcV1Adapter.id,
				frameKind: "event",
				reason: "malformed_event",
				frameType: "agent_start",
			});
		});
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			decodeTimeoutMs: 1_000,
			onExit: (info) => exits.push(info),
		});
		await proc.start();

		const oldCommand = proc.send({ type: "prompt", message: "ordered-async" });
		const oldResult = oldCommand.then(
			() => "resolved",
			() => "rejected",
		);
		await decodeStarted.promise;
		await proc.stop();
		expect(decodeSignal?.aborted).toBe(true);
		expect(await oldResult).toBe("rejected");
		await proc.start();

		releaseDecode.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(exits).toEqual([]);
		expect(proc.running).toBe(true);
	});

	it("lets an active protocol rejection win over a concurrent unexpected child exit", async () => {
		const decodeStarted = deferred();
		const releaseDecode = deferred();
		const exits: Array<{ reason?: string; diagnostic?: { reason: string } }> = [];
		const adapter = withAsyncDecodeGate(async (frame) => {
			if (frame.kind !== "event") return;
			decodeStarted.resolve();
			await releaseDecode.promise;
			throw new PiProtocolIncompatibleError({
				code: "protocol_incompatible",
				adapterId: legacyRpcV1Adapter.id,
				frameKind: "event",
				reason: "malformed_event",
				frameType: "agent_start",
			});
		});
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			adapter,
			decodeTimeoutMs: 1_000,
			onExit: (info) => exits.push(info),
		});
		await proc.start();

		const command = proc.send({ type: "prompt", message: "async-decode-exit" });
		await decodeStarted.promise;
		const internals = proc as unknown as {
			spawnIdentity: { leaderExitObserved: boolean } | null;
		};
		await waitFor(() => internals.spawnIdentity?.leaderExitObserved === true);
		releaseDecode.resolve();

		await expect(command).rejects.toMatchObject({
			name: "PiProtocolIncompatibleError",
			diagnostic: { reason: "malformed_event" },
		});
		await waitFor(() => exits.length === 1);
		expect(exits).toEqual([
			expect.objectContaining({
				reason: "protocol_incompatible",
				diagnostic: expect.objectContaining({ reason: "malformed_event" }),
			}),
		]);
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
		tempDir = await mkdtemp(path.join(tmpdir(), "pi-web-argv-"));
		const argvMarker = path.join(tempDir, "argv.json");
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
			env: { PI_WEB_FAKE_ARGV_MARKER: argvMarker },
		});
		await proc.start();

		expect(JSON.parse(readFileSync(argvMarker, "utf8"))).toEqual([
			"--mode",
			"rpc",
			"--session",
			"/tmp/native.jsonl",
		]);
		expect(resolved.args).toEqual([fakePiPath, "--mode", "rpc"]);
	});

	it.runIf(process.platform !== "win32")("stops descendants in Pi's detached process group", async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pi-web-process-group-stop-"));
		const pidMarker = path.join(tempDir, "pids.json");
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: {
				command: process.execPath,
				args: [processGroupPiPath],
				source: "pi-path",
				label: "group Pi",
			},
			env: { PI_WEB_PROCESS_GROUP_PID_MARKER: pidMarker },
		});
		await proc.start();
		const state = processGroupPids(pidMarker);
		descendantPid = state.descendantPid;

		await proc.stop();
		expect(() => process.kill(state.descendantPid, 0)).toThrow();
	});

	it.runIf(process.platform !== "win32")(
		"cleans the detached process group before reporting an unexpected leader exit",
		async () => {
			tempDir = await mkdtemp(path.join(tmpdir(), "pi-web-process-group-"));
			const marker = path.join(tempDir, "descendant-survived");
			const pidMarker = path.join(tempDir, "pids.json");
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
					env: {
						PI_WEB_PROCESS_GROUP_EXIT_MARKER: marker,
						PI_WEB_PROCESS_GROUP_PID_MARKER: pidMarker,
					},
					onExit: (info) => resolveExit?.(info),
				});
				await proc.start();
				const state = processGroupPids(pidMarker);
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
			const pidMarker = path.join(tempDir, "pids.json");
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
					PI_WEB_PROCESS_GROUP_PID_MARKER: pidMarker,
				},
				onExit: () => resolveExit?.(),
			});
			await proc.start();
			const state = processGroupPids(pidMarker);
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
			const pidMarker = path.join(tempDir, "pids.json");
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
					PI_WEB_PROCESS_GROUP_PID_MARKER: pidMarker,
				},
				onExit: () => resolveExit?.(),
			});
			await proc.start();
			const state = processGroupPids(pidMarker);
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
			const pidMarker = path.join(tempDir, "pids.json");
			let resolveExit:
				| ((info: {
						code: number | null;
						signal: NodeJS.Signals | null;
						stderrTail: string;
						reason?: string;
						diagnostic?: { reason: string };
				  }) => void)
				| undefined;
			const exited = new Promise<{
				code: number | null;
				signal: NodeJS.Signals | null;
				stderrTail: string;
				reason?: string;
				diagnostic?: { reason: string };
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
					PI_WEB_PROCESS_GROUP_PID_MARKER: pidMarker,
					PI_WEB_PROCESS_GROUP_PROTOCOL_FAILURE: "1",
				},
				onExit: (info) => resolveExit?.(info),
			});
			await proc.start();
			const state = processGroupPids(pidMarker);
			descendantPid = state.descendantPid;

			const info = await exited;
			expect(info).toMatchObject({
				reason: "protocol_incompatible",
				diagnostic: { reason: "oversized_frame" },
			});
			expect(proc.running).toBe(false);
			expect(() => process.kill(state.descendantPid, 0)).toThrow();
			await new Promise<void>((resolve) => setTimeout(resolve, 350));
			expect(existsSync(marker)).toBe(false);
		},
	);

	it("terminates a process that emits an oversized JSONL line", async () => {
		const failures: Array<{ stderrTail: string; reason?: string; diagnostic?: { reason: string } }> = [];
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: {
				command: process.execPath,
				args: [longLinePiPath],
				source: "pi-path",
				label: "long line Pi",
			},
			onExit: (info) => failures.push(info),
		});
		await proc.start();
		await waitFor(() => failures.length === 1, 5_000);
		await waitFor(() => !proc?.running, 5_000);
		expect(failures[0]).toMatchObject({
			reason: "protocol_incompatible",
			diagnostic: { reason: "oversized_frame" },
		});
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

	it("admits only a closed future event above 8 MiB and transfers its union lease", async () => {
		const leased = fakeFutureLease();
		const ref = leased.lease.refs[0];
		const emptyLease: PiPayloadLease<EpochStoredContentRef> = {
			refs: [],
			transfer: () => {
				throw new Error("empty lease");
			},
			release: async () => {},
		};
		const externalize = vi.fn(async (input: { value: unknown }) => {
			const value = input.value as { type?: string };
			return value.type === "tool_execution_start"
				? { value: { ...value, args: { type: "external_json", ref } }, lease: leased.lease }
				: { value, lease: emptyLease };
		});
		let claimed: PiPayloadLeaseTransfer<EpochStoredContentRef> | null | undefined;
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			payloadExternalizer: {
				...futurePayloadExternalizer,
				externalize,
			},
			onFutureDecodedEvent: (delivery) =>
				delivery.prepare((transfer) => {
					claimed = transfer;
					return true;
				}),
		});
		await proc.start();
		externalize.mockClear();
		const internals = proc as unknown as {
			handleLine(line: string): Promise<void>;
			currentJsonlLineBudget(): number;
		};
		expect(internals.currentJsonlLineBudget()).toBe(MAX_JSONL_FUTURE_CONTENT_LINE_BYTES);

		await internals.handleLine(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "tool",
				args: "x".repeat(MAX_JSONL_LINE_BYTES),
			}),
		);

		expect(externalize).toHaveBeenCalledOnce();
		expect(claimed?.refs).toEqual([ref]);
		await claimed?.release();
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it("admits an exact future Extension root above 8 MiB and transfers its lease", async () => {
		const leased = fakeFutureLease();
		const ref = leased.lease.refs[0];
		const externalize = vi.fn(async (input: PiPayloadExternalizerInput) => {
			if (input.kind !== "extension_ui_request") return futurePayloadExternalizer.externalize(input);
			return {
				value: {
					type: "extension_ui_request",
					id: "extension-wide",
					method: "set_editor_text",
					text: { type: "external_text", ref },
				},
				lease: leased.lease,
			};
		});
		let claimed: PiPayloadLeaseTransfer<EpochStoredContentRef> | null | undefined;
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			payloadExternalizer: { ...futurePayloadExternalizer, externalize },
			onFutureDecodedExtensionUiRequest: (delivery) =>
				delivery.prepare((transfer) => {
					claimed = transfer;
					return true;
				}),
		});
		await proc.start();
		externalize.mockClear();
		const internals = proc as unknown as { handleLine(line: string): Promise<void> };

		await internals.handleLine(
			JSON.stringify({
				type: "extension_ui_request",
				id: "extension-wide",
				method: "set_editor_text",
				text: "x".repeat(MAX_JSONL_LINE_BYTES),
			}),
		);

		expect(externalize).toHaveBeenCalledOnce();
		expect(claimed?.refs).toEqual([ref]);
		await claimed?.release();
		expect(leased.release).toHaveBeenCalledOnce();
	});

	it("rejects an oversized excluded future Extension field before externalization", async () => {
		const externalize = vi.fn(futurePayloadExternalizer.externalize);
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			payloadExternalizer: { ...futurePayloadExternalizer, externalize },
		});
		await proc.start();
		externalize.mockClear();
		const internals = proc as unknown as { handleLine(line: string): Promise<void> };

		await expect(
			internals.handleLine(
				JSON.stringify({
					type: "extension_ui_request",
					id: "status-wide",
					method: "setStatus",
					statusKey: "status",
					statusText: "x".repeat(MAX_JSONL_LINE_BYTES),
				}),
			),
		).rejects.toMatchObject({
			name: "PiProtocolIncompatibleError",
			diagnostic: { reason: "oversized_frame" },
		});
		expect(externalize).not.toHaveBeenCalled();
	});

	it.each([
		["Extension request", { type: "extension_ui_request", id: "ext", method: "notify" }],
		["opaque event", { type: "queue_update", action: "clear" }],
	])("rejects an oversized future %s before externalization", async (_name, frame) => {
		const externalize = vi.fn(futurePayloadExternalizer.externalize);
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			payloadExternalizer: { ...futurePayloadExternalizer, externalize },
		});
		await proc.start();
		externalize.mockClear();
		const internals = proc as unknown as { handleLine(line: string): Promise<void> };

		await expect(
			internals.handleLine(JSON.stringify({ ...frame, padding: "x".repeat(MAX_JSONL_LINE_BYTES) })),
		).rejects.toMatchObject({
			name: "PiProtocolIncompatibleError",
			diagnostic: { reason: "oversized_frame" },
		});
		expect(externalize).not.toHaveBeenCalled();
	});

	it("raw-validates and ignores an oversized future history orphan without externalization", async () => {
		const externalize = vi.fn(futurePayloadExternalizer.externalize);
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			payloadExternalizer: { ...futurePayloadExternalizer, externalize },
		});
		await proc.start();
		externalize.mockClear();
		const internals = proc as unknown as { handleLine(line: string): Promise<void> };

		await internals.handleLine(
			JSON.stringify({
				type: "response",
				id: "late-future-history",
				command: "get_messages",
				success: true,
				data: {
					messages: [
						{
							role: "bashExecution",
							command: "printf x",
							output: "x".repeat(MAX_JSONL_LINE_BYTES),
							exitCode: 0,
							cancelled: false,
							truncated: false,
							timestamp: 1,
						},
					],
				},
			}),
		);

		expect(externalize).not.toHaveBeenCalled();
	});

	it("rejects an allowlisted future frame above the 64 MiB hard ceiling before externalization", async () => {
		const externalize = vi.fn(futurePayloadExternalizer.externalize);
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
			payloadExternalizer: { ...futurePayloadExternalizer, externalize },
		});
		await proc.start();
		externalize.mockClear();
		const internals = proc as unknown as { handleLine(line: string): Promise<void> };

		await expect(
			internals.handleLine(
				JSON.stringify({
					type: "tool_execution_start",
					toolCallId: "tool-1",
					toolName: "tool",
					args: "x".repeat(MAX_JSONL_FUTURE_CONTENT_LINE_BYTES),
				}),
			),
		).rejects.toMatchObject({
			name: "PiProtocolIncompatibleError",
			diagnostic: { reason: "oversized_frame" },
		});
		expect(externalize).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "an interleaved event",
			line: () => JSON.stringify({ type: "agent_start", padding: "x".repeat(MAX_JSONL_LINE_BYTES) }),
		},
		{
			name: "an unrelated response",
			line: () =>
				JSON.stringify({
					type: "response",
					id: "ordinary",
					command: "get_state",
					success: true,
					data: { padding: "x".repeat(MAX_JSONL_LINE_BYTES) },
				}),
		},
		{
			name: "a dirty line",
			line: () => "x".repeat(MAX_JSONL_LINE_BYTES + 1),
		},
	])("rejects $name above the ordinary limit while get_messages is pending", async ({ line }) => {
		proc = new PiProcess({
			cwd: process.cwd(),
			resolved: { command: process.execPath, args: [fakePiPath], source: "pi-path", label: "fake Pi" },
		});
		const internals = proc as unknown as {
			pending: Map<
				string,
				{
					command: string;
					resolve: (value: unknown) => void;
					reject: (error: Error) => void;
					timer: NodeJS.Timeout;
				}
			>;
			handleLine: (line: string) => Promise<void>;
		};
		const timers = [setTimeout(() => {}, 60_000), setTimeout(() => {}, 60_000)];
		internals.pending.set("snapshot", {
			command: "get_messages",
			resolve: vi.fn(),
			reject: vi.fn(),
			timer: timers[0]!,
		});
		internals.pending.set("ordinary", {
			command: "get_state",
			resolve: vi.fn(),
			reject: vi.fn(),
			timer: timers[1]!,
		});

		try {
			await expect(internals.handleLine(line())).rejects.toEqual(
				expect.objectContaining({
					name: "PiProtocolIncompatibleError",
					diagnostic: expect.objectContaining({ frameKind: "frame", reason: "oversized_frame" }),
				}),
			);
		} finally {
			for (const timer of timers) clearTimeout(timer);
		}
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

		await expect(proc.send({ type: "get_messages" }, 1_000)).rejects.toMatchObject({
			name: "PiProtocolIncompatibleError",
			diagnostic: { reason: "oversized_frame" },
		});
		await waitFor(() => failures.length === 1);
		expect(proc.running).toBe(false);
	});
});
