import { create } from "zustand";
import { type ConversationProjection, createEmptyProjection } from "../types/view-models";
import { useComposerStore } from "./composer";
import { reduceProjection } from "./projection-reducer";

const MAX_CACHED_SESSIONS = 3;

interface ProjectionState {
	projections: Record<string, ConversationProjection>;
	order: string[];
	currentSessionId: string | null;
	/** Apply one session event through the assembler state machine. */
	applyEvent: (sessionId: string, event: Parameters<typeof reduceProjection>[1]) => void;
	/** Rebuild the projection from a get_messages snapshot (reconnect/first load). */
	rebuildFromMessages: (sessionId: string, messages: unknown[]) => void;
	/** Drop a session projection (switch away, eviction). */
	resetSession: (sessionId: string) => void;
	setCurrentSession: (sessionId: string | null) => void;
}

function prune(state: ProjectionState): ProjectionState {
	if (state.order.length <= MAX_CACHED_SESSIONS) return state;
	const drop = state.order.slice(MAX_CACHED_SESSIONS);
	const projections = { ...state.projections };
	for (const sessionId of drop) delete projections[sessionId];
	return { ...state, projections, order: state.order.slice(0, MAX_CACHED_SESSIONS) };
}

export const useProjectionStore = create<ProjectionState>()((set, get) => ({
	projections: {},
	order: [],
	currentSessionId: null,

	applyEvent: (sessionId, event) => {
		const state = get();
		const existing = state.projections[sessionId] ?? createEmptyProjection(sessionId);
		const next = reduceProjection(existing, event, {
			now: Date.now(),
			resolveInjectionSource: (text) => useComposerStore.getState().consumeInjectionSource(text),
		});
		const order = state.order.includes(sessionId) ? state.order : [...state.order, sessionId];
		set(prune({ ...state, projections: { ...state.projections, [sessionId]: next }, order }));
	},

	rebuildFromMessages: (sessionId, messages) => {
		const state = get();
		const projection = state.projections[sessionId];
		// Snapshot must never clobber a running turn.
		if (projection && !projection.replayable) return;
		const next = rebuildProjectionFromMessages(sessionId, messages);
		const order = state.order.includes(sessionId) ? state.order : [...state.order, sessionId];
		set(prune({ ...state, projections: { ...state.projections, [sessionId]: next }, order }));
	},

	resetSession: (sessionId) => {
		const state = get();
		const projections = { ...state.projections };
		delete projections[sessionId];
		set({ ...state, projections, order: state.order.filter((id) => id !== sessionId) });
	},

	setCurrentSession: (sessionId) => set({ currentSessionId: sessionId }),
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
		data?: string;
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
				.filter((b) => b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string")
				.map((b) => ({ type: "image" as const, data: b.data as string, mimeType: b.mimeType as string }));
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
							status: "done" as const,
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
			step.toolResults.push({
				toolCallId: message.toolCallId ?? "",
				toolName: message.toolName ?? "",
				content,
				isError: message.isError ?? false,
				details: message.details,
			});
		}
	}
	return projection;
}
