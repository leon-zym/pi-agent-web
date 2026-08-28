import { spawn, spawnSync } from "node:child_process";
import type {
	ExtensionUiRequestDto,
	ExtensionUiResponseDto,
	FutureProductSessionEventDto,
	FutureSessionCommandResponseDto,
	FutureSessionContentRefGuardContext,
	ProductSessionEventDto,
	SessionAttachmentGuardContext,
	SessionAttachmentRefDto,
	SessionCommandDto,
	SessionCommandResponseDto,
	SessionCommandTypeDto,
} from "@pi-agent-web/protocol";
import type { EpochContentHold, EpochStoredContentRef } from "./epoch-content-store.js";
import type {
	Externalized,
	PiPayloadExternalizerInput,
	PiPayloadLease,
	PiPayloadLeaseTransfer,
} from "./pi-payload-externalizer.js";

const MAX_VERSION_LENGTH = 64;
const EXACT_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export type PiCapability =
	| "session.create"
	| "session.open"
	| "session.fork"
	| "session.clone"
	| "rpc.commands"
	| "rpc.events"
	| "rpc.extension_ui"
	| "rpc.toolcall_identity";

export interface PiVersionProbeTarget {
	command: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	maxOutputBytes: number;
}

export type PiHostProbeFailureKind =
	| "spawn_failed"
	| "timeout"
	| "nonzero_exit"
	| "output_invalid"
	| "output_oversized";

export class PiHostProbeError extends Error {
	readonly kind: PiHostProbeFailureKind;

	constructor(kind: PiHostProbeFailureKind, options?: ErrorOptions) {
		super(`Pi Host probe failed: ${kind}`, options);
		this.name = "PiHostProbeError";
		this.kind = kind;
	}
}

export interface PiRuntimeDiagnostic {
	code: "protocol_incompatible";
	adapterId: string;
	frameKind: "response" | "event" | "extension_ui_request" | "frame";
	reason:
		| "malformed_response"
		| "response_command_mismatch"
		| "malformed_event"
		| "unknown_authoritative_event"
		| "malformed_extension_ui_request"
		| "malformed_frame"
		| "oversized_frame";
	frameType?: string;
}

export class PiProtocolIncompatibleError extends Error {
	readonly diagnostic: PiRuntimeDiagnostic;

	constructor(diagnostic: PiRuntimeDiagnostic) {
		super(
			`Pi protocol incompatible (${diagnostic.adapterId}/${diagnostic.frameKind}/${diagnostic.reason})` +
				(diagnostic.frameType ? `: ${diagnostic.frameType}` : ""),
		);
		this.name = "PiProtocolIncompatibleError";
		this.diagnostic = diagnostic;
	}
}

export type PiHostUnsolicitedFrame<TEvent = ProductSessionEventDto> =
	| { kind: "event"; event: TEvent }
	| { kind: "extension_ui_request"; request: ExtensionUiRequestDto }
	| { kind: "ignored"; frameType: string };

export type PiHostFutureUnsolicitedFrame = PiHostUnsolicitedFrame<FutureProductSessionEventDto>;

export type PiHostPayloadLease = PiPayloadLease<EpochStoredContentRef>;
export type PiHostPayloadLeaseTransfer = PiPayloadLeaseTransfer<EpochStoredContentRef>;

/** Safely widen a namespace-specific lease without casting its holds or refs. */
export function adaptPiPayloadLease<TRef extends EpochStoredContentRef>(
	lease: PiPayloadLease<TRef>,
): PiHostPayloadLease {
	const adaptTransfer = (transfer: PiPayloadLeaseTransfer<TRef>): PiHostPayloadLeaseTransfer =>
		Object.freeze({
			refs: transfer.refs,
			adopt(accept: (holds: readonly EpochContentHold<EpochStoredContentRef>[]) => true) {
				transfer.adopt((holds) => accept(holds));
			},
			release: () => transfer.release(),
		});
	return Object.freeze({
		refs: lease.refs,
		transfer: () => adaptTransfer(lease.transfer()),
		release: () => lease.release(),
	});
}

export interface PiHostDecodeOutcome<T, TRef extends EpochStoredContentRef = SessionAttachmentRefDto> {
	readonly value: T;
	readonly lease: PiPayloadLease<TRef> | null;
}

export interface PiHostAttachmentPayloadExternalizer {
	/** Omission is the backwards-compatible current attachment mode. */
	readonly mode?: "attachment";
	readonly context: SessionAttachmentGuardContext;
	externalize(input: PiPayloadExternalizerInput, signal: AbortSignal): Promise<Externalized<unknown>>;
}

export interface PiHostFuturePayloadExternalizer {
	readonly mode: "future_content";
	readonly context: FutureSessionContentRefGuardContext;
	externalize(
		input: PiPayloadExternalizerInput,
		signal: AbortSignal,
	): Promise<Externalized<unknown, EpochStoredContentRef>>;
}

export type PiHostPayloadExternalizer = PiHostAttachmentPayloadExternalizer | PiHostFuturePayloadExternalizer;

/** Adapter normalization may be synchronous today or asynchronously externalize bounded payloads. */
export type PiHostDecodeResult<T, TRef extends EpochStoredContentRef = SessionAttachmentRefDto> =
	| PiHostDecodeOutcome<T, TRef>
	| PromiseLike<PiHostDecodeOutcome<T, TRef>>;

/** Spawn-scoped cancellation passed to asynchronous normalization/externalization work. */
export interface PiHostDecodeContext {
	readonly signal: AbortSignal;
	/** Server-private and disabled unless the complete downstream ownership path is installed. */
	readonly externalizer?: PiHostAttachmentPayloadExternalizer;
}

export interface PiHostFutureDecodeContext {
	readonly signal: AbortSignal;
	readonly externalizer: PiHostFuturePayloadExternalizer;
}

export interface PiHostFutureOrphanDecodeContext {
	readonly signal: AbortSignal;
	readonly externalizer?: never;
}

export type PiHostResponseExternalizationFailure =
	| "blob_too_large"
	| "cache_bytes_exhausted"
	| "cache_items_exhausted"
	| "deadline";

/** A valid raw response that the Gateway could not make locally deliverable. */
export class PiHostResponseExternalizationError extends Error {
	constructor(
		readonly command: SessionCommandTypeDto,
		readonly failure: PiHostResponseExternalizationFailure,
		options?: ErrorOptions,
	) {
		super(`Gateway failed to deliver the Pi ${command} response`, options);
		this.name = "PiHostResponseExternalizationError";
	}
}

/** Product-facing boundary for one concrete Pi host protocol implementation. */
export interface PiHostAdapter {
	readonly id: string;
	readonly version: string;
	readonly capabilities: readonly PiCapability[];
	probeVersion(target: PiVersionProbeTarget): Promise<string>;
	createSessionArguments(target: { nativeSessionId: string; sessionDir: string }): string[];
	openSessionArguments(target: { sessionFile: string; sessionDir: string }): string[];
	encodeCommand(command: SessionCommandDto & { id: string }): unknown;
	encodeExtensionUiResponse(response: ExtensionUiResponseDto): unknown;
	decodeResponse(
		value: unknown,
		expectedCommand: SessionCommandTypeDto,
		context?: PiHostDecodeContext,
	): PiHostDecodeResult<
		SessionCommandResponseDto & {
			id: string;
		}
	>;
	decodeFutureResponse(
		value: unknown,
		expectedCommand: SessionCommandTypeDto,
		context: PiHostFutureDecodeContext,
	): PiHostDecodeResult<
		FutureSessionCommandResponseDto & {
			id: string;
		},
		EpochStoredContentRef
	>;
	/** Validate a late/unknown-id response before explicitly ignoring it. */
	decodeOrphanedResponse(value: unknown, context?: PiHostDecodeContext): PiHostDecodeResult<void>;
	/** Future raw validation for an ownerless response; externalization is intentionally unavailable. */
	decodeFutureOrphanedResponse(
		value: unknown,
		context?: PiHostFutureOrphanDecodeContext,
	): PiHostDecodeResult<void>;
	decodeFutureUnsolicited(
		value: unknown,
		context: PiHostFutureDecodeContext,
	): PiHostDecodeResult<PiHostFutureUnsolicitedFrame, EpochStoredContentRef>;
	decodeUnsolicited(
		value: unknown,
		context?: PiHostDecodeContext,
	): PiHostDecodeResult<PiHostUnsolicitedFrame>;
}

/** Execute an adapter-owned, bounded version probe and clean its whole process group. */
export function probeExactPiVersion(target: PiVersionProbeTarget): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stdout = Buffer.alloc(0);
		let outputBytes = 0;
		const detached = process.platform !== "win32";
		let child: ReturnType<typeof spawn> | undefined;
		let timer: NodeJS.Timeout | undefined;
		const processExists = (pid: number): boolean => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "EPERM";
			}
		};
		const processGroupExists = (groupId: number): boolean => {
			try {
				process.kill(-groupId, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "EPERM";
			}
		};

		const killGroup = (): void => {
			if (!child) return;
			try {
				if (process.platform === "win32" && child.pid) {
					if (child.exitCode !== null || child.signalCode !== null) return;
					spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
						stdio: "ignore",
						timeout: 2_000,
						windowsHide: true,
					});
				} else if (detached && child.pid) {
					if (!processGroupExists(child.pid)) return;
					// After leader exit, a live positive PID means the OS reused the
					// saved PGID. Never signal that unrelated process group.
					if ((child.exitCode !== null || child.signalCode !== null) && processExists(child.pid)) return;
					process.kill(-child.pid, "SIGKILL");
				} else child.kill("SIGKILL");
			} catch {
				// The group may already have exited.
			}
		};

		const finish = (error?: PiHostProbeError, version?: string, terminate = false): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (terminate) killGroup();
			child?.stdout?.destroy();
			child?.stderr?.destroy();
			if (error) reject(error);
			else resolve(version ?? "");
		};
		const fail = (kind: PiHostProbeFailureKind, cause?: unknown): void => {
			finish(new PiHostProbeError(kind, cause === undefined ? undefined : { cause }), undefined, true);
		};

		try {
			child = spawn(target.command, [...target.args], {
				detached,
				env: target.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			reject(new PiHostProbeError("spawn_failed", { cause: error }));
			return;
		}

		timer = setTimeout(() => fail("timeout"), target.timeoutMs);
		timer.unref?.();
		const capture = (chunk: Buffer, keep: boolean): void => {
			if (settled) return;
			outputBytes += chunk.byteLength;
			if (outputBytes > target.maxOutputBytes) {
				fail("output_oversized");
				return;
			}
			if (keep) stdout = Buffer.concat([stdout, chunk]);
		};
		child.stdout?.on("data", (chunk: Buffer) => capture(chunk, true));
		child.stderr?.on("data", (chunk: Buffer) => capture(chunk, false));
		child.once("error", (error) => finish(new PiHostProbeError("spawn_failed", { cause: error })));
		child.once("close", (code) => {
			if (settled) return;
			if (code !== 0) {
				finish(new PiHostProbeError("nonzero_exit"));
				return;
			}
			const raw = stdout.toString("utf8");
			const version = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
			if (version.length === 0 || version.length > MAX_VERSION_LENGTH || !EXACT_SEMVER.test(version)) {
				finish(new PiHostProbeError("output_invalid"));
				return;
			}
			finish(undefined, version);
		});
	});
}
