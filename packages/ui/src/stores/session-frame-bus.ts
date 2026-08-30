import type {
	InlineSessionWsServerMessage,
	PiSessionMessageDto,
	SessionRuntimeIdentityDto,
} from "@pi-agent-web/protocol";
import type { ProjectedSessionFrameMessage } from "../lib/session-content-adapter";

export type SessionFrameProductMode = "current" | "future";

export type CurrentSessionFrameBusMessage = Exclude<
	InlineSessionWsServerMessage,
	{ type: "response" } | { type: "session_directory_changed" } | { type: "auth_changed" }
>;

/** Product event emitted only after a complete older history page is assembled. */
export interface SessionHistoryPageLoadedFrame extends SessionRuntimeIdentityDto {
	type: "session_history_page_loaded";
	requestId: string;
	snapshotId: string;
	asOfSeq: number;
	messages: PiSessionMessageDto[];
}

export type SessionFrameBusMessage =
	| CurrentSessionFrameBusMessage
	| SessionHistoryPageLoadedFrame
	| ProjectedSessionFrameMessage;

interface OrderedSessionFrameEnvelope {
	order: number;
	receivedAt: number;
	sessionHandle: string;
}

export type OrderedSessionFrame = OrderedSessionFrameEnvelope &
	(
		| { productMode: "current"; message: CurrentSessionFrameBusMessage | SessionHistoryPageLoadedFrame }
		| { productMode: "future"; message: ProjectedSessionFrameMessage }
	);

/** A listener may retain a frame for bounded asynchronous projection work. */
export const SESSION_FRAME_DEFERRED = Symbol("session-frame-deferred");

export type SessionFrameListener = (frame: OrderedSessionFrame) => void | typeof SESSION_FRAME_DEFERRED;

export interface SessionFrameDeliveryResult {
	deferred: boolean;
	errors: unknown[];
}

/**
 * A synchronous, per-Session ordered bus. Consumers subscribe to identities,
 * not the currently selected view, so background Sessions keep ingesting.
 */
export class OrderedSessionFrameBus {
	private readonly listeners = new Map<string, Set<SessionFrameListener>>();
	private readonly allListeners = new Set<SessionFrameListener>();
	private readonly orderBySession = new Map<string, number>();

	subscribe(sessionHandle: string, listener: SessionFrameListener): () => void {
		const listeners = this.listeners.get(sessionHandle) ?? new Set<SessionFrameListener>();
		const registeredListener: SessionFrameListener = (frame) => listener(frame);
		listeners.add(registeredListener);
		this.listeners.set(sessionHandle, listeners);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			for (const [handle, registered] of this.listeners) {
				registered.delete(registeredListener);
				if (registered.size === 0) this.listeners.delete(handle);
			}
		};
	}

	subscribeAll(listener: SessionFrameListener): () => void {
		this.allListeners.add(listener);
		return () => this.allListeners.delete(listener);
	}

	emit(
		sessionHandle: string,
		message: CurrentSessionFrameBusMessage,
		receivedAt: number,
	): SessionFrameDeliveryResult;
	emit(
		sessionHandle: string,
		message: SessionHistoryPageLoadedFrame,
		receivedAt: number,
	): SessionFrameDeliveryResult;
	emit(
		sessionHandle: string,
		message: ProjectedSessionFrameMessage,
		receivedAt: number,
		productMode: "future",
	): SessionFrameDeliveryResult;
	emit(
		sessionHandle: string,
		...args:
			| [message: CurrentSessionFrameBusMessage, receivedAt: number]
			| [message: SessionHistoryPageLoadedFrame, receivedAt: number]
			| [message: ProjectedSessionFrameMessage, receivedAt: number, productMode: "future"]
	): SessionFrameDeliveryResult {
		const order = (this.orderBySession.get(sessionHandle) ?? 0) + 1;
		this.orderBySession.set(sessionHandle, order);
		const frame: OrderedSessionFrame =
			args.length === 2
				? {
						order,
						receivedAt: args[1],
						sessionHandle,
						productMode: "current",
						message: args[0] as CurrentSessionFrameBusMessage | SessionHistoryPageLoadedFrame,
					}
				: {
						order,
						receivedAt: args[1],
						sessionHandle,
						productMode: "future",
						message: args[0] as ProjectedSessionFrameMessage,
					};
		const result: SessionFrameDeliveryResult = { deferred: false, errors: [] };
		for (const listener of this.listeners.get(sessionHandle) ?? []) this.deliver(listener, frame, result);
		for (const listener of this.allListeners) this.deliver(listener, frame, result);
		return result;
	}

	/** Move both listeners and the monotonic order counter with a rekeyed identity. */
	rekey(previousSessionHandle: string, sessionHandle: string): void {
		if (previousSessionHandle === sessionHandle) return;
		const previous = this.listeners.get(previousSessionHandle);
		if (previous) {
			const next = this.listeners.get(sessionHandle) ?? new Set<SessionFrameListener>();
			for (const listener of previous) next.add(listener);
			this.listeners.set(sessionHandle, next);
			this.listeners.delete(previousSessionHandle);
		}
		const order = Math.max(
			this.orderBySession.get(previousSessionHandle) ?? 0,
			this.orderBySession.get(sessionHandle) ?? 0,
		);
		this.orderBySession.delete(previousSessionHandle);
		this.orderBySession.set(sessionHandle, order);
	}

	clear(): void {
		this.listeners.clear();
		this.allListeners.clear();
		this.orderBySession.clear();
	}

	private deliver(
		listener: SessionFrameListener,
		frame: OrderedSessionFrame,
		result: SessionFrameDeliveryResult,
	): void {
		try {
			if (listener(frame) === SESSION_FRAME_DEFERRED) result.deferred = true;
		} catch (error) {
			// Report the failure after every listener had a chance to ingest this frame.
			result.errors.push(error);
		}
	}
}

export type GlobalSessionTransportMessage = Extract<
	InlineSessionWsServerMessage,
	{ type: "session_directory_changed" } | { type: "auth_changed" } | { type: "hot_runtime_inventory" }
>;

export class SessionTransportGlobalBus {
	private readonly listeners = new Set<(message: GlobalSessionTransportMessage) => void>();

	subscribe(listener: (message: GlobalSessionTransportMessage) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(message: GlobalSessionTransportMessage): void {
		for (const listener of this.listeners) {
			try {
				listener(message);
			} catch {
				// One observer must not break transport ingestion.
			}
		}
	}

	clear(): void {
		this.listeners.clear();
	}
}
