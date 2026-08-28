import type {
	ExtensionUiRequestDto,
	FutureExtensionUiRequestDto,
	FutureProductSessionEventDto,
	FutureSessionContentRefGuardContext,
	FutureSessionMessageDto,
	FutureSessionSnapshotDto,
	ProductSessionEventDto,
	SessionAttachmentGuardContext,
	SessionMessageDto,
	SessionSnapshotDto,
} from "@pi-agent-web/protocol";
import {
	analyzeFutureExtensionUiRequestLogicalBytes,
	analyzeFutureProductSessionEventLogicalBytes,
	analyzeFutureSessionSnapshotLogicalBytes,
	FutureSessionLogicalBytesError,
	isExtensionUiRequestDto,
	isFutureExtensionUiRequestDto,
	isFutureProductSessionEventDto,
	isFutureSessionContentRefGuardContext,
	isFutureSessionMessageDto,
	isFutureSessionSnapshotDto,
	isProductSessionEventDto,
	isSessionAttachmentGuardContext,
	isSessionMessageDto,
	isSessionSnapshotDto,
	SESSION_NORMALIZED_EVENT_MAX_BYTES,
	SESSION_PI_JSONL_MAX_BYTES,
	SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
	SESSION_REPLAY_FRAME_MAX_BYTES,
	SESSION_SNAPSHOT_MAX_BYTES,
} from "@pi-agent-web/protocol";

const CURRENT_CONTEXT_KEYS = ["serverEpoch", "payloadBudget"];
const FUTURE_CONTEXT_KEYS = ["serverEpoch", "payloadBudget", "contentRefBudget"];

export interface SessionProjectionProductSchema<
	TMessage = SessionMessageDto,
	TEvent = ProductSessionEventDto,
	TExtensionRequest = ExtensionUiRequestDto,
> {
	readonly mode: "current" | "future_content";
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

export function createCurrentSessionProductSchema(
	context?: SessionAttachmentGuardContext,
): SessionProductSchema {
	const exactContext = context === undefined ? undefined : snapshotAttachmentContext(context);
	const schema: SessionProductSchema = {
		mode: "current",
		serverEpoch: exactContext?.serverEpoch,
		maxNormalizedEventWireBytes: SESSION_NORMALIZED_EVENT_MAX_BYTES,
		maxReplayFrameWireBytes: SESSION_REPLAY_FRAME_MAX_BYTES,
		maxProjectionSuffixWireBytes: SESSION_PI_JSONL_MAX_BYTES,
		maxSnapshotCanonicalWireBytes: SESSION_SNAPSHOT_MAX_BYTES,
		maxActiveTurnLogicalBytes: Number.MAX_SAFE_INTEGER,
		maxSnapshotLogicalBytes: Number.MAX_SAFE_INTEGER,
		guardMessage: (value: unknown): value is SessionMessageDto => isSessionMessageDto(value, exactContext),
		guardEvent: (value: unknown): value is ProductSessionEventDto =>
			isProductSessionEventDto(value, exactContext),
		guardExtensionRequest: (value: unknown): value is ExtensionUiRequestDto => isExtensionUiRequestDto(value),
		guardSnapshot: (value: unknown): value is SessionSnapshotDto => isSessionSnapshotDto(value, exactContext),
		mergeCompatibleDelta: (previous: ProductSessionEventDto, next: ProductSessionEventDto) =>
			mergeCurrentCompatibleDelta(previous, next, exactContext),
		queueUpdate: currentQueueUpdate,
		activeTurnEventLogicalBytes: () => 0,
		extensionRequestLogicalBytes: () => 0,
		snapshotLogicalBytes: () => 0,
	};
	return Object.freeze(schema);
}

export function createFutureSessionProductSchema(
	context: FutureSessionContentRefGuardContext,
): SessionProductSchema<
	FutureSessionMessageDto,
	FutureProductSessionEventDto,
	FutureSessionSnapshotDto,
	FutureExtensionUiRequestDto
> {
	const exactContext = snapshotFutureContext(context);
	const schema: SessionProductSchema<
		FutureSessionMessageDto,
		FutureProductSessionEventDto,
		FutureSessionSnapshotDto,
		FutureExtensionUiRequestDto
	> = {
		mode: "future_content",
		serverEpoch: exactContext.serverEpoch,
		maxNormalizedEventWireBytes: SESSION_NORMALIZED_EVENT_MAX_BYTES,
		maxReplayFrameWireBytes: SESSION_REPLAY_FRAME_MAX_BYTES,
		maxProjectionSuffixWireBytes: SESSION_PI_JSONL_MAX_BYTES,
		maxSnapshotCanonicalWireBytes: SESSION_SNAPSHOT_MAX_BYTES,
		maxActiveTurnLogicalBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
		maxSnapshotLogicalBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
		guardMessage: (value: unknown): value is FutureSessionMessageDto =>
			isFutureSessionMessageDto(value, exactContext),
		guardEvent: (value: unknown): value is FutureProductSessionEventDto =>
			isFutureProductSessionEventDto(value, exactContext),
		guardExtensionRequest: (value: unknown): value is FutureExtensionUiRequestDto =>
			isFutureExtensionUiRequestDto(value, exactContext),
		guardSnapshot: (value: unknown): value is FutureSessionSnapshotDto =>
			isFutureSessionSnapshotDto(value, exactContext),
		mergeCompatibleDelta: (previous: FutureProductSessionEventDto, next: FutureProductSessionEventDto) =>
			mergeFutureCompatibleDelta(previous, next, exactContext),
		queueUpdate: futureQueueUpdate,
		activeTurnEventLogicalBytes: (event: FutureProductSessionEventDto) =>
			futureLogicalBytes(() =>
				analyzeFutureProductSessionEventLogicalBytes(event, {
					maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
				}),
			),
		extensionRequestLogicalBytes: (request: FutureExtensionUiRequestDto) =>
			futureLogicalBytes(() =>
				analyzeFutureExtensionUiRequestLogicalBytes(request, {
					maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
				}),
			),
		snapshotLogicalBytes: (snapshot: FutureSessionSnapshotDto) =>
			futureLogicalBytes(() =>
				analyzeFutureSessionSnapshotLogicalBytes(snapshot, {
					maxBytes: SESSION_PI_SNAPSHOT_JSONL_MAX_BYTES,
				}),
			),
	};
	return Object.freeze(schema);
}

function snapshotAttachmentContext(context: SessionAttachmentGuardContext): SessionAttachmentGuardContext {
	if (!hasExactOwnKeys(context, CURRENT_CONTEXT_KEYS)) {
		throw new TypeError("Current Session product schema context is invalid");
	}
	const copy = {
		serverEpoch: context.serverEpoch,
		payloadBudget: { ...context.payloadBudget },
	};
	if (!isSessionAttachmentGuardContext(copy)) {
		throw new TypeError("Current Session product schema context is invalid");
	}
	return Object.freeze({ ...copy, payloadBudget: Object.freeze(copy.payloadBudget) });
}

function snapshotFutureContext(
	context: FutureSessionContentRefGuardContext,
): FutureSessionContentRefGuardContext {
	if (!hasExactOwnKeys(context, FUTURE_CONTEXT_KEYS)) {
		throw new TypeError("Future Session product schema context is invalid");
	}
	const copy = {
		serverEpoch: context.serverEpoch,
		payloadBudget: { ...context.payloadBudget },
		contentRefBudget: { ...context.contentRefBudget },
	};
	if (!isFutureSessionContentRefGuardContext(copy)) {
		throw new TypeError("Future Session product schema context is invalid");
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

function futureLogicalBytes(analyze: () => { byteLength: number }): number {
	try {
		return analyze().byteLength;
	} catch (error) {
		if (error instanceof FutureSessionLogicalBytesError) {
			throw new SessionProductSchemaLogicalError(error.code, error.message, error.limit, error.actual);
		}
		throw error;
	}
}

type CurrentMessageUpdate = Extract<ProductSessionEventDto, { type: "message_update" }>;
type CurrentDelta = Extract<
	CurrentMessageUpdate["assistantMessageEvent"],
	{ type: "text_delta" | "thinking_delta" | "toolcall_delta" }
>;

function isCurrentDelta(value: CurrentMessageUpdate["assistantMessageEvent"]): value is CurrentDelta {
	return value.type === "text_delta" || value.type === "thinking_delta" || value.type === "toolcall_delta";
}

function mergeCurrentCompatibleDelta(
	previous: ProductSessionEventDto,
	next: ProductSessionEventDto,
	context?: SessionAttachmentGuardContext,
): ProductSessionEventDto | null {
	if (previous.type !== "message_update" || next.type !== "message_update") return null;
	const previousDelta = previous.assistantMessageEvent;
	const nextDelta = next.assistantMessageEvent;
	if (
		!isCurrentDelta(previousDelta) ||
		!isCurrentDelta(nextDelta) ||
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

type FutureMessageUpdate = Extract<FutureProductSessionEventDto, { type: "message_update" }>;
type FutureDelta = Extract<
	FutureMessageUpdate["assistantMessageEvent"],
	{ type: "text_delta" | "thinking_delta" | "toolcall_delta" }
>;

function isFutureDelta(value: FutureMessageUpdate["assistantMessageEvent"]): value is FutureDelta {
	return value.type === "text_delta" || value.type === "thinking_delta" || value.type === "toolcall_delta";
}

function mergeFutureCompatibleDelta(
	previous: FutureProductSessionEventDto,
	next: FutureProductSessionEventDto,
	context: FutureSessionContentRefGuardContext,
): FutureProductSessionEventDto | null {
	if (previous.type !== "message_update" || next.type !== "message_update") return null;
	const previousDelta = previous.assistantMessageEvent;
	const nextDelta = next.assistantMessageEvent;
	if (
		!isFutureDelta(previousDelta) ||
		!isFutureDelta(nextDelta) ||
		previousDelta.type !== nextDelta.type ||
		previousDelta.contentIndex !== nextDelta.contentIndex
	) {
		return null;
	}
	const merged = {
		...next,
		assistantMessageEvent: { ...nextDelta, delta: previousDelta.delta + nextDelta.delta },
	};
	return isFutureProductSessionEventDto(merged, context) ? merged : null;
}

function currentQueueUpdate(
	event: ProductSessionEventDto,
): { readonly steering: readonly string[]; readonly followUp: readonly string[] } | null {
	return event.type === "queue_update" ? { steering: event.steering, followUp: event.followUp } : null;
}

function futureQueueUpdate(
	event: FutureProductSessionEventDto,
): { readonly steering: readonly string[]; readonly followUp: readonly string[] } | null {
	return event.type === "queue_update" ? { steering: event.steering, followUp: event.followUp } : null;
}
