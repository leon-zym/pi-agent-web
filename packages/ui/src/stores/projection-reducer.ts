import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { tt } from "../lib/i18n";
import { presentUserMessage, serializePresentedUserMessage } from "../lib/user-message-presentation";
import type {
	AssistantStep,
	ContentBlock,
	ConversationProjection,
	ProductTurn,
	StatusRow,
	UiUserMessageSource,
} from "../types/view-models";

/**
 * Pure stream assembler reducer.
 *
 * Invariants:
 * - Stable keys everywhere: steps are turnId:index, blocks are stepKey:contentIndex.
 * - message_update deltas append per contentIndex; message_end swaps authoritative
 *   final blocks but keeps the same React keys.
 * - Tool results render from message_start(role:"toolResult"); turn_end.toolResults
 *   is used only for settlement, never rendered (rule 4).
 * - agent_settled is the only event that settles a running turn (rule 5).
 * - stopReason "length" marks preparing tool calls as skipped (rule 2).
 * - stopReason "error"/"aborted" settle the turn into error/aborted and keep partials.
 */

export interface ReducerContext {
	now: number;
	/** Map recently queued texts to their delivery mode (steer vs follow_up). */
	resolveInjectionSource?: (text: string) => UiUserMessageSource | undefined;
}

// ---------------------------------------------------------------------------
// Structural helpers (the wire payloads are plain JSON; narrow at the boundary)
// ---------------------------------------------------------------------------

type ContentBlockLite = {
	type?: string;
	text?: string;
	thinking?: string;
	data?: string;
	mimeType?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	redacted?: boolean;
};

function flattenText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block) => typeof block === "object" && block !== null && (block as ContentBlockLite).type === "text",
		)
		.map((block) => (block as ContentBlockLite).text ?? "")
		.join("\n");
}

function extractImages(content: unknown): { type: "image"; data: string; mimeType: string }[] | undefined {
	if (!Array.isArray(content)) return undefined;
	const images = content
		.filter(
			(block) =>
				typeof block === "object" &&
				block !== null &&
				(block as ContentBlockLite).type === "image" &&
				typeof (block as ContentBlockLite).data === "string" &&
				typeof (block as ContentBlockLite).mimeType === "string",
		)
		.map((block) => ({
			type: "image" as const,
			data: (block as ContentBlockLite).data as string,
			mimeType: (block as ContentBlockLite).mimeType as string,
		}));
	return images.length > 0 ? images : undefined;
}

function flattenPartialResult(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.output === "string") return record.output;
		if (typeof record.partial === "string") return record.partial;
		if (typeof record.text === "string") return record.text;
		try {
			return JSON.stringify(value);
		} catch {
			return undefined;
		}
	}
	return String(value);
}

// ---------------------------------------------------------------------------
// Turn / step helpers
// ---------------------------------------------------------------------------

function activeTurn(state: ConversationProjection): ProductTurn | undefined {
	return state.activeTurnId ? state.turns.find((t) => t.id === state.activeTurnId) : undefined;
}

function withTurn(state: ConversationProjection, turn: ProductTurn): ConversationProjection {
	return { ...state, turns: state.turns.map((t) => (t.id === turn.id ? turn : t)) };
}

function withLastStep(turn: ProductTurn, step: AssistantStep): ProductTurn {
	const steps = turn.steps.slice();
	steps[steps.length - 1] = step;
	return { ...turn, steps };
}

function ensureTurn(
	state: ConversationProjection,
	ctx: ReducerContext,
): { state: ConversationProjection; turn: ProductTurn } {
	const existing = activeTurn(state);
	if (existing) return { state, turn: existing };
	const id = `turn-${String(state.turnSeq + 1)}`;
	const turn: ProductTurn = {
		id,
		userMessages: [],
		steps: [],
		status: "running",
		timing: { startTime: ctx.now },
	};
	return {
		state: {
			...state,
			turns: [...state.turns, turn],
			turnSeq: state.turnSeq + 1,
			activeTurnId: id,
			replayable: false,
		},
		turn,
	};
}

function ensureStep(turn: ProductTurn, ctx: ReducerContext): { turn: ProductTurn; step: AssistantStep } {
	const step: AssistantStep = {
		key: `${turn.id}:${String(turn.steps.length)}`,
		blocks: [],
		toolResults: [],
		isSettled: false,
		timing: { startTime: ctx.now },
	};
	return { turn: { ...turn, steps: [...turn.steps, step] }, step };
}

function ensureOpenStep(turn: ProductTurn, ctx: ReducerContext): { turn: ProductTurn; step: AssistantStep } {
	const latest = turn.steps[turn.steps.length - 1];
	return latest && !latest.isSettled ? { turn, step: latest } : ensureStep(turn, ctx);
}

function ensureBlock(
	step: AssistantStep,
	contentIndex: number,
	kind: "thinking" | "text" | "tool_call",
): { step: AssistantStep; block: ContentBlock } {
	const existing = step.blocks[contentIndex];
	if (existing && (kind === "tool_call" ? existing.type === "tool_call" : existing.type === kind)) {
		return { step, block: existing };
	}
	const key = `${step.key}:${String(contentIndex)}`;
	const block: ContentBlock =
		kind === "thinking"
			? { type: "thinking", key, text: "", isStreaming: true }
			: kind === "tool_call"
				? {
						type: "tool_call",
						key,
						toolCallId: "",
						toolName: "",
						argsText: "",
						args: undefined,
						status: "preparing",
					}
				: { type: "text", key, markdown: "", isStreaming: true };
	const blocks = step.blocks.slice();
	blocks[contentIndex] = block;
	return { step: { ...step, blocks }, block };
}

function replaceBlock(step: AssistantStep, contentIndex: number, block: ContentBlock): AssistantStep {
	const blocks = step.blocks.slice();
	blocks[contentIndex] = block;
	return { ...step, blocks };
}

function updateToolBlock(
	turn: ProductTurn,
	toolCallId: string,
	patch: (
		block: Extract<ContentBlock, { type: "tool_call" }>,
	) => Extract<ContentBlock, { type: "tool_call" }>,
): ProductTurn {
	const steps = turn.steps.slice();
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex];
		if (!step) continue;
		for (let index = 0; index < step.blocks.length; index++) {
			const block = step.blocks[index];
			if (block?.type === "tool_call" && block.toolCallId === toolCallId) {
				steps[stepIndex] = replaceBlock(step, index, patch(block));
				return { ...turn, steps };
			}
		}
	}
	return turn;
}

function upsertToolResult(step: AssistantStep, result: AssistantStep["toolResults"][number]): AssistantStep {
	const index = step.toolResults.findIndex((entry) => entry.toolCallId === result.toolCallId);
	const previous = index === -1 ? undefined : step.toolResults[index];
	const toolResults =
		index === -1
			? [...step.toolResults, result]
			: step.toolResults.map((entry, entryIndex) =>
					entryIndex === index ? { ...result, isError: Boolean(previous?.isError || result.isError) } : entry,
				);
	const blocks = step.blocks.map((block) =>
		block.type === "tool_call" && block.toolCallId === result.toolCallId && result.isError
			? { ...block, status: "error" as const }
			: block,
	);
	return { ...step, blocks, toolResults };
}

export function convergeHangingToolCalls(turn: ProductTurn): ProductTurn {
	const steps = turn.steps.map((step) => {
		let modified = false;
		const blocks = step.blocks.map((block) => {
			if (block.type === "tool_call" && (block.status === "preparing" || block.status === "running")) {
				const hasResult = step.toolResults.some((result) => result.toolCallId === block.toolCallId);
				if (!hasResult) {
					modified = true;
					return { ...block, status: "interrupted" as const };
				}
			}
			return block;
		});
		return modified ? { ...step, blocks } : step;
	});
	return { ...turn, steps };
}

function upsertStatusRow(state: ConversationProjection, row: StatusRow): ConversationProjection {
	const existing = state.statusRows.findIndex((r) => r.key === row.key);
	if (existing === -1) return { ...state, statusRows: [...state.statusRows, row] };
	const statusRows = state.statusRows.slice();
	statusRows[existing] = row;
	return { ...state, statusRows };
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handleMessageUpdate(
	state: ConversationProjection,
	ctx: ReducerContext,
	event: Extract<JsonAgentSessionEvent, { type: "message_update" }>,
): ConversationProjection {
	const ensured = ensureTurn(state, ctx);
	// Attach deltas to the step created by turn_start; create one defensively
	// only when the event stream skipped turn_start.
	const stepped = ensureOpenStep(ensured.turn, ctx);
	let finalStep = stepped.step;
	const inner = event.assistantMessageEvent;

	switch (inner.type) {
		case "text_start": {
			finalStep = ensureBlock(finalStep, inner.contentIndex, "text").step;
			break;
		}
		case "text_delta": {
			const res = ensureBlock(finalStep, inner.contentIndex, "text");
			if (res.block.type === "text") {
				finalStep = replaceBlock(res.step, inner.contentIndex, {
					...res.block,
					markdown: res.block.markdown + inner.delta,
				});
			}
			break;
		}
		case "text_end": {
			const res = ensureBlock(finalStep, inner.contentIndex, "text");
			if (res.block.type === "text") {
				finalStep = replaceBlock(res.step, inner.contentIndex, {
					...res.block,
					markdown: inner.content,
					isStreaming: false,
				});
			}
			break;
		}
		case "thinking_start": {
			finalStep = ensureBlock(finalStep, inner.contentIndex, "thinking").step;
			break;
		}
		case "thinking_delta": {
			const res = ensureBlock(finalStep, inner.contentIndex, "thinking");
			if (res.block.type === "thinking") {
				finalStep = replaceBlock(res.step, inner.contentIndex, {
					...res.block,
					text: res.block.text + inner.delta,
				});
			}
			break;
		}
		case "thinking_end": {
			const res = ensureBlock(finalStep, inner.contentIndex, "thinking");
			if (res.block.type === "thinking") {
				finalStep = replaceBlock(res.step, inner.contentIndex, {
					...res.block,
					text: inner.content,
					isStreaming: false,
				});
			}
			break;
		}
		case "toolcall_start": {
			finalStep = ensureBlock(finalStep, inner.contentIndex, "tool_call").step;
			break;
		}
		case "toolcall_delta": {
			const res = ensureBlock(finalStep, inner.contentIndex, "tool_call");
			if (res.block.type === "tool_call") {
				finalStep = replaceBlock(res.step, inner.contentIndex, {
					...res.block,
					argsText: res.block.argsText + inner.delta,
				});
			}
			break;
		}
		case "toolcall_end": {
			const res = ensureBlock(finalStep, inner.contentIndex, "tool_call");
			if (res.block.type === "tool_call") {
				finalStep = replaceBlock(res.step, inner.contentIndex, {
					...res.block,
					toolCallId: inner.toolCall.id,
					toolName: inner.toolCall.name,
					args: inner.toolCall.arguments,
				});
			}
			break;
		}
		case "start":
		case "done":
		case "error":
			// Initial snapshot / final message / stream error: message_end owns the
			// authoritative swap; only usage is interesting here.
			break;
		default:
			break;
	}

	finalStep = {
		...finalStep,
		usage: {
			input: event.usage.input,
			output: event.usage.output,
			cacheRead: event.usage.cacheRead,
			cacheWrite: event.usage.cacheWrite,
			totalTokens: event.usage.totalTokens,
			cost: event.usage.cost.total,
		},
	};
	return withTurn(ensured.state, withLastStep(stepped.turn, finalStep));
}

function handleMessageStart(
	state: ConversationProjection,
	ctx: ReducerContext,
	event: Extract<JsonAgentSessionEvent, { type: "message_start" }>,
): ConversationProjection {
	const message = event.message as { role?: string; content: unknown };

	if (message.role === "user") {
		const ensured = ensureTurn(state, ctx);
		const presented = presentUserMessage(flattenText(message.content));
		const explicitSource = ctx.resolveInjectionSource?.(serializePresentedUserMessage(presented));
		const hasPriorConversationWork =
			ensured.turn.userMessages.length > 0 ||
			ensured.turn.steps.some(
				(step) => step.blocks.length > 0 || step.toolResults.length > 0 || step.isSettled,
			);
		// Pi emits turn_start before the initial user message. An empty step is
		// therefore not evidence that the message was injected into a running
		// turn; only an explicit queued mode or prior conversation work is.
		const source: UiUserMessageSource = explicitSource ?? (hasPriorConversationWork ? "steer" : "prompt");
		const userMessages = [
			...ensured.turn.userMessages,
			{
				entryKey: `${ensured.turn.id}:u${String(ensured.turn.userMessages.length)}`,
				text: presented.text,
				...(presented.command ? { command: presented.command } : {}),
				images: extractImages(message.content),
				source,
				delivered: true,
			},
		];
		return withTurn(ensured.state, { ...ensured.turn, userMessages });
	}

	if (message.role === "assistant") {
		const ensured = ensureTurn(state, ctx);
		const stepped = ensureOpenStep(ensured.turn, ctx);
		// Seed any already-present content (snapshot replay / zero-delta messages).
		const seeded = (message.content as ContentBlockLite[]).map((block, index) => {
			const key = `${stepped.step.key}:${String(index)}`;
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
		});
		const step = seeded.length > 0 ? { ...stepped.step, blocks: seeded } : stepped.step;
		return withTurn(ensured.state, withLastStep(stepped.turn, step));
	}

	if (message.role === "toolResult") {
		const ensured = ensureTurn(state, ctx);
		const toolResult = event.message as {
			toolCallId?: string;
			toolName?: string;
			content: unknown;
			isError?: boolean;
			details?: unknown;
		};
		const last = ensured.turn.steps[ensured.turn.steps.length - 1];
		if (!last) return state;
		return withTurn(
			ensured.state,
			withLastStep(
				ensured.turn,
				upsertToolResult(last, {
					toolCallId: toolResult.toolCallId ?? "",
					toolName: toolResult.toolName ?? "",
					content: flattenText(toolResult.content),
					isError: toolResult.isError ?? false,
					details: toolResult.details,
				}),
			),
		);
	}

	return state;
}

function handleMessageEnd(
	state: ConversationProjection,
	ctx: ReducerContext,
	event: Extract<JsonAgentSessionEvent, { type: "message_end" }>,
): ConversationProjection {
	const message = event.message as {
		role?: string;
		content: unknown;
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
	if (message.role !== "assistant") return state;

	const ensured = ensureTurn(state, ctx);
	const last = ensured.turn.steps[ensured.turn.steps.length - 1];
	if (!last) return state;

	let finalTurn = ensured.turn;

	// stopReason "length": the model was cut off; pending tool calls never run
	// (rule 2). Mark skipped BEFORE the final swap so the swap preserves the
	// skipped status on tool blocks that survive into the final content.
	if (message.stopReason === "length") {
		const steps = finalTurn.steps.slice();
		const step = steps[steps.length - 1];
		if (step) {
			steps[steps.length - 1] = {
				...step,
				blocks: step.blocks.map((b) =>
					b.type === "tool_call" && b.status === "preparing" ? { ...b, status: "skipped" as const } : b,
				),
			};
			finalTurn = { ...finalTurn, steps };
		}
	}

	// Authoritative final swap, preserving block keys (rule 5).
	const markedLast = finalTurn.steps[finalTurn.steps.length - 1];
	if (!markedLast) return state;
	const blocks = (message.content as ContentBlockLite[]).map((block, index) => {
		const key = `${markedLast.key}:${String(index)}`;
		const existing = markedLast.blocks[index];
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
			const historicalError = markedLast.toolResults.some(
				(result) => result.toolCallId === (block.id ?? "") && result.isError,
			);
			return {
				type: "tool_call" as const,
				key,
				toolCallId: block.id ?? "",
				toolName: block.name ?? "",
				argsText: JSON.stringify(block.arguments ?? {}),
				args: block.arguments,
				status: historicalError
					? ("error" as const)
					: existing?.type === "tool_call"
						? existing.status
						: ("preparing" as const),
				partialOutput: existing?.type === "tool_call" ? existing.partialOutput : undefined,
				result: existing?.type === "tool_call" ? existing.result : undefined,
			};
		}
		return { type: "text" as const, key, markdown: block.text ?? "", isStreaming: false };
	});

	const settledStep: AssistantStep = {
		...markedLast,
		blocks,
		isSettled: true,
		timing: {
			startTime: markedLast.timing?.startTime ?? ctx.now,
			endTime: ctx.now,
		},
		usage: message.usage
			? {
					input: message.usage.input,
					output: message.usage.output,
					cacheRead: message.usage.cacheRead,
					cacheWrite: message.usage.cacheWrite,
					totalTokens: message.usage.totalTokens,
					cost: message.usage.cost.total,
				}
			: markedLast.usage,
	};
	finalTurn = withLastStep(finalTurn, settledStep);

	if (message.stopReason === "error") {
		finalTurn = convergeHangingToolCalls({
			...finalTurn,
			status: "error",
			errorMessage: message.errorMessage ?? tt("tail.modelError"),
		});
	} else if (message.stopReason === "aborted") {
		finalTurn = convergeHangingToolCalls({ ...finalTurn, status: "aborted" });
	}

	return withTurn(ensured.state, finalTurn);
}
// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function reduceProjection(
	state: ConversationProjection,
	event: JsonAgentSessionEvent,
	ctx: ReducerContext,
): ConversationProjection {
	switch (event.type) {
		case "agent_start": {
			// Any previous running turn is abandoned (defensive).
			const settled = {
				...state,
				turns: state.turns.map((t) =>
					t.id === state.activeTurnId && t.status === "running"
						? convergeHangingToolCalls({ ...t, status: "settled" as const })
						: t,
				),
				activeTurnId: null,
				replayable: false,
			};
			return ensureTurn(settled, ctx).state;
		}

		case "turn_start": {
			const ensured = ensureTurn(state, ctx);
			const stepped = ensureStep(ensured.turn, ctx);
			return withTurn(ensured.state, stepped.turn);
		}

		case "message_start":
			return handleMessageStart(state, ctx, event);

		case "message_update":
			return handleMessageUpdate(state, ctx, event);

		case "message_end":
			return handleMessageEnd(state, ctx, event);

		case "tool_execution_start": {
			const ensured = ensureTurn(state, ctx);
			const updated = updateToolBlock(ensured.turn, event.toolCallId, (block) => ({
				...block,
				// A skipped block (stopReason length) must never flip back to running.
				status: block.status === "skipped" ? "skipped" : "running",
				args: event.args,
			}));
			return withTurn(ensured.state, updated);
		}

		case "tool_execution_update": {
			const ensured = ensureTurn(state, ctx);
			const partial = flattenPartialResult(event.partialResult);
			const updated = updateToolBlock(ensured.turn, event.toolCallId, (block) => ({
				...block,
				partialOutput: partial ?? block.partialOutput,
			}));
			return withTurn(ensured.state, updated);
		}

		case "tool_execution_end": {
			const ensured = ensureTurn(state, ctx);
			const updated = updateToolBlock(ensured.turn, event.toolCallId, (block) => ({
				...block,
				status: block.status === "skipped" ? "skipped" : event.isError ? "error" : "done",
				result: event.result,
				partialOutput: block.partialOutput ?? flattenPartialResult(event.result),
			}));
			return withTurn(ensured.state, updated);
		}

		case "turn_end": {
			const ensured = ensureTurn(state, ctx);
			const last = ensured.turn.steps[ensured.turn.steps.length - 1];
			if (!last) return state;
			return withTurn(
				ensured.state,
				withLastStep(ensured.turn, {
					...last,
					isSettled: true,
					timing: { startTime: last.timing?.startTime ?? ctx.now, endTime: ctx.now },
				}),
			);
		}

		case "agent_end": {
			// willRetry means the run continues (auto-retry); never settle here (rule 5).
			return state;
		}

		case "agent_settled": {
			const turn = activeTurn(state);
			if (!turn) return { ...state, replayable: true };
			const convergedTurn = convergeHangingToolCalls(turn);
			const status =
				convergedTurn.status === "error" || convergedTurn.status === "aborted"
					? convergedTurn.status
					: "settled";
			const startTime = convergedTurn.timing?.startTime ?? ctx.now;
			const timing = { startTime, endTime: ctx.now, durationMs: ctx.now - startTime };
			return withTurn(
				{ ...state, activeTurnId: null, replayable: true },
				{ ...convergedTurn, status, timing },
			);
		}

		case "queue_update":
			return { ...state, queue: { steering: [...event.steering], followUp: [...event.followUp] } };

		case "compaction_start":
			return upsertStatusRow(state, {
				key: "compaction",
				kind: "compaction",
				state: "running",
				detail: event.reason,
			});

		case "compaction_end":
			return upsertStatusRow(state, {
				key: "compaction",
				kind: "compaction",
				state: event.aborted || event.errorMessage ? "failed" : "done",
				detail: event.errorMessage ?? (event.result ? tt("system.contextCompacted") : undefined),
			});

		case "auto_retry_start":
			return upsertStatusRow(state, {
				key: "retry",
				kind: "retry",
				state: "waiting",
				detail: tt("system.retryScheduled", {
					attempt: event.attempt,
					max: event.maxAttempts,
					seconds: Math.round(event.delayMs / 1000),
				}),
			});

		case "auto_retry_end":
			return upsertStatusRow(state, {
				key: "retry",
				kind: "retry",
				state: "done",
				detail: event.success ? tt("system.retryDone") : (event.finalError ?? tt("system.retryFailed")),
			});

		case "summarization_retry_scheduled":
			return upsertStatusRow(state, {
				key: "compaction",
				kind: "compaction",
				state: "running",
				detail: tt("system.summaryRetryScheduled", { seconds: Math.round(event.delayMs / 1000) }),
			});

		case "summarization_retry_attempt_start":
			return upsertStatusRow(state, {
				key: "compaction",
				kind: "compaction",
				state: "running",
				detail: tt("system.summaryRetrying"),
			});

		case "summarization_retry_finished":
			return upsertStatusRow(state, {
				key: "compaction",
				kind: "compaction",
				state: "done",
				detail: tt("system.summaryDone"),
			});

		case "bash_execution_update":
		case "thinking_level_changed":
		case "session_info_changed":
		case "entry_appended":
			// Handled by other stores in the pipeline; no projection impact.
			return state;

		default:
			return state;
	}
}
