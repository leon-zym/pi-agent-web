import type { SessionImageContentDto, SessionProjectionEventDto } from "@pi-agent-web/protocol";
import { create } from "zustand";
import { type ConversationProjection, createEmptyProjection } from "../types/view-models";
import { useComposerStore } from "./composer";
import { convergeHangingToolCalls, reduceProjection } from "./projection-reducer";
import { sessionTransport } from "./session-transport";

const MAX_CACHED_SESSIONS = 3;

interface ProjectionState {
	projections: Record<string, ConversationProjection>;
	order: string[];
	currentSessionId: string | null;
	/** Apply one session event through the assembler state machine. */
	applyEvent: (sessionId: string, event: Parameters<typeof reduceProjection>[1]) => void;
	/** Reduce an ordered event batch and publish one Zustand commit. */
	applyEvents: (sessionId: string, events: Parameters<typeof reduceProjection>[1][]) => void;
	/** Rebuild the projection from a get_messages snapshot (reconnect/first load). */
	rebuildFromMessages: (sessionId: string, messages: unknown[]) => void;
	/** Atomically build and publish one authoritative snapshot projection. */
	applyAuthoritativeSnapshot: (
		sessionId: string,
		settledMessages: unknown[],
		projectionEvents: SessionProjectionEventDto["event"][],
	) => void;
	/** Settle a locally active turn when the owning Pi process is lost. */
	markRuntimeFailure: (sessionId: string, error?: string) => void;
	/** Drop a session projection (switch away, eviction). */
	resetSession: (sessionId: string) => void;
	setCurrentSession: (sessionId: string | null) => void;
}

function prune(state: ProjectionState): ProjectionState {
	const projections = { ...state.projections };
	const order = [...state.order];
	while (order.length > MAX_CACHED_SESSIONS) {
		const index = order.findLastIndex((sessionId) => {
			const projection = projections[sessionId];
			const subscribed = sessionTransport.store.getState().sessions[sessionId]?.subscribed === true;
			return !subscribed && sessionId !== state.currentSessionId && projection?.activeTurnId === null;
		});
		if (index === -1) break;
		const [sessionId] = order.splice(index, 1);
		if (sessionId) delete projections[sessionId];
	}
	return { ...state, projections, order };
}

function touch(order: string[], sessionId: string): string[] {
	return [sessionId, ...order.filter((id) => id !== sessionId)];
}

export const useProjectionStore = create<ProjectionState>()((set, get) => ({
	projections: {},
	order: [],
	currentSessionId: null,

	applyEvent: (sessionId, event) => get().applyEvents(sessionId, [event]),

	applyEvents: (sessionId, events) => {
		if (events.length === 0) return;
		const state = get();
		let next = state.projections[sessionId] ?? createEmptyProjection(sessionId);
		for (const event of events) {
			next = reduceProjection(next, event, {
				now: Date.now(),
				resolveInjectionSource: (text) =>
					useComposerStore.getState().consumeInjectionSourceForSession(sessionId, text),
			});
		}
		const order = touch(state.order, sessionId);
		set(prune({ ...state, projections: { ...state.projections, [sessionId]: next }, order }));
	},

	rebuildFromMessages: (sessionId, messages) => {
		const state = get();
		// A snapshot is applied only while the Session transport holds later
		// frames behind a resync barrier, so it is authoritative even if the
		// previous local projection appeared to be streaming.
		const next = rebuildProjectionFromMessages(sessionId, messages);
		const order = touch(state.order, sessionId);
		set(prune({ ...state, projections: { ...state.projections, [sessionId]: next }, order }));
	},

	applyAuthoritativeSnapshot: (sessionId, settledMessages, projectionEvents) => {
		const state = get();
		let next = rebuildProjectionFromMessages(sessionId, settledMessages);
		for (const event of projectionEvents) {
			if (event.type === "extension_error") continue;
			next = reduceProjection(next, event, {
				now: Date.now(),
				resolveInjectionSource: (text) =>
					useComposerStore.getState().consumeInjectionSourceForSession(sessionId, text),
			});
		}
		const order = touch(state.order, sessionId);
		set(prune({ ...state, projections: { ...state.projections, [sessionId]: next }, order }));
	},

	markRuntimeFailure: (sessionId, error) => {
		const state = get();
		const projection = state.projections[sessionId];
		if (!projection?.activeTurnId) return;
		const now = Date.now();
		set({
			projections: {
				...state.projections,
				[sessionId]: {
					...projection,
					activeTurnId: null,
					replayable: true,
					turns: projection.turns.map((turn) =>
						turn.id === projection.activeTurnId
							? (() => {
									const startTime = turn.timing?.startTime ?? now;
									const failedTurn = {
										...turn,
										status: "error" as const,
										errorMessage: error,
										timing: {
											...turn.timing,
											startTime,
											endTime: now,
											durationMs: Math.max(0, now - startTime),
										},
									};
									return convergeHangingToolCalls(failedTurn);
								})()
							: turn,
					),
				},
			},
		});
	},

	resetSession: (sessionId) => {
		const state = get();
		const projections = { ...state.projections };
		delete projections[sessionId];
		set({ ...state, projections, order: state.order.filter((id) => id !== sessionId) });
	},

	setCurrentSession: (sessionId) => {
		const state = get();
		set(
			prune({
				...state,
				currentSessionId: sessionId,
				order: sessionId ? touch(state.order, sessionId) : state.order,
			}),
		);
	},
}));

/** Selector: the active (running) turn id of the current session, or null. */
export function selectActiveTurnId(state: ProjectionState): string | null {
	if (!state.currentSessionId) return null;
	const projection = state.projections[state.currentSessionId];
	return projection?.activeTurnId ?? null;
}

/**
 * Segment the active-branch message array back into product turns.
 * A user message opens a turn; assistant messages add steps; tool results
 * attach to the last step. Timing is unknown after replay, so it stays empty.
 */
export function rebuildProjectionFromMessages(
	sessionId: string,
	messages: unknown[],
): ConversationProjection {
	type LiteBlock = {
		type?: string;
		text?: string;
		thinking?: string;
		redacted?: boolean;
		id?: string;
		name?: string;
		arguments?: unknown;
		data?: SessionImageContentDto["data"];
		mimeType?: string;
	};
	type LiteMessage = {
		role?: string;
		content: string | LiteBlock[];
		timestamp?: number;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
		stopReason?: string;
		errorMessage?: string;
		usage?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			cost: { total: number };
		};
	};

	const projection = createEmptyProjection(sessionId);
	for (const raw of messages) {
		const message = raw as LiteMessage;
		if (message.role === "user") {
			const id = `turn-${String(projection.turnSeq + 1)}`;
			const blocks = Array.isArray(message.content) ? (message.content as LiteBlock[]) : [];
			const content =
				typeof message.content === "string"
					? message.content
					: blocks
							.filter((b) => b.type === "text")
							.map((b) => b.text ?? "")
							.join("\n");
			const images = blocks
				.filter(
					(b) =>
						b.type === "image" &&
						(typeof b.data === "string" || (b.data !== null && typeof b.data === "object")) &&
						typeof b.mimeType === "string",
				)
				.map((b) => ({
					type: "image" as const,
					data: b.data as SessionImageContentDto["data"],
					mimeType: b.mimeType as string,
				}));
			projection.turns.push({
				id,
				userMessages: [
					{
						entryKey: `${id}:u0`,
						text: content,
						images: images.length > 0 ? images : undefined,
						source: "prompt",
						delivered: true,
					},
				],
				steps: [],
				status: "settled",
				timing: { startTime: message.timestamp ?? 0, endTime: message.timestamp ?? 0 },
			});
			projection.turnSeq += 1;
			continue;
		}

		const turn = projection.turns[projection.turns.length - 1];
		if (!turn) continue;

		if (message.role === "assistant") {
			const stepKey = `${turn.id}:${String(turn.steps.length)}`;
			const blocks = (Array.isArray(message.content) ? (message.content as LiteBlock[]) : []).map(
				(block, index) => {
					const key = `${stepKey}:${String(index)}`;
					if (block.type === "thinking") {
						return {
							type: "thinking" as const,
							key,
							text: block.thinking ?? "",
							isStreaming: false,
							redacted: block.redacted,
						};
					}
					if (block.type === "toolCall") {
						return {
							type: "tool_call" as const,
							key,
							toolCallId: block.id ?? "",
							toolName: block.name ?? "",
							argsText: JSON.stringify(block.arguments ?? {}),
							args: block.arguments,
							status: "preparing" as const,
						};
					}
					return { type: "text" as const, key, markdown: block.text ?? "", isStreaming: false };
				},
			);
			turn.steps.push({
				key: stepKey,
				blocks,
				toolResults: [],
				isSettled: true,
				usage: message.usage
					? {
							input: message.usage.input,
							output: message.usage.output,
							cacheRead: message.usage.cacheRead,
							cacheWrite: message.usage.cacheWrite,
							totalTokens: message.usage.totalTokens,
							cost: message.usage.cost.total,
						}
					: undefined,
			});
			if (message.stopReason === "error") {
				turn.status = "error";
				turn.errorMessage = message.errorMessage;
			} else if (message.stopReason === "aborted") {
				turn.status = "aborted";
			}
			continue;
		}

		if (message.role === "toolResult") {
			const step = turn.steps[turn.steps.length - 1];
			if (!step) continue;
			const blocks = Array.isArray(message.content) ? (message.content as LiteBlock[]) : [];
			const content =
				typeof message.content === "string"
					? message.content
					: blocks
							.filter((b) => b.type === "text")
							.map((b) => b.text ?? "")
							.join("\n");
			const result = {
				toolCallId: message.toolCallId ?? "",
				toolName: message.toolName ?? "",
				content,
				isError: message.isError ?? false,
				details: message.details,
			};
			applyToolResult(step, result);
		}
	}

	// Post-processing pass: converge all tool call statuses against recorded tool results
	for (const turn of projection.turns) {
		for (const step of turn.steps) {
			for (let i = 0; i < step.blocks.length; i++) {
				const block = step.blocks[i];
				if (block?.type === "tool_call") {
					const result = step.toolResults.find((r) => r.toolCallId === block.toolCallId);
					if (!result) {
						step.blocks[i] = { ...block, status: "interrupted" };
					} else {
						step.blocks[i] = { ...block, status: result.isError ? "error" : "done" };
					}
				}
			}
		}
	}

	return projection;
}

function applyToolResult(
	step: ConversationProjection["turns"][number]["steps"][number],
	result: ConversationProjection["turns"][number]["steps"][number]["toolResults"][number],
): void {
	const existing = step.toolResults.findIndex((entry) => entry.toolCallId === result.toolCallId);
	if (existing === -1) step.toolResults.push(result);
	else {
		const previous = step.toolResults[existing];
		if (previous) {
			step.toolResults[existing] = {
				...result,
				isError: previous.isError || result.isError,
			};
		}
	}
	if (!result.isError) return;
	const block = step.blocks.find(
		(entry): entry is Extract<(typeof step.blocks)[number], { type: "tool_call" }> =>
			entry.type === "tool_call" && entry.toolCallId === result.toolCallId,
	);
	if (block) block.status = "error";
}
