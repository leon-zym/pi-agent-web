import type {
	AssistantMessageDto,
	ExtensionUiRequestDto,
	ProductSessionEventDto,
	SessionMessageDto,
	SessionRuntimeDto,
	UsageDto,
} from "@pi-agent-web/protocol";
import { isSessionSnapshotDto, SESSION_SNAPSHOT_MAX_MESSAGES } from "@pi-agent-web/protocol";
import { describe, expect, it } from "vitest";
import {
	SessionLiveProjection,
	type SessionLiveProjectionIdentity,
	SessionLiveProjectionIdentityError,
	SessionLiveProjectionLimitError,
} from "../src/session-live-projection.js";

const identity: SessionLiveProjectionIdentity = {
	serverEpoch: "epoch-a",
	sessionHandle: "session-a",
	workspaceId: "workspace-a",
	generation: 3,
};

const usage: UsageDto = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): SessionMessageDto {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantMessage(text: string, stopReason: AssistantMessageDto["stopReason"]): AssistantMessageDto {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage,
		stopReason,
		timestamp: 2,
	};
}

function event(value: ProductSessionEventDto) {
	return { type: "event" as const, event: value };
}

function wireSnapshot(projection: ReturnType<SessionLiveProjection["snapshot"]>) {
	const runtime: SessionRuntimeDto = {
		serverEpoch: projection.serverEpoch,
		sessionHandle: projection.sessionHandle,
		workspaceId: projection.workspaceId,
		nativeSessionId: "native-a",
		sessionFile: null,
		cwd: "/tmp/workspace-a",
		generation: projection.generation,
		lastSeq: projection.asOfSeq,
		state: projection.runtimePhase,
		lastActivityAt: 1,
		recoverable: false,
	};
	return {
		type: "session_snapshot" as const,
		snapshotId: "snapshot-a",
		serverEpoch: projection.serverEpoch,
		sessionHandle: projection.sessionHandle,
		workspaceId: projection.workspaceId,
		generation: projection.generation,
		baseSeq: projection.baseSeq,
		asOfSeq: projection.asOfSeq,
		runtime,
		settledMessages: [...projection.settledMessages],
		projectionEvents: [...projection.projectionEvents],
		queue: {
			steering: [...projection.queue.steering],
			followUp: [...projection.queue.followUp],
		},
		pendingExtensionRequests: [...projection.pendingExtensionRequests],
		stickyExtensionState: [...projection.stickyExtensionState],
	};
}

describe("SessionLiveProjection", () => {
	it("captures settled messages plus ordered text and thinking partials at one waterline", () => {
		const projection = new SessionLiveProjection({
			identity,
			settledMessages: [userMessage("question")],
			baseSeq: 7,
			runtimePhase: "idle",
		});

		projection.commit(identity, event({ type: "agent_start" }), "running");
		projection.commit(
			identity,
			event({
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan" },
			}),
		);
		projection.commit(
			identity,
			event({
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "partial" },
			}),
		);

		const snapshot = projection.snapshot();
		expect(snapshot).toMatchObject({
			...identity,
			baseSeq: 7,
			asOfSeq: 10,
			runtimePhase: "running",
			settledMessages: [userMessage("question")],
		});
		expect(snapshot.projectionEvents.map((frame) => frame.seq)).toEqual([8, 9, 10]);
		expect(snapshot.projectionEvents.map((frame) => frame.event.type)).toEqual([
			"agent_start",
			"message_update",
			"message_update",
		]);
		expect(snapshot.projectionEvents.every((frame) => frame.type === "event")).toBe(true);
		expect(isSessionSnapshotDto(wireSnapshot(snapshot))).toBe(true);
	});

	it("coalesces 2050 adjacent compatible deltas without losing the authoritative waterline", () => {
		const projection = new SessionLiveProjection({ identity, baseSeq: 0, runtimePhase: "running" });
		projection.commit(
			identity,
			event({
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" },
			}),
		);
		for (let index = 0; index < 2_049; index += 1) {
			projection.commit(
				identity,
				event({
					type: "message_update",
					usage,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b" },
				}),
			);
		}

		const snapshot = projection.snapshot();
		expect(snapshot.asOfSeq).toBe(2_050);
		expect(snapshot.projectionEvents).toHaveLength(1);
		expect(snapshot.projectionEvents[0]).toMatchObject({
			type: "event",
			seq: 2_050,
			event: {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `a${"b".repeat(2_049)}` },
			},
		});
		expect(isSessionSnapshotDto(wireSnapshot(snapshot))).toBe(true);
	});

	it("keeps structural boundaries and incompatible delta identities separate", () => {
		const projection = new SessionLiveProjection({ identity, baseSeq: 0 });
		const delta = (type: "text_delta" | "thinking_delta", contentIndex: number, value: string) =>
			event({
				type: "message_update",
				usage,
				assistantMessageEvent: { type, contentIndex, delta: value },
			});
		projection.commit(identity, delta("text_delta", 0, "one"));
		projection.commit(identity, delta("text_delta", 1, "two"));
		projection.commit(identity, event({ type: "turn_start" }));
		projection.commit(identity, delta("text_delta", 1, "three"));
		projection.commit(identity, delta("thinking_delta", 1, "four"));

		expect(projection.snapshot().projectionEvents.map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5]);
	});

	it("coalesces thinking and toolcall deltas but not across an Extension boundary", () => {
		const projection = new SessionLiveProjection({ identity, baseSeq: 0 });
		const delta = (type: "thinking_delta" | "toolcall_delta", value: string): ReturnType<typeof event> =>
			event({
				type: "message_update",
				usage,
				assistantMessageEvent: { type, contentIndex: 0, delta: value },
			});
		projection.commit(identity, delta("thinking_delta", "one"));
		projection.commit(identity, delta("thinking_delta", "two"));
		projection.commit(identity, {
			type: "extension_ui_request",
			request: {
				type: "extension_ui_request",
				id: "notify-a",
				method: "notify",
				message: "boundary",
			},
		});
		projection.commit(identity, delta("toolcall_delta", '{"path"'));
		projection.commit(identity, delta("toolcall_delta", ':"README.md"}'));

		const snapshot = projection.snapshot();
		expect(snapshot.asOfSeq).toBe(5);
		expect(snapshot.projectionEvents.map((frame) => frame.seq)).toEqual([2, 5]);
		expect(snapshot.projectionEvents[0]?.event).toMatchObject({
			assistantMessageEvent: { type: "thinking_delta", delta: "onetwo" },
		});
		expect(snapshot.projectionEvents[1]?.event).toMatchObject({
			assistantMessageEvent: { type: "toolcall_delta", delta: '{"path":"README.md"}' },
		});
	});

	it("retains tool construction, execution partials, and the authoritative message_end", () => {
		const projection = new SessionLiveProjection({ identity, baseSeq: 0 });
		const finalMessage = assistantMessage("done", "toolUse");

		projection.commit(
			identity,
			event({
				type: "message_update",
				usage,
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					id: "tool-1",
					toolName: "read",
				},
			}),
			"running",
		);
		projection.commit(
			identity,
			event({
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "README.md" },
			}),
		);
		projection.commit(
			identity,
			event({
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "README.md" },
				partialResult: { text: "prefix" },
			}),
		);
		projection.commit(identity, event({ type: "message_end", message: finalMessage }));

		const snapshot = projection.snapshot();
		expect(snapshot.asOfSeq).toBe(4);
		expect(snapshot.projectionEvents.at(2)?.event).toMatchObject({
			type: "tool_execution_update",
			partialResult: { text: "prefix" },
		});
		expect(snapshot.projectionEvents.at(-1)?.event).toEqual({
			type: "message_end",
			message: finalMessage,
		});
	});

	it("tracks the latest queue independently while preserving event order", () => {
		const projection = new SessionLiveProjection({ identity, baseSeq: 4 });
		projection.commit(identity, event({ type: "queue_update", steering: ["first"], followUp: ["later"] }));
		projection.commit(identity, event({ type: "queue_update", steering: [], followUp: ["replacement"] }));

		const snapshot = projection.snapshot();
		expect(snapshot.queue).toEqual({ steering: [], followUp: ["replacement"] });
		expect(snapshot.projectionEvents.map((frame) => frame.seq)).toEqual([5, 6]);
	});

	it("retains blocking dialogs while leaving sticky and notify authority to the runtime", () => {
		const projection = new SessionLiveProjection({ identity, baseSeq: 0, runtimePhase: "running" });
		const dialog: ExtensionUiRequestDto = {
			type: "extension_ui_request",
			id: "dialog-1",
			method: "confirm",
			title: "Continue?",
			message: "Confirm",
		};
		projection.commit(identity, { type: "extension_ui_request", request: dialog });
		projection.commit(identity, {
			type: "extension_ui_request",
			request: {
				type: "extension_ui_request",
				id: "notify-1",
				method: "notify",
				message: "transient",
			},
		});
		projection.commit(identity, {
			type: "extension_ui_request",
			request: {
				type: "extension_ui_request",
				id: "status-1",
				method: "setStatus",
				statusKey: "build",
				statusText: "one",
			},
		});
		projection.commit(identity, {
			type: "extension_ui_request",
			request: {
				type: "extension_ui_request",
				id: "status-2",
				method: "setStatus",
				statusKey: "build",
				statusText: "two",
			},
		});

		let snapshot = projection.snapshot();
		expect(snapshot.runtimePhase).toBe("waiting_ui");
		expect(snapshot.pendingExtensionRequests).toEqual([dialog]);
		expect(snapshot.stickyExtensionState).toEqual([]);
		expect(JSON.stringify(snapshot)).not.toContain("transient");
		expect(isSessionSnapshotDto(wireSnapshot(snapshot))).toBe(true);

		projection.commit(identity, {
			type: "extension_ui_request",
			request: {
				type: "extension_ui_request",
				id: "status-clear",
				method: "setStatus",
				statusKey: "build",
			},
		});
		projection.commit(identity, {
			type: "extension_ui_closed",
			requestId: "dialog-1",
			reason: "answered",
		});

		snapshot = projection.snapshot();
		expect(snapshot.runtimePhase).toBe("running");
		expect(snapshot.pendingExtensionRequests).toEqual([]);
		expect(snapshot.stickyExtensionState).toEqual([]);
		expect(snapshot.asOfSeq).toBe(6);
	});

	it("fails closed on epoch, handle, Workspace, or generation mismatch without advancing", () => {
		const projection = new SessionLiveProjection({ identity, baseSeq: 11 });
		const mismatches: SessionLiveProjectionIdentity[] = [
			{ ...identity, serverEpoch: "epoch-b" },
			{ ...identity, sessionHandle: "session-b" },
			{ ...identity, workspaceId: "workspace-b" },
			{ ...identity, generation: 4 },
		];

		for (const mismatch of mismatches) {
			expect(() => projection.commit(mismatch, event({ type: "agent_start" }))).toThrow(
				SessionLiveProjectionIdentityError,
			);
		}
		expect(projection.snapshot().asOfSeq).toBe(11);
		expect(projection.snapshot().projectionEvents).toEqual([]);
	});

	it("returns deeply frozen snapshots detached from caller-owned event and message objects", () => {
		const originalMessage = userMessage("original");
		const originalEvent: ProductSessionEventDto = {
			type: "queue_update",
			steering: ["steer"],
			followUp: [],
		};
		const projection = new SessionLiveProjection({
			identity,
			baseSeq: 0,
			settledMessages: [originalMessage],
		});
		projection.commit(identity, event(originalEvent));
		const snapshot = projection.snapshot();

		(originalMessage as { content: string }).content = "mutated";
		(originalEvent.steering as string[]).push("mutated");
		expect(snapshot.settledMessages).toEqual([userMessage("original")]);
		expect(snapshot.queue.steering).toEqual(["steer"]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.projectionEvents[0]?.event)).toBe(true);
		expect(() => (snapshot.queue.steering as string[]).push("forbidden")).toThrow();
	});

	it("enforces live-event item and byte ceilings transactionally", () => {
		const itemBounded = new SessionLiveProjection({
			identity,
			baseSeq: 0,
			limits: { maxLiveEventItems: 1, maxLiveEventBytes: 10_000 },
		});
		itemBounded.commit(identity, event({ type: "agent_start" }));
		expect(() => itemBounded.commit(identity, event({ type: "turn_start" }))).toThrow(
			SessionLiveProjectionLimitError,
		);
		expect(itemBounded.snapshot().asOfSeq).toBe(1);

		const byteBounded = new SessionLiveProjection({
			identity,
			baseSeq: 0,
			limits: { maxLiveEventItems: 10, maxLiveEventBytes: 100 },
		});
		expect(() =>
			byteBounded.commit(
				identity,
				event({
					type: "extension_error",
					extensionPath: "fixture",
					event: "event",
					error: "x".repeat(500),
				}),
			),
		).toThrow(SessionLiveProjectionLimitError);
		expect(byteBounded.snapshot().asOfSeq).toBe(0);
	});

	it("rejects a merged delta or aggregate snapshot overflow before advancing waterline", () => {
		const merged = new SessionLiveProjection({
			identity,
			baseSeq: 0,
			limits: { maxLiveEventItems: 10, maxLiveEventBytes: 450, maxSnapshotBytes: 10_000 },
		});
		merged.commit(
			identity,
			event({
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "small" },
			}),
		);
		const beforeMergedOverflow = merged.snapshot();
		expect(() =>
			merged.commit(
				identity,
				event({
					type: "message_update",
					usage,
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "x".repeat(500),
					},
				}),
			),
		).toThrow(SessionLiveProjectionLimitError);
		expect(merged.snapshot()).toEqual(beforeMergedOverflow);

		const aggregate = new SessionLiveProjection({
			identity,
			baseSeq: 0,
			limits: { maxLiveEventBytes: 10_000, maxSnapshotBytes: 600 },
		});
		const beforeAggregateOverflow = aggregate.snapshot();
		expect(() =>
			aggregate.commit(
				identity,
				event({
					type: "extension_error",
					extensionPath: "fixture",
					event: "event",
					error: "x".repeat(1_000),
				}),
			),
		).toThrow(SessionLiveProjectionLimitError);
		expect(aggregate.snapshot()).toEqual(beforeAggregateOverflow);
	});

	it("enforces Extension state item and byte ceilings without retaining the rejected request", () => {
		const projection = new SessionLiveProjection({
			identity,
			baseSeq: 0,
			limits: { maxExtensionItems: 1, maxExtensionBytes: 300 },
		});
		projection.commit(identity, {
			type: "extension_ui_request",
			request: {
				type: "extension_ui_request",
				id: "dialog-1",
				method: "confirm",
				title: "One",
				message: "One",
			},
		});
		expect(() =>
			projection.commit(identity, {
				type: "extension_ui_request",
				request: {
					type: "extension_ui_request",
					id: "dialog-2",
					method: "confirm",
					title: "Two",
					message: "Two",
				},
			}),
		).toThrow(SessionLiveProjectionLimitError);
		expect(projection.snapshot()).toMatchObject({
			asOfSeq: 1,
			pendingExtensionRequests: [expect.objectContaining({ id: "dialog-1" })],
		});

		const byteBounded = new SessionLiveProjection({
			identity,
			baseSeq: 0,
			limits: { maxExtensionItems: 10, maxExtensionBytes: 100 },
		});
		expect(() =>
			byteBounded.commit(identity, {
				type: "extension_ui_request",
				request: {
					type: "extension_ui_request",
					id: "large-dialog",
					method: "confirm",
					title: "Large",
					message: "x".repeat(500),
				},
			}),
		).toThrow(SessionLiveProjectionLimitError);
		expect(byteBounded.snapshot()).toMatchObject({
			asOfSeq: 0,
			stickyExtensionState: [],
		});
	});

	it("bounds both settled-base message count and bytes", () => {
		expect(
			() =>
				new SessionLiveProjection({
					identity,
					baseSeq: 0,
					settledMessages: Array.from({ length: SESSION_SNAPSHOT_MAX_MESSAGES + 1 }, () =>
						userMessage("tiny"),
					),
				}),
		).toThrow(SessionLiveProjectionLimitError);
		expect(
			() =>
				new SessionLiveProjection({
					identity,
					baseSeq: 0,
					settledMessages: [userMessage("one"), userMessage("two")],
					limits: { maxSettledMessageItems: 1 },
				}),
		).toThrow(SessionLiveProjectionLimitError);
		expect(
			() =>
				new SessionLiveProjection({
					identity,
					baseSeq: 0,
					settledMessages: [userMessage("x".repeat(500))],
					limits: { maxSettledMessageBytes: 100 },
				}),
		).toThrow(SessionLiveProjectionLimitError);
	});

	it("compacts an idle settled base only when the captured identity and waterline still match", () => {
		const projection = new SessionLiveProjection({
			identity,
			baseSeq: 3,
			settledMessages: [userMessage("old")],
			runtimePhase: "idle",
		});
		projection.commit(identity, event({ type: "message_end", message: assistantMessage("done", "stop") }));
		projection.setRuntimePhase(identity, "idle");
		const token = projection.beginIdleBaseCompaction();
		expect(token).not.toBeNull();
		expect(projection.commitIdleBaseCompaction(token!, [userMessage("new")])).toBe(true);
		expect(projection.snapshot()).toMatchObject({
			baseSeq: 4,
			asOfSeq: 4,
			settledMessages: [userMessage("new")],
			projectionEvents: [],
		});

		const staleToken = projection.beginIdleBaseCompaction();
		projection.commit(identity, event({ type: "agent_start" }), "running");
		expect(projection.commitIdleBaseCompaction(staleToken!, [userMessage("stale")])).toBe(false);
		expect(projection.snapshot().settledMessages).toEqual([userMessage("new")]);
		expect(projection.beginIdleBaseCompaction()).toBeNull();
	});
});
