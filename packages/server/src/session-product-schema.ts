import type {
	ExtensionUiRequestDto,
	ProductSessionEventDto,
	SessionContentRefGuardContext,
	SessionMessageDto,
	SessionSnapshotDto,
} from "@pi-agent-web/protocol";
import {
	analyzeExtensionUiRequestLogicalBytes,
	analyzeProductSessionEventLogicalBytes,
	analyzeSessionSnapshotLogicalBytes,
	isExtensionUiRequestDto,
	isProductSessionEventDto,
	isSessionContentRefGuardContext,
	isSessionMessageDto,
	isSessionSnapshotDto,
	SESSION_NORMALIZED_EVENT_MAX_BYTES,
	SESSION_PI_JSONL_MAX_BYTES,
	SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
	SESSION_REPLAY_FRAME_MAX_BYTES,
	SESSION_SNAPSHOT_MAX_BYTES,
	SessionLogicalBytesError,
} from "@pi-agent-web/protocol";

const CONTEXT_KEYS = ["serverEpoch", "payloadBudget", "contentRefBudget"];

export interface SessionProjectionProductSchema<
	TMessage = SessionMessageDto,
	TEvent = ProductSessionEventDto,
	TExtensionRequest = ExtensionUiRequestDto,
> {
	readonly mode: "content_ref";
	readonly serverEpoch: string | undefined;
	readonly maxNormalizedEventWireBytes: number;
	readonly maxReplayFrameWireBytes: number;
	readonly maxProjectionSuffixWireBytes: number;
	readonly maxSnapshotCanonicalWireBytes: number;
	readonly maxActiveTurnLogicalBytes: number;
	readonly maxSnapshotLogicalBytes: number;
	guardMessage(value: unknown): value is TMessage;
	guardEvent(value: unknown): value is TEvent;
	guardExtensionRequest(value: unknown): value is TExtensionRequest;
	mergeCompatibleDelta(previous: TEvent, next: TEvent): TEvent | null;
	queueUpdate(
		event: TEvent,
	): { readonly steering: readonly string[]; readonly followUp: readonly string[] } | null;
	/** Count a value that already passed guardEvent without materializing an encoded copy. */
	activeTurnEventLogicalBytes(event: TEvent): number;
	/** Count a value that already passed guardExtensionRequest without materializing an encoded copy. */
	extensionRequestLogicalBytes(request: TExtensionRequest): number;
}

export interface SessionProductSchema<
	TMessage = SessionMessageDto,
	TEvent = ProductSessionEventDto,
	TSnapshot = SessionSnapshotDto,
	TExtensionRequest = ExtensionUiRequestDto,
> extends SessionProjectionProductSchema<TMessage, TEvent, TExtensionRequest> {
	guardSnapshot(value: unknown): value is TSnapshot;
	/** Count a value that already passed guardSnapshot without materializing an encoded copy. */
	snapshotLogicalBytes(snapshot: TSnapshot): number;
}

export type SessionProductSchemaLogicalErrorCode = "invalid_limit" | "invalid_value" | "limit_exceeded";

export class SessionProductSchemaLogicalError extends Error {
	constructor(
		readonly code: SessionProductSchemaLogicalErrorCode,
		message: string,
		readonly limit?: number,
		readonly actual?: number,
	) {
		super(message);
		this.name = "SessionProductSchemaLogicalError";
	}
}

export function createSessionProductSchema(context: SessionContentRefGuardContext): SessionProductSchema {
	const exactContext = snapshotContext(context);
	const schema: SessionProductSchema = {
		mode: "content_ref",
		serverEpoch: exactContext.serverEpoch,
		maxNormalizedEventWireBytes: SESSION_NORMALIZED_EVENT_MAX_BYTES,
		maxReplayFrameWireBytes: SESSION_REPLAY_FRAME_MAX_BYTES,
		maxProjectionSuffixWireBytes: SESSION_PI_JSONL_MAX_BYTES,
		maxSnapshotCanonicalWireBytes: SESSION_SNAPSHOT_MAX_BYTES,
		maxActiveTurnLogicalBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
		maxSnapshotLogicalBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
		guardMessage: (value: unknown): value is SessionMessageDto => isSessionMessageDto(value, exactContext),
		guardEvent: (value: unknown): value is ProductSessionEventDto =>
			isProductSessionEventDto(value, exactContext),
		guardExtensionRequest: (value: unknown): value is ExtensionUiRequestDto =>
			isExtensionUiRequestDto(value, exactContext),
		guardSnapshot: (value: unknown): value is SessionSnapshotDto => isSessionSnapshotDto(value, exactContext),
		mergeCompatibleDelta: (previous: ProductSessionEventDto, next: ProductSessionEventDto) =>
			mergeCompatibleDelta(previous, next, exactContext),
		queueUpdate,
		activeTurnEventLogicalBytes: (event: ProductSessionEventDto) =>
			logicalBytes(() =>
				analyzeProductSessionEventLogicalBytes(event, {
					maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
				}),
			),
		extensionRequestLogicalBytes: (request: ExtensionUiRequestDto) =>
			logicalBytes(() =>
				analyzeExtensionUiRequestLogicalBytes(request, {
					maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
				}),
			),
		snapshotLogicalBytes: (snapshot: SessionSnapshotDto) =>
			logicalBytes(() =>
				analyzeSessionSnapshotLogicalBytes(snapshot, {
					maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
				}),
			),
	};
	return Object.freeze(schema);
}

function snapshotContext(context: SessionContentRefGuardContext): SessionContentRefGuardContext {
	if (!hasExactOwnKeys(context, CONTEXT_KEYS)) {
		throw new TypeError("Session product schema context is invalid");
	}
	const copy = {
		serverEpoch: context.serverEpoch,
		payloadBudget: { ...context.payloadBudget },
		contentRefBudget: { ...context.contentRefBudget },
	};
	if (!isSessionContentRefGuardContext(copy)) {
		throw new TypeError("Session product schema context is invalid");
	}
	return Object.freeze({
		...copy,
		payloadBudget: Object.freeze(copy.payloadBudget),
		contentRefBudget: Object.freeze(copy.contentRefBudget),
	});
}

function hasExactOwnKeys(value: unknown, expected: readonly string[]): value is object {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function logicalBytes(analyze: () => { byteLength: number }): number {
	try {
		return analyze().byteLength;
	} catch (error) {
		if (error instanceof SessionLogicalBytesError) {
			throw new SessionProductSchemaLogicalError(error.code, error.message, error.limit, error.actual);
		}
		throw error;
	}
}

type MessageUpdate = Extract<ProductSessionEventDto, { type: "message_update" }>;
type Delta = Extract<
	MessageUpdate["assistantMessageEvent"],
	{ type: "text_delta" | "thinking_delta" | "toolcall_delta" }
>;

function isDelta(value: MessageUpdate["assistantMessageEvent"]): value is Delta {
	return value.type === "text_delta" || value.type === "thinking_delta" || value.type === "toolcall_delta";
}

function mergeCompatibleDelta(
	previous: ProductSessionEventDto,
	next: ProductSessionEventDto,
	context: SessionContentRefGuardContext,
): ProductSessionEventDto | null {
	if (previous.type !== "message_update" || next.type !== "message_update") return null;
	const previousDelta = previous.assistantMessageEvent;
	const nextDelta = next.assistantMessageEvent;
	if (
		!isDelta(previousDelta) ||
		!isDelta(nextDelta) ||
		previousDelta.type !== nextDelta.type ||
		previousDelta.contentIndex !== nextDelta.contentIndex
	) {
		return null;
	}
	const merged = {
		...next,
		assistantMessageEvent: { ...nextDelta, delta: previousDelta.delta + nextDelta.delta },
	};
	return isProductSessionEventDto(merged, context) ? merged : null;
}

function queueUpdate(
	event: ProductSessionEventDto,
): { readonly steering: readonly string[]; readonly followUp: readonly string[] } | null {
	return event.type === "queue_update" ? { steering: event.steering, followUp: event.followUp } : null;
}
